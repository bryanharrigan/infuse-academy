import { useState } from "react";
import { Course } from "~/.server/course.resource";

type UseMyCoursesResult = {
  courses: Course[];
  selectedCourse: Course | null;
  playingCourse: Course | null;
  handleCardClick: (courseId: string) => void;
  handleStartCourse: (id: string) => void;
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
   * "Start / Resume" button on a course card → open the LessonPlayerModal.
   * Modal fetches /lesson-player/:courseId and iframes Absorb's
   * /learn/lessonplayer. No legacy new-tab fallback now that the iframe
   * embed is working.
   */
  const handleStartCourse = (id: string) => {
    const course = courses.find((c) => c.id === id) || null;
    setPlayingCourse(course);
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
