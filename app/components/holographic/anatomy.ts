/**
 * app/components/holographic/anatomy.ts
 *
 * Procedural anatomical point-cloud generator for the /holographic route and
 * the Echocardiographic Windows SCORM module.
 *
 * WHY PROCEDURAL: shipping a rigged anatomical mesh would mean megabytes of
 * binary assets in the repo and a licence question for a pre-sales demo. The
 * body here is instead a union of rotatable tapered capsules and ellipsoids
 * that we surface-sample into a point cloud. The aim is anatomical
 * plausibility at particle resolution, not a medical illustration: structures
 * sit in the right place, in the right proportion, with the landmarks a
 * clinician would look for. Nobody is counting ribs.
 *
 * Everything is pure maths — no THREE import — so this module is safe to run
 * on the server, in a test, or in a worker. It returns plain Float32Arrays.
 *
 * COORDINATES: metres, Y up, origin on the floor between the feet, facing +Z.
 * Patient's left is −X (so you read the figure as if facing it). A standing
 * adult is ~1.76m on an eight-head canon. `BODY_Y_OFFSET` recentres the
 * finished cloud on the origin so the camera can orbit it without an offset
 * target.
 */

export type Vec3 = [number, number, number];

/**
 * A tapered capsule: the segment a→b swept by a radius that lerps ra→rb,
 * scaled in cross-section by (sx, sz), then rotated about `pivot`.
 * Setting a === b gives an ellipsoid with radii (ra*sx, ra, ra*sz).
 */
export type Part = {
  a: Vec3;
  b: Vec3;
  ra: number;
  rb?: number;
  /** Cross-section scale, applied in part space before rotation. */
  sx?: number;
  sz?: number;
  /**
   * Euler XYZ rotation in radians, applied about `pivot` after scaling.
   * Without this, every primitive is world-axis aligned, which makes oblique
   * structures — lung fissures, the heart's long axis, the scapular blade,
   * the kidneys' tilt — impossible to express.
   */
  rot?: Vec3;
  /** Rotation centre. Defaults to the midpoint of a→b. */
  pivot?: Vec3;
  /** Include the hemispherical cap at the a / b end. Default true. */
  capA?: boolean;
  capB?: boolean;
  /**
   * Carves other parts away instead of adding surface. Used for the cardiac
   * notch, the pulmonary fissures, the brain's longitudinal fissure, the
   * falciform ligament, the renal hilum and the diaphragmatic surfaces.
   */
  subtract?: boolean;
  /**
   * Skip the union-rejection test for points generated from this part.
   * Internal structures (bronchial tree, coronary arteries, great vessels)
   * live inside or against other parts and would otherwise be culled.
   */
  noCull?: boolean;
  /**
   * Sampling weight multiplier, default 1.
   *
   * This is a brightness control as much as a density one. Sampling is
   * area-weighted, so a large closed mass (skull, pelvis, a joint end) takes
   * most of the budget and, under additive blending, reads as a solid white
   * blob while thin structures fade out. Under-weight the masses.
   */
  w?: number;
  /** Radial displacement, 0..1, applied as sinusoidal folds. For the brain. */
  gyri?: number;
  /**
   * Arbitrary group id written to `Cloud.regions`. The SCORM heart uses this
   * to contract ventricles, atria and vessels independently.
   */
  region?: number;
};

export type Cloud = {
  /** xyz triples, already recentred by BODY_Y_OFFSET. */
  positions: Float32Array;
  /** Per-point size multiplier. */
  sizes: Float32Array;
  /** Per-point stable random, 0..1. Drives colour variance and drift phase. */
  seeds: Float32Array;
  /** Per-point value of the source part's `region` (0 when unset). */
  regions: Float32Array;
  count: number;
};

/** Shifts the finished cloud so the body's mid-chest sits near the origin. */
export const BODY_Y_OFFSET = 1.0;

/** Region ids used by the heart. Exported so the engines agree on them. */
export const HEART_REGION = {
  VENTRICLE: 0,
  ATRIUM: 1,
  VESSEL: 2,
  CORONARY: 3,
} as const;

/* ------------------------------------------------------------------ */
/* Deterministic RNG                                                    */
/* ------------------------------------------------------------------ */

/**
 * mulberry32 — small, fast, good enough for point scattering. Seeded so the
 * body looks identical on every load; a body that reshuffles on each refresh
 * looks like a bug during a live demo.
 */
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
/* Vector helpers (plain tuples — no allocation-heavy class)            */
/* ------------------------------------------------------------------ */

const sub = (p: Vec3, q: Vec3): Vec3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const dot = (p: Vec3, q: Vec3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const len = (p: Vec3) => Math.sqrt(dot(p, p));

function normalize(p: Vec3): Vec3 {
  const l = len(p) || 1;
  return [p[0] / l, p[1] / l, p[2] / l];
}

/** Any unit vector perpendicular to n. Branch avoids the degenerate case. */
function perpendicular(n: Vec3): Vec3 {
  const ref: Vec3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  return normalize(cross(n, ref));
}

function cross(p: Vec3, q: Vec3): Vec3 {
  return [
    p[1] * q[2] - p[2] * q[1],
    p[2] * q[0] - p[0] * q[2],
    p[0] * q[1] - p[1] * q[0],
  ];
}

/* ------------------------------------------------------------------ */
/* Rotation                                                             */
/* ------------------------------------------------------------------ */

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

/** Transpose, which for a rotation matrix is the inverse. */
const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

/* ------------------------------------------------------------------ */
/* Part geometry                                                        */
/* ------------------------------------------------------------------ */

type PartCache = {
  part: Part;
  /** Endpoints relative to the pivot. All geometry is built here, then
   *  scaled, rotated and translated back — so the cross-section scale acts
   *  about the part's own centre rather than about the world origin. */
  la: Vec3;
  lb: Vec3;
  axis: Vec3;
  axisLen: number;
  dir: Vec3;
  u: Vec3;
  v: Vec3;
  ra: number;
  rb: number;
  sx: number;
  sz: number;
  area: number;
  rot?: Mat3;
  rotInv?: Mat3;
  pivot: Vec3;
  region: number;
};

function cachePart(part: Part): PartCache {
  const axis = sub(part.b, part.a);
  const axisLen = len(axis);
  const dir: Vec3 = axisLen > 1e-6 ? normalize(axis) : [0, 1, 0];
  const u = perpendicular(dir);
  const v = cross(dir, u);
  const ra = part.ra;
  const rb = part.rb ?? part.ra;
  const sx = part.sx ?? 1;
  const sz = part.sz ?? 1;

  // Lateral surface of a frustum plus whichever caps we sample, scaled by the
  // mean cross-section scale. Only used for relative sampling weight, so a
  // rough figure is fine.
  const meanScale = (sx + sz) / 2;
  const lateral = Math.PI * (ra + rb) * axisLen * meanScale;
  const capA = part.capA === false ? 0 : 2 * Math.PI * ra * ra * meanScale;
  const capB = part.capB === false ? 0 : 2 * Math.PI * rb * rb * meanScale;

  const rot = part.rot ? eulerMatrix(part.rot) : undefined;
  const pivot: Vec3 =
    part.pivot ??
    [(part.a[0] + part.b[0]) / 2, (part.a[1] + part.b[1]) / 2, (part.a[2] + part.b[2]) / 2];

  return {
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
    sx,
    sz,
    area: Math.max(lateral + capA + capB, 1e-5) * (part.w ?? 1),
    rot,
    rotInv: rot ? transpose(rot) : undefined,
    pivot,
    region: part.region ?? 0,
  };
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

/**
 * Signed-ish distance from p to a part's surface. Negative means inside.
 * Exact for capsules, an approximation for strongly tapered cones — all we
 * need, since it only ever decides whether to discard a candidate point.
 */
function signedDistance(c: PartCache, world: Vec3): number {
  // World → local: translate to the pivot, undo the rotation, undo the
  // cross-section scale. What remains is a plain capsule test.
  let rel = sub(world, c.pivot);
  if (c.rotInv) rel = applyMat(c.rotInv, rel);

  const q: Vec3 = [rel[0] / c.sx, rel[1], rel[2] / c.sz];
  const a = c.la;
  const b = c.lb;
  const ab = sub(b, a);
  const ap = sub(q, a);
  const abLenSq = dot(ab, ab);
  const t = abLenSq > 1e-9 ? Math.max(0, Math.min(1, dot(ap, ab) / abLenSq)) : 0;
  const closest: Vec3 = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
  const r = c.ra + (c.rb - c.ra) * t;
  const d = len(sub(q, closest));
  const g = gyriFactor(c.part.gyri ?? 0, q[0], q[1], q[2]);
  return d - r * g;
}

/** A surface point on the part, plus its outward normal, in world space. */
function sampleSurface(c: PartCache, rng: () => number): { p: Vec3; n: Vec3 } {
  const { part } = c;
  const wantCapA = part.capA !== false;
  const wantCapB = part.capB !== false;

  const lateralW = Math.PI * (c.ra + c.rb) * c.axisLen;
  const capAW = wantCapA ? 2 * Math.PI * c.ra * c.ra : 0;
  const capBW = wantCapB ? 2 * Math.PI * c.rb * c.rb : 0;
  const total = lateralW + capAW + capBW || 1;

  const pick = rng() * total;
  const theta = rng() * Math.PI * 2;
  const ct = Math.cos(theta);
  const st = Math.sin(theta);

  let base: Vec3;
  let normal: Vec3;

  if (pick < lateralW || c.axisLen < 1e-6) {
    if (c.axisLen < 1e-6) {
      // Degenerate (a === b): a sphere. Uniform sphere sampling.
      const z = rng() * 2 - 1;
      const rxy = Math.sqrt(Math.max(0, 1 - z * z));
      normal = [rxy * ct, rxy * st, z];
      base = [
        c.la[0] + normal[0] * c.ra,
        c.la[1] + normal[1] * c.ra,
        c.la[2] + normal[2] * c.ra,
      ];
    } else {
      // Lateral surface. Sample t biased toward the wider end so point
      // density stays even over a tapered limb.
      const rnd = rng();
      const t = c.ra === c.rb ? rnd : biasedT(rnd, c.ra, c.rb);
      const r = c.ra + (c.rb - c.ra) * t;
      const axisPoint: Vec3 = [
        c.la[0] + c.axis[0] * t,
        c.la[1] + c.axis[1] * t,
        c.la[2] + c.axis[2] * t,
      ];
      normal = [
        c.u[0] * ct + c.v[0] * st,
        c.u[1] * ct + c.v[1] * st,
        c.u[2] * ct + c.v[2] * st,
      ];
      base = [
        axisPoint[0] + normal[0] * r,
        axisPoint[1] + normal[1] * r,
        axisPoint[2] + normal[2] * r,
      ];
    }
  } else {
    // One of the hemispherical caps.
    const atA = pick < lateralW + capAW;
    const origin = atA ? c.la : c.lb;
    const r = atA ? c.ra : c.rb;
    const sign = atA ? -1 : 1;
    const z = rng();
    const rxy = Math.sqrt(Math.max(0, 1 - z * z));
    normal = [
      c.u[0] * rxy * ct + c.v[0] * rxy * st + c.dir[0] * z * sign,
      c.u[1] * rxy * ct + c.v[1] * rxy * st + c.dir[1] * z * sign,
      c.u[2] * rxy * ct + c.v[2] * rxy * st + c.dir[2] * z * sign,
    ];
    base = [
      origin[0] + normal[0] * r,
      origin[1] + normal[1] * r,
      origin[2] + normal[2] * r,
    ];
  }

  // Gyri displacement, about the part's own centre, before scaling.
  const g = gyriFactor(part.gyri ?? 0, base[0], base[1], base[2]);
  if (g !== 1) base = [base[0] * g, base[1] * g, base[2] * g];

  // Scale the cross-section in LOCAL space, so an off-midline part stays
  // where it was declared. Doing this in world space silently translated
  // every scaled part away from the origin in proportion to its offset.
  let p: Vec3 = [base[0] * c.sx, base[1], base[2] * c.sz];
  // A surface scaled by S transforms its normal by the inverse transpose,
  // which for a diagonal S is 1/S. Using S here would tilt a flat disc's
  // normal into its own plane.
  let n: Vec3 = normalize([normal[0] / c.sx, normal[1], normal[2] / c.sz]);

  if (c.rot) {
    p = applyMat(c.rot, p);
    n = applyMat(c.rot, n);
  }

  return { p: [p[0] + c.pivot[0], p[1] + c.pivot[1], p[2] + c.pivot[2]], n };
}

/**
 * Inverse-CDF for sampling t along a cone so that surface density is uniform.
 * Radius lerps ra→rb, so the lateral area element is proportional to r(t).
 */
function biasedT(rnd: number, ra: number, rb: number): number {
  if (Math.abs(ra - rb) < 1e-6) return rnd;
  const k = rb / ra;
  const a = k - 1;
  const disc = 1 + a * rnd * (1 + k);
  return (Math.sqrt(Math.max(0, disc)) - 1) / a;
}

/* ------------------------------------------------------------------ */
/* Cloud builder                                                        */
/* ------------------------------------------------------------------ */

type BuildOptions = {
  /** Fraction of points placed inside the shell rather than on it. */
  interior?: number;
  /** Half-thickness of the shell, in metres. */
  shell?: number;
  /** Tolerance for the union rejection test. Larger keeps more seams. */
  margin?: number;
  sizeMin?: number;
  sizeMax?: number;
  /** Subtract this from every Y. Defaults to BODY_Y_OFFSET. */
  yOffset?: number;
};

/**
 * Surface-samples a union of parts into a point cloud.
 *
 * Candidate points are rejected when they fall inside a different additive
 * part (so you get the outer shell of the union, not a pile of intersecting
 * tubes) or inside any subtractive part. Parts flagged `noCull` skip the test.
 */
export function buildCloud(
  parts: Part[],
  count: number,
  rng: () => number,
  opts: BuildOptions = {}
): Cloud {
  const {
    interior = 0.14,
    shell = 0.004,
    margin = 0.0045,
    sizeMin = 0.6,
    sizeMax = 1.5,
    yOffset = BODY_Y_OFFSET,
  } = opts;

  const caches = parts.map(cachePart);
  const additive = caches.filter((c) => !c.part.subtract);
  const subtractive = caches.filter((c) => c.part.subtract);

  const cumulative: number[] = [];
  let areaTotal = 0;
  for (const c of additive) {
    areaTotal += c.area;
    cumulative.push(areaTotal);
  }

  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const seeds = new Float32Array(count);
  const regions = new Float32Array(count);

  let written = 0;
  // Generous attempt budget: heavy subtraction (lungs) rejects a lot.
  const maxAttempts = count * 24;

  for (let attempt = 0; attempt < maxAttempts && written < count; attempt++) {
    const target = rng() * areaTotal;
    let idx = 0;
    while (idx < cumulative.length - 1 && cumulative[idx] < target) idx++;
    const c = additive[idx];

    const { p, n } = sampleSurface(c, rng);

    const inward = rng() < interior;
    const offset = inward
      ? -(0.04 + rng() * 0.5) * c.ra
      : (rng() - 0.5) * 2 * shell;
    const q: Vec3 = [
      p[0] + n[0] * offset,
      p[1] + n[1] * offset,
      p[2] + n[2] * offset,
    ];

    if (!c.part.noCull) {
      let rejected = false;

      // Inside another additive part → interior to the union. Interior points
      // are allowed to fail this (that is what they are for), so only cull
      // shell points.
      if (!inward) {
        for (let i = 0; i < additive.length; i++) {
          if (i === idx) continue;
          if (additive[i].part.noCull) continue;
          if (signedDistance(additive[i], q) < -margin) {
            rejected = true;
            break;
          }
        }
      }

      if (!rejected) {
        for (let i = 0; i < subtractive.length; i++) {
          if (signedDistance(subtractive[i], q) < 0) {
            rejected = true;
            break;
          }
        }
      }

      if (rejected) continue;
    }

    const o = written * 3;
    positions[o] = q[0];
    positions[o + 1] = q[1] - yOffset;
    positions[o + 2] = q[2];
    const s = sizeMin + rng() * (sizeMax - sizeMin);
    sizes[written] = inward ? s * 0.6 : s;
    seeds[written] = rng();
    regions[written] = c.region;
    written++;
  }

  // If subtraction was aggressive enough that we ran out of attempts, fold the
  // cloud back on itself rather than shipping zeroes (which render as a bright
  // blob at the origin).
  for (let i = written; i < count; i++) {
    const src = (i % Math.max(written, 1)) * 3;
    const o = i * 3;
    positions[o] = positions[src];
    positions[o + 1] = positions[src + 1];
    positions[o + 2] = positions[src + 2];
    sizes[i] = sizes[i % Math.max(written, 1)];
    seeds[i] = rng();
    regions[i] = regions[i % Math.max(written, 1)];
  }

  return { positions, sizes, seeds, regions, count };
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

/**
 * A thin oriented disc, used as a `subtract` part to cut a fissure or a
 * cleft. Radius r in its own plane, `thickness` across it, then rotated.
 */
function plane(
  c: Vec3,
  r: number,
  thickness: number,
  rot: Vec3,
  extra: Partial<Part> = {}
): Part {
  return {
    a: c,
    b: c,
    ra: thickness,
    sx: r / thickness,
    sz: r / thickness,
    rot,
    pivot: c,
    subtract: true,
    ...extra,
  };
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

/** Mirrors a part across the sagittal plane (x → −x). */
function mirror(part: Part): Part {
  const m: Part = {
    ...part,
    a: [-part.a[0], part.a[1], part.a[2]],
    b: [-part.b[0], part.b[1], part.b[2]],
  };
  if (part.pivot) m.pivot = [-part.pivot[0], part.pivot[1], part.pivot[2]];
  // Mirroring reverses the handedness of a rotation about the Y and Z axes.
  if (part.rot) m.rot = [part.rot[0], -part.rot[1], -part.rot[2]];
  return m;
}

/** A part and its mirror image. */
const pair = (parts: Part[]): Part[] => [...parts, ...parts.map(mirror)];

/* ------------------------------------------------------------------ */
/* The body                                                            */
/* ------------------------------------------------------------------ */

/**
 * Standing adult figure, ~1.76m on an eight-head canon (head 0.22m; shoulder
 * line 1.45; nipple 1.30; navel 1.09; pubic symphysis 0.88 — the halfway
 * point; knee 0.49; ankle 0.08).
 *
 * The pelvis is deliberately a single smooth continuous surface: the hip and
 * seat frusta meet without any separate geometry, so the figure reads as an
 * anatomical mannequin rather than a nude.
 */
export function bodyParts(): Part[] {
  const armL: Part[] = [
    // deltoid, capping the shoulder
    ellipsoid([-0.172, 1.412, 0.0], 0.062, 0.074, 0.064, { w: 0.9 }),
    // humerus envelope
    { a: [-0.182, 1.392, 0.0], b: [-0.236, 1.128, 0.008], ra: 0.052, rb: 0.040, capA: false },
    // biceps belly, anterior
    ellipsoid([-0.198, 1.300, 0.016], 0.044, 0.062, 0.042, { w: 0.5 }),
    // triceps, posterior
    ellipsoid([-0.204, 1.290, -0.020], 0.040, 0.066, 0.034, { w: 0.4 }),
    // elbow
    ellipsoid([-0.238, 1.118, 0.008], 0.042, 0.040, 0.042, { w: 0.5 }),
    // forearm, tapering to the wrist
    { a: [-0.240, 1.112, 0.010], b: [-0.282, 0.862, 0.028], ra: 0.044, rb: 0.027, capA: false },
    // flexor bulge, upper forearm
    ellipsoid([-0.252, 1.046, 0.018], 0.042, 0.054, 0.040, { w: 0.45 }),
    // wrist
    ellipsoid([-0.283, 0.856, 0.029], 0.026, 0.020, 0.017, { w: 0.3 }),
    // palm
    { a: [-0.285, 0.850, 0.031], b: [-0.292, 0.792, 0.035], ra: 0.030, rb: 0.028, sz: 0.45, capA: false, w: 0.5 },
    // thumb, opposed and forward
    { a: [-0.266, 0.836, 0.044], b: [-0.252, 0.792, 0.058], ra: 0.012, rb: 0.0095, w: 0.2 },
  ];
  // four fingers, fanned slightly
  for (let f = 0; f < 4; f++) {
    const o = (f - 1.5) * 0.0145;
    const lenScale = 1 - Math.abs(f - 1.1) * 0.08;
    armL.push({
      a: [-0.290 + o * 0.25, 0.790, 0.035 + o],
      b: [-0.296 + o * 0.5, 0.790 - 0.062 * lenScale, 0.038 + o * 1.25],
      ra: 0.0098,
      rb: 0.0072,
      w: 0.14,
    });
  }

  const legL: Part[] = [
    // gluteal mass
    ellipsoid([-0.090, 0.902, -0.024], 0.092, 0.088, 0.086, { w: 0.8 }),
    // thigh
    { a: [-0.088, 0.886, 0.0], b: [-0.098, 0.522, 0.004], ra: 0.088, rb: 0.058, capA: false },
    // quadriceps, anterior
    ellipsoid([-0.090, 0.716, 0.030], 0.072, 0.118, 0.052, { w: 0.6 }),
    // hamstrings, posterior
    ellipsoid([-0.092, 0.730, -0.038], 0.068, 0.112, 0.044, { w: 0.5 }),
    // knee
    ellipsoid([-0.100, 0.502, 0.008], 0.058, 0.054, 0.058, { w: 0.6 }),
    // shin
    { a: [-0.100, 0.492, 0.004], b: [-0.104, 0.092, -0.004], ra: 0.055, rb: 0.036, capA: false },
    // gastrocnemius, posterior and high
    ellipsoid([-0.102, 0.402, -0.044], 0.050, 0.084, 0.040, { w: 0.5 }),
    // ankle
    ellipsoid([-0.104, 0.078, -0.012], 0.037, 0.035, 0.040, { w: 0.4 }),
    // heel
    ellipsoid([-0.104, 0.042, -0.048], 0.033, 0.034, 0.030, { w: 0.35 }),
    // foot, tapering toward the toes
    { a: [-0.104, 0.052, -0.030], b: [-0.100, 0.026, 0.088], ra: 0.038, rb: 0.028, sx: 0.95, capA: false },
  ];
  // toes
  for (let t = 0; t < 4; t++) {
    const o = (t - 1.5) * 0.0135;
    legL.push({
      a: [-0.100 + o * 0.6, 0.026, 0.086],
      b: [-0.099 + o, 0.023, 0.104 - Math.abs(t - 0.6) * 0.004],
      ra: 0.0095,
      rb: 0.008,
      w: 0.1,
    });
  }

  return [
    /* ---- head ---- */
    // cranium
    ellipsoid([0, 1.654, 0.004], 0.087, 0.097, 0.100, { w: 0.9 }),
    // occiput, the back of the skull
    ellipsoid([0, 1.640, -0.048], 0.070, 0.074, 0.056, { w: 0.4 }),
    // face block / brow
    ellipsoid([0, 1.603, 0.048], 0.062, 0.056, 0.052, { w: 0.5 }),
    // nose
    ellipsoid([0, 1.614, 0.086], 0.015, 0.022, 0.020, { w: 0.12 }),
    // jaw
    ellipsoid([0, 1.567, 0.030], 0.057, 0.042, 0.060, { w: 0.5 }),
    // chin
    ellipsoid([0, 1.550, 0.056], 0.028, 0.024, 0.028, { w: 0.2 }),
    // ears
    ...pair([ellipsoid([-0.090, 1.644, -0.006], 0.011, 0.028, 0.020, { w: 0.14 })]),

    /* ---- neck and shoulder girdle ---- */
    { a: [0, 1.470, -0.006], b: [0, 1.548, 0.0], ra: 0.054, rb: 0.050, sz: 0.92, capB: false },
    // trapezius slope, neck down to acromion
    ...pair([ellipsoid([-0.080, 1.470, -0.016], 0.072, 0.044, 0.060, { w: 0.5 })]),
    { a: [-0.140, 1.448, -0.018], b: [0.140, 1.448, -0.018], ra: 0.070, sz: 0.74, capA: false, capB: false },

    /* ---- torso: five stacked frusta, flattened front-to-back ---- */
    // upper chest, widening to the nipple line
    { a: [0, 1.440, 0], b: [0, 1.320, 0], ra: 0.150, rb: 0.167, sz: 0.56, capA: false, capB: false },
    // lower chest, narrowing to the waist
    { a: [0, 1.320, 0], b: [0, 1.180, 0], ra: 0.167, rb: 0.153, sz: 0.60, capA: false, capB: false },
    // waist
    { a: [0, 1.180, 0], b: [0, 1.020, 0], ra: 0.153, rb: 0.127, sz: 0.62, capA: false, capB: false },
    // hips, flaring again
    { a: [0, 1.020, 0], b: [0, 0.920, 0], ra: 0.127, rb: 0.146, sz: 0.70, capA: false, capB: false },
    // seat, closing smoothly into the thighs
    { a: [0, 0.920, -0.012], b: [0, 0.862, -0.012], ra: 0.146, rb: 0.126, sz: 0.80, capA: false, capB: false },

    // pectorals
    ...pair([ellipsoid([-0.070, 1.330, 0.070], 0.074, 0.050, 0.034, { w: 0.45 })]),
    // scapular mass, upper back
    ...pair([ellipsoid([-0.078, 1.368, -0.074], 0.078, 0.088, 0.028, { w: 0.4 })]),
    // abdominal wall, gently convex
    ellipsoid([0, 1.120, 0.052], 0.098, 0.090, 0.034, { w: 0.4 }),

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
 * Heart — left of midline, long axis running down-left-forward from the base
 * to the apex, which is the orientation that makes the echo windows make
 * sense. Built from the four chambers, the great vessels and the three major
 * coronary arteries, each tagged with a HEART_REGION so the SCORM module can
 * contract them independently through the cardiac cycle.
 */
export function heartParts(): Part[] {
  const [cx, cy, cz] = HEART_CENTRE;
  const V = (x: number, y: number, z: number): Vec3 => [cx + x, cy + y, cz + z];
  const VENT = { region: HEART_REGION.VENTRICLE };
  const ATR = { region: HEART_REGION.ATRIUM };
  const VES = { region: HEART_REGION.VESSEL, noCull: true };
  const COR = { region: HEART_REGION.CORONARY, noCull: true };

  return [
    /* ---- ventricular mass ---- */
    // Left ventricle: thick-walled cone from the base down to the apex.
    { a: V(0.004, 0.050, -0.004), b: V(-0.046, -0.070, 0.030), ra: 0.050, rb: 0.009, sz: 0.92, ...VENT },
    // Right ventricle: thinner, wrapped anteriorly and to the patient's right.
    ellipsoid(V(0.030, 0.000, 0.032), 0.040, 0.050, 0.030, {
      rot: [0, 0, -18 * DEG], w: 0.9, ...VENT,
    }),
    // Right ventricular outflow tract, sweeping up toward the pulmonary valve.
    { a: V(0.030, 0.030, 0.034), b: V(0.012, 0.062, 0.030), ra: 0.024, rb: 0.019, w: 0.5, ...VENT },

    /* ---- atria ---- */
    // Left atrium, posterior — the chamber you see behind the mitral valve.
    ellipsoid(V(-0.016, 0.070, -0.034), 0.034, 0.029, 0.032, { ...ATR }),
    // Left atrial appendage.
    ellipsoid(V(-0.046, 0.060, -0.012), 0.014, 0.012, 0.016, { w: 0.3, ...ATR }),
    // Right atrium.
    ellipsoid(V(0.046, 0.048, -0.002), 0.031, 0.034, 0.030, { ...ATR }),
    // Right atrial appendage, hooking forward over the aortic root.
    ellipsoid(V(0.034, 0.066, 0.024), 0.018, 0.014, 0.016, { w: 0.3, ...ATR }),

    /* ---- great vessels ---- */
    // Aortic root, ascending aorta, arch, and descending thoracic aorta.
    ...tube(
      [
        V(0.004, 0.056, 0.002),
        V(0.010, 0.098, -0.004),
        V(0.004, 0.132, -0.018),
        V(-0.022, 0.140, -0.034),
        V(-0.034, 0.112, -0.046),
        V(-0.030, 0.060, -0.050),
      ],
      0.017,
      0.012,
      { w: 0.55, ...VES }
    ),
    // Head and neck branches off the arch: brachiocephalic, left common
    // carotid, left subclavian.
    ...tube([V(0.008, 0.126, -0.012), V(0.016, 0.168, -0.014)], 0.0075, 0.006, { w: 0.2, ...VES }),
    ...tube([V(-0.004, 0.138, -0.022), V(-0.004, 0.176, -0.024)], 0.0062, 0.005, { w: 0.18, ...VES }),
    ...tube([V(-0.018, 0.142, -0.030), V(-0.026, 0.174, -0.034)], 0.0062, 0.005, { w: 0.18, ...VES }),
    // Pulmonary trunk, bifurcating into left and right pulmonary arteries.
    ...tube([V(0.012, 0.064, 0.030), V(0.000, 0.098, 0.016), V(-0.010, 0.112, -0.002)], 0.016, 0.013, { w: 0.4, ...VES }),
    ...tube([V(-0.010, 0.112, -0.002), V(-0.052, 0.112, -0.016)], 0.011, 0.009, { w: 0.22, ...VES }),
    ...tube([V(-0.010, 0.112, -0.002), V(0.036, 0.106, -0.022)], 0.011, 0.009, { w: 0.22, ...VES }),
    // Superior vena cava, draining into the right atrium.
    ...tube([V(0.050, 0.062, -0.004), V(0.054, 0.132, -0.012)], 0.013, 0.011, { w: 0.28, ...VES }),
    // Inferior vena cava.
    ...tube([V(0.040, 0.016, -0.028), V(0.044, -0.034, -0.038)], 0.013, 0.012, { w: 0.22, ...VES }),
    // Four pulmonary veins entering the left atrium.
    ...tube([V(-0.046, 0.082, -0.044), V(-0.080, 0.092, -0.054)], 0.007, 0.006, { w: 0.14, ...VES }),
    ...tube([V(-0.044, 0.058, -0.050), V(-0.078, 0.052, -0.062)], 0.007, 0.006, { w: 0.14, ...VES }),
    ...tube([V(0.012, 0.084, -0.050), V(0.040, 0.094, -0.062)], 0.007, 0.006, { w: 0.14, ...VES }),
    ...tube([V(0.010, 0.058, -0.054), V(0.038, 0.050, -0.066)], 0.007, 0.006, { w: 0.14, ...VES }),

    /* ---- coronary arteries ---- */
    // Left main stem into the LAD, running the anterior interventricular
    // groove toward the apex.
    ...tube(
      [V(-0.008, 0.046, 0.016), V(0.000, 0.028, 0.038), V(-0.014, -0.012, 0.042), V(-0.038, -0.056, 0.034)],
      0.0052,
      0.0032,
      { w: 0.3, ...COR }
    ),
    // Circumflex, around the left atrioventricular groove.
    ...tube(
      [V(-0.008, 0.046, 0.014), V(-0.040, 0.036, 0.004), V(-0.054, 0.014, -0.024)],
      0.0048,
      0.0032,
      { w: 0.25, ...COR }
    ),
    // Right coronary artery, around the right atrioventricular groove.
    ...tube(
      [V(0.030, 0.044, 0.018), V(0.056, 0.022, 0.010), V(0.050, -0.012, -0.020), V(0.022, -0.038, -0.036)],
      0.0050,
      0.0032,
      { w: 0.3, ...COR }
    ),
  ];
}

/* ------------------------------------------------------------------ */
/* Lungs                                                                */
/* ------------------------------------------------------------------ */

/**
 * Lungs — three lobes on the right (oblique + horizontal fissures), two on
 * the left (oblique fissure only), with the cardiac notch and lingula on the
 * left and a concave diaphragmatic base on both. The bronchial tree is
 * generated recursively and flagged noCull so it survives inside the
 * parenchyma.
 *
 * Fissures are thin rotated discs used as subtract parts — the gap they cut
 * in the point cloud reads as the fissure line.
 */
export function lungParts(): Part[] {
  const parts: Part[] = [];

  const lung = (sign: number): Part[] => {
    const x = 0.090 * sign;
    return [
      // apex to base, widening and flattening against the chest wall
      { a: [x * 0.60, 1.400, -0.012], b: [x * 1.26, 1.108, 0.000], ra: 0.036, rb: 0.086, sx: 1, sz: 0.76 },
      ellipsoid([x * 1.22, 1.118, 0.000], 0.070, 0.072, 0.056),
    ];
  };

  parts.push(...lung(-1), ...lung(1));

  // Diaphragm: a large sphere beneath, carving the concave lung bases. The
  // right hemidiaphragm sits higher because the liver is under it.
  parts.push(ellipsoid([0.085, 0.945, 0.0], 0.20, 0.20, 0.26, { subtract: true }));
  parts.push(ellipsoid([-0.085, 0.920, 0.0], 0.20, 0.20, 0.26, { subtract: true }));
  // Mediastinum: clears the central column for the heart, trachea and vessels.
  parts.push({ a: [0, 1.420, 0], b: [0, 1.080, 0], ra: 0.030, rb: 0.034, sz: 1.3, subtract: true });
  // Cardiac notch, left lung only (patient's left is −x).
  parts.push(ellipsoid([-0.056, 1.232, 0.034], 0.060, 0.072, 0.070, { subtract: true }));

  // Oblique fissures, running postero-superior to antero-inferior at ~45°.
  parts.push(plane([-0.108, 1.212, 0.0], 0.115, 0.0035, [48 * DEG, 0, 0]));
  parts.push(plane([0.108, 1.212, 0.0], 0.115, 0.0035, [48 * DEG, 0, 0]));
  // Horizontal fissure, right lung only — separates upper from middle lobe.
  parts.push(plane([0.110, 1.272, 0.022], 0.072, 0.0032, [4 * DEG, 0, 6 * DEG]));

  // Trachea and carina.
  parts.push(...tube([[0, 1.462, -0.006], [0, 1.330, -0.005]], 0.013, 0.012, { noCull: true, w: 0.3 }));

  // Recursive bronchial tree. Four generations reads as a tree at particle
  // resolution without flooding the buffer.
  const branch = (
    from: Vec3,
    dir: Vec3,
    length: number,
    radius: number,
    depth: number,
    rng: () => number
  ) => {
    if (depth === 0 || radius < 0.0022) return;
    const to: Vec3 = [
      from[0] + dir[0] * length,
      from[1] + dir[1] * length,
      from[2] + dir[2] * length,
    ];
    parts.push({ a: from, b: to, ra: radius, rb: radius * 0.72, noCull: true, w: 0.18, capA: false, capB: false });
    for (let i = 0; i < 2; i++) {
      const spread = 0.55 + rng() * 0.35;
      const side = i === 0 ? 1 : -1;
      const nd = normalize([
        dir[0] + side * spread * (0.6 + rng() * 0.5),
        dir[1] - spread * 0.5 * rng(),
        dir[2] + (rng() - 0.5) * spread,
      ]);
      branch(to, nd, length * (0.68 + rng() * 0.12), radius * 0.68, depth - 1, rng);
    }
  };

  const rng = makeRng(0x1f3a);
  // The right main bronchus is wider and more vertical than the left — the
  // reason inhaled foreign bodies tend to go right.
  branch([0, 1.330, -0.005], normalize([0.66, -0.70, 0.10]), 0.052, 0.0100, 4, rng);
  branch([0, 1.330, -0.005], normalize([0.78, -0.52, 0.10]), 0.056, 0.0092, 4, rng);

  return parts;
}

/* ------------------------------------------------------------------ */
/* Brain                                                                */
/* ------------------------------------------------------------------ */

/**
 * Brain — gyrified cerebral hemispheres split by the longitudinal fissure,
 * frontal and temporal lobes, cerebellum with finer folia, and a brainstem
 * descending through the foramen magnum.
 */
export function brainParts(): Part[] {
  const cy = 1.662;
  return [
    // cerebral hemispheres
    ellipsoid([-0.036, cy, 0.004], 0.050, 0.062, 0.078, { gyri: 0.12 }),
    ellipsoid([0.036, cy, 0.004], 0.050, 0.062, 0.078, { gyri: 0.12 }),
    // frontal lobes, leaning forward and slightly down
    ellipsoid([-0.030, cy - 0.008, 0.058], 0.039, 0.046, 0.042, { gyri: 0.11 }),
    ellipsoid([0.030, cy - 0.008, 0.058], 0.039, 0.046, 0.042, { gyri: 0.11 }),
    // temporal lobes, below the Sylvian fissure
    ellipsoid([-0.058, cy - 0.054, 0.020], 0.025, 0.029, 0.050, { gyri: 0.09, rot: [0, 0, 10 * DEG] }),
    ellipsoid([0.058, cy - 0.054, 0.020], 0.025, 0.029, 0.050, { gyri: 0.09, rot: [0, 0, -10 * DEG] }),
    // occipital poles
    ellipsoid([-0.028, cy - 0.006, -0.062], 0.034, 0.040, 0.034, { gyri: 0.10 }),
    ellipsoid([0.028, cy - 0.006, -0.062], 0.034, 0.040, 0.034, { gyri: 0.10 }),
    // cerebellum, finer folia than the cortex
    ellipsoid([0, cy - 0.066, -0.054], 0.050, 0.029, 0.034, { gyri: 0.17 }),

    // longitudinal fissure, separating the hemispheres
    plane([0, cy + 0.004, 0.006], 0.095, 0.0035, [0, 90 * DEG, 0]),
    // Sylvian fissures, separating temporal from frontal/parietal
    plane([-0.052, cy - 0.034, 0.016], 0.052, 0.003, [0, 0, 74 * DEG]),
    plane([0.052, cy - 0.034, 0.016], 0.052, 0.003, [0, 0, -74 * DEG]),

    // brainstem: midbrain, pons, medulla
    ellipsoid([0, cy - 0.050, -0.012], 0.016, 0.014, 0.016, { noCull: true, w: 0.3 }),
    ellipsoid([0, cy - 0.072, -0.014], 0.018, 0.016, 0.018, { noCull: true, w: 0.3 }),
    { a: [0, cy - 0.084, -0.016], b: [0, cy - 0.124, -0.022], ra: 0.013, rb: 0.011, noCull: true, w: 0.3 },
  ];
}

/* ------------------------------------------------------------------ */
/* Liver                                                                */
/* ------------------------------------------------------------------ */

/**
 * Liver — a large right-sided wedge with a smaller left lobe across the
 * midline, divided by the falciform ligament, sitting under the right
 * hemidiaphragm with a flat inferior surface and the gallbladder tucked
 * beneath.
 */
export function liverParts(): Part[] {
  return [
    // right lobe, the bulk, domed to follow the diaphragm
    ellipsoid([0.058, 1.108, 0.010], 0.122, 0.072, 0.080, { rot: [0, 0, -7 * DEG] }),
    // left lobe, thinner, crossing the midline
    ellipsoid([-0.062, 1.098, 0.030], 0.058, 0.040, 0.050, { rot: [0, 0, 5 * DEG] }),
    // caudate lobe, posterior
    ellipsoid([0.012, 1.086, -0.034], 0.030, 0.026, 0.022, { w: 0.4 }),

    // flatten the inferior surface against the stomach and right kidney
    ellipsoid([0.020, 0.986, 0.030], 0.205, 0.074, 0.145, { subtract: true }),
    // falciform ligament: the fissure between right and left lobes
    plane([-0.018, 1.104, 0.026], 0.062, 0.0032, [0, 84 * DEG, 0]),

    // gallbladder, on the inferior surface of the right lobe
    ellipsoid([0.052, 1.056, 0.054], 0.017, 0.026, 0.018, { noCull: true, w: 0.3, rot: [18 * DEG, 0, 0] }),
    // portal vein and hepatic artery entering at the hilum
    ...tube([[0.030, 1.064, -0.012], [-0.004, 1.048, -0.020]], 0.008, 0.007, { noCull: true, w: 0.18 }),
  ];
}

/* ------------------------------------------------------------------ */
/* Kidneys                                                              */
/* ------------------------------------------------------------------ */

/**
 * Kidneys — retroperitoneal, tilted so the upper poles sit closer to the
 * midline, each with a medial hilum carved out, an adrenal gland capping the
 * upper pole, and a ureter descending to the bladder. The right kidney sits
 * slightly lower, displaced by the liver.
 */
export function kidneyParts(): Part[] {
  const kidney = (sign: number, y: number): Part[] => [
    // the bean, tilted with the upper pole medial
    ellipsoid([0.074 * sign, y, -0.062], 0.030, 0.056, 0.030, {
      rot: [0, 0, sign * 12 * DEG],
    }),
    // hilum: carve the medial concavity
    ellipsoid([0.042 * sign, y, -0.060], 0.026, 0.030, 0.030, { subtract: true }),
    // adrenal gland, capping the upper pole
    ellipsoid([0.066 * sign, y + 0.062, -0.060], 0.022, 0.013, 0.020, { w: 0.35, noCull: true }),
    // renal artery and vein at the hilum
    ...tube([[0.048 * sign, y + 0.004, -0.058], [0.014 * sign, y + 0.008, -0.050]], 0.0065, 0.0055, {
      noCull: true,
      w: 0.16,
    }),
    // ureter, descending to the bladder
    ...tube(
      [
        [0.050 * sign, y - 0.016, -0.058],
        [0.046 * sign, y - 0.078, -0.046],
        [0.030 * sign, y - 0.132, -0.024],
      ],
      0.005,
      0.004,
      { noCull: true, w: 0.22 }
    ),
  ];

  return [
    // left kidney sits a little higher than the right
    ...kidney(-1, 1.052),
    ...kidney(1, 1.038),
    // bladder
    ellipsoid([0, 0.902, 0.008], 0.034, 0.030, 0.030, { w: 0.45 }),
  ];
}

/* ------------------------------------------------------------------ */
/* Skeleton                                                             */
/* ------------------------------------------------------------------ */

/**
 * Skeleton — skull, vertebral column with its three curves, ribcage with
 * costal cartilage, shoulder and pelvic girdles, and the long bones.
 *
 * Sampling is area-weighted, so the `w` values deliberately under-weight the
 * big closed masses (skull, pelvis, joint ends) and over-weight the thin
 * structures that actually carry the anatomy. Without that the skull reads as
 * a solid white egg and the ribs disappear.
 */
export function skeletonParts(): Part[] {
  const parts: Part[] = [];

  /* ---- skull ---- */
  parts.push(ellipsoid([0, 1.654, 0.002], 0.080, 0.094, 0.092, { w: 0.30 }));
  parts.push(ellipsoid([0, 1.636, -0.046], 0.062, 0.064, 0.048, { w: 0.14 }));
  // maxilla and mandible
  parts.push(ellipsoid([0, 1.592, 0.044], 0.048, 0.030, 0.040, { w: 0.16 }));
  parts.push(ellipsoid([0, 1.562, 0.030], 0.052, 0.030, 0.052, { w: 0.18 }));
  // orbits, carved into the face
  parts.push(ellipsoid([-0.030, 1.608, 0.064], 0.019, 0.019, 0.022, { subtract: true }));
  parts.push(ellipsoid([0.030, 1.608, 0.064], 0.019, 0.019, 0.022, { subtract: true }));

  /* ---- vertebral column: cervical lordosis, thoracic kyphosis, lumbar lordosis ---- */
  const vertebrae = 24;
  const spinePoint = (t: number): Vec3 => {
    const y = 1.492 - t * 0.572;
    // Piecewise curvature rather than one sine — a single wave gives a spine
    // that curves the wrong way in the neck.
    let z: number;
    if (t < 0.29) z = -0.028 + 0.020 * Math.sin((t / 0.29) * Math.PI); // cervical, convex forward
    else if (t < 0.75) z = -0.028 - 0.026 * Math.sin(((t - 0.29) / 0.46) * Math.PI); // thoracic, convex back
    else z = -0.028 + 0.030 * Math.sin(((t - 0.75) / 0.25) * Math.PI); // lumbar, convex forward
    return [0, y, z];
  };
  for (let i = 0; i < vertebrae; i++) {
    const t = i / (vertebrae - 1);
    const p = spinePoint(t);
    // bodies grow from cervical to lumbar
    const r = 0.013 + t * 0.014;
    parts.push(ellipsoid(p, r, 0.0105, r * 0.88, { w: 0.5 }));
    // spinous process, angled down and back, steepest in the mid-thoracic
    const droop = t > 0.29 && t < 0.72 ? 0.020 : 0.010;
    parts.push({
      a: [0, p[1], p[2] - r * 0.85],
      b: [0, p[1] - droop, p[2] - r * 0.85 - 0.023],
      ra: 0.0055,
      rb: 0.0038,
      w: 0.3,
    });
    // transverse processes
    if (t > 0.2 && t < 0.78) {
      for (const s of [-1, 1]) {
        parts.push({
          a: [0, p[1], p[2] - r * 0.4],
          b: [s * (r + 0.016), p[1] + 0.002, p[2] - r * 0.5],
          ra: 0.0042,
          rb: 0.0034,
          w: 0.16,
        });
      }
    }
  }
  // sacrum and coccyx
  parts.push(ellipsoid([0, 0.900, -0.040], 0.040, 0.054, 0.020, { w: 0.22, rot: [16 * DEG, 0, 0] }));
  parts.push(ellipsoid([0, 0.856, -0.030], 0.012, 0.016, 0.008, { w: 0.08 }));

  /* ---- ribcage ---- */
  // Ribs sweep down and forward from the spine; the lower ones flare wider
  // and the last two float. Costal cartilage closes 1-7 onto the sternum.
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
      parts.push(...tube(pts, 0.0070, 0.0052, { w: 0.62 }));
    }
  }

  /* ---- sternum: manubrium, body, xiphoid ---- */
  parts.push(ellipsoid([0, 1.364, 0.080], 0.023, 0.018, 0.007, { w: 0.14 }));
  parts.push({ a: [0, 1.344, 0.078], b: [0, 1.230, 0.070], ra: 0.017, rb: 0.013, sz: 0.38, w: 0.2 });
  parts.push(ellipsoid([0, 1.216, 0.068], 0.008, 0.012, 0.004, { w: 0.07 }));

  /* ---- shoulder girdle ---- */
  for (const sign of [-1, 1]) {
    // clavicle, S-curved from the manubrium to the acromion
    parts.push(
      ...tube(
        [
          [sign * 0.013, 1.400, 0.058],
          [sign * 0.080, 1.410, 0.050],
          [sign * 0.148, 1.398, 0.012],
        ],
        0.0078,
        0.0065,
        { w: 0.4 }
      )
    );
    // scapula blade, lying flat against the posterior ribcage and tilted
    parts.push(
      ellipsoid([sign * 0.106, 1.344, -0.058], 0.052, 0.068, 0.010, {
        w: 0.22,
        rot: [8 * DEG, sign * -22 * DEG, sign * 10 * DEG],
      })
    );
    // acromion and spine of the scapula
    parts.push({
      a: [sign * 0.062, 1.384, -0.066],
      b: [sign * 0.148, 1.396, -0.028],
      ra: 0.0075,
      rb: 0.0095,
      w: 0.16,
    });
  }

  /* ---- pelvis ---- */
  for (const sign of [-1, 1]) {
    // iliac wing, flared outward and forward
    parts.push(
      ellipsoid([sign * 0.090, 0.956, -0.012], 0.046, 0.062, 0.024, {
        w: 0.2,
        rot: [10 * DEG, 0, sign * -16 * DEG],
      })
    );
    // ischium and pubic ramus, closing the obturator ring
    parts.push(
      ...tube(
        [
          [sign * 0.078, 0.902, 0.006],
          [sign * 0.058, 0.868, 0.030],
          [sign * 0.014, 0.862, 0.042],
        ],
        0.0105,
        0.0085,
        { w: 0.3 }
      )
    );
    parts.push(ellipsoid([sign * 0.080, 0.898, -0.016], 0.018, 0.020, 0.018, { w: 0.12 }));
  }

  /* ---- long bones ---- */
  // A shaft with a smaller bulb at each joint. The ends are heavily
  // overlapped by the shaft and each other, so they take a fraction of the
  // shaft's weight or the joints glare.
  const longBone = (a: Vec3, b: Vec3, rShaft: number, rEnd: number, w = 0.45): Part[] => [
    { a, b, ra: rShaft, rb: rShaft * 0.92, capA: false, capB: false, w },
    ellipsoid(a, rEnd, rEnd, rEnd, { w: w * 0.22 }),
    ellipsoid(b, rEnd * 0.9, rEnd * 0.9, rEnd * 0.9, { w: w * 0.22 }),
  ];

  for (const sign of [-1, 1]) {
    // humerus, radius, ulna
    parts.push(...longBone([sign * 0.158, 1.392, 0.0], [sign * 0.236, 1.124, 0.008], 0.0135, 0.023));
    parts.push(...longBone([sign * 0.230, 1.112, 0.018], [sign * 0.278, 0.862, 0.032], 0.0085, 0.013, 0.28));
    parts.push(...longBone([sign * 0.248, 1.112, 0.004], [sign * 0.288, 0.860, 0.022], 0.0085, 0.012, 0.28));
    // carpals, then metacarpals fanned into the hand
    parts.push(ellipsoid([sign * 0.284, 0.846, 0.028], 0.020, 0.012, 0.012, { w: 0.1 }));
    for (let f = 0; f < 4; f++) {
      const o = (f - 1.5) * 0.013;
      parts.push({
        a: [sign * (0.286 + o * 0.2), 0.836, 0.030 + o * 0.6],
        b: [sign * (0.293 + o * 0.4), 0.780, 0.034 + o * 1.2],
        ra: 0.004,
        rb: 0.0031,
        w: 0.09,
      });
    }
    // femur, with a neck angled into the acetabulum
    parts.push(...longBone([sign * 0.086, 0.906, -0.010], [sign * 0.100, 0.512, 0.004], 0.0175, 0.030, 0.42));
    parts.push({ a: [sign * 0.082, 0.908, -0.012], b: [sign * 0.040, 0.922, -0.012], ra: 0.013, rb: 0.016, w: 0.14 });
    // patella
    parts.push(ellipsoid([sign * 0.100, 0.514, 0.036], 0.017, 0.019, 0.008, { w: 0.1 }));
    // tibia and fibula
    parts.push(...longBone([sign * 0.098, 0.500, 0.004], [sign * 0.104, 0.098, -0.004], 0.0135, 0.023, 0.4));
    parts.push(...longBone([sign * 0.124, 0.492, -0.006], [sign * 0.120, 0.102, -0.010], 0.0058, 0.0085, 0.15));
    // tarsals and metatarsals
    parts.push(ellipsoid([sign * 0.104, 0.062, -0.026], 0.026, 0.028, 0.030, { w: 0.14 }));
    for (let f = 0; f < 4; f++) {
      const o = (f - 1.5) * 0.013;
      parts.push({
        a: [sign * (0.104 + o * 0.5), 0.044, -0.004],
        b: [sign * (0.101 + o), 0.027, 0.088],
        ra: 0.0048,
        rb: 0.0036,
        w: 0.1,
      });
    }
  }

  return parts;
}
