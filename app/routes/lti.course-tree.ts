/**
 * app/routes/lti.course-tree.ts  ->  GET /lti/course-tree?key=<LTI_DIAG_KEY>&course=<id>
 *
 * Dumps the RAW chapter and lesson tree for a source-portal course, plus the
 * course object itself.
 *
 * WHY THIS EXISTS
 * ---------------
 * The player currently shows one lesson. Showing the whole course means
 * rendering the chapter/lesson tree ourselves and honouring whatever ordering
 * rule the source course is configured with — Absorb locks by CHAPTER ("All
 * Lessons, in Order by Chapter"), not by lesson.
 *
 * Which of that the Infuse API actually exposes is unknown, and guessing an
 * undocumented payload shape is exactly how the SMOWL claim set went wrong.
 * So: look first, build second. One call answers whether there is a lock or
 * prerequisite flag to honour, or whether we have to derive it from chapter
 * completion.
 *
 * Read-only. Provisions through the normal path, so it exercises the same
 * code a launch does, but it starts nothing and writes nothing.
 *
 * DELETE THIS once the rail is built.
 */

import { json, type LoaderFunctionArgs } from "@remix-run/node";

import { provisionAndEnrol, sourcePortal } from "~/.server/lti/portal";

async function getJson(url: string, apiKey: string, token: string) {
  const r = await fetch(url, {
    headers: {
      "x-api-key": apiKey,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
  });
  const raw = await r.text();
  if (!r.ok) return { status: r.status, error: raw.slice(0, 400) };
  try {
    return { status: r.status, body: JSON.parse(raw) };
  } catch {
    return { status: r.status, unparsed: raw.slice(0, 400) };
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const diagKey = process.env.LTI_DIAG_KEY ?? "";
  if (!diagKey || url.searchParams.get("key") !== diagKey) {
    return json({ error: "Set LTI_DIAG_KEY and pass ?key=<it>." }, { status: 403 });
  }

  const courseId = url.searchParams.get("course");
  if (!courseId) {
    return json(
      { error: "Pass ?course=<courseId> from the source portal." },
      { status: 400 }
    );
  }

  const cfg = sourcePortal();

  try {
    const learner = await provisionAndEnrol(cfg, {
      iss: "https://diag.local",
      sub: "course-tree-probe",
      firstName: "Tree",
      lastName: "Probe",
      email: null,
      courseId,
    });

    const [course, chapters] = await Promise.all([
      getJson(`${cfg.apiUrl}/online-courses/${courseId}`, cfg.apiKey, learner.token),
      getJson(
        `${cfg.apiUrl}/online-courses/${courseId}/chapters`,
        cfg.apiKey,
        learner.token
      ),
    ]);

    return json({
      courseId,
      learnerMode: learner.mode,
      note:
        "Looking for: a per-chapter or per-lesson lock/prerequisite flag, a " +
        "'must complete' or ordering setting on the course, and whether " +
        "lesson type is exposed (some types may not play in the lesson player).",
      course,
      chapters,
    });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
};
