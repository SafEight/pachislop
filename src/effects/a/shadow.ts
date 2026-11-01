import type { EffectDef } from '../../engine/contracts';
import { lit } from '../globalLight';
import { blur, bounds, BOUNDS_GLSL } from '../lib';
import { col, dirVec, num, pass, pColor, pDeg, pNum, pPx } from './util';

// ---------- drop shadow ----------

const dropFrag = /* glsl */ `
uniform sampler2D tSrc, tBlur;
uniform vec2 uOff; uniform vec3 uColor; uniform float uSpread, uOpacity;
void main() {
  vec4 L = texture(tSrc, vUv);
  float a = texture(tBlur, vUv - uOff / uRes).a;
  a = clamp(a / max(1.0 - uSpread, 0.02), 0.0, 1.0) * uOpacity;
  o = L + vec4(uColor * a, a) * (1.0 - L.a);
}`;

const dropShadow: EffectDef = {
  type: 'dropShadow',
  label: 'Drop Shadow',
  category: 'Shadow',
  description: 'Offset, blurred shadow behind the layer (direction 90° = straight down; Use global light casts it away from the comp light).',
  params: [
    pDeg('angle', 'Direction', 60),
    pPx('distance', 'Distance', 10, 0, 500),
    pPx('size', 'Blur', 14, 0, 300),
    pNum('spread', 'Spread', 0.1, 0, 0.95),
    pColor('color', 'Color', '#000000'),
    pNum('opacity', 'Opacity', 0.75, 0, 1),
  ],
  directions: [{ angle: 'angle', length: 'distance', label: 'Shadow', convention: 'cwFromRight' }],
  reach: (p) => num(p, 'distance') + num(p, 'size'),
  apply(ctx, input, output, p) {
    const b = blur(ctx, input, Math.max(0, num(p, 'size')) * ctx.pxScale, 'a');
    const [dx, dy] = dirVec(num(p, 'angle'));
    const d = num(p, 'distance') * ctx.pxScale;
    pass(
      ctx,
      'dropShadow',
      dropFrag,
      {
        tSrc: input,
        tBlur: b.texture,
        uOff: [dx * d, dy * d],
        uColor: col(p, 'color'),
        uSpread: num(p, 'spread'),
        uOpacity: num(p, 'opacity'),
      },
      output,
    );
  },
};

// ---------- inner shadow ----------

const innerFrag = /* glsl */ `
uniform sampler2D tSrc, tBlur;
uniform vec2 uOff; uniform vec3 uColor; uniform float uChoke, uOpacity;
void main() {
  vec4 L = texture(tSrc, vUv);
  // The layer's own alpha, shifted and blurred: where it doesn't cover the layer the edge casts
  // the shadow inward (Photoshop inner shadow). Outside the canvas counts as empty.
  vec2 q = vUv - uOff / uRes;
  float inside = all(greaterThanEqual(q, vec2(0.0))) && all(lessThanEqual(q, vec2(1.0))) ? texture(tBlur, q).a : 0.0;
  float s = clamp((1.0 - inside) / max(1.0 - uChoke, 0.02), 0.0, 1.0) * uOpacity;
  // source-atop: shadow over the layer, clipped to its alpha
  o = vec4(L.rgb * (1.0 - s) + uColor * s * L.a, L.a);
}`;

const innerShadow: EffectDef = {
  type: 'innerShadow',
  label: 'Inner Shadow',
  category: 'Shadow',
  description: 'Photoshop inner shadow: the edge facing the light casts a soft shadow into the layer (direction 90° = shadow falls downward).',
  params: [
    pDeg('angle', 'Direction', 60),
    pPx('distance', 'Distance', 6, 0, 300),
    pPx('size', 'Blur', 8, 0, 200),
    pNum('choke', 'Choke', 0, 0, 0.95),
    pColor('color', 'Color', '#000000'),
    pNum('opacity', 'Opacity', 0.6, 0, 1),
  ],
  directions: [{ angle: 'angle', length: 'distance', label: 'Inner shadow', convention: 'cwFromRight' }],
  apply(ctx, input, output, p) {
    const b = blur(ctx, input, Math.max(0, num(p, 'size')) * ctx.pxScale, 'a');
    const [dx, dy] = dirVec(num(p, 'angle'));
    const d = num(p, 'distance') * ctx.pxScale;
    pass(
      ctx,
      'innerShadow',
      innerFrag,
      {
        tSrc: input,
        tBlur: b.texture,
        uOff: [dx * d, dy * d],
        uColor: col(p, 'color'),
        uChoke: num(p, 'choke'),
        uOpacity: num(p, 'opacity'),
      },
      output,
    );
  },
};

// ---------- perspective shadow ----------

const perspFrag = /* glsl */ `
${BOUNDS_GLSL}
uniform sampler2D tSrc, tNear, tFar;
uniform vec3 uColor;
uniform vec2 uLen; // shadow tip offset (render px) for the top of the object: x = sideways, y = vertical (−: in front)
uniform float uPersp, uFade, uOpacity, uOffset;
void main() {
  vec4 L = texture(tSrc, vUv);
  vec4 b = layerBox();
  vec2 lo = b.xy * uRes, hi = b.zw * uRes;
  float H = max(hi.y - lo.y, 1.0);
  float ratio = uLen.y / H, shear = uLen.x / H;
  float base = lo.y + uOffset;
  float cx = 0.5 * (lo.x + hi.x);
  vec2 p = vUv * uRes;
  float h = (p.y - base) / ratio;            // height on the object this shadow pixel comes from
  float edge = clamp(h * abs(ratio) + 0.5, 0.0, 1.0);
  h = max(h, 0.0);
  float t = clamp(h / H, 0.0, 1.0);
  float k = max(1.0 - uPersp * t, 0.05);
  float sx = cx + (p.x - cx - h * shear) / k;
  vec2 q = vec2(sx, lo.y + h) / uRes;
  float a = mix(texture(tNear, q).a, texture(tFar, q).a, smoothstep(0.0, 1.0, t));
  a *= edge * max(1.0 - uFade * t, 0.0) * uOpacity;
  o = L + vec4(uColor * a, a) * (1.0 - L.a);
}`;

const perspectiveShadow: EffectDef = {
  type: 'perspectiveShadow',
  label: 'Perspective Shadow',
  category: 'Shadow',
  description:
    'Eye Candy-style shadow cast onto a floor at the base of the layer: sheared, squashed, blurring and fading with distance. ' +
    'Direction up (−90°) casts behind the object, down (90°) in front; Length = distance from the base to the tip of the shadow.',
  params: [
    pDeg('angle', 'Direction', -55, -180, 180),
    pPx('length', 'Length', 230, 5, 2000),
    pNum('perspective', 'Perspective', 0.35, 0, 0.95),
    pPx('blurNear', 'Blur Near', 2, 0, 100),
    pPx('blurFar', 'Blur Far', 22, 0, 300),
    pNum('fade', 'Fade', 0.75, 0, 1),
    pPx('offset', 'Floor Offset', 0, -300, 300),
    pColor('color', 'Color', '#000000'),
    pNum('opacity', 'Opacity', 0.7, 0, 1),
  ],
  directions: [{ angle: 'angle', length: 'length', label: 'Cast shadow', convention: 'cwFromRight' }],
  reach: (p) => num(p, 'length') + Math.abs(num(p, 'offset')) + num(p, 'blurFar'),
  apply(ctx, input, output, p) {
    const s = ctx.pxScale;
    const near = blur(ctx, input, Math.max(0, num(p, 'blurNear')) * s, 'a');
    const far = blur(ctx, input, Math.max(0, num(p, 'blurFar')) * s, 'b');
    const box = bounds(ctx, input);
    const len = Math.max(1, num(p, 'length')) * s;
    const [dx, dy] = dirVec(num(p, 'angle'));
    // Keep at least 10° away from horizontal so the floor projection stays finite.
    const vy = Math.sign(dy || 1) * Math.max(Math.abs(dy), 0.17);
    pass(
      ctx,
      'perspectiveShadow',
      perspFrag,
      {
        tSrc: input,
        tNear: near.texture,
        tFar: far.texture,
        tBounds: box.texture,
        uColor: col(p, 'color'),
        uLen: [dx * len, vy * len],
        uPersp: num(p, 'perspective'),
        uFade: num(p, 'fade'),
        uOpacity: num(p, 'opacity'),
        uOffset: num(p, 'offset') * s,
      },
      output,
    );
  },
};

// ---------- floor reflection ----------

const reflectFrag = /* glsl */ `
${BOUNDS_GLSL}
uniform sampler2D tSrc, tBlur;
uniform float uGap, uLen, uOpacity, uScale, uFalloff;
void main() {
  vec4 L = texture(tSrc, vUv);
  vec4 b = layerBox();
  float base = b.y * uRes.y;                       // bottom of the layer content (render px)
  float floorY = base - uGap;                      // mirror line
  float d = floorY - vUv.y * uRes.y;               // distance below the mirror line
  if (d <= 0.0) { o = L; return; }
  float t = clamp(d / uLen, 0.0, 1.0);
  vec2 q = vec2(vUv.x, (base + d / uScale) / uRes.y);
  vec4 sharp = q.y <= 1.0 ? texture(tSrc, q) : vec4(0.0);
  vec4 soft = q.y <= 1.0 ? texture(tBlur, q) : vec4(0.0);
  vec4 r = mix(sharp, soft, smoothstep(0.0, 0.85, t));
  r *= pow(1.0 - t, uFalloff) * uOpacity * clamp(d + 0.5, 0.0, 1.0);
  o = L + r * (1.0 - L.a);
}`;

const floorReflection: EffectDef = {
  type: 'floorReflection',
  label: 'Floor Reflection',
  category: 'Shadow',
  description:
    'Mirrored copy of the layer below its base, as if standing on a glossy floor: fades out and blurs with distance.',
  params: [
    pPx('gap', 'Gap', 4, -100, 300),
    pPx('length', 'Fade Length', 150, 5, 2000),
    pNum('opacity', 'Opacity', 0.45, 0, 1),
    pPx('blur', 'Blur Growth', 14, 0, 200),
    pNum('falloff', 'Falloff', 1.4, 0.3, 5, 0.05),
    pNum('scale', 'Vertical Scale', 1, 0.2, 2, 0.01, 'x'),
  ],
  reach: (p) => Math.max(0, num(p, 'gap')) + num(p, 'length') + num(p, 'blur'),
  apply(ctx, input, output, p) {
    const s = ctx.pxScale;
    const box = bounds(ctx, input);
    const soft = blur(ctx, input, Math.max(0, num(p, 'blur')) * s, 'a');
    pass(
      ctx,
      'floorReflection',
      reflectFrag,
      {
        tSrc: input,
        tBlur: soft.texture,
        tBounds: box.texture,
        uGap: num(p, 'gap') * s,
        uLen: Math.max(1, num(p, 'length') * s),
        uOpacity: num(p, 'opacity'),
        uScale: Math.max(0.05, num(p, 'scale')),
        uFalloff: Math.max(0.05, num(p, 'falloff')),
      },
      output,
    );
  },
};

// Flat shadows fall away from the comp light; the floor shadow recedes behind the title.
const AWAY = { angle: 'angle', convention: 'cwFromRight', relation: 'away' } as const;
export const SHADOW_EFFECTS: EffectDef[] = [
  lit(dropShadow, AWAY),
  lit(innerShadow, AWAY),
  lit(perspectiveShadow, { angle: 'angle', convention: 'cwFromRight', relation: 'floor' }),
  floorReflection,
];
