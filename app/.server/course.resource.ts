import { CourseType } from "./course-type.type";

export type Course = {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  courseType: CourseType;
  enrollmentStatus: string | null;
};
