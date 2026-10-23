/**
 * app/components/holographic/course-table.tsx
 *
 * The Minority Report / periodic-table course grid.
 *
 * Deliberately NOT three.js. The original three.js periodic-table demo uses
 * CSS3DRenderer, which is just CSS 3D transforms driven from JS — so we do
 * the same thing directly with a `preserve-3d` container and let CSS
 * transitions handle the easing. The upside is real text: selectable,
 * screen-reader-visible, crisp at any DPI, and themeable with ordinary CSS.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { courseSymbol, type MatchedCourse, type Organ } from "./organ-catalog";

export type TableLayout = "table" | "sphere" | "helix" | "grid";

/**
 * Opening arrangement. The helix reads as a path wrapped around the body —
 * it shows the whole sequence at once and drifts on its own, which is what
 * makes the panel feel alive the moment an organ is picked. TABLE is one
 * click away for anyone who just wants to read the list.
 */
export const DEFAULT_LAYOUT: TableLayout = "helix";

const LAYOUTS: { id: TableLayout; label: string }[] = [
  { id: "table", label: "TABLE" },
  { id: "sphere", label: "SPHERE" },
  { id: "helix", label: "HELIX" },
  { id: "grid", label: "GRID" },
];

type Placement = { transform: string };

/**
 * Position for one card under one layout.
 *
 * Position only — no per-card rotation. The three.js periodic-table demo
 * turns each card to face outward from the sphere, which means the far side
 * presents its back; with real DOM elements that is either invisible
 * (backface-visibility) or mirrored text. We billboard the faces instead, so
 * every module stays readable from wherever the arrangement has been spun to.
 */
function placements(count: number, layout: TableLayout): Placement[] {
  const out: Placement[] = [];

  if (layout === "table") {
    // Column count chosen so the block stays wider than it is tall, which is
    // what makes it read as a periodic table rather than a list.
    const cols = Math.max(3, Math.ceil(Math.sqrt(count * 1.9)));
    const rows = Math.ceil(count / cols);
    for (let i = 0; i < count; i++) {
      const cx = (i % cols) - (cols - 1) / 2;
      const cy = Math.floor(i / cols) - (rows - 1) / 2;
      out.push({
        transform: `translate3d(${(cx * 132).toFixed(1)}px, ${(cy * 158).toFixed(1)}px, 0px)`,
      });
    }
    return out;
  }

  if (layout === "sphere") {
    // Scaled to the course count: a fixed radius throws four cards to the
    // far corners and crams fourteen into the same shell.
    const radius = 170 + count * 15;
    for (let i = 0; i < count; i++) {
      // Even distribution in latitude, then a golden-angle spiral in
      // longitude so neighbours never line up into visible seams.
      const phi = Math.acos(-1 + (2 * i + 1) / Math.max(count, 1));
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const x = radius * Math.cos(theta) * Math.sin(phi);
      const y = radius * Math.cos(phi) * 0.78;
      const z = radius * Math.sin(theta) * Math.sin(phi);
      out.push({
        transform: `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, ${z.toFixed(1)}px)`,
      });
    }
    return out;
  }

  if (layout === "helix") {
    const radius = 215;
    // Spacing adapts to the count: a fixed pitch bunches four cards into one
    // overlapping clump and runs fourteen off the top and bottom of the view.
    const pitch = Math.min(96, Math.max(44, 520 / Math.max(count, 1)));
    const turn = count <= 6 ? 1.05 : 0.62;
    for (let i = 0; i < count; i++) {
      const theta = i * turn + Math.PI;
      const y = -(i * pitch) + ((count - 1) * pitch) / 2;
      const x = radius * Math.sin(theta);
      const z = radius * Math.cos(theta);
      out.push({
        transform: `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, ${z.toFixed(1)}px)`,
      });
    }
    return out;
  }

  // grid — stacked planes receding into depth
  const per = 4;
  for (let i = 0; i < count; i++) {
    const x = ((i % per) - (per - 1) / 2) * 148;
    const y = (-(Math.floor(i / per) % per) + (per - 1) / 2) * 170;
    const z = (Math.floor(i / (per * per)) - 1) * 300;
    out.push({
      transform: `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, ${z.toFixed(1)}px)`,
    });
  }
  return out;
}

type Props = {
  organ: Organ;
  courses: MatchedCourse[];
  onLaunch: (course: MatchedCourse) => void;
  onClose: () => void;
};

export default function CourseTable({ organ, courses, onLaunch, onClose }: Props) {
  const [layout, setLayout] = useState<TableLayout>(DEFAULT_LAYOUT);
  const [focus, setFocus] = useState<number | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // Scene rotation. Auto-drifts, and the user can drag it.
  const [rot, setRot] = useState({ x: -6, y: 0 });
  const drag = useRef<{ x: number; y: number; rx: number; ry: number } | null>(null);
  const autoRef = useRef(true);

  const spots = useMemo(
    () => placements(courses.length, layout),
    [courses.length, layout]
  );

  // Inverse of the scene rotation. The parent applies rotateX(a) rotateY(b),
  // so the inverse in CSS order is rotateY(-b) rotateX(-a).
  const billboard = `rotateY(${(-rot.y).toFixed(2)}deg) rotateX(${(-rot.x).toFixed(2)}deg)`;

  useEffect(() => {
    // A new organ reopens on the default arrangement.
    setLayout(DEFAULT_LAYOUT);
    setRot({ x: -6, y: 0 });
    setFocus(null);
  }, [organ.id]);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
    if (reduce) return;

    let raf = 0;
    let last = performance.now();
    const spin = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (autoRef.current && !drag.current && layout !== "table") {
        setRot((r) => ({ ...r, y: r.y + dt * 7 }));
      }
      raf = requestAnimationFrame(spin);
    };
    raf = requestAnimationFrame(spin);
    return () => cancelAnimationFrame(raf);
  }, [layout]);

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".holo-tile")) return;
    drag.current = { x: e.clientX, y: e.clientY, rx: rot.x, ry: rot.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setRot({
      // Clamp pitch so the cards never flip edge-on and vanish.
      x: Math.max(-60, Math.min(60, d.rx - (e.clientY - d.y) * 0.25)),
      y: d.ry + (e.clientX - d.x) * 0.3,
    });
  };

  const endDrag = (e: React.PointerEvent) => {
    drag.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };

  return (
    <div className="holo-table" style={{ ["--organ-accent" as string]: organ.accent }}>
      <header className="holo-table__bar">
        <div className="holo-table__ident">
          <span className="holo-table__sym">{organ.symbol}</span>
          <div>
            <h2>{organ.label} Learning Path</h2>
            <p>
              {organ.specialty} · {courses.length} module
              {courses.length === 1 ? "" : "s"}
              {!courses[0]?.isDemo
                ? " · live catalog"
                : courses.some((c) => c.resolution === "named-match")
                  ? " · sample titles, matched in portal"
                  : " · sample content, plays default course"}
            </p>
          </div>
        </div>

        <div className="holo-table__modes" role="group" aria-label="Arrangement">
          {LAYOUTS.map((l) => (
            <button
              key={l.id}
              type="button"
              className={`holo-chip ${layout === l.id ? "is-on" : ""}`}
              aria-pressed={layout === l.id}
              onClick={() => {
                setLayout(l.id);
                autoRef.current = l.id !== "table";
              }}
            >
              {l.label}
            </button>
          ))}
          <button type="button" className="holo-chip holo-chip--close" onClick={onClose}>
            CLOSE
          </button>
        </div>
      </header>

      <div
        className="holo-table__stage"
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div
          className="holo-table__scene"
          style={{ transform: `rotateX(${rot.x}deg) rotateY(${rot.y}deg)` }}
        >
          {courses.map((course, i) => {
            const isFocus = focus === i;
            return (
              <button
                key={course.id}
                type="button"
                className={`holo-tile ${isFocus ? "is-focus" : ""} ${
                  course.enrollmentStatus ? "is-enrolled" : ""
                }`}
                style={{
                  transform: spots[i]?.transform,
                  // Stagger so the rearrangement ripples instead of snapping.
                  transitionDelay: `${(i % 18) * 24}ms`,
                }}
                onMouseEnter={() => setFocus(i)}
                onMouseLeave={() => setFocus((f) => (f === i ? null : f))}
                onFocus={() => setFocus(i)}
                onBlur={() => setFocus((f) => (f === i ? null : f))}
                onClick={() => onLaunch(course)}
              >
                {/*
                  The face undoes the scene's rotation so the card always
                  presents square to the viewer. It sits on its own element,
                  without a transition, so continuous rotation stays crisp
                  while the position above still eases between layouts.
                */}
                <span
                  className="holo-tile__face"
                  style={{ transform: billboard }}
                >
                  <span className="holo-tile__n">{String(i + 1).padStart(2, "0")}</span>
                  <span className="holo-tile__sym">{courseSymbol(course.name)}</span>
                  <span className="holo-tile__name">{course.name}</span>
                  <span className="holo-tile__meta">
                    {course.courseType === "Curriculum"
                      ? "CURRICULUM"
                      : course.courseType === "InstructorLedCourse"
                        ? "INSTRUCTOR LED"
                        : "ONLINE"}
                  </span>
                  {course.enrollmentStatus ? (
                    <span className="holo-tile__state">{course.enrollmentStatus}</span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <footer className="holo-table__foot">
        <p>{organ.blurb}</p>
        <span className="holo-table__hint">
          Drag to rotate · select a module to open the player
        </span>
      </footer>
    </div>
  );
}
