/**
 * app/components/modal/curriculum-modal.tsx
 *
 * In-app drill-in for Curriculum cards. Replaces the window.open()
 * bounce to Absorb's portal — keeps the learner inside the Cowork app
 * and lets them launch any child course directly.
 *
 * Flow:
 *   1. Caller opens the modal with `curriculumId` set; component fetches
 *      `GET /curriculum/:id` (the resource route).
 *   2. Renders one card per child course with its type label and
 *      progress badge.
 *   3. Tapping a child fires `onPickCourse(course)` and closes itself —
 *      the parent dispatches to the right downstream modal:
 *        OnlineCourse        → CoursePlayerModal
 *        InstructorLedCourse → SessionsModal
 *        Curriculum          → another CurriculumModal (nested)
 *
 * Theming is intentionally neutral (translucent dark glass) so it
 * reads well on top of either `body.theme-experimental` aurora or
 * `body.theme-ia` dark backgrounds.
 */

import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Typography,
} from "@mui/material";
import {
  Close as CloseIcon,
  CheckCircle as CheckCircleIcon,
  PlayCircleOutline as PlayCircleOutlineIcon,
  School as SchoolIcon,
  Person as PersonIcon,
  CollectionsBookmark as CollectionsBookmarkIcon,
  ArrowForward as ArrowForwardIcon,
  EventAvailable as EventAvailableIcon,
} from "@mui/icons-material";
import { useEffect, useState } from "react";

import type { Course } from "~/.server/course.resource";

type CurriculumModalProps = {
  /** Curriculum course id; non-null while the modal should be open. */
  curriculumId: string | null;
  /** Curriculum's name for the dialog header. */
  curriculumTitle?: string;
  /** Fired when the modal is closed (escape, backdrop, X). */
  onClose: () => void;
  /**
   * Fired when the learner picks a child course. Caller decides what to
   * open next based on `course.courseType`. Called BEFORE close so the
   * parent can chain a new modal on top without flicker.
   */
  onPickCourse: (course: Course) => void;
};

type FetcherState = "idle" | "loading" | "loaded" | "error";

function isCompleteStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  return s === "complete" || s === "completed";
}

function isInProgressStatus(status: string | null | undefined): boolean {
  return status === "InProgress";
}

/* ─── child course card ────────────────────────────────────────────────── */

const ChildCourseRow: React.FC<{
  course: Course;
  onClick: () => void;
}> = ({ course, onClick }) => {
  const complete = isCompleteStatus(course.enrollmentStatus);
  const inProgress = isInProgressStatus(course.enrollmentStatus);

  // Type icon + label
  const { TypeIcon, typeLabel } =
    course.courseType === "OnlineCourse"
      ? { TypeIcon: SchoolIcon, typeLabel: "Online" }
      : course.courseType === "InstructorLedCourse"
      ? { TypeIcon: PersonIcon, typeLabel: "Instructor-Led" }
      : { TypeIcon: CollectionsBookmarkIcon, typeLabel: "Curriculum" };

  // Status pill
  const statusChip = complete ? (
    <Chip
      icon={<CheckCircleIcon fontSize="small" />}
      label="Completed"
      size="small"
      sx={{
        color: "#fde68a",
        backgroundColor: "rgba(253,230,138,0.14)",
        border: "1px solid currentColor",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        fontSize: "0.68rem",
      }}
    />
  ) : inProgress ? (
    <Chip
      icon={<PlayCircleOutlineIcon fontSize="small" />}
      label="In Progress"
      size="small"
      sx={{
        color: "#5eead4",
        backgroundColor: "rgba(94,234,212,0.14)",
        border: "1px solid currentColor",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        fontSize: "0.68rem",
      }}
    />
  ) : course.enrollmentStatus ? (
    <Chip
      label="Not Started"
      size="small"
      sx={{
        color: "rgba(245,243,255,0.75)",
        backgroundColor: "rgba(255,255,255,0.06)",
        border: "1px solid currentColor",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        fontSize: "0.68rem",
      }}
    />
  ) : (
    <Chip
      label="Available"
      size="small"
      sx={{
        color: "#f0abfc",
        backgroundColor: "rgba(240,171,252,0.14)",
        border: "1px solid currentColor",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        fontSize: "0.68rem",
      }}
    />
  );

  return (
    <Box
      component="button"
      type="button"
      onClick={onClick}
      sx={{
        all: "unset",
        cursor: "pointer",
        display: "flex",
        alignItems: "stretch",
        gap: 1.5,
        p: 1.5,
        borderRadius: 3,
        background: complete
          ? "rgba(253,230,138,0.06)"
          : inProgress
          ? "rgba(94,234,212,0.07)"
          : "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.12)",
        transition: "transform 0.25s, border-color 0.25s, box-shadow 0.25s",
        "&:hover": {
          transform: "translateY(-1px)",
          borderColor: "rgba(94,234,212,0.55)",
          boxShadow: "0 12px 32px rgba(94,234,212,0.18)",
        },
        "&:focus-visible": {
          outline: "2px solid #5eead4",
          outlineOffset: 2,
        },
      }}
    >
      {/* Thumbnail with type-tinted gradient backdrop when imageUrl missing */}
      <Box
        sx={{
          flexShrink: 0,
          width: 64,
          height: 64,
          borderRadius: 2,
          overflow: "hidden",
          background: course.imageUrl
            ? `center/cover no-repeat url(${course.imageUrl})`
            : "linear-gradient(135deg, rgba(94,234,212,0.18), rgba(167,139,250,0.18))",
          display: "grid",
          placeItems: "center",
          color: "rgba(245,243,255,0.65)",
        }}
      >
        {!course.imageUrl && <TypeIcon fontSize="medium" />}
      </Box>

      <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 0.5 }}>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 0.75,
            color: "rgba(245,243,255,0.55)",
            fontSize: "0.68rem",
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            fontWeight: 700,
          }}
        >
          <TypeIcon sx={{ fontSize: "0.95rem" }} />
          {typeLabel}
        </Box>
        <Typography
          variant="subtitle2"
          sx={{
            fontFamily: "'Space Grotesk', sans-serif",
            fontWeight: 700,
            color: "rgba(245,243,255,0.95)",
            lineHeight: 1.25,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            wordBreak: "break-word",
          }}
        >
          {course.name || "Untitled course"}
        </Typography>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 0.25 }}>
          {statusChip}
        </Box>
      </Box>

      <Box
        sx={{
          alignSelf: "center",
          color: "rgba(245,243,255,0.5)",
          flexShrink: 0,
        }}
      >
        <ArrowForwardIcon fontSize="small" />
      </Box>
    </Box>
  );
};

/* ─── modal ────────────────────────────────────────────────────────────── */

export function CurriculumModal({
  curriculumId,
  curriculumTitle,
  onClose,
  onPickCourse,
}: CurriculumModalProps) {
  const [state, setState] = useState<FetcherState>("idle");
  const [courses, setCourses] = useState<Course[]>([]);
  const [error, setError] = useState<string | null>(null);

  const open = curriculumId !== null;

  useEffect(() => {
    if (!curriculumId) {
      // Reset on close.
      setState("idle");
      setCourses([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setState("loading");
    fetch(`/curriculum/${encodeURIComponent(curriculumId)}`, {
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as {
          courses?: Course[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error ?? `HTTP ${res.status}`);
          setState("error");
          return;
        }
        setCourses(json.courses ?? []);
        setState("loaded");
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setState("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [curriculumId]);

  // Sort: in-progress first, then not started/available, then completed.
  const sorted = [...courses].sort((a, b) => {
    const order = (s: string | null) =>
      s === "InProgress" ? 0 : isCompleteStatus(s) ? 2 : 1;
    return order(a.enrollmentStatus) - order(b.enrollmentStatus);
  });

  const completedCount = courses.filter((c) =>
    isCompleteStatus(c.enrollmentStatus)
  ).length;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      PaperProps={{
        sx: {
          borderRadius: 4,
          background: "rgba(20, 20, 36, 0.92)",
          backdropFilter: "blur(28px) saturate(160%)",
          WebkitBackdropFilter: "blur(28px) saturate(160%)",
          border: "1px solid rgba(255, 255, 255, 0.18)",
          color: "#f5f3ff",
        },
      }}
    >
      <DialogTitle
        sx={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 2,
          fontFamily: "'Space Grotesk', sans-serif",
          fontWeight: 700,
          pb: 1,
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography
            variant="caption"
            sx={{
              textTransform: "uppercase",
              letterSpacing: "0.18em",
              color: "rgba(245,243,255,0.6)",
              fontWeight: 600,
              fontSize: "0.7rem",
              display: "inline-flex",
              alignItems: "center",
              gap: 0.75,
            }}
          >
            <CollectionsBookmarkIcon sx={{ fontSize: "0.85rem" }} />
            Curriculum
          </Typography>
          <Typography
            variant="h6"
            sx={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 700,
              lineHeight: 1.25,
              mt: 0.25,
              wordBreak: "break-word",
            }}
          >
            {curriculumTitle || "Course bundle"}
          </Typography>
          {state === "loaded" && courses.length > 0 && (
            <Typography
              variant="caption"
              sx={{
                color: "rgba(245,243,255,0.55)",
                fontWeight: 500,
                mt: 0.25,
                display: "block",
                fontSize: "0.78rem",
              }}
            >
              {courses.length} course{courses.length === 1 ? "" : "s"}
              {completedCount > 0 ? ` · ${completedCount} completed` : ""}
            </Typography>
          )}
        </Box>
        <IconButton
          onClick={onClose}
          aria-label="Close"
          size="small"
          sx={{ color: "rgba(245,243,255,0.7)", flexShrink: 0 }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers sx={{ borderColor: "rgba(255,255,255,0.1)" }}>
        {state === "loading" && (
          <Box sx={{ display: "grid", placeItems: "center", py: 6 }}>
            <CircularProgress sx={{ color: "#5eead4" }} />
          </Box>
        )}

        {state === "error" && (
          <Alert severity="error" sx={{ borderRadius: 2 }}>
            Couldn&rsquo;t load the courses in this curriculum: {error}
          </Alert>
        )}

        {state === "loaded" && sorted.length === 0 && (
          <Box sx={{ py: 6, textAlign: "center" }}>
            <EventAvailableIcon
              sx={{ fontSize: 48, color: "rgba(245,243,255,0.3)", mb: 1 }}
            />
            <Typography
              variant="body1"
              sx={{
                color: "rgba(245,243,255,0.7)",
                mb: 0.5,
                fontWeight: 600,
              }}
            >
              No courses in this curriculum yet
            </Typography>
            <Typography variant="body2" sx={{ color: "rgba(245,243,255,0.45)" }}>
              The bundle hasn&rsquo;t been populated, or your account
              doesn&rsquo;t have access to its contents.
            </Typography>
          </Box>
        )}

        {state === "loaded" && sorted.length > 0 && (
          <Stack spacing={1.25}>
            {sorted.map((c) => (
              <ChildCourseRow
                key={c.id}
                course={c}
                onClick={() => {
                  // Hand off to caller, then close so the next modal can
                  // mount cleanly. The caller is responsible for opening
                  // the appropriate downstream modal (CoursePlayerModal /
                  // SessionsModal / nested CurriculumModal).
                  onPickCourse(c);
                  onClose();
                }}
              />
            ))}
          </Stack>
        )}
      </DialogContent>
    </Dialog>
  );
}
