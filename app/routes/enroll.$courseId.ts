/**
 * app/routes/enroll.$courseId.ts
 *
 * Resource route — POST only. Enrolls the current learner in the given
 * course via Absorb's `POST /my-enrollments` endpoint, then returns JSON
 * the client can react to.
 *
 *   POST /enroll/:courseId
 *
 * Returns:
 *   200 { ok: true }            — enrollment succeeded (or learner was
 *                                 already enrolled — Absorb sometimes 409s
 *                                 with that, which we map to ok)
 *   401 { error: "unauthorized" } — no session cookie
 *   400 { error: "courseId required" }
 *   500 { error: "<message>" }   — anything else
 *
 * The Experimental + IA Learning Hubs call this from a `useFetcher`/fetch
 * + revalidator pair: on a successful response they invalidate the route
 * loader so the freshly-enrolled course shows up in /my-courses without a
 * full page reload.
 *
 * No `loader` export — the route is POST-only.
 */

import { ActionFunctionArgs, json } from "@remix-run/node";
import { startEnrollment } from "~/.server/infuse-api";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, { status: 405 });
  }

  const cookieHeader = request.headers.get("Cookie");
  const token = await infuseJwtCookie.parse(cookieHeader);
  if (!token) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  const courseId = params.courseId;
  if (!courseId) {
    return json({ error: "courseId required" }, { status: 400 });
  }

  try {
    await startEnrollment(token, courseId);
    return json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Absorb sometimes returns 409 / "already enrolled" for repeat calls.
    // Treat that as success so the UI can move on rather than display an
    // error for what is, from the learner's perspective, a no-op.
    if (
      message.toLowerCase().includes("409") ||
      message.toLowerCase().includes("already")
    ) {
      return json({ ok: true, note: "already enrolled" });
    }
    console.error(`[enroll] courseId=${courseId} failed:`, message);
    return json({ error: message }, { status: 500 });
  }
}
