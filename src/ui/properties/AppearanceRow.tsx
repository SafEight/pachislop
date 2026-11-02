import { Fragment, useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Swatch } from './style/widgets';

// Appearance rows (Illustrator's Appearance panel): a list of materials, each a row with eye,
// swatch, link badge, name + summary, an optional width field and hover actions; clicking a row
// edits it right under its row, ⇧ / ⌘ select several, edited together under the last of them.
// The layer's Appearance (its parts) and the Letters section (a letter's face, side and bands)
// both list theirs with these.

/** A row click, as the selection handlers read it. */
export type RowClick = MouseEvent | KeyboardEvent;

/**
 * The list of rows. `shownKey` names the selected rows: when it changes, the first selected row is
 * brought to the top of the panel if it is out of view (a part selected elsewhere, or from a row
 * scrolled away), after PropertiesPanel restored the remembered scroll (its frame runs first).
 */
export function AppearanceStack({ label, shownKey, children }: { label: string; shownKey: string; children: ReactNode }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = list.current?.querySelector(':scope > .sty-row.sel');
    const body = row?.closest('.props-body');
    if (!row || !body) return;
    const raf = requestAnimationFrame(() => {
      const r = row.getBoundingClientRect();
      const b = body.getBoundingClientRect();
      if (r.top < b.top || r.bottom > b.bottom - 120) body.scrollTop += r.top - b.top - 8;
    });
    return () => cancelAnimationFrame(raf);
  }, [shownKey]);
  return (
    <div ref={list} className="sty-stack" role="list" aria-label={label}>
      {children}
    </div>
  );
}

export interface AppearanceRowProps {
  /** Selected (highlighted, actions shown). */
  sel: boolean;
  /** The last selected row: its twisty is open and `children` (the editor) show under it. */
  open: boolean;
  /** Hidden part: name and swatch dimmed. */
  off?: boolean;
  /** Uses another's material (a letter's part that is the layer's, a 3D side that shows the face): swatch muted. */
  inherited?: boolean;
  title: string;
  onClick: (e: RowClick) => void;
  /** Show / hide toggle; an empty cell when absent, so rows line up. */
  eye?: ReactNode;
  swatch: string;
  /** Several targets that differ: a striped swatch. */
  swatchMixed?: boolean;
  badge?: ReactNode;
  name: string;
  summary?: string;
  /** Field on the row itself (a rim's width, a band's grow). */
  width?: ReactNode;
  /** Buttons shown on hover and while selected. */
  actions?: ReactNode;
  /** The inline editor, shown under the row while it is `open`. */
  children?: ReactNode;
}

/** One row of an AppearanceStack, with its inline editor under it while it is open. */
export function AppearanceRow({ sel, open, off, inherited, title, onClick, eye, swatch, swatchMixed, badge, name, summary, width, actions, children }: AppearanceRowProps) {
  return (
    <Fragment>
      <div
        role="listitem"
        tabIndex={0}
        aria-selected={sel}
        aria-expanded={open}
        className={`sty-row ${sel ? 'sel' : ''} ${off ? 'off' : ''}${inherited ? ' inherited' : ''}`}
        title={title}
        onClick={onClick}
        onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && onClick(e)}
      >
        <span className="sty-twisty" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        {eye ?? <span className="part-eye" aria-hidden />}
        <Swatch css={swatch} mixed={swatchMixed} />
        {badge}
        <span className="sty-name">
          {name} {summary && <span className="muted">· {summary}</span>}
        </span>
        {width}
        <span className="sty-actions">{actions}</span>
      </div>
      {open && children}
    </Fragment>
  );
}
