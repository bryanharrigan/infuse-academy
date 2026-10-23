/**
 * app/components/holographic/anatomy.ts
 *
 * Procedural anatomical point-cloud generator for the /holographic route and
 * the Echocardiographic Windows SCORM module.
 *
 * WHY PROCEDURAL: shipping a rigged anatomical mesh would mean megabytes of
 * binary assets in the repo and a licence question for a pre-sales demo. The
 * body here is a signed distance field built from rotatable, profiled
 * capsules, surface-sampled into a point cloud.
 *
 * WHY AN SDF rather than a union of primitives. The earlier version sampled
 * each primitive's own surface and discarded points that fell inside another.
 * Two things went wrong with that. Overlapping primitives each contributed a
 * full surface, so wherever several met — the pelvis, the wrists, the whole
 * heart — additive blending stacked them into a white blob. And every join
 * was a hard intersection, so limbs read as a pile of cylinders rather than a
 * body. A smooth-min union solves both: there is exactly one surface, and it
 * flows organically through the joins.
 *
 * Everything is pure maths — no THREE import — so this module runs on the
 * server, in a test, or in a worker. It returns plain Float32Arrays.
 *
 * COORDINATES: metres, Y up, origin on the floor between the feet, facing +Z.
 * Patient's left is −X, so the figure reads as if you are facing it. A
 * standing adult is ~1.76m on an eight-head canon. `BODY_Y_OFFSET` recentres
 * the finished cloud on the origin.
 */

export type Vec3 = [number, number, number];

/**
 * A capsule swept along a→b, with a radius that either lerps ra→rb or follows
 * a `profile`, scaled in cross-section by (sx, sz) and rotated about `pivot`.
 * a === b gives an ellipsoid.
 */
export type Part = {
  a: Vec3;
  b: Vec3;
  ra: number;
  rb?: number;
  /**
   * Radii sampled evenly along the axis, interpolated between. This is what
   * gives a limb a real silhouette: a linear taper makes every arm a cone,
   * whereas a profile can carry the flexor belly and the narrow wrist.
   */
  profile?: number[];
  /** Cross-section scale, applied in part space before rotation. */
  sx?: number;
  sz?: number;
  /** Euler XYZ radians, applied about `pivot` after scaling. */
  rot?: Vec3;
  /** Rotation centre. Defaults to the midpoint of a→b. */
  pivot?: Vec3;
  /**
   * Smooth-union radius in metres. Larger blends further into neighbours.
   * 0 keeps the join sharp, which is what the great vessels want so they stay
   * readable as tubes rather than melting into the myocardium.
   */
  blend?: number;
  /** Include the hemispherical cap at the a / b end. Default true. */
  capA?: boolean;
  capB?: boolean;
  /**
   * Cuts a concave surface into the field — the diaphragm under the lungs,
   * the cardiac notch, the renal hilum, the flat inferior face of the liver.
   * The result is a proper curved surface, not an absence of points.
   */
  carve?: boolean;
  /**
   * Discards any point inside it. Used for the thin partings that should read
   * as a dark line rather than a surface: pulmonary fissures, the brain's
   * longitudinal fissure, the falciform ligament.
   */
  subtract?: boolean;
  /** Skip this part when seeding points, but keep it in the field. */
  noSeed?: boolean;
  /**
   * Sampling weight multiplier, default 1. A brightness control as much as a
   * density one: sampling is area-weighted, so a large closed mass takes most
   * of the budget and glares while thin structures fade out.
   */
  w?: number;
  /** Radial displacement, 0..1, applied as sinusoidal folds. For the brain. */
  gyri?: number;
  /** Group id written to `Cloud.regions`. The heart animates on these. */
  region?: number;
  /**
   * Independent field index. Everything on one layer blends together; layers
   * are sampled separately and concatenated.
   *
   * This is what lets internal structure survive. A bronchial tree inside the
   * lung, or a coronary artery lying on the myocardium, is inside the outer
   * isosurface — on the same layer its points would simply project out onto
   * that surface and vanish. On its own layer it keeps its own geometry.
   */
  layer?: number;
};

export type Cloud = {
  positions: Float32Array;
  sizes: Float32Array;
  seeds: Float32Array;
  regions: Float32Array;
  /** Outward surface normal, used for shell offsets and lighting cues. */
  normals: Float32Array;
  count: number;
  /**
   * Approximate sampled surface area in square metres.
   *
   * The renderer divides count by this to get points per unit area, which is
   * what actually determines how bright an additively-blended cloud looks. A
   * heart and a whole body given the same point count are wildly different
   * densities, and without this the small organs clip to white.
   */
  area: number;
};

export const BODY_Y_OFFSET = 1.0;

export const HEART_REGION = {
  VENTRICLE: 0,
  ATRIUM: 1,
  VESSEL: 2,
  CORONARY: 3,
} as const;

/* ------------------------------------------------------------------ */
/* Deterministic RNG                                                    */
/* ------------------------------------------------------------------ */

/** mulberry32. Seeded, so the body is identical on every load. */
export function makeRng(seed: number): () => number {
  let t = seed >>> 0;
  return function rng() {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Maths                                                                */
/* ------------------------------------------------------------------ */

const sub = (p: Vec3, q: Vec3): Vec3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const dot = (p: Vec3, q: Vec3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const len = (p: Vec3) => Math.sqrt(dot(p, p));
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function normalize(p: Vec3): Vec3 {
  const l = len(p) || 1;
  return [p[0] / l, p[1] / l, p[2] / l];
}

function cross(p: Vec3, q: Vec3): Vec3 {
  return [
    p[1] * q[2] - p[2] * q[1],
    p[2] * q[0] - p[0] * q[2],
    p[0] * q[1] - p[1] * q[0],
  ];
}

function perpendicular(n: Vec3): Vec3 {
  const ref: Vec3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  return normalize(cross(n, ref));
}

type Mat3 = [number, number, number, number, number, number, number, number, number];

/** Euler XYZ → row-major 3x3. R = Rz · Ry · Rx. */
function eulerMatrix(r: Vec3): Mat3 {
  const [x, y, z] = r;
  const cx = Math.cos(x), sx = Math.sin(x);
  const cy = Math.cos(y), sy = Math.sin(y);
  const cz = Math.cos(z), sz = Math.sin(z);
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}

const applyMat = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

/**
 * Polynomial smooth minimum. Blends two distance fields over a width of k,
 * which is what rounds a joint instead of creasing it.
 */
function smin(a: number, b: number, k: number): number {
  if (k <= 1e-6) return a < b ? a : b;
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return b * (1 - h) + a * h - k * h * (1 - h);
}

/** Smooth maximum, for carving a concave surface rather than a hard cut. */
function smax(a: number, b: number, k: number): number {
  if (k <= 1e-6) return a > b ? a : b;
  const h = clamp(0.5 - (0.5 * (b - a)) / k, 0, 1);
  return b * (1 - h) + a * h + k * h * (1 - h);
}

/* ------------------------------------------------------------------ */
/* Part caching                                                         */
/* ------------------------------------------------------------------ */

type PartCache = {
  part: Part;
  la: Vec3;
  lb: Vec3;
  axis: Vec3;
  axisLen: number;
  dir: Vec3;
  u: Vec3;
  v: Vec3;
  ra: number;
  rb: number;
  profile?: number[];
  maxR: number;
  sx: number;
  sz: number;
  minScale: number;
  area: number;
  rot?: Mat3;
  rotInv?: Mat3;
  pivot: Vec3;
  blend: number;
  region: number;
  /** World-space AABB, expanded by blend. Drives the spatial grid. */
  lo: Vec3;
  hi: Vec3;
};

function radiusAt(c: PartCache, t: number): number {
  const p = c.profile;
  if (!p) return c.ra + (c.rb - c.ra) * t;
  const n = p.length - 1;
  if (n === 0) return p[0];
  const x = clamp(t, 0, 1) * n;
  const i = Math.min(n - 1, Math.floor(x));
  const f = x - i;
  // Catmull-Rom, clamped at the ends. Interpolating linearly would leave a
  // slope discontinuity at every sample; on a blended isosurface that is a
  // crease, and the projection step concentrates points into creases, which
  // draws a bright ring around the limb at each profile sample.
  const p0 = p[i > 0 ? i - 1 : 0];
  const p1 = p[i];
  const p2 = p[i + 1];
  const p3 = p[i + 2 <= n ? i + 2 : n];
  const f2 = f * f;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * f +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * f2 * f)
  );
}

function cachePart(part: Part): PartCache {
  const axis = sub(part.b, part.a);
  const axisLen = len(axis);
  const dir: Vec3 = axisLen > 1e-6 ? normalize(axis) : [0, 1, 0];
  const u = perpendicular(dir);
  const v = cross(dir, u);
  const ra = part.profile ? part.profile[0] : part.ra;
  const rb = part.profile ? part.profile[part.profile.length - 1] : part.rb ?? part.ra;
  const maxR = part.profile ? Math.max(...part.profile) : Math.max(ra, rb);
  const sx = part.sx ?? 1;
  const sz = part.sz ?? 1;
  const pivot: Vec3 =
    part.pivot ??
    [(part.a[0] + part.b[0]) / 2, (part.a[1] + part.b[1]) / 2, (part.a[2] + part.b[2]) / 2];
  const rot = part.rot ? eulerMatrix(part.rot) : undefined;

  const meanScale = (sx + sz) / 2;
  const meanR = part.profile
    ? part.profile.reduce((s, r) => s + r, 0) / part.profile.length
    : (ra + rb) / 2;
  const lateral = 2 * Math.PI * meanR * axisLen * meanScale;
  const capA = part.capA === false ? 0 : 2 * Math.PI * ra * ra * meanScale;
  const capB = part.capB === false ? 0 : 2 * Math.PI * rb * rb * meanScale;

  const c: PartCache = {
    part,
    la: sub(part.a, pivot),
    lb: sub(part.b, pivot),
    axis,
    axisLen,
    dir,
    u,
    v,
    ra,
    rb,
    profile: part.profile,
    maxR,
    sx,
    sz,
    minScale: Math.min(sx, 1, sz),
    area: Math.max(lateral + capA + capB, 1e-6) * (part.w ?? 1),
    rot,
    rotInv: rot ? transpose(rot) : undefined,
    pivot,
    blend: part.blend ?? 0,
    region: part.region ?? 0,
    lo: [0, 0, 0],
    hi: [0, 0, 0],
  };

  // Conservative world AABB: the part's extent in its own frame, scaled, then
  // bounded by the rotation's worst case (the corner radius), plus blend.
  const reach = c.maxR * Math.max(sx, 1, sz) + c.blend + 0.02;
  const ax: Vec3 = [part.a[0], part.a[1], part.a[2]];
  const bx: Vec3 = [part.b[0], part.b[1], part.b[2]];
  for (let i = 0; i < 3; i++) {
    c.lo[i] = Math.min(ax[i], bx[i]) - reach;
    c.hi[i] = Math.max(ax[i], bx[i]) + reach;
  }
  if (rot) {
    // A rotated part can swing out to the pivot distance plus its extent.
    const r = Math.max(len(sub(ax, pivot)), len(sub(bx, pivot))) + reach;
    for (let i = 0; i < 3; i++) {
      c.lo[i] = Math.min(c.lo[i], pivot[i] - r);
      c.hi[i] = Math.max(c.hi[i], pivot[i] + r);
    }
  }
  return c;
}

/** Sinusoidal radial folds — turns a smooth ellipsoid into a gyrified brain. */
function gyriFactor(amount: number, x: number, y: number, z: number): number {
  if (!amount) return 1;
  const f =
    Math.sin(x * 46) * Math.sin(y * 38) +
    Math.sin(y * 52 + 1.7) * Math.sin(z * 41) +
    Math.sin(z * 44 + 0.6) * Math.sin(x * 36);
  return 1 + amount * f * 0.33;
}

/** Signed distance from a world point to one part's surface. */
function partDistance(c: PartCache, world: Vec3): number {
  let rel = sub(world, c.pivot);
  if (c.rotInv) rel = applyMat(c.rotInv, rel);
  const q: Vec3 = [rel[0] / c.sx, rel[1], rel[2] / c.sz];

  const ab = sub(c.lb, c.la);
  const ap = sub(q, c.la);
  const abLenSq = dot(ab, ab);
  const t = abLenSq > 1e-9 ? clamp(dot(ap, ab) / abLenSq, 0, 1) : 0;
  const closest: Vec3 = [
    c.la[0] + ab[0] * t,
    c.la[1] + ab[1] * t,
    c.la[2] + ab[2] * t,
  ];
  const r = radiusAt(c, t) * gyriFactor(c.part.gyri ?? 0, q[0], q[1], q[2]);
  // Multiplying by the smallest scale keeps the field a conservative
  // (under-)estimate of true distance, so the projection never overshoots.
  return (len(sub(q, closest)) - r) * c.minScale;
}

/* ------------------------------------------------------------------ */
/* The field                                                            */
/* ------------------------------------------------------------------ */

const GRID_CELL = 0.05;
const GRID_SPAN = 2048;

const cellKey = (x: number, y: number, z: number) =>
  (x + 512) + (y + 512) * GRID_SPAN + (z + 512) * GRID_SPAN * GRID_SPAN;

type Field = {
  add: PartCache[];
  carve: PartCache[];
  cut: PartCache[];
  grid: Map<number, number[]>;
  /** Scratch, reused across evaluations to keep the sampler allocation-free. */
  scratch: Float64Array;
};

function buildField(parts: Part[]): Field {
  const caches = parts.map(cachePart);
  const add = caches.filter((c) => !c.part.carve && !c.part.subtract);
  const carve = caches.filter((c) => c.part.carve);
  const cut = caches.filter((c) => c.part.subtract);

  // Bucket the additive and carving parts so a field evaluation only touches
  // the handful of parts near the point, not all ~80 of them.
  const grid = new Map<number, number[]>();
  const indexed = [...add, ...carve];
  indexed.forEach((c, i) => {
    const x0 = Math.floor(c.lo[0] / GRID_CELL), x1 = Math.floor(c.hi[0] / GRID_CELL);
    const y0 = Math.floor(c.lo[1] / GRID_CELL), y1 = Math.floor(c.hi[1] / GRID_CELL);
    const z0 = Math.floor(c.lo[2] / GRID_CELL), z1 = Math.floor(c.hi[2] / GRID_CELL);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++) {
          const k = cellKey(x, y, z);
          const list = grid.get(k);
          if (list) list.push(i);
          else grid.set(k, [i]);
        }
  });

  return { add, carve, cut, grid, scratch: new Float64Array(indexed.length) };
}

function candidates(f: Field, p: Vec3): number[] | undefined {
  return f.grid.get(
    cellKey(
      Math.floor(p[0] / GRID_CELL),
      Math.floor(p[1] / GRID_CELL),
      Math.floor(p[2] / GRID_CELL)
    )
  );
}

type FieldSample = { d: number; region: number; influence: number };

const EMPTY: FieldSample = { d: 1, region: 0, influence: 1 };

/**
 * Evaluates the blended field at p.
 *
 * `influence` counts how many parts are within blending range of the nearest
 * one. It is the density correction: where several primitives meet, several
 * seed surfaces project onto the same blended surface, and without dividing
 * the keep-probability by this count the joins come out several times denser
 * than flat regions — which is exactly what made the pelvis and wrists glare.
 */
function evalField(f: Field, p: Vec3, out: FieldSample): FieldSample {
  const list = candidates(f, p);
  if (!list || list.length === 0) {
    out.d = EMPTY.d;
    out.region = 0;
    out.influence = 1;
    return out;
  }

  const nAdd = f.add.length;
  let d = Infinity;
  let best = Infinity;
  let region = 0;
  let count = 0;

  for (let i = 0; i < list.length; i++) {
    const idx = list[i];
    if (idx >= nAdd) continue;
    const c = f.add[idx];
    const di = partDistance(c, p);
    f.scratch[count++] = di;
    if (di < best) {
      best = di;
      region = c.region;
    }
    d = d === Infinity ? di : smin(d, di, c.blend);
  }

  if (count === 0) {
    out.d = EMPTY.d;
    out.region = 0;
    out.influence = 1;
    return out;
  }

  // How many parts actually contribute surface here.
  let influence = 0;
  const window = 0.012;
  for (let i = 0; i < count; i++) if (f.scratch[i] < best + window) influence++;

  for (let i = 0; i < list.length; i++) {
    const idx = list[i];
    if (idx < nAdd) continue;
    const c = f.carve[idx - nAdd];
    d = smax(d, -partDistance(c, p), c.blend);
  }

  out.d = d;
  out.region = region;
  out.influence = influence < 1 ? 1 : influence;
  return out;
}

const GRAD_EPS = 0.0012;

/** Four-tap tetrahedron gradient; cheaper than six-tap central differences. */
function fieldNormal(f: Field, p: Vec3, s: FieldSample): Vec3 {
  const e = GRAD_EPS;
  const k0: Vec3 = [p[0] + e, p[1] - e, p[2] - e];
  const k1: Vec3 = [p[0] - e, p[1] - e, p[2] + e];
  const k2: Vec3 = [p[0] - e, p[1] + e, p[2] - e];
  const k3: Vec3 = [p[0] + e, p[1] + e, p[2] + e];
  const d0 = evalField(f, k0, s).d;
  const d1 = evalField(f, k1, s).d;
  const d2 = evalField(f, k2, s).d;
  const d3 = evalField(f, k3, s).d;
  return normalize([
    d0 - d1 - d2 + d3,
    -d0 - d1 + d2 + d3,
    -d0 + d1 - d2 + d3,
  ]);
}

/* ------------------------------------------------------------------ */
/* Seeding                                                              */
/* ------------------------------------------------------------------ */

/** A point on one part's own surface, used as a seed for projection. */
function seedOnPart(c: PartCache, rng: () => number): Vec3 {
  const { part } = c;
  const wantCapA = part.capA !== false;
  const wantCapB = part.capB !== false;

  const lateralW = 2 * Math.PI * ((c.ra + c.rb) / 2) * c.axisLen;
  const capAW = wantCapA ? 2 * Math.PI * c.ra * c.ra : 0;
  const capBW = wantCapB ? 2 * Math.PI * c.rb * c.rb : 0;
  const total = lateralW + capAW + capBW || 1;

  const pick = rng() * total;
  const theta = rng() * Math.PI * 2;
  const ct = Math.cos(theta);
  const st = Math.sin(theta);

  let base: Vec3;

  if (pick < lateralW || c.axisLen < 1e-6) {
    if (c.axisLen < 1e-6) {
      const z = rng() * 2 - 1;
      const rxy = Math.sqrt(Math.max(0, 1 - z * z));
      const n: Vec3 = [rxy * ct, rxy * st, z];
      base = [c.la[0] + n[0] * c.ra, c.la[1] + n[1] * c.ra, c.la[2] + n[2] * c.ra];
    } else {
      const t = rng();
      const r = radiusAt(c, t);
      const n: Vec3 = [
        c.u[0] * ct + c.v[0] * st,
        c.u[1] * ct + c.v[1] * st,
        c.u[2] * ct + c.v[2] * st,
      ];
      base = [
        c.la[0] + c.axis[0] * t + n[0] * r,
        c.la[1] + c.axis[1] * t + n[1] * r,
        c.la[2] + c.axis[2] * t + n[2] * r,
      ];
    }
  } else {
    const atA = pick < lateralW + capAW;
    const origin = atA ? c.la : c.lb;
    const r = atA ? c.ra : c.rb;
    const sign = atA ? -1 : 1;
    const z = rng();
    const rxy = Math.sqrt(Math.max(0, 1 - z * z));
    const n: Vec3 = [
      c.u[0] * rxy * ct + c.v[0] * rxy * st + c.dir[0] * z * sign,
      c.u[1] * rxy * ct + c.v[1] * rxy * st + c.dir[1] * z * sign,
      c.u[2] * rxy * ct + c.v[2] * rxy * st + c.dir[2] * z * sign,
    ];
    base = [origin[0] + n[0] * r, origin[1] + n[1] * r, origin[2] + n[2] * r];
  }

  const g = gyriFactor(c.part.gyri ?? 0, base[0], base[1], base[2]);
  if (g !== 1) base = [base[0] * g, base[1] * g, base[2] * g];

  let p: Vec3 = [base[0] * c.sx, base[1], base[2] * c.sz];
  if (c.rot) p = applyMat(c.rot, p);
  return [p[0] + c.pivot[0], p[1] + c.pivot[1], p[2] + c.pivot[2]];
}

/* ------------------------------------------------------------------ */
/* Cloud builder                                                        */
/* ------------------------------------------------------------------ */

type BuildOptions = {
  /** Fraction of points placed inside the shell rather than on it. */
  interior?: number;
  /** Half-thickness of the shell, in metres. */
  shell?: number;
  sizeMin?: number;
  sizeMax?: number;
  /** Subtract this from every Y. Defaults to BODY_Y_OFFSET. */
  yOffset?: number;
};

/**
 * Samples the blended isosurface into a point cloud.
 *
 * Seeds come from the individual primitives — cheap, and already close to the
 * answer — then a few Newton steps along the gradient pull each one onto the
 * single blended surface. Points that cannot be projected, that land inside a
 * `subtract` part, or that lose the density lottery at a join are discarded.
 */
function buildLayer(
  parts: Part[],
  count: number,
  rng: () => number,
  opts: BuildOptions = {}
): Cloud {
  const {
    interior = 0.12,
    shell = 0.0035,
    sizeMin = 0.6,
    sizeMax = 1.5,
    yOffset = BODY_Y_OFFSET,
  } = opts;

  const field = buildField(parts);
  const seedable = field.add.filter((c) => !c.part.noSeed);

  const cumulative: number[] = [];
  let areaTotal = 0;
  for (const c of seedable) {
    areaTotal += c.area;
    cumulative.push(areaTotal);
  }

  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const seeds = new Float32Array(count);
  const regions = new Float32Array(count);

  const s: FieldSample = { d: 0, region: 0, influence: 1 };
  const TOL = 0.0007;
  let written = 0;
  const maxAttempts = count * 40;

  for (let attempt = 0; attempt < maxAttempts && written < count; attempt++) {
    const target = rng() * areaTotal;
    let idx = 0;
    while (idx < cumulative.length - 1 && cumulative[idx] < target) idx++;

    let p = seedOnPart(seedable[idx], rng);

    // Project onto the blended surface.
    let d = evalField(field, p, s).d;
    let n: Vec3 = [0, 1, 0];
    for (let step = 0; step < 5; step++) {
      if (Math.abs(d) < TOL) break;
      n = fieldNormal(field, p, s);
      p = [p[0] - n[0] * d, p[1] - n[1] * d, p[2] - n[2] * d];
      d = evalField(field, p, s).d;
    }
    if (Math.abs(d) > TOL * 4) continue;

    evalField(field, p, s);
    // Density correction at joins: several seeds converge on the same patch
    // of blended surface, so thin them in proportion to how many.
    if (s.influence > 1 && rng() > 1 / s.influence) continue;

    let inCut = false;
    for (let i = 0; i < field.cut.length; i++) {
      if (partDistance(field.cut[i], p) < 0) { inCut = true; break; }
    }
    if (inCut) continue;

    n = fieldNormal(field, p, s);

    const inward = rng() < interior;
    const off = inward ? -(0.004 + rng() * 0.030) : (rng() - 0.5) * 2 * shell;
    const o = written * 3;
    positions[o] = p[0] + n[0] * off;
    positions[o + 1] = p[1] + n[1] * off - yOffset;
    positions[o + 2] = p[2] + n[2] * off;
    normals[o] = n[0];
    normals[o + 1] = n[1];
    normals[o + 2] = n[2];

    const sz = sizeMin + rng() * (sizeMax - sizeMin);
    sizes[written] = inward ? sz * 0.6 : sz;
    seeds[written] = rng();
    regions[written] = s.region;
    written++;
  }

  // Ran short (heavy carving rejects a lot) — fold the cloud back on itself
  // rather than shipping zeroes, which would render as a blob at the origin.
  for (let i = written; i < count; i++) {
    const src = (i % Math.max(written, 1)) * 3;
    const o = i * 3;
    positions[o] = positions[src];
    positions[o + 1] = positions[src + 1];
    positions[o + 2] = positions[src + 2];
    normals[o] = normals[src];
    normals[o + 1] = normals[src + 1];
    normals[o + 2] = normals[src + 2];
    sizes[i] = sizes[i % Math.max(written, 1)];
    seeds[i] = rng();
    regions[i] = regions[i % Math.max(written, 1)];
  }

  return { positions, sizes, seeds, regions, normals, count, area: areaTotal };
}

/**
 * Samples a part list into a point cloud, one independent field per `layer`.
 *
 * The budget is split between layers by their total sampling area, so a thin
 * bronchial tree does not take the share of a whole lung — the `w` weights
 * are the dial for pushing a layer up or down.
 */
export function buildCloud(
  parts: Part[],
  count: number,
  rng: () => number,
  opts: BuildOptions = {}
): Cloud {
  const byLayer = new Map<number, Part[]>();
  for (const p of parts) {
    const k = p.layer ?? 0;
    const list = byLayer.get(k);
    if (list) list.push(p);
    else byLayer.set(k, [p]);
  }
  if (byLayer.size === 1) return buildLayer(parts, count, rng, opts);

  const keys = [...byLayer.keys()].sort((a, b) => a - b);
  const areas = keys.map((k) =>
    (byLayer.get(k) as Part[])
      .filter((p) => !p.carve && !p.subtract && !p.noSeed)
      .reduce((sum, p) => sum + cachePart(p).area, 0)
  );
  const areaTotal = areas.reduce((a, b) => a + b, 0) || 1;

  const clouds: Cloud[] = [];
  let allocated = 0;
  keys.forEach((k, i) => {
    const n =
      i === keys.length - 1
        ? count - allocated
        : Math.max(1, Math.round((areas[i] / areaTotal) * count));
    allocated += n;
    // Carves and subtracts only shape their own layer; a fissure in the lung
    // should not punch a hole in the bronchial tree.
    clouds.push(buildLayer(byLayer.get(k) as Part[], n, rng, opts));
  });

  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const seeds = new Float32Array(count);
  const regions = new Float32Array(count);
  let cursor = 0;
  for (const c of clouds) {
    positions.set(c.positions.subarray(0, c.count * 3), cursor * 3);
    normals.set(c.normals.subarray(0, c.count * 3), cursor * 3);
    sizes.set(c.sizes.subarray(0, c.count), cursor);
    seeds.set(c.seeds.subarray(0, c.count), cursor);
    regions.set(c.regions.subarray(0, c.count), cursor);
    cursor += c.count;
  }
  return {
    positions, sizes, seeds, regions, normals, count,
    area: clouds.reduce((sum, c) => sum + c.area, 0),
  };
}

/* ------------------------------------------------------------------ */
/* Primitive helpers                                                    */
/* ------------------------------------------------------------------ */

const DEG = Math.PI / 180;

/** Ellipsoid centred at c with radii (rx, ry, rz). */
function ellipsoid(
  c: Vec3,
  rx: number,
  ry: number,
  rz: number,
  extra: Partial<Part> = {}
): Part {
  return { a: c, b: c, ra: ry, sx: rx / ry, sz: rz / ry, pivot: c, ...extra };
}

/** A limb segment whose radius follows a profile along its axis. */
function limb(a: Vec3, b: Vec3, profile: number[], extra: Partial<Part> = {}): Part {
  return { a, b, ra: profile[0], profile, ...extra };
}

/** A polyline swept by a radius that lerps r0→r1 across the whole run. */
function tube(
  points: Vec3[],
  r0: number,
  r1: number,
  extra: Partial<Part> = {}
): Part[] {
  const out: Part[] = [];
  const segs = points.length - 1;
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs;
    const t1 = (i + 1) / segs;
    out.push({
      a: points[i],
      b: points[i + 1],
      ra: r0 + (r1 - r0) * t0,
      rb: r0 + (r1 - r0) * t1,
      capA: i === 0,
      capB: i === segs - 1,
      ...extra,
    });
  }
  return out;
}

/**
 * A thin oriented disc used as a `subtract`, which parts the cloud into two
 * surfaces with a dark line between — a fissure, not a carved bowl.
 */
function fissure(c: Vec3, r: number, thickness: number, rot: Vec3): Part {
  return {
    a: c, b: c, ra: thickness,
    sx: r / thickness, sz: r / thickness,
    rot, pivot: c, subtract: true,
  };
}

/** A rounded mass that carves a concave surface into the field. */
function carve(
  c: Vec3,
  rx: number,
  ry: number,
  rz: number,
  blend = 0.02,
  extra: Partial<Part> = {}
): Part {
  return ellipsoid(c, rx, ry, rz, { carve: true, blend, ...extra });
}

function mirror(part: Part): Part {
  const m: Part = {
    ...part,
    a: [-part.a[0], part.a[1], part.a[2]],
    b: [-part.b[0], part.b[1], part.b[2]],
  };
  if (part.pivot) m.pivot = [-part.pivot[0], part.pivot[1], part.pivot[2]];
  if (part.rot) m.rot = [part.rot[0], -part.rot[1], -part.rot[2]];
  return m;
}

const pair = (parts: Part[]): Part[] => [...parts, ...parts.map(mirror)];

/* ------------------------------------------------------------------ */
/* The body                                                            */
/* ------------------------------------------------------------------ */

/**
 * Standing adult, ~1.76m on an eight-head canon. Landmarks: shoulder line
 * 1.45, nipple 1.30, navel 1.09, pubic symphysis 0.88 (the halfway point),
 * knee 0.49, ankle 0.08.
 *
 * The trunk is a single profiled part rather than a stack of frusta, so the
 * shoulders, ribcage flare, waist and hips are one continuous surface. The
 * limbs likewise carry their muscle bellies in the profile instead of having
 * separate bulge ellipsoids laid over them — which is both a better
 * silhouette and the reason the figure no longer glares at every joint.
 *
 * The pelvis is anatomically neutral by construction: a single smooth surface
 * with the inner-thigh cleft produced by one carve on the midline, so there
 * is no genital geometry to include or omit.
 */
export function bodyParts(): Part[] {
  const armL: Part[] = [
    ellipsoid([-0.168, 1.408, 0.000], 0.058, 0.072, 0.060, { blend: 0.05 }),
    // humerus envelope: deltoid insertion, biceps belly, taper to the elbow
    limb(
      [-0.176, 1.398, 0.002],
      [-0.234, 1.128, 0.008],
      [0.046, 0.052, 0.050, 0.043, 0.036],
      { blend: 0.045, capA: false }
    ),
    ellipsoid([-0.236, 1.120, 0.008], 0.040, 0.038, 0.040, { blend: 0.035, w: 0.7 }),
    // forearm: flexor mass high, narrow wrist
    limb(
      [-0.238, 1.114, 0.010],
      [-0.284, 0.860, 0.030],
      [0.040, 0.046, 0.042, 0.033, 0.025],
      { blend: 0.04, capA: false }
    ),
    // palm
    { a: [-0.286, 0.852, 0.032], b: [-0.293, 0.794, 0.038], ra: 0.030, rb: 0.028, sz: 0.44, blend: 0.018, capA: false, w: 0.7 },
    // thumb, opposed
    { a: [-0.268, 0.838, 0.046], b: [-0.254, 0.794, 0.060], ra: 0.0115, rb: 0.009, blend: 0.010, w: 0.3 },
  ];
  for (let f = 0; f < 4; f++) {
    const o = (f - 1.5) * 0.0145;
    const lenScale = 1 - Math.abs(f - 1.1) * 0.09;
    armL.push({
      a: [-0.291 + o * 0.25, 0.792, 0.036 + o],
      b: [-0.297 + o * 0.5, 0.792 - 0.060 * lenScale, 0.039 + o * 1.2],
      ra: 0.0092,
      rb: 0.0068,
      blend: 0.006,
      w: 0.22,
    });
  }

  const legL: Part[] = [
    // thigh: quadriceps mass high, narrowing above the knee
    limb(
      [-0.092, 0.902, -0.006],
      [-0.100, 0.518, 0.004],
      [0.090, 0.093, 0.085, 0.072, 0.060],
      { blend: 0.055, capA: false }
    ),
    ellipsoid([-0.100, 0.506, 0.008], 0.055, 0.050, 0.056, { blend: 0.035, w: 0.7 }),
    // shin: gastrocnemius belly high, narrow ankle
    limb(
      [-0.100, 0.498, 0.004],
      [-0.104, 0.092, -0.004],
      [0.054, 0.058, 0.049, 0.038, 0.029],
      { blend: 0.04, capA: false }
    ),
    ellipsoid([-0.104, 0.080, -0.012], 0.034, 0.032, 0.038, { blend: 0.025, w: 0.6 }),
    ellipsoid([-0.104, 0.040, -0.050], 0.032, 0.031, 0.030, { blend: 0.025, w: 0.5 }),
    { a: [-0.104, 0.050, -0.034], b: [-0.100, 0.026, 0.086], ra: 0.036, rb: 0.026, sx: 0.92, blend: 0.022, capA: false, w: 0.7 },
  ];
  for (let t = 0; t < 4; t++) {
    const o = (t - 1.5) * 0.0135;
    legL.push({
      a: [-0.100 + o * 0.6, 0.027, 0.084],
      b: [-0.099 + o, 0.024, 0.100 - Math.abs(t - 0.6) * 0.004],
      ra: 0.0092,
      rb: 0.0078,
      blend: 0.005,
      w: 0.14,
    });
  }

  return [
    /* ---- head ---- */
    ellipsoid([0, 1.656, 0.000], 0.086, 0.098, 0.100, { blend: 0.030, w: 0.8 }),
    ellipsoid([0, 1.638, -0.050], 0.068, 0.072, 0.052, { blend: 0.035, w: 0.4 }),
    ellipsoid([0, 1.608, 0.046], 0.064, 0.056, 0.050, { blend: 0.030, w: 0.5 }),
    ellipsoid([0, 1.570, 0.026], 0.058, 0.044, 0.058, { blend: 0.028, w: 0.5 }),
    ellipsoid([0, 1.552, 0.056], 0.028, 0.026, 0.026, { blend: 0.020, w: 0.25 }),
    ellipsoid([0, 1.616, 0.086], 0.014, 0.020, 0.018, { blend: 0.008, w: 0.15 }),
    ...pair([ellipsoid([-0.088, 1.646, -0.008], 0.010, 0.027, 0.019, { blend: 0.008, w: 0.18 })]),
    // orbits, so the face has brow and eye definition rather than a blank egg
    ...pair([carve([-0.032, 1.620, 0.072], 0.019, 0.017, 0.018, 0.012)]),

    /* ---- neck, widening into the trapezius ---- */
    limb([0, 1.446, -0.006], [0, 1.554, 0.004], [0.064, 0.053, 0.050, 0.054], {
      sz: 0.92, blend: 0.045, capB: false,
    }),
    // clavicle-level bridge from neck to shoulders
    { a: [-0.145, 1.442, -0.010], b: [0.145, 1.442, -0.010], ra: 0.066, sz: 0.78, blend: 0.06, capA: false, capB: false },

    /* ---- trunk: one surface from shoulders to seat ---- */
    limb(
      [0, 1.452, 0.002],
      [0, 0.856, -0.014],
      [0.148, 0.162, 0.167, 0.158, 0.141, 0.130, 0.140, 0.154, 0.130],
      { sz: 0.62, blend: 0.05, capA: false, capB: false, w: 1.15 }
    ),
    // the pelvis is deeper front-to-back than the constant trunk flattening
    ellipsoid([0, 0.908, -0.014], 0.150, 0.078, 0.112, { blend: 0.06, w: 0.5 }),
    // pectorals and scapulae, blended broadly so they read as modelling
    ...pair([ellipsoid([-0.068, 1.330, 0.068], 0.072, 0.048, 0.034, { blend: 0.05, w: 0.35 })]),
    ...pair([ellipsoid([-0.076, 1.368, -0.072], 0.076, 0.086, 0.028, { blend: 0.05, w: 0.3 })]),
    ellipsoid([0, 1.118, 0.050], 0.096, 0.088, 0.034, { blend: 0.05, w: 0.3 }),

    // Inner-thigh cleft. One carve on the midline separates the legs and
    // closes the perineum into a smooth continuous surface.
    carve([0, 0.782, 0.004], 0.030, 0.150, 0.105, 0.035),

    ...pair(armL),
    ...pair(legL),
  ];
}

/* ------------------------------------------------------------------ */
/* Heart                                                                */
/* ------------------------------------------------------------------ */

/** Centre of the heart in floor coordinates. Exported for camera framing. */
export const HEART_CENTRE: Vec3 = [-0.030, 1.245, 0.028];

/**
 * Heart — left of midline, long axis running down-left-forward from base to
 * apex, which is the orientation that makes the echo windows make sense.
 *
 * The chambers read as chambers because two grooves are carved into the
 * field: the anterior interventricular sulcus between the ventricles, and
 * the atrioventricular groove at the valve plane. Without them a smooth union
 * of four ellipsoids is just a lump.
 *
 * Coronaries sit on `layer: 1` — their own field — so they render as vessels
 * lying on the epicardial surface rather than being absorbed into it.
 */
export function heartParts(): Part[] {
  const [cx, cy, cz] = HEART_CENTRE;
  const V = (x: number, y: number, z: number): Vec3 => [cx + x, cy + y, cz + z];
  const VENT = { region: HEART_REGION.VENTRICLE };
  const ATR = { region: HEART_REGION.ATRIUM };
  const VES = { region: HEART_REGION.VESSEL };
  const COR = { region: HEART_REGION.CORONARY, layer: 1 };

  return [
    /* ---- ventricular mass ---- */
    // Left ventricle: thick-walled cone, base to apex.
    limb(V(0.004, 0.052, -0.006), V(-0.048, -0.072, 0.032),
      [0.046, 0.050, 0.048, 0.040, 0.026, 0.009],
      { sz: 0.92, blend: 0.014, ...VENT }),
    // Right ventricle: thinner walled, wrapped anteriorly and to the right.
    ellipsoid(V(0.030, -0.002, 0.030), 0.038, 0.050, 0.030, {
      rot: [0, 0, -18 * DEG], blend: 0.016, w: 0.9, ...VENT,
    }),
    // Right ventricular outflow tract, up to the pulmonary valve.
    { a: V(0.030, 0.026, 0.032), b: V(0.012, 0.062, 0.028), ra: 0.022, rb: 0.017, blend: 0.014, w: 0.5, ...VENT },

    /* ---- atria ---- */
    ellipsoid(V(-0.016, 0.072, -0.034), 0.033, 0.028, 0.031, { blend: 0.010, ...ATR }),
    ellipsoid(V(-0.046, 0.062, -0.012), 0.013, 0.011, 0.015, { blend: 0.008, w: 0.3, ...ATR }),
    ellipsoid(V(0.046, 0.050, -0.002), 0.030, 0.033, 0.029, { blend: 0.010, ...ATR }),
    ellipsoid(V(0.034, 0.068, 0.024), 0.017, 0.013, 0.015, { blend: 0.008, w: 0.3, ...ATR }),

    /* ---- the two grooves that make the chambers legible ---- */
    // Anterior interventricular sulcus — the dividing line between LV and RV.
    { a: V(0.002, 0.034, 0.042), b: V(-0.038, -0.056, 0.040), ra: 0.011, rb: 0.008, carve: true, blend: 0.007 },
    // Atrioventricular groove at the valve plane.
    ellipsoid(V(0.012, 0.047, -0.006), 0.068, 0.006, 0.060, {
      carve: true, blend: 0.006, rot: [-12 * DEG, 0, 6 * DEG],
    }),

    /* ---- great vessels ---- */
    // Aortic root, ascending aorta, arch, descending thoracic aorta.
    ...tube(
      [V(0.004, 0.056, 0.002), V(0.010, 0.098, -0.004), V(0.004, 0.132, -0.018),
       V(-0.022, 0.140, -0.034), V(-0.034, 0.112, -0.046), V(-0.030, 0.060, -0.050)],
      0.017, 0.012, { blend: 0.008, w: 0.55, ...VES }
    ),
    // Brachiocephalic, left common carotid, left subclavian.
    ...tube([V(0.008, 0.126, -0.012), V(0.016, 0.168, -0.014)], 0.0075, 0.006, { blend: 0.005, w: 0.2, ...VES }),
    ...tube([V(-0.004, 0.138, -0.022), V(-0.004, 0.176, -0.024)], 0.0062, 0.005, { blend: 0.005, w: 0.18, ...VES }),
    ...tube([V(-0.018, 0.142, -0.030), V(-0.026, 0.174, -0.034)], 0.0062, 0.005, { blend: 0.005, w: 0.18, ...VES }),
    // Pulmonary trunk and its bifurcation.
    ...tube([V(0.012, 0.064, 0.030), V(0.000, 0.098, 0.016), V(-0.010, 0.112, -0.002)], 0.016, 0.013, { blend: 0.008, w: 0.4, ...VES }),
    ...tube([V(-0.010, 0.112, -0.002), V(-0.052, 0.112, -0.016)], 0.011, 0.009, { blend: 0.005, w: 0.22, ...VES }),
    ...tube([V(-0.010, 0.112, -0.002), V(0.036, 0.106, -0.022)], 0.011, 0.009, { blend: 0.005, w: 0.22, ...VES }),
    // Superior and inferior vena cava.
    ...tube([V(0.050, 0.062, -0.004), V(0.054, 0.132, -0.012)], 0.013, 0.011, { blend: 0.006, w: 0.28, ...VES }),
    ...tube([V(0.040, 0.016, -0.028), V(0.044, -0.034, -0.038)], 0.013, 0.012, { blend: 0.006, w: 0.22, ...VES }),
    // Four pulmonary veins into the left atrium.
    ...tube([V(-0.046, 0.082, -0.044), V(-0.080, 0.092, -0.054)], 0.007, 0.006, { blend: 0.004, w: 0.14, ...VES }),
    ...tube([V(-0.044, 0.058, -0.050), V(-0.078, 0.052, -0.062)], 0.007, 0.006, { blend: 0.004, w: 0.14, ...VES }),
    ...tube([V(0.012, 0.084, -0.050), V(0.040, 0.094, -0.062)], 0.007, 0.006, { blend: 0.004, w: 0.14, ...VES }),
    ...tube([V(0.010, 0.058, -0.054), V(0.038, 0.050, -0.066)], 0.007, 0.006, { blend: 0.004, w: 0.14, ...VES }),

    /* ---- coronary arteries, on their own layer ---- */
    // Left main into the LAD, down the anterior interventricular groove.
    ...tube([V(-0.008, 0.046, 0.016), V(0.000, 0.028, 0.040), V(-0.014, -0.012, 0.044), V(-0.038, -0.056, 0.036)],
      0.0046, 0.0028, { blend: 0.003, w: 1.0, ...COR }),
    // Circumflex, around the left atrioventricular groove.
    ...tube([V(-0.008, 0.046, 0.014), V(-0.040, 0.038, 0.004), V(-0.054, 0.016, -0.024)],
      0.0042, 0.0028, { blend: 0.003, w: 0.8, ...COR }),
    // Right coronary, around the right atrioventricular groove.
    ...tube([V(0.030, 0.046, 0.020), V(0.058, 0.024, 0.010), V(0.052, -0.012, -0.020), V(0.022, -0.038, -0.036)],
      0.0044, 0.0028, { blend: 0.003, w: 1.0, ...COR }),
  ];
}

/* ------------------------------------------------------------------ */
/* Lungs                                                                */
/* ------------------------------------------------------------------ */

/**
 * Lungs — narrow rounded apices widening to broad concave bases, three lobes
 * on the right and two on the left. The diaphragm, mediastinum and cardiac
 * notch are carved, so those surfaces are genuinely concave; the fissures are
 * thin subtracts, so they read as dark partings rather than extra surface.
 *
 * The bronchial tree is on `layer: 1`, since anything inside the parenchyma
 * would otherwise be swallowed by the outer surface.
 */
export function lungParts(): Part[] {
  const parts: Part[] = [];

  const lung = (sign: number, scale: number): Part[] => [
    limb(
      [sign * 0.060, 1.404, -0.016],
      [sign * 0.112 * scale, 1.096, 0.004],
      [0.028, 0.048, 0.064, 0.077, 0.086].map((r) => r * scale),
      { sx: 1, sz: 0.76, blend: 0.030 }
    ),
  ];

  // The left lung is the smaller of the two: the heart takes the room.
  parts.push(...lung(1, 1.0), ...lung(-1, 0.94));

  // Hemidiaphragms. The right sits higher, pushed up by the liver.
  parts.push(carve([0.088, 0.952, 0.0], 0.205, 0.195, 0.26, 0.025));
  parts.push(carve([-0.088, 0.924, 0.0], 0.205, 0.195, 0.26, 0.025));
  // Mediastinum: the central column for heart, trachea and great vessels.
  parts.push({ a: [0, 1.430, 0], b: [0, 1.060, 0], ra: 0.030, rb: 0.034, sz: 1.4, carve: true, blend: 0.022 });
  // Cardiac notch and lingula, left lung only.
  parts.push(carve([-0.060, 1.226, 0.040], 0.060, 0.072, 0.068, 0.028));
  // Hila, where the bronchi and vessels enter.
  parts.push(carve([0.052, 1.232, -0.030], 0.030, 0.034, 0.026, 0.014));
  parts.push(carve([-0.052, 1.238, -0.030], 0.028, 0.032, 0.024, 0.014));

  // Fissures. Oblique on both sides, horizontal on the right only.
  parts.push(fissure([-0.112, 1.212, 0.0], 0.115, 0.0032, [48 * DEG, 0, 0]));
  parts.push(fissure([0.112, 1.212, 0.0], 0.115, 0.0032, [48 * DEG, 0, 0]));
  parts.push(fissure([0.114, 1.276, 0.020], 0.072, 0.0030, [4 * DEG, 0, 6 * DEG]));

  // Trachea, carina and bronchial tree.
  parts.push(...tube([[0, 1.468, -0.008], [0, 1.332, -0.006]], 0.013, 0.012, { layer: 1, blend: 0.004, w: 0.8 }));

  const branch = (
    from: Vec3, dir: Vec3, length: number, radius: number, depth: number, rng: () => number
  ) => {
    if (depth === 0 || radius < 0.0020) return;
    const to: Vec3 = [from[0] + dir[0] * length, from[1] + dir[1] * length, from[2] + dir[2] * length];
    parts.push({ a: from, b: to, ra: radius, rb: radius * 0.74, layer: 1, blend: 0.003, w: 0.5, capA: false, capB: false });
    for (let i = 0; i < 2; i++) {
      const spread = 0.55 + rng() * 0.35;
      const side = i === 0 ? 1 : -1;
      const nd = normalize([
        dir[0] + side * spread * (0.6 + rng() * 0.5),
        dir[1] - spread * 0.5 * rng(),
        dir[2] + (rng() - 0.5) * spread,
      ]);
      branch(to, nd, length * (0.70 + rng() * 0.12), radius * 0.70, depth - 1, rng);
    }
  };
  const rng = makeRng(0x1f3a);
  // The right main bronchus is wider and more vertical than the left — the
  // reason inhaled foreign bodies tend to go right.
  branch([0, 1.332, -0.006], normalize([0.62, -0.74, 0.10]), 0.050, 0.0100, 4, rng);
  branch([0, 1.332, -0.006], normalize([-0.80, -0.52, 0.10]), 0.056, 0.0090, 4, rng);

  return parts;
}

/* ------------------------------------------------------------------ */
/* Brain                                                                */
/* ------------------------------------------------------------------ */

/**
 * Brain — gyrified hemispheres parted by the longitudinal fissure, frontal,
 * temporal and occipital lobes, cerebellum with finer folia, and a brainstem
 * descending through the foramen magnum.
 */
export function brainParts(): Part[] {
  const cy = 1.662;
  return [
    ellipsoid([-0.036, cy, 0.004], 0.050, 0.062, 0.078, { gyri: 0.12, blend: 0.016 }),
    ellipsoid([0.036, cy, 0.004], 0.050, 0.062, 0.078, { gyri: 0.12, blend: 0.016 }),
    ellipsoid([-0.030, cy - 0.008, 0.058], 0.039, 0.046, 0.042, { gyri: 0.11, blend: 0.016 }),
    ellipsoid([0.030, cy - 0.008, 0.058], 0.039, 0.046, 0.042, { gyri: 0.11, blend: 0.016 }),
    ellipsoid([-0.058, cy - 0.054, 0.020], 0.025, 0.029, 0.050, { gyri: 0.09, blend: 0.014, rot: [0, 0, 10 * DEG] }),
    ellipsoid([0.058, cy - 0.054, 0.020], 0.025, 0.029, 0.050, { gyri: 0.09, blend: 0.014, rot: [0, 0, -10 * DEG] }),
    ellipsoid([-0.028, cy - 0.006, -0.062], 0.034, 0.040, 0.034, { gyri: 0.10, blend: 0.016 }),
    ellipsoid([0.028, cy - 0.006, -0.062], 0.034, 0.040, 0.034, { gyri: 0.10, blend: 0.016 }),
    ellipsoid([0, cy - 0.066, -0.054], 0.050, 0.029, 0.034, { gyri: 0.17, blend: 0.012 }),

    // Longitudinal fissure between the hemispheres, and the Sylvian fissures
    // separating temporal from frontal and parietal.
    fissure([0, cy + 0.004, 0.006], 0.096, 0.0032, [0, 90 * DEG, 0]),
    fissure([-0.052, cy - 0.034, 0.016], 0.052, 0.0028, [0, 0, 74 * DEG]),
    fissure([0.052, cy - 0.034, 0.016], 0.052, 0.0028, [0, 0, -74 * DEG]),

    // Brainstem: midbrain, pons, medulla.
    limb([0, cy - 0.044, -0.012], [0, cy - 0.126, -0.022], [0.016, 0.019, 0.015, 0.011], { layer: 1, blend: 0.006, w: 0.8 }),
  ];
}

/* ------------------------------------------------------------------ */
/* Liver                                                                */
/* ------------------------------------------------------------------ */

/**
 * Liver — a large right lobe domed under the right hemidiaphragm, a smaller
 * left lobe across the midline, divided by the falciform ligament, with the
 * inferior surface carved flat and the gallbladder beneath.
 */
export function liverParts(): Part[] {
  return [
    ellipsoid([0.058, 1.110, 0.010], 0.122, 0.070, 0.080, { rot: [0, 0, -7 * DEG], blend: 0.030 }),
    ellipsoid([-0.062, 1.100, 0.030], 0.058, 0.038, 0.050, { rot: [0, 0, 5 * DEG], blend: 0.030 }),
    ellipsoid([0.012, 1.086, -0.034], 0.030, 0.026, 0.022, { blend: 0.020, w: 0.4 }),

    // Flat inferior surface, against the stomach and right kidney.
    carve([0.020, 0.980, 0.030], 0.210, 0.078, 0.150, 0.025),
    // Falciform ligament.
    fissure([-0.018, 1.108, 0.028], 0.060, 0.0030, [0, 84 * DEG, 0]),

    // Gallbladder, on the inferior surface of the right lobe.
    ellipsoid([0.052, 1.058, 0.056], 0.016, 0.025, 0.017, { blend: 0.010, w: 0.4, rot: [18 * DEG, 0, 0] }),
    // Portal vein and hepatic artery at the hilum.
    ...tube([[0.030, 1.066, -0.012], [-0.004, 1.050, -0.020]], 0.008, 0.007, { layer: 1, blend: 0.004, w: 0.6 }),
  ];
}

/* ------------------------------------------------------------------ */
/* Kidneys                                                              */
/* ------------------------------------------------------------------ */

/**
 * Kidneys — retroperitoneal, tilted with the upper poles medial, each with a
 * carved medial hilum, an adrenal gland capping the upper pole, and a ureter
 * descending to the bladder. The right sits lower, displaced by the liver.
 */
export function kidneyParts(): Part[] {
  const kidney = (sign: number, y: number): Part[] => [
    ellipsoid([0.074 * sign, y, -0.062], 0.029, 0.055, 0.029, {
      rot: [0, 0, sign * 12 * DEG], blend: 0.014,
    }),
    // Hilum: the medial concavity that makes it a bean.
    carve([0.044 * sign, y, -0.060], 0.026, 0.030, 0.030, 0.012),
    // Adrenal gland.
    ellipsoid([0.064 * sign, y + 0.060, -0.060], 0.022, 0.013, 0.020, { blend: 0.010, w: 0.5 }),
    // Renal artery and vein.
    ...tube([[0.048 * sign, y + 0.004, -0.058], [0.014 * sign, y + 0.008, -0.050]], 0.0065, 0.0055, { layer: 1, blend: 0.003, w: 0.6 }),
    // Ureter, down to the bladder.
    ...tube(
      [[0.050 * sign, y - 0.018, -0.058], [0.046 * sign, y - 0.080, -0.046], [0.030 * sign, y - 0.134, -0.024]],
      0.005, 0.004, { layer: 1, blend: 0.003, w: 0.8 }
    ),
  ];

  return [
    ...kidney(-1, 1.052),
    ...kidney(1, 1.038),
    ellipsoid([0, 0.902, 0.008], 0.034, 0.030, 0.030, { blend: 0.012, w: 0.5 }),
  ];
}

/* ------------------------------------------------------------------ */
/* Skeleton                                                             */
/* ------------------------------------------------------------------ */

/**
 * Skeleton — skull, vertebral column with its three curves, ribcage with
 * costal cartilage, both girdles and the long bones.
 *
 * Blends are deliberately tiny here: bones should meet at joints, not melt
 * into one another. The density correction in the sampler is what keeps the
 * overlaps (shaft into joint end, rib into spine) from glaring, so the `w`
 * values only need to balance thin structures against large ones.
 */
export function skeletonParts(): Part[] {
  const parts: Part[] = [];
  const B = 0.004;

  /* ---- skull ---- */
  parts.push(ellipsoid([0, 1.654, 0.002], 0.080, 0.094, 0.092, { blend: 0.012, w: 0.55 }));
  parts.push(ellipsoid([0, 1.636, -0.046], 0.062, 0.064, 0.048, { blend: 0.014, w: 0.25 }));
  parts.push(ellipsoid([0, 1.592, 0.044], 0.048, 0.030, 0.040, { blend: 0.012, w: 0.25 }));
  parts.push(ellipsoid([0, 1.562, 0.030], 0.052, 0.030, 0.052, { blend: 0.012, w: 0.3 }));
  // Orbits and nasal aperture, so the skull reads as a skull.
  parts.push(carve([-0.030, 1.608, 0.064], 0.020, 0.020, 0.024, 0.006));
  parts.push(carve([0.030, 1.608, 0.064], 0.020, 0.020, 0.024, 0.006));
  parts.push(carve([0, 1.586, 0.070], 0.011, 0.016, 0.020, 0.005));

  /* ---- vertebral column ---- */
  const vertebrae = 24;
  const spinePoint = (t: number): Vec3 => {
    const y = 1.492 - t * 0.572;
    // Piecewise, not one sine wave: a single wave curves the neck the wrong way.
    let z: number;
    if (t < 0.29) z = -0.028 + 0.020 * Math.sin((t / 0.29) * Math.PI);
    else if (t < 0.75) z = -0.028 - 0.026 * Math.sin(((t - 0.29) / 0.46) * Math.PI);
    else z = -0.028 + 0.030 * Math.sin(((t - 0.75) / 0.25) * Math.PI);
    return [0, y, z];
  };
  for (let i = 0; i < vertebrae; i++) {
    const t = i / (vertebrae - 1);
    const p = spinePoint(t);
    const r = 0.013 + t * 0.014;
    parts.push(ellipsoid(p, r, 0.0105, r * 0.88, { blend: B, w: 0.55 }));
    const droop = t > 0.29 && t < 0.72 ? 0.020 : 0.010;
    parts.push({
      a: [0, p[1], p[2] - r * 0.85],
      b: [0, p[1] - droop, p[2] - r * 0.85 - 0.023],
      ra: 0.0055, rb: 0.0038, blend: B, w: 0.35,
    });
    if (t > 0.2 && t < 0.78) {
      for (const s of [-1, 1]) {
        parts.push({
          a: [0, p[1], p[2] - r * 0.4],
          b: [s * (r + 0.016), p[1] + 0.002, p[2] - r * 0.5],
          ra: 0.0042, rb: 0.0034, blend: B, w: 0.18,
        });
      }
    }
  }
  parts.push(ellipsoid([0, 0.900, -0.040], 0.040, 0.054, 0.020, { blend: B, w: 0.25, rot: [16 * DEG, 0, 0] }));
  parts.push(ellipsoid([0, 0.856, -0.030], 0.012, 0.016, 0.008, { blend: B, w: 0.08 }));

  /* ---- ribcage ---- */
  for (let i = 0; i < 12; i++) {
    const t = i / 11;
    const spineT = 0.20 + t * 0.44;
    const origin = spinePoint(spineT);
    const spread = Math.sin((0.26 + t * 0.70) * Math.PI) * 0.150 + 0.034;
    const drop = 0.040 + t * 0.070;
    const front = 0.100 - t * 0.014;
    const floating = i >= 10;
    const cartilage = i >= 7 && i < 10;

    for (const sign of [-1, 1]) {
      const pts: Vec3[] = [
        [origin[0], origin[1], origin[2]],
        [sign * spread * 0.70, origin[1] - drop * 0.22, origin[2] + 0.028],
        [sign * spread, origin[1] - drop * 0.60, origin[2] + front * 0.42],
        [sign * spread * 0.64, origin[1] - drop, origin[2] + front * 0.84],
      ];
      if (floating) pts.length = 3;
      else if (cartilage) pts.push([sign * 0.050, origin[1] - drop * 1.18, origin[2] + front * 0.96]);
      else pts.push([sign * 0.026, origin[1] - drop * 1.10, origin[2] + front]);
      parts.push(...tube(pts, 0.0070, 0.0052, { blend: B, w: 0.9 }));
    }
  }

  /* ---- sternum ---- */
  parts.push(ellipsoid([0, 1.364, 0.080], 0.023, 0.018, 0.007, { blend: B, w: 0.16 }));
  parts.push({ a: [0, 1.344, 0.078], b: [0, 1.230, 0.070], ra: 0.017, rb: 0.013, sz: 0.38, blend: B, w: 0.22 });
  parts.push(ellipsoid([0, 1.216, 0.068], 0.008, 0.012, 0.004, { blend: B, w: 0.07 }));

  /* ---- shoulder girdle ---- */
  for (const sign of [-1, 1]) {
    parts.push(...tube(
      [[sign * 0.013, 1.400, 0.058], [sign * 0.080, 1.410, 0.050], [sign * 0.148, 1.398, 0.012]],
      0.0078, 0.0065, { blend: B, w: 0.5 }
    ));
    parts.push(ellipsoid([sign * 0.106, 1.344, -0.058], 0.052, 0.068, 0.010, {
      blend: B, w: 0.26, rot: [8 * DEG, sign * -22 * DEG, sign * 10 * DEG],
    }));
    parts.push({
      a: [sign * 0.062, 1.384, -0.066], b: [sign * 0.148, 1.396, -0.028],
      ra: 0.0075, rb: 0.0095, blend: B, w: 0.18,
    });
  }

  /* ---- pelvis ---- */
  for (const sign of [-1, 1]) {
    parts.push(ellipsoid([sign * 0.090, 0.956, -0.012], 0.046, 0.062, 0.022, {
      blend: B, w: 0.24, rot: [10 * DEG, 0, sign * -16 * DEG],
    }));
    parts.push(...tube(
      [[sign * 0.078, 0.902, 0.006], [sign * 0.058, 0.868, 0.030], [sign * 0.014, 0.862, 0.042]],
      0.0105, 0.0085, { blend: B, w: 0.35 }
    ));
    parts.push(ellipsoid([sign * 0.080, 0.898, -0.016], 0.018, 0.020, 0.018, { blend: B, w: 0.14 }));
    // Obturator foramen, so the pelvis is a ring rather than a plate.
    parts.push(carve([sign * 0.052, 0.890, 0.012], 0.016, 0.020, 0.030, 0.005));
  }

  /* ---- long bones: profiled shafts with modest joint ends ---- */
  const longBone = (a: Vec3, b: Vec3, rShaft: number, rEnd: number, w = 0.5): Part[] => [
    limb(a, b, [rEnd * 0.8, rShaft, rShaft * 0.92, rShaft, rEnd * 0.72], { blend: 0.006, w }),
    ellipsoid(a, rEnd, rEnd, rEnd, { blend: 0.006, w: w * 0.2 }),
    ellipsoid(b, rEnd * 0.86, rEnd * 0.86, rEnd * 0.86, { blend: 0.006, w: w * 0.2 }),
  ];

  for (const sign of [-1, 1]) {
    parts.push(...longBone([sign * 0.158, 1.392, 0.0], [sign * 0.236, 1.124, 0.008], 0.0135, 0.023));
    parts.push(...longBone([sign * 0.230, 1.112, 0.018], [sign * 0.278, 0.862, 0.032], 0.0085, 0.013, 0.3));
    parts.push(...longBone([sign * 0.248, 1.112, 0.004], [sign * 0.288, 0.860, 0.022], 0.0085, 0.012, 0.3));
    parts.push(ellipsoid([sign * 0.284, 0.846, 0.028], 0.020, 0.012, 0.012, { blend: B, w: 0.12 }));
    for (let f = 0; f < 4; f++) {
      const o = (f - 1.5) * 0.013;
      parts.push({
        a: [sign * (0.286 + o * 0.2), 0.836, 0.030 + o * 0.6],
        b: [sign * (0.293 + o * 0.4), 0.780, 0.034 + o * 1.2],
        ra: 0.004, rb: 0.0031, blend: B, w: 0.1,
      });
    }
    parts.push(...longBone([sign * 0.086, 0.906, -0.010], [sign * 0.100, 0.512, 0.004], 0.0175, 0.030, 0.55));
    parts.push({ a: [sign * 0.082, 0.908, -0.012], b: [sign * 0.040, 0.922, -0.012], ra: 0.013, rb: 0.016, blend: B, w: 0.16 });
    parts.push(ellipsoid([sign * 0.100, 0.514, 0.036], 0.017, 0.019, 0.008, { blend: B, w: 0.11 }));
    parts.push(...longBone([sign * 0.098, 0.500, 0.004], [sign * 0.104, 0.098, -0.004], 0.0135, 0.023, 0.5));
    parts.push(...longBone([sign * 0.124, 0.492, -0.006], [sign * 0.120, 0.102, -0.010], 0.0058, 0.0085, 0.18));
    parts.push(ellipsoid([sign * 0.104, 0.062, -0.026], 0.026, 0.028, 0.030, { blend: B, w: 0.16 }));
    for (let f = 0; f < 4; f++) {
      const o = (f - 1.5) * 0.013;
      parts.push({
        a: [sign * (0.104 + o * 0.5), 0.044, -0.004],
        b: [sign * (0.101 + o), 0.027, 0.088],
        ra: 0.0048, rb: 0.0036, blend: B, w: 0.12,
      });
    }
  }

  return parts;
}
