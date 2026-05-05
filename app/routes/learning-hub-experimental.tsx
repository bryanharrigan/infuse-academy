/**
 * app/routes/learning-hub-experimental.tsx
 *
 * The "Experimental" Learning Hub — a complete visual departure from the
 * RadNet / Infuse Academy templates. Liquid glassmorphism aesthetic with:
 *
 *   - Animated aurora background + ambient particle field
 *   - Swirling text whirlpool that orbits the learner's initial; clicking
 *     the core scrolls the page into reveal mode (cards fade in with a
 *     stagger and the page emits a confetti burst)
 *   - Iridescent gradient typography
 *   - Holographic gamification HUD: tier (Bronze→Diamond) + XP/level (1–50)
 *     + streak + earned/locked achievement medals — all driven by REAL
 *     completion data from /online-courses/:id/chapters
 *   - Embedded course/lesson player (re-uses the existing modals)
 *   - News articles + Resources rail
 *
 * Data sources (Infuse / Absorb V2 REST API — all live, no mocks):
 *   GET /my-courses                          (legacy v2 base)
 *   GET /my-catalog                          (legacy v2 base)
 *   GET /resources                           (legacy v2 base — optional)
 *   GET /my-news-articles                    (Infuse API)
 *   GET /online-courses/:id/chapters x N     (Infuse API; for lesson tracking)
 *
 * The chapters call is the expensive bit — we cap it at 8 in-progress courses
 * to keep the loader well under a second. Anything beyond that contributes
 * via a status-based fallback in computeGamification().
 *
 * The page automatically becomes the default landing page for users on the
 * Experimental theme: app/routes/_index.tsx redirects there on hydration.
 */

import { useEffect, useMemo, useRef, useState } from "react";
// (useRef is used for both the level-up tracking refs below and the
// theme-bootstrap ref above.)
import { json, LoaderFunctionArgs } from "@remix-run/node";
import {
  useLoaderData,
  useRouteLoaderData,
  Link,
  useNavigate,
  useRevalidator,
} from "@remix-run/react";
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  Check as CheckIcon,
} from "@mui/icons-material";
import {
  PlayArrow,
  OpenInNew,
  Close as CloseIcon,
  Logout as LogoutIcon,
  AutoAwesome as AutoAwesomeIcon,
} from "@mui/icons-material";

import {
  getMyCatalog,
  getMyCourses,
  getNewsArticles,
  getResources,
  getChaptersForCourse,
  InfusePortalUrl,
  type NewsArticle,
  type Resource,
  type Chapter,
} from "~/.server/infuse-api";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";
import { Course } from "~/.server/course.resource";
import { LessonPlayerModal } from "~/components/modal/lesson-player-modal";
import { CoursePlayerModal } from "~/components/modal/course-player-modal";
import { SessionsModal } from "~/components/modal/sessions-modal";
import { CurriculumModal } from "~/components/modal/curriculum-modal";
import OnlineCourseSVG from "~/assets/online-course.svg";
import { useAppStateContext } from "~/context/app-state.context";
import {
  computeGamification,
  type Gamification,
  type RankTier,
} from "~/.server/gamification";

type RootData = {
  userProfile: { firstName: string; lastName: string };
  avatarUrl: string;
};

/* ─── Loader ────────────────────────────────────────────────────────────── */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const cookieHeader = request.headers.get("Cookie");
  const token = await infuseJwtCookie.parse(cookieHeader);
  if (!token) throw new Response("Not authenticated", { status: 401 });

  // Top-level fetches (parallel). News + resources are optional — some
  // tenants don't have those modules, so failures fall back to empty arrays
  // rather than failing the whole page.
  const [myCoursesRes, catalogRes, news, resources] = await Promise.all([
    getMyCourses(token, { limit: 30, showCompleted: true }),
    getMyCatalog(token, { limit: 12, showCompleted: true }),
    getNewsArticles(token, { limit: 12 }).catch((err) => {
      console.warn(
        "[learning-hub-experimental] news fetch failed:",
        err?.message ?? err
      );
      return [] as NewsArticle[];
    }),
    getResources(token, { limit: 12 }).catch((err) => {
      console.warn(
        "[learning-hub-experimental] resources fetch failed:",
        err?.message ?? err
      );
      return [] as Resource[];
    }),
  ]);

  const myCourses = myCoursesRes._embedded.courses;
  const catalog = catalogRes._embedded.courses;

  // Lesson-level tracking: fetch chapters for up to 8 in-progress courses
  // so the gamification numbers reflect real lesson completions. Capped to
  // bound loader latency.
  const trackable = myCourses
    .filter(
      (c) =>
        c.enrollmentStatus === "InProgress" ||
        c.enrollmentStatus === "Complete" ||
        c.enrollmentStatus === "Completed"
    )
    .slice(0, 8);
  const chapterEntries = await Promise.all(
    trackable.map(async (c) => {
      try {
        const chapters = await getChaptersForCourse(token, c.id);
        return [c.id, chapters] as [string, Chapter[]];
      } catch (err) {
        console.warn(
          `[learning-hub-experimental] chapters for ${c.id} failed:`,
          err instanceof Error ? err.message : err
        );
        return [c.id, [] as Chapter[]] as [string, Chapter[]];
      }
    })
  );
  const chaptersByCourse = new Map<string, Chapter[]>(chapterEntries);

  const gamification = computeGamification({ myCourses, chaptersByCourse });

  return json({
    myCourses,
    catalog,
    news,
    resources,
    gamification,
    // Base URL of the Absorb learner portal — used by the client to build
    // deep links for InstructorLedCourse / Curriculum cards (the embedded
    // lesson player only handles OnlineCourse).
    portalBaseUrl: InfusePortalUrl.replace(/\/$/, ""),
  });
};

/* ─── Utilities ─────────────────────────────────────────────────────────── */

function greetingForHour(h: number): string {
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function formatDate(now: Date): string {
  return now.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function estimateProgressPct(status: string | null): number {
  if (!status) return 0;
  if (status === "Complete" || status === "Completed") return 100;
  if (status === "InProgress") return 50;
  return 0;
}

function isComplete(status: string | null): boolean {
  return status === "Complete" || status === "Completed";
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

function rankSubLabel(rank: RankTier): string {
  const map: Record<RankTier, string> = {
    bronze: "Tier I",
    silver: "Tier II",
    gold: "Tier III",
    platinum: "Tier IV",
    diamond: "Apex",
  };
  return map[rank];
}

function resourceIcon(type: string | undefined): string {
  const t = (type ?? "").toLowerCase();
  if (t.includes("video")) return "▶";
  if (t.includes("audio")) return "♪";
  if (t.includes("link")) return "↗";
  if (t.includes("image")) return "◐";
  return "📄";
}

/* ─── Whirlpool component ──────────────────────────────────────────────── */

const WHIRLPOOL_PHRASES = [
  // 4 rings × ~3 phrases each — repeat as needed for full circle.
  ["LEARN", "DISCOVER", "GROW", "EXPLORE", "MASTER", "BUILD"],
  ["COMPLETE", "STREAK", "EARN", "LEVEL UP", "UNLOCK", "ASCEND"],
  ["KNOWLEDGE", "JOURNEY", "PROGRESS", "INSIGHT", "INFUSE"],
  ["READY", "GO", "NEXT", "RESUME", "DIVE IN"],
];

const Whirlpool: React.FC<{
  initial: string;
  onCoreClick: () => void;
}> = ({ initial, onCoreClick }) => {
  // Each ring is its own SVG with a circular path that text rides along.
  // Different radii + reversed alternating direction make the illusion of
  // a vortex pulling toward the centre.
  const rings = [
    { r: 210, words: WHIRLPOOL_PHRASES[0], color: "exp-whirlpool__text" },
    {
      r: 178,
      words: WHIRLPOOL_PHRASES[1],
      color: "exp-whirlpool__text exp-whirlpool__text--aqua",
    },
    {
      r: 146,
      words: WHIRLPOOL_PHRASES[2],
      color: "exp-whirlpool__text exp-whirlpool__text--magenta",
    },
    {
      r: 114,
      words: WHIRLPOOL_PHRASES[3],
      color: "exp-whirlpool__text exp-whirlpool__text--lemon",
    },
  ];

  return (
    <div className="exp-whirlpool" aria-hidden>
      {rings.map((ring, i) => {
        // Full circle path — we use one <textPath> per WORD positioned
        // via startOffset. Because each word is a self-contained text
        // node, SVG can't truncate or smash mid-word at the seam.
        //
        // Offset math: with N words evenly spaced, each occupies a
        // 100/N% "slot" of the path. We center the word in its slot
        // (offset = (j + 0.5) / N) so that:
        //   - No word's center sits AT 0% / the seam (which would
        //     clip half the word with textAnchor="middle")
        //   - Adjacent words can't overlap (their centers are a full
        //     slot-width apart, more than any single word renders)
        //
        // Dots sit at slot BORDERS (offset = (j+1) / N) and we skip
        // the dot at 100% (= 0% = seam) — the natural arc gap there
        // serves as the visual divider between the last and first word.
        const pathD = `M 0 ${-ring.r} A ${ring.r} ${ring.r} 0 1 1 -0.01 ${-ring.r}`;
        const fontSize = i === 0 ? 22 : i === 1 ? 19 : i === 2 ? 17 : 15;
        const slots = ring.words.length;
        return (
          <div
            key={i}
            className={`exp-whirlpool__ring exp-whirlpool__ring--${i + 1}`}
          >
            <svg
              className="exp-whirlpool__svg"
              viewBox="-230 -230 460 460"
              xmlns="http://www.w3.org/2000/svg"
            >
              <defs>
                <path
                  id={`exp-whirlpool-path-${i}`}
                  d={pathD}
                  fill="none"
                />
              </defs>
              {ring.words.map((word, j) => {
                const wordOffset = ((j + 0.5) / slots) * 100;
                return (
                  <text
                    key={`${word}-${j}`}
                    className={ring.color}
                    fontSize={fontSize}
                  >
                    <textPath
                      href={`#exp-whirlpool-path-${i}`}
                      startOffset={`${wordOffset}%`}
                      textAnchor="middle"
                    >
                      {word}
                    </textPath>
                  </text>
                );
              })}
              {ring.words.slice(0, -1).map((_, j) => {
                const dotOffset = ((j + 1) / slots) * 100;
                return (
                  <text
                    key={`dot-${j}`}
                    className={ring.color}
                    fontSize={fontSize}
                  >
                    <textPath
                      href={`#exp-whirlpool-path-${i}`}
                      startOffset={`${dotOffset}%`}
                      textAnchor="middle"
                    >
                      •
                    </textPath>
                  </text>
                );
              })}
            </svg>
          </div>
        );
      })}
      <button
        type="button"
        className="exp-whirlpool__core"
        onClick={onCoreClick}
        aria-label="Reveal learning journey"
      >
        {initial}
      </button>
    </div>
  );
};

/* ─── Confetti ──────────────────────────────────────────────────────────── */

const CONFETTI_COLORS = [
  "#5eead4",
  "#22d3ee",
  "#a78bfa",
  "#f0abfc",
  "#ec4899",
  "#fde68a",
  "#fb923c",
];

type ConfettiBurst = { id: number; pieces: ConfettiPiece[] };
type ConfettiPiece = { tx: number; ty: number; rot: number; color: string };

function makeConfettiBurst(): ConfettiPiece[] {
  const pieces: ConfettiPiece[] = [];
  const count = 80;
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.4;
    const distance = 220 + Math.random() * 280;
    pieces.push({
      tx: Math.cos(angle) * distance,
      ty: Math.sin(angle) * distance,
      rot: 360 + Math.random() * 720 * (Math.random() < 0.5 ? -1 : 1),
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    });
  }
  return pieces;
}

const ConfettiLayer: React.FC<{ bursts: ConfettiBurst[] }> = ({ bursts }) => {
  if (bursts.length === 0) return null;
  return (
    <div className="exp-confetti-root" aria-hidden>
      {bursts.flatMap((burst) =>
        burst.pieces.map((p, i) => (
          <span
            key={`${burst.id}-${i}`}
            className="exp-confetti-piece"
            style={
              {
                background: p.color,
                "--exp-tx": `${p.tx}px`,
                "--exp-ty": `${p.ty}px`,
                "--exp-rot": `${p.rot}deg`,
                animationDelay: `${(i % 8) * 0.02}s`,
              } as React.CSSProperties
            }
          />
        ))
      )}
    </div>
  );
};

/* ─── Page ──────────────────────────────────────────────────────────────── */

export default function LearningHubExperimental() {
  const { myCourses, catalog, news, resources, gamification, portalBaseUrl } =
    useLoaderData<typeof loader>();

  /** Course currently driving the SessionsModal (null = closed). */
  const [sessionsCourse, setSessionsCourse] = useState<Course | null>(null);
  /** Curriculum currently driving the CurriculumModal (null = closed). */
  const [curriculumCourse, setCurriculumCourse] = useState<Course | null>(null);
  /**
   * When set, closing the lesson player / sessions modal / nested
   * curriculum returns the learner to THIS curriculum modal rather than
   * dropping back to the hub. Captured at the moment a child course is
   * picked from inside a curriculum so we can hop back where we came from.
   */
  const [returnToCurriculum, setReturnToCurriculum] = useState<Course | null>(
    null
  );

  /**
   * Wraps the lesson-player launch with a courseType branch:
   *   OnlineCourse        → embedded course player modal
   *   InstructorLedCourse → native SessionsModal listing scheduled sessions
   *   Curriculum          → native CurriculumModal listing child courses;
   *                         picking a child re-enters playOrOpen for that
   *                         child (so an OnlineCourse child plays in the
   *                         lesson player, an ILT child opens its own
   *                         SessionsModal, etc.)
   */
  const playOrOpen = (course: Course) => {
    if (course.courseType === "OnlineCourse") {
      setPlaying({ course, mode: "course" });
    } else if (course.courseType === "InstructorLedCourse") {
      setSessionsCourse(course);
    } else if (course.courseType === "Curriculum") {
      setCurriculumCourse(course);
    } else {
      // Unknown courseType — log so we can extend the branch later, then
      // fall back to the lesson player so the click does *something*.
      console.warn(
        "[learning-hub-experimental] unknown courseType",
        course.courseType,
        "for course",
        course.id
      );
      setPlaying({ course, mode: "course" });
    }
  };
  const rootData = useRouteLoaderData("root") as RootData | null;
  const { themeVariant, setThemeVariant } = useAppStateContext();
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  /**
   * Enrollment in flight — track the courseId currently being enrolled so
   * the corresponding card can show a spinner / disabled state. Set to null
   * when no enrollment is active.
   */
  const [enrollingId, setEnrollingId] = useState<string | null>(null);

  const handleEnroll = async (courseId: string) => {
    if (enrollingId) return; // already enrolling something else

    // ILT enrollment requires picking a specific session — open the
    // SessionsModal instead of a blind enroll. The modal POSTs the
    // session-specific enrollment when the learner clicks Register on
    // a session card.
    const course =
      myCourses.find((c) => c.id === courseId) ??
      catalog.find((c) => c.id === courseId);
    if (course?.courseType === "InstructorLedCourse") {
      setSessionsCourse(course);
      return;
    }

    setEnrollingId(courseId);
    try {
      const res = await fetch(`/enroll/${courseId}`, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const payload = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error ?? `HTTP ${res.status}`);
      }
      // Celebrate + refetch the loader so the course appears in My Courses
      // and the gamification numbers tick up.
      fireConfetti();
      revalidator.revalidate();
    } catch (err) {
      console.error("[learning-hub-experimental] enroll failed:", err);
      // Fall back to navigating to the catalog page so the learner can
      // enroll there manually.
      navigate("/catalog");
    } finally {
      setEnrollingId(null);
    }
  };

  /**
   * On first mount, force the theme to "experimental" if the user
   * landed here via direct URL — the page assumes the theme-
   * experimental body class is applied. We DON'T want this effect to
   * fight the picker below: if the learner deliberately chooses a
   * different theme, we navigate them away (see handleSwitchTheme)
   * so the auto-revert doesn't fire on subsequent renders.
   */
  const themeBootstrapped = useRef(false);
  useEffect(() => {
    if (themeBootstrapped.current) return;
    themeBootstrapped.current = true;
    if (themeVariant !== "experimental") {
      setThemeVariant("experimental");
    }
  }, [themeVariant, setThemeVariant]);

  /**
   * Theme picker — opens a Menu so the learner can hop between themes.
   * Picking anything other than Experimental navigates them away from
   * /learning-hub-experimental (the IA/RadNet/Default themes have
   * their own surfaces) so the chosen theme actually takes effect.
   */
  const [themeAnchor, setThemeAnchor] = useState<HTMLElement | null>(null);
  const handleSwitchTheme = (variant: typeof themeVariant) => {
    setThemeAnchor(null);
    setThemeVariant(variant);
    if (variant !== "experimental") {
      // The IA / RadNet / Default themes share /learning-hub (the
      // legacy hub) — go there so the switch is immediately visible.
      navigate("/learning-hub");
    }
  };

  const [playing, setPlaying] = useState<
    { course: Course; mode: "lesson" | "course" } | null
  >(null);
  const [openArticle, setOpenArticle] = useState<NewsArticle | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [confetti, setConfetti] = useState<ConfettiBurst[]>([]);
  const [levelUpBanner, setLevelUpBanner] = useState<string | null>(null);

  // Track the last-seen completion count + level so we can fire celebrations
  // when they advance during the session (e.g. learner finishes a lesson in
  // the embedded player and we re-validate from a navigate-revalidate).
  const prevLevel = useRef(gamification.level);
  const prevCompleted = useRef(gamification.counts.coursesCompleted);

  /* Confetti helpers */
  const fireConfetti = () => {
    setConfetti((cur) => [
      ...cur,
      { id: Date.now() + Math.random(), pieces: makeConfettiBurst() },
    ]);
    // Cleanup after the animation completes (1.5s + small buffer).
    window.setTimeout(() => {
      setConfetti((cur) => cur.slice(1));
    }, 1900);
  };

  const fireLevelUp = (label: string) => {
    setLevelUpBanner(label);
    fireConfetti();
    window.setTimeout(() => setLevelUpBanner(null), 2400);
  };

  // Reveal the page on first paint with a short delay, plus emit a small
  // celebration if the learner has any completed courses to acknowledge.
  useEffect(() => {
    const t = window.setTimeout(() => setRevealed(true), 350);
    return () => window.clearTimeout(t);
  }, []);

  // Detect level-ups / new course completions across re-renders.
  useEffect(() => {
    if (gamification.level > prevLevel.current) {
      fireLevelUp(`Level ${gamification.level}`);
    } else if (
      gamification.counts.coursesCompleted > prevCompleted.current
    ) {
      fireConfetti();
    }
    prevLevel.current = gamification.level;
    prevCompleted.current = gamification.counts.coursesCompleted;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gamification.level, gamification.counts.coursesCompleted]);

  /* Derived data */
  const featured = useMemo(
    () => myCourses.find((c) => c.enrollmentStatus === "InProgress") ?? null,
    [myCourses]
  );
  const inProgressCourses = useMemo(
    () => myCourses.filter((c) => c.enrollmentStatus === "InProgress"),
    [myCourses]
  );
  const completedCourses = useMemo(
    () => myCourses.filter((c) => isComplete(c.enrollmentStatus)),
    [myCourses]
  );

  /**
   * Time-dependent rendering must wait for hydration: the server runs in
   * UTC (so getHours() gives e.g. 18 → "Good evening") while the browser
   * is in the user's local timezone (12 → "Good afternoon"). Rendering
   * either at SSR causes a React #418/#425 hydration mismatch that
   * disrupts event handlers in the surrounding subtree (clicks on
   * Resume / Enroll silently no-op until manual reload).
   *
   * Initialise to null and populate on hydration so SSR and first paint
   * match exactly. The eyebrow line just renders nothing until the
   * effect fires a tick later.
   */
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
  }, []);

  const firstName = rootData?.userProfile?.firstName ?? "Learner";
  const lastName = rootData?.userProfile?.lastName ?? "";
  const initial = firstName.charAt(0).toUpperCase() || "?";

  /* Course card */
  const renderCard = (course: Course, inCatalog: boolean) => {
    const pct = estimateProgressPct(course.enrollmentStatus);
    const statusClass = isComplete(course.enrollmentStatus)
      ? "exp-card__status--done"
      : course.enrollmentStatus === "InProgress"
      ? "exp-card__status--progress"
      : "exp-card__status--new";
    const statusLabel = isComplete(course.enrollmentStatus)
      ? "Completed"
      : course.enrollmentStatus === "InProgress"
      ? "In Progress"
      : inCatalog && !course.enrollmentStatus
      ? "Available"
      : "Not Started";
    const isEnrolled = Boolean(course.enrollmentStatus);
    const isEnrollingThis = enrollingId === course.id;
    const canPlay = isEnrolled;

    return (
      <article
        key={course.id}
        className="exp-card"
        onClick={() => {
          if (!isEnrolled) {
            // Click anywhere on a non-enrolled card kicks off enrollment.
            handleEnroll(course.id);
          } else {
            playOrOpen(course);
          }
        }}
      >
        <div
          className="exp-card__img"
          style={
            course.imageUrl
              ? { backgroundImage: `url(${course.imageUrl})` }
              : undefined
          }
        >
          {!course.imageUrl && (
            <div className="exp-card__img-empty">
              <img src={OnlineCourseSVG} alt="" />
            </div>
          )}
        </div>
        <div className="exp-card__body">
          <span className={`exp-card__status ${statusClass}`}>
            {statusLabel}
          </span>
          <h3 className="exp-card__title">{course.name}</h3>
          {course.description && (
            <p className="exp-card__desc">
              {stripHtmlToText(course.description)}
            </p>
          )}
          {!inCatalog && (
            <>
              <div className="exp-card__progress">
                <div
                  className="exp-card__progress-fill"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="exp-card__footer">
                <span className="exp-card__pct">{pct}%</span>
                <button
                  type="button"
                  className="exp-card__cta"
                  disabled={isEnrollingThis}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isEnrolled) {
                      handleEnroll(course.id);
                    } else {
                      playOrOpen(course);
                    }
                  }}
                >
                  {isEnrollingThis
                    ? "Enrolling…"
                    : !isEnrolled
                    ? "Enroll"
                    : isComplete(course.enrollmentStatus)
                    ? "Review"
                    : course.enrollmentStatus === "InProgress"
                    ? "Resume"
                    : "Start"}
                </button>
              </div>
            </>
          )}
          {inCatalog && (
            <div className="exp-card__footer">
              <span className="exp-card__pct">
                {isEnrolled ? "Enrolled" : "Catalog"}
              </span>
              <button
                type="button"
                className="exp-card__cta"
                disabled={isEnrollingThis}
                onClick={(e) => {
                  e.stopPropagation();
                  if (isEnrolled) {
                    playOrOpen(course);
                  } else {
                    handleEnroll(course.id);
                  }
                }}
              >
                {isEnrollingThis
                  ? "Enrolling…"
                  : isEnrolled
                  ? isComplete(course.enrollmentStatus)
                    ? "Review"
                    : course.enrollmentStatus === "InProgress"
                    ? "Resume"
                    : "Start"
                  : "Enroll"}
              </button>
            </div>
          )}
        </div>
      </article>
    );
  };

  /* ─── Render ──────────────────────────────────────────────────────────── */

  return (
    <Box
      data-rank={gamification.rank}
      sx={{
        opacity: revealed ? 1 : 0,
        transition: "opacity 800ms cubic-bezier(0.22, 1, 0.36, 1)",
      }}
    >
      {/* Confetti overlay (always mounted; renders nothing when empty) */}
      <ConfettiLayer bursts={confetti} />

      {/* Level-up banner */}
      {levelUpBanner && (
        <div className="exp-levelup">
          <div className="exp-levelup__inner">
            <p className="exp-levelup__title">⚡ Level Up</p>
            <h2 className="exp-levelup__big exp-text-iridescent">
              {levelUpBanner}
            </h2>
          </div>
        </div>
      )}

      {/* Top bar — minimal in-page nav (the global IA-style header is hidden
          via CSS while theme-experimental is active). Keeps the theme
          switcher accessible without polluting the visual.

          Responsive: on screens ≤640px the action buttons collapse to icon
          buttons and the wordmark hides so the brand mark + iridescent
          glyph stay visible without overflowing. */}
      <header
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 100,
          padding: "16px clamp(14px, 4vw, 28px)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          background:
            "linear-gradient(180deg, rgba(6,6,26,0.7) 0%, rgba(6,6,26,0) 100%)",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
        }}
      >
        <Link
          to="/learning-hub-experimental"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            textDecoration: "none",
            minWidth: 0,
          }}
        >
          <span
            style={{
              width: 36,
              height: 36,
              flexShrink: 0,
              borderRadius: 12,
              background:
                "linear-gradient(135deg, #5eead4 0%, #a78bfa 50%, #f0abfc 100%)",
              display: "grid",
              placeItems: "center",
              color: "#06061a",
              fontWeight: 800,
              fontSize: "1.1rem",
              fontFamily: "'Space Grotesk', sans-serif",
              boxShadow: "0 6px 20px rgba(94,234,212,0.4)",
            }}
          >
            iX
          </span>
          <span
            className="exp-text-iridescent exp-topbar-wordmark"
            style={{
              fontWeight: 700,
              fontSize: "1.05rem",
              letterSpacing: "-0.01em",
              whiteSpace: "nowrap",
            }}
          >
            Infuse · Experimental
          </span>
        </Link>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: { xs: 0.5, sm: 1.5 },
            flexShrink: 0,
          }}
        >
          {/* Switch theme — full button on ≥sm, icon-only on phone */}
          <Tooltip title="Switch theme">
            <Button
              size="small"
              variant="outlined"
              onClick={(e) => setThemeAnchor(e.currentTarget)}
              startIcon={<AutoAwesomeIcon fontSize="small" />}
              sx={{
                fontSize: "0.78rem",
                display: { xs: "none", sm: "inline-flex" },
              }}
              aria-haspopup="true"
              aria-expanded={themeAnchor !== null}
            >
              Switch theme
            </Button>
          </Tooltip>
          <Tooltip title="Switch theme">
            <IconButton
              size="small"
              onClick={(e) => setThemeAnchor(e.currentTarget)}
              aria-label="Switch theme"
              aria-haspopup="true"
              aria-expanded={themeAnchor !== null}
              sx={{
                color: "var(--exp-text-muted)",
                display: { xs: "inline-flex", sm: "none" },
              }}
            >
              <AutoAwesomeIcon fontSize="small" />
            </IconButton>
          </Tooltip>

          {/* Theme picker menu — anchored to either button above. */}
          <Menu
            anchorEl={themeAnchor}
            open={themeAnchor !== null}
            onClose={() => setThemeAnchor(null)}
            anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
            transformOrigin={{ vertical: "top", horizontal: "right" }}
            slotProps={{
              paper: {
                sx: {
                  mt: 0.5,
                  minWidth: 220,
                  background: "rgba(20, 20, 36, 0.95)",
                  backdropFilter: "blur(20px) saturate(160%)",
                  WebkitBackdropFilter: "blur(20px) saturate(160%)",
                  border: "1px solid rgba(255,255,255,0.18)",
                  color: "#f5f3ff",
                  borderRadius: 3,
                },
              },
            }}
          >
            {[
              { v: "experimental" as const, label: "Experimental" },
              { v: "infuse-academy" as const, label: "Infuse Academy" },
              { v: "radnet" as const, label: "RadNet" },
              { v: "default" as const, label: "Default" },
            ].map(({ v, label }) => (
              <MenuItem
                key={v}
                onClick={() => handleSwitchTheme(v)}
                selected={themeVariant === v}
                sx={{
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontSize: "0.9rem",
                  "&.Mui-selected": {
                    background: "rgba(94,234,212,0.12)",
                  },
                  "&:hover": {
                    background: "rgba(255,255,255,0.06)",
                  },
                }}
              >
                <ListItemIcon
                  sx={{
                    minWidth: 28,
                    color: themeVariant === v ? "#5eead4" : "transparent",
                  }}
                >
                  <CheckIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary={label} />
              </MenuItem>
            ))}
          </Menu>

          {/* My Courses + Catalog — labelled on ≥sm, hidden on phone (the
              hub already surfaces both as in-page nav). */}
          <Button
            component={Link}
            to="/my-courses"
            size="small"
            variant="outlined"
            sx={{
              fontSize: "0.78rem",
              display: { xs: "none", sm: "inline-flex" },
            }}
          >
            My Courses
          </Button>
          <Button
            component={Link}
            to="/catalog"
            size="small"
            variant="outlined"
            sx={{
              fontSize: "0.78rem",
              display: { xs: "none", sm: "inline-flex" },
            }}
          >
            Catalog
          </Button>

          <IconButton
            onClick={() => navigate("/signout")}
            size="small"
            sx={{ color: "var(--exp-text-muted)" }}
            aria-label="Sign out"
          >
            <LogoutIcon fontSize="small" />
          </IconButton>
        </Box>
      </header>

      {/* HERO ─────────────────────────────────────────────────────────── */}
      <section className="exp-hero">
        <div className="exp-container">
          {/* Empty span on SSR; populated post-hydration so server and
              client agree on initial markup. See `now` state above. */}
          <span className="exp-hero__eyebrow" suppressHydrationWarning>
            {now
              ? `${greetingForHour(now.getHours())} · ${formatDate(now)}`
              : " "}
          </span>

          <Whirlpool
            initial={initial}
            onCoreClick={() => {
              fireConfetti();
              window.scrollTo({
                top: window.innerHeight * 0.6,
                behavior: "smooth",
              });
            }}
          />

          <h1 className="exp-hero__title">
            <span className="exp-text-iridescent">{firstName}</span>
            {lastName ? `, your journey` : `'s journey`}
            <br />
            keeps unfolding.
          </h1>
          <p className="exp-hero__subtitle">
            A living portal of your learning — every lesson, every milestone,
            every spark of curiosity. Tap the core to dive in, or scroll to
            explore the path you&apos;re writing for yourself.
          </p>
        </div>
      </section>

      {/* GAMIFICATION HUD ─────────────────────────────────────────────── */}
      <div className="exp-container">
        <div className="exp-hud">
          {/* XP / Level / Tier */}
          <div className="exp-glass exp-xp-card">
            <div className="exp-xp-card__top">
              <div className="exp-xp-card__rank-badge">
                <span>{rankBadgeChar(gamification.rank)}</span>
              </div>
              <div className="exp-xp-card__rank-meta">
                <h3 className="exp-xp-card__rank-name">
                  {gamification.rankLabel}
                </h3>
                <span className="exp-xp-card__rank-sub">
                  {rankSubLabel(gamification.rank)} · Level {gamification.level}
                </span>
              </div>
            </div>
            <div className="exp-xp-bar" aria-hidden>
              <div
                className="exp-xp-bar__fill"
                style={{
                  width: `${Math.round(gamification.levelProgress * 100)}%`,
                }}
              />
            </div>
            <div className="exp-xp-card__row">
              <span>
                <span className="exp-xp-card__level">
                  {gamification.totalXp.toLocaleString()}
                </span>{" "}
                XP total
              </span>
              <span>
                {gamification.isMaxLevel
                  ? "MAX"
                  : `${gamification.xpInLevel} / ${gamification.xpForNextLevel} to L${gamification.level + 1}`}
              </span>
            </div>
          </div>

          {/* Streak */}
          <div className="exp-glass exp-streak-card">
            <div className="exp-streak-card__flame" aria-hidden>
              🔥
            </div>
            <h3 className="exp-streak-card__num">{gamification.streakDays}</h3>
            <span className="exp-streak-card__label">
              {gamification.streakDays === 1 ? "Day Streak" : "Day Streak"}
            </span>
            <Typography
              variant="caption"
              sx={{ color: "var(--exp-text-dim)", fontSize: "0.72rem" }}
            >
              {gamification.streakDays === 0
                ? "Complete a lesson today to ignite it"
                : "Keep the flame alive — return tomorrow"}
            </Typography>
          </div>

          {/* Achievements */}
          <div className="exp-glass exp-ach-card">
            <h3 className="exp-ach-card__title">Achievements</h3>
            <div className="exp-ach-grid">
              {gamification.achievements.slice(0, 12).map((a) => (
                <Tooltip
                  key={a.id}
                  title={
                    <span>
                      <strong>{a.title}</strong>
                      <br />
                      {a.description}
                    </span>
                  }
                >
                  <span
                    className={`exp-ach-medal ${
                      a.earned
                        ? "exp-ach-medal--earned"
                        : "exp-ach-medal--locked"
                    }`}
                  >
                    {a.emoji}
                  </span>
                </Tooltip>
              ))}
            </div>
            <Typography
              variant="caption"
              sx={{
                color: "var(--exp-text-dim)",
                fontSize: "0.72rem",
                textAlign: "center",
                mt: 0.5,
              }}
            >
              {gamification.achievements.filter((a) => a.earned).length} /{" "}
              {gamification.achievements.length} unlocked
            </Typography>
          </div>
        </div>
      </div>

      {/* CONTINUE LEARNING ───────────────────────────────────────────── */}
      {featured && (
        <div className="exp-container">
          <div className="exp-section">
            <div className="exp-section__head">
              <div>
                <h2 className="exp-section__title">Continue Learning</h2>
                <p className="exp-section__sub">
                  Pick up exactly where you left off
                </p>
              </div>
            </div>
            <div className="exp-featured">
              <div
                className="exp-featured__media"
                style={
                  featured.imageUrl
                    ? { backgroundImage: `url(${featured.imageUrl})` }
                    : undefined
                }
              />
              <div className="exp-featured__body">
                <span className="exp-card__status exp-card__status--progress">
                  In Progress
                </span>
                <h3 className="exp-featured__title">{featured.name}</h3>
                {featured.description && (
                  <p className="exp-featured__desc">
                    {stripHtmlToText(featured.description).slice(0, 220)}
                    {stripHtmlToText(featured.description).length > 220
                      ? "…"
                      : ""}
                  </p>
                )}
                <button
                  type="button"
                  className="exp-featured__cta"
                  onClick={() => playOrOpen(featured)}
                >
                  <PlayArrow fontSize="small" />
                  Resume now
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MY COURSES ───────────────────────────────────────────────────── */}
      <div className="exp-container">
        <div className="exp-section">
          <div className="exp-section__head">
            <div>
              <h2 className="exp-section__title">Your Learning Path</h2>
              <p className="exp-section__sub">
                {gamification.counts.lessonsCompleted} lessons completed across{" "}
                {gamification.counts.enrolled} courses
              </p>
            </div>
          </div>
          {myCourses.length > 0 ? (
            <div className="exp-grid">
              {myCourses
                .slice()
                .sort((a, b) => {
                  // In progress first, then not started, then completed.
                  const order = (s: string | null) =>
                    s === "InProgress" ? 0 : isComplete(s) ? 2 : 1;
                  return (
                    order(a.enrollmentStatus) - order(b.enrollmentStatus)
                  );
                })
                .map((c) => renderCard(c, false))}
            </div>
          ) : (
            <Typography sx={{ color: "var(--exp-text-muted)" }}>
              No courses yet — head to the catalog to enroll in your first.
            </Typography>
          )}
        </div>
      </div>

      {/* NEWS ─────────────────────────────────────────────────────────── */}
      {news.length > 0 && (
        <div className="exp-container">
          <div className="exp-section">
            <div className="exp-section__head">
              <div>
                <h2 className="exp-section__title">News &amp; Signal</h2>
                <p className="exp-section__sub">
                  Fresh dispatches from your organisation
                </p>
              </div>
            </div>
            <div className="exp-news">
              {news.slice(0, 8).map((article) => {
                const dateStr = article.dateCreated
                  ? new Date(article.dateCreated).toLocaleDateString(
                      undefined,
                      { month: "short", day: "numeric", year: "numeric" }
                    )
                  : "";
                return (
                  <button
                    key={article.id}
                    type="button"
                    className="exp-news-card"
                    onClick={() => setOpenArticle(article)}
                    aria-label={`Open article: ${article.title}`}
                  >
                    {article.imageUri && (
                      <div
                        className="exp-news-card__img"
                        style={{ backgroundImage: `url(${article.imageUri})` }}
                      />
                    )}
                    <div className="exp-news-card__body">
                      <span
                        className={`exp-news-card__badge ${
                          article.hasRead ? "exp-news-card__badge--read" : ""
                        }`}
                      >
                        {article.hasRead ? "Read" : "New"}
                      </span>
                      <h3 className="exp-news-card__title">{article.title}</h3>
                      {(article.description || article.content) && (
                        <p className="exp-news-card__desc">
                          {stripHtmlToText(
                            article.description || article.content || ""
                          ).slice(0, 140)}
                        </p>
                      )}
                      {dateStr && (
                        <span className="exp-news-card__date">{dateStr}</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* RESOURCES ────────────────────────────────────────────────────── */}
      {resources.length > 0 && (
        <div className="exp-container">
          <div className="exp-section">
            <div className="exp-section__head">
              <div>
                <h2 className="exp-section__title">Resources</h2>
                <p className="exp-section__sub">
                  Documents, links, and references curated for your learning
                </p>
              </div>
            </div>
            <div className="exp-resources">
              {resources.slice(0, 12).map((r) => {
                const title = r.name ?? r.title ?? "Untitled resource";
                const meta = (r.resourceType ?? r.category ?? "Document")
                  .toString()
                  .toUpperCase();
                const href = r.url;
                const Tag = href ? "a" : "div";
                return (
                  <Tag
                    key={r.id}
                    {...(href
                      ? {
                          href,
                          target: "_blank",
                          rel: "noreferrer noopener",
                        }
                      : {})}
                    className="exp-resource"
                  >
                    <span className="exp-resource__icon">
                      {resourceIcon(r.resourceType)}
                    </span>
                    <h4 className="exp-resource__title">{title}</h4>
                    {r.description && (
                      <p
                        style={{
                          color: "var(--exp-text-muted)",
                          fontSize: "0.82rem",
                          margin: 0,
                          lineHeight: 1.4,
                        }}
                      >
                        {stripHtmlToText(r.description).slice(0, 80)}
                      </p>
                    )}
                    <span className="exp-resource__meta">{meta}</span>
                  </Tag>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* CATALOG ──────────────────────────────────────────────────────── */}
      {catalog.length > 0 && (
        <div className="exp-container">
          <div className="exp-section">
            <div className="exp-section__head">
              <div>
                <h2 className="exp-section__title">Discover</h2>
                <p className="exp-section__sub">
                  New courses ready for you to step into
                </p>
              </div>
              <Button
                component={Link}
                to="/catalog"
                variant="outlined"
                endIcon={<OpenInNew fontSize="small" />}
              >
                Full catalog
              </Button>
            </div>
            <div className="exp-grid">
              {catalog.slice(0, 8).map((c) => renderCard(c, true))}
            </div>
          </div>
        </div>
      )}

      {/* Stats footer band */}
      <div className="exp-container" style={{ marginBottom: 80 }}>
        <div
          className="exp-glass"
          style={{
            padding: "24px 28px",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 24,
            textAlign: "center",
          }}
        >
          <div>
            <div
              style={{
                fontSize: "1.8rem",
                fontWeight: 800,
                letterSpacing: "-0.02em",
              }}
              className="exp-text-iridescent"
            >
              {gamification.counts.enrolled}
            </div>
            <div
              style={{
                fontSize: "0.72rem",
                color: "var(--exp-text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.18em",
                fontWeight: 600,
              }}
            >
              Enrolled
            </div>
          </div>
          <div>
            <div
              style={{
                fontSize: "1.8rem",
                fontWeight: 800,
                letterSpacing: "-0.02em",
              }}
              className="exp-text-iridescent"
            >
              {gamification.counts.coursesCompleted}
            </div>
            <div
              style={{
                fontSize: "0.72rem",
                color: "var(--exp-text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.18em",
                fontWeight: 600,
              }}
            >
              Courses Completed
            </div>
          </div>
          <div>
            <div
              style={{
                fontSize: "1.8rem",
                fontWeight: 800,
                letterSpacing: "-0.02em",
              }}
              className="exp-text-iridescent"
            >
              {gamification.counts.lessonsCompleted}
            </div>
            <div
              style={{
                fontSize: "0.72rem",
                color: "var(--exp-text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.18em",
                fontWeight: 600,
              }}
            >
              Lessons Completed
            </div>
          </div>
          <div>
            <div
              style={{
                fontSize: "1.8rem",
                fontWeight: 800,
                letterSpacing: "-0.02em",
              }}
              className="exp-text-iridescent"
            >
              {inProgressCourses.length}
            </div>
            <div
              style={{
                fontSize: "0.72rem",
                color: "var(--exp-text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.18em",
                fontWeight: 600,
              }}
            >
              In Progress
            </div>
          </div>
          <div>
            <div
              style={{
                fontSize: "1.8rem",
                fontWeight: 800,
                letterSpacing: "-0.02em",
              }}
              className="exp-text-iridescent"
            >
              {completedCourses.length > 0 ? "✓" : "—"}
            </div>
            <div
              style={{
                fontSize: "0.72rem",
                color: "var(--exp-text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.18em",
                fontWeight: 600,
              }}
            >
              Status
            </div>
          </div>
        </div>
      </div>

      {/* News article modal */}
      <Dialog
        open={openArticle !== null}
        onClose={() => setOpenArticle(null)}
        fullWidth
        maxWidth="md"
      >
        {openArticle && (
          <>
            <DialogTitle
              sx={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 2,
                fontFamily: "'Space Grotesk', sans-serif",
                fontWeight: 700,
                pr: 2,
              }}
            >
              <span>{openArticle.title}</span>
              <IconButton
                onClick={() => setOpenArticle(null)}
                aria-label="Close"
                size="small"
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </DialogTitle>
            <DialogContent dividers sx={{ p: 0 }}>
              {openArticle.imageUri && (
                <img
                  src={openArticle.imageUri}
                  alt=""
                  style={{
                    width: "100%",
                    maxHeight: 360,
                    objectFit: "cover",
                    display: "block",
                  }}
                />
              )}
              <Box sx={{ p: 3 }}>
                <Box
                  sx={{
                    color: "var(--exp-text)",
                    lineHeight: 1.7,
                    "& a": { color: "var(--exp-aqua)" },
                    "& img": { maxWidth: "100%", height: "auto" },
                  }}
                  dangerouslySetInnerHTML={{
                    __html:
                      openArticle.content || openArticle.description || "",
                  }}
                />
              </Box>
            </DialogContent>
          </>
        )}
      </Dialog>

      {/* Lesson player modal (single lesson, auto-resolve next) */}
      <LessonPlayerModal
        courseId={
          playing && playing.mode === "lesson" ? playing.course.id : null
        }
        courseTitle={playing?.course.name}
        onClose={() => {
          setPlaying(null);
          // Small celebration any time the lesson player is closed — proxy
          // for a possible lesson completion event. Real completion data
          // refreshes on next loader run.
          fireConfetti();
          // Bounce back to the curriculum if we drilled in from one.
          if (returnToCurriculum) {
            const ret = returnToCurriculum;
            setReturnToCurriculum(null);
            window.setTimeout(() => setCurriculumCourse(ret), 0);
          }
        }}
      />

      {/* Course player modal (sidebar + per-lesson iframe) */}
      <CoursePlayerModal
        courseId={
          playing && playing.mode === "course" ? playing.course.id : null
        }
        courseTitle={playing?.course.name}
        onClose={() => {
          setPlaying(null);
          fireConfetti();
          if (returnToCurriculum) {
            const ret = returnToCurriculum;
            setReturnToCurriculum(null);
            window.setTimeout(() => setCurriculumCourse(ret), 0);
          }
        }}
      />

      {/* Sessions modal — InstructorLedCourse cards land here */}
      <SessionsModal
        courseId={sessionsCourse?.id ?? null}
        courseTitle={sessionsCourse?.name}
        course={sessionsCourse}
        onRegistered={() => {
          fireConfetti();
          revalidator.revalidate();
        }}
        onClose={() => {
          setSessionsCourse(null);
          // If we got here from a curriculum, reopen it.
          if (returnToCurriculum) {
            const ret = returnToCurriculum;
            setReturnToCurriculum(null);
            window.setTimeout(() => setCurriculumCourse(ret), 0);
          }
        }}
      />

      {/* Curriculum modal — Curriculum cards land here. Child clicks
          remember the parent curriculum so closing the child returns
          the learner here rather than dropping to the hub. */}
      <CurriculumModal
        curriculumId={curriculumCourse?.id ?? null}
        curriculumTitle={curriculumCourse?.name}
        onClose={() => {
          setCurriculumCourse(null);
          // Manual close clears any pending return — we're not going
          // back into a deeper modal that would need to bounce here.
          setReturnToCurriculum(null);
        }}
        onPickCourse={(child) => {
          // Remember which curriculum we came from BEFORE we close it
          // and open the child's modal.
          const parent = curriculumCourse;
          setCurriculumCourse(null);
          if (parent) setReturnToCurriculum(parent);
          // Defer one tick so React commits the unmount before the next
          // modal mounts — avoids stacked-dialog flashes.
          window.setTimeout(() => playOrOpen(child), 0);
        }}
      />

      {/* Loading fallback while courses haven't arrived (very rare) */}
      {myCourses.length === 0 && (
        <Box className="flex justify-center p-12">
          <CircularProgress />
        </Box>
      )}
    </Box>
  );
}

/* ─── Helpers ───────────────────────────────────────────────────────────── */

function rankBadgeChar(rank: Gamification["rank"]): string {
  // First letter of each tier — sits inside the iridescent badge.
  const map: Record<Gamification["rank"], string> = {
    bronze: "B",
    silver: "S",
    gold: "G",
    platinum: "P",
    diamond: "◆",
  };
  return map[rank];
}
