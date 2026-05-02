/**
 * app/routes/sessions.$courseId.ts
 *
 * Resource route — GET only. Returns the scheduled sessions for an
 * Instructor-Led Course as JSON so the client-side `SessionsModal` can
 * display them and let the learner pick one to register for.
 *
 *   GET /sessions/:courseId
 *
 * Returns:
 *   200 { sessions: Session[] } — possibly empty array when the course
 *                                 has no scheduled sessions or the tenant
 *                                 doesn't expose them via this endpoint
 *   401 { error: "unauthorized" }
 *   400 { error: "courseId required" }
 *
 * The matching POST flow is /enroll/:courseId — pass `{ sessionId: "..." }`
 * in the body to register for a specific session.
 */

import { LoaderFunctionArgs, json } from "@remix-run/node";
import { getSessionsForCourse } from "~/.server/infuse-api";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
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
    const sessions = await getSessionsForCourse(token, courseId);
    return json({ sessions });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sessions] courseId=${courseId} failed:`, message);
    // Soft-fail with empty list so the UI shows "no sessions" rather than an
    // error toast for tenants where the endpoint is partially missing.
    return json({ sessions: [], error: message });
  }
}
