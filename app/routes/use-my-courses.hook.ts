import { useState } from "react";
import { Course } from "~/.server/course.resource";

type UseMyCoursesResult = {
  courses: Course[];
  selectedCourse: Course | null;
  playingCourse: Course | null;
  /**
   * Course currently powering the SessionsModal (InstructorLedCourse only).
   * Null when no sessions modal should be open.
   */
  sessionsCourse: Course | null;
  handleCardClick: (courseId: string) => void;
  handleStartCourse: (id: string, portalBaseUrl?: string) => void;
  handleCloseDetailModal: () => void;
  handleClosePlayer: () => void;
  handleCloseSessions: () => void;
};

export const useMyCourses = (data?: {
  myCourses: { _embedded: { courses: Course[] } };
}): UseMyCoursesResult => {
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [playingCourse, setPlayingCourse] = useState<Course | null>(null);
  const [sessionsCourse, setSessionsCourse] = useState<Course | null>(null);

  const courses = data?.myCourses?._embedded.courses || [];

  /**
   * "Start / Resume" on a course card.
   *   OnlineCourse        → embedded LessonPlayerModal (current behavior).
   *   InstructorLedCourse → native SessionsModal (lists scheduled sessions
   *                         with Register CTAs).
   *   Curriculum          → opens Absorb's portal in a new tab so the user
   *                         can drill into the bundle's child courses.
   */
  const handleStartCourse = (id: string, portalBaseUrl?: string) => {
    const course = courses.find((c) => c.id === id) || null;
    if (!course) return;
    if (course.courseType === "OnlineCourse") {
      setPlayingCourse(course);
      return;
    }
    if (course.courseType === "InstructorLedCourse") {
      setSessionsCourse(course);
      return;
    }
    if (typeof window === "undefined") return;
    const base = portalBaseUrl ?? window.location.origin;
    window.open(
      `${base}/#/courses/${encodeURIComponent(course.id)}`,
      "_blank",
      "noopener,noreferrer"
    );
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

  return {
    courses,
    selectedCourse,
    playingCourse,
    sessionsCourse,
    handleCardClick,
    handleStartCourse,
    handleCloseDetailModal,
    handleClosePlayer,
    handleCloseSessions,
  };
};
