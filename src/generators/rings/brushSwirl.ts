import * as THREE from 'three';
import type { EffectParams, GeneratorContext, GeneratorDef } from '../../engine/contracts';
import { C, col, DEG, hash, N, num, S, sel } from '../../effects/b/common';
import { NOISE_GLSL } from '../../effects/lib';
import { clearTarget, drawInstancedQuads, LAYER_VERT, type LayerUniforms, layerUniforms, lightGlow, rng, setLayerUniforms } from '../common';
import { centreParams, layerPxScale } from './shared';

// 筆渦 / 墨 (brush swirl): a few thick dry-brush strokes circling a centre (arc, spiral, 円相 ring)
// or cutting across it (一閃 slash), tapered at both ends, broken up by bristle gaps that open
// toward the dry tail, with splatter droplets thrown off the sides and past the end.

const PATHS = ['arc', 'spiral', 'slash', 'ring'] as const;
type PathKind = (typeof PATHS)[number];

/** One stroke's centreline samples (layer px) and width. */
interface Stroke {
  x: Float32Array;
  y: Float32Array;
  /** Unit tangent (direction of travel). */
  tx: Float32Array;
  ty: Float32Array;
  /** Half width at each sample. */
  hw: Float32Array;
  /** Arc length from the stroke's start. */
  len: Float32Array;
  /** Full (untapered) width. */
  width: number;
  seed: number;
}

/** Smooth 1D value noise in [0, 1). */
function noise1(x: number, seed: number) {
  const i = Math.floor(x);
  const f = x - i;
  const s = f * f * (3 - 2 * f);
  return hash(seed, i) * (1 - s) + hash(seed, i + 1) * s;
}

/**
 * Centreline point at path parameter t ∈ [0, 1], `off` px to the side (outward for the round
 * paths, to the left of travel for the slash), relative to the centre.
 */
function pathPoint(kind: PathKind, t: number, R: number, a0: number, sweep: number, off: number): [number, number] {
  if (kind === 'slash') {
    // A long stroke through the centre along a0, bowed slightly to one side.
    const ux = Math.cos(a0);
    const uy = Math.sin(a0);
    const s = R * (2 * t - 1);
    const n = off + 0.06 * R * Math.sin(Math.PI * t);
    return [ux * s - uy * n, uy * s + ux * n];
  }
  // Clockwise from a0. The spiral winds inward to 30 % of the radius; the ring (円相) goes once
  // round and overshoots its start, drifting a little outward so the ends overlap side by side.
  const th = a0 - (kind === 'ring' ? 2 * Math.PI + 0.4 : sweep) * t;
  const r = (R + off) * (kind === 'spiral' ? 1 - 0.7 * t : kind === 'ring' ? 1 + 0.05 * t : 1);
  return [r * Math.cos(th), r * Math.sin(th)];
}

/** The strokes of params `p`, deterministic from the params and seed. */
function buildStrokes(p: EffectParams): Stroke[] {
  const path = S(p, 'path') as PathKind;
  const kind: PathKind = PATHS.includes(path) ? path : 'arc';
  const R = Math.max(1, N(p, 'radius'));
  const a0 = N(p, 'angle') * DEG;
  const sweep = Math.max(1, N(p, 'sweep')) * DEG;
  const n = Math.round(Math.min(12, Math.max(1, N(p, 'strokes'))));
  const spacing = N(p, 'spacing');
  const W = Math.max(1, N(p, 'width'));
  const tin = Math.min(1, Math.max(0, N(p, 'taperIn') / 100));
  const tout = Math.min(1, Math.max(0, N(p, 'taperOut') / 100));
  // Taper: how thin the end gets (a blunt press at 0 %, a hair-fine point at 100 %) and over how
  // much of the stroke it narrows.
  const inStart = 1 - 0.9 * tin;
  const inLen = 0.03 + 0.3 * tin;
  const outEnd = 1 - 0.95 * tout;
  const outLen = 0.03 + 0.5 * tout;
  const seed = N(p, 'seed');
  const cx = N(p, 'cx');
  const cy = N(p, 'cy');
  const rand = rng(seed * 101 + 7);
  const main = Math.floor((n - 1) / 2);
  const pathLen = kind === 'slash' ? 2 * R : kind === 'ring' ? (2 * Math.PI + 0.4) * R : sweep * R * (kind === 'spiral' ? 0.65 : 1);
  const strokes: Stroke[] = [];
  for (let j = 0; j < n; j++) {
    // The middle stroke is the full, widest one; the others are thinner and start / end a little
    // off it, like the separate bristle clumps of one big brush.
    const isMain = j === main;
    const wf = isMain ? 1 : 0.45 + 0.5 * rand();
    const t0 = isMain ? 0 : 0.15 * rand();
    const t1 = isMain ? 1 : 1 - 0.3 * rand();
    const off = (j - (n - 1) / 2) * spacing + (isMain ? 0 : (rand() - 0.5) * 0.3 * spacing);
    const sSeed = seed * 13 + j * 7.31;
    const width = W * wf;
    const M = Math.min(1000, Math.max(16, Math.ceil(((t1 - t0) * pathLen) / 4)));
    const s: Stroke = {
      x: new Float32Array(M),
      y: new Float32Array(M),
      tx: new Float32Array(M),
      ty: new Float32Array(M),
      hw: new Float32Array(M),
      len: new Float32Array(M),
      width,
      seed: hash(sSeed, 3) * 100,
    };
    for (let k = 0; k < M; k++) {
      const u = k / (M - 1);
      // The hand wobbles: a slow sideways drift of about a tenth of the width.
      const wob = 0.2 * width * (noise1(u * 5, sSeed) - 0.5);
      const [x, y] = pathPoint(kind, t0 + (t1 - t0) * u, R, a0, sweep, off + wob);
      s.x[k] = cx + x;
      s.y[k] = cy + y;
      // Pressure: the press-in swells fast, the lift-off thins out over a long tail.
      const swell = inStart + (1 - inStart) * (1 - (1 - Math.min(1, u / inLen)) ** 2);
      const lift = outEnd + (1 - outEnd) * Math.min(1, (1 - u) / outLen) ** 0.8;
      s.hw[k] = 0.5 * width * swell * lift * (0.8 + 0.4 * noise1(u * 3, sSeed + 1));
    }
    for (let k = 0; k < M; k++) {
      const a = Math.max(0, k - 1);
      const b = Math.min(M - 1, k + 1);
      const dx = s.x[b] - s.x[a];
      const dy = s.y[b] - s.y[a];
      const d = Math.hypot(dx, dy) || 1;
      s.tx[k] = dx / d;
      s.ty[k] = dy / d;
      s.len[k] = k === 0 ? 0 : s.len[k - 1] + Math.hypot(s.x[k] - s.x[k - 1], s.y[k] - s.y[k - 1]);
    }
    // Round caps: the brush tip is round, so both ends close in a half disc of their width.
    const total = s.len[M - 1];
    const h0 = Math.max(1e-3, s.hw[0]);
    const h1 = Math.max(1e-3, s.hw[M - 1]);
    for (let k = 0; k < M; k++) {
      const a = 1 - Math.min(1, s.len[k] / h0);
      const b = 1 - Math.min(1, (total - s.len[k]) / h1);
      s.hw[k] *= Math.sqrt(Math.max(0, 1 - a * a)) * Math.sqrt(Math.max(0, 1 - b * b));
    }
    strokes.push(s);
  }
  return strokes;
}

// ---------- ribbon mesh ----------

const strokeVert = /* glsl */ `
in vec2 aUV;   // (u along the stroke 0..1, px across from the centreline)
in vec4 aInfo; // (arc length px, half width px, stroke seed, stroke width px)
out vec2 vUV; out vec4 vInfo;
${LAYER_VERT}
void main() {
  vUV = aUV;
  vInfo = aInfo;
  gl_Position = layerToClip(position.xy);
}`;

const strokeFrag = /* glsl */ `
uniform vec3 uColor; uniform float uDry;
in vec2 vUV; in vec4 vInfo; out vec4 o;
${NOISE_GLSL}
void main() {
  float u = vUV.x, across = vUV.y;
  float len = vInfo.x, hw = max(vInfo.y, 1e-3), seed = vInfo.z, W = max(vInfo.w, 1.0);
  float sn = across / hw; // −1 … 1 across the ink
  float s = abs(sn);
  // Hairs: clumps across the stroke (≈ W/10 + 3 per half width, converging in the tapers like a
  // real tip) stretched far along it, with finer single hairs inside them.
  float f = W / 5.0 + 6.0;
  float b1 = vnoise(vec2(sn * f * 0.5 + seed * 31.0, len / (4.0 * W)));
  float b2 = vnoise(vec2(sn * f * 2.3 + seed * 17.0, len / (1.5 * W)));
  float b = 0.6 * b1 + 0.4 * b2;
  // Ragged rim: the outermost hairs straggle.
  float rim = 1.0 - 0.08 * vnoise(vec2(len / (0.3 * W), seed * 13.0)) - 0.08 * vnoise(vec2(len / (0.06 * W), seed * 7.0 + 3.0));
  float cov = clamp((rim * hw - abs(across)) / max(fwidth(across), 1e-4) + 0.5, 0.0, 1.0);
  // Dry brush (かすれ): hairs run out of ink toward the tail and on the rims first, with dry
  // patches along the way where the brush skipped over the paper.
  float skip = vnoise(vec2(len / (1.2 * W), seed * 5.0 + 11.0));
  float thr = uDry * ((0.35 + 0.9 * pow(u, 1.2)) * (0.75 + 0.6 * s * s) + 0.5 * (skip - 0.5));
  // Two value noises mix to a narrow band around 0.5: stretch it so the threshold above opens
  // real gaps (white streaks of paper) instead of hairlines.
  float bs = clamp((b - 0.5) * 2.4 + 0.5, 0.0, 1.0);
  float aw = max(0.04, fwidth(bs)); // hair gaps stay anti-aliased when they get finer than a pixel
  float ink = uDry > 0.0 ? smoothstep(thr - aw, thr + aw, bs) : 1.0;
  // Sheen follows the hairs (bright / dark streaks in gold and red); the ink stays near solid.
  float a = cov * ink * (0.94 + 0.06 * b1);
  o = vec4(uColor * (0.45 + 1.1 * b2) * a, a);
}`;

const splatFrag = /* glsl */ `
${NOISE_GLSL}
void main() {
  float d = length(vQuad) + 0.22 * (vnoise(vQuad * 2.5 + vExtra.x) - 0.5);
  float aa = 2.0 / max(min(vSizePx.x, vSizePx.y), 1.0);
  o = vColor * clamp((0.8 - d) / aa + 0.5, 0.0, 1.0);
}`;

/** The params buildStrokes() reads: a change of any of them rebuilds the strokes. */
const STROKE_KEYS = ['path', 'cx', 'cy', 'radius', 'sweep', 'angle', 'strokes', 'spacing', 'width', 'taperIn', 'taperOut', 'seed'];

interface Ribbon {
  key: string;
  strokes: Stroke[];
  /** Rim padding the mesh was built with (layer px). */
  padPx: number;
  mesh: THREE.Mesh;
}

/** Strokes and their ribbon mesh per generator layer, rebuilt when the strokes or the rim padding change. */
const ribbons = new Map<string, Ribbon>();

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
let material: THREE.ShaderMaterial | null = null;

/** Triangle strips along each stroke, `padPx` layer px wider than the ink on each side for the anti-aliased rim. */
function ribbonGeometry(strokes: Stroke[], padPx: number) {
  const verts = strokes.reduce((n, s) => n + 2 * s.x.length, 0);
  const quads = strokes.reduce((n, s) => n + s.x.length - 1, 0);
  const pos = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  const info = new Float32Array(verts * 4);
  const index = new Uint32Array(quads * 6);
  let v = 0;
  let q = 0;
  for (const s of strokes) {
    const M = s.x.length;
    for (let k = 0; k < M; k++) {
      const e = s.hw[k] + padPx;
      for (let side = -1; side <= 1; side += 2) {
        // Normal = tangent turned left: (−ty, tx).
        pos[v * 3] = s.x[k] - s.ty[k] * e * side;
        pos[v * 3 + 1] = s.y[k] + s.tx[k] * e * side;
        uv[v * 2] = k / (M - 1);
        uv[v * 2 + 1] = e * side;
        info[v * 4] = s.len[k];
        info[v * 4 + 1] = s.hw[k];
        info[v * 4 + 2] = s.seed;
        info[v * 4 + 3] = s.width;
        v++;
      }
      if (k > 0) {
        const a = v - 4;
        index[q++] = a;
        index[q++] = a + 1;
        index[q++] = a + 2;
        index[q++] = a + 1;
        index[q++] = a + 3;
        index[q++] = a + 2;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aUV', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  return geo;
}

/** This layer's strokes and ribbon mesh for params `p`, from the cache when nothing they depend on changed. */
function ribbonFor(ctx: GeneratorContext, p: EffectParams): Ribbon {
  const key = STROKE_KEYS.map((k) => String(p[k])).join('|');
  const padPx = 1.5 / Math.max(1e-6, layerPxScale(ctx));
  let rb = ribbons.get(ctx.layerId);
  if (rb && rb.key === key && rb.padPx === padPx) return rb;
  const strokes = rb && rb.key === key ? rb.strokes : buildStrokes(p);
  rb?.mesh.geometry.dispose();
  material ??= new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: strokeVert,
    // Strip winding follows the direction of travel (clockwise or not): draw both faces.
    side: THREE.DoubleSide,
    fragmentShader: strokeFrag,
    uniforms: { ...layerUniforms(), uColor: { value: new THREE.Color() }, uDry: { value: 0 } },
    depthTest: false,
    depthWrite: false,
    transparent: true,
    // Premultiplied "over".
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  const mesh = new THREE.Mesh(ribbonGeometry(strokes, padPx), material);
  mesh.frustumCulled = false;
  rb = { key, strokes, padPx, mesh };
  ribbons.set(ctx.layerId, rb);
  return rb;
}

function drawRibbons(ctx: GeneratorContext, target: THREE.WebGLRenderTarget, mesh: THREE.Mesh, p: EffectParams) {
  const m = mesh.material as THREE.ShaderMaterial;
  setLayerUniforms(m.uniforms as unknown as LayerUniforms, ctx, ctx.layerToRender);
  m.uniforms.uColor.value.copy(C(p, 'color'));
  m.uniforms.uDry.value = Math.min(1, Math.max(0, N(p, 'dry') / 100));
  scene.add(mesh);
  const r = ctx.renderer;
  const prevAutoClear = r.autoClear;
  r.autoClear = false;
  r.setRenderTarget(target);
  r.render(scene, camera);
  r.autoClear = prevAutoClear;
  scene.remove(mesh);
}

/** Most droplets, at Splatter 100 %. */
const MAX_SPLATS = 120;

/** Droplets sprayed off the strokes' sides and flicked past their ends. */
function drawSplatter(ctx: GeneratorContext, target: THREE.WebGLRenderTarget, strokes: Stroke[], p: EffectParams) {
  const count = Math.round((Math.min(100, Math.max(0, N(p, 'splatter'))) / 100) * MAX_SPLATS);
  if (count === 0) return;
  const rand = rng(N(p, 'seed') * 31 + 5);
  const c = C(p, 'color');
  const center = new Float32Array(count * 2);
  const size = new Float32Array(count * 2);
  const rotation = new Float32Array(count);
  const color = new Float32Array(count * 4);
  const extra = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const s = strokes[Math.min(strokes.length - 1, Math.floor(rand() * strokes.length))];
    const M = s.x.length;
    const W = s.width;
    let x: number;
    let y: number;
    let k: number;
    let d = W * (0.04 + 0.22 * rand() ** 3);
    if (rand() < 0.7) {
      // Sprayed off a side, more toward the fast tail.
      k = Math.min(M - 1, Math.floor(rand() ** 0.7 * M));
      const side = rand() < 0.5 ? -1 : 1;
      const dist = s.hw[k] + W * (0.08 + 1.4 * rand() ** 2);
      const along = (rand() - 0.5) * 0.6 * W;
      x = s.x[k] - s.ty[k] * dist * side + s.tx[k] * along;
      y = s.y[k] + s.tx[k] * dist * side + s.ty[k] * along;
    } else {
      // Flicked on past the end of the stroke.
      k = M - 1;
      const ahead = W * (0.3 + 2.2 * rand());
      const aside = (rand() - 0.5) * 0.5 * W;
      x = s.x[k] + s.tx[k] * ahead - s.ty[k] * aside;
      y = s.y[k] + s.ty[k] * ahead + s.tx[k] * aside;
      d *= 0.7;
    }
    const stretch = rand() < 0.35 ? 1.5 + 2 * rand() : 1;
    center.set([x, y], i * 2);
    size.set([d * stretch, d], i * 2);
    rotation[i] = Math.atan2(s.ty[k], s.tx[k]);
    color.set([c.r, c.g, c.b, 1], i * 4);
    extra[i * 4] = rand() * 100;
  }
  drawInstancedQuads(ctx, target, { count, center, size, rotation, color, extra, toRender: ctx.layerToRender, fragmentShader: splatFrag, blend: 'normal' });
}

/** Furthest ink from the centre (layer px). */
function reach(p: EffectParams) {
  const R = Math.max(1, N(p, 'radius'));
  const n = Math.round(Math.min(12, Math.max(1, N(p, 'strokes'))));
  const W = Math.max(1, N(p, 'width'));
  // Ring overshoot / slash bow, the outermost stroke's offset and jitter, its half width with
  // pressure swell and wobble, then the splatter's reach (side spray and end flicks).
  const ink = 1.06 * R + 0.5 * (n - 1) * Math.abs(N(p, 'spacing')) * 1.15 + 0.75 * W;
  return ink + (N(p, 'splatter') > 0 ? 3.4 * W : 0) + 2;
}

/** Glow of the coloured presets: a halo around the paint, kept below the stroke's own strength so the hairs stay readable. */
const brushGlow = (size: number) => lightGlow(size, 0.6);

export const brushSwirl: GeneratorDef = {
  type: 'brushSwirl',
  label: 'Brush Swirl',
  category: 'Rings',
  description:
    '筆渦 / 墨: thick dry-brush strokes along an arc, an inward spiral, a 円相 ring or a 一閃 slash, tapered in and out, ' +
    'with bristle gaps opening toward the dry tail and splatter droplets. Black ink by default; gold, red or white.',
  params: [
    sel('path', 'Path', 'arc', [
      ['arc', 'Arc'],
      ['spiral', 'Spiral'],
      ['slash', 'Slash'],
      ['ring', 'Ring (円相)'],
    ]),
    ...centreParams(),
    num('radius', 'Radius', 380, 10, 3000, 'px'),
    { ...num('sweep', 'Sweep', 300, 10, 1080, 'deg'), when: { key: 'path', value: ['arc', 'spiral'] } },
    num('angle', 'Start angle', 150, -180, 180, 'deg'),
    num('strokes', 'Strokes', 4, 1, 12, undefined, 1),
    num('spacing', 'Stroke spacing', 26, 0, 400, 'px'),
    num('width', 'Width', 70, 1, 600, 'px'),
    num('taperIn', 'Taper in', 15, 0, 100, '%'),
    num('taperOut', 'Taper out', 85, 0, 100, '%'),
    num('dry', 'Dry brush', 45, 0, 100, '%'),
    num('splatter', 'Splatter', 30, 0, 100, '%'),
    col('color', 'Colour', '#0b0907'),
    num('seed', 'Seed', 1, 0, 999, undefined, 1),
  ],
  presets: [
    { id: 'ink', label: 'Ink swirl', params: {} },
    {
      id: 'gold',
      label: 'Gold brush',
      params: {
        path: 'spiral', radius: 420, sweep: 420, angle: 120, strokes: 3, spacing: 34, width: 64, taperIn: 20, taperOut: 90, dry: 55, splatter: 25,
        color: '#d9a030',
      },
      effects: [brushGlow(14)],
    },
    {
      id: 'red',
      label: 'Red brush',
      params: { path: 'ring', radius: 360, angle: -130, strokes: 2, spacing: 18, width: 84, taperIn: 10, taperOut: 70, dry: 40, splatter: 35, color: '#d0121a' },
      effects: [brushGlow(10)],
    },
    {
      id: 'slash',
      label: 'Slash',
      params: { path: 'slash', radius: 560, angle: 18, strokes: 3, spacing: 12, width: 50, taperIn: 90, taperOut: 95, dry: 50, splatter: 20, color: '#fff8ec' },
      effects: [brushGlow(16)],
    },
  ],
  handles: [{ x: 'cx', y: 'cy', label: 'Swirl centre' }],
  sizes: [{ rx: 'radius', x: 'cx', y: 'cy', label: 'Radius' }],
  bounds(p) {
    const E = reach(p);
    const cx = N(p, 'cx');
    const cy = N(p, 'cy');
    return { x0: cx - E, y0: cy - E, x1: cx + E, y1: cy + E };
  },
  render(ctx, target, p) {
    clearTarget(ctx, target);
    const rb = ribbonFor(ctx, p);
    drawRibbons(ctx, target, rb.mesh, p);
    drawSplatter(ctx, target, rb.strokes, p);
  },
  dispose() {
    for (const rb of ribbons.values()) rb.mesh.geometry.dispose();
    ribbons.clear();
    material?.dispose();
    material = null;
  },
};
