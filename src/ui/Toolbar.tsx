import type { KeyboardEvent, ReactNode } from 'react';
import { useEditor, type Tool } from '../store/store';
import { useT } from './i18n';
import { TOOLS, useSpaceHand } from './util';

/** 20 × 20 line icons, drawn in the button's text colour. */
const ICONS: Record<Tool, ReactNode> = {
  move: (
    <>
      <path d="M4 2.5l8.5 4.8-3.8 1.2-1.6 3.7z" fill="currentColor" stroke="none" />
      <path d="M14 10.5v7.5M10.2 14.2h7.6M12.8 11.7l1.2-1.2 1.2 1.2M12.8 16.8l1.2 1.2 1.2-1.2M11.4 13l-1.2 1.2 1.2 1.2M16.6 13l1.2 1.2-1.2 1.2" />
    </>
  ),
  glyph: (
    <>
      <rect x="2.5" y="2.5" width="15" height="15" strokeDasharray="2 2" />
      <path d="M6.3 14.5L10 5.5l3.7 9M7.6 11.4h4.8" />
    </>
  ),
  text: <path d="M4 5.5V3.5h12v2M10 3.5v13M7.3 16.5h5.4" />,
  shape: <rect x="2.5" y="5" width="15" height="10" rx="3.5" />,
  gradient: (
    <>
      <defs>
        <linearGradient id="tool-icon-gradient" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="currentColor" stopOpacity="1" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="2.5" y="3.5" width="15" height="13" rx="1" />
      <rect x="2.5" y="3.5" width="15" height="13" rx="1" fill="url(#tool-icon-gradient)" stroke="none" />
    </>
  ),
  distort: (
    <>
      <path d="M4 5l12.5-2 1 14-13-1.5z" />
      <path d="M2.5 3.5h3v3h-3zM15 1.5h3v3h-3zM16 15.5h3v3h-3zM3 14h3v3H3z" fill="currentColor" stroke="none" />
    </>
  ),
  light: (
    <>
      <circle cx="10" cy="10" r="3.5" />
      <path d="M10 1.8v2.4M10 15.8v2.4M1.8 10h2.4M15.8 10h2.4M4.2 4.2l1.7 1.7M14.1 14.1l1.7 1.7M4.2 15.8l1.7-1.7M14.1 5.9l1.7-1.7" />
    </>
  ),
  hand: (
    <path d="M6.6 10.6V4.8a1.2 1.2 0 0 1 2.4 0V9.4M9 9.4V3.6a1.2 1.2 0 0 1 2.4 0v5.8M11.4 9.4V4.6a1.2 1.2 0 0 1 2.4 0v5M13.8 10.2V6.8a1.2 1.2 0 0 1 2.4 0v5.4c0 3.3-2.3 5.6-5.5 5.6-2.1 0-3.4-.8-4.6-2.4l-2.6-3.6a1.2 1.2 0 0 1 1.9-1.5l1.2 1.3" />
  ),
  zoom: (
    <>
      <circle cx="8.5" cy="8.5" r="5.3" />
      <path d="M12.3 12.3l5.2 5.2M6.2 8.5h4.6M8.5 6.2v4.6" />
    </>
  ),
};

/** The icon of `tool` (also the options bar's tool badge). */
export function ToolIcon({ tool }: { tool: Tool }) {
  return (
    <svg className="tool-icon" viewBox="0 0 20 20" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[tool]}
    </svg>
  );
}

/**
 * The tool strip (left edge, Photoshop's toolbar). Space held shows Hand as the active tool. ↑/↓
 * move focus along the strip (one Tab stop: the active tool); Enter / Space pick a tool.
 */
export function Toolbar() {
  const tool = useEditor((s) => s.view.tool);
  const setTool = useEditor((s) => s.setTool);
  const active = useSpaceHand() ? 'hand' : tool;
  const t = useT();
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Home' && e.key !== 'End') return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const n = buttons.length;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    // The strip owns these keys: the global handler would otherwise nudge the selected layers.
    e.preventDefault();
    e.stopPropagation();
    buttons[next]?.focus();
  };
  return (
    <div className="toolbar" role="toolbar" aria-orientation="vertical" aria-label={t('Tools')} onKeyDown={onKeyDown}>
      {TOOLS.map((x) => {
        const key = x.code.slice(3);
        const on = x.tool === active;
        return (
          <button
            key={x.tool}
            className={`tool-btn ${on ? 'active' : ''}`}
            aria-pressed={on}
            aria-label={t(x.label)}
            aria-keyshortcuts={x.tool === 'text' ? 'T Shift+T' : key}
            tabIndex={on ? 0 : -1}
            title={`${t(x.label)} (${x.tool === 'text' ? 'T / ⇧T' : key})\n${t(x.hint)}`}
            onClick={() => setTool(x.tool)}
          >
            <ToolIcon tool={x.tool} />
          </button>
        );
      })}
    </div>
  );
}
