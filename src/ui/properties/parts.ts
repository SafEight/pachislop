import { create } from 'zustand';
import { backplate3D, band3D, material2D, rim2D, solidFill, uid } from '../../model/defaults';
import { bandKey, parsePartKey, partEffectsOf, plateKey, rimKey, type TitleLayer } from '../../model/parts';
import { withoutLink, type AnyMaterial } from '../../model/links';
import { sideMaterial, sideNeighbour, sideSource } from '../../model/sides';
import type { Backplate3D, Material3D, PartKey, Title3DLayer, Title3DProps } from '../../model/types';
import { formatMsg, msg, type Text, type Translate } from '../../store/msg';
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

/** The material a part shows (a plate's face material, a side's inherited one), or null when the part is gone. */
export function partMaterial(l: TitleLayer, key: PartKey): AnyMaterial | null {
  const { kind } = parsePartKey(key);
  const pos = stackPos(l, key);
  if (l.kind === 'title2d') return pos ? l.style.rims[pos.index].material : kind === 'face' ? l.style.face : null;
  const s = l.style3d;
  if (kind === 'face') return s.face;
  if (kind === 'side') return sideMaterial(s);
  if (!pos) return null;
  return pos.kind === 'band' ? s.bands[pos.index].material : s.backplates[pos.index].face;
}

/** Whether `key` is a 3D side that follows its neighbour (model/sides.ts). */
export const isInheritedSide = (l: TitleLayer, key: PartKey): boolean => l.kind === 'title3d' && key === 'side' && !l.style3d.side;

/** What the title's side follows while it has no material of its own: “Same as Band 2” / “Same as face”. */
export function sideSameAs(l: Title3DLayer): Text {
  const i = sideSource(l.style3d);
  return i === null ? msg('Same as face') : msg('Same as {part}', { part: partLabel(l, bandKey(l.style3d.bands[i].id)) });
}

/** Every 3D title of the project restyled by `fn` (a title it leaves alone: its own style back), one undo step. */
function editStyles(fn: (l: Title3DLayer) => Title3DProps, label: Text) {
  useEditor.getState().edit(
    (p) => ({
      ...p,
      layers: p.layers.map((l) => {
        if (l.kind !== 'title3d') return l;
        const style3d = fn(l);
        return style3d === l.style3d ? l : { ...l, style3d };
      }),
    }),
    oneShot('own-side'),
    label,
  );
}

/**
 * Give the side of every title of `layers` that follows its neighbour an unlinked copy of what it
 * shows (`own`), or let every one follow its neighbour again; one undo step.
 */
export function ownSides(layers: readonly Title3DLayer[], own: boolean) {
  const ids = new Set(layers.map((l) => l.id));
  const part = partLabel(layers[0], 'side');
  editStyles(
    ({ id, style3d: s }) => {
      if (!ids.has(id) || !!s.side === own) return s;
      if (own) return { ...s, side: structuredClone(withoutLink(sideNeighbour(s))) };
      const { side: _, ...rest } = s;
      return rest;
    },
    own ? msg('Own {part}', { part }) : msg('{part}: {source}', { part, source: sideSameAs(layers[0]) }),
  );
}

/** The same for the edges of plates (`index` in each layer's `style3d.backplates`): a copy of the plate's front, or following it again. */
export function ownPlateSides(plates: readonly { layer: Title3DLayer; index: number }[], own: boolean) {
  const at = new Map<string, Set<number>>();
  for (const { layer, index } of plates) at.set(layer.id, (at.get(layer.id) ?? new Set()).add(index));
  const edge = (p: Backplate3D): Backplate3D => {
    if (!!p.side === own) return p;
    if (own) return { ...p, side: structuredClone(withoutLink(p.face)) };
    const { side: _, ...rest } = p;
    return rest;
  };
  const part = msg('Edge material');
  editStyles(
    ({ id, style3d: s }) => {
      const picked = at.get(id);
      return picked ? { ...s, backplates: s.backplates.map((p, i) => (picked.has(i) ? edge(p) : p)) } : s;
    },
    own ? msg('Own {part}', { part }) : msg('{part}: {source}', { part, source: msg('Same as front') }),
  );
}

/** CSS background of a material's swatch (the whole gradient, not just its main colour). */
export const materialCss = (m: AnyMaterial): string => ('fill' in m ? fillCss(m.fill) : material3DCss(m));

/** CSS background of the part's swatch. */
export function partSwatch(l: TitleLayer, key: PartKey): string {
  const m = partMaterial(l, key);
  return m ? materialCss(m) : 'transparent';
}

const pct = (v: number) => `${+v.toFixed(2)}%`;

/** Where a rim's or band's width lives and its field's maximum (null for other parts): the number most often changed, edited right on the part's row. */
export function partWidth(l: TitleLayer, key: PartKey): { ref: PropRef; max: number } | null {
  const pos = stackPos(l, key);
  if (pos?.kind === 'rim') return { ref: { layerId: l.id, path: ['style', 'rims', pos.index, 'width'] }, max: 8 };
  if (pos?.kind === 'band') return { ref: { layerId: l.id, path: ['style3d', 'bands', pos.index, 'width'] }, max: 10 };
  return null;
}

/** One-line summary bits of a material: a 2D one's fill kind and bevel, a 3D one's preset. */
export function materialSummary(t: Translate, m: AnyMaterial): string[] {
  if (!('fill' in m)) return [presetLabel(t, m.preset)];
  const out = [t(FILL_KINDS.find((k) => k.value === m.fill.kind)?.label ?? m.fill.kind)];
  if (m.bevel.enabled) out.push(t('bevel {n}', { n: pct(m.bevel.size) }));
  return out;
}

/**
 * One-line summary for the Appearance list, e.g. "Gold · fx 2" / "Linear · bevel 3% · fx 1"; a side
 * that follows its neighbour says which ("Same as Band 2"); a rim's or band's width is the field
 * on its row (partWidth).
 */
export function partSummary(t: Translate, l: TitleLayer, key: PartKey): string {
  const mat = partMaterial(l, key);
  const out = l.kind === 'title3d' && isInheritedSide(l, key) ? [formatMsg(sideSameAs(l), t)] : mat ? materialSummary(t, mat) : [];
  const pos = stackPos(l, key);
  if (l.kind === 'title3d' && pos?.kind === 'plate') out.push(`+${pct(l.style3d.backplates[pos.index].grow)}`);
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
