import * as THREE from 'three';
import type { PassContext } from '../../engine/contracts';
import { isWhole } from '../../engine/frame';
import type { Gradient } from '../../model/types';

// Helpers shared by the energy generators (fire, smoke, corona, lightning), which grow from the
// pixels of the layer they follow (ctx.layerContent) before that layer's own effects.

export const stops = (...s: [number, string][]): Gradient => ({ stops: s.map(([pos, color]) => ({ pos, color })) });

/**
 * Sample the signed distance (render px) of `tSdf` (a field over the target): "far outside" beyond
 * the whole frame. Past a preview window's edge but inside the frame (the preview keeps the followed
 * ink on the target), at most the distance through the nearest target pixel: an upper bound, exact
 * where the nearest ink lies straight across that edge. Set the uniforms with sdUniforms() / setSdf().
 */
export const SD_GLSL = /* glsl */ `
uniform sampler2D tSdf; uniform bool uWindow; uniform vec4 uFrame;
float sd(vec2 frag) {
  vec2 uv = frag / uRes;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
    if (!uWindow || any(lessThan(frag, uFrame.xy)) || any(greaterThan(frag, uFrame.zw))) return 1e4;
    vec2 q = clamp(frag, vec2(0.0), uRes);
    return texture(tSdf, q / uRes).r + length(frag - q);
  }
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

/** Fresh uniforms for SD_GLSL (spread them into a material's uniforms). */
export const sdUniforms = () => ({
  tSdf: { value: null as THREE.Texture | null },
  uWindow: { value: false },
  /** The whole frame in target px: x0, y0, x1, y1. */
  uFrame: { value: new THREE.Vector4() },
});

/** Point SD_GLSL's uniforms of `m` at the field `sdf` over the target of `ctx`. */
export function setSdf(m: THREE.ShaderMaterial, ctx: Pick<PassContext, 'width' | 'height' | 'frame'>, sdf: THREE.Texture) {
  const f = ctx.frame;
  m.uniforms.tSdf.value = sdf;
  m.uniforms.uWindow.value = !isWhole(f, ctx.width, ctx.height);
  m.uniforms.uFrame.value.set(-f.x, -f.y, f.width - f.x, f.height - f.y);
}
