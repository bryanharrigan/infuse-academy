import { useState } from "react";
import { Course } from "~/.server/course.resource";

type UseMyCoursesResult = {
  courses: Course[];
  selectedCourse: Course | null;
  playingCourse: Course | null;
  /** Currently driving the SessionsModal (ILT only); null = closed. */
  sessionsCourse: Course | null;
  /** Currently driving the CurriculumModal (Curriculum only); null = closed. */
  curriculumCourse: Course | null;
  handleCardClick: (courseId: string) => void;
  handleStartCourse: (id: string, portalBaseUrl?: string) => void;
  handleCloseDetailModal: () => void;
  handleClosePlayer: () => void;
  handleCloseSessions: () => void;
  handleCloseCurriculum: () => void;
  /** Used by the CurriculumModal to launch a picked child course. */
  handleStartCourseDirect: (course: Course, portalBaseUrl?: string) => void;
  /** Picks a child course from inside a curriculum AND remembers the
   *  parent so the user is bounced back to the curriculum on close. */
  handlePickChildCourse: (child: Course, portalBaseUrl?: string) => void;
};

export const useMyCourses = (data?: {
  myCourses: { _embedded: { courses: Course[] } };
}): UseMyCoursesResult => {
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [playingCourse, setPlayingCourse] = useState<Course | null>(null);
  const [sessionsCourse, setSessionsCourse] = useState<Course | null>(null);
  const [curriculumCourse, setCurriculumCourse] = useState<Course | null>(null);
  /**
   * Curriculum to reopen when the next downstream modal closes — set
   * when the learner picks a child course out of a CurriculumModal so
   * we can hop back into the curriculum after they finish a child.
   */
  const [returnToCurriculum, setReturnToCurriculum] = useState<Course | null>(
    null
  );

  const courses = data?.myCourses?._embedded.courses || [];

  const popReturnToCurriculum = () => {
    if (returnToCurriculum) {
      const ret = returnToCurriculum;
      setReturnToCurriculum(null);
      window.setTimeout(() => setCurriculumCourse(ret), 0);
    }
  };

  /**
   * Dispatches based on courseType to the correct in-app modal.
   *   OnlineCourse        → embedded LessonPlayerModal
   *   InstructorLedCourse → SessionsModal
   *   Curriculum          → CurriculumModal (child clicks re-enter this
   *                         dispatcher with the picked child course)
   *   unknown             → falls back to the LessonPlayerModal so a click
   *                         always does something
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

  /**
   * Convenience wrapper for the existing call site that only has the
   * course id (e.g. CourseCard's onClick which passes id back up).
   */
  const handleStartCourse = (id: string, portalBaseUrl?: string) => {
    const course = courses.find((c) => c.id === id) || null;
    if (!course) return;
    handleStartCourseDirect(course, portalBaseUrl);
  };

  const handleCardClick = (courseId: string) => {
    const course = courses.find((c: Course) => c.id === courseId) || null;
    setSelectedCourse(course);
  };

  const handleCloseDetailModal = () => {
    setSelectedCourse(null);
  };

  /**
   * Close handlers — each one also pops a queued return-to-curriculum,
   * so a learner who drilled in via a curriculum lands back on it after
   * closing the child rather than dropping to /my-courses.
   */
  const handleClosePlayerWithReturn = () => {
    setPlayingCourse(null);
    popReturnToCurriculum();
  };
  const handleCloseSessions = () => {
    setSessionsCourse(null);
    popReturnToCurriculum();
  };
  const handleCloseCurriculum = () => {
    setCurriculumCourse(null);
    setReturnToCurriculum(null);
  };

  /**
   * Picking a child course out of a CurriculumModal: stash the parent
   * curriculum so we know where to return on close, then dispatch.
   */
  const handlePickChildCourse = (
    child: Course,
    portalBaseUrl?: string
  ) => {
    if (curriculumCourse) {
      setReturnToCurriculum(curriculumCourse);
    }
    setCurriculumCourse(null);
    window.setTimeout(
      () => handleStartCourseDirect(child, portalBaseUrl),
      0
    );
  };

  return {
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
    handleClosePlayer: handleClosePlayerWithReturn,
    handleCloseSessions,
    handleCloseCurriculum,
  };
};
