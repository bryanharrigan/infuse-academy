/**
 * app/components/holographic/anatomy.ts
 *
 * Procedural anatomical point-cloud generator for the /holographic route.
 *
 * WHY PROCEDURAL: shipping a rigged anatomical mesh would mean megabytes of
 * binary assets in the repo and a licence question for a pre-sales demo. The
 * body here is instead a union of tapered capsules and ellipsoids that we
 * surface-sample into a point cloud. At particle density the silhouette reads
 * as a human body; nobody is counting ribs.
 *
 * Everything is pure maths — no THREE import — so this module is safe to run
 * on the server, in a test, or in a worker. It returns plain Float32Arrays.
 *
 * COORDINATES: metres, Y up, origin on the floor between the feet, facing +Z.
 * A standing adult is ~1.76m. `BODY_Y_OFFSET` recentres the finished cloud on
 * the origin so the camera can orbit it without an offset target.
 */

export type Vec3 = [number, number, number];

/**
 * A tapered capsule: the segment a→b swept by a radius that lerps ra→rb,
 * then scaled in cross-section by (sx, sz). Setting a === b gives an
 * ellipsoid with radii (ra*sx, ra, ra*sz).
 */
export type Part = {
  a: Vec3;
  b: Vec3;
  ra: number;
  rb?: number;
  /** Cross-section scale. Lets one primitive describe a flattened torso. */
  sx?: number;
  sz?: number;
  /** Include the hemispherical cap at the a / b end. Default true. */
  capA?: boolean;
  capB?: boolean;
  /**
   * Carves other parts away instead of adding surface. Used for the cardiac
   * notch in the left lung, the diaphragm curve under both lungs, the renal
   * hilum, and so on.
   */
  subtract?: boolean;
  /**
   * Skip the union-rejection test for points generated from this part.
   * Internal structures (bronchial tree, vessels) live *inside* other parts
   * and would otherwise be culled entirely.
   */
  noCull?: boolean;
  /** Manual sampling weight multiplier. Default 1. */
  w?: number;
  /** Radial displacement, 0..1, applied as sinusoidal folds. For the brain. */
  gyri?: number;
};

export type Cloud = {
  /** xyz triples, already recentred by BODY_Y_OFFSET. */
  positions: Float32Array;
  /** Per-point size multiplier, 0.55..1.6. */
  sizes: Float32Array;
  /** Per-point stable random, 0..1. Drives colour variance and drift phase. */
  seeds: Float32Array;
  count: number;
};

/** Shifts the finished cloud so the body's mid-chest sits near the origin. */
export const BODY_Y_OFFSET = 1.0;

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
  const c: Vec3 = [
    n[1] * ref[2] - n[2] * ref[1],
    n[2] * ref[0] - n[0] * ref[2],
    n[0] * ref[1] - n[1] * ref[0],
  ];
  return normalize(c);
}

function cross(p: Vec3, q: Vec3): Vec3 {
  return [
    p[1] * q[2] - p[2] * q[1],
    p[2] * q[0] - p[0] * q[2],
    p[0] * q[1] - p[1] * q[0],
  ];
}

/* ------------------------------------------------------------------ */
/* Part geometry                                                        */
/* ------------------------------------------------------------------ */

type PartCache = {
  part: Part;
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

  // Lateral surface of a frustum + the caps we actually sample, scaled by the
  // mean cross-section scale. Only used for relative sampling weight, so a
  // rough figure is fine.
  const meanScale = (sx + sz) / 2;
  const lateral = Math.PI * (ra + rb) * axisLen * meanScale;
  const capA = part.capA === false ? 0 : 2 * Math.PI * ra * ra * meanScale;
  const capB = part.capB === false ? 0 : 2 * Math.PI * rb * rb * meanScale;

  return {
    part,
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
 * Signed-ish distance from p to a part's surface, in that part's own
 * cross-section-scaled space. Negative means inside. Exact for capsules,
 * an approximation for strongly tapered cones — which is all we need, since
 * it only ever decides whether to discard a candidate point.
 */
function signedDistance(c: PartCache, p: Vec3): number {
  // Into the part's normalised space, where the cross-section is circular.
  const q: Vec3 = [p[0] / c.sx, p[1], p[2] / c.sz];
  const a: Vec3 = [c.part.a[0] / c.sx, c.part.a[1], c.part.a[2] / c.sz];
  const b: Vec3 = [c.part.b[0] / c.sx, c.part.b[1], c.part.b[2] / c.sz];
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
function sampleSurface(
  c: PartCache,
  rng: () => number
): { p: Vec3; n: Vec3 } {
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
      // Degenerate (a === b): a sphere. Cosine-free uniform sphere sampling.
      const z = rng() * 2 - 1;
      const rxy = Math.sqrt(Math.max(0, 1 - z * z));
      normal = [rxy * ct, rxy * st, z];
      base = [
        part.a[0] + normal[0] * c.ra,
        part.a[1] + normal[1] * c.ra,
        part.a[2] + normal[2] * c.ra,
      ];
    } else {
      // Lateral surface. Sample t with a bias toward the wider end so the
      // point density stays roughly even over a tapered limb.
      const rnd = rng();
      const t = c.ra === c.rb ? rnd : biasedT(rnd, c.ra, c.rb);
      const r = c.ra + (c.rb - c.ra) * t;
      const axisPoint: Vec3 = [
        part.a[0] + c.axis[0] * t,
        part.a[1] + c.axis[1] * t,
        part.a[2] + c.axis[2] * t,
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
    const origin = atA ? part.a : part.b;
    const r = atA ? c.ra : c.rb;
    const sign = atA ? -1 : 1;
    const z = rng(); // hemisphere: 0..1 along the axis direction
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

  // Gyri displacement, applied before the cross-section scale.
  const g = gyriFactor(part.gyri ?? 0, base[0], base[1], base[2]);
  if (g !== 1) {
    const o = part.a;
    base = [
      o[0] + (base[0] - o[0]) * g,
      o[1] + (base[1] - o[1]) * g,
      o[2] + (base[2] - o[2]) * g,
    ];
  }

  return {
    p: [base[0] * c.sx, base[1], base[2] * c.sz],
    n: normalize([normal[0] * c.sx, normal[1], normal[2] * c.sz]),
  };
}

/**
 * Inverse-CDF for sampling t along a cone so that surface density is uniform.
 * Radius lerps ra→rb, so the lateral area element is proportional to r(t).
 */
function biasedT(rnd: number, ra: number, rb: number): number {
  if (Math.abs(ra - rb) < 1e-6) return rnd;
  const k = rb / ra;
  // Solve for t in: (2t + (k-1)t^2) / (1 + k) = rnd
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
  /** Point size range. */
  sizeMin?: number;
  sizeMax?: number;
  /** Subtract this from every Y. Defaults to BODY_Y_OFFSET. */
  yOffset?: number;
};

/**
 * Surface-samples a union of parts into a point cloud.
 *
 * Candidate points are rejected when they fall inside a *different* additive
 * part (so you get the outer shell of the union, not a pile of intersecting
 * tubes) or inside any subtractive part (the cardiac notch, the diaphragm).
 * Parts flagged `noCull` skip the test so internal structures survive.
 */
export function buildCloud(
  parts: Part[],
  count: number,
  rng: () => number,
  opts: BuildOptions = {}
): Cloud {
  const {
    interior = 0.22,
    shell = 0.004,
    margin = 0.0045,
    sizeMin = 0.6,
    sizeMax = 1.5,
    yOffset = BODY_Y_OFFSET,
  } = opts;

  const caches = parts.map(cachePart);
  const additive = caches.filter((c) => !c.part.subtract);
  const subtractive = caches.filter((c) => c.part.subtract);

  // Cumulative area table for weighted part selection.
  const cumulative: number[] = [];
  let areaTotal = 0;
  for (const c of additive) {
    areaTotal += c.area;
    cumulative.push(areaTotal);
  }

  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const seeds = new Float32Array(count);

  let written = 0;
  // Generous attempt budget: heavy subtraction (lungs) rejects a lot.
  const maxAttempts = count * 24;

  for (let attempt = 0; attempt < maxAttempts && written < count; attempt++) {
    // Pick a part weighted by surface area.
    const target = rng() * areaTotal;
    let idx = 0;
    while (idx < cumulative.length - 1 && cumulative[idx] < target) idx++;
    const c = additive[idx];

    const { p, n } = sampleSurface(c, rng);

    // Push the point off the surface: most sit in a thin shell, a minority
    // sink inward to give the cloud some volume when you orbit it.
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

      // Inside another additive part → this point is interior to the union.
      // Interior points are allowed to fail this test (that is the point of
      // them), so only cull shell points.
      if (!inward) {
        for (let i = 0; i < additive.length; i++) {
          if (i === idx) continue;
          if (signedDistance(additive[i], q) < -margin) {
            rejected = true;
            break;
          }
        }
      }

      // Inside a subtractive part → carved away. Always culled.
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
    // Interior points render smaller and dimmer so the shell stays readable.
    const s = sizeMin + rng() * (sizeMax - sizeMin);
    sizes[written] = inward ? s * 0.6 : s;
    seeds[written] = rng();
    written++;
  }

  // If subtraction was aggressive enough that we ran out of attempts, fold the
  // cloud back on itself rather than shipping a buffer of zeroes (which would
  // render as a bright blob at the origin).
  for (let i = written; i < count; i++) {
    const src = (i % Math.max(written, 1)) * 3;
    const o = i * 3;
    positions[o] = positions[src];
    positions[o + 1] = positions[src + 1];
    positions[o + 2] = positions[src + 2];
    sizes[i] = sizes[i % Math.max(written, 1)];
    seeds[i] = rng();
  }

  return { positions, sizes, seeds, count };
}

/* ------------------------------------------------------------------ */
/* Primitive helpers                                                    */
/* ------------------------------------------------------------------ */

/** Ellipsoid centred at c with radii (rx, ry, rz). */
function ellipsoid(
  c: Vec3,
  rx: number,
  ry: number,
  rz: number,
  extra: Partial<Part> = {}
): Part {
  return { a: c, b: c, ra: ry, sx: rx / ry, sz: rz / ry, ...extra };
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

/** Mirrors a part across the sagittal plane (x → -x). */
function mirror(part: Part): Part {
  return {
    ...part,
    a: [-part.a[0], part.a[1], part.a[2]],
    b: [-part.b[0], part.b[1], part.b[2]],
  };
}

const mirrorAll = (parts: Part[]): Part[] => parts.map(mirror);

/** A part and its mirror image. */
const pair = (parts: Part[]): Part[] => [...parts, ...mirrorAll(parts)];

/* ------------------------------------------------------------------ */
/* The body                                                             */
/* ------------------------------------------------------------------ */

/**
 * Full standing figure. Proportions are a ~1.76m adult in anatomical
 * position, arms slightly abducted so the silhouette reads cleanly from the
 * front without the hands merging into the thighs.
 */
export function bodyParts(): Part[] {
  const armL: Part[] = [
    // deltoid
    ellipsoid([-0.185, 1.418, 0], 0.062, 0.07, 0.062),
    // humerus envelope
    { a: [-0.195, 1.4, 0], b: [-0.253, 1.115, 0.012], ra: 0.054, rb: 0.042, capA: false },
    // elbow
    ellipsoid([-0.255, 1.105, 0.012], 0.045, 0.045, 0.045),
    // forearm
    { a: [-0.257, 1.1, 0.014], b: [-0.298, 0.845, 0.03], ra: 0.043, rb: 0.031, capA: false },
    // hand
    { a: [-0.3, 0.84, 0.032], b: [-0.311, 0.715, 0.038], ra: 0.032, rb: 0.022, capA: false, sz: 0.52 },
  ];

  const legL: Part[] = [
    // gluteal / hip
    ellipsoid([-0.092, 0.905, -0.01], 0.095, 0.095, 0.095),
    // thigh
    { a: [-0.09, 0.895, 0], b: [-0.102, 0.515, 0.004], ra: 0.088, rb: 0.058, capA: false },
    // knee
    ellipsoid([-0.103, 0.5, 0.006], 0.06, 0.055, 0.058),
    // shin
    { a: [-0.103, 0.495, 0.004], b: [-0.106, 0.095, -0.004], ra: 0.057, rb: 0.038, capA: false },
    // ankle + foot
    ellipsoid([-0.106, 0.075, -0.012], 0.04, 0.04, 0.045),
    { a: [-0.106, 0.055, -0.018], b: [-0.104, 0.032, 0.108], ra: 0.039, rb: 0.026, capA: false, sx: 0.95, sz: 1 },
  ];

  return [
    /* head + neck */
    ellipsoid([0, 1.648, 0.004], 0.094, 0.122, 0.112),
    // jaw — slightly forward and narrower, keeps the head from reading as a ball
    ellipsoid([0, 1.572, 0.026], 0.068, 0.052, 0.078),
    { a: [0, 1.49, -0.005], b: [0, 1.565, -0.002], ra: 0.052, rb: 0.055, sz: 0.88 },

    /* shoulder girdle */
    { a: [-0.145, 1.438, -0.008], b: [0.145, 1.438, -0.008], ra: 0.072, sz: 0.78, capA: false, capB: false },

    /* torso: three stacked frusta, flattened front-to-back */
    { a: [0, 1.44, 0], b: [0, 1.26, 0], ra: 0.158, rb: 0.163, sz: 0.6, capA: false, capB: false },
    { a: [0, 1.26, 0], b: [0, 1.1, 0], ra: 0.163, rb: 0.133, sz: 0.62, capA: false, capB: false },
    { a: [0, 1.1, 0], b: [0, 0.99, 0], ra: 0.133, rb: 0.142, sz: 0.66, capA: false, capB: false },
    /* pelvis */
    { a: [0, 0.99, 0], b: [0, 0.9, -0.005], ra: 0.142, rb: 0.135, sz: 0.7, capA: false, capB: false },

    ...pair(armL),
    ...pair(legL),
  ];
}

/* ------------------------------------------------------------------ */
/* Organs                                                               */
/* ------------------------------------------------------------------ */

/**
 * Heart — left of midline, apex pointing down-left-forward. Built from the
 * ventricular mass, both atria, and the great vessels arching off the base.
 */
export function heartParts(): Part[] {
  const cx = -0.03;
  const cy = 1.245;
  const cz = 0.028;
  const V = (x: number, y: number, z: number): Vec3 => [cx + x, cy + y, cz + z];

  return [
    // left ventricle: the bulk, tapering to the apex
    { a: V(0.005, 0.045, 0), b: V(-0.038, -0.062, 0.022), ra: 0.052, rb: 0.009, sz: 0.88, capA: true },
    // right ventricle, bulging anteriorly
    ellipsoid(V(0.026, -0.002, 0.03), 0.038, 0.044, 0.031, { w: 0.8 }),
    // left atrium
    ellipsoid(V(-0.012, 0.062, -0.018), 0.034, 0.028, 0.03),
    // right atrium
    ellipsoid(V(0.038, 0.052, 0.008), 0.031, 0.03, 0.028),

    // aortic arch, sweeping up and back over the pulmonary trunk
    ...tube(
      [V(0.004, 0.06, 0.004), V(0.008, 0.105, -0.002), V(-0.004, 0.135, -0.016), V(-0.03, 0.128, -0.03), V(-0.034, 0.09, -0.036)],
      0.016,
      0.013,
      { noCull: true, w: 0.5 }
    ),
    // pulmonary trunk, forward of the aorta, bifurcating
    ...tube([V(0.016, 0.062, 0.03), V(0.006, 0.098, 0.022), V(-0.012, 0.112, 0.004)], 0.014, 0.011, { noCull: true, w: 0.35 }),
    // superior vena cava
    ...tube([V(0.05, 0.06, 0.004), V(0.052, 0.115, -0.006)], 0.012, 0.011, { noCull: true, w: 0.25 }),
    // coronary arteries traced over the ventricular surface
    ...tube([V(0.012, 0.04, 0.034), V(-0.006, 0.006, 0.042), V(-0.026, -0.036, 0.034)], 0.005, 0.0035, { noCull: true, w: 0.3 }),
    ...tube([V(0.04, 0.034, 0.016), V(0.05, -0.004, 0.012), V(0.034, -0.038, 0.016)], 0.005, 0.0035, { noCull: true, w: 0.3 }),
  ];
}

/**
 * Lungs — two lobed volumes carved by the diaphragm below and, on the left,
 * by the cardiac notch. The bronchial tree is generated recursively and
 * flagged noCull so it survives inside the parenchyma.
 */
export function lungParts(): Part[] {
  const parts: Part[] = [];

  const lung = (sign: number): Part[] => {
    const x = 0.088 * sign;
    return [
      // apex → base, widening and flattening
      { a: [x * 0.62, 1.395, -0.01], b: [x * 1.25, 1.1, 0.0], ra: 0.038, rb: 0.088, sx: 1, sz: 0.78 },
      ellipsoid([x * 1.2, 1.115, 0.0], 0.072, 0.07, 0.056),
    ];
  };

  parts.push(...lung(-1), ...lung(1));

  // Diaphragm: a large sphere beneath, carving the concave lung bases.
  parts.push(ellipsoid([0, 0.92, 0.0], 0.34, 0.2, 0.26, { subtract: true }));
  // Mediastinum: clears the central column where the heart and trachea sit.
  parts.push({ a: [0, 1.42, 0], b: [0, 1.08, 0], ra: 0.03, rb: 0.034, sz: 1.3, subtract: true });
  // Cardiac notch, left lung only (patient's left = negative x here).
  parts.push(ellipsoid([-0.055, 1.235, 0.03], 0.062, 0.075, 0.07, { subtract: true }));

  // Trachea and main bronchi.
  parts.push(...tube([[0, 1.46, -0.005], [0, 1.325, -0.004]], 0.013, 0.012, { noCull: true, w: 0.3 }));

  // Recursive bronchial tree. Three generations is enough to read as a tree
  // at particle density without flooding the buffer.
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
  branch([0, 1.325, -0.004], normalize([-0.72, -0.62, 0.1]), 0.055, 0.0095, 4, rng);
  branch([0, 1.325, -0.004], normalize([0.72, -0.58, 0.1]), 0.05, 0.0095, 4, rng);

  return parts;
}

/**
 * Brain — gyrified cerebrum split into two hemispheres, plus cerebellum and
 * brainstem. The `gyri` term is what turns a plain ellipsoid into folds.
 */
export function brainParts(): Part[] {
  const cy = 1.662;
  return [
    ellipsoid([-0.036, cy, 0.004], 0.052, 0.062, 0.078, { gyri: 0.12 }),
    ellipsoid([0.036, cy, 0.004], 0.052, 0.062, 0.078, { gyri: 0.12 }),
    // frontal lobes, leaning forward
    ellipsoid([-0.03, cy - 0.006, 0.058], 0.04, 0.047, 0.042, { gyri: 0.11 }),
    ellipsoid([0.03, cy - 0.006, 0.058], 0.04, 0.047, 0.042, { gyri: 0.11 }),
    // temporal lobes
    ellipsoid([-0.058, cy - 0.052, 0.022], 0.026, 0.03, 0.05, { gyri: 0.09 }),
    ellipsoid([0.058, cy - 0.052, 0.022], 0.026, 0.03, 0.05, { gyri: 0.09 }),
    // cerebellum
    ellipsoid([0, cy - 0.062, -0.052], 0.05, 0.03, 0.034, { gyri: 0.16 }),
    // brainstem down into the foramen magnum
    { a: [0, cy - 0.036, -0.016], b: [0, cy - 0.12, -0.022], ra: 0.016, rb: 0.013, noCull: true, w: 0.4 },
  ];
}

/** Liver — a large right-sided wedge with the inferior border carved flat. */
export function liverParts(): Part[] {
  return [
    ellipsoid([0.055, 1.105, 0.01], 0.125, 0.07, 0.078),
    // left lobe, smaller, crossing the midline
    ellipsoid([-0.06, 1.095, 0.028], 0.06, 0.042, 0.052),
    // carve the inferior surface flat against the stomach and gallbladder bed
    ellipsoid([0.02, 0.985, 0.03], 0.2, 0.072, 0.14, { subtract: true }),
    // gallbladder, tucked under the right lobe
    ellipsoid([0.055, 1.052, 0.052], 0.018, 0.026, 0.018, { noCull: true, w: 0.25 }),
  ];
}

/** Kidneys — paired beans, hilum carved medially, with ureters descending. */
export function kidneyParts(): Part[] {
  const kidney = (sign: number): Part[] => [
    ellipsoid([0.072 * sign, 1.045, -0.062], 0.03, 0.055, 0.03),
    // hilum: carve the medial concavity
    ellipsoid([0.04 * sign, 1.045, -0.062], 0.026, 0.03, 0.03, { subtract: true }),
    // ureter
    ...tube(
      [
        [0.05 * sign, 1.032, -0.06],
        [0.045 * sign, 0.97, -0.05],
        [0.03 * sign, 0.918, -0.03],
      ],
      0.005,
      0.004,
      { noCull: true, w: 0.25 }
    ),
  ];
  return [
    ...kidney(-1),
    ...kidney(1),
    // bladder
    ellipsoid([0, 0.898, 0.01], 0.034, 0.03, 0.03, { w: 0.4 }),
  ];
}

/**
 * Skeleton — skull, spine, ribcage, girdles and long bones. This one is a
 * whole-body structure rather than a single organ, so the camera treats it
 * differently (pulls back instead of closing in).
 */
export function skeletonParts(): Part[] {
  const parts: Part[] = [];

  /*
   * skull + mandible
   *
   * Sampling is area-weighted, so large closed masses (skull, pelvis, joint
   * ends) would otherwise take most of the budget and, under additive
   * blending, read as solid white blobs while the ribs and spine fade out.
   * The `w` values below deliberately under-weight the big masses and
   * over-weight the thin structures that actually carry the anatomy.
   */
  parts.push(ellipsoid([0, 1.652, 0.004], 0.082, 0.102, 0.096, { w: 0.34 }));
  parts.push(ellipsoid([0, 1.578, 0.03], 0.058, 0.04, 0.062, { w: 0.2 }));

  /* vertebral column: a gentle S from C1 to the sacrum */
  const vertebrae = 24;
  const spinePoint = (t: number): Vec3 => {
    const y = 1.49 - t * 0.56;
    // cervical lordosis → thoracic kyphosis → lumbar lordosis
    const z = -0.02 + Math.sin(t * Math.PI * 1.9 + 0.35) * 0.026;
    return [0, y, z];
  };
  for (let i = 0; i < vertebrae; i++) {
    const t = i / (vertebrae - 1);
    const p = spinePoint(t);
    const r = 0.016 + t * 0.011;
    parts.push(ellipsoid(p, r, 0.011, r * 0.9, { w: 0.5 }));
    // spinous process, angled down and back
    parts.push({
      a: [0, p[1], p[2] - r * 0.8],
      b: [0, p[1] - 0.012, p[2] - r * 0.8 - 0.022],
      ra: 0.006,
      rb: 0.004,
      w: 0.3,
    });
  }
  // sacrum + coccyx
  parts.push(ellipsoid([0, 0.905, -0.042], 0.042, 0.055, 0.022, { w: 0.22 }));

  /* ribcage: 12 pairs sweeping from the spine round to the sternum */
  for (let i = 0; i < 12; i++) {
    const t = i / 11;
    const spineT = 0.18 + t * 0.44;
    const origin = spinePoint(spineT);
    // ribs widen to ~rib 7 then taper
    const spread = Math.sin((0.25 + t * 0.72) * Math.PI) * 0.155 + 0.03;
    const drop = 0.035 + t * 0.055;
    const front = 0.1 - t * 0.012;
    const floating = i >= 10;

    for (const sign of [-1, 1]) {
      const pts: Vec3[] = [
        [origin[0], origin[1], origin[2]],
        [sign * spread * 0.75, origin[1] - drop * 0.25, origin[2] + 0.03],
        [sign * spread, origin[1] - drop * 0.62, origin[2] + front * 0.45],
        [sign * spread * 0.62, origin[1] - drop, origin[2] + front * 0.86],
      ];
      if (floating) pts.length = 3; // ribs 11–12 stop short of the sternum
      else pts.push([sign * 0.026, origin[1] - drop * 1.12, origin[2] + front]);
      parts.push(...tube(pts, 0.0072, 0.0055, { w: 0.62 }));
    }
  }

  /* sternum */
  parts.push({ a: [0, 1.345, 0.082], b: [0, 1.195, 0.072], ra: 0.021, rb: 0.012, sz: 0.4, w: 0.22 });

  /* clavicles + scapulae */
  for (const sign of [-1, 1]) {
    parts.push(
      ...tube(
        [
          [sign * 0.012, 1.405, 0.055],
          [sign * 0.082, 1.412, 0.052],
          [sign * 0.15, 1.4, 0.018],
        ],
        0.008,
        0.007,
        { w: 0.4 }
      )
    );
    parts.push(ellipsoid([sign * 0.11, 1.345, -0.055], 0.055, 0.07, 0.014, { w: 0.16 }));
  }

  /* pelvis: iliac wings + pubic rami */
  for (const sign of [-1, 1]) {
    parts.push(ellipsoid([sign * 0.088, 0.952, -0.012], 0.05, 0.062, 0.026, { w: 0.2 }));
    parts.push(
      ...tube(
        [
          [sign * 0.075, 0.9, 0.012],
          [sign * 0.04, 0.878, 0.038],
          [0, 0.872, 0.042],
        ],
        0.011,
        0.009,
        { w: 0.3 }
      )
    );
  }

  /* long bones — a shaft with a bulbous end at each joint */
  const longBone = (a: Vec3, b: Vec3, rShaft: number, rEnd: number, w = 0.45): Part[] => [
    { a, b, ra: rShaft, rb: rShaft * 0.92, capA: false, capB: false, w },
    // Joint ends are heavily overlapped by the shaft and by each other, so
    // they take a fraction of the shaft's weight.
    ellipsoid(a, rEnd, rEnd, rEnd, { w: w * 0.22 }),
    ellipsoid(b, rEnd * 0.9, rEnd * 0.9, rEnd * 0.9, { w: w * 0.22 }),
  ];

  for (const sign of [-1, 1]) {
    // humerus / radius / ulna
    parts.push(...longBone([sign * 0.16, 1.395, 0.0], [sign * 0.253, 1.115, 0.012], 0.014, 0.024));
    parts.push(...longBone([sign * 0.247, 1.1, 0.02], [sign * 0.292, 0.85, 0.034], 0.009, 0.014, 0.25));
    parts.push(...longBone([sign * 0.265, 1.1, 0.006], [sign * 0.303, 0.848, 0.024], 0.009, 0.013, 0.25));
    // metacarpals, rendered as a small fan rather than individual phalanges
    for (let f = 0; f < 4; f++) {
      const o = (f - 1.5) * 0.013;
      parts.push({
        a: [sign * (0.3 + o * 0.2), 0.838, 0.03 + o],
        b: [sign * (0.308 + o * 0.3), 0.768, 0.034 + o * 1.4],
        ra: 0.0042,
        rb: 0.0032,
        w: 0.08,
      });
    }
    // femur / tibia / fibula
    parts.push(...longBone([sign * 0.085, 0.91, -0.008], [sign * 0.102, 0.512, 0.004], 0.018, 0.032, 0.42));
    parts.push(...longBone([sign * 0.1, 0.5, 0.004], [sign * 0.105, 0.1, -0.004], 0.014, 0.024, 0.4));
    parts.push(...longBone([sign * 0.126, 0.492, -0.004], [sign * 0.122, 0.105, -0.008], 0.006, 0.009, 0.15));
    // patella
    parts.push(ellipsoid([sign * 0.1, 0.512, 0.036], 0.018, 0.02, 0.008, { w: 0.1 }));
    // tarsals + metatarsals
    parts.push(ellipsoid([sign * 0.105, 0.062, -0.022], 0.028, 0.03, 0.03, { w: 0.14 }));
    for (let f = 0; f < 4; f++) {
      const o = (f - 1.5) * 0.013;
      parts.push({
        a: [sign * (0.105 + o * 0.5), 0.045, -0.002],
        b: [sign * (0.102 + o), 0.028, 0.092],
        ra: 0.005,
        rb: 0.0038,
        w: 0.1,
      });
    }
  }

  return parts;
}
