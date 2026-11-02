import { getEffect } from '../effects/registry';
import type { Companion } from '../generators/fromEffect';
import { getGenerator } from '../generators/registry';
import { companionsOf, dissolveCompanionGroups, ownGroupOf, placeCompanions } from '../model/companions';
import { defaultComp, layerBase, uid } from '../model/defaults';
import { allLighting, effectiveLighting } from '../model/lighting';
import { addLinkNames, freshLinks, linkedSlots, linkNamesOf, remapLayerLinks } from '../model/links';
import { bandKey, isTitleLayer, layerParts, parsePartKey, rimKey, type TitleLayer } from '../model/parts';
import type { EffectInstance, GeneratorLayer, Layer, Lighting3D, PartEffects, PartKey, Project, Title3DProps } from '../model/types';
import type { ApplyPreset, PresetPartKey, StylePreset } from './types';

// Preset effect conventions:
// - Params whose ParamDef unit is 'px' were authored for a source of size `refSize`; they are
//   scaled by layer.source.size / refSize on apply.
// - On-canvas handle positions (EffectDef.handles) are stored RELATIVE TO THE LAYER POSITION
//   (presetFromLayer subtracts the layer's x/y; applyPreset scales them and adds it back), so a
//   flare placed on the title stays on the title wherever the target layer sits.
// - Companions (StylePreset.companions: glints, fire…) become generator layers following the layer,
//   in a group with it (applyPresetToProject); their px params scale like effects', and a free
//   companion sits at the layer position.
// - Part effects travel with the look keyed by part POSITION (PresetPartKey: 'rim:2' = the third
//   rim of the style), since element ids differ between layers; on apply each key is mapped to
//   the part at that position of the applied style, and keys with no such part are dropped.
// - 3D looks carry their lighting in style3d.lighting as overrides that set every value
//   (environment, lights, tone mapping, exposure): applying one gives the layer that lighting of
//   its own, so a look never changes the comp or another layer.
// - Material links (Material2D.link / Material3D.link) of a look's style get fresh ids on every
//   application (applyPreset), so a look's gold links its own bands, not another layer's; the
//   look's link names (StylePreset.links) go into the project's (applyPresetToProject). A pasted
//   style (`keepLinks`) keeps the links the project has and drops the others.
//
// Kind mismatch: a 2D preset applied to a 3D title (or vice versa) CONVERTS the layer to the
// preset's kind when its source exists in both kinds (text, shape, SVG, image: a 3D image layer is
// the traced alpha extruded / inflated); id, name, transform, source and blend are kept. Model
// (3D-only) sources, backgrounds, groups and adjustment layers can't — `canApplyPreset` reports
// that and `applyPreset` throws.

export function canApplyPreset(layer: Layer, preset: StylePreset): layer is TitleLayer {
  if (!isTitleLayer(layer)) return false;
  if (layer.kind === preset.kind) return true;
  return layer.source.kind !== 'model';
}

/** Copies effects with fresh ids; px params × `k`, handle positions × `k` then shifted by (dx, dy). */
function transferEffects(effects: EffectInstance[], k: number, dx: number, dy: number): EffectInstance[] {
  return effects.map((fx) => {
    const params = structuredClone(fx.params);
    const def = getEffect(fx.type);
    if (def) {
      const handleKeys = new Map<string, number>();
      for (const h of def.handles ?? []) {
        handleKeys.set(h.x, dx);
        handleKeys.set(h.y, dy);
      }
      for (const pd of def.params) {
        const v = params[pd.key];
        if (pd.kind !== 'number' || typeof v !== 'number') continue;
        const shift = handleKeys.get(pd.key);
        if (shift !== undefined) params[pd.key] = v * k + shift;
        else if (pd.unit === 'px') params[pd.key] = v * k;
      }
    }
    return { ...fx, id: uid(), params };
  });
}

/** Copies effects with fresh ids and handle positions made relative to (x, y), the layer position. */
function relativeEffects(effects: EffectInstance[], x: number, y: number): EffectInstance[] {
  return effects.map((fx) => {
    const params = structuredClone(fx.params);
    for (const h of getEffect(fx.type)?.handles ?? []) {
      if (typeof params[h.x] === 'number') params[h.x] = (params[h.x] as number) - x;
      if (typeof params[h.y] === 'number') params[h.y] = (params[h.y] as number) - y;
    }
    return { ...fx, id: uid(), params };
  });
}

/** Ids of the rims / bands of `l`, in style-list order (the PresetPartKey index). */
function elementIds(l: TitleLayer, kind: 'rim' | 'band'): string[] {
  if (l.kind === 'title2d') return kind === 'rim' ? l.style.rims.map((r) => r.id) : [];
  return kind === 'band' ? l.style3d.bands.map((b) => b.id) : [];
}

/** The part of `l` at look position `key`, or null when its style has no part there. */
function partAt(l: TitleLayer, key: PresetPartKey): PartKey | null {
  const { kind, id } = parsePartKey(key);
  let part: PartKey | null = null;
  if (kind === 'face' || kind === 'side') part = kind;
  else {
    const elId = elementIds(l, kind)[Number(id)];
    if (elId !== undefined) part = kind === 'rim' ? rimKey(elId) : bandKey(elId);
  }
  // layerParts drops what the style draws no part for: a 2D side, a hidden face.
  return part && layerParts(l).includes(part) ? part : null;
}

/** Look position of part `key` of `l` (null for a stale key). */
function positionOf(l: TitleLayer, key: PartKey): PresetPartKey | null {
  const { kind, id } = parsePartKey(key);
  if (kind === 'face' || kind === 'side') return kind;
  const i = elementIds(l, kind).indexOf(id ?? '');
  return i < 0 ? null : `${kind}:${i}`;
}

/**
 * Applies `preset` to title `layer` alone: its style (material links with fresh ids), effects and
 * part effects (its companions need the project: applyPresetToProject).
 */
export const applyPreset: ApplyPreset = (layer, preset, opts) => {
  if (!canApplyPreset(layer, preset)) throw new Error(`“${preset.name}” can't be applied to this layer`);
  const k = preset.refSize > 0 ? layer.source.size / preset.refSize : 1;
  const { x, y } = layer.transform;
  const effects = transferEffects(preset.effects, k, x, y);
  let source = layer.source;
  if (opts.applyFont && preset.fontId && source.kind === 'text') source = { ...source, fontId: preset.fontId };
  const { id, name, visible, solo, locked, guide, blend, transform, clip, masks, parentId, warp, distort, weight } = layer;
  // Outline ops (warp / distort / weight) are geometry like the source: they stay with the layer,
  // as do its group membership, clipping and masks.
  const base = { id, name, visible, solo, locked, guide, blend, transform, clip, masks, warp, distort, weight, effects, partEffects: {}, ...(parentId ? { parentId } : {}) };
  let out: TitleLayer;
  if (preset.kind === 'title2d') {
    if (!preset.style) throw new Error(`Preset “${preset.name}” has no 2D style`);
    if (source.kind === 'model') throw new Error('3D model layers cannot take a 2D style');
    out = { ...base, kind: 'title2d', source, style: structuredClone(preset.style) };
  } else {
    if (!preset.style3d) throw new Error(`Preset “${preset.name}” has no 3D style`);
    out = { ...base, kind: 'title3d', source, style3d: lookStyle3D(preset.style3d) };
  }
  const partEffects: PartEffects = {};
  for (const [pos, list] of Object.entries(preset.partEffects) as [PresetPartKey, EffectInstance[] | undefined][]) {
    const part = list?.length ? partAt(out, pos) : null;
    if (part) partEffects[part] = transferEffects(list ?? [], k, x, y);
  }
  const styled = { ...out, partEffects };
  return opts.keepLinks ? styled : (freshLinks(styled).layer as TitleLayer);
};

/**
 * Applies look `preset` to layer `layerId` of `project`: the layer's style, effects and part
 * effects (applyPreset), then its companions and group effects (placeLook). `keepLinks` (pasting
 * a copied style): material links the project already has stay, unknown ones are dropped;
 * otherwise the look's links get fresh ids and its link names join the project's.
 */
export function applyPresetToProject(project: Project, layerId: string, preset: StylePreset, opts: { applyFont: boolean; keepLinks?: boolean }): Project {
  const layer = project.layers.find((l) => l.id === layerId);
  if (!layer) throw new Error(`No layer ${layerId}`);
  let styled: Layer;
  let named = project;
  if (opts.keepLinks) {
    const known = new Set([...Object.keys(project.materialLinks ?? {}), ...linkedSlots(project).map((s) => s.link)]);
    styled = remapLayerLinks(applyPreset(layer, preset, opts), (id) => (known.has(id) ? undefined : null));
  } else {
    const fresh = freshLinks(applyPreset(layer, preset, { ...opts, keepLinks: true }), preset.links);
    styled = fresh.layer;
    named = addLinkNames(project, fresh.links);
  }
  return placeLook({ ...named, layers: project.layers.map((l) => (l.id === layerId ? styled : l)) }, layerId, preset);
}

/**
 * Layer `layerId`'s companions replaced by look `preset`'s (px × the title's size / `refSize`),
 * then `extra` ones (authored for the layer: not scaled). They go in a group with the layer
 * (placeCompanions: the group it already sits in on its own, else a new one named after it) that
 * also carries the look's `groupEffects` (marked `fromPreset`, replacing the previous look's);
 * `outer` companions follow that group, in a group around it.
 */
export function placeLook(project: Project, layerId: string, preset: Pick<StylePreset, 'companions' | 'groupEffects' | 'refSize'>, extra: readonly Companion[] = []): Project {
  const layer = project.layers.find((l) => l.id === layerId);
  if (!layer) throw new Error(`No layer ${layerId}`);
  const k = isTitleLayer(layer) && preset.refSize > 0 ? layer.source.size / preset.refSize : 1;
  const list = [...(preset.companions ?? []).map((c) => ({ c, k })), ...extra.map((c) => ({ c, k: 1 }))];
  const { x, y } = layer.transform;
  const made = (outer: boolean, place: Companion['place'], follow: string) =>
    list.filter(({ c }) => !!c.outer === outer && c.place === place).map(({ c, k }) => companionLayer(c, layer, k, follow));
  const groupFx = transferEffects(preset.groupEffects ?? [], k, x, y).map((fx): EffectInstance => ({ ...fx, fromPreset: true }));
  let layers = placeCompanions(project.layers, layerId, made(false, 'below', layerId), made(false, 'above', layerId), groupFx.length ? { effects: groupFx } : undefined);
  const own = ownGroupOf(layers, layerId);
  if (own) layers = layers.map((l) => (l === own ? { ...own, effects: [...groupFx, ...own.effects.filter((fx) => !fx.fromPreset)] } : l));
  if (list.some(({ c }) => c.outer)) {
    const inner = own?.id ?? layerId;
    const below = made(true, 'below', inner);
    const above = made(true, 'above', inner);
    const added = new Set([...below, ...above].map((c) => c.id));
    layers = placeCompanions(layers, inner, below, above).map((l) => (added.has(l.id) ? { ...l, companionOf: layerId } : l));
  }
  // Groups made for the previous look's companions that hold nothing now go again.
  return { ...project, layers: dissolveCompanionGroups(layers, layerId) };
}

/**
 * Companion `c` of a look as a generator layer for `target`: px params × `k`, following layer
 * `follow` (or, free, placed at the target's position), with the look's blend, opacity and effects
 * (px × `k`, handles relative to the target's position). placeCompanions marks and places it.
 */
function companionLayer(c: Companion, target: Layer, k: number, follow: string): GeneratorLayer {
  const def = getGenerator(c.generator.type);
  const params = structuredClone(c.generator.params);
  for (const pd of def?.params ?? []) {
    const v = params[pd.key];
    if (pd.kind === 'number' && pd.unit === 'px' && typeof v === 'number') params[pd.key] = v * k;
  }
  const free = def?.follow && params.follow === '';
  if (def?.follow && !free) params.follow = follow;
  const base = layerBase(def?.label ?? c.generator.type);
  const { x, y } = target.transform;
  return {
    ...base,
    kind: 'generator',
    generator: { type: c.generator.type, params },
    blend: c.blend ?? 'normal',
    transform: { ...base.transform, ...(free ? { x, y } : {}), opacity: c.opacity ?? 1 },
    effects: transferEffects(c.effects ?? [], k, x, y),
  };
}

/**
 * Companion generator `g` of `layer` (in group `own`, if any) as a look's companion: following the
 * layer → `follow` absent, following `own` → `outer`, else free ('', its handles made relative to
 * the layer position, as effect handles).
 */
function companionOfLook(g: GeneratorLayer, layer: TitleLayer, own: Layer | null, place: Companion['place']): Companion {
  const def = getGenerator(g.generator.type);
  const params = structuredClone(g.generator.params);
  const { x, y } = layer.transform;
  const outer = !!own && def?.follow !== undefined && params.follow === own.id;
  if (def?.follow && (params.follow === layer.id || outer)) delete params.follow;
  else if (def?.follow) {
    params.follow = '';
    for (const h of def.handles ?? []) {
      if (typeof params[h.x] === 'number') params[h.x] = (params[h.x] as number) + g.transform.x - x;
      if (typeof params[h.y] === 'number') params[h.y] = (params[h.y] as number) + g.transform.y - y;
    }
  }
  return {
    generator: { type: g.generator.type, params },
    place,
    ...(g.blend !== 'normal' ? { blend: g.blend } : {}),
    ...(g.transform.opacity !== 1 ? { opacity: g.transform.opacity } : {}),
    ...(g.effects.length ? { effects: relativeEffects(g.effects, x, y) } : {}),
    ...(outer ? { outer: true as const } : {}),
  };
}

/** `l` with the default comp's value for every missing field (a look's complete lighting). */
export function fullLighting(l: Partial<Lighting3D>): Lighting3D {
  return { ...effectiveLighting(defaultComp(), null), ...structuredClone(l) };
}

/** A look's 3D style for a layer: a copy whose lights get fresh ids. */
function lookStyle3D(s: Title3DProps): Title3DProps {
  const style3d = structuredClone(s);
  const { lights } = style3d.lighting;
  if (lights) style3d.lighting.lights = lights.map((l) => ({ ...l, id: uid() }));
  return style3d;
}

/**
 * Captures title layer `layerId`'s look (style, layer effects, part effects, companions and the
 * effects of the group it sits in with them) as a user preset. A 3D look records the layer's
 * effective lighting (model/lighting.ts) as overrides of every value, so applying it reproduces the reflections.
 */
export function presetFromLayer(project: Project, layerId: string, name: string, group: string): StylePreset {
  const layer = project.layers.find((l) => l.id === layerId);
  if (!layer || !isTitleLayer(layer)) throw new Error('Only title layers have a style');
  const { x, y } = layer.transform;
  const partEffects: StylePreset['partEffects'] = {};
  for (const [key, list] of Object.entries(layer.partEffects) as [PartKey, EffectInstance[] | undefined][]) {
    const pos = list?.length ? positionOf(layer, key) : null;
    if (pos) partEffects[pos] = relativeEffects(list ?? [], x, y);
  }
  const own = ownGroupOf(project.layers, layer.id);
  const companions = companionsOf(project.layers, layer.id).map((g) => {
    // Outer companions sit around the layer's own group, the others around the layer.
    const pivot = own && g.parentId !== own.id ? own : layer;
    return companionOfLook(g, layer, own, project.layers.indexOf(g) < project.layers.indexOf(pivot) ? 'below' : 'above');
  });
  const groupEffects = own?.effects.length ? relativeEffects(own.effects, x, y) : [];
  const links = linkNamesOf(project, layer);
  const preset: StylePreset = {
    id: `user-${uid()}`,
    name,
    group,
    kind: layer.kind,
    effects: relativeEffects(layer.effects, x, y),
    ...(companions.length ? { companions } : {}),
    ...(groupEffects.length ? { groupEffects } : {}),
    partEffects,
    ...(Object.keys(links).length ? { links } : {}),
    refSize: layer.source.size,
    fontId: layer.source.kind === 'text' ? layer.source.fontId : undefined,
    builtin: false,
  };
  if (layer.kind === 'title2d') preset.style = structuredClone(layer.style);
  else {
    const style3d = structuredClone(layer.style3d);
    preset.style3d = { ...style3d, lighting: allLighting(effectiveLighting(project.comp, layer)) };
  }
  return preset;
}
