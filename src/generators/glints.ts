import * as THREE from 'three';
import type { EffectParams, GeneratorDef, PassContext } from '../engine/contracts';
import { B, bool, C, col, common, DEG, drawObject, gridDistance, type Grid, hash, HEAD, material, N, num, readGrid, rng, S, sel } from '../effects/b/common';
import { centreX, centreY } from '../engine/frame';
import { ANAMORPHIC_GLSL, drawFollowed, followed, followParam } from './common';

// Glints: star sparkles on a followed layer — on its highlight peaks (a few large glints plus small
// ones, favouring the face over the outer rims), on its hottest peaks (big flare stars), one long
// hero glint across it, scattered over and around its shape, or one star at a fixed point. They
// draw light only (alpha = the brightest channel), so a Glints layer set to Add over the title
// adds exactly that light.
//
// Highlights are found on the followed layer as styled (GeneratorContext.layerAlpha: with its
// effects), the scatter shape on its own pixels (layerContent). Placement is scale invariant: the
// analysis grid is fixed in comp px (readGrid) and pickHighlights smooths near ties, so the stars
// sit in the same place at every export scale.

// ---------- star sprites ----------

export interface Star {
  x: number; // render px, bottom-left origin
  y: number;
  size: number; // radius, render px
  rot: number; // radians
  intensity: number;
  color: THREE.Color;
}

const starVert = /* glsl */ `
in vec2 iPos; in float iSize; in float iRot; in float iInt; in vec3 iCol;
out vec2 vL; out float vI; out vec3 vC;
uniform vec2 uRes;
void main() {
  vL = position.xy; vI = iInt; vC = iCol;
  float c = cos(iRot), s = sin(iRot);
  vec2 p = iPos + mat2(c, s, -s, c) * position.xy * iSize;
  gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);
}`;

const starFrag = /* glsl */ `
in vec2 vL; in float vI; in vec3 vC; out vec4 o;
uniform int uRays; uniform float uThin; uniform bool uSpectral;
// Hue wheel, t = 0 red … 0.72 violet.
vec3 spectrum(float t) {
  return clamp(abs(fract(t + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}
vec3 ray(vec2 v, float ang, float len, float thin) {
  vec2 d = vec2(cos(ang), sin(ang));
  float al = abs(dot(v, d)) / len;
  if (al >= 1.0) return vec3(0.0);
  float pe = abs(dot(v, vec2(-d.y, d.x)));
  float w = thin * (1.0 - al) + 0.003;
  float fall = pow(1.0 - al, 1.2);
  // Sharp spike plus a softer sheath around it.
  if (!uSpectral) return vec3((exp(-pe / w) + 0.35 * exp(-pe / (w * 4.0))) * fall);
  // Cross-screen diffraction: the sheath fans out by wavelength (red widest, blue tightest)
  // and the ray runs violet → red outward, twice, leaving the hot centre white.
  vec3 wc = w * vec3(1.4, 1.0, 0.7);
  vec3 i = exp(-pe / wc) + 0.5 * exp(-pe / (wc * 4.0));
  vec3 tint = mix(vec3(1.0), 1.7 * spectrum(0.72 * (1.0 - fract(al * 2.0 + 0.15))), smoothstep(0.04, 0.2, al));
  return i * tint * fall;
}
void main() {
  vec2 v = vL;
  float r = length(v);
  vec3 I;
  float haloK = 0.6;
  if (uRays == 4) {
    I = ray(v, 0.0, 1.0, uThin) + ray(v, 1.5708, 1.0, uThin);
  } else if (uRays == 6) {
    // Snow cross (6-line cross-screen filter): three equal needle axes, vertical + ±60°.
    float t = uThin * 0.7;
    I = ray(v, 1.5708, 1.0, t) + ray(v, 0.5236, 1.0, t) + ray(v, 2.618, 1.0, t);
    haloK = 0.35;
  } else {
    I = ray(v, 0.0, 1.0, uThin) + ray(v, 1.5708, 1.0, uThin) + 0.6 * (ray(v, 0.7854, 0.5, uThin) + ray(v, -0.7854, 0.5, uThin));
  }
  float core = exp(-r * r * 50.0);
  float halo = exp(-r * 6.0) * haloK * (1.0 - smoothstep(0.7, 1.0, r));
  float lum = dot(I, vec3(0.3333));
  vec3 c = vC * (I + halo) + vec3(1.0) * (core * 2.0 + lum * 0.6 * exp(-r * 2.5));
  c *= vI;
  o = vec4(c, max(c.r, max(c.g, c.b)));
}`;

const starState = new WeakMap<object, { mesh: THREE.Mesh; geo: THREE.InstancedBufferGeometry; cap: number }>();

function starMesh(kit: object, n: number) {
  let st = starState.get(kit);
  if (!st || st.cap < n) {
    st?.geo.dispose();
    const cap = Math.max(256, 2 ** Math.ceil(Math.log2(n)));
    const quad = new THREE.PlaneGeometry(2, 2);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(quad.getIndex());
    geo.setAttribute('position', quad.getAttribute('position'));
    const ia = (k: string, size: number) =>
      geo.setAttribute(k, new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size).setUsage(THREE.DynamicDrawUsage));
    ia('iPos', 2);
    ia('iSize', 1);
    ia('iRot', 1);
    ia('iInt', 1);
    ia('iCol', 3);
    const mat =
      st?.mesh.material instanceof THREE.ShaderMaterial
        ? st.mesh.material
        : new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: starVert,
            fragmentShader: starFrag,
            uniforms: {
              uRes: { value: new THREE.Vector2() },
              uRays: { value: 4 },
              uThin: { value: 0.02 },
              uSpectral: { value: false },
            },
            depthTest: false,
            depthWrite: false,
            transparent: true,
            blending: THREE.AdditiveBlending,
            premultipliedAlpha: true,
          });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    st = { mesh, geo, cap };
    starState.set(kit, st);
  }
  return st;
}

/** Sprite look shared by every star of one effect. */
interface StarLook {
  /** Ray count of the shape: 4 (cross), 6 (snow cross) or 8 (4 long + 4 short). */
  rays: number;
  /** Ray half-width at the centre, fraction of the radius. */
  thin: number;
  /** Rainbow diffraction fringe on the rays. */
  spectral: boolean;
}

/** Additively draw star sprites into `target` (cleared first). */
function drawStars(ctx: PassContext, stars: Star[], look: StarLook, target: THREE.WebGLRenderTarget) {
  const st = starMesh(ctx.kit, stars.length);
  const g = st.geo;
  const pos = g.getAttribute('iPos') as THREE.InstancedBufferAttribute;
  const size = g.getAttribute('iSize') as THREE.InstancedBufferAttribute;
  const rot = g.getAttribute('iRot') as THREE.InstancedBufferAttribute;
  const int = g.getAttribute('iInt') as THREE.InstancedBufferAttribute;
  const colr = g.getAttribute('iCol') as THREE.InstancedBufferAttribute;
  stars.forEach((s, i) => {
    pos.setXY(i, s.x, s.y);
    size.setX(i, s.size);
    rot.setX(i, s.rot);
    int.setX(i, s.intensity);
    colr.setXYZ(i, s.color.r, s.color.g, s.color.b);
  });
  for (const a of [pos, size, rot, int, colr]) a.needsUpdate = true;
  g.instanceCount = stars.length;
  const m = st.mesh.material as THREE.ShaderMaterial;
  m.uniforms.uRes.value.set(ctx.width, ctx.height);
  m.uniforms.uRays.value = look.rays;
  m.uniforms.uThin.value = look.thin;
  m.uniforms.uSpectral.value = look.spectral;
  drawObject(ctx, st.mesh, target);
}

/** Light × gain as premultiplied light (alpha = brightest channel): an Add layer then adds exactly the light. */
const lightFrag = /* glsl */ `
uniform sampler2D tLight; uniform float uGain;
void main() { o = lightPremul(texture(tLight, vUv).rgb * uGain); }`;

/** Star sprites `stars` as light × `gain` into `target`. */
function renderStars(ctx: PassContext, target: THREE.WebGLRenderTarget, stars: Star[], look: StarLook, gain: number) {
  if (stars.length === 0) {
    ctx.kit.clear(target);
    return;
  }
  const tmp = ctx.kit.acquire();
  drawStars(ctx, stars, look, tmp);
  const m = material(ctx.kit, 'gen-glints-light', {
    uniforms: { tLight: { value: null }, uGain: { value: 1 } },
    fragmentShader: HEAD + lightFrag,
  });
  m.uniforms.tLight.value = tmp.texture;
  m.uniforms.uGain.value = gain;
  ctx.kit.run(m, target);
  ctx.kit.release(tmp);
}

const RAYS: [string, string][] = [
  ['4', '4-ray cross'],
  ['snow', '6-ray snow cross'],
  ['8', '8-ray star (4 long + 4 short)'],
];

const RAY_COUNT: Record<string, number> = { '4': 4, snow: 6, '8': 8 };

/** Ray half-width at the centre, fraction of the radius, at 100 % thickness: big flare stars (peaks, point) are finer than sparkles. */
const thinBase = (placement: string) => (placement === 'peaks' || placement === 'point' ? 0.026 : 0.035);

const starLook = (p: EffectParams): StarLook => ({
  rays: RAY_COUNT[S(p, 'rays')] ?? 4,
  thin: thinBase(S(p, 'placement')) * (N(p, 'thickness') / 100),
  spectral: B(p, 'spectral'),
});

// ---------- highlight finder ----------

/** Analysis cell, comp px. Fixed in comp space so placement is identical at every export scale. */
const HL_CELL = 4;
/** Neighbourhood (cells each way) a highlight's prominence is measured against: 6 × 4 = 24 comp px. */
const HL_BG = 6;

/** A highlight peak: comp px about the comp centre, y up. */
interface Highlight {
  x: number;
  y: number;
  score: number;
  /** Scale- and canvas-independent hash key (the analysis cell, counted from the comp centre). */
  key: number;
}

/**
 * [1 2 1]/4 blur along x then y, four times (σ ≈ 1.4 cells ≈ 6 comp px). Strong enough that
 * 1-px bevel lines, whose antialiasing differs between render scales, pool into one stable peak.
 */
function smooth(src: Float32Array, w: number, h: number): Float32Array {
  const a = src.slice();
  const b = new Float32Array(w * h);
  for (let pass = 0; pass < 4; pass++) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        b[i] = 0.25 * a[x > 0 ? i - 1 : i] + 0.5 * a[i] + 0.25 * a[x < w - 1 ? i + 1 : i];
      }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        a[i] = 0.25 * b[y > 0 ? i - w : i] + 0.5 * b[i] + 0.25 * b[y < h - 1 ? i + w : i];
      }
  }
  return a;
}

/** Mean of `v` over the (2r+1)² box around every cell (clamped at the edges), via an integral image. */
function boxMean(v: Float32Array, w: number, h: number, r: number): Float32Array {
  const W = w + 1;
  const sat = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += v[y * w + x];
      sat[(y + 1) * W + x + 1] = sat[y * W + x + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const s = sat[y1 * W + x1] - sat[y0 * W + x1] - sat[y1 * W + x0] + sat[y0 * W + x0];
      out[y * w + x] = s / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/** Sub-cell offset (−0.5…0.5) of a parabola's vertex through three samples. */
function vertex(l: number, c: number, r: number): number {
  const d = l - 2 * c + r;
  return d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / d)) : 0;
}

/** Ink bounding box in comp px about the comp centre (y-up). */
interface InkBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Box of the on-shape cells (mean alpha ≥ 0.5) of a grid, or null when the layer is empty. */
function gridBox(g: Grid): InkBox | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++)
      if (g.alpha[y * g.w + x] >= 0.5) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x + 1);
        y1 = Math.max(y1, y + 1);
      }
  if (x0 > x1) return null;
  const c = g.cellComp;
  return { x0: g.x0 + x0 * c, y0: g.y0 + y0 * c, x1: g.x0 + x1 * c, y1: g.y0 + y1 * c };
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Cells per side of a regionalMax() block (8 × 4 = 32 comp px). */
const REG_BLOCK = 8;
/** Blocks each way a regionalMax() window reaches (4 × 32 = 128 comp px). */
const REG_REACH = 4;

/**
 * Brightest on-shape luminance within ~128 comp px of each cell, as a lookup (x, y) → max.
 * Normalising a peak by it instead of by the global maximum lets every part of a title compete
 * for glints: a dimmer second line still gets its own brightest spots.
 */
function regionalMax(lum: Float32Array, alpha: Float32Array, w: number, h: number): (x: number, y: number) => number {
  const bw = Math.ceil(w / REG_BLOCK);
  const bh = Math.ceil(h / REG_BLOCK);
  const block = new Float32Array(bw * bh);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (alpha[i] < 0.5) continue;
      const b = Math.floor(y / REG_BLOCK) * bw + Math.floor(x / REG_BLOCK);
      block[b] = Math.max(block[b], lum[i]);
    }
  const out = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      let m = 0;
      for (let y = Math.max(0, by - REG_REACH); y <= Math.min(bh - 1, by + REG_REACH); y++)
        for (let x = Math.max(0, bx - REG_REACH); x <= Math.min(bw - 1, bx + REG_REACH); x++) m = Math.max(m, block[y * bw + x]);
      out[by * bw + bx] = m;
    }
  return (x, y) => Math.max(1e-6, out[Math.floor(y / REG_BLOCK) * bw + Math.floor(x / REG_BLOCK)]);
}

/**
 * Highlight peaks, strongest first: local maxima of the smoothed luminance on the shape (mean
 * alpha ≥ 0.5), found by non-maximum suppression over the 8 neighbours (ties go to the first
 * cell, so a flat plateau yields one peak) and positioned at the sub-cell vertex. A bright ridge
 * such as a plate's top edge then gives a few separate peaks instead of a run of candidates the
 * spacing would string into a row.
 *
 * Score = prominence over the surrounding 24 px plus a share of absolute brightness, so hot
 * specular spots (bevel highlights, corners, stroke ends) win over flat bright fills; times an
 * alpha-depth weight: `faceBias` (0..1) damps peaks close to the silhouette edge (outer rims and
 * plates) against peaks deeper inside the face. Depth is the chamfer distance to the nearest
 * off-shape cell, relative to the deepest cell. `threshold` (0..1) drops cells dimmer than that
 * fraction of the brightest. `ridge` (0..1) damps peaks on bright ridges (lit edges running
 * along a stroke or plate) against spot and corner peaks, which is what turns a lit edge into a
 * row of evenly spaced stars. `regional` (0..1) blends the score's normaliser from the global
 * brightest toward the brightest within ~128 px (regionalMax). `site` as for readGrid.
 */
function findHighlights(
  ctx: PassContext,
  input: THREE.Texture,
  site: string,
  threshold: number,
  { faceBias = 0, ridge = 0, regional = 0 }: { faceBias?: number; ridge?: number; regional?: number } = {},
): { hl: Highlight[]; box: InkBox | null } {
  const g = readGrid(ctx, input, HL_CELL, site);
  const { w, h, alpha } = g;
  const box = gridBox(g);
  if (!box) return { hl: [], box };
  const lum = smooth(g.lum, w, h);
  const bg = boxMean(lum, w, h, HL_BG);
  // Distance of on-shape cells to the nearest off-shape cell = gridDistance of the inverted mask.
  const depth = faceBias > 0 ? gridDistance({ ...g, alpha: alpha.map((a) => (a >= 0.5 ? 0 : 1)) }) : null;
  let maxL = 0;
  let maxD = 0;
  for (let i = 0; i < w * h; i++)
    if (alpha[i] >= 0.5) {
      maxL = Math.max(maxL, lum[i]);
      if (depth) maxD = Math.max(maxD, depth[i]);
    }
  if (maxL <= 0) return { hl: [], box };
  const reg = regional > 0 ? regionalMax(lum, alpha, w, h) : null;
  // Reference brightness of a cell: the global maximum, blended toward the regional one.
  const ref = (x: number, y: number) => (reg ? (1 - regional) * maxL + regional * reg(x, y) : maxL);
  const out: Highlight[] = [];
  const R = 2; // Hessian step, cells (8 comp px)
  for (let y = R; y < h - R; y++)
    for (let x = R; x < w - R; x++) {
      const i = y * w + x;
      const c = lum[i];
      if (alpha[i] < 0.5) continue;
      const cRef = ref(x, y);
      if (c < cRef * threshold) continue;
      // Strict against neighbours before this cell in scan order, ≥ against those after it.
      if (lum[i - w - 1] >= c || lum[i - w] >= c || lum[i - w + 1] >= c || lum[i - 1] >= c) continue;
      if (lum[i + 1] > c || lum[i + w - 1] > c || lum[i + w] > c || lum[i + w + 1] > c) continue;
      const fx = vertex(lum[i - 1], c, lum[i + 1]);
      const fy = vertex(lum[i - w], c, lum[i + w]);
      const wDepth = depth && maxD > 0 ? 1 - faceBias * (1 - smoothstep(0.1, 0.5, depth[i] / maxD)) : 1;
      let wRidge = 1;
      if (ridge > 0) {
        // Hessian eigenvalues: a spot or corner curves down both ways, a ridge (a lit edge
        // running along a stroke or plate) only across itself. Ridge peaks lose up to `ridge`.
        const lxx = lum[i - R] - 2 * c + lum[i + R];
        const lyy = lum[i - R * w] - 2 * c + lum[i + R * w];
        const lxy = 0.25 * (lum[i + R * w + R] - lum[i + R * w - R] - lum[i - R * w + R] + lum[i - R * w - R]);
        const m = 0.5 * (lxx + lyy);
        const q = Math.sqrt(0.25 * (lxx - lyy) ** 2 + lxy * lxy);
        const strong = Math.min(0, m - q);
        const weak = Math.min(0, m + q);
        const iso = strong < 0 ? weak / strong : 0;
        wRidge = 1 - ridge * (1 - Math.sqrt(iso));
      }
      const cx = x + g.x0 / HL_CELL;
      const cy = y + g.y0 / HL_CELL;
      out.push({
        x: (cx + 0.5 + fx) * HL_CELL,
        y: (cy + 0.5 + fy) * HL_CELL,
        score: ((c - bg[i] + 0.15 * c) / cRef) * wDepth * wRidge,
        key: cx * 7919 + cy,
      });
    }
  // Index order breaks score ties, so the ranking is fully deterministic.
  return { hl: out.sort((a, b) => b.score - a.score || a.key - b.key), box };
}

/**
 * Score margin (fraction of the top score) over which the last picks fade in and near-tied
 * peaks share a star's position; see pickHighlights.
 */
const HL_FADE = 0.015;
/**
 * How near (fraction of the star's radius) a suppressed near-tied peak must be to share the
 * star's position: under its hot core, so the blend stays on the highlight. Ties farther along
 * a lit edge would drag the star off it, and their weights flicker between export scales.
 */
const HL_TIE_REACH = 0.25;

interface Pick {
  /** The star's peak; for a star placed between near-tied peaks, its position is theirs blended. */
  h: Highlight;
  /** Radius, comp px. */
  r: number;
  /** 0..1 fade-in against the runner-up. */
  fade: number;
}

/**
 * Greedy pick of up to `count` highlights, strongest first, keeping stars apart by at least
 * `minDist` comp px and `spacing` × the sum of their radii (`radius(h)`, comp px), also from the
 * stars already `taken`. Near ties are smoothed both ways, as tiny luminance differences
 * between export scales reorder them:
 * - a star sits at the score-weighted centre of its peak and the peaks it suppresses that score
 *   within HL_FADE of it and lie within HL_TIE_REACH of its radius (weight: how far inside that
 *   margin), so when two such peaks along a lit edge swap order between export scales the star
 *   slides between them instead of jumping from one to the other;
 * - the pick that would come next is the runner-up: each star's `fade` (0..1) ramps in over
 *   HL_FADE of score above it, so two near-tied peaks that swap across the cut-off are both
 *   nearly invisible, instead of one popping in for the other.
 */
function pickHighlights(
  hl: Highlight[],
  count: number,
  radius: (h: Highlight) => number,
  spacing: number,
  minDist = 0,
  taken: readonly Pick[] = [],
): Pick[] {
  if (count <= 0) return [];
  const margin = HL_FADE * (hl[0]?.score ?? 1);
  const out: { h: Highlight; r: number }[] = [];
  const merged = new Set<Highlight>();
  const clash = (o: { h: Highlight; r: number }, h: Highlight, r: number) =>
    (o.h.x - h.x) ** 2 + (o.h.y - h.y) ** 2 < Math.max(minDist, spacing * (o.r + r)) ** 2;
  for (let i = 0; i < hl.length && out.length <= count; i++) {
    const h = hl[i];
    if (merged.has(h)) continue;
    const r = radius(h);
    if (taken.some((o) => o.h === h || clash(o, h, r)) || out.some((o) => clash(o, h, r))) continue;
    // Near-tied peaks it suppresses within HL_TIE_REACH of its radius pull the star toward them.
    let sw = margin;
    let sx = h.x * margin;
    let sy = h.y * margin;
    for (let j = i + 1; j < hl.length && h.score - hl[j].score < margin; j++) {
      const t = hl[j];
      if (merged.has(t) || (t.x - h.x) ** 2 + (t.y - h.y) ** 2 > (HL_TIE_REACH * r) ** 2 || !clash({ h, r }, t, radius(t))) continue;
      const w = margin - (h.score - t.score);
      sw += w;
      sx += t.x * w;
      sy += t.y * w;
      merged.add(t);
    }
    out.push({ h: sw > margin ? { ...h, x: sx / sw, y: sy / sw } : h, r });
  }
  const runnerUp = out.length > count ? out.pop()!.h.score : -Infinity;
  return out.map((o) => ({ ...o, fade: Math.min(1, (o.h.score - runnerUp) / margin) }));
}

/**
 * Size factor (0..1] of a highlight star from its score relative to the strongest (`top`): the
 * hottest few stay large and weaker ones shrink fast, as practitioners dress a title (a few big
 * glints, more small ones). Continuous in the score, not the rank, so two near-tied peaks that
 * swap order between export scales still get near-equal sizes. `variation` 0..1 scales the spread.
 */
function highlightSize(score: number, top: number, variation: number): number {
  const t = Math.min(1, Math.max(0, (top - score) / (0.3 * top)));
  return 1 - variation * t;
}

/**
 * Smooth pseudo-random 0..1 of a comp-px position (channel `k`). Peaks tens of px apart get
 * unrelated values, but the sub-pixel drift of one peak between export scales barely changes its
 * value, unlike a hash of the analysis cell, which a peak can cross between scales.
 */
function wobble(x: number, y: number, seed: number, k: number): number {
  const s = seed * 1.618 + k * 2.399;
  return 0.5 + 0.25 * Math.sin(x * 0.061 + y * 0.037 + s) + 0.25 * Math.sin(y * 0.079 - x * 0.043 + 1.7 * s);
}

// ---------- sparkle and hero constants ----------

/** Small glints' radius, fraction of the sparkle size. */
const SMALL_SPARKLE = 0.34;
/** Hero glint's small companion stars' radius, fraction of the sparkle size. */
const HERO_STAR = 0.45;
/** How much sparkles avoid peaks on lit edges (ridges) in favour of spots and corners; see findHighlights. */
const SPARKLE_RIDGE = 0.7;
/** How far sparkle peaks are judged against their own part of the title, not the whole; see findHighlights. */
const SPARKLE_REGIONAL = 0.7;

const heroFrag = /* glsl */ `
uniform sampler2D tLight; uniform vec2 uPos; uniform float uT, uLen, uCross, uRot, uGain, uHero; uniform vec3 uCol;
${ANAMORPHIC_GLSL}
// Thin line tapering to nothing at ±len along x: carries the streak across the whole span, where
// the lens-flare streak alone (exponential falloff) would have faded out by mid-length.
vec3 taper(vec2 lv, float t, float len) {
  float f = max(1.0 - abs(lv.x) / max(len, 1.0), 0.0);
  float ay = abs(lv.y) / t;
  return mix(uCol, vec3(1.0), f * f) * (exp(-ay * 30.0) * 1.3 + exp(-ay * 6.0) * 0.2) * pow(f, 1.1);
}
void main() {
  vec2 v = gl_FragCoord.xy - uPos;
  float c = cos(uRot), sn = sin(uRot);
  vec2 lv = vec2(c * v.x + sn * v.y, -sn * v.x + c * v.y);
  float r = length(v) / (uT * 0.6);
  vec3 L = vec3(1.0) * (exp(-r * r * 18.0) * 2.0 + 0.2 / (1.0 + r * r * 6.0)) + uCol * 0.3 / (1.0 + r * r * 1.5);
  L += anamorphicStreak(lv, uT, uLen / 2.5, uCol) + taper(lv, uT, uLen);
  L += anamorphicStreak(lv.yx, uT * 0.8, uCross / 2.5, uCol) + taper(lv.yx, uT * 0.8, uCross);
  o = lightPremul((L * uHero + texture(tLight, vUv).rgb) * uGain);
}`;

/** Hero glint: the long anamorphic cross centred at `pos` (render px) plus the star sprites in `stars`. */
function renderHero(
  ctx: PassContext,
  target: THREE.WebGLRenderTarget,
  hero: { x: number; y: number; t: number; len: number; cross: number; rot: number; intensity: number; color: THREE.Color },
  stars: Star[],
  look: StarLook,
  gain: number,
) {
  const { kit } = ctx;
  const tmp = kit.acquire();
  drawStars(ctx, stars, look, tmp);
  const m = material(kit, 'gen-glints-hero', {
    uniforms: {
      tLight: { value: null },
      uPos: { value: new THREE.Vector2() },
      uT: { value: 10 },
      uLen: { value: 100 },
      uCross: { value: 20 },
      uRot: { value: 0 },
      uGain: { value: 1 },
      uHero: { value: 1 },
      uCol: { value: new THREE.Color() },
    },
    fragmentShader: HEAD + heroFrag,
  });
  common(m, ctx);
  const u = m.uniforms;
  u.tLight.value = tmp.texture;
  u.uPos.value.set(hero.x, hero.y);
  u.uT.value = Math.max(0.5, hero.t);
  u.uLen.value = hero.len;
  u.uCross.value = hero.cross;
  u.uRot.value = hero.rot;
  u.uGain.value = gain;
  u.uHero.value = hero.intensity;
  u.uCol.value.copy(hero.color);
  kit.run(m, target);
  kit.release(tmp);
}

// ---------- the generator ----------

const ON_HL = { key: 'placement', value: 'highlights' };
const ON_HERO = { key: 'placement', value: 'hero' };
const ON_PEAKS = { key: 'placement', value: 'peaks' };
const ON_SCATTER = { key: 'placement', value: 'scatter' };
const ON_POINT = { key: 'placement', value: 'point' };
const ON_HL_HERO = { key: 'placement', value: ['highlights', 'hero'] };

/** One star at the generator's (x, y) (placement Fixed point), render px of `ctx`. */
function pointStar(ctx: PassContext, p: EffectParams): Star {
  const k = ctx.pxScale;
  return { x: N(p, 'x') * k + centreX(ctx.frame), y: N(p, 'y') * k + centreY(ctx.frame), size: N(p, 'size') * k, rot: N(p, 'rotation') * DEG, intensity: 1, color: C(p, 'color') };
}

/** Big flare stars on the hottest peaks of `shape` (placement Hottest peaks). */
function peakStars(ctx: PassContext, shape: THREE.Texture, p: EffectParams): Star[] {
  const size = N(p, 'size'); // comp px
  const color = C(p, 'color');
  const rot = N(p, 'rotation') * DEG;
  const vr = N(p, 'sizeVariation') / 100;
  const k = ctx.pxScale;
  const { hl } = findHighlights(ctx, shape, 'glints-peaks', N(p, 'threshold') / 100);
  const top = hl[0]?.score ?? 1;
  return pickHighlights(hl, Math.round(N(p, 'stars')), (h) => size * highlightSize(h.score, top, vr), 0.45).map(({ h, r, fade }) => ({
    x: h.x * k + centreX(ctx.frame),
    y: h.y * k + centreY(ctx.frame),
    size: r * k * (0.6 + 0.4 * fade),
    rot,
    intensity: (0.4 + 0.6 * (r / size)) * fade,
    color,
  }));
}

/** Highlight glints or the hero glint on the peaks of `shape` (the followed layer as styled), into `target`. */
function renderPeaks(ctx: PassContext, target: THREE.WebGLRenderTarget, shape: THREE.Texture, p: EffectParams) {
  const seed = N(p, 'seed');
  const size = N(p, 'size'); // comp px
  const sv = N(p, 'sizeVariation') / 100;
  const bv = N(p, 'brightnessVariation') / 100;
  const color = C(p, 'color');
  const rot0 = N(p, 'rotation') * DEG;
  const k = ctx.pxScale;
  const look = starLook(p);
  const gain = N(p, 'intensity') / 100;
  const stars: Star[] = [];
  const { hl, box } = findHighlights(ctx, shape, 'glints', N(p, 'threshold') / 100, {
    faceBias: N(p, 'faceBias') / 100,
    ridge: SPARKLE_RIDGE,
    regional: SPARKLE_REGIONAL,
  });
  if (!box || hl.length === 0) {
    ctx.kit.clear(target);
    return;
  }
  const minD = N(p, 'spacing');
  const jit = N(p, 'jitter') / 100;
  // A little size (±20%) and rotation (±12°) jitter at full Jitter, a smooth function of the peak position.
  const star = ({ h, r, fade }: Pick, intensity: number): Star => ({
    x: h.x * k + centreX(ctx.frame),
    y: h.y * k + centreY(ctx.frame),
    size: r * k * (0.6 + 0.4 * fade) * (1 + 0.4 * jit * (wobble(h.x, h.y, seed, 0) - 0.5)),
    rot: rot0 + 0.42 * jit * (wobble(h.x, h.y, seed, 1) - 0.5),
    intensity: intensity * fade,
    color,
  });
  if (S(p, 'placement') === 'highlights') {
    const top = hl[0].score;
    const nLarge = Math.round(N(p, 'large'));
    // Large glints also keep a share of the title's size apart, so they dress the whole
    // title instead of crowding its single brightest letter.
    const spanD = (0.7 * Math.hypot(box.x1 - box.x0, box.y1 - box.y0)) / Math.max(1, nLarge);
    // Large glints stay large: the score shrinks them by at most half the size variation.
    const large = pickHighlights(hl, nLarge, (h) => size * highlightSize(h.score, top, 0.5 * sv), 0.6, Math.max(minD, spanD));
    const small = pickHighlights(hl, Math.round(N(p, 'small')), () => size * SMALL_SPARKLE, 0.6, minD * 0.5, large);
    // Big glints read brightest; Brightness variation dims the smaller ones.
    for (const pk of large) stars.push(star(pk, 1 - bv * (1 - pk.r / size)));
    for (const pk of small) stars.push(star(pk, 1 - bv * 0.6));
    renderStars(ctx, target, stars, look, gain);
    return;
  }
  // Hero: the streak may pass the ink box by at most 10% of its width per side, so the core
  // sits on the strongest peak inside the central band where the streak fits (blended with
  // near-tied ones beside it, see pickHighlights).
  const W = box.x1 - box.x0;
  const half = (W * N(p, 'heroWidth')) / 200;
  const band = W * Math.max(0.1, 0.6 - half / W);
  const cx = 0.5 * (box.x0 + box.x1);
  const inBand = hl.filter((h) => Math.abs(h.x - cx) <= band);
  const h0 = pickHighlights(inBand.length ? inBand : hl, 1, () => size, 0.6, minD)[0].h;
  const heroPick: Pick = { h: h0, r: size, fade: 1 };
  for (const pk of pickHighlights(hl, Math.round(N(p, 'heroStars')), () => size * HERO_STAR, 0.6, minD, [heroPick])) stars.push(star(pk, 1 - bv * 0.4));
  const t = size * (N(p, 'heroThickness') / 100) * k;
  renderHero(
    ctx,
    target,
    {
      x: h0.x * k + centreX(ctx.frame),
      y: h0.y * k + centreY(ctx.frame),
      t,
      len: half * k,
      cross: half * (N(p, 'heroCross') / 100) * k,
      rot: N(p, 'heroAngle') * DEG,
      intensity: 1,
      color,
    },
    stars,
    look,
    gain,
  );
}

/** Stars scattered over and around the silhouette of `content` (the followed layer's own pixels). */
function scatterStars(ctx: PassContext, content: THREE.Texture, p: EffectParams): Star[] {
  const seed = N(p, 'seed');
  const size = N(p, 'size');
  const sv = N(p, 'sizeVariation') / 100;
  const bv = N(p, 'brightnessVariation') / 100;
  const color = C(p, 'color');
  const rot0 = N(p, 'rotation') * DEG;
  const k = ctx.pxScale;
  const count = Math.round(N(p, 'count'));
  const g = readGrid(ctx, content, 8, 'glints-scatter');
  const box = gridBox(g);
  if (!box) return [];
  const dist = gridDistance(g);
  const cellPx = g.cellComp;
  const spread = N(p, 'spread');
  const inside = B(p, 'inside');
  const bx0 = box.x0 - spread;
  const by0 = box.y0 - spread;
  const bw = box.x1 - box.x0 + 2 * spread;
  const bh = box.y1 - box.y0 + 2 * spread;
  const r = rng(seed * 131 + 7);
  const stars: Star[] = [];
  for (let tries = 0; stars.length < count && tries < count * 80; tries++) {
    const cx = bx0 + r() * bw;
    const cy = by0 + r() * bh;
    const gx = Math.floor((cx - g.x0) / cellPx);
    const gy = Math.floor((cy - g.y0) / cellPx);
    const d = gx >= 0 && gy >= 0 && gx < g.w && gy < g.h ? dist[gy * g.w + gx] * cellPx : Infinity;
    if (d > spread || (!inside && d === 0)) continue;
    // Keyed by the try, not the placed index: a borderline cell flipping between render
    // scales then changes only that one star instead of re-rolling all that follow.
    stars.push({
      x: cx * k + centreX(ctx.frame),
      y: cy * k + centreY(ctx.frame),
      size: size * k * (1 - sv + sv * hash(seed, tries, 3)),
      rot: rot0 + (hash(seed, tries, 1) - 0.5) * 0.4,
      intensity: 1 - bv * hash(seed, tries, 2),
      color,
    });
  }
  return stars;
}

export const glints: GeneratorDef = {
  type: 'glints',
  label: 'Glints',
  category: 'Light',
  description:
    'Star sparkles on a layer: on its highlight peaks (a few large glints plus small ones, favouring the face over the outer rims), ' +
    'big flare stars on its hottest peaks, one long anamorphic hero glint across it, scattered over and around its shape, ' +
    'or one star at a fixed point; 4-ray, 6-ray snow-cross or 8-ray shapes, optionally with rainbow (spectral) rays.',
  follow: 'required',
  params: [
    followParam('Layer'),
    sel('placement', 'Placement', 'highlights', [
      ['highlights', 'On highlights'],
      ['peaks', 'Hottest peaks'],
      ['hero', 'Hero glint'],
      ['scatter', 'Scatter around shape'],
      ['point', 'Fixed point'],
    ]),
    { ...num('large', 'Large glints', 5, 0, 20, undefined, 1), when: ON_HL },
    { ...num('small', 'Small glints', 6, 0, 40, undefined, 1), when: ON_HL },
    { ...num('stars', 'Star count', 5, 1, 40, undefined, 1), when: ON_PEAKS },
    { ...num('count', 'Count', 40, 1, 400, undefined, 1), when: ON_SCATTER },
    { ...num('heroWidth', 'Hero streak width', 80, 20, 150, '%'), when: ON_HERO },
    { ...num('heroThickness', 'Hero thickness', 100, 20, 400, '%'), when: ON_HERO },
    { ...num('heroCross', 'Vertical spike', 22, 0, 100, '%'), when: ON_HERO },
    { ...num('heroAngle', 'Streak angle', 0, -90, 90, 'deg'), when: ON_HERO },
    { ...num('heroStars', 'Small stars', 3, 0, 8, undefined, 1), when: ON_HERO },
    { ...num('x', 'Position X', 0, -4000, 4000, 'px'), when: ON_POINT },
    { ...num('y', 'Position Y', 0, -4000, 4000, 'px'), when: ON_POINT },
    num('size', 'Star size', 50, 2, 800, 'px'),
    { ...num('sizeVariation', 'Size variation', 60, 0, 100, '%'), when: { key: 'placement', value: ['highlights', 'peaks', 'scatter'] } },
    { ...num('threshold', 'Highlight thresh.', 30, 0, 100, '%'), when: { key: 'placement', value: ['highlights', 'peaks', 'hero'] } },
    { ...num('spacing', 'Min. spacing', 80, 0, 600, 'px'), when: ON_HL_HERO },
    { ...num('faceBias', 'Face priority', 70, 0, 100, '%'), when: ON_HL_HERO },
    { ...num('jitter', 'Size / angle jitter', 50, 0, 100, '%'), when: ON_HL_HERO },
    { ...num('spread', 'Scatter area', 60, 0, 600, 'px'), when: ON_SCATTER },
    { ...bool('inside', 'Scatter over shape', true), when: ON_SCATTER },
    sel('rays', 'Shape', '4', RAYS),
    bool('spectral', 'Rainbow rays', false),
    num('thickness', 'Ray thickness', 100, 20, 400, '%'),
    col('color', 'Colour', '#fff4c0'),
    num('intensity', 'Intensity', 130, 0, 400, '%'),
    num('rotation', 'Rotation', 0, -180, 180, 'deg'),
    { ...num('brightnessVariation', 'Brightness variation', 50, 0, 100, '%'), when: { key: 'placement', value: ['highlights', 'hero', 'scatter'] } },
    { ...num('seed', 'Seed', 1, 0, 999, undefined, 1), when: { key: 'placement', value: ['highlights', 'hero', 'scatter'] } },
  ],
  presets: [
    { id: 'highlights', label: 'Highlight glints', blend: 'add', params: {} },
    { id: 'hero', label: 'Hero glint', blend: 'add', params: { placement: 'hero', size: 52, color: '#fff6dc', intensity: 140 } },
    { id: 'stars', label: 'Star glints', blend: 'add', params: { placement: 'peaks', stars: 4, threshold: 80, size: 90, sizeVariation: 50, rays: '8', color: '#ffffff', intensity: 140 } },
    { id: 'rainbow', label: 'Rainbow glints', blend: 'add', params: { large: 4, small: 6, size: 64, threshold: 40, spectral: true, color: '#ffffff', intensity: 140 } },
    { id: 'scatter', label: 'Scattered sparkles', blend: 'add', params: { placement: 'scatter', count: 10, size: 26, spread: 10, color: '#e8fbff', intensity: 110, seed: 3 } },
  ],
  handles: [{ x: 'x', y: 'y', label: 'Star', when: { key: 'placement', value: 'point' } }],
  bounds: () => ({ x0: 0, y0: 0, x1: 0, y1: 0 }),
  // Peaks: jitter grows a glint by up to 20 % (see renderPeaks). Hero: the streak spans a share of
  // the ink box's width, past it by 10-35 % of it; only the core and stars count here.
  followReach: (p) => {
    const pl = S(p, 'placement');
    if (pl === 'scatter') return N(p, 'spread') + N(p, 'size');
    if (pl === 'peaks' || pl === 'point') return N(p, 'size');
    return N(p, 'size') * (1 + (0.2 * N(p, 'jitter')) / 100);
  },
  render(ctx, target, p) {
    const id = followed(p);
    const placement = S(p, 'placement');
    drawFollowed(ctx, target, (out) => {
      if (placement === 'point') {
        renderStars(ctx, out, id ? [pointStar(ctx, p)] : [], starLook(p), N(p, 'intensity') / 100);
        return;
      }
      if (placement === 'scatter') {
        const content = id ? ctx.layerContent(id) : null;
        renderStars(ctx, out, content ? scatterStars(ctx, content, p) : [], starLook(p), N(p, 'intensity') / 100);
        return;
      }
      const shape = id ? ctx.layerAlpha(id) : null;
      if (!shape) ctx.kit.clear(out);
      else if (placement === 'peaks') renderStars(ctx, out, peakStars(ctx, shape, p), starLook(p), N(p, 'intensity') / 100);
      else renderPeaks(ctx, out, shape, p);
    });
  },
};
