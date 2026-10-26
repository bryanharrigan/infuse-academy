/**
 * app/components/holographic/holo-engine.client.ts
 *
 * The Three.js side of the /holographic route: a particle human body you can
 * orbit, zoom and click, with each organ breaking out of the body as its own
 * point cloud.
 *
 * `.client.ts` so Remix never evaluates it on the server. It is also only
 * ever reached through a dynamic import inside an effect, so the three.js
 * bundle code-splits away from the rest of the app.
 *
 * DESIGN NOTES
 *
 * One draw call for everything. Body and all six organs live in a single
 * BufferGeometry; an `aOrgan` attribute (-1 for body, 0..5 for organs) plus a
 * `uActive` uniform decide what is visible. Switching organs changes a
 * uniform, not a buffer — which is why the transitions are free.
 *
 * Picking is done against invisible spheres rather than against the points.
 * Raycasting 150k points is both slow and fiddly (you have to pick a
 * threshold, and sparse regions become unclickable); a handful of spheres is
 * exact and costs nothing.
 *
 * Labels are HTML, not sprites. The engine projects each anchor to screen
 * space every frame and hands the coordinates back through a callback — text
 * stays crisp at any DPI and can be styled with CSS.
 */

import type {
  BufferGeometry,
  Group,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

import {
  ANATOMY_BASE,
  ANATOMY_HIRES_BASE,
  BODY_Y_OFFSET,
  centreOf,
  extentOf,
  hitSpheres,
  loadManifest,
  radiusOf,
  loadMesh,
  makeRng,
  sampleMesh,
  type Cloud,
  type Manifest,
  type StructureId,
} from "./anatomy";
import { ORGANS, type OrganId } from "./organ-catalog";

/* ------------------------------------------------------------------ */
/* Configuration                                                        */
/* ------------------------------------------------------------------ */

type HitSphere = { center: [number, number, number]; radius: number };

type OrganConfig = {
  id: OrganId;
  /** The mesh in public/anatomy this organ's cloud is scattered over. */
  structure: StructureId;
  /** Centre of the structure's bounding box, in body-centred coordinates. */
  centre: [number, number, number];
  /** Surface area in m², which sets the particle count. */
  area: number;
  /** Clickable volumes, in body-centred coordinates. */
  hits: HitSphere[];
  /** Where the camera sits when this organ is focused, relative to its centre. */
  viewDir: [number, number, number];
  /** Resolved camera distance in metres. */
  viewDist: number;
  /** Where the HTML label is pinned, in body-centred coordinates. */
  labelAt: [number, number, number];
  accent: number;
  /** Mirrors Organ.labelSide — which way the floating label reads. */
  labelSide: "left" | "right";
  /**
   * Mirrors Organ.framing in organ-catalog. A "body" structure spans the
   * whole figure, so focusing it pulls the camera back and leaves the cloud
   * at rest scale instead of diving in and swelling it.
   */
  framing: "organ" | "body";
};

/**
 * Art direction per discipline: particle budget, where the camera sits, and
 * where the floating label is pinned.
 *
 * Everything geometric — hit volumes, organ centres, label anchors — is
 * derived from the anatomy manifest at load time instead of being listed
 * here. Hand-tuned coordinates were right for the generated figure they were
 * measured against and wrong the moment the geometry changed; reading the
 * bounding boxes means the labels and click targets follow the meshes.
 */
type ViewHint = {
  /** Camera direction from the organ's centre. */
  viewDir: [number, number, number];
  /**
   * How far back to sit, as a multiple of the structure's bounding radius.
   *
   * Relative rather than absolute. A fixed distance per organ was measured
   * against whatever the geometry happened to be at the time, and it left
   * the heart as a thumbnail in the middle of a torso while the kidneys
   * overflowed the frame. Scaling by the structure's own size frames every
   * organ the same way, and keeps doing so when the meshes change.
   *
   * The value matters more than it looks. A focused organ is pushed to 30%
   * of the frame width to clear room for the learning path, and an earlier
   * attempt at a close camera clipped against that, so this was backed off
   * until nothing clipped — which left every organ about 300px wide and its
   * structure below the spacing between particles. The table starts at 36%
   * of the width, so there is room for roughly 500px. Multiplied against
   * radiusOf, which is a bounding-sphere radius and so already generous for
   * an elongated structure, 3.0 uses it without touching the table.
   */
  fill?: number;
  /** Absolute camera distance, for whole-body structures. */
  viewDist?: number;
  /**
   * Overrides the derived hit spheres. Used where the bounding box is a bad
   * click target — the skeleton's would swallow every other organ, so it is
   * picked up at the limbs instead.
   */
  hits?: HitSphere[];
  /** Overrides the derived label anchor. */
  labelAt?: [number, number, number];
};

const VIEW_HINTS: Record<OrganId, ViewHint> = {
  brain: { viewDir: [0.38, 0.22, 1], fill: 3.0 },
  heart: { viewDir: [0.34, 0.14, 1], fill: 3.0 },
  lungs: { viewDir: [0.18, 0.1, 1], fill: 3.0 },
  liver: { viewDir: [0.5, 0.12, 1], fill: 3.0 },
  // Retroperitoneal — the teaching view is from behind.
  kidneys: { viewDir: [0.3, 0.18, -1], fill: 3.0 },
  digestive: { viewDir: [0.26, 0.1, 1], fill: 3.0 },
  vascular: { viewDir: [0.3, 0.1, 1], viewDist: 3.0 },
  muscular: { viewDir: [0.3, 0.12, 1], viewDist: 2.9 },
  eyes: { viewDir: [0.1, 0.05, 1], fill: 3.0 },
  skeleton: {
    viewDir: [0.3, 0.1, 1],
    viewDist: 3.05,
    // No central volume — it would swallow every other organ. The limbs are
    // the only places the skeleton is the obvious thing under the cursor.
    hits: [
      { center: [-0.095, -0.3, 0], radius: 0.1 },
      { center: [0.095, -0.3, 0], radius: 0.1 },
      { center: [-0.28, 0.0, 0.02], radius: 0.07 },
      { center: [0.28, 0.0, 0.02], radius: 0.07 },
    ],
    labelAt: [0.38, -0.34, 0.04],
  },
};

/**
 * Builds the runtime organ table by joining the catalog's metadata to the
 * geometry the manifest reports.
 */
function organConfigs(manifest: Manifest): OrganConfig[] {
  const out: OrganConfig[] = [];
  for (const organ of ORGANS) {
    const meta = manifest.structures[organ.structure];
    if (!meta) continue; // structure absent from this asset build
    const hint = VIEW_HINTS[organ.id];
    const hits = hint.hits ?? hitSpheres(meta, organ.paired);
    const c = centreOf(meta);
    const ext = extentOf(meta);
    // Park the label clear of the organ, on the side the catalog asked for.
    const lateral = (organ.labelSide === "left" ? -1 : 1) * (ext[0] / 2 + 0.17);
    out.push({
      id: organ.id,
      structure: organ.structure,
      area: meta.area,
      hits,
      viewDir: hint.viewDir,
      viewDist: hint.viewDist ?? radiusOf(meta) * (hint.fill ?? 2.7),
      labelAt: hint.labelAt ?? [c[0] + lateral, c[1] + ext[1] * 0.18, c[2] + 0.04],
      accent: parseInt(organ.accent.replace("#", ""), 16),
      labelSide: organ.labelSide,
      framing: organ.framing,
      centre: c,
    });
  }
  return out;
}

/**
 * World-space radius of a single particle, in metres. At ~3mm a 1.76m figure
 * resolves as a dense cloud of discrete points rather than either a solid
 * sheet or a sparse dusting.
 */
/**
 * World radius of a figure particle, in metres.
 *
 * At the resting camera this projects to roughly one CSS pixel, so the
 * figure's apparent resolution is set by how many particles there are rather
 * than by how big each one is — which is why the quality tiers move counts
 * and leave this alone. Slightly finer than the 3.4 mm it was tuned at, to
 * sharpen the silhouette; the exposure model raises alpha to match.
 */
const PARTICLE_RADIUS = 0.0029;

/**
 * Resting camera. The figure spans y -1.0 to 0.77, so the target sits a
 * little below the origin to centre it, and 3.0m leaves head and feet clear
 * of the frame edges at a 42-degree vertical field of view.
 */
const HOME_TARGET = new THREE.Vector3(0, -0.07, 0);
const HOME_POSITION = new THREE.Vector3(0.52, 0.1, 3.0);

/**
 * Where the subject sits horizontally, as a fraction of canvas width.
 *
 * The left rail covers the first ~290px, and when a learning path is open the
 * course tiles claim the right. Rather than moving the model — which would
 * drag the orbit pivot with it — we offset the camera frustum, so the subject
 * slides across the screen while orbiting still spins it about its own axis.
 */
const FOCUS_FRACTION = { rest: 0.58, organ: 0.3, narrow: 0.5 };

export type QualityTier = "low" | "medium" | "high";

const BUDGETS: Record<
  QualityTier,
  { body: number; dust: number; organDensity: number; organCap: number }
> = {
  low: { body: 48000, dust: 1000, organDensity: 170_000, organCap: 60_000 },
  medium: { body: 92000, dust: 2000, organDensity: 320_000, organCap: 110_000 },
  high: { body: 160000, dust: 3200, organDensity: 520_000, organCap: 170_000 },
};

/**
 * How many particles a structure gets: its surface area times the tier's
 * density, floored so a small structure stays solid and capped so a
 * whole-body one does not eat the memory budget on its own.
 *
 * This used to be a hand-picked number per organ, and the numbers bore no
 * relation to the surfaces they had to cover. Measured across the set they
 * ranged from 980 000 points per square metre on the eyes down to 48 000 on
 * the musculature — a twentyfold spread, which is precisely why some organs
 * read as solid structures and others as a scattering of dots. Deriving the
 * count means a structure added later is dense enough without anyone having
 * to notice, and the tiers mean what they say.
 *
 * The cap binds on the skeleton, the musculature and the digestive tract.
 * Those spread ten times the heart's surface over roughly the same area of
 * screen, so they cannot reach its density without a count nothing would
 * thank us for; they land about a third of the way there, which is still
 * three times what they had.
 */
const organPointCount = (area: number, tier: QualityTier) =>
  Math.round(
    THREE.MathUtils.clamp(
      area * BUDGETS[tier].organDensity,
      Math.min(16_000, BUDGETS[tier].organCap),
      BUDGETS[tier].organCap
    )
  );
/**
 * Target light per unit of surface, in the additive sum the shader builds up.
 *
 * Everything about particle brightness reduces to one identity. Under
 * additive blending the light reaching a pixel is
 *
 *     alpha x radius^2 x (points per m^2 of surface) x (surfaces crossed)
 *
 * and camera distance cancels out of it, because closing in enlarges every
 * sprite by exactly as much as it thins the points across the screen.
 *
 * So rather than tune alpha and then re-tune it every time a particle count
 * or radius moves, the engine fixes the product and solves for alpha. Raising
 * a quality tier's budget then buys finer grain at the same exposure instead
 * of a brighter figure — which is the whole point of a quality tier — and
 * this constant is the single dial for how hard the subject reads against
 * the background.
 *
 * The value is the figure's old hand-tuned look — 25 000 points/m2 of 3.4 mm
 * particles — lifted by 1.75. A quarter of that makes up for the tighter
 * sprite falloff below, whose integral over the disc goes as 1/(n+1) and so
 * drops a fifth going from 2.2 to 3.0. The rest is the contrast the subject
 * needed against the background.
 */
const EXPOSURE = 25000 * 0.0034 ** 2 * 1.75;

/**
 * A note on shading, so nobody spends the afternoon I did.
 *
 * The sampler computes a surface normal for every particle, and it is
 * tempting to weight each one by how its surface faces the eye — Fresnel for
 * the edges, a key light for the faces. Rendered offline at low overlap it
 * transforms these organs: a heart grows chambers, coronaries and an arch.
 *
 * In this renderer it does nothing. Measured across eight structures it
 * moved contrast between -4% and +5%, and not consistently upward. The
 * reason is that shading varies per particle, while a pixel sums every
 * particle that lands on it. At the densities these organs need in order to
 * read as solid, five to ten normals share a pixel and the pixel gets their
 * mean — which the exposure model pins to a constant. The variation cancels
 * exactly where the detail was wanted.
 *
 * It would pay off at low particle density, or at a much tighter camera.
 * Neither is where this page lives. What actually separated the organs was
 * giving each one a point count proportional to its surface area; see
 * organPointCount below. tools/shading-preview reproduces the experiment.
 */

/**
 * Particle radius for a structure, from how big that structure is.
 *
 * A particle is drawn at a pixel size proportional to radius / distance, so
 * carrying the figure's particles into a close-up of the heart puts every one
 * of them several pixels across and the organ dissolves into a glowing ball —
 * which is exactly what it did. Scaling the radius with the square root of
 * the structure's size keeps roughly the same number of particles across its
 * silhouette whatever is being looked at, so a heart resolves its chambers
 * the way the figure resolves its limbs.
 *
 * Brightness follows automatically: densityCompensation divides by radius^2,
 * so a smaller particle is a brighter one and the exposure holds.
 */
const radiusFor = (extent: number, bodyExtent: number) =>
  THREE.MathUtils.clamp(
    PARTICLE_RADIUS * Math.sqrt(extent / Math.max(bodyExtent, 0.001)),
    0.0008,
    PARTICLE_RADIUS
  );

/**
 * Extra trim on the focused organ, beyond what the depth measurement gives.
 *
 * depth is a 90th percentile, and the places that clip are thicker still.
 * Additive blending has no shoulder below the tone curve to absorb that, so
 * a compact organ corrected only to its p90 still goes white in the middle.
 */
const ORGAN_EXPOSURE = 0.85;

/**
 * Per-particle alpha for one cloud: solve the identity above for alpha.
 *
 * The depth term is the one that is easy to forget and impossible to miss
 * once it is wrong. Spreading points by surface area assumes a view ray
 * crosses one surface. True for the skin; false for a heart, whose chamber
 * cavities, walls, valve leaflets and vessel stubs stack three or four deep,
 * and false for a brain with its folded cortex. The pipeline measures it and
 * the manifest carries it; dividing by it relative to the figure's own depth
 * leaves the body untouched and pulls the nested organs back into range.
 */
const densityCompensation = (
  cloud: Cloud,
  depth: number,
  bodyDepth: number,
  radius: number,
  trim = 1
) =>
  THREE.MathUtils.clamp(
    (EXPOSURE * cloud.area) /
      (radius * radius * Math.max(cloud.count, 1)) /
      Math.max(depth / Math.max(bodyDepth, 0.001), 0.25) *
      trim,
    0.02,
    8
  );

/**
 * Translucent, edge-lit surface material for a focused organ.
 *
 * Particles cannot show what this shows, and five measured attempts at
 * making them establish it: additive point clouds sum every surface along a
 * view ray, so a closed organ fills its own silhouette and no amount of
 * shading, density or bloom tuning recovers the structure inside. A surface
 * can occlude, which is the whole difference.
 *
 * Fresnel on the edges, a key light on the faces, normal blending so the
 * near wall hides the far one. The same geometry the particles are scattered
 * over, at four times the triangle budget so the facets do not show.
 */
function organSurfaceMaterial(accent: number): ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColour: { value: new THREE.Color(accent) },
      uLight: { value: new THREE.Vector3(0.35, 0.7, 0.6).normalize() },
      uFade: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vView;
      void main() {
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3  uColour;
      uniform vec3  uLight;
      uniform float uFade;
      uniform float uTime;
      varying vec3 vN;
      varying vec3 vView;
      void main() {
        vec3 n = normalize(vN);
        float f = pow(1.0 - abs(dot(n, normalize(vView))), 1.5);
        float key = max(dot(n, normalize(uLight)), 0.0);
        // A slow breath across the surface, so it still reads as projected
        // light rather than as a solid plastic model.
        float pulse = 0.97 + 0.03 * sin(uTime * 1.1);
        vec3 col = uColour * (0.40 + 0.60 * key) + vec3(f * 0.45);
        gl_FragColor = vec4(col * pulse, clamp(0.26 + f * 0.58, 0.0, 1.0) * uFade);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    side: THREE.FrontSide,
  });
}

/* ------------------------------------------------------------------ */
/* Shaders                                                              */
/* ------------------------------------------------------------------ */

const PARTICLE_VERT = /* glsl */ `
  attribute vec3 aScatter;
  attribute float aSize;
  attribute float aSeed;
  attribute float aOrgan;
  attribute float aDensity;
  attribute float aRadius;   // world radius, per structure

  uniform float uTime;
  uniform float uForm;        // 0 = scattered cloud, 1 = assembled body
  uniform float uBodyAlpha;
  uniform float uActive;      // focused organ index, -1 for none
  uniform float uReveal;      // focused organ opacity
  uniform float uGhost;       // unfocused organ opacity (x-ray mode)
  uniform vec3  uOrganCenter;
  uniform float uOrganScale;
  uniform float uScanY;
  uniform float uScanWidth;
  uniform float uScanStrength;
  uniform float uPixelRatio;
  uniform float uSize;
  uniform float uRadius;      // figure's particle radius, in world metres
  uniform float uScale;       // (viewportHeightCss / 2) / tan(fov / 2)
  uniform float uDrift;

  varying float vAlpha;
  varying float vHeat;
  varying float vSeed;
  varying float vActive;
  varying float vSize;

  void main() {
    float isBody   = step(aOrgan, -0.5);
    float isActive = (1.0 - step(0.5, abs(aOrgan - uActive))) * (1.0 - isBody);
    float isOther  = (1.0 - isBody) * (1.0 - isActive);

    vAlpha = (isBody * uBodyAlpha + isActive * uReveal + isOther * uGhost) * aDensity;
    vActive = isActive;
    vSeed = aSeed;

    // Five of the six organs are invisible at any moment. Discarding them in
    // the fragment shader would still rasterise every sprite, so push them
    // behind the near plane instead and skip the work entirely.
    if (vAlpha < 0.004) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }

    vec3 p = position;

    // The focused organ swells about its own centre, so selecting it reads as
    // the organ lifting out of the body rather than the camera just moving.
    p = mix(p, uOrganCenter + (p - uOrganCenter) * uOrganScale, isActive);

    // Low-frequency drift. Three decorrelated sine fields are enough to look
    // like flow without the cost of real curl noise.
    float ph = aSeed * 6.2831853;
    float amp = uDrift * (1.0 + isActive * 1.4);
    p.x += sin(uTime * 0.55 + ph + p.y * 5.3) * amp;
    p.y += sin(uTime * 0.47 + ph * 1.7 + p.z * 5.1) * amp;
    p.z += sin(uTime * 0.63 + ph * 2.3 + p.x * 4.9) * amp;

    // Boot: particles converge from a scattered shell.
    p = mix(aScatter, p, uForm);

    float scan = exp(-pow((p.y - uScanY) / uScanWidth, 2.0)) * uScanStrength;
    vHeat = scan;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;


    // Perspective-correct: a particle is a sphere of uRadius metres, so its
    // projected size is radius * (viewportScale / distance). Deriving it
    // rather than tuning a constant keeps the figure looking identical at
    // every viewport size and field of view.
    float size = aSize * aRadius * uSize * uScale * uPixelRatio / max(-mv.z, 0.05);
    size *= (1.0 + scan * 0.7) * mix(1.0, 1.25, isActive);
    size = clamp(size, 0.4, 9.0 * uPixelRatio);
    gl_PointSize = size;
    vSize = size;

    // Light per pixel works out as alpha x radius^2 x (points per unit
    // surface area) — the camera distance cancels, because moving closer
    // grows each sprite by exactly as much as it thins the points across the
    // screen. So density compensation alone sets the brightness, and this
    // only has to stop a sprite from smearing at extreme close range.
    vAlpha *= clamp((6.0 * uPixelRatio) / max(size, 1.0), 0.35, 1.0);
  }
`;

const PARTICLE_FRAG = /* glsl */ `
  precision highp float;

  uniform vec3  uColDeep;
  uniform vec3  uColCyan;
  uniform vec3  uColAccent;
  uniform float uAccentMix;

  varying float vAlpha;
  varying float vHeat;
  varying float vSeed;
  varying float vActive;
  varying float vSize;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = dot(uv, uv);
    if (d > 0.25) discard;

    // Soft disc with a hot core — a flat disc reads as confetti, a pure
    // gaussian reads as fog. This sits between the two.
    //
    // The exponent follows the sprite's own size, because the same number
    // means opposite things at the two scales this renderer works at. A
    // particle on the whole figure covers about a pixel, where a profile is
    // not resolvable and a steep one only discards light; a particle on a
    // focused organ covers several, where a steep profile is exactly what
    // keeps neighbouring points distinguishable instead of bleeding into a
    // continuous haze. Fixing it at either value costs the other view.
    float falloff = 1.0 - d * 4.0;
    float shape = mix(1.9, 3.2, smoothstep(1.5, 5.0, vSize));
    float a = pow(falloff, shape) * vAlpha;
    if (a < 0.002) discard;

    vec3 col = mix(uColDeep, uColCyan, smoothstep(0.15, 0.92, vSeed));
    col = mix(col, uColAccent, vActive * uAccentMix);
    // The sweep brightens what it crosses; it does not replace it. Pushed
    // harder it clipped a band of pure white across the whole torso, which
    // read as a rendering fault rather than as a scan.
    col += vec3(0.30, 0.62, 0.95) * vHeat * 0.55;
    col += vec3(vHeat * vHeat * 0.16);

    gl_FragColor = vec4(col, a);
  }
`;

/** Final grade: scanlines, chromatic fringe, grain, vignette, interference. */
const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as unknown },
    uTime: { value: 0 },
    uResolution: { value: null as unknown },
    uScanlines: { value: 1.0 },
    uAberration: { value: 1.0 },
    uVignette: { value: 1.0 },
    uGlitch: { value: 0.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2  uResolution;
    uniform float uScanlines;
    uniform float uAberration;
    uniform float uVignette;
    uniform float uGlitch;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centred = uv - 0.5;

      // Horizontal tear that sweeps the frame when an organ is selected.
      float band = smoothstep(0.0, 0.015, abs(fract(uv.y * 1.0 - uTime * 0.35) - 0.5) - 0.48);
      uv.x += band * uGlitch * 0.012 * (hash(vec2(uv.y, floor(uTime * 20.0))) - 0.5);

      // Chromatic aberration, growing toward the edges like a real lens.
      float r2 = dot(centred, centred);
      vec2 offset = centred * r2 * 0.016 * uAberration;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + offset).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - offset).b;

      // CRT scanlines, locked to device pixels so they never moire.
      float line = sin(uv.y * uResolution.y * 1.4 + uTime * 1.2);
      col *= 1.0 - uScanlines * 0.055 * (0.5 + 0.5 * line);

      // A slow bright band drifting down the frame.
      float sweep = exp(-pow((fract(uv.y + uTime * 0.045) - 0.5) * 7.0, 2.0));
      col += vec3(0.02, 0.06, 0.1) * sweep;

      // Grain, resolution-independent.
      float g = hash(uv * uResolution + fract(uTime) * 91.7) - 0.5;
      col += g * 0.022;

      // Vignette.
      col *= 1.0 - uVignette * smoothstep(0.32, 0.95, length(centred) * 1.25);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/* ------------------------------------------------------------------ */
/* Public types                                                         */
/* ------------------------------------------------------------------ */

export type LabelPosition = {
  id: OrganId;
  /** CSS pixels relative to the canvas. */
  x: number;
  y: number;
  /** False when the anchor is behind the camera or off-screen. */
  visible: boolean;
  /** 0..1, closer is larger. Lets the HUD scale labels with depth. */
  depth: number;
  /** Which way the label reads from its anchor. */
  side: "left" | "right";
};

export type EngineCallbacks = {
  onHover?: (id: OrganId | null) => void;
  onSelect?: (id: OrganId | null) => void;
  onLabels?: (labels: LabelPosition[]) => void;
  onReady?: () => void;
  onProgress?: (fraction: number, stage: string) => void;
};

export type EngineOptions = {
  quality?: QualityTier;
  reducedMotion?: boolean;
};

/* ------------------------------------------------------------------ */
/* Engine                                                               */
/* ------------------------------------------------------------------ */

export class HoloEngine {
  private canvas: HTMLCanvasElement;
  private renderer!: WebGLRenderer;
  private scene!: Scene;
  private camera!: PerspectiveCamera;
  private controls!: OrbitControls;
  private composer!: EffectComposer;
  private bloom!: UnrealBloomPass;
  private grade!: ShaderPass;

  private points!: Points;
  private material!: ShaderMaterial;
  private dust!: Points;
  private hud!: Group;
  private reticle!: Group;
  private hitMeshes: Mesh[] = [];

  /** Geometry description for this asset build, fetched during init. */
  private manifest!: Manifest;
  /** Runtime organ table, joined from the catalog and the manifest. */
  private organs: OrganConfig[] = [];
  /** Cancels in-flight asset fetches when the engine is disposed mid-load. */
  private abort = new AbortController();

  /** Dense manifest for the surface meshes, fetched on the first focus. */
  private hiManifest?: Manifest;
  /** Surface meshes already built, keyed by structure. */
  private surfaces = new Map<StructureId, Mesh>();
  /** In-flight surface loads, so a double click does not fetch twice. */
  private surfaceLoads = new Map<StructureId, Promise<void>>();
  /** The surface currently showing, if any. */
  private surface?: Mesh;

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pointerInside = false;

  private clock = new THREE.Clock();
  private frame = 0;
  private running = false;
  private disposed = false;

  private callbacks: EngineCallbacks;
  private quality: QualityTier;
  private reducedMotion: boolean;

  /** Current and target values for everything we ease rather than snap. */
  private state = {
    form: 0,
    formTarget: 1,
    bodyAlpha: 1.0,
    bodyAlphaTarget: 1.0,
    reveal: 0,
    revealTarget: 0,
    ghost: 0,
    ghostTarget: 0,
    organScale: 1,
    organScaleTarget: 1,
    accentMix: 0,
    accentMixTarget: 0,
    /** Cross-fade between the particle organ and its shaded surface. */
    surface: 0,
    surfaceTarget: 0,
    glitch: 0,
    scanY: -1.2,
    bloomStrength: 0.38,
    bloomTarget: 0.38,
  };

  private active: OrganId | null = null;
  private hovered: OrganId | null = null;
  private xray = false;

  private camFrom = new THREE.Vector3();
  private camTo = new THREE.Vector3();
  private tgtFrom = new THREE.Vector3();
  private tgtTo = new THREE.Vector3();
  private camT = 1;
  private camDuration = 1.2;

  private lastInteraction = 0;
  private labelScratch: LabelPosition[] = [];
  private tmpVec = new THREE.Vector3();
  private resizeObserver?: ResizeObserver;

  constructor(
    canvas: HTMLCanvasElement,
    callbacks: EngineCallbacks = {},
    options: EngineOptions = {}
  ) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.quality = options.quality ?? "medium";
    this.reducedMotion = options.reducedMotion ?? false;
  }

  /* ---------------------------------------------------------------- */
  /* Boot                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Builds the scene. Point-cloud generation is chunked across animation
   * frames: generating ~150k points takes roughly half a second of solid
   * maths, and doing it in one go freezes the boot animation at exactly the
   * moment the user is watching it.
   */
  async init(): Promise<void> {
    this.setupRenderer();
    this.setupScene();
    this.setupComposer();
    this.setupControls();

    const budget = BUDGETS[this.quality];
    const rng = makeRng(0xc0ffee);

    this.callbacks.onProgress?.(0.04, "LOCATING ANATOMY");
    const manifest = await loadManifest(ANATOMY_BASE);
    this.manifest = manifest;
    this.organs = organConfigs(manifest);

    // The skin is the figure, so it is fetched first and alone: the
    // silhouette should be resolving while the organs are still arriving.
    this.callbacks.onProgress?.(0.08, "RESOLVING SURFACE MESH");
    const skin = await loadMesh("skin", manifest, ANATOMY_BASE, this.abort.signal);

    // Everything else goes out at once. Ten structures fetched one after the
    // other spend most of the boot sequence waiting on round trips rather
    // than on anything the user can see happening; in parallel the browser
    // pipelines them over a single connection and the wait collapses to
    // roughly the slowest one.
    const pending = this.organs.map((cfg) =>
      loadMesh(cfg.structure, manifest, ANATOMY_BASE, this.abort.signal)
    );

    const bodyCloud = sampleMesh(skin, budget.body, rng, {
      interior: 0.1,
      interiorDepth: 0.03,
      shell: 0.0034,
      sizeMin: 0.55,
      sizeMax: 1.35,
    });
    this.callbacks.onProgress?.(0.24, "SURFACE RESOLVED");
    await nextFrame();

    const meshes = await Promise.all(pending);
    const organClouds: { id: OrganId; cloud: Cloud }[] = [];

    // Sampling stays one organ per frame. It is only a few milliseconds
    // each, but doing all ten between two frames is a visible hitch in the
    // boot animation at exactly the moment the user is watching it.
    for (let i = 0; i < this.organs.length; i++) {
      const cfg = this.organs[i];
      const count = organPointCount(cfg.area, this.quality);
      organClouds.push({
        id: cfg.id,
        // Tight to the surface. The inward scatter that gives the figure
        // its sense of volume only muddies a compact organ, where every
        // stray point lands inside the silhouette rather than against open
        // space.
        cloud: sampleMesh(meshes[i], count, rng, {
          interior: 0.05,
          interiorDepth: 0.006,
          shell: 0.0012,
          sizeMin: 0.55,
          sizeMax: 1.45,
        }),
      });
      this.callbacks.onProgress?.(
        0.24 + ((i + 1) / this.organs.length) * 0.66,
        `MAPPING ${cfg.id.toUpperCase()}`
      );
      await nextFrame();
    }

    this.buildPoints(bodyCloud, organClouds, rng);
    this.buildDust(budget.dust, rng);
    this.buildHud();
    this.buildHitVolumes();

    this.callbacks.onProgress?.(1, "SYSTEM ONLINE");
    this.attachEvents();
    this.start();
    this.callbacks.onReady?.();
  }

  private setupRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false, // bloom + additive points; MSAA buys nothing here
      alpha: false,
      powerPreference: "high-performance",
      stencil: false,
    });
    this.renderer.setClearColor(0x03060e, 1);
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
  }

  private pixelRatio() {
    const cap = this.quality === "high" ? 2 : this.quality === "medium" ? 1.6 : 1.25;
    return Math.min(window.devicePixelRatio || 1, cap);
  }

  private setupScene() {
    this.scene = new THREE.Scene();
    // No scene.fog: these points use a custom ShaderMaterial, which does not
    // include three's fog chunks, so setting it would be a silent no-op.

    const { width, height } = this.size();
    this.camera = new THREE.PerspectiveCamera(42, width / height, 0.05, 60);
    this.camera.position.copy(HOME_POSITION);
    this.camera.lookAt(HOME_TARGET);
  }

  private setupComposer() {
    const { width, height } = this.size();
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.pixelRatio());
    this.composer.setSize(width, height);

    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      0.34, // strength — eased at runtime
      0.38, // radius: a tight halo reads as glow, a wide one as fog
      0.42 // threshold: only genuine highlights bloom, so structure survives
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.grade = new ShaderPass(GRADE_SHADER);
    (this.grade.uniforms.uResolution.value as unknown) = new THREE.Vector2(
      width,
      height
    );
    if (this.reducedMotion) {
      this.grade.uniforms.uScanlines.value = 0.35;
      this.grade.uniforms.uAberration.value = 0.3;
    }
    this.composer.addPass(this.grade);
  }

  private setupControls() {
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.minDistance = 0.22;
    this.controls.maxDistance = 5.2;
    this.controls.target.copy(HOME_TARGET);
    this.controls.autoRotate = !this.reducedMotion;
    this.controls.autoRotateSpeed = 0.42;
    this.controls.rotateSpeed = 0.75;
    this.controls.zoomSpeed = 0.8;
    // Stop just short of the poles; looking straight down a point cloud of a
    // person is never the shot you want.
    this.controls.minPolarAngle = 0.25;
    this.controls.maxPolarAngle = Math.PI - 0.25;
    this.controls.addEventListener("start", () => {
      this.lastInteraction = performance.now();
      this.controls.autoRotate = false;
    });
  }

  /**
   * Fetches and builds the shaded surface for one structure, once.
   *
   * Deliberately lazy. The dense meshes are 7.8 MB across the set and only
   * ever one is on screen, so loading them at boot would pay for ten organs
   * to show one. At ~700 KB each they arrive inside the camera flight, and
   * the particle cloud covers the gap.
   */
  private async ensureSurface(cfg: OrganConfig): Promise<void> {
    if (this.surfaces.has(cfg.structure)) return;
    const pending = this.surfaceLoads.get(cfg.structure);
    if (pending) return pending;

    const load = (async () => {
      if (!this.hiManifest) {
        this.hiManifest = await loadManifest(ANATOMY_HIRES_BASE);
      }
      const mesh = await loadMesh(
        cfg.structure,
        this.hiManifest,
        ANATOMY_HIRES_BASE,
        this.abort.signal
      );
      if (this.disposed) return;

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      // Smooth normals across shared vertices; without this every facet of
      // the decimated mesh shades flat and the organ looks like cut glass.
      geometry.computeVertexNormals();

      const surface = new THREE.Mesh(geometry, organSurfaceMaterial(cfg.accent));
      surface.visible = false;
      surface.frustumCulled = false;
      // Drawn after the particles so it composites over them.
      surface.renderOrder = 2;
      this.surfaces.set(cfg.structure, surface);
      this.scene.add(surface);
    })().finally(() => {
      this.surfaceLoads.delete(cfg.structure);
    });

    this.surfaceLoads.set(cfg.structure, load);
    return load;
  }

  /* ---------------------------------------------------------------- */
  /* Geometry assembly                                                 */
  /* ---------------------------------------------------------------- */

  private buildPoints(
    body: Cloud,
    organs: { id: OrganId; cloud: Cloud }[],
    rng: () => number
  ) {
    // The figure is the reference every other structure is measured against,
    // for both exposure and particle size.
    const skin = this.manifest.structures.skin;
    const bodyDepth = skin?.depth ?? 1;
    const bodyExtent = skin ? Math.max(...extentOf(skin)) : 1.76;
    const total =
      body.count + organs.reduce((sum, o) => sum + o.cloud.count, 0);

    const positions = new Float32Array(total * 3);
    const scatter = new Float32Array(total * 3);
    const sizes = new Float32Array(total);
    const seeds = new Float32Array(total);
    const organAttr = new Float32Array(total);
    const density = new Float32Array(total);
    const radii = new Float32Array(total);

    let cursor = 0;
    const append = (cloud: Cloud, organIdx: number, comp: number, radius: number) => {
      positions.set(cloud.positions, cursor * 3);
      sizes.set(cloud.sizes, cursor);
      seeds.set(cloud.seeds, cursor);
      for (let i = 0; i < cloud.count; i++) {
        organAttr[cursor + i] = organIdx;
        density[cursor + i] = comp;
        radii[cursor + i] = radius;
      }

      // Scatter origin: a shell well outside the body, biased along the
      // particle's own direction so the assembly looks like an implosion
      // rather than a random shuffle.
      for (let i = 0; i < cloud.count; i++) {
        const o = (cursor + i) * 3;
        const px = cloud.positions[i * 3];
        const py = cloud.positions[i * 3 + 1];
        const pz = cloud.positions[i * 3 + 2];
        const l = Math.hypot(px, py, pz) || 1;
        const spread = 2.1 + rng() * 2.6;
        scatter[o] = (px / l) * spread + (rng() - 0.5) * 0.9;
        scatter[o + 1] = (py / l) * spread * 0.7 + (rng() - 0.5) * 0.9;
        scatter[o + 2] = (pz / l) * spread + (rng() - 0.5) * 0.9;
      }
      cursor += cloud.count;
    };

    append(body, -1, densityCompensation(body, bodyDepth, bodyDepth, PARTICLE_RADIUS), PARTICLE_RADIUS);
    for (const { id, cloud } of organs) {
      const organ = ORGANS.find((o) => o.id === id)!;
      const meta = this.manifest.structures[organ.structure];
      const depth = meta?.depth ?? bodyDepth;
      const radius = meta
        ? radiusFor(Math.max(...extentOf(meta)), bodyExtent)
        : PARTICLE_RADIUS;
      append(
        cloud,
        ORGANS.findIndex((o) => o.id === id),
        densityCompensation(cloud, depth, bodyDepth, radius, ORGAN_EXPOSURE),
        radius
      );
    }

    const geometry: BufferGeometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aScatter", new THREE.BufferAttribute(scatter, 3));
    geometry.setAttribute("aRadius", new THREE.BufferAttribute(radii, 1));
    geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    geometry.setAttribute("aOrgan", new THREE.BufferAttribute(organAttr, 1));
    geometry.setAttribute("aDensity", new THREE.BufferAttribute(density, 1));
    // The shader moves points well outside their rest positions during the
    // boot implosion, so a computed bounding sphere would cull them.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uForm: { value: 0 },
        uBodyAlpha: { value: 1.0 },
        uActive: { value: -1 },
        uReveal: { value: 0 },
        uGhost: { value: 0 },
        uOrganCenter: { value: new THREE.Vector3() },
        uOrganScale: { value: 1 },
        uScanY: { value: -2 },
        uScanWidth: { value: 0.07 },
        uScanStrength: { value: 1.0 },
        uPixelRatio: { value: this.pixelRatio() },
        uSize: { value: 1 },
        uRadius: { value: PARTICLE_RADIUS },
        uScale: { value: 1000 },
        uDrift: { value: this.reducedMotion ? 0.0012 : 0.0045 },
        uColDeep: { value: new THREE.Color(0x0d3f7a) },
        uColCyan: { value: new THREE.Color(0x63e4ff) },
        uColAccent: { value: new THREE.Color(0xffb265) },
        uAccentMix: { value: 0 },
      },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // Organs sit inside the body: without this they would be occluded by
      // the very shell we want to see them through.
      depthTest: false,
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
  }

  /** Sparse far-field motes. Pure parallax — they give the void a depth cue. */
  private buildDust(count: number, rng: () => number) {
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const seeds = new Float32Array(count);
    const scatter = new Float32Array(count * 3);
    const organAttr = new Float32Array(count).fill(-1);
    const densityAttr = new Float32Array(count).fill(1);

    for (let i = 0; i < count; i++) {
      const r = 2.6 + rng() * 5.5;
      const theta = rng() * Math.PI * 2;
      const phi = Math.acos(rng() * 2 - 1);
      const o = i * 3;
      positions[o] = r * Math.sin(phi) * Math.cos(theta);
      positions[o + 1] = (rng() * 2 - 1) * 3.2;
      positions[o + 2] = r * Math.sin(phi) * Math.sin(theta);
      scatter[o] = positions[o];
      scatter[o + 1] = positions[o + 1];
      scatter[o + 2] = positions[o + 2];
      sizes[i] = 0.3 + rng() * 0.75;
      seeds[i] = rng();
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aScatter", new THREE.BufferAttribute(scatter, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    geo.setAttribute("aOrgan", new THREE.BufferAttribute(organAttr, 1));
    geo.setAttribute("aDensity", new THREE.BufferAttribute(densityAttr, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 12);

    const mat = this.material.clone();
    mat.uniforms.uBodyAlpha = { value: 0.34 };
    mat.uniforms.uDrift = { value: 0.0 };
    mat.uniforms.uScanStrength = { value: 0 };
    mat.uniforms.uForm = { value: 1 };
    mat.uniforms.uTime = this.material.uniforms.uTime; // share the clock

    this.dust = new THREE.Points(geo, mat);
    this.dust.frustumCulled = false;
    this.scene.add(this.dust);
  }

  /** Floor grid, standing rings and the gyroscopic focus reticle. */
  private buildHud() {
    this.hud = new THREE.Group();
    this.scene.add(this.hud);

    const lineMat = (color: number, opacity: number) =>
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      });

    const floorY = -BODY_Y_OFFSET + 0.004;

    // Concentric dashed floor rings.
    for (const [radius, opacity, dashes] of [
      [0.52, 0.5, 72],
      [0.78, 0.3, 96],
      [1.12, 0.2, 128],
      [1.5, 0.12, 160],
    ] as const) {
      const pts: number[] = [];
      for (let i = 0; i < dashes; i++) {
        const a0 = (i / dashes) * Math.PI * 2;
        const a1 = a0 + (Math.PI * 2) / dashes / 2;
        pts.push(Math.cos(a0) * radius, floorY, Math.sin(a0) * radius);
        pts.push(Math.cos(a1) * radius, floorY, Math.sin(a1) * radius);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      this.hud.add(new THREE.LineSegments(g, lineMat(0x3fb8ff, opacity)));
    }

    // Radial spokes.
    const spokes: number[] = [];
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      const inner = i % 3 === 0 ? 0.52 : 1.28;
      spokes.push(Math.cos(a) * inner, floorY, Math.sin(a) * inner);
      spokes.push(Math.cos(a) * 1.5, floorY, Math.sin(a) * 1.5);
    }
    const spokeGeo = new THREE.BufferGeometry();
    spokeGeo.setAttribute("position", new THREE.Float32BufferAttribute(spokes, 3));
    this.hud.add(new THREE.LineSegments(spokeGeo, lineMat(0x2f8fd8, 0.16)));

    // Gyroscopic reticle, parked at the origin until an organ is focused.
    this.reticle = new THREE.Group();
    this.reticle.visible = false;
    this.scene.add(this.reticle);

    const ringGeo = (radius: number, segments: number, gap: number) => {
      const pts: number[] = [];
      for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * Math.PI * 2;
        const a1 = a0 + ((Math.PI * 2) / segments) * (1 - gap);
        pts.push(Math.cos(a0) * radius, Math.sin(a0) * radius, 0);
        pts.push(Math.cos(a1) * radius, Math.sin(a1) * radius, 0);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      return g;
    };

    const r1 = new THREE.LineSegments(ringGeo(1, 48, 0.45), lineMat(0x7fe3ff, 0.85));
    const r2 = new THREE.LineSegments(ringGeo(1.22, 8, 0.5), lineMat(0x7fe3ff, 0.6));
    r2.rotation.x = Math.PI / 2.4;
    const r3 = new THREE.LineSegments(ringGeo(1.4, 120, 0.6), lineMat(0x4fb6ff, 0.35));
    r3.rotation.y = Math.PI / 3;
    this.reticle.add(r1, r2, r3);
    this.reticle.userData.rings = [r1, r2, r3];
  }

  private buildHitVolumes() {
    // Opacity 0 rather than visible:false — some three versions still raycast
    // invisible objects, and relying on that is a trap for whoever upgrades.
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      colorWrite: false,
    });

    for (const cfg of this.organs) {
      for (const hit of cfg.hits) {
        const mesh = new THREE.Mesh(
          new THREE.SphereGeometry(hit.radius, 12, 10),
          mat
        );
        mesh.position.set(hit.center[0], hit.center[1], hit.center[2]);
        mesh.userData.organ = cfg.id;
        mesh.renderOrder = -1;
        this.scene.add(mesh);
        this.hitMeshes.push(mesh);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Events                                                            */
  /* ---------------------------------------------------------------- */

  private onPointerMove = (e: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.pointerInside = true;
  };

  private onPointerLeave = () => {
    this.pointerInside = false;
    if (this.hovered !== null) {
      this.hovered = null;
      this.callbacks.onHover?.(null);
    }
  };

  private downAt = { x: 0, y: 0, t: 0 };

  private onPointerDown = (e: PointerEvent) => {
    this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
    this.lastInteraction = performance.now();
  };

  private onPointerUp = (e: PointerEvent) => {
    // Distinguish a click from the end of an orbit drag. Without this, every
    // rotation that happens to finish over an organ selects it.
    const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y);
    const elapsed = performance.now() - this.downAt.t;
    if (moved > 6 || elapsed > 600) return;

    this.onPointerMove(e);
    const hit = this.pick();
    this.callbacks.onSelect?.(hit);
  };

  private onContextLost = (e: Event) => {
    e.preventDefault();
    this.running = false;
  };

  private onContextRestored = () => {
    if (!this.disposed) this.start();
  };

  private attachEvents() {
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("webglcontextlost", this.onContextLost);
    this.canvas.addEventListener("webglcontextrestored", this.onContextRestored);

    const parent = this.canvas.parentElement;
    if (parent && typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(parent);
    } else {
      window.addEventListener("resize", this.resize);
    }
  }

  private pick(): OrganId | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.hitMeshes, false);
    if (hits.length === 0) return null;
    return (hits[0].object.userData.organ as OrganId) ?? null;
  }

  /* ---------------------------------------------------------------- */
  /* Public API                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Clears every shaded surface from view.
   *
   * All of them, not just the one on screen: a surface stays in the scene
   * once built, and only the active one has its fade driven by the loop, so
   * hiding by reference left each previously opened organ sitting at full
   * opacity. Switching from lungs to liver showed both, plus the heart from
   * two organs ago.
   */
  private hideSurface() {
    this.state.surface = 0;
    this.state.surfaceTarget = 0;
    for (const mesh of this.surfaces.values()) {
      (mesh.material as ShaderMaterial).uniforms.uFade.value = 0;
      mesh.visible = false;
    }
    this.surface = undefined;
  }

  /** Focus an organ, or pass null to return to the whole body. */
  setOrgan(id: OrganId | null) {
    if (id === this.active) return;
    this.active = id;

    const s = this.state;
    s.glitch = 1; // decays in the loop; drives the tear in the grade pass

    if (id) {
      const cfg = this.organs.find((o) => o.id === id) as OrganConfig;
      const idx = ORGANS.findIndex((o) => o.id === id);
      this.material.uniforms.uActive.value = idx;
      (this.material.uniforms.uOrganCenter.value as Vector3).set(
        cfg.hits[0].center[0],
        cfg.hits[0].center[1],
        cfg.hits[0].center[2]
      );
      (this.material.uniforms.uColAccent.value as THREE.Color).setHex(cfg.accent);

      // Full reveal whatever the framing. Holding the whole-body structures
      // back to 85% was a second penalty on exactly the ones that were
      // already the sparsest.
      s.revealTarget = 1.0;
      // The shell is a locating outline, nothing more. Every body particle
      // in front of a focused organ lays haze over it, and there are 160 000
      // of them.
      s.bodyAlphaTarget = cfg.framing === "body" ? 0.055 : 0.022;
      s.ghostTarget = this.xray ? 0.12 : 0.03;
      s.organScaleTarget = cfg.framing === "body" ? 1 : 1.25;
      s.accentMixTarget = 0.55;
      // Bloom comes down on focus, not up. A wide halo fills in the dark
      // between particles, which is the one thing a close look needs kept.
      s.bloomTarget = 0.22;

      const centre = new THREE.Vector3(...cfg.hits[0].center);
      const target = cfg.framing === "body" ? HOME_TARGET.clone() : centre;
      const dir = new THREE.Vector3(...cfg.viewDir).normalize();
      this.flyTo(target.clone().addScaledVector(dir, cfg.viewDist), target, 1.35);

      // The reticle frames a discrete organ. Around a whole-body structure
      // it just draws long diagonals across the viewport, and the floor grid
      // already supplies the framing there.
      this.reticle.visible = cfg.framing !== "body";
      this.reticle.position.copy(centre);
      this.reticle.scale.setScalar(cfg.hits[0].radius * 1.9);
      for (const ring of this.reticle.userData.rings as Object3D[]) {
        ((ring as THREE.LineSegments).material as THREE.LineBasicMaterial).color.setHex(
          cfg.accent
        );
      }

      // Bring up the shaded surface once its mesh is here. Until then the
      // particle cloud carries the shot, so the flight never waits on a
      // fetch; the swap lands a moment later and reads as the organ
      // resolving rather than as a load.
      this.hideSurface();
      void this.ensureSurface(cfg).then(() => {
        if (this.disposed || this.active !== id) return;
        const mesh = this.surfaces.get(cfg.structure);
        if (!mesh) return;
        this.surface = mesh;
        mesh.visible = true;
        this.state.surfaceTarget = 1;
      });
    } else {
      this.hideSurface();
      s.revealTarget = 0;
      s.bodyAlphaTarget = 1.0;
      s.ghostTarget = this.xray ? 0.18 : 0;
      s.organScaleTarget = 1;
      s.accentMixTarget = 0;
      s.bloomTarget = 0.38;
      this.reticle.visible = false;
      this.flyTo(HOME_POSITION.clone(), HOME_TARGET.clone(), 1.2);
    }

    // Re-run the scan sweep on every change — it sells the idea that the
    // volume is being re-acquired.
    s.scanY = -1.15;
    this.applyViewOffset();
  }

  /**
   * True once the boot assembly and any camera flight have finished. The
   * visual test harness waits on this: the engine clamps its frame delta, so
   * on a slow renderer wall-clock time is a poor proxy for animation state.
   */
  isSettled(): boolean {
    return this.state.form > 0.985 && this.camT >= 1;
  }

  /** Ghosts every organ into view at once, through the body shell. */
  setXray(on: boolean) {
    this.xray = on;
    this.state.ghostTarget = on ? (this.active ? 0.12 : 0.18) : this.active ? 0.03 : 0;
    this.material.uniforms.uBodyAlpha.value = this.state.bodyAlpha;
    if (!this.active) this.state.bodyAlphaTarget = on ? 0.45 : 1;
  }

  setAutoRotate(on: boolean) {
    this.controls.autoRotate = on && !this.reducedMotion;
  }

  resetView() {
    this.setOrgan(null);
  }

  /** Nudges the camera without changing the focused organ. */
  zoom(delta: number) {
    const dir = this.camera.position.clone().sub(this.controls.target);
    const len = THREE.MathUtils.clamp(
      dir.length() * (1 + delta),
      this.controls.minDistance,
      this.controls.maxDistance
    );
    this.camera.position.copy(this.controls.target).addScaledVector(dir.normalize(), len);
  }

  private flyTo(position: Vector3, target: Vector3, duration: number) {
    this.camFrom.copy(this.camera.position);
    this.camTo.copy(position);
    this.tgtFrom.copy(this.controls.target);
    this.tgtTo.copy(target);
    this.camT = 0;
    this.camDuration = this.reducedMotion ? 0.35 : duration;
    this.controls.enabled = false;
    this.controls.autoRotate = false;
  }

  /* ---------------------------------------------------------------- */
  /* Loop                                                              */
  /* ---------------------------------------------------------------- */

  private start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.frame = requestAnimationFrame(this.tick);
  }

  private tick = () => {
    if (!this.running || this.disposed) return;
    this.frame = requestAnimationFrame(this.tick);

    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    const s = this.state;

    // Ease every animated value toward its target. One rate for all of them
    // keeps the transitions feeling like a single coordinated movement.
    const k = 1 - Math.exp(-dt * 3.2);
    s.form += (s.formTarget - s.form) * (1 - Math.exp(-dt * 1.15));
    s.bodyAlpha += (s.bodyAlphaTarget - s.bodyAlpha) * k;
    s.reveal += (s.revealTarget - s.reveal) * k;
    s.ghost += (s.ghostTarget - s.ghost) * k;
    s.organScale += (s.organScaleTarget - s.organScale) * k;
    s.accentMix += (s.accentMixTarget - s.accentMix) * k;
    s.surface += (s.surfaceTarget - s.surface) * (1 - Math.exp(-dt * 2.4));

    if (this.surface) {
      const mat = this.surface.material as ShaderMaterial;
      mat.uniforms.uFade.value = s.surface;
      mat.uniforms.uTime.value = t;
      this.surface.visible = s.surface > 0.004;
    }
    s.bloomStrength += (s.bloomTarget - s.bloomStrength) * k;
    s.glitch *= Math.exp(-dt * 3.5);

    // The scan plane sweeps up the body, then idles above it.
    s.scanY += dt * (this.active ? 0.55 : 0.42);
    if (s.scanY > 1.6) s.scanY = -1.3;

    const u = this.material.uniforms;
    u.uTime.value = t;
    u.uForm.value = s.form;
    u.uBodyAlpha.value = s.bodyAlpha;
    // Once the shaded surface is up the particle organ steps back to a thin
    // aura around it, rather than competing with it. Not to zero: the aura
    // is what keeps a solid-looking organ inside a particle figure from
    // reading as two different pictures.
    u.uReveal.value = s.reveal * (1 - 0.72 * s.surface);
    u.uGhost.value = s.ghost;
    u.uOrganScale.value = s.organScale;
    u.uAccentMix.value = s.accentMix;
    u.uScanY.value = s.scanY;
    // The sweep reads as a whole-body acquisition pass. On a close-up it is
    // just a flash across the frame, and at full strength it clips the
    // focused organ to white every time it crosses, so damp it right down.
    u.uScanStrength.value =
      s.form * (this.reducedMotion ? 0.3 : 0.5) * (this.active ? 0.5 : 1);

    this.bloom.strength = s.bloomStrength * (0.9 + Math.sin(t * 0.8) * 0.05);
    this.grade.uniforms.uTime.value = t;
    this.grade.uniforms.uGlitch.value = s.glitch;

    // Camera flight.
    if (this.camT < 1) {
      this.camT = Math.min(1, this.camT + dt / this.camDuration);
      const e = easeInOutCubic(this.camT);
      this.camera.position.lerpVectors(this.camFrom, this.camTo, e);
      this.controls.target.lerpVectors(this.tgtFrom, this.tgtTo, e);
      this.camera.lookAt(this.controls.target);
      if (this.camT >= 1) {
        this.controls.enabled = true;
        this.lastInteraction = performance.now();
      }
    } else {
      // Resume the idle turntable once the user has been still for a while.
      if (
        !this.reducedMotion &&
        !this.controls.autoRotate &&
        performance.now() - this.lastInteraction > 4500
      ) {
        this.controls.autoRotate = true;
      }
      this.controls.update();
    }

    // Reticle gyroscope.
    if (this.reticle.visible) {
      const rings = this.reticle.userData.rings as Object3D[];
      rings[0].rotation.z += dt * 0.35;
      rings[1].rotation.z -= dt * 0.22;
      rings[1].rotation.y += dt * 0.15;
      rings[2].rotation.z += dt * 0.12;
      this.reticle.lookAt(this.camera.position);
      this.reticle.rotateZ(t * 0.05);
    }

    this.hud.rotation.y += dt * 0.035;

    // Hover picking. Every other frame is plenty and halves the raycast cost.
    if (this.pointerInside && this.camT >= 1 && Math.round(t * 60) % 2 === 0) {
      const hit = this.pick();
      if (hit !== this.hovered) {
        this.hovered = hit;
        this.callbacks.onHover?.(hit);
        this.canvas.style.cursor = hit ? "pointer" : "grab";
      }
    }

    this.emitLabels();
    this.composer.render();
  };

  /** Projects each organ anchor to canvas-relative CSS pixels for the HUD. */
  private emitLabels() {
    if (!this.callbacks.onLabels) return;
    const { width, height } = this.size();
    const out = this.labelScratch;
    out.length = 0;

    for (const cfg of this.organs) {
      this.tmpVec.set(cfg.labelAt[0], cfg.labelAt[1], cfg.labelAt[2]);
      const world = this.tmpVec.clone();
      this.tmpVec.project(this.camera);

      const behind = this.tmpVec.z > 1;
      const x = (this.tmpVec.x * 0.5 + 0.5) * width;
      const y = (-this.tmpVec.y * 0.5 + 0.5) * height;
      const dist = world.distanceTo(this.camera.position);

      out.push({
        id: cfg.id,
        x,
        y,
        visible:
          !behind &&
          x > -80 &&
          x < width + 80 &&
          y > -40 &&
          y < height + 40 &&
          this.state.form > 0.75,
        depth: THREE.MathUtils.clamp(1 - (dist - 0.4) / 3, 0, 1),
        side: cfg.labelSide,
      });
    }
    this.callbacks.onLabels(out);
  }

  private size() {
    const parent = this.canvas.parentElement;
    const width = Math.max(1, parent?.clientWidth ?? window.innerWidth);
    const height = Math.max(1, parent?.clientHeight ?? window.innerHeight);
    return { width, height };
  }

  /**
   * Slides the rendered image sideways by offsetting the camera frustum.
   *
   * Raycasting and label projection both go through the projection matrix, so
   * picking and the HTML labels stay aligned with what is drawn — which is
   * why this is done here rather than by translating the scene.
   */
  private applyViewOffset() {
    const { width, height } = this.size();
    const narrow = width < 980;
    const fraction = narrow
      ? FOCUS_FRACTION.narrow
      : this.active
        ? FOCUS_FRACTION.organ
        : FOCUS_FRACTION.rest;
    const x = (0.5 - fraction) * width;
    if (Math.abs(x) < 0.5) this.camera.clearViewOffset();
    else this.camera.setViewOffset(width, height, x, 0, width, height);
  }

  resize = () => {
    if (this.disposed || !this.renderer) return;
    const { width, height } = this.size();
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.applyViewOffset();
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(this.pixelRatio());
    this.composer.setSize(width, height);
    this.bloom.resolution.set(width, height);
    (this.grade.uniforms.uResolution.value as Vector2).set(width, height);
    this.material.uniforms.uPixelRatio.value = this.pixelRatio();
    this.material.uniforms.uScale.value =
      height / 2 / Math.tan((this.camera.fov / 2) * THREE.MathUtils.DEG2RAD);
    // On narrow viewports the body is further away, so push point size up a
    // little or the figure dissolves into noise.
    this.material.uniforms.uSize.value = width < 760 ? 1.3 : 1;
  };

  /** Call when the canvas scrolls out of view or the tab is hidden. */
  setPaused(paused: boolean) {
    if (paused) {
      this.running = false;
      cancelAnimationFrame(this.frame);
    } else if (!this.disposed) {
      this.start();
    }
  }

  dispose() {
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.frame);
    // Asset fetches outlive a fast unmount otherwise, and their decode work
    // lands on a scene that no longer exists.
    this.abort.abort();

    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.resizeObserver?.disconnect();
    window.removeEventListener("resize", this.resize);

    this.controls?.dispose();
    this.scene?.traverse((obj: Object3D) => {
      const any = obj as unknown as {
        geometry?: { dispose: () => void };
        material?: { dispose: () => void } | { dispose: () => void }[];
      };
      any.geometry?.dispose?.();
      if (Array.isArray(any.material)) any.material.forEach((m) => m.dispose());
      else any.material?.dispose?.();
    });
    this.composer?.dispose?.();
    this.renderer?.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Picks a particle budget from the device's screen and pixel density. */
export function detectQuality(): QualityTier {
  if (typeof window === "undefined") return "medium";
  const area = window.innerWidth * window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  const cores = (navigator as unknown as { hardwareConcurrency?: number })
    .hardwareConcurrency ?? 4;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  if (mobile || cores <= 4 || area * dpr < 700_000) return "low";
  if (cores >= 8 && area > 1_200_000) return "high";
  return "medium";
}
