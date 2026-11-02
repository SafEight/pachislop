import { addAsset, BUILTIN_FONTS, getAsset, listFonts, registerFont } from '../assets/registry';
import { getEffect } from '../effects/registry';
import { createTitle3DLayer, defaultComp, erode2D, glass2D, imageTrace, material3D, noDistort, noWarp, plateShape, reflection2D, sheen2D } from '../model/defaults';
import { noLighting } from '../model/lighting';
import type {
  Backplate3D,
  Bevel2D,
  CharAdjust,
  EffectInstance,
  Environment3D,
  EnvironmentOverrides,
  Layer,
  Lighting3D,
  LightingOverrides,
  Material2D,
  Material3D,
  PartEffects,
  Project,
  Rim2D,
  Satin2D,
  Title3DProps,
  TitleStyle2D,
} from '../model/types';
import { errorMsg, msg, MsgError, type Msg } from '../store/msg';
import { contentEffects } from './migrate/contentEffects';
import { effectDedupe } from './migrate/effectDedupe';
import { generatorParams } from './migrate/generatorParams';
import { materialEffects } from './migrate/materialEffects';

// `.pslot.json` project files: the Project JSON plus every referenced non-builtin font and binary
// asset, base64-encoded, so a file is self-contained. Builtin fonts are referenced by id only (they
// ship with the app and load lazily). Version 9 is written; version 4 to 8 files (and autosaves)
// are upgraded by `migrateProject`; versions 1–3 are rejected with a clear message.

export const PROJECT_EXT = '.pslot.json';

interface EmbeddedBlob {
  id: string;
  name: string;
  mime?: string;
  data: string; // base64
}

/** Project versions this app opens (older ones are upgraded on load). */
export type ProjectVersion = 4 | 5 | 6 | 7 | 8 | 9;

const isSupported = (v: unknown): v is ProjectVersion => v === 4 || v === 5 || v === 6 || v === 7 || v === 8 || v === 9;

export interface ProjectFile {
  format: 'pslot';
  version: ProjectVersion;
  project: Project;
  fonts: EmbeddedBlob[];
  assets: EmbeddedBlob[];
}

export interface Bundle {
  project: Project;
  fonts: { id: string; name: string; data: ArrayBuffer }[];
  assets: { id: string; name: string; mime: string; data: ArrayBuffer }[];
  /** Project version the data was saved as (4: see `compensateV4CharScale`). */
  version: ProjectVersion;
  /** Notes about the load (e.g. a v8 file upgraded to v9); empty for current files. */
  notes: Msg[];
}

export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export function fromBase64(s: string): ArrayBuffer {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Every string `assetId` / `customAssetId` anywhere inside `v` (sources, image fills, custom patterns, a 3D layer's own custom HDRI). */
function collectAssetIds(v: unknown, out: Set<string>): void {
  if (Array.isArray(v)) for (const x of v) collectAssetIds(x, out);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if ((k === 'assetId' || k === 'customAssetId') && typeof x === 'string') out.add(x);
      else collectAssetIds(x, out);
    }
  }
}

/** Ids of fonts and assets the project references (text fonts, source / image-fill / pattern assets, custom HDRIs of the comp and of 3D layers' own lighting). */
export function referencedIds(project: Project): { fontIds: Set<string>; assetIds: Set<string> } {
  const fontIds = new Set<string>();
  const assetIds = new Set<string>();
  for (const l of project.layers) {
    if ((l.kind === 'title2d' || l.kind === 'title3d') && l.source.kind === 'text') fontIds.add(l.source.fontId);
    collectAssetIds(l, assetIds);
  }
  const env = project.comp.environment.customAssetId;
  if (env) assetIds.add(env);
  return { fontIds, assetIds };
}

/** Project + referenced non-builtin fonts + referenced assets currently in the registry. */
export function collectBundle(project: Project): Omit<Bundle, 'notes' | 'version'> {
  const { fontIds, assetIds } = referencedIds(project);
  const builtin = new Set(BUILTIN_FONTS.map((f) => f.id));
  const fonts = listFonts()
    .filter((f) => !f.builtin && !builtin.has(f.id) && fontIds.has(f.id))
    .map((f) => ({ id: f.id, name: f.name, data: f.data }));
  const assets = [...assetIds].flatMap((id) => {
    const a = getAsset(id);
    return a ? [{ id: a.id, name: a.name, mime: a.mime, data: a.data }] : [];
  });
  return { project, fonts, assets };
}

/** Register a bundle's fonts/assets. Font failures are collected, not thrown. */
export async function installBundle(b: Omit<Bundle, 'notes' | 'version'>): Promise<Msg[]> {
  const errors: Msg[] = [];
  for (const f of b.fonts) {
    try {
      await registerFont(f.id, f.name, f.data);
    } catch (e) {
      errors.push(msg('Font "{name}": {error}', { name: f.name, error: errorMsg(e) }));
    }
  }
  for (const a of b.assets) if (!getAsset(a.id)) addAsset(a);
  return errors;
}

// ---------------------------------------------------------------------------------------------
// v4 / v5 / v6 / v7 / v8 → v9 migration
//
// Every function below fills fields that are MISSING with their current value and keeps whatever
// is present, so it is idempotent and safe on current data (user presets of any version go through
// the same helpers). Where a current default would change how stored older data renders, the old
// behaviour is filled instead:
// - Bevel2D.useGlobalLight → false: a v4 bevel keeps its own stored light angle / altitude.
// - effect params `useGlobalLight` (directional effects) → false: v4 shadows keep their angle.
// - effect param `follow` (Keyline, Contour Lines) → 'stack': they traced the stack below them.
// - TextSource.tateChuYoko → false: v4 vertical text set half-width runs sideways.
// v5 changed CharAdjust.scale to reflow the line; that needs font metrics, so it is compensated
// after loading by the async `compensateV4CharScale` (migrateText.ts), not here.
// v6 added clipping masks (`clip`, false), style-part effects (`partEffects`, none), nested groups
// and adjustment layers; older files have none of them, so nothing else changes. Later v6 files
// added `ImageSource.trace` (filled with `imageTrace()`) and `Title3DProps.faceImage` (1: it only
// applies to 3D image layers, which files without it cannot contain), then layer masks (`masks`,
// none), mirrored layers (`Transform.flipX` / `flipY`, false), per-layer 3D lighting
// (`Title3DProps.lighting`, null: the layer keeps rendering with the comp's lighting) and the 2D
// reflection map (`Material2D.reflection`, filled with `reflection2D()`: off) and the Fit bevel
// scaling (`Bevel2D.sizeMode` 'fixed', `fit` 70: the bevel keeps its absolute size), then the
// material fields of the merged Material effect (`Material2D.refraction` 0, `glass` and `sheen`
// off, `Texture2D.angle` 0: nothing changes), then the environment blur and tiling (`blur` 0,
// `repeatX` / `repeatY` 1 on the comp's, a layer's own and a part's own environment: reflections
// as before; a whole-number `repeat` from a short-lived build becomes `repeatX`).
// v7 reduced everything to primitives (layers make pixels, effects change them, masks decide
// where, groups combine): the steps in src/io/migrate/ move generator post-processing params to
// effects / masks / layers, fold duplicate effects into one, turn the material effects into the
// Material effect, and turn effects that drew new content into generator layers following the
// layer (see each step's header). They detect old data, so they pass current data unchanged.
// v8 made lighting inherit value by value (model/lighting.ts): `Title3DProps.lighting` and
// `Material3D.environment` hold only the values a layer / part sets itself. Older files are read
// by version (a v7 part environment and a v8 one that sets every value look alike), with
// `legacy` set (`migrateStyle3D`): a layer's own lighting sets every value, `null` none; a part's
// own environment sets every value except its repeats of 1 and a blur the layer's already
// reached (the layer's blur was a floor for part environments), which inherit, so the layer's
// blur keeps reaching the part and its repeat now does too (a part with repeat 1 under a layer
// repeating the environment is the one render that changes); `null` sets none.
// v9 turned CharAdjust.tiltY around to match the layer's Transform.rotY (+ = right side away from
// the viewer; before, + brought the right side toward the viewer). It is read by version, like the
// v8 lighting (a v8 tilt and a v9 one look alike): a v4–v8 text layer's stored tiltY is negated
// (`flipTiltY`, `migrateChars`); absent or 0 stays as is, so every glyph keeps its tilt.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
/** `defaults` overlaid by the fields present in `v` (shallow). */
const filled = <T extends object>(defaults: T, v: unknown): T => (isObj(v) ? ({ ...defaults, ...v } as T) : defaults);

function migrateBevel2D(b: Bevel2D): Bevel2D {
  return filled({ useGlobalLight: false, sizeMode: 'fixed', fit: 70 } as Bevel2D, b);
}

function migrateSatin2D(s: Satin2D): Satin2D {
  return filled({ useGlobalLight: false } as Satin2D, s);
}

function migrateMaterial2D(m: Material2D): Material2D {
  return {
    ...filled({ opacity: 1, refraction: 0 } as Material2D, m),
    bevel: migrateBevel2D(m.bevel),
    reflection: filled(reflection2D(), m.reflection),
    satin: migrateSatin2D(m.satin),
    texture: filled({ target: 'color', angle: 0 } as Material2D['texture'], m.texture),
    gloss: filled({ angle: 0 } as Material2D['gloss'], m.gloss),
    glass: filled(glass2D(), m.glass),
    sheen: filled(sheen2D(), m.sheen),
  };
}

function migrateRim2D(r: Rim2D): Rim2D {
  return { ...r, plate: filled(plateShape(), r.plate), material: migrateMaterial2D(r.material) };
}

/** A 2D title style (v4, v5 or v6) with every current field present. */
export function migrateStyle2D(style: TitleStyle2D): TitleStyle2D {
  return {
    ...style,
    face: migrateMaterial2D(style.face),
    rims: style.rims.map(migrateRim2D),
    knockout: style.knockout ?? false,
    erode: filled(erode2D(), style.erode),
  };
}

function migrateEnvironment(e: Environment3D): Environment3D {
  const out = filled({ blur: 0, repeatX: 1, repeatY: 1 } as Environment3D, e);
  if (!('repeat' in out)) return out;
  const { repeat, ...rest } = out;
  return { ...rest, repeatX: typeof repeat === 'number' && !('repeatX' in e) ? repeat : out.repeatX };
}

/** How v4–v7 lighting is read (see the v8 notes above): `layerBlur` = the effective environment blur of the layer a part belongs to. */
interface LegacyLighting {
  layerBlur: number;
}

/** A v4–v7 layer's own lighting (whole, or null for the comp's) as overrides. */
function legacyLayerLighting(l: Lighting3D | null): LightingOverrides {
  return l ? { ...l, environment: migrateEnvironment(l.environment) } : noLighting();
}

/** A v4–v7 part's own environment (whole, or null for the layer's) as overrides of the layer's. */
function legacyPartEnvironment(e: Environment3D | null | undefined, legacy: LegacyLighting): EnvironmentOverrides {
  if (!e) return {};
  const out: EnvironmentOverrides = migrateEnvironment(e);
  if ((out.blur ?? 0) <= legacy.layerBlur) delete out.blur;
  if (out.repeatX === 1) delete out.repeatX;
  if (out.repeatY === 1) delete out.repeatY;
  return out;
}

function migrateMaterial3D(m: Material3D, legacy: LegacyLighting | null): Material3D {
  const out = filled({ gradientAxis: 'xy', gradientBend: 0, glassDepth: 0, environment: {} } as Material3D, m);
  return {
    // files from before gradient bend / glass depth / part environments: flat ramps, no absorption, the layer's reflections
    ...out,
    environment: legacy ? legacyPartEnvironment(m.environment as unknown as Environment3D | null | undefined, legacy) : out.environment,
    surface: filled(material3D('custom').surface, m.surface),
  };
}

function migrateBackplate3D(b: Backplate3D, legacy: LegacyLighting | null): Backplate3D {
  return { ...b, plate: filled(plateShape(), b.plate), face: migrateMaterial3D(b.face, legacy), side: migrateMaterial3D(b.side, legacy) };
}

/**
 * A 3D title style (v4 to v8) with every current field present; `legacy` (v4–v7 data, see the v8
 * notes): its lighting converted to overrides, `docBlur` = the environment blur of the document
 * the style was in (what a layer without its own lighting had).
 */
export function migrateStyle3D(s: Title3DProps, legacy?: { docBlur: number }): Title3DProps {
  const lighting = legacy ? legacyLayerLighting(s.lighting as unknown as Lighting3D | null) : s.lighting;
  const parts = legacyParts(lighting, legacy);
  return {
    ...s,
    mode: s.mode ?? 'extrude',
    // Files from before inflate.smoothness / detail get 0 / 1: the mesh-normal shading and grid they were drawn with.
    inflate: filled(createTitle3DLayer().style3d.inflate, s.inflate),
    envLock: s.envLock ?? false,
    // Files from before bevelPosition cut their bands inward; keep their silhouettes.
    bevelPosition: s.bevelPosition ?? 'inside',
    faceImage: s.faceImage ?? 1,
    lighting,
    edgeImage: s.edgeImage ?? 0,
    face: migrateMaterial3D(s.face, parts),
    side: migrateMaterial3D(s.side, parts),
    bands: s.bands.map((b) => ({ ...b, material: migrateMaterial3D(b.material, parts) })),
    backplates: s.backplates.map((b) => migrateBackplate3D(b, parts)),
  };
}

/** How the part environments under converted layer lighting `lighting` are read (null: current data). */
function legacyParts(lighting: LightingOverrides, legacy: { docBlur: number } | undefined): LegacyLighting | null {
  return legacy ? { layerBlur: lighting.environment.blur ?? legacy.docBlur } : null;
}

/**
 * Deep Glow before the light model (two Gaussian blurs, inner + outer, with a flat tint) → the
 * light glow, keeping roughly its size and brightness. Old: glow = gain · (1.2 · innerIntensity ·
 * G(innerRadius) + 3 · outerIntensity · G(outerRadius)) of the thresholded layer, gain =
 * 2^exposure on the glow only, each blur unit-energy. New (src/effects/a/glow.ts):
 *   radius    = outerRadius
 *   falloff   from the inner/outer energy ratio at the two radii: a power-law PSF puts weight
 *             ∝ σ^(2−p) per octave, so p = 2 − ln(3·outerI / 1.2·innerI) / ln(outerR / innerR),
 *             clamped to 1.6…3.2 → (p − 1.6) / 1.6 · 100 %
 *   intensity = (1.2 · innerIntensity + 3 · outerIntensity) · 2^exposure (same scattered energy),
 *             exposure 0 (the old exposure never brightened the face)
 *   threshold = the old sRGB-luma threshold as linear luminance, knee 0.1 (old ±0.08 ramp)
 *   colour    tintAmount > 0.5 → custom colour = tint; else the layer's colours tinted toward
 *             tint by tintAmount (inner = outer = tint)
 * Only instances with a key the new glow lacks are old (`tintAmount` exists in both); missing
 * old keys take the old defaults.
 */
function migrateDeepGlow(fx: EffectInstance): EffectInstance {
  const OLD_KEYS = ['innerRadius', 'outerRadius', 'innerIntensity', 'outerIntensity', 'tint'];
  if (fx.type !== 'deepGlow' || !OLD_KEYS.some((k) => k in fx.params)) return fx;
  const n = (k: string, def: number) => (typeof fx.params[k] === 'number' ? (fx.params[k] as number) : def);
  const rIn = Math.max(1, n('innerRadius', 14));
  const rOut = Math.max(rIn * 1.01, n('outerRadius', 240));
  const iIn = n('innerIntensity', 1);
  const iOut = n('outerIntensity', 0.7);
  const p = iIn > 0 && iOut > 0 ? 2 - Math.log((3 * iOut) / (1.2 * iIn)) / Math.log(rOut / rIn) : iOut > 0 ? 1.6 : 3.2;
  const tint = typeof fx.params.tint === 'string' ? fx.params.tint : '#ffb43c';
  const tintAmount = n('tintAmount', 0.6);
  const t = n('threshold', 0);
  const params = { ...fx.params };
  for (const k of [...OLD_KEYS, 'exposure', 'threshold']) delete params[k];
  return {
    ...fx,
    params: {
      ...params,
      radius: Math.round(rOut),
      falloff: Math.round(((Math.min(3.2, Math.max(1.6, p)) - 1.6) / 1.6) * 100),
      intensity: Math.min(8, (1.2 * iIn + 3 * iOut) * 2 ** n('exposure', 0)),
      exposure: 0,
      threshold: t <= 0.04045 ? t / 12.92 : ((t + 0.055) / 1.055) ** 2.4,
      knee: 0.1,
      ...(tintAmount > 0.5 ? { colorMode: 'custom', color: tint, tintAmount: 0 } : { colorMode: 'layer', tintAmount, tintInner: tint, tintOuter: tint }),
    },
  };
}

/**
 * Effects (v4, v5 or v6): a missing `useGlobalLight` param of a directional effect becomes false
 * (keeps the stored angle); a missing `follow` of a Keyline or Contour Lines becomes 'stack' (they
 * traced the effects below them before the param existed); an old two-blur Deep Glow becomes the
 * light glow (`migrateDeepGlow`).
 */
export function migrateEffects(effects: EffectInstance[]): EffectInstance[] {
  return effects.map((fx) => {
    const hasParam = getEffect(fx.type)?.params.some((p) => p.key === 'useGlobalLight');
    let out = hasParam && !('useGlobalLight' in fx.params) ? { ...fx, params: { ...fx.params, useGlobalLight: false } } : fx;
    if ((out.type === 'keyline' || out.type === 'contourLines') && !('follow' in out.params)) out = { ...out, params: { ...out.params, follow: 'stack' } };
    return migrateDeepGlow(out);
  });
}

/** `flipTiltY`: v4–v8 data, whose tiltY turned the other way (see the v9 notes). */
function migrateChars(chars: Record<number, CharAdjust>, is3D: boolean, legacy: LegacyLighting | null, flipTiltY: boolean): Record<number, CharAdjust> {
  const out: Record<number, CharAdjust> = {};
  for (const [k, c] of Object.entries(chars)) {
    const face = !is3D && c.face ? migrateMaterial2D(c.face) : c.face;
    const face3d = c.face3d && migrateMaterial3D(c.face3d, legacy);
    const bands3d = c.bands3d?.map((m) => m && migrateMaterial3D(m, legacy));
    const side3d = c.side3d && migrateMaterial3D(c.side3d, legacy);
    const tilt = flipTiltY && c.tiltY ? { tiltY: -c.tiltY } : {};
    out[Number(k)] = { ...c, ...tilt, ...(face ? { face } : {}), ...(face3d ? { face3d } : {}), ...(bands3d ? { bands3d } : {}), ...(side3d ? { side3d } : {}) };
  }
  return out;
}

/** `legacy`: v4–v7 data (see the v8 notes), in a document whose environment blur is `docBlur`; `flipTiltY`: v4–v8 data (see the v9 notes). */
function migrateLayer(l: Layer, legacy: { docBlur: number } | undefined, flipTiltY: boolean): Layer {
  const effects = migrateEffects(l.effects ?? []);
  const clip = l.clip ?? false;
  const masks = l.masks ?? [];
  const transform = { ...l.transform, flipX: l.transform.flipX ?? false, flipY: l.transform.flipY ?? false };
  // generator params stay as stored: generatorParams fills the defaults at render time
  if (l.kind === 'background' || l.kind === 'group' || l.kind === 'adjustment' || l.kind === 'generator') return { ...l, clip, masks, transform, effects };
  const ops = { warp: filled(noWarp(), l.warp), distort: filled(noDistort(), l.distort), weight: l.weight ?? 0 };
  const style3d = l.kind === 'title3d' ? migrateStyle3D(l.style3d, legacy) : null;
  const charLegacy = style3d ? legacyParts(style3d.lighting, legacy) : null;
  const source =
    l.source.kind === 'text'
      ? {
          ...l.source,
          hScale: l.source.hScale ?? 1,
          vScale: l.source.vScale ?? 1,
          tsume: l.source.tsume ?? 0,
          tateChuYoko: l.source.tateChuYoko ?? false,
          chars: migrateChars(l.source.chars ?? {}, l.kind === 'title3d', charLegacy, flipTiltY),
          lines: l.source.lines ?? {},
        }
      : l.source.kind === 'image'
        ? { ...l.source, trace: filled(imageTrace(), l.source.trace) }
        : l.source;
  const partEffects = Object.fromEntries(Object.entries(l.partEffects ?? {}).map(([k, fx]) => [k, migrateEffects(fx ?? [])])) as PartEffects;
  const common = { ...ops, clip, masks, transform, effects, partEffects };
  if (l.kind === 'title2d') return { ...l, ...common, source: source as typeof l.source, style: migrateStyle2D(l.style) };
  return { ...l, ...common, source: source as typeof l.source, style3d: style3d ?? migrateStyle3D(l.style3d, legacy) };
}

/**
 * A version 4 to 9 project as a complete version 9 project (see the migration notes above).
 * Throws on anything else.
 */
export function migrateProject(json: unknown): Project {
  if (!isObj(json) || !Array.isArray(json.layers) || !isObj(json.comp)) throw new MsgError(msg('Not a Pachislop project'));
  const version = json.version;
  if (!isSupported(version)) throw new MsgError(unsupported(version));
  const p = json as unknown as Project;
  const comp = defaultComp();
  const environment = migrateEnvironment(p.comp.environment);
  const legacy = version < 8 ? { docBlur: environment.blur } : undefined;
  const flipTiltY = version < 9;
  const filledIn: Project = {
    ...p,
    version: 9,
    comp: { ...p.comp, globalLight: filled(comp.globalLight, p.comp.globalLight), dpi: p.comp.dpi ?? comp.dpi, environment },
    layers: p.layers.map((l) => migrateLayer(l, legacy, flipTiltY)),
  };
  // The migration steps of src/io/migrate/, in order.
  return contentEffects(materialEffects(effectDedupe(generatorParams(filledIn))));
}

function unsupported(version: unknown): Msg {
  return version === 1 || version === 2 || version === 3
    ? msg('This is a version {version} project; this version of the app opens version 4 to 9 projects only', { version })
    : msg('Unsupported project version {version} (expected 4 to 9)', { version: String(version) });
}

/**
 * Note shown when an older project (`what`: “This project file”, “The autosaved project”) was
 * upgraded on load; `version` is the one it was saved as.
 */
export const upgradeNote = (what: string, version: ProjectVersion): Msg =>
  msg('{what} was made with an earlier version (v{version}) and has been upgraded to v9', { what: msg(what), version });

/** Added after `upgradeNote` when `compensateV4CharScale` moved glyphs back to their v4 positions. */
export const charScaleNote: Msg = msg(
  'Per-character scale now reflows the line, so character offsets and layer positions were adjusted to keep the v4 glyph positions',
);

// ---------------------------------------------------------------------------------------------
// Files

export function serializeProject(project: Project): string {
  const b = collectBundle(project);
  const file: ProjectFile = {
    format: 'pslot',
    version: 9,
    project,
    fonts: b.fonts.map((f) => ({ id: f.id, name: f.name, data: toBase64(f.data) })),
    assets: b.assets.map((a) => ({ id: a.id, name: a.name, mime: a.mime, data: toBase64(a.data) })),
  };
  return JSON.stringify(file);
}

export function parseProjectFile(text: string): Bundle {
  let file: ProjectFile;
  try {
    file = JSON.parse(text) as ProjectFile;
  } catch {
    throw new MsgError(msg('Not a valid project file (JSON parse failed)'));
  }
  if (file?.format !== 'pslot' || !file.project || !Array.isArray(file.project.layers) || !file.project.comp) {
    throw new MsgError(msg('Not a Pachislop project file'));
  }
  const version: unknown = file.version;
  if (!isSupported(version) || (file.project.version as unknown) !== version) throw new MsgError(unsupported(version));
  return {
    project: migrateProject(file.project),
    fonts: (file.fonts ?? []).map((f) => ({ id: f.id, name: f.name, data: fromBase64(f.data) })),
    assets: (file.assets ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      mime: a.mime ?? 'application/octet-stream',
      data: fromBase64(a.data),
    })),
    version,
    notes: version === 9 ? [] : [upgradeNote('This project file', version)],
  };
}

export function safeFileName(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'untitled';
}
