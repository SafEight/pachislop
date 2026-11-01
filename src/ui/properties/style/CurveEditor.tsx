import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { curveFn, curvePoints, type CurvePreset } from '../../../engine/layer2d/contours';
import type { Curve, CurvePoint } from '../../../model/types';
import { NumberField } from '../../controls';
import { useT } from '../../i18n';
import { oneShot, useGesture } from '../../util';

// Photoshop-style curve / contour widget: click to add a point (and drag it), drag points,
// ⌫ / Delete or drag a point out of the box to remove it, ⌥/Alt-click (or the Corner box) to
// toggle a corner kink, arrow keys nudge the selected point (Shift ×10). Endpoints stay at
// x = 0 and x = 1. Reusable for any Curve (gloss / satin contours, bevel profiles…).

const DEFAULT_SIZE = 128; // graph px
const PAD = 6; // px around the graph so handles at the edges stay grabbable
const HIT = 6; // px
const REMOVE_PX = 18; // drag an interior point this far outside the box to delete it
const NUDGE = 1 / 255;

export interface CurveEditorProps {
  /** Coalesce base for undo (e.g. refKey of the curve). */
  id: string;
  value: Curve;
  onChange: (c: Curve, coalesce: string) => void;
  /** Accessible name, e.g. "Gloss contour" (translated by the caller). */
  label: string;
  /** Preset labels are English i18n keys, translated here. */
  presets?: readonly CurvePreset[];
  /** Axis captions under / beside the graph (translated by the caller; default Input / Output). */
  xLabel?: string;
  yLabel?: string;
  /** Optional input histogram drawn under the curve: 256 bins normalised to 0..1, index = input level (Curves adjustment). */
  histogram?: ArrayLike<number>;
  /** Graph side in px (default 128, indented under the row labels). Given: drawn at that size, flush left, like PS Curves. */
  size?: number;
  /** Several targets whose curves differ: the first one's is drawn dashed; an edit gives every target the edited curve. */
  mixed?: boolean;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round3 = (v: number) => Math.round(v * 1000) / 1000;

export function CurveEditor({ id, value, onChange, label, presets, xLabel: xl, yLabel: yl, histogram, size, mixed = false }: CurveEditorProps) {
  const S = size ?? DEFAULT_SIZE;
  const t = useT();
  const xLabel = xl ?? t('Input');
  const yLabel = yl ?? t('Output');
  const pts = curvePoints(value);
  const [sel, setSel] = useState<number | null>(null);
  const [removing, setRemoving] = useState(false);
  const g = useGesture(id);
  const svgRef = useRef<SVGSVGElement>(null);
  const selIdx = sel !== null && sel < pts.length ? sel : null;

  const emit = (next: CurvePoint[], coalesce = g.key()) =>
    onChange({ points: next.map((p) => ({ x: round3(p.x), y: round3(p.y), corner: p.corner })) }, coalesce);

  /** Pointer → unit-square coordinates (unclamped) and the raw px offset outside the box. */
  const toUnit = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    const k = (S + 2 * PAD) / r.width;
    const px = (e.clientX - r.left) * k - PAD;
    const py = (e.clientY - r.top) * k - PAD;
    const out = Math.max(-px, px - S, -py, py - S, 0) / k;
    return { x: px / S, y: 1 - py / S, out };
  };

  /** Move point i to (x, y), keeping it between its neighbours; endpoints keep their x. */
  const moved = (list: CurvePoint[], i: number, x: number, y: number): CurvePoint[] => {
    const next = list.slice();
    const last = list.length - 1;
    const lo = i === 0 ? 0 : list[i - 1].x + 0.004;
    const hi = i === last ? 1 : list[i + 1].x - 0.004;
    const nx = i === 0 ? 0 : i === last ? 1 : Math.min(hi, Math.max(lo, x));
    next[i] = { ...list[i], x: nx, y: clamp01(y) };
    return next;
  };

  const remove = (list: CurvePoint[], i: number) => {
    if (i <= 0 || i >= list.length - 1) return;
    emit(
      list.filter((_, k) => k !== i),
      oneShot(id),
    );
    setSel(null);
  };

  const toggleCorner = (list: CurvePoint[], i: number) => {
    emit(
      list.map((p, k) => (k === i ? { ...p, corner: !p.corner } : p)),
      oneShot(id),
    );
  };

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    svgRef.current!.focus();
    const u = toUnit(e);
    const r = svgRef.current!.getBoundingClientRect();
    const k = r.width / (S + 2 * PAD);
    // Nearest point within the hit radius (screen px).
    let hit = -1;
    let best = HIT;
    pts.forEach((p, i) => {
      const d = Math.hypot((p.x - u.x) * S * k, (p.y - u.y) * S * k);
      if (d <= best) {
        best = d;
        hit = i;
      }
    });
    if (hit >= 0 && e.altKey) {
      setSel(hit);
      toggleCorner(pts, hit);
      return;
    }
    let list = pts;
    let idx = hit;
    g.begin();
    if (idx < 0) {
      if (u.out > 0) return;
      const p = { x: clamp01(u.x), y: clamp01(u.y), corner: false };
      idx = pts.findIndex((q) => q.x > p.x);
      if (idx <= 0) return; // on an endpoint's x: nothing to insert between
      list = [...pts.slice(0, idx), p, ...pts.slice(idx)];
      emit(list);
    }
    setSel(idx);
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const interior = idx > 0 && idx < list.length - 1;
    let gone = false;
    const move = (ev: globalThis.PointerEvent) => {
      const m = toUnit(ev);
      gone = interior && m.out > REMOVE_PX;
      setRemoving(gone);
      if (!gone) emit(moved(list, idx, m.x, m.y));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setRemoving(false);
      if (gone) {
        emit(
          list.filter((_, q) => q !== idx),
          g.key(),
        );
        setSel(null);
      }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    const del = e.key === 'Backspace' || e.key === 'Delete';
    if (!del && !arrows[e.key]) return;
    // Never let ⌫ / arrows reach the app shortcuts (delete layer, nudge layer).
    e.preventDefault();
    e.stopPropagation();
    if (selIdx === null) return;
    if (del) {
      remove(pts, selIdx);
      return;
    }
    const step = NUDGE * (e.shiftKey ? 10 : 1);
    const [dx, dy] = arrows[e.key];
    const p = pts[selIdx];
    if (!e.repeat) g.begin(); // one undo step per held-key burst
    emit(moved(pts, selIdx, p.x + dx * step, p.y + dy * step));
  };

  const f = curveFn({ points: pts });
  const line = Array.from({ length: 129 }, (_, i) => {
    const x = i / 128;
    return `${(PAD + x * S).toFixed(2)},${(PAD + (1 - f(x)) * S).toFixed(2)}`;
  }).join(' ');
  const grid = [0.25, 0.5, 0.75].map((t) => PAD + t * S);
  const selPt = selIdx !== null ? pts[selIdx] : null;
  const interiorSel = selIdx !== null && selIdx > 0 && selIdx < pts.length - 1;

  return (
    <div className="curve-editor" style={{ display: 'flex', flexDirection: 'column', gap: 4, margin: size ? '4px 0 6px 0' : '4px 0 6px 86px' }}>
      <svg
        ref={svgRef}
        role="application"
        aria-label={t('{label} curve editor', { label })}
        tabIndex={0}
        width={S + 2 * PAD}
        height={S + 2 * PAD}
        viewBox={`0 0 ${S + 2 * PAD} ${S + 2 * PAD}`}
        style={{ background: 'var(--bg0)', border: '1px solid var(--line)', borderRadius: 3, cursor: 'crosshair', touchAction: 'none', outline: 'none' }}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      >
        <title>
          {mixed && `${t('The selected curves differ: an edit gives all of them this one')}\n`}
          {t('{label}: click to add a point, drag to move, ⌫ or drag out to delete, ⌥-click for a corner, arrows nudge', { label })}
        </title>
        <rect x={PAD} y={PAD} width={S} height={S} fill="none" stroke="var(--line)" />
        {grid.map((v) => (
          <g key={v} stroke="var(--line)" strokeDasharray="2 3">
            <line x1={v} y1={PAD} x2={v} y2={PAD + S} />
            <line x1={PAD} y1={v} x2={PAD + S} y2={v} />
          </g>
        ))}
        {histogram && histogram.length > 1 && (
          <path
            d={`M ${PAD},${PAD + S} ${Array.from(histogram, (h, i) => `L ${(PAD + (i / (histogram.length - 1)) * S).toFixed(2)},${(PAD + S - clamp01(h) * S).toFixed(2)}`).join(' ')} L ${PAD + S},${PAD + S} Z`}
            fill="var(--muted)"
            fillOpacity={0.35}
            stroke="none"
            pointerEvents="none"
          />
        )}
        <line x1={PAD} y1={PAD + S} x2={PAD + S} y2={PAD} stroke="var(--muted)" strokeOpacity={0.35} />
        <polyline points={line} fill="none" stroke={mixed ? 'var(--muted)' : 'var(--text)'} strokeWidth={1.5} strokeDasharray={mixed ? '4 3' : undefined} strokeLinejoin="round" />
        {pts.map((p, i) => {
          const cx = PAD + p.x * S;
          const cy = PAD + (1 - p.y) * S;
          const on = i === selIdx;
          const fill = on ? 'var(--accent)' : 'var(--bg0)';
          const stroke = on ? 'var(--accent)' : 'var(--text)';
          const opacity = on && removing ? 0.3 : 1;
          return p.corner ? (
            <polygon key={i} points={`${cx},${cy - 4.5} ${cx + 4.5},${cy} ${cx},${cy + 4.5} ${cx - 4.5},${cy}`} fill={fill} stroke={stroke} opacity={opacity} />
          ) : (
            <rect key={i} x={cx - 3.5} y={cy - 3.5} width={7} height={7} fill={fill} stroke={stroke} opacity={opacity} />
          );
        })}
      </svg>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {presets && presets.length > 0 && (
          <select
            aria-label={t('{label} preset', { label })}
            title={t('Replace the curve with a preset')}
            value=""
            onChange={(e) => {
              const p = presets[Number(e.target.value)];
              if (p) {
                onChange(structuredClone(p.curve), oneShot(id));
                setSel(null);
              }
            }}
          >
            <option value="" disabled>
              {t('Preset…')}
            </option>
            {presets.map((p, i) => (
              <option key={p.label} value={i}>
                {t(p.label)}
              </option>
            ))}
          </select>
        )}
        <label title={t('Corner point: a sharp kink instead of a smooth curve (⌥-click a point)')} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          <input
            type="checkbox"
            aria-label={t('Corner point')}
            disabled={!interiorSel}
            checked={!!selPt?.corner}
            onChange={() => selIdx !== null && toggleCorner(pts, selIdx)}
          />
          {t('Corner', undefined, { ctx: 'curve' })}
        </label>
        <button title={t('Delete the selected point (⌫)')} aria-label={t('Delete point')} disabled={!interiorSel} onClick={() => selIdx !== null && remove(pts, selIdx)}>
          {t('Delete')}
        </button>
      </div>
      {selPt && selIdx !== null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }} className="curve-editor-io">
          <span className="muted" title={t('{axis} of the selected point', { axis: xLabel })}>
            {xLabel}
          </span>
          <NumberField
            id={`${id}:x`}
            value={selPt.x}
            min={0}
            max={1}
            clamp
            display={100}
            unit="%"
            slider={false}
            onChange={(v, c) => emit(moved(pts, selIdx, v, selPt.y), c)}
          />
          <span className="muted" title={t('{axis} of the selected point', { axis: yLabel })}>
            {yLabel}
          </span>
          <NumberField
            id={`${id}:y`}
            value={selPt.y}
            min={0}
            max={1}
            clamp
            display={100}
            unit="%"
            slider={false}
            onChange={(v, c) => emit(moved(pts, selIdx, selPt.x, v), c)}
          />
        </div>
      )}
    </div>
  );
}
