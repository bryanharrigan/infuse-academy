import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Typography,
} from "@mui/material";
import { Close as CloseIcon, OpenInNew as OpenInNewIcon } from "@mui/icons-material";
import { useFetcher } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";

type LessonPlayerData = {
  playerUrl: string;
  courseId: string;
  lessonId: string | null;
  verifier: string;
  pickedLesson: boolean;
};

type ApiError = { error: string };

type LessonPlayerModalProps = {
  /** Non-null while the modal should be open. */
  courseId: string | null;
  courseTitle?: string;
  /**
   * "lesson" (default) → Absorb's single-lesson player; auto-resolves the next
   *   incomplete lesson.
   * "course"           → Absorb's multi-lesson Course Player with the lesson
   *   sidebar. Use when the learner should see / navigate all lessons.
   */
  mode?: "lesson" | "course";
  onClose: () => void;
};

const IFRAME_LOAD_TIMEOUT_MS = 8_000;

/**
 * Absorb Lesson Player, embedded in an MUI Dialog.
 *
 * Flow when `courseId` becomes non-null:
 *   1. Fire a GET to /lesson-player/:courseId (resource route) via useFetcher.
 *      Server generates a fresh verifier + single-use refresh token and returns
 *      the full Absorb /learn/lessonPlayer URL.
 *   2. Render <iframe src={playerUrl}>. If the iframe doesn't report `load`
 *      within IFRAME_LOAD_TIMEOUT_MS, we assume Absorb's X-Frame-Options /
 *      CSP blocked it, and surface a "Open in new window" fallback.
 *
 *   For iframe embedding to work, the origin of this app (e.g.
 *   https://bryanh.localhost:5173) must be added under Portal Settings →
 *   Info → Absorb Allow List in the Absorb admin. Without that, the iframe
 *   will be blocked silently and the popup fallback will kick in.
 */
export function LessonPlayerModal({
  courseId,
  courseTitle,
  mode = "lesson",
  onClose,
}: LessonPlayerModalProps) {
  const fetcher = useFetcher<LessonPlayerData | ApiError>();
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [iframeBlocked, setIframeBlocked] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track both courseId and mode so switching mode for the same course
  // triggers a refetch (fresh refresh token + correct player URL).
  const lastFetchedKey = useRef<string | null>(null);

  // Kick off the loader fetch whenever a new courseId or mode is opened.
  useEffect(() => {
    if (!courseId) {
      lastFetchedKey.current = null;
      setIframeLoaded(false);
      setIframeBlocked(false);
      return;
    }
    const key = `${courseId}|${mode}`;
    if (lastFetchedKey.current === key) return;
    lastFetchedKey.current = key;
    setIframeLoaded(false);
    setIframeBlocked(false);
    const qs = mode === "course" ? "?mode=course" : "";
    fetcher.load(`/lesson-player/${courseId}${qs}`);
  }, [courseId, mode, fetcher]);

  // Watchdog: if the iframe never loads, assume embedding was blocked.
  useEffect(() => {
    if (!courseId) return;
    if (fetcher.state !== "idle") return;
    if (!fetcher.data || "error" in fetcher.data) return;
    if (iframeLoaded || iframeBlocked) return;

    timeoutRef.current = setTimeout(() => {
      if (!iframeLoaded) setIframeBlocked(true);
    }, IFRAME_LOAD_TIMEOUT_MS);

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [courseId, fetcher.state, fetcher.data, iframeLoaded, iframeBlocked]);

  const open = courseId !== null;
  const loading = fetcher.state !== "idle" && !fetcher.data;
  const apiError =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;
  const playerUrl =
    fetcher.data && !("error" in fetcher.data) ? fetcher.data.playerUrl : null;
  const pickedLesson =
    fetcher.data && !("error" in fetcher.data) ? fetcher.data.pickedLesson : false;

  const handleOpenInNewWindow = () => {
    if (!playerUrl) return;
    window.open(
      playerUrl,
      "absorb-lesson-player",
      "width=1200,height=800,noopener,noreferrer"
    );
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="lg"
      PaperProps={{
        className: "h-[90vh] max-h-[90vh]",
      }}
    >
      <DialogTitle className="flex items-center justify-between pr-2">
        <Typography variant="h6" className="truncate" component="span">
          {courseTitle || "Lesson Player"}
        </Typography>
        <IconButton onClick={onClose} aria-label="Close lesson player" size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers className="flex flex-col p-0">
        {loading && (
          <Box className="flex flex-1 items-center justify-center p-12">
            <CircularProgress />
          </Box>
        )}

        {apiError && (
          <Box className="p-6">
            <Alert severity="error">
              Couldn&rsquo;t start the lesson player: {apiError}
            </Alert>
          </Box>
        )}

        {!loading && !apiError && playerUrl && !iframeBlocked && (
          <Box className="relative flex flex-1">
            {!iframeLoaded && (
              <Box className="absolute inset-0 flex items-center justify-center">
                <CircularProgress />
              </Box>
            )}
            <iframe
              ref={iframeRef}
              src={playerUrl}
              title="Absorb Lesson Player"
              className="flex-1 border-0"
              allow="autoplay; fullscreen; encrypted-media"
              allowFullScreen
              onLoad={() => setIframeLoaded(true)}
            />
          </Box>
        )}

        {!loading && !apiError && playerUrl && iframeBlocked && (
          <Box className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
            <Alert severity="info" className="max-w-xl">
              The lesson couldn&rsquo;t be embedded here. This usually means the
              app&rsquo;s URL hasn&rsquo;t been added to Absorb&rsquo;s Allow
              List yet (Portal Settings → Info → Absorb Allow List). Open the
              lesson in a new window instead:
            </Alert>
            <Button
              variant="contained"
              startIcon={<OpenInNewIcon />}
              onClick={handleOpenInNewWindow}
            >
              Open lesson in new window
            </Button>
            {pickedLesson && (
              <Typography variant="caption" color="textSecondary">
                Resuming next incomplete lesson.
              </Typography>
            )}
          </Box>
        )}
      </DialogContent>

      <DialogActions>
        {playerUrl && !iframeBlocked && (
          <Button
            startIcon={<OpenInNewIcon />}
            onClick={handleOpenInNewWindow}
            size="small"
          >
            Open in new window
          </Button>
        )}
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
