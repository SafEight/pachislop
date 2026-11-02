import { create } from 'zustand';
import { band3D, material2D, rim2D, solidFill, uid } from '../../model/defaults';
import { bandKey, parsePartKey, partEffectsOf, rimKey, type TitleLayer } from '../../model/parts';
import { withoutLink, type AnyMaterial } from '../../model/links';
import { sideMaterial } from '../../model/bands';
import type { Band3D, MaterialPreset, PartKey, Title3DLayer, Title3DProps } from '../../model/types';
import { formatMsg, msg, type Text, type Translate } from '../../store/msg';
import { partLabel } from '../../store/labels';
import { useEditor, type PropRef, type Refs } from '../../store/store';
import { oneShot } from '../util';
import { FILL_KINDS, fillCss, material3DCss, presetLabel } from './style/shared';

// Style parts as Properties shows and edits them: swatches, one-line summaries, and the stack
// operations (add / remove / duplicate / reorder) of 2D rims and 3D bands. Each operation is one
// undo step (replaceLayer) and keeps `partEffects` in step: a removed part takes its effects with
// it, a duplicate gets copies with fresh ids. Band operations keep the letters' own band
// materials (CharAdjust.bands3d, index-aligned with the bands) with their bands. Part names come
// from `partLabel`.

export type StackKind = 'rim' | 'band';

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

/** The rim / band list a stack kind lives in, as stored (innermost first). */
function stackOf(l: TitleLayer, kind: StackKind): readonly { id: string }[] {
  if (l.kind === 'title2d') return kind === 'rim' ? l.style.rims : [];
  return kind === 'band' ? l.style3d.bands : [];
}

/**
 * `l` with its stack (2D rims, 3D bands) replaced by `items` (reordered / filtered / extended);
 * `from[i]` = the old index whose letter overrides item i takes over (null: none), for 3D bands.
 */
function withStack(l: TitleLayer, items: readonly { id: string }[], from: readonly (number | null)[]): TitleLayer {
  if (l.kind === 'title2d') return { ...l, style: { ...l.style, rims: items as typeof l.style.rims } };
  const next: Title3DLayer = { ...l, style3d: { ...l.style3d, bands: items as Band3D[] } };
  const src = l.source;
  if (src.kind !== 'text' || !Object.values(src.chars).some((a) => a.bands3d)) return next;
  const chars = Object.fromEntries(
    Object.entries(src.chars).map(([k, a]) => {
      if (!a.bands3d) return [k, a];
      const { bands3d, ...rest } = a;
      const moved = from.map((j) => (j === null ? null : (bands3d[j] ?? null)));
      return [k, moved.some(Boolean) ? { ...rest, bands3d: moved } : rest];
    }),
  );
  return { ...next, source: { ...src, chars } };
}

/** 0..n−1: every item stays where its letter overrides are. */
const indices = (n: number) => Array.from({ length: n }, (_, i): number | null => i);

const keyOf = (kind: StackKind, id: string): PartKey => (kind === 'rim' ? rimKey(id) : bandKey(id));

/** Stack kind and array index of a rim / band part (null for face / side or a missing part). */
export function stackPos(l: TitleLayer, key: PartKey): { kind: StackKind; index: number } | null {
  const { kind, id } = parsePartKey(key);
  if (kind === 'face' || kind === 'side' || !id) return null;
  const index = stackOf(l, kind).findIndex((x) => x.id === id);
  return index < 0 ? null : { kind, index };
}

/** The material a part shows (a band's material, a side's inherited one), or null when the part is gone. */
export function partMaterial(l: TitleLayer, key: PartKey): AnyMaterial | null {
  const { kind } = parsePartKey(key);
  const pos = stackPos(l, key);
  if (l.kind === 'title2d') return pos ? l.style.rims[pos.index].material : kind === 'face' ? l.style.face : null;
  const s = l.style3d;
  if (kind === 'face') return s.face;
  if (kind === 'side') return sideMaterial(s);
  return pos ? s.bands[pos.index].material : null;
}

/** Whether `key` is a 3D title side without a material of its own: it shows the face's (model/bands.ts). */
export const isInheritedSide = (l: TitleLayer, key: PartKey): boolean => l.kind === 'title3d' && key === 'side' && !l.style3d.side;

/** What the title's side follows while it has no material of its own. */
export const SIDE_SAME_AS: Text = msg('Same as face');

/** What a band's side wall follows while it has no material of its own. */
export const BAND_SIDE_SAME_AS: Text = msg('Same as band');

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
 * Give the side walls of every title of `layers` that shows its face there an unlinked copy of
 * the face (`own`: the side can then differ, Element 3D's separate side material), or let every
 * one show the face again; one undo step.
 */
export function ownSides(layers: readonly Title3DLayer[], own: boolean) {
  const ids = new Set(layers.map((l) => l.id));
  const part = partLabel(layers[0], 'side');
  editStyles(
    ({ id, style3d: s }) => {
      if (!ids.has(id) || !!s.side === own) return s;
      if (own) return { ...s, side: structuredClone(withoutLink(s.face)) };
      const { side: _, ...rest } = s;
      return rest;
    },
    own ? msg('Own {part}', { part }) : msg('{part}: {source}', { part, source: SIDE_SAME_AS }),
  );
}

/** The same for the side walls of bands (`index` in each layer's `style3d.bands`): a copy of the band's material, or showing it again. */
export function ownBandSides(bands: readonly { layer: Title3DLayer; index: number }[], own: boolean) {
  const at = new Map<string, Set<number>>();
  for (const { layer, index } of bands) at.set(layer.id, (at.get(layer.id) ?? new Set()).add(index));
  const wall = (b: Band3D): Band3D => {
    if (!!b.side === own) return b;
    if (own) return { ...b, side: structuredClone(withoutLink(b.material)) };
    const { side: _, ...rest } = b;
    return rest;
  };
  const { layer, index } = bands[0];
  const part = bands.length === 1 ? msg('{part} side', { part: partLabel(layer, bandKey(layer.style3d.bands[index].id)) }) : msg('{n} band sides', { n: bands.length });
  editStyles(
    ({ id, style3d: s }) => {
      const picked = at.get(id);
      return picked ? { ...s, bands: s.bands.map((b, i) => (picked.has(i) ? wall(b) : b)) } : s;
    },
    own ? msg('Own {part}', { part }) : msg('{part}: {source}', { part, source: BAND_SIDE_SAME_AS }),
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

/**
 * The number most often changed on a rim's or band's Appearance row, edited right on the row: a
 * rim's width, a band's grow (`grow`), with the field's maximum; null for other parts.
 */
export function partWidth(l: TitleLayer, key: PartKey): { ref: PropRef; max: number; grow: boolean } | null {
  const pos = stackPos(l, key);
  if (pos?.kind === 'rim') return { ref: { layerId: l.id, path: ['style', 'rims', pos.index, 'width'] }, max: 8, grow: false };
  if (pos?.kind === 'band') return { ref: { layerId: l.id, path: ['style3d', 'bands', pos.index, 'grow'] }, max: 15, grow: true };
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
 * One-line summary for the Appearance list, e.g. "Gold · bevel 2.5% · fx 2" (a 3D face names the
 * letter's bevel) / "Linear · bevel 3% · fx 1"; a side without a material of its own says what it
 * shows ("Same as face"), a band with a side wall of its own says so; a rim's width and a band's
 * grow are the field on its row (partWidth).
 */
export function partSummary(t: Translate, l: TitleLayer, key: PartKey): string {
  const mat = partMaterial(l, key);
  const out = isInheritedSide(l, key) ? [formatMsg(SIDE_SAME_AS, t)] : mat ? materialSummary(t, mat) : [];
  if (l.kind === 'title3d') {
    const s = l.style3d;
    // the letter's bevel, where it renders: Extrude mode, not on a GLB model or an orb
    const src = l.source;
    if (key === 'face' && s.bevel.width > 0 && s.mode === 'extrude' && src.kind !== 'model' && !(src.kind === 'shape' && src.shape === 'orb')) out.push(t('bevel {n}', { n: pct(s.bevel.width) }));
    const pos = stackPos(l, key);
    if (pos && s.bands[pos.index].side) out.push(t('own side'));
  }
  const fx = partEffectsOf(l, key).length;
  if (fx) out.push(t('fx {n}', { n: fx }));
  return out.join(' · ');
}

/** Materials of new bands by their index (cycling): green, gold, red, blue, chrome, black outlines stacked behind. */
const BAND_PALETTE: readonly MaterialPreset[] = ['greenMetal', 'gold', 'redMetal', 'blueMetal', 'chrome', 'blackGloss'];

/** New outermost band: 2 % beyond the last one, its shape, join and counter filling continued, in the palette's next colour. */
function newBand(l: Title3DLayer): Band3D {
  const bands = l.style3d.bands;
  const added = band3D(2, BAND_PALETTE[bands.length % BAND_PALETTE.length]);
  const prev = bands[bands.length - 1];
  return prev ? { ...added, shape: { ...prev.shape }, join: prev.join, fillCounters: prev.fillCounters } : added;
}

const ADD_LABEL: Record<StackKind, string> = { rim: 'Add rim', band: 'Add band' };

/** Add a rim (2D, outside the outermost) or a band (3D, behind the last one) and select the new part. */
export function addPart(l: TitleLayer, kind: StackKind) {
  const added = l.kind === 'title2d' ? rim2D(2, material2D(solidFill('#000000'))) : newBand(l);
  const items = stackOf(l, kind);
  const { replaceLayer, selectNode } = useEditor.getState();
  replaceLayer(l.id, withStack(l, [...items, added], [...indices(items.length), null]), oneShot(`${l.id}:add-${kind}`), ADD_LABEL[kind]);
  selectNode({ kind: 'part', layerId: l.id, part: keyOf(kind, added.id) });
}

/** Remove a rim / band with its effects; the layer node is selected after. */
export function removePart(l: TitleLayer, key: PartKey) {
  const pos = stackPos(l, key);
  if (!pos) return;
  const partEffects = { ...l.partEffects };
  delete partEffects[key];
  const keep = (_: unknown, i: number) => i !== pos.index;
  const items = stackOf(l, pos.kind);
  const next = { ...withStack(l, items.filter(keep), indices(items.length).filter(keep)), partEffects };
  const { replaceLayer, selectNode } = useEditor.getState();
  replaceLayer(l.id, next, oneShot(`${l.id}:remove-part`), msg('Remove {part}', { part: partLabel(l, key) }));
  selectNode({ kind: 'layer', layerId: l.id });
}

/** Copy a rim / band (with fresh-id copies of its effects; a band also keeps the letters' own materials) right behind it, and select the copy. */
export function duplicatePart(l: TitleLayer, key: PartKey) {
  const pos = stackPos(l, key);
  if (!pos) return;
  const items = stackOf(l, pos.kind);
  const copy = { ...structuredClone(items[pos.index]), id: uid() };
  const copyKey = keyOf(pos.kind, copy.id);
  const fx = l.partEffects[key]?.map((e) => ({ ...structuredClone(e), id: uid() }));
  const at = pos.index + 1;
  const from = indices(items.length);
  const next = {
    ...withStack(l, [...items.slice(0, at), copy, ...items.slice(at)], [...from.slice(0, at), pos.index, ...from.slice(at)]),
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
 * Move a rim / band one step toward the front (-1: nearer the face) or the back (+1) within its
 * own stack. Every stack is stored front-most first, so that is the array step.
 */
export function movePart(l: TitleLayer, key: PartKey, dir: -1 | 1) {
  const pos = stackPos(l, key);
  if (!pos || !canMovePart(l, key, dir)) return;
  const items = stackOf(l, pos.kind).slice();
  const from = indices(items.length);
  const [item] = items.splice(pos.index, 1);
  items.splice(pos.index + dir, 0, item);
  const [j] = from.splice(pos.index, 1);
  from.splice(pos.index + dir, 0, j);
  const label = msg(dir < 0 ? 'Move {part} forward' : 'Move {part} backward', { part: partLabel(l, key) });
  useEditor.getState().replaceLayer(l.id, withStack(l, items, from), oneShot(`${l.id}:move-part`), label);
}
