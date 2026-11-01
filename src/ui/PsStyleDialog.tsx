import { useMemo, useState } from 'react';
import { convertPsStyle, type ConvertedStyle, type PsStyleFile } from '../io/psStyle';
import { addUserPreset } from '../presets/user';
import { errorMsg, formatMsg, joinMsgs, msg, type Msg } from '../store/msg';
import { useEditor } from '../store/store';
import { NumberField } from './controls';
import { useT } from './i18n';
import './export.css';

// The "Import PS style…" dialog (PsStyleImport.tsx): lets the user confirm the size each style
// was designed for (px → % of size) and adds the chosen ones to My Styles. Loaded on demand with
// the ag-psd reader (io/psStyle).

interface Choice {
  on: boolean;
  /** Reference size in px: style px become % of it. */
  size: number;
}

export function PsStyleDialog({ fileName, data, onClose }: { fileName: string; data: PsStyleFile; onClose: () => void }) {
  const t = useT();
  const [choices, setChoices] = useState<Choice[]>(() => data.styles.map((s) => ({ on: true, size: s.fontPx ?? s.suggestedPx })));
  const converted = useMemo(
    () =>
      data.styles.map((s, i): ConvertedStyle | { error: Msg } => {
        try {
          return convertPsStyle(s, choices[i].size);
        } catch (e) {
          return { error: errorMsg(e) };
        }
      }),
    [data, choices],
  );
  const update = (i: number, patch: Partial<Choice>) => setChoices((prev) => prev.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const chosen = converted.filter((c, i): c is ConvertedStyle => choices[i].on && 'preset' in c);

  const importChosen = () => {
    for (const c of chosen) addUserPreset(c.preset);
    useEditor
      .getState()
      .notify(chosen.length === 1 ? msg('Imported {n} PS style into My Styles', { n: chosen.length }) : msg('Imported {n} PS styles into My Styles', { n: chosen.length }));
    onClose();
  };

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal ps-dialog" role="dialog" aria-label={t('Import Photoshop styles')} onKeyDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="ellipsis">{t('Import PS styles · {file}', { file: fileName })}</span>
          <button className="icon-btn right" onClick={onClose} title={t('Close')} aria-label={t('Close')}>
            ✕
          </button>
        </div>
        <div className="body ps-body">
          <div className="notes muted">
            {t(
              'Photoshop sizes are px; here they are % of the text size. Check the size each style was made for: the font size when the file has it, else confirm it (the layer height is offered).',
            )}
          </div>
          {data.styles.map((s, i) => {
            const c = converted[i];
            const known = s.fontPx !== null;
            const origin = formatMsg(s.origin, t);
            const sizeNote = formatMsg(s.sizeNote, t);
            return (
              <div key={i} className={`ps-row${choices[i].on ? '' : ' off'}`}>
                <label className="ps-name" title={`${s.name} (${origin})`}>
                  <input type="checkbox" checked={choices[i].on} onChange={(e) => update(i, { on: e.target.checked })} />
                  <span className="ellipsis">{s.name}</span>
                  <span className="muted ps-origin">{origin}</span>
                </label>
                <span className="ps-size" title={known ? t('From the {note}', { note: sizeNote }) : t('Size the style was designed for ({note}); confirm or type it', { note: sizeNote })}>
                  <NumberField
                    id={`ps-size-${i}`}
                    label={t('Reference size of {name}', { name: s.name })}
                    value={choices[i].size}
                    onChange={(v) => update(i, { size: v })}
                    min={1}
                    max={2000}
                    step={1}
                    unit="px"
                    clamp
                    slider={false}
                    defaultValue={s.fontPx ?? s.suggestedPx}
                  />
                  <span className={known ? 'muted' : 'ps-confirm'}>{known ? sizeNote : t('confirm · {note}', { note: sizeNote })}</span>
                </span>
                {'error' in c ? (
                  <div className="status error">{formatMsg(c.error, t)}</div>
                ) : (
                  <div className="ps-detail">
                    <span>{c.summary.length ? formatMsg(joinMsgs(c.summary, ' · '), t) : t('no supported effects')}</span>
                    {c.notes.length > 0 && <span className="muted"> — {formatMsg(joinMsgs(c.notes, '; '), t)}</span>}
                  </div>
                )}
              </div>
            );
          })}
          {data.skipped.length > 0 && <div className="notes muted">{t('Skipped: {list}', { list: formatMsg(joinMsgs(data.skipped, '; '), t) })}</div>}
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>{t('Cancel')}</button>
          <button className="primary" disabled={!chosen.length} onClick={importChosen} title={t('Add the checked styles to My Styles')}>
            {chosen.length === 1 ? t('Import {n} style', { n: chosen.length }) : t('Import {n} styles', { n: chosen.length })}
          </button>
        </div>
      </div>
    </div>
  );
}
