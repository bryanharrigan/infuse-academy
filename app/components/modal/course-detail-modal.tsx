import React, { useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  CardMedia,
  Box,
} from "@mui/material";
import FallbackImage from "~/assets/banner.jpg";
import { useAppStateContext } from "~/context/app-state.context";

type CourseType = "OnlineCourse" | "InstructorLedCourse" | "Curriculum";

type CourseDetailModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  imageUrl: string;
  /** Course type — drives the launch CTA label + behaviour. */
  courseType?: CourseType;
  /** Current learner enrollment status. Drives the CTA label
   *  (Resume / Review / Start / Pick a session / Enroll). */
  enrollmentStatus?: string | null;
  /** Fired when the launch CTA is clicked. The caller is responsible
   *  for closing this modal and opening the right downstream modal
   *  (LessonPlayerModal / SessionsModal / CurriculumModal). */
  onLaunch?: () => void;
};

function ctaLabelFor(
  courseType: CourseType | undefined,
  enrollmentStatus: string | null | undefined
): string {
  if (courseType === "InstructorLedCourse") {
    const s = (enrollmentStatus ?? "").toLowerCase();
    if (s === "complete" || s === "completed") return "Review session";
    return enrollmentStatus ? "View / switch session" : "Pick a session";
  }
  if (courseType === "Curriculum") {
    return enrollmentStatus ? "Continue curriculum" : "View curriculum";
  }
  // OnlineCourse / unknown
  if (enrollmentStatus === "Complete" || enrollmentStatus === "Completed")
    return "Review course";
  if (enrollmentStatus === "InProgress") return "Resume";
  if (enrollmentStatus) return "Start";
  return "Enroll";
}

export const CourseDetailModal: React.FC<CourseDetailModalProps> = ({
  open,
  onClose,
  title,
  description,
  imageUrl,
  courseType,
  enrollmentStatus,
  onLaunch,
}) => {
  const { setModalOpen } = useAppStateContext();

  useEffect(() => {
    setModalOpen(open);
    return () => setModalOpen(false);
  }, [open, setModalOpen]);

  const ctaLabel = ctaLabelFor(courseType, enrollmentStatus);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="md"
      PaperProps={{
        className:
          "relative mx-auto mt-20 max-w-lg max-h-[90vh] overflow-y-auto",
      }}
      disableEscapeKeyDown
    >
      <DialogContent>
        <Typography
          variant="h6"
          component="h2"
          className="line-clamp-2 overflow-hidden text-ellipsis whitespace-normal"
        >
          {title}
        </Typography>
        <Box className="flex flex-col items-center">
          <CardMedia
            component="img"
            image={imageUrl || FallbackImage}
            alt={title}
            className="max-h-[400px] object-cover mb-4"
          />
          {description && (
            <Box
              className="mt-4 text-base leading-relaxed"
              dangerouslySetInnerHTML={{ __html: description }}
            />
          )}
        </Box>
      </DialogContent>
      <DialogActions className="flex justify-end gap-2 pr-4">
        <Button onClick={onClose} color="inherit">
          Close
        </Button>
        {onLaunch && (
          <Button
            onClick={() => {
              // Close this modal first, then defer one tick so React
              // commits the unmount before the parent mounts the next
              // modal (LessonPlayerModal / SessionsModal / etc.).
              onClose();
              window.setTimeout(() => onLaunch(), 0);
            }}
            color="primary"
            variant="contained"
          >
            {ctaLabel}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
};
