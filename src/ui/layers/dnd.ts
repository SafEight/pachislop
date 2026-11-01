import type { Layer, Project } from '../../model/types';
import { effectsOf } from '../../store/effects';
import type { EffectOwner, LayerDest } from '../../store/store';
import { ancestorsOf, childrenOf } from '../../store/tree';

// Drag and drop in the Layers panel. The payload lives here for the drag's duration because
// dataTransfer contents can't be read during dragover, where the drop is validated. Files from
// the desktop carry no payload: they are told apart by their 'Files' type (draggingFiles).

export type DragPayload =
  /** Layer rows: the whole selection. */
  | { kind: 'layers'; ids: string[] }
  /** Effect rows (one id) or an fx badge (every effect of the owner), in array order. */
  | { kind: 'fx'; owner: EffectOwner; ids: string[] }
  /** A mask chip: reordered among its layer's chips. */
  | { kind: 'mask'; layerId: string; maskId: string };

export const drag: { current: DragPayload | null } = { current: null };

/** dataTransfer type set on every panel drag (browsers only start a drag that carries data). */
export const DRAG_MIME = 'application/x-pachislot-layers';

/** Where a layer drop lands relative to the row under the pointer; 'into' only on group rows. */
export type DropPos = 'above' | 'below' | 'into';

/** Indent per nesting level in px (layers.css `--lp-indent`). */
export const INDENT = 14;

/** Drop zone from the pointer's height in the row: a group row's middle drops in. */
export function dropPosAt(clientY: number, rect: DOMRect, group: boolean): DropPos {
  const f = (clientY - rect.top) / rect.height;
  if (group) return f < 0.3 ? 'above' : f > 0.7 ? 'below' : 'into';
  return f < 0.5 ? 'above' : 'below';
}

/**
 * Stack slot for dropping `ids` (none for files: addLayer) at `pos` of row `target`, or null when the drop is
 * refused (onto itself or into its own subtree). Below an open group with members = its top
 * member slot. Below the bottom member of a group with the pointer left of the row's indent
 * (`outLevels` > 0) steps out of that many groups: below the group's whole block (PS) — also
 * on the dragged row itself, which is how a bottom member is dragged out of its group.
 */
export function layerDest(layers: readonly Layer[], ids: readonly string[], target: Layer, pos: DropPos, open: boolean, outLevels: number): LayerDest | null {
  if (ancestorsOf(layers, target.id).some((g) => ids.includes(g.id))) return null;
  const self = ids.includes(target.id);
  if (pos === 'into') return self ? null : { into: target.id };
  if (pos === 'above') return self ? null : { aboveId: target.id };
  if (!self && target.kind === 'group' && open && childrenOf(layers, target.id).length) return { into: target.id };
  let below = target;
  for (let k = 0; k < outLevels && below.parentId; k++) {
    if (childrenOf(layers, below.parentId)[0]?.id !== below.id) break;
    const parent = layers.find((l) => l.id === below.parentId);
    if (!parent) break;
    below = parent;
  }
  return below === target && self ? null : { belowId: below.id };
}

/**
 * store.moveEffect index for dropping the dragged effects at array gap `gap` of `to`'s list (gap
 * counted before removal; default: the top of the stack). Null when nothing would change.
 */
export function fxDropIndex(project: Project, p: Extract<DragPayload, { kind: 'fx' }>, to: EffectOwner, gap?: number, copy?: boolean): number | null {
  const list = effectsOf(project, to);
  const at = gap ?? list.length;
  if (copy || p.owner.layerId !== to.layerId || p.owner.part !== to.part) return at;
  const index = at - list.slice(0, at).filter((fx) => p.ids.includes(fx.id)).length;
  // Moving a block onto its own place.
  return list.findIndex((fx) => fx.id === p.ids[0]) === index ? null : index;
}
