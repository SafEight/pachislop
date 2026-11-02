import { useState } from 'react';
import type { Title3DLayer } from '../../model/types';
import { useEditor } from '../../store/store';
import { IconBtn, MixedCheckbox, RefColor, RefNum, Row, Seg } from '../controls';
import { deleteGlint, GLINT_ABOUT, GLINT_PINNED, glintRefs, resetGlint, setGlintEnabled } from '../glint';
import { useT } from '../i18n';
import { useMixed, useRefValue } from '../util';
import { InfoTip } from './InfoTip';
import { sub } from './style/shared';
import './effects.css';

const STREAK_COUNTS = [
  { value: '0', label: 'None' },
  { value: '2', label: '2' },
  { value: '4', label: '4' },
  { value: '6', label: '6' },
  { value: '8', label: '8' },
] as const;

/**
 * The 3D glint (`style3d.glint`) as an effect card (see ui/glint.ts): on / off, Reset, Delete
 * (switches it off) and its settings. `layers`: one 3D title, or several (a multi-selection)
 * edited together, “—” where they differ. In a list it collapses and its name opens the glint
 * node; `full` is that node's view. Pinned: no drag, no move.
 */
export function GlintCard({ layers, full }: { layers: readonly Title3DLayer[]; full?: boolean }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const selectNode = useEditor((s) => s.selectNode);
  const single = layers.length === 1;
  const layerId = layers[0].id;
  const selected = useEditor((s) => single && s.selectedNode?.kind === 'glint' && s.selectedNode.layerId === layerId);
  const [open, setOpen] = useState(true);
  const ids = layers.map((l) => l.id);
  const refp = glintRefs(ids);
  const enabled = useRefValue(sub(refp, 'enabled'));
  const [streaksMixed] = useMixed(sub(refp, 'streaks'));
  const glint = layers[0].style3d.glint;
  const name = t('Glint');
  const link = !full && single;
  const shown = full || open;
  const select = () => link && selectNode({ kind: 'glint', layerId });
  return (
    <div className={`effect glint ${full ? 'full' : ''} ${enabled.value === false && !enabled.mixed ? 'disabled' : ''} ${selected ? 'sel' : ''}`}>
      <div className="effect-head">
        {!full && (
          <>
            <span className="grip pinned" title={t(GLINT_PINNED)}>
              ⊤
            </span>
            <button className="twisty icon-btn" title={open ? t('Collapse') : t('Expand')} aria-label={open ? t('Collapse') : t('Expand')} aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? '▾' : '▸'}
            </button>
          </>
        )}
        <MixedCheckbox title={t('Enable')} aria-label={t('Enable {name}', { name })} checked={enabled.value === true} mixed={enabled.mixed} onChange={(v) => setGlintEnabled(ids, v)} />
        <span
          className={`fx-name ${link ? 'link' : ''}`}
          role={link ? 'button' : undefined}
          tabIndex={link ? 0 : undefined}
          title={t('{label} ({category}): {description}', { label: name, category: t('Glow'), description: t(GLINT_ABOUT) })}
          onClick={select}
          onKeyDown={(e) => e.key === 'Enter' && select()}
        >
          {name}
        </span>
        <InfoTip text={`${t(GLINT_ABOUT)}\n${t(GLINT_PINNED)}`} />
        {!single && <span className="muted">{t('× {n} layers', { n: layers.length })}</span>}
        <span className="right">
          <IconBtn title={t('Reset the glint settings to their defaults')} onClick={() => resetGlint(ids)}>
            ↺
          </IconBtn>
          <IconBtn danger title={t('Delete')} onClick={() => deleteGlint(ids)}>
            ✕
          </IconBtn>
        </span>
      </div>
      {shown && (
        <div className="effect-body">
          <RefNum label={t('Threshold')} refp={sub(refp, 'threshold')} min={0} max={8} step={0.05} title={t('HDR luminance above which pixels glint (1 ≈ brighter than white)')} />
          <RefNum label={t('Intensity')} refp={sub(refp, 'intensity')} min={0} max={4} step={0.01} clamp unit="x" />
          <RefNum label={t('Bloom radius')} refp={sub(refp, 'radius')} min={0} max={40} step={0.1} unit="%" title={t('% of the source size')} />
          <Row label={t('Streaks')}>
            <Seg
              value={String(glint.streaks) as (typeof STREAK_COUNTS)[number]['value']}
              mixed={streaksMixed}
              options={STREAK_COUNTS.map((o) => (o.value === '0' ? { ...o, label: t(o.label) } : o))}
              onChange={(v) => setAt(sub(refp, 'streaks'), Number(v))}
            />
          </Row>
          {(streaksMixed || glint.streaks > 0) && (
            <>
              <RefNum label={t('Length')} refp={sub(refp, 'length')} min={0} max={200} step={0.5} unit="%" title={t('% of the source size')} />
              <RefNum label={t('Angle')} refp={sub(refp, 'angle')} min={-180} max={180} step={0.5} unit="deg" title={t('Clockwise on screen')} />
            </>
          )}
          <RefColor label={t('Tint')} refp={sub(refp, 'tint')} />
        </div>
      )}
    </div>
  );
}
