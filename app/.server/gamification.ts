/**
 * app/.server/gamification.ts
 *
 * Pure functions that turn raw Absorb V2 data (my-courses, lesson chapters,
 * enrollment dates) into the gamification primitives the Experimental
 * Learning Hub renders:
 *
 *   - Tier ranks: Bronze → Silver → Gold → Platinum → Diamond
 *   - XP / Level: 1–50, with a curved XP-per-level requirement
 *   - Daily streak: consecutive days of any learning activity
 *   - Achievements: unlockable medals tied to specific milestones
 *
 * Computation is server-side so it shows up correctly on first paint and so
 * the page doesn't re-shuffle on hydration. The route loader passes the
 * resulting `Gamification` object straight to the React component.
 *
 * Sources of truth:
 *   - Course-level: my-courses (enrollmentStatus + enrollmentDate +
 *     completionDate from /my-course-enrollments/:id when fetched)
 *   - Lesson-level: chapters from /online-courses/:id/chapters → their
 *     embedded lessons with `progress.status` and `progress.completedDate`
 *
 * Lesson tracking is "accurate" in the sense that we count actual completed
 * lessons reported by Absorb — not estimated from a 50%/100% bucket like
 * the existing learning-hub fallback.
 */

import type { Course } from "./course.resource";
import type { Chapter, Lesson } from "./infuse-api";

/* ─── Types ─────────────────────────────────────────────────────────────── */

export type RankTier = "bronze" | "silver" | "gold" | "platinum" | "diamond";

export type Achievement = {
  id: string;
  emoji: string;
  title: string;
  description: string;
  earned: boolean;
};

export type Gamification = {
  totalXp: number;
  level: number; // 1..50
  /** XP at the start of the current level (i.e. the level's threshold). */
  levelStartXp: number;
  /** XP at the start of the next level (Infinity if at max). */
  nextLevelXp: number;
  /** XP earned within the current level. */
  xpInLevel: number;
  /** XP needed to reach the next level. */
  xpForNextLevel: number;
  /** 0..1 progress through the current level. */
  levelProgress: number;
  /** Capped at 50; remains there once max'd. */
  isMaxLevel: boolean;
  rank: RankTier;
  /** Friendly rank label, e.g. "Diamond Scholar". */
  rankLabel: string;
  /** Days in a row the learner has done at least one lesson/course completion. */
  streakDays: number;
  /** Achievements: earned + locked, in the order they should display. */
  achievements: Achievement[];
  /** Raw counts for UI labels ("12 / 40 lessons completed"). */
  counts: {
    enrolled: number;
    coursesCompleted: number;
    lessonsCompleted: number;
    lessonsTotal: number;
  };
};

/* ─── XP economy ────────────────────────────────────────────────────────── */

/**
 * XP weights are intentionally generous so a learner with a handful of
 * completions sees real progression. Tune freely — the page just renders
 * whatever numbers come out the other side.
 */
export const XP_PER_LESSON = 25;
export const XP_PER_COURSE_COMPLETED = 200;
export const XP_PER_COURSE_ENROLLED = 30;

/**
 * Cumulative XP required to *reach* a given level. levelXpThreshold(1) === 0.
 * Curve: each level needs `100 + 50 * (level - 1)` XP — roughly linear with
 * a small ramp, so level 50 sits at 67k XP.
 */
export function levelXpThreshold(level: number): number {
  if (level <= 1) return 0;
  // Sum of an arithmetic series: a=100, d=50, n=level-1.
  const n = level - 1;
  return Math.round((n * (2 * 100 + (n - 1) * 50)) / 2);
}

const MAX_LEVEL = 50;

function levelForXp(xp: number): number {
  for (let lvl = MAX_LEVEL; lvl >= 1; lvl--) {
    if (xp >= levelXpThreshold(lvl)) return lvl;
  }
  return 1;
}

/* ─── Tier ranks ────────────────────────────────────────────────────────── */

const TIER_THRESHOLDS: ReadonlyArray<{
  tier: RankTier;
  minCompleted: number;
  label: (firstName: string) => string;
}> = [
  { tier: "diamond", minCompleted: 25, label: () => "Diamond Scholar" },
  { tier: "platinum", minCompleted: 12, label: () => "Platinum Pathfinder" },
  { tier: "gold", minCompleted: 6, label: () => "Gold Voyager" },
  { tier: "silver", minCompleted: 2, label: () => "Silver Apprentice" },
  { tier: "bronze", minCompleted: 0, label: () => "Bronze Initiate" },
];

function pickTier(coursesCompleted: number): {
  tier: RankTier;
  label: string;
} {
  for (const t of TIER_THRESHOLDS) {
    if (coursesCompleted >= t.minCompleted) {
      return { tier: t.tier, label: t.label("") };
    }
  }
  return { tier: "bronze", label: "Bronze Initiate" };
}

/* ─── Streak ────────────────────────────────────────────────────────────── */

/**
 * Compute the current daily streak from a list of activity dates.
 *
 * "Streak day" = a calendar day (UTC) on which any lesson or course
 * completion was recorded. We walk backwards from today: if today is
 * inactive but yesterday was, the streak counts yesterday onward — only
 * breaks if there's a 2+ day gap.
 *
 * Pure function. Caller passes whatever date set they have available; in
 * practice this comes from lesson `completedDate` + course `completionDate`.
 */
export function computeStreak(activityDates: ReadonlyArray<string | null | undefined>): number {
  const days = new Set<string>();
  for (const raw of activityDates) {
    if (!raw) continue;
    const d = new Date(raw);
    if (isNaN(d.getTime())) continue;
    days.add(d.toISOString().slice(0, 10)); // YYYY-MM-DD UTC
  }
  if (days.size === 0) return 0;

  const today = new Date();
  let cursor = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  );
  let streak = 0;

  // If today isn't active, allow the streak to start from yesterday.
  if (!days.has(cursor.toISOString().slice(0, 10))) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    if (!days.has(cursor.toISOString().slice(0, 10))) return 0;
  }

  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

/* ─── Lesson helpers ────────────────────────────────────────────────────── */

/**
 * Pull the canonical completion signal off a lesson.
 *
 * Absorb V2 stores per-lesson completion data on `lesson.enrollment`,
 * NOT `lesson.progress` (the latter is essentially never populated on
 * this tenant). The enrollment object looks like:
 *   { status: "Complete", progress: 100, completionDate: "2026-..." }
 *
 * We accept either shape so older response formats don't break, but
 * `enrollment` wins when both are present.
 */
function lessonStatus(l: Lesson): string {
  return (
    l.enrollment?.status ??
    l.progress?.status ??
    ""
  ).toLowerCase();
}

function lessonCompletionDate(l: Lesson): string | null | undefined {
  return l.enrollment?.completionDate ?? l.progress?.completedDate;
}

function isLessonComplete(l: Lesson): boolean {
  const s = lessonStatus(l);
  if (s === "complete" || s === "completed") return true;
  return Boolean(lessonCompletionDate(l));
}

function flattenLessons(chapters: Chapter[]): Lesson[] {
  return chapters.flatMap((c) => c._embedded?.lessons ?? []);
}

/* ─── Main computation ─────────────────────────────────────────────────── */

export type GamificationInput = {
  myCourses: Course[];
  /**
   * Map of courseId → chapters fetched from /online-courses/{id}/chapters.
   * The route loader is responsible for fetching these in parallel for any
   * subset of courses it wants to count lessons for. Courses absent from
   * the map fall back to status-based estimation (50% for InProgress).
   */
  chaptersByCourse: ReadonlyMap<string, Chapter[]>;
};

export function computeGamification({
  myCourses,
  chaptersByCourse,
}: GamificationInput): Gamification {
  /* Counts ------------------------------------------------------------- */
  const enrolled = myCourses.length;
  const coursesCompleted = myCourses.filter(
    (c) => c.enrollmentStatus === "Complete" || c.enrollmentStatus === "Completed"
  ).length;

  let lessonsCompleted = 0;
  let lessonsTotal = 0;
  const activityDates: string[] = [];

  for (const course of myCourses) {
    const chapters = chaptersByCourse.get(course.id);
    const courseIsComplete =
      course.enrollmentStatus === "Complete" ||
      course.enrollmentStatus === "Completed";

    if (chapters) {
      const lessons = flattenLessons(chapters);
      lessonsTotal += lessons.length;

      if (courseIsComplete) {
        // Course rolled up to complete → every lesson is complete. Count
        // them all + harvest any per-lesson completion dates we can.
        lessonsCompleted += lessons.length;
        for (const lesson of lessons) {
          const d = lessonCompletionDate(lesson);
          if (d) activityDates.push(d);
        }
      } else {
        // For not-complete courses, count only lessons that report
        // completion explicitly via `lesson.enrollment.completionDate`.
        for (const lesson of lessons) {
          if (isLessonComplete(lesson)) {
            lessonsCompleted += 1;
            const d = lessonCompletionDate(lesson);
            if (d) activityDates.push(d);
          }
        }
      }
    } else {
      // Fallback when we didn't fetch chapters for this course (capped at 8
      // in the loader). Status-based estimate so XP isn't wildly wrong.
      if (courseIsComplete) {
        lessonsCompleted += 4;
        lessonsTotal += 4;
      } else if (course.enrollmentStatus === "InProgress") {
        lessonsCompleted += 1;
        lessonsTotal += 2;
      }
    }
  }

  /* XP + level --------------------------------------------------------- */
  const totalXp =
    lessonsCompleted * XP_PER_LESSON +
    coursesCompleted * XP_PER_COURSE_COMPLETED +
    enrolled * XP_PER_COURSE_ENROLLED;

  const level = levelForXp(totalXp);
  const isMaxLevel = level >= MAX_LEVEL;
  const levelStartXp = levelXpThreshold(level);
  const nextLevelXp = isMaxLevel ? Infinity : levelXpThreshold(level + 1);
  const xpInLevel = totalXp - levelStartXp;
  const xpForNextLevel = isMaxLevel ? 1 : nextLevelXp - levelStartXp;
  const levelProgress = isMaxLevel ? 1 : Math.min(1, xpInLevel / xpForNextLevel);

  /* Tier --------------------------------------------------------------- */
  const { tier, label: rankLabel } = pickTier(coursesCompleted);

  /* Streak ------------------------------------------------------------- */
  const streakDays = computeStreak(activityDates);

  /* Achievements ------------------------------------------------------- */
  const achievements: Achievement[] = [
    {
      id: "first-step",
      emoji: "🌱",
      title: "First Step",
      description: "Enrolled in your very first course.",
      earned: enrolled >= 1,
    },
    {
      id: "ignition",
      emoji: "✨",
      title: "Ignition",
      description: "Completed your first lesson.",
      earned: lessonsCompleted >= 1,
    },
    {
      id: "trailblazer",
      emoji: "🚀",
      title: "Trailblazer",
      description: "Completed your first course end-to-end.",
      earned: coursesCompleted >= 1,
    },
    {
      id: "scholar",
      emoji: "📚",
      title: "Scholar",
      description: "Completed five courses.",
      earned: coursesCompleted >= 5,
    },
    {
      id: "marathon",
      emoji: "🏃",
      title: "Marathon",
      description: "Completed twenty-five lessons.",
      earned: lessonsCompleted >= 25,
    },
    {
      id: "centurion",
      emoji: "💯",
      title: "Centurion",
      description: "Completed one hundred lessons.",
      earned: lessonsCompleted >= 100,
    },
    {
      id: "streak-3",
      emoji: "🔥",
      title: "On Fire",
      description: "Three-day learning streak.",
      earned: streakDays >= 3,
    },
    {
      id: "streak-7",
      emoji: "⚡",
      title: "Lightning",
      description: "Seven-day learning streak.",
      earned: streakDays >= 7,
    },
    {
      id: "platinum-tier",
      emoji: "🪐",
      title: "Pathfinder",
      description: "Reached the Platinum tier.",
      earned: tier === "platinum" || tier === "diamond",
    },
    {
      id: "diamond-tier",
      emoji: "💎",
      title: "Apex",
      description: "Reached the Diamond tier.",
      earned: tier === "diamond",
    },
    {
      id: "level-10",
      emoji: "🎯",
      title: "Level 10",
      description: "Earned 10 levels of XP.",
      earned: level >= 10,
    },
    {
      id: "level-25",
      emoji: "🌟",
      title: "Quarter Century",
      description: "Earned 25 levels of XP.",
      earned: level >= 25,
    },
  ];

  return {
    totalXp,
    level,
    levelStartXp,
    nextLevelXp,
    xpInLevel,
    xpForNextLevel,
    levelProgress,
    isMaxLevel,
    rank: tier,
    rankLabel,
    streakDays,
    achievements,
    counts: {
      enrolled,
      coursesCompleted,
      lessonsCompleted,
      lessonsTotal,
    },
  };
}
