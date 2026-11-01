import { shapeSource, uid } from '../model/defaults';
import { isTitleLayer } from '../model/parts';
import type { GradientMask, Layer, LayerMask, LayerSourceMask, Project, ShapeKind, ShapeMask } from '../model/types';
import type { Bounds } from '../text/layout';
import { layerCompBounds, layerLocalBounds } from '../ui/viewport/geometry';
import { relinkMask } from '../ui/viewport/mask';
import type { Slice } from './core';
import { commit } from './history';
import { swapImageAsset } from './imageOps';
import { maskLabel } from './labels';
import { msg } from './msg';
import { ancestorsOf, subtreeIds } from './tree';

// Layer masks: add (fitted to the layer), edit, show / hide, reorder, delete, apply (bake into an image).

type Own<M> = Partial<Omit<M, 'id' | 'kind'>>;
/** Fields of one mask to change (never its id or kind). */
export type MaskPatch = Own<ShapeMask> | Own<GradientMask> | Own<LayerSourceMask>;

/** What a new mask is: a vector shape, a linear / radial gradient, or another layer's pixels. */
export interface AddMaskOpts {
  /** Shape masks: the shape (default 'rect'). */
  shape?: ShapeKind;
  /** Gradient masks: the gradient shape (default 'linear'). */
  gradient?: GradientMask['shape'];
  /** Layer masks: the source layer (default: the nearest usable layer above, else below). */
  source?: string;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Shapes that stretch to fill the whole box; the others keep their own proportions and fit inside it. */
const FILLS_BOX: Partial<Record<ShapeKind, true>> = { rect: true, ellipse: true, orb: true };

/**
 * The box a new mask is fitted to and the space it lives in: the layer's content box in layer
 * space (linked) when it has one, else a group's children's comp box, else the comp (unlinked).
 */
function maskFrame(project: Project, layer: Layer): { linked: boolean; box: Bounds } {
  const local = layerLocalBounds(layer);
  if (local) return { linked: true, box: local };
  const kids = subtreeIds(project.layers, layer.id)
    .map((id) => project.layers.find((l) => l.id === id))
    .flatMap((l) => (l ? [layerCompBounds(l)] : []))
    .filter((b): b is Bounds => b !== null);
  if (kids.length)
    return {
      linked: false,
      box: { x0: Math.min(...kids.map((b) => b.x0)), y0: Math.min(...kids.map((b) => b.y0)), x1: Math.max(...kids.map((b) => b.x1)), y1: Math.max(...kids.map((b) => b.y1)) },
    };
  const { width: w, height: h } = project.comp;
  return { linked: false, box: { x0: -w / 2, y0: -h / 2, x1: w / 2, y1: h / 2 } };
}

/**
 * The layer a new layer mask reads by default: the nearest title, generator or group layer (what
 * the mask's layer picker lists) above `layer` in the stack, else below, that isn't itself, its
 * group or inside it.
 */
function defaultSource(project: Project, layer: Layer): string | null {
  const L = project.layers;
  const skip = new Set([layer.id, ...ancestorsOf(L, layer.id).map((g) => g.id), ...subtreeIds(L, layer.id)]);
  const ok = (l: Layer) => !skip.has(l.id) && (isTitleLayer(l) || l.kind === 'generator' || l.kind === 'group');
  const i = L.indexOf(layer);
  return (L.slice(i + 1).find(ok) ?? L.slice(0, i).findLast(ok))?.id ?? null;
}

/** A new mask of `kind` fitted to `layer`; null when a layer mask has no source layer to read. */
function makeMask(project: Project, layer: Layer, kind: LayerMask['kind'], opts: AddMaskOpts | undefined): LayerMask | null {
  const { linked, box } = maskFrame(project, layer);
  const base = { id: uid(), enabled: true, invert: false, feather: 0, density: 1, linked };
  const w = Math.max(1, box.x1 - box.x0);
  const h = Math.max(1, box.y1 - box.y0);
  const cx = round2((box.x0 + box.x1) / 2);
  const cy = round2((box.y0 + box.y1) / 2);
  if (kind === 'shape') {
    const shape = opts?.shape ?? 'rect';
    const src = shapeSource(shape, h);
    const source = FILLS_BOX[shape] ? { ...src, size: round2(h), aspect: w / h, corner: 0 } : { ...src, size: round2(Math.min(h, w / src.aspect)) };
    return { ...base, kind: 'shape', source, x: cx, y: cy, rotation: 0 };
  }
  if (kind === 'gradient') {
    // Linear: opaque along the top edge, transparent at the bottom. Radial: opaque middle, transparent at the corners.
    return (opts?.gradient ?? 'linear') === 'linear'
      ? { ...base, kind: 'gradient', shape: 'linear', x: cx, y: round2(box.y1), angle: -90, length: round2(h), inner: 0, mid: 0.5 }
      : { ...base, kind: 'gradient', shape: 'radial', x: cx, y: cy, angle: 0, length: round2(Math.hypot(w, h) / 2), inner: 0.5, mid: 0.5 };
  }
  const source = opts?.source ?? defaultSource(project, layer);
  if (!source || source === layer.id) return null;
  return { ...base, kind: 'layer', linked: false, layerId: source, channel: 'alpha' };
}

/** `project` with layer `id`'s masks replaced. */
const withMasks = (project: Project, id: string, masks: LayerMask[]): Project => ({
  ...project,
  layers: project.layers.map((l) => (l.id === id ? { ...l, masks } : l)),
});

export const masksSlice: Slice<'addMask' | 'removeMask' | 'updateMask' | 'setMaskEnabled' | 'moveMask' | 'applyMask'> = (core) => {
  const { get } = core;
  /** The layer and mask, when both exist. */
  const find = (layerId: string, maskId: string): { layer: Layer; mask: LayerMask } | null => {
    const layer = get().project.layers.find((l) => l.id === layerId);
    const mask = layer?.masks.find((m) => m.id === maskId);
    return layer && mask ? { layer, mask } : null;
  };
  return {
    addMask(layerId, kind, opts) {
      const { project, notify } = get();
      const layer = project.layers.find((l) => l.id === layerId);
      if (!layer) return null;
      const mask = makeMask(project, layer, kind, opts);
      if (!mask) {
        notify(msg('No other layer to mask “{name}” with', { name: layer.name }), 'error');
        return null;
      }
      commit(core, withMasks(project, layerId, [...layer.masks, mask]), undefined, 'Add mask');
      get().selectNode({ kind: 'mask', layerId, maskId: mask.id });
      return mask.id;
    },
    removeMask(layerId, maskId) {
      const hit = find(layerId, maskId);
      if (!hit) return;
      // The focus, if on this mask, falls back to its layer (commit → fixSelection).
      commit(core, withMasks(get().project, layerId, hit.layer.masks.filter((m) => m !== hit.mask)), undefined, msg('Delete {mask}', { mask: maskLabel(hit.layer, maskId) }));
    },
    updateMask(layerId, maskId, patch, coalesce, label) {
      const hit = find(layerId, maskId);
      if (!hit) return;
      // Linking / unlinking keeps a shape or gradient mask where it is (Photoshop's chain toggle).
      const relinked = patch.linked !== undefined && hit.mask.kind !== 'layer' ? relinkMask(hit.layer, hit.mask, patch.linked) : {};
      const next = { ...hit.mask, ...patch, ...relinked } as LayerMask;
      if ((Object.keys(patch) as (keyof LayerMask)[]).every((k) => next[k] === hit.mask[k])) return;
      commit(core, withMasks(get().project, layerId, hit.layer.masks.map((m) => (m === hit.mask ? next : m))), coalesce, label);
    },
    setMaskEnabled(layerId, maskId, enabled) {
      const hit = find(layerId, maskId);
      if (!hit || hit.mask.enabled === enabled) return;
      get().updateMask(layerId, maskId, { enabled }, undefined, msg(enabled ? 'Enable {mask}' : 'Disable {mask}', { mask: maskLabel(hit.layer, maskId) }));
    },
    moveMask(layerId, maskId, index) {
      const hit = find(layerId, maskId);
      if (!hit) return;
      const rest = hit.layer.masks.filter((m) => m !== hit.mask);
      const at = Math.max(0, Math.min(rest.length, index));
      if (hit.layer.masks[at] === hit.mask) return;
      const label = msg('Reorder {mask}', { mask: maskLabel(hit.layer, maskId) });
      commit(core, withMasks(get().project, layerId, [...rest.slice(0, at), hit.mask, ...rest.slice(at)]), undefined, label);
    },
    applyMask(layerId, maskId, assetId) {
      const hit = find(layerId, maskId);
      if (!hit || !isTitleLayer(hit.layer) || hit.layer.source.kind !== 'image') return;
      const layer = swapImageAsset(hit.layer, hit.layer.source.assetId, assetId);
      const next = { ...layer, masks: layer.masks.filter((m) => m.id !== maskId) };
      const { project } = get();
      commit(core, { ...project, layers: project.layers.map((l) => (l.id === layerId ? next : l)) }, undefined, msg('Apply {mask}', { mask: maskLabel(hit.layer, maskId) }));
    },
  };
};
