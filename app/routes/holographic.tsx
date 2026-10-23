/**
 * app/routes/holographic.tsx
 *
 * "Holographic" — a particle-volume learning interface for medical
 * diagnosticians and technologists.
 *
 * A point-cloud human body floats in a dark volume. Clicking an organ lifts
 * it out of the body, surfaces the Absorb courses that belong to that
 * discipline as a Minority-Report style arrangement, and plays them in a
 * holographic shell around the real Absorb lesson player.
 *
 * DATA
 * The loader pulls the learner's full catalog with the same server function
 * the /catalog route uses, then `matchCatalogToOrgans` assigns each course to
 * the single organ it scores highest against. Organs with no live match fall
 * back to sample modules so the page is never empty on a tenant whose catalog
 * is all compliance training.
 *
 * The loader runs server-side, so the learner's Infuse token stays in the
 * HttpOnly cookie and never reaches the browser — the constraint that drives
 * the whole SSR design of this app.
 *
 * RENDERING
 * Everything three.js lives behind a dynamic import in HoloCanvas and only
 * runs in the browser. This route renders a complete, readable HTML page on
 * the server: the organ rail, the learning paths and the course lists all
 * work with the canvas absent, which is also what makes the page usable by
 * keyboard and screen reader.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LoaderFunctionArgs, MetaFunction, LinksFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { getAllAvailableCatalog } from "~/.server/infuse-api";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";

import HoloCanvas, {
  type HoloCanvasHandle,
} from "~/components/holographic/holo-canvas";
import CourseTable from "~/components/holographic/course-table";
import HoloPlayer from "~/components/holographic/holo-player";
import {
  ORGANS,
  matchCatalogToOrgans,
  organById,
  type CatalogCourse,
  type MatchedCourse,
  type OrganId,
} from "~/components/holographic/organ-catalog";
import type { LabelPosition } from "~/components/holographic/holo-engine.client";

import holographicStyles from "~/styles/holographic.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: holographicStyles },
];

export const meta: MetaFunction = () => [
  { title: "Holographic · Infuse Academy" },
  {
    name: "description",
    content:
      "A particle-volume anatomy interface for diagnostic imaging and clinical technology learning paths.",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const token = await infuseJwtCookie.parse(request.headers.get("Cookie"));
  // The root loader already redirects unauthenticated requests to /signin;
  // this guard only covers the race where the cookie expires between the two.
  if (!token) return json({ courses: [] as CatalogCourse[], catalogError: null });

  try {
    const catalog = await getAllAvailableCatalog(token);
    return json({
      courses: catalog?._embedded?.courses ?? [],
      catalogError: null as string | null,
    });
  } catch (err) {
    // A catalog failure must not take the page down — the organ paths fall
    // back to sample modules and the volume still renders.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[holographic] catalog fetch failed:", message);
    return json({ courses: [] as CatalogCourse[], catalogError: message });
  }
};

export default function Holographic() {
  const { courses, catalogError } = useLoaderData<typeof loader>();

  const [booted, setBooted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("POWERING VOLUME");
  const [engineError, setEngineError] = useState<string | null>(null);

  const [activeOrgan, setActiveOrgan] = useState<OrganId | null>(null);
  const [hoverOrgan, setHoverOrgan] = useState<OrganId | null>(null);
  const [xray, setXray] = useState(false);
  const [labels, setLabels] = useState<LabelPosition[]>([]);
  const [playing, setPlaying] = useState<MatchedCourse | null>(null);

  const handleRef = useRef<HoloCanvasHandle | null>(null);

  const byOrgan = useMemo(
    () => matchCatalogToOrgans(courses as CatalogCourse[]),
    [courses]
  );

  const liveCount = useMemo(
    () =>
      ORGANS.reduce(
        (sum, o) => sum + byOrgan[o.id].filter((c) => !c.isDemo).length,
        0
      ),
    [byOrgan]
  );

  /* --- engine callbacks, all stable so the canvas never remounts --- */

  const onProgress = useCallback((fraction: number, text: string) => {
    setProgress(fraction);
    setStage(text);
  }, []);

  const onReady = useCallback(() => {
    // Hold the boot overlay a beat past 100% so the assembly animation is
    // actually seen rather than flashing past.
    window.setTimeout(() => setBooted(true), 650);
  }, []);

  const onLabels = useCallback((next: LabelPosition[]) => {
    // The engine reuses its array, so copy before it lands in state.
    setLabels(next.map((l) => ({ ...l })));
  }, []);

  const onSelect = useCallback((id: OrganId | null) => {
    setActiveOrgan((current) => (id === null ? current : id === current ? null : id));
  }, []);

  const onHandle = useCallback((handle: HoloCanvasHandle | null) => {
    handleRef.current = handle;
  }, []);

  const onError = useCallback((message: string) => {
    setEngineError(message);
    setBooted(true);
  }, []);

  /* --- keyboard shortcuts --- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if (e.key === "Escape") {
        if (playing) return; // the player handles its own Escape
        setActiveOrgan(null);
        return;
      }
      if (e.key.toLowerCase() === "x") setXray((v) => !v);
      if (e.key.toLowerCase() === "r") {
        setActiveOrgan(null);
        handleRef.current?.resetView();
      }
      // 1–6 jump straight to an organ, which is how this gets demoed on stage.
      const n = Number(e.key);
      if (n >= 1 && n <= ORGANS.length) setActiveOrgan(ORGANS[n - 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing]);

  const organ = activeOrgan ? organById(activeOrgan) : null;
  const activeCourses = activeOrgan ? byOrgan[activeOrgan] : [];

  return (
    <main className={`holo ${booted ? "is-booted" : ""} ${activeOrgan ? "has-organ" : ""}`}>
      <div className="holo-bg" aria-hidden="true">
        <span className="holo-bg__glow" />
        <span className="holo-bg__grid" />
      </div>

      <div className="holo-stage">
        <HoloCanvas
          activeOrgan={activeOrgan}
          xray={xray}
          onHover={setHoverOrgan}
          onSelect={onSelect}
          onLabels={onLabels}
          onReady={onReady}
          onProgress={onProgress}
          onHandle={onHandle}
          onError={onError}
        />

        {/* 3D-anchored organ labels, projected by the engine each frame. */}
        <div className="holo-labels" aria-hidden="true">
          {!activeOrgan &&
            !engineError &&
            labels.map((label) => {
              const o = organById(label.id);
              const isHover = hoverOrgan === label.id;
              if (!label.visible) return null;
              return (
                <span
                  key={label.id}
                  className={`holo-label holo-label--${label.side} ${
                    isHover ? "is-hover" : ""
                  }`}
                  style={{
                    transform: `translate3d(${label.x}px, ${label.y}px, 0)`,
                    opacity: 0.35 + label.depth * 0.65,
                    ["--organ-accent" as string]: o.accent,
                  }}
                >
                  <i className="holo-label__pin" />
                  <b>{o.label}</b>
                  <em>
                    {byOrgan[label.id].length} module
                    {byOrgan[label.id].length === 1 ? "" : "s"}
                  </em>
                </span>
              );
            })}
        </div>
      </div>

      {/* ---------------- boot overlay ---------------- */}
      {!booted && (
        <div className="holo-boot" role="status" aria-live="polite">
          <div className="holo-boot__inner">
            <p className="holo-boot__kicker">INFUSE ACADEMY · DIAGNOSTIC IMAGING</p>
            <h1>HOLOGRAPHIC ANATOMY</h1>
            <div className="holo-boot__bar">
              <span style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <p className="holo-boot__stage">
              {stage}
              <span className="holo-boot__pct">{Math.round(progress * 100)}%</span>
            </p>
          </div>
        </div>
      )}

      {/* ---------------- left rail ---------------- */}
      <nav className="holo-rail" aria-label="Anatomical systems">
        <header className="holo-rail__head">
          <span className="holo-rail__mark" aria-hidden="true" />
          <div>
            <h1>Holographic</h1>
            <p>Diagnostic Imaging &amp; Clinical Technology</p>
          </div>
        </header>

        <ul className="holo-rail__list">
          {ORGANS.map((o, i) => {
            const count = byOrgan[o.id].length;
            const isDemo = byOrgan[o.id][0]?.isDemo ?? false;
            return (
              <li key={o.id}>
                <button
                  type="button"
                  className={`holo-organ ${activeOrgan === o.id ? "is-active" : ""} ${
                    hoverOrgan === o.id ? "is-hover" : ""
                  }`}
                  style={{ ["--organ-accent" as string]: o.accent }}
                  aria-pressed={activeOrgan === o.id}
                  onMouseEnter={() => setHoverOrgan(o.id)}
                  onMouseLeave={() => setHoverOrgan(null)}
                  onClick={() => setActiveOrgan((c) => (c === o.id ? null : o.id))}
                >
                  <span className="holo-organ__key">{i + 1}</span>
                  <span className="holo-organ__sym">{o.symbol}</span>
                  <span className="holo-organ__text">
                    <b>{o.label}</b>
                    <em>{o.specialty}</em>
                  </span>
                  <span className="holo-organ__count">
                    {count}
                    {isDemo && <i title="Sample content" />}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="holo-rail__foot">
          <button
            type="button"
            className={`holo-chip ${xray ? "is-on" : ""}`}
            aria-pressed={xray}
            onClick={() => setXray((v) => !v)}
          >
            X-RAY
          </button>
          <button
            type="button"
            className="holo-chip"
            onClick={() => {
              setActiveOrgan(null);
              handleRef.current?.resetView();
            }}
          >
            RESET
          </button>
        </div>
      </nav>

      {/* ---------------- status bar ---------------- */}
      <footer className="holo-status">
        <span className="holo-status__item">
          <i className="holo-dot" />
          VOLUME {engineError ? "OFFLINE" : booted ? "STABLE" : "CALIBRATING"}
        </span>
        <span className="holo-status__item">
          CATALOG {catalogError ? "UNAVAILABLE" : `${liveCount} LINKED`}
        </span>
        <span className="holo-status__item holo-status__item--keys">
          <kbd>1</kbd>–<kbd>{ORGANS.length}</kbd> system · <kbd>X</kbd> x-ray ·{" "}
          <kbd>R</kbd> reset · drag to orbit · scroll to zoom
        </span>
      </footer>

      {/* ---------------- fallback when WebGL is unavailable ---------------- */}
      {engineError && (
        <div className="holo-fallback" role="alert">
          <h2>Holographic volume unavailable</h2>
          <p>{engineError}</p>
          <p className="holo-note">
            The learning paths below still work — pick a system from the left.
          </p>
        </div>
      )}

      {/* ---------------- learning path / periodic table ---------------- */}
      {organ && !playing && (
        <CourseTable
          organ={organ}
          courses={activeCourses}
          onLaunch={setPlaying}
          onClose={() => setActiveOrgan(null)}
        />
      )}

      {/* ---------------- player ---------------- */}
      {playing && organ && (
        <HoloPlayer organ={organ} course={playing} onClose={() => setPlaying(null)} />
      )}
    </main>
  );
}
