/**
 * app/components/modal/sessions-modal.tsx
 *
 * Native sessions list for InstructorLedCourse cards. Replaces the
 * window.open() bounce to Absorb's portal — keeps the learner inside the
 * Cowork app and lets them register for a session in two taps.
 *
 * Flow:
 *   1. Caller opens the modal with `courseId` set; component fetches
 *      `GET /sessions/:courseId` (the resource route).
 *   2. Renders one card per session with start/end, location, instructor,
 *      and a Register CTA (or "Already registered" when the learner has
 *      a slot in that session).
 *   3. Tapping Register POSTs `{ sessionId }` to `/enroll/:courseId`.
 *      On success the modal closes and `onRegistered()` fires so the
 *      caller can revalidate its loader.
 *
 * Theming: uses raw MUI components + a small set of CSS vars that resolve
 * to sensible values under both `body.theme-experimental` (aurora glass)
 * and `body.theme-ia` (Infuse Academy dark) — the modal looks at home in
 * either context without a theme switch.
 */

import {
  Alert,
  Box,
  Button,
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
  AccessTime as AccessTimeIcon,
  CalendarMonth as CalendarMonthIcon,
  CheckCircle as CheckCircleIcon,
  Close as CloseIcon,
  EventAvailable as EventAvailableIcon,
  LocationOn as LocationOnIcon,
  Person as PersonIcon,
  Group as GroupIcon,
  Videocam as VideocamIcon,
  ArrowOutward as ArrowOutwardIcon,
} from "@mui/icons-material";
import React, { useEffect, useMemo, useState } from "react";

import type { Session } from "~/.server/infuse-api";
import type { Course } from "~/.server/course.resource";
import { MapModal } from "./map-modal";

type SessionsModalProps = {
  /** Non-null while the modal should be open. */
  courseId: string | null;
  /** Course title for the dialog header. */
  courseTitle?: string;
  /**
   * Optional full course object — when provided we show the course
   * description in the modal header. Pass it through whenever you have it;
   * the legacy callers that pass only id+title still work.
   */
  course?: Course | null;
  /** Fired when the modal is closed (escape, backdrop, X, or after register). */
  onClose: () => void;
  /** Optional — fires after a successful registration so caller can revalidate. */
  onRegistered?: (sessionId: string) => void;
};

type FetcherState = "idle" | "loading" | "loaded" | "error";

function isSessionRegistered(s: Session): boolean {
  if (s.isLearnerEnrolled === true) return true;
  const status = (s.enrollmentStatus ?? "").toLowerCase();
  return (
    status === "enrolled" ||
    status === "registered" ||
    status === "complete" ||
    status === "completed" ||
    status === "inprogress"
  );
}

function formatSessionDateRange(start?: string, end?: string): string {
  if (!start) return "Date TBD";
  const startDate = new Date(start);
  if (isNaN(startDate.getTime())) return start;
  const dateOptions: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  };
  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
  };
  const startStr =
    startDate.toLocaleDateString(undefined, dateOptions) +
    " · " +
    startDate.toLocaleTimeString(undefined, timeOptions);
  if (!end) return startStr;
  const endDate = new Date(end);
  if (isNaN(endDate.getTime())) return startStr;
  const sameDay =
    startDate.toDateString() === endDate.toDateString();
  if (sameDay) {
    return (
      startStr +
      " – " +
      endDate.toLocaleTimeString(undefined, timeOptions)
    );
  }
  return (
    startStr +
    " – " +
    endDate.toLocaleDateString(undefined, dateOptions) +
    " " +
    endDate.toLocaleTimeString(undefined, timeOptions)
  );
}

function locationStringFor(s: Session): string | null {
  const parts = [s.location, s.venue, s.city, s.country]
    .filter(Boolean)
    .map((p) => String(p).trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  // De-duplicate while preserving order — some tenants put the same value
  // in multiple fields.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }
  return deduped.join(" · ");
}

function seatsBadge(s: Session): { text: string; color: "success" | "warning" | "default" } | null {
  // Prefer explicit seatsAvailable; otherwise compute from capacity - registered.
  const seats =
    typeof s.seatsAvailable === "number"
      ? s.seatsAvailable
      : typeof s.capacity === "number" && typeof s.registeredCount === "number"
      ? s.capacity - s.registeredCount
      : null;
  if (seats === null) return null;
  if (seats <= 0) return { text: "Full", color: "default" };
  if (seats <= 3) return { text: `${seats} seat${seats === 1 ? "" : "s"} left`, color: "warning" };
  return { text: `${seats} seats open`, color: "success" };
}

/* ─── webinar detection + map query helpers ──────────────────────────── */

/**
 * True when the session is a webinar / virtual classroom. We treat any
 * of these as "yes":
 *   - Absorb's `venue.type === "Virtual"` (parsed into meetingType)
 *   - An explicit join URL (webinarUrl) is present
 *   - meetingType / location strings smell online
 */
function isWebinarSession(s: Session): boolean {
  const mt = (s.meetingType ?? "").toLowerCase();
  if (
    mt === "virtual" ||
    mt.includes("webinar") ||
    mt.includes("virtual") ||
    mt.includes("online") ||
    mt.includes("remote")
  ) {
    return true;
  }
  if (s.webinarUrl && s.webinarUrl.length > 0) return true;
  const loc = (s.location ?? "").toLowerCase();
  if (loc === "online" || loc === "virtual" || loc === "webinar") return true;
  return false;
}

/**
 * Build the address string we feed to Google Maps. Prefers the most
 * specific fields available and falls back to whatever is present.
 */
function mapAddressFor(s: Session): string | null {
  const parts: string[] = [];
  if (s.venue) parts.push(s.venue);
  if (s.address) parts.push(s.address);
  // Keep building / room out of the map query — they're noise to the
  // geocoder. They still display in the venue text alongside the map link.
  if (s.city) parts.push(s.city);
  if (s.state) parts.push(s.state);
  if (s.postalCode) parts.push(s.postalCode);
  if (s.country) parts.push(s.country);
  // If we have nothing structured, fall back to the free-form location
  // string when it looks like an address (not "Online" / "Virtual").
  if (parts.length === 0 && s.location) {
    const loc = s.location.toLowerCase();
    if (
      !["online", "virtual", "webinar", "remote"].some((k) =>
        loc.includes(k)
      )
    ) {
      parts.push(s.location);
    }
  }
  if (parts.length === 0) return null;
  return parts.join(", ");
}

function stripHtmlToText(html: string | undefined | null): string {
  if (!html) return "";
  return html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/\s+/g, " ")
    .trim();
}

export function SessionsModal({
  courseId,
  courseTitle,
  course,
  onClose,
  onRegistered,
}: SessionsModalProps) {
  const [state, setState] = useState<FetcherState>("idle");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Tracks the sessionId currently being registered for so the matching
  // card can show a spinner. Only one in flight at a time.
  const [registeringId, setRegisteringId] = useState<string | null>(null);
  const [registeredIds, setRegisteredIds] = useState<Set<string>>(new Set());

  /**
   * Sub-modal state — when a learner taps a session's location row we
   * pop an OSM map for physical addresses. Webinar links open directly
   * in a new tab (Zoom / Teams etc. block iframe embedding too often
   * to make in-app embedding worthwhile).
   */
  const [mapSession, setMapSession] = useState<Session | null>(null);

  /** Open the webinar URL in a new tab. */
  const openWebinar = (s: Session) => {
    if (!s.webinarUrl) return;
    if (typeof window === "undefined") return;
    window.open(s.webinarUrl, "_blank", "noopener,noreferrer");
  };

  const open = courseId !== null;

  useEffect(() => {
    if (!courseId) {
      // Reset on close so the next open starts fresh.
      setState("idle");
      setSessions([]);
      setError(null);
      setRegisteringId(null);
      setRegisteredIds(new Set());
      setMapSession(null);
      return;
    }
    let cancelled = false;
    setState("loading");
    fetch(`/sessions/${encodeURIComponent(courseId)}`, {
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as {
          sessions?: Session[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error ?? `HTTP ${res.status}`);
          setState("error");
          return;
        }
        setSessions(json.sessions ?? []);
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
  }, [courseId]);

  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => {
      // Registered sessions float to the top — easier to spot when
      // accessing the modal from inside a curriculum where the learner
      // already booked a slot.
      const aReg = isSessionRegistered(a) || registeredIds.has(a.id);
      const bReg = isSessionRegistered(b) || registeredIds.has(b.id);
      if (aReg !== bReg) return aReg ? -1 : 1;
      // Within each group, oldest start date first.
      const aT = a.startDate ? new Date(a.startDate).getTime() : Infinity;
      const bT = b.startDate ? new Date(b.startDate).getTime() : Infinity;
      return aT - bT;
    });
  }, [sessions, registeredIds]);

  const handleRegister = async (session: Session) => {
    if (!courseId || registeringId) return;
    setRegisteringId(session.id);
    try {
      const res = await fetch(`/enroll/${encodeURIComponent(courseId)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ sessionId: session.id }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error ?? `HTTP ${res.status}`);
      }
      // Mark as registered locally so the row updates immediately, then
      // notify the caller so it can revalidate its loader.
      setRegisteredIds((cur) => {
        const next = new Set(cur);
        next.add(session.id);
        return next;
      });
      onRegistered?.(session.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[sessions-modal] register failed:", msg);
      setError(msg);
    } finally {
      setRegisteringId(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      PaperProps={{
        sx: {
          borderRadius: 4,
          // Glass surface that looks at home over either theme's background.
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
            }}
          >
            Pick a session
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
            {courseTitle || course?.name || "Instructor-Led Course"}
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
        {/* Course description block — surfaced from the parent course
            object when provided. Folds at 4 lines so a long Absorb
            description doesn't push every session off-screen. */}
        {course?.description && stripHtmlToText(course.description).length > 0 && (
          <Box
            sx={{
              mb: 2.75,
              p: 2.75,
              borderRadius: 3,
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.1)",
            }}
          >
            <Typography
              variant="caption"
              sx={{
                color: "rgba(245,243,255,0.55)",
                textTransform: "uppercase",
                letterSpacing: "0.16em",
                fontWeight: 700,
                fontSize: "0.65rem",
                display: "block",
                mb: 0.5,
              }}
            >
              About this course
            </Typography>
            {/* Full description — DialogContent itself scrolls if the
                course writeup is long, so we don't truncate. */}
            <Typography
              variant="body2"
              sx={{
                color: "rgba(245,243,255,0.85)",
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
              }}
            >
              {stripHtmlToText(course.description)}
            </Typography>
          </Box>
        )}

        {state === "loading" && (
          <Box sx={{ display: "grid", placeItems: "center", py: 6 }}>
            <CircularProgress sx={{ color: "#5eead4" }} />
          </Box>
        )}

        {state === "error" && (
          <Alert severity="error" sx={{ borderRadius: 2 }}>
            Couldn&rsquo;t load sessions: {error}
          </Alert>
        )}

        {state === "loaded" && sortedSessions.length === 0 && (
          <Box sx={{ py: 6, textAlign: "center" }}>
            <EventAvailableIcon sx={{ fontSize: 48, color: "rgba(245,243,255,0.3)", mb: 1 }} />
            <Typography
              variant="body1"
              sx={{ color: "rgba(245,243,255,0.7)", mb: 0.5, fontWeight: 600 }}
            >
              No sessions scheduled yet
            </Typography>
            <Typography
              variant="body2"
              sx={{ color: "rgba(245,243,255,0.45)" }}
            >
              Check back soon, or browse other courses in the catalog.
            </Typography>
          </Box>
        )}

        {state === "loaded" && sortedSessions.length > 0 && (() => {
          // Anyone registered? If so, the first non-registered session
          // gets a "Switch to another session" header above it so the
          // learner sees their alternatives clearly.
          const anyRegistered = sortedSessions.some(
            (sess) => isSessionRegistered(sess) || registeredIds.has(sess.id)
          );
          const firstAlternativeIdx = sortedSessions.findIndex(
            (sess) => !isSessionRegistered(sess) && !registeredIds.has(sess.id)
          );

          return (
            <Stack spacing={1.75}>
              {sortedSessions.map((s, idx) => {
              const dateStr = formatSessionDateRange(s.startDate, s.endDate);
              const location = locationStringFor(s);
              const seats = seatsBadge(s);
              const alreadyRegistered =
                isSessionRegistered(s) || registeredIds.has(s.id);
              const isRegistering = registeringId === s.id;
              const isFull = seats?.text === "Full";
              const webinar = isWebinarSession(s);
              const mapAddress = webinar ? null : mapAddressFor(s);
              const venueClickable =
                (webinar && s.webinarUrl) || (!webinar && mapAddress);
              const venueText = webinar
                ? location ?? "Join webinar"
                : location;
              // Is the learner registered for some OTHER session in this
              // course already? If so AND the tenant allows switching,
              // the CTA on this row says "Switch" instead of "Register".
              // When canSwitch is explicitly false we keep "Register" so
              // the API call doesn't 4xx (Absorb rejects switches when
              // disabled at the tenant level).
              const otherRegistered = sortedSessions.some(
                (sess) =>
                  sess.id !== s.id &&
                  (isSessionRegistered(sess) || registeredIds.has(sess.id))
              );
              const switchAllowed = s.canSwitch !== false; // default to true when undefined
              const isSwitch = otherRegistered && switchAllowed;

              const isFirstAlternative =
                anyRegistered && idx === firstAlternativeIdx;

              return (
                <React.Fragment key={s.id}>
                  {isFirstAlternative && (
                    <Box
                      sx={{
                        mt: 1,
                        mb: 0.5,
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                      }}
                    >
                      <Box
                        sx={{
                          flex: 1,
                          height: 1,
                          background:
                            "linear-gradient(90deg, transparent, rgba(94,234,212,0.4), transparent)",
                        }}
                      />
                      <Typography
                        variant="caption"
                        sx={{
                          color: "rgba(245,243,255,0.7)",
                          textTransform: "uppercase",
                          letterSpacing: "0.16em",
                          fontWeight: 700,
                          fontSize: "0.68rem",
                          whiteSpace: "nowrap",
                        }}
                      >
                        Switch to another session
                      </Typography>
                      <Box
                        sx={{
                          flex: 1,
                          height: 1,
                          background:
                            "linear-gradient(90deg, transparent, rgba(94,234,212,0.4), transparent)",
                        }}
                      />
                    </Box>
                  )}
                  <Box
                    sx={{
                      p: 2.75,
                      borderRadius: 3,
                      // Same dark surface for every card; the registered
                      // one is distinguished by a green left border + glow,
                      // not a tinted background. Better contrast against
                      // the modal's translucent dark glass.
                      background: "rgba(255,255,255,0.04)",
                      border: alreadyRegistered
                        ? "1px solid rgba(94,234,212,0.55)"
                        : "1px solid rgba(255,255,255,0.12)",
                      borderLeft: alreadyRegistered
                        ? "4px solid #5eead4"
                        : "1px solid rgba(255,255,255,0.12)",
                      boxShadow: alreadyRegistered
                        ? "0 0 0 1px rgba(94,234,212,0.2), 0 8px 28px rgba(94,234,212,0.12)"
                        : "none",
                      transition: "background 0.3s, border 0.3s, box-shadow 0.3s",
                    }}
                  >
                  {s.name && (
                    <Typography
                      variant="subtitle1"
                      sx={{
                        fontWeight: 700,
                        fontFamily: "'Space Grotesk', sans-serif",
                        lineHeight: 1.3,
                        mb: 0.5,
                      }}
                    >
                      {s.name}
                    </Typography>
                  )}
                  <Stack spacing={0.5} sx={{ fontSize: "0.86rem" }}>
                    <SessionMetaRow
                      icon={<CalendarMonthIcon fontSize="small" />}
                      text={dateStr}
                    />
                    {s.timezone && (
                      <SessionMetaRow
                        icon={<AccessTimeIcon fontSize="small" />}
                        text={s.timezone}
                      />
                    )}
                    {venueText && (
                      <ClickableMetaRow
                        icon={
                          webinar ? (
                            <VideocamIcon fontSize="small" />
                          ) : (
                            <LocationOnIcon fontSize="small" />
                          )
                        }
                        text={venueText}
                        accent={webinar ? "aqua" : "magenta"}
                        actionLabel={
                          webinar
                            ? "Join webinar"
                            : mapAddress
                            ? "View on map"
                            : undefined
                        }
                        onClick={
                          venueClickable
                            ? () => {
                                if (webinar) openWebinar(s);
                                else setMapSession(s);
                              }
                            : undefined
                        }
                      />
                    )}
                    {s.instructor && (
                      <SessionMetaRow
                        icon={<PersonIcon fontSize="small" />}
                        text={s.instructor}
                      />
                    )}
                    {typeof s.capacity === "number" && (
                      <SessionMetaRow
                        icon={<GroupIcon fontSize="small" />}
                        text={`${s.registeredCount ?? 0} of ${s.capacity} registered`}
                      />
                    )}
                  </Stack>

                  <Box
                    sx={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      mt: 1.5,
                      gap: 1.5,
                      flexWrap: "wrap",
                    }}
                  >
                    {seats ? (
                      <Chip
                        label={seats.text}
                        size="small"
                        sx={{
                          fontWeight: 600,
                          color:
                            seats.color === "success"
                              ? "#5eead4"
                              : seats.color === "warning"
                              ? "#fde68a"
                              : "rgba(245,243,255,0.7)",
                          backgroundColor:
                            seats.color === "success"
                              ? "rgba(94,234,212,0.14)"
                              : seats.color === "warning"
                              ? "rgba(253,230,138,0.14)"
                              : "rgba(255,255,255,0.08)",
                          border: "1px solid currentColor",
                          letterSpacing: "0.06em",
                          textTransform: "uppercase",
                          fontSize: "0.7rem",
                        }}
                      />
                    ) : (
                      <Box />
                    )}

                    {alreadyRegistered ? (
                      <Box
                        sx={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 0.75,
                          color: "#5eead4",
                          fontWeight: 700,
                          fontSize: "0.85rem",
                        }}
                      >
                        <CheckCircleIcon fontSize="small" />
                        Registered
                      </Box>
                    ) : (
                      <Button
                        size="small"
                        variant="contained"
                        disabled={isRegistering || isFull}
                        onClick={() => handleRegister(s)}
                        sx={{
                          background:
                            "linear-gradient(135deg, #5eead4 0%, #22d3ee 50%, #a78bfa 100%)",
                          color: "#06061a",
                          fontWeight: 700,
                          textTransform: "none",
                          letterSpacing: "0.02em",
                          borderRadius: 999,
                          px: 2,
                          "&:hover": {
                            background:
                              "linear-gradient(135deg, #5eead4 0%, #22d3ee 50%, #a78bfa 100%)",
                            filter: "brightness(1.08)",
                          },
                          "&.Mui-disabled": {
                            background: "rgba(255,255,255,0.08)",
                            color: "rgba(245,243,255,0.4)",
                          },
                        }}
                      >
                        {isRegistering
                          ? isSwitch
                            ? "Switching…"
                            : "Registering…"
                          : isFull
                          ? "Full"
                          : isSwitch
                          ? "Switch to this"
                          : "Register"}
                      </Button>
                    )}
                  </Box>
                  </Box>
                </React.Fragment>
              );
            })}
            </Stack>
          );
        })()}
      </DialogContent>

      {/* Map embed sub-modal — opens for physical sessions when the
          learner taps the venue row. Webinars open directly in a new
          tab (no embed) so this is the only sub-modal mounted. */}
      <MapModal
        query={mapSession ? mapAddressFor(mapSession) : null}
        title={mapSession?.venue ?? mapSession?.name ?? "Venue"}
        caption={mapSession ? mapAddressFor(mapSession) ?? undefined : undefined}
        onClose={() => setMapSession(null)}
      />
    </Dialog>
  );
}

const SessionMetaRow: React.FC<{ icon: React.ReactNode; text: string }> = ({
  icon,
  text,
}) => (
  <Box
    sx={{
      display: "flex",
      alignItems: "center",
      gap: 1,
      color: "rgba(245,243,255,0.85)",
    }}
  >
    <Box
      sx={{
        display: "inline-flex",
        color: "rgba(245,243,255,0.55)",
        flexShrink: 0,
      }}
    >
      {icon}
    </Box>
    <span style={{ wordBreak: "break-word" }}>{text}</span>
  </Box>
);

/**
 * Like SessionMetaRow but tappable — used for the venue row so the
 * learner can pop the webinar or map sub-modal. Passing no `onClick`
 * renders inline like SessionMetaRow (no hover, no action label).
 */
const ClickableMetaRow: React.FC<{
  icon: React.ReactNode;
  text: string;
  accent?: "aqua" | "magenta";
  actionLabel?: string;
  onClick?: () => void;
}> = ({ icon, text, accent = "aqua", actionLabel, onClick }) => {
  const accentColor = accent === "magenta" ? "#f0abfc" : "#5eead4";
  if (!onClick) {
    return <SessionMetaRow icon={icon} text={text} />;
  }
  return (
    <Box
      component="button"
      type="button"
      onClick={onClick}
      sx={{
        all: "unset",
        display: "flex",
        alignItems: "center",
        gap: 1,
        cursor: "pointer",
        color: "rgba(245,243,255,0.92)",
        fontFamily: "inherit",
        fontSize: "inherit",
        padding: "2px 6px",
        marginLeft: "-6px",
        borderRadius: 8,
        transition: "background 0.2s, color 0.2s",
        "&:hover": {
          background: "rgba(255,255,255,0.06)",
          color: accentColor,
        },
        "&:focus-visible": {
          outline: `2px solid ${accentColor}`,
          outlineOffset: 2,
        },
      }}
    >
      <Box
        sx={{
          display: "inline-flex",
          color: accentColor,
          flexShrink: 0,
        }}
      >
        {icon}
      </Box>
      <span style={{ wordBreak: "break-word" }}>{text}</span>
      {actionLabel && (
        <Box
          component="span"
          sx={{
            display: "inline-flex",
            alignItems: "center",
            gap: 0.25,
            color: accentColor,
            fontSize: "0.78rem",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            ml: 0.25,
          }}
        >
          {actionLabel}
          <ArrowOutwardIcon sx={{ fontSize: "0.85rem" }} />
        </Box>
      )}
    </Box>
  );
};
