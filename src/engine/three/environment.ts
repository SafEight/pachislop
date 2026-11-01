import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { getAsset, type AssetEntry } from '../../assets/registry';
import type { Comp, EnvPreset, PhotoEnvPreset } from '../../model/types';

type Environment = Comp['environment'];

// PMREM environment maps for the 3D layers: each layer and part renders with its effective
// environment (model/lighting.ts). Most presets are small procedural scenes (gradient
// sky sphere + emissive softboxes / tubes / discs) rendered once through
// PMREMGenerator.fromScene; 'softbox' is a bundled CC0 studio HDRI (public/hdri); 'highway',
// 'city' and 'sky' are the 2D reflection maps' photographs (public/reflections), oriented as in
// 2D: a flat face mirrors the panorama's centre column, sky above, ground below. They carry no
// key softbox: the photograph alone lights the metal, as Eye Candy's reflection map does.
// Text faces +z toward the camera, so flat caps mirror the +z half of the environment and
// bevels sweep across the rest: presets keep that half bright and banded so a gold face
// never turns muddy when the title is rotated. A flat face turned by θ mirrors a direction 2θ
// off-axis, out of reach of those bands, so every preset (and the softbox HDRI) also carries
// a broad, soft-edged KEY softbox on the left (keySoftbox): a title turned toward it — the
// usual three-quarter pose — catches one big bright reflection across the whole face instead
// of mirroring dim floor. Title3DProps.envLock (materials.ts) is the full fix for any pose.
// The environment's tint / saturation / contrast (Element 3D Physical Environment) grade the
// finished PMREM texels into a copy. Prefiltering is linear, so tint and saturation (linear
// colour maps) are exact; contrast is a power curve, exact on the mirror level and a close
// approximation on the blurred (rough) levels — cheap enough to drag live.

type Rgb = [number, number, number];
type SkyStop = [elevation: number, color: Rgb];

// Procedural presets: cube face size of the PMREM. Mirror chrome reflects the top mip 1:1, so
// it sets how crisp strip-light edges stay; exports at ≥ 2× get the larger map.
const PMREM_SIZE = 1024;
const PMREM_SIZE_HI = 2048;
const PMREM_HI_SCALE = 2; // render px per comp px from which PMREM_SIZE_HI is used
const PMREM_AA_TEXELS = 1.25; // preset cube-render antialiasing blur, in cube texels (90° = size texels)
/** Preset PMREMs kept per size (a 1024 map is ~100 MB of half floats, a 2048 one ~400 MB). */
const PMREM_CACHE: Record<number, number> = { [PMREM_SIZE]: 3, [PMREM_SIZE_HI]: 1 };
/** Graded copies kept (each as large as its source PMREM): a layer's and its parts' own in one frame. */
const GRADE_CACHE = 3;
// The bundled softbox HDRI is 1k wide (~256 px per 90°): a 512 cube already oversamples it.
const SOFTBOX_PMREM_SIZE = 512;
/** The reflection-map photos are 1024 × 512 like the softbox HDRI. */
const PHOTO_PMREM_SIZE = 512;

type ProceduralPreset = Exclude<EnvPreset, 'custom' | 'softbox' | PhotoEnvPreset>;

const isPhoto = (p: EnvPreset): p is PhotoEnvPreset => p === 'highway' || p === 'city' || p === 'sky';

function skySphere(stops: SkyStop[]): THREE.Mesh {
  const geo = new THREE.SphereGeometry(50, 96, 480);
  const pos = geo.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const e = pos.getY(i) / 50;
    let c: Rgb = stops[stops.length - 1][1];
    if (e <= stops[0][0]) c = stops[0][1];
    else {
      for (let k = 0; k < stops.length - 1; k++) {
        const [e0, c0] = stops[k];
        const [e1, c1] = stops[k + 1];
        if (e <= e1) {
          const x = (e - e0) / (e1 - e0 || 1);
          c = [c0[0] + (c1[0] - c0[0]) * x, c0[1] + (c1[1] - c0[1]) * x, c0[2] + (c1[2] - c0[2]) * x];
          break;
        }
      }
    }
    col.set(c, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide }));
}

function emissive(color: Rgb, intensity: number) {
  return new THREE.MeshBasicMaterial({
    color: new THREE.Color(color[0] * intensity, color[1] * intensity, color[2] * intensity),
    side: THREE.DoubleSide,
  });
}

/** Rectangular softbox facing the origin. */
function panel(scene: THREE.Scene, w: number, h: number, at: [number, number, number], color: Rgb, intensity: number) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), emissive(color, intensity));
  m.position.set(...at);
  m.lookAt(0, 0, 0);
  scene.add(m);
}

/** Thin glowing tube from a to b. */
function tube(scene: THREE.Scene, a: [number, number, number], b: [number, number, number], r: number, color: Rgb, intensity: number) {
  const va = new THREE.Vector3(...a);
  const vb = new THREE.Vector3(...b);
  const len = va.distanceTo(vb);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 12, 1), emissive(color, intensity));
  m.position.copy(va).add(vb).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
  scene.add(m);
}

function disc(scene: THREE.Scene, r: number, at: [number, number, number], color: Rgb, intensity: number) {
  const m = new THREE.Mesh(new THREE.CircleGeometry(r, 48), emissive(color, intensity));
  m.position.set(...at);
  m.lookAt(0, 0, 0);
  scene.add(m);
}

// Key softbox: centre direction and angular size (degrees; azimuth < 0 = left, 0 = toward the
// camera), placed beyond the strip lights (KEY_DIST) so their hard lines still cross it. A
// face turned θ mirrors 2θ off-axis, so a three-quarter pose (rotY ≈ −35, i.e. 70°) reaches
// the key while a face turned ≤ ~20° (and head-on titles) keeps mirroring the banded front:
// tuned on 大当り, whose comp slides the environment 25° (its front pose stays unchanged).
const KEY_AZIMUTH = -95;
const KEY_ELEVATION = 0;
const KEY_WIDTH = 70;
const KEY_HEIGHT = 110; // tall, so tilting up or down (rotX ±20°) still lands on it
const KEY_DIST = 30;
const KEY_EDGE = 0.3; // soft border, fraction of the half size over which it fades in

/**
 * The broad key softbox (see the header): an additive plane whose brightness fades in from
 * its rim, so reflections of it have soft edges instead of a hard seam across a tilted face.
 */
function keySoftbox(scene: THREE.Scene, color: Rgb, intensity: number) {
  const w = 2 * KEY_DIST * Math.tan((KEY_WIDTH / 2) * DEG);
  const h = 2 * KEY_DIST * Math.tan((KEY_HEIGHT / 2) * DEG);
  const geo = new THREE.PlaneGeometry(w, h, 24, 32);
  const uv = geo.getAttribute('uv');
  const col = new Float32Array(uv.count * 3);
  for (let i = 0; i < uv.count; i++) {
    const ex = Math.min(uv.getX(i), 1 - uv.getX(i)) * 2;
    const ey = Math.min(uv.getY(i), 1 - uv.getY(i)) * 2;
    const f = smooth(Math.min(1, ex / KEY_EDGE)) * smooth(Math.min(1, ey / KEY_EDGE));
    col.fill(f, i * 3, i * 3 + 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = emissive(color, intensity);
  mat.vertexColors = true;
  mat.transparent = true;
  mat.blending = THREE.AdditiveBlending;
  mat.depthWrite = false;
  const m = new THREE.Mesh(geo, mat);
  const az = KEY_AZIMUTH * DEG;
  const el = KEY_ELEVATION * DEG;
  m.position.set(Math.sin(az) * Math.cos(el) * KEY_DIST, Math.sin(el) * KEY_DIST, Math.cos(az) * Math.cos(el) * KEY_DIST);
  m.lookAt(0, 0, 0);
  scene.add(m);
}

const smooth = (x: number) => x * x * (3 - 2 * x);
const DEG = Math.PI / 180;

/**
 * Key softbox colour and peak radiance per preset ('softbox' = the HDRI). About the brightness
 * of each preset's own front bands, not hotter: a hot white key turns a gold face it fills
 * pale cream; at this level the face reads as bright, still saturated gold.
 */
const KEY_LIGHT: Record<Exclude<EnvPreset, 'custom' | PhotoEnvPreset>, [Rgb, number]> = {
  studio: [[1, 1, 1], 1.05],
  strips: [[1, 1, 1], 0.9],
  softbox: [[1, 1, 1], 0.9],
  backlit: [[1, 0.97, 0.92], 0.5],
  under: [[1, 0.95, 0.85], 0.55],
  gold: [[1, 0.85, 0.6], 1.05],
  sunset: [[1, 0.62, 0.32], 0.9],
  neon: [[1, 0.35, 0.8], 0.65],
  night: [[0.8, 0.88, 1], 0.55],
};

function buildPreset(preset: ProceduralPreset): THREE.Scene {
  const s = new THREE.Scene();
  const W: Rgb = [1, 1, 1];
  switch (preset) {
    case 'studio': {
      // Azimuth-invariant bands in front, so a face reflects the same light whichever way
      // the title is turned: a bright floor sweep, a soft grey horizon line, a hot sky glow
      // above it. Contrast stays moderate (no near-black zone near the horizon: a small
      // head-on face reflects only a few degrees of it and would turn muddy) — the banding
      // comes from the metal presets' tint gradients. Hard vertical strip lights add
      // 'biki-tto' glints on the bevels, tiny very hot discs add specular sparkles.
      s.add(
        skySphere([
          [-1, [0.05, 0.05, 0.055]],
          [-0.55, [0.35, 0.35, 0.37]],
          [-0.3, [0.9, 0.9, 0.92]],
          [-0.18, [0.55, 0.55, 0.57]],
          [-0.1, [1.15, 1.15, 1.17]],
          [-0.04, [0.5, 0.5, 0.52]],
          [0.0, [0.42, 0.42, 0.45]],
          [0.02, [2.4, 2.4, 2.45]],
          [0.12, [1.5, 1.52, 1.58]],
          [0.24, [0.45, 0.46, 0.5]],
          [0.32, [0.95, 0.97, 1.02]],
          [0.6, [0.32, 0.33, 0.36]],
          [1, [0.7, 0.7, 0.72]],
        ]),
      );
      panel(s, 0.8, 30, [-9, 0, 12], W, 9);
      panel(s, 0.8, 30, [9, 0, 12], W, 9);
      panel(s, 0.6, 30, [-14, 0, 4], W, 8);
      panel(s, 0.6, 30, [14, 0, 4], W, 8);
      panel(s, 1.5, 30, [-12, 0, -8], W, 5);
      panel(s, 1.5, 30, [12, 0, -8], W, 5);
      panel(s, 20, 1.2, [0, 14, 3], W, 6);
      disc(s, 0.35, [-5, 7, 13], W, 60);
      disc(s, 0.35, [6, 4, 14], W, 60);
      disc(s, 0.3, [-11, -3, 9], W, 50);
      disc(s, 0.3, [10, 9, 8], W, 50);
      break;
    }
    case 'strips': {
      // 遊技機 studio: a dim neutral room lit by LONG strip lights — horizontal bars across
      // the front and overhead, vertical bars at the sides. Every bevel crossing a bar
      // mirrors it as a long, hard specular band (the "biki-tto" line along a gold rim);
      // the soft front wash keeps flat faces readable between the bands.
      s.add(
        skySphere([
          [-1, [0.03, 0.03, 0.033]],
          [-0.4, [0.3, 0.3, 0.31]],
          [-0.12, [0.95, 0.95, 0.97]],
          [0.0, [0.6, 0.6, 0.62]],
          [0.15, [1.05, 1.05, 1.08]],
          [0.5, [0.25, 0.25, 0.27]],
          [1, [0.1, 0.1, 0.11]],
        ]),
      );
      // front horizontal bars at several heights (flat faces and horizontal bevels)
      panel(s, 44, 0.45, [0, 7, 13], W, 14);
      panel(s, 44, 0.3, [0, 2.2, 15], W, 10);
      panel(s, 44, 0.45, [0, -5, 13], W, 12);
      // overhead bars running left → right and front → back
      panel(s, 44, 0.6, [0, 15, 4], W, 14);
      panel(s, 44, 0.6, [0, 15, -6], W, 9);
      // tall side strips (vertical bevels), a front pair and a grazing pair
      panel(s, 0.5, 44, [-10, 0, 11], W, 14);
      panel(s, 0.5, 44, [10, 0, 11], W, 14);
      panel(s, 0.7, 44, [-15, 0, 1], W, 12);
      panel(s, 0.7, 44, [15, 0, 1], W, 12);
      panel(s, 1, 44, [-11, 0, -10], W, 6);
      panel(s, 1, 44, [11, 0, -10], W, 6);
      break;
    }
    case 'backlit': {
      // 派手 back light: a darkish front, a blazing wall and halo BEHIND the title and a
      // hot ring around the silhouette direction, so side walls and outer bevels flare as
      // rim light while faces stay deep (CGWORLD 派手学: the main light may sit behind).
      s.add(
        skySphere([
          [-1, [0.01, 0.008, 0.012]],
          [-0.35, [0.06, 0.05, 0.07]],
          [-0.08, [0.22, 0.2, 0.24]],
          [0.0, [0.12, 0.11, 0.13]],
          [0.1, [0.28, 0.26, 0.3]],
          [0.45, [0.08, 0.075, 0.09]],
          [1, [0.03, 0.03, 0.035]],
        ]),
      );
      // big hot wall behind and its glow
      panel(s, 26, 26, [0, 2, -16], W, 9);
      disc(s, 4, [0, 3, -14], W, 40);
      // rim ring: bright panels around the silhouette (z ≈ 0)
      const ringN = 12;
      for (let i = 0; i < ringN; i++) {
        const a = (i / ringN) * Math.PI * 2;
        panel(s, 5, 1.2, [Math.cos(a) * 15.5, Math.sin(a) * 15.5, -1.5], W, 22);
      }
      // grazing back strips at the sides
      panel(s, 1.2, 40, [-13, 0, -7], W, 18);
      panel(s, 1.2, 40, [13, 0, -7], W, 18);
      // a faint front fill so faces are not black
      panel(s, 30, 6, [0, 4, 16], W, 0.9);
      break;
    }
    case 'under': {
      // 下からのスポットライト: a hot spot low in front, a lit floor sweep and a dark ceiling,
      // so lower bevels and the underside of strokes catch the light (stage up-lighting).
      s.add(
        skySphere([
          [-1, [0.9, 0.85, 0.75]],
          [-0.55, [1.6, 1.5, 1.3]],
          [-0.25, [0.45, 0.42, 0.38]],
          [-0.05, [0.12, 0.11, 0.1]],
          [0.1, [0.05, 0.05, 0.055]],
          [0.5, [0.02, 0.02, 0.025]],
          [1, [0.01, 0.01, 0.012]],
        ]),
      );
      const warmW: Rgb = [1, 0.95, 0.85];
      disc(s, 2.6, [0, -11, 10], warmW, 45);
      disc(s, 1.4, [-7, -12, 6], warmW, 30);
      disc(s, 1.4, [7, -12, 6], warmW, 30);
      panel(s, 36, 1.2, [0, -7, 13], warmW, 9);
      panel(s, 0.6, 18, [-12, -6, 7], warmW, 8);
      panel(s, 0.6, 18, [12, -6, 7], warmW, 8);
      // soft fill high in front so top faces read
      panel(s, 24, 3, [0, 9, 13], W, 0.7);
      break;
    }
    case 'gold': {
      s.add(
        skySphere([
          [-1, [0.03, 0.012, 0.0]],
          [-0.45, [0.35, 0.16, 0.03]],
          [-0.2, [0.9, 0.5, 0.14]],
          [-0.06, [0.25, 0.11, 0.02]],
          [-0.02, [0.12, 0.05, 0.01]],
          [0.0, [2.6, 1.7, 0.7]],
          [0.1, [1.2, 0.7, 0.22]],
          [0.4, [0.3, 0.16, 0.04]],
          [1, [0.9, 0.62, 0.3]],
        ]),
      );
      const warm: Rgb = [1, 0.82, 0.55];
      panel(s, 1.1, 18, [-8, 2, 10], warm, 6);
      panel(s, 1.1, 18, [8, 2, 10], warm, 6);
      panel(s, 0.8, 18, [-12.5, 1, 3.5], [1, 0.75, 0.4], 5);
      panel(s, 0.8, 18, [12.5, 1, 3.5], [1, 0.75, 0.4], 5);
      panel(s, 16, 2.5, [0, 13, 4], [1, 0.9, 0.7], 6);
      panel(s, 6, 1, [0, 6, 13], [1, 0.95, 0.8], 10);
      panel(s, 3, 14, [-12, 0, -7], [1, 0.5, 0.12], 5);
      panel(s, 3, 14, [12, 0, -7], [1, 0.5, 0.12], 5);
      panel(s, 22, 1.5, [0, -5, 12], [1, 0.45, 0.1], 2);
      break;
    }
    case 'sunset': {
      s.add(
        skySphere([
          [-1, [0.015, 0.005, 0.03]],
          [-0.45, [0.12, 0.04, 0.12]],
          [-0.18, [0.75, 0.25, 0.22]],
          [-0.05, [0.3, 0.08, 0.12]],
          [-0.01, [0.25, 0.06, 0.12]],
          [0.0, [3.2, 1.25, 0.32]],
          [0.08, [1.8, 0.45, 0.4]],
          [0.25, [0.7, 0.16, 0.45]],
          [0.55, [0.12, 0.06, 0.3]],
          [1, [0.02, 0.03, 0.14]],
        ]),
      );
      disc(s, 2.2, [-5, 1.6, 14], [1, 0.8, 0.45], 35);
      panel(s, 18, 1.5, [0, 1.5, 15], [1, 0.45, 0.15], 6);
      panel(s, 2, 12, [12, 4, 6], [1, 0.3, 0.6], 5);
      panel(s, 16, 2, [0, 12, -6], [0.5, 0.3, 1], 3);
      break;
    }
    case 'neon': {
      s.add(
        skySphere([
          [-1, [0.004, 0.002, 0.008]],
          [-0.4, [0.08, 0.01, 0.12]],
          [-0.2, [0.35, 0.04, 0.4]],
          [-0.05, [0.015, 0.005, 0.03]],
          [0.05, [0.04, 0.01, 0.07]],
          [0.3, [0.03, 0.12, 0.2]],
          [1, [0.006, 0.004, 0.02]],
        ]),
      );
      const pink: Rgb = [1, 0.08, 0.55];
      const cyan: Rgb = [0.05, 0.75, 1];
      const purple: Rgb = [0.5, 0.15, 1];
      tube(s, [-14, 4, 10], [14, 4, 10], 0.35, pink, 14);
      tube(s, [-14, -2, 12], [14, -2, 12], 0.3, cyan, 14);
      tube(s, [-8, -10, 9], [-8, 12, 9], 0.35, cyan, 12);
      tube(s, [8, -10, 9], [8, 12, 9], 0.35, pink, 12);
      tube(s, [-12, 10, 3], [12, 10, 3], 0.4, purple, 10);
      tube(s, [-13, -8, -6], [-13, 10, -6], 0.4, pink, 10);
      tube(s, [13, -8, -6], [13, 10, -6], 0.4, cyan, 10);
      tube(s, [-10, 1, 14], [10, 1, 14], 0.15, W, 16);
      panel(s, 20, 3, [0, -10, 6], [0.3, 0.05, 0.5], 1.5);
      break;
    }
    case 'night': {
      s.add(
        skySphere([
          [-1, [0.004, 0.005, 0.012]],
          [-0.3, [0.03, 0.04, 0.08]],
          [-0.1, [0.12, 0.13, 0.2]],
          [-0.03, [0.03, 0.04, 0.09]],
          [0.0, [0.9, 1.0, 1.35]],
          [0.07, [0.35, 0.42, 0.7]],
          [0.2, [0.06, 0.08, 0.2]],
          [0.5, [0.02, 0.03, 0.09]],
          [1, [0.006, 0.008, 0.035]],
        ]),
      );
      disc(s, 1.4, [6, 9, 10], [0.85, 0.92, 1], 30);
      // deterministic scattered city lights along the horizon
      let seed = 1337;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 60; i++) {
        const az = rnd() * Math.PI * 2;
        const el = -0.02 - rnd() * 0.12;
        const r = 18;
        const warmLight = rnd() < 0.55;
        const col: Rgb = warmLight ? [1, 0.6, 0.25] : [0.4, 0.75, 1];
        panel(s, 0.25 + rnd() * 0.5, 0.15 + rnd() * 0.4, [Math.sin(az) * r, el * r, Math.cos(az) * r], col, 8 + rnd() * 12);
      }
      // moonlit reflector bands behind the camera: faces stay readable (cool white, not murky)
      panel(s, 22, 1.4, [0, 4.5, 14], [0.85, 0.92, 1], 5);
      panel(s, 22, 1, [0, -3, 14], [0.75, 0.85, 1], 3);
      panel(s, 2, 14, [-11, 0, 6], [0.5, 0.65, 1], 4);
      panel(s, 1.2, 14, [12, 0, 4], [0.85, 0.92, 1], 5);
      break;
    }
  }
  const [keyColor, keyIntensity] = KEY_LIGHT[preset];
  keySoftbox(s, keyColor, keyIntensity);
  return s;
}

function disposeScene(s: THREE.Scene) {
  s.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  });
}

interface CustomEntry {
  asset: AssetEntry;
  rt: THREE.WebGLRenderTarget | null;
}

const _lockM = new THREE.Matrix4();
const _yawM = new THREE.Matrix4();

/**
 * `envMapRotation` for plain three materials (GLB originals, which lack the part shader's
 * normal-swap lock, materials.ts): the comp yaw and, when `lockRot` (layer axes → world) is
 * given, the environment counter-rotated with the layer. three samples the map at
 * R(euler)ᵀ · world direction, so the locked lookup R_y(yaw)ᵀ · Lᵀ · d is R(euler) = L · R_y(yaw).
 * Rotation-only: a tilted mirror still turns its reflection by the tilt (not twice), so this is
 * an approximation of the part shader's lock.
 */
export function envMapEuler(out: THREE.Euler, yaw: number, lockRot: THREE.Matrix3 | null): THREE.Euler {
  if (!lockRot) return out.set(0, yaw, 0);
  _lockM.setFromMatrix3(lockRot).multiply(_yawM.makeRotationY(yaw));
  return out.setFromRotationMatrix(_lockM);
}

// ---------- async readiness ----------

const readyListeners = new Set<() => void>();

/**
 * Called whenever an asynchronously loaded environment (the bundled HDRI behind 'softbox',
 * or a custom .hdr/.exr/image) becomes available — re-render then.
 */
export function onEnvironmentReady(cb: () => void): () => void {
  readyListeners.add(cb);
  return () => {
    readyListeners.delete(cb);
  };
}

/** Bundled CC0 HDRI (Poly Haven "studio_small_09", 1k) behind the 'softbox' preset. */
const SOFTBOX_HDRI = `${import.meta.env.BASE_URL}hdri/studio_small_09_1k.hdr`;
/**
 * Yaw of the HDRI sphere. An inside-out SphereGeometry shows an equirect mirrored in z
 * relative to three's equirect reflection mapping, which already puts this HDRI's big
 * softboxes behind the camera — where flat title faces reflect.
 */
const SOFTBOX_YAW = 0;
/**
 * Yaw of a reflection-map photo's sphere: SphereGeometry puts the image's centre column at +x;
 * turned to +z, where a flat face facing the camera mirrors (the 2D reflection map's convention).
 */
const PHOTO_YAW = -Math.PI / 2;

/** A photo panorama on an inside-out sphere at `yaw`, plus the key softbox when `key` is given. */
function panoramaScene(tex: THREE.Texture, yaw: number, key?: [Rgb, number]): THREE.Scene {
  const scene = new THREE.Scene();
  const sky = new THREE.Mesh(new THREE.SphereGeometry(50, 128, 64), new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide }));
  sky.rotation.y = yaw;
  scene.add(sky);
  if (key) keySoftbox(scene, ...key);
  return scene;
}

/** Decode an equirect HDR / EXR / LDR image (any mime) into a linear texture. */
function loadEquirect(data: ArrayBuffer, name: string, mime: string): Promise<THREE.Texture> {
  const n = name.toLowerCase();
  const m = mime.toLowerCase();
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  // Dynamic EXR import: custom .exr environments are rare, so the EXR decoder is a lazy chunk (precached for offline use).
  const load: Promise<THREE.Texture> =
    n.endsWith('.hdr') || m.includes('radiance') || m.includes('hdr')
      ? new HDRLoader().setDataType(THREE.HalfFloatType).loadAsync(url)
      : n.endsWith('.exr') || m.includes('exr')
        ? import('three/examples/jsm/loaders/EXRLoader.js').then(({ EXRLoader }) => new EXRLoader().setDataType(THREE.HalfFloatType).loadAsync(url))
        : new THREE.TextureLoader().loadAsync(url).then((tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            return tex;
          });
  return load.finally(() => URL.revokeObjectURL(url));
}

/** Element 3D Physical Environment grade: linear multipliers, 1 / '#ffffff' = unchanged. */
interface EnvGrade {
  tint: string;
  contrast: number;
  saturation: number;
}

/** Linear-light value contrast pivots around: the mid tones of the procedural presets. */
const CONTRAST_PIVOT = 0.5;

/** One graded copy: the PMREM it was graded from and the grade. */
interface GradeEntry {
  rt: THREE.WebGLRenderTarget;
  src: THREE.Texture;
  key: string;
}

/**
 * Grades a PMREM texture texel-for-texel into a same-sized copy (keeps the CubeUV layout).
 * Copies are cached by source and grade, least recently used first; each 3D layer may have its
 * own environment, so several graded maps can be live in one frame. An evicted copy's target
 * is reused for the next grade.
 */
class GradePass {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      tSrc: { value: null },
      uTint: { value: new THREE.Color() },
      uContrast: { value: 1 },
      uSaturation: { value: 1 },
    },
    vertexShader: /* glsl */ `
      out vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    // Saturation mixes with Rec.709 luminance; contrast is a power curve on luminance around
    // CONTRAST_PIVOT (HDR-safe: black stays black, hot lights scale with their luminance) that
    // rescales the colour, so it does not shift hues.
    fragmentShader: /* glsl */ `
      uniform sampler2D tSrc; uniform vec3 uTint; uniform float uContrast; uniform float uSaturation;
      in vec2 vUv; out vec4 o;
      const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
      const float PIVOT = ${CONTRAST_PIVOT.toFixed(4)};
      void main() {
        vec4 c = texelFetch(tSrc, ivec2(gl_FragCoord.xy), 0);
        vec3 col = c.rgb * uTint;
        float l = dot(col, LUMA);
        col = max(vec3(l) + (col - vec3(l)) * uSaturation, vec3(0.0));
        float l2 = dot(col, LUMA);
        if (l2 > 1e-6) col *= PIVOT * pow(l2 / PIVOT, uContrast) / l2;
        o = vec4(col, c.a);
      }`,
    depthTest: false,
    depthWrite: false,
  });
  /** Graded copies, least recently used first. */
  private readonly entries: GradeEntry[] = [];

  private readonly renderer: THREE.WebGLRenderer;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  apply(src: THREE.Texture, g: EnvGrade): THREE.Texture {
    const key = `${g.tint}|${g.contrast}|${g.saturation}`;
    const hit = this.entries.findIndex((e) => e.src === src && e.key === key);
    if (hit >= 0) {
      const [e] = this.entries.splice(hit, 1);
      this.entries.push(e); // most recently used
      return e.rt.texture;
    }
    const { width, height } = src.image as { width: number; height: number };
    let rt: THREE.WebGLRenderTarget;
    if (this.entries.length >= GRADE_CACHE) {
      rt = this.entries.shift()!.rt;
      if (rt.width !== width || rt.height !== height) rt.setSize(width, height);
    } else {
      rt = new THREE.WebGLRenderTarget(width, height, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
      });
      rt.texture.mapping = THREE.CubeUVReflectionMapping;
      rt.texture.name = 'PMREM.cubeUv.graded';
    }
    rt.texture.colorSpace = src.colorSpace;
    const u = this.material.uniforms;
    u.tSrc.value = src;
    u.uTint.value.set(g.tint);
    u.uContrast.value = Math.max(0, g.contrast);
    u.uSaturation.value = Math.max(0, g.saturation);
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(rt);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
    this.entries.push({ rt, src, key });
    return rt.texture;
  }

  dispose() {
    for (const e of this.entries) e.rt.dispose();
    this.entries.length = 0;
    this.material.dispose();
    for (const o of this.scene.children) (o as THREE.Mesh).geometry.dispose();
  }
}

export class EnvironmentManager {
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly gradePass: GradePass;
  /** Preset PMREMs by `${preset}@${size}`, least recently used first. */
  private readonly presets = new Map<string, THREE.WebGLRenderTarget>();
  private readonly custom = new Map<string, CustomEntry>();
  private softbox: THREE.WebGLRenderTarget | null = null;
  /** Reflection-map photo PMREMs, loaded on first use (null while loading or after a failed load). */
  private readonly photos = new Map<PhotoEnvPreset, THREE.WebGLRenderTarget | null>();
  private disposed = false;

  constructor(renderer: THREE.WebGLRenderer) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.gradePass = new GradePass(renderer);
    // fetch the bundled HDRI up front so it is ready long before anyone picks 'softbox'
    fetch(SOFTBOX_HDRI)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => loadEquirect(buf, SOFTBOX_HDRI, 'image/vnd.radiance'))
      .then((tex) => {
        if (this.disposed) {
          tex.dispose();
          return;
        }
        // bake the orientation into the PMREM: equirect on an inside-out sphere, rendered as a scene
        const scene = panoramaScene(tex, SOFTBOX_YAW, KEY_LIGHT.softbox);
        this.softbox = this.pmrem.fromScene(scene, 0, 0.1, 100, { size: SOFTBOX_PMREM_SIZE });
        disposeScene(scene);
        tex.dispose();
        for (const l of readyListeners) l();
      })
      .catch((err) => console.warn('Softbox environment failed to load', err));
  }

  /**
   * Graded PMREM texture for `env` (the effective environment of a 3D layer or part,
   * model/lighting.ts); null while an HDRI loads or a custom asset is missing. `pxScale` = render px per
   * comp px: picks the procedural map size. Maps are cached per environment (least recently
   * used evicted, see PMREM_CACHE / GRADE_CACHE), so layers with different environments share
   * one frame.
   */
  update(env: Environment, pxScale: number): THREE.Texture | null {
    const tex = this.ungraded(env, pxScale >= PMREM_HI_SCALE ? PMREM_SIZE_HI : PMREM_SIZE);
    const grade: EnvGrade = { tint: env.tint.toLowerCase(), contrast: env.contrast, saturation: env.saturation };
    const neutral = grade.tint === '#ffffff' && grade.contrast === 1 && grade.saturation === 1;
    return tex && !neutral ? this.gradePass.apply(tex, grade) : tex;
  }

  /**
   * False while `env`'s asynchronous map (softbox HDRI / reflection-map photo / custom HDR) is
   * still loading; starts a photo or custom load. Procedural presets are always ready (built on
   * render).
   */
  ready(env: Environment): boolean {
    if (env.preset === 'softbox') return this.softbox !== null;
    if (isPhoto(env.preset)) return this.photoMap(env.preset) !== null;
    if (env.preset !== 'custom') return true;
    return !env.customAssetId || this.customMap(env.customAssetId) !== null;
  }

  private ungraded(env: Environment, size: number): THREE.Texture | null {
    const preset = env.preset;
    if (preset === 'softbox') return this.softbox?.texture ?? null;
    if (isPhoto(preset)) return this.photoMap(preset);
    if (preset !== 'custom') return this.presetMap(preset, size).texture;
    const id = env.customAssetId;
    return id ? this.customMap(id) : null;
  }

  /** PMREM of the reflection-map photo `name` (null while it loads; the first call starts the load). */
  private photoMap(name: PhotoEnvPreset): THREE.Texture | null {
    if (!this.photos.has(name)) {
      this.photos.set(name, null);
      const url = `${import.meta.env.BASE_URL}reflections/${name}.jpg`;
      fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        })
        .then((buf) => loadEquirect(buf, url, 'image/jpeg'))
        .then((tex) => {
          if (this.disposed) {
            tex.dispose();
            return;
          }
          const scene = panoramaScene(tex, PHOTO_YAW);
          this.photos.set(name, this.pmrem.fromScene(scene, 0, 0.1, 100, { size: PHOTO_PMREM_SIZE }));
          disposeScene(scene);
          tex.dispose();
          for (const l of readyListeners) l();
        })
        .catch((err) => console.warn(`Environment photo “${name}” failed to load`, err));
    }
    return this.photos.get(name)?.texture ?? null;
  }

  /** PMREM of a custom equirect asset (null while it loads or when the asset is missing). */
  private customMap(id: string): THREE.Texture | null {
    const asset = getAsset(id);
    if (!asset) return null;
    let entry = this.custom.get(id);
    if (entry && entry.asset !== asset) {
      entry.rt?.dispose();
      entry = undefined;
    }
    if (!entry) {
      const fresh: CustomEntry = { asset, rt: null };
      entry = fresh;
      this.custom.set(id, fresh);
      loadEquirect(asset.data, asset.name, asset.mime)
        .then((tex) => {
          if (this.disposed || this.custom.get(asset.id) !== fresh) {
            tex.dispose();
            return;
          }
          tex.mapping = THREE.EquirectangularReflectionMapping;
          fresh.rt = this.pmrem.fromEquirectangular(tex);
          tex.dispose();
          for (const l of readyListeners) l();
        })
        .catch((err) => console.warn(`Environment asset "${asset.name}" failed to load`, err));
    }
    return entry.rt ? entry.rt.texture : null;
  }

  /** Procedural preset PMREM at `size`, built on demand; keeps the PMREM_CACHE most recent per size. */
  private presetMap(preset: ProceduralPreset, size: number): THREE.WebGLRenderTarget {
    const key = `${preset}@${size}`;
    let rt = this.presets.get(key);
    if (rt) this.presets.delete(key);
    else {
      const scene = buildPreset(preset);
      // the cube render is not antialiased: blur by a texel or so (not a fixed angle, which
      // would throw away the extra resolution and soften the strip edges again)
      rt = this.pmrem.fromScene(scene, (PMREM_AA_TEXELS * Math.PI) / 2 / size, 0.1, 100, { size });
      disposeScene(scene);
      const sameSize = [...this.presets.keys()].filter((k) => k.endsWith(`@${size}`));
      for (const k of sameSize.slice(0, Math.max(0, sameSize.length - PMREM_CACHE[size] + 1))) {
        this.presets.get(k)!.dispose();
        this.presets.delete(k);
      }
    }
    this.presets.set(key, rt); // re-insert = most recently used
    return rt;
  }

  dispose() {
    this.disposed = true;
    for (const rt of this.presets.values()) rt.dispose();
    for (const e of this.custom.values()) e.rt?.dispose();
    for (const rt of this.photos.values()) rt?.dispose();
    this.softbox?.dispose();
    this.softbox = null;
    this.presets.clear();
    this.custom.clear();
    this.photos.clear();
    this.pmrem.dispose();
    this.gradePass.dispose();
  }
}
