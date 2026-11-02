import type * as THREE from 'three';
import type { Comp, EffectInstance, Layer, Project } from '../model/types';
import { isTitleLayer } from '../model/parts';
import { getEffect } from '../effects/registry';
import { inkBounds } from '../effects/lib';
import { getGenerator } from '../generators/registry';
import type { Bounds } from '../text/layout';
import type { LayerSource, ParamDef } from './contracts';
import { drawnLayers, drawTree, findNode, inspectView, type DrawNode } from './drawTree';
import { frameKey } from './frame';
import type { Surface } from './surface';

/** A project's layers as FrameSource draws them alone. Memoized per project snapshot. */
interface Isolation {
  project: Project;
  /** The project's layers (bottom first) and by id: the objects reuse checks and alpha keys compare. */
  layers: readonly Layer[];
  byId: Map<string, Layer>;
  /** Per layer id, built on demand: see `aloneView`. */
  views: Map<string, { view: Project; node: DrawNode | null }>;
}

const isolations = new WeakMap<Project, Isolation>();

export function isolation(project: Project): Isolation {
  let iso = isolations.get(project);
  if (!iso) {
    iso = { project, layers: project.layers, byId: new Map(project.layers.map((l) => [l.id, l])), views: new Map() };
    isolations.set(project, iso);
  }
  return iso;
}

/**
 * Layer `id` as a FrameSource draws it, like a thumbnail: the project of inspectView (it and its
 * groups shown, no solo) with the comp kept, and its node there with guides drawn (null when it
 * still draws nothing).
 */
function aloneView(iso: Isolation, id: string): { view: Project; node: DrawNode | null } {
  let a = iso.views.get(id);
  if (!a) {
    const view = { ...inspectView(iso.project, id), comp: iso.project.comp };
    a = { view, node: findNode(drawTree(view, true), id) };
    iso.views.set(id, a);
  }
  return a;
}

/** Ids of the layers `l` reads: through 'layer' params (its generator's and its enabled (part) effects') and its enabled layer masks. */
function layerRefs(l: Layer): string[] {
  const out: string[] = [];
  const scan = (defs: readonly ParamDef[] | undefined, params: Record<string, unknown>) => {
    for (const pd of defs ?? []) {
      const v = params[pd.key];
      if (pd.kind === 'layer' && typeof v === 'string' && v) out.push(v);
    }
  };
  const scanFx = (list: readonly EffectInstance[] | undefined) => {
    for (const fx of list ?? []) if (fx.enabled) scan(getEffect(fx.type)?.params, fx.params);
  };
  if (l.kind === 'generator') scan(getGenerator(l.generator.type)?.params, l.generator.params);
  scanFx(l.effects);
  if (isTitleLayer(l)) for (const list of Object.values(l.partEffects)) scanFx(list);
  for (const m of l.masks) if (m.enabled && m.kind === 'layer' && m.layerId) out.push(m.layerId);
  return out;
}

/**
 * Adds to `out` (id → layer object of `iso`, undefined when missing) every layer whose change could
 * change layer `id` drawn alone: it and its ancestors, with the clip-group siblings below each down
 * to its clip base (they decide whether it draws), the layers drawn with it, and recursively the
 * layers those read (layerRefs: 'layer' params and layer masks).
 */
function sourceDeps(iso: Isolation, id: string, out: Map<string, Layer | undefined>, seen = new Set<string>()) {
  if (seen.has(id)) return;
  seen.add(id);
  const own = iso.byId.get(id);
  if (!own) {
    out.set(id, undefined);
    return;
  }
  const chain = new Set<string>();
  for (let l: Layer | undefined = own; l && !chain.has(l.id); l = l.parentId !== undefined ? iso.byId.get(l.parentId) : undefined) {
    chain.add(l.id);
    out.set(l.id, l);
    if (!l.clip) continue;
    for (let j = iso.layers.indexOf(l) - 1; j >= 0; j--) {
      const b = iso.layers[j];
      if (b.parentId !== l.parentId) continue;
      out.set(b.id, b);
      if (!b.clip) break;
    }
  }
  const { node } = aloneView(iso, id);
  if (!node) return;
  for (const l of drawnLayers([node])) {
    out.set(l.id, iso.byId.get(l.id));
    for (const ref of layerRefs(l)) sourceDeps(iso, ref, out, seen);
  }
}

/** sourceDeps of every layer node `n`'s drawn layers read through 'layer' params or layer masks (empty for most nodes). */
export function nodeDeps(n: DrawNode, project: Project): Map<string, Layer | undefined> {
  const out = new Map<string, Layer | undefined>();
  const seen = new Set<string>();
  let iso: Isolation | null = null;
  for (const l of drawnLayers([n])) for (const ref of layerRefs(l)) sourceDeps((iso ??= isolation(project)), ref, out, seen);
  return out;
}

const versions = new WeakMap<object, number>();
let lastVersion = 0;
/** A number per object identity (the store never mutates: a changed layer or mask is a new object). */
export function version(o: object): number {
  let v = versions.get(o);
  if (v === undefined) versions.set(o, (v = ++lastVersion));
  return v;
}

/** What FrameSource needs of the engine. */
export interface SourceHost {
  /** Node `n` rendered alone on `s` (renderUnit); a pool RT of `s.kit`. */
  renderAlone(n: DrawNode, s: Surface): THREE.WebGLRenderTarget;
  /** Node `n`'s pixels before its own effects on `s` (what its effects get as content); a pool RT of `s.kit`. */
  renderContent(n: DrawNode, s: Surface): THREE.WebGLRenderTarget;
  /** Comp-px box of the alpha of `tex` (render size of `s`), null when empty. */
  measure(tex: THREE.Texture, s: Surface): Bounds | null;
}

/**
 * LayerSource of one surface for one frame (GeneratorContext.layerAlpha / layerAlphaKey /
 * layerBounds / layerContent / layerContentKey, and the sources of layer masks, see masks.ts).
 * Cost: each id asked for renders once per frame — renderUnit of its node drawn alone like a
 * thumbnail (`aloneView`: shown even when hidden, solo ignored, guides drawn) at the surface's
 * size, draft and renderers; its content (the node before its own effects) separately, once —
 * and is kept until `close()` at the end of the frame; layerBounds adds one 1×1 GPU readback per
 * id; the keys do no GPU work. Cycle rule: a generator is marked while it renders, a masked
 * layer while its masks render (`drawing`); an id that is marked, or whose node draws a marked
 * layer (a group or clip base holding it), gives null — not cached, as it depends on who asks.
 */
export class FrameSource implements LayerSource {
  private readonly alphas = new Map<string, THREE.WebGLRenderTarget>();
  private readonly contents = new Map<string, THREE.WebGLRenderTarget>();
  private readonly boxes = new Map<string, Bounds | null>();
  private readonly active = new Set<string>();
  private readonly base: Omit<Surface, 'source'>;
  /** Comp the keys name: the preview's own, also for its reduced-scale surface. */
  private readonly keyComp: Comp;
  private readonly host: SourceHost;
  private iso: Isolation | null = null;

  constructor(base: Omit<Surface, 'source'>, keyComp: Comp, host: SourceHost) {
    this.base = base;
    this.keyComp = keyComp;
    this.host = host;
  }

  /** Run `draw` with layer `id` marked as rendering (a generator, or a layer whose masks render); returns its result. */
  drawing<T>(id: string, draw: () => T): T {
    const marked = this.active.has(id);
    this.active.add(id);
    try {
      return draw();
    } finally {
      if (!marked) this.active.delete(id);
    }
  }

  private isolation(): Isolation {
    return (this.iso ??= isolation(this.base.ctx.project));
  }

  /** The node `id` draws alone with its project, or null when it gives no alpha (see GeneratorContext.layerAlpha). */
  private node(id: string): { view: Project; node: DrawNode } | null {
    if (!id || this.active.has(id) || !this.isolation().byId.has(id)) return null;
    const { view, node } = aloneView(this.isolation(), id);
    if (!node || node.kind === 'adjust') return null;
    if (this.active.size && drawnLayers([node]).some((l) => this.active.has(l.id))) return null;
    return { view, node };
  }

  alpha(id: string): THREE.Texture | null {
    return this.rendered(id, this.alphas, (n, s) => this.host.renderAlone(n, s));
  }

  /** Ids some layer of the frame reads (layer params, layer masks): the ones worth sharing (see offer). */
  private wanted: Set<string> | null = null;

  /** The main pass's node `n` draws exactly what its layer's alone view does (the same layer objects), so their pixels are the same. */
  private matches(n: DrawNode): boolean {
    const alone = aloneView(this.isolation(), n.layer.id).node;
    if (!alone) return false;
    const a = drawnLayers([alone]);
    const b = drawnLayers([n]);
    // inspectView lifts the layer and its groups (shown, no solo): a copy, the same when they already were.
    const lifted = (x: Layer, y: Layer) =>
      x.id === y.id && y.visible && !y.solo && Object.keys(x).every((k) => k === 'visible' || k === 'solo' || x[k as keyof Layer] === y[k as keyof Layer]);
    return a.length === b.length && a.every((l, i) => l === b[i] || lifted(l, b[i]));
  }

  /**
   * Pixels of node `n` this frame already has (`kind` 'alpha': drawn whole, 'content': before its
   * own effects), for the compositor to use instead of rendering the node again; valid until the
   * frame ends.
   */
  shared(kind: 'alpha' | 'content', n: DrawNode): THREE.Texture | null {
    const rt = (kind === 'alpha' ? this.alphas : this.contents).get(n.layer.id);
    return rt && this.matches(n) ? rt.texture : null;
  }

  /**
   * The compositor drew node `n` as `rt` (`kind` as for `shared`): keeps a copy when a layer of the
   * frame reads it, so a follow generator, a layer mask or a speed-lines focus costs no second
   * render of that layer (one drawn above its source).
   */
  offer(kind: 'alpha' | 'content', n: DrawNode, rt: THREE.WebGLRenderTarget) {
    const cache = kind === 'alpha' ? this.alphas : this.contents;
    const id = n.layer.id;
    this.wanted ??= new Set(this.isolation().layers.flatMap(layerRefs));
    if (cache.has(id) || !this.wanted.has(id) || !this.matches(n)) return;
    const copy = this.base.kit.acquire();
    this.base.kit.copy(rt.texture, copy);
    cache.set(id, copy);
  }

  content(id: string): THREE.Texture | null {
    return this.rendered(id, this.contents, (n, s) => this.host.renderContent(n, s));
  }

  /** Layer `id`'s node drawn by `draw` (cached in `cache` for the frame), or null (see `node`). */
  private rendered(id: string, cache: Map<string, THREE.WebGLRenderTarget>, draw: (n: DrawNode, s: Surface) => THREE.WebGLRenderTarget): THREE.Texture | null {
    const a = this.node(id);
    if (!a) return null;
    let rt = cache.get(id);
    if (!rt) {
      rt = draw(a.node, { ...this.base, ctx: { ...this.base.ctx, project: a.view }, source: this });
      cache.set(id, rt);
    }
    return rt.texture;
  }

  alphaKey(id: string): string | null {
    if (!this.node(id)) return null;
    const deps = new Map<string, Layer | undefined>();
    sourceDeps(this.isolation(), id, deps);
    const { width, height, scale, ctx } = this.base;
    let key = `${width}x${height}${frameKey(ctx.frame, width, height)}@${scale}${ctx.draft ? 'd' : ''}:${version(this.keyComp)}`;
    for (const [depId, l] of deps) key += `|${depId}:${l ? version(l) : '-'}`;
    return key;
  }

  /** The content depends on a subset of what the alpha does: the alpha's key, marked as content's. */
  contentKey(id: string): string | null {
    const k = this.alphaKey(id);
    return k === null ? null : `c:${k}`;
  }

  bounds(id: string): Bounds | null {
    const tex = this.alpha(id);
    if (!tex) return null;
    let b = this.boxes.get(id);
    if (b === undefined) this.boxes.set(id, (b = this.host.measure(tex, { ...this.base, source: this })));
    return b;
  }

  /** Release the rendered alphas and contents to the pool. */
  close() {
    for (const rt of this.alphas.values()) this.base.kit.release(rt);
    for (const rt of this.contents.values()) this.base.kit.release(rt);
    this.alphas.clear();
    this.contents.clear();
    this.boxes.clear();
  }
}

/** Comp-px box (origin comp centre, +y up) of the alpha of `tex` (render size and frame of `s`): a GPU reduction and a 1×1 readback; null when empty. */
export function measureAlpha(tex: THREE.Texture, s: Surface): Bounds | null {
  return inkBounds({ renderer: s.ctx.renderer, kit: s.kit, width: s.width, height: s.height, pxScale: s.scale, frame: s.ctx.frame, layerId: '', comp: s.ctx.project.comp, draft: s.ctx.draft }, tex);
}
