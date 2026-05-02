import { useState } from "react";
import { Course } from "~/.server/course.resource";

type UseMyCoursesResult = {
  courses: Course[];
  selectedCourse: Course | null;
  playingCourse: Course | null;
  handleCardClick: (courseId: string) => void;
  handleStartCourse: (id: string, portalBaseUrl?: string) => void;
  handleCloseDetailModal: () => void;
  handleClosePlayer: () => void;
};

export const useMyCourses = (data?: {
  myCourses: { _embedded: { courses: Course[] } };
}): UseMyCoursesResult => {
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [playingCourse, setPlayingCourse] = useState<Course | null>(null);

  const courses = data?.myCourses?._embedded.courses || [];

  /**
   * "Start / Resume" on a course card.
   *   OnlineCourse        → embedded LessonPlayerModal (current behavior).
   *   InstructorLedCourse → opens Absorb's learner portal in a new tab so
   *                         the user can pick a session to register for.
   *   Curriculum          → opens Absorb's portal so the user can drill
   *                         into the bundle's child courses.
   */
  const handleStartCourse = (id: string, portalBaseUrl?: string) => {
    const course = courses.find((c) => c.id === id) || null;
    if (!course) return;
    if (course.courseType === "OnlineCourse") {
      setPlayingCourse(course);
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

  return {
    courses,
    selectedCourse,
    playingCourse,
    handleCardClick,
    handleStartCourse,
    handleCloseDetailModal,
    handleClosePlayer,
  };
};
