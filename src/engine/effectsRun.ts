import type * as THREE from 'three';
import type { EffectInstance } from '../model/types';
import { getEffect } from '../effects/registry';
import type { EffectContext, EffectParams } from './contracts';
import type { Surface } from './surface';

/**
 * `effects` run in order on `input`; returns the result (`input` itself when none is enabled).
 * `input` stays alive as every effect's `content` until the stack is done, then is released
 * unless `keepInput`.
 */
export function applyEffects(layerId: string, effects: EffectInstance[], input: THREE.WebGLRenderTarget, s: Surface, keepInput: boolean): THREE.WebGLRenderTarget {
  let cur = input;
  let ectx: EffectContext | null = null;
  for (const fx of effects) {
    if (!fx.enabled) continue;
    const def = getEffect(fx.type);
    if (!def) continue;
    ectx ??= {
      renderer: s.ctx.renderer,
      kit: s.kit,
      width: s.width,
      height: s.height,
      pxScale: s.scale,
      frame: s.ctx.frame,
      layerId,
      comp: s.ctx.project.comp,
      draft: s.ctx.draft,
      content: input.texture,
    };
    const params: EffectParams = { ...fx.params };
    for (const pd of def.params) if (!(pd.key in params)) params[pd.key] = pd.default;
    const out = s.kit.acquire();
    def.apply(ectx, cur.texture, out, params);
    if (cur !== input) s.kit.release(cur);
    cur = out;
  }
  if (cur !== input && !keepInput) s.kit.release(input);
  return cur;
}
