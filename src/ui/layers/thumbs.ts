import { getGenerator } from '../../generators/registry';
import type { Layer, LayerMask, Project } from '../../model/types';
import { useEditor } from '../../store/store';
import { clippedTo, subtreeIds } from '../../store/tree';
import { engineHost } from '../engineHost';

// Layer thumbnails and mask chips for the Layers panel: engine.renderThumb /
// engine.renderMaskPreview on idle after edits settle, cached per layer (per mask) by a content key
// — the object identities of everything the picture draws (the layer, its subtree, the layers
// clipped onto it and their subtrees, and the comp). Edits make new objects only along the
// changed path (store.edit is immutable), so an unchanged key means an unchanged picture and only
// pictures whose content changed are re-rendered.

/** Thumbnail picture size in CSS px: the 24 px `.lp-thumb` box inside its 1 px border; rendered at device pixels. */
const THUMB_CSS = 22;
/** Quiet time after the last project change before thumbnails are re-rendered, in ms. */
const DEBOUNCE_MS = 250;
/** Retry delay while the engine is not up yet, in ms. */
const RETRY_MS = 500;
/** Idle time left below which a flush yields to the next idle period, in ms. */
const MIN_IDLE_MS = 4;

interface Entry {
  key: readonly unknown[];
  img: ImageData | null;
}

const cache = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
let timer: number | undefined;
let unsubscribeStore: (() => void) | null = null;

/**
 * Layers whose pixels the layer's thumbnail draws from: those a generator's layer params pick
 * (emitter / focus shapes) and the sources of its enabled layer masks.
 */
function sourcesOf(byId: ReadonlyMap<string, Layer>, layer: Layer): Layer[] {
  const ids = layer.masks.flatMap((m) => (m.enabled && m.kind === 'layer' ? [m.layerId] : []));
  if (layer.kind === 'generator')
    for (const pd of getGenerator(layer.generator.type)?.params ?? []) if (pd.kind === 'layer') ids.push(String(layer.generator.params[pd.key] ?? ''));
  return ids.flatMap((id) => {
    const src = byId.get(id);
    return src && src !== layer ? [src] : [];
  });
}

/** Everything the layer's thumbnail depends on, by identity. */
function contentKey(project: Project, byId: ReadonlyMap<string, Layer>, layer: Layer): unknown[] {
  const { layers } = project;
  const key: unknown[] = [project.comp, layer];
  for (const drawn of [layer, ...sourcesOf(byId, layer)])
    for (const owner of [drawn, ...clippedTo(layers, drawn.id)]) {
      if (owner !== layer) key.push(owner);
      for (const d of subtreeIds(layers, owner.id)) key.push(byId.get(d));
    }
  return key;
}

/** Thumbnail id of mask `maskId` of layer `layerId` (a layer's own thumbnail goes by the layer id). */
export const maskThumbId = (layerId: string, maskId: string) => `${layerId}/${maskId}`;

/** Everything a mask chip depends on, by identity: the mask, the comp, the layer's transform when linked, a source layer's content. */
function maskKey(project: Project, byId: ReadonlyMap<string, Layer>, layer: Layer, mask: LayerMask): unknown[] {
  if (mask.kind === 'layer') {
    const src = byId.get(mask.layerId);
    return [mask, ...(src ? contentKey(project, byId, src) : [project.comp])];
  }
  return [mask, project.comp, mask.linked ? layer.transform : null];
}

const idle = (cb: (deadline: { timeRemaining(): number }) => void) => {
  if ('requestIdleCallback' in window) window.requestIdleCallback(cb, { timeout: 2000 });
  // Safari: no requestIdleCallback; a macrotask after the current frame's work.
  else setTimeout(() => cb({ timeRemaining: () => 8 }), 0);
};

function schedule(delay = DEBOUNCE_MS) {
  clearTimeout(timer);
  timer = window.setTimeout(() => idle(flush), delay);
}

function flush(deadline: { timeRemaining(): number }) {
  const engine = engineHost.engine;
  if (!engine) return schedule(RETRY_MS);
  const { project } = useEditor.getState();
  const byId = new Map(project.layers.map((l) => [l.id, l]));
  for (const id of cache.keys()) {
    const [layerId, maskId] = id.split('/');
    const layer = byId.get(layerId);
    if (!layer || (maskId !== undefined && !layer.masks.some((m) => m.id === maskId))) cache.delete(id);
  }
  const side = Math.round(THUMB_CSS * devicePixelRatio);
  for (const [id, subs] of listeners) {
    const [layerId, maskId] = id.split('/');
    const layer = byId.get(layerId);
    const mask = maskId === undefined ? null : layer?.masks.find((m) => m.id === maskId);
    if (!layer || mask === undefined) continue;
    const key = mask ? maskKey(project, byId, layer, mask) : contentKey(project, byId, layer);
    const hit = cache.get(id);
    if (hit && hit.key.length === key.length && hit.key.every((x, i) => x === key[i])) continue;
    if (deadline.timeRemaining() < MIN_IDLE_MS) return schedule(0);
    cache.set(id, { key, img: mask ? engine.renderMaskPreview(project, layerId, mask.id, side) : engine.renderThumb(project, id, side) });
    for (const cb of subs) cb();
  }
}

/** useSyncExternalStore subscription for thumbnail `id` (a layer id or maskThumbId); mounting one starts the scheduler. */
export function subscribeThumb(id: string, cb: () => void): () => void {
  let subs = listeners.get(id);
  if (!subs) listeners.set(id, (subs = new Set()));
  subs.add(cb);
  unsubscribeStore ??= useEditor.subscribe((s, prev) => {
    if (s.project !== prev.project) schedule();
  });
  schedule();
  return () => {
    subs.delete(cb);
    if (subs.size) return;
    listeners.delete(id);
    if (listeners.size || !unsubscribeStore) return;
    unsubscribeStore();
    unsubscribeStore = null;
  };
}

/** The cached thumbnail: undefined until first rendered, null when the layer draws nothing (mask chips are never null). */
export const thumbOf = (id: string): ImageData | null | undefined => cache.get(id)?.img;
