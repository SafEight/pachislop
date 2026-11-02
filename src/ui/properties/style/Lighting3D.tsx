import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { addAsset } from '../../../assets/registry';
import { uid } from '../../../model/defaults';
import {
  effectiveLighting,
  envKeysSet,
  lightingKeysSet,
  lightingSource,
  noLighting,
  resolveEnvironment,
  setsEnv,
  setsLighting,
  withEnvValue,
  withLightingValue,
  withoutEnvValue,
  withoutLightingValue,
  type EnvKey,
  type LightingLevel,
} from '../../../model/lighting';
import type { Comp, Environment3D, EnvironmentOverrides, EnvPreset, Light3D, Lighting3D, LightingOverrides, Material3D, Title3DLayer } from '../../../model/types';
import { formatMsg, msg } from '../../../store/msg';
import { getRef, refKey, refList } from '../../../store/paths';
import { useEditor, type PropRef, type Refs } from '../../../store/store';
import { ColorRow, Findable, IconBtn, NumRow, RefCheck, Row, Section, Seg, SelectRow, type Option } from '../../controls';
import { engineHost } from '../../engineHost';
import { useT } from '../../i18n';
import { oneShot, pickFile, useGesture } from '../../util';
import { sub, tOpts } from './shared';

// 3D lighting editors (environment, tone mapping + exposure, lights) at the three levels of
// lighting inheritance (model/lighting.ts): the document's (Comp, Document properties), a 3D
// layer's (its Lighting section, style3d.lighting) and a part's environment (the Reflections group
// of its material, Material3D.environment). On a layer or part every value shows where it comes
// from with a dot before its label (set here, from the layer, from Document); clicking the dot
// sets an inherited value here (from its current value) or makes a set one inherit again, and
// editing an inherited value sets it here.

const ENV_OPTIONS: Option<EnvPreset>[] = [
  { value: 'studio', label: 'Studio (hard softboxes)' },
  { value: 'strips', label: 'Strips (遊技機 studio, long bands)' },
  { value: 'softbox', label: 'Softbox (even, product)' },
  { value: 'backlit', label: 'Backlit (派手 rim light)' },
  { value: 'under', label: 'Under (spotlight from below)' },
  { value: 'sunset', label: 'Sunset (warm)' },
  { value: 'neon', label: 'Neon (pachinko hall)' },
  { value: 'gold', label: 'Gold (warm metal)' },
  { value: 'night', label: 'Night (dark, rim lights)' },
  { value: 'highway', label: 'Photo: highway (高速道路)' },
  { value: 'city', label: 'Photo: city street' },
  { value: 'sky', label: 'Photo: blue sky' },
  { value: 'custom', label: 'Custom HDR / image…' },
];

const TONE_OPTIONS: Option<Comp['toneMapping']>[] = [
  { value: 'neutral', label: 'Neutral', title: 'Khronos PBR Neutral: true-to-colour mid tones; bright colours drift slightly toward white' },
  {
    value: 'punch',
    label: 'Punch',
    title: 'Hue-preserving: compresses brightness but keeps every colour ratio, so gold and red stay fully saturated; only the hottest specular blends to white',
  },
  { value: 'aces', label: 'ACES', title: 'ACES filmic: contrasty film look, but it desaturates bright colours (gold turns pale)' },
  { value: 'agx', label: 'AgX', title: 'AgX: soft, very wide highlight roll-off, but it desaturates strongly (gold turns beige)' },
  { value: 'none', label: 'None', title: 'No tone mapping: values above 1 clip (hue shifts on hot highlights)' },
];

const LIGHT_TYPES: Option<Light3D['type']>[] = [
  { value: 'directional', label: 'Directional' },
  { value: 'point', label: 'Point' },
  { value: 'ambient', label: 'Ambient' },
];

/** A number row of the environment / tone editors (labels and titles are i18n keys). */
interface NumSpec {
  label: string;
  /** i18n context of the label. */
  ctx?: string;
  min: number;
  max: number;
  step: number;
  clamp?: boolean;
  unit?: string;
  display?: number;
  defaultValue?: number;
  title?: string;
}

const NUM_SPECS: Record<Exclude<EnvKey, 'preset' | 'tint'> | 'exposure', NumSpec> = {
  intensity: { label: 'Intensity', min: 0, max: 4, step: 0.01 },
  contrast: {
    label: 'Contrast',
    min: 0,
    max: 3,
    step: 0.01,
    clamp: true,
    unit: 'x',
    defaultValue: 1,
    title: 'Element 3D Physical Environment contrast: above 1 = darker darks and hotter highlights in the reflections (punchier chrome), below 1 = flatter, softer reflections',
  },
  saturation: {
    label: 'Saturation',
    min: 0,
    max: 3,
    step: 0.01,
    clamp: true,
    unit: 'x',
    defaultValue: 1,
    title: 'Colour strength of the reflections: 0 = grey environment (neutral chrome), above 1 = more coloured light (neon, sunset)',
  },
  repeatX: {
    label: 'Repeat ↔',
    ctx: 'environment',
    min: 0.25,
    max: 8,
    step: 0.05,
    clamp: true,
    unit: 'x',
    defaultValue: 1,
    title: 'Element 3D horizontal environment repeat: how many times the environment wraps around the 360°. 2 shows it twice, each copy in half the turn, for more and narrower reflections; below 1 stretches it',
  },
  repeatY: {
    label: 'Repeat ↕',
    ctx: 'environment',
    min: 0.25,
    max: 8,
    step: 0.05,
    clamp: true,
    unit: 'x',
    defaultValue: 1,
    title: 'Element 3D vertical environment repeat: how many times the environment tiles from bottom to top, centred on the horizon, so a chrome title shows more horizon lines; below 1 stretches it',
  },
  blur: {
    label: 'Blur',
    ctx: 'environment',
    min: 0,
    max: 1,
    step: 0.01,
    clamp: true,
    display: 100,
    unit: '%',
    defaultValue: 0,
    title: 'Element 3D environment blur: softens the reflections, as if the map were blurred; highlights from the lights stay sharp',
  },
  rotation: { label: 'Slide refl.', min: -180, max: 180, step: 1, unit: 'deg', title: 'Rotate the environment to slide reflections across the metal' },
  exposure: { label: 'Exposure', min: 0, max: 4, step: 0.01 },
};

// ---------- source markers ----------

/** A value's source marker: where each edited target's value comes from, at level `here`. */
interface Mark {
  from: readonly LightingLevel[];
  here: 'layer' | 'part';
  /** Sets the value here on every target that inherits it, or (when all set it) makes them all inherit. */
  toggle: () => void;
}

const MARK_TITLES = {
  here: { layer: 'Set on this layer. Click to use the document’s value again', part: 'Set on this part. Click to use the layer’s value again' },
  document: { layer: 'From Document. Click or edit the value to set it on this layer', part: 'From Document, through the layer. Click or edit the value to set it on this part' },
  layer: { layer: 'From the layer', part: 'From the layer. Click or edit the value to set it on this part' },
  mixed: { layer: 'Set on some of them. Click to set it on all', part: 'Set on some of them. Click to set it on all' },
} as const;

function SourceMark({ from, here, toggle }: Mark) {
  const t = useT();
  const own = from.filter((f) => f === here).length;
  const state = own === from.length ? 'here' : own > 0 || from.some((f) => f !== from[0]) ? 'mixed' : (from[0] as 'document' | 'layer');
  const title = t(MARK_TITLES[state][here]);
  return <button type="button" className={`lt-src ${state}`} title={title} aria-label={title} aria-pressed={state === 'here'} onClick={toggle} />;
}

/** `children` (one row) with its source marker in front, when edited at a layer or part. */
function Marked({ mark, children }: { mark?: Mark; children: ReactNode }) {
  if (!mark) return children;
  return (
    <div className={`lt-row${mark.from.includes(mark.here) ? '' : ' inherited'}`}>
      <SourceMark {...mark} />
      {children}
    </div>
  );
}

/** What the markers mean, above a layer's or part's values. */
function MarkLegend({ here }: { here: 'layer' | 'part' }) {
  const t = useT();
  return (
    <div className="hint-line lt-legend">
      <span className="lt-src here" /> {t(here === 'layer' ? 'set on this layer' : 'set on this part')}
      {here === 'part' && (
        <>
          {' · '}
          <span className="lt-src layer" /> {t('from the layer')}
        </>
      )}
      {' · '}
      <span className="lt-src document" /> {t('from Document')}
    </div>
  );
}

// ---------- value rows ----------

/** One lighting value at the level being edited: what its row shows and how it edits it. */
interface Field {
  id: string;
  value: unknown;
  /** The edited targets show different values. */
  mixed: boolean;
  set: (v: unknown, coalesce?: string) => void;
  /** Relative gesture over mixed values: every target's value at the gesture's start + `d`, through `norm`. */
  shift?: (d: number, coalesce: string, norm: (v: number) => number) => void;
  mark?: Mark;
}

/** An environment at one level: a field per value, and the custom HDR upload. */
interface EnvBinding {
  field: (key: EnvKey) => Field;
  /** Whether the (first) effective custom environment has its HDR. */
  assetLoaded: boolean;
  /** Use uploaded asset `id` as the custom environment. */
  upload: (id: string) => void;
}

function NumField({ field, spec }: { field: Field; spec: NumSpec }) {
  const t = useT();
  const { shift } = field;
  const norm = (v: number) => (spec.clamp ? Math.max(spec.min, Math.min(spec.max, v)) : v);
  return (
    <Marked mark={field.mark}>
      <NumRow
        label={t(spec.label, undefined, spec.ctx ? { ctx: spec.ctx } : undefined)}
        title={spec.title && t(spec.title)}
        id={field.id}
        value={typeof field.value === 'number' ? field.value : 0}
        mixed={field.mixed}
        onChange={(v, c) => field.set(v, c)}
        onOffset={shift && ((d, c) => shift(d, c, norm))}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        clamp={spec.clamp}
        unit={spec.unit}
        display={spec.display}
        defaultValue={spec.defaultValue}
      />
    </Marked>
  );
}

/** Preset or custom HDR, intensity and the Element 3D grade of the environment of `scope`. */
export function EnvironmentRows({ scope }: { scope: LightScope }) {
  const t = useT();
  const notify = useEditor((s) => s.notify);
  const lit = useLighting(scope);
  if (!lit) return null;
  const { env } = lit;
  const preset = env.field('preset');
  const row = (key: EnvKey) => <LightRow scope={scope} fkey={key} />;
  return (
    <>
      {row('preset')}
      {preset.value === 'custom' && !preset.mixed && (
        <Row label={t('HDR / image')}>
          <span className="muted ellipsis">{env.assetLoaded ? t('loaded') : t('none')}</span>
          <button
            className="small"
            onClick={async () => {
              const f = await pickFile('.hdr,.jpg,.jpeg,.png,.webp');
              if (!f) return;
              const ext = f.name.split('.').pop()?.toLowerCase();
              const mime = ext === 'hdr' ? 'image/vnd.radiance' : f.type || 'image/jpeg';
              const a = addAsset({ name: f.name, mime, data: await f.arrayBuffer() });
              env.upload(a.id);
              notify(msg('Environment “{name}” loaded', { name: f.name }));
            }}
          >
            {t('Upload…')}
          </button>
        </Row>
      )}
      {row('intensity')}
      {row('tint')}
      {row('contrast')}
      {row('saturation')}
      {row('repeatX')}
      {row('repeatY')}
      {row('blur')}
      {row('rotation')}
    </>
  );
}

/** Tone mapping and exposure of `scope` (the document or layers). */
export function ToneRows({ scope }: { scope: LightScope }) {
  return (
    <>
      <LightRow scope={scope} fkey="toneMapping" />
      <LightRow scope={scope} fkey="exposure" />
    </>
  );
}

/**
 * One environment or tone value of `scope`, with its source marker, read from the store (so the
 * search results show it live): the effective value, and an edit sets it at the scope's level.
 */
function LightRow(props: { scope: LightScope; fkey: EnvKey | 'toneMapping' | 'exposure' }) {
  const { scope, fkey } = props;
  const t = useT();
  const lit = useLighting(scope);
  const field = !lit ? null : fkey === 'toneMapping' || fkey === 'exposure' ? (lit.tone?.(fkey) ?? null) : lit.env.field(fkey);
  if (!field) return null;
  return (
    <Findable type={LightRow} props={props}>
      {fkey === 'preset' ? (
        <Marked mark={field.mark}>
          <SelectRow label={t('Preset')} id={field.id} value={field.value as EnvPreset} mixed={field.mixed} options={tOpts(t, ENV_OPTIONS)} onChange={(v) => field.set(v)} />
        </Marked>
      ) : fkey === 'tint' ? (
        <Marked mark={field.mark}>
          <ColorRow label={t('Tint')} id={field.id} value={typeof field.value === 'string' ? field.value : '#ffffff'} mixed={field.mixed} onChange={(v, c) => field.set(v, c)} />
        </Marked>
      ) : fkey === 'toneMapping' ? (
        <Marked mark={field.mark}>
          <Row label={t('Tone map')} title={t('How 3D layers squeeze bright light into the visible range')} fid={field.id}>
            <span role="group" aria-label={t('Tone mapping')}>
              <Seg value={field.value as Comp['toneMapping']} mixed={field.mixed} options={tOpts(t, TONE_OPTIONS)} onChange={(v) => field.set(v)} />
            </span>
          </Row>
        </Marked>
      ) : (
        <NumField field={field} spec={NUM_SPECS[fkey]} />
      )}
    </Findable>
  );
}

// ---------- the document's ----------

const compRef = (...path: (string | number)[]): PropRef => ({ layerId: null, path: ['comp', ...path] });

/** Where lighting values are edited: the document's, the own lighting of 3D layers `layerIds`, or the environment of the 3D materials at `refp` (parts). */
export type LightScope = { level: 'document' } | { level: 'layer'; layerIds: readonly string[] } | { level: 'part'; refp: Refs };

/** The document's lighting (Document properties). */
export const DOCUMENT_LIGHTING: LightScope = { level: 'document' };

/** The document's environment. */
function documentEnvironment(comp: Comp): EnvBinding {
  const { setAt } = useEditor.getState();
  return {
    field: (key) => {
      const ref = compRef('environment', key);
      return { id: refKey(ref), value: comp.environment[key], mixed: false, set: (v, c) => setAt(ref, v, c) };
    },
    assetLoaded: !!comp.environment.customAssetId,
    upload: (id) => setAt(compRef('environment', 'customAssetId'), id),
  };
}

/** The document's tone mapping or exposure. */
function documentValue(comp: Comp, key: 'toneMapping' | 'exposure'): Field {
  const ref = compRef(key);
  return { id: refKey(ref), value: comp[key], mixed: false, set: (v, c) => useEditor.getState().setAt(ref, v, c) };
}

// ---------- inherited values (layers and parts) ----------

/** One edited layer's or part's environment: its overrides, where they live, and what it inherits. */
interface EnvTarget {
  ref: PropRef;
  own: EnvironmentOverrides;
  parent: Environment3D;
  /** Where each inherited value comes from. */
  from: (key: EnvKey) => LightingLevel;
}

/** The environment of `targets` (edited together) at level `here`. */
function inheritedEnvironment(targets: readonly EnvTarget[], here: 'layer' | 'part'): EnvBinding {
  const { setAt, setEachAt } = useEditor.getState();
  const refs = targets.map((tg) => tg.ref);
  const eff = targets.map((tg) => resolveEnvironment(tg.parent, tg.own));
  const each = (fn: (o: EnvironmentOverrides, i: number) => EnvironmentOverrides, coalesce?: string, label?: string) =>
    setEachAt(refs, (o, i) => fn(o as EnvironmentOverrides, i), coalesce, label);
  return {
    field: (key) => ({
      id: refKey(sub(refs, key)),
      value: eff[0][key],
      mixed: eff.some((e) => e[key] !== eff[0][key]),
      // the preset keeps the custom HDR in effect when it stays custom
      set:
        key === 'preset'
          ? (v) => each((o, i) => withEnvValue(o, 'preset', { ...eff[i], preset: v as EnvPreset, customAssetId: v === 'custom' ? eff[i].customAssetId : undefined }))
          : (v, c) => setAt(sub(refs, key), v, c),
      shift: (d, c, norm) => each((o, i) => ({ ...o, [key]: norm(((o[key] ?? targets[i].parent[key]) as number) + d) }), c),
      mark: {
        from: targets.map((tg) => (setsEnv(tg.own, key) ? here : tg.from(key))),
        here,
        toggle: () => {
          const all = targets.every((tg) => setsEnv(tg.own, key));
          each((o, i) => (all ? withoutEnvValue(o, key) : setsEnv(o, key) ? o : withEnvValue(o, key, eff[i])), undefined, all ? 'Inherit lighting value' : 'Set lighting value here');
        },
      },
    }),
    assetLoaded: !!eff[0].customAssetId,
    upload: (id) => each((o) => ({ ...o, preset: 'custom', customAssetId: id })),
  };
}

/** One edited layer's own lighting: its overrides, where they live, and the document's lighting it inherits. */
interface LayerTarget {
  ref: PropRef;
  own: LightingOverrides;
  parent: Lighting3D;
}

/** A layer-level value (tone mapping, exposure, lights) of `targets`, edited together. */
function layerValue(targets: readonly LayerTarget[], key: 'toneMapping' | 'exposure' | 'lights'): Field {
  const { setAt, setEachAt } = useEditor.getState();
  const refs = targets.map((tg) => tg.ref);
  const eff = targets.map((tg) => tg.own[key] ?? tg.parent[key]);
  const each = (fn: (o: LightingOverrides, i: number) => LightingOverrides, coalesce?: string, label?: string) =>
    setEachAt(refs, (o, i) => fn(o as LightingOverrides, i), coalesce, label);
  return {
    id: refKey(sub(refs, key)),
    value: eff[0],
    mixed: eff.some((v) => v !== eff[0]),
    set: (v, c) => setAt(sub(refs, key), v, c),
    shift: (d, c, norm) => each((o, i) => ({ ...o, [key]: norm(((o[key] ?? targets[i].parent[key]) as number) + d) }), c),
    mark: {
      from: targets.map((tg) => (setsLighting(tg.own, key) ? 'layer' : 'document')),
      here: 'layer',
      toggle: () => {
        const all = targets.every((tg) => setsLighting(tg.own, key));
        each(
          (o, i) => (all ? withoutLightingValue(o, key) : setsLighting(o, key) ? o : withLightingValue(o, key, targets[i].parent)),
          undefined,
          all ? 'Inherit lighting value' : 'Set lighting value here',
        );
      },
    },
  };
}

/** The environment of layer targets: the document's, overridden value by value. */
const layerEnvironment = (targets: readonly LayerTarget[]): EnvBinding =>
  inheritedEnvironment(
    targets.map((tg) => ({ ref: sub(tg.ref, 'environment'), own: tg.own.environment, parent: tg.parent.environment, from: () => 'document' })),
    'layer',
  );

const NO_IDS: readonly string[] = [];
const NO_REFS: readonly PropRef[] = [];

/** The own lighting of the 3D layers `ids`, from the store, each inheriting the document's. */
function useLayerTargets(ids: readonly string[]): LayerTarget[] {
  const comp = useEditor((s) => s.project.comp);
  const layers = useEditor(useShallow((s) => ids.map((id) => s.project.layers.find((l) => l.id === id))));
  const parent = effectiveLighting(comp, null);
  return layers.flatMap((l) => (l?.kind === 'title3d' ? [{ ref: { layerId: l.id, path: ['style3d', 'lighting'] }, own: l.style3d.lighting, parent }] : []));
}

/** The environments of the 3D materials at `refp`, from the store (none where there is no 3D material). */
function usePartTargets(refp: Refs): EnvTarget[] {
  const comp = useEditor((s) => s.project.comp);
  const refs = refList(refp);
  const mats = useEditor(useShallow((s) => refs.map((r) => getRef(s.project, r) as Material3D | undefined)));
  const layers = useEditor(useShallow((s) => refs.map((r) => s.project.layers.find((l) => l.id === r.layerId))));
  return refs.flatMap((r, i) => {
    const mat = mats[i];
    const layer = layers[i];
    if (!mat || layer?.kind !== 'title3d') return [];
    return [{ ref: sub(r, 'environment'), own: mat.environment, parent: effectiveLighting(comp, layer).environment, from: (key: EnvKey) => lightingSource(layer, key) }];
  });
}

/** The environment and tone values of `scope`, from the store; null where it has nothing to edit (a part without a 3D material). Tone is null on a part (always the layer's). */
function useLighting(scope: LightScope): { env: EnvBinding; tone: ((key: 'toneMapping' | 'exposure') => Field) | null } | null {
  const comp = useEditor((s) => s.project.comp);
  const layerTargets = useLayerTargets(scope.level === 'layer' ? scope.layerIds : NO_IDS);
  const partTargets = usePartTargets(scope.level === 'part' ? scope.refp : NO_REFS);
  if (scope.level === 'document') return { env: documentEnvironment(comp), tone: (key) => documentValue(comp, key) };
  if (scope.level === 'layer') return layerTargets.length ? { env: layerEnvironment(layerTargets), tone: (key) => layerValue(layerTargets, key) } : null;
  return partTargets.length ? { env: inheritedEnvironment(partTargets, 'part'), tone: null } : null;
}

/**
 * Lighting of 3D layers (their own section, after Shape): the reflections lock, then every
 * environment, tone and light value with its source (set on this layer or from Document), Reset
 * to document, and for one layer "Make document default" (its values become the document's and
 * it sets none) and "Use for all 3D layers" (the same, and no 3D layer sets any). Several layers
 * (a multi-selection) edit their values together, mixed ones showing “—”; the lights list is one
 * layer's.
 */
export function LayerLightingSection({ layers }: { layers: readonly Title3DLayer[] }) {
  const t = useT();
  const { edit, setEachAt } = useEditor.getState();
  const layerIds = layers.map((l) => l.id);
  const scope: LightScope = { level: 'layer', layerIds };
  const targets = useLayerTargets(layerIds);
  const lights = layerValue(targets, 'lights');
  const single = layers.length === 1 ? layers[0] : null;
  const anySet = targets.some((tg) => lightingKeysSet(tg.own).length > 0);
  /** The document takes `layer`'s effective lighting; `all`: no 3D layer sets any value, else just this one. */
  const promote = (layer: Title3DLayer, all: boolean, label: string) =>
    edit(
      (p) => {
        const l = p.layers.find((x) => x.id === layer.id);
        if (l?.kind !== 'title3d') return p;
        return {
          ...p,
          comp: { ...p.comp, ...structuredClone(effectiveLighting(p.comp, l)) },
          layers: p.layers.map((x) => (x.kind === 'title3d' && (all || x === l) ? { ...x, style3d: { ...x.style3d, lighting: noLighting() } } : x)),
        };
      },
      undefined,
      label,
    );
  return (
    <Section id="style3d-lighting" title={t('Lighting')}>
      <RefCheck
        label={t('Lock reflections')}
        refp={single ? { layerId: single.id, path: ['style3d', 'envLock'] } : layers.map((l) => ({ layerId: l.id, path: ['style3d', 'envLock'] }))}
        title={t('Reflections stay as they look head-on when the layer is tilted (rotX / rotY), so tilted gold stays bright instead of mirroring dim sky')}
      />
      <MarkLegend here="layer" />
      {/* wraps: the Japanese labels don't fit side by side in a narrow dock */}
      <div className="lt-actions">
        <button
          className="small"
          disabled={!anySet}
          title={t('Use the document’s value for every lighting value of this layer')}
          onClick={() => setEachAt(targets.map((tg) => tg.ref), () => noLighting(), undefined, 'Reset to document')}
        >
          {t('Reset to document')}
        </button>
        {single && (
          <>
            <button
              className="small"
              disabled={!anySet}
              title={t('Make the values this layer sets the document’s, so every 3D layer that doesn’t set them uses them; this layer then sets none')}
              onClick={() => promote(single, false, 'Make document default')}
            >
              {t('Make document default')}
            </button>
            <button
              className="small"
              title={t('Make this layer’s lighting the document’s and have every 3D layer use it (they set no lighting values of their own)')}
              onClick={() => promote(single, true, 'Use for all 3D layers')}
            >
              {t('Use for all 3D layers')}
            </button>
          </>
        )}
      </div>
      <div className="sub-head">{t('Environment (3D reflections)')}</div>
      <EnvironmentRows scope={scope} />
      <div className="sub-head">{t('Tone')}</div>
      <ToneRows scope={scope} />
      <div className="sub-head lt-row">
        {lights.mark && <SourceMark {...lights.mark} />}
        {lights.mixed ? t('Lights') : t('Lights ({n})', { n: (lights.value as Light3D[]).length })}
      </div>
      {single ? (
        <LightsEditor refp={sub(targets[0].ref, 'lights')} />
      ) : (
        <div className="hint-line">{t('Each layer keeps its own lights: select one layer to edit them.')}</div>
      )}
    </Section>
  );
}

/**
 * The environment of the 3D materials at `refp` (several edited together): every value with its
 * source (set on this part, from the layer, from Document) and Reset to layer. Lights and tone
 * mapping are always the layer's.
 */
export function PartReflections({ refp }: { refp: Refs }) {
  const t = useT();
  const targets = usePartTargets(refp);
  const setEachAt = useEditor((s) => s.setEachAt);
  if (targets.length === 0) return null;
  return (
    <>
      <MarkLegend here="part" />
      <div className="lt-actions">
        <button
          className="small"
          disabled={targets.every((tg) => envKeysSet(tg.own).length === 0)}
          title={t('Use the layer’s value for every environment value of this part')}
          onClick={() => setEachAt(targets.map((tg) => tg.ref), () => ({}), undefined, 'Reset to layer')}
        >
          {t('Reset to layer')}
        </button>
      </div>
      <EnvironmentRows scope={{ level: 'part', refp }} />
    </>
  );
}

// ---------- lights ----------

const DIR_PAD = 88; // direction pad diameter, CSS px
const DIR_STEP = 0.02; // arrow-key step on the pad, unit-sphere coordinates (Shift ×10, ⌥/Alt ×0.1)
const DIR_FALLBACK_DIST = 1000; // distance used when a light sits exactly at the centre, px

/**
 * Element 3D-style light direction ball for `light`: the front view of the unit sphere around
 * the scene centre (+x right, +y up). Dragging moves the light over the hemisphere toward the
 * camera, or the one behind the title when toggled to "Behind" (the dot turns hollow); the
 * distance from the centre is kept, so for a directional light only the direction changes.
 */
function LightDirPad({ id, label, light, onChange }: { id: string; label: string; light: Light3D; onChange: (light: Light3D, coalesce: string) => void }) {
  const t = useT();
  const g = useGesture(`light-dir-${id}`);
  const dist = Math.hypot(light.x, light.y, light.z) || DIR_FALLBACK_DIST;
  const nx = light.x / dist;
  const ny = light.y / dist;
  const behind = light.z < 0;

  /** Point the light at (dx, dy) on the pad (clamped to the rim), on the chosen hemisphere. */
  const aim = (dx: number, dy: number, back: boolean, coalesce: string) => {
    const r = Math.hypot(dx, dy);
    const k = r > 1 ? 1 / r : 1;
    const x = dx * k;
    const y = dy * k;
    const z = Math.sqrt(Math.max(0, 1 - x * x - y * y)) * (back ? -1 : 1);
    onChange({ ...light, x: Math.round(x * dist), y: Math.round(y * dist), z: Math.round(z * dist) }, coalesce);
  };
  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    aim(((e.clientX - b.left) / b.width) * 2 - 1, 1 - ((e.clientY - b.top) / b.height) * 2, behind, g.key());
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
    if (!d) return;
    e.preventDefault();
    const s = DIR_STEP * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
    aim(nx + d[0] * s, ny + d[1] * s, behind, `light-dir-key-${id}`);
  };
  // shading lit from the light, so the ball reads like the lit side of the title
  const hx = 50 + nx * 38;
  const hy = 50 - ny * 38;
  const ball = behind
    ? `radial-gradient(circle at ${hx}% ${hy}%, #555 0%, #2a2a2e 45%, #141416 100%)`
    : `radial-gradient(circle at ${hx}% ${hy}%, #fff 0%, #9a9aa0 30%, #3a3a40 70%, #1a1a1e 100%)`;
  return (
    <Row label={label} title={t('Drag to aim the light (front view of the scene; distance from the centre is kept). Arrow keys nudge.')}>
      <div
        role="slider"
        tabIndex={0}
        aria-label={behind ? t('Light direction, behind the title') : t('Light direction, in front of the title')}
        aria-valuetext={t(behind ? 'x {x}, y {y}, behind' : 'x {x}, y {y}, front', { x: nx.toFixed(2), y: ny.toFixed(2) })}
        title={t('Drag to aim the light: centre = straight from the camera side, rim = grazing from the side. Arrow keys nudge (Shift coarse, ⌥/Alt fine).')}
        style={{ position: 'relative', width: DIR_PAD, height: DIR_PAD, borderRadius: '50%', background: ball, cursor: 'crosshair', touchAction: 'none', flex: 'none', boxShadow: 'inset 0 0 0 1px #0008' }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          g.begin();
          engineHost.setInteractive(true);
          fromPointer(e);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e);
        }}
        onLostPointerCapture={() => engineHost.setInteractive(false)}
        onKeyDown={onKey}
      >
        <span style={{ position: 'absolute', left: '50%', top: 4, bottom: 4, borderLeft: '1px dashed #fff3', pointerEvents: 'none' }} />
        <span style={{ position: 'absolute', top: '50%', left: 4, right: 4, borderTop: '1px dashed #fff3', pointerEvents: 'none' }} />
        <span
          style={{
            position: 'absolute',
            left: `${50 + nx * 50}%`,
            top: `${50 - ny * 50}%`,
            width: 10,
            height: 10,
            margin: -5,
            borderRadius: '50%',
            border: '2px solid #ffd54a',
            background: behind ? 'transparent' : '#ffd54a',
            boxShadow: '0 0 0 1px #000a',
            pointerEvents: 'none',
          }}
        />
      </div>
      <button
        className="small"
        aria-pressed={behind}
        aria-label={t('Light behind the title')}
        title={behind ? t('The light is behind the title (rim / back light). Click to bring it to the front.') : t('The light is in front of the title. Click to move it behind (rim / back light).')}
        onClick={() => aim(nx, ny, !behind, oneShot('light-behind'))}
      >
        {behind ? `◐ ${t('Behind')}` : `● ${t('Front')}`}
      </button>
    </Row>
  );
}

/** The light values shown as number rows: labels and titles are i18n keys. */
const LIGHT_NUMS = {
  intensity: { label: 'Intensity', min: 0, max: 10, step: 0.05, unit: undefined, title: undefined },
  x: { label: 'X', min: -3000, max: 3000, step: 1, unit: 'px', title: 'Light position right of the scene centre (directional: only the direction from the centre counts)' },
  y: { label: 'Y', min: -3000, max: 3000, step: 1, unit: 'px', title: 'Light position above the scene centre' },
  z: { label: 'Z', min: -3000, max: 3000, step: 1, unit: 'px', title: 'Light position toward the camera (negative = behind the title)' },
} as const;

type LightField = 'type' | 'color' | keyof typeof LIGHT_NUMS | 'direction';

/**
 * The lights at `refp` (the document's, or a layer's `lighting.lights`) from the store: the stored
 * list, or the document's that a layer setting none inherits. `set` edits light `i`'s `key` (the
 * whole light for null); a layer that inherits them sets the whole list on its first edit.
 */
function useLights(refp: PropRef) {
  const stored = useEditor((s) => getRef(s.project, refp) as readonly Light3D[] | undefined);
  const inherited = useEditor((s) => s.project.comp.lights);
  const lights = stored ?? inherited;
  const set = (i: number, key: keyof Light3D | null, value: unknown, coalesce?: string) => {
    const { setAt } = useEditor.getState();
    if (stored) setAt(key ? sub(refp, i, key) : sub(refp, i), value, coalesce);
    else setAt(refp, lights.map((x, k) => (k === i ? (key ? { ...x, [key]: value } : (value as Light3D)) : x)), coalesce);
  };
  return { lights, set };
}

/**
 * One value of light `i` at `refp`, read from the store (so the search results show it live);
 * the position rows only while it isn't ambient. `named`: the label says which light (the search
 * results, away from its card).
 */
function LightRowOf(props: { refp: PropRef; i: number; field: LightField; named?: boolean }) {
  const { refp, i, field, named } = props;
  const t = useT();
  const { lights, set } = useLights(refp);
  const light = lights[i];
  if (!light || (light.type === 'ambient' && field !== 'type' && field !== 'color' && field !== 'intensity')) return null;
  const id = refKey(sub(refp, i));
  const label = (text: string) => (named ? `${t('Light {n}', { n: i + 1 })} · ${text}` : text);
  return (
    <Findable type={LightRowOf} props={named ? props : { ...props, named: true }}>
      {field === 'type' ? (
        <SelectRow label={label(t('Type'))} id={`${id}.type`} value={light.type} options={tOpts(t, LIGHT_TYPES)} onChange={(v) => set(i, 'type', v)} />
      ) : field === 'color' ? (
        <ColorRow label={label(t('Colour'))} id={`${id}.color`} value={light.color} onChange={(v, c) => set(i, 'color', v, c)} />
      ) : field === 'direction' ? (
        <LightDirPad id={id} label={label(t('Direction'))} light={light} onChange={(l, c) => set(i, null, l, c)} />
      ) : (
        <NumRow
          label={label(t(LIGHT_NUMS[field].label))}
          title={LIGHT_NUMS[field].title && t(LIGHT_NUMS[field].title)}
          id={`${id}.${field}`}
          value={light[field]}
          onChange={(v, c) => set(i, field, v, c)}
          min={LIGHT_NUMS[field].min}
          max={LIGHT_NUMS[field].max}
          step={LIGHT_NUMS[field].step}
          unit={LIGHT_NUMS[field].unit}
        />
      )}
    </Findable>
  );
}

/** Light `i` at `refp` as a card: its type in the head, Remove, then its values. */
function LightEditor({ refp, light, i, remove }: { refp: PropRef; light: Light3D; i: number; remove: () => void }) {
  const t = useT();
  return (
    <div className="light-card">
      <div className="stack-head">
        <span>
          {t('Light {n}', { n: i + 1 })} <span className="muted">{formatMsg({ en: LIGHT_TYPES.find((o) => o.value === light.type)?.label ?? light.type, lower: true }, t)}</span>
        </span>
        <span className="right">
          <IconBtn danger title={t('Remove light')} onClick={remove}>
            ✕
          </IconBtn>
        </span>
      </div>
      <LightRowOf refp={refp} i={i} field="type" />
      <LightRowOf refp={refp} i={i} field="color" />
      <LightRowOf refp={refp} i={i} field="intensity" />
      <LightRowOf refp={refp} i={i} field="direction" />
      <LightRowOf refp={refp} i={i} field="x" />
      <LightRowOf refp={refp} i={i} field="y" />
      <LightRowOf refp={refp} i={i} field="z" />
    </div>
  );
}

/**
 * The lights at `refp` (the document's, or a layer's `lighting.lights`, the document's while it
 * sets none), one card each, plus Add light.
 */
export function LightsEditor({ refp }: { refp: PropRef }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const { lights } = useLights(refp);
  return (
    <>
      {lights.map((l, i) => (
        <LightEditor key={l.id} refp={refp} light={l} i={i} remove={() => setAt(refp, lights.filter((x) => x !== l), undefined, 'Remove light')} />
      ))}
      <button className="small" onClick={() => setAt(refp, [...lights, { id: uid(), type: 'point', color: '#ffffff', intensity: 2, x: 0, y: 300, z: 600 }], undefined, 'Add light')}>
        + {t('Add light')}
      </button>
    </>
  );
}
