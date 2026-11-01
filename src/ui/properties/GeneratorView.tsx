import { Fragment } from 'react';
import type { GeneratorDef, ParamDef } from '../../engine/contracts';
import { generatorFromPreset, generatorParams, getGenerator } from '../../generators/registry';
import type { GeneratorLayer, ParamValue } from '../../model/types';
import { useEditor, type PropRef } from '../../store/store';
import { Row, Section } from '../controls';
import { GeneratorIcon } from '../generatorIcons';
import { useT } from '../i18n';
import { EffectStack } from './EffectCard';
import { InfoTip } from './InfoTip';
import { ParamControl } from './ParamControl';
import { paramShown } from './params';
import { TransformSection } from './TransformSection';

// Generator layer node (particles, speed lines, rings…): the layer it follows, the generator's
// presets and params (its description is the title's ⓘ), then the effects that run on its pixels and its transform. Blend and
// opacity are the Layers panel header's.

/** Whether the layer's params are preset `presetId`'s as applied (picked source layers aside): its chip shows as current. */
function isCurrentPreset(def: GeneratorDef, layer: GeneratorLayer, presetId: string): boolean {
  const preset = generatorFromPreset(def.type, presetId);
  const cur = generatorParams(layer.generator);
  // Gradients compare by value (a stored one is a copy of the preset's).
  return !!preset && def.params.every((pd) => pd.kind === 'layer' || JSON.stringify(cur[pd.key]) === JSON.stringify(preset.params[pd.key]));
}

/** One chip per preset; a click replaces the params and the previous preset's effects with the preset's as one undo step (transform, the user's own effects and picked layers stay). */
function PresetChips({ def, layer }: { def: GeneratorDef; layer: GeneratorLayer }) {
  const t = useT();
  const apply = useEditor((s) => s.applyGeneratorPreset);
  if (!def.presets.length) return null;
  return (
    <div className="gen-presets" role="group" aria-label={t('Presets')}>
      {def.presets.map((p) => {
        const on = isCurrentPreset(def, layer, p.id);
        const title = t("Preset {name}: replaces the settings below and the previous preset's effects (position and your own effects stay)", { name: t(p.label) });
        return (
          <button key={p.id} className={`gen-chip ${on ? 'on' : ''}`} title={title} aria-label={title} aria-pressed={on} onClick={() => apply(layer.id, p.id)}>
            {t(p.label)}
          </button>
        );
      })}
    </div>
  );
}

/** “🎲 Re-roll” under the seed param: a new random seed in its range (a different scatter, same look). */
function ReRoll({ pd, refp, current }: { pd: Extract<ParamDef, { kind: 'number' }>; refp: PropRef; current: ParamValue | undefined }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const title = t('New random seed: same settings, a different scatter');
  const roll = () => {
    const lo = Math.ceil(pd.min);
    const span = Math.max(1, Math.floor(pd.max) - lo + 1);
    let next = lo + Math.floor(Math.random() * span);
    if (next === current && span > 1) next = lo + ((next - lo + 1) % span);
    setAt(refp, next);
  };
  return (
    <Row label="" title={title}>
      <button className="small" title={title} aria-label={t('Re-roll the seed')} onClick={roll}>
        🎲 {t('Re-roll')}
      </button>
    </Row>
  );
}

/** The generator's params with the effect cards' controls; `when` rules hide the ones that don't apply. */
function GeneratorParams({ def, layer }: { def: GeneratorDef; layer: GeneratorLayer }) {
  const values = layer.generator.params;
  return (
    <>
      {def.params
        .filter((pd) => pd.key !== 'follow' && paramShown(def.params, values, pd))
        .map((pd) => {
          const refp: PropRef = { layerId: layer.id, path: ['generator', 'params', pd.key] };
          return (
            <Fragment key={pd.key}>
              <ParamControl def={pd} refp={refp} />
              {pd.key === 'seed' && pd.kind === 'number' && <ReRoll pd={pd} refp={refp} current={values[pd.key]} />}
            </Fragment>
          );
        })}
    </>
  );
}

/** The layer a follow generator follows, first: it decides where everything else draws. */
function FollowRow({ def, layer }: { def: GeneratorDef; layer: GeneratorLayer }) {
  const t = useT();
  const pd = def.follow ? def.params.find((d) => d.key === 'follow') : undefined;
  if (!pd) return null;
  const unset = !layer.generator.params.follow;
  return (
    <>
      <ParamControl def={pd} refp={{ layerId: layer.id, path: ['generator', 'params', 'follow'] }} />
      {unset && def.follow === 'required' && <div className="hint-line">{t('Pick a layer: it draws on the layer it follows.')}</div>}
    </>
  );
}

export function GeneratorView({ layer }: { layer: GeneratorLayer }) {
  const t = useT();
  const def = getGenerator(layer.generator.type);
  const fx = layer.effects.length;
  return (
    <>
      <Section
        id="generator"
        title={
          <span className="gen-title">
            <GeneratorIcon type={layer.generator.type} />
            {def ? t(def.label) : layer.generator.type}
            {def?.description && <InfoTip text={t(def.description)} />}
          </span>
        }
      >
        {def ? (
          <>
            <FollowRow def={def} layer={layer} />
            <PresetChips def={def} layer={layer} />
            <GeneratorParams def={def} layer={layer} />
          </>
        ) : (
          <div className="hint-line">{t('Unknown generator type “{type}” (made by a newer version?): it draws nothing.', { type: layer.generator.type })}</div>
        )}
      </Section>
      <Section id="effects" title={fx ? t('Effects {n}', { n: fx }) : t('Effects')}>
        <EffectStack owner={{ layerId: layer.id, part: null }} />
      </Section>
      <TransformSection layers={[layer]} />
    </>
  );
}
