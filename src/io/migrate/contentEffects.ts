import { FROM_EFFECT, type Companion, type FromEffectLayer } from '../../generators/fromEffect';
import { getGenerator } from '../../generators/registry';
import { placeCompanions } from '../../model/companions';
import { layerBase, uid } from '../../model/defaults';
import { isTitleLayer } from '../../model/parts';
import type { EffectInstance, GeneratorLayer, Layer, PartEffects, PartKey, Project } from '../../model/types';
import type { StylePreset } from '../../presets/types';

// Migration step 4 (see src/io/migrate/): effects that drew new content (Sparkles, Star Glint,
// Burst Rays, Particle Burst, Fire, Smoke, Corona, Lightning, Ink Splatter, Backlight, Lens Flare)
// became follow generators (src/generators/fromEffect.ts maps each instance). A stack keeps its
// order exactly: it is cut at its content effects, and
//
//   [e1, sparkles, e2]   → group{ effects [e2] } holding L{ effects [e1] } and a Glints layer
//                          following L (it reads L as styled by e1 and its pixels before them,
//                          as the effect did), Add, above L;
//   consecutive content  → sibling companions in one group (later 'behind' ones further down);
//   [.., c1, e2, c2, e3] → the next content run follows the group of the run before, in a group
//                          around it (groups nest only where an effect runs between two runs).
//
// Each group is a new one named after the layer (only the last, with no effects after the run,
// may be the group the layer already sits in on its own) and takes the layer's place, clipping,
// blend and opacity (placeCompanions), so it composites as the layer did and an Add companion
// lights only what the effect lit. The layer's masks move to the first group when they are all
// in comp space (unlinked or layer masks); linked ones stay on the layer, so its companions show
// outside them. A clip base's companions go over its whole clip group (its clipped layers drew
// over the effects before). Disabled effects become hidden companions. Every companion is marked
// `companionOf` the layer, so a look applied to it replaces them.
//
// Part effects: content effects of a style part (no factory look or template has one) follow the
// whole layer and run first, before the layer's effects (which then go to the group).
// Adjustment layers: content effects drew on the composite below them; nothing follows that, so
// they are dropped.
// User looks (StylePreset): the same cut gives `effects`, `companions`, `groupEffects` and `outer`
// companions; a third content run joins the outer ones (the effects between are kept in front).
// Particles' old Layer-alpha emitter (Emitter layer param) becomes following that layer.
//
// Idempotent: only the removed effect types and the old emitter param are touched.

const isContent = (fx: EffectInstance) => fx.type in FROM_EFFECT;

/** A stack cut at its content effects: the plain effects before the first run, then each run of content effects with the plain effects after it. */
interface Cut {
  first: EffectInstance[];
  runs: { content: EffectInstance[]; after: EffectInstance[] }[];
}

function cut(effects: readonly EffectInstance[]): Cut {
  const out: Cut = { first: [], runs: [] };
  for (const fx of effects) {
    const run = out.runs.at(-1);
    if (isContent(fx)) {
      if (run && !run.after.length) run.content.push(fx);
      else out.runs.push({ content: [fx], after: [] });
    } else if (run) run.after.push(fx);
    else out.first.push(fx);
  }
  return out;
}

/** The FROM_EFFECT companions of one old instance, bottom first. */
const fromEffect = (fx: EffectInstance): FromEffectLayer[] => [FROM_EFFECT[fx.type](fx.params)].flat();

/** Generator layer of companion `r` following `follow` (unless the entry made it free). */
function companionLayer(r: FromEffectLayer, follow: string): GeneratorLayer {
  const def = getGenerator(r.type);
  const base = layerBase(def?.label ?? r.type);
  return {
    ...base,
    kind: 'generator',
    generator: { type: r.type, params: 'follow' in r.params ? r.params : { ...r.params, follow } },
    blend: r.blend ?? 'normal',
    transform: { ...base.transform, opacity: r.opacity ?? 1 },
    effects: (r.effects ?? []).map((fx) => ({ ...fx, id: uid() })),
  };
}

/** `layers` with layer `id`'s effect stack (part content effects first) cut into companions and groups (see above). */
function convertLayer(layers: Layer[], id: string, partContent: EffectInstance[]): Layer[] {
  const owner = layers.find((l) => l.id === id);
  if (!owner) return layers;
  const { first, runs } = cut([...partContent, ...owner.effects]);
  if (!runs.length) return layers;
  const masks = owner.masks.length && owner.masks.every((m) => !m.linked || m.kind === 'layer') ? owner.masks : [];
  let out = layers.map((l) => (l.id === id ? { ...l, effects: first, ...(masks.length ? { masks: [] } : {}) } : l));
  let target = id;
  runs.forEach(({ content, after }, i) => {
    const below: GeneratorLayer[] = [];
    const above: GeneratorLayer[] = [];
    const hidden = new Set<string>();
    for (const fx of content) {
      for (const r of fromEffect(fx)) {
        const g = companionLayer(r, target);
        if (!fx.enabled) hidden.add(g.id);
        // A later 'behind' effect drew under everything before it.
        if (r.place === 'below') below.unshift(g);
        else above.push(g);
      }
    }
    const before = new Set(out.map((l) => l.id));
    const fresh = after.length > 0 || i < runs.length - 1;
    out = placeCompanions(out, target, below, above, fresh ? { effects: after, fresh } : undefined);
    const group = out.find((l) => l.id === out.find((x) => x.id === target)?.parentId);
    out = out.map((l) => {
      if (l.kind === 'generator' && (hidden.has(l.id) || l.companionOf === target)) return { ...l, companionOf: id, ...(hidden.has(l.id) ? { visible: false } : {}) };
      if (i === 0 && masks.length && l === group && !before.has(l.id)) return { ...l, masks };
      return l;
    });
    if (group) target = group.id;
  });
  return out;
}

/** Particles' old Layer-alpha emitter: its Emitter layer param became `follow`. */
function migrateEmitter(l: Layer): Layer {
  if (l.kind !== 'generator' || l.generator.type !== 'particles' || !('layer' in l.generator.params)) return l;
  const { layer, ...params } = l.generator.params;
  return { ...l, generator: { ...l.generator, params: { ...params, follow: typeof layer === 'string' ? layer : '', edgeWidth: 6 } } };
}

/** Step 4 over a whole project: every layer's, group's and part's content effects become companions; adjustment layers drop theirs. */
export function contentEffects(project: Project): Project {
  let layers = project.layers.map(migrateEmitter);
  const owners = layers.filter((l) => l.effects.some(isContent) || (isTitleLayer(l) && Object.values(l.partEffects).some((list) => list?.some(isContent)))).map((l) => l.id);
  for (const id of owners) {
    // The current object: wrapping an earlier owner may have moved this one into its group.
    const owner = layers.find((l) => l.id === id)!;
    if (owner.kind === 'adjustment') {
      layers = layers.map((l) => (l === owner ? { ...owner, effects: owner.effects.filter((fx) => !isContent(fx)) } : l));
      continue;
    }
    let partContent: EffectInstance[] = [];
    if (isTitleLayer(owner)) {
      const partEffects: PartEffects = {};
      for (const [key, list] of Object.entries(owner.partEffects) as [PartKey, EffectInstance[] | undefined][]) {
        partContent = [...partContent, ...(list ?? []).filter(isContent)];
        partEffects[key] = (list ?? []).filter((fx) => !isContent(fx));
      }
      if (partContent.length) layers = layers.map((l) => (l === owner ? { ...owner, partEffects } : l));
    }
    layers = convertLayer(layers, id, partContent);
  }
  return { ...project, layers };
}

/** A look's companion from one old content effect's companion. */
const lookCompanion = (r: FromEffectLayer, outer: boolean): Companion => ({
  generator: { type: r.type, params: r.params },
  place: r.place,
  ...(r.blend ? { blend: r.blend } : {}),
  ...(r.opacity !== undefined ? { opacity: r.opacity } : {}),
  ...(r.effects?.length ? { effects: r.effects.map((fx) => ({ ...fx, id: uid() })) } : {}),
  ...(outer ? { outer: true as const } : {}),
});

/**
 * Step 4 for a user look: its content effects (part ones first) become `companions` (disabled
 * ones dropped), the effects after the first run its `groupEffects`, a later run `outer`
 * companions (see above).
 */
export function contentEffectsOfLook(preset: StylePreset): StylePreset {
  const partContent = Object.values(preset.partEffects).flatMap((list) => (list ?? []).filter(isContent));
  if (!partContent.length && !preset.effects.some(isContent)) return preset;
  const { first, runs } = cut([...partContent, ...preset.effects]);
  const companions = [...(preset.companions ?? [])];
  const groupEffects = [...(preset.groupEffects ?? [])];
  runs.forEach(({ content, after }, i) => {
    for (const fx of content) if (fx.enabled) for (const r of fromEffect(fx)) companions.push(lookCompanion(r, i > 0));
    groupEffects.push(...after);
  });
  const partEffects = Object.fromEntries(Object.entries(preset.partEffects).map(([k, list]) => [k, (list ?? []).filter((fx) => !isContent(fx))]));
  return { ...preset, effects: first, partEffects, companions, ...(groupEffects.length ? { groupEffects } : {}) };
}
