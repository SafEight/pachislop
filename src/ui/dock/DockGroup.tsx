import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { useT } from '../i18n';

export interface DockTab<Id extends string> {
  id: Id;
  label: string;
  title: string;
}

/**
 * One stacked tab group of the dock (Photoshop panel group): a tab strip and the active tab's
 * panel. Collapsed, only the strip shows and the other group takes the height. ←/→ (Home/End)
 * switch tabs on the strip; double-clicking the strip's empty part or the ▾ button collapses.
 */
export function DockGroup<Id extends string>({
  label,
  tabs,
  active,
  collapsed,
  style,
  onSelect,
  onToggleCollapsed,
  children,
}: {
  /** Accessible name of the tab strip. */
  label: string;
  tabs: readonly DockTab<Id>[];
  active: Id;
  collapsed: boolean;
  style?: CSSProperties;
  /** Make `id` the active tab (and expand the group). */
  onSelect: (id: Id) => void;
  onToggleCollapsed: () => void;
  /** The active tab's panel. */
  children: ReactNode;
}) {
  const t = useT();
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((tab) => tab.id === active);
    const next =
      e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0 || !(e.target instanceof HTMLElement) || e.target.getAttribute('role') !== 'tab') return;
    // The strip owns these keys: the global handler would otherwise nudge the selected layers.
    e.preventDefault();
    e.stopPropagation();
    onSelect(tabs[next].id);
    document.getElementById(`dock-tab-${tabs[next].id}`)?.focus();
  };
  return (
    <section className={`dock-group ${collapsed ? 'collapsed' : ''}`} style={style}>
      <div
        className="dock-tabs"
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        onDoubleClick={(e) => e.target === e.currentTarget && onToggleCollapsed()}
        title={t('Double-click the empty strip to collapse / expand the group')}
      >
        {tabs.map((tab) => {
          const on = tab.id === active;
          return (
            <button
              key={tab.id}
              id={`dock-tab-${tab.id}`}
              role="tab"
              className={`dock-tab ${on ? 'active' : ''}`}
              aria-selected={on}
              aria-controls={on && !collapsed ? `dock-panel-${tab.id}` : undefined}
              tabIndex={on ? 0 : -1}
              title={t(tab.title)}
              onClick={() => onSelect(tab.id)}
            >
              {t(tab.label)}
            </button>
          );
        })}
        <button
          className="dock-collapse"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('Expand {panel}', { panel: label }) : t('Collapse {panel}', { panel: label })}
          title={collapsed ? t('Expand the group') : t('Collapse the group to its tabs (the other group takes the space)')}
          onClick={onToggleCollapsed}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      </div>
      {!collapsed && (
        <div className="dock-panel" role="tabpanel" id={`dock-panel-${active}`} aria-labelledby={`dock-tab-${active}`} tabIndex={-1}>
          {children}
        </div>
      )}
    </section>
  );
}
