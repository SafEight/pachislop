import type { RenderFrame } from './contracts';

/** A target that is the whole render: `width`×`height` render px, nothing cut off (see RenderFrame). */
export function wholeFrame(width: number, height: number): RenderFrame {
  return { width, height, x: 0, y: 0 };
}

/** A `width`×`height` target of frame `f` is the whole render (no preview window). */
export function isWhole(f: RenderFrame, width: number, height: number): boolean {
  return f.x === 0 && f.y === 0 && f.width === width && f.height === height;
}

/** Render px x of the comp centre on a target of the frame `f` (origin: the target's left edge). */
export function centreX(f: RenderFrame): number {
  return f.width / 2 - f.x;
}

/** Render px y of the comp centre on a target of the frame `f` (origin: the target's bottom edge, +y up). */
export function centreY(f: RenderFrame): number {
  return f.height / 2 - f.y;
}

/**
 * The frame of a `width`×`height` target at `k` times the resolution of a `w`×`h` target of
 * frame `f` (a reduced-scale surface of the same window); a whole frame stays whole.
 */
export function scaledFrame(f: RenderFrame, w: number, h: number, k: number, width: number, height: number): RenderFrame {
  if (isWhole(f, w, h)) return wholeFrame(width, height);
  return { width: Math.max(1, Math.round(f.width * k)), height: Math.max(1, Math.round(f.height * k)), x: Math.round(f.x * k), y: Math.round(f.y * k) };
}

/** Key part naming the window a `width`×`height` target of `f` is (empty for a whole frame), for caches keyed by render size. */
export function frameKey(f: RenderFrame, width: number, height: number): string {
  return isWhole(f, width, height) ? '' : `[${f.width}x${f.height}+${f.x}+${f.y}]`;
}
