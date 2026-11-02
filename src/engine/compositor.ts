import * as THREE from 'three';
import type { AdjustmentLayer, Comp, Layer, PartKey } from '../model/types';
import { hasPartEffects, isTitleLayer, layerParts, partEffectsOf } from '../model/parts';
import { adjustmentIsIdentity, applyAdjustment } from './adjustments';
import type { DrawNode, LeafLayer } from './drawTree';
import { effectsAddLight, effectsTraceInk } from '../effects/registry';
import { applyEffects } from './effectsRun';
import { Masks } from './masks';
import type { PassKit } from './passkit';
import { adjustMaterial, backgroundMaterial, BLEND_IDS, blendMaterial, maskMaterial, type Composite } from './shaders';
import { rendererFor, type Surface } from './surface';

const IDENTITY_UV = new THREE.Matrix3();

/** Draws a group's children onto `acc` in place of drawNodes and returns the new acc (interactive reuse, see InteractiveCache). */
export type ChildDrawer = (children: readonly DrawNode[], acc: THREE.WebGLRenderTarget, s: Surface) => THREE.WebGLRenderTarget;

/** renderBackdrop: the adjustment layer to stop at and the buffer it received (a pool RT of the backdrop kit). */
export interface Probe {
  id: string;
  rt: THREE.WebGLRenderTarget | null;
}

/**
 * The layer tree onto pool targets: leaf / group pixels with their effects, clip groups and
 * layer masks, blended onto the backdrop, and adjustment layers applied to it.
 */
export class Compositor {
  private readonly blendMat: THREE.ShaderMaterial;
  private readonly adjustMat: THREE.ShaderMaterial;
  private readonly maskMat: THREE.ShaderMaterial;
  private readonly bgMat: THREE.ShaderMaterial;
  /** Layer masks (LayerBase.masks): rasterised, combined and cached per layer. */
  readonly masks: Masks;
  /** Set by renderBackdrop while it renders (see Probe). */
  probe: Probe | null = null;

  /** `kit`: the pool whose renderer compiles the shaders (they run on any pool of that renderer). */
  constructor(kit: PassKit) {
    this.blendMat = blendMaterial(kit);
    this.adjustMat = adjustMaterial(kit);
    this.maskMat = maskMaterial(kit);
    this.bgMat = backgroundMaterial(kit);
    this.masks = new Masks(kit);
  }

  /** A pool RT of `kit` holding the comp background (transparent or its colour). */
  background(kit: PassKit, comp: Comp): THREE.WebGLRenderTarget {
    const rt = kit.acquire();
    if (comp.background.transparent) kit.clear(rt);
    else {
      const c = new THREE.Color(comp.background.color); // hex is sRGB; Color stores linear
      this.bgMat.uniforms.uColor.value.set(c.r, c.g, c.b, 1);
      kit.run(this.bgMat, rt);
    }
    return rt;
  }

  /** Node `n` rendered alone for a FrameSource: renderBackdrop's probe must not see it. */
  renderAlone(n: DrawNode, s: Surface): THREE.WebGLRenderTarget {
    return this.unprobed(() => this.renderUnit(n, s, null));
  }

  /** Node `n`'s pixels before its own effects for a FrameSource (layerContent), unprobed like renderAlone. */
  renderContent(n: DrawNode, s: Surface): THREE.WebGLRenderTarget {
    return this.unprobed(() => this.unitContent(n, s, false, null).px);
  }

  private unprobed<T>(draw: () => T): T {
    const probe = this.probe;
    this.probe = null;
    try {
      return draw();
    } finally {
      this.probe = probe;
    }
  }

  /**
   * Composite `nodes` (bottom first) onto `acc`, each with its own blend and opacity; returns the
   * new acc (`acc` is released). `mask`: the nodes are clipped, shown only inside its alpha.
   */
  drawNodes(nodes: readonly DrawNode[], acc: THREE.WebGLRenderTarget, s: Surface, mask: THREE.WebGLRenderTarget | null): THREE.WebGLRenderTarget {
    return this.drawInk(nodes, acc, null, s, mask, false).px;
  }

  /**
   * drawNodes (`px`), and with `wantInk` the same composite of the nodes' ink onto `ink` (null:
   * `acc` is all ink so far) as `ink`, null while no light came in. A light-blended generator
   * (isLightBlend) adds nothing to the ink, a node holding light (holdsLight) its own ink, any
   * other node its pixels. `ink` is released / returned like `acc`.
   */
  private drawInk(
    nodes: readonly DrawNode[],
    acc: THREE.WebGLRenderTarget,
    ink: THREE.WebGLRenderTarget | null,
    s: Surface,
    mask: THREE.WebGLRenderTarget | null,
    wantInk: boolean,
  ): { px: THREE.WebGLRenderTarget; ink: THREE.WebGLRenderTarget | null } {
    const { kit } = s;
    for (const n of nodes) {
      // renderBackdrop has what it came for: the rest cannot change it
      if (this.probe?.rt) break;
      if (n.kind === 'adjust') {
        acc = this.adjustOnto(acc, n.layer, s, mask);
        if (ink) ink = this.adjustOnto(ink, n.layer, s, mask);
        continue;
      }
      const light = wantInk && isLightBlend(n.layer);
      const lit = wantInk && !light && this.holdsLight(n, s);
      // A layer some generator or mask of the frame already read alone has these very pixels
      // (without their ink).
      const shared = lit ? null : s.source.shared('alpha', n);
      const unit = shared ? null : this.unit(n, s, null, lit);
      if (unit) s.source.offer('alpha', n, unit.px);
      const px = shared ?? unit!.px.texture;
      if (!ink && (light || unit?.ink)) {
        // the first light: the ink so far is the composite so far
        ink = kit.acquire();
        kit.copy(acc.texture, ink);
      }
      acc = this.blendOnto(kit, acc, px, n.layer.transform.opacity, n.layer.blend, IDENTITY_UV, mask);
      if (ink && !light) ink = this.blendOnto(kit, ink, unit?.ink?.texture ?? px, n.layer.transform.opacity, n.layer.blend, IDENTITY_UV, mask);
      if (unit) kit.release(unit.px);
      if (unit?.ink) kit.release(unit.ink);
    }
    return { px: acc, ink };
  }

  /**
   * Post-effects pixels of a leaf / group node together with its clip group, before its own
   * blend / opacity (a pool RT of `s.kit`; caller releases). Clip group (Photoshop): the base
   * with its effects at full strength, then each clipped node with its own blend, opacity and
   * effects inside the base's content alpha (its pixels before any effect, part effects
   * included); clipped adjustments adjust that buffer inside the same alpha. Last, the node's
   * layer masks multiply the whole (a clip base's masks shape its clip group, a group's its
   * composite). `drawChildren`: a top-level group while interactive, see
   * InteractiveCache.drawChildrenCached.
   */
  renderUnit(n: DrawNode, s: Surface, drawChildren: ChildDrawer | null): THREE.WebGLRenderTarget {
    return this.unit(n, s, drawChildren, false).px;
  }

  /**
   * renderUnit (`px`), and with `wantInk` the ink of those pixels (`ink`, the caller releases it;
   * null while they hold no light). The content's ink is rendered only when an outline effect of
   * the node traces it or the caller wants the node's ink, and light is in it (contentLight).
   */
  private unit(n: DrawNode, s: Surface, drawChildren: ChildDrawer | null, wantInk: boolean): { px: THREE.WebGLRenderTarget; ink: THREE.WebGLRenderTarget | null } {
    const clip = n.clipped.length > 0;
    const contentInk = (wantInk || effectsTraceInk(n.layer.effects)) && n.kind !== 'adjust' && this.contentLight(n, s);
    const { px, mask, ink } = this.unitContent(n, s, clip, drawChildren, contentInk);
    const post = applyEffects(n.layer.id, n.layer.effects, px, s, clip && mask === px, ink, wantInk);
    if (!clip) return { px: this.masks.apply(n.layer, post.px, s), ink: post.ink && this.masks.apply(n.layer, post.ink, s) };
    let buf = post.px;
    if (buf === mask) {
      // no base effects ran: the clip group needs a buffer of its own, the mask stays intact
      buf = s.kit.acquire();
      s.kit.copy(mask.texture, buf);
    }
    const drawn = this.drawInk(n.clipped, buf, post.ink, s, mask, wantInk);
    s.kit.release(mask);
    return { px: this.masks.apply(n.layer, drawn.px, s), ink: drawn.ink && this.masks.apply(n.layer, drawn.ink, s) };
  }

  /**
   * Whether node `n`'s post-effects pixels (its clip group included) may hold light: light
   * effects (EffectDef.addsLight), light in its content (contentLight) or in a clipped node.
   */
  private holdsLight(n: DrawNode, s: Surface): boolean {
    if (effectsAddLight(n.layer.effects)) return true;
    if (n.clipped.some((c) => c.kind !== 'adjust' && (isLightBlend(c.layer) || this.holdsLight(c, s)))) return true;
    return n.kind !== 'adjust' && this.contentLight(n, s);
  }

  /**
   * Whether the pixels of leaf / group `n` before its own effects may hold light: the light its
   * renderer adds (LayerRenderer.addsLight) or its part effects add, or, in a group, a child
   * holding light or blended as light (isLightBlend).
   */
  private contentLight(n: Exclude<DrawNode, { kind: 'adjust' }>, s: Surface): boolean {
    if (n.kind === 'group') return n.children.some((c) => c.kind !== 'adjust' && (isLightBlend(c.layer) || this.holdsLight(c, s)));
    const l = n.layer;
    if (rendererFor(l, s.renderers).addsLight?.(l)) return true;
    return isTitleLayer(l) && hasPartEffects(l) && layerParts(l).some((p) => effectsAddLight(partEffectsOf(l, p)));
  }

  /**
   * A leaf / group node's pixels before its own effects (`px`: what they get as content), and with
   * `wantMask` its content alpha for a clip group (see renderLeafContent; a group's is `px`). With
   * `wantInk` (light is in them, contentLight), `ink`: those pixels without that light (null when
   * they turn out to hold none).
   */
  private unitContent(
    n: DrawNode,
    s: Surface,
    wantMask: boolean,
    drawChildren: ChildDrawer | null,
    wantInk = false,
  ): { px: THREE.WebGLRenderTarget; mask: THREE.WebGLRenderTarget; ink: THREE.WebGLRenderTarget | null } {
    // content another reader had rendered comes without its ink: render both here
    const shared = wantMask || wantInk ? null : s.source.shared('content', n);
    if (shared) {
      const px = s.kit.acquire();
      s.kit.copy(shared, px);
      return { px, mask: px, ink: null };
    }
    const out = this.ownContent(n, s, wantMask, drawChildren, wantInk);
    if (!wantMask) s.source.offer('content', n, out.px);
    return out;
  }

  /** unitContent rendered (see there). */
  private ownContent(
    n: DrawNode,
    s: Surface,
    wantMask: boolean,
    drawChildren: ChildDrawer | null,
    wantInk: boolean,
  ): { px: THREE.WebGLRenderTarget; mask: THREE.WebGLRenderTarget; ink: THREE.WebGLRenderTarget | null } {
    switch (n.kind) {
      case 'group': {
        // isolated, like a Photoshop group set to Normal
        const buf = s.kit.acquire();
        s.kit.clear(buf);
        if (wantInk) {
          // the interactive reuse keeps no ink: drawn afresh
          const { px, ink } = this.drawInk(n.children, buf, null, s, null, true);
          return { px, mask: px, ink };
        }
        const px = drawChildren ? drawChildren(n.children, buf, s) : this.drawNodes(n.children, buf, s, null);
        return { px, mask: px, ink: null };
      }
      case 'leaf':
        return this.renderLeafContent(n.layer, s, wantMask, wantInk);
      case 'adjust':
        throw new Error('adjustment layers are never rendered alone');
    }
  }

  /**
   * A leaf's pixels before its layer effects (`px`), and with `wantMask` its content alpha for a
   * clip group (`mask`: the same RT as `px` unless part effects ran), with `wantInk` its ink (see
   * unitContent): each run's ink through its part effects, composited like the runs. A title
   * with part effects renders part by part, back to front: consecutive parts without enabled
   * effects in one render, each part with effects alone through its own effect chain. 2D runs
   * stack Normal, as the renderer stacks its parts. 3D runs partition the anti-aliased coverage
   * (depth prepass), so they stack 'disjoint' (an exact sum at seams between parts, plain over
   * where a part's effect spills onto opaque parts in front), and the matte shadow (`parts: []`,
   * see LayerRenderContext.parts) goes under the stack with Normal.
   */
  private renderLeafContent(
    layer: LeafLayer,
    s: Surface,
    wantMask: boolean,
    wantInk: boolean,
  ): { px: THREE.WebGLRenderTarget; mask: THREE.WebGLRenderTarget; ink: THREE.WebGLRenderTarget | null } {
    const { kit, ctx } = s;
    const renderer = rendererFor(layer, s.renderers);
    if (!isTitleLayer(layer) || !hasPartEffects(layer)) {
      const rt = kit.acquire();
      const ink = wantInk && renderer.addsLight?.(layer) ? kit.acquire() : null;
      if (ink) {
        // cleared: what the renderer leaves undrawn is empty, as in `rt`
        kit.clear(ink);
        ctx.ink = ink;
      }
      try {
        if (layer.kind === 'generator') s.source.drawing(layer.id, () => renderer.render(layer, ctx, rt));
        else renderer.render(layer, ctx, rt);
      } finally {
        ctx.ink = undefined;
      }
      return { px: rt, mask: rt, ink };
    }
    const stack: Composite = layer.kind === 'title3d' ? 'disjoint' : 'normal';
    const parts = layerParts(layer);
    const withFx = parts.map((p) => partEffectsOf(layer, p).some((e) => e.enabled));
    // each run's own ink when the renderer adds light
    const runInks = wantInk && !!renderer.addsLight?.(layer);
    let acc: THREE.WebGLRenderTarget | null = null;
    let mask: THREE.WebGLRenderTarget | null = null;
    let ink: THREE.WebGLRenderTarget | null = null;
    if (wantMask) {
      mask = kit.acquire();
      kit.clear(mask);
    }
    const renderRun = (run: readonly PartKey[], runInk: THREE.WebGLRenderTarget | null) => {
      const rt = kit.acquire();
      ctx.parts = run;
      if (runInk) {
        kit.clear(runInk);
        ctx.ink = runInk;
      }
      try {
        renderer.render(layer, ctx, rt);
      } finally {
        ctx.parts = undefined;
        ctx.ink = undefined;
      }
      return rt;
    };
    for (let i = 0; i < parts.length; ) {
      const alone = withFx[i];
      let j = i + 1;
      if (!alone) while (j < parts.length && !withFx[j]) j++;
      const runInk = runInks ? kit.acquire() : null;
      const rt = renderRun(parts.slice(i, j), runInk);
      if (mask) mask = this.blendOnto(kit, mask, rt.texture, 1, stack, IDENTITY_UV, null);
      const post = alone ? applyEffects(`${layer.id}#${parts[i]}`, partEffectsOf(layer, parts[i]), rt, s, false, runInk, wantInk) : { px: rt, ink: runInk };
      if (wantInk) {
        if (ink) {
          ink = this.blendOnto(kit, ink, (post.ink ?? post.px).texture, 1, stack, IDENTITY_UV, null);
          if (post.ink) kit.release(post.ink);
        } else if (post.ink) ink = post.ink;
        else {
          ink = kit.acquire();
          kit.copy(post.px.texture, ink);
        }
      }
      if (acc) {
        acc = this.blendOnto(kit, acc, post.px.texture, 1, stack, IDENTITY_UV, null);
        kit.release(post.px);
      } else acc = post.px;
      i = j;
    }
    if (!acc) {
      acc = kit.acquire();
      kit.clear(acc);
    }
    if (layer.kind === 'title3d' && layer.style3d.shadow.enabled) {
      const shadow = renderRun([], null);
      for (const over of [mask, ink]) {
        if (!over) continue;
        const under = kit.acquire();
        kit.copy(shadow.texture, under);
        const next = this.blendOnto(kit, under, over.texture, 1, 'normal', IDENTITY_UV, null);
        kit.release(over);
        if (over === mask) mask = next;
        else ink = next;
      }
      const next = this.blendOnto(kit, shadow, acc.texture, 1, 'normal', IDENTITY_UV, null);
      kit.release(acc);
      acc = next;
    }
    return { px: acc, mask: mask ?? acc, ink };
  }

  /**
   * Adjustment layer `layer` applied to `acc` (the parent's buffer so far, or the clip group's
   * with `mask` = its base's content alpha); returns the new acc (`acc` is released). The
   * adjustment (skipped when identity, `effectsOnly` included), then the layer's enabled effects
   * on that adjusted buffer, then the opacity × mask × layer masks / blend mix over `acc`
   * (adjustMat): the layer masks limit where it applies. Without a colour change or enabled
   * effects `acc` passes through. renderBackdrop's probe copies what it receives (before the
   * adjustment and its effects) and stops there.
   */
  adjustOnto(acc: THREE.WebGLRenderTarget, layer: AdjustmentLayer, s: Surface, mask: THREE.WebGLRenderTarget | null): THREE.WebGLRenderTarget {
    const { kit } = s;
    if (this.probe && this.probe.id === layer.id && !this.probe.rt) {
      const rt = kit.acquire();
      if (mask) {
        this.maskMat.uniforms.tSrc.value = acc.texture;
        this.maskMat.uniforms.tMask.value = mask.texture;
        kit.run(this.maskMat, rt);
      } else kit.copy(acc.texture, rt);
      this.probe.rt = rt;
      // renderBackdrop has what it came for: adjusting and running the effects would be wasted
      return acc;
    }
    let adjusted: THREE.WebGLRenderTarget;
    if (adjustmentIsIdentity(layer.adjustment)) {
      adjusted = applyEffects(layer.id, layer.effects, acc, s, true).px;
      if (adjusted === acc) return acc;
    } else {
      adjusted = kit.acquire();
      applyAdjustment(kit, acc.texture, layer.adjustment, adjusted);
      adjusted = applyEffects(layer.id, layer.effects, adjusted, s, false).px;
    }
    const opacity = Math.min(1, layer.transform.opacity);
    const layerMask = this.masks.combined(layer, s);
    if (opacity >= 1 && layer.blend === 'normal' && !mask && !layerMask) {
      kit.release(acc);
      return adjusted;
    }
    const next = kit.acquire();
    const u = this.adjustMat.uniforms;
    u.tDst.value = acc.texture;
    u.tSrc.value = adjusted.texture;
    u.tMask.value = mask?.texture ?? null;
    u.uMasked.value = mask !== null;
    u.tLayerMask.value = layerMask;
    u.uLayerMasked.value = layerMask !== null;
    u.uOpacity.value = opacity;
    u.uMode.value = BLEND_IDS[layer.blend];
    kit.run(this.adjustMat, next);
    kit.release(adjusted);
    kit.release(acc);
    return next;
  }

  /**
   * `src` (sampled through `srcUv`, inside `mask`'s alpha when given) blended over `dst`;
   * returns the new pool RT, `dst` is released.
   */
  blendOnto(
    kit: PassKit,
    dst: THREE.WebGLRenderTarget,
    src: THREE.Texture,
    opacity: number,
    blend: Composite,
    srcUv: THREE.Matrix3,
    mask: THREE.WebGLRenderTarget | null,
  ) {
    const next = kit.acquire();
    const u = this.blendMat.uniforms;
    u.tDst.value = dst.texture;
    u.tSrc.value = src;
    u.tMask.value = mask?.texture ?? null;
    u.uMasked.value = mask !== null;
    u.uSrcUv.value.copy(srcUv);
    u.uOpacity.value = Math.min(1, opacity);
    u.uMode.value = BLEND_IDS[blend];
    kit.run(this.blendMat, next);
    kit.release(dst);
    return next;
  }
}

/** A generator layer blended as light (Add / Screen: glints, flares, sparkles): light, not ink, in what it is drawn onto. */
function isLightBlend(layer: Layer): boolean {
  return layer.kind === 'generator' && (layer.blend === 'add' || layer.blend === 'screen');
}
