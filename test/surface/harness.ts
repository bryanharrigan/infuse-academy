/**
 * Renders the shipped anatomy meshes as shaded surfaces instead of particles,
 * to establish what fidelity is actually available from the geometry.
 *
 * Same .bin files, same loader. The only thing that changes is that the
 * triangles are drawn as triangles.
 */
import * as THREE from "three";
import { loadManifest, loadMesh, type StructureId } from "../../app/components/holographic/anatomy";

const BASE = "/anatomy";

/** Translucent, edge-lit. The look every medical x-ray illustration uses. */
function fresnelMaterial(colour: number, opts: { power: number; strength: number; core: number }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColour: { value: new THREE.Color(colour) },
      uPower: { value: opts.power },
      uStrength: { value: opts.strength },
      uCore: { value: opts.core },
      uLight: { value: new THREE.Vector3(0.35, 0.7, 0.6).normalize() },
    },
    vertexShader: `
      varying vec3 vN; varying vec3 vView;
      void main() {
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColour; uniform float uPower; uniform float uStrength;
      uniform float uCore; uniform vec3 uLight;
      varying vec3 vN; varying vec3 vView;
      void main() {
        vec3 n = normalize(vN);
        float f = pow(1.0 - abs(dot(n, normalize(vView))), uPower);
        float key = max(dot(n, normalize(uLight)), 0.0);
        float a = clamp(uCore + f * uStrength, 0.0, 1.0);
        vec3 col = uColour * (0.45 + 0.55 * key) + vec3(f * 0.5);
        gl_FragColor = vec4(col, a);
      }`,
    transparent: true,
    depthWrite: false,
    // Normal alpha, not additive: additive stacks every surface along the
    // ray and blows the chest out exactly the way the particle renderer did.
    // The whole point of moving to surfaces is that a surface can occlude.
    blending: THREE.NormalBlending,
    side: THREE.FrontSide,
  });
}

async function build(id: StructureId, manifest: Awaited<ReturnType<typeof loadManifest>>) {
  const mesh = await loadMesh(id, manifest, BASE);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  g.computeVertexNormals();
  return g;
}

(async () => {
  const canvas = document.getElementById("stage") as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.setClearColor(0x0a1b3d, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, canvas.clientWidth / canvas.clientHeight, 0.05, 60);

  const manifest = await loadManifest(BASE);

  // The body: translucent shell, front faces culled so you see into it.
  const skin = await build("skin", manifest);
  const skinMat = fresnelMaterial(0x2f6fc8, { power: 2.6, strength: 0.42, core: 0.015 });
  skinMat.side = THREE.BackSide;
  scene.add(new THREE.Mesh(skin, skinMat));

  // The organs: solid, lit, sitting inside it.
  // Skeleton faint and behind, lungs the subject — the arrangement the
  // reference illustration uses.
  const bone = await build("skeleton", manifest);
  scene.add(new THREE.Mesh(bone, fresnelMaterial(0x5e95e8, { power: 2.0, strength: 0.34, core: 0.05 })));
  const lung = await build("lungs", manifest);
  scene.add(new THREE.Mesh(lung, fresnelMaterial(0xf05ac0, { power: 1.5, strength: 0.55, core: 0.30 })));

  camera.position.set(0.22, 0.30, 1.05);
  camera.lookAt(0, 0.26, 0);
  renderer.render(scene, camera);
  (window as unknown as { __done?: boolean }).__done = true;
})();
