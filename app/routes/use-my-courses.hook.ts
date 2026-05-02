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
};

export const useMyCourses = (data?: {
  myCourses: { _embedded: { courses: Course[] } };
}): UseMyCoursesResult => {
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [playingCourse, setPlayingCourse] = useState<Course | null>(null);
  const [sessionsCourse, setSessionsCourse] = useState<Course | null>(null);
  const [curriculumCourse, setCurriculumCourse] = useState<Course | null>(null);

  const courses = data?.myCourses?._embedded.courses || [];

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

  const handleClosePlayer = () => {
    setPlayingCourse(null);
  };

  const handleCloseSessions = () => setSessionsCourse(null);
  const handleCloseCurriculum = () => setCurriculumCourse(null);

  return {
    courses,
    selectedCourse,
    playingCourse,
    sessionsCourse,
    curriculumCourse,
    handleCardClick,
    handleStartCourse,
    handleStartCourseDirect,
    handleCloseDetailModal,
    handleClosePlayer,
    handleCloseSessions,
    handleCloseCurriculum,
  };
};
