/**
 * app/components/modal/curriculum-modal.tsx
 *
 * In-app curriculum drill-in. Replaces the window.open() bounce to
 * Absorb's portal — keeps the learner inside the Cowork app.
 *
 * Renders:
 *   - Header card with the curriculum's headline progress (big bar +
 *     percent + completion summary). Visually distinct from per-course
 *     cards so the curriculum's own progress reads at a glance.
 *   - One section per "group" inside the curriculum, each with the
 *     group's name + completion rule (e.g. "Complete all", "Complete 2
 *     of 3"). Courses are slotted under whichever group they belong to.
 *   - Any courses not assigned to a group fall back into an "Other"
 *     section so nothing is lost.
 *
 * Click flow:
 *   1. Tapping a child course fires `onPickCourse(course)`. Caller is
 *      responsible for opening the appropriate downstream modal
 *      (CoursePlayerModal / SessionsModal / nested CurriculumModal).
 *   2. The modal stays mounted but invisible (parent toggles
 *      `curriculumId`) so when the child closes the parent can reopen
 *      this same modal — the learner returns to the curriculum context
 *      they came from rather than dropping back to the hub.
 *
 * Theming is intentionally neutral (translucent dark glass) so it sits
 * well over either `body.theme-experimental` aurora or `body.theme-ia`
 * dark backgrounds.
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
  Layers as LayersIcon,
} from "@mui/icons-material";
import { useEffect, useMemo, useState } from "react";

import type { Course } from "~/.server/course.resource";
import type {
  CurriculumGroup,
  CurriculumEnrollmentSummary,
} from "~/.server/infuse-api";

type CurriculumModalProps = {
  /** Curriculum course id; non-null while the modal should be open. */
  curriculumId: string | null;
  /** Curriculum's name for the dialog header. */
  curriculumTitle?: string;
  /** Fired when the modal is closed (escape, backdrop, X). */
  onClose: () => void;
  /**
   * Fired when the learner picks a child course. Caller decides what to
   * open next based on `course.courseType` and is responsible for
   * reopening this modal afterwards if it wants to preserve the
   * "return to curriculum" navigation.
   */
  onPickCourse: (course: Course) => void;
};

type FetcherState = "idle" | "loading" | "loaded" | "error";

type OverviewData = {
  groups: CurriculumGroup[];
  courses: Course[];
  enrollment: CurriculumEnrollmentSummary | null;
};

function isCompleteStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  return s === "complete" || s === "completed";
}

function isInProgressStatus(status: string | null | undefined): boolean {
  return status === "InProgress";
}

/* ─── completion-rule helpers ──────────────────────────────────────────── */

function describeCompletionRule(group: CurriculumGroup): string {
  const type = (group.completionType ?? "").toLowerCase();
  const total = group.totalCourses ?? group.courseIds?.length ?? 0;
  const count = group.completionCount;

  // "All": complete every course in the group.
  if (type === "all" || type === "completeall" || type === "everything") {
    return total > 0
      ? `Complete all ${total} course${total === 1 ? "" : "s"}`
      : "Complete every course";
  }
  // "Some" / "AnyN" / explicit count.
  if (type === "some" || type === "any" || type === "completesome" || count) {
    if (typeof count === "number" && count > 0) {
      return total > 0
        ? `Complete ${count} of ${total} courses`
        : `Complete ${count} course${count === 1 ? "" : "s"}`;
    }
    return "Complete the required courses";
  }
  // Sequential.
  if (type === "sequential" || type === "ordered") {
    return total > 0
      ? `Complete ${total} course${total === 1 ? "" : "s"} in order`
      : "Complete in order";
  }
  // Fallback — surface the description if Absorb gave us one.
  if (group.description && group.description.length < 80) {
    return group.description;
  }
  return total > 0
    ? `Includes ${total} course${total === 1 ? "" : "s"}`
    : "Required for curriculum completion";
}

/* ─── child course row ─────────────────────────────────────────────────── */

const ChildCourseRow: React.FC<{
  course: Course;
  onClick: () => void;
}> = ({ course, onClick }) => {
  const complete = isCompleteStatus(course.enrollmentStatus);
  const inProgress = isInProgressStatus(course.enrollmentStatus);

  const { TypeIcon, typeLabel } =
    course.courseType === "OnlineCourse"
      ? { TypeIcon: SchoolIcon, typeLabel: "Online" }
      : course.courseType === "InstructorLedCourse"
      ? { TypeIcon: PersonIcon, typeLabel: "Instructor-Led" }
      : { TypeIcon: CollectionsBookmarkIcon, typeLabel: "Curriculum" };

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

      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 0.5,
        }}
      >
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

/* ─── prominent overall progress card (header) ────────────────────────── */

const CurriculumProgressCard: React.FC<{
  enrollment: CurriculumEnrollmentSummary | null;
  totalCourses: number;
  completedCourses: number;
  totalGroups: number;
  completedGroups: number;
}> = ({ enrollment, totalCourses, completedCourses, totalGroups, completedGroups }) => {
  // Prefer Absorb's own progress number when populated; fall back to
  // course-completion ratio so the bar isn't stuck at 0 for curricula
  // whose enrollment record hasn't synced yet.
  const pct = enrollment && enrollment.progress > 0
    ? Math.round(enrollment.progress)
    : totalCourses > 0
    ? Math.round((completedCourses / totalCourses) * 100)
    : 0;
  const status = enrollment?.enrollmentStatus ?? null;
  const isDone = isCompleteStatus(status);

  return (
    <Box
      sx={{
        mb: 2.5,
        p: 2.25,
        borderRadius: 4,
        background: isDone
          ? "linear-gradient(135deg, rgba(253,230,138,0.15) 0%, rgba(240,171,252,0.15) 100%)"
          : "linear-gradient(135deg, rgba(94,234,212,0.15) 0%, rgba(167,139,250,0.15) 100%)",
        border: "1px solid rgba(255,255,255,0.18)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.18), 0 12px 32px rgba(0,0,0,0.18)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 2,
          mb: 1.25,
        }}
      >
        <Box>
          <Typography
            variant="caption"
            sx={{
              textTransform: "uppercase",
              letterSpacing: "0.18em",
              color: "rgba(245,243,255,0.7)",
              fontWeight: 700,
              fontSize: "0.7rem",
            }}
          >
            Curriculum progress
          </Typography>
          <Typography
            sx={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 800,
              fontSize: "2rem",
              lineHeight: 1,
              color: "#f5f3ff",
              mt: 0.25,
            }}
          >
            {pct}%
          </Typography>
        </Box>
        <Box sx={{ textAlign: "right" }}>
          <Typography
            sx={{
              fontWeight: 700,
              color: "rgba(245,243,255,0.92)",
              fontSize: "0.95rem",
              fontFamily: "'Space Grotesk', sans-serif",
            }}
          >
            {completedCourses} / {totalCourses} courses
          </Typography>
          {totalGroups > 0 && (
            <Typography
              variant="caption"
              sx={{
                color: "rgba(245,243,255,0.6)",
                fontSize: "0.78rem",
              }}
            >
              {completedGroups} of {totalGroups} group
              {totalGroups === 1 ? "" : "s"} complete
            </Typography>
          )}
        </Box>
      </Box>

      {/* Big iridescent progress bar — distinct from per-course bars */}
      <Box
        sx={{
          position: "relative",
          height: 12,
          borderRadius: 999,
          background: "rgba(0,0,0,0.32)",
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,0.14)",
        }}
        aria-hidden
      >
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            width: `${pct}%`,
            background:
              "linear-gradient(90deg, #5eead4 0%, #a78bfa 50%, #f0abfc 100%)",
            transition: "width 600ms cubic-bezier(0.22, 1, 0.36, 1)",
            boxShadow: "0 0 16px rgba(94,234,212,0.55)",
          }}
        />
      </Box>

      {status && (
        <Typography
          variant="caption"
          sx={{
            display: "block",
            mt: 1,
            color: isDone ? "#fde68a" : "rgba(245,243,255,0.78)",
            fontWeight: 600,
            fontSize: "0.78rem",
          }}
        >
          {isDone
            ? "✓ Completed"
            : isInProgressStatus(status)
            ? "In progress"
            : status}
        </Typography>
      )}
    </Box>
  );
};

/* ─── group section header ─────────────────────────────────────────────── */

const GroupHeader: React.FC<{
  group: CurriculumGroup;
  index: number;
  groupCourses: Course[];
}> = ({ group, index, groupCourses }) => {
  const completedInGroup = groupCourses.filter((c) =>
    isCompleteStatus(c.enrollmentStatus)
  ).length;
  const requiredCount =
    group.completionCount ??
    (typeof group.totalCourses === "number" ? group.totalCourses : groupCourses.length);
  const groupComplete =
    requiredCount > 0 && completedInGroup >= requiredCount;
  const rule = describeCompletionRule({
    ...group,
    totalCourses: group.totalCourses ?? groupCourses.length,
  });

  return (
    <Box
      sx={{
        mt: index === 0 ? 0 : 2.25,
        mb: 1,
        display: "flex",
        alignItems: "flex-start",
        gap: 1.5,
      }}
    >
      <Box
        sx={{
          flexShrink: 0,
          width: 32,
          height: 32,
          borderRadius: "50%",
          display: "grid",
          placeItems: "center",
          background: groupComplete
            ? "linear-gradient(135deg, #fde68a, #f0abfc)"
            : "rgba(255,255,255,0.07)",
          border: groupComplete
            ? "1px solid rgba(253,230,138,0.6)"
            : "1px solid rgba(255,255,255,0.18)",
          color: groupComplete ? "#06061a" : "rgba(245,243,255,0.85)",
          fontWeight: 800,
          fontSize: "0.85rem",
          fontFamily: "'Space Grotesk', sans-serif",
        }}
      >
        {groupComplete ? <CheckCircleIcon sx={{ fontSize: "1.1rem" }} /> : index + 1}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
          <Typography
            variant="subtitle1"
            sx={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 700,
              color: "#f5f3ff",
              lineHeight: 1.2,
            }}
          >
            {group.name || `Group ${index + 1}`}
          </Typography>
          {requiredCount > 0 && (
            <Chip
              size="small"
              label={`${completedInGroup}/${requiredCount}`}
              sx={{
                fontWeight: 700,
                fontSize: "0.7rem",
                color: groupComplete ? "#fde68a" : "#5eead4",
                backgroundColor: groupComplete
                  ? "rgba(253,230,138,0.14)"
                  : "rgba(94,234,212,0.14)",
                border: "1px solid currentColor",
                letterSpacing: "0.04em",
              }}
            />
          )}
        </Box>
        <Typography
          variant="caption"
          sx={{
            display: "block",
            color: "rgba(245,243,255,0.6)",
            fontSize: "0.78rem",
            mt: 0.25,
          }}
        >
          {rule}
        </Typography>
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
  const [data, setData] = useState<OverviewData>({
    groups: [],
    courses: [],
    enrollment: null,
  });
  const [error, setError] = useState<string | null>(null);

  const open = curriculumId !== null;

  useEffect(() => {
    if (!curriculumId) {
      setState("idle");
      setData({ groups: [], courses: [], enrollment: null });
      setError(null);
      return;
    }
    let cancelled = false;
    setState("loading");
    fetch(`/curriculum/${encodeURIComponent(curriculumId)}`, {
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as Partial<OverviewData> & {
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error ?? `HTTP ${res.status}`);
          setState("error");
          return;
        }
        setData({
          groups: json.groups ?? [],
          courses: json.courses ?? [],
          enrollment: json.enrollment ?? null,
        });
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

  /**
   * Bucket courses by group. Falls back to a single "Other" bucket for
   * courses whose group membership we can't determine — and to a
   * single un-grouped "All courses" bucket when the curriculum has no
   * groups defined at all.
   */
  const buckets = useMemo(() => {
    const byId = new Map<string, Course>(data.courses.map((c) => [c.id, c]));
    const used = new Set<string>();
    const result: Array<{
      group: CurriculumGroup | null;
      courses: Course[];
    }> = [];

    if (data.groups.length === 0) {
      // No groups → render a single un-grouped section.
      return [
        {
          group: null,
          courses: data.courses,
        },
      ];
    }

    for (const group of data.groups) {
      const ids = group.courseIds ?? group.courses?.map((c) => c.id) ?? [];
      const courses: Course[] = [];
      for (const id of ids) {
        const c = byId.get(id);
        if (c) {
          courses.push(c);
          used.add(id);
        }
      }
      // If the embed didn't include course ids, fall back to the embedded
      // course objects directly so we still show *something*.
      if (courses.length === 0 && group.courses && group.courses.length > 0) {
        for (const c of group.courses) {
          courses.push(c);
          used.add(c.id);
        }
      }
      result.push({ group, courses });
    }

    const orphans = data.courses.filter((c) => !used.has(c.id));
    if (orphans.length > 0) {
      result.push({ group: null, courses: orphans });
    }
    return result;
  }, [data]);

  const totalCourses = data.courses.length;
  const completedCourses = data.courses.filter((c) =>
    isCompleteStatus(c.enrollmentStatus)
  ).length;
  const totalGroups = data.groups.length;
  const completedGroups = useMemo(
    () =>
      buckets.filter(({ group, courses }) => {
        if (!group) return false;
        const completed = courses.filter((c) =>
          isCompleteStatus(c.enrollmentStatus)
        ).length;
        const required =
          group.completionCount ??
          group.totalCourses ??
          courses.length;
        return required > 0 && completed >= required;
      }).length,
    [buckets]
  );

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

        {state === "loaded" && totalCourses === 0 && (
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

        {state === "loaded" && totalCourses > 0 && (
          <>
            <CurriculumProgressCard
              enrollment={data.enrollment}
              totalCourses={totalCourses}
              completedCourses={completedCourses}
              totalGroups={totalGroups}
              completedGroups={completedGroups}
            />

            {buckets.map(({ group, courses }, i) => (
              <Box key={group?.id ?? `ungrouped-${i}`}>
                {group ? (
                  <GroupHeader group={group} index={i} groupCourses={courses} />
                ) : totalGroups > 0 ? (
                  // Orphans bucket label
                  <Box
                    sx={{
                      mt: 2.25,
                      mb: 1,
                      display: "flex",
                      alignItems: "center",
                      gap: 1,
                      color: "rgba(245,243,255,0.6)",
                      fontWeight: 700,
                      fontSize: "0.78rem",
                      textTransform: "uppercase",
                      letterSpacing: "0.14em",
                    }}
                  >
                    <LayersIcon sx={{ fontSize: "0.95rem" }} />
                    Other courses
                  </Box>
                ) : null}
                <Stack spacing={1.25}>
                  {courses.map((c) => (
                    <ChildCourseRow
                      key={c.id}
                      course={c}
                      onClick={() => onPickCourse(c)}
                    />
                  ))}
                </Stack>
              </Box>
            ))}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
