/**
 * app/routes/learning-hub-crossfit.tsx
 *
 * The "CrossFit" Learning Hub — a template modelled directly on
 * https://www.crossfit.com/education/explore-courses.
 *
 * Sections (top → bottom):
 *   1. Top red marquee ticker
 *   2. "CERTIFICATE COURSES & CREDENTIALS" band — 5 hero credential
 *      cards: Online L1, L1, L2, L3, L4. Each has a badge, CEU/format
 *      meta tag, description, and a "Learn More" button that opens
 *      the CoursePlayerModal for the tenant's trial portal course.
 *   3. "CrossFit Courses" main band — intro copy, type-filter dropdown,
 *      dense grid of every enrolled + catalog course rendered as
 *      cf-course cards.
 *
 * The trial portal course is discovered dynamically in the loader:
 *   - Prefers a course whose name contains "trial portal"
 *   - Falls back to the first Curriculum in the learner's my-courses
 *   - Falls back to the first course of any type if neither is present
 *
 * When "Learn More" is tapped on any of the four Level cards, the
 * CoursePlayerModal opens with that resolved courseId so the learner
 * can start / resume the trial portal content directly.
 */

import { useMemo, useState } from "react";
import { json, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { Box, CircularProgress } from "@mui/material";

import {
  getMyCourses,
  getAllAvailableCatalog,
  InfusePortalUrl,
} from "~/.server/infuse-api";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";
import { Course } from "~/.server/course.resource";
import { CoursePlayerModal } from "~/components/modal/course-player-modal";
import { CourseDetailModal } from "~/components/modal/course-detail-modal";

/* ─── Loader ────────────────────────────────────────────────────────────── */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const cookieHeader = request.headers.get("Cookie");
  const token = await infuseJwtCookie.parse(cookieHeader);
  if (!token) throw new Response("Not authenticated", { status: 401 });

  const [myCoursesRes, catalogRes] = await Promise.all([
    getMyCourses(token, { limit: 20, showCompleted: true }),
    getAllAvailableCatalog(token).catch(() => ({
      _embedded: { courses: [] as Course[] },
    })),
  ]);

  const myCourses = myCoursesRes._embedded.courses;
  const catalog = catalogRes._embedded.courses;

  // Merge my-courses + catalog (my-courses first so enrollment status
  // wins), dedupe by id.
  const seen = new Set<string>();
  const merged: Course[] = [];
  for (const c of [...myCourses, ...catalog]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    merged.push(c);
  }

  /**
   * Trial portal courseId — resolved with a cascade:
   *   1. Anything whose name contains "trial portal" (case-insensitive)
   *   2. Anything whose name contains "portal" alone
   *   3. The first Curriculum in myCourses (Absorb's default landing)
   *   4. The first myCourses entry
   * When there's absolutely nothing available the modal simply doesn't
   * open — the Learn More button no-ops gracefully.
   */
  const findByName = (needle: string): Course | undefined =>
    merged.find((c) => c.name?.toLowerCase().includes(needle));
  const trialCourse: Course | null =
    findByName("trial portal") ??
    findByName("portal") ??
    myCourses.find((c) => c.courseType === "Curriculum") ??
    myCourses[0] ??
    null;

  return json({
    myCourses,
    catalog: merged,
    trialCourse,
    portalBaseUrl: InfusePortalUrl.replace(/\/$/, ""),
  });
};

/* ─── Static credential cards ──────────────────────────────────────────── */

type CredentialCard = {
  badge: string;
  tag: string;
  ceu: string;
  format: "Online" | "In Person";
  title: string;
  description: string;
};

const CREDENTIALS: CredentialCard[] = [
  {
    badge: "L1",
    tag: "Online",
    ceu: "8 CEU",
    format: "Online",
    title: "Online Level 1 CrossFit Trainer",
    description:
      "The Online Level 1 provides an introductory education on the fundamental principles and movements of CrossFit. Ideal for anyone who wants to learn effective training and nutritional strategies without the requirements of travel.",
  },
  {
    badge: "L1",
    tag: "In Person",
    ceu: "14 CEU",
    format: "In Person",
    title: "Level 1 CrossFit Trainer",
    description:
      "An in-person introductory course on the fundamental principles and movements of CrossFit. Teaches effective training techniques and nutritional strategies — ideal for anyone who wants to start coaching CrossFit.",
  },
  {
    badge: "L2",
    tag: "In Person",
    ceu: "13 CEU",
    format: "In Person",
    title: "Level 2 CrossFit Trainer",
    description:
      "Builds upon the Level 1 Course and is designed for any CrossFit trainer who wants to refine their coaching skills and acquire a deeper understanding of the CrossFit methodology and its practical applications, including program design, lesson planning, and implementation.",
  },
  {
    badge: "L3",
    tag: "In Person",
    ceu: "Exam",
    format: "In Person",
    title: "Level 3 Certified CrossFit Trainer",
    description:
      "The Certified CrossFit Level 3 Trainer credential is a CrossFit-specific designation for those who have completed the Level 1 and Level 2 Certificate Courses and then successfully passed the CCFT examination.",
  },
  {
    badge: "L4",
    tag: "Online",
    ceu: "Evaluation",
    format: "Online",
    title: "Level 4 Certified CrossFit Coach",
    description:
      "The Certified CrossFit Level 4 Coach credential is the highest credential offered by CrossFit. It is a virtual process focused on one-on-one coach development and culminates in an evaluation that assesses a trainer's ability to effectively coach CrossFit movements and run a successful class.",
  },
];

/* ─── Utility ──────────────────────────────────────────────────────────── */

function stripHtml(html: string | undefined | null): string {
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

function courseTypeLabel(t: Course["courseType"]): string {
  if (t === "OnlineCourse") return "Online";
  if (t === "InstructorLedCourse") return "In Person";
  return "Curriculum";
}

/* ─── Page ─────────────────────────────────────────────────────────────── */

export default function LearningHubCrossFit() {
  const { catalog, trialCourse } = useLoaderData<typeof loader>();

  const [filter, setFilter] = useState<
    "all" | "OnlineCourse" | "InstructorLedCourse" | "Curriculum"
  >("all");
  const [playing, setPlaying] = useState<Course | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<Course | null>(null);

  const filteredCatalog = useMemo(() => {
    if (filter === "all") return catalog;
    return catalog.filter((c) => c.courseType === filter);
  }, [catalog, filter]);

  const launchTrialPortal = () => {
    if (trialCourse) setPlaying(trialCourse);
  };

  if (!catalog) {
    return (
      <Box className="flex justify-center p-12">
        <CircularProgress />
      </Box>
    );
  }

  return (
    <div style={{ paddingTop: 72 /* clearance for the fixed IA header */ }}>
      {/* Marquee — the red bar at the top of crossfit.com */}
      <div className="cf-marquee">
        Fittest on Earth 2026 — Certificate Courses Now Enrolling
        <a href="https://www.crossfit.com/education/about" target="_blank" rel="noreferrer noopener">
          Learn About Our Courses
        </a>
      </div>

      {/* Certificate credentials band */}
      <section className="cf-credentials">
        <div className="cf-container">
          <h2 className="cf-credentials__title">
            Certificate Courses & Credentials
          </h2>
          <div className="cf-credentials__grid">
            {CREDENTIALS.map((c) => (
              <article key={c.title + c.tag} className="cf-credential-card">
                <div className="cf-credential-card__badge">{c.badge}</div>
                <div className="cf-credential-card__meta">
                  <span className={c.tag === "Online" ? "cf-tag" : "cf-tag cf-tag--red"}>
                    {c.tag}
                  </span>
                  <span>{c.ceu}</span>
                </div>
                <h3 className="cf-credential-card__title">{c.title}</h3>
                <p className="cf-credential-card__desc">{c.description}</p>
                <button
                  type="button"
                  className="cf-btn"
                  onClick={launchTrialPortal}
                  disabled={!trialCourse}
                  aria-label={`Learn more about ${c.title}`}
                >
                  Learn More
                </button>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Main course grid */}
      <section className="cf-main">
        <div className="cf-container">
          <h1 className="cf-main__title">CrossFit Courses</h1>
          <p className="cf-main__intro">
            The best CrossFit coaches are always seeking ways to improve.
            Refine your skills, improve your technique, and become a better
            coach and athlete with any of CrossFit&rsquo;s continuing-education
            courses.
          </p>

          <div className="cf-filter">
            <label htmlFor="cf-filter-type" className="cf-filter__label">
              Type
            </label>
            <select
              id="cf-filter-type"
              className="cf-filter__select"
              value={filter}
              onChange={(e) =>
                setFilter(e.target.value as typeof filter)
              }
            >
              <option value="all">All</option>
              <option value="OnlineCourse">Online</option>
              <option value="InstructorLedCourse">In Person</option>
              <option value="Curriculum">Curriculum</option>
            </select>
          </div>

          <div className="cf-course-grid">
            {filteredCatalog.length === 0 ? (
              <div className="cf-empty" style={{ gridColumn: "1 / -1" }}>
                No courses available for that filter.
              </div>
            ) : (
              filteredCatalog.map((c) => (
                <article
                  key={c.id}
                  className="cf-course-card"
                  onClick={() => setSelectedDetail(c)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedDetail(c);
                    }
                  }}
                >
                  <div className="cf-course-card__badge">
                    {c.courseType === "OnlineCourse"
                      ? "ON"
                      : c.courseType === "InstructorLedCourse"
                      ? "IP"
                      : "CU"}
                  </div>
                  <div className="cf-course-card__meta">
                    <span className="cf-tag">
                      {courseTypeLabel(c.courseType)}
                    </span>
                    {c.enrollmentStatus === "Complete" ||
                    c.enrollmentStatus === "Completed" ? (
                      <span className="cf-tag cf-tag--red">Complete</span>
                    ) : c.enrollmentStatus === "InProgress" ? (
                      <span className="cf-tag cf-tag--red">In Progress</span>
                    ) : c.enrollmentStatus ? (
                      <span className="cf-tag">Enrolled</span>
                    ) : (
                      <span className="cf-tag">Available</span>
                    )}
                  </div>
                  <h3 className="cf-course-card__title">{c.name}</h3>
                  {c.description && (
                    <p className="cf-course-card__desc">
                      {stripHtml(c.description)}
                    </p>
                  )}
                  <button
                    type="button"
                    className="cf-course-card__cta"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedDetail(c);
                    }}
                  >
                    Learn More →
                  </button>
                </article>
              ))
            )}
          </div>
        </div>
      </section>

      {/* Course detail modal — matches other themes' behaviour */}
      {selectedDetail && (
        <CourseDetailModal
          open={!!selectedDetail}
          onClose={() => setSelectedDetail(null)}
          title={selectedDetail.name}
          description={selectedDetail.description}
          imageUrl={selectedDetail.imageUrl}
          courseType={selectedDetail.courseType}
          enrollmentStatus={selectedDetail.enrollmentStatus}
          onLaunch={() => setPlaying(selectedDetail)}
        />
      )}

      {/* Course player modal — opens for the trial portal from the
          credential cards, or for any course from the detail modal */}
      <CoursePlayerModal
        courseId={playing?.id ?? null}
        courseTitle={playing?.name}
        onClose={() => setPlaying(null)}
      />

      {/* Fallback link footer */}
      <div style={{ textAlign: "center", padding: "24px 0 56px" }}>
        <Link
          to="/catalog"
          style={{
            color: "#e01515",
            fontFamily: "'Bebas Neue', 'Roboto Condensed', sans-serif",
            fontWeight: 800,
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            fontSize: "0.9rem",
          }}
        >
          Browse Full Catalog →
        </Link>
      </div>
    </div>
  );
}
