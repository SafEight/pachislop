import { useState } from 'react';
import type { Title2DLayer } from '../../model/types';
import { refKey } from '../../store/paths';
import { useEditor } from '../../store/store';
import { IconBtn, MixedCheckbox, NumberField, RefNum, Row } from '../controls';
import { deleteErode, ERODE_ABOUT, ERODE_NAME, ERODE_PINNED, erodeRefs, resetErode, setErodeEnabled } from '../erode';
import { useT } from '../i18n';
import { useRefValue } from '../util';
import { InfoTip } from './InfoTip';
import { sub } from './style/shared';
import './effects.css';

/**
 * The 2D かすれ dry brush (`style.erode`) as an effect card (see ui/erode.ts): on / off, Reset,
 * Delete (switches it off) and its settings. `layers`: one 2D title, or several (a
 * multi-selection) edited together, “—” where they differ. In a list it collapses and its name
 * opens the erode node; `full` is that node's view. Pinned: no drag, no move.
 */
export function ErodeCard({ layers, full }: { layers: readonly Title2DLayer[]; full?: boolean }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const setEachAt = useEditor((s) => s.setEachAt);
  const selectNode = useEditor((s) => s.selectNode);
  const single = layers.length === 1;
  const layerId = layers[0].id;
  const selected = useEditor((s) => single && s.selectedNode?.kind === 'erode' && s.selectedNode.layerId === layerId);
  const [open, setOpen] = useState(true);
  const ids = layers.map((l) => l.id);
  const refp = erodeRefs(ids);
  const enabled = useRefValue(sub(refp, 'enabled'));
  const seedRef = sub(refp, 'seed');
  const seed = useRefValue(seedRef);
  const name = t(ERODE_NAME);
  const link = !full && single;
  const shown = full || open;
  const select = () => link && selectNode({ kind: 'erode', layerId });
  return (
    <div className={`effect erode ${full ? 'full' : ''} ${enabled.value === false && !enabled.mixed ? 'disabled' : ''} ${selected ? 'sel' : ''}`}>
      <div className="effect-head">
        {!full && (
          <>
            <span className="grip pinned" title={t(ERODE_PINNED)}>
              ⊤
            </span>
            <button className="twisty icon-btn" title={open ? t('Collapse') : t('Expand')} aria-label={open ? t('Collapse') : t('Expand')} aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? '▾' : '▸'}
            </button>
          </>
        )}
        <MixedCheckbox title={t('Enable')} aria-label={t('Enable {name}', { name })} checked={enabled.value === true} mixed={enabled.mixed} onChange={(v) => setErodeEnabled(ids, v)} />
        <span
          className={`fx-name ${link ? 'link' : ''}`}
          role={link ? 'button' : undefined}
          tabIndex={link ? 0 : undefined}
          title={t('{label} ({category}): {description}', { label: name, category: t('Distort'), description: t(ERODE_ABOUT) })}
          onClick={select}
          onKeyDown={(e) => e.key === 'Enter' && select()}
        >
          {name}
        </span>
        <InfoTip text={`${t(ERODE_ABOUT)}\n${t(ERODE_PINNED)}`} />
        {!single && <span className="muted">{t('× {n} layers', { n: layers.length })}</span>}
        <span className="right">
          <IconBtn title={t('Reset the dry-brush settings to their defaults')} onClick={() => resetErode(ids)}>
            ↺
          </IconBtn>
          <IconBtn danger title={t('Delete')} onClick={() => deleteErode(ids)}>
            ✕
          </IconBtn>
        </span>
      </div>
      {shown && (
        <div className="effect-body">
          <RefNum label={t('Amount')} refp={sub(refp, 'amount')} min={0} max={1} clamp display={100} unit="%" title={t('How much of the edge band the dry brush leaves bare')} />
          <RefNum label={t('Edge band')} refp={sub(refp, 'edge')} min={0.5} max={30} step={0.1} unit="%" title={t('How far in from the outer silhouette the streaks may reach (face and every rim alike)')} />
          <RefNum label={t('Streak length')} refp={sub(refp, 'scale')} min={1} max={60} step={0.5} unit="%" title={t('Length of the dry-brush drag marks')} />
          <RefNum label={t('Drag angle')} refp={sub(refp, 'angle')} min={-180} max={180} step={1} unit="deg" defaultValue={0} title={t('Direction the brush was dragged, clockwise on screen (0 = left → right)')} />
          <Row label={t('Seed')}>
            <NumberField
              id={refKey(seedRef)}
              label={t('Erode seed')}
              value={typeof seed.value === 'number' ? seed.value : 0}
              mixed={seed.mixed}
              onChange={(v, c) => setAt(seedRef, v, c)}
              min={0}
              max={9999}
              integer
              slider={false}
            />
            <IconBtn title={t('New random streaks')} onClick={() => setEachAt(seedRef, () => Math.floor(Math.random() * 10000))}>
              🎲
            </IconBtn>
          </Row>
        </div>
      )}
    </div>
  );
}
