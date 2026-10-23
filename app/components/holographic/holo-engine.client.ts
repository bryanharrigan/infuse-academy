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
  BODY_Y_OFFSET,
  bodyParts,
  brainParts,
  buildCloud,
  heartParts,
  kidneyParts,
  liverParts,
  lungParts,
  makeRng,
  skeletonParts,
  type Cloud,
  type Part,
} from "./anatomy";
import { ORGANS, type OrganId } from "./organ-catalog";

/* ------------------------------------------------------------------ */
/* Configuration                                                        */
/* ------------------------------------------------------------------ */

type HitSphere = { center: [number, number, number]; radius: number };

type OrganConfig = {
  id: OrganId;
  parts: () => Part[];
  /**
   * Particle count at medium quality, scaled by ORGAN_SCALE.
   *
   * Absolute rather than a share of one budget: only one organ is ever
   * visible, so they do not actually compete for fill rate, and a share
   * meant the whole-body skeleton starved the six compact organs (or, at
   * its own correct size, starved them worse).
   */
  count: number;
  /** Clickable volumes, in body-centred coordinates. */
  hits: HitSphere[];
  /** Where the camera sits when this organ is focused, relative to its centre. */
  viewDir: [number, number, number];
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

/** All coordinates below are already body-centred (floor Y − BODY_Y_OFFSET). */
const ORGAN_CONFIG: OrganConfig[] = [
  {
    id: "brain",
    parts: brainParts,
    count: 15000,
    hits: [{ center: [0, 0.662, 0.004], radius: 0.105 }],
    viewDir: [0.38, 0.22, 1],
    viewDist: 0.86,
    labelAt: [0.20, 0.70, 0.02],
    accent: 0x8ab4ff,
    labelSide: "right",
    framing: "organ",
  },
  {
    id: "heart",
    parts: heartParts,
    count: 12000,
    hits: [{ center: [-0.03, 0.245, 0.028], radius: 0.082 }],
    viewDir: [0.34, 0.14, 1],
    viewDist: 0.82,
    labelAt: [-0.26, 0.27, 0.06],
    accent: 0xff8a7a,
    labelSide: "left",
    framing: "organ",
  },
  {
    id: "lungs",
    parts: lungParts,
    count: 23000,
    hits: [
      { center: [-0.108, 0.26, -0.005], radius: 0.078 },
      { center: [0.108, 0.26, -0.005], radius: 0.078 },
    ],
    viewDir: [0.18, 0.1, 1],
    viewDist: 1.08,
    labelAt: [0.30, 0.38, 0.0],
    accent: 0x6fe8d0,
    labelSide: "right",
    framing: "organ",
  },
  {
    id: "liver",
    parts: liverParts,
    count: 10000,
    hits: [{ center: [0.062, 0.108, 0.015], radius: 0.092 }],
    viewDir: [0.5, 0.12, 1],
    viewDist: 0.88,
    labelAt: [0.32, 0.10, 0.04],
    accent: 0xffc46b,
    labelSide: "right",
    framing: "organ",
  },
  {
    id: "kidneys",
    parts: kidneyParts,
    count: 8000,
    hits: [
      { center: [-0.074, 0.045, -0.062], radius: 0.05 },
      { center: [0.074, 0.045, -0.062], radius: 0.05 },
    ],
    // Retroperitoneal — the teaching view is from behind.
    viewDir: [0.3, 0.18, -1],
    viewDist: 0.76,
    labelAt: [-0.30, 0.01, -0.07],
    accent: 0xb79bff,
    labelSide: "left",
    framing: "organ",
  },
  {
    id: "skeleton",
    parts: skeletonParts,
    count: 40000,
    // No central hit volume — it would swallow every other organ. The limbs
    // are the only places the skeleton is the obvious thing under the cursor.
    hits: [
      { center: [-0.095, -0.3, 0], radius: 0.1 },
      { center: [0.095, -0.3, 0], radius: 0.1 },
      { center: [-0.28, 0.0, 0.02], radius: 0.07 },
      { center: [0.28, 0.0, 0.02], radius: 0.07 },
    ],
    viewDir: [0.3, 0.1, 1],
    viewDist: 3.05,
    labelAt: [0.38, -0.34, 0.04],
    accent: 0x9fd8ff,
    labelSide: "right",
    framing: "body",
  },
];

/**
 * World-space radius of a single particle, in metres. At ~3mm a 1.76m figure
 * resolves as a dense cloud of discrete points rather than either a solid
 * sheet or a sparse dusting.
 */
const PARTICLE_RADIUS = 0.0034;

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

const BUDGETS: Record<QualityTier, { body: number; dust: number; organScale: number }> = {
  low: { body: 34000, dust: 900, organScale: 0.55 },
  medium: { body: 56000, dust: 1800, organScale: 1 },
  high: { body: 86000, dust: 3000, organScale: 1.5 },
};

/* ------------------------------------------------------------------ */
/* Shaders                                                              */
/* ------------------------------------------------------------------ */

const PARTICLE_VERT = /* glsl */ `
  attribute vec3 aScatter;
  attribute float aSize;
  attribute float aSeed;
  attribute float aOrgan;

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
  uniform float uRadius;      // particle radius in world metres
  uniform float uScale;       // (viewportHeightCss / 2) / tan(fov / 2)
  uniform float uDrift;

  varying float vAlpha;
  varying float vHeat;
  varying float vSeed;
  varying float vActive;

  void main() {
    float isBody   = step(aOrgan, -0.5);
    float isActive = (1.0 - step(0.5, abs(aOrgan - uActive))) * (1.0 - isBody);
    float isOther  = (1.0 - isBody) * (1.0 - isActive);

    vAlpha = isBody * uBodyAlpha + isActive * uReveal + isOther * uGhost;
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
    float size = aSize * uRadius * uSize * uScale * uPixelRatio / max(-mv.z, 0.05);
    size *= (1.0 + scan * 1.4) * mix(1.0, 1.25, isActive);
    size = clamp(size, 0.4, 9.0 * uPixelRatio);
    gl_PointSize = size;

    // Additive blending means a particle's contribution scales with its area,
    // so flying the camera into an organ would otherwise multiply the light
    // by ~25x and clip to white. Fading alpha as the sprite grows keeps each
    // particle's emitted light roughly constant, which is what lets the same
    // material read correctly at both 3m and 0.3m.
    float sizeFade = clamp((2.2 * uPixelRatio) / max(size, 0.4), 0.3, 1.0);
    vAlpha *= sizeFade;
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

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = dot(uv, uv);
    if (d > 0.25) discard;

    // Soft disc with a hot core — a flat disc reads as confetti, a pure
    // gaussian reads as fog. This sits between the two.
    float falloff = 1.0 - d * 4.0;
    float a = pow(falloff, 2.2) * vAlpha;
    if (a < 0.002) discard;

    vec3 col = mix(uColDeep, uColCyan, smoothstep(0.15, 0.92, vSeed));
    col = mix(col, uColAccent, vActive * uAccentMix);
    col += vec3(0.30, 0.62, 0.95) * vHeat * 0.9;
    col += vec3(vHeat * vHeat * 0.45);

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
    bodyAlpha: 1,
    bodyAlphaTarget: 1,
    reveal: 0,
    revealTarget: 0,
    ghost: 0,
    ghostTarget: 0,
    organScale: 1,
    organScaleTarget: 1,
    accentMix: 0,
    accentMixTarget: 0,
    glitch: 0,
    scanY: -1.2,
    bloomStrength: 0.5,
    bloomTarget: 0.5,
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

    this.callbacks.onProgress?.(0.05, "INITIALISING VOLUME");
    await nextFrame();

    // Body first so something is on screen immediately.
    const bodyCloud = buildCloud(bodyParts(), budget.body, rng, {
      interior: 0.2,
      sizeMin: 0.55,
      sizeMax: 1.35,
    });
    this.callbacks.onProgress?.(0.3, "RESOLVING SURFACE MESH");
    await nextFrame();

    const organClouds: { id: OrganId; cloud: Cloud }[] = [];

    for (let i = 0; i < ORGAN_CONFIG.length; i++) {
      const cfg = ORGAN_CONFIG[i];
      const count = Math.round(cfg.count * budget.organScale);
      const cloud = buildCloud(cfg.parts(), count, rng, {
        // Few interior points: where primitives overlap heavily (the pelvis,
        // the skull, the bulbous ends of long bones) interior points pile up
        // and additive blending turns the region into a white blob. The
        // surface shell is what carries the anatomy anyway.
        interior: 0.12,
        shell: 0.003,
        margin: 0.003,
        sizeMin: 0.6,
        sizeMax: 1.6,
      });
      organClouds.push({ id: cfg.id, cloud });
      this.callbacks.onProgress?.(
        0.3 + ((i + 1) / ORGAN_CONFIG.length) * 0.6,
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
      0.5, // strength — eased at runtime
      0.5, // radius
      0.22 // threshold: only the brighter cores bloom, so the body keeps form
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

  /* ---------------------------------------------------------------- */
  /* Geometry assembly                                                 */
  /* ---------------------------------------------------------------- */

  private buildPoints(
    body: Cloud,
    organs: { id: OrganId; cloud: Cloud }[],
    rng: () => number
  ) {
    const total =
      body.count + organs.reduce((sum, o) => sum + o.cloud.count, 0);

    const positions = new Float32Array(total * 3);
    const scatter = new Float32Array(total * 3);
    const sizes = new Float32Array(total);
    const seeds = new Float32Array(total);
    const organAttr = new Float32Array(total);

    let cursor = 0;
    const append = (cloud: Cloud, organIdx: number) => {
      positions.set(cloud.positions, cursor * 3);
      sizes.set(cloud.sizes, cursor);
      seeds.set(cloud.seeds, cursor);
      for (let i = 0; i < cloud.count; i++) organAttr[cursor + i] = organIdx;

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

    append(body, -1);
    for (const { id, cloud } of organs) {
      append(cloud, ORGANS.findIndex((o) => o.id === id));
    }

    const geometry: BufferGeometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aScatter", new THREE.BufferAttribute(scatter, 3));
    geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    geometry.setAttribute("aOrgan", new THREE.BufferAttribute(organAttr, 1));
    // The shader moves points well outside their rest positions during the
    // boot implosion, so a computed bounding sphere would cull them.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uForm: { value: 0 },
        uBodyAlpha: { value: 1 },
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

    for (const cfg of ORGAN_CONFIG) {
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

  /** Focus an organ, or pass null to return to the whole body. */
  setOrgan(id: OrganId | null) {
    if (id === this.active) return;
    this.active = id;

    const s = this.state;
    s.glitch = 1; // decays in the loop; drives the tear in the grade pass

    if (id) {
      const cfg = ORGAN_CONFIG.find((o) => o.id === id) as OrganConfig;
      const idx = ORGANS.findIndex((o) => o.id === id);
      this.material.uniforms.uActive.value = idx;
      (this.material.uniforms.uOrganCenter.value as Vector3).set(
        cfg.hits[0].center[0],
        cfg.hits[0].center[1],
        cfg.hits[0].center[2]
      );
      (this.material.uniforms.uColAccent.value as THREE.Color).setHex(cfg.accent);

      // A body-framed structure fills the frame with many small points at
      // once, so it needs less per-particle alpha than a compact organ.
      s.revealTarget = cfg.framing === "body" ? 0.72 : 0.85;
      s.bodyAlphaTarget = cfg.framing === "body" ? 0.1 : 0.14;
      s.ghostTarget = this.xray ? 0.12 : 0.03;
      s.organScaleTarget = cfg.framing === "body" ? 1 : 1.25;
      s.accentMixTarget = 0.55;
      s.bloomTarget = 0.6;

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
    } else {
      s.revealTarget = 0;
      s.bodyAlphaTarget = 1;
      s.ghostTarget = this.xray ? 0.18 : 0;
      s.organScaleTarget = 1;
      s.accentMixTarget = 0;
      s.bloomTarget = 0.5;
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
    s.bloomStrength += (s.bloomTarget - s.bloomStrength) * k;
    s.glitch *= Math.exp(-dt * 3.5);

    // The scan plane sweeps up the body, then idles above it.
    s.scanY += dt * (this.active ? 0.55 : 0.42);
    if (s.scanY > 1.6) s.scanY = -1.3;

    const u = this.material.uniforms;
    u.uTime.value = t;
    u.uForm.value = s.form;
    u.uBodyAlpha.value = s.bodyAlpha;
    u.uReveal.value = s.reveal;
    u.uGhost.value = s.ghost;
    u.uOrganScale.value = s.organScale;
    u.uAccentMix.value = s.accentMix;
    u.uScanY.value = s.scanY;
    // The sweep reads as a whole-body acquisition pass. On a close-up it is
    // just a flash across the frame, and at full strength it clips the
    // focused organ to white every time it crosses, so damp it right down.
    u.uScanStrength.value =
      s.form * (this.reducedMotion ? 0.45 : 1) * (this.active ? 0.3 : 1);

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

    for (const cfg of ORGAN_CONFIG) {
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
