import { useEffect, useRef } from 'react';
import { formatMsg } from '../../store/msg';
import { useEditor } from '../../store/store';
import { useT } from '../i18n';
import './layers.css';

/**
 * Photoshop-style History panel: the oldest kept state ('Start'), every applied step and (dimmed)
 * the undone steps still redoable. Clicking a row jumps there; a new edit drops the dimmed rows.
 */
export function HistoryPanel() {
  const past = useEditor((s) => s.past);
  const future = useEditor((s) => s.future);
  const jumpTo = useEditor((s) => s.jumpTo);
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);
  const rows = [t('Start'), ...past.map((h) => formatMsg(h.label, t)), ...future.map((h) => formatMsg(h.label, t))];
  const current = past.length;

  // Keep the current state in view as steps are added or undone.
  useEffect(() => {
    listRef.current?.querySelector('.hp-item.current')?.scrollIntoView({ block: 'nearest' });
  }, [current, rows.length]);

  return (
    <div className="hp" ref={listRef} role="listbox" aria-label={t('History')}>
      {rows.map((label, i) => (
        <button
          key={i}
          className={`hp-item ${i === current ? 'current' : ''} ${i > current ? 'undone' : ''}`}
          role="option"
          aria-selected={i === current}
          aria-label={label}
          title={i > current ? t('Undone: click to redo up to here') : i === current ? t('Current state') : t('Click to go back to here')}
          onClick={() => jumpTo(i)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
