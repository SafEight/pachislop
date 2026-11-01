import { create } from 'zustand';
import { backplate3D, band3D, material2D, rim2D, solidFill, uid } from '../../model/defaults';
import { bandKey, parsePartKey, partEffectsOf, plateKey, rimKey, type TitleLayer } from '../../model/parts';
import type { Backplate3D, Material3D, PartKey, Title3DLayer } from '../../model/types';
import { msg, type Translate } from '../../store/msg';
import { partLabel } from '../../store/labels';
import { useEditor, type PropRef, type Refs } from '../../store/store';
import { oneShot } from '../util';
import { FILL_KINDS, fillCss, material3DCss, presetLabel } from './style/shared';

// Style parts as Properties shows and edits them: swatches, one-line summaries, and the stack
// operations (add / remove / duplicate / reorder) of rims, bands and plates. Each operation is
// one undo step (replaceLayer) and keeps `partEffects` in step: a removed part takes its
// effects with it, a duplicate gets copies with fresh ids. Part names come from `partLabel`.

export type StackKind = 'rim' | 'band' | 'plate';

/** Targets as the Ref* controls take them: one as a plain ref (single-part editing unchanged), several as a list. */
export const refsOf = (list: readonly PropRef[]): Refs => (list.length === 1 ? list[0] : list);

/**
 * The part shown on its own page (`layerId:part`, opened with ⤢ from its row in Appearance)
 * instead of expanded in its layer's page; PropertiesPanel ends it when the selection leaves
 * that part and its effects.
 */
export const usePartPage = create<{ key: string | null }>(() => ({ key: null }));

/** The node kind the part editors' section states are remembered under: the part page's, so a section closed inline is closed on the page too. */
export const partScope = (layer: TitleLayer, parts: readonly PartKey[]): string => {
  const kinds = new Set(parts.map((p) => parsePartKey(p).kind));
  return `part:${layer.kind}:${kinds.size === 1 ? [...kinds][0] : 'mixed'}`;
};

/** The rim / band / plate list a stack kind lives in, as stored (rims and plates innermost first, bands face edge → side). */
function stackOf(l: TitleLayer, kind: StackKind): readonly { id: string }[] {
  if (l.kind === 'title2d') return kind === 'rim' ? l.style.rims : [];
  return kind === 'band' ? l.style3d.bands : kind === 'plate' ? l.style3d.backplates : [];
}

/** `l` with stack `kind` replaced by `items` (items of that stack, reordered / filtered / extended). */
function withStack(l: TitleLayer, kind: StackKind, items: readonly { id: string }[]): TitleLayer {
  if (l.kind === 'title2d') return { ...l, style: { ...l.style, rims: items as typeof l.style.rims } };
  return kind === 'band'
    ? { ...l, style3d: { ...l.style3d, bands: items as typeof l.style3d.bands } }
    : { ...l, style3d: { ...l.style3d, backplates: items as typeof l.style3d.backplates } };
}

const keyOf = (kind: StackKind, id: string): PartKey => (kind === 'rim' ? rimKey(id) : kind === 'band' ? bandKey(id) : plateKey(id));

/** Stack kind and array index of a rim / band / plate part (null for face / side or a missing part). */
export function stackPos(l: TitleLayer, key: PartKey): { kind: StackKind; index: number } | null {
  const { kind, id } = parsePartKey(key);
  if (kind === 'face' || kind === 'side' || !id) return null;
  const index = stackOf(l, kind).findIndex((x) => x.id === id);
  return index < 0 ? null : { kind, index };
}

/** The 3D material a part shows (a plate's face material), or null when the part is gone. */
function material3DOf(l: Title3DLayer, key: PartKey): Material3D | null {
  const s = l.style3d;
  const { kind } = parsePartKey(key);
  if (kind === 'face') return s.face;
  if (kind === 'side') return s.side;
  const pos = stackPos(l, key);
  if (!pos) return null;
  return pos.kind === 'band' ? s.bands[pos.index].material : s.backplates[pos.index].face;
}

/** CSS background of the part's swatch (the whole gradient, not just its main colour). */
export function partSwatch(l: TitleLayer, key: PartKey): string {
  if (l.kind === 'title2d') {
    const pos = stackPos(l, key);
    const mat = pos ? l.style.rims[pos.index].material : parsePartKey(key).kind === 'face' ? l.style.face : null;
    return mat ? fillCss(mat.fill) : 'transparent';
  }
  const m = material3DOf(l, key);
  return m ? material3DCss(m) : 'transparent';
}

const pct = (v: number) => `${+v.toFixed(2)}%`;

/** Where a rim's or band's width lives and its field's maximum (null for other parts): the number most often changed, edited right on the part's row. */
export function partWidth(l: TitleLayer, key: PartKey): { ref: PropRef; max: number } | null {
  const pos = stackPos(l, key);
  if (pos?.kind === 'rim') return { ref: { layerId: l.id, path: ['style', 'rims', pos.index, 'width'] }, max: 8 };
  if (pos?.kind === 'band') return { ref: { layerId: l.id, path: ['style3d', 'bands', pos.index, 'width'] }, max: 10 };
  return null;
}

/** One-line summary for the Appearance list, e.g. "Gold · fx 2" / "Linear · bevel 3% · fx 1"; a rim's or band's width is the field on its row (partWidth). */
export function partSummary(t: Translate, l: TitleLayer, key: PartKey): string {
  const out: string[] = [];
  const pos = stackPos(l, key);
  if (l.kind === 'title2d') {
    const rim = pos ? l.style.rims[pos.index] : null;
    const mat = rim ? rim.material : parsePartKey(key).kind === 'face' ? l.style.face : null;
    if (mat) {
      out.push(t(FILL_KINDS.find((k) => k.value === mat.fill.kind)?.label ?? mat.fill.kind));
      if (mat.bevel.enabled) out.push(t('bevel {n}', { n: pct(mat.bevel.size) }));
    }
  } else {
    const m = material3DOf(l, key);
    if (m) out.push(presetLabel(t, m.preset));
    if (pos?.kind === 'plate') out.push(`+${pct(l.style3d.backplates[pos.index].grow)}`);
  }
  const fx = partEffectsOf(l, key).length;
  if (fx) out.push(t('fx {n}', { n: fx }));
  return out.join(' · ');
}

/** Whether a plate material reads as black (dark, unsaturated finish). */
function isBlackish(m: Material3D): boolean {
  if (m.preset === 'blackGloss') return true;
  if (m.gradient) return false;
  const c = parseInt(m.color.slice(1, 7), 16);
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  return Math.max(r, g, b) < 64;
}

/**
 * New outermost plate: 2 % beyond every other plate, its base shape continued, a colour that
 * contrasts with the outermost plate that actually shows (black after a coloured one, else red).
 * A plate shows when it is enabled and grows beyond the previous solid.
 */
function newPlate(l: Title3DLayer): Backplate3D {
  const plates = l.style3d.backplates;
  const shown = [...plates].reverse().find((p) => p.enabled && p.grow > 0);
  const added = backplate3D(2, shown && isBlackish(shown.face) ? 'redMetal' : 'blackGloss');
  const prev = [...plates].reverse().find((p) => p.enabled);
  if (prev) added.plate = { ...prev.plate };
  return added;
}

const ADD_LABEL: Record<StackKind, string> = { rim: 'Add rim', band: 'Add band', plate: 'Add plate' };

/**
 * Add a rim (2D, outside the outermost), a band (3D, at the side-wall end) or a plate (3D,
 * outside every other plate) and select the new part.
 */
export function addPart(l: TitleLayer, kind: StackKind) {
  const added = l.kind === 'title2d' ? rim2D(2, material2D(solidFill('#000000'))) : kind === 'band' ? band3D(1.5, 1.5, 'gold') : newPlate(l);
  const { replaceLayer, selectNode } = useEditor.getState();
  replaceLayer(l.id, withStack(l, kind, [...stackOf(l, kind), added]), oneShot(`${l.id}:add-${kind}`), ADD_LABEL[kind]);
  selectNode({ kind: 'part', layerId: l.id, part: keyOf(kind, added.id) });
}

/** Remove a rim / band / plate with its effects; the layer node is selected after. */
export function removePart(l: TitleLayer, key: PartKey) {
  const pos = stackPos(l, key);
  if (!pos) return;
  const partEffects = { ...l.partEffects };
  delete partEffects[key];
  const next = { ...withStack(l, pos.kind, stackOf(l, pos.kind).filter((_, i) => i !== pos.index)), partEffects };
  const { replaceLayer, selectNode } = useEditor.getState();
  replaceLayer(l.id, next, oneShot(`${l.id}:remove-part`), msg('Remove {part}', { part: partLabel(l, key) }));
  selectNode({ kind: 'layer', layerId: l.id });
}

/** Copy a rim / band / plate (with fresh-id copies of its effects) right behind it, and select the copy. */
export function duplicatePart(l: TitleLayer, key: PartKey) {
  const pos = stackPos(l, key);
  if (!pos) return;
  const items = stackOf(l, pos.kind);
  const copy = { ...structuredClone(items[pos.index]), id: uid() };
  const copyKey = keyOf(pos.kind, copy.id);
  const fx = l.partEffects[key]?.map((e) => ({ ...structuredClone(e), id: uid() }));
  const next = {
    ...withStack(l, pos.kind, [...items.slice(0, pos.index + 1), copy, ...items.slice(pos.index + 1)]),
    partEffects: fx?.length ? { ...l.partEffects, [copyKey]: fx } : l.partEffects,
  };
  const { replaceLayer, selectNode } = useEditor.getState();
  replaceLayer(l.id, next, oneShot(`${l.id}:dup-part`), msg('Duplicate {part}', { part: partLabel(l, key) }));
  selectNode({ kind: 'part', layerId: l.id, part: copyKey });
}

/** Whether `key` can move one step toward the front (-1) or the back (+1) of its own stack. */
export function canMovePart(l: TitleLayer, key: PartKey, dir: -1 | 1): boolean {
  const pos = stackPos(l, key);
  return !!pos && pos.index + dir >= 0 && pos.index + dir < stackOf(l, pos.kind).length;
}

/**
 * Move a rim / band / plate one step toward the front (-1: nearer the face) or the back (+1)
 * within its own stack. Every stack is stored front-most first, so that is the array step.
 */
export function movePart(l: TitleLayer, key: PartKey, dir: -1 | 1) {
  const pos = stackPos(l, key);
  if (!pos || !canMovePart(l, key, dir)) return;
  const items = stackOf(l, pos.kind).slice();
  const [item] = items.splice(pos.index, 1);
  items.splice(pos.index + dir, 0, item);
  const label = msg(dir < 0 ? 'Move {part} forward' : 'Move {part} backward', { part: partLabel(l, key) });
  useEditor.getState().replaceLayer(l.id, withStack(l, pos.kind, items), oneShot(`${l.id}:move-part`), label);
}
