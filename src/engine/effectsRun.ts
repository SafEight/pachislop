import type * as THREE from 'three';
import type { EffectInstance } from '../model/types';
import { getEffect } from '../effects/registry';
import type { EffectContext, EffectDef, EffectParams } from './contracts';
import type { Surface } from './surface';

/**
 * `effects` run in order on `input`; `px` is the result (`input` itself when none is enabled).
 * `input` stays alive as every effect's `content` until the stack is done, then is released
 * unless `keepInput`.
 *
 * Light is never traced by outline effects (EffectDef.outline): they get the ink, the stack
 * with every light effect (EffectDef.addsLight) left out, as `ctx.inputInk`, and `inputInk` (the
 * input without the light in it: its renderer's own, the 3D glint, or its children's in a group)
 * as `ctx.ink`. Once light is in the stack and an outline effect is still to come, the ink
 * effects in between run a second time on that ink (with `content` = the input's ink). With
 * `wantInk` that ink runs to the end of the stack and comes back as `ink` (null while the result
 * holds no light: it is all ink), for a caller that composites it on (a part of a title, a
 * group's child); the caller then owns it. `inputInk` is released here otherwise. Without light
 * before an outline effect (or anywhere, with `wantInk`) nothing extra runs.
 */
export function applyEffects(
  layerId: string,
  effects: EffectInstance[],
  input: THREE.WebGLRenderTarget,
  s: Surface,
  keepInput: boolean,
  inputInk: THREE.WebGLRenderTarget | null = null,
  wantInk = false,
): { px: THREE.WebGLRenderTarget; ink: THREE.WebGLRenderTarget | null } {
  const run: { def: EffectDef; params: EffectParams }[] = [];
  let lastOutline = -1;
  for (const fx of effects) {
    if (!fx.enabled) continue;
    const def = getEffect(fx.type);
    if (!def) continue;
    const params: EffectParams = { ...fx.params };
    for (const pd of def.params) if (!(pd.key in params)) params[pd.key] = pd.default;
    if (def.outline) lastOutline = run.length;
    run.push({ def, params });
  }
  // the ink is still needed after the effects before this index
  const inkUntil = wantInk ? run.length : lastOutline;
  const { kit } = s;
  let cur = input;
  // the stack's ink while it is carried and light is in the stack (else null)
  let ink: THREE.WebGLRenderTarget | null = inputInk;
  let ectx: EffectContext | null = null;
  let inkCtx: EffectContext | null = null;
  const drop = (rt: THREE.WebGLRenderTarget) => {
    if (rt !== input && rt !== cur && rt !== ink) kit.release(rt);
  };
  const dropInk = () => {
    const prev = ink;
    ink = null;
    if (prev) drop(prev);
  };
  for (let i = 0; i < run.length; i++) {
    const { def, params } = run[i];
    ectx ??= {
      renderer: s.ctx.renderer,
      kit,
      width: s.width,
      height: s.height,
      pxScale: s.scale,
      frame: s.ctx.frame,
      layerId,
      comp: s.ctx.project.comp,
      draft: s.ctx.draft,
      content: input.texture,
      ink: (inputInk ?? input).texture,
      inputInk: input.texture,
    };
    ectx.inputInk = def.outline && ink ? ink.texture : cur.texture;
    const out = kit.acquire();
    def.apply(ectx, cur.texture, out, params);
    if (i < inkUntil) {
      if (def.addsLight?.(params)) {
        // the light stays out of the ink: the stack before it is the ink from here on
        ink ??= cur;
      } else if (ink) {
        // the same effect on the ink alone (its own layer id: what effects keep per layer stays apart)
        inkCtx ??= { ...ectx, layerId: `${layerId}~ink`, content: ectx.ink };
        inkCtx.inputInk = ink.texture;
        const inkOut = kit.acquire();
        def.apply(inkCtx, ink.texture, inkOut, params);
        const prev = ink;
        ink = inkOut;
        drop(prev);
      }
    } else dropInk();
    const prev = cur;
    cur = out;
    drop(prev);
  }
  if (!wantInk) dropInk();
  else if (ink === input && keepInput) {
    // the caller keeps `input` itself: the ink is a target of its own
    const own = kit.acquire();
    kit.copy(input.texture, own);
    ink = own;
  }
  if (cur !== input && !keepInput && ink !== input) kit.release(input);
  return { px: cur, ink };
}
