import { migrateEffects, migrateStyle2D, migrateStyle3D } from '../io/project';
import { contentEffectsOfLook } from '../io/migrate/contentEffects';
import { dedupeEffects } from '../io/migrate/effectDedupe';
import { migrateMaterialEffects } from '../io/migrate/materialEffects';
import { uid } from '../model/defaults';
import type { EffectInstance, Lighting3D } from '../model/types';
import { fullLighting } from './apply';
import { msg, MsgError } from '../store/msg';
import type { PresetPartKey, StylePreset } from './types';

// User style presets ("My Styles"), persisted in localStorage (a preset is a few KB of JSON).
// Import/export uses a small JSON file format so looks can be shared between machines.

const STORAGE_KEY = 'pachislot-visuals.userPresets.v8';
/** Read in this order when the v8 key is absent; their presets are migrated (lighting as before v8) and written under STORAGE_KEY. */
const OLDER_STORAGE_KEYS = ['pachislot-visuals.userPresets.v7', 'pachislot-visuals.userPresets.v6', 'pachislot-visuals.userPresets.v5', 'pachislot-visuals.userPresets.v4'];
const FILE_FORMAT = 'pachislot-visuals/style-presets';
export const PRESET_FILE_EXT = '.pslot-styles.json';

interface PresetFile {
  format: typeof FILE_FORMAT;
  /** 8 = lighting as overrides; 7 = looks with companion generators; 4–7 files are read through the project migration. */
  version: 4 | 5 | 6 | 7 | 8;
  presets: StylePreset[];
}

const PART_POSITION = /^(face|side|(rim|band|plate):\d+)$/;

/** Stored part effects with malformed keys and empty / non-list values dropped (v4 / v5 looks have none). */
function migratePartEffects(raw: unknown): StylePreset['partEffects'] {
  const out: StylePreset['partEffects'] = {};
  if (!isObj(raw)) return out;
  for (const [key, list] of Object.entries(raw)) {
    if (PART_POSITION.test(key) && Array.isArray(list) && list.length) out[key as PresetPartKey] = migrateMaterialEffects(dedupeEffects(migrateEffects(list as EffectInstance[])));
  }
  return out;
}

/**
 * A stored or imported preset with every current field present: its style and effects go through
 * the project file's own migration (which only fills missing fields, so current data passes
 * unchanged), its old content effects become companions (contentEffectsOfLook); v4 / v5 looks get
 * no part effects. `legacy` (saved before v8): its 3D lighting becomes overrides as a project's
 * does (a look's lighting is complete, so it sets every value). 3D looks saved before per-layer
 * lighting kept theirs in `comp` (applied to the comp): it becomes their style3d.lighting,
 * completed with the default comp's.
 */
function migratePreset(stored: StylePreset & { comp?: Partial<Lighting3D> }, legacy: boolean): StylePreset {
  const { comp, ...p } = stored;
  const style3d = p.style3d && (legacy ? migrateStyle3D({ ...p.style3d, lighting: p.style3d.lighting ?? fullLighting(comp ?? {}) }, { docBlur: 0 }) : migrateStyle3D(p.style3d));
  return contentEffectsOfLook({
    ...p,
    effects: migrateMaterialEffects(dedupeEffects(migrateEffects(p.effects))),
    partEffects: migratePartEffects(p.partEffects),
    ...(p.style ? { style: migrateStyle2D(p.style) } : {}),
    ...(style3d ? { style3d } : {}),
  });
}

function readList(key: string, legacy: boolean): StylePreset[] | null {
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  const data: unknown = JSON.parse(raw);
  return Array.isArray(data) ? data.filter(isPreset).map((p) => migratePreset(p, legacy)) : [];
}

function load(): StylePreset[] {
  try {
    const current = readList(STORAGE_KEY, false);
    if (current) return current;
    for (const key of OLDER_STORAGE_KEYS) {
      const older = readList(key, true);
      if (!older) continue;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(older));
      return older;
    }
    return [];
  } catch (e) {
    console.warn('User presets could not be read', e);
    return [];
  }
}

function commit(next: StylePreset[]) {
  // Persist first: a quota error leaves the in-memory list unchanged and reaches the caller.
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  presets = next;
  for (const l of listeners) l();
}

// Shape checks for stored / imported presets, run BEFORE the v5 migration (which fills the v5
// fields). They cover every field the renderers read without a fallback that a v4 preset already
// had (Fill.span, Material2D.satin, custom bevel / gloss curves, Material3D gradient kind / span /
// scale / offset, BevelShape3D segments / curve, Title3DProps.skew / ao), so stale or hand-edited
// data is dropped instead of crashing the renderer.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;
const has = (o: Obj, type: 'number' | 'string' | 'boolean', keys: string[]) => keys.every((k) => typeof o[k] === type);

const isPattern = (v: unknown) =>
  isObj(v) && has(v, 'string', ['kind', 'color', 'color2']) && has(v, 'number', ['opacity', 'scale', 'angle', 'seed', 'shade', 'relief']);

const isCurve = (v: unknown) =>
  isObj(v) &&
  Array.isArray(v.points) &&
  v.points.length >= 2 &&
  v.points.every((p) => isObj(p) && has(p, 'number', ['x', 'y']) && typeof p.corner === 'boolean');

const SPANS = ['layer', 'line', 'char'];
const isSpan = (v: unknown) => typeof v === 'string' && SPANS.includes(v);

const isGradient = (v: unknown) =>
  isObj(v) && Array.isArray(v.stops) && v.stops.every((s) => isObj(s) && typeof s.pos === 'number' && typeof s.color === 'string');

const isFill = (v: unknown) =>
  isObj(v) && has(v, 'string', ['kind', 'color']) && has(v, 'number', ['angle', 'scale', 'offset']) && isSpan(v.span) && isGradient(v.gradient);

const isBevel2D = (v: unknown) => isObj(v) && has(v, 'string', ['profile', 'gloss']) && isCurve(v.profileCurve) && isCurve(v.glossCurve);

const isSatin = (v: unknown) =>
  isObj(v) &&
  typeof v.enabled === 'boolean' &&
  typeof v.invert === 'boolean' &&
  has(v, 'string', ['color', 'blend']) &&
  has(v, 'number', ['opacity', 'angle', 'distance', 'size']) &&
  isCurve(v.contour);

const isMaterial2D = (v: unknown) =>
  isObj(v) &&
  isFill(v.fill) &&
  isBevel2D(v.bevel) &&
  isObj(v.finish) &&
  isSatin(v.satin) &&
  isObj(v.texture) &&
  isObj(v.innerGlow) &&
  isObj(v.gloss) &&
  isPattern(v.pattern);

const isMaterial3D = (v: unknown) =>
  isObj(v) &&
  has(v, 'string', ['preset', 'color', 'emissive', 'gradientKind']) &&
  has(v, 'number', [
    'gradientAngle',
    'gradientScale',
    'gradientOffset',
    'metalness',
    'roughness',
    'reflectivity',
    'specBoost',
    'clearcoat',
    'iridescence',
    'transmission',
    'ior',
    'dispersion',
    'flakes',
    'flakeScale',
    'emissiveIntensity',
    'opacity',
  ]) &&
  isSpan(v.gradientSpan) &&
  (v.gradient === undefined || isGradient(v.gradient)) &&
  isPattern(v.pattern);

const isBevelShape3D = (v: unknown) => isObj(v) && typeof v.profile === 'string' && has(v, 'number', ['width', 'depth', 'segments', 'curve']);

const isStyle2D = (v: unknown) =>
  isObj(v) && isMaterial2D(v.face) && Array.isArray(v.rims) && v.rims.every((r) => isObj(r) && typeof r.width === 'number' && isMaterial2D(r.material));

const isStyle3D = (v: unknown) =>
  isObj(v) &&
  isMaterial3D(v.face) &&
  isMaterial3D(v.side) &&
  Array.isArray(v.bands) &&
  v.bands.every((b) => isBevelShape3D(b) && isMaterial3D((b as Obj).material)) &&
  Array.isArray(v.backplates) &&
  v.backplates.every((p) => isObj(p) && isBevelShape3D(p.bevel) && isMaterial3D(p.face) && isMaterial3D(p.side)) &&
  isObj(v.skew) &&
  has(v.skew, 'number', ['x', 'y']) &&
  isObj(v.ao) &&
  has(v.ao, 'boolean', ['enabled']) &&
  has(v.ao, 'number', ['radius', 'intensity']) &&
  isObj(v.shadow) &&
  has(v.shadow, 'boolean', ['enabled']) &&
  has(v.shadow, 'string', ['color']) &&
  has(v.shadow, 'number', ['opacity', 'softness']) &&
  isObj(v.glint) &&
  has(v.glint, 'boolean', ['enabled']) &&
  has(v.glint, 'string', ['tint']) &&
  has(v.glint, 'number', ['threshold', 'intensity', 'radius', 'streaks', 'length', 'angle']);

function isPreset(v: unknown): v is StylePreset {
  if (!isObj(v)) return false;
  return (
    has(v, 'string', ['id', 'name', 'group']) &&
    typeof v.refSize === 'number' &&
    v.refSize > 0 &&
    Array.isArray(v.effects) &&
    (v.partEffects === undefined || isObj(v.partEffects)) &&
    ((v.kind === 'title2d' && isStyle2D(v.style)) || (v.kind === 'title3d' && isStyle3D(v.style3d)))
  );
}

// After the validators: load() runs at module init and needs them initialised.
const listeners = new Set<() => void>();
let presets: StylePreset[] = load();

/** useSyncExternalStore-compatible store of the user's presets (newest last). */
export const userPresets = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  getSnapshot: (): readonly StylePreset[] => presets,
};

export function addUserPreset(preset: StylePreset) {
  commit([...presets, { ...preset, builtin: false }]);
}

export function renameUserPreset(id: string, name: string) {
  commit(presets.map((p) => (p.id === id ? { ...p, name } : p)));
}

export function deleteUserPreset(id: string) {
  commit(presets.filter((p) => p.id !== id));
}

export function exportUserPresets(): Blob {
  const file: PresetFile = { format: FILE_FORMAT, version: 8, presets: [...presets] };
  return new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' });
}

/**
 * Adds the presets from an exported file. Imported presets get fresh ids (so importing twice
 * duplicates rather than silently replacing). Returns how many were added.
 */
export function importUserPresets(text: string): number {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new MsgError(msg('Not a style preset file'));
  }
  const file = data as Partial<PresetFile>;
  if (typeof data !== 'object' || data === null || file.format !== FILE_FORMAT || !Array.isArray(file.presets)) {
    throw new MsgError(msg('Not a style preset file'));
  }
  if (file.version !== 4 && file.version !== 5 && file.version !== 6 && file.version !== 7 && file.version !== 8)
    throw new MsgError(msg('Unsupported preset file version {version} (expected 4 to 8)', { version: String(file.version) }));
  const valid = file.presets.filter(isPreset).map((p) => ({ ...migratePreset(p, file.version !== 8), id: `user-${uid()}`, builtin: false }));
  if (valid.length === 0) throw new MsgError(msg('The file contains no usable presets'));
  commit([...presets, ...valid]);
  return valid.length;
}
