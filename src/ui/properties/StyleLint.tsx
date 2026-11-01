import { useMemo, useRef } from 'react';
import type { Title2DLayer, Title3DLayer } from '../../model/types';
import { lintStyle } from '../../presets/lint';
import { formatMsg, msg } from '../../store/msg';
import { useEditor } from '../../store/store';
import { useT } from '../i18n';
import { oneShot, usePopover } from '../util';
import './lint.css';

type TitleLayer = Title2DLayer | Title3DLayer;

/**
 * Style check badge: ✓ when the look follows the practitioners' rules, else the number of
 * issues; click for the list, each citing its rule (hover) with a one-click fix where the
 * repair is mechanical. Fixes are single undo steps.
 */
export function StyleLint({ layer }: { layer: TitleLayer }) {
  const t = useT();
  const anchor = useRef<HTMLSpanElement>(null);
  const pop = usePopover(anchor, 'right');
  const issues = useMemo(() => lintStyle(layer), [layer]);
  const n = issues.length;
  return (
    <span className="lint" ref={anchor}>
      <button
        className={`lint-badge ${n ? 'warn' : 'ok'}`}
        aria-label={n ? t(n === 1 ? 'Style check: {n} issue' : 'Style check: {n} issues', { n }) : t('Style check: no issues')}
        aria-expanded={pop.open}
        title={
          n
            ? t(n === 1 ? 'Style check: {n} issue — click for details and fixes' : 'Style check: {n} issues — click for details and fixes', { n })
            : t('Style check: contrast, hues, rim widths, shadows and rainbow span follow the usual practice, and no switch is on without effect')
        }
        onClick={() => pop.setOpen(!pop.open)}
      >
        {n ? `⚠ ${n}` : '✓'}
      </button>
      {pop.open && (
        <div className="menu-pop lint-pop" style={pop.style} role="dialog" aria-label={t('Style check')}>
          {n === 0 && <div className="lint-none">{t('No issues: lightness alternates, hues stay in check, rims and shadows are in range, and every switch that is on shows.')}</div>}
          {issues.map((it) => {
            const rule = formatMsg(it.rule, t);
            return (
              <div key={it.id} className="lint-item">
                <div className="lint-msg">
                  {formatMsg(it.message, t)}
                  <span className="lint-rule" title={rule} aria-label={t('Rule: {rule}', { rule })}>
                    ⓘ
                  </span>
                </div>
                {it.fix && (
                  <button
                    className="small"
                    title={t('{fix} (undoable)', { fix: t(it.fix.label) })}
                    onClick={() => {
                      const fixed = it.fix!.apply(layer);
                      useEditor.getState().replaceLayer(layer.id, fixed, oneShot('lint'), msg('Style fix: {fix}', { fix: msg(it.fix!.label) }));
                    }}
                  >
                    {t(it.fix.label)}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </span>
  );
}
