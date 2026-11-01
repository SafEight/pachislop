import { useRef, useState } from 'react';
import { GRADIENTS } from '../model/defaults';
import { sampleGradientRgba } from '../model/gradient';
import type { Gradient, GradientStop } from '../model/types';
import { ColorInput, IconBtn, NumberField } from './controls';
import { useT } from './i18n';
import { gradientCss, gradientPresetLabel, oneShot, useGesture } from './util';

const toHex = (rgb: number[]) =>
  '#' + rgb.slice(0, 3).map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('');

const MID_MIN = 0.05;
const MID_MAX = 0.95;

/**
 * Gradient stops on a bar (Photoshop Gradient Editor): click the bar to add a stop, drag
 * markers to move, drag a marker down off the bar (or press Delete) to remove it; colour,
 * opacity and location per stop. A diamond between two stops is their midpoint: drag it to
 * bias the blend, double-click to reset. "Vivid" blends in OKLCH (blue → white stays blue).
 * Preset swatches from GRADIENTS (optionally filtered, e.g. only `*Ramp` for finishes).
 * `mixed`: several targets whose gradients differ; the bar is striped over the first one's
 * gradient, and any edit sets the edited gradient on every target.
 */
export function GradientEditor({
  value,
  onChange,
  id,
  presets = () => true,
  mixed = false,
}: {
  value: Gradient;
  onChange: (g: Gradient, coalesce: string) => void;
  id: string;
  presets?: (name: string) => boolean;
  mixed?: boolean;
}) {
  const t = useT();
  const bar = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState(0);
  const g = useGesture(id);
  const stops = value.stops;
  const selIdx = Math.min(sel, stops.length - 1);
  const selStop = stops[selIdx];
  // Midpoints sit between neighbours in position order; `mid` lives on the left stop.
  const order = stops.map((_, i) => i).sort((a, b) => stops[a].pos - stops[b].pos);

  const posAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };
  const setStops = (s: GradientStop[], c = g.key()) => onChange({ ...value, stops: s }, c);
  const patchStop = (i: number, patch: Partial<GradientStop>, c?: string) => setStops(stops.map((x, j) => (j === i ? { ...x, ...patch } : x)), c);

  const removeStop = (i: number) => {
    if (stops.length <= 1) return;
    setStops(stops.filter((_, j) => j !== i));
    setSel(Math.max(0, i - 1));
  };

  /** Pointer drag helper: captures the pointer on `el` and calls `move` until release. */
  const drag = (e: React.PointerEvent<HTMLElement>, move: (ev: PointerEvent) => void) => {
    e.preventDefault();
    e.stopPropagation();
    g.begin();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  return (
    <div
      className="gradient-editor"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== 'Delete' && e.key !== 'Backspace') return;
        if ((e.target as HTMLElement).tagName === 'INPUT') return;
        e.stopPropagation();
        removeStop(selIdx);
      }}
    >
      <div
        className="gbar checker"
        ref={bar}
        title={mixed ? t('The selected gradients differ: an edit gives all of them this one') : t('Click to add a stop')}
        onPointerDown={(e) => {
          g.begin();
          const pos = posAt(e.clientX);
          const c = sampleGradientRgba(value, pos);
          setStops([...stops, { pos, color: toHex(c), ...(c[3] < 1 ? { alpha: Math.round(c[3] * 1000) / 1000 } : {}) }]);
          setSel(stops.length);
        }}
      >
        <div className="gfill" style={{ background: gradientCss(value) }} />
        {mixed && <div className="gmixed mixed-stripes" />}
      </div>
      <div className="gstops">
        {stops.map((s, i) => (
          <div
            key={i}
            role="slider"
            aria-label={t('Stop {n} location', { n: i + 1 })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(s.pos * 100)}
            tabIndex={0}
            className={`gstop ${i === selIdx ? 'sel' : ''}`}
            style={{ left: `${s.pos * 100}%`, background: s.color }}
            title={t('Drag to move, drag down off the bar to delete')}
            onFocus={() => setSel(i)}
            onPointerDown={(e) => {
              setSel(i);
              const startY = e.clientY;
              let removed = false;
              drag(e, (ev) => {
                if (removed) return;
                if (ev.clientY - startY > 40 && stops.length > 1) {
                  removed = true;
                  removeStop(i);
                  return;
                }
                setStops(stops.map((x, j) => (j === i ? { ...x, pos: posAt(ev.clientX) } : x)));
              });
            }}
          />
        ))}
        {order.slice(0, -1).map((li, k) => {
          const a = stops[li];
          const b = stops[order[k + 1]];
          if (b.pos - a.pos < 0.02) return null;
          const mid = a.mid ?? 0.5;
          return (
            <div
              key={`m${li}`}
              role="slider"
              aria-label={t('Midpoint after stop {n}', { n: li + 1 })}
              aria-valuemin={MID_MIN * 100}
              aria-valuemax={MID_MAX * 100}
              aria-valuenow={Math.round(mid * 100)}
              className="gmid"
              style={{
                position: 'absolute',
                top: 3,
                left: `${(a.pos + (b.pos - a.pos) * mid) * 100}%`,
                width: 6,
                height: 6,
                marginLeft: -3,
                transform: 'rotate(45deg)',
                background: Math.abs(mid - 0.5) > 1e-3 ? 'var(--accent)' : '#ddd',
                border: '1px solid #000',
                cursor: 'ew-resize',
              }}
              title={t('Midpoint {pct}%: drag to bias the blend toward one stop; double-click to reset', { pct: Math.round(mid * 100) })}
              onDoubleClick={() => patchStop(li, { mid: undefined }, oneShot(id))}
              onPointerDown={(e) =>
                drag(e, (ev) => {
                  const f = (posAt(ev.clientX) - a.pos) / Math.max(b.pos - a.pos, 1e-6);
                  patchStop(li, { mid: Math.round(Math.min(MID_MAX, Math.max(MID_MIN, f)) * 1000) / 1000 });
                })
              }
            />
          );
        })}
      </div>
      <div className="gcontrols" style={{ flexWrap: 'wrap', rowGap: 4 }}>
        {selStop && (
          <>
            <ColorInput id={`${id}:stop`} label={t('Stop colour')} value={selStop.color} onChange={(c, k) => patchStop(selIdx, { color: c }, k)} />
            <span className="muted" title={t('Stop opacity (Photoshop opacity stop)')} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              {t('Opacity')}
              <NumberField
                id={`${id}:alpha`}
                label={t('Stop opacity')}
                value={selStop.alpha ?? 1}
                onChange={(v, k) => patchStop(selIdx, { alpha: v >= 1 ? undefined : v }, k)}
                min={0}
                max={1}
                clamp
                display={100}
                unit="%"
                slider={false}
              />
            </span>
            <span className="muted" title={t('Stop location')} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              {t('Location')}
              <NumberField
                id={`${id}:pos`}
                label={t('Stop location')}
                value={selStop.pos}
                onChange={(v, k) => patchStop(selIdx, { pos: v }, k)}
                min={0}
                max={1}
                clamp
                display={100}
                unit="%"
                slider={false}
              />
            </span>
            <button className="small" disabled={stops.length <= 1} onClick={() => removeStop(selIdx)} title={t('Delete stop')} aria-label={t('Delete stop')}>
              ✕
            </button>
            <button
              className="small"
              title={t('Reverse')}
              aria-label={t('Reverse gradient')}
              onClick={() =>
                // Reversing moves each midpoint to the other side of its gap.
                setStops(
                  stops.map((x, i) => {
                    const k = order.indexOf(i);
                    const prev = k > 0 ? stops[order[k - 1]] : undefined;
                    return { ...x, pos: 1 - x.pos, mid: prev?.mid !== undefined ? 1 - prev.mid : undefined };
                  }),
                  oneShot(id),
                )
              }
            >
              ⇄
            </button>
            <IconBtn
              title={t('Vivid: blend through OKLCH along the shorter hue arc, so blue → white stays blue instead of greying out in the middle')}
              active={value.interp === 'vivid'}
              onClick={() => onChange({ ...value, interp: value.interp === 'vivid' ? undefined : 'vivid' }, oneShot(id))}
            >
              {t('Vivid')}
            </IconBtn>
          </>
        )}
      </div>
      <div className="presets">
        {Object.entries(GRADIENTS)
          .filter(([name]) => presets(name))
          .map(([name, pg]) => (
            <button
              key={name}
              className="swatch"
              title={gradientPresetLabel(t, name)}
              aria-label={t('{name} preset', { name: gradientPresetLabel(t, name) })}
              style={{ background: gradientCss(pg) }}
              onClick={() => onChange(structuredClone(pg), oneShot(id))}
            />
          ))}
      </div>
    </div>
  );
}
