/**
 * app/routes/lti.progress.ts  ->  GET /lti/progress?lid=<launchId>
 *
 * Polled by the player page while the learner is in the course. Asks the
 * source portal whether they have finished, and the moment they have, posts
 * the AGS score back to the host portal.
 *
 * WHY POLL RATHER THAN WAIT FOR A WEBHOOK
 * ---------------------------------------
 * LTI's AGS is how a score is *reported*; it says nothing about how a tool
 * learns that the learner finished. A normal LTI tool hosts the activity, so
 * it simply knows. This one does not: it hands the learner to Absorb's own
 * player on a different portal and a different origin, and cannot see inside
 * that frame.
 *
 * A webhook from the source portal answers that, but needs configuration on
 * the source portal and only reports after the fact. Polling the learner's own
 * enrolment record answers the same question with nothing to configure, and
 * reports while they are still on screen -- which is both a better demo and a
 * faster feedback loop.
 *
 * The webhook receiver at /api/lti/webhook still works and is the right
 * backstop for completions that land after the tab is closed (a graded
 * assignment marked days later, say). It is simply not required.
 *
 * IDEMPOTENCE
 * -----------
 * Polling means this runs repeatedly against a completed course. `claimScorePost`
 * returns true exactly once per launch, so the score is posted once; the claim
 * is released if the post throws, so a transient failure can still retry.
 *
 * ACCESS
 * ------
 * `lid` is an opaque, high-entropy, server-side handle minted by /lti/launch.
 * Holding one lets you ask about that launch's progress and trigger its score
 * post -- it reveals no identity and can only ever report the completion the
 * source portal already recorded.
 */

import { json, type LoaderFunctionArgs } from "@remix-run/node";

import { postScore } from "~/.server/lti/ags";
import { allPlatforms } from "~/.server/lti/platforms";
import { getCourseProgress, sourcePortal } from "~/.server/lti/portal";
import {
  claimScorePost,
  getLaunch,
  recordLtiEvent,
  releaseScorePost,
} from "~/.server/lti/store";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const lid = new URL(request.url).searchParams.get("lid");
  const launch = lid ? getLaunch(lid) : null;

  if (!launch) {
    // Expected after a deploy: the store is in-memory. Tell the page to stop
    // rather than hammer a launch that no longer exists.
    return json({ ok: false, stop: true, reason: "launch expired" }, { status: 410 });
  }
  if (!launch.learnerToken) {
    return json({ ok: false, stop: true, reason: "no learner session" }, { status: 409 });
  }

  let progress;
  try {
    progress = await getCourseProgress(
      sourcePortal(),
      launch.learnerToken,
      launch.sourceCourseId
    );
  } catch (err) {
    // A failed poll is not fatal — the learner is still playing the course.
    return json({
      ok: false,
      stop: false,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  if (!progress.complete) {
    return json({
      ok: true,
      complete: false,
      progress: progress.progress,
      status: progress.status,
    });
  }

  // Complete. Post once.
  if (!claimScorePost(launch.launchId)) {
    return json({ ok: true, complete: true, posted: false, already: true, stop: true });
  }

  const platform = allPlatforms().find((p) => p.id === launch.platformId);
  if (!platform) {
    releaseScorePost(launch.launchId);
    return json({ ok: false, stop: true, reason: "platform registration missing" });
  }

  try {
    const posted = await postScore(platform, launch.ags, {
      ltiSub: launch.ltiSub,
      // Absorb reports a score for scored content and nothing for content that
      // only tracks completion. Treat a bare completion as full marks — a 0
      // would mark a finished course as failed in the host portal.
      scoreGiven: 100,
      scoreMaximum: 100,
      comment: launch.courseTitle ? `Completed: ${launch.courseTitle}` : undefined,
    });

    recordLtiEvent(
      "ags",
      posted
        ? `score posted via polling to ${platform.id} for sub=${launch.ltiSub.slice(0, 8)}...`
        : "completion detected, but the launch carried no AGS line item — " +
            "the host portal gave us nowhere to send it"
    );

    return json({ ok: true, complete: true, posted, stop: true });
  } catch (err) {
    releaseScorePost(launch.launchId);
    const message = err instanceof Error ? err.message : String(err);
    recordLtiEvent("ags", `POST FAILED (polling): ${message}`);
    return json({ ok: false, stop: false, complete: true, posted: false, reason: message });
  }
};
