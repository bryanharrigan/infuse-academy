import React, { useCallback } from "react";
import {
  Button,
  Card,
  CardActions,
  CardContent,
  CardMedia,
  Typography,
  CircularProgress,
  Box,
} from "@mui/material";

import OnlineCourseSVG from "~/assets/online-course.svg";
import InstructorLedCourseSVG from "~/assets/instructor-led-course.svg";
import CurriculumSVG from "~/assets/curriculum.svg";
import { useAppStateContext } from "~/context/app-state.context";

type CourseCardProps = {
  id: string;
  title: string;
  description: string;
  imageUrl: string;
  courseType: "OnlineCourse" | "InstructorLedCourse" | "Curriculum";
  enrollmentStatus: string | null;
  onClick: (id: string) => void;
  isEnrolling: boolean;
  onCardClick: (id: string) => void;
};

const formatEnrollmentStatus = (
  status: string | null,
  isEnrolling: boolean
): string => {
  if (!status) {
    return isEnrolling ? "Enrolling" : "Enroll";
  }

  const enrollmentStatusMap: Record<string, string> = {
    NotStarted: "Start",
    InProgress: "Resume",
    // "Review" makes it obvious the button still launches the player even
    // though the course is already marked complete.
    Complete: "Review",
    Completed: "Review",
  };

  return (
    enrollmentStatusMap[status] || status.replace(/([a-z])([A-Z])/g, "$1 $2")
  );
};

const courseTypeLabel = (t: CourseCardProps["courseType"]): string =>
  t === "OnlineCourse"
    ? "Online Course"
    : t === "InstructorLedCourse"
    ? "Instructor-Led"
    : "Curriculum";

export const CourseCard: React.FC<CourseCardProps> = ({
  id,
  title,
  imageUrl,
  courseType,
  enrollmentStatus,
  onClick,
  isEnrolling,
  onCardClick,
}) => {
  const { themeVariant } = useAppStateContext();
  const isExperimental = themeVariant === "experimental";
  // Any branded variant (Infuse Academy, RadNet) uses the IA layout + tokens.
  // Experimental gets its own treatment below — splitting so isIA only
  // covers the non-experimental branded themes.
  const isIA =
    themeVariant === "infuse-academy" || themeVariant === "radnet";
  const buttonTitle = formatEnrollmentStatus(enrollmentStatus, isEnrolling);

  const getDefaultImage = () => {
    switch (courseType) {
      case "OnlineCourse":
        return OnlineCourseSVG;
      case "InstructorLedCourse":
        return InstructorLedCourseSVG;
      case "Curriculum":
        return CurriculumSVG;
      default:
        return `https://picsum.photos/250/150?random=${id}`;
    }
  };

  const handleActionClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onClick(id);
    },
    [onClick, id]
  );

  const handleViewDetailsClick = useCallback(() => {
    onCardClick(id);
  }, [onCardClick, id]);

  // ─── Experimental variant — uses the Learning Hub's exp-card styling ──
  if (isExperimental) {
    const statusClass =
      enrollmentStatus === "Complete" || enrollmentStatus === "Completed"
        ? "exp-card__status--done"
        : enrollmentStatus === "InProgress"
        ? "exp-card__status--progress"
        : "exp-card__status--new";
    const statusLabel =
      enrollmentStatus === "Complete" || enrollmentStatus === "Completed"
        ? "Completed"
        : enrollmentStatus === "InProgress"
        ? "In Progress"
        : enrollmentStatus
        ? "Not Started"
        : "Available";
    return (
      <article
        className="exp-card"
        onClick={handleViewDetailsClick}
        role="button"
        tabIndex={0}
      >
        <div
          className="exp-card__img"
          style={
            imageUrl
              ? { backgroundImage: `url(${imageUrl})` }
              : undefined
          }
        >
          {!imageUrl && (
            <div className="exp-card__img-empty">
              <img src={getDefaultImage()} alt="" />
            </div>
          )}
        </div>
        <div className="exp-card__body">
          <span className={`exp-card__status ${statusClass}`}>
            {statusLabel}
          </span>
          <h3 className="exp-card__title" title={title}>
            {title}
          </h3>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: "0.72rem",
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--exp-text-muted)",
              marginTop: -4,
            }}
          >
            {courseTypeLabel(courseType)}
          </div>
          <div className="exp-card__footer" style={{ marginTop: "auto" }}>
            <span className="exp-card__pct">
              {enrollmentStatus
                ? enrollmentStatus === "Complete" ||
                  enrollmentStatus === "Completed"
                  ? "100%"
                  : enrollmentStatus === "InProgress"
                  ? "50%"
                  : "0%"
                : courseTypeLabel(courseType)}
            </span>
            <button
              type="button"
              className="exp-card__cta"
              disabled={isEnrolling}
              onClick={handleActionClick}
            >
              {isEnrolling ? "Enrolling…" : buttonTitle}
            </button>
          </div>
        </div>
      </article>
    );
  }

  // ─── Infuse Academy variant ────────────────────────────────────────────
  if (isIA) {
    const statusLabel =
      enrollmentStatus === "InProgress"
        ? "In Progress"
        : enrollmentStatus === "NotStarted"
        ? "Not Started"
        : enrollmentStatus ?? "Available";
    return (
      <article
        className="ia-course-card"
        onClick={handleViewDetailsClick}
        role="button"
        tabIndex={0}
      >
        <div
          className={`ia-course-card__media ${
            imageUrl ? "" : "ia-course-card__media--placeholder"
          }`}
        >
          {imageUrl ? (
            <img src={imageUrl} alt={title} />
          ) : (
            <img src={getDefaultImage()} alt={title} />
          )}
        </div>
        <div className="ia-course-card__body">
          <div className="ia-course-card__meta">
            {courseTypeLabel(courseType)}
          </div>
          <h3 className="ia-course-card__title" title={title}>
            {title}
          </h3>
          <div className="ia-course-card__footer">
            <span className="ia-course-card__status">{statusLabel}</span>
            <Button
              size="small"
              variant="contained"
              color="primary"
              onClick={handleActionClick}
              disabled={isEnrolling}
              endIcon={
                isEnrolling ? (
                  <CircularProgress size={14} sx={{ color: "inherit" }} />
                ) : undefined
              }
            >
              {buttonTitle}
            </Button>
          </div>
        </div>
      </article>
    );
  }

  // ─── Default variant (unchanged) ───────────────────────────────────────
  return (
    <Card className="w-[250px] cursor-pointer" onClick={handleViewDetailsClick}>
      <div className="h-[150px] w-full flex justify-center items-center bg-gray-200">
        {!imageUrl ? (
          <img
            src={getDefaultImage()}
            alt={title}
            className="w-[80px] h-auto filter invert-[34%] sepia-[0%] saturate-[0%] hue-rotate-[180deg] brightness-[65%] contrast-[84%]"
          />
        ) : (
          <CardMedia
            component="img"
            image={imageUrl}
            alt={title}
            className="h-full w-full object-cover"
          />
        )}
      </div>
      <CardContent>
        <Typography
          gutterBottom
          variant="h6"
          component="div"
          className="truncate"
          title={title}
        >
          {title}
        </Typography>
      </CardContent>
      <CardActions className="flex justify-end">
        <Button size="small" onClick={handleActionClick} disabled={isEnrolling}>
          {buttonTitle}
        </Button>
        {isEnrolling && (
          <Box className="ml-2">
            <CircularProgress size={20} />
          </Box>
        )}
      </CardActions>
    </Card>
  );
};
