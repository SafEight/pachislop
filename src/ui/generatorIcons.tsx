import type { ReactNode } from 'react';

// 16 px generator-layer glyphs (Layers rows while the thumbnail renders, the add menu, the
// Properties header), drawn in currentColor like adjustIcons.tsx.

/** A four-point sparkle: unknown generator types (a project from a newer version). */
const SPARKLE = <path d="M8 1.5 9.3 6.7 14.5 8 9.3 9.3 8 14.5 6.7 9.3 1.5 8 6.7 6.7z" fill="currentColor" />;

const GLYPHS: Readonly<Record<string, ReactNode>> = {
  particles: (
    <>
      <circle cx="4" cy="4.5" r="1.6" fill="currentColor" />
      <circle cx="11.5" cy="3" r="1" fill="currentColor" />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
      <circle cx="13" cy="9.5" r="1.3" fill="currentColor" />
      <circle cx="3" cy="11.5" r="1" fill="currentColor" />
      <circle cx="9" cy="13.5" r="1.2" fill="currentColor" />
    </>
  ),
  // 集中線: lines from the frame toward an empty centre.
  speedLines: (
    <path
      d="M8 .5V4.5M8 11.5v4M.5 8h4M11.5 8h4M2.2 2.2l2.8 2.8M11 11l2.8 2.8M13.8 2.2 11 5M5 11l-2.8 2.8M4.5.9l1.3 3.4M10.2 11.7l1.3 3.4M15.1 4.5l-3.4 1.3M4.3 10.2.9 11.5M11.5.9l-1.3 3.4M5.8 11.7l-1.3 3.4M15.1 11.5l-3.4-1.3M.9 4.5l3.4 1.3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
    />
  ),
  // Anamorphic streak through a star glint.
  lightStreaks: (
    <>
      <path d="M.5 8C5 7.4 11 7.4 15.5 8 11 8.6 5 8.6.5 8z" fill="currentColor" />
      <path d="M8 3.5 8.7 7.3 12.5 8 8.7 8.7 8 12.5 7.3 8.7 3.5 8 7.3 7.3z" fill="currentColor" />
    </>
  ),
  // Alternating rays from the centre.
  sunburst: (
    <path d="M8 8 6.9.5h2.2zM8 8 13.3 2.7l1.6 1.6zM8 8l7.5-1.1v2.2zM8 8l5.3 5.3-1.6 1.6zM8 8l1.1 7.5H6.9zM8 8l-5.3 5.3-1.6-1.6zM8 8 .5 9.1V6.9zM8 8 2.7 2.7l1.6-1.6z" fill="currentColor" />
  ),
  // Expanding rings.
  shockwave: (
    <>
      <circle cx="8" cy="8" r="1.5" fill="currentColor" />
      <circle cx="8" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="8" cy="8" r="6.8" fill="none" stroke="currentColor" strokeOpacity="0.55" />
    </>
  ),
  // 魔法陣: ring around a hexagram.
  magicCircle: (
    <>
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" />
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeOpacity="0.55" />
      <path d="M8 2.6 12.7 10.7H3.3zM8 13.4 3.3 5.3h9.4z" fill="none" stroke="currentColor" strokeLinejoin="round" />
    </>
  ),
  // 筆渦: a tapering brush spiral.
  brushSwirl: (
    <path
      d="M8.5 8.2c-.4-1.4 1.6-1.9 2.2-.6.9 1.9-1.3 3.7-3.3 3.2-2.8-.7-3.2-4.4-1.1-6.2 2.7-2.3 7-.8 7.7 2.7.8 4-3 7.2-6.9 6.6-3.2-.5-5.5-3.4-5.4-6.6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  ),
  // Full-frame 柄 (zebra stripes in the frame).
  patternFill: (
    <>
      <rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke="currentColor" />
      <path d="M1.5 5.5 5.5 1.5h2.5l-6.5 6.5zM1.5 11 11 1.5h2.5L1.5 13.5zM6.5 14.5 14.5 6.5V9l-5.5 5.5zM12 14.5l2.5-2.5v2.5z" fill="currentColor" />
    </>
  ),
};

/** 16 px icon of a generator type (Layers rows, menus, Properties). Decorative: label the surrounding control. */
export function GeneratorIcon({ type }: { type: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={{ flex: 'none' }}>
      {GLYPHS[type] ?? SPARKLE}
    </svg>
  );
}
