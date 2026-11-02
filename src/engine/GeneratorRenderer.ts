import * as THREE from 'three';
import { generatorParams, getGenerator } from '../generators/registry';
import type { Layer, Transform } from '../model/types';
import type { GeneratorContext, LayerRenderContext, LayerRenderer, LayerSource, RenderFrame } from './contracts';
import { centreX, centreY } from './frame';

const DEG = Math.PI / 180;

/**
 * Layer space of a generator layer (comp px, origin at the layer position, +y up, mirrored by
 * flipX / flipY, then turned by rotZ — positive turns clockwise on screen — and scaled by `scale`)
 * → render px of a target of the frame `frame` at `pxScale` (the comp centre at centreX / centreY);
 * written into `out`. rotX / rotY / z do not apply: generators are flat screen-plane content.
 */
export function generatorLayerToRender(t: Transform, frame: RenderFrame, pxScale: number, out: THREE.Matrix3): THREE.Matrix3 {
  const r = -t.rotZ * DEG;
  const c = Math.cos(r) * t.scale * pxScale;
  const s = Math.sin(r) * t.scale * pxScale;
  const fx = t.flipX ? -1 : 1;
  const fy = t.flipY ? -1 : 1;
  return out.set(c * fx, -s * fy, t.x * pxScale + centreX(frame), s * fx, c * fy, t.y * pxScale + centreY(frame), 0, 0, 1);
}

/** No other layers to read (a render without a frame source): every lookup is null. */
const NO_SOURCE: LayerSource = { alpha: () => null, alphaKey: () => null, bounds: () => null, content: () => null, contentKey: () => null };

/**
 * Draws a GeneratorLayer through its GeneratorDef (src/generators/registry.ts); an unknown type
 * draws nothing. Stateless: generators cache what they need per def.
 */
class GeneratorRenderer implements LayerRenderer {
  private readonly layerToRender = new THREE.Matrix3();

  render(layer: Layer, ctx: LayerRenderContext, target: THREE.WebGLRenderTarget): void {
    const def = layer.kind === 'generator' ? getGenerator(layer.generator.type) : undefined;
    if (layer.kind !== 'generator' || !def) {
      ctx.kit.clear(target);
      return;
    }
    const src = ctx.layerSource ?? NO_SOURCE;
    const gctx: GeneratorContext = {
      renderer: ctx.renderer,
      kit: ctx.kit,
      width: ctx.width,
      height: ctx.height,
      pxScale: ctx.pxScale,
      frame: ctx.frame,
      comp: ctx.project.comp,
      layerId: layer.id,
      draft: ctx.draft,
      layerToRender: generatorLayerToRender(layer.transform, ctx.frame, ctx.pxScale, this.layerToRender),
      layerAlpha: (id) => src.alpha(id),
      layerAlphaKey: (id) => src.alphaKey(id),
      layerBounds: (id) => src.bounds(id),
      layerContent: (id) => src.content(id),
      layerContentKey: (id) => src.contentKey(id),
    };
    def.render(gctx, target, generatorParams(layer.generator));
  }

  dispose(): void {}
}

export function createGeneratorRenderer(): LayerRenderer {
  return new GeneratorRenderer();
}
