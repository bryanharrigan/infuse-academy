import { json, LoaderFunctionArgs } from "@remix-run/node";
import { getLessonPlayerPayload } from "~/.server/infuse-api";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";

/**
 * Resource route: GET /lesson-player/:courseId
 *   → { playerUrl, courseId, lessonId, verifier, pickedLesson }
 *
 * Used by the lesson-player modal. Fetches the Absorb player URL using the
 * WordPress-plugin reference pattern: tenant JWT as Bearer, chapters fetch
 * to discover a lessonId, lowercase /learn/lessonplayer URL.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  if (!params.courseId) {
    throw new Response("Missing courseId", { status: 400 });
  }

  const cookieHeader = request.headers.get("Cookie");
  const tokenValue = await infuseJwtCookie.parse(cookieHeader);
  if (!tokenValue) {
    throw new Response("Not authenticated", { status: 401 });
  }

  // Query params:
  //   ?mode=course            → also return chapters so the client can render
  //                             a sidebar + per-lesson iframe.
  //   ?lessonId=<id>          → mint a URL for that specific lesson (used by
  //                             the CoursePlayerModal when the learner picks
  //                             a lesson from the sidebar).
  //   (default)               → single-lesson player, next incomplete lesson.
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode") === "course" ? "course" : "lesson";
  const lessonId = url.searchParams.get("lessonId") ?? undefined;

  try {
    const payload = await getLessonPlayerPayload(params.courseId, tokenValue, {
      mode,
      lessonId,
    });
    return json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, { status: 500 });
  }
};
