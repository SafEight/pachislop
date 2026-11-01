import type { EffectDef } from '../../engine/contracts';
import { DEG, dirVec, flag, num, pass, pBool, pDeg, pick, pNum, pPx, pSelect } from './util';

/** Comp-px centre params (origin = comp centre, +y up) → render px from bottom-left. */
const centrePx = (ctx: { width: number; height: number; pxScale: number }, x: number, y: number) => [
  ctx.width / 2 + x * ctx.pxScale,
  ctx.height / 2 + y * ctx.pxScale,
];

// ---------- radial blur ----------

// Each pass averages uN taps over a span: zoom = log-scale span (q = c + (p-c)·e^(−span·k)),
// spin = angle span centred on 0. Long blurs run twice (coarse span, then span/n) so taps
// stay ≤ ~1 render px apart without hundreds of samples per pixel.
const radialFrag = /* glsl */ `
uniform sampler2D tSrc, tOrig;
uniform vec2 uC; uniform float uSpan; uniform int uN, uType; uniform bool uKeep;
void main() {
  vec2 p = vUv * uRes;
  float j = hash1(p + uSpan);
  vec4 acc = vec4(0.0);
  vec2 d = p - uC;
  for (int i = 0; i < 64; i++) {
    if (i >= uN) break;
    float k = (float(i) + j) / float(uN);
    vec2 q;
    if (uType == 0) q = uC + d * exp(-uSpan * k);
    else {
      float a = uSpan * (k - 0.5);
      float cs = cos(a), sn = sin(a);
      q = uC + vec2(cs * d.x - sn * d.y, sn * d.x + cs * d.y);
    }
    acc += texture(tSrc, q / uRes);
  }
  acc /= float(uN);
  vec4 L = texture(tOrig, vUv);
  o = uKeep ? L + acc * (1.0 - L.a) : acc;
}`;

const radialBlur: EffectDef = {
  type: 'radialBlur',
  label: 'Radial Blur',
  category: 'Blur',
  description: 'Zoom blur streaking toward a centre point (impact cut-in), or spin blur around it.',
  params: [
    pSelect('type', 'Type', 'zoom', [
      ['zoom', 'Zoom'],
      ['spin', 'Spin'],
    ]),
    pNum('amount', 'Zoom Amount', 0.25, 0, 0.95),
    pDeg('spin', 'Spin Angle', 12, 0, 180),
    pPx('centerX', 'Center X', 0, -4000, 4000),
    pPx('centerY', 'Center Y', 0, -4000, 4000),
    pBool('keepOriginal', 'Original On Top', true),
  ],
  handles: [{ x: 'centerX', y: 'centerY', label: 'Blur centre' }],
  apply(ctx, input, output, p) {
    const type = pick(p, 'type', ['zoom', 'spin']);
    const c = centrePx(ctx, num(p, 'centerX'), num(p, 'centerY'));
    const diag = Math.hypot(ctx.width, ctx.height);
    const span = type === 0 ? -Math.log(1 - Math.max(0, Math.min(0.95, num(p, 'amount')))) : num(p, 'spin') * DEG;
    // longest tap travel in render px (zoom: ~ span × distance to the far corner)
    const travel = Math.abs(span) * diag * (type === 0 ? 0.6 : 0.5);
    const keep = flag(p, 'keepOriginal');
    const u = { tSrc: input, tOrig: input, uC: c, uType: type };
    if (travel <= 48) {
      pass(ctx, 'radialBlur', radialFrag, { ...u, uSpan: span, uN: Math.max(8, Math.ceil(travel)), uKeep: keep }, output);
      return;
    }
    const n1 = 32;
    const tmp = ctx.kit.acquire();
    pass(ctx, 'radialBlur', radialFrag, { ...u, uSpan: span, uN: n1, uKeep: false }, tmp);
    const n2 = Math.min(64, Math.ceil(travel / n1) + 1);
    pass(ctx, 'radialBlur', radialFrag, { ...u, tSrc: tmp.texture, uSpan: span / n1, uN: n2, uKeep: keep }, output);
    ctx.kit.release(tmp);
  },
};

// ---------- wave ----------

const waveFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uDir, uC; uniform float uAmp, uLambda, uPhase; uniform int uType;
void main() {
  vec2 p = vUv * uRes;
  vec2 disp;
  if (uType == 0) {
    float ph = 2.0 * PI * (dot((p - 0.5 * uRes) / uPx, uDir) / uLambda - uPhase);
    disp = vec2(-uDir.y, uDir.x) * uAmp * sin(ph);
  } else {
    vec2 d = p - uC;
    float r = length(d);
    float ph = 2.0 * PI * (r / uPx / uLambda - uPhase);
    disp = (r > 1e-3 ? d / r : vec2(0.0)) * uAmp * sin(ph);
  }
  vec2 q = (p - disp) / uRes;
  o = (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) ? vec4(0.0) : texture(tSrc, q);
}`;

const wave: EffectDef = {
  type: 'wave',
  label: 'Wave',
  category: 'Distort',
  description: 'Sine ripple displacement: a linear wave (flag) or circular ripples from a centre.',
  params: [
    pSelect('type', 'Type', 'linear', [
      ['linear', 'Linear'],
      ['radial', 'Radial Ripple'],
    ]),
    pPx('amplitude', 'Amplitude', 8, 0, 200, 0.5),
    pPx('wavelength', 'Wavelength', 140, 4, 3000),
    pNum('phase', 'Phase', 0, 0, 1),
    pDeg('angle', 'Direction', 0),
    pPx('centerX', 'Center X', 0, -4000, 4000),
    pPx('centerY', 'Center Y', 0, -4000, 4000),
  ],
  handles: [{ x: 'centerX', y: 'centerY', label: 'Ripple centre', when: { key: 'type', value: 'radial' } }],
  directions: [{ angle: 'angle', label: 'Wave direction', convention: 'cwFromRight', when: { key: 'type', value: 'linear' } }],
  reach: (p) => num(p, 'amplitude'),
  apply(ctx, input, output, p) {
    pass(
      ctx,
      'wave',
      waveFrag,
      {
        tSrc: input,
        uDir: dirVec(num(p, 'angle')),
        uC: centrePx(ctx, num(p, 'centerX'), num(p, 'centerY')),
        uAmp: num(p, 'amplitude') * ctx.pxScale,
        uLambda: Math.max(1, num(p, 'wavelength')),
        uPhase: num(p, 'phase'),
        uType: pick(p, 'type', ['linear', 'radial']),
      },
      output,
    );
  },
};

// ---------- chromatic aberration ----------

const caFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uDir, uC; uniform float uAmount; uniform int uN, uType;
void main() {
  vec2 p = vUv * uRes;
  vec2 off = uType == 0 ? (p - uC) / (0.5 * length(uRes)) * uAmount : uDir * uAmount;
  vec3 sumC = vec3(0.0), sumA = vec3(0.0), sumW = vec3(0.0);
  for (int i = 0; i < 32; i++) {
    if (i >= uN) break;
    float k = -1.0 + 2.0 * float(i) / float(uN - 1);
    vec3 w = max(1.0 - abs(vec3(k - 1.0, k, k + 1.0)), 0.0);
    vec4 s = texture(tSrc, (p + off * k) / uRes);
    sumC += s.rgb * w; sumA += s.a * w; sumW += w;
  }
  vec3 a = sumA / sumW;
  o = vec4(sumC / sumW, max(a.r, max(a.g, a.b)));
}`;

const chromaticAberration: EffectDef = {
  type: 'chromaticAberration',
  label: 'Chromatic Aberration',
  category: 'Distort',
  description: 'RGB split: red and blue pushed apart radially from a centre or along a direction.',
  params: [
    pPx('amount', 'Amount', 6, 0, 200, 0.5),
    pSelect('type', 'Type', 'radial', [
      ['radial', 'Radial'],
      ['directional', 'Directional'],
    ]),
    pDeg('angle', 'Direction', 0),
    pBool('smooth', 'Spectral Smear', true),
    pPx('centerX', 'Center X', 0, -4000, 4000),
    pPx('centerY', 'Center Y', 0, -4000, 4000),
  ],
  handles: [{ x: 'centerX', y: 'centerY', label: 'Aberration centre', when: { key: 'type', value: 'radial' } }],
  directions: [
    { angle: 'angle', label: 'Split direction', convention: 'cwFromRight', when: { key: 'type', value: 'directional' } },
  ],
  // radial offset = amount × distance-from-centre / half-diagonal: ≤ 2× for a centre inside the comp
  reach: (p) => num(p, 'amount') * (p.type === 'directional' ? 1 : 2),
  apply(ctx, input, output, p) {
    const amount = num(p, 'amount') * ctx.pxScale;
    pass(
      ctx,
      'chromaticAberration',
      caFrag,
      {
        tSrc: input,
        uDir: dirVec(num(p, 'angle')),
        uC: centrePx(ctx, num(p, 'centerX'), num(p, 'centerY')),
        uAmount: amount,
        uN: flag(p, 'smooth') ? Math.max(3, Math.min(31, 2 * Math.ceil(amount) + 1)) : 3,
        uType: pick(p, 'type', ['radial', 'directional']),
      },
      output,
    );
  },
};

export const DISTORT_EFFECTS: EffectDef[] = [radialBlur, wave, chromaticAberration];
