/**
 * app/routes/embed_.play.ts  →  GET /embed/play?courseId=<id>[&lessonId=<id>]
 *
 * Mints a one-time Absorb player URL for the embed widget.
 *
 * The trailing underscore in the filename opts this route out of nesting
 * under `embed.tsx`, so it is a plain JSON endpoint rather than a child view.
 *
 * Auth comes from the `infuse_embed_jwt` cookie (SameSite=None, so it
 * survives the third-party iframe context the embed always runs in).
 *
 * ENTITLEMENT
 * -----------
 * `getLessonPlayerPayload` → `getRefreshTokenForCoursePlayer` mints against
 *
 *     claims: [{ Key: "Learner.Enrollment", Value: courseId }]
 *
 * so Absorb binds the token to this learner AND this course, server-side.
 * A learner with no enrolment gets a mint failure, which is why the check
 * cannot be bypassed from the browser — there is nothing client-side to
 * tamper with. We map that failure to `needsEnrollment` so the widget can
 * say something useful instead of showing a raw error.
 *
 * The minted token is SINGLE USE, so every launch calls this afresh. Do not
 * add caching here.
 */

import { json, type LoaderFunctionArgs } from "@remix-run/node";

import { embedJwtCookie } from "~/constants/embed-cookie.server";
import { getLessonPlayerPayload } from "~/.server/infuse-api";

/** Absorb's wording when the learner has no enrolment for the course. */
function looksLikeEnrollmentFailure(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("enrollment") ||
    m.includes("enrolment") ||
    m.includes("403") ||
    m.includes("not found") ||
    m.includes("404")
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const token = await embedJwtCookie.parse(request.headers.get("Cookie"));
  if (!token) {
    return json({ needsAuth: true, error: "Sign in to start this course." }, { status: 401 });
  }

  const url = new URL(request.url);
  const courseId = url.searchParams.get("courseId");
  const lessonId = url.searchParams.get("lessonId") ?? undefined;
  if (!courseId) {
    return json({ error: "courseId required" }, { status: 400 });
  }

  try {
    const payload = await getLessonPlayerPayload(courseId, token, {
      mode: "lesson",
      lessonId,
      // Empty returnUrl: inside an iframe there is nowhere sensible to send
      // the learner when the course ends, and a real URL here would navigate
      // the frame away from the player.
      returnUrl: "",
    });
    return json({ playerUrl: payload.playerUrl, lessonId: payload.lessonId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[embed/play] mint failed for course ${courseId}: ${message}`);

    if (looksLikeEnrollmentFailure(message)) {
      return json({ needsEnrollment: true }, { status: 403 });
    }
    // Absorb's error bodies can echo request internals — don't forward them
    // to a page that an arbitrary third-party site is framing.
    return json({ error: "Could not start this course. Please try again." }, { status: 500 });
  }
};
