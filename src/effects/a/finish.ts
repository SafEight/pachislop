import type { EffectDef } from '../../engine/contracts';
import { bounds, BOUNDS_GLSL, sdf } from '../lib';
import { col, flag, followed, num, pass, pBool, pColor, pFollow, pNum, pPx } from './util';

// Finishing passes over the whole layer composite: slice glitch, film grain and the outline
// keyline (the thin dark line under 3D edges, or stacked as several strokes).

// ---------- glitch ----------

const glitchFrag = /* glsl */ `
${BOUNDS_GLSL}
uniform sampler2D tSrc; uniform float uAmount, uSlices, uOffset, uSplit, uSeed;
void main() {
  // Slices are fractions of the layer's height, so the pattern is the same at every export scale.
  vec4 b = layerBox();
  float t = (vUv.y - b.y) / max(b.w - b.y, 1e-4);
  // Irregular bands: uSlices even bands, each cut once at a random height.
  float f = t * uSlices;
  float i = floor(f);
  float id = i * 2.0 + step(0.25 + 0.5 * hash1(vec2(i, uSeed)), fract(f));
  float h1 = hash1(vec2(id, uSeed + 3.1)), h2 = hash1(vec2(id, uSeed + 7.7)), h3 = hash1(vec2(id, uSeed + 11.3));
  float on = step(1.0 - uAmount, h1);                 // share of slices that jump sideways
  float off = on * (h2 * 2.0 - 1.0) * uOffset;        // render px
  // Every slice carries a faint RGB split; displaced ones the full amount.
  float split = uSplit * (0.4 + 0.6 * h3) * mix(0.35, 1.0, on);
  vec2 px = vec2(1.0 / uRes.x, 0.0);
  vec4 cR = texture(tSrc, vUv - (off + split) * px);
  vec4 cG = texture(tSrc, vUv - off * px);
  vec4 cB = texture(tSrc, vUv - (off - split) * px);
  // Premultiplied channels from three shifted copies: where only one copy lands it shows as a
  // pure red / green / blue fringe, where they overlap the original colour returns.
  o = vec4(cR.r, cG.g, cB.b, max(cG.a, max(cR.a, cB.a)));
}`;

const glitch: EffectDef = {
  type: 'glitch',
  label: 'Glitch',
  category: 'Distort',
  description: 'Digital glitch (逆押し style): horizontal slices of the layer jump sideways, each with its own RGB split.',
  params: [
    pNum('amount', 'Amount', 0.35, 0, 1),
    pNum('slices', 'Slice count', 14, 1, 80, 1),
    pPx('offset', 'Max offset', 28, 0, 600),
    pPx('split', 'RGB split', 7, 0, 100, 0.5),
    pNum('seed', 'Seed', 1, 0, 999, 1),
  ],
  reach: (p) => num(p, 'offset') + num(p, 'split'),
  apply(ctx, input, output, p) {
    const box = bounds(ctx, input);
    pass(
      ctx,
      'glitch',
      glitchFrag,
      {
        tSrc: input,
        tBounds: box.texture,
        uAmount: num(p, 'amount'),
        uSlices: Math.max(1, Math.round(num(p, 'slices'))),
        uOffset: num(p, 'offset') * ctx.pxScale,
        uSplit: num(p, 'split') * ctx.pxScale,
        uSeed: (num(p, 'seed') % 997) * 1.37,
      },
      output,
    );
  },
};

// ---------- grain ----------

const grainFrag = /* glsl */ `
uniform sampler2D tSrc; uniform float uAmount, uSize, uSeed; uniform bool uColor;
float vnoise(vec2 p, float s) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash1(i + s), b = hash1(i + vec2(1.0, 0.0) + s), c = hash1(i + vec2(0.0, 1.0) + s), d = hash1(i + 1.0 + s);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// Two octaves: clumpy like silver grain, not a regular pixel grid.
float grain(vec2 q, float s) { return 0.65 * vnoise(q, s) + 0.35 * vnoise(q * 2.03 + 5.2, s + 9.0) - 0.5; }
void main() {
  vec4 L = texture(tSrc, vUv);
  if (L.a < 1e-5) { o = L; return; }
  // Grain cells in comp px: the same grain at every export scale.
  vec2 q = (gl_FragCoord.xy - 0.5 * uRes) / uPx / uSize;
  vec3 n = uColor ? vec3(grain(q, uSeed), grain(q, uSeed + 17.0), grain(q, uSeed + 31.0)) : vec3(grain(q, uSeed));
  vec3 lin = unpremul(L);
  float hdr = max(max(lin.r, max(lin.g, lin.b)), 1.0);
  vec3 c = toSRGB(lin / hdr);
  // Film grain shows most in the midtones, less in deep shadows and clipped highlights.
  float l = luma(c);
  c += n * uAmount * (0.3 + 2.8 * l * (1.0 - l));
  o = vec4(toLinear(clamp(c, 0.0, 1.0)) * hdr * L.a, L.a);
}`;

const grain: EffectDef = {
  type: 'grain',
  label: 'Grain',
  category: 'Color',
  description: 'Film grain over the layer, monochrome or colour; transparency is left untouched.',
  params: [
    pNum('amount', 'Amount', 0.14, 0, 1),
    pPx('size', 'Grain size', 1.2, 0.3, 20, 0.1),
    pBool('color', 'Colour grain', false),
    pNum('seed', 'Seed', 1, 0, 999, 1),
  ],
  apply(ctx, input, output, p) {
    pass(
      ctx,
      'grain',
      grainFrag,
      {
        tSrc: input,
        uAmount: num(p, 'amount'),
        uSize: Math.max(0.05, num(p, 'size')),
        uSeed: (num(p, 'seed') % 997) * 3.71,
        uColor: flag(p, 'color'),
      },
      output,
    );
  },
};

// ---------- keyline ----------

const keylineFrag = /* glsl */ `
uniform sampler2D tSrc, tSdf, tContent; uniform vec3 uColor; uniform float uWidth, uSoft, uOpacity; uniform bool uLayer;
void main() {
  vec4 L = texture(tSrc, vUv);
  float d = texture(tSdf, vUv).r;   // render px from the alpha edge, + outside
  // Solid out to the width, antialiased over one pixel; Softness feathers the outer part.
  float k = 1.0 - smoothstep(uWidth * (1.0 - uSoft) - 0.5, uWidth + 0.5, d);
  float a = k * uOpacity;
  vec4 K = vec4(uColor * a, a);
  if (!uLayer) { o = L + K * (1.0 - L.a); return; }
  // Follow Layer: behind the layer's own pixels C but over what the stack drew around them
  // (L − C, e.g. a glow), so a glow below doesn't bury the line; where K is 0 this is L.
  vec4 C = texture(tContent, vUv);
  o = max(C + K * (1.0 - C.a) + (L - C) * (1.0 - K.a), 0.0);
}`;

const keyline: EffectDef = {
  type: 'keyline',
  label: 'Keyline',
  category: 'Material',
  description:
    'Outline traced from the layer’s alpha, drawn behind it just outside the silhouette: the thin dark keyline that ' +
    'separates a 3D title’s edge from the background, or a stroke. Several following the stack below make stacked strokes.',
  params: [
    pPx('width', 'Width', 1.5, 0.5, 100, 0.25),
    pColor('color', 'Color', '#0a0604'),
    pNum('opacity', 'Opacity', 1, 0, 1),
    pNum('softness', 'Softness', 0, 0, 1),
    pNum('threshold', 'Alpha threshold', 0.5, 0.05, 0.95),
    pFollow(),
  ],
  reach: (p) => num(p, 'width'),
  apply(ctx, input, output, p) {
    const field = sdf(ctx, followed(ctx, input, p), num(p, 'threshold'));
    pass(
      ctx,
      'keyline',
      keylineFrag,
      {
        tSrc: input,
        tContent: ctx.content,
        uLayer: p.follow === 'layer',
        tSdf: field.texture,
        uColor: col(p, 'color'),
        uWidth: Math.max(0.25, num(p, 'width') * ctx.pxScale),
        uSoft: num(p, 'softness'),
        uOpacity: num(p, 'opacity'),
      },
      output,
    );
  },
};

export const FINISH_EFFECTS: EffectDef[] = [keyline, grain, glitch];
