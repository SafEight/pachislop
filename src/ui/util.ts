import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from 'react';
import { getEffect } from '../effects/registry';
import { gradientHasAlpha, hexToRgb, sampleGradientRgba } from '../model/gradient';
import type { EffectInstance, FillKind, Gradient, ShapeKind } from '../model/types';
import { effectName as effectNameMsg } from '../store/effects';
import { formatMsg, type Translate } from '../store/msg';
import { getRef, isMultiRef, MIXED, refList } from '../store/paths';
import { useEditor, type Refs, type Tool } from '../store/store';

// Non-component UI helpers (kept out of .tsx component modules so Fast Refresh stays local).

let gestureCounter = 0;
/** Returns a coalesce-key factory: edits within one pointer gesture/typing burst share a key. */
export function useGesture(base: string) {
  const id = useRef(0);
  return {
    begin: () => {
      id.current = ++gestureCounter;
    },
    key: () => `${base}#${id.current}`,
  };
}

/** A fresh coalesce key: edits carrying it merge only with each other (a one-shot edit, or every step of one drag gesture). */
export const oneShot = (base: string) => `${base}!${++gestureCounter}`;

/**
 * A ref to `value` as of the last commit, for handlers and listeners that outlive the render they
 * were made in. Read it in those, never while rendering.
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** Floating popover anchored to the element `anchor` points at (fixed positioning escapes scrolling panels). */
export function usePopover(anchor: RefObject<HTMLElement | null>, align: 'left' | 'right' = 'right') {
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const open = pos !== null;
  const setOpen = (o: boolean) => {
    if (!o || !anchor.current) return setPos(null);
    const r = anchor.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const up = below < 300 && r.top > below;
    setPos({
      position: 'fixed',
      ...(align === 'right' ? { right: Math.max(4, window.innerWidth - r.right), left: 'auto' } : { left: Math.max(4, r.left), right: 'auto' }),
      ...(up ? { top: 'auto', bottom: window.innerHeight - r.top + 2 } : { top: r.bottom + 2, bottom: 'auto' }),
      maxHeight: (up ? r.top : below) - 12,
    });
  };
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!anchor.current?.contains(e.target as Node)) setPos(null);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setPos(null);
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open, anchor]);
  return { open, setOpen, style: pos ?? undefined };
}

/** Display name of effect instance `fx` (an Adjust effect shows its adjustment's name; unknown types show their id). */
export function effectName(t: Translate, fx: EffectInstance): string {
  return getEffect(fx.type) ? formatMsg(effectNameMsg(fx), t) : t('{type} (unknown effect)', { type: fx.type });
}

/** Readable, translated preset name: goldRamp → “Gold Ramp” (the English is the i18n key). */
export const gradientPresetLabel = (t: Translate, name: string) => t(name.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()));

/**
 * True while keys go to a text field (text inputs, selects, text areas, contentEditable): global
 * letter / arrow / Space shortcuts stand aside. Checkboxes, sliders, colour wells and buttons don't type.
 */
export const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT' ||
    (t.tagName === 'INPUT' && !['checkbox', 'range', 'color', 'button'].includes((t as HTMLInputElement).type)));

// Space held = temporary Hand tool (Photoshop). Transient, never saved or undone: App's global
// key handler sets it, the Viewport pans with it and the Toolbar lights Hand up while it is held.
let spaceHand = false;
const spaceListeners = new Set<() => void>();
const subscribeSpace = (l: () => void) => {
  spaceListeners.add(l);
  return () => {
    spaceListeners.delete(l);
  };
};

export function setSpaceHand(held: boolean) {
  if (spaceHand === held) return;
  spaceHand = held;
  spaceListeners.forEach((l) => l());
}

/** Whether Space is held (the active tool is then Hand, whatever `view.tool` says). */
export function useSpaceHand(): boolean {
  return useSyncExternalStore(subscribeSpace, () => spaceHand);
}

/** Photoshop's zoom ladder (display scale) for ⌘= / ⌘- and the Zoom tool's options. */
const ZOOM_STEPS = [1 / 16, 1 / 8, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 1, 1.5, 2, 3, 4, 6, 8];

/** Next ladder step above (dir 1) or below (dir -1) the current display scale, zooming about the view centre. */
export function stepZoom(dir: 1 | -1) {
  const { view, fitScale, setView } = useEditor.getState();
  const d = view.zoom === 'fit' ? fitScale : view.zoom;
  const next = dir > 0 ? (ZOOM_STEPS.find((z) => z > d * 1.01) ?? ZOOM_STEPS.at(-1)!) : (ZOOM_STEPS.findLast((z) => z < d / 1.01) ?? ZOOM_STEPS[0]);
  const k = next / d;
  setView({ zoom: next, panX: view.panX * k, panY: view.panY * k });
}

/**
 * The tool strip in order: tool, its Photoshop key (KeyboardEvent.code, so ⇧ and keyboard
 * layouts don't change it), name and what it does. App binds the keys, Toolbar shows them.
 */
export const TOOLS: readonly { tool: Tool; code: string; label: string; hint: string }[] = [
  { tool: 'move', code: 'KeyV', label: 'Move tool', hint: 'Select and drag layers; Auto-Select picks the layer or group under the cursor' },
  { tool: 'glyph', code: 'KeyA', label: 'Per-letter tool', hint: 'Click a glyph of any text layer to select it and move, scale, rotate or tilt it on its own' },
  { tool: 'text', code: 'KeyT', label: 'Type tool', hint: 'Click the canvas to add text (⇧T: 3D text); click a text layer to type in it' },
  { tool: 'shape', code: 'KeyU', label: 'Shape tool', hint: 'Drag on the canvas to draw the shape chosen in the options bar (2D or 3D)' },
  { tool: 'gradient', code: 'KeyG', label: 'Gradient tool', hint: "Drag across the layer to lay the target fill's gradient (angle and length)" },
  { tool: 'distort', code: 'KeyD', label: 'Distort tool', hint: 'Corner / mesh handles on the selected text or shape (⇧-drag a corner: symmetric パース)' },
  { tool: 'light', code: 'KeyL', label: 'Light tool', hint: "Global Light dial: drag to aim the bevels' light, ⇧-drag for altitude" },
  { tool: 'hand', code: 'KeyH', label: 'Hand tool', hint: 'Drag to pan the view (or hold Space with any tool)' },
  { tool: 'zoom', code: 'KeyZ', label: 'Zoom tool', hint: 'Click to zoom in, ⌥-click to zoom out, drag a rect to zoom to it' },
];

/** Opens a native file picker; resolves with the chosen file (or null). */
export function pickFile(accept: string): Promise<File | null> {
  // lib is ES2023 (no Promise.withResolvers typing), so use the executor form.
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Saves `blob` as a download named `fileName`. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** CSS colour of an sRGB 0..1 colour with straight alpha. */
function cssRgba(r: number, g: number, b: number, a: number): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return a >= 1 ? `rgb(${c(r)} ${c(g)} ${c(b)})` : `rgb(${c(r)} ${c(g)} ${c(b)} / ${Math.max(0, a).toFixed(3)})`;
}

/** Photoshop-style transparency checkerboard, as the bottom background layer. */
const CHECKER_CSS = 'repeating-conic-gradient(#9a9a9a 0 25%, #d0d0d0 0 50%) 0 0 / 8px 8px';

/**
 * CSS gradient for previews (`angle` in CSS degrees: 90 = left→right, 180 = top→bottom).
 * CSS has no diamond or shape-burst gradient: diamond is four corner-anchored linear
 * gradients (normalised to the box rather than square) and shape burst a reversed radial.
 * Stop opacity shows over a checkerboard. Midpoints become CSS colour hints (the same power
 * curve the renderer uses); 'vivid' gradients get OKLCH samples between stops. CSS blends
 * colour and opacity premultiplied, the renderer straight, so fades are approximate.
 */
export function gradientCss(g: Gradient, angle = 90, kind: Exclude<FillKind, 'solid' | 'image'> = 'linear') {
  const stops = [...g.stops].sort((a, b) => a.pos - b.pos);
  if (stops.length === 0) return '#fff';
  const stopCss = (s: Gradient['stops'][number]) => {
    const [r, gg, b] = hexToRgb(s.color);
    return cssRgba(r, gg, b, s.alpha ?? 1);
  };
  const checker = gradientHasAlpha(g) ? `, ${CHECKER_CSS}` : '';
  if (stops.length === 1) return `linear-gradient(${stopCss(stops[0])}, ${stopCss(stops[0])})${checker}`;
  // Ordered entries: colour stops, plus colour hints (color = null) or vivid samples between them.
  const items: { pos: number; color: string | null }[] = [];
  stops.forEach((s, i) => {
    items.push({ pos: s.pos, color: stopCss(s) });
    const next = stops[i + 1];
    if (!next || next.pos - s.pos < 1e-4) return;
    if (g.interp === 'vivid' && s.color !== next.color) {
      for (let k = 1; k < 8; k++) {
        const pos = s.pos + ((next.pos - s.pos) * k) / 8;
        items.push({ pos, color: cssRgba(...sampleGradientRgba(g, pos)) });
      }
    } else if (s.mid !== undefined && Math.abs(s.mid - 0.5) > 1e-3) {
      items.push({ pos: s.pos + (next.pos - s.pos) * Math.min(0.95, Math.max(0.05, s.mid)), color: null });
    }
  });
  const list = (map: (pos: number) => number, from = items) =>
    from.map((it) => (it.color === null ? '' : `${it.color} `) + `${(map(it.pos) * 100).toFixed(1)}%`).join(', ');
  const plain = list((p) => p);
  const reversed = [...items].reverse();
  let css: string;
  switch (kind) {
    case 'radial':
      css = `radial-gradient(circle, ${plain})`;
      break;
    case 'angle':
      css = `conic-gradient(from ${angle}deg, ${plain})`;
      break;
    case 'reflected':
      css = `linear-gradient(${angle}deg, ${list((p) => 0.5 - p / 2, reversed)}, ${list((p) => 0.5 + p / 2)})`;
      break;
    case 'diamond':
      css = (['top left', 'top right', 'bottom left', 'bottom right'] as const)
        .map((corner) => `linear-gradient(to ${corner}, ${plain}) ${corner} / 50% 50% no-repeat`)
        .join(', ');
      break;
    case 'shapeBurst':
      css = `radial-gradient(closest-side, ${list((p) => 1 - p, reversed)})`;
      break;
    default:
      css = `linear-gradient(${angle}deg, ${plain})`;
  }
  return css + checker;
}

/** Move array item i to index j (returns a new array). */
export function moveItem<T>(a: readonly T[], i: number, j: number): T[] {
  const c = a.slice();
  const [x] = c.splice(i, 1);
  c.splice(Math.max(0, Math.min(c.length, j)), 0, x);
  return c;
}

/** Shape kinds in menu order with the pachislot part each one is for. */
export const SHAPES: readonly { kind: ShapeKind; label: string; hint: string }[] = [
  { kind: 'rect', label: 'Plate', hint: 'Rounded plate / capsule (まくら)' },
  { kind: 'parallelogram', label: 'Band', hint: 'Slanted band / cut-in frame (帯)' },
  { kind: 'ellipse', label: 'Ellipse', hint: 'Circle / badge (a flat disc in 3D)' },
  { kind: 'orb', label: 'Orb', hint: '保留 orb: a circle in 2D, a true sphere in 3D' },
  { kind: 'polygon', label: 'Polygon', hint: 'Hexagon, octagon… plate' },
  { kind: 'star', label: 'Star', hint: 'Regular star' },
  { kind: 'burst', label: 'Burst', hint: 'ギザギザ starburst badge' },
  { kind: 'shield', label: 'Shield', hint: 'Emblem shield' },
  { kind: 'speech', label: 'Speech bubble', hint: 'Rounded セリフ枠 with a tail' },
  { kind: 'shout', label: 'Shout bubble', hint: 'Jagged セリフ枠 with a tail' },
  { kind: 'ribbon', label: 'Ribbon', hint: 'Banner with folded, notched ends' },
];

/**
 * The value at `refp` for a control: the targets' shared value, or (`mixed`) the first target's,
 * when their values differ.
 */
export function useRefValue(refp: Refs): { value: unknown; mixed: boolean } {
  const v = useEditor((s) => getRef(s.project, refp));
  const first = useEditor((s) => (isMultiRef(refp) ? getRef(s.project, refList(refp)[0]) : undefined));
  return v === MIXED ? { value: first, mixed: true } : { value: v, mixed: false };
}

/** For each of `refs`, whether its targets hold differing values (always false for one target): one subscription for an editor's value-bound controls. */
export function useMixed(...refs: Refs[]): boolean[] {
  const key = useEditor((s) => refs.map((r) => (isMultiRef(r) && getRef(s.project, r) === MIXED ? '1' : '0')).join(''));
  return refs.map((_, i) => key[i] === '1');
}
