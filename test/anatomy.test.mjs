/**
 * test/anatomy.test.mjs
 *
 * Checks the anatomy assets and the sampler that reads them, with no
 * browser, no three.js and no bundler — anatomy.ts deliberately depends on
 * nothing but fetch, so it can be tested directly against the real files in
 * public/anatomy.
 *
 *   node --experimental-strip-types test/anatomy.test.mjs
 *
 * What this is actually guarding: the binary layout is agreed between a
 * Python build script and a TypeScript reader that share no code. Nothing
 * but a test that decodes a real file catches a drift between the two, and
 * the failure mode in the browser is a silent cloud of garbage rather than
 * an error.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(here, "..", "public", "anatomy");

// anatomy.ts calls fetch; serve it from disk.
//
// The query string is dropped before resolving the path, the way a static
// file server does: loadMesh appends the manifest's build hash as `?v=` so a
// rebuild changes every mesh URL, and keeping it here would look for a file
// named `skin.bin?v=...`.
globalThis.fetch = async (url) => {
  const rel = String(url).replace(/^.*\/anatomy\//, "").replace(/\?.*$/, "");
  const file = path.join(ASSETS, rel);
  const buf = await readFile(file);
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    json: async () => JSON.parse(buf.toString("utf8")),
  };
};

const {
  loadManifest, loadMesh, sampleMesh, makeRng,
  centreOf, extentOf, hitSpheres, HEART_REGION,
} = await import("../app/components/holographic/anatomy.ts");

let pass = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

const manifest = await loadManifest("/anatomy");
const ids = Object.keys(manifest.structures);

check("manifest lists structures", ids.length >= 10, `got ${ids.length}`);
check("manifest records attribution", /BodyParts3D/.test(manifest.attribution ?? ""));
check("manifest is in metres", manifest.space?.units === "metres");

const rng = makeRng(42);
let totalBytes = 0;

for (const id of ids) {
  const meta = manifest.structures[id];
  const mesh = await loadMesh(id, manifest, "/anatomy");
  totalBytes += meta.bytes;

  check(`${id}: vertex count matches manifest`,
    mesh.positions.length === meta.verts * 3);
  check(`${id}: triangle count matches manifest`,
    mesh.indices.length === meta.tris * 3);
  check(`${id}: every index is in range`,
    mesh.indices.every((i) => i < meta.verts),
    `max index ${Math.max(...mesh.indices)} of ${meta.verts}`);
  check(`${id}: surface area agrees with the build`,
    Math.abs(mesh.area - meta.area) / Math.max(meta.area, 1e-6) < 0.02,
    `runtime ${mesh.area.toFixed(4)} vs manifest ${meta.area}`);
  check(`${id}: cumulative areas increase`,
    mesh.cumulative.every((v, i) => i === 0 || v >= mesh.cumulative[i - 1]));

  // Decoded positions must land back inside the box the build recorded.
  const [lo, hi] = meta.bbox;
  let out = 0;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = mesh.positions[i + a];
      if (v < lo[a] - 1e-3 || v > hi[a] + 1e-3) out++;
    }
  }
  check(`${id}: decoded vertices sit inside the recorded bbox`, out === 0, `${out} outside`);

  // A sampled cloud: right size, inside the box plus the shell, finite.
  const n = 4000;
  const shell = 0.004;
  const cloud = sampleMesh(mesh, n, rng, { shell, interior: 0.1, interiorDepth: 0.02 });
  check(`${id}: cloud has the requested point count`, cloud.count === n);
  check(`${id}: cloud arrays are the right length`,
    cloud.positions.length === n * 3 && cloud.sizes.length === n &&
    cloud.normals.length === n * 3 && cloud.regions.length === n);

  let bad = 0, nonFinite = 0, badNormal = 0;
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const v = cloud.positions[i * 3 + a];
      if (!Number.isFinite(v)) nonFinite++;
      else if (v < lo[a] - 0.03 || v > hi[a] + 0.03) bad++;
    }
    const nx = cloud.normals[i * 3], ny = cloud.normals[i * 3 + 1], nz = cloud.normals[i * 3 + 2];
    if (Math.abs(Math.hypot(nx, ny, nz) - 1) > 1e-3) badNormal++;
  }
  check(`${id}: sampled points are finite`, nonFinite === 0, `${nonFinite} non-finite`);
  check(`${id}: sampled points stay near the surface`, bad === 0, `${bad} strays`);
  check(`${id}: normals are unit length`, badNormal === 0, `${badNormal} bad`);

  // Area-weighted sampling, not per-triangle: points should spread over the
  // whole structure rather than clustering on its densest corner.
  const [ex, ey, ez] = extentOf(meta);
  const span = Math.max(ex, ey, ez);
  if (span > 0.05) {
    const buckets = new Array(10).fill(0);
    const axis = ey >= ex && ey >= ez ? 1 : ex >= ez ? 0 : 2;
    for (let i = 0; i < n; i++) {
      const t = (cloud.positions[i * 3 + axis] - lo[axis]) / (hi[axis] - lo[axis]);
      buckets[Math.min(9, Math.max(0, Math.floor(t * 10)))]++;
    }
    const empty = buckets.filter((b) => b === 0).length;
    check(`${id}: sampling covers the structure`, empty <= 2,
      `${empty}/10 slices empty: ${buckets.join(",")}`);
  }
}

// The heart carries chamber tags; the cardiac animation is built on them.
const heart = await loadMesh("heart", manifest, "/anatomy");
check("heart ships region tags", heart.regions !== null);
const cloud = sampleMesh(heart, 8000, makeRng(7));
const seen = new Set(cloud.regions);
for (const [name, id] of Object.entries(HEART_REGION)) {
  check(`heart cloud contains ${name.toLowerCase()} points`, seen.has(id));
}

// Derived geometry the engine uses in place of hand-written coordinates.
const skin = manifest.structures.skin;
const [, sy] = extentOf(skin);
check("figure is roughly human height", sy > 1.6 && sy < 1.9, `${sy.toFixed(3)} m`);
check("figure stands on the floor",
  Math.abs(skin.bbox[0][1] + manifest.space.bodyYOffset) < 0.05,
  `soles at y=${skin.bbox[0][1]}`);
// +X is the subject's left, so a figure facing the camera has its left on
// the right of the screen. Confirmed against the source data: the mesh named
// "Left kidney" occupies positive X and "Right kidney" negative.
const heartCentre = centreOf(manifest.structures.heart);
const liverCentre = centreOf(manifest.structures.liver);
check("heart sits left of the midline", heartCentre[0] > 0, `x=${heartCentre[0].toFixed(3)}`);
check("liver sits right of the midline", liverCentre[0] < 0, `x=${liverCentre[0].toFixed(3)}`);
check("heart sits in the chest",
  heartCentre[1] > 0.15 && heartCentre[1] < 0.45, `y=${heartCentre[1].toFixed(3)}`);
const lungHits = hitSpheres(manifest.structures.lungs, true);
check("paired organs get two hit spheres", lungHits.length === 2);
check("the two lung spheres are on opposite sides",
  lungHits[0].center[0] < 0 && lungHits[1].center[0] > 0);

/* ---------------------------------------------------------------- *
 * Build pairing                                                      *
 *                                                                    *
 * On 27 Oct both browsers threw `Invalid typed array length: 77721`  *
 * on /holographic. 77721 is 3 x 25907 triangles; the skin had 25902. *
 * remix-serve sends everything copied from public/ as                *
 * `max-age=31536000, immutable`, and these files keep plain names    *
 * across deploys, so manifest.json and skin.bin cached independently *
 * and a browser ended up holding one from each of two builds. The    *
 * fix is a content hash in the manifest, appended to every mesh URL. *
 * ---------------------------------------------------------------- */

check("manifest carries a build hash", typeof manifest.build === "string" && manifest.build.length >= 8,
  String(manifest.build));

const hiManifest = await loadManifest("/anatomy/hi");
check("hi manifest carries a build hash", typeof hiManifest.build === "string" && hiManifest.build.length >= 8,
  String(hiManifest.build));
check("the two resolutions have distinct build hashes", manifest.build !== hiManifest.build);

// The hash must reach the wire, or it buys nothing.
const requested = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { requested.push(String(url)); return realFetch(url, init); };
await loadMesh("heart", manifest, "/anatomy");
globalThis.fetch = realFetch;
check("mesh URL carries the build hash",
  requested.some((u) => u.includes(`heart.bin?v=${manifest.build}`)), requested.join(" "));

// A mismatched pair must be named, not decoded. Both shapes it takes:
// different counts (the RangeError above) and identical byte length with
// different contents, which decimation produces often enough to matter.
const wrongCounts = {
  ...manifest,
  structures: { ...manifest.structures, heart: { ...manifest.structures.heart, tris: manifest.structures.heart.tris + 5 } },
};
let msg = "";
try { await loadMesh("heart", wrongCounts, "/anatomy"); } catch (e) { msg = e.message; }
check("a stale manifest is reported, not decoded",
  /different builds/.test(msg) && /heart/.test(msg), msg || "no error thrown");

const sameSize = {
  ...manifest,
  structures: {
    ...manifest.structures,
    heart: { ...manifest.structures.heart, verts: manifest.structures.heart.verts - 1, tris: manifest.structures.heart.tris + 1 },
  },
};
msg = "";
try { await loadMesh("heart", sameSize, "/anatomy"); } catch (e) { msg = e.message; }
check("an out-of-range triangle index is caught", /different builds/.test(msg), msg || "no error thrown");

console.log(`\n${pass} passed, ${failures.length} failed`);
console.log(`${ids.length} structures, ${(totalBytes / 1024).toFixed(0)} KB of geometry\n`);
if (failures.length) {
  for (const f of failures) console.error("  FAIL " + f);
  process.exit(1);
}
