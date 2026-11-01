import { useContext, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { refKey } from '../store/paths';
import { useEditor, type Refs } from '../store/store';
import { engineHost } from './engineHost';
import { useT } from './i18n';
import { FindProbe, SectionScope, useSectionsOpen } from './sectionMemory';
import { oneShot, useGesture, useLatest, usePopover, useRefValue } from './util';
import './controls.css';

// Shared panel controls. Two flavours:
// - value/onChange controls (NumRow, ColorRow, SelectRow, CheckRow) for anything;
// - Ref* controls bound to a store PropRef (read with getRef, write with setAt).
// `onChange(v, coalesce)`: edits carrying the same coalesce key merge into one undo step;
// every pointer gesture / focus burst gets a fresh key (useGesture).
//
// Several targets (a PropRef list: the rim width of 3 layers) edit together. When their values
// differ (MIXED) a control shows “—”: an empty number or hex field, an indeterminate checkbox, a
// striped swatch, a blank choice. Setting a value (typing, a pick, the slider track, a reset)
// gives every target that value, as in Photoshop; a number's relative gestures (scrubbing the
// label or field, ↑/↓, the wheel, −/+) instead shift every target by the same offset from where
// it was when the gesture began, so 3 rims of different widths all grow by 2.

const fmt = (v: number, step: number) => {
  const decimals = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step) - 1e-9));
  return Number(v.toFixed(decimals)).toString();
};

const autoStep = (min: number, max: number, integer?: boolean) =>
  integer ? 1 : Math.abs(max - min) <= 2 ? 0.01 : Math.abs(max - min) <= 20 ? 0.1 : 1;

const UNIT_LABEL: Record<string, string> = { px: 'px', deg: '°', '%': '%', x: '×' };

/** Modifier multiplier shared by scrubbing, wheel and arrow keys: Shift = coarse ×10, ⌥/Alt = fine ×0.1. */
const modK = (e: { shiftKey: boolean; altKey: boolean }) => (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);

/** Snap `v` to multiples of `q` without float noise (0.1 + 0.2 → 0.3). */
const quantize = (v: number, q: number) => Number((Math.round(v / q) * q).toFixed(Math.max(0, Math.min(8, Math.ceil(-Math.log10(q) + 1e-9)))));

/** Screen px a press must travel before it becomes a scrub (shorter = a click). */
const SCRUB_SLOP = 3;
/** Wheel delta (px) per step: one mouse-wheel notch ≈ 100, trackpads send many small deltas. */
const WHEEL_PX = 100;
/** Two presses within this many ms are a double-click. */
const DOUBLE_CLICK_MS = 400;
/** Integer params with at most this many values get −/+ steppers instead of a track. */
const STEPPER_MAX_SPAN = 24;

/**
 * Slider-track mapping. 'log' spreads a wide positive range evenly by ratio (size 8..800),
 * 'pow' is quadratic from `min` (fine control near the low end of 0..1000 blurs).
 */
export type TrackMapping = 'linear' | 'log' | 'pow';

/** Track resolution for non-linear mappings. */
const TRACK_STEPS = 1000;

function trackOf(min: number, max: number, track: TrackMapping | undefined): TrackMapping {
  if (track === 'log' && !(min > 0)) return 'pow'; // log needs a positive range
  if (track) return track;
  return min > 0 && max / min >= 50 ? 'log' : 'linear';
}

/** Value → track position 0..1. */
function toTrack(v: number, min: number, max: number, t: TrackMapping) {
  const x = Math.max(min, Math.min(max, v));
  if (t === 'log') return Math.log(x / min) / Math.log(max / min);
  const u = (x - min) / (max - min || 1);
  return t === 'pow' ? Math.sqrt(u) : u;
}

/** Track position 0..1 → value. */
function fromTrack(u: number, min: number, max: number, t: TrackMapping) {
  if (t === 'log') return min * Math.pow(max / min, u);
  return min + (max - min) * (t === 'pow' ? u * u : u);
}

/**
 * Pointer-drag scrubbing (After Effects / Photoshop scrubby values): returns a pointerdown
 * handler. Horizontal travel × `step` × modifier changes the value from where the press began;
 * a press that never travels `SCRUB_SLOP` px calls `onClick` instead. With `relative` (fixed at
 * the press) the scrub starts from 0 and `apply` gets the offset travelled.
 */
function useScrub(value: number, step: number, apply: (v: number, coalesce: string, relative: boolean) => void, id: string, onClick?: () => void, relative = false) {
  const g = useGesture(id);
  const live = useLatest({ value, step, apply, onClick, relative });
  return (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const startX = e.clientX;
    const rel = live.current.relative;
    const start = rel ? 0 : live.current.value;
    let scrubbing = false;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!scrubbing) {
        if (Math.abs(dx) < SCRUB_SLOP) return;
        scrubbing = true;
        g.begin();
        document.body.classList.add('scrubbing');
        engineHost.setInteractive(true);
      }
      const k = modK(ev);
      const q = live.current.step * Math.min(1, k);
      live.current.apply(quantize(start + Math.round(dx) * live.current.step * k, q), g.key(), rel);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.classList.remove('scrubbing');
      if (scrubbing) engineHost.setInteractive(false);
      if (!scrubbing) live.current.onClick?.();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
}

/**
 * Engine interactive mode for a native range-track drag: on at the press, off at the release
 * (anywhere: the browser keeps the track's pointer until then).
 */
function sliderInteractive(e: React.PointerEvent) {
  if (e.button !== 0) return;
  engineHost.setInteractive(true);
  const up = () => {
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', up, true);
    engineHost.setInteractive(false);
  };
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
}

// ---------- number ----------

export interface NumProps {
  value: number;
  onChange: (v: number, coalesce: string) => void;
  /** Slider range (typed values may exceed it unless `clamp`). Values are in stored units. */
  min: number;
  max: number;
  step?: number;
  /** Shown after the input: '%', 'px', '°', '×'. */
  unit?: string;
  /** Hard clamp to [min, max]. */
  clamp?: boolean;
  integer?: boolean;
  /** Display multiplier (100 shows a 0..1 value as 0..100). */
  display?: number;
  /** Show the slider track (default on; small integer ranges show −/+ steppers instead). */
  slider?: boolean;
  /** Value restored by double-clicking the label (stored units). Omit when there is no sensible default. */
  defaultValue?: number;
  /** Slider-track mapping; default 'linear', or 'log' for positive ranges spanning ≥ 50×. */
  track?: TrackMapping;
  /** Accessible name of the value field (rows pass their label). */
  label?: string;
  id: string;
  /** The targets hold different values: the field shows “—” (`value` only places the track). */
  mixed?: boolean;
  /**
   * While `mixed`: relative gestures (scrub, ↑/↓, wheel, −/+) report the offset (stored units)
   * from the values at the gesture's start, accumulated per coalesce key, instead of a value.
   */
  onOffset?: (delta: number, coalesce: string) => void;
}

const normFor = ({ integer, clamp, min, max }: Pick<NumProps, 'integer' | 'clamp' | 'min' | 'max'>) => (v: number) => {
  let x = integer ? Math.round(v) : v;
  if (clamp) x = Math.max(min, Math.min(max, x));
  return x;
};

/**
 * Value field: drag it to scrub, click to type, ↑/↓ to step, wheel to step while focused
 * (or with ⌥/Alt held, so scrolling a panel never changes values by accident).
 * Shift = ×10, ⌥/Alt = ×0.1 everywhere. Small integer ranges get −/+ steppers; the slider
 * track remains as a secondary control, optionally log / pow mapped for wide ranges.
 */
export function NumberField({ value, onChange, min, max, step, unit, clamp, integer, display = 1, slider = true, track, label, id, mixed = false, onOffset }: NumProps) {
  const t = useT();
  const st = step ?? autoStep(min, max, integer);
  const g = useGesture(id);
  const [text, setText] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** Offset accumulated by the relative steps of one gesture on a mixed value. */
  const offset = useRef({ key: '', d: 0 });
  const relative = mixed && !!onOffset;
  const norm = normFor({ integer, clamp, min, max });
  const shown = value * display;
  const dst = st * display;
  const stepper = !!integer && max - min <= STEPPER_MAX_SPAN;
  const mapping = trackOf(min, max, track);
  const commitText = (s: string) => {
    const v = Number(s);
    if (s.trim() !== '' && Number.isFinite(v)) onChange(norm(v / display), g.key());
  };
  /** Step by `n` × step from the current value (keyboard / wheel / steppers); mixed: shift every target. */
  const stepBy = (n: number, k: number, coalesce: string) => {
    if (relative) {
      const d = quantize((offset.current.key === coalesce ? offset.current.d : 0) + n * st * k, st * Math.min(1, k));
      offset.current = { key: coalesce, d };
      onOffset?.(d, coalesce);
      if (text !== null) setText(null);
      return;
    }
    const v = norm(quantize(value + n * st * k, st * Math.min(1, k)));
    onChange(v, coalesce);
    if (text !== null) setText(fmt(v * display, dst));
  };
  const scrub = useScrub(
    value,
    st,
    (v, c, rel) => (rel ? onOffset?.(v, c) : onChange(norm(v), c)),
    `${id}:scrub`,
    () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    },
    relative,
  );

  // Wheel stepping needs a non-passive listener to keep the panel from scrolling.
  const beginWheelBurst = useEffectEvent(() => {
    g.begin();
    return g.key();
  });
  const wheelStep = useEffectEvent((n: number, k: number, coalesce: string) => stepBy(n, k, coalesce));
  useEffect(() => {
    const el = wrapRef.current!;
    let acc = 0;
    let last = 0;
    let key = '';
    const onWheel = (e: WheelEvent) => {
      const focused = document.activeElement === inputRef.current;
      if (!focused && !e.altKey) return;
      e.preventDefault();
      const now = performance.now();
      if (now - last > 600) {
        key = beginWheelBurst();
        acc = 0;
      }
      last = now;
      // Shift+wheel arrives as horizontal scroll in most browsers.
      const raw = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1);
      acc -= raw;
      const n = Math.trunc(acc / WHEEL_PX);
      if (n === 0) return;
      acc -= n * WHEEL_PX;
      wheelStep(n, modK(e), key);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const name = label ?? id;
  return (
    <div className={`numfield ${stepper ? 'has-stepper' : ''}${mixed ? ' mixed' : ''}`} ref={wrapRef}>
      {slider && !stepper && (
        <input
          type="range"
          aria-label={t('{name} slider', { name })}
          title={
            mapping === 'linear'
              ? undefined
              : mapping === 'log'
                ? t('Logarithmic track: finer near {v}', { v: fmt(min * display, dst) })
                : t('Quadratic track: finer near {v}', { v: fmt(min * display, dst) })
          }
          min={mapping === 'linear' ? min : 0}
          max={mapping === 'linear' ? max : TRACK_STEPS}
          step={mapping === 'linear' ? st : 1}
          value={mapping === 'linear' ? Math.max(min, Math.min(max, value)) : Math.round(toTrack(value, min, max, mapping) * TRACK_STEPS)}
          onPointerDown={(e) => {
            g.begin();
            sliderInteractive(e);
          }}
          onKeyDown={g.begin}
          onChange={(e) => {
            const raw = Number(e.target.value);
            const v = mapping === 'linear' ? raw : quantize(fromTrack(raw / TRACK_STEPS, min, max, mapping), st);
            onChange(norm(v), g.key());
          }}
        />
      )}
      {stepper && (
        <button
          type="button"
          className="stepper"
          aria-label={t('Decrease {name}', { name })}
          title={t('Decrease (Shift ×10)')}
          disabled={clamp && !relative && value <= min}
          onClick={(e) => stepBy(-1, e.shiftKey ? 10 : 1, oneShot(id))}
        >
          −
        </button>
      )}
      <input
        ref={inputRef}
        className="num"
        type="text"
        inputMode="decimal"
        aria-label={name}
        title={t('Drag to scrub · click to type · ↑/↓ step · wheel steps while focused (or with ⌥) · Shift ×10, ⌥ ×0.1')}
        placeholder={mixed ? '—' : undefined}
        value={text ?? (mixed ? '' : fmt(shown, dst))}
        onPointerDown={(e) => {
          // Focused: a normal text field (caret, selection). Otherwise the press scrubs or, without travel, focuses.
          if (document.activeElement !== e.currentTarget) scrub(e);
        }}
        onFocus={(e) => {
          g.begin();
          setText(mixed ? '' : fmt(shown, dst));
          e.target.select();
        }}
        onChange={(e) => {
          setText(e.target.value);
          commitText(e.target.value);
        }}
        onBlur={() => setText(null)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur();
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            stepBy(e.key === 'ArrowUp' ? 1 : -1, modK(e), g.key());
          }
        }}
      />
      {stepper && (
        <button
          type="button"
          className="stepper"
          aria-label={t('Increase {name}', { name })}
          title={t('Increase (Shift ×10)')}
          disabled={clamp && !relative && value >= max}
          onClick={(e) => stepBy(1, e.shiftKey ? 10 : 1, oneShot(id))}
        >
          +
        </button>
      )}
      {/* An empty unit cell keeps unitless fields in the same column as the rest of a section. */}
      {slider && <span className="unit" aria-hidden={!unit}>{unit ? (UNIT_LABEL[unit] ?? unit) : null}</span>}
      {!slider && unit && <span className="unit">{UNIT_LABEL[unit] ?? unit}</span>}
    </div>
  );
}

/**
 * Label that scrubs a value when dragged horizontally (Shift ×10, ⌥/Alt ×0.1); double-click
 * resets to `defaultValue` when given. Mixed with `onOffset`: the scrub shifts every target.
 */
function ScrubLabel({
  label,
  value,
  step,
  onChange,
  id,
  title,
  defaultValue,
  display = 1,
  norm = (v) => v,
  mixed = false,
  onOffset,
}: {
  label: ReactNode;
  value: number;
  step: number;
  onChange: (v: number, c: string) => void;
  id: string;
  title?: string;
  defaultValue?: number;
  display?: number;
  norm?: (v: number) => number;
  mixed?: boolean;
  onOffset?: (delta: number, c: string) => void;
}) {
  const t = useT();
  const scrub = useScrub(value, step, (v, c, rel) => (rel ? onOffset?.(v, c) : onChange(norm(v), c)), `${id}:label`, undefined, mixed && !!onOffset);
  // Pointerdown is default-prevented (no text selection while scrubbing), which also stops the
  // browser from counting clicks: detect the double-click here.
  const lastDown = useRef(0);
  const how =
    defaultValue !== undefined
      ? t('Drag to scrub (Shift ×10, ⌥ ×0.1) · double-click: reset to {v}', { v: fmt(defaultValue * display, step * display) })
      : t('Drag to scrub (Shift ×10, ⌥ ×0.1)');
  return (
    <span
      className={`label scrub ${defaultValue !== undefined && (mixed || value !== defaultValue) ? 'changed' : ''}`}
      title={`${typeof label === 'string' ? `${label}\n` : ''}${title ? `${title}\n` : ''}${how}`}
      onPointerDown={(e) => {
        const now = performance.now();
        const double = now - lastDown.current < DOUBLE_CLICK_MS;
        lastDown.current = double ? 0 : now;
        if (double && defaultValue !== undefined && e.button === 0) {
          e.preventDefault();
          onChange(defaultValue, oneShot(`${id}:reset`));
          return;
        }
        scrub(e);
      }}
    >
      {label}
    </span>
  );
}

/**
 * Labelled control row. `fid`: the field's stable id for Properties search (`data-fid`; a store
 * control passes its ref key); without it a string label is the id.
 */
export function Row({ label, children, className, title, fid }: { label: ReactNode; children: ReactNode; className?: string; title?: string; fid?: string }) {
  return (
    <div className={`row ${className ?? ''}`} title={title} data-fid={fid ?? (typeof label === 'string' && label ? label : undefined)}>
      {typeof label === 'string' ? (
        <span className="label" title={label || undefined}>
          {label}
        </span>
      ) : (
        label
      )}
      <div className="ctl">{children}</div>
    </div>
  );
}

/** Labelled number row: scrub label (double-click resets) + value field (+ track or steppers) + unit. */
export function NumRow(props: NumProps & { label: string; title?: string }) {
  const st = props.step ?? autoStep(props.min, props.max, props.integer);
  return (
    <Row
      fid={props.id}
      title={props.title}
      label={
        <ScrubLabel
          label={props.label}
          value={props.value}
          step={st}
          onChange={props.onChange}
          id={props.id}
          title={props.title}
          defaultValue={props.defaultValue}
          display={props.display}
          norm={normFor(props)}
          mixed={props.mixed}
          onOffset={props.onOffset}
        />
      }
    >
      <NumberField {...props} />
    </Row>
  );
}

type RefNumProps = Omit<NumProps, 'value' | 'onChange' | 'id' | 'mixed' | 'onOffset'> & {
  label: string;
  refp: Refs;
  /** Used when the stored value is missing (e.g. an effect param added after the effect). */
  fallback?: number;
  title?: string;
};

/** Number row bound to the store; over several targets, mixed values show “—” and relative gestures shift each target (see the top of this file). */
export function RefNum({ refp, fallback = 0, ...rest }: RefNumProps) {
  const { value: v, mixed } = useRefValue(refp);
  const setAt = useEditor((s) => s.setAt);
  const setEachAt = useEditor((s) => s.setEachAt);
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);
  const norm = normFor(rest);
  return (
    <NumRow
      {...rest}
      id={refKey(refp)}
      value={num(v)}
      onChange={(x, c) => setAt(refp, x, c)}
      mixed={mixed}
      onOffset={(d, c) => setEachAt(refp, (start) => norm(num(start) + d), c)}
    />
  );
}

// ---------- colour ----------

/** One-click colours every pachislot title uses (白 / 黒 outlines, 金, the colourway hues). */
const COLOR_CHIPS: readonly { label: string; name: string; color: string }[] = [
  { label: '白', name: 'White', color: '#ffffff' },
  { label: '黒', name: 'Black', color: '#000000' },
  { label: '金', name: 'Gold', color: '#ffc800' },
  { label: '赤', name: 'Red', color: '#e00000' },
  { label: '青', name: 'Blue', color: '#0060ff' },
  { label: '緑', name: 'Green', color: '#00b040' },
  { label: '黄', name: 'Yellow', color: '#ffe000' },
];

/**
 * '#ff0000', 'ff0000', '#f00' or 'f00' (any case, surrounding space ignored) → '#ff0000';
 * anything else → null.
 */
function parseHex(s: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return `#${h.toLowerCase()}`;
}

// Recently applied colours, shared by every colour field and kept across sessions.
const RECENT_KEY = 'pslot.recentColors';
const RECENT_MAX = 12;
const recentListeners = new Set<() => void>();
let recent: string[] = (() => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string' && parseHex(c) !== null).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
})();

/** Put `color` first in the recent list (deduplicated, last 12). */
function rememberColor(color: string) {
  const c = parseHex(color);
  if (!c || recent[0] === c) return;
  recent = [c, ...recent.filter((x) => x !== c)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    // Storage full / disabled: the list still works for this session.
  }
  recentListeners.forEach((l) => l());
}

const subscribeRecent = (l: () => void) => {
  recentListeners.add(l);
  return () => {
    recentListeners.delete(l);
  };
};

/** The browser's screen colour picker (Chromium); absent elsewhere. */
interface EyeDropperApi {
  open(): Promise<{ sRGBHex: string }>;
}
// The DOM lib has no EyeDropper type yet; the `in` check proves the constructor exists.
const EyeDropperCtor = 'EyeDropper' in window ? (window.EyeDropper as new () => EyeDropperApi) : undefined;

/**
 * Colour field: swatch (the native picker opens from it), an editable hex (paste '#ff0000',
 * 'ff0000' or 'f00'; Enter / blur commits, Esc reverts), the screen eyedropper where the
 * browser has one, and a ▾ popover of fixed chips + the last 12 colours (one click applies).
 * `mixed`: the targets' colours differ (striped swatch, “—” hex); any pick sets them all.
 */
export function ColorInput({
  value,
  onChange,
  id,
  title,
  label,
  mixed = false,
}: {
  value: string;
  onChange: (v: string, c: string) => void;
  id: string;
  title?: string;
  label?: string;
  mixed?: boolean;
}) {
  const t = useT();
  const g = useGesture(id);
  const anchor = useRef<HTMLSpanElement>(null);
  const pop = usePopover(anchor, 'left');
  const pickerRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState<string | null>(null);
  const reverting = useRef(false);
  const recents = useSyncExternalStore(subscribeRecent, () => recent);
  const hex = mixed ? null : parseHex(value);
  const name = label ?? title ?? t('Colour');
  /** Apply a finished colour choice: one undo step, remembered as recent. */
  const apply = (c: string) => {
    const v = parseHex(c);
    if (!v) return;
    if (v !== hex) onChange(v, oneShot(id));
    rememberColor(v);
  };
  // The native picker sends `input` while dragging (live, one gesture) and `change` when it closes.
  useEffect(() => {
    const el = pickerRef.current!;
    const done = () => rememberColor(el.value);
    el.addEventListener('change', done);
    return () => el.removeEventListener('change', done);
  }, []);
  const commitText = () => {
    if (text !== null && !reverting.current) apply(text);
    reverting.current = false;
    setText(null);
  };
  const chip = (c: string, key: string, tip: string, glyph?: string) => (
    <button
      key={key}
      type="button"
      className={`color-chip ${hex === c ? 'active' : ''}`}
      style={{ background: c, color: luminance(c) > 0.55 ? '#000' : '#fff' }}
      title={`${tip} ${c}`}
      aria-label={`${tip} ${c}`}
      onClick={() => apply(c)}
    >
      {glyph}
    </button>
  );
  return (
    <span className={`colorfield${mixed ? ' mixed' : ''}`} ref={anchor}>
      <input
        ref={pickerRef}
        type="color"
        className="color"
        aria-label={t('{name}: open the colour picker', { name })}
        title={title ?? t('Open the colour picker')}
        value={hex ?? parseHex(value) ?? '#ffffff'}
        onFocus={g.begin}
        onPointerDown={g.begin}
        onChange={(e) => onChange(e.target.value, g.key())}
      />
      <input
        type="text"
        className="hex-input"
        aria-label={t('{name} hex', { name })}
        title={t('Hex colour: type or paste #ff0000, ff0000 or f00 · Enter applies · Esc reverts')}
        spellCheck={false}
        maxLength={9}
        placeholder={mixed ? '—' : undefined}
        value={text ?? (mixed ? '' : (hex ?? value))}
        onFocus={(e) => {
          setText(mixed ? '' : (hex ?? value));
          e.target.select();
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitText}
        onPaste={(e) => {
          // A pasted hex applies at once (the common Photoshop → app hand-off).
          const v = parseHex(e.clipboardData.getData('text'));
          if (!v) return;
          e.preventDefault();
          apply(v);
          setText(v);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            reverting.current = true;
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {EyeDropperCtor && (
        <button
          type="button"
          className="color-tool"
          aria-label={t('{name}: pick from the screen', { name })}
          title={t('Eyedropper: pick a colour anywhere on the screen')}
          onClick={() => {
            new EyeDropperCtor()
              .open()
              .then((r) => apply(r.sRGBHex))
              .catch(() => {}); // Esc cancels the pick
          }}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M11.5 1.5a2.1 2.1 0 0 1 3 3L12.8 6.2l.9.9-1.4 1.4-.9-.9-5.6 5.6H3.4l-.8.8-1.4-1.4.8-.8v-2.4l5.6-5.6-.9-.9L8.1 1.5l.9.9z" fill="currentColor" />
          </svg>
        </button>
      )}
      <button
        type="button"
        className={`color-tool ${pop.open ? 'on' : ''}`}
        aria-label={t('{name}: swatches and recent colours', { name })}
        aria-expanded={pop.open}
        title={t('Swatches and recent colours (one click applies)')}
        onClick={() => pop.setOpen(!pop.open)}
      >
        ▾
      </button>
      {pop.open && (
        <div className="menu-pop color-pop" style={pop.style} role="dialog" aria-label={t('{name} swatches', { name })}>
          <div className="color-pop-title">{t('Swatches')}</div>
          <div className="color-chips">{COLOR_CHIPS.map((c) => chip(c.color, c.color, `${c.label} ${t(c.name)}`, c.label))}</div>
          <div className="color-pop-title">{t('Recent')}</div>
          {recents.length > 0 ? (
            <div className="color-chips">{recents.map((c) => chip(c, c, t('Recent')))}</div>
          ) : (
            <div className="menu-empty">{t('Colours you apply show up here.')}</div>
          )}
        </div>
      )}
    </span>
  );
}

/** Relative luminance 0..1 of a '#rrggbb' (chip label contrast). */
function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

export function ColorRow({
  label,
  value,
  onChange,
  id,
  children,
  mixed,
}: {
  label: string;
  value: string;
  onChange: (v: string, c: string) => void;
  id: string;
  children?: ReactNode;
  mixed?: boolean;
}) {
  return (
    <Row label={label} fid={id}>
      <ColorInput id={id} value={value} onChange={onChange} label={label} mixed={mixed} />
      {children}
    </Row>
  );
}

export function RefColor({ label, refp, fallback = '#ffffff' }: { label: string; refp: Refs; fallback?: string }) {
  const { value: v, mixed } = useRefValue(refp);
  const setAt = useEditor((s) => s.setAt);
  return <ColorRow label={label} id={refKey(refp)} value={typeof v === 'string' ? v : fallback} mixed={mixed} onChange={(x, c) => setAt(refp, x, c)} />;
}

// ---------- choices ----------

export interface Option<T extends string> {
  value: T;
  label: string;
  title?: string;
}

/** `mixed`: the targets' choices differ; the select shows “—” until one is picked for all. */
export function SelectRow<T extends string>({ label, value, options, onChange, mixed, id }: { label: string; value: T; options: readonly Option<T>[]; onChange: (v: T) => void; mixed?: boolean; id?: string }) {
  return (
    <Row label={label} fid={id}>
      <select value={mixed ? '' : value} onChange={(e) => onChange(e.target.value as T)}>
        {mixed && (
          <option value="" disabled hidden>
            —
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value} title={o.title}>
            {o.label}
          </option>
        ))}
      </select>
    </Row>
  );
}

export function RefSelect<T extends string>({ label, refp, options, fallback }: { label: string; refp: Refs; options: readonly Option<T>[]; fallback?: T }) {
  const { value: v, mixed } = useRefValue(refp);
  const setAt = useEditor((s) => s.setAt);
  return <SelectRow label={label} id={refKey(refp)} value={(typeof v === 'string' ? v : (fallback ?? options[0]?.value)) as T} mixed={mixed} options={options} onChange={(x) => setAt(refp, x)} />;
}

/** Segmented buttons; `mixed` (the targets differ): none is active, a click sets them all. */
export function Seg<T extends string>({ value, options, onChange, mixed }: { value: T; options: readonly (Option<T> & { icon?: ReactNode })[]; onChange: (v: T) => void; mixed?: boolean }) {
  return (
    <span className="seg">
      {options.map((o) => (
        <button key={o.value} className={!mixed && value === o.value ? 'active' : ''} title={o.title ?? o.label} onClick={() => onChange(o.value)}>
          {o.icon ?? o.label}
        </button>
      ))}
    </span>
  );
}

/** `mixed`: the targets differ; the box shows indeterminate and a click turns them all on. */
export function CheckRow({ label, value, onChange, title, mixed = false, id }: { label: string; value: boolean; onChange: (v: boolean) => void; title?: string; mixed?: boolean; id?: string }) {
  return (
    <Row label={label} title={title} fid={id}>
      <MixedCheckbox aria-label={label} title={title} checked={value} mixed={mixed} onChange={onChange} />
    </Row>
  );
}

/** A checkbox showing the indeterminate state while `mixed`; checking it sets every target. */
export function MixedCheckbox({ checked, mixed, onChange, ...rest }: { checked: boolean; mixed: boolean; onChange: (v: boolean) => void; title?: string; 'aria-label'?: string; onClick?: (e: React.MouseEvent) => void }) {
  return (
    <input
      type="checkbox"
      {...rest}
      ref={(el) => {
        if (el) el.indeterminate = mixed;
      }}
      checked={mixed ? false : checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

export function RefCheck({ label, refp, title }: { label: string; refp: Refs; title?: string }) {
  const { value: v, mixed } = useRefValue(refp);
  const setAt = useEditor((s) => s.setAt);
  return <CheckRow label={label} id={refKey(refp)} title={title} value={v === true} mixed={mixed} onChange={(x) => setAt(refp, x)} />;
}

// ---------- structure ----------

export interface SectionProps {
  /** Stable id, unique within its page: the open state is remembered under it (and the SectionScope). */
  id: string;
  title: ReactNode;
  children: ReactNode;
  /** Open state until the user toggles it (then remembered). */
  defaultOpen?: boolean;
  actions?: ReactNode;
  enabled?: boolean;
  /** With `onToggle`: the targets differ in being on; the box shows indeterminate and a click turns them all on. */
  enabledMixed?: boolean;
  onToggle?: (v: boolean) => void;
  className?: string;
}

/**
 * Collapsible section whose open state is remembered per node kind (SectionScope) and `id`, in
 * localStorage. With `enabled`/`onToggle` the header carries an on/off checkbox (Photoshop
 * layer-style rows); a disabled section dims its body.
 */
export function Section({ id, title, children, defaultOpen = true, actions, enabled, enabledMixed = false, onToggle, className }: SectionProps) {
  const t = useT();
  const key = `${useContext(SectionScope)}/${id}`;
  const remembered = useSectionsOpen((s) => s[key]) ?? defaultOpen;
  // The hidden render that indexes Properties search sees every section open.
  const open = useContext(FindProbe) || remembered;
  return (
    <section className={`section ${open ? 'open' : ''} ${enabled === false ? 'off' : ''} ${className ?? ''}`} data-sk={key}>
      <header onClick={() => useSectionsOpen.setState({ [key]: !open })}>
        <span className="twisty">{open ? '▾' : '▸'}</span>
        {onToggle && <MixedCheckbox checked={!!enabled} mixed={enabledMixed} title={t('Enable')} onClick={(e) => e.stopPropagation()} onChange={onToggle} />}
        <span className="title">{title}</span>
        {actions && (
          <span className="actions" onClick={(e) => e.stopPropagation()}>
            {actions}
          </span>
        )}
      </header>
      {open && <div className="body">{children}</div>}
    </section>
  );
}

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: readonly Option<T>[]; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" className={`tab ${t.value === value ? 'active' : ''}`} title={t.title} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export interface MenuItem {
  label: ReactNode;
  onClick: () => void;
  group?: string;
  /** Second line (description). */
  hint?: string;
  disabled?: boolean;
  onHover?: (on: boolean) => void;
}

/** Dropdown menu button. Items with `group` render under group headings. */
export function Menu({
  label,
  items,
  className,
  title,
  align = 'right',
}: {
  label: ReactNode;
  items: MenuItem[];
  className?: string;
  title?: string;
  align?: 'left' | 'right';
}) {
  const t = useT();
  const anchor = useRef<HTMLDivElement>(null);
  const pop = usePopover(anchor, align);
  const groupHeads = items.map((it, i) => (it.group && it.group !== items[i - 1]?.group ? it.group : null));
  return (
    <div className={`menu ${className ?? ''}`} ref={anchor}>
      <button className="menu-btn" title={title} onClick={() => pop.setOpen(!pop.open)}>
        {label}
      </button>
      {pop.open && (
        <div className="menu-pop" style={pop.style}>
          {items.length === 0 && <div className="menu-empty">{t('Nothing available')}</div>}
          {items.map((it, i) => {
            const head = groupHeads[i];
            return (
              <div key={i}>
                {head && <div className="menu-group">{head}</div>}
                <button
                  className={`menu-item ${it.hint ? 'has-hint' : ''}`}
                  disabled={it.disabled}
                  onPointerEnter={() => it.onHover?.(true)}
                  onPointerLeave={() => it.onHover?.(false)}
                  onClick={() => {
                    it.onHover?.(false);
                    pop.setOpen(false);
                    it.onClick();
                  }}
                >
                  <span className="mi-label">{it.label}</span>
                  {it.hint && <span className="mi-hint">{it.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Small icon button used in stack rows. */
export function IconBtn({ children, title, onClick, disabled, danger, active }: { children: ReactNode; title: string; onClick: () => void; disabled?: boolean; danger?: boolean; active?: boolean }) {
  return (
    <button
      className={`icon-btn ${danger ? 'danger' : ''} ${active ? 'on' : ''}`}
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}
