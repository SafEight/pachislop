import { useMemo } from 'react';
import type { GeneratorDef } from '../engine/contracts';
import { listGenerators } from '../generators/registry';
import { listedCompanions } from '../model/companions';
import { isTitleLayer } from '../model/parts';
import type { GeneratorLayer, Layer } from '../model/types';
import { useEditor } from '../store/store';
import { clippedTo } from '../store/tree';

// Companion generators (model/companions.ts: glints on a title, fire behind it…) shown as effects
// of the layer they follow, as the 3D glint is (ui/glint.ts): “+ Add effect” offers every preset of
// the follow-capable generators, the Layers panel lists them under the layer's Effects in stack
// order (behind-ones marked), and selecting one opens its effect-style card (CompanionCard). They
// stay generator layers of their own (export, PSD, their own blend, effects and masks), so the
// selection of a companion is its layer node.

/** Layers “+ Add effect” offers companions for: titles (text, shapes, SVG, images, models) and groups. */
export const takesCompanions = (l: Layer | undefined): boolean => isTitleLayer(l) || l?.kind === 'group';

/** “+ Add effect” categories of the companions, after the effect categories. */
export type CompanionCategory = 'Light' | 'Energy' | 'Ink & more';

export const COMPANION_CATEGORIES: { id: CompanionCategory; glyph: string; title: string }[] = [
  { id: 'Light', glyph: '✦', title: 'Light drawn on the layer: glints and sparkles on its highlights, god rays behind it, lens flares' },
  { id: 'Energy', glyph: 'ϟ', title: 'Fire, smoke, corona and lightning from the edges of the layer' },
  { id: 'Ink & more', glyph: '✒', title: 'Ink splatter thrown off the layer, particles emitted from it, sunburst rays behind it' },
];

/** One “+ Add effect” entry: a preset of a follow-capable generator, added as a companion of the layer. */
export interface CompanionEntry {
  def: GeneratorDef;
  presetId: string;
  /** English preset name (the i18n key). */
  label: string;
  category: CompanionCategory;
  /** Drawn behind the layer (the preset's `place`). */
  behind: boolean;
}

/** Every preset of every follow-capable generator, by category then registry order. */
export function companionEntries(): CompanionEntry[] {
  const category = (def: GeneratorDef): CompanionCategory => (def.category === 'Light' || def.category === 'Energy' ? def.category : 'Ink & more');
  return listGenerators()
    .filter((def) => def.follow)
    .flatMap((def) => def.presets.map((p): CompanionEntry => ({ def, presetId: p.id, label: p.label, category: category(def), behind: p.place === 'below' })))
    .toSorted((a, b) => COMPANION_CATEGORIES.findIndex((c) => c.id === a.category) - COMPANION_CATEGORIES.findIndex((c) => c.id === b.category));
}

/** The companions of layer `ownerId` as its Effects list shows them: `front` (above it) and `back` (behind it), each top first. */
export interface CompanionSides {
  front: GeneratorLayer[];
  back: GeneratorLayer[];
}

export function companionSides(layers: readonly Layer[], ownerId: string, listed = listedCompanions(layers)): CompanionSides {
  const all = listed.get(ownerId) ?? [];
  const at = layers.findIndex((l) => l.id === ownerId);
  return { front: all.filter((c) => layers.indexOf(c) > at).reverse(), back: all.filter((c) => layers.indexOf(c) < at).reverse() };
}

/** companionSides of `ownerId` in the current project. */
export function useCompanionSides(ownerId: string): CompanionSides {
  const layers = useEditor((s) => s.project.layers);
  return useMemo(() => companionSides(layers, ownerId), [layers, ownerId]);
}

/** Companion `id` of `owner` moved directly in front of the layer (above its clip group) or behind it, as one undo step. */
export function placeCompanion(owner: Layer, id: string, front: boolean) {
  const st = useEditor.getState();
  const top = clippedTo(st.project.layers, owner.id).at(-1) ?? owner;
  st.moveLayers([id], front ? { aboveId: top.id } : { belowId: owner.id });
}
