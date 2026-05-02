import { Box, CircularProgress, Typography, Button } from "@mui/material";
import { json, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useLoaderData, useRouteLoaderData } from "@remix-run/react";
import { getMyCourses, InfusePortalUrl } from "~/.server/infuse-api";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";
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

  const myCourses = await getMyCourses(tokenValue, {
    limit: 30,
    showCompleted: true,
  });

  return json({
    myCourses,
    portalBaseUrl: InfusePortalUrl.replace(/\/$/, ""),
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
    handlePickChildCourse,
    handleCloseDetailModal,
    handleClosePlayer,
    handleCloseSessions,
    handleCloseCurriculum,
  } = useMyCourses(data);

  // Derive quick progress stats for the IA dashboard hero / rings.
  // `courses` here comes from /my-courses which includes enrollmentStatus
  // but not percentage-progress, so we approximate with completed count.
  const completedCount = courses.filter(
    (c) => c.enrollmentStatus === "Complete" || c.enrollmentStatus === "Completed"
  ).length;
  const inProgressCount = courses.filter(
    (c) => c.enrollmentStatus === "InProgress"
  ).length;
  const totalCount = courses.length;
  const overallProgress =
    totalCount > 0 ? completedCount / totalCount : 0;

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

        {/* Gamification bar */}
        <section className="ia-gamification-bar ia-animate">
          <div className="ia-gamification-bar__grid">
            <div className="ia-gamification-bar__item">
              <div className="ia-gamification-bar__label">
                Experience Points
              </div>
              <div
                className="ia-xp-bar"
                style={
                  {
                    ["--xp" as string]: `${Math.min(
                      100,
                      completedCount * 10 + inProgressCount * 3
                    )}%`,
                  } as React.CSSProperties
                }
              >
                <div className="ia-xp-bar__fill" />
              </div>
              <div className="ia-gamification-bar__meta">
                <span>
                  {completedCount * 100 + inProgressCount * 30} / 1000 XP
                </span>
                <span className="ia-badge ia-badge--sm">
                  Level {Math.max(1, Math.floor(completedCount / 2) + 1)}
                </span>
              </div>
            </div>
            <div className="ia-gamification-bar__item">
              <div className="ia-gamification-bar__label">Weekly Streak</div>
              <div className="ia-streak">
                {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
                  <div
                    key={i}
                    className={`ia-streak__day ${
                      i < 3 ? "ia-streak__day--active" : ""
                    }`}
                  >
                    <span className="ia-streak__dot" />
                    <span className="ia-streak__label">{d}</span>
                  </div>
                ))}
              </div>
            </div>
            <div
              className="ia-gamification-bar__item"
              style={{ textAlign: "center" }}
            >
              <div className="ia-gamification-bar__label">Rank</div>
              <div className="ia-rank-badge">
                <span className="ia-rank-badge__icon">🎖</span>
                <span className="ia-rank-badge__title">
                  {completedCount >= 5
                    ? "Veteran"
                    : completedCount >= 2
                    ? "Explorer"
                    : "Novice"}
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Progress rings */}
        <section className="ia-section--tight">
          <div className="ia-container">
            <div className="ia-stats-row ia-animate">
              <ProgressRing
                progress={overallProgress}
                label="Overall Progress"
              />
              <ProgressRing
                progress={totalCount > 0 ? completedCount / totalCount : 0}
                label={`${completedCount} of ${totalCount} Completed`}
              />
              <ProgressRing
                progress={totalCount > 0 ? inProgressCount / totalCount : 0}
                label={`${inProgressCount} In Progress`}
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
