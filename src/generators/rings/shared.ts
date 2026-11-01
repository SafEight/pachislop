import type * as THREE from 'three';
import type { GeneratorContext, ParamDef } from '../../engine/contracts';
import type { Bounds } from '../../text/layout';
import { num } from '../../effects/b/common';
import { drawInstancedQuads } from '../common';

// Plumbing shared by the ring-family generators (shockwave, magicCircle, brushSwirl).

/** Centre params (layer-space comp px) every ring-family generator draws around. */
export const centreParams = (): ParamDef[] => [num('cx', 'Centre X', 0, -4000, 4000, 'px'), num('cy', 'Centre Y', 0, -4000, 4000, 'px')];

/** Render px per layer-space px (the layer's scale × pxScale), as LAYER_VERT's layerPxScale(). */
export const layerPxScale = (ctx: GeneratorContext) => Math.hypot(ctx.layerToRender.elements[0], ctx.layerToRender.elements[1]);

/** GLSL for shaders drawn with drawBox(): `boxPos()` = the fragment's layer-space position (comp px). */
export const BOX_GLSL = /* glsl */ `
vec2 boxPos() { return vExtra.xy + vQuad * vExtra.zw; }
`;

const WHITE = new Float32Array([1, 1, 1, 1]);

/**
 * Shade the layer-space box `b` with `fragmentShader` (a drawInstancedQuads body using BOX_GLSL),
 * normal-blended over `target`'s content: one quad instead of a full-frame pass, so only the
 * pixels the generator can reach run the shader.
 */
export function drawBox(
  ctx: GeneratorContext,
  target: THREE.WebGLRenderTarget,
  b: Bounds,
  fragmentShader: string,
  uniforms: Record<string, THREE.IUniform>,
) {
  const cx = 0.5 * (b.x0 + b.x1);
  const cy = 0.5 * (b.y0 + b.y1);
  const hw = 0.5 * (b.x1 - b.x0);
  const hh = 0.5 * (b.y1 - b.y0);
  if (!(hw > 0 && hh > 0)) return;
  drawInstancedQuads(ctx, target, {
    count: 1,
    center: new Float32Array([cx, cy]),
    size: new Float32Array([2 * hw, 2 * hh]),
    color: WHITE,
    extra: new Float32Array([cx, cy, hw, hh]),
    toRender: ctx.layerToRender,
    fragmentShader,
    uniforms,
    blend: 'normal',
  });
}

/** Box of an ellipse centred at (cx, cy) with semi-axes `a` (along `angle`, rad CCW) and `b`. */
export function ellipseBox(cx: number, cy: number, a: number, b: number, angle: number): Bounds {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const ex = Math.hypot(a * c, b * s);
  const ey = Math.hypot(a * s, b * c);
  return { x0: cx - ex, y0: cy - ey, x1: cx + ex, y1: cy + ey };
}
