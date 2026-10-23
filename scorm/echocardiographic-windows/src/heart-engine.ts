/**
 * scorm/echocardiographic-windows/src/heart-engine.ts
 *
 * The interactive beating heart at the centre of the module.
 *
 * Geometry comes from the same `anatomy.ts` the /holographic route uses, so
 * there is one source of truth for what a heart looks like in this project.
 * The parts are tagged with HEART_REGION, which is what lets the cardiac
 * cycle contract ventricles, atria and great vessels independently instead
 * of pulsing the whole cloud like a balloon.
 *
 * The teaching mechanism is the imaging plane. Each echo window is defined by
 * a real transducer position and beam direction; the engine draws the
 * ultrasound sector through the heart from that position and parks the camera
 * square to it, so the learner sees exactly which structures the plane cuts
 * and why the view contains what it contains.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

import {
  HEART_CENTRE,
  HEART_REGION,
  buildCloud,
  heartParts,
  makeRng,
} from "../../../app/components/holographic/anatomy";

/* ------------------------------------------------------------------ */
/* Views                                                                */
/* ------------------------------------------------------------------ */

export type ViewId = "free" | "plax" | "psax" | "a4c" | "a5c" | "subcostal";

export type StructureLabel = { text: string; at: [number, number, number] };

type ViewDef = {
  id: ViewId;
  label: string;
  /** Transducer position, heart-centred metres. */
  probe: [number, number, number];
  /** Point the beam is aimed at. */
  target: [number, number, number];
  /** Rough "up" in the imaging plane; orthogonalised against the beam. */
  up: [number, number, number];
  /** Sector half-angle in degrees and its depth in metres. */
  spread: number;
  depth: number;
  /**
   * How far the camera sits from the heart along the plane normal. Scaled
   * per view because the subcostal probe is twice as far from the heart as
   * the parasternal one, and a fixed distance either clips the organ or
   * loses it in the sector.
   */
  camDist: number;
  /** Structures named in this view. */
  labels: StructureLabel[];
};

/**
 * Transducer positions, in heart-centred coordinates (patient's left is −X,
 * anterior is +Z, superior is +Y). Derived from the surface landmarks:
 * parasternal is the 3rd–4th left intercostal space just left of the sternum,
 * apical sits over the apex beat at the 5th space in the midclavicular line,
 * and subcostal is below the xiphoid angled up toward the left shoulder.
 */
const VIEWS: ViewDef[] = [
  {
    id: "plax",
    label: "Parasternal long axis",
    probe: [-0.052, 0.082, 0.120],
    target: [0.004, -0.012, -0.016],
    up: [-0.55, 0.3, 0.1],
    spread: 30,
    depth: 0.28,
    camDist: 0.42,
    labels: [
      { text: "RV", at: [0.030, 0.006, 0.036] },
      { text: "IVS", at: [0.004, 0.000, 0.016] },
      { text: "LV", at: [-0.020, -0.024, 0.008] },
      { text: "Posterior wall", at: [-0.040, -0.050, -0.010] },
      { text: "MV", at: [-0.008, 0.038, -0.016] },
      { text: "LA", at: [-0.016, 0.070, -0.034] },
      { text: "AV / Ao root", at: [0.008, 0.074, -0.002] },
    ],
  },
  {
    id: "psax",
    label: "Parasternal short axis",
    probe: [-0.052, 0.082, 0.120],
    target: [0.004, -0.012, -0.016],
    // Rotating the probe ~90 degrees from PLAX swings the plane's "up" into
    // the patient's left-right axis, cutting the ventricle in cross-section.
    up: [0.1, 0.25, 0.95],
    spread: 30,
    depth: 0.26,
    camDist: 0.40,
    labels: [
      { text: "LV (doughnut)", at: [-0.018, -0.018, 0.010] },
      { text: "RV (crescent)", at: [0.034, -0.004, 0.030] },
      { text: "Anterior septum", at: [0.008, 0.008, 0.028] },
      { text: "Inferior wall", at: [-0.016, -0.042, -0.018] },
      { text: "Lateral wall", at: [-0.050, -0.016, -0.002] },
    ],
  },
  {
    id: "a4c",
    label: "Apical 4-chamber",
    probe: [-0.088, -0.116, 0.088],
    target: [0.006, 0.068, -0.022],
    up: [0.9, 0.2, 0.3],
    spread: 32,
    depth: 0.30,
    camDist: 0.46,
    labels: [
      { text: "LV", at: [-0.026, -0.018, 0.004] },
      { text: "RV", at: [0.034, -0.004, 0.028] },
      { text: "LA", at: [-0.016, 0.070, -0.034] },
      { text: "RA", at: [0.046, 0.048, -0.002] },
      { text: "Mitral valve", at: [-0.010, 0.040, -0.018] },
      { text: "Tricuspid valve", at: [0.034, 0.030, 0.008] },
      { text: "Apex", at: [-0.046, -0.070, 0.030] },
    ],
  },
  {
    id: "a5c",
    label: "Apical 5-chamber",
    probe: [-0.088, -0.116, 0.092],
    // Tilting the beam anteriorly from A4C brings the LVOT and aortic valve
    // into the plane — the "fifth chamber".
    target: [0.010, 0.082, 0.004],
    up: [0.9, 0.2, 0.2],
    spread: 32,
    depth: 0.30,
    camDist: 0.46,
    labels: [
      { text: "LVOT", at: [-0.002, 0.044, -0.004] },
      { text: "Aortic valve", at: [0.006, 0.062, 0.000] },
      { text: "Ascending aorta", at: [0.010, 0.098, -0.004] },
      { text: "LV", at: [-0.026, -0.018, 0.004] },
      { text: "RV", at: [0.034, -0.004, 0.028] },
    ],
  },
  {
    id: "subcostal",
    label: "Subcostal 4-chamber",
    probe: [0.010, -0.215, 0.090],
    target: [-0.014, 0.052, -0.024],
    up: [-0.2, 0.75, 0.6],
    spread: 30,
    depth: 0.34,
    camDist: 0.56,
    labels: [
      { text: "RA", at: [0.046, 0.048, -0.002] },
      { text: "RV", at: [0.034, -0.004, 0.028] },
      { text: "LA", at: [-0.016, 0.070, -0.034] },
      { text: "LV", at: [-0.026, -0.018, 0.004] },
      { text: "Interatrial septum", at: [0.014, 0.060, -0.020] },
      { text: "Pericardium", at: [-0.046, -0.078, 0.030] },
    ],
  },
];

export const VIEW_LIST = VIEWS.map((v) => ({ id: v.id, label: v.label }));

/* ------------------------------------------------------------------ */
/* Cardiac cycle                                                        */
/* ------------------------------------------------------------------ */

export type Phase = {
  /** 0..1 through the cycle. */
  t: number;
  /** Plain-language name of the current mechanical event. */
  name: string;
  /** 0..1 ventricular contraction. */
  ventricle: number;
  /** 0..1 atrial contraction. */
  atrium: number;
};

const smoothBump = (x: number) => {
  if (x <= 0 || x >= 1) return 0;
  // Smooth 0→1→0 over the interval, with an ease at both ends.
  return Math.sin(Math.PI * x) ** 1.6;
};

/**
 * Mechanical events of one cardiac cycle, as fractions of R-R.
 *
 * Atrial systole tops up ventricular filling just before the ventricles
 * contract; ventricular systole is shorter than diastole, and the difference
 * widens as the rate falls — which is why diastole is what disappears when a
 * patient becomes tachycardic.
 */
function cyclePhase(t: number): Phase {
  const atrium = smoothBump((t - 0.0) / 0.14) * 1.0;
  const ventricle = smoothBump((t - 0.14) / 0.34) * 1.0;

  let name: string;
  if (t < 0.14) name = "Atrial systole";
  else if (t < 0.20) name = "Isovolumetric contraction";
  else if (t < 0.42) name = "Ventricular ejection";
  else if (t < 0.50) name = "Isovolumetric relaxation";
  else if (t < 0.70) name = "Rapid ventricular filling";
  else name = "Diastasis";

  return { t, name, ventricle, atrium };
}

/* ------------------------------------------------------------------ */
/* Shaders                                                              */
/* ------------------------------------------------------------------ */

const VERT = /* glsl */ `
  attribute float aSize;
  attribute float aSeed;
  attribute float aRegion;

  uniform float uTime;
  uniform float uForm;
  uniform float uVent;        // 0..1 ventricular contraction
  uniform float uAtr;         // 0..1 atrial contraction
  uniform vec3  uApexAxis;    // unit vector, base -> apex
  uniform vec3  uBase;        // LV base, heart-centred
  uniform vec3  uLaCentre;
  uniform vec3  uRaCentre;
  uniform float uPixelRatio;
  uniform float uScale;
  uniform float uRadius;
  uniform float uPlaneFade;   // dims particles far from the imaging plane
  uniform vec3  uPlaneNormal;
  uniform vec3  uPlanePoint;
  uniform float uPlaneWidth;

  varying float vAlpha;
  varying float vSeed;
  varying float vRegion;
  varying float vNearPlane;

  // Rotate v about a unit axis by angle a (Rodrigues).
  vec3 rotateAxis(vec3 v, vec3 axis, float a) {
    float c = cos(a), s = sin(a);
    return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
  }

  void main() {
    vec3 p = position;
    vSeed = aSeed;
    vRegion = aRegion;

    bool isVent = aRegion < 0.5;
    bool isAtr  = aRegion > 0.5 && aRegion < 1.5;
    bool isCor  = aRegion > 2.5;

    // Ventricles (and the coronaries riding on them) contract toward the
    // long axis, shorten toward the base, and wring: the apex rotates
    // opposite to the base, which is the motion that actually ejects blood.
    if (isVent || isCor) {
      vec3 rel = p - uBase;
      float along = dot(rel, uApexAxis);
      vec3 radial = rel - uApexAxis * along;
      radial *= 1.0 - 0.20 * uVent;
      along  *= 1.0 - 0.12 * uVent;
      vec3 contracted = uApexAxis * along + radial;
      contracted = rotateAxis(contracted, uApexAxis, uVent * 0.20 * (along * 12.0 - 0.5));
      p = uBase + contracted;
    }

    // Atria contract toward their own centres, not a shared one, or the
    // whole base of the heart slides sideways during atrial systole.
    if (isAtr) {
      vec3 c = p.x > 0.0 ? uRaCentre : uLaCentre;
      p = c + (p - c) * (1.0 - 0.22 * uAtr);
    }

    // Low-frequency drift so the cloud never looks frozen.
    float ph = aSeed * 6.2831853;
    p.x += sin(uTime * 0.6 + ph) * 0.0012;
    p.y += sin(uTime * 0.5 + ph * 1.7) * 0.0012;
    p.z += sin(uTime * 0.7 + ph * 2.3) * 0.0012;

    // Distance to the imaging plane, used to pick out the slice.
    float d = abs(dot(p - uPlanePoint, uPlaneNormal));
    vNearPlane = 1.0 - smoothstep(0.0, uPlaneWidth, d);

    p = mix(p * 2.2, p, uForm);

    vAlpha = mix(0.70, mix(0.13, 0.92, vNearPlane), uPlaneFade);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    float size = aSize * uRadius * uScale * uPixelRatio / max(-mv.z, 0.02);
    size *= 1.0 + vNearPlane * uPlaneFade * 0.35;
    size = clamp(size, 0.5, 10.0 * uPixelRatio);
    gl_PointSize = size;

    // Conserve light per particle as the sprite grows, or flying the camera
    // in clips the whole organ to white.
    vAlpha *= clamp((2.1 * uPixelRatio) / max(size, 0.5), 0.26, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;

  uniform vec3 uColVent;
  uniform vec3 uColAtr;
  uniform vec3 uColVessel;
  uniform vec3 uColCoronary;
  uniform float uHighlight;

  varying float vAlpha;
  varying float vSeed;
  varying float vRegion;
  varying float vNearPlane;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = dot(uv, uv);
    if (d > 0.25) discard;
    float a = pow(1.0 - d * 4.0, 2.2) * vAlpha;
    if (a < 0.002) discard;

    vec3 col = uColVent;
    if (vRegion > 0.5 && vRegion < 1.5) col = uColAtr;
    else if (vRegion > 1.5 && vRegion < 2.5) col = uColVessel;
    else if (vRegion > 2.5) col = uColCoronary;

    col *= 0.78 + vSeed * 0.44;
    // Structures the imaging plane passes through glow, which is the whole
    // point of the view overlay.
    // Enough to pick the slice out, not enough to erase the colour that
    // distinguishes ventricle from atrium from vessel.
    col += vec3(0.14, 0.26, 0.38) * vNearPlane * uHighlight;

    gl_FragColor = vec4(col, a);
  }
`;

/* ------------------------------------------------------------------ */
/* Engine                                                               */
/* ------------------------------------------------------------------ */

export type HeartCallbacks = {
  onPhase?: (p: Phase) => void;
  onLabels?: (labels: { text: string; x: number; y: number; visible: boolean }[]) => void;
  onReady?: () => void;
};

export class HeartEngine {
  private canvas: HTMLCanvasElement;
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private composer!: EffectComposer;
  private points!: THREE.Points;
  private material!: THREE.ShaderMaterial;
  private sector!: THREE.Group;
  private probeMesh!: THREE.Group;

  private clock = new THREE.Clock();
  private raf = 0;
  private running = false;
  private disposed = false;

  private cb: HeartCallbacks;
  private view: ViewId = "free";
  private playing = true;
  private bpm = 68;
  private cycleT = 0;
  private scrub: number | null = null;
  private form = 0;
  private planeFade = 0;
  private planeFadeTarget = 0;
  private labelsOn = true;

  private camFrom = new THREE.Vector3();
  private camTo = new THREE.Vector3();
  private tgtFrom = new THREE.Vector3();
  private tgtTo = new THREE.Vector3();
  private camT = 1;

  private activeLabels: StructureLabel[] = [];
  private tmp = new THREE.Vector3();
  private ro?: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, cb: HeartCallbacks = {}) {
    this.canvas = canvas;
    this.cb = cb;
  }

  async init() {
    const { width, height } = this.size();

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
      stencil: false,
    });
    this.renderer.setClearColor(0x04070f, 1);
    this.renderer.setPixelRatio(this.dpr());
    this.renderer.setSize(width, height, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, width / height, 0.01, 20);
    this.camera.position.set(0.19, 0.09, 0.46);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.enablePan = false;
    this.controls.minDistance = 0.14;
    this.controls.maxDistance = 0.9;
    this.controls.rotateSpeed = 0.8;
    this.controls.target.set(0, 0, 0);
    this.controls.addEventListener("start", () => {
      // Taking manual control drops out of the fixed view framing.
      this.camT = 1;
    });

    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.dpr());
    this.composer.setSize(width, height);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(
      new UnrealBloomPass(new THREE.Vector2(width, height), 0.40, 0.5, 0.26)
    );
    this.composer.addPass(new OutputPass());

    this.buildHeart();
    this.buildSector();

    this.attach();
    this.resize();
    this.start();
    this.cb.onReady?.();
  }

  private dpr() {
    return Math.min(window.devicePixelRatio || 1, 2);
  }

  private size() {
    const el = this.canvas.parentElement;
    return {
      width: Math.max(1, el?.clientWidth ?? 640),
      height: Math.max(1, el?.clientHeight ?? 420),
    };
  }

  /** Builds the point cloud, recentred so the heart sits on the origin. */
  private buildHeart() {
    const cloud = buildCloud(heartParts(), 52000, makeRng(0x4ea71), {
      interior: 0.14,
      shell: 0.0026,
      margin: 0.0028,
      sizeMin: 0.6,
      sizeMax: 1.5,
      yOffset: HEART_CENTRE[1],
    });

    // buildCloud only recentres Y; shift X and Z so the heart orbits about
    // itself rather than about the body's midline.
    const pos = cloud.positions;
    for (let i = 0; i < cloud.count; i++) {
      pos[i * 3] -= HEART_CENTRE[0];
      pos[i * 3 + 2] -= HEART_CENTRE[2];
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(cloud.sizes, 1));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(cloud.seeds, 1));
    geo.setAttribute("aRegion", new THREE.BufferAttribute(cloud.regions, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.5);

    // LV base and apex, in the same recentred frame, drive the contraction.
    const base = new THREE.Vector3(0.004, 0.050, -0.004);
    const apex = new THREE.Vector3(-0.046, -0.070, 0.030);
    const axis = apex.clone().sub(base).normalize();

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uForm: { value: 0 },
        uVent: { value: 0 },
        uAtr: { value: 0 },
        uApexAxis: { value: axis },
        uBase: { value: base },
        uLaCentre: { value: new THREE.Vector3(-0.016, 0.070, -0.034) },
        uRaCentre: { value: new THREE.Vector3(0.046, 0.048, -0.002) },
        uPixelRatio: { value: this.dpr() },
        uScale: { value: 1000 },
        uRadius: { value: 0.0027 },
        uPlaneFade: { value: 0 },
        uPlaneNormal: { value: new THREE.Vector3(0, 0, 1) },
        uPlanePoint: { value: new THREE.Vector3() },
        uPlaneWidth: { value: 0.016 },
        uColVent: { value: new THREE.Color(0xff8e7a) },
        uColAtr: { value: new THREE.Color(0xc98bff) },
        uColVessel: { value: new THREE.Color(0x63d8ff) },
        uColCoronary: { value: new THREE.Color(0xffd27a) },
        uHighlight: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
  }

  /** The ultrasound sector and a small transducer at its apex. */
  private buildSector() {
    this.sector = new THREE.Group();
    this.sector.visible = false;
    this.scene.add(this.sector);

    // Fan built in local space: apex at origin, sweeping about +Y, opening
    // along −Z. Positioned and oriented per view.
    const segments = 36;
    const verts: number[] = [];
    const alphas: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a0 = -0.5 + i / segments;
      const a1 = -0.5 + (i + 1) / segments;
      verts.push(0, 0, 0, a0, 0, -1, a1, 0, -1);
      alphas.push(1, 0, 0);
    }
    const fan = new THREE.BufferGeometry();
    fan.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    fan.setAttribute("aFade", new THREE.Float32BufferAttribute(alphas, 1));

    const fanMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0x7fe3ff) }, uOpacity: { value: 0.085 } },
      vertexShader: `
        attribute float aFade; varying float vF;
        void main(){ vF = aFade; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
      `,
      fragmentShader: `
        precision highp float; uniform vec3 uColor; uniform float uOpacity; varying float vF;
        void main(){ gl_FragColor = vec4(uColor, uOpacity * mix(0.04, 1.0, vF)); }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    this.sector.add(new THREE.Mesh(fan, fanMat));

    // Outline the sector edges so the plane reads crisply.
    const edge: number[] = [];
    edge.push(0, 0, 0, -0.5, 0, -1);
    edge.push(0, 0, 0, 0.5, 0, -1);
    for (let i = 0; i < segments; i++) {
      const a0 = -0.5 + i / segments;
      const a1 = -0.5 + (i + 1) / segments;
      edge.push(a0, 0, -1, a1, 0, -1);
    }
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute("position", new THREE.Float32BufferAttribute(edge, 3));
    this.sector.add(
      new THREE.LineSegments(
        edgeGeo,
        new THREE.LineBasicMaterial({
          color: 0x9ceaff,
          transparent: true,
          opacity: 0.55,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          depthTest: false,
        })
      )
    );

    // Transducer: a small slab at the sector apex.
    this.probeMesh = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.030, 0.016, 0.013),
      new THREE.MeshBasicMaterial({ color: 0x2b6f93 })
    );
    const face = new THREE.Mesh(
      new THREE.BoxGeometry(0.030, 0.004, 0.014),
      new THREE.MeshBasicMaterial({ color: 0x9ceaff })
    );
    face.position.y = -0.009;
    // Orientation marker: the dot that tells you which way the probe points.
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.0035, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffc46b })
    );
    marker.position.set(0.013, 0.004, 0.008);
    this.probeMesh.add(body, face, marker);
    this.sector.add(this.probeMesh);
  }

  /* ---------------------------------------------------------------- */
  /* Public API                                                        */
  /* ---------------------------------------------------------------- */

  setView(id: ViewId) {
    this.view = id;
    const def = VIEWS.find((v) => v.id === id);

    if (!def) {
      this.sector.visible = false;
      this.planeFadeTarget = 0;
      this.activeLabels = [];
      this.flyTo(new THREE.Vector3(0.19, 0.09, 0.46), new THREE.Vector3(0, 0.004, 0));
      return;
    }

    const probe = new THREE.Vector3(...def.probe);
    const target = new THREE.Vector3(...def.target);
    const beam = target.clone().sub(probe).normalize();

    // Orthogonalise the requested "up" against the beam to get a stable
    // in-plane frame, then the plane normal follows.
    const rawUp = new THREE.Vector3(...def.up);
    const inPlane = rawUp.clone().sub(beam.clone().multiplyScalar(rawUp.dot(beam))).normalize();
    const normal = new THREE.Vector3().crossVectors(beam, inPlane).normalize();

    // The fan's local frame: −Z along the beam, X across the sector.
    const m = new THREE.Matrix4().makeBasis(inPlane, normal, beam.clone().negate());
    this.sector.setRotationFromMatrix(m);
    this.sector.position.copy(probe);
    const halfWidth = Math.tan((def.spread * Math.PI) / 180) * def.depth;
    this.sector.scale.set(halfWidth * 2, 1, def.depth);
    this.sector.visible = true;

    // The probe sits at the sector apex in world scale, so undo the group
    // scaling on it.
    this.probeMesh.scale.set(1 / (halfWidth * 2), 1, 1 / def.depth);

    this.material.uniforms.uPlaneNormal.value = normal;
    this.material.uniforms.uPlanePoint.value = probe.clone();
    this.planeFadeTarget = 1;
    this.activeLabels = def.labels;

    // Park the camera square to the imaging plane, but centred on the heart
    // rather than on the sector: the subject is the organ, and the beam is
    // only there to show which part of it the plane cuts.
    const heart = new THREE.Vector3(0, 0.004, 0);
    const side = normal.clone().multiplyScalar(def.camDist);
    this.flyTo(heart.clone().add(side), heart);
  }

  setPlaying(on: boolean) {
    this.playing = on;
    if (on) this.scrub = null;
  }

  /** Manual scrub through the cycle, 0..1, or null to resume. */
  setScrub(t: number | null) {
    this.scrub = t;
    if (t !== null) {
      this.playing = false;
      this.cycleT = t;
    }
  }

  setRate(bpm: number) {
    this.bpm = Math.max(30, Math.min(160, bpm));
  }

  setLabels(on: boolean) {
    this.labelsOn = on;
  }

  resetView() {
    this.setView("free");
  }

  private flyTo(pos: THREE.Vector3, target: THREE.Vector3) {
    this.camFrom.copy(this.camera.position);
    this.camTo.copy(pos);
    this.tgtFrom.copy(this.controls.target);
    this.tgtTo.copy(target);
    this.camT = 0;
  }

  /* ---------------------------------------------------------------- */
  /* Loop                                                              */
  /* ---------------------------------------------------------------- */

  private start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = () => {
    if (!this.running || this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);

    const dt = Math.min(this.clock.getDelta(), 0.05);
    const time = this.clock.elapsedTime;

    this.form += (1 - this.form) * (1 - Math.exp(-dt * 2.2));
    this.planeFade += (this.planeFadeTarget - this.planeFade) * (1 - Math.exp(-dt * 4));

    if (this.playing && this.scrub === null) {
      this.cycleT = (this.cycleT + (dt * this.bpm) / 60) % 1;
    }
    const phase = cyclePhase(this.cycleT);

    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uForm.value = this.form;
    u.uVent.value = phase.ventricle;
    u.uAtr.value = phase.atrium;
    u.uPlaneFade.value = this.planeFade;
    u.uHighlight.value = this.planeFade;

    if (this.camT < 1) {
      this.camT = Math.min(1, this.camT + dt / 1.1);
      const e = this.camT < 0.5 ? 4 * this.camT ** 3 : 1 - (-2 * this.camT + 2) ** 3 / 2;
      this.camera.position.lerpVectors(this.camFrom, this.camTo, e);
      this.controls.target.lerpVectors(this.tgtFrom, this.tgtTo, e);
      this.camera.lookAt(this.controls.target);
    } else {
      this.controls.update();
    }

    this.emitLabels();
    this.cb.onPhase?.(phase);
    this.composer.render();
  };

  private emitLabels() {
    if (!this.cb.onLabels) return;
    if (!this.labelsOn || this.activeLabels.length === 0) {
      this.cb.onLabels([]);
      return;
    }
    const { width, height } = this.size();
    const out = this.activeLabels.map((l) => {
      this.tmp.set(l.at[0], l.at[1], l.at[2]).project(this.camera);
      return {
        text: l.text,
        x: (this.tmp.x * 0.5 + 0.5) * width,
        y: (-this.tmp.y * 0.5 + 0.5) * height,
        visible: this.tmp.z < 1 && this.form > 0.7,
      };
    });
    this.cb.onLabels(out);
  }

  private attach() {
    const parent = this.canvas.parentElement;
    if (parent && typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(parent);
    } else {
      window.addEventListener("resize", this.resize);
    }
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  private onVisibility = () => {
    if (document.visibilityState === "hidden") {
      this.running = false;
      cancelAnimationFrame(this.raf);
    } else if (!this.disposed) {
      this.start();
    }
  };

  resize = () => {
    if (this.disposed || !this.renderer) return;
    const { width, height } = this.size();
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this.dpr());
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(this.dpr());
    this.composer.setSize(width, height);
    this.material.uniforms.uPixelRatio.value = this.dpr();
    this.material.uniforms.uScale.value =
      height / 2 / Math.tan((this.camera.fov / 2) * THREE.MathUtils.DEG2RAD);
  };

  dispose() {
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    window.removeEventListener("resize", this.resize);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.controls?.dispose();
    this.scene?.traverse((o) => {
      const any = o as unknown as {
        geometry?: { dispose(): void };
        material?: { dispose(): void } | { dispose(): void }[];
      };
      any.geometry?.dispose?.();
      if (Array.isArray(any.material)) any.material.forEach((m) => m.dispose());
      else any.material?.dispose?.();
    });
    this.composer?.dispose?.();
    this.renderer?.dispose();
  }
}

export function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
  } catch {
    return false;
  }
}
