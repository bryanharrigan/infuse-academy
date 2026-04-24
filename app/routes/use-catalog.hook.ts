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

  const submit = useSubmit();
  const navigation = useNavigation();

  const catalog = data?.catalog?._embedded.courses || [];

  // "Start / Resume" on an enrolled catalog course → open the modal player.
  const handleStartCourse = (id: string) => {
    const course = catalog.find((c) => c.id === id) || null;
    setPlayingCourse(course);
  };

  const handleClosePlayer = () => setPlayingCourse(null);

  const handleEnroll = (courseId: string) => {
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

  return {
    catalog,
    enrollmentToastOpen,
    modalTitle,
    enrollingCourseId,
    selectedCourse,
    playingCourse,
    handleStartCourse,
    handleEnroll,
    handleCardClick,
    handleCloseDetailModal,
    handleClosePlayer,
  };
}
