/**
 * app/components/holographic/anatomy.ts
 *
 * Particle clouds scattered across real anatomical meshes.
 *
 * This replaces an earlier generator that built the figure from signed
 * distance fields — capsules and ellipsoids smooth-unioned together. That
 * approach could be tuned endlessly and still only ever produced something
 * that read as "roughly a person": the proportions were right and nothing
 * else was. Scattering over scanned anatomy costs about 1.2 MB of assets and
 * gets a body that is actually a body.
 *
 * Geometry comes from BodyParts3D, reduced and quantised at build time by
 * bp3d/pipeline/build.py into one .bin per structure. The renderer samples
 * them at runtime rather than loading baked point clouds, so the quality
 * tiers can scatter as many or as few particles as the device can carry
 * without shipping three versions of every organ.
 *
 *   BodyParts3D, (c) The Database Center for Life Science,
 *   licensed under CC Attribution-Share Alike 2.1 Japan.
 *
 * No THREE and no DOM beyond fetch, so the route, the engine and any test
 * can all share it.
 */

export type Vec3 = [number, number, number];

/** Floor of the scene. Everything is authored with the soles at -1.0. */
export const BODY_Y_OFFSET = 1.0;

/** Where the built assets are served from. */
export const ANATOMY_BASE = "/anatomy";

/**
 * The same structures at roughly four times the triangle budget.
 *
 * Facets are invisible to a point cloud, so the particle renderer is well
 * served by the small set and boots quickly on it. Drawing the same meshes
 * as shaded surfaces exposes every facet, which needs the dense set — but
 * only for the one structure being looked at, so it is fetched on demand
 * rather than at boot. About 700 KB per organ against 7.8 MB for all of them.
 */
export const ANATOMY_HIRES_BASE = "/anatomy/hi";

export type StructureId =
  | "skin"
  | "skeleton"
  | "heart"
  | "lungs"
  | "brain"
  | "liver"
  | "kidneys"
  | "digestive"
  | "muscular"
  | "eyes"
  | "vascular";

export type StructureMeta = {
  /** Vertex count; positions occupy verts * 6 bytes at the head of the file. */
  verts: number;
  tris: number;
  /** Dequantisation: world = (int16 + 32767) * scale + lo. */
  lo: Vec3;
  scale: Vec3;
  /** Index width in bits. Over 65535 vertices the file uses uint32. */
  index: 16 | 32;
  /** True when a uint8 region tag per triangle follows the indices. */
  regions: boolean;
  bytes: number;
  bbox: [Vec3, Vec3];
  label: string;
  /** Surface area in m², used to keep particle brightness consistent. */
  area: number;
  /**
   * How many surfaces a view ray crosses on average, relative to a simple
   * closed shape. 1 for an open tree, ~2 for a closed blob, higher where
   * the structure nests surfaces inside each other. Additive blending sums
   * all of them, so this is what stops a heart from out-glowing a torso.
   */
  depth: number;
  /** How many source meshes were merged. */
  sources: number;
  sourceTris: number;
  /** True where the surface was reconstructed rather than scanned. */
  reconstructed?: boolean;
  note?: string;
};

export type Manifest = {
  generator: string;
  /**
   * Content hash over every .bin in this set, written by the pipeline.
   *
   * It is the cache key: `loadMesh` appends it to each mesh URL, so a rebuild
   * changes every mesh URL and a browser can never pair this manifest with a
   * mesh from a different build. Optional only so an older manifest still
   * loads; without it the pairing is unprotected.
   */
  build?: string;
  source: string;
  attribution: string;
  space: {
    units: string;
    up: string;
    anterior: string;
    metresPerUnit: number;
    bodyYOffset: number;
  };
  structures: Partial<Record<StructureId, StructureMeta>>;
};

export type Mesh = {
  id: StructureId;
  positions: Float32Array;
  indices: Uint32Array;
  /** One tag per triangle, or null where the structure has none. */
  regions: Uint8Array | null;
  /** Prefix sum of triangle areas; last entry is the total. */
  cumulative: Float64Array;
  area: number;
  bbox: [Vec3, Vec3];
  centre: Vec3;
  meta: StructureMeta;
};

export type Cloud = {
  positions: Float32Array;
  sizes: Float32Array;
  seeds: Float32Array;
  regions: Float32Array;
  normals: Float32Array;
  count: number;
  /** Surface area the points were spread over, in m². */
  area: number;
};

/** Region ids baked into heart.bin. Mirrors REGION_RULES in the pipeline. */
export const HEART_REGION = {
  VENTRICLE: 0,
  ATRIUM: 1,
  VESSEL: 2,
  CORONARY: 3,
} as const;

/* ------------------------------------------------------------------ */
/* Random                                                               */
/* ------------------------------------------------------------------ */

/**
 * Mulberry32. Deterministic so a reload produces the same figure — a cloud
 * that reshuffles every refresh reads as noise rather than as a model.
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Loading                                                              */
/* ------------------------------------------------------------------ */

export async function loadManifest(base = ANATOMY_BASE): Promise<Manifest> {
  // `cache: "reload"` is load-bearing, not a precaution.
  //
  // remix-serve serves everything under build/client -- which includes
  // everything copied from public/ -- as
  // `Cache-Control: public, max-age=31536000, immutable`. That is right for
  // its own content-hashed bundles and wrong for these, which keep plain
  // names across every deploy. `immutable` means a browser will not
  // revalidate even on a normal reload, so a visitor can hold a year-old
  // manifest while deploys land invisibly.
  //
  // The Cloudflare rule that strips `immutable` matches only paths ending in
  // `.html`, so it does not cover this file.
  //
  // Everything else here depends on the manifest being the current one: it
  // supplies the build hash that keys every mesh URL below. Six kilobytes off
  // the network per page load is the whole cost.
  const res = await fetch(`${base}/manifest.json`, {
    headers: { Accept: "application/json" },
    cache: "reload",
  });
  if (!res.ok) throw new Error(`anatomy manifest: HTTP ${res.status}`);
  return (await res.json()) as Manifest;
}

/**
 * Fetches and decodes one structure.
 *
 * Positions are int16 quantised over the structure's own bounding box, which
 * at body scale puts the worst-case error around 30 µm — far below the
 * particle radius, and half the bytes of float32.
 */
export async function loadMesh(
  id: StructureId,
  manifest: Manifest,
  base = ANATOMY_BASE,
  signal?: AbortSignal
): Promise<Mesh> {
  const meta = manifest.structures[id];
  if (!meta) throw new Error(`anatomy: no structure "${id}" in manifest`);

  // The build hash keys the URL so this mesh can only ever be the one the
  // manifest describes. Without it the two files cache independently under a
  // one-year immutable policy and a browser will eventually hold a manifest
  // from one build beside a mesh from another -- which decodes as a
  // RangeError if the counts disagree, and as wild triangles if they happen
  // to agree. See loadManifest.
  const url = manifest.build
    ? `${base}/${id}.bin?v=${encodeURIComponent(manifest.build)}`
    : `${base}/${id}.bin`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`anatomy ${id}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();

  const nv = meta.verts;
  const nt = meta.tris;

  // Check the size before decoding anything. Reading past the end of the
  // buffer throws `Invalid typed array length: <n>`, which names the array it
  // tried to build and nothing about why -- it took a byte count and a
  // triangle count to work back to a stale manifest. Say so directly instead.
  const indexBytes = meta.index === 32 ? 4 : 2;
  const expected = nv * 6 + nt * 3 * indexBytes + (meta.regions ? nt : 0);
  if (buf.byteLength !== expected) {
    throw new Error(
      `anatomy ${id}: manifest and mesh disagree — manifest describes ` +
        `${nv} vertices and ${nt} triangles (${expected} bytes), file is ` +
        `${buf.byteLength} bytes. The two are from different builds; ` +
        `the cached copy of one of them is stale.`
    );
  }

  const q = new Int16Array(buf, 0, nv * 3);
  const positions = new Float32Array(nv * 3);
  const [lx, ly, lz] = meta.lo;
  const [sx, sy, sz] = meta.scale;
  for (let i = 0; i < nv; i++) {
    positions[i * 3] = (q[i * 3] + 32767) * sx + lx;
    positions[i * 3 + 1] = (q[i * 3 + 1] + 32767) * sy + ly;
    positions[i * 3 + 2] = (q[i * 3 + 2] + 32767) * sz + lz;
  }

  const idxOffset = nv * 6;
  const indices = new Uint32Array(nt * 3);
  if (meta.index === 32) {
    indices.set(new Uint32Array(buf, idxOffset, nt * 3));
  } else {
    const src = new Uint16Array(buf, idxOffset, nt * 3);
    for (let i = 0; i < src.length; i++) indices[i] = src[i];
  }

  // A size match is not proof the two files agree: decimation lands on the
  // same vertex and triangle counts often enough that two builds of the same
  // structure can be byte-for-byte the same length. An index past the end of
  // the vertex array is the giveaway, and it is the failure that does not
  // announce itself -- the mesh builds, and draws triangles stretching to
  // whatever happens to sit at that address.
  let maxIndex = 0;
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] > maxIndex) maxIndex = indices[i];
  }
  if (maxIndex >= nv) {
    throw new Error(
      `anatomy ${id}: triangle references vertex ${maxIndex} of ${nv}. ` +
        `The mesh and the manifest are from different builds.`
    );
  }

  const regionOffset = idxOffset + nt * 3 * (meta.index === 32 ? 4 : 2);
  const regions = meta.regions ? new Uint8Array(buf.slice(regionOffset, regionOffset + nt)) : null;

  // Prefix sums let a point pick its triangle in O(log n) with the right
  // probability. Float64 because 25k small areas summed in float32 drifts
  // enough to bias the tail of the distribution.
  const cumulative = new Float64Array(nt);
  let total = 0;
  for (let t = 0; t < nt; t++) {
    const a = indices[t * 3] * 3;
    const b = indices[t * 3 + 1] * 3;
    const c = indices[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    total += 0.5 * Math.hypot(cx, cy, cz);
    cumulative[t] = total;
  }

  const [lo, hi] = meta.bbox;
  return {
    id,
    positions,
    indices,
    regions,
    cumulative,
    area: total,
    bbox: meta.bbox,
    centre: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
    meta,
  };
}

/* ------------------------------------------------------------------ */
/* Sampling                                                             */
/* ------------------------------------------------------------------ */

export type SampleOptions = {
  /** Fraction of points pushed below the surface, for a sense of volume. */
  interior?: number;
  /** How far inward those points go, in metres. */
  interiorDepth?: number;
  /** Random displacement along the normal, in metres. Softens the shell. */
  shell?: number;
  sizeMin?: number;
  sizeMax?: number;
};

/** Largest index whose cumulative area is below x. */
function pickTriangle(cumulative: Float64Array, x: number): number {
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Scatters `count` particles uniformly over a mesh's surface.
 *
 * Uniform by area, not by triangle: picking triangles with equal probability
 * would pile points onto the dense little faces of the fingers and leave the
 * chest bare. The prefix-sum search weights each triangle by how much surface
 * it actually contributes.
 */
export function sampleMesh(
  mesh: Mesh,
  count: number,
  rng: () => number,
  options: SampleOptions = {}
): Cloud {
  const {
    interior = 0.12,
    interiorDepth = 0.02,
    shell = 0.003,
    sizeMin = 0.55,
    sizeMax = 1.4,
  } = options;

  const n = Math.max(1, Math.floor(count));
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  const seeds = new Float32Array(n);
  const regions = new Float32Array(n);

  const { cumulative, indices, positions: vp, regions: tri } = mesh;
  const total = cumulative[cumulative.length - 1] || 1;

  for (let i = 0; i < n; i++) {
    const t = pickTriangle(cumulative, rng() * total);
    const a = indices[t * 3] * 3;
    const b = indices[t * 3 + 1] * 3;
    const c = indices[t * 3 + 2] * 3;

    // Uniform barycentric coordinates: fold the unit square into the triangle.
    let u = rng();
    let v = rng();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }

    const ax = vp[a];
    const ay = vp[a + 1];
    const az = vp[a + 2];
    const ux = vp[b] - ax;
    const uy = vp[b + 1] - ay;
    const uz = vp[b + 2] - az;
    const wx = vp[c] - ax;
    const wy = vp[c + 1] - ay;
    const wz = vp[c + 2] - az;

    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    // Most points sit on the surface with a little jitter; a minority sink
    // inward so the volume reads as filled rather than as an empty shell.
    const inward = rng() < interior ? -rng() * interiorDepth : 0;
    const jitter = (rng() * 2 - 1) * shell;
    const off = inward + jitter;

    const o = i * 3;
    positions[o] = ax + ux * u + wx * v + nx * off;
    positions[o + 1] = ay + uy * u + wy * v + ny * off;
    positions[o + 2] = az + uz * u + wz * v + nz * off;
    normals[o] = nx;
    normals[o + 1] = ny;
    normals[o + 2] = nz;

    sizes[i] = sizeMin + rng() * (sizeMax - sizeMin);
    seeds[i] = rng();
    regions[i] = tri ? tri[t] : 0;
  }

  return { positions, sizes, seeds, regions, normals, count: n, area: mesh.area };
}

/* ------------------------------------------------------------------ */
/* Derived geometry                                                     */
/* ------------------------------------------------------------------ */

export const centreOf = (meta: StructureMeta): Vec3 => [
  (meta.bbox[0][0] + meta.bbox[1][0]) / 2,
  (meta.bbox[0][1] + meta.bbox[1][1]) / 2,
  (meta.bbox[0][2] + meta.bbox[1][2]) / 2,
];

export const extentOf = (meta: StructureMeta): Vec3 => [
  meta.bbox[1][0] - meta.bbox[0][0],
  meta.bbox[1][1] - meta.bbox[0][1],
  meta.bbox[1][2] - meta.bbox[0][2],
];

/** Radius of a sphere that comfortably contains the structure. */
export const radiusOf = (meta: StructureMeta): number => {
  const [x, y, z] = extentOf(meta);
  return 0.5 * Math.hypot(x, y, z);
};

/**
 * Splits a structure's triangles into left and right halves and returns a
 * hit sphere for each. Paired organs need two targets or a click between
 * the lungs lands on nothing.
 */
export function hitSpheres(meta: StructureMeta, paired: boolean): {
  center: Vec3;
  radius: number;
}[] {
  const c = centreOf(meta);
  const [ex, ey, ez] = extentOf(meta);
  if (!paired) {
    return [{ center: c, radius: 0.5 * Math.max(ex, ey, ez) * 0.72 }];
  }
  const dx = ex * 0.25;
  const r = 0.5 * Math.max(ex / 2, ey, ez) * 0.72;
  return [
    { center: [c[0] - dx, c[1], c[2]], radius: r },
    { center: [c[0] + dx, c[1], c[2]], radius: r },
  ];
}
