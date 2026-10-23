/**
 * app/components/holographic/holo-player.tsx
 *
 * The Absorb course player, dressed in the same holographic chrome as the
 * rest of the page.
 *
 * It talks only to resource routes that already exist in this app:
 *
 *   GET  /lesson-player/:courseId?mode=course   → { playerUrl, chapters, lessonId }
 *   GET  /lesson-player/:courseId?lessonId=:id  → { playerUrl, lessonId }
 *   GET  /curriculum/:courseId                  → { courses, groups, enrollment }
 *   POST /api/psbi/catalog  { courseId }        → enrols the learner
 *
 * The iframe watchdog is the same approach as CoursePlayerModal: Absorb's
 * portal only allows embedding from origins on the Allow List, and a blocked
 * frame fails silently rather than firing onError, so we time it out and
 * offer a new window instead.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  isDemoCourseId,
  FALLBACK_COURSE_ID,
  type CatalogCourse,
  type MatchedCourse,
  type Organ,
} from "./organ-catalog";

/** Mirrors Chapter / Lesson in app/.server/infuse-api.ts. */
type Lesson = {
  id: string;
  name?: string;
  title?: string;
  type?: string;
  enrollment?: { status?: string; progress?: number };
};
type Chapter = { id: string; name?: string; title?: string; _embedded?: { lessons?: Lesson[] } };

type PlayerPayload = {
  playerUrl?: string;
  lessonId?: string | null;
  chapters?: Chapter[];
  error?: string;
};

const IFRAME_TIMEOUT_MS = 9000;

type Props = {
  course: MatchedCourse;
  organ: Organ;
  onClose: () => void;
};

type Phase =
  | "idle"
  | "enrolling"
  | "loading"
  | "ready"
  | "curriculum"
  | "blocked"
  | "demo"
  | "ilt"
  | "error";

export default function HoloPlayer({ course, organ, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [children, setChildren] = useState<CatalogCourse[]>([]);
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [activeLessonId, setActiveLessonId] = useState<string | null>(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [status, setStatus] = useState("STANDING BY");

  // The course currently loaded into the player. For a curriculum this
  // becomes the selected child rather than the curriculum itself.
  const [playing, setPlaying] = useState<{ id: string; name: string } | null>(null);

  const watchdog = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const clearWatchdog = () => {
    if (watchdog.current) window.clearTimeout(watchdog.current);
    watchdog.current = null;
  };

  // Lets openCourse retry itself against the default course without the
  // circular reference a self-referencing useCallback would need.
  const openCourseRef = useRef<
    | ((
        t: { id: string; name: string; enrollmentStatus: string | null },
        retried?: boolean
      ) => Promise<void>)
    | null
  >(null);

  /** Enrol if needed, then mint a player URL and load the chapter tree. */
  const openCourse = useCallback(
    async (
      target: { id: string; name: string; enrollmentStatus: string | null },
      retried = false
    ) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      clearWatchdog();
      setError(null);
      setIframeLoaded(false);
      setActiveUrl(null);
      setPlaying({ id: target.id, name: target.name });

      try {
        if (!target.enrollmentStatus) {
          setPhase("enrolling");
          setStatus("REQUESTING ENROLMENT");
          const res = await fetch("/api/psbi/catalog", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ courseId: target.id }),
            signal: ac.signal,
          });
          // A failed enrolment is not fatal — the learner may already be
          // enrolled through a curriculum, in which case the player still works.
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            // eslint-disable-next-line no-console
            console.warn("[holographic] enrolment returned", res.status, body);
          }
        }

        setPhase("loading");
        setStatus("MINTING SECURE SESSION");

        const res = await fetch(`/lesson-player/${target.id}?mode=course`, {
          headers: { Accept: "application/json" },
          signal: ac.signal,
        });
        const payload = (await res.json()) as PlayerPayload;
        if (ac.signal.aborted) return;

        if (!res.ok || payload.error) {
          // One retry against the default course. A card that resolved to a
          // portal course the learner turns out not to be able to open should
          // still show a working player rather than a stack trace.
          if (target.id !== FALLBACK_COURSE_ID && !retried) {
            // eslint-disable-next-line no-console
            console.warn("[holographic] falling back from", target.id, payload.error);
            await openCourseRef.current?.(
              { id: FALLBACK_COURSE_ID, name: target.name, enrollmentStatus: null },
              true
            );
            return;
          }
          setError(payload.error || `Player request failed (HTTP ${res.status})`);
          setPhase("error");
          return;
        }

        setChapters(payload.chapters ?? []);
        setActiveLessonId(payload.lessonId ?? null);
        setActiveUrl(payload.playerUrl ?? null);
        setPhase("ready");
        setStatus("STREAMING");

        watchdog.current = window.setTimeout(() => {
          setPhase((p) => (p === "ready" ? "blocked" : p));
        }, IFRAME_TIMEOUT_MS);
      } catch (err) {
        if (ac.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    },
    []
  );

  openCourseRef.current = openCourse;

  /* Decide what kind of thing we were handed, and open it. */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      // What the card says and what the portal can actually play are two
      // different things: a sample module resolves by title to a real course
      // where the portal has one, and to the default course where it does not.
      const targetId = course.playableId || course.id;
      const targetType = course.playableType ?? course.courseType;

      if (isDemoCourseId(targetId)) {
        setPhase("demo");
        setStatus("SAMPLE MODULE");
        return;
      }

      if (targetType === "Curriculum") {
        setPhase("loading");
        setStatus("EXPANDING CURRICULUM");
        try {
          const res = await fetch(`/curriculum/${targetId}`, {
            headers: { Accept: "application/json" },
          });
          const data = (await res.json()) as { courses?: CatalogCourse[]; error?: string };
          if (cancelled) return;
          const kids = data.courses ?? [];
          setChildren(kids);
          setPhase("curriculum");
          setStatus(`${kids.length} MODULE${kids.length === 1 ? "" : "S"}`);
        } catch (err) {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
          setPhase("error");
        }
        return;
      }

      if (targetType === "InstructorLedCourse") {
        setPhase("ilt");
        setStatus("SESSION-BASED");
        return;
      }

      await openCourse({
        id: targetId,
        name: course.name,
        enrollmentStatus: course.playableEnrollment ?? course.enrollmentStatus,
      });
    })();

    return () => {
      cancelled = true;
      abortRef.current?.abort();
      clearWatchdog();
    };
  }, [course, openCourse]);

  /** Swap the iframe to a specific lesson, with a fresh single-use token. */
  const selectLesson = async (lessonId: string) => {
    if (!playing || lessonId === activeLessonId) return;
    clearWatchdog();
    setIframeLoaded(false);
    setActiveLessonId(lessonId);
    setStatus("SWITCHING LESSON");
    try {
      const res = await fetch(
        `/lesson-player/${playing.id}?lessonId=${encodeURIComponent(lessonId)}`,
        { headers: { Accept: "application/json" } }
      );
      const payload = (await res.json()) as PlayerPayload;
      if (!res.ok || payload.error) {
        setError(payload.error || `HTTP ${res.status}`);
        setPhase("error");
        return;
      }
      setActiveUrl(payload.playerUrl ?? null);
      setPhase("ready");
      setStatus("STREAMING");
      watchdog.current = window.setTimeout(() => {
        setPhase((p) => (p === "ready" ? "blocked" : p));
      }, IFRAME_TIMEOUT_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  };

  // Escape always closes, from anywhere in the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const lessons = chapters.flatMap((c) =>
    (c._embedded?.lessons ?? []).map((l) => ({ ...l, chapter: c.name ?? c.title ?? "" }))
  );

  const busy = phase === "loading" || phase === "enrolling";

  return (
    <div
      className="holo-player"
      style={{ ["--organ-accent" as string]: organ.accent }}
      role="dialog"
      aria-modal="true"
      aria-label={`${course.name} player`}
    >
      <div className="holo-player__scrim" onClick={onClose} />

      <div className="holo-player__frame">
        <span className="holo-corner holo-corner--tl" />
        <span className="holo-corner holo-corner--tr" />
        <span className="holo-corner holo-corner--bl" />
        <span className="holo-corner holo-corner--br" />

        <header className="holo-player__head">
          <div className="holo-player__title">
            <span className="holo-player__badge">{organ.symbol}</span>
            <div>
              <h2>{playing?.name ?? course.name}</h2>
              <p>
                <span className={`holo-dot ${busy ? "is-busy" : ""}`} />
                {status}
                {playing && playing.id !== course.id ? ` · ${course.name}` : ""}
              </p>
            </div>
          </div>
          <button type="button" className="holo-chip holo-chip--close" onClick={onClose}>
            CLOSE
          </button>
        </header>

        <div className="holo-player__body">
          {/* ---- left rail: lessons, curriculum children, or description ---- */}
          <aside className="holo-player__rail">
            {phase === "curriculum" && (
              <>
                <h3>Curriculum modules</h3>
                <ul className="holo-lessons">
                  {children.map((child, i) => (
                    <li key={child.id}>
                      <button
                        type="button"
                        className="holo-lesson"
                        onClick={() =>
                          openCourse({
                            id: child.id,
                            name: child.name,
                            enrollmentStatus: child.enrollmentStatus,
                          })
                        }
                      >
                        <span className="holo-lesson__n">{String(i + 1).padStart(2, "0")}</span>
                        <span className="holo-lesson__name">{child.name}</span>
                      </button>
                    </li>
                  ))}
                  {children.length === 0 && (
                    <li className="holo-empty">
                      This curriculum reports no child courses for your account.
                    </li>
                  )}
                </ul>
              </>
            )}

            {(phase === "ready" || phase === "blocked") && lessons.length > 0 && (
              <>
                <h3>Lessons</h3>
                <ul className="holo-lessons">
                  {lessons.map((lesson, i) => {
                    const done =
                      (lesson.enrollment?.status ?? "").toLowerCase().startsWith("complete");
                    return (
                      <li key={lesson.id}>
                        <button
                          type="button"
                          className={`holo-lesson ${
                            lesson.id === activeLessonId ? "is-active" : ""
                          } ${done ? "is-done" : ""}`}
                          onClick={() => selectLesson(lesson.id)}
                        >
                          <span className="holo-lesson__n">
                            {String(i + 1).padStart(2, "0")}
                          </span>
                          <span className="holo-lesson__name">
                            {lesson.name ?? lesson.title ?? "Untitled lesson"}
                          </span>
                          {done && <span className="holo-lesson__tick" aria-label="Complete" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}

            {(phase === "demo" || phase === "ilt" || lessons.length === 0) &&
              phase !== "curriculum" && (
                <>
                  <h3>Module brief</h3>
                  <p className="holo-player__desc">
                    {stripHtml(course.description) || organ.blurb}
                  </p>
                </>
              )}

            <div className="holo-player__telemetry" aria-hidden="true">
              <Telemetry label="SIGNAL" value={phase === "ready" ? 0.92 : 0.4} />
              <Telemetry label="BUFFER" value={iframeLoaded ? 1 : 0.35} />
              <Telemetry label="SYNC" value={busy ? 0.55 : 0.88} />
            </div>
          </aside>

          {/* ---- stage ---- */}
          <div className="holo-player__stage">
            {busy && (
              <div className="holo-player__state">
                <div className="holo-spinner" />
                <p>{status}</p>
              </div>
            )}

            {phase === "demo" && (
              <div className="holo-player__state holo-player__state--demo">
                <div className="holo-demo-reel" aria-hidden="true">
                  {Array.from({ length: 28 }).map((_, i) => (
                    <span key={i} style={{ animationDelay: `${i * 70}ms` }} />
                  ))}
                </div>
                <h3>{course.name}</h3>
                <p>{stripHtml(course.description)}</p>
                <p className="holo-note">
                  Sample module. Your Absorb catalog has no course matching{" "}
                  {organ.specialty.toLowerCase()} yet — publish one and it appears here
                  automatically, with the real player in this frame.
                </p>
              </div>
            )}

            {phase === "ilt" && (
              <div className="holo-player__state">
                <h3>Instructor-led course</h3>
                <p>
                  {course.name} runs as scheduled sessions rather than on-demand content,
                  so there is nothing to stream here.
                </p>
                <p className="holo-note">
                  Session selection and registration live on the catalog page.
                </p>
              </div>
            )}

            {phase === "curriculum" && (
              <div className="holo-player__state">
                <h3>Select a module</h3>
                <p>
                  {course.name} is a curriculum. Choose a module from the left to open it in
                  the player.
                </p>
              </div>
            )}

            {phase === "error" && (
              <div className="holo-player__state holo-player__state--error">
                <h3>Playback unavailable</h3>
                <p className="holo-error">{error}</p>
                <p className="holo-note">
                  The player mints a single-use token per lesson; a stale or already-consumed
                  token produces this. Reopening the module usually clears it.
                </p>
              </div>
            )}

            {phase === "blocked" && activeUrl && (
              <div className="holo-player__state">
                <h3>Embedding blocked</h3>
                <p>
                  The Absorb portal is refusing to render inside this frame. Add this origin
                  to Portal Settings → Info → Absorb Allow List, or open the lesson directly.
                </p>
                <a
                  className="holo-chip holo-chip--go"
                  href={activeUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  OPEN IN NEW WINDOW
                </a>
              </div>
            )}

            {phase === "ready" && activeUrl && (
              <div className="holo-player__screen">
                {!iframeLoaded && (
                  <div className="holo-player__state holo-player__state--overlay">
                    <div className="holo-spinner" />
                  </div>
                )}
                <iframe
                  key={activeUrl}
                  src={activeUrl}
                  title={playing?.name ?? course.name}
                  allow="fullscreen; autoplay; encrypted-media"
                  allowFullScreen
                  onLoad={() => {
                    setIframeLoaded(true);
                    clearWatchdog();
                  }}
                />
                <span className="holo-player__scan" aria-hidden="true" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A labelled bar. Decorative — it reads as instrumentation, not data. */
function Telemetry({ label, value }: { label: string; value: number }) {
  return (
    <div className="holo-telemetry">
      <span>{label}</span>
      <i>
        <b style={{ width: `${Math.round(value * 100)}%` }} />
      </i>
    </div>
  );
}

/**
 * Absorb course descriptions arrive as HTML. We only ever render them as
 * text, so strip tags rather than dangerouslySetInnerHTML — the content is
 * tenant-authored and this page has no reason to trust it.
 */
function stripHtml(input: string): string {
  if (!input) return "";
  return input
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
