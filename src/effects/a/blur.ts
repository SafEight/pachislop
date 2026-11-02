import * as THREE from 'three';
import type { EffectContext, EffectDef } from '../../engine/contracts';
import { centreX, centreY } from '../../engine/frame';
import { DEG, dirVec, flag, num, pass, pBool, pDeg, pick, pNum, pPx, pSelect } from './util';

// Photoshop / After Effects blurs. Every pass reads and writes premultiplied linear colour, so
// averaging never darkens transparent edges. Radii are comp px × ctx.pxScale (render px), and
// each blur picks its working resolution from the render-px radius, so preview and export match.
// Draft frames trade quality for speed (coarser levels, fewer taps).

// ---------- private RT cache (reduced-resolution levels) ----------

const rts = new Map<string, THREE.WebGLRenderTarget>();

/** Private HalfFloat RT `key` at w×h (linear filtering, clamp-to-edge); valid until the next request of `key`. */
function rt(key: string, w: number, h: number): THREE.WebGLRenderTarget {
  let t = rts.get(key);
  if (!t) {
    t = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    rts.set(key, t);
  } else if (t.width !== w || t.height !== h) t.setSize(w, h);
  return t;
}

// ---------- separable Gaussian ----------

const MAX_TAP = 32;

// One 1-D Gaussian pass. Without uRepeat, taps outside the frame (the whole render, uFrameUv) read
// transparent but still count in the weight sum, so content touching the frame edge fades out (AE
// with Repeat Edge Pixels off); with it they clamp to the edge texel.
const gaussFrag = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uStep; uniform float uSigma; uniform bool uRepeat;
void main() {
  int r = min(int(ceil(uSigma * 3.0)), ${MAX_TAP});
  float k = -0.5 / (uSigma * uSigma);
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int i = -${MAX_TAP}; i <= ${MAX_TAP}; i++) {
    if (i < -r || i > r) continue;
    vec2 uv = vUv + uStep * float(i);
    float w = exp(k * float(i * i));
    ws += w;
    if (!uRepeat && (uv.x < uFrameUv.x || uv.y < uFrameUv.y || uv.x > uFrameUv.z || uv.y > uFrameUv.w)) continue;
    acc += texture(tSrc, uv) * w;
  }
  o = acc / ws;
}`;

/**
 * Gaussian of `src` with standard deviations `sx`, `sy` (render px). Each axis is halved (box
 * downsample) until its σ is ≤ 6 level px (3 in drafts), so a pass never needs more than ~37 taps;
 * an axis with no blur keeps full resolution. Returns a texture, possibly smaller than the render
 * size (sample it by uv), valid until the next call with the same `slot`; `src` itself if both σ are tiny.
 */
function gauss(ctx: EffectContext, src: THREE.Texture, sx: number, sy: number, repeat: boolean, slot: string): THREE.Texture {
  const cap = ctx.draft ? 3 : 6;
  const level = (s: number) => {
    let l = 0;
    while (s / 2 ** l > cap && l < 10) l++;
    return l;
  };
  const lx = level(sx);
  const ly = level(sy);
  let cur = src;
  let w = ctx.width;
  let h = ctx.height;
  for (let i = 1; i <= Math.max(lx, ly); i++) {
    if (i <= lx) w = Math.max(1, Math.ceil(w / 2));
    if (i <= ly) h = Math.max(1, Math.ceil(h / 2));
    const t = rt(`${slot}-d${i}`, w, h);
    ctx.kit.copy(cur, t);
    cur = t.texture;
  }
  const sxl = (sx * w) / ctx.width;
  const syl = (sy * h) / ctx.height;
  if (sxl >= 0.3) {
    const t = rt(`${slot}-x`, w, h);
    pass(ctx, 'blurGauss', gaussFrag, { tSrc: cur, uStep: [1 / w, 0], uSigma: sxl, uRepeat: repeat }, t);
    cur = t.texture;
  }
  if (syl >= 0.3) {
    const t = rt(`${slot}-y`, w, h);
    pass(ctx, 'blurGauss', gaussFrag, { tSrc: cur, uStep: [0, 1 / h], uSigma: syl, uRepeat: repeat }, t);
    cur = t.texture;
  }
  return cur;
}

// Photoshop's Gaussian Blur radius is the standard deviation; AE's Repeat Edge Pixels clamps the
// frame edge instead of fading it in from transparency.
const gaussianBlur: EffectDef = {
  type: 'gaussianBlur',
  label: 'Gaussian Blur',
  category: 'Blur',
  description:
    'Photoshop Gaussian Blur: a smooth, even blur of the layer (or of everything below it on an adjustment layer). Radius is the standard deviation in comp px; Horizontal / Vertical Scale stretch it along one axis. Repeat Edge Pixels keeps content at the frame edge from fading to transparent.',
  params: [
    pNum('radius', 'Radius', 8, 0, 500, 0.1, 'px'),
    pNum('scaleX', 'Horizontal Scale', 100, 0, 200, 1, '%'),
    pNum('scaleY', 'Vertical Scale', 100, 0, 200, 1, '%'),
    pBool('repeatEdges', 'Repeat Edge Pixels', true),
  ],
  reach: (p) => 3 * num(p, 'radius') * (Math.max(num(p, 'scaleX'), num(p, 'scaleY')) / 100),
  gather: (p) => 4 * num(p, 'radius') * (Math.max(num(p, 'scaleX'), num(p, 'scaleY')) / 100),
  apply(ctx, input, output, p) {
    const s = Math.max(0, num(p, 'radius')) * ctx.pxScale;
    const sx = (s * Math.max(0, num(p, 'scaleX'))) / 100;
    const sy = (s * Math.max(0, num(p, 'scaleY'))) / 100;
    ctx.kit.copy(gauss(ctx, input, sx, sy, flag(p, 'repeatEdges'), 'gauss'), output);
  },
};

// ---------- motion blur ----------

// Average of uN taps along uDir (uv per render px) at uStart + i·uSpacing render px.
const motionFrag = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uDir; uniform float uStart, uSpacing; uniform int uN;
void main() {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 64; i++) {
    if (i >= uN) break;
    acc += texture(tSrc, vUv + uDir * (uStart + uSpacing * float(i)));
  }
  o = acc / float(uN);
}`;

const COMB = 32;

// A box of length D along the direction (Photoshop Motion Blur's kernel), built exactly as
// comb(32 taps, D/32) ∗ … ∗ box(last span) so long blurs stay ≤ 64 taps per pass: the last pass
// samples its span ≤ 1 render px apart (2 in drafts), which with bilinear filtering is continuous.
const motionBlur: EffectDef = {
  type: 'motionBlur',
  label: 'Motion Blur',
  category: 'Blur',
  description:
    'Photoshop Motion Blur: smears the layer evenly along a direction over Distance (comp px), centred on it, or one-sided as a trail left behind the motion (180° = trail to the left).',
  params: [
    pDeg('angle', 'Angle', 0),
    pPx('distance', 'Distance', 40, 0, 2000),
    pSelect('mode', 'Type', 'centered', [
      ['centered', 'Centered'],
      ['trail', 'Trail (one-sided)'],
    ]),
  ],
  directions: [{ angle: 'angle', length: 'distance', label: 'Motion direction', convention: 'cwFromRight' }],
  reach: (p) => num(p, 'distance') * (p.mode === 'trail' ? 1 : 0.5),
  apply(ctx, input, output, p) {
    const { kit } = ctx;
    const d = Math.max(0, num(p, 'distance')) * ctx.pxScale;
    if (d < 0.5) {
      kit.copy(input, output);
      return;
    }
    // The trail lies toward the angle, so a pixel gathers from the opposite side.
    const [dx, dy] = dirVec(num(p, 'angle'));
    const uDir = [-dx / ctx.width, -dy / ctx.height];
    const fine = ctx.draft ? 2 : 1;
    const steps: { n: number; spacing: number; start: number }[] = [];
    let span = d;
    let start = pick(p, 'mode', ['centered', 'trail']) === 0 ? -d / 2 : 0;
    while (span / fine > 64) {
      steps.push({ n: COMB, spacing: span / COMB, start });
      span /= COMB;
      start = 0;
    }
    const n = Math.max(1, Math.ceil(span / fine));
    steps.push({ n, spacing: span / n, start: start + span / n / 2 });
    const tmp = steps.length > 1 ? [kit.acquire(), kit.acquire()] : [];
    let src = input;
    steps.forEach((s, i) => {
      const target = i === steps.length - 1 ? output : tmp[i % 2];
      pass(ctx, 'blurMotion', motionFrag, { tSrc: src, uDir, uStart: s.start, uSpacing: s.spacing, uN: s.n }, target);
      src = target.texture;
    });
    for (const t of tmp) kit.release(t);
  },
};

// ---------- lens blur ----------

// Highlight weight of a premultiplied colour: 1 where its sRGB luma is at or above the threshold.
const HIGHLIGHT_GLSL = /* glsl */ `
uniform float uThr, uGain;
float highlight(vec4 c) { return c.a * smoothstep(uThr - 0.04, uThr, luma(toSRGB(unpremul(c)))); }
`;

// 2× downsample weighted by highlights, so a bright point survives as a bright texel and still
// blooms at low resolution. With no highlight gain this is a plain 2×2 box.
const lensDownFrag =
  HIGHLIGHT_GLSL +
  /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel;
void main() {
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 off = vec2(float(i & 1), float(i >> 1)) - 0.5;
    vec4 c = texture(tSrc, vUv + off * uTexel);
    float w = 1.0 + uGain * highlight(c);
    acc += c * w; ws += w;
  }
  o = acc / ws;
}`;

// Gather over the iris: uN taps on a Vogel (golden-angle) spiral, uniform over the unit disc, pushed
// out to the polygon by P(θ) (apothem/cos) and weighted by P² so the polygon is covered evenly.
// Highlights get (1 + gain) weight, so near a bright point it takes over the whole disc: a bokeh disc
// of the highlight colour with the iris's hard edge. The spiral is the same for every pixel, so the
// kernel is fixed and smooth (no per-pixel noise).
const lensGatherFrag =
  HIGHLIGHT_GLSL +
  /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uRad; uniform int uN; uniform float uBlades, uRot;
void main() {
  float seg = uBlades > 0.0 ? 2.0 * PI / uBlades : 0.0;
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int i = 0; i < 512; i++) {
    if (i >= uN) break;
    float rho = sqrt((float(i) + 0.5) / float(uN));
    float th = float(i) * 2.39996323;
    float P = 1.0;
    if (seg > 0.0) P = cos(0.5 * seg) / cos(mod(th - uRot, seg) - 0.5 * seg);
    vec4 c = texture(tSrc, vUv + vec2(cos(th), sin(th)) * (rho * P) * uRad);
    float w = P * P * (1.0 + uGain * highlight(c));
    acc += c * w; ws += w;
  }
  o = acc / ws;
}`;

// Full-resolution upsample plus Photoshop's Noise: ±uNoise (sRGB levels / 255) uniform, or Gaussian
// with σ = uNoise / 2, per channel or monochromatic, only where there is ink. Keyed on the whole
// render's pixel, so a window of it gets the same grain.
const lensFinishFrag = /* glsl */ `
uniform sampler2D tSrc; uniform float uNoise; uniform bool uGauss, uMono;
void main() {
  vec4 c = texture(tSrc, vUv);
  if (uNoise > 0.0 && c.a > 1e-4) {
    vec2 p = floor(gl_FragCoord.xy + uFrame.xy);
    vec3 u = vec3(hash1(p), hash1(p + 31.7), hash1(p + 73.1));
    vec3 n = u * 2.0 - 1.0;
    if (uGauss) {
      vec3 v = vec3(hash1(p + 11.3), hash1(p + 47.9), hash1(p + 91.4));
      n = 0.5 * sqrt(-2.0 * log(max(u, 1e-6))) * cos(2.0 * PI * v);
    }
    if (uMono) n = vec3(n.x);
    c.rgb = toLinear(toSRGB(unpremul(c)) + n * uNoise) * c.a;
  }
  o = c;
}`;

const IRIS = ['circle', 'hexagon', 'octagon'] as const;
const BLADES = [0, 6, 8];

const lensBlur: EffectDef = {
  type: 'lensBlur',
  label: 'Lens Blur',
  category: 'Blur',
  description:
    'Photoshop Lens Blur: an out-of-focus camera blur through an iris (circle, hexagon or octagon), in which bright points bloom into hard-edged bokeh discs. Specular highlights at or above the threshold (0–255) take over the disc around them, more with higher brightness; Noise adds grain back (in 8-bit levels) so the smooth blur does not band.',
  params: [
    pPx('radius', 'Radius', 20, 0, 300),
    pSelect('shape', 'Iris Shape', 'hexagon', [
      ['circle', 'Circle'],
      ['hexagon', 'Hexagon'],
      ['octagon', 'Octagon'],
    ]),
    pDeg('rotation', 'Blade Rotation', 0, 0, 360),
    pNum('brightness', 'Highlight Brightness', 15, 0, 100, 1),
    pNum('threshold', 'Highlight Threshold', 235, 0, 255, 1),
    pNum('noise', 'Noise Amount', 2, 0, 100, 1),
    pSelect('distribution', 'Noise Distribution', 'uniform', [
      ['uniform', 'Uniform'],
      ['gaussian', 'Gaussian'],
    ]),
    pBool('mono', 'Monochromatic', true),
  ],
  reach: (p) => num(p, 'radius'),
  apply(ctx, input, output, p) {
    const r = Math.max(0, num(p, 'radius')) * ctx.pxScale;
    const thr = num(p, 'threshold') / 255;
    const gain = (Math.max(0, num(p, 'brightness')) / 100) ** 2 * 400;
    let blurred = input;
    if (r >= 0.5) {
      // Halve until the radius is ≤ 10 level px (5 in drafts), then gather ~1.6 taps per level px².
      const cap = ctx.draft ? 5 : 10;
      let cur = input;
      let w = ctx.width;
      let h = ctx.height;
      for (let i = 1; r / 2 ** (i - 1) > cap && i <= 10; i++) {
        const nw = Math.max(1, Math.ceil(w / 2));
        const nh = Math.max(1, Math.ceil(h / 2));
        const t = rt(`lens-d${i}`, nw, nh);
        pass(ctx, 'blurLensDown', lensDownFrag, { tSrc: cur, uTexel: [1 / w, 1 / h], uThr: thr, uGain: gain }, t);
        cur = t.texture;
        w = nw;
        h = nh;
      }
      const rl = (r * w) / ctx.width;
      const taps = Math.round(Math.min(ctx.draft ? 128 : 512, Math.max(16, 1.6 * Math.PI * rl * rl)));
      const g = rt('lens-g', w, h);
      pass(
        ctx,
        'blurLensGather',
        lensGatherFrag,
        {
          tSrc: cur,
          uRad: [r / ctx.width, r / ctx.height],
          uN: taps,
          uBlades: BLADES[pick(p, 'shape', IRIS)],
          uRot: -num(p, 'rotation') * DEG,
          uThr: thr,
          uGain: gain,
        },
        g,
      );
      blurred = g.texture;
    }
    pass(
      ctx,
      'blurLensFinish',
      lensFinishFrag,
      { tSrc: blurred, uNoise: Math.max(0, num(p, 'noise')) / 255, uGauss: p.distribution === 'gaussian', uMono: flag(p, 'mono') },
      output,
    );
  },
};

// ---------- tilt-shift ----------

// Blur amount b (0…1 of the maximum) from the distance to the focus line, then a blend between
// the sharp layer and Gaussian levels at σ = max·{1/8, 1/4, 1/2, 1}: linear below 1/8, log2 above.
const tiltFrag = /* glsl */ `
uniform sampler2D tSrc, tL1, tL2, tL3, tL4; uniform vec2 uC, uN; uniform float uHalf, uFall;
void main() {
  float d = abs(dot(vUv * uRes - uC, uN));
  float t = uFall > 0.0 ? clamp((d - uHalf) / uFall, 0.0, 1.0) : step(uHalf, d);
  float x = 8.0 * t * t * (3.0 - 2.0 * t);
  if (x <= 1.0) { o = mix(texture(tSrc, vUv), texture(tL1, vUv), x); return; }
  float l = log2(x);
  if (l <= 1.0) o = mix(texture(tL1, vUv), texture(tL2, vUv), l);
  else if (l <= 2.0) o = mix(texture(tL2, vUv), texture(tL3, vUv), l - 1.0);
  else o = mix(texture(tL3, vUv), texture(tL4, vUv), l - 2.0);
}`;

const tiltShift: EffectDef = {
  type: 'tiltShift',
  label: 'Tilt-Shift Blur',
  category: 'Blur',
  description:
    'Photoshop Tilt-Shift (field blur): a sharp focus band through a centre point, blurring smoothly more and more beyond it up to Blur (comp px), the miniature look. Angle tilts the band (0° = horizontal); drag its centre on the canvas.',
  params: [
    pPx('blur', 'Blur', 16, 0, 200),
    pPx('centerX', 'Center X', 0, -4000, 4000),
    pPx('centerY', 'Center Y', 0, -4000, 4000),
    pDeg('angle', 'Angle', 0),
    pPx('width', 'Sharp Width', 160, 0, 4000),
    pPx('falloff', 'Falloff', 240, 0, 4000),
  ],
  handles: [{ x: 'centerX', y: 'centerY', label: 'Focus centre' }],
  directions: [{ angle: 'angle', label: 'Focus band', convention: 'cwFromRight' }],
  // σ = Blur / 2 (a disc of radius Blur has that variance), spreading 3σ.
  reach: (p) => 1.5 * num(p, 'blur'),
  apply(ctx, input, output, p) {
    const s = ctx.pxScale;
    const sigma = (Math.max(0, num(p, 'blur')) * s) / 2;
    if (sigma < 0.3) {
      ctx.kit.copy(input, output);
      return;
    }
    const level = (f: number, i: number) => gauss(ctx, input, sigma * f, sigma * f, true, `tilt${i}`);
    const [dx, dy] = dirVec(num(p, 'angle'));
    pass(
      ctx,
      'blurTilt',
      tiltFrag,
      {
        tSrc: input,
        tL1: level(1 / 8, 1),
        tL2: level(1 / 4, 2),
        tL3: level(1 / 2, 3),
        tL4: level(1, 4),
        // centre params: comp px from the comp centre, +y up → target px from bottom-left
        uC: [centreX(ctx.frame) + num(p, 'centerX') * s, centreY(ctx.frame) + num(p, 'centerY') * s],
        uN: [-dy, dx],
        uHalf: (Math.max(0, num(p, 'width')) * s) / 2,
        uFall: Math.max(0, num(p, 'falloff')) * s,
      },
      output,
    );
  },
};

export const BLUR_EFFECTS: EffectDef[] = [gaussianBlur, motionBlur, lensBlur, tiltShift];
