import { engineHost } from '../engineHost';
import type { Pt } from './geometry';

/** Comp ↔ overlay mapping of the current view. */
export interface StageMap {
  /** CSS px per comp px. */
  d: number;
  /** Comp point → overlay (stage) px. */
  S(p: Pt): Pt;
  /** Client (pointer) coords → comp point. */
  toComp(clientX: number, clientY: number): Pt;
  /** Comp point → client coords. */
  client(p: Pt): Pt;
}

/** Screen px a press must travel before it counts as a drag. */
const DRAG_SLOP = 3;

export interface DragOptions {
  /**
   * The gesture edits the project (default): engine interactive mode is on from the first move
   * to the release (cheap preview renders, one full-quality render at the end). Pan / marquee
   * gestures change no pixels and pass false.
   */
  interactive?: boolean;
}

/** Start a window-level pointer drag; `move` gets client coords + modifiers. */
export function drag(e: React.PointerEvent, move: (ev: PointerEvent) => void, end?: () => void, opts: DragOptions = {}) {
  e.preventDefault();
  e.stopPropagation();
  const interactive = opts.interactive ?? true;
  let live = false;
  const mv = (ev: PointerEvent) => {
    if (interactive && !live) {
      live = true;
      engineHost.setInteractive(true);
    }
    move(ev);
  };
  const up = () => {
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    end?.();
    if (live) engineHost.setInteractive(false);
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/**
 * A press that is a click unless it travels `DRAG_SLOP` px: `onDrag` runs for every move once
 * dragging (the press event is passed so gestures can measure from it), `onClick` on a
 * release without travel, `onEnd` after a drag. Interactive mode only starts once it drags.
 */
export function press(
  e: React.PointerEvent,
  h: { onDrag?: (ev: PointerEvent) => void; onClick?: (ev: PointerEvent) => void; onEnd?: () => void },
  opts: DragOptions = {},
) {
  const sx = e.clientX;
  const sy = e.clientY;
  const interactive = opts.interactive ?? true;
  let dragging = false;
  let last: PointerEvent | null = null;
  drag(
    e,
    (ev) => {
      last = ev;
      if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_SLOP) return;
      if (!dragging && interactive) engineHost.setInteractive(true);
      dragging = true;
      h.onDrag?.(ev);
    },
    () => {
      if (dragging) h.onEnd?.();
      else h.onClick?.(last ?? (e.nativeEvent as PointerEvent));
      if (dragging && interactive) engineHost.setInteractive(false);
    },
    { interactive: false },
  );
}

/** Two presses within this many ms and px are a double-click. */
const DOUBLE_MS = 400;
const DOUBLE_PX = 5;
let lastPress = { t: 0, x: 0, y: 0 };

/**
 * True when this pointerdown completes a double-click. Pointer events carry no click count, and
 * default-prevented presses stop the browser's own dblclick, so gestures count presses here.
 */
export function isDoublePress(e: React.PointerEvent): boolean {
  const now = performance.now();
  const double = now - lastPress.t < DOUBLE_MS && Math.hypot(e.clientX - lastPress.x, e.clientY - lastPress.y) < DOUBLE_PX;
  lastPress = double ? { t: 0, x: 0, y: 0 } : { t: now, x: e.clientX, y: e.clientY };
  return double;
}
