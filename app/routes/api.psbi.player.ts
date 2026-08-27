import { json, LoaderFunctionArgs } from "@remix-run/node";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";
import { getLessonPlayerPayload } from "~/.server/infuse-api";

/**
 * GET /api/psbi/player?courseId=<id>[&lessonId=<id>]
 *
 * Mints a one-time Absorb lessonplayer URL for the given course/lesson.
 * Returns:
 *   { playerUrl, courseId, lessonId, verifier, pickedLesson, chapters? }
 *
 * When lessonId is omitted, picks the next incomplete lesson.
 * When mode=course, also returns the full chapter/lesson tree.
 *
 * Used by the PSBI static demo page to embed real Absorb content.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const cookieHeader = request.headers.get("Cookie");
  const token = await infuseJwtCookie.parse(cookieHeader);
  if (!token) return json({ error: "Not authenticated" }, { status: 401 });

  const url = new URL(request.url);
  const courseId = url.searchParams.get("courseId");
  const lessonId = url.searchParams.get("lessonId") ?? undefined;
  const mode = url.searchParams.get("mode") === "course" ? "course" as const : "lesson" as const;

  if (!courseId) return json({ error: "courseId required" }, { status: 400 });

  try {
    const payload = await getLessonPlayerPayload(courseId, token, {
      mode,
      lessonId,
    });
    return json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, { status: 500 });
  }
};
