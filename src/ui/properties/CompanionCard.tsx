import { useState } from 'react';
import { getGenerator } from '../../generators/registry';
import type { GeneratorLayer, Layer } from '../../model/types';
import { useEditor } from '../../store/store';
import { IconBtn } from '../controls';
import { placeCompanion } from '../companions';
import { GeneratorIcon } from '../generatorIcons';
import { useT } from '../i18n';
import { GeneratorParams, GeneratorView, PresetChips } from './GeneratorView';
import { InfoTip } from './InfoTip';
import './effects.css';

/**
 * A companion generator (ui/companions.ts) as an effect card of `owner`, the layer it follows: its
 * eye (the generator layer's visibility), icon and name, “behind” while it is below the layer,
 * then in front of / behind, duplicate and delete. In the layer's effect list it collapses to its
 * presets and params and its name opens the card (keeping the layer selected for the buttons);
 * `full` is that node's view: the head over the whole generator page (presets, blend and opacity,
 * params, its own effects, offset).
 */
export function CompanionCard({ owner, gen, behind, full }: { owner: Layer; gen: GeneratorLayer; behind: boolean; full?: boolean }) {
  const t = useT();
  const selected = useEditor((s) => s.selectedNode?.kind === 'layer' && s.selectedNode.layerId === gen.id);
  const [open, setOpen] = useState(false);
  const def = getGenerator(gen.generator.type);
  const select = () => !full && useEditor.getState().selectNode({ kind: 'layer', layerId: gen.id });
  /** A list card's command keeps the shown node (duplicating selects the copy). */
  const keeping = (run: () => void) => {
    const keep = useEditor.getState().selectedNode;
    run();
    if (!full) useEditor.getState().selectNode(keep);
  };
  const head = (
    <div className="effect-head">
      {!full && (
        <button className="twisty icon-btn" title={open ? t('Collapse') : t('Expand')} aria-label={open ? t('Collapse') : t('Expand')} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'}
        </button>
      )}
      <input
        type="checkbox"
        title={t('Enable')}
        aria-label={t('Enable {name}', { name: gen.name })}
        checked={gen.visible}
        onChange={(e) => useEditor.getState().setAt({ layerId: gen.id, path: ['visible'] }, e.target.checked)}
      />
      <GeneratorIcon type={gen.generator.type} />
      <span
        className={`fx-name ${full ? '' : 'link'}`}
        role={full ? undefined : 'button'}
        tabIndex={full ? undefined : 0}
        title={def ? t('{label} ({category}): {description}', { label: gen.name, category: t(def.label), description: t(def.description) }) : gen.name}
        onClick={select}
        onKeyDown={(e) => e.key === 'Enter' && select()}
      >
        {gen.name}
      </span>
      {behind && (
        <span className="fx-behind" title={t('Drawn behind “{name}”', { name: owner.name })}>
          {t('behind')}
        </span>
      )}
      {def?.description && <InfoTip text={t(def.description)} />}
      <span className="right">
        <IconBtn title={behind ? t('Move in front of the layer') : t('Move behind the layer')} onClick={() => placeCompanion(owner, gen.id, behind)}>
          {behind ? '⤒' : '⤓'}
        </IconBtn>
        <IconBtn title={t('Duplicate')} onClick={() => keeping(() => useEditor.getState().duplicateLayers([gen.id]))}>
          ⧉
        </IconBtn>
        <IconBtn danger title={t('Delete')} onClick={() => keeping(() => useEditor.getState().removeLayers([gen.id]))}>
          ✕
        </IconBtn>
      </span>
    </div>
  );
  if (full)
    return (
      <>
        <div className={`effect companion ${gen.visible ? '' : 'disabled'}`}>{head}</div>
        <GeneratorView layer={gen} companion />
      </>
    );
  return (
    <div className={`effect companion ${gen.visible ? '' : 'disabled'} ${selected ? 'sel' : ''}`}>
      {head}
      {open && def && (
        <div className="effect-body">
          <PresetChips def={def} layer={gen} />
          <GeneratorParams def={def} layer={gen} />
        </div>
      )}
    </div>
  );
}
