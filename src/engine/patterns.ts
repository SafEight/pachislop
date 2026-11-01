import * as THREE from 'three';
import { hexToRgb } from '../model/gradient';
import type { Pattern, PatternKind } from '../model/types';
import { getBitmap, imageTexture } from './layer2d/images';

// Procedural 柄 patterns shared by the 2D title renderer and the 3D materials, so a zebra or
// giraffe face looks the same in both. The GLSL is self-contained (every helper is `pat_`
// prefixed) so it can be pasted into any fragment shader, including three.js chunks.
//
// patternSampleD(p, dpdx, dpdy, kind, seed): p is in MOTIF units (layer units / (Pattern.scale %
// of source.size), already rotated), so one motif unit is the nominal feature size; dpdx / dpdy
// are p's per-pixel steps (callers pass analytic values or take dFdx/dFdy at top level; the
// `patternSample(p, kind, seed)` macro does the latter). Returns
//   x = mark coverage 0..1 (analytic anti-aliasing over the pixel footprint),
//   y = secondary-colour (color2) coverage 0..1, composited over the marks,
//   z = mark height 0..1 for relief (rounded over a short ramp inside each mark),
//   w = reserved (0).
// Each kind computes a signed distance d to its mark outline (negative inside) in its own
// internal units; coverage is then exact analytic AA: clamp(0.5 - d / pixelSize).
// Kind 15 ('custom') instead tiles the image bound to `tPatImage` (one tile per motif unit):
// its luminance × alpha is the mark coverage and the relief height, filtered with textureGrad
// from the same per-pixel steps, so tiling shows no seams. setPatternUniforms binds it.
export const PATTERN_KIND_IDS: Record<PatternKind, number> = {
  none: 0,
  zebra: 1,
  tiger: 2,
  giraffe: 3,
  leopard: 4,
  checker: 5,
  hazard: 6,
  stripes: 7,
  dots: 8,
  sakura: 9,
  seigaiha: 10,
  asanoha: 11,
  shippo: 12,
  kikko: 13,
  uroko: 14,
  custom: 15,
};

export function patternKindId(kind: PatternKind): number {
  return PATTERN_KIND_IDS[kind] ?? 0;
}

/** True when the pattern draws anything: visible marks, or relief alone (和柄 as a low bump). */
export function patternActive(p: Pattern): boolean {
  return p.kind !== 'none' && (p.opacity > 0 || p.relief > 0) && (p.kind !== 'custom' || !!p.assetId);
}

export const PATTERN_GLSL = /* glsl */ `
uniform sampler2D tPatImage; // kind 15: tileable image (rows top → bottom), see patterns.ts
float pat_h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 pat_h22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
// Gradient noise, roughly -1..1.
float pat_gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(pat_h22(i) * 2.0 - 1.0, f);
  float b = dot(pat_h22(i + vec2(1.0, 0.0)) * 2.0 - 1.0, f - vec2(1.0, 0.0));
  float c = dot(pat_h22(i + vec2(0.0, 1.0)) * 2.0 - 1.0, f - vec2(0.0, 1.0));
  float d = dot(pat_h22(i + vec2(1.0, 1.0)) * 2.0 - 1.0, f - vec2(1.0, 1.0));
  return 1.6 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
vec2 pat_warp(vec2 q, float freq, float amt) {
  return q + amt * vec2(pat_gnoise(q * freq + 3.7), pat_gnoise(q * freq + 11.3));
}
float pat_smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
float pat_seg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }
const float PAT_NONE = 1e3;

// Each kind returns (d, d2, w): mark distance, secondary distance (PAT_NONE = no colour 2),
// relief ramp width — all in the kind's internal units.

// ゼブラ: irregular stripes bent by low-frequency noise; their width wanders along the stripe
// and where it falls below zero the stripe tapers to a point and breaks.
float pat_zebraU(vec2 q) { return q.x + 0.95 * pat_gnoise(q * vec2(0.19, 0.13)) + 0.22 * pat_gnoise(q * vec2(0.7, 0.5) + 5.3); }
vec3 pat_zebra(vec2 q, vec2 dqx, vec2 dqy, float px) {
  float u = pat_zebraU(q);
  // Internal units per unit of u, from finite differences along the pixel steps.
  float k = px / max(abs(pat_zebraU(q + dqx) - u) + abs(pat_zebraU(q + dqy) - u), 1e-6);
  float id = floor(u + 0.5);
  float f = u - id;
  float wv = pat_gnoise(vec2(id * 1.73 + 0.31, q.y * 0.5));
  float hw = 0.25 + 0.24 * wv + 0.05 * pat_gnoise(q * 1.7 + 7.1);
  return vec3((abs(f) - min(hw, 0.4)) * k, PAT_NONE, 0.1);
}

// 虎: a stripe per unit of u, broken along v into strokes that swell off-centre and taper to
// needle tips; some strokes fork into two prongs at one end, some cells stay empty, and short
// dashes sit midway between the stripes. Distances are in u units (stripe spacing 1), scaled to
// internal units by k.
float pat_tigerU(vec2 q) { return q.x * 0.6 + 0.4 * pat_gnoise(q * vec2(0.22, 0.16)) + 0.06 * pat_gnoise(q * 1.1 + 2.0); }
// Half-width profile over t in [0, 1]: 0 at both tips, 1 at the peak, which skew (1 = centred) moves.
float pat_tigerW(float t, float skew) { float s = pow(clamp(t, 0.0, 1.0), skew); return pow(4.0 * s * (1.0 - s), 0.85); }
// Distance to a stroke on f = 0 over v in [0, len] with peak half-width w; h is the stroke's hash.
// fork: 0 none, else the end (+1: v = len, -1: v = 0) that splits into two prongs.
float pat_tigerStroke(float f, float v, float len, float w, float h, float fork) {
  float t = v / len;
  float skew = mix(0.75, 1.35, h);
  float cap = max(-v, v - len);
  float hw = w * pat_tigerW(t, skew);
  if (fork == 0.0) return max(abs(f) - hw, cap);
  float t0 = mix(0.45, 0.65, fract(h * 7.31));
  float tf = fork > 0.0 ? t : 1.0 - t;
  float tau = max(tf - t0, 0.0) / (1.0 - t0); // 0 at the split → 1 at the forked end
  float span = (1.0 - t0) * len;
  // The body narrows to a point half-way along the prongs.
  float body = max(max(abs(f) - hw * (1.0 - smoothstep(0.0, 0.5, tau)), cap), (tau - 0.5) * span);
  float pw = 0.7 * w * pat_tigerW(fork > 0.0 ? t0 : 1.0 - t0, skew);
  float sep = (0.7 * w + 0.08) * pow(tau, 1.3);
  float before = (t0 - tf) * len;
  float l2 = mix(0.55, 1.0, fract(h * 13.7));
  float p1 = max(max(abs(f - sep) - pw * pow(max(1.0 - tau, 0.0), 1.1), before), cap);
  float p2 = max(max(abs(f + 0.85 * sep) - pw * pow(max(1.0 - tau / l2, 0.0), 1.1), before), (tau - l2) * span);
  return min(body, min(p1, p2));
}
vec3 pat_tiger(vec2 q, vec2 dqx, vec2 dqy, float px) {
  float u = pat_tigerU(q);
  float k = px / max(abs(pat_tigerU(q + dqx) - u) + abs(pat_tigerU(q + dqy) - u), 1e-6);
  float v = q.y * 0.6 + 0.25 * pat_gnoise(q * vec2(0.3, 0.2) + 5.1);
  float id0 = floor(u);
  float d = PAT_NONE;
  // The two stripes either side (a stroke reaches at most ~0.55 from its stripe).
  for (int i = 0; i < 2; i++) {
    float id = id0 + float(i);
    float hs = pat_h21(vec2(id, 4.1));
    float period = mix(4.5, 7.5, hs);
    float vs = v + hs * 17.0;
    float j = floor(vs / period);
    vec2 ha = pat_h22(vec2(id, j) + 0.37), hb = pat_h22(vec2(j, id) + 9.2);
    if (ha.x < 0.1) continue;
    float gap = mix(0.3, 1.0, ha.y);
    float fork = hb.x < 0.4 ? (hb.y < 0.5 ? -1.0 : 1.0) : 0.0;
    float w = mix(0.15, 0.28, fract(ha.x * 3.7));
    d = min(d, pat_tigerStroke(u - id - (hb.y - 0.5) * 0.14, vs - j * period - gap * hb.x, period - gap, w, ha.x, fork));
  }
  // Dashes midway between the stripes, in about half of their cells.
  float vd = v + pat_h21(vec2(id0, 8.3)) * 11.0;
  float jd = floor(vd / 1.8);
  vec2 hc = pat_h22(vec2(id0, jd) + 5.9), hd = pat_h22(vec2(jd, id0) + 2.4);
  if (hc.x > 0.5) {
    float len = mix(0.4, 1.0, hc.y);
    d = min(d, pat_tigerStroke(u - id0 - 0.5 - (hd.x - 0.5) * 0.16, vd - jd * 1.8 - (1.8 - len) * hd.y, len, mix(0.05, 0.1, hd.y), hc.x, 0.0));
  }
  return vec3(d * k, PAT_NONE, 0.12);
}

// キリン: rounded Voronoi patches (the marks) separated by gaps of the base colour.
vec3 pat_giraffe(vec2 q, float seed) {
  q = pat_warp(q, 1.6, 0.07);
  vec2 n = floor(q), f = fract(q);
  vec2 mg = vec2(0.0), mr = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 r = g + 0.5 + 0.38 * sin(6.2831853 * pat_h22(n + g) + seed) - f;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  float e = 8.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 g = mg + vec2(float(i), float(j));
    vec2 r = g + 0.5 + 0.38 * sin(6.2831853 * pat_h22(n + g) + seed) - f;
    vec2 dr = r - mr;
    if (dot(dr, dr) > 1e-5) e = pat_smin(e, dot(0.5 * (mr + r), normalize(dr)), 0.14);
  }
  return vec3(0.055 - e, PAT_NONE, 0.1);
}

// 豹: broken rosette rings (3–5 arcs) with color2 centres, plus some solid spots.
vec3 pat_leopard(vec2 q) {
  q = pat_warp(q, 1.3, 0.05);
  vec2 n = floor(q), f = fract(q);
  float d = PAT_NONE, d2 = PAT_NONE;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 c = n + g;
    vec2 h = pat_h22(c);
    float h3 = pat_h21(c + 4.7), h4 = pat_h21(c + 8.3);
    vec2 r = f - (g + 0.28 + 0.44 * h);
    float ang = atan(r.y, r.x);
    float rr = length(r) * (1.0 + 0.14 * sin(2.0 * ang + 6.2831853 * h4) + 0.05 * sin(3.0 * ang + 9.0 * h3));
    if (h3 > 0.84) {
      d = min(d, rr - 0.08 - 0.05 * h4);
    } else {
      float R = 0.24 + 0.05 * h3;
      float lobes = 3.0 + floor(h4 * 2.999);
      float s = smoothstep(0.1, 0.42, 0.5 + 0.5 * cos(lobes * ang + 6.2831853 * h3));
      float th = 0.075 * s - 0.018 + 0.012 * sin(5.0 * ang + 5.0 * h4) + 0.012 * pat_gnoise(r * 7.0 + c);
      float dr = abs(rr - R) - th;
      d = min(d, dr);
      d2 = min(d2, max(rr - R, -dr));
    }
  }
  return vec3(d, d2, 0.05);
}

// Racing chequer: marks on one parity, color2 on the other.
vec3 pat_checker(vec2 q) {
  vec2 cell = floor(q), fr = q - cell;
  float e = min(min(fr.x, 1.0 - fr.x), min(fr.y, 1.0 - fr.y));
  float d = mod(cell.x + cell.y, 2.0) < 0.5 ? -e : e;
  return vec3(d, -d, 0.08);
}

// DANGER tape: 45° stripes alternating mark / color2.
vec3 pat_hazard(vec2 q) {
  float u = (q.x - q.y) * 0.7071068;
  float d = abs(fract(u) - 0.25) - 0.25;
  return vec3(d, -d, 0.06);
}

vec3 pat_stripes(vec2 q) {
  return vec3(abs(fract(q.x) - 0.5) - 0.25, PAT_NONE, 0.08);
}

// Polka dots on two interleaved square grids.
vec3 pat_dots(vec2 q) {
  float d = min(length(fract(q) - 0.5), length(fract(q + 0.5) - 0.5)) - 0.2;
  return vec3(d, PAT_NONE, 0.08);
}

// 桜: scattered five-petal blossoms with notched petal tips and color2 centres.
vec3 pat_sakura(vec2 q) {
  vec2 n = floor(q), f = fract(q);
  float d = PAT_NONE, d2 = PAT_NONE;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 c = n + g;
    if (pat_h21(c + 2.9) >= 0.12) {
      vec2 h = pat_h22(c);
      float R = 0.27 + 0.1 * pat_h21(c + 6.1);
      vec2 r = f - (g + 0.3 + 0.4 * h);
      float rl = length(r);
      float ang = atan(r.y, r.x) + 6.2831853 * pat_h21(c + 1.3);
      float a = mod(ang, 1.2566371) - 0.6283185; // -π/5..π/5 within one petal
      float petal = R * (0.42 + 0.58 * pow(max(cos(a * 2.5), 0.0), 0.6));
      petal -= R * 0.2 * max(0.0, 1.0 - abs(a) / 0.14); // V notch at the tip
      d = min(d, (rl - petal) * 0.8);
      d2 = min(d2, rl - R * 0.17);
    }
  }
  return vec3(d, d2, 0.05);
}

// 青海波: rows of concentric fans; lower rows overlap the ones above.
vec3 pat_seigaiha(vec2 q, float px) {
  const float R = 0.5, rowH = 0.25, hw = 0.022, sp = R / 4.0;
  float j0 = floor(q.y / rowH);
  float l = R;
  // Back to front (highest row first); the lowest row containing q wins.
  for (int k = 2; k >= -2; k--) {
    float j = j0 + float(k);
    float off = mod(j, 2.0) * 0.5;
    vec2 c = vec2(floor(q.x - off + 0.5) + off, j * rowH);
    float lk = length(q - c);
    if (lk < R + hw + px) l = lk;
  }
  float ring = clamp(floor(l / sp + 0.5), 1.0, 4.0);
  return vec3(abs(l - ring * sp) - hw, PAT_NONE, hw);
}

// 麻の葉: equilateral triangle lattice plus spokes from each triangle's centroid to its corners.
vec3 pat_asanoha(vec2 q) {
  const float H = 0.8660254, hw = 0.022;
  vec2 st = vec2(q.x - 0.5 * q.y / H, q.y / H);
  vec2 cell = floor(st), f = st - cell;
  vec2 A = cell, B, C;
  if (f.x + f.y < 1.0) { B = cell + vec2(1.0, 0.0); C = cell + vec2(0.0, 1.0); }
  else { A = cell + vec2(1.0, 0.0); B = cell + vec2(1.0, 1.0); C = cell + vec2(0.0, 1.0); }
  vec2 a = vec2(A.x + 0.5 * A.y, A.y * H), b = vec2(B.x + 0.5 * B.y, B.y * H), c = vec2(C.x + 0.5 * C.y, C.y * H);
  vec2 m = (a + b + c) / 3.0;
  float d = min(min(pat_seg(q, a, b), pat_seg(q, b, c)), pat_seg(q, c, a));
  d = min(d, min(min(pat_seg(q, m, a), pat_seg(q, m, b)), pat_seg(q, m, c)));
  return vec3(d - hw, PAT_NONE, hw);
}

// 七宝: circles on a square grid, each overlapped a quarter by its four neighbours.
vec3 pat_shippo(vec2 q) {
  const float r = 0.7071068, hw = 0.025;
  vec2 n = floor(q);
  float d = PAT_NONE;
  for (int j = 0; j <= 1; j++) for (int i = 0; i <= 1; i++) d = min(d, abs(length(q - n - vec2(float(i), float(j))) - r));
  return vec3(d - hw, PAT_NONE, hw);
}

// 亀甲: flat-top hexagon lattice with a double outline.
vec3 pat_kikko(vec2 q) {
  const float hw = 0.02;
  vec2 s = vec2(1.0, 1.7320508), h = s * 0.5;
  vec2 p = q.yx;
  vec2 a = mod(p, s) - h, b = mod(p - h, s) - h;
  vec2 g = abs(dot(a, a) < dot(b, b) ? a : b);
  float hd = max(dot(g, vec2(0.5, 0.8660254)), g.x); // 0.5 on the cell edge
  float d = min(abs(hd - 0.5) - hw, abs(hd - 0.41) - hw * 0.75);
  return vec3(d, PAT_NONE, hw);
}

// 鱗: upward triangles of the mark colour tiling with downward triangles of the base.
vec3 pat_uroko(vec2 q) {
  const float H = 0.8660254;
  vec2 st = vec2(q.x - 0.5 * q.y / H, q.y / H);
  vec2 f = fract(st);
  float s = f.x + f.y;
  float d = s < 1.0 ? -min(min(f.x, f.y), 1.0 - s) * H : min(min(1.0 - f.x, 1.0 - f.y), s - 1.0) * H;
  return vec3(d, PAT_NONE, 0.07);
}

// dpdx / dpdy: derivatives of p along screen x / y (motif units per pixel). No derivative
// functions are used inside, so it is safe anywhere (helper lanes, branches, MSAA edges).
vec4 patternSampleD(vec2 p, vec2 dpdx, vec2 dpdy, int kind, float seed) {
  if (kind <= 0) return vec4(0.0);
  if (kind == 15) {
    // One image tile per motif unit; v flipped because the texture's first row is the top.
    vec2 t = fract(p);
    vec4 c = textureGrad(tPatImage, vec2(t.x, 1.0 - t.y), dpdx * vec2(1.0, -1.0), dpdy * vec2(1.0, -1.0));
    float m = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)) * c.a;
    return vec4(m, 0.0, m, 0.0);
  }
  // Integer offsets keep lattices anchored to the layer origin while reshuffling cells.
  vec2 so = floor(vec2(pat_h21(vec2(seed, 1.37)), pat_h21(vec2(seed + 3.1, 7.91))) * 512.0);
  // Internal units per motif unit, chosen so one Pattern.scale reads alike across kinds.
  float S = kind == 1 ? 0.7 : kind == 2 ? 0.7 : kind == 3 ? 0.45 : kind == 4 ? 0.38 : kind == 5 ? 1.0
          : kind == 6 ? 0.6 : kind == 7 ? 1.0 : kind == 8 ? 1.0 : kind == 9 ? 0.32 : kind == 10 ? 0.4
          : kind == 11 ? 0.55 : kind == 12 ? 0.65 : kind == 13 ? 0.5 : 0.55;
  vec2 q = p * S + so;
  vec2 dqx = dpdx * S, dqy = dpdy * S;
  float px = max(length(abs(dqx) + abs(dqy)) * 0.7071068, 1e-6); // pixel footprint, internal units
  vec3 r;
  if (kind == 1) r = pat_zebra(q, dqx, dqy, px);
  else if (kind == 2) r = pat_tiger(q, dqx, dqy, px);
  else if (kind == 3) r = pat_giraffe(q, seed);
  else if (kind == 4) r = pat_leopard(q);
  else if (kind == 5) r = pat_checker(q);
  else if (kind == 6) r = pat_hazard(q);
  else if (kind == 7) r = pat_stripes(q);
  else if (kind == 8) r = pat_dots(q);
  else if (kind == 9) r = pat_sakura(q);
  else if (kind == 10) r = pat_seigaiha(q, px);
  else if (kind == 11) r = pat_asanoha(q);
  else if (kind == 12) r = pat_shippo(q);
  else if (kind == 13) r = pat_kikko(q);
  else r = pat_uroko(q);
  float x = clamp(0.5 - r.x / px, 0.0, 1.0);
  float y = clamp(0.5 - r.y / px, 0.0, 1.0);
  float t = clamp(-r.x / max(r.z, px), 0.0, 1.0);
  return vec4(x, y, t * t * (3.0 - 2.0 * t), 0.0);
}

// Screen-derivative convenience form: a macro so dFdx/dFdy run at the caller's top level.
#define patternSample(p, kind, seed) patternSampleD((p), dFdx(p), dFdy(p), (kind), (seed))
`;

/**
 * Uniforms for one pattern and `patternAt(pos)`: pos → motif units through uPatXform (row-major
 * 2×2: motif.x = dot(xy, pos), motif.y = dot(zw, pos)) + uPatOffset. Colours are sRGB or
 * linear as the consumer asked in setPatternUniforms. uPatRelief is Pattern.relief (0..1).
 */
export const PATTERN_UNIFORMS_GLSL = /* glsl */ `
uniform int uPatKind;
uniform float uPatSeed;
uniform vec4 uPatXform;
uniform vec2 uPatOffset;
uniform vec3 uPatColor;
uniform vec3 uPatColor2;
uniform float uPatOpacity;
uniform float uPatShade;
uniform float uPatRelief;
vec2 patternCoord(vec2 pos) { return vec2(dot(uPatXform.xy, pos), dot(uPatXform.zw, pos)) + uPatOffset; }
#define patternAt(pos) patternSample(patternCoord(pos), uPatKind, uPatSeed)
`;

export function patternUniforms(): Record<string, THREE.IUniform> {
  return {
    uPatKind: { value: 0 },
    uPatSeed: { value: 0 },
    uPatXform: { value: new THREE.Vector4(1, 0, 0, 1) },
    uPatOffset: { value: new THREE.Vector2() },
    uPatColor: { value: new THREE.Vector3() },
    uPatColor2: { value: new THREE.Vector3() },
    uPatOpacity: { value: 0 },
    uPatShade: { value: 0 },
    uPatRelief: { value: 0 },
    tPatImage: { value: null },
  };
}

/**
 * Layer units (y-up) → motif units, row-major [a, b, c, d]: motif = (a·x + b·y, c·x + d·y).
 * One motif unit = Pattern.scale % of `size`; the motif turns clockwise on screen by angle.
 * 'custom' tiles keep their image's aspect: the tile is `scale` % wide and width / aspect tall.
 */
export function patternMatrix(pattern: Pattern, size: number): [number, number, number, number] {
  const k = 1 / Math.max(1e-3, (pattern.scale / 100) * size);
  const a = (pattern.angle * Math.PI) / 180;
  const c = Math.cos(a) * k;
  const s = Math.sin(a) * k;
  const bmp = pattern.kind === 'custom' && pattern.assetId ? getBitmap(pattern.assetId) : undefined;
  const aspect = bmp ? bmp.width / Math.max(1, bmp.height) : 1;
  return [c, -s, s * aspect, c * aspect];
}

const tmpColor = new THREE.Color();

function setColor(v: THREE.Vector3, hex: string, linear: boolean) {
  if (linear) {
    tmpColor.set(hex);
    v.set(tmpColor.r, tmpColor.g, tmpColor.b);
  } else v.fromArray(hexToRgb(hex));
}

/**
 * Fill patternUniforms() for `pattern` on a source of reference size `size`.
 * Shader positions are `pos = layer / unitsPerPos`-scaled samples: pass `pxPerUnit` (positions
 * per layer unit, e.g. 2D frame px per layer unit) and `origin` (layer coordinates of pos 0)
 * when the shader does not work in layer units directly. `linear` selects linear-light colours.
 */
export function setPatternUniforms(
  u: Record<string, THREE.IUniform>,
  pattern: Pattern,
  size: number,
  opts: { linear: boolean; pxPerUnit?: number; origin?: { x: number; y: number } },
) {
  const on = patternActive(pattern);
  u.uPatKind.value = on ? patternKindId(pattern.kind) : 0;
  u.uPatSeed.value = pattern.seed;
  const [a, b, c, d] = patternMatrix(pattern, size);
  const m = opts.pxPerUnit ?? 1;
  const o = opts.origin ?? { x: 0, y: 0 };
  (u.uPatXform.value as THREE.Vector4).set(a / m, b / m, c / m, d / m);
  (u.uPatOffset.value as THREE.Vector2).set(a * o.x + b * o.y, c * o.x + d * o.y);
  setColor(u.uPatColor.value as THREE.Vector3, pattern.color, opts.linear);
  setColor(u.uPatColor2.value as THREE.Vector3, pattern.color2, opts.linear);
  u.uPatOpacity.value = pattern.opacity;
  u.uPatShade.value = pattern.shade;
  u.uPatRelief.value = pattern.relief;
  u.tPatImage.value = on && pattern.kind === 'custom' ? imageTexture(pattern.assetId!) : null;
}
