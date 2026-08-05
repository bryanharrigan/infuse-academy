import { Box, CircularProgress, Typography, Button } from "@mui/material";
import { json, redirect, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useLoaderData, useRouteLoaderData } from "@remix-run/react";
import {
  getMyCourses,
  getMyCourseEnrollment,
  getChaptersForCourse,
  getMyILTEnrollments,
  InfusePortalUrl,
  type Chapter,
} from "~/.server/infuse-api";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";
import { computeGamification } from "~/.server/gamification";
import { useMyCourses } from "~/routes/use-my-courses.hook";
import { CourseDetailModal } from "~/components/modal/course-detail-modal";
import { LessonPlayerModal } from "~/components/modal/lesson-player-modal";
import { SessionsModal } from "~/components/modal/sessions-modal";
import { CurriculumModal } from "~/components/modal/curriculum-modal";
import { CourseCard } from "~/components/course-card/course-card.component";
import { useAppStateContext } from "~/context/app-state.context";

type RootData = {
  userProfile: { firstName: string; lastName: string };
  avatarUrl: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const cookieHeader = request.headers.get("Cookie");
  const tokenValue = await infuseJwtCookie.parse(cookieHeader);
  if (!tokenValue) throw redirect("/signin");

  const myCoursesRes = await getMyCourses(tokenValue, {
    limit: 20,
    showCompleted: true,
  });
  const myCourses = myCoursesRes._embedded.courses;

  /* ─── Lesson tracking for gamification ─────────────────────────────── */
  // Fetch chapters for every Online course the learner is engaged with
  // so a lesson completed today gets picked up in the XP / streak math.
  // Cap to 20 (Absorb's per-page max) to keep the loader responsive.
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
        const chapters = await getChaptersForCourse(tokenValue, c.id);
        return [c.id, chapters] as [string, Chapter[]];
      } catch {
        return [c.id, [] as Chapter[]] as [string, Chapter[]];
      }
    })
  );
  const chaptersByCourse = new Map<string, Chapter[]>(chapterEntries);
  const gamification = computeGamification({ myCourses, chaptersByCourse });

  /* ─── Most-recent curriculum + its progress ────────────────────────── */
  // Pull enrollment records for every curriculum (capped at 5) and pick
  // the one with the most recent `enrollmentDate`. The progress field
  // on the enrollment record IS Absorb's authoritative percentage, so we
  // can render it directly in the second progress ring.
  const curricula = myCourses
    .filter((c) => c.courseType === "Curriculum")
    .slice(0, 5);
  const curriculumEntries = await Promise.all(
    curricula.map(async (c) => {
      try {
        const e = await getMyCourseEnrollment(tokenValue, c.id);
        return { course: c, enrollment: e };
      } catch {
        return null;
      }
    })
  );
  const curriculumWithEnrollment = curriculumEntries.filter(
    (e): e is { course: typeof curricula[number]; enrollment: Awaited<ReturnType<typeof getMyCourseEnrollment>> } =>
      e !== null
  );
  const recentCurriculum =
    curriculumWithEnrollment.length === 0
      ? null
      : [...curriculumWithEnrollment].sort((a, b) => {
          const aT = a.enrollment.enrollmentDate
            ? new Date(a.enrollment.enrollmentDate).getTime()
            : 0;
          const bT = b.enrollment.enrollmentDate
            ? new Date(b.enrollment.enrollmentDate).getTime()
            : 0;
          return bT - aT;
        })[0];

  /* ─── ILT progress ─────────────────────────────────────────────────── */
  // Absorb's /my-courses doesn't surface ILT registrations on this
  // tenant — they live at session level. Discover them via the catalog
  // walk (getMyILTEnrollments). Each entry is one session the learner
  // is registered for.
  const iltEnrollments = await getMyILTEnrollments(tokenValue).catch(
    () => [] as Awaited<ReturnType<typeof getMyILTEnrollments>>
  );

  // Per-session progress: prefer Absorb's enrollmentStatus on the
  // session itself; fall back to weighted scoring so a registered-but-
  // not-yet-attended session still pulls the ring forward.
  const iltCompleted = iltEnrollments.filter((r) => {
    const s = (r.session.enrollmentStatus ?? "").toLowerCase();
    return s === "complete" || s === "completed";
  }).length;
  const iltInProgress = iltEnrollments.filter(
    (r) => r.session.enrollmentStatus === "InProgress"
  ).length;
  const iltProgressTotal = iltEnrollments.reduce((sum, r) => {
    const s = (r.session.enrollmentStatus ?? "").toLowerCase();
    if (s === "complete" || s === "completed") return sum + 1;
    if (s === "inprogress") return sum + 0.5;
    // Registered but not yet attended — the session is in the future
    // or hasn't been graded yet. Half-credit so the ring isn't 0%.
    return sum + 0.25;
  }, 0);

  const iltStats = {
    total: iltEnrollments.length,
    enrolled: iltEnrollments.length,
    completed: iltCompleted,
    inProgress: iltInProgress,
    progress:
      iltEnrollments.length > 0
        ? iltProgressTotal / iltEnrollments.length
        : 0,
  };

  return json({
    myCourses: myCoursesRes,
    portalBaseUrl: InfusePortalUrl.replace(/\/$/, ""),
    gamification,
    recentCurriculum,
    iltStats,
  });
};

/**
 * Progress ring for the IA theme variant. Uses the SVG gradient defined in
 * root.tsx. `progress` is 0..1.
 */
const ProgressRing: React.FC<{ progress: number; label: string }> = ({
  progress,
  label,
}) => {
  const circumference = 2 * Math.PI * 24; // r=24 in the 52x52 viewBox
  const offset = circumference * (1 - Math.max(0, Math.min(1, progress)));
  return (
    <div className="ia-stat-card">
      <div className="ia-progress-ring">
        <svg viewBox="0 0 52 52" className="ia-progress-ring__svg">
          <circle
            className="ia-progress-ring__bg"
            cx="26"
            cy="26"
            r="24"
          />
          <circle
            className="ia-progress-ring__fill"
            cx="26"
            cy="26"
            r="24"
            strokeDasharray={circumference.toFixed(1)}
            strokeDashoffset={offset.toFixed(1)}
          />
        </svg>
        <span className="ia-progress-ring__text">
          {Math.round(progress * 100)}%
        </span>
      </div>
      <div className="ia-stat-card__label">{label}</div>
    </div>
  );
};

export default function MyCourses() {
  const data = useLoaderData<typeof loader>();
  const rootData = useRouteLoaderData("root") as RootData | null;
  const { themeVariant } = useAppStateContext();
  // IA layout also powers the RadNet variant.
  const isIA = themeVariant !== "default";
  const {
    courses,
    selectedCourse,
    playingCourse,
    sessionsCourse,
    curriculumCourse,
    handleCardClick,
    handleStartCourse,
    handleStartCourseDirect,
    handlePickChildCourse,
    handleCloseDetailModal,
    handleClosePlayer,
    handleCloseSessions,
    handleCloseCurriculum,
  } = useMyCourses(data);

  // Real gamification computed server-side from completion data.
  const { gamification, recentCurriculum, iltStats } = data;

  const totalCount = courses.length;
  const completedCount = gamification.counts.coursesCompleted;
  const inProgressCount = courses.filter(
    (c) => c.enrollmentStatus === "InProgress"
  ).length;

  // Overall progress — weighted: complete = 1, in-progress = 0.5,
  // not-started = 0. Mirrors the "average progress" stat on the
  // experimental hub.
  const overallProgress =
    totalCount > 0
      ? courses.reduce((sum, c) => {
          if (
            c.enrollmentStatus === "Complete" ||
            c.enrollmentStatus === "Completed"
          )
            return sum + 1;
          if (c.enrollmentStatus === "InProgress") return sum + 0.5;
          return sum;
        }, 0) / totalCount
      : 0;

  // Tier letter — matches the experimental hub's rank badge.
  const rankBadgeChar = (rank: typeof gamification.rank): string =>
    rank === "diamond"
      ? "◆"
      : rank === "platinum"
      ? "P"
      : rank === "gold"
      ? "G"
      : rank === "silver"
      ? "S"
      : "B";

  if (!courses || courses.length === 0) {
    return (
      <Box className="flex justify-center p-12">
        <CircularProgress />
      </Box>
    );
  }

  // ─── Infuse Academy variant ──────────────────────────────────────────
  if (isIA) {
    const firstName = rootData?.userProfile?.firstName ?? "Learner";
    return (
      <div>
        {/* Hero */}
        <section className="ia-hero ia-animate" style={{ marginTop: 72 }}>
          <div className="ia-hero__inner">
            <div>
              <h1 className="ia-hero__title">
                Welcome back,{" "}
                <span className="ia-text-gradient">{firstName}</span>
              </h1>
              <p className="ia-hero__sub">
                Track your progress, earn achievements, and keep your streak
                alive.
              </p>
            </div>
            <div>
              <Button
                component={Link}
                to="/catalog"
                variant="contained"
                color="primary"
                size="large"
              >
                Browse Catalog →
              </Button>
            </div>
          </div>
        </section>

        {/* Gamification bar — same data source as the Experimental
            Learning Hub (computeGamification). XP / level / streak /
            rank are all real numbers, not approximations. */}
        <section
          className="ia-gamification-bar ia-animate"
          data-rank={gamification.rank}
        >
          <div className="ia-gamification-bar__grid">
            <div className="ia-gamification-bar__item">
              <div className="ia-gamification-bar__label">
                Experience Points
              </div>
              <div
                className="ia-xp-bar"
                style={
                  {
                    ["--xp" as string]: `${Math.round(
                      gamification.levelProgress * 100
                    )}%`,
                  } as React.CSSProperties
                }
              >
                <div className="ia-xp-bar__fill" />
              </div>
              <div className="ia-gamification-bar__meta">
                <span>
                  {gamification.totalXp.toLocaleString()} XP
                  {!gamification.isMaxLevel && (
                    <>
                      {" "}
                      ·{" "}
                      <span style={{ opacity: 0.7 }}>
                        {gamification.xpInLevel} /{" "}
                        {gamification.xpForNextLevel} to L
                        {gamification.level + 1}
                      </span>
                    </>
                  )}
                </span>
                <span className="ia-badge ia-badge--sm">
                  Level {gamification.level}
                </span>
              </div>
            </div>
            <div className="ia-gamification-bar__item">
              <div className="ia-gamification-bar__label">Streak</div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  marginTop: 6,
                }}
              >
                <span style={{ fontSize: "1.8rem", lineHeight: 1 }}>
                  🔥
                </span>
                <div>
                  <div
                    style={{
                      fontFamily: "'Space Grotesk', sans-serif",
                      fontWeight: 800,
                      fontSize: "1.6rem",
                      lineHeight: 1,
                    }}
                  >
                    {gamification.streakDays}
                  </div>
                  <div
                    style={{
                      fontSize: "0.7rem",
                      color: "var(--ia-text-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.12em",
                      marginTop: 2,
                    }}
                  >
                    {gamification.streakDays === 1 ? "day" : "days"}
                  </div>
                </div>
              </div>
            </div>
            <div
              className="ia-gamification-bar__item"
              style={{ textAlign: "center" }}
            >
              <div className="ia-gamification-bar__label">Rank</div>
              {/* Tier badge — same gradient palette as the experimental
                  hub's rank card. Letter inside follows the tier:
                  B/S/G/P/◆ for Bronze/Silver/Gold/Platinum/Diamond. */}
              <div
                className="exp-xp-card__rank-badge"
                style={{
                  margin: "8px auto 6px",
                  width: 64,
                  height: 64,
                  borderRadius: 18,
                  fontSize: "1.4rem",
                }}
              >
                <span>{rankBadgeChar(gamification.rank)}</span>
              </div>
              <div
                style={{
                  fontWeight: 700,
                  fontSize: "0.95rem",
                  fontFamily: "'Space Grotesk', sans-serif",
                }}
              >
                {gamification.rankLabel}
              </div>
            </div>
          </div>
        </section>

        {/* Progress rings — three real signals:
              1. Overall progress across every enrolled course
              2. Most recently enrolled curriculum's progress (Absorb's
                 own enrollment.progress field — authoritative)
              3. ILT enrollment progression: % of registered ILT courses
                 the learner has completed                              */}
        <section className="ia-section--tight">
          <div className="ia-container">
            <div className="ia-stats-row ia-animate">
              <ProgressRing
                progress={overallProgress}
                label={`Overall · ${totalCount} ${
                  totalCount === 1 ? "course" : "courses"
                }`}
              />
              <ProgressRing
                progress={
                  recentCurriculum
                    ? Math.max(
                        0,
                        Math.min(1, recentCurriculum.enrollment.progress / 100)
                      )
                    : 0
                }
                label={
                  recentCurriculum
                    ? `Curriculum · ${recentCurriculum.course.name}`
                    : "No curriculum enrolled"
                }
              />
              <ProgressRing
                progress={iltStats.progress}
                label={
                  iltStats.enrolled === 0
                    ? "No ILT enrollments"
                    : iltStats.completed === iltStats.enrolled
                    ? `Instructor-Led · all ${iltStats.enrolled} complete`
                    : `Instructor-Led · ${iltStats.completed} of ${iltStats.enrolled} complete`
                }
              />
            </div>
          </div>
        </section>

        {/* Course grid */}
        <section className="ia-section">
          <div className="ia-container">
            <div className="ia-section-heading">
              <h2>My Courses</h2>
              <span className="ia-section-heading__aside">
                {totalCount} {totalCount === 1 ? "course" : "courses"}
              </span>
            </div>
            <div className="ia-course-grid ia-animate">
              {courses.map((course) => (
                <CourseCard
                  key={course.id}
                  id={course.id}
                  title={course.name}
                  imageUrl={course.imageUrl}
                  courseType={course.courseType}
                  description={course.description}
                  enrollmentStatus={course.enrollmentStatus}
                  onClick={(id) => handleStartCourse(id, data.portalBaseUrl)}
                  isEnrolling={false}
                  onCardClick={() => handleCardClick(course.id)}
                />
              ))}
            </div>
          </div>
        </section>

        {selectedCourse && (
          <CourseDetailModal
            open={!!selectedCourse}
            onClose={handleCloseDetailModal}
            title={selectedCourse.name}
            description={selectedCourse.description}
            imageUrl={selectedCourse.imageUrl}
            courseType={selectedCourse.courseType}
            enrollmentStatus={selectedCourse.enrollmentStatus}
            onLaunch={() => handleStartCourseDirect(selectedCourse, data.portalBaseUrl)}
          />
        )}
        <LessonPlayerModal
          courseId={playingCourse?.id ?? null}
          courseTitle={playingCourse?.name}
          onClose={handleClosePlayer}
        />
        <SessionsModal
          courseId={sessionsCourse?.id ?? null}
          courseTitle={sessionsCourse?.name}
          course={sessionsCourse}
          onClose={handleCloseSessions}
        />
        <CurriculumModal
          curriculumId={curriculumCourse?.id ?? null}
          curriculumTitle={curriculumCourse?.name}
          onClose={handleCloseCurriculum}
          onPickCourse={(child) =>
            handlePickChildCourse(child, data.portalBaseUrl)
          }
        />
      </div>
    );
  }

  // ─── Default variant (unchanged) ─────────────────────────────────────
  return (
    <div>
      <div className="p-12 mt-[75px]">
        <Typography variant="h4">My Courses</Typography>
      </div>
      {courses.length === 0 ? (
        <Box
          display="flex"
          justifyContent="center"
          alignItems="center"
          minHeight="200px"
          bgcolor="#F7F7F7"
          borderRadius="8px"
          p={3}
        >
          <Typography variant="body1" color="textSecondary">
            Sorry, we could not find any results.
          </Typography>
        </Box>
      ) : (
        <div className="flex flex-wrap gap-8 px-12">
          {courses.map((course) => (
            <CourseCard
              key={course.id}
              id={course.id}
              title={course.name}
              imageUrl={course.imageUrl}
              courseType={course.courseType}
              description={course.description}
              enrollmentStatus={course.enrollmentStatus}
              onClick={(id) => handleStartCourse(id, data.portalBaseUrl)}
              isEnrolling={false}
              onCardClick={() => handleCardClick(course.id)}
            />
          ))}
        </div>
      )}
      {selectedCourse && (
        <CourseDetailModal
          open={!!selectedCourse}
          onClose={handleCloseDetailModal}
          title={selectedCourse.name}
          description={selectedCourse.description}
          imageUrl={selectedCourse.imageUrl}
        />
      )}
      <LessonPlayerModal
        courseId={playingCourse?.id ?? null}
        courseTitle={playingCourse?.name}
        onClose={handleClosePlayer}
      />
      <SessionsModal
        courseId={sessionsCourse?.id ?? null}
        courseTitle={sessionsCourse?.name}
        course={sessionsCourse}
        onClose={handleCloseSessions}
      />
      <CurriculumModal
        curriculumId={curriculumCourse?.id ?? null}
        curriculumTitle={curriculumCourse?.name}
        onClose={handleCloseCurriculum}
        onPickCourse={(child) =>
          handlePickChildCourse(child, data.portalBaseUrl)
        }
      />
    </div>
  );
}
