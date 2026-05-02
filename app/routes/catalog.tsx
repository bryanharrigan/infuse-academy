import { useMemo, useState } from "react";
import { CircularProgress, Typography, Box } from "@mui/material";
import { Search as SearchIcon } from "@mui/icons-material";
import { json, LoaderFunctionArgs, ActionFunction } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { CourseCard } from "~/components/course-card/course-card.component";
import { EnrollmentToast } from "~/components/modal/toast-notification.component";
import { CourseDetailModal } from "~/components/modal/course-detail-modal";
import { LessonPlayerModal } from "~/components/modal/lesson-player-modal";
import { SessionsModal } from "~/components/modal/sessions-modal";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";
import { MyCoursesResource } from "~/.server/my-courses.resource";
import { useCatalog } from "~/routes/use-catalog.hook";
import {
  getAllAvailableCatalog,
  startEnrollment,
  getMyCourseEnrollment,
  InfusePortalUrl,
} from "~/.server/infuse-api";
import { useAppStateContext } from "~/context/app-state.context";

/**
 * Loader returns every course in the learner's catalog — paginated across
 * Absorb's ~30-per-page limit and unfiltered by course type, so all
 * OnlineCourse / InstructorLedCourse / Curriculum entries are present.
 *
 * The page itself shows enrolled and not-yet-enrolled courses side-by-side;
 * the in-card click handler differentiates enroll vs. start.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const cookieHeader = request.headers.get("Cookie");
  const tokenValue = await infuseJwtCookie.parse(cookieHeader);

  const catalog: MyCoursesResource = await getAllAvailableCatalog(tokenValue);

  return json({
    catalog,
    portalBaseUrl: InfusePortalUrl.replace(/\/$/, ""),
  });
};

export const action: ActionFunction = async ({ request }) => {
  const formData = await request.formData();
  const courseId = formData.get("courseId");

  if (!courseId) {
    throw new Error("No courseId provided");
  }

  const cookieHeader = request.headers.get("Cookie");
  const tokenValue = await infuseJwtCookie.parse(cookieHeader);

  await startEnrollment(tokenValue, courseId as string);

  let isEnrolled = false;
  const MAX_ATTEMPTS = 10;
  let attempts = 0;

  while (!isEnrolled && attempts < MAX_ATTEMPTS) {
    attempts++;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const enrollmentData = await getMyCourseEnrollment(
        tokenValue,
        courseId as string
      );
      if (
        enrollmentData.enrollmentStatus &&
        enrollmentData.enrollmentStatus !== ""
      ) {
        isEnrolled = true;
      }
    } catch (error) {
      if (attempts === MAX_ATTEMPTS) {
        throw new Error("Enrollment Failed");
      }
    }
  }

  if (isEnrolled) {
    return json({ status: "success" });
  }

  return json({ status: "error", message: "Enrollment failed" });
};

export default function MyCatalog() {
  const data = useLoaderData<typeof loader>();
  const { themeVariant } = useAppStateContext();
  // IA layout also powers the RadNet variant.
  const isIA = themeVariant !== "default";
  const {
    catalog,
    enrollmentToastOpen,
    modalTitle,
    enrollingCourseId,
    selectedCourse,
    playingCourse,
    sessionsCourse,
    handleStartCourse,
    handleEnroll,
    handleCardClick,
    handleCloseDetailModal,
    handleClosePlayer,
    handleCloseSessions,
  } = useCatalog(data);

  const [query, setQuery] = useState("");
  const filteredCatalog = useMemo(() => {
    if (!query.trim()) return catalog;
    const q = query.trim().toLowerCase();
    return catalog.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.description || "").toLowerCase().includes(q)
    );
  }, [catalog, query]);

  if (!catalog) {
    return (
      <Box className="flex justify-center p-12">
        <CircularProgress />
      </Box>
    );
  }

  // ─── Infuse Academy variant ──────────────────────────────────────────
  if (isIA) {
    return (
      <>
        <section className="ia-hero ia-animate" style={{ marginTop: 72 }}>
          <div className="ia-hero__inner">
            <div>
              <h1 className="ia-hero__title">
                Discover your <span className="ia-text-gradient">next skill</span>
              </h1>
              <p className="ia-hero__sub">
                Browse the catalog and enroll in courses that match your goals.
              </p>
            </div>
          </div>
        </section>

        <section className="ia-section">
          <div className="ia-container">
            <div className="ia-catalog-toolbar ia-animate">
              <label className="ia-catalog-search" htmlFor="ia-catalog-q">
                <SearchIcon sx={{ color: "var(--ia-text-dim)", fontSize: 20 }} />
                <input
                  id="ia-catalog-q"
                  type="search"
                  placeholder="Search courses…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <span className="ia-badge">
                {filteredCatalog.length}{" "}
                {filteredCatalog.length === 1 ? "course" : "courses"}
              </span>
            </div>

            <div className="ia-course-grid ia-animate">
              {filteredCatalog.map((course) => (
                <CourseCard
                  key={course.id}
                  id={course.id}
                  title={course.name}
                  description={course.description}
                  imageUrl={course.imageUrl}
                  courseType={course.courseType}
                  enrollmentStatus={course.enrollmentStatus}
                  onClick={() => {
                    if (!course.enrollmentStatus) {
                      handleEnroll(course.id);
                    } else {
                      handleStartCourse(course.id, data.portalBaseUrl);
                    }
                  }}
                  onCardClick={() => handleCardClick(course.id)}
                  isEnrolling={enrollingCourseId === course.id}
                />
              ))}
              {filteredCatalog.length === 0 && (
                <Typography
                  variant="body1"
                  sx={{ color: "var(--ia-text-muted)", gridColumn: "1/-1" }}
                >
                  No courses match “{query}”.
                </Typography>
              )}
            </div>
          </div>
        </section>

        <EnrollmentToast open={enrollmentToastOpen} title={modalTitle} />
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
          onClose={handleCloseSessions}
        />
      </>
    );
  }

  // ─── Default variant (unchanged) ─────────────────────────────────────
  return (
    <>
      <Box className="p-12 mt-[75px]">
        <Typography variant="h4">My Catalog</Typography>
      </Box>
      <Box className="flex flex-wrap gap-8 px-12">
        {catalog.map((course) => (
          <CourseCard
            key={course.id}
            id={course.id}
            title={course.name}
            description={course.description}
            imageUrl={course.imageUrl}
            courseType={course.courseType}
            enrollmentStatus={course.enrollmentStatus}
            onClick={() => {
              if (!course.enrollmentStatus) {
                handleEnroll(course.id);
              } else {
                handleStartCourse(course.id, data.portalBaseUrl);
              }
            }}
            onCardClick={() => handleCardClick(course.id)}
            isEnrolling={enrollingCourseId === course.id}
          />
        ))}
      </Box>
      <EnrollmentToast open={enrollmentToastOpen} title={modalTitle} />
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
        onClose={handleCloseSessions}
      />
    </>
  );
}
