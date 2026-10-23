/**
 * Boots HoloEngine against a bare canvas, with no Remix and no React, so the
 * particle engine can be rendered and photographed headlessly.
 */
import { HoloEngine } from "../../app/components/holographic/holo-engine.client";

type W = Window & {
  __holo?: HoloEngine;
  __ready?: boolean;
  __progress?: [number, string][];
  __errors?: string[];
  __select?: (id: string) => void;
};

const w = window as W;
w.__progress = [];
w.__errors = [];

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const quality = (new URLSearchParams(location.search).get("q") ?? "medium") as
  | "low"
  | "medium"
  | "high";

const engine = new HoloEngine(
  canvas,
  { onProgress: (f: number, t: string) => w.__progress!.push([f, t]) },
  { quality, reducedMotion: false }
);

w.__holo = engine;
w.__select = (id: string) =>
  (engine as unknown as { setOrgan: (i: string | null) => void }).setOrgan(id);

engine
  .init()
  .then(() => {
    engine.start();
    w.__ready = true;
  })
  .catch((e: unknown) => {
    w.__errors!.push(String(e));
    w.__ready = true;
  });
