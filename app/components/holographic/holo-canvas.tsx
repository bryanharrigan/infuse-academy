/**
 * app/components/holographic/holo-canvas.tsx
 *
 * React wrapper around HoloEngine. Owns the canvas element and the engine
 * lifecycle; everything else on the page is plain HTML layered on top.
 *
 * The engine is pulled in with a dynamic import inside the mount effect, so
 * three.js never touches the server render and lands in its own chunk.
 *
 * NOT named `.client.tsx`, deliberately. Remix's Vite plugin replaces any
 * `.client.*` module with an EMPTY module in the server build, so a route
 * importing this one would receive `undefined` and throw "Element type is
 * invalid" on every server render — a 500 that neither `tsc` nor
 * `remix vite:build` can catch, because neither server-renders a route.
 *
 * This component is safe to render on the server: it emits a bare <canvas>
 * and does every bit of WebGL work inside an effect, which never runs there.
 * The client-only boundary belongs one level down, on the engine itself,
 * which is `.client.ts` AND reached only through a dynamic import.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { OrganId } from "./organ-catalog";
import type { HoloEngine, LabelPosition } from "./holo-engine.client";

export type HoloCanvasHandle = {
  resetView: () => void;
  zoom: (delta: number) => void;
  setAutoRotate: (on: boolean) => void;
  /** Boot assembly and any camera flight have finished. */
  isSettled: () => boolean;
};

type Props = {
  activeOrgan: OrganId | null;
  xray: boolean;
  onHover: (id: OrganId | null) => void;
  onSelect: (id: OrganId | null) => void;
  onLabels: (labels: LabelPosition[]) => void;
  onReady: () => void;
  onProgress: (fraction: number, stage: string) => void;
  onHandle?: (handle: HoloCanvasHandle | null) => void;
  onError: (message: string) => void;
  /**
   * Forces a particle budget instead of detecting one. Mainly so the visual
   * tests can render the tier real hardware gets — every defect in the first
   * pass shipped because screenshots were taken at the low tier.
   */
  quality?: "low" | "medium" | "high";
};

export default function HoloCanvas({
  activeOrgan,
  xray,
  onHover,
  onSelect,
  onLabels,
  onReady,
  onProgress,
  onHandle,
  onError,
  quality,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<HoloEngine | null>(null);
  const [mounted, setMounted] = useState(false);

  // Callbacks are stashed in a ref so the engine's effect can depend on
  // nothing and never tear down mid-session when a parent re-renders.
  const cbRef = useRef({ onHover, onSelect, onLabels, onReady, onProgress, onError });
  cbRef.current = { onHover, onSelect, onLabels, onReady, onProgress, onError };

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let engine: HoloEngine | null = null;
    let cancelled = false;

    (async () => {
      try {
        if (!hasWebGL()) {
          cbRef.current.onError(
            "This browser reports no WebGL support, so the holographic volume cannot render."
          );
          return;
        }

        const mod = await import("./holo-engine.client");
        if (cancelled) return;

        const reducedMotion =
          window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

        engine = new mod.HoloEngine(
          canvas,
          {
            onHover: (id) => cbRef.current.onHover(id),
            onSelect: (id) => cbRef.current.onSelect(id),
            onLabels: (labels) => cbRef.current.onLabels(labels),
            onReady: () => cbRef.current.onReady(),
            onProgress: (f, s) => cbRef.current.onProgress(f, s),
          },
          { quality: quality ?? mod.detectQuality(), reducedMotion }
        );

        // Publish the engine only once init() has resolved.
        //
        // Assigning it first leaves a half-built engine wired to the prop
        // effects below if init() throws: the next activeOrgan change calls
        // setOrgan on an instance whose shader material was never created,
        // and the TypeError is raised inside a React effect, where it
        // escapes to the error boundary and takes the whole app down --
        // which signs the learner out. A mesh that failed to load should
        // cost the volume, not the session.
        await engine.init();
        if (cancelled) return;
        engine.resize();
        engineRef.current = engine;

        onHandle?.({
          resetView: () => engineRef.current?.resetView(),
          zoom: (d) => engineRef.current?.zoom(d),
          setAutoRotate: (on) => engineRef.current?.setAutoRotate(on),
          isSettled: () => engineRef.current?.isSettled() ?? false,
        });
      } catch (err) {
        // Whatever state init() got to, nothing may reach it now.
        engineRef.current = null;
        try {
          engine?.dispose();
        } catch {
          // A failed init can leave dispose() with nothing to free. The
          // original error is the one worth reporting.
        }
        engine = null;
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        cbRef.current.onError(message);
      }
    })();

    return () => {
      cancelled = true;
      onHandle?.(null);
      // Dispose the local reference, not the ref: the ref is only populated
      // after a successful init, so unmounting while init is still in flight
      // would otherwise strand an engine holding a WebGL context. The async
      // body re-checks `cancelled` before touching the engine again.
      engine?.dispose();
      engine = null;
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  // Pushing props into the engine is a side effect, not a re-render: the
  // engine owns its own animation state and only needs to be told the target.
  useEffect(() => {
    engineRef.current?.setOrgan(activeOrgan);
  }, [activeOrgan]);

  useEffect(() => {
    engineRef.current?.setXray(xray);
  }, [xray]);

  // Stop burning GPU on a tab nobody is looking at.
  useEffect(() => {
    const onVisibility = () =>
      engineRef.current?.setPaused(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const noop = useCallback((e: React.MouseEvent) => e.preventDefault(), []);

  return (
    <canvas
      ref={canvasRef}
      className="holo-canvas"
      onContextMenu={noop}
      aria-label="Interactive holographic human anatomy. Use the organ list for keyboard access."
    />
  );
}

/** Cheap capability probe — cheaper than letting the engine throw. */
function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(
      window.WebGLRenderingContext &&
      (c.getContext("webgl2") || c.getContext("webgl"))
    );
  } catch {
    return false;
  }
}
