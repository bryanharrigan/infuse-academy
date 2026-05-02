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

  // For each session, list its top-level keys, preview values, AND
  // recursively crack open any nested objects (currentClass, instructors,
  // recurrenceRule) so we can see where the schedule + venue actually live.
  const summarise = (s: Record<string, unknown>): Record<string, unknown> => {
    const keys = Object.keys(s);
    const preview: Record<string, unknown> = {};
    for (const k of keys) {
      const v = s[k];
      if (v === null || v === undefined) continue;
      if (typeof v === "string") preview[k] = v.slice(0, 100);
      else if (typeof v === "number" || typeof v === "boolean")
        preview[k] = v;
      else if (Array.isArray(v)) {
        preview[k] = {
          __type: `Array(${v.length})`,
          first:
            v.length > 0
              ? typeof v[0] === "object" && v[0] !== null
                ? summarise(v[0] as Record<string, unknown>)
                : v[0]
              : null,
        };
      } else if (typeof v === "object") {
        preview[k] = summarise(v as Record<string, unknown>);
      }
    }
    return { __keys: keys, ...preview };
  };
  const summary = sessions.slice(0, 5).map((s) => ({
    id: s.id ?? s.sessionId ?? "<no-id>",
    fields: summarise(s),
  }));

  return json({
    courseId,
    url,
    status: r.status,
    sessionCount: sessions.length,
    sessions: summary,
    rawHead: text.slice(0, 1500),
  });
}
