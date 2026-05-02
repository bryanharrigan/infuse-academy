/**
 * app/routes/sessions-diag.$courseId.ts
 *
 * Throwaway diagnostic — calls /instructor-led-courses/:id/sessions and
 * dumps the raw response so we can see which field names this tenant
 * actually populates (startDate vs startTime vs startsOn, webinarUrl
 * vs joinUrl, etc.). Once we know we'll pin the parser and delete this.
 */

import { LoaderFunctionArgs, json } from "@remix-run/node";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";

const InfuseApiKey = process.env.INFUSE_API_KEY ?? "";
const InfuseBaseUrl = process.env.INFUSE_BASE_URL ?? "";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const cookieHeader = request.headers.get("Cookie");
  const token = await infuseJwtCookie.parse(cookieHeader);
  if (!token) return json({ error: "unauthorized" }, { status: 401 });
  const courseId = params.courseId;
  if (!courseId) return json({ error: "courseId required" }, { status: 400 });

  const url = `${InfuseBaseUrl.replace(/\/$/, "")}/instructor-led-courses/${encodeURIComponent(courseId)}/sessions?_limit=20`;
  const r = await fetch(url, {
    headers: {
      "X-Absorb-API-Key": InfuseApiKey,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
  });

  const text = await r.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* ignore */
  }

  // Pull the array of sessions (Absorb wraps it in various ways).
  let sessions: Array<Record<string, unknown>> = [];
  if (parsed && typeof parsed === "object") {
    const p = parsed as Record<string, unknown>;
    sessions =
      (p.sessions as Array<Record<string, unknown>>) ??
      ((p._embedded as Record<string, unknown>)?.sessions as Array<
        Record<string, unknown>
      >) ??
      [];
  }

  // For each session, list its top-level keys and a tiny preview value
  // so we can see what's populated without dumping huge nested objects.
  const summary = sessions.slice(0, 5).map((s) => {
    const keys = Object.keys(s);
    const preview: Record<string, string> = {};
    for (const k of keys) {
      const v = s[k];
      if (v === null || v === undefined) continue;
      if (typeof v === "string") preview[k] = v.slice(0, 80);
      else if (typeof v === "number" || typeof v === "boolean")
        preview[k] = String(v);
      else if (Array.isArray(v))
        preview[k] = `[Array(${v.length})] ${JSON.stringify(v).slice(0, 80)}`;
      else preview[k] = `[Object] ${JSON.stringify(v).slice(0, 100)}`;
    }
    return { id: s.id ?? s.sessionId ?? "<no-id>", keys, preview };
  });

  return json({
    courseId,
    url,
    status: r.status,
    sessionCount: sessions.length,
    sessions: summary,
    rawHead: text.slice(0, 1500),
  });
}
