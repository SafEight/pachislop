import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';

/** Hit radius of every on-canvas handle, CSS px: a ≥ 24 px target whatever the drawn size. */
export const HIT_R = 12;
/** Hit radius of a handle that covers only its own drawn disc / diamond, CSS px. */
export const EXACT_HIT_R = 8;
/**
 * Hit radius of the handles below it (default HIT_R). The Viewport sets EXACT_HIT_R on a shape's
 * own handles while the 3D gizmo shares the canvas with them: drawn above the gizmo, they keep
 * presses on themselves only, so the gizmo's arrows and arcs around them stay grabbable.
 */
export const HandleHitRadius = createContext(HIT_R);

/** Screen px within which a dragged point handle snaps (Shift) to its centre, and a dragged layer's edges / centre snap. */
export const SNAP_PX = 8;
/** Screen length of a direction arrow whose param has no length. */
export const ARROW_PX = 70;

/** Rotate cursor (CSS has none): a circular arrow, hotspot in the middle. */
export const ROTATE_CURSOR: CSSProperties['cursor'] =
  `url("data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M18.5 9A7 7 0 1 0 19 14" fill="none" stroke="#000" stroke-width="4" stroke-linecap="round"/><path d="M18.5 9A7 7 0 1 0 19 14" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/><path d="M21.5 4.5l-2.5 6-6-2.5z" fill="#fff" stroke="#000" stroke-width="1"/></svg>',
  )}") 12 12, grab`;

/**
 * One draggable on-canvas handle: the drawn `children` (visual only) plus an invisible hit
 * circle of `HIT_R` around (x, y) that takes the press, so small handles stay easy to grab
 * (`hit`: an own hit shape instead, class `hit`, for arrows, arcs and rings).
 * Drawn after glyph / layer outlines, and its press stops propagation, so it always wins over
 * glyph and layer hit-testing. Hovering lights the handle up.
 */
export function Handle({
  x,
  y,
  cursor,
  title,
  onDown,
  className,
  hit,
  children,
}: {
  x: number;
  y: number;
  cursor: CSSProperties['cursor'];
  title: string;
  onDown: (e: React.PointerEvent) => void;
  className?: string;
  hit?: ReactNode;
  children: ReactNode;
}) {
  const hitR = useContext(HandleHitRadius);
  return (
    <g
      className={`hh ${className ?? ''}`}
      style={{ cursor }}
      role="button"
      aria-label={title}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        onDown(e);
      }}
    >
      <title>{title}</title>
      {hit ?? <circle className="hit" cx={x} cy={y} r={hitR} />}
      {children}
    </g>
  );
}
