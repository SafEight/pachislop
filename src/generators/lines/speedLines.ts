import * as THREE from 'three';
import type { EffectParams, GeneratorContext, GeneratorDef, ParamDef } from '../../engine/contracts';
import { C, col, DEG, G, grad, type Grid, HEAD, material, N, num, readGrid, S, sel } from '../../effects/b/common';
import type { EffectInstance, Gradient } from '../../model/types';
import { clearTarget, compToRender, drawInstancedQuads, LAYER_FRAG, type LayerUniforms, layerUniforms, lightGlow, presetEffect, rng, setLayerUniforms } from '../common';
import { clamp, framePolygon, gradientLinear, insideConvex, pxPerLayer, rayExit, TAPER_GLSL, taperFractions, when } from './shared';

// 集中線 / 流線 / フラッシュ / ベタフラ (CLIP STUDIO / AMIX 集中線メーカー vocabulary).
//
// Every line is a tapered wedge anchored at the focus boundary (a clean hole: the ellipse, the
// rectangle or another layer's silhouette, plus base jitter and jagged teeth) and running away
// from it. Focus lines run out to the frame edge, flash spikes a fraction of the focus radius,
// flow lines are parallel and run from the focus to the frame edge on either side. Lines are
// instanced quads (one per segment when curved) whose fragment shader measures the distance to
// the wedge's edges in render pixels: crisp analytic anti-aliasing at any export scale, sub-pixel
// hairlines fading by their true width. ベタフラ fills the frame outside the burst instead, the
// spikes and the focus cut out of the fill (a dot fade toward the burst is a Halftone Dissolve on
// the layer, `halftoneFade`; a coloured burst is a layer below).

const MAX_LINES = 600;
/** Samples of the focus boundary around the centre (radial) or across the frame (flow). */
const TAB = 1024;
/** Readback cell for a layer-alpha focus, comp px. */
const CELL = 6;

const RAINBOW: Gradient = {
  stops: [
    { pos: 0, color: '#ff2a2a' },
    { pos: 0.17, color: '#ffb000' },
    { pos: 0.33, color: '#f4ff3a' },
    { pos: 0.5, color: '#2aff6a' },
    { pos: 0.67, color: '#2ad4ff' },
    { pos: 0.83, color: '#8a4bff' },
    { pos: 1, color: '#ff2a2a' },
  ],
};

const FOCUS_SHAPE = { key: 'shape', value: 'layer' };
const GRADIENT_FILL = { key: 'colorMode', value: ['length', 'around'] };

const params: ParamDef[] = [
  sel('type', 'Type', 'focus', [
    ['focus', 'Focus lines (集中線)'],
    ['flow', 'Flow lines (流線)'],
    ['flash', 'Flash (フラッシュ)'],
    ['beta', 'Beta flash (ベタフラ)'],
  ]),
  // With a layer focus these offset the convergence point from the centre of that layer's box.
  num('x', 'Centre X (offset with a layer focus)', 0, -4000, 4000, 'px'),
  num('y', 'Centre Y (offset with a layer focus)', 0, -4000, 4000, 'px'),
  sel('shape', 'Focus shape', 'ellipse', [
    ['ellipse', 'Ellipse'],
    ['rect', 'Rectangle'],
    ['layer', 'Layer alpha'],
  ]),
  { key: 'layer', label: 'Focus layer', kind: 'layer', default: '', when: FOCUS_SHAPE },
  when(num('padding', 'Padding', 40, 0, 1000, 'px'), 'shape', 'layer'),
  // A layer focus without a (visible) layer falls back to this ellipse.
  when(num('rx', 'Focus radius X', 420, 0, 4000, 'px'), 'shape', ['ellipse', 'rect']),
  when(num('ry', 'Focus radius Y', 260, 0, 4000, 'px'), 'shape', ['ellipse', 'rect']),
  when(num('angle', 'Flow angle', 0, -180, 180, 'deg'), 'type', 'flow'),
  when(
    sel('side', 'Flow side', 'both', [
      ['both', 'Both sides'],
      ['front', 'Ahead (arrow side)'],
      ['back', 'Behind'],
    ]),
    'type',
    'flow',
  ),
  num('count', 'Line count', 160, 4, MAX_LINES, undefined, 1),
  num('width', 'Width', 10, 0.2, 200, 'px'),
  num('widthRandom', 'Width random', 60, 0, 100, '%'),
  num('length', 'Length', 100, 1, 300, '%'),
  num('lengthRandom', 'Length random', 0, 0, 100, '%'),
  num('jitter', 'Base jitter', 60, 0, 1000, 'px'),
  num('jagCount', 'Jagged teeth', 0, 0, 64, undefined, 1),
  num('jagHeight', 'Jag height', 40, 0, 1000, 'px'),
  num('clump', 'Clumping', 1, 1, 20, undefined, 1),
  num('gap', 'Gap', 0, 0, 10, undefined, 0.1),
  num('taperIn', 'Taper (focus end)', 100, 0, 100, '%'),
  num('taperOut', 'Taper (far end)', 0, 0, 100, '%'),
  num('curve', 'Curve', 0, -100, 100, '%'),
  sel('colorMode', 'Fill', 'solid', [
    ['solid', 'Solid'],
    ['length', 'Gradient (base → tip)'],
    ['around', 'Gradient (around)'],
  ]),
  when(col('color', 'Colour', '#ffffff'), 'colorMode', 'solid'),
  { ...grad('gradient', 'Gradient', { stops: [{ pos: 0, color: '#ffffff' }, { pos: 1, color: '#ffc83a' }] }), when: GRADIENT_FILL },
  // Each line's own opacity: overlapping lines build up, unlike the layer opacity.
  num('opacity', 'Opacity', 85, 0, 100, '%'),
  num('seed', 'Seed', 1, 0, 999, undefined, 1),
];

// ---------- focus boundary ----------

/** Distance along a unit ray at which it last leaves the focus area (0 = never inside), marching at most `maxT`. */
type Exit = (ox: number, oy: number, dx: number, dy: number, maxT: number) => number;

function ellipseExit(cx: number, cy: number, rx: number, ry: number): Exit {
  return (ox, oy, dx, dy) => {
    if (rx <= 0 || ry <= 0) return 0;
    const px = ox - cx;
    const py = oy - cy;
    const ix = 1 / (rx * rx);
    const iy = 1 / (ry * ry);
    const a = dx * dx * ix + dy * dy * iy;
    const b = 2 * (px * dx * ix + py * dy * iy);
    const c = px * px * ix + py * py * iy - 1;
    const disc = b * b - 4 * a * c;
    return disc < 0 ? 0 : Math.max(0, (-b + Math.sqrt(disc)) / (2 * a));
  };
}

function rectExit(cx: number, cy: number, rx: number, ry: number): Exit {
  return (ox, oy, dx, dy) => {
    let t0 = -Infinity;
    let t1 = Infinity;
    for (const [p, d, r] of [
      [ox - cx, dx, rx],
      [oy - cy, dy, ry],
    ]) {
      if (Math.abs(d) < 1e-12) {
        if (Math.abs(p) > r) return 0;
        continue;
      }
      const a = (-r - p) / d;
      const b = (r - p) / d;
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
    }
    return t1 >= Math.max(t0, 0) ? t1 : 0;
  };
}

/** The farthest cell of a layer's alpha along the ray (outer silhouette, gaps between glyphs ignored) plus `pad`. */
function gridExit(grid: Grid, m: THREE.Matrix3, k: number, pad: number): Exit {
  const e = m.elements;
  const step = Math.max(0.5, (grid.cell * 0.5) / k);
  return (ox, oy, dx, dy, maxT) => {
    let x = e[0] * ox + e[3] * oy + e[6];
    let y = e[1] * ox + e[4] * oy + e[7];
    const sx = (e[0] * dx + e[3] * dy) * step;
    const sy = (e[1] * dx + e[4] * dy) * step;
    let last = -1;
    for (let t = 0; t <= maxT; t += step, x += sx, y += sy) {
      const gx = Math.floor((x - grid.px0) / grid.cell);
      const gy = Math.floor((y - grid.py0) / grid.cell);
      if (gx >= 0 && gy >= 0 && gx < grid.w && gy < grid.h && grid.alpha[gy * grid.w + gx] >= 0.3) last = t;
    }
    return last < 0 ? 0 : last + step * 0.5 + pad;
  };
}

/**
 * Where the lines converge, layer px. A layer focus centres on that layer's box, the x / y params
 * offsetting it, so picking a title puts 集中線 around it wherever it sits; otherwise x / y.
 */
function focusCentre(ctx: GeneratorContext, p: EffectParams): [number, number] {
  const x = N(p, 'x');
  const y = N(p, 'y');
  const id = S(p, 'layer');
  const b = S(p, 'shape') === 'layer' && ctx.layerAlpha(id) ? ctx.layerBounds(id) : null;
  if (!b) return [x, y];
  const toLayer = ctx.layerToRender.clone().invert().multiply(compToRender(ctx));
  const c = new THREE.Vector2(0.5 * (b.x0 + b.x1), 0.5 * (b.y0 + b.y1)).applyMatrix3(toLayer);
  return [c.x + x, c.y + y];
}

/** The focus shape's exit function around centre (cx, cy); a missing / hidden focus layer falls back to the ellipse. `coarse` = sampled from a grid. */
function focusExit(ctx: GeneratorContext, p: EffectParams, k: number, cx: number, cy: number): { exit: Exit; coarse: boolean } {
  const rx = Math.max(0, N(p, 'rx'));
  const ry = Math.max(0, N(p, 'ry'));
  const shape = S(p, 'shape');
  if (shape === 'layer') {
    const tex = ctx.layerAlpha(S(p, 'layer'));
    if (tex) return { exit: gridExit(readGrid(ctx, tex, CELL, 'speedLines-focus'), ctx.layerToRender, k, Math.max(0, N(p, 'padding'))), coarse: true };
  }
  return { exit: shape === 'rect' ? rectExit(cx, cy, rx, ry) : ellipseExit(cx, cy, rx, ry), coarse: false };
}

/** Running max over ±2 samples: closes the notches a grid silhouette leaves between glyphs. */
function dilate(tab: Float32Array, wrap: boolean) {
  const src = tab.slice();
  const n = src.length;
  for (let i = 0; i < n; i++) {
    let v = src[i];
    for (let j = -2; j <= 2; j++) {
      const q = wrap ? (i + j + n) % n : clamp(i + j, 0, n - 1);
      v = Math.max(v, src[q]);
    }
    tab[i] = v;
  }
}

/** Linear lookup of a table at u 0..1 (wrapping around for radial tables). */
function lookup(tab: Float32Array, u: number, wrap: boolean): number {
  const n = tab.length;
  if (wrap) {
    const x = (((u % 1) + 1) % 1) * n;
    const i = Math.floor(x) % n;
    return tab[i] + (tab[(i + 1) % n] - tab[i]) * (x - Math.floor(x));
  }
  const x = clamp(u * n - 0.5, 0, n - 1);
  const i = Math.min(n - 2, Math.floor(x));
  return tab[i] + (tab[i + 1] - tab[i]) * (x - i);
}

/** Jagged teeth (ギザギザ): 0 at the notches, `height` at the tips, `count` teeth over u 0..1. */
function jag(u: number, count: number, height: number): number {
  if (count <= 0) return 0;
  const f = (((u * count) % 1) + 1) % 1;
  return height * (1 - Math.abs(2 * f - 1));
}

/** Point at arc length `s` along a circular arc from (x, y), heading `h` (radians), curvature `kappa` (px⁻¹). */
function arcPoint(x: number, y: number, h: number, kappa: number, s: number): [number, number] {
  if (Math.abs(kappa * s) < 1e-6) return [x + Math.cos(h) * s, y + Math.sin(h) * s];
  return [x + (Math.sin(h + kappa * s) - Math.sin(h)) / kappa, y + (Math.cos(h) - Math.cos(h + kappa * s)) / kappa];
}

/** Arc length at which the arc (as arcPoint) last leaves the convex `frame` within `maxS`, or −1 if it never is inside. */
function arcExit(frame: [number, number][], x: number, y: number, h: number, kappa: number, maxS: number): number {
  if (Math.abs(kappa) < 1e-9) return rayExit(frame, x, y, Math.cos(h), Math.sin(h));
  const steps = 256;
  const ds = maxS / steps;
  let last = -1;
  let prev = insideConvex(frame, x, y);
  for (let i = 1; i <= steps; i++) {
    const [px, py] = arcPoint(x, y, h, kappa, i * ds);
    const inside = insideConvex(frame, px, py);
    if (prev && !inside) {
      // Refine the crossing between the two samples.
      let a = (i - 1) * ds;
      let b = i * ds;
      for (let j = 0; j < 12; j++) {
        const m = 0.5 * (a + b);
        const [mx, my] = arcPoint(x, y, h, kappa, m);
        if (insideConvex(frame, mx, my)) a = m;
        else b = m;
      }
      last = b;
    }
    prev = inside;
  }
  return last;
}

// ---------- layout ----------

interface Layout {
  quads: number;
  center: Float32Array;
  size: Float32Array;
  rotation: Float32Array;
  color: Float32Array;
  extra: Float32Array;
  /** Radial types: per angle sample (2π·i/TAB) R = focus boundary + teeth, G = frame exit, layer px from the centre. */
  table: Float32Array | null;
  /** The effective focus centre (focusCentre), layer px. */
  cx: number;
  cy: number;
}

function layout(ctx: GeneratorContext, p: EffectParams): Layout {
  const k = pxPerLayer(ctx.layerToRender);
  const frame = framePolygon(ctx);
  const type = S(p, 'type');
  const radial = type !== 'flow';
  const [cx, cy] = focusCentre(ctx, p);
  const { exit, coarse } = focusExit(ctx, p, k, cx, cy);
  const jagN = Math.round(clamp(N(p, 'jagCount'), 0, 64));
  const jagH = Math.max(0, N(p, 'jagHeight'));

  // Focus boundary tables: radial around the centre, or across the frame for flow (per side).
  let table: Float32Array | null = null;
  const tabs: Float32Array[] = [];
  const fa = N(p, 'angle') * DEG;
  const dir = [Math.cos(fa), Math.sin(fa)];
  const perp = [-dir[1], dir[0]];
  let vMin = 0;
  let vMax = 0;
  if (radial) {
    const rf = new Float32Array(TAB);
    const fr = new Float32Array(TAB);
    for (let i = 0; i < TAB; i++) {
      const th = (2 * Math.PI * i) / TAB;
      const dx = Math.cos(th);
      const dy = Math.sin(th);
      fr[i] = Math.max(0, rayExit(frame, cx, cy, dx, dy));
      rf[i] = exit(cx, cy, dx, dy, fr[i]);
    }
    if (coarse) dilate(rf, true);
    tabs.push(rf);
    table = new Float32Array(TAB * 4);
    for (let i = 0; i < TAB; i++) {
      table[i * 4] = rf[i] + jag(i / TAB, jagN, jagH);
      table[i * 4 + 1] = fr[i];
    }
  } else {
    vMin = Infinity;
    vMax = -Infinity;
    for (const [x, y] of frame) {
      const v = (x - cx) * perp[0] + (y - cy) * perp[1];
      vMin = Math.min(vMin, v);
      vMax = Math.max(vMax, v);
    }
    for (const s of [1, -1]) {
      const rf = new Float32Array(TAB);
      for (let i = 0; i < TAB; i++) {
        const v = vMin + ((i + 0.5) / TAB) * (vMax - vMin);
        const ox = cx + perp[0] * v;
        const oy = cy + perp[1] * v;
        rf[i] = exit(ox, oy, s * dir[0], s * dir[1], Math.max(0, rayExit(frame, ox, oy, s * dir[0], s * dir[1])));
      }
      if (coarse) dilate(rf, false);
      tabs.push(rf);
    }
  }

  const n = Math.round(clamp(N(p, 'count'), 1, MAX_LINES));
  const kc = Math.round(clamp(N(p, 'clump'), 1, 20));
  const gap = clamp(N(p, 'gap'), 0, 10);
  const bundles = Math.ceil(n / kc);
  const units = n + bundles * gap;
  const width = Math.max(0, N(p, 'width'));
  const wr = clamp(N(p, 'widthRandom') / 100, 0, 1);
  const len = Math.max(0, N(p, 'length') / 100);
  const lr = clamp(N(p, 'lengthRandom') / 100, 0, 1);
  const jitter = Math.max(0, N(p, 'jitter'));
  // Curvature (layer px⁻¹): ±100% turns a line by 60° over half the frame diagonal, the same for
  // every line so focus lines swirl as one.
  let halfDiag = 0;
  for (const [x, y] of frame) for (const [x2, y2] of frame) halfDiag = Math.max(halfDiag, 0.5 * Math.hypot(x - x2, y - y2));
  const kappa = ((clamp(N(p, 'curve'), -100, 100) / 100) * (Math.PI / 3)) / Math.max(halfDiag, 1);
  const side = S(p, 'side');
  const margin = 1.5 / k; // anti-aliasing room around each quad, layer px
  const over = width + 2 / k; // how far frame-anchored lines run past the frame edge
  const opacity = clamp(N(p, 'opacity') / 100, 0, 1);
  const mode = S(p, 'colorMode');
  const g = G(p, 'gradient');
  const solid = C(p, 'color');

  // Lines: start point, heading, length, half width (negative = no focus end: tapers like the
  // far end on both ends), colour (premultiplied).
  const lines: number[] = [];
  const push = (x: number, y: number, h: number, L: number, hw: number, cu: number) => {
    if (L * k < 0.5) return;
    let c = [solid.r * opacity, solid.g * opacity, solid.b * opacity, opacity];
    if (mode === 'around') {
      const [gr, gg, gb, ga] = gradientLinear(g, cu);
      const a = ga * opacity;
      c = [gr * a, gg * a, gb * a, a];
    }
    lines.push(x, y, h, L, hw, c[0], c[1], c[2], c[3]);
  };
  // A line anchored at the frame edge: from `ax, ay` (its focus end at full length) along the arc
  // to past the frame edge; shorter lengths keep the outer end and give up the focus end, so the
  // frame is always swept to its edges and only the clear centre varies.
  const toFrame = (ax: number, ay: number, h: number, lenK: number, hw: number, cu: number) => {
    const s = arcExit(frame, ax, ay, h, kappa, 4 * halfDiag);
    if (s < 0) return;
    const total = s + over;
    const L = total * len * lenK;
    const [x, y] = arcPoint(ax, ay, h, kappa, total - L);
    push(x, y, h + kappa * (total - L), L, hw, cu);
  };
  const r = rng(N(p, 'seed'));
  const spin = r();
  const bundleLen = Array.from({ length: bundles }, () => r());
  for (let i = 0; i < n; i++) {
    const b = Math.floor(i / kc);
    // Position in its slot (CLIP STUDIO 間隔の乱れ), bundles separated by `gap` empty slots.
    const u = (i + b * gap + 0.5 * gap + 0.15 + 0.7 * r()) / units;
    // Fixed draws per line and side so toggling a side or the type keeps the other lines in place.
    const draws = [r(), r(), r(), r(), r(), r()];
    const lenK = (h: number) => 1 - lr * (kc > 1 ? 0.6 * bundleLen[b] + 0.4 * h : h);
    const [hj, hw, hl] = draws;
    const halfW = 0.5 * width * (1 - wr * hw);
    if (radial) {
      const au = (u + spin) % 1;
      const th = 2 * Math.PI * au;
      const rf = lookup(tabs[0], au, true);
      const rb = rf + jag(au, jagN, jagH) + jitter * hj;
      const ax = cx + Math.cos(th) * rb;
      const ay = cy + Math.sin(th) * rb;
      // Focus lines run to the frame edge; flash spikes a share of the focus radius.
      if (type === 'focus') toFrame(ax, ay, th, lenK(hl), halfW, au);
      else push(ax, ay, th, Math.max(rf, 20) * len * lenK(hl), halfW, au);
      continue;
    }
    const v = vMin + u * (vMax - vMin);
    const ox = cx + perp[0] * v;
    const oy = cy + perp[1] * v;
    const eF = lookup(tabs[0], u, false);
    const eB = lookup(tabs[1], u, false);
    if (side === 'both' && eF <= 0 && eB <= 0) {
      // Past the focus a flow line sweeps the whole frame (it has no focus end for the length
      // random to shorten), placed at random along it when the length is under 100%.
      const h = Math.atan2(dir[1], dir[0]);
      const fb = rayExit(frame, ox, oy, -dir[0], -dir[1]);
      if (fb < 0) continue;
      const sx = ox - dir[0] * (fb + over);
      const sy = oy - dir[1] * (fb + over);
      const s = arcExit(frame, sx, sy, h, kappa, 4 * halfDiag);
      if (s < 0) continue;
      const total = s + over;
      const L = total * Math.min(1, len);
      const off = (total - L) * draws[4];
      const [x, y] = arcPoint(sx, sy, h, kappa, off);
      push(x, y, h + kappa * off, L, -halfW, u);
      continue;
    }
    for (const sd of side === 'front' ? [1] : side === 'back' ? [-1] : [1, -1]) {
      const [sj, sw, sl] = sd > 0 ? draws : draws.slice(3);
      const rb = (sd > 0 ? eF : eB) + jag(u, jagN, jagH) + jitter * sj;
      const dx = sd * dir[0];
      const dy = sd * dir[1];
      toFrame(ox + dx * rb, oy + dy * rb, Math.atan2(dy, dx), lenK(sl), 0.5 * width * (1 - wr * sw), u);
    }
  }

  // Segments: one per 2° of turn (straight lines: one quad).
  const segsOf = (L: number) => clamp(Math.ceil(Math.abs(kappa * L) / (2 * DEG)), 1, 32);
  let count = 0;
  for (let li = 0; li < lines.length; li += 9) count += segsOf(lines[li + 3]);
  const center = new Float32Array(count * 2);
  const size = new Float32Array(count * 2);
  const rotation = new Float32Array(count);
  const color = new Float32Array(count * 4);
  const extra = new Float32Array(count * 4);
  let q = 0;
  for (let li = 0; li < lines.length; li += 9) {
    const [bx, by, h0, L, hw] = lines.slice(li, li + 5);
    const segs = segsOf(L);
    const halfExt = (Math.max(Math.abs(hw) * k, 0.5) + 1) / k;
    for (let j = 0; j < segs; j++) {
      const s0 = j / segs;
      const s1 = (j + 1) / segs;
      let [ax, ay] = arcPoint(bx, by, h0, kappa, L * s0);
      let [ex, ey] = arcPoint(bx, by, h0, kappa, L * s1);
      const dl = Math.hypot(ex - ax, ey - ay) || 1e-6;
      const ux = (ex - ax) / dl;
      const uy = (ey - ay) / dl;
      // Only the line's two ends grow for anti-aliasing: inner joints must not overlap (double alpha).
      const m0 = j === 0 ? margin : 0;
      const m1 = j === segs - 1 ? margin : 0;
      ax -= ux * m0;
      ay -= uy * m0;
      ex += ux * m1;
      ey += uy * m1;
      center[q * 2] = 0.5 * (ax + ex);
      center[q * 2 + 1] = 0.5 * (ay + ey);
      size[q * 2] = dl + m0 + m1;
      size[q * 2 + 1] = 2 * halfExt;
      rotation[q] = Math.atan2(uy, ux);
      color.set(lines.slice(li + 5, li + 9), q * 4);
      extra[q * 4] = s0 - m0 / L;
      extra[q * 4 + 1] = s1 + m1 / L;
      extra[q * 4 + 2] = hw * k;
      extra[q * 4 + 3] = L * k;
      q++;
    }
  }
  return { quads: q, center, size, rotation, color, extra, table, cx, cy };
}

// ---------- shaders ----------

const lineFrag = /* glsl */ `
uniform float uTail, uHead, uOpacity; uniform bool uGrad; uniform sampler2D tGrad;
${TAPER_GLSL}
// vExtra: t at the quad's two ends (0 = base on the focus, 1 = tip), half width and length in render px.
void main() {
  float t = mix(vExtra.x, vExtra.y, 0.5 + 0.5 * vQuad.x);
  // Negative width: a flow line with no focus end, tapering like its far end on both ends.
  float hw = abs(vExtra.z) * taperAt(clamp(t, 0.0, 1.0), vExtra.z < 0.0 ? uHead : uTail, uHead);
  float x = abs(vQuad.y) * 0.5 * vSizePx.y;
  // Sub-pixel widths keep a 1 px footprint and fade by their true width: hairlines, not dashes.
  float cov = clamp(max(hw, 0.5) - x + 0.5, 0.0, 1.0) * min(1.0, 2.0 * hw);
  cov *= clamp(t * vExtra.w + 0.5, 0.0, 1.0) * clamp((1.0 - t) * vExtra.w + 0.5, 0.0, 1.0);
  vec4 c = vColor;
  if (uGrad) {
    vec4 g = texture(tGrad, vec2(clamp(t, 0.0, 1.0), 0.5));
    c = vec4(g.rgb * g.a, g.a) * uOpacity;
  }
  o = c * cov;
}`;

const TABLE_GLSL = /* glsl */ `
uniform sampler2D tTable;
const float TAU = 6.2831853;
// Focus boundary (x) and frame exit (y) at angle th, linear between the ${TAB} samples.
vec2 tableAt(float th) {
  float u = fract(th / TAU) * ${TAB}.0;
  int i0 = int(floor(u)) % ${TAB};
  int i1 = (i0 + 1) % ${TAB};
  return mix(texelFetch(tTable, ivec2(i0, 0), 0).xy, texelFetch(tTable, ivec2(i1, 0), 0).xy, fract(u));
}
`;

// ベタフラ mask: the spikes united with the (toothed) focus hole.
const maskFrag = /* glsl */ `
uniform sampler2D tLines; uniform vec2 uC;
${LAYER_FRAG}
${TABLE_GLSL}
void main() {
  vec2 d = layerPos() - uC;
  float hole = clamp((tableAt(atan(d.y, d.x)).x - length(d)) * layerPxScale() + 0.5, 0.0, 1.0);
  o = vec4(max(texture(tLines, vUv).a, hole));
}`;

const fillFrag = /* glsl */ `
uniform sampler2D tMask, tGrad; uniform vec2 uC; uniform vec3 uCol; uniform int uMode; uniform float uOpacity;
${LAYER_FRAG}
${TABLE_GLSL}
void main() {
  vec2 d = layerPos() - uC;
  float th = atan(d.y, d.x);
  float cov = 1.0 - texture(tMask, vUv).a;
  vec4 c = vec4(uCol, 1.0);
  if (uMode == 1) {
    vec2 tb = tableAt(th);
    c = texture(tGrad, vec2(clamp((length(d) - tb.x) / max(tb.y - tb.x, 1.0), 0.0, 1.0), 0.5));
  } else if (uMode == 2) c = texture(tGrad, vec2(fract(th / TAU), 0.5));
  o = vec4(c.rgb * c.a, c.a) * (cov * uOpacity);
}`;

const tableData = new Float32Array(TAB * 4);
let tableTex: THREE.DataTexture | null = null;

/** The radial table as a TAB×1 float texture (nearest: tableAt() interpolates). */
function uploadTable(data: Float32Array): THREE.DataTexture {
  tableData.set(data);
  if (!tableTex) {
    tableTex = new THREE.DataTexture(tableData, TAB, 1, THREE.RGBAFormat, THREE.FloatType);
    tableTex.minFilter = THREE.NearestFilter;
    tableTex.magFilter = THREE.NearestFilter;
  }
  tableTex.needsUpdate = true;
  return tableTex;
}

// ---------- def ----------

/**
 * Dot fade of the ベタフラ fill toward the burst: a Halftone Dissolve of `cell`-px dots at 45°
 * fading over 4 cells (what the generator's Halftone edge drew).
 */
export const halftoneFade = (cell: number): EffectInstance => presetEffect('halftone', { source: 'alpha', size: cell, angle: 45, fade: 4 * cell });

export const speedLines: GeneratorDef = {
  type: 'speedLines',
  label: 'Speed Lines',
  category: 'Lines',
  description:
    '集中線 / 流線 / フラッシュ / ベタフラ: tapered wedges around a clean focus (ellipse, rectangle or another layer’s silhouette; with a layer the lines converge on it, Centre X / Y offsetting them). ' +
    'Length is a share of the way to the frame edge (focus, flow) or of the focus radius (flash, ベタフラ). Set the layer blend to Add for light-like lines.',
  params,
  presets: [
    { id: 'focus', label: 'Focus lines', params: {} },
    {
      id: 'focusRed',
      label: 'Focus lines (red, additive)',
      blend: 'add',
      params: {
        count: 220,
        width: 14,
        jitter: 90,
        colorMode: 'length',
        gradient: {
          stops: [
            { pos: 0, color: '#fff0a0' },
            { pos: 0.3, color: '#ff7a1a' },
            { pos: 1, color: '#d00c00' },
          ],
        },
        opacity: 100,
      },
      effects: [lightGlow(14)],
    },
    {
      id: 'flowH',
      label: 'Flow lines, horizontal',
      params: { type: 'flow', rx: 380, ry: 150, count: 170, width: 5, widthRandom: 70, lengthRandom: 35, jitter: 160 },
    },
    {
      id: 'flowDiag',
      label: 'Flow lines, diagonal',
      blend: 'add',
      params: {
        type: 'flow',
        angle: 30,
        rx: 340,
        ry: 170,
        count: 150,
        width: 7,
        widthRandom: 70,
        lengthRandom: 40,
        jitter: 140,
        clump: 3,
        gap: 1.5,
        color: '#6ff0ff',
        opacity: 100,
      },
      effects: [lightGlow(10)],
    },
    {
      id: 'flash',
      label: 'Flash',
      blend: 'add',
      params: { type: 'flash', rx: 260, ry: 260, count: 300, width: 3, widthRandom: 50, length: 70, lengthRandom: 60, jitter: 0, taperIn: 15, taperOut: 100, opacity: 100 },
      effects: [lightGlow(10)],
    },
    {
      id: 'beta',
      label: 'Beta flash',
      params: {
        type: 'beta',
        rx: 240,
        ry: 240,
        count: 140,
        width: 12,
        widthRandom: 60,
        length: 120,
        lengthRandom: 70,
        jitter: 0,
        taperIn: 0,
        taperOut: 100,
        color: '#0c0c14',
        opacity: 100,
      },
      effects: [halftoneFade(7)],
    },
    {
      id: 'spiky',
      label: 'Spiky burst',
      blend: 'add',
      params: {
        type: 'flash',
        rx: 180,
        ry: 180,
        count: 90,
        width: 30,
        widthRandom: 60,
        length: 170,
        lengthRandom: 70,
        jitter: 0,
        taperIn: 0,
        taperOut: 100,
        colorMode: 'length',
        gradient: {
          stops: [
            { pos: 0, color: '#fffbe0' },
            { pos: 0.35, color: '#ffc21a' },
            { pos: 1, color: '#ff5a00' },
          ],
        },
        opacity: 100,
      },
      effects: [lightGlow(30)],
    },
    {
      id: 'rainbow',
      label: 'Rainbow tunnel',
      blend: 'add',
      params: { shape: 'rect', rx: 300, ry: 200, count: 420, width: 16, widthRandom: 50, jitter: 50, colorMode: 'around', gradient: RAINBOW, opacity: 100 },
      effects: [lightGlow(10)],
    },
  ],
  // The handle draws at the raw x / y params, so it is only shown where they are the centre: with
  // a layer focus they are an offset from that layer's box centre and are edited in Properties.
  handles: [
    { x: 'x', y: 'y', label: 'Focus centre', when: { key: 'shape', value: 'ellipse' } },
    { x: 'x', y: 'y', label: 'Focus centre', when: { key: 'shape', value: 'rect' } },
  ],
  sizes: [
    { rx: 'rx', ry: 'ry', x: 'x', y: 'y', shape: 'ellipse', label: 'Focus size', when: { key: 'shape', value: 'ellipse' } },
    { rx: 'rx', ry: 'ry', x: 'x', y: 'y', shape: 'box', label: 'Focus size', when: { key: 'shape', value: 'rect' } },
  ],
  directions: [{ angle: 'angle', label: 'Flow direction', convention: 'ccwFromRight', when: { key: 'type', value: 'flow' } }],
  // Flash spikes around an ellipse / rectangle stay within a circle; the rest reach the frame edge.
  bounds(p) {
    if (S(p, 'type') !== 'flash' || S(p, 'shape') === 'layer') return null;
    const rx = Math.max(0, N(p, 'rx'));
    const ry = Math.max(0, N(p, 'ry'));
    const rf = S(p, 'shape') === 'rect' ? Math.hypot(rx, ry) : Math.max(rx, ry);
    const R =
      rf +
      Math.max(0, N(p, 'jagHeight')) * (N(p, 'jagCount') > 0 ? 1 : 0) +
      Math.max(0, N(p, 'jitter')) +
      Math.max(rf, 20) * Math.max(0, N(p, 'length') / 100) +
      Math.max(0, N(p, 'width')) +
      2;
    const x = N(p, 'x');
    const y = N(p, 'y');
    return { x0: x - R, y0: y - R, x1: x + R, y1: y + R };
  },
  render(ctx, target, p) {
    const lay = layout(ctx, p);
    const beta = S(p, 'type') === 'beta';
    const [tail, head] = taperFractions(N(p, 'taperIn'), N(p, 'taperOut'));
    const g = G(p, 'gradient');
    const gradTex = ctx.kit.gradientTexture(g);
    const quads = (dst: THREE.WebGLRenderTarget, mask: boolean) =>
      drawInstancedQuads(ctx, dst, {
        count: lay.quads,
        center: lay.center,
        size: lay.size,
        rotation: lay.rotation,
        color: mask ? new Float32Array(lay.quads * 4).fill(1) : lay.color,
        extra: lay.extra,
        toRender: ctx.layerToRender,
        fragmentShader: lineFrag,
        uniforms: {
          uTail: { value: tail },
          uHead: { value: head },
          uOpacity: { value: clamp(N(p, 'opacity') / 100, 0, 1) },
          uGrad: { value: !mask && S(p, 'colorMode') === 'length' },
          tGrad: { value: gradTex },
        },
        blend: 'normal',
        minPx: 0,
      });

    if (!beta || !lay.table) {
      clearTarget(ctx, target);
      quads(target, false);
      return;
    }

    // ベタフラ: spikes ∪ focus hole → fill outside it.
    const { kit } = ctx;
    const lines = kit.acquire();
    const maskRT = kit.acquire();
    clearTarget(ctx, lines);
    quads(lines, true);
    const table = uploadTable(lay.table);
    const mm = material(kit, 'gen-speedlines-mask', {
      uniforms: { ...layerUniforms(), tLines: { value: null }, tTable: { value: null }, uC: { value: new THREE.Vector2() } },
      fragmentShader: HEAD + maskFrag,
    });
    setLayerUniforms(mm.uniforms as unknown as LayerUniforms, ctx, ctx.layerToRender);
    mm.uniforms.tLines.value = lines.texture;
    mm.uniforms.tTable.value = table;
    mm.uniforms.uC.value.set(lay.cx, lay.cy);
    kit.run(mm, maskRT);
    const fm = material(kit, 'gen-speedlines-fill', {
      uniforms: {
        ...layerUniforms(),
        tMask: { value: null },
        tGrad: { value: null },
        tTable: { value: null },
        uC: { value: new THREE.Vector2() },
        uCol: { value: new THREE.Color() },
        uMode: { value: 0 },
        uOpacity: { value: 1 },
      },
      fragmentShader: HEAD + fillFrag,
    });
    const u = fm.uniforms;
    setLayerUniforms(u as unknown as LayerUniforms, ctx, ctx.layerToRender);
    u.tMask.value = maskRT.texture;
    u.tGrad.value = gradTex;
    u.tTable.value = table;
    u.uC.value.set(lay.cx, lay.cy);
    u.uCol.value.copy(C(p, 'color'));
    u.uMode.value = { solid: 0, length: 1, around: 2 }[S(p, 'colorMode')] ?? 0;
    u.uOpacity.value = clamp(N(p, 'opacity') / 100, 0, 1);
    kit.run(fm, target);
    kit.release(lines);
    kit.release(maskRT);
  },
  dispose() {
    tableTex?.dispose();
    tableTex = null;
  },
};
