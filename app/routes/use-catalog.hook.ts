import { useState, useEffect } from "react";
import { useSubmit, useNavigation } from "@remix-run/react";
import { Course } from "~/.server/course.resource";
import { MyCoursesResource } from "~/.server/my-courses.resource";

export function useCatalog(data: { catalog: MyCoursesResource }) {
  const [enrollmentToastOpen, setEnrollmentToastOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState("Enrollment Started");
  const [enrollingCourseId, setEnrollingCourseId] = useState<string | null>(
    null
  );
  const [enrollmentInProgress, setEnrollmentInProgress] = useState(false);
  const [enrollmentStartedAt, setEnrollmentStartedAt] = useState<number | null>(
    null
  );
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [playingCourse, setPlayingCourse] = useState<Course | null>(null);
  const [sessionsCourse, setSessionsCourse] = useState<Course | null>(null);
  const [curriculumCourse, setCurriculumCourse] = useState<Course | null>(null);
  /** Curriculum to reopen on next downstream-modal close. */
  const [returnToCurriculum, setReturnToCurriculum] = useState<Course | null>(
    null
  );

  const popReturnToCurriculum = () => {
    if (returnToCurriculum) {
      const ret = returnToCurriculum;
      setReturnToCurriculum(null);
      window.setTimeout(() => setCurriculumCourse(ret), 0);
    }
  };

  const submit = useSubmit();
  const navigation = useNavigation();

  const catalog = data?.catalog?._embedded.courses || [];

  // "Start / Resume" on an enrolled catalog course.
  //   OnlineCourse        → open the modal player (current behavior)
  //   InstructorLedCourse → open Absorb learner portal in a new tab so
  //                         the user can pick a session to register for
  //   Curriculum          → open Absorb learner portal so the user can
  //                         drill into the bundle's child courses
  // The portal base URL is built from `window.location.origin` plus the
  // tenant portal hash route — works because the app and the Absorb
  // portal share the same hostname (or a known sibling). When that's
  // not the case (multi-tenant deploys), the caller can pass an explicit
  // `portalBaseUrl` via the second argument.
  /**
   * Dispatches based on courseType to the correct in-app modal.
   *   OnlineCourse        → LessonPlayerModal
   *   InstructorLedCourse → SessionsModal
   *   Curriculum          → CurriculumModal
   *   unknown             → LessonPlayerModal (so the click does something)
   */
  const handleStartCourseDirect = (
    course: Course,
    _portalBaseUrl?: string
  ) => {
    if (course.courseType === "OnlineCourse") {
      setPlayingCourse(course);
      return;
    }
    if (course.courseType === "InstructorLedCourse") {
      setSessionsCourse(course);
      return;
    }
    if (course.courseType === "Curriculum") {
      setCurriculumCourse(course);
      return;
    }
    setPlayingCourse(course);
  };

  const handleStartCourse = (id: string, portalBaseUrl?: string) => {
    const course = catalog.find((c) => c.id === id) || null;
    if (!course) return;
    handleStartCourseDirect(course, portalBaseUrl);
  };

  const handleClosePlayer = () => setPlayingCourse(null);

  const handleEnroll = (courseId: string) => {
    const course = catalog.find((c) => c.id === courseId);

    // ILT enrollment is session-specific — opening the SessionsModal
    // lets the learner pick a date/venue/webinar before registering.
    // The modal POSTs to /enroll/:courseId with the sessionId after
    // the learner clicks Register on a specific session card.
    if (course?.courseType === "InstructorLedCourse") {
      setSessionsCourse(course);
      return;
    }

    // Non-ILT path: legacy form-submit enrollment via the route's action.
    const formData = new FormData();
    formData.append("courseId", courseId);

    submit(formData, { method: "post" });
    setEnrollingCourseId(courseId);
    setEnrollmentInProgress(true);
    setEnrollmentStartedAt(Date.now());
    setModalTitle("Enrollment Started");
    setEnrollmentToastOpen(true);
  };

  const handleCardClick = (courseId: string) => {
    const course = catalog.find((c: Course) => c.id === courseId) || null;
    setSelectedCourse(course);
  };

  const handleCloseDetailModal = () => {
    setSelectedCourse(null);
  };

  useEffect(() => {
    if (navigation.state === "idle" && enrollmentInProgress) {
      const elapsedTime = Date.now() - (enrollmentStartedAt || 0);

      const timeRemaining = 3000 - elapsedTime;
      const delay = timeRemaining > 0 ? timeRemaining : 0;

      setTimeout(() => {
        setModalTitle("Enrollment Completed Successfully");
        setTimeout(() => {
          setEnrollmentToastOpen(false);
          setEnrollingCourseId(null);
        }, 2000);
      }, delay);
      setEnrollmentInProgress(false);
    }
  }, [navigation.state, enrollmentInProgress, enrollmentStartedAt]);

  const handleCloseSessions = () => {
    setSessionsCourse(null);
    popReturnToCurriculum();
  };
  const handleCloseCurriculum = () => {
    setCurriculumCourse(null);
    setReturnToCurriculum(null);
  };
  const handleClosePlayerWithReturn = () => {
    setPlayingCourse(null);
    popReturnToCurriculum();
  };

  /** Picks a child out of the CurriculumModal and queues the parent to
   *  reopen when the child closes. */
  const handlePickChildCourse = (child: Course, portalBaseUrl?: string) => {
    if (curriculumCourse) setReturnToCurriculum(curriculumCourse);
    setCurriculumCourse(null);
    window.setTimeout(
      () => handleStartCourseDirect(child, portalBaseUrl),
      0
    );
  };

  return {
    catalog,
    enrollmentToastOpen,
    modalTitle,
    enrollingCourseId,
    selectedCourse,
    playingCourse,
    sessionsCourse,
    curriculumCourse,
    handleStartCourse,
    handleStartCourseDirect,
    handlePickChildCourse,
    handleEnroll,
    handleCardClick,
    handleCloseDetailModal,
    handleClosePlayer: handleClosePlayerWithReturn,
    handleCloseSessions,
    handleCloseCurriculum,
  };
}
