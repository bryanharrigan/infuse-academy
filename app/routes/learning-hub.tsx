/**
 * app/routes/learning-hub.tsx
 *
 * Port of wordpress-theme/infuse-academy/page-templates/learning-hub.php
 * — a Sana-inspired personalised learning dashboard for the IA theme.
 *
 * Sections:
 *   1. Hero   — avatar / greeting / name / date
 *   2. Stats  — four progress rings (enrolled, completed, in-progress, avg)
 *   3. Continue Learning — featured first in-progress course
 *   4. My Courses — filter pills + card grid
 *   5. Explore Catalog — first 8 catalog items
 *   6. Progress Breakdown — bar chart (one bar per in-progress course)
 *
 * Skipped (WP-specific): News & Announcements section + modal.
 * Uses the existing LessonPlayerModal for launches.
 *
 * Renders a full experience only when the IA theme is active. In default
 * mode it shows a prompt to flip the theme toggle.
 */
import { useMemo, useState } from "react";
import {
  Box,
  Button,
  CircularProgress,
  Typography,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
} from "@mui/material";
import { PlayArrow, OpenInNew, Close as CloseIcon } from "@mui/icons-material";
import { json, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useRouteLoaderData, Link } from "@remix-run/react";
import {
  getMyCatalog,
  getMyCourses,
  getNewsArticles,
  type NewsArticle,
} from "~/.server/infuse-api";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";
import { Course } from "~/.server/course.resource";
import { LessonPlayerModal } from "~/components/modal/lesson-player-modal";
import { CoursePlayerModal } from "~/components/modal/course-player-modal";
import OnlineCourseSVG from "~/assets/online-course.svg";
import { useAppStateContext } from "~/context/app-state.context";

type RootData = {
  userProfile: { firstName: string; lastName: string };
  avatarUrl: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const cookieHeader = request.headers.get("Cookie");
  const token = await infuseJwtCookie.parse(cookieHeader);
  if (!token) throw new Response("Not authenticated", { status: 401 });

  // Absorb's Infuse API caps _limit around 30 — passing 50 gets a 422.
  // Match what the other pages successfully use.
  // News is optional — some tenants don't have Engage enabled; swallow errors.
  const [myCoursesRes, catalogRes, news] = await Promise.all([
    getMyCourses(token, { limit: 30, showCompleted: true }),
    getMyCatalog(token, { limit: 20, showCompleted: true }),
    getNewsArticles(token, { limit: 20 }).catch((err) => {
      console.warn("[learning-hub] news fetch failed:", err?.message ?? err);
      return [] as NewsArticle[];
    }),
  ]);

  return json({
    myCourses: myCoursesRes._embedded.courses,
    catalog: catalogRes._embedded.courses,
    news,
  });
};

/* ───────── Utilities ─────────────────────────────────────────────────── */

function greetingForHour(h: number): string {
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function formatDate(now: Date): string {
  const days = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
}

// Best-effort: /my-courses doesn't return a 0–100 progress number, just
// enrollmentStatus. Derive a rough figure so the rings/bars have something
// to show.
function estimateProgressPct(status: string | null): number {
  if (!status) return 0;
  if (status === "Complete" || status === "Completed") return 100;
  if (status === "InProgress") return 50;
  if (status === "NotStarted") return 0;
  return 0;
}

function isComplete(status: string | null): boolean {
  return status === "Complete" || status === "Completed";
}

/**
 * Absorb returns course descriptions as HTML — often pasted from Word or
 * Wikipedia with inline-styled spans, links, highlighted backgrounds, etc.
 * For the hub cards we want a plain-text preview so the dark theme doesn't
 * show orphan highlight boxes and link underlines.
 */
function stripHtmlToText(html: string | undefined | null): string {
  if (!html) return "";
  // Remove <style> and <script> blocks entirely so their contents don't leak.
  const withoutBlocks = html.replace(
    /<(style|script)[^>]*>[\s\S]*?<\/\1>/gi,
    ""
  );
  const withoutTags = withoutBlocks.replace(/<[^>]+>/g, "");
  // Decode the common entities Absorb sends; anything else falls through as-is.
  const decoded = withoutTags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, "’")
    .replace(/&lsquo;/g, "‘")
    .replace(/&rdquo;/g, "”")
    .replace(/&ldquo;/g, "“")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–");
  return decoded.replace(/\s+/g, " ").trim();
}

/* ───────── Sub-components ────────────────────────────────────────────── */

const StatRing: React.FC<{
  value: number;
  label: string;
  max?: number;
  strokeGradId: string;
  displayPercent?: boolean;
}> = ({ value, label, max = 1, strokeGradId, displayPercent }) => {
  const r = 30;
  const circumference = 2 * Math.PI * r;
  const progress = max > 0 ? Math.min(1, value / max) : 0;
  const offset = circumference * (1 - progress);
  const valueText = displayPercent ? (
    <>
      {Math.round(progress * 100)}
      <small>%</small>
    </>
  ) : (
    String(value)
  );
  return (
    <div className="hub-stat">
      <div className="hub-stat__ring-wrap">
        <svg width="72" height="72" viewBox="0 0 72 72">
          <circle
            cx="36"
            cy="36"
            r={r}
            stroke="rgba(255,255,255,0.06)"
            strokeWidth={5}
            fill="none"
          />
          <circle
            cx="36"
            cy="36"
            r={r}
            stroke={`url(#${strokeGradId})`}
            strokeWidth={5}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={circumference.toFixed(1)}
            strokeDashoffset={offset.toFixed(1)}
            transform="rotate(-90 36 36)"
            style={{ transition: "stroke-dashoffset 1.2s cubic-bezier(.4,0,.2,1)" }}
          />
        </svg>
        <span className="hub-stat__ring-val">{valueText}</span>
      </div>
      <span className="hub-stat__label">{label}</span>
    </div>
  );
};

const BigRing: React.FC<{ percent: number }> = ({ percent }) => {
  const r = 52;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - Math.min(1, percent / 100));
  return (
    <div className="hub-featured__ring-wrap">
      <svg width="120" height="120" viewBox="0 0 120 120">
        <circle
          cx="60"
          cy="60"
          r={r}
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={8}
          fill="none"
        />
        <circle
          cx="60"
          cy="60"
          r={r}
          stroke="url(#ia-ring-gradient)"
          strokeWidth={8}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference.toFixed(1)}
          strokeDashoffset={offset.toFixed(1)}
          transform="rotate(-90 60 60)"
          style={{ transition: "stroke-dashoffset 1.2s cubic-bezier(.4,0,.2,1)" }}
        />
      </svg>
      <span className="hub-featured__ring-pct">{Math.round(percent)}%</span>
    </div>
  );
};

/* ───────── Page ─────────────────────────────────────────────────────── */

export default function LearningHub() {
  const { myCourses, catalog, news } = useLoaderData<typeof loader>();
  const rootData = useRouteLoaderData("root") as RootData | null;
  const { themeVariant } = useAppStateContext();
  // IA layout also powers the RadNet variant.
  const isIA = themeVariant !== "default";
  const isRadNet = themeVariant === "radnet";

  const [filter, setFilter] = useState<
    "all" | "InProgress" | "Complete" | "NotStarted"
  >("all");
  const [playing, setPlaying] = useState<
    { course: Course; mode: "lesson" | "course" } | null
  >(null);
  const [openArticle, setOpenArticle] = useState<NewsArticle | null>(null);
  // Legacy alias used by existing card/featured click handlers (defaults to
  // "lesson" mode). Progress Breakdown bars pass "course" instead.
  const setPlayingCourse = (c: Course | null) =>
    setPlaying(c ? { course: c, mode: "lesson" } : null);

  // Index myCourses by id so Progress Breakdown bars can resolve clicks.
  const courseById = useMemo(() => {
    const m = new Map<string, Course>();
    for (const c of myCourses) m.set(c.id, c);
    return m;
  }, [myCourses]);

  // Derived metrics for the stats rings and progress bars
  const metrics = useMemo(() => {
    const enrolled = myCourses.length;
    const completed = myCourses.filter((c) => isComplete(c.enrollmentStatus))
      .length;
    const inProgress = myCourses.filter(
      (c) => c.enrollmentStatus === "InProgress"
    ).length;
    const totalPct = myCourses.reduce(
      (sum, c) => sum + estimateProgressPct(c.enrollmentStatus),
      0
    );
    const avgPct = enrolled > 0 ? Math.round(totalPct / enrolled) : 0;
    return { enrolled, completed, inProgress, avgPct };
  }, [myCourses]);

  const featured = useMemo(
    () => myCourses.find((c) => c.enrollmentStatus === "InProgress") ?? null,
    [myCourses]
  );

  const filteredCourses = useMemo(() => {
    if (filter === "all") return myCourses;
    return myCourses.filter((c) => c.enrollmentStatus === filter);
  }, [myCourses, filter]);

  const inProgressCourses = useMemo(
    () => myCourses.filter((c) => c.enrollmentStatus === "InProgress"),
    [myCourses]
  );

  // ─── Default variant fallback ────────────────────────────────────────
  if (!isIA) {
    return (
      <Box
        className="p-12 mt-[75px]"
        sx={{ maxWidth: 720, mx: "auto", textAlign: "center" }}
      >
        <Typography variant="h4" gutterBottom>
          Learning Hub
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
          The Learning Hub is designed for the Infuse Academy theme. Flip the
          <strong> Default / Infuse Academy</strong> toggle in the top-right to
          see the full experience.
        </Typography>
        <Button component={Link} to="/my-courses" variant="contained">
          Go to My Courses
        </Button>
      </Box>
    );
  }

  const now = new Date();
  const firstName = rootData?.userProfile?.firstName ?? "Learner";
  const lastName = rootData?.userProfile?.lastName ?? "";
  const initial = firstName.charAt(0).toUpperCase() || "?";

  /* ─── Card renderer (shared by my-courses grid + catalog grid) ─────── */
  const renderCard = (course: Course, inCatalog: boolean) => {
    const pct = estimateProgressPct(course.enrollmentStatus);
    const statusClass = isComplete(course.enrollmentStatus)
      ? "hub-card__status--done"
      : course.enrollmentStatus === "InProgress"
      ? "hub-card__status--progress"
      : "hub-card__status--new";
    const statusLabel = isComplete(course.enrollmentStatus)
      ? "Completed"
      : course.enrollmentStatus === "InProgress"
      ? "In Progress"
      : inCatalog && !course.enrollmentStatus
      ? "Available"
      : "Not Started";
    const canPlay = Boolean(course.enrollmentStatus);

    return (
      <article key={course.id} className="hub-card">
        <div
          className="hub-card__img"
          style={
            course.imageUrl
              ? { backgroundImage: `url(${course.imageUrl})` }
              : undefined
          }
        >
          {!course.imageUrl && (
            <img
              className="hub-card__img-placeholder"
              src={OnlineCourseSVG}
              alt=""
            />
          )}
        </div>
        <div className="hub-card__body">
          <span className={`hub-card__status ${statusClass}`}>
            {statusLabel}
          </span>
          <h3 className="hub-card__title" title={course.name}>
            {course.name}
          </h3>
          {course.description && (
            <p className="hub-card__desc">
              {stripHtmlToText(course.description)}
            </p>
          )}
          {!inCatalog && (
            <>
              <div className="hub-card__progress">
                <div
                  className="hub-card__progress-bar"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="hub-card__footer">
                <span className="hub-card__pct">{pct}%</span>
                <button
                  type="button"
                  className={
                    isComplete(course.enrollmentStatus)
                      ? "hub-card__enroll hub-card__enroll--done"
                      : "hub-card__open"
                  }
                  onClick={() => canPlay && setPlayingCourse(course)}
                >
                  {isComplete(course.enrollmentStatus)
                    ? "Review"
                    : course.enrollmentStatus === "InProgress"
                    ? "Resume"
                    : "Start"}
                </button>
              </div>
            </>
          )}
          {inCatalog && (
            <div className="hub-card__footer">
              <Button
                component={Link}
                to="/catalog"
                size="small"
                variant="outlined"
                endIcon={<OpenInNew fontSize="small" />}
                sx={{ ml: "auto" }}
              >
                Catalog
              </Button>
            </div>
          )}
        </div>
      </article>
    );
  };

  return (
    <section className="hub">
      {/* HERO */}
      <div className="hub-hero" style={{ marginTop: 72 }}>
        <div className="hub-hero__bg-dots" />
        <div className="ia-container hub-hero__inner">
          <div className="hub-hero__left">
            <div className="hub-hero__avatar">
              <span className="hub-hero__avatar-letter">{initial}</span>
            </div>
            <div>
              <p className="hub-hero__greeting">
                {greetingForHour(now.getHours())}
              </p>
              <h1 className="hub-hero__name">
                {firstName} {lastName}
              </h1>
              <p className="hub-hero__tagline">
                Your personalised learning journey
              </p>
            </div>
          </div>
          <div className="hub-hero__date">{formatDate(now)}</div>
        </div>
        {/* RadNet-only brand tagline centered below the personal greeting
            row. Light "Advancing Imaging Through" over bold "Innovation &
            Technology" — matches radnet.com's homepage headline. */}
        {isRadNet && (
          <h2 className="hub-hero__radnet-tagline">
            <span className="hub-hero__radnet-tagline-light">
              Advancing Imaging Through
            </span>
            <span className="hub-hero__radnet-tagline-bold">
              Innovation &amp; Technology
            </span>
          </h2>
        )}
      </div>

      {/* STATS */}
      <div className="ia-container">
        <div className="hub-stats ia-animate">
          <StatRing
            value={metrics.enrolled}
            max={Math.max(metrics.enrolled, 10)}
            label="Enrolled"
            strokeGradId="ia-ring-gradient"
          />
          <StatRing
            value={metrics.completed}
            max={Math.max(metrics.enrolled, 1)}
            label="Completed"
            strokeGradId="hub-ring-green"
          />
          <StatRing
            value={metrics.inProgress}
            max={Math.max(metrics.enrolled, 1)}
            label="In Progress"
            strokeGradId="ia-ring-gradient"
          />
          <StatRing
            value={metrics.avgPct}
            max={100}
            label="Avg Progress"
            strokeGradId="ia-ring-gradient"
            displayPercent
          />
        </div>
      </div>

      {/* RADNET INVESTOR DAY banner — rendered only in RadNet theme. Matches
          the blue bar on radnet.com with an outlined uppercase headline. */}
      {isRadNet && (
        <div
          className="rn-investor-banner"
          role="region"
          aria-label="RadNet Investor Day 2025"
        >
          <span className="rn-investor-banner__title">
            RadNet Investor Day 2025
          </span>
          <span className="rn-investor-banner__divider" aria-hidden />
          <a
            className="rn-investor-banner__link"
            href="https://www.radnet.com/investor-day"
            target="_blank"
            rel="noreferrer noopener"
          >
            Webcast Replay
            <span className="rn-investor-banner__chev" aria-hidden>
              ▸
            </span>
          </a>
        </div>
      )}

      {/* CONTINUE LEARNING */}
      {featured && (
        <div className="ia-container">
          <div className="hub-section">
            <div className="hub-section__header">
              <div>
                <h2 className="hub-section__title">Continue Learning</h2>
                <p className="hub-section__sub">Pick up where you left off</p>
              </div>
            </div>
            <div className="hub-featured__card">
              <div className="hub-featured__left">
                {featured.imageUrl && (
                  <img
                    className="hub-featured__img"
                    src={featured.imageUrl}
                    alt={featured.name}
                  />
                )}
                <div className="hub-featured__overlay" />
                <div className="hub-featured__content">
                  <span className="hub-featured__badge">In Progress</span>
                  <h3 className="hub-featured__title">{featured.name}</h3>
                  {featured.description && (
                    <p className="hub-featured__desc">
                      {stripHtmlToText(featured.description)}
                    </p>
                  )}
                  <span className="hub-featured__meta">
                    {featured.courseType === "OnlineCourse"
                      ? "Online Course"
                      : featured.courseType}
                  </span>
                </div>
              </div>
              <div className="hub-featured__right">
                <BigRing percent={estimateProgressPct(featured.enrollmentStatus)} />
                <button
                  type="button"
                  className="hub-featured__resume"
                  onClick={() => setPlayingCourse(featured)}
                >
                  <PlayArrow fontSize="small" />
                  Resume
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MY COURSES */}
      <div className="ia-container">
        <div className="hub-section">
          <div className="hub-section__header">
            <h2 className="hub-section__title">My Courses</h2>
            <div className="hub-filter">
              {(
                [
                  ["all", "All"],
                  ["InProgress", "In Progress"],
                  ["Complete", "Completed"],
                  ["NotStarted", "Not Started"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`hub-filter__btn ${
                    filter === key ? "hub-filter__btn--active" : ""
                  }`}
                  onClick={() => setFilter(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="hub-grid">
            {filteredCourses.length > 0 ? (
              filteredCourses.map((c) => renderCard(c, false))
            ) : (
              <Typography
                variant="body2"
                sx={{ color: "var(--ia-text-muted)", gridColumn: "1/-1" }}
              >
                Nothing matches that filter.
              </Typography>
            )}
          </div>
        </div>
      </div>

      {/* PROGRESS BREAKDOWN (clickable — launches the course player) */}
      {inProgressCourses.length > 0 && (
        <div className="ia-container">
          <div className="hub-section">
            <div className="hub-section__header">
              <div>
                <h2 className="hub-section__title">Progress Breakdown</h2>
                <p className="hub-section__sub">
                  Visual snapshot of your learning — click a course to resume.
                </p>
              </div>
            </div>
            <div className="hub-bars">
              {inProgressCourses.map((c) => {
                const pct = estimateProgressPct(c.enrollmentStatus);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className="hub-pbar"
                    onClick={() => {
                      const course = courseById.get(c.id) ?? c;
                      // Launch the multi-lesson Course Player (sidebar of
                      // lessons) rather than the single-lesson player.
                      setPlaying({ course, mode: "course" });
                    }}
                    aria-label={`Open ${c.name} in the course player — ${pct} percent complete`}
                  >
                    <div className="hub-pbar__label">
                      <span className="hub-pbar__name">{c.name}</span>
                      <span className="hub-pbar__pct">{pct}%</span>
                    </div>
                    <div className="hub-pbar__track">
                      <div
                        className={`hub-pbar__fill ${
                          pct >= 100
                            ? "hub-pbar__fill--done"
                            : "hub-pbar__fill--progress"
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* EXPLORE CATALOG */}
      {catalog.length > 0 && (
        <div className="ia-container">
          <div className="hub-section">
            <div className="hub-section__header">
              <div>
                <h2 className="hub-section__title">Explore Catalog</h2>
                <p className="hub-section__sub">
                  Discover new courses to grow your skills
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
            <div className="hub-grid">
              {catalog.slice(0, 8).map((c) => renderCard(c, true))}
            </div>
          </div>
        </div>
      )}

      {/* NEWS & ANNOUNCEMENTS */}
      {news.length > 0 && (
        <div className="ia-container">
          <div className="hub-section">
            <div className="hub-section__header">
              <div>
                <h2 className="hub-section__title">News &amp; Announcements</h2>
                <p className="hub-section__sub">
                  Latest updates from your organisation
                </p>
              </div>
            </div>
            <div className="hub-news">
              {news.map((article) => {
                const authorInitial =
                  article.author?.charAt(0)?.toUpperCase() ?? "•";
                const dateStr = article.dateCreated
                  ? new Date(article.dateCreated).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })
                  : "";
                return (
                  <button
                    key={article.id}
                    type="button"
                    className="hub-news-card"
                    onClick={() => setOpenArticle(article)}
                    aria-label={`Open article: ${article.title}`}
                  >
                    <div
                      className="hub-news-card__img"
                      style={
                        article.imageUri
                          ? { backgroundImage: `url(${article.imageUri})` }
                          : undefined
                      }
                    >
                      {!article.imageUri && (
                        <svg
                          className="hub-news-card__img-placeholder"
                          viewBox="0 0 24 24"
                          fill="none"
                          aria-hidden
                        >
                          <path
                            d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V9a2 2 0 012-2h2a2 2 0 012 2v9a2 2 0 01-2 2h-2zM5 12h6m-6 4h6"
                            stroke="rgba(255,255,255,0.35)"
                            strokeWidth={1.5}
                            strokeLinecap="round"
                          />
                        </svg>
                      )}
                    </div>
                    <div className="hub-news-card__body">
                      <div className="hub-news-card__top">
                        <span
                          className={`hub-news-card__badge ${
                            article.hasRead
                              ? "hub-news-card__badge--read"
                              : "hub-news-card__badge--new"
                          }`}
                        >
                          {article.hasRead ? "Read" : "New"}
                        </span>
                        {dateStr && (
                          <span className="hub-news-card__date">{dateStr}</span>
                        )}
                      </div>
                      <h3 className="hub-news-card__title">{article.title}</h3>
                      {(article.description || article.content) && (
                        <p className="hub-news-card__desc">
                          {stripHtmlToText(
                            article.description || article.content || ""
                          )}
                        </p>
                      )}
                      <div className="hub-news-card__author-row">
                        {article.authorProfileImageUri ? (
                          <img
                            className="hub-news-card__author-avatar"
                            src={article.authorProfileImageUri}
                            alt=""
                          />
                        ) : (
                          <span className="hub-news-card__author-initial">
                            {authorInitial}
                          </span>
                        )}
                        {article.author && (
                          <span className="hub-news-card__author-name">
                            {article.author}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* News article modal */}
      <Dialog
        open={openArticle !== null}
        onClose={() => setOpenArticle(null)}
        fullWidth
        maxWidth="md"
        PaperProps={{ sx: { borderRadius: 3 } }}
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
                    display: "flex",
                    gap: 1.5,
                    alignItems: "center",
                    mb: 2,
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    className={`hub-news-card__badge ${
                      openArticle.hasRead
                        ? "hub-news-card__badge--read"
                        : "hub-news-card__badge--new"
                    }`}
                  >
                    {openArticle.hasRead ? "Read" : "New"}
                  </span>
                  {openArticle.dateCreated && (
                    <span className="hub-news-card__date">
                      {new Date(openArticle.dateCreated).toLocaleDateString(
                        undefined,
                        {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        }
                      )}
                    </span>
                  )}
                  {openArticle.author && (
                    <span className="hub-news-card__author-name">
                      · {openArticle.author}
                    </span>
                  )}
                </Box>
                {/* Full HTML content — Absorb admins author this in the Engage
                    editor, so rich formatting is expected here. */}
                <Box
                  sx={{
                    color: "var(--ia-text)",
                    lineHeight: 1.6,
                    "& a": { color: "var(--ia-accent-1)" },
                    "& img": { maxWidth: "100%", height: "auto" },
                  }}
                  dangerouslySetInnerHTML={{
                    __html: openArticle.content || openArticle.description || "",
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
        onClose={() => setPlaying(null)}
      />

      {/* Course player modal (sidebar + per-lesson iframe) */}
      <CoursePlayerModal
        courseId={
          playing && playing.mode === "course" ? playing.course.id : null
        }
        courseTitle={playing?.course.name}
        onClose={() => setPlaying(null)}
      />

      {/* Bottom padding */}
      <div style={{ height: 64 }} />

      {/* Extra SVG gradient used by the green ring stat */}
      <svg
        width="0"
        height="0"
        style={{ position: "absolute" }}
        aria-hidden
      >
        <defs>
          <linearGradient id="hub-ring-green" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#43e97b" />
            <stop offset="100%" stopColor="#38f9d7" />
          </linearGradient>
        </defs>
      </svg>

      {/* Fallback while no courses at all (rare) */}
      {myCourses.length === 0 && (
        <Box className="flex justify-center p-12">
          <CircularProgress />
        </Box>
      )}
    </section>
  );
}
