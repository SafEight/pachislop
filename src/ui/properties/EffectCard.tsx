import { useContext, useState } from 'react';
import { followsGlobalLight, globalLightSpec } from '../../effects/globalLight';
import { getEffect } from '../../effects/registry';
import type { EffectDef, EffectPreset } from '../../engine/contracts';
import type { EffectInstance } from '../../model/types';
import { effectsOf } from '../../store/effects';
import { msg } from '../../store/msg';
import { useEditor, type EffectOwner, type PropRef, type Refs } from '../../store/store';
import { IconBtn, MixedCheckbox, RefNum, Row } from '../controls';
import { useT } from '../i18n';
import { effectName, oneShot, useRefValue } from '../util';
import { LightSphere } from '../LightSphere';
import { FindProbe } from '../sectionMemory';
import { glintListed } from '../glint';
import { AddEffectButton } from './AddEffectMenu';
import { GlintCard } from './GlintCard';
import { InfoTip } from './InfoTip';
import { ParamControl } from './ParamControl';
import { paramShown } from './params';
import { sub } from './style/shared';
import './effects.css';

// Effect cards: one card per effect of an owner (layer, group or style part), edited in place.
// Lists show the stack like Photoshop (last applied on top); the effect node view shows one card
// at full height. Cards address their params through PropRefs into `effects` or
// `partEffects[part]`, so every edit is an ordinary setAt.

/** Drag payload MIME of a card: JSON `{ layerId, part, id }`. */
const DRAG_TYPE = 'application/x-props-effect';

/** PropRef of effect `index` of `owner`. */
const effectRef = (owner: EffectOwner, index: number): PropRef => ({
  layerId: owner.layerId,
  path: owner.part === null ? ['effects', index] : ['partEffects', owner.part, index],
});

/** Number param `k` of `fx` (stored, else the default). */
const numParam = (def: EffectDef, fx: EffectInstance, k: string) => {
  const v = fx.params[k];
  const pd = def.params.find((p) => p.key === k);
  return typeof v === 'number' ? v : pd?.kind === 'number' ? pd.default : 0;
};

const GLOBAL_ANGLE: PropRef = { layerId: null, path: ['comp', 'globalLight', 'angle'] };
const GLOBAL_ALTITUDE: PropRef = { layerId: null, path: ['comp', 'globalLight', 'altitude'] };

/** Light-direction sphere of an effect (or of the same effect on several layers, `fx` the first); with "Use global light" on it moves the comp's global light instead. */
function EffectLight({ def, fx, base, global }: { def: EffectDef; fx: EffectInstance; base: Refs; global: boolean }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const gl = useEditor((s) => s.project.comp.globalLight);
  const light = def.light!;
  if (global)
    return (
      <div className="row-block" data-fid="comp:globalLight" title={t('Use global light is on: this sphere moves the comp’s global light, shared by every bevel, shadow and effect that uses it')}>
        <span className="label">{t('Global light (comp)')}</span>
        <LightSphere
          id="comp:globalLight"
          label={t('Global light direction')}
          angle={gl.angle}
          altitude={gl.altitude}
          convention="ccwFromRight"
          onChange={(a, alt, c) => {
            // Same coalesce key → one undo step per drag for both values.
            setAt(GLOBAL_ANGLE, a, c);
            setAt(GLOBAL_ALTITUDE, alt, c);
          }}
        />
      </div>
    );
  return (
    <div className="row-block" data-fid="light">
      <span className="label">{t('Light direction')}</span>
      <LightSphere
        id={`${fx.id}:light`}
        label={t('Light direction')}
        angle={numParam(def, fx, light.angle)}
        altitude={numParam(def, fx, light.elevation)}
        convention={light.convention}
        onChange={(a, alt, c) => {
          setAt(sub(base, 'params', light.angle), a, c);
          setAt(sub(base, 'params', light.elevation), alt, c);
        }}
      />
    </div>
  );
}

/**
 * The effect's presets as one dropdown row ("Custom" while the settings match none); picking one
 * sets its params (structured ones replaced whole) as one undo step, on every target of `base`.
 */
function EffectPresets({ def, fx, base }: { def: EffectDef; fx: EffectInstance; base: Refs }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const presets = def.presets;
  if (!presets?.length) return null;
  const apply = (preset: EffectPreset) => {
    const k = oneShot(`${fx.id}:preset`);
    const label = msg('Preset “{name}”', { name: msg(preset.label) });
    for (const [key, v] of Object.entries(preset.params)) if (v !== undefined) setAt(sub(base, 'params', key), structuredClone(v), k, label);
  };
  const current = presets.find((p) => Object.entries(p.params).every(([key, v]) => JSON.stringify(fx.params[key]) === JSON.stringify(v)));
  const title = t('A preset replaces the settings it covers');
  return (
    <Row label={t('Preset')} title={title}>
      <select
        value={current?.id ?? ''}
        aria-label={t('Preset')}
        title={title}
        onChange={(e) => {
          const p = presets.find((x) => x.id === e.target.value);
          if (p) apply(p);
        }}
      >
        {!current && <option value="">{t('Custom')}</option>}
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {t(p.label)}
          </option>
        ))}
      </select>
    </Row>
  );
}

/**
 * One effect of `owner` (at array `index`). In a list it collapses, drags to reorder (⌥ copies,
 * also onto another owner's list) and its name opens the effect node; `full` is the effect node
 * view: always open, no drag.
 */
export function EffectCard({ owner, fx, index, count, full }: { owner: EffectOwner; fx: EffectInstance; index: number; count: number; full?: boolean }) {
  const t = useT();
  const def = getEffect(fx.type);
  const selected = useEditor((s) => s.selectedNode?.kind === 'effect' && s.selectedNode.effectId === fx.id);
  const [open, setOpen] = useState(true);
  const [dropPos, setDropPos] = useState<'above' | 'below' | null>(null);
  const { removeEffect, setEffectEnabled, selectNode } = useEditor.getState();
  /** moveEffect selects the moved effect; a list keeps showing its owner instead (the effect view follows the store). */
  const moveEffect = (from: EffectOwner, id: string, to: EffectOwner, index: number, copy: boolean) => {
    const keep = useEditor.getState().selectedNode;
    useEditor.getState().moveEffect(from, id, to, index, copy);
    if (!full) selectNode(keep);
  };
  const base = effectRef(owner, index);
  const spec = globalLightSpec(fx.type);
  const global = !!spec && followsGlobalLight(fx.params);
  const lightKeys = def?.light ? [def.light.angle, def.light.elevation] : [];
  const hasHandles = !!(def?.handles?.length || def?.directions?.length);
  const node = { kind: 'effect', layerId: owner.layerId, part: owner.part, effectId: fx.id } as const;
  const name = effectName(t, fx);
  const shown = full || open;
  return (
    <div
      className={`effect ${full ? 'full' : ''} ${fx.enabled ? '' : 'disabled'} ${selected ? 'sel' : ''} ${dropPos ? `drop-${dropPos}` : ''}`}
      onDragOver={(e) => {
        if (full || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
        const r = e.currentTarget.getBoundingClientRect();
        setDropPos(e.clientY < r.top + r.height / 2 ? 'above' : 'below');
      }}
      onDragLeave={() => setDropPos(null)}
      onDrop={(e) => {
        const pos = dropPos;
        setDropPos(null);
        const raw = e.dataTransfer.getData(DRAG_TYPE);
        if (!raw) return;
        e.preventDefault();
        const from = JSON.parse(raw) as EffectOwner & { id: string };
        if (from.id === fx.id && !e.altKey) return;
        const same = from.layerId === owner.layerId && from.part === owner.part;
        // The list is shown top = last applied, so "above" means a higher index.
        let to = pos === 'above' ? index + 1 : index;
        if (same && !e.altKey) {
          const fromIndex = effectsOf(useEditor.getState().project, owner).findIndex((x) => x.id === from.id);
          if (fromIndex < to) to -= 1;
        }
        moveEffect({ layerId: from.layerId, part: from.part }, from.id, owner, to, e.altKey);
      }}
    >
      <div
        className="effect-head"
        draggable={!full}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ layerId: owner.layerId, part: owner.part, id: fx.id }));
          e.dataTransfer.effectAllowed = 'copyMove';
        }}
      >
        {!full && (
          <>
            <span className="grip" title={t('Drag to reorder (⌥: copy)')}>
              ⋮⋮
            </span>
            <button className="twisty icon-btn" title={open ? t('Collapse') : t('Expand')} aria-label={open ? t('Collapse') : t('Expand')} aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? '▾' : '▸'}
            </button>
          </>
        )}
        <input type="checkbox" title={t('Enable')} aria-label={t('Enable {name}', { name })} checked={fx.enabled} onChange={(e) => setEffectEnabled(owner, fx.id, e.target.checked)} />
        <span
          className={`fx-name ${full ? '' : 'link'}`}
          role={full ? undefined : 'button'}
          tabIndex={full ? undefined : 0}
          title={
            def
              ? t('{label} ({category}): {description}', { label: name, category: t(def.category), description: t(def.description) })
              : t('Unknown effect type “{type}”', { type: fx.type })
          }
          onClick={() => !full && selectNode(node)}
          onKeyDown={(e) => !full && e.key === 'Enter' && selectNode(node)}
        >
          {name}
        </span>
        {def?.description && <InfoTip text={t(def.description)} />}
        {hasHandles && (
          <button
            className={`fx-handles icon-btn ${selected ? 'on' : ''}`}
            title={t('This effect has on-canvas handles (select it to show them in the viewport)')}
            aria-label={t('Show on-canvas handles')}
            aria-pressed={selected}
            onClick={() => selectNode(node)}
          >
            ✥
          </button>
        )}
        <span className="right">
          <IconBtn disabled={index === count - 1} title={t('Move up: applied later, drawn on top of the effects below')} onClick={() => moveEffect(owner, fx.id, owner, index + 1, false)}>
            ▲
          </IconBtn>
          <IconBtn disabled={index === 0} title={t('Move down: applied earlier, closer to the layer')} onClick={() => moveEffect(owner, fx.id, owner, index - 1, false)}>
            ▼
          </IconBtn>
          <IconBtn title={t('Duplicate')} onClick={() => moveEffect(owner, fx.id, owner, index + 1, true)}>
            ⧉
          </IconBtn>
          <IconBtn danger title={t('Delete')} onClick={() => removeEffect(owner, fx.id)}>
            ✕
          </IconBtn>
        </span>
      </div>
      {shown && def && (
        <div className="effect-body">
          <EffectPresets def={def} fx={fx} base={base} />
          {def.light && <EffectLight def={def} fx={fx} base={base} global={global} />}
          {def.params
            .filter((pd) => !lightKeys.includes(pd.key) && paramShown(def.params, fx.params, pd))
            .map((pd) =>
              global && pd.key === spec!.angle ? (
                <RefNum
                  key={pd.key}
                  label={t('Global angle')}
                  refp={GLOBAL_ANGLE}
                  min={0}
                  max={360}
                  step={1}
                  unit="deg"
                  title={t('Use global light is on: this is the comp’s global light angle (direction the light comes from, 120° = upper-left), shared by every effect and bevel that uses it')}
                />
              ) : (
                <ParamControl key={pd.key} def={pd} refp={sub(base, 'params', pd.key)} />
              ),
            )}
        </div>
      )}
    </div>
  );
}

/** The same effect on several layers (by type and order), edited as one; `index` is its place in that layer's own stack. */
export interface EffectTarget {
  owner: EffectOwner;
  fx: EffectInstance;
  index: number;
}

/**
 * One card for an effect that several layers share (a multi-selection): its on / off, presets,
 * light and params set every target at once; differing values show “—”. Reordering, duplicating
 * and deleting stay per layer.
 */
export function MultiEffectCard({ targets }: { targets: readonly EffectTarget[] }) {
  const t = useT();
  const { fx } = targets[0];
  const def = getEffect(fx.type);
  const [open, setOpen] = useState(true);
  const setAt = useEditor((s) => s.setAt);
  const base: Refs = targets.map(({ owner, index }) => effectRef(owner, index));
  const enabled = useRefValue(sub(base, 'enabled'));
  const spec = globalLightSpec(fx.type);
  const global = !!spec && followsGlobalLight(fx.params);
  const lightKeys = def?.light ? [def.light.angle, def.light.elevation] : [];
  const name = effectName(t, fx);
  return (
    <div className={`effect ${enabled.value === false && !enabled.mixed ? 'disabled' : ''}`}>
      <div className="effect-head">
        <button className="twisty icon-btn" title={open ? t('Collapse') : t('Expand')} aria-label={open ? t('Collapse') : t('Expand')} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'}
        </button>
        <MixedCheckbox title={t('Enable')} aria-label={t('Enable {name}', { name })} checked={enabled.value === true} mixed={enabled.mixed} onChange={(v) => setAt(sub(base, 'enabled'), v)} />
        <span className="fx-name" title={def ? t('{label} ({category}): {description}', { label: name, category: t(def.category), description: t(def.description) }) : name}>
          {name}
        </span>
        <span className="muted">{t('× {n} layers', { n: targets.length })}</span>
      </div>
      {open && def && (
        <div className="effect-body">
          <EffectPresets def={def} fx={fx} base={base} />
          {def.light && <EffectLight def={def} fx={fx} base={base} global={global} />}
          {def.params
            .filter((pd) => !lightKeys.includes(pd.key) && paramShown(def.params, fx.params, pd))
            .map((pd) =>
              global && pd.key === spec!.angle ? (
                <RefNum
                  key={pd.key}
                  label={t('Global angle')}
                  refp={GLOBAL_ANGLE}
                  min={0}
                  max={360}
                  step={1}
                  unit="deg"
                  title={t('Use global light is on: this is the comp’s global light angle (direction the light comes from, 120° = upper-left), shared by every effect and bevel that uses it')}
                />
              ) : (
                <ParamControl key={pd.key} def={pd} refp={sub(base, 'params', pd.key)} />
              ),
            )}
        </div>
      )}
    </div>
  );
}

/** Every effect of `owner` as cards (last applied on top) with “+ Add effect” (the count is the section title's); a 3D title's listed glint is pinned first. */
export function EffectStack({ owner }: { owner: EffectOwner }) {
  const t = useT();
  // Select the project, not effectsOf's result: a part without effects may yield a fresh [] per call.
  const project = useEditor((s) => s.project);
  const effects = effectsOf(project, owner);
  const layer = owner.part === null ? project.layers.find((l) => l.id === owner.layerId) : undefined;
  const glint = glintListed(layer) ? layer : null;
  // The search index renders every effect on its own (its node page), not inside its owner's list.
  const probe = useContext(FindProbe);
  if (probe) return null;
  const n = effects.length;
  return (
    <div className="effects-stack">
      <div className="fx-toolbar">
        <AddEffectButton owner={owner} />
      </div>
      {glint && <GlintCard layers={[glint]} />}
      {n === 0 && !glint && <div className="empty">{t('No effects yet. Open “+ Add effect” and hover an entry to preview it on this layer.')}</div>}
      {n > 1 && (
        <div className="fx-stack-hint" title={t('Effects apply bottom to top: each one works on the result of those below it, so the top one is drawn last, over everything else')}>
          {t('↑ drawn on top (applied last)')}
        </div>
      )}
      {effects
        .map((fx, i) => <EffectCard key={fx.id} owner={owner} fx={fx} index={i} count={n} />)
        .reverse()}
      {n > 1 && (
        <div className="fx-stack-hint" title={t("The bottom effect applies first, directly to the layer's own pixels")}>
          {t('↓ applied first, closest to the layer')}
        </div>
      )}
    </div>
  );
}
