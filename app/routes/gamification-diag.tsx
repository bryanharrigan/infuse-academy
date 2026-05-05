/**
 * app/routes/gamification-diag.tsx
 *
 * Throwaway diagnostic — runs the same gamification computation as the
 * /my-courses loader and dumps the inputs + outputs so we can see why
 * a particular course / lesson / ILT doesn't show up in the rings.
 *
 *   GET /gamification-diag
 *
 * Returns the per-course status list, per-lesson progress dates, the
 * computed gamification object, and the per-ILT enrollment.progress
 * values. Renders as JSON in the browser; nothing user-facing.
 */

import { LoaderFunctionArgs, json } from "@remix-run/node";
import {
  getMyCourses,
  getMyCourseEnrollment,
  getChaptersForCourse,
  type Chapter,
  type Lesson,
} from "~/.server/infuse-api";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";
import { computeGamification } from "~/.server/gamification";

export async function loader({ request }: LoaderFunctionArgs) {
  const cookieHeader = request.headers.get("Cookie");
  const token = await infuseJwtCookie.parse(cookieHeader);
  if (!token) return json({ error: "unauthorized" }, { status: 401 });

  const myCoursesRes = await getMyCourses(token, {
    limit: 20,
    showCompleted: true,
  });
  const myCourses = myCoursesRes._embedded.courses;

  // Chapters for every Online course
  const trackable = myCourses
    .filter(
      (c) =>
        c.courseType === "OnlineCourse" &&
        (c.enrollmentStatus === "InProgress" ||
          c.enrollmentStatus === "Complete" ||
          c.enrollmentStatus === "Completed")
    )
    .slice(0, 20);
  const chapterEntries = await Promise.all(
    trackable.map(async (c) => {
      try {
        const chapters = await getChaptersForCourse(token, c.id);
        return [c.id, chapters] as [string, Chapter[]];
      } catch (err) {
        return [c.id, [] as Chapter[]] as [string, Chapter[]];
      }
    })
  );
  const chaptersByCourse = new Map<string, Chapter[]>(chapterEntries);
  const gamification = computeGamification({ myCourses, chaptersByCourse });

  // Per-ILT enrollment data
  const iltCourses = myCourses.filter(
    (c) => c.courseType === "InstructorLedCourse"
  );
  const iltEnrollments = await Promise.all(
    iltCourses.map(async (c) => {
      try {
        const e = await getMyCourseEnrollment(token, c.id);
        return {
          id: c.id,
          name: c.name,
          courseStatus: c.enrollmentStatus,
          enrollmentRecord: {
            progress: e.progress,
            enrollmentStatus: e.enrollmentStatus,
            enrollmentDate: e.enrollmentDate,
            completionDate: e.completionDate,
          },
        };
      } catch (err) {
        return {
          id: c.id,
          name: c.name,
          courseStatus: c.enrollmentStatus,
          enrollmentRecord: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );

  // Per-course chapter summary (which lessons we have completion data for)
  const lessonSummary = trackable.map((c) => {
    const chapters = chaptersByCourse.get(c.id) ?? [];
    const lessons: Array<{
      name: string;
      status: string | undefined;
      completedDate: string | null | undefined;
    }> = [];
    for (const ch of chapters) {
      for (const l of ch._embedded?.lessons ?? []) {
        lessons.push({
          name: l.name ?? l.title ?? "(untitled)",
          status: l.progress?.status,
          completedDate: l.progress?.completedDate,
        });
      }
    }
    return {
      id: c.id,
      name: c.name,
      status: c.enrollmentStatus,
      chapterCount: chapters.length,
      lessons,
    };
  });

  return json({
    courseSummary: myCourses.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.courseType,
      status: c.enrollmentStatus,
    })),
    gamification: {
      totalXp: gamification.totalXp,
      level: gamification.level,
      xpInLevel: gamification.xpInLevel,
      xpForNextLevel: gamification.xpForNextLevel,
      rank: gamification.rank,
      rankLabel: gamification.rankLabel,
      streakDays: gamification.streakDays,
      counts: gamification.counts,
    },
    chapterFetched: trackable.length,
    iltEnrollments,
    lessonSummary,
  });
}
