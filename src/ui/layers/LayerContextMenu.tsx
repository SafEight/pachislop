import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { MenuAnchor } from '../properties/AddEffectMenu';

// Photoshop-style command menu with ▸ submenus: the Layers panel's row context menu and its
// bottom toolbar's ◐ / ⊕ menus. Rendered in a body portal at fixed position, so the dock's
// scrolling and clipping never cut it off.

export interface CtxItem {
  label: string;
  /** Tooltip: what the command does. */
  hint?: string;
  /** Key shown right-aligned (display only; the shortcuts live in App / the panel). */
  shortcut?: string;
  disabled?: boolean;
  /** Toggle commands show a check mark while on. */
  checked?: boolean;
  /** Decorative 16 px glyph in the check column (unused on toggle commands). */
  icon?: ReactNode;
  /** Section heading: an item whose group differs from the previous item's starts a labelled section (the generator categories). */
  group?: string;
  onSelect?: (mods: { altKey: boolean }) => void;
  /** Submenu (▸). */
  items?: CtxEntry[];
}

export type CtxEntry = CtxItem | 'sep';

/** Free space kept between a menu and the window edge, in px. */
const MARGIN = 4;

interface ListProps {
  entries: CtxEntry[];
  anchor: MenuAnchor;
  /** Submenu: opens beside the anchor instead of below it. */
  side: boolean;
  label: string;
  /** Focus the first command on open (keyboard / click-opened submenus); else the menu itself. */
  focusFirst: boolean;
  onDone: () => void;
  /** ← in a submenu: back to its parent item. */
  onBack?: () => void;
}

function MenuList({ entries, anchor, side, label, focusFirst, onDone, onBack }: ListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden', left: 0, top: 0 });
  const [sub, setSub] = useState<{ index: number; anchor: MenuAnchor; focus: boolean } | null>(null);
  const enabled = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>(':scope > .lp-mi:not(:disabled)') ?? [])];

  // Place below the anchor (beside it for a submenu); flip up / left where it would overflow.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = side ? anchor.right : anchor.left;
    if (left + w > window.innerWidth - MARGIN) left = side ? anchor.left - w : anchor.right - w;
    let top = side ? anchor.top : anchor.bottom;
    if (top + h > window.innerHeight - MARGIN) top = side ? anchor.bottom - h : anchor.top - h;
    setPos({ left: Math.max(MARGIN, left), top: Math.max(MARGIN, top), maxHeight: window.innerHeight - 2 * MARGIN });
  }, [anchor, side]);

  useEffect(() => {
    if (focusFirst) enabled()[0]?.focus();
    else ref.current?.focus();
  }, [focusFirst]);

  const openSub = (index: number, el: HTMLElement, focus: boolean) => setSub({ index, anchor: el.getBoundingClientRect(), focus });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = enabled();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const cur = list[i] as HTMLButtonElement | undefined;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const down = e.key === 'ArrowDown';
      list[i < 0 ? (down ? 0 : list.length - 1) : (i + (down ? 1 : -1) + list.length) % list.length]?.focus();
    } else if (e.key === 'ArrowRight' && cur?.dataset.sub) openSub(Number(cur.dataset.sub), cur, true);
    else if (e.key === 'ArrowLeft' && onBack) onBack();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const open = sub ? entries[sub.index] : undefined;
  /** Group heading shown above entry `i`: where an item's group differs from the previous item's. */
  const headingAt = (i: number): string | undefined => {
    const it = entries[i];
    if (it === 'sep' || it.group === undefined) return undefined;
    const prev = entries.slice(0, i).findLast((e): e is CtxItem => e !== 'sep');
    return prev?.group === it.group ? undefined : it.group;
  };
  return (
    <>
      <div ref={ref} className="lp-menu" role="menu" aria-label={label} tabIndex={-1} style={pos} onKeyDown={onKeyDown}>
        {entries.map((it, i) => {
          if (it === 'sep') return <div key={i} className="lp-menu-sep" role="separator" />;
          const heading = headingAt(i);
          return (
            <Fragment key={i}>
              {heading && (
                <div className="lp-menu-head" role="presentation">
                  {heading}
                </div>
              )}
              <button
                className={`lp-mi ${sub?.index === i ? 'open' : ''}`}
                role={it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                title={it.hint ?? it.label}
                aria-label={it.label}
                aria-haspopup={it.items ? 'menu' : undefined}
                aria-checked={it.checked}
                disabled={it.disabled}
                data-sub={it.items ? i : undefined}
                onPointerEnter={(e) => (it.items ? openSub(i, e.currentTarget, false) : setSub(null))}
                onClick={(e) => {
                  if (it.items) return openSub(i, e.currentTarget, true);
                  onDone();
                  it.onSelect?.({ altKey: e.altKey });
                }}
              >
                <span className="lp-mi-check" aria-hidden>
                  {it.checked ? '✓' : (it.icon ?? '')}
                </span>
                <span className="lp-mi-label">{it.label}</span>
                {it.shortcut && <span className="lp-mi-key">{it.shortcut}</span>}
                {it.items && (
                  <span className="lp-mi-key" aria-hidden>
                    ▸
                  </span>
                )}
              </button>
            </Fragment>
          );
        })}
      </div>
      {sub && open && open !== 'sep' && open.items && (
        <MenuList
          key={sub.index}
          entries={open.items}
          anchor={sub.anchor}
          side
          label={open.label}
          focusFirst={sub.focus}
          onDone={onDone}
          onBack={() => {
            setSub(null);
            ref.current?.querySelector<HTMLButtonElement>(`:scope > [data-sub="${sub.index}"]`)?.focus();
          }}
        />
      )}
    </>
  );
}

/**
 * Menu opened at `anchor` (a row's pointer position or a button's rect). Closes on Esc, a
 * pointer-down outside every open menu level and outside `trigger` (the button that opened it
 * toggles it itself), a command, or window blur / resize.
 */
export function ContextMenu({ anchor, items, label, trigger, onClose }: { anchor: MenuAnchor; items: CtxEntry[]; label: string; trigger?: HTMLElement | null; onClose: () => void }) {
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element && (trigger?.contains(t) || t.closest('.lp-menu')))) onClose();
    };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose, trigger]);
  return createPortal(<MenuList entries={items} anchor={anchor} side={false} label={label} focusFirst={false} onDone={onClose} />, document.body);
}
