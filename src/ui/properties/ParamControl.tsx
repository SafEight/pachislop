import type { ParamDef } from '../../engine/contracts';
import { isGradient, isMaterial2D } from '../../model/gradient';
import { isTitleLayer } from '../../model/parts';
import type { Adjustment, ParamValue } from '../../model/types';
import { getRef, refKey, refList } from '../../store/paths';
import { useEditor, type Refs } from '../../store/store';
import { ancestorsOf } from '../../store/tree';
import { CheckRow, ColorRow, Findable, RefNum, Row, SelectRow } from '../controls';
import { GradientEditor } from '../GradientEditor';
import { useT } from '../i18n';
import { useMixed, useRefValue } from '../util';
import { AdjustmentFields } from './AdjustmentEditor';
import { Material2DEditor } from './style/Material2DEditor';

// One control per ParamDef kind, bound to the store through a PropRef: shared by the effect
// cards (EffectCard) and generator layers (GeneratorView), so a param looks and edits the same
// wherever it appears. Several targets (the same effect on several layers) edit together.

/**
 * Layer picker of a 'layer' param or a layer mask's source: the title, generator and group layers
 * of the project in panel order (top first, indented by depth), except the one(s) `refp` belongs
 * to, plus None unless `noNone`. A picked layer that was deleted stays listed as such until
 * another is picked.
 */
export function LayerPicker(props: { label: string; refp: Refs; title?: string; noNone?: boolean }) {
  const { label, refp, title: hint, noNone = false } = props;
  const t = useT();
  const layers = useEditor((s) => s.project.layers);
  const { value: stored, mixed } = useRefValue(refp);
  const setAt = useEditor((s) => s.setAt);
  const value = mixed ? '' : typeof stored === 'string' ? stored : '';
  const own = new Set(refList(refp).map((r) => r.layerId));
  const options = layers.filter((l) => !own.has(l.id) && (isTitleLayer(l) || l.kind === 'generator' || l.kind === 'group')).toReversed();
  const missing = value !== '' && !options.some((l) => l.id === value);
  const title = hint ?? t('{param}: the layer whose shape (alpha) is used; None = off', { param: label });
  return (
    <Findable type={LayerPicker} props={props}>
      <Row label={label} title={title}>
        <select value={mixed ? '\u0000mixed' : value} title={title} aria-label={label} onChange={(e) => setAt(refp, e.target.value)}>
          {mixed && (
            <option value={'\u0000mixed'} disabled hidden>
              —
            </option>
          )}
          {!noNone && <option value="">{t('None')}</option>}
          {missing && <option value={value}>{t('(deleted layer)')}</option>}
          {options.map((l) => (
            <option key={l.id} value={l.id}>
              {'\u00a0\u00a0'.repeat(ancestorsOf(layers, l.id).length)}
              {l.name}
            </option>
          ))}
        </select>
      </Row>
    </Findable>
  );
}

/** The control of param `def` stored at `refp` (an effect's or a generator's `params[key]`, or that param of several). */
export function ParamControl(props: { def: ParamDef; refp: Refs }) {
  const { def, refp } = props;
  const t = useT();
  const { value: stored, mixed } = useRefValue(refp);
  const setAt = useEditor((s) => s.setAt);
  // A 'material2d' param's fillWhen: the stored value of the sibling param it names (the first target's).
  const fillWhen = def.kind === 'material2d' ? def.fillWhen : undefined;
  const first = refList(refp)[0];
  const sibling = useEditor((s) => (fillWhen && first ? getRef(s.project, { layerId: first.layerId, path: [...first.path.slice(0, -1), fillWhen.key] }) : undefined));
  const [adjTypeMixed] = useMixed(def.kind === 'adjustment' ? refList(refp).map((r) => ({ layerId: r.layerId, path: [...r.path, 'type'] })) : []);
  const id = refKey(refp);
  const label = t(def.label);
  switch (def.kind) {
    case 'number':
      return <RefNum label={label} refp={refp} min={def.min} max={def.max} step={def.step} unit={def.unit} fallback={def.default} />;
    case 'color':
      return (
        <Findable type={ParamControl} props={props}>
          <ColorRow label={label} id={id} value={typeof stored === 'string' ? stored : def.default} mixed={mixed} onChange={(c, k) => setAt(refp, c, k)} />
        </Findable>
      );
    case 'bool':
      return (
        <Findable type={ParamControl} props={props}>
          <CheckRow label={label} value={typeof stored === 'boolean' ? stored : def.default} mixed={mixed} onChange={(v) => setAt(refp, v)} />
        </Findable>
      );
    case 'select':
      return (
        <Findable type={ParamControl} props={props}>
          <SelectRow
            label={label}
            value={typeof stored === 'string' ? stored : def.default}
            mixed={mixed}
            options={def.options.map((o) => ({ value: o.value, label: t(o.label) }))}
            onChange={(v) => setAt(refp, v)}
          />
        </Findable>
      );
    case 'gradient':
      return (
        <Findable type={ParamControl} props={props}>
          <div className="row-block" data-fid={id}>
            <span className="label">{label}</span>
            <GradientEditor id={id} value={isGradient(stored as ParamValue | undefined) ? (stored as typeof def.default) : def.default} mixed={mixed} onChange={(v, k) => setAt(refp, v, k)} />
          </div>
        </Findable>
      );
    case 'layer':
      return <LayerPicker label={label} refp={refp} />;
    case 'material2d':
      // The title parts' own editor, writing below params[key]: every knob works as on a face or rim.
      // Its groups' open state is remembered per param, shared by the Material effects of a page.
      return <Material2DEditor id={`fx-${def.key}`} refp={refp} mat={isMaterial2D(stored) ? stored : def.default} fill={!fillWhen || sibling === fillWhen.value} />;
    case 'adjustment':
      // The adjustment layer's editor, writing below params[key]; no backdrop histogram for an effect.
      // Several targets share it only while their adjustments are of one type.
      if (adjTypeMixed) return <div className="hint-line">{t('{param}: the selected effects use different adjustments; edit them one by one.', { param: label })}</div>;
      return <AdjustmentFields refp={refp} adj={typeof stored === 'object' && stored !== null && 'type' in stored ? (stored as Adjustment) : def.default} />;
  }
}
