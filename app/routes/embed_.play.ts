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
 * cannot be bypassed from the browser.
 *
 * WHY THIS ROUTE REPORTS `framable`
 * ---------------------------------
 * Absorb has two player endpoints and they behave differently in an iframe:
 *
 *   /learn/lessonplayer     frames fine on a valid allow-listed launch
 *   /learn/v2/coursePlayer  sends X-Frame-Options: SAMEORIGIN — never frames
 *
 * `getLessonPlayerPayload` falls back to coursePlayer whenever it cannot
 * resolve a lessonId. A Curriculum has child courses rather than chapters, so
 * `getChaptersForCourse` returns nothing for one and every curriculum took
 * that fallback — producing a silently blank frame in the embed.
 *
 * Detecting the block client-side does not work: Chrome fires `load` on the
 * refusal page, so a watchdog keyed on "did it load" never trips. Instead we
 * decide here, where the answer is knowable with certainty, and tell the
 * client which UI to render. See the CURRICULUM section below for how we
 * avoid the fallback in the first place.
 *
 * The minted token is SINGLE USE, so every launch calls this afresh. Do not
 * add caching here.
 */

import { json, type LoaderFunctionArgs } from "@remix-run/node";

import { embedJwtCookie } from "~/constants/embed-cookie.server";
import {
  getCurriculumChildren,
  getLessonPlayerPayload,
  getPortalCourseUrl,
} from "~/.server/infuse-api";
import { getEmbedCourse } from "~/.server/embed-catalog";
import {
  ProvisionBusyError,
  autoProvisionEnabled,
  provisionDemoLearner,
} from "~/.server/embed-provision";

/** Only the lesson player can be framed — see the header comment. */
function isFramable(playerUrl: string): boolean {
  return playerUrl.includes("/learn/lessonplayer");
}

/**
 * Absorb's wording when the learner has no enrolment for the course.
 *
 * Deliberately narrow. An earlier version also matched "404"/"not found",
 * which made an unknown course id look like an entitlement problem and sent
 * the learner a misleading message.
 */
function looksLikeEnrollmentFailure(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("enrollment") ||
    m.includes("enrolment") ||
    m.includes("not enrolled") ||
    m.includes(" 403")
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const courseId = url.searchParams.get("courseId");
  const lessonId = url.searchParams.get("lessonId") ?? undefined;
  if (!courseId) {
    return json({ error: "courseId required" }, { status: 400 });
  }

  let token = await embedJwtCookie.parse(request.headers.get("Cookie"));

  /**
   * No session yet. With auto-provisioning on, create a throwaway learner so
   * the visitor goes straight to playing — no sign-in, no signup form.
   *
   * The cookie check above is the session-reuse guard: a visitor who already
   * has one never reaches here, so refreshing the page does not mint a second
   * account. See embed-provision.ts for the other limits.
   */
  let setCookie: string | null = null;
  if (!token && autoProvisionEnabled()) {
    try {
      const provisioned = await provisionDemoLearner(courseId);
      token = provisioned.token;
      setCookie = await embedJwtCookie.serialize(provisioned.token);
    } catch (err) {
      if (err instanceof ProvisionBusyError) {
        return json(
          {
            error:
              "This demo is handling a lot of traffic right now. Try again in a few minutes.",
          },
          { status: 429 }
        );
      }
      // Fall through to the sign-in prompt rather than dead-ending: the
      // existing credential path still works when provisioning is misconfigured.
      console.error(
        "[embed/play] auto-provisioning failed:",
        err instanceof Error ? err.message : err
      );
    }
  }

  if (!token) {
    return json({ needsAuth: true, error: "Sign in to start this course." }, { status: 401 });
  }

  /** Attach the new session to whatever we return below. */
  const withCookie = (payload: unknown, init?: ResponseInit) =>
    json(payload, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        ...(setCookie ? { "Set-Cookie": setCookie } : {}),
      },
    });

  try {
    const course = await getEmbedCourse(courseId).catch(() => null);

    /* ── CURRICULUM ────────────────────────────────────────────────────────
     * A curriculum is a container, not playable content. Absorb's own portal
     * renders a child-course list for one. We resolve the first playable
     * online child and launch THAT in the lesson player, so the common case
     * ("play this curriculum") works inline instead of dead-ending on the
     * unframable course player.
     *
     * If there is no online child, we hand back the portal URL and let the
     * widget offer to open Absorb in a new window — the child might be
     * instructor-led or another curriculum, neither of which embeds.
     */
    if (course?.courseType === "Curriculum" && !lessonId) {
      let children: Awaited<ReturnType<typeof getCurriculumChildren>> = [];
      try {
        children = await getCurriculumChildren(token, courseId);
      } catch (err) {
        console.warn(
          `[embed/play] curriculum children lookup failed for ${courseId}:`,
          err instanceof Error ? err.message : err
        );
      }

      const playable = children.find((c) => c.courseType === "OnlineCourse");
      if (playable) {
        const childPayload = await getLessonPlayerPayload(playable.id, token, {
          mode: "lesson",
          returnUrl: "",
        });
        return withCookie({
          playerUrl: childPayload.playerUrl,
          lessonId: childPayload.lessonId,
          framable: isFramable(childPayload.playerUrl),
          // So the widget can say which child it opened rather than showing
          // the curriculum's name over unrelated content.
          playingCourseId: playable.id,
          playingCourseName: playable.name,
          partOfCurriculum: true,
        });
      }

      return withCookie({
        notEmbeddable: true,
        reason:
          "This curriculum has no online course that can play inside an embedded frame.",
        externalUrl: getPortalCourseUrl(courseId),
      });
    }

    const payload = await getLessonPlayerPayload(courseId, token, {
      mode: "lesson",
      lessonId,
      // Empty returnUrl: inside an iframe there is nowhere sensible to send
      // the learner when the course ends, and a real URL here would navigate
      // the frame away from the player.
      returnUrl: "",
    });

    const framable = isFramable(payload.playerUrl);
    if (!framable) {
      console.warn(
        `[embed/play] course ${courseId} resolved to the unframable course player ` +
          `(no lessonId could be determined) — returning open-in-window instead`
      );
    }

    return withCookie({
      playerUrl: payload.playerUrl,
      lessonId: payload.lessonId,
      framable,
      externalUrl: getPortalCourseUrl(courseId),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[embed/play] mint failed for course ${courseId}: ${message}`);

    if (looksLikeEnrollmentFailure(message)) {
      return withCookie({ needsEnrollment: true }, { status: 403 });
    }
    // Absorb's error bodies can echo request internals — don't forward them
    // to a page that an arbitrary third-party site is framing.
    return withCookie(
      { error: "Could not start this course. Please try again." },
      { status: 500 }
    );
  }
};
