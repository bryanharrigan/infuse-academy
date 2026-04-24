import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogTitle,
  IconButton,
  Typography,
} from "@mui/material";
import {
  Close as CloseIcon,
  OpenInNew as OpenInNewIcon,
  PlayCircleOutline,
  CheckCircle,
} from "@mui/icons-material";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Chapter, Lesson } from "~/.server/infuse-api";

/**
 * Course Player modal with a chapter/lesson sidebar.
 *
 * Absorb's native `/learn/v2/coursePlayer` URL refuses to embed in an iframe
 * (X-Frame-Options: sameorigin on the wrapping chrome), so we build the
 * sidebar UI ourselves and load `/learn/lessonplayer?lessonId=…` in the
 * iframe — that endpoint respects the Absorb Allow List.
 *
 * Flow:
 *   1. When `courseId` becomes non-null, fetch
 *        GET /lesson-player/:courseId?mode=course
 *      to get `{ chapters, playerUrl, lessonId }` — chapters for the sidebar,
 *      plus the URL for the first lesson.
 *   2. Render the sidebar (chapters → lessons) and iframe the first URL.
 *   3. When the learner clicks a different lesson, fetch
 *        GET /lesson-player/:courseId?lessonId=<id>
 *      to mint a fresh single-use refresh token for that specific lesson and
 *      swap the iframe src.
 *   4. If the iframe fails to load within 8s, assume embedding was blocked
 *      and surface an "Open in new window" fallback.
 */

type InitialPayload = {
  playerUrl: string;
  courseId: string;
  lessonId: string | null;
  verifier: string;
  pickedLesson: boolean;
  chapters?: Chapter[];
};

type LessonPayload = { playerUrl: string; lessonId: string | null };

type CoursePlayerModalProps = {
  courseId: string | null;
  courseTitle?: string;
  onClose: () => void;
};

const IFRAME_LOAD_TIMEOUT_MS = 8_000;

export function CoursePlayerModal({
  courseId,
  courseTitle,
  onClose,
}: CoursePlayerModalProps) {
  const [initial, setInitial] = useState<InitialPayload | null>(null);
  const [loadingInitial, setLoadingInitial] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [activeLessonId, setActiveLessonId] = useState<string | null>(null);
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [loadingLesson, setLoadingLesson] = useState(false);

  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [iframeBlocked, setIframeBlocked] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFetchedCourseId = useRef<string | null>(null);

  // Reset state whenever the modal opens or closes.
  useEffect(() => {
    if (!courseId) {
      lastFetchedCourseId.current = null;
      setInitial(null);
      setError(null);
      setActiveLessonId(null);
      setActiveUrl(null);
      setIframeLoaded(false);
      setIframeBlocked(false);
      return;
    }
    if (lastFetchedCourseId.current === courseId) return;
    lastFetchedCourseId.current = courseId;
    setInitial(null);
    setError(null);
    setActiveLessonId(null);
    setActiveUrl(null);
    setIframeLoaded(false);
    setIframeBlocked(false);
    setLoadingInitial(true);

    let cancelled = false;
    fetch(`/lesson-player/${courseId}?mode=course`, {
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || ("error" in json && json.error)) {
          setError(
            ("error" in json && json.error) || `HTTP ${res.status}`
          );
          return;
        }
        setInitial(json as InitialPayload);
        setActiveLessonId((json as InitialPayload).lessonId ?? null);
        setActiveUrl((json as InitialPayload).playerUrl ?? null);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message ?? String(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingInitial(false);
      });

    return () => {
      cancelled = true;
    };
  }, [courseId]);

  // Watchdog for iframe blocks.
  useEffect(() => {
    if (!courseId) return;
    if (!activeUrl) return;
    if (iframeLoaded || iframeBlocked) return;

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      if (!iframeLoaded) setIframeBlocked(true);
    }, IFRAME_LOAD_TIMEOUT_MS);

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [courseId, activeUrl, iframeLoaded, iframeBlocked]);

  const flatLessons: Lesson[] = useMemo(() => {
    const out: Lesson[] = [];
    for (const ch of initial?.chapters ?? []) {
      for (const l of ch._embedded?.lessons ?? []) out.push(l);
    }
    return out;
  }, [initial]);

  const handleLessonClick = (lessonId: string) => {
    if (!courseId) return;
    if (lessonId === activeLessonId && activeUrl) return;
    setActiveLessonId(lessonId);
    setIframeLoaded(false);
    setIframeBlocked(false);
    setLoadingLesson(true);

    fetch(
      `/lesson-player/${courseId}?lessonId=${encodeURIComponent(lessonId)}`,
      { headers: { Accept: "application/json" } }
    )
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok || ("error" in json && json.error)) {
          setError(("error" in json && json.error) || `HTTP ${res.status}`);
          return;
        }
        setActiveUrl((json as LessonPayload).playerUrl);
      })
      .catch((err) => setError(err?.message ?? String(err)))
      .finally(() => setLoadingLesson(false));
  };

  const open = courseId !== null;
  const hasLessons = flatLessons.length > 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth={false}
      PaperProps={{
        sx: {
          width: "94vw",
          height: "90vh",
          maxWidth: "94vw",
          maxHeight: "90vh",
          m: 2,
          display: "flex",
          flexDirection: "column",
        },
      }}
    >
      <DialogTitle
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          py: 1,
          px: 2,
          borderBottom: "1px solid",
          borderBottomColor: "divider",
          flexShrink: 0,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>
          <Typography
            variant="subtitle1"
            sx={{
              fontWeight: 600,
              fontFamily: "'Space Grotesk', sans-serif",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {courseTitle || "Course Player"}
          </Typography>
          {(loadingInitial || loadingLesson) && (
            <CircularProgress size={16} />
          )}
          {iframeBlocked && (
            <Typography variant="caption" color="error">
              Embedding blocked
            </Typography>
          )}
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          {activeUrl && (
            <IconButton
              size="small"
              href={activeUrl}
              target="_blank"
              rel="noreferrer"
              title="Open current lesson in a new tab"
            >
              <OpenInNewIcon fontSize="small" />
            </IconButton>
          )}
          <IconButton size="small" onClick={onClose} title="Close">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
      </DialogTitle>

      {/* Body: sidebar + player */}
      <Box
        sx={{
          flex: 1,
          display: "flex",
          minHeight: 0,
          background: "var(--ia-black, #0a0a0f)",
        }}
      >
        {/* Sidebar */}
        <Box
          sx={{
            width: 320,
            flexShrink: 0,
            borderRight: "1px solid",
            borderRightColor: "divider",
            overflowY: "auto",
            background: "var(--ia-dark, #12121a)",
          }}
        >
          <Box sx={{ p: 2, borderBottom: "1px solid", borderBottomColor: "divider" }}>
            <Typography
              variant="caption"
              sx={{
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "text.secondary",
                fontWeight: 600,
              }}
            >
              Lessons
            </Typography>
            {hasLessons && (
              <Typography
                variant="body2"
                sx={{ color: "text.secondary", mt: 0.5 }}
              >
                {flatLessons.length}{" "}
                {flatLessons.length === 1 ? "lesson" : "lessons"}
              </Typography>
            )}
          </Box>

          {loadingInitial && !initial && (
            <Box sx={{ p: 3, display: "grid", placeItems: "center" }}>
              <CircularProgress size={22} />
            </Box>
          )}

          {!loadingInitial && initial && !hasLessons && (
            <Box sx={{ p: 3 }}>
              <Typography variant="body2" color="text.secondary">
                This course doesn&rsquo;t have any lessons listed — opening the
                default player instead.
              </Typography>
            </Box>
          )}

          {initial?.chapters?.map((chapter) => {
            const lessons = chapter._embedded?.lessons ?? [];
            if (lessons.length === 0) return null;
            return (
              <Box key={chapter.id} sx={{ py: 1 }}>
                <Typography
                  variant="caption"
                  sx={{
                    display: "block",
                    px: 2,
                    py: 0.5,
                    color: "text.secondary",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  {chapter.name || chapter.title || "Chapter"}
                </Typography>
                {lessons.map((lesson) => {
                  const complete =
                    (lesson.progress?.status ?? "").toLowerCase() ===
                      "complete" ||
                    (lesson.progress?.status ?? "").toLowerCase() ===
                      "completed" ||
                    Boolean(lesson.progress?.completedDate);
                  const active = lesson.id === activeLessonId;
                  return (
                    <Box
                      key={lesson.id}
                      component="button"
                      type="button"
                      onClick={() => handleLessonClick(lesson.id)}
                      sx={{
                        all: "unset",
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                        width: "100%",
                        boxSizing: "border-box",
                        px: 2,
                        py: 1.25,
                        cursor: "pointer",
                        borderLeft: "3px solid",
                        borderLeftColor: active
                          ? "var(--ia-accent-1, #6c63ff)"
                          : "transparent",
                        background: active
                          ? "rgba(108,99,255,0.1)"
                          : "transparent",
                        "&:hover": {
                          background: "rgba(255,255,255,0.04)",
                        },
                        "&:focus-visible": {
                          outline: "2px solid var(--ia-accent-1, #6c63ff)",
                          outlineOffset: -2,
                        },
                      }}
                    >
                      {complete ? (
                        <CheckCircle
                          fontSize="small"
                          sx={{ color: "var(--ia-accent-3, #43e97b)" }}
                        />
                      ) : (
                        <PlayCircleOutline
                          fontSize="small"
                          sx={{
                            color: active
                              ? "var(--ia-accent-1, #6c63ff)"
                              : "text.secondary",
                          }}
                        />
                      )}
                      <Typography
                        variant="body2"
                        sx={{
                          color: active ? "text.primary" : "text.secondary",
                          fontWeight: active ? 600 : 400,
                        }}
                      >
                        {lesson.name || lesson.title || "Lesson"}
                      </Typography>
                    </Box>
                  );
                })}
              </Box>
            );
          })}
        </Box>

        {/* Player area */}
        <Box
          sx={{
            flex: 1,
            position: "relative",
            display: "grid",
            placeItems: "center",
            minWidth: 0,
            background: "#000",
          }}
        >
          {error && (
            <Box sx={{ p: 4, maxWidth: 520 }}>
              <Alert severity="error">Couldn&rsquo;t start course: {error}</Alert>
            </Box>
          )}

          {!error && loadingInitial && !activeUrl && <CircularProgress />}

          {!error && activeUrl && !iframeBlocked && (
            <>
              {!iframeLoaded && (
                <Box
                  sx={{
                    position: "absolute",
                    inset: 0,
                    display: "grid",
                    placeItems: "center",
                    pointerEvents: "none",
                  }}
                >
                  <CircularProgress />
                </Box>
              )}
              <iframe
                ref={iframeRef}
                key={activeUrl}
                src={activeUrl}
                title={courseTitle || "Absorb Course Player"}
                allow="fullscreen; autoplay; encrypted-media"
                allowFullScreen
                style={{
                  width: "100%",
                  height: "100%",
                  border: "none",
                  background: "#000",
                }}
                onLoad={() => setIframeLoaded(true)}
                onError={() => setIframeBlocked(true)}
              />
            </>
          )}

          {!error && activeUrl && iframeBlocked && (
            <Box
              sx={{
                p: 4,
                maxWidth: 520,
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                gap: 2,
                alignItems: "center",
              }}
            >
              <Alert severity="info">
                Your Absorb portal is blocking this lesson from embedding.
                Open it in a new window instead.
              </Alert>
              <Button
                variant="contained"
                startIcon={<OpenInNewIcon />}
                href={activeUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open lesson in new window
              </Button>
            </Box>
          )}
        </Box>
      </Box>
    </Dialog>
  );
}
