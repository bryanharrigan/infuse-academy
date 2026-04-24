type MyCourseResource = {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  courseType: "OnlineCourse" | "InstructorLedCourse" | "Curriculum";
  enrollmentStatus: string | null;
};

export type MyCoursesResource = {
  _embedded: {
    courses: MyCourseResource[];
  };
};
