import { getEffect } from '../effects/registry';
import { getGenerator } from '../generators/registry';
import { ADJUSTMENT_NAMES } from '../model/defaults';
import { isTitleLayer, parsePartKey, partEffectsOf, type TitleLayer } from '../model/parts';
import type { EffectInstance, Layer, PartKey, Project } from '../model/types';
import { effectName } from './effects';
import { msg, verbatim, type Msg, type Text } from './msg';
import type { Path } from './paths';

// Human-readable History labels ("Rim width", "Face bevel depth", "Move") derived from the path
// an edit touched. Explicit labels passed to the store win; these cover every other edit. Each
// word is its own message (translated at display), joined by a `{a} {b}` template.

/** Path segments that name a part of the document; '' = structural, contributes no word. */
const NOUNS: Record<string, string> = {
  style: '',
  style3d: '',
  source: '',
  material: '',
  params: '',
  comp: '',
  stops: '',
  chars: 'Character',
  face: 'Face',
  face3d: 'Face',
  rims: 'Rim',
  bands: 'Bevel band',
  backplates: 'Plate',
  side: 'Side',
  bevel: 'Bevel',
  finish: 'Finish',
  texture: 'Texture',
  innerGlow: 'Inner glow',
  satin: 'Satin',
  reflection: 'Reflection',
  glass: 'Glass',
  sheen: 'Sheen',
  gloss: 'Gloss',
  pattern: 'Pattern',
  fill: 'Fill',
  gradient: 'Gradient',
  warp: 'Warp',
  shadow: 'Shadow',
  glint: 'Glint',
  tail: 'Tail',
  camera: 'Camera',
  environment: 'Environment',
  lights: 'Light',
  background: 'Background',
  effects: 'Effect',
};

/** Leaf keys whose camelCase split would read badly. */
const LEAVES: Record<string, string> = {
  x: 'X',
  y: 'Y',
  z: 'Z',
  dx: 'offset X',
  dy: 'offset Y',
  rotX: 'tilt',
  rotY: 'turn',
  rotZ: 'rotation',
  fontId: 'font',
  color: 'colour',
  color2: 'colour 2',
  enabled: 'on/off',
  fillCounters: 'fill counters',
  zOffset: 'distance',
  fov: 'FOV',
};

/** Leaf keys whose word means something else elsewhere in the UI: their i18n context (“Close” = close a plate's gaps, not a dialog). */
const LEAF_CTX: Record<string, string> = {
  close: 'plate',
};

/** Transform keys → the verb a designer thinks in. */
const TRANSFORM_VERBS: Record<string, string> = {
  x: 'Move',
  y: 'Move',
  z: 'Move',
  rotX: 'Rotate X',
  rotY: 'Rotate Y',
  rotZ: 'Rotate',
  scale: 'Scale',
  opacity: 'Opacity',
};

/** Layer-root keys edited as a whole (row toggles, rename). */
const LAYER_KEYS: Record<string, string> = {
  name: 'Rename layer',
  visible: 'Visibility',
  solo: 'Solo',
  locked: 'Lock',
  guide: 'Guide',
  blend: 'Blend mode',
  effects: 'Effects',
  style: 'Style',
  style3d: 'Style',
  source: 'Source',
  warp: 'Warp',
  clip: 'Clipping mask',
  partEffects: 'Effects',
  masks: 'Layer mask',
};

const humanize = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Join words (English keys, each capitalised), lowering all but the first: “Rim bevel depth”. */
function phrase(words: readonly Msg[]): Text {
  if (words.length === 0) return 'Edit';
  if (words.length === 1) return words[0];
  const [a, b, c] = words.map((w, i): Msg => (i > 0 ? { ...w, lower: true } : w));
  return words.length === 2 ? msg('{a} {b}', { a, b }) : msg('{a} {b} {c}', { a, b, c });
}

/** Name of a style part: Face, Side, Rim 2, Band 1, Plate 1 (rims / bands / plates counted from the face outward, as listed). */
export function partLabel(layer: TitleLayer, part: PartKey): Text {
  const { kind, id } = parsePartKey(part);
  if (kind === 'face') return 'Face';
  if (kind === 'side') return 'Side';
  const list: readonly { id: string }[] =
    layer.kind === 'title2d' ? (kind === 'rim' ? layer.style.rims : []) : kind === 'band' ? layer.style3d.bands : kind === 'plate' ? layer.style3d.backplates : [];
  const n = list.findIndex((x) => x.id === id) + 1;
  return msg(kind === 'rim' ? 'Rim {n}' : kind === 'band' ? 'Band {n}' : 'Plate {n}', { n });
}

/** Name of a layer mask: Mask 1, Mask 2… in list order. */
export function maskLabel(layer: Layer, maskId: string): Text {
  return msg('Mask {n}', { n: layer.masks.findIndex((m) => m.id === maskId) + 1 });
}

/** What an effect added to `part` of `layer` runs on: that part (“Rim 2”) or, for `null`, the layer by its name. */
export const effectOwnerLabel = (layer: Layer, part: PartKey | null): Text => (part !== null && isTitleLayer(layer) ? partLabel(layer, part) : verbatim(layer.name));

/** “{owner} {param}” for an edit of param `key` of an effect / generator named `owner` whose params are `defs`. */
const paramLabel = (owner: Msg, defs: readonly { key: string; label: string }[] | undefined, key: string): Text =>
  msg('{effect} {param}', { effect: owner, param: { en: defs?.find((p) => p.key === key)?.label ?? capital(humanize(key)), lower: true } });

/** “{adjustment} {field}” for an edit at `path` inside an adjustment named `name` (a layer's or an Adjust effect's); the name alone for the whole adjustment. */
function adjustmentLabel(name: Msg, path: Path): Text {
  const leaf = path[path.length - 1];
  return path.length === 0 || typeof leaf !== 'string' ? name : msg('{a} {b}', { a: name, b: { en: capital(LEAVES[leaf] ?? humanize(leaf)), lower: true } });
}

/** Label for an edit of effect `fx` at `rest` (the path inside the effect). */
function effectLabel(fx: EffectInstance | undefined, rest: Path): Text {
  const def = fx ? getEffect(fx.type) : undefined;
  const effect = fx ? effectName(fx) : msg('Effect');
  // An Adjust effect is named by its adjustment, its fields worded as on an adjustment layer: “Levels gamma”.
  if (fx?.type === 'adjust' && rest[0] === 'params' && rest[1] === 'adjustment') return adjustmentLabel(effect, rest.slice(2));
  // Inside a structured param (a Material2D): its own field words, “Material bevel size”.
  if (rest[0] === 'params' && rest.length > 2) {
    const field = describePath(null, rest.slice(2));
    return msg('{a} {b}', { a: effect, b: typeof field === 'string' ? { en: field, lower: true } : 'parts' in field ? field : { ...field, lower: true } });
  }
  if (rest[0] === 'params' && typeof rest[1] === 'string') return paramLabel(effect, def?.params, rest[1]);
  if (rest[0] === 'enabled') return msg('{effect} on/off', { effect });
  return effect;
}

/** Label for a path relative to a layer (or to the project when `layer` is null). */
export function describePath(layer: Layer | null, path: Path): Text {
  if (path.length === 0) return layer ? msg('Edit “{name}”', { name: layer.name }) : 'Edit project';
  const head = path[0];
  if (layer && head === 'transform') {
    const key = path[1];
    return typeof key === 'string' ? (TRANSFORM_VERBS[key] ?? 'Transform') : 'Transform';
  }
  if (layer && head === 'effects' && typeof path[1] === 'number') return effectLabel(layer.effects[path[1]], path.slice(2));
  if (isTitleLayer(layer) && head === 'partEffects' && typeof path[1] === 'string') {
    const key = path[1] as PartKey;
    const part = partLabel(layer, key);
    const i = path[2];
    return typeof i === 'number' ? msg('{part}: {label}', { part, label: effectLabel(partEffectsOf(layer, key)[i], path.slice(3)) }) : msg('{part} effects', { part });
  }
  if (layer?.kind === 'adjustment' && head === 'adjustment') return adjustmentLabel(msg(ADJUSTMENT_NAMES[layer.adjustment.type], undefined, 'adjustment'), path.slice(1));
  if (layer?.kind === 'generator' && head === 'generator') {
    const def = getGenerator(layer.generator.type);
    const generator = msg(def?.label ?? 'Generator');
    return path[1] === 'params' && typeof path[2] === 'string' ? paramLabel(generator, def?.params, path[2]) : generator;
  }
  if (layer && head === 'masks' && typeof path[1] === 'number') {
    const mask = layer.masks[path[1]];
    const name = mask ? maskLabel(layer, mask.id) : 'Layer mask';
    const leaf = path[path.length - 1];
    return path.length < 3 || typeof leaf !== 'string' ? name : msg('{a} {b}', { a: name, b: { en: capital(LEAVES[leaf] ?? humanize(leaf)), lower: true, ctx: 'mask' } });
  }
  if (layer && path.length === 1 && typeof head === 'string' && LAYER_KEYS[head]) return LAYER_KEYS[head];
  if (!layer && path.length === 1 && head === 'name') return 'Rename project';

  const leaf = path[path.length - 1];
  const nouns = path
    .slice(0, -1)
    .filter((k): k is string => typeof k === 'string')
    .map((k) => NOUNS[k] ?? '')
    .filter(Boolean);
  // Name the part (first noun) and the innermost group (last noun): "Rim bevel depth".
  const words = (nouns.length > 1 && nouns[nouns.length - 1] !== nouns[0] ? [nouns[0], nouns[nouns.length - 1]] : nouns.slice(0, 1)).map((n) => msg(n));
  if (typeof leaf === 'number') return phrase(words);
  const leafWord = capital(LEAVES[leaf] ?? (NOUNS[leaf] || humanize(leaf)));
  if (leaf === 'rims' || leaf === 'bands' || leaf === 'backplates' || leaf === 'lights') return phrase([...words, msg(`${leafWord}s`)]);
  return phrase([...words, msg(leafWord, undefined, LEAF_CTX[leaf])]);
}

/**
 * The deepest path where `prev` and `next` differ along a single branch. Structural sharing
 * (see paths.ts) means untouched subtrees are the same object, so this is a cheap walk.
 * Stops where several keys changed, returning that node's path and the changed keys.
 */
function changedPath(prev: unknown, next: unknown): { path: (string | number)[]; keys: string[] } {
  const path: (string | number)[] = [];
  let a = prev;
  let b = next;
  for (;;) {
    if (a === b || a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return { path, keys: [] };
    if (Array.isArray(a) !== Array.isArray(b)) return { path, keys: [] };
    if (Array.isArray(a) && a.length !== (b as unknown[]).length) return { path, keys: [] };
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].filter((k) => ra[k] !== rb[k]);
    if (keys.length !== 1) return { path, keys };
    const k = Array.isArray(a) ? Number(keys[0]) : keys[0];
    path.push(k);
    a = ra[keys[0]];
    b = rb[keys[0]];
  }
}

/** A History label for an edit that came without one. */
export function diffLabel(prev: Project, next: Project): Text {
  if (prev.layers !== next.layers) {
    const before = new Map(prev.layers.map((l) => [l.id, l]));
    const after = new Map(next.layers.map((l) => [l.id, l]));
    const added = next.layers.filter((l) => !before.has(l.id));
    const removed = prev.layers.filter((l) => !after.has(l.id));
    if (added.length === 1 && removed.length === 0) return msg('Add “{name}”', { name: added[0].name });
    if (removed.length === 1 && added.length === 0) return msg('Delete “{name}”', { name: removed[0].name });
    if (added.length || removed.length) return 'Change layers';
    const changed = next.layers.filter((l) => before.get(l.id) !== l);
    if (changed.length === 0) return 'Reorder layers';
    if (changed.length > 1) return msg('Edit {n} layers', { n: changed.length });
    const layer = changed[0];
    const old = before.get(layer.id)!;
    const { path, keys } = changedPath(old, layer);
    if (path.length === 0 && keys.length && keys.every((k) => k in TRANSFORM_VERBS || k === 'transform')) return 'Transform';
    if (path.length === 1 && path[0] === 'transform') {
      const verbs = new Set(keys.map((k) => TRANSFORM_VERBS[k] ?? 'Transform'));
      return verbs.size === 1 ? [...verbs][0] : 'Transform';
    }
    if (path.length === 0 && (keys.includes('style') || keys.includes('style3d'))) return msg('Style “{name}”', { name: layer.name });
    return describePath(layer, path);
  }
  if (prev.comp !== next.comp) {
    const { path } = changedPath(prev.comp, next.comp);
    return path.length ? describePath(null, ['comp', ...path]) : 'Comp settings';
  }
  if (prev.name !== next.name) return 'Rename project';
  return 'Edit';
}
