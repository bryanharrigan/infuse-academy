/**
 * app/routes/curriculum.$courseId.ts
 *
 * Resource route — GET only. Returns the child courses contained in a
 * Curriculum bundle as JSON for the client-side `CurriculumModal` to
 * render. Each child shows up with its own courseType + enrollmentStatus
 * so the modal can dispatch clicks to the right downstream modal
 * (CoursePlayerModal / SessionsModal / nested CurriculumModal).
 *
 *   GET /curriculum/:courseId
 *
 * Returns:
 *   200 { courses: MyCourseResource[] }  — possibly empty
 *   401 { error: "unauthorized" }
 *   400 { error: "courseId required" }
 *
 * Soft-fails with empty list when the underlying Absorb endpoints all
 * 404 — the modal then renders a "no child courses" empty state rather
 * than blowing up.
 */

import { LoaderFunctionArgs, json } from "@remix-run/node";
import { getCurriculumChildren } from "~/.server/infuse-api";
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
    const courses = await getCurriculumChildren(token, courseId);
    return json({ courses });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[curriculum] courseId=${courseId} failed:`, message);
    return json({ courses: [], error: message });
  }
}
