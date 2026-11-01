import type { Gradient } from '../../model/types';

// Helpers shared by the energy generators (fire, smoke, corona, lightning), which grow from the
// pixels of the layer they follow (ctx.layerContent) before that layer's own effects.

export const stops = (...s: [number, string][]): Gradient => ({ stops: s.map(([pos, color]) => ({ pos, color })) });

/** Sample the signed distance (render px) with "far outside" beyond the frame. */
export const SD_GLSL = /* glsl */ `
uniform sampler2D tSdf;
float sd(vec2 frag) {
  vec2 uv = frag / uRes;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1e4;
  return texture(tSdf, uv).r;
}
// "Upstream" distance: how far the source edge is when looking back against the flow direction,
// with sideways distance weighted by uSide so flames also lick up the sides.
float upstream(vec2 frag, vec2 dir, float len, float side) {
  float E = 1e9;
  for (int i = 0; i < 40; i++) {
    float st = len * float(i) / 39.0;
    if (st > E) break;
    float d = max(sd(frag - dir * st), 0.0);
    E = min(E, d * side + st);
  }
  return E;
}
`;
