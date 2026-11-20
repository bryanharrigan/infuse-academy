/**
 * app/routes/embed_.progress.ts  ->  GET /embed/progress?courseId=<id>
 *
 * "Is this learner finished yet, and how did each lesson go?"
 *
 * WHY POLLING
 * -----------
 * Absorb's lesson player gives the embedding page no completion signal — no
 * postMessage, no callback, nothing cross-origin we are allowed to read. So
 * the only way to know is to ask the portal, which is exactly what the LTI
 * side does at /lti/progress. Same approach, different session source: this
 * one reads the embed's own learner cookie.
 *
 * Returns per-lesson detail as well as the overall result, because SCORM has
 * a per-object channel (cmi.objectives.n.*) that can carry it and the data
 * costs one extra call we were making anyway.
 *
 * Read-only. Reports nothing to anyone — the page decides what to do with it.
 */

import { json, type LoaderFunctionArgs } from "@remix-run/node";

import { embedJwtCookie } from "~/constants/embed-cookie.server";
import {
  getCourseProgress,
  lessonResults,
  sourcePortal,
} from "~/.server/lti/portal";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const courseId = url.searchParams.get("courseId");
  if (!courseId) return json({ error: "courseId required" }, { status: 400 });

  const token = await embedJwtCookie.parse(request.headers.get("Cookie"));
  if (!token) return json({ error: "no session" }, { status: 401 });

  const cfg = sourcePortal();

  try {
    // Both in parallel: the breakdown must never delay the overall answer.
    const [progress, lessons] = await Promise.all([
      getCourseProgress(cfg, token, courseId),
      lessonResults(cfg, token, courseId).catch(() => []),
    ]);

    return json({
      complete: progress.complete,
      score: progress.score,
      scoreSource: progress.scoreSource,
      status: progress.status,
      lessons,
    });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
};
