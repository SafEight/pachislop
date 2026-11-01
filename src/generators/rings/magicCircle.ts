import * as THREE from 'three';
import type { EffectParams, GeneratorDef, ParamDef } from '../../engine/contracts';
import type { Gradient } from '../../model/types';
import type { Bounds } from '../../text/layout';
import { getFont } from '../../assets/registry';
import { DEG, G, grad, N, num, S, sel } from '../../effects/b/common';
import { NOISE_GLSL } from '../../effects/lib';
import { clearTarget, lightGlow } from '../common';
import { BOX_GLSL, centreParams, drawBox, layerPxScale } from './shared';

// 魔法陣 / HUD rings: a stack of up to six concentric rows (rings, dashes, ticks, text, polygons,
// stars, chevrons, random arcs, a hex-grid band) drawn as anti-aliased distance fields, spun,
// optionally laid on a floor plane (ホログラム台座), coloured by a centre → edge gradient.

const ROW_TYPES = ['ring', 'dashed', 'ticks', 'text', 'polygon', 'star2', 'star3', 'chevrons', 'arcs', 'hex'] as const;
type RowType = (typeof ROW_TYPES)[number];
const MAX_ROWS = 6;

/**
 * Text-ring strings, each with the bundled font it is drawn in. No bundled font has the Runic
 * block (U+16A0), so the rune set uses Greek capitals, which read as runes on a circle.
 */
const GLYPH_SETS: Record<string, { label: string; chars: string; font: string }> = {
  runes: { label: 'Runes ΨΓΔ…', chars: 'ΨΓΔΘΛΞΠΣΦΩ', font: 'zen-old-mincho-black' },
  kuji: { label: 'Kuji 臨兵闘者…', chars: '臨兵闘者皆陣列在前', font: 'zen-old-mincho-black' },
  eto: { label: 'Zodiac 子丑寅卯…', chars: '子丑寅卯辰巳午未申酉戌亥', font: 'zen-old-mincho-black' },
  bagua: { label: 'Trigrams 乾兌離震…', chars: '乾兌離震巽坎艮坤', font: 'zen-old-mincho-black' },
  hud: { label: 'HUD readout SYSTEM…', chars: 'SYSTEM ONLINE // TARGET LOCK 0451-7F3A // ', font: 'zen-kaku-gothic-black' },
};

interface Row {
  type: RowType;
  radius: number; // % of the circle radius
  size: number; // px
  count: number;
  angle: number; // deg
}

/** Param defaults per row (the 魔法陣 (金) stack). */
const ROW_DEFAULTS: Row[] = [
  { type: 'ring', radius: 100, size: 6, count: 1, angle: 0 },
  { type: 'text', radius: 91.5, size: 30, count: 30, angle: 0 },
  { type: 'ring', radius: 83, size: 3, count: 1, angle: 0 },
  { type: 'star2', radius: 83, size: 4, count: 6, angle: 0 },
  { type: 'ring', radius: 41.5, size: 3, count: 1, angle: 0 },
  { type: 'dashed', radius: 30, size: 5, count: 24, angle: 0 },
];

const ROW_TYPE_OPTIONS: [RowType, string][] = [
  ['ring', 'Ring'],
  ['dashed', 'Dashed ring'],
  ['ticks', 'Ticks'],
  ['text', 'Text ring'],
  ['polygon', 'Polygon'],
  ['star2', 'Star n/2'],
  ['star3', 'Star n/3'],
  ['chevrons', 'Chevrons'],
  ['arcs', 'Arcs'],
  ['hex', 'Hex grid'],
];

function rowParams(i: number): ParamDef[] {
  const d = ROW_DEFAULTS[i];
  const n = i + 1;
  // Row n shows while the row count is n or more.
  const when = { key: 'rows', value: Array.from({ length: MAX_ROWS - i }, (_, k) => String(n + k)) };
  return [
    { ...sel(`row${n}Type`, `Row ${n} type`, d.type, ROW_TYPE_OPTIONS), when },
    { ...num(`row${n}Radius`, `Row ${n} radius`, d.radius, 0, 150, '%'), when },
    { ...num(`row${n}Size`, `Row ${n} size`, d.size, 0.5, 600, 'px'), when },
    { ...num(`row${n}Count`, `Row ${n} count`, d.count, 1, 360, undefined, 1), when },
    { ...num(`row${n}Angle`, `Row ${n} angle`, d.angle, -180, 180, 'deg'), when },
  ];
}

function rowsOf(p: EffectParams): Row[] {
  const n = Math.min(MAX_ROWS, Math.max(1, Math.round(Number(S(p, 'rows')) || 1)));
  return Array.from({ length: n }, (_, i): Row => {
    const k = `row${i + 1}`;
    const type = S(p, `${k}Type`) as RowType;
    return {
      type: ROW_TYPES.includes(type) ? type : 'ring',
      radius: Math.max(0, N(p, `${k}Radius`)),
      size: Math.max(0.5, N(p, `${k}Size`)),
      count: Math.max(1, Math.round(N(p, `${k}Count`))),
      angle: N(p, `${k}Angle`),
    };
  });
}

/** Furthest any row reaches from the centre in the circle's plane (layer px). */
function outerRadius(p: EffectParams, rows: Row[]) {
  const R = Math.max(1, N(p, 'radius'));
  let E = R;
  for (const r of rows) E = Math.max(E, (R * r.radius) / 100 + r.size);
  return E + 2;
}

/** Viewing distance of the floor-plane tilt: a fixed multiple of the circle, so its shape doesn't depend on the comp. */
const focalOf = (E: number) => 3 * E;

/** Layer-space box of the circle of plane radius E laid back by `tilt` rad, seen from `f`. */
function tiltedBox(cx: number, cy: number, E: number, tilt: number, f: number): Bounds {
  const sT = Math.sin(tilt);
  const cT = Math.cos(tilt);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let k = 0; k < 96; k++) {
    const a = (k / 96) * 2 * Math.PI;
    const u = E * Math.cos(a);
    const v = E * Math.sin(a);
    const s = f / (f + v * sT);
    x0 = Math.min(x0, u * s);
    x1 = Math.max(x1, u * s);
    y0 = Math.min(y0, v * cT * s);
    y1 = Math.max(y1, v * cT * s);
  }
  // The 96-gon sits inside the curve by at most 1 − cos(π/96) ≈ 0.05 % of its radius, magnified
  // up to 1.5× on the near side.
  const m = 0.0015 * E + 1;
  return { x0: cx + x0 - m, y0: cy + y0 - m, x1: cx + x1 + m, y1: cy + y1 + m };
}

const tiltOf = (p: EffectParams) => Math.min(80, Math.max(0, N(p, 'tilt'))) * DEG;

function coreBox(p: EffectParams) {
  const E = outerRadius(p, rowsOf(p));
  return tiltedBox(N(p, 'cx'), N(p, 'cy'), E, tiltOf(p), focalOf(E));
}

// ---------- glyph atlas (text rows) ----------

interface Atlas {
  tex: THREE.CanvasTexture;
  cols: number;
  rows: number;
  count: number;
}

const atlases = new Map<string, Atlas>();

/**
 * White glyph coverage of `set`, one square cell of `cell` px per character (em centred), or null
 * while its font loads (the registry's change event re-renders the layer then).
 */
function glyphAtlas(set: { chars: string; font: string }, cell: number): Atlas | null {
  const entry = getFont(set.font);
  if (!entry) return null;
  const key = `${set.font}|${set.chars}|${cell}`;
  const have = atlases.get(key);
  if (have) return have;
  const chars = [...set.chars];
  const cols = Math.min(8, chars.length);
  const rows = Math.ceil(chars.length / cols);
  const canvas = new OffscreenCanvas(cols * cell, rows * cell);
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#ffffff';
  const f = entry.font;
  // Em at 84 % of the cell: room for the outline anti-aliasing and the linear filter's reach.
  const em = 0.84 * cell;
  const k = em / f.unitsPerEm;
  const emH = (f.ascender - f.descender) * k;
  chars.forEach((ch, i) => {
    const glyph = f.charToGlyph(ch);
    const x = (i % cols) * cell;
    const y = Math.floor(i / cols) * cell;
    const adv = (glyph.advanceWidth ?? f.unitsPerEm) * k;
    const path = glyph.getPath(x + 0.5 * (cell - adv), y + 0.5 * (cell - emH) + f.ascender * k, em);
    g.fill(new Path2D(path.toPathData(2)));
  });
  const tex = new THREE.CanvasTexture(canvas as unknown as HTMLCanvasElement);
  tex.flipY = true;
  tex.premultiplyAlpha = false;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  // A few sizes stay cached (preview, export, two layers); older ones go.
  if (atlases.size >= 6) {
    const [oldKey, old] = atlases.entries().next().value as [string, Atlas];
    old.tex.dispose();
    atlases.delete(oldKey);
  }
  const atlas = { tex, cols, rows, count: chars.length };
  atlases.set(key, atlas);
  return atlas;
}

// ---------- shader ----------

const frag = /* glsl */ `
uniform vec2 uCenter;
uniform vec2 uSpin;  // (cos, sin) of the rotation
uniform vec2 uTilt;  // (sin, cos) of the floor tilt
uniform float uFocal;
uniform int uRows;
uniform vec4 uRowA[${MAX_ROWS}];   // type, radius px, size px, count
uniform float uRowAng[${MAX_ROWS}]; // rad
uniform float uRadius, uFill, uFillR, uSeed;
uniform sampler2D tGrad, tGlyphs;
uniform vec3 uGlyph; // atlas cols, rows, glyph count (0 = no atlas)
${NOISE_GLSL}
${BOX_GLSL}
const float PI = 3.14159265, TAU = 6.28318531;

vec2 Jx, Jy; // circle-plane px per screen px along x / y

// Plane px per screen px along unit plane direction g: the anti-aliasing width of a distance whose gradient is g.
float aaAlong(vec2 g) { return max(length(vec2(dot(Jx, g), dot(Jy, g))), 1e-4); }
float cover(float d, float aa) { return clamp(0.5 - d / aa, 0.0, 1.0); }
vec2 closest(vec2 p, vec2 a, vec2 b) {
  vec2 ba = b - a;
  return a + ba * clamp(dot(p - a, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
}
// Pointy-top hex lattice of unit flat-to-flat width: (offset from the cell centre, cell id).
vec4 hexCell(vec2 p) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec4 hc = floor(vec4(p, p - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec4 h = vec4(p - hc.xy * s, p - (hc.zw + 0.5) * s);
  return dot(h.xy, h.xy) < dot(h.zw, h.zw) ? vec4(h.xy, hc.xy) : vec4(h.zw, hc.zw + 0.5);
}

// Coverage of row i at plane point pl (polar radius r, radial unit vector er; aaR / aaT the
// anti-aliasing widths across / along the rings).
float rowCover(int i, vec2 pl, float r, vec2 er, float aaR, float aaT) {
  vec4 A = uRowA[i];
  int type = int(A.x + 0.5);
  float R = A.y, s = A.z, n = max(A.w, 1.0);
  float a0 = 0.5 * PI + uRowAng[i];       // slots start at the top…
  float th = a0 - atan(pl.y, pl.x);       // …and run clockwise, the reading direction of text rows
  float phi = th / TAU * n;               // slot coordinate: slot k is centred on phi = k
  float slot = TAU / n;
  if (type == 0) return cover(abs(r - R) - 0.5 * s, aaR);
  if (type == 1) {
    float pc = phi - floor(phi + 0.5);
    return cover(abs(r - R) - 0.5 * s, aaR) * cover((abs(pc) - 0.3) * slot * r, aaT);
  }
  if (type == 2) {
    // Ticks hang inward from R. Long majors every 5th / 4th / 3rd tick, whichever divides the count
    // (so they stay regular all round), once there are enough ticks to count.
    float k = floor(phi + 0.5);
    float every = mod(n, 5.0) < 0.5 ? 5.0 : mod(n, 4.0) < 0.5 ? 4.0 : mod(n, 3.0) < 0.5 ? 3.0 : 0.0;
    float L = n >= 20.0 && every > 0.0 && mod(mod(k, n), every) < 0.5 ? 1.7 * s : s;
    float w = max(0.12 * s, 1.0);
    return cover(abs(r - (R - 0.5 * L)) - 0.5 * L, aaR) * cover(abs(phi - k) * slot * r - 0.5 * w, aaT);
  }
  if (type == 3 || type == 7) {
    // Upright frame of slot k: x along the clockwise tangent, y outward from the row radius.
    float k = floor(phi + 0.5);
    float a = a0 - k * slot;
    vec2 ur = vec2(cos(a), sin(a)), ux = vec2(ur.y, -ur.x);
    vec2 lc = vec2(dot(pl, ux), dot(pl, ur) - R);
    if (type == 3) {
      if (uGlyph.z < 0.5) return 0.0;
      vec2 uv = lc / s + 0.5;
      if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;
      // Slot 0 (the top) takes the first glyph; the string repeats clockwise.
      float g = mod(floor(mod(k, n) + 0.5), uGlyph.z);
      float gx = mod(g, uGlyph.x), gy = floor(g / uGlyph.x);
      return textureLod(tGlyphs, vec2((gx + uv.x) / uGlyph.x, 1.0 - (gy + 1.0 - uv.y) / uGlyph.y), 0.0).a;
    }
    // Chevron pointing at the centre.
    vec2 pa = vec2(-0.5 * s, 0.25 * s), pb = vec2(0.0, -0.25 * s), pc = vec2(0.5 * s, 0.25 * s);
    vec2 c1 = closest(lc, pa, pb), c2 = closest(lc, pb, pc);
    vec2 dv = lc - (length(lc - c1) < length(lc - c2) ? c1 : c2);
    float d = length(dv);
    vec2 g = d > 1e-5 ? dv / d : vec2(0.0, 1.0);
    return cover(d - 0.11 * s, aaAlong(g.x * ux + g.y * ur));
  }
  if (type >= 4 && type <= 6) {
    // Polygon {n} or star {n/2}, {n/3}: chords between vertices on the row circle, first one at the top.
    int nn = int(clamp(n, 2.0, 32.0) + 0.5);
    float stepA = float(type - 3) * TAU / float(nn);
    float best = 1e9;
    vec2 bv = er;
    for (int j = 0; j < 32; j++) {
      if (j >= nn) break;
      float va = a0 + float(j) * TAU / float(nn);
      vec2 dv = pl - closest(pl, R * vec2(cos(va), sin(va)), R * vec2(cos(va + stepA), sin(va + stepA)));
      float d = length(dv);
      if (d < best) { best = d; bv = dv; }
    }
    return cover(best - 0.5 * s, aaAlong(best > 1e-5 ? bv / best : er));
  }
  if (type == 8) {
    // Random arcs, one chance per slot: start, length and thickness from the seed.
    float k = floor(phi), f = phi - k;
    vec2 hs = vec2(mod(k, n) + float(i) * 131.0, uSeed * 17.0);
    if (hash12(hs) > 0.8) return 0.0;
    float st = 0.04 + 0.3 * hash12(hs + 7.1);
    float len = 0.2 + (0.72 - st) * hash12(hs + 13.7);
    float thick = s * (0.35 + 0.65 * hash12(hs + 29.3));
    return cover(abs(r - R) - 0.5 * thick, aaR) * cover(max(st - f, f - st - len) * slot * r, aaT);
  }
  // Hex grid filling the band [R − s, R], n cells around, fading inward.
  float cs = TAU * R / n;
  vec2 hp = abs(hexCell(pl / cs).xy);
  float edge = max(dot(hp, vec2(0.5, 0.8660254)), hp.x); // 0.5 on the cell outline
  float band = cover(r - R, aaR) * smoothstep(R - s, R - 0.55 * s, r);
  return band * cover((0.5 - edge) * cs - 0.5 * max(1.0, 0.08 * cs), 0.5 * (aaR + aaT));
}

void main() {
  vec2 lp = boxPos() - uCenter;
  // Floor plane laid back about the x axis, seen from uFocal in front of the centre (as the
  // pattern fill's): screen y = f·v·cos t / (f + v·sin t), screen x = f·u / (f + v·sin t), inverted.
  float den = uFocal * uTilt.y - lp.y * uTilt.x;
  float v = lp.y * uFocal / max(den, 1e-3 * uFocal);
  vec2 pl = vec2(lp.x * (uFocal + v * uTilt.x) / uFocal, v);
  pl = vec2(uSpin.x * pl.x + uSpin.y * pl.y, -uSpin.y * pl.x + uSpin.x * pl.y);
  Jx = dFdx(pl);
  Jy = dFdy(pl);
  float r = length(pl);
  vec2 er = r > 1e-4 ? pl / r : vec2(1.0, 0.0);
  float aaR = aaAlong(er), aaT = aaAlong(vec2(-er.y, er.x));
  float cov = 0.0;
  for (int i = 0; i < ${MAX_ROWS}; i++) {
    if (i >= uRows) break;
    cov = max(cov, rowCover(i, pl, r, er, aaR, aaT));
  }
  // Inner fill: a disc to the outermost row, brightening toward its rim like a lit lens.
  float fr = r / max(uFillR, 1.0);
  cov = max(cov, uFill * cover(r - uFillR, aaR) * (0.35 + 0.65 * min(fr * fr, 1.0)));
  vec4 g = textureLod(tGrad, vec2(clamp(r / uRadius, 0.0, 1.0), 0.5), 0.0);
  float a = cov * g.a * (den > 1e-3 * uFocal ? 1.0 : 0.0);
  o = vec4(g.rgb * a, a);
}`;

const uniforms: Record<string, THREE.IUniform> = {
  uCenter: { value: new THREE.Vector2() },
  uSpin: { value: new THREE.Vector2(1, 0) },
  uTilt: { value: new THREE.Vector2(0, 1) },
  uFocal: { value: 1 },
  uRows: { value: 1 },
  uRowA: { value: Array.from({ length: MAX_ROWS }, () => new THREE.Vector4()) },
  uRowAng: { value: new Float32Array(MAX_ROWS) },
  uRadius: { value: 1 },
  uFill: { value: 0 },
  uFillR: { value: 1 },
  uSeed: { value: 0 },
  tGrad: { value: null },
  tGlyphs: { value: null },
  uGlyph: { value: new THREE.Vector3() },
};

const gold: Gradient = {
  stops: [
    { pos: 0, color: '#fff6d0' },
    { pos: 1, color: '#f0b030' },
  ],
};

/** Preset params: the row stack plus the rest. */
function stack(rows: Partial<Row>[], rest: Partial<EffectParams>): Partial<EffectParams> {
  const out: Partial<EffectParams> = { rows: String(rows.length), ...rest };
  rows.forEach((r, i) => {
    const k = `row${i + 1}`;
    const d = { ...ROW_DEFAULTS[i], count: 1, angle: 0, ...r };
    out[`${k}Type`] = d.type;
    out[`${k}Radius`] = d.radius;
    out[`${k}Size`] = d.size;
    out[`${k}Count`] = d.count;
    out[`${k}Angle`] = d.angle;
  });
  return out;
}

const gradient = (inner: string, outer: string): Gradient => ({
  stops: [
    { pos: 0, color: inner },
    { pos: 1, color: outer },
  ],
});

export const magicCircle: GeneratorDef = {
  type: 'magicCircle',
  label: 'Magic Circle',
  category: 'Rings',
  description:
    '魔法陣 / HUD rings: up to six concentric rows (ring, dashes, ticks, text, polygon, star, chevrons, arcs, hex grid), ' +
    'rotated, optionally laid on the floor (ホログラム台座), coloured centre → edge, with an inner fill. ' +
    'Row size: line width (ring, dashes, arcs, polygon, star), tick length, glyph or chevron height, hex band depth. ' +
    'Row count: dashes, ticks, glyphs, sides / points, chevrons, arc slots or hex cells around.',
  params: [
    ...centreParams(),
    num('radius', 'Radius', 320, 10, 3000, 'px'),
    num('rotation', 'Rotation', 0, -180, 180, 'deg'),
    num('tilt', 'Tilt X', 0, 0, 80, 'deg'),
    grad('color', 'Colour (centre → edge)', gold),
    num('fill', 'Inner fill', 6, 0, 100, '%'),
    sel(
      'text',
      'Text ring glyphs',
      'runes',
      Object.entries(GLYPH_SETS).map(([k, v]) => [k, v.label]),
    ),
    sel('rows', 'Rows', String(MAX_ROWS), [
      ['1', '1'],
      ['2', '2'],
      ['3', '3'],
      ['4', '4'],
      ['5', '5'],
      ['6', '6'],
    ]),
    ...Array.from({ length: MAX_ROWS }, (_, i) => rowParams(i)).flat(),
    num('seed', 'Seed', 1, 0, 999, undefined, 1),
  ],
  presets: [
    { id: 'gold', label: 'Magic circle (gold)', blend: 'add', params: stack(ROW_DEFAULTS, { color: gold, fill: 6, text: 'runes', tilt: 0 }), effects: [lightGlow(14)] },
    {
      id: 'blue',
      label: 'Magic circle (blue)',
      blend: 'add',
      params: stack(
        [
          { type: 'ring', radius: 100, size: 4 },
          { type: 'text', radius: 92, size: 26, count: 36 },
          { type: 'ring', radius: 84, size: 2 },
          { type: 'star2', radius: 84, size: 3, count: 5 },
          { type: 'polygon', radius: 84, size: 2, count: 5 },
          { type: 'dashed', radius: 36, size: 3, count: 36 },
        ],
        { color: gradient('#e8fbff', '#3aa0ff'), fill: 8, text: 'runes', tilt: 0 },
      ),
      effects: [lightGlow(16)],
    },
    {
      id: 'hud',
      label: 'HUD target',
      blend: 'add',
      params: stack(
        [
          { type: 'ring', radius: 100, size: 2 },
          { type: 'ticks', radius: 96, size: 16, count: 72 },
          { type: 'arcs', radius: 82, size: 8, count: 6 },
          // One slot per character of the HUD string, so it reads once round without a seam.
          { type: 'text', radius: 70, size: 16, count: 42 },
          { type: 'chevrons', radius: 50, size: 34, count: 4, angle: 45 },
          { type: 'dashed', radius: 22, size: 3, count: 12 },
        ],
        { radius: 300, color: gradient('#d8ffff', '#29c4ff'), fill: 0, text: 'hud', tilt: 0 },
      ),
      effects: [lightGlow(10)],
    },
    {
      id: 'hologram',
      label: 'Hologram base',
      blend: 'add',
      params: stack(
        [
          { type: 'ring', radius: 100, size: 8 },
          { type: 'hex', radius: 97, size: 110, count: 48 },
          { type: 'ticks', radius: 68, size: 12, count: 120 },
          { type: 'arcs', radius: 58, size: 6, count: 5 },
          { type: 'ring', radius: 50, size: 3 },
          { type: 'dashed', radius: 34, size: 8, count: 16 },
        ],
        { radius: 360, color: gradient('#e6ffff', '#00b8ff'), fill: 18, text: 'hud', tilt: 68 },
      ),
      effects: [lightGlow(18)],
    },
    {
      id: 'radar',
      label: 'Radar',
      blend: 'add',
      params: stack(
        [
          { type: 'ring', radius: 100, size: 3 },
          { type: 'ticks', radius: 100, size: 14, count: 72 },
          { type: 'ring', radius: 66.7, size: 1.5 },
          { type: 'ring', radius: 33.3, size: 1.5 },
          { type: 'star2', radius: 100, size: 1.5, count: 4 },
          { type: 'dashed', radius: 83, size: 1.5, count: 72 },
        ],
        { color: gradient('#d0ffd8', '#20e060'), fill: 10, text: 'hud', tilt: 0 },
      ),
      effects: [lightGlow(8)],
    },
    {
      id: 'bagua',
      label: 'Bagua',
      blend: 'add',
      params: stack(
        [
          { type: 'ring', radius: 100, size: 5 },
          { type: 'polygon', radius: 96, size: 3, count: 8, angle: 22.5 },
          { type: 'text', radius: 82, size: 46, count: 8 },
          { type: 'polygon', radius: 66, size: 2, count: 8, angle: 22.5 },
          { type: 'ring', radius: 50, size: 3 },
          { type: 'star2', radius: 48, size: 2, count: 8 },
        ],
        { color: gradient('#fff0c0', '#ff6a1a'), fill: 0, text: 'bagua', tilt: 0 },
      ),
      effects: [lightGlow(12)],
    },
  ],
  handles: [{ x: 'cx', y: 'cy', label: 'Circle centre' }],
  sizes: [{ rx: 'radius', x: 'cx', y: 'cy', label: 'Radius' }],
  bounds: (p) => coreBox(p),
  fonts: (p) => (rowsOf(p).some((r) => r.type === 'text') ? [(GLYPH_SETS[S(p, 'text')] ?? GLYPH_SETS.runes).font] : []),
  render(ctx, target, p) {
    clearTarget(ctx, target);
    const rows = rowsOf(p);
    const R = Math.max(1, N(p, 'radius'));
    const E = outerRadius(p, rows);
    const tilt = tiltOf(p);
    const f = focalOf(E);
    const spin = N(p, 'rotation') * DEG;
    const u = uniforms;
    u.uCenter.value.set(N(p, 'cx'), N(p, 'cy'));
    u.uSpin.value.set(Math.cos(spin), Math.sin(spin));
    u.uTilt.value.set(Math.sin(tilt), Math.cos(tilt));
    u.uFocal.value = f;
    u.uRows.value = rows.length;
    let fillR = 0;
    let textSize = 0;
    rows.forEach((r, i) => {
      const radius = (R * r.radius) / 100;
      (u.uRowA.value as THREE.Vector4[])[i].set(ROW_TYPES.indexOf(r.type), radius, r.size, r.count);
      (u.uRowAng.value as Float32Array)[i] = r.angle * DEG;
      fillR = Math.max(fillR, radius);
      if (r.type === 'text') textSize = Math.max(textSize, r.size);
    });
    u.uRadius.value = R;
    u.uFill.value = Math.min(1, Math.max(0, N(p, 'fill') / 100));
    u.uFillR.value = fillR;
    u.uSeed.value = N(p, 'seed');
    u.tGrad.value = ctx.kit.gradientTexture(G(p, 'color'));
    let atlas: Atlas | null = null;
    if (textSize > 0) {
      // Glyph cells at about the drawn size in render px (the near side of a tilted circle is
      // magnified up to f / (f − E·sin t)), in steps of 32 px so small zooms reuse the atlas.
      const mag = f / (f - E * Math.sin(tilt));
      const px = textSize * layerPxScale(ctx) * mag;
      const cell = Math.min(512, Math.max(32, Math.ceil(px / 32) * 32));
      atlas = glyphAtlas(GLYPH_SETS[S(p, 'text')] ?? GLYPH_SETS.runes, cell);
    }
    u.tGlyphs.value = atlas?.tex ?? null;
    u.uGlyph.value.set(atlas?.cols ?? 1, atlas?.rows ?? 1, atlas?.count ?? 0);
    drawBox(ctx, target, coreBox(p), frag, uniforms);
  },
  dispose() {
    for (const a of atlases.values()) a.tex.dispose();
    atlases.clear();
  },
};
