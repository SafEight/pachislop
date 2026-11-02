import type { EffectInstance, Layer, PartEffects, PartKey, Title2DLayer, Title3DLayer } from './types';

// Style parts of title layers (see PartKey): the units the Layers panel lists under a title, that
// can be selected and edited on their own and can carry their own effects (PartEffects).

export type TitleLayer = Title2DLayer | Title3DLayer;

export const isTitleLayer = (l: Layer | null | undefined): l is TitleLayer => l?.kind === 'title2d' || l?.kind === 'title3d';

export type PartKind = 'face' | 'rim' | 'band' | 'side';

/** Kind and element id (rim / band id; null for face and side) of a part key. */
export function parsePartKey(key: PartKey): { kind: PartKind; id: string | null } {
  const i = key.indexOf(':');
  if (i < 0) return { kind: key as 'face' | 'side', id: null };
  return { kind: key.slice(0, i) as PartKind, id: key.slice(i + 1) };
}

export const rimKey = (id: string): PartKey => `rim:${id}`;
export const bandKey = (id: string): PartKey => `band:${id}`;

/**
 * Every part the layer's style has, BACK to FRONT — the order the renderers stack them and the
 * order the engine composites per-part effect results in.
 * 2D: rims outermost first (rims are listed innermost first), then the face (absent when
 * `style.hideFace`). 3D: bands outermost first (listed innermost first), the letter's side
 * walls, then its face (and bevel). Disabled rims / bands are still parts (they can be
 * re-enabled); renderers draw nothing for them.
 */
export function layerParts(l: TitleLayer): PartKey[] {
  if (l.kind === 'title2d') {
    const rims = [...l.style.rims].reverse().map((r) => rimKey(r.id));
    return l.style.hideFace ? rims : [...rims, 'face'];
  }
  const bands = [...l.style3d.bands].reverse().map((b) => bandKey(b.id));
  return [...bands, 'side', 'face'];
}

/** Effects of part `key` (empty when it has none). */
export const partEffectsOf = (l: TitleLayer, key: PartKey): EffectInstance[] => l.partEffects[key] ?? [];
/** True when some part has at least one enabled effect (the engine then renders the title part by part). */
export const hasPartEffects = (l: TitleLayer): boolean => Object.values(l.partEffects).some((fx) => fx?.some((e) => e.enabled));

/** `partEffects` with keys of parts the style no longer has, and empty lists, removed; the same object when nothing changes. */
export function prunePartEffects(l: TitleLayer): PartEffects {
  const live = new Set<string>(layerParts(l));
  const keys = Object.keys(l.partEffects) as PartKey[];
  if (keys.every((k) => live.has(k) && l.partEffects[k]?.length)) return l.partEffects;
  const out: PartEffects = {};
  for (const k of keys) if (live.has(k) && l.partEffects[k]?.length) out[k] = l.partEffects[k];
  return out;
}
