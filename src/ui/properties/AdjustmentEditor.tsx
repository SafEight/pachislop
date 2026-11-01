import { useEffect, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { CurvePreset } from '../../engine/layer2d/contours';
import type { AdjustChannel, Adjustment, AdjustmentLayer, AdjustmentType, ColorBalanceRange, CurvePoint, LevelsChannel, Project } from '../../model/types';
import { getRefs, refList } from '../../store/paths';
import { useEditor, type Refs } from '../../store/store';
import { CheckRow, NumberField, RefCheck, RefColor, RefNum, Row, Seg, type NumProps } from '../controls';
import { engineHost } from '../engineHost';
import { GradientEditor } from '../GradientEditor';
import { useT } from '../i18n';
import { oneShot, useGesture, useMixed, useRefValue } from '../util';
import { CurveEditor } from './style/CurveEditor';
import { sub } from './style/shared';
import './adjust.css';

// Properties-panel editors for an adjustment (of an adjustment layer or an Adjust effect), laid
// out like Photoshop's Properties panel for each adjustment. Values are stored in Photoshop's
// units (see Adjustment in types.ts). Each editor writes the fields of the Adjustment at `refp`:
// one, or the same adjustment of several Adjust effects (a multi-selection). There every control
// shows where the targets differ, as everywhere else: “—” in number fields, an indeterminate
// box, a striped swatch, gradient or hue preview, a dimmed Levels triangle, a dashed curve.
// Typing, picking, dragging a triangle or editing a curve / gradient sets every target to the
// result; relative gestures on a “—” number field shift each target from its own value.

type Adj<T extends AdjustmentType> = Extract<Adjustment, { type: T }>;

/** Id / coalesce-key prefix unique to the adjustment stored at `refp`. */
const refKey = (refp: Refs) => refList(refp).map((r) => `${r.layerId}:${r.path.join('.')}`).join('|');

/**
 * Value field of one adjustment number at `refp` (see the top of this file for several targets).
 * `limit` bounds target `i`'s new value (default: the field's integer / clamp rules), e.g. a
 * Levels point that must stay clear of that target's other point.
 */
function AdjField({ refp, limit, ...rest }: Omit<NumProps, 'value' | 'onChange' | 'mixed' | 'onOffset' | 'id'> & { refp: Refs; limit?: (v: number, i: number) => number }) {
  const setEachAt = useEditor((s) => s.setEachAt);
  const { value, mixed } = useRefValue(refp);
  const num = (x: unknown) => (typeof x === 'number' ? x : 0);
  const { min, max, integer, clamp } = rest;
  const bound =
    limit ??
    ((v: number) => {
      const x = integer ? Math.round(v) : v;
      return clamp ? Math.max(min, Math.min(max, x)) : x;
    });
  return (
    <NumberField
      {...rest}
      id={refKey(refp)}
      value={num(value)}
      mixed={mixed}
      onChange={(v, c) => setEachAt(refp, (_, i) => bound(v, i), c)}
      onOffset={(d, c) => setEachAt(refp, (start, i) => bound(num(start) + d, i), c)}
    />
  );
}

/** Backdrop is re-read this long after the last change below the adjustment layer, ms. */
const HISTOGRAM_DEBOUNCE_MS = 300;
/** Backdrop render scale for the histogram (a quarter of the comp size is plenty for 256 bins). */
const HISTOGRAM_SCALE = 0.25;
/** Auto Levels clips this fraction of pixels at each end (Photoshop's default 0.1 %). */
const AUTO_CLIP = 0.001;
/** Curves graph side, px: nearly the Properties panel's width, like Photoshop's Curves. */
const CURVES_SIZE = 236;

const CHANNELS: readonly AdjustChannel[] = ['rgb', 'r', 'g', 'b'];
const CHANNEL_LABEL: Record<AdjustChannel, string> = { rgb: 'RGB', r: 'Red', g: 'Green', b: 'Blue' };
const CHANNEL_COLOR: Record<AdjustChannel, string> = { rgb: '#ffffff', r: '#ff4040', g: '#40d040', b: '#4080ff' };

// ---------- histogram of the backdrop ----------

interface Histogram {
  /** Alpha-weighted pixel counts per 8-bit level; 'rgb' is the sum of the three channels (Photoshop's composite histogram). */
  counts: Record<AdjustChannel, Float32Array>;
  /**
   * `counts` scaled for drawing: the 4th-tallest bin reaches 1 and the up to three taller spikes
   * are clipped, so a solid black outline or white highlight doesn't flatten the rest.
   */
  norm: Record<AdjustChannel, Float32Array>;
}

function histogramOf(img: ImageData): Histogram {
  const counts = { rgb: new Float32Array(256), r: new Float32Array(256), g: new Float32Array(256), b: new Float32Array(256) };
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    if (a === 0) continue;
    counts.r[d[i]] += a;
    counts.g[d[i + 1]] += a;
    counts.b[d[i + 2]] += a;
  }
  for (let i = 0; i < 256; i++) counts.rgb[i] = counts.r[i] + counts.g[i] + counts.b[i];
  const norm = {} as Record<AdjustChannel, Float32Array>;
  for (const c of CHANNELS) {
    const sorted = Float32Array.from(counts[c]).sort();
    const max = sorted[252] || sorted[255];
    norm[c] = counts[c].map((v) => (max > 0 ? Math.min(1, v / max) : 0));
  }
  return { counts, norm };
}

/**
 * Histogram of what adjustment layer `layerId` receives (its backdrop), recomputed on idle 300 ms
 * after anything it depends on changes: the comp settings, the layers below it (the store keeps
 * the identity of unchanged layers) and its own nesting / clipping. Editing the adjustment itself
 * does not recompute. No layer (an Adjust effect): always null.
 */
function useBackdropHistogram(layerId: string | undefined): Histogram | null {
  const [hist, setHist] = useState<Histogram | null>(null);
  useEffect(() => {
    if (!layerId) return;
    let prev: readonly unknown[] = [];
    let timer = 0;
    let idle = 0;
    const hasIdle = typeof window.requestIdleCallback === 'function';
    const cancel = () => {
      clearTimeout(timer);
      if (hasIdle) cancelIdleCallback(idle);
      else clearTimeout(idle);
    };
    const compute = () => {
      const engine = engineHost.engine;
      if (!engine) {
        prev = []; // no engine yet: retry on the next store change
        return;
      }
      setHist(histogramOf(engine.renderBackdrop(useEditor.getState().project, layerId, { scale: HISTOGRAM_SCALE })));
    };
    const check = (project: Project) => {
      const i = project.layers.findIndex((l) => l.id === layerId);
      if (i < 0) return;
      const self = project.layers[i];
      const next = [project.comp, self.parentId, self.clip, ...project.layers.slice(0, i)];
      if (next.length === prev.length && next.every((v, k) => v === prev[k])) return;
      const first = prev.length === 0;
      prev = next;
      cancel();
      timer = window.setTimeout(
        () => {
          idle = hasIdle ? requestIdleCallback(compute, { timeout: 500 }) : window.setTimeout(compute, 0);
        },
        first ? 0 : HISTOGRAM_DEBOUNCE_MS,
      );
    };
    check(useEditor.getState().project);
    const unsubscribe = useEditor.subscribe((s) => check(s.project));
    return () => {
      unsubscribe();
      cancel();
    };
  }, [layerId]);
  return layerId ? hist : null;
}

function HistogramView({ bins, color, marker, label }: { bins: ArrayLike<number> | null; color: string; marker?: number; label: string }) {
  const t = useT();
  let d = 'M0,100';
  if (bins) for (let i = 0; i < 256; i++) d += ` L${i + 0.5},${(100 - bins[i] * 96).toFixed(1)}`;
  d += ' L256,100 Z';
  return (
    <svg className="adj-histogram" viewBox="0 0 256 100" preserveAspectRatio="none" role="img" aria-label={label}>
      <title>{bins ? label : t('Histogram: computing…')}</title>
      {bins && <path d={d} fill={color} fillOpacity={0.55} />}
      {marker !== undefined && <line x1={marker + 0.5} y1={0} x2={marker + 0.5} y2={100} stroke="var(--accent)" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

function ChannelSelect({ value, onChange }: { value: AdjustChannel; onChange: (c: AdjustChannel) => void }) {
  const t = useT();
  return (
    <Row label={t('Channel')} title={t('Channel to edit: RGB adjusts all three together')}>
      <select aria-label={t('Channel')} title={t('Channel to edit: RGB adjusts all three together')} value={value} onChange={(e) => onChange(e.target.value as AdjustChannel)}>
        {CHANNELS.map((c) => (
          <option key={c} value={c}>
            {t(CHANNEL_LABEL[c])}
          </option>
        ))}
      </select>
    </Row>
  );
}

// ---------- slider bar with triangle handles (Levels) ----------

interface Handle {
  key: string;
  /** Position on the bar, 0..255. */
  value: number;
  /** Triangle fill (black / grey / white). */
  fill: string;
  label: string;
  title: string;
  /** Text read out for the current value. */
  valueText: string;
  /** Drag to bar position v (0..255, unrounded). */
  onMove: (v: number, coalesce: string) => void;
  /** Arrow keys: one step in `dir` (Shift = ×10). */
  onNudge: (dir: 1 | -1, big: boolean, coalesce: string) => void;
  /** The targets differ here: the triangle is dimmed at the first one's value; moving it sets them all. */
  mixed?: boolean;
}

/**
 * Photoshop Levels slider: triangles under a ramp. Pressing anywhere on the bar grabs the nearest
 * triangle; each triangle is also a keyboard slider (arrows, Shift ×10).
 */
function TriangleBar({ id, handles, ramp, label }: { id: string; handles: Handle[]; ramp: string; label: string }) {
  const t = useT();
  const g = useGesture(id);
  const [active, setActive] = useState<number | null>(null);
  const toLevel = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(255, Math.max(0, ((e.clientX - r.left) / r.width) * 255));
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const v = toLevel(e);
    let best = 0;
    handles.forEach((h, i) => {
      if (Math.abs(h.value - v) < Math.abs(handles[best].value - v)) best = i;
    });
    e.currentTarget.setPointerCapture(e.pointerId);
    g.begin();
    engineHost.setInteractive(true);
    setActive(best);
    handles[best].onMove(v, g.key());
  };
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>, h: Handle) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    h.onNudge(dir, e.shiftKey, `${id}:${h.key}:key`);
  };
  return (
    <div
      className="adj-tribar"
      title={label}
      onPointerDown={onPointerDown}
      onPointerMove={(e) => {
        if (active !== null && e.currentTarget.hasPointerCapture(e.pointerId)) handles[active].onMove(toLevel(e), g.key());
      }}
      onLostPointerCapture={() => {
        setActive(null);
        engineHost.setInteractive(false);
      }}
    >
      <div className="adj-ramp" style={{ background: ramp }} />
      {handles.map((h) => (
        <span
          key={h.key}
          className={`adj-tri ${h.mixed ? 'mixed' : ''}`}
          role="slider"
          tabIndex={0}
          aria-label={h.label}
          aria-valuemin={0}
          aria-valuemax={255}
          aria-valuenow={Math.round(h.value)}
          aria-valuetext={h.mixed ? '—' : h.valueText}
          title={h.mixed ? `${h.title}\n${t('The selected effects differ here: moving it sets all of them to one value')}` : h.title}
          style={{ left: `${(h.value / 255) * 100}%`, color: h.fill }}
          onKeyDown={(e) => onKeyDown(e, h)}
        />
      ))}
    </div>
  );
}

// ---------- per-type editors ----------

function BrightnessContrastEditor({ refp }: { refp: Refs }) {
  const t = useT();
  return (
    <>
      <RefNum
        label={t('Brightness')}
        title={t('Lightens or darkens the midtones; black and white stay put (Photoshop’s modern Brightness/Contrast)')}
        refp={sub(refp, 'brightness')}
        min={-150}
        max={150}
        integer
        clamp
        defaultValue={0}
      />
      <RefNum
        label={t('Contrast')}
        title={t('Spreads the tones away from the midpoint without clipping black or white')}
        refp={sub(refp, 'contrast')}
        min={-50}
        max={100}
        integer
        clamp
        defaultValue={0}
      />
    </>
  );
}

function LevelsEditor({ refp, adj, histogramLayerId }: { refp: Refs; adj: Adj<'levels'>; histogramLayerId?: string }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const setEachAt = useEditor((s) => s.setEachAt);
  const [ch, setCh] = useState<AdjustChannel>('rgb');
  const hist = useBackdropHistogram(histogramLayerId);
  const id = refKey(refp);
  const lv = adj.channels[ch];
  const lvRef = sub(refp, 'channels', ch);
  const at = (key: keyof LevelsChannel) => sub(lvRef, key);
  const [blackMixed, gammaMixed, whiteMixed, outBlackMixed, outWhiteMixed] = useMixed(at('inBlack'), at('gamma'), at('inWhite'), at('outBlack'), at('outWhite'));
  /** Target `i`'s levels of this channel, read when a value is set (the input points keep 2 apart per target). */
  const levelsAt = (i: number) => getRefs(useEditor.getState().project, lvRef)[i] as LevelsChannel;
  const limits: Record<keyof LevelsChannel, (v: number, i: number) => number> = {
    inBlack: (v, i) => Math.min(levelsAt(i).inWhite - 2, Math.max(0, Math.round(v))),
    inWhite: (v, i) => Math.max(levelsAt(i).inBlack + 2, Math.min(255, Math.round(v))),
    gamma: (v) => Math.min(9.99, Math.max(0.01, Math.round(v * 100) / 100)),
    outBlack: (v) => Math.min(255, Math.max(0, Math.round(v))),
    outWhite: (v) => Math.min(255, Math.max(0, Math.round(v))),
  };
  /** Set `key` on every target to `v`, within that target's limits. */
  const set = (key: keyof LevelsChannel, v: number, c: string) => setEachAt(at(key), (_, i) => limits[key](v, i), c);
  // The grey triangle marks the input level that comes out as 50 %: v^(1/γ) = 0.5.
  const grayAt = lv.inBlack + (lv.inWhite - lv.inBlack) * 0.5 ** lv.gamma;
  const ramp = `linear-gradient(to right, #000, ${CHANNEL_COLOR[ch]})`;
  const hasPixels = hist !== null && hist.counts.rgb.some((v) => v > 0);

  const auto = () => {
    if (!hist || !hasPixels) return;
    // Photoshop's Auto (Enhance Per Channel Contrast): each channel's darkest / lightest 0.1 %
    // become its black / white input points; the composite and gammas are reset.
    const ends = (counts: Float32Array) => {
      const clip = counts.reduce((s, v) => s + v, 0) * AUTO_CLIP;
      let lo = 0;
      let acc = counts[0];
      while (lo < 253 && acc <= clip) acc += counts[++lo];
      let hi = 255;
      acc = counts[255];
      while (hi > lo + 2 && acc <= clip) acc += counts[--hi];
      return { inBlack: lo, inWhite: hi, gamma: 1, outBlack: 0, outWhite: 255 };
    };
    setAt(
      sub(refp, 'channels'),
      { rgb: { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 }, r: ends(hist.counts.r), g: ends(hist.counts.g), b: ends(hist.counts.b) },
      oneShot(`${id}:levels-auto`),
      'Auto Levels',
    );
  };

  return (
    <div className="adj-levels">
      <div className="adj-toolbar">
        <ChannelSelect value={ch} onChange={setCh} />
        {histogramLayerId && (
          <button
            className="small"
            disabled={!hasPixels}
            title={t('Auto: stretch each channel so its darkest and lightest 0.1 % become black and white')}
            aria-label={t('Auto Levels')}
            onClick={auto}
          >
            {t('Auto')}
          </button>
        )}
      </div>
      {histogramLayerId && <HistogramView bins={hist?.norm[ch] ?? null} color={CHANNEL_COLOR[ch]} label={t('Histogram of the layers below')} />}
      <TriangleBar
        id={`${id}:levels-in:${ch}`}
        ramp={ramp}
        label={t('Input levels: drag the black, grey and white triangles')}
        handles={[
          {
            key: 'black',
            value: lv.inBlack,
            fill: '#000',
            label: t('Input black point'),
            title: t('Input black point: levels at or below it become the output black'),
            valueText: String(lv.inBlack),
            mixed: blackMixed,
            onMove: (v, c) => set('inBlack', v, c),
            onNudge: (d, big, c) => set('inBlack', lv.inBlack + d * (big ? 10 : 1), c),
          },
          {
            key: 'gray',
            value: grayAt,
            fill: '#888',
            label: t('Midtone (gamma)'),
            title: t('Midtone: drag left to lighten, right to darken (gamma)'),
            valueText: lv.gamma.toFixed(2),
            mixed: gammaMixed,
            // Each target's gamma that puts its 50 % grey at the dragged level, between its own black and white.
            onMove: (v, c) =>
              setEachAt(
                at('gamma'),
                (_, i) => {
                  const l = levelsAt(i);
                  return limits.gamma(Math.log(Math.min(0.999, Math.max(0.001, (v - l.inBlack) / (l.inWhite - l.inBlack)))) / Math.log(0.5), i);
                },
                c,
              ),
            onNudge: (d, big, c) => set('gamma', lv.gamma - d * (big ? 0.1 : 0.01), c),
          },
          {
            key: 'white',
            value: lv.inWhite,
            fill: '#fff',
            label: t('Input white point'),
            title: t('Input white point: levels at or above it become the output white'),
            valueText: String(lv.inWhite),
            mixed: whiteMixed,
            onMove: (v, c) => set('inWhite', v, c),
            onNudge: (d, big, c) => set('inWhite', lv.inWhite + d * (big ? 10 : 1), c),
          },
        ]}
      />
      <div className="adj-fields" role="group" aria-label={t('Input levels')}>
        <AdjField refp={at('inBlack')} limit={limits.inBlack} label={t('Input black point')} min={0} max={253} integer clamp slider={false} />
        <AdjField refp={at('gamma')} limit={limits.gamma} label={t('Midtone (gamma)')} min={0.01} max={9.99} step={0.01} clamp slider={false} />
        <AdjField refp={at('inWhite')} limit={limits.inWhite} label={t('Input white point')} min={2} max={255} integer clamp slider={false} />
      </div>
      <div className="adj-caption muted">{t('Output Levels')}</div>
      <TriangleBar
        id={`${id}:levels-out:${ch}`}
        ramp={ramp}
        label={t('Output levels: drag the black and white triangles')}
        handles={[
          {
            key: 'black',
            value: lv.outBlack,
            fill: '#000',
            label: t('Output black'),
            title: t('Output black: the darkest level the result may have'),
            valueText: String(lv.outBlack),
            mixed: outBlackMixed,
            onMove: (v, c) => set('outBlack', v, c),
            onNudge: (d, big, c) => set('outBlack', lv.outBlack + d * (big ? 10 : 1), c),
          },
          {
            key: 'white',
            value: lv.outWhite,
            fill: '#fff',
            label: t('Output white'),
            title: t('Output white: the lightest level the result may have'),
            valueText: String(lv.outWhite),
            mixed: outWhiteMixed,
            onMove: (v, c) => set('outWhite', v, c),
            onNudge: (d, big, c) => set('outWhite', lv.outWhite + d * (big ? 10 : 1), c),
          },
        ]}
      />
      <div className="adj-fields adj-fields-2" role="group" aria-label={t('Output Levels')}>
        <AdjField refp={at('outBlack')} label={t('Output black')} min={0} max={255} integer clamp slider={false} />
        <AdjField refp={at('outWhite')} label={t('Output white')} min={0} max={255} integer clamp slider={false} />
      </div>
    </div>
  );
}

const cp = (x: number, y: number): CurvePoint => ({ x, y, corner: false });

/** Photoshop's Curves presets (RGB). */
const CURVE_PRESETS: readonly CurvePreset[] = [
  { label: 'Linear', curve: { points: [cp(0, 0), cp(1, 1)] } },
  { label: 'Increase Contrast', curve: { points: [cp(0, 0), cp(64 / 255, 48 / 255), cp(192 / 255, 208 / 255), cp(1, 1)] } },
  { label: 'Darker', curve: { points: [cp(0, 0), cp(128 / 255, 96 / 255), cp(1, 1)] } },
  { label: 'Lighter', curve: { points: [cp(0, 0), cp(128 / 255, 160 / 255), cp(1, 1)] } },
];

function CurvesEditor({ refp, adj, histogramLayerId }: { refp: Refs; adj: Adj<'curves'>; histogramLayerId?: string }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const [ch, setCh] = useState<AdjustChannel>('rgb');
  const hist = useBackdropHistogram(histogramLayerId);
  const id = refKey(refp);
  const curveRef = sub(refp, 'channels', ch);
  const [mixed] = useMixed(curveRef);
  return (
    <div className="adj-curves">
      <ChannelSelect value={ch} onChange={setCh} />
      <CurveEditor
        id={`${id}:curves:${ch}`}
        value={adj.channels[ch]}
        mixed={mixed}
        onChange={(c, k) => setAt(curveRef, c, k)}
        label={t('Curves')}
        presets={CURVE_PRESETS}
        histogram={hist?.norm[ch]}
        size={CURVES_SIZE}
      />
    </div>
  );
}

function ExposureEditor({ refp }: { refp: Refs }) {
  const t = useT();
  return (
    <>
      <RefNum
        label={t('Exposure')}
        title={t('Exposure in stops: brightens or darkens mostly the highlights (linear light, like a camera)')}
        refp={sub(refp, 'exposure')}
        min={-20}
        max={20}
        step={0.01}
        clamp
        defaultValue={0}
      />
      <RefNum
        label={t('Offset')}
        title={t('Offset: lifts or crushes the shadows and midtones, highlights barely move')}
        refp={sub(refp, 'offset')}
        min={-0.5}
        max={0.5}
        step={0.0001}
        clamp
        defaultValue={0}
      />
      <RefNum
        label={t('Gamma Correction')}
        title={t('Gamma correction: a power curve; above 1 lightens the midtones')}
        refp={sub(refp, 'gamma')}
        min={0.01}
        max={9.99}
        step={0.01}
        clamp
        defaultValue={1}
      />
    </>
  );
}

function VibranceEditor({ refp }: { refp: Refs }) {
  const t = useT();
  return (
    <>
      <RefNum
        label={t('Vibrance')}
        title={t('Vibrance: boosts dull colours more than already saturated ones, without clipping')}
        refp={sub(refp, 'vibrance')}
        min={-100}
        max={100}
        integer
        clamp
        defaultValue={0}
      />
      <RefNum
        label={t('Saturation')}
        title={t('Saturation: the same change for every colour, without clipping')}
        refp={sub(refp, 'saturation')}
        min={-100}
        max={100}
        integer
        clamp
        defaultValue={0}
      />
    </>
  );
}

/** Hue angles of the rainbow bar stops: 0°..360° in 30° steps. */
const HUE_STEPS = Array.from({ length: 13 }, (_, i) => i * 30);

function HueSaturationEditor({ refp, adj }: { refp: Refs; adj: Adj<'hueSaturation'> }) {
  const t = useT();
  const setEachAt = useEditor((s) => s.setEachAt);
  // Like Photoshop, switching Colorize on with no saturation starts from 25 so the tint shows.
  const setColorize = (on: boolean) =>
    setEachAt(
      refp,
      (a) => {
        const cur = a as Adj<'hueSaturation'>;
        return { ...cur, colorize: on, saturation: on && cur.saturation <= 0 ? 25 : cur.saturation };
      },
      oneShot(`${refKey(refp)}:colorize`),
      'Colorize',
    );
  const [colorizeMixed, previewMixed] = useMixed(sub(refp, 'colorize'), refp);
  // Preview of where each hue ends up (exact for fully saturated hues): Hue rotates, Saturation
  // scales HSL saturation (or Colorize paints one hue), Lightness blends to white / black.
  // Striped while the targets differ.
  const s = adj.colorize ? Math.max(0, adj.saturation) : adj.saturation >= 0 ? 100 : 100 + adj.saturation;
  const l = 50 + adj.lightness / 2;
  const shifted = HUE_STEPS.map((h) => `hsl(${adj.colorize ? adj.hue : h + adj.hue}deg ${s}% ${l}%)`).join(', ');
  const rainbow = HUE_STEPS.map((h) => `hsl(${h}deg 100% 50%)`).join(', ');
  return (
    <>
      <RefNum label={t('Hue')} title={t('Hue: rotates every colour around the colour wheel')} refp={sub(refp, 'hue')} min={-180} max={180} integer clamp unit="deg" defaultValue={0} />
      <RefNum
        label={t('Saturation')}
        title={adj.colorize ? t('Saturation of the colorize tint') : t('Saturation: −100 = greyscale, +100 = fully saturated')}
        refp={sub(refp, 'saturation')}
        min={adj.colorize ? 0 : -100}
        max={100}
        integer
        clamp
        defaultValue={adj.colorize ? 25 : 0}
      />
      <RefNum label={t('Lightness')} title={t('Lightness: +100 = white, −100 = black')} refp={sub(refp, 'lightness')} min={-100} max={100} integer clamp defaultValue={0} />
      <CheckRow label={t('Colorize')} title={t('Colorize: paint the image in one hue, keeping its tones')} value={adj.colorize} mixed={colorizeMixed} onChange={setColorize} />
      <div className="adj-huebars" role="img" aria-label={t('Hue preview: the top bar is the input, the bottom bar the result')} title={t('Hue preview: the top bar is the input, the bottom bar the result')}>
        <div style={{ background: `linear-gradient(to right, ${rainbow})` }} />
        <div className={previewMixed ? 'mixed-stripes' : undefined} style={{ background: `linear-gradient(to right, ${shifted})` }} />
      </div>
    </>
  );
}

type Tone = 'shadows' | 'midtones' | 'highlights';

const TONES: Record<Tone, { label: string; title: string }> = {
  shadows: { label: 'Shadows', title: 'Edit the shadows' },
  midtones: { label: 'Midtones', title: 'Edit the midtones' },
  highlights: { label: 'Highlights', title: 'Edit the highlights' },
};
const TONE_ORDER: readonly Tone[] = ['shadows', 'midtones', 'highlights'];

const BALANCE_AXES: readonly { key: keyof ColorBalanceRange; left: string; right: string; leftColor: string; rightColor: string }[] = [
  { key: 'cyanRed', left: 'Cyan', right: 'Red', leftColor: '#00ffff', rightColor: '#ff0000' },
  { key: 'magentaGreen', left: 'Magenta', right: 'Green', leftColor: '#ff00ff', rightColor: '#00ff00' },
  { key: 'yellowBlue', left: 'Yellow', right: 'Blue', leftColor: '#ffff00', rightColor: '#0000ff' },
];

function ColorBalanceEditor({ refp }: { refp: Refs }) {
  const t = useT();
  const [tone, setTone] = useState<Tone>('midtones');
  return (
    <>
      <Row label={t('Tone', undefined, { ctx: 'balance' })} title={t('Tonal range the sliders below shift')}>
        <Seg
          value={tone}
          onChange={setTone}
          options={TONE_ORDER.map((v) => ({ value: v, label: t(TONES[v].label), title: t(TONES[v].title) }))}
        />
      </Row>
      {BALANCE_AXES.map((a) => {
        const label = t('{left} – {right}', { left: t(a.left), right: t(a.right) });
        return (
          <Row
            key={a.key}
            className="adj-balance"
            title={t('Shift the {tone} toward {left} (−) or {right} (+)', { tone: t(TONES[tone].label), left: t(a.left), right: t(a.right) })}
            label={
              <span className="label">
                <i className="adj-dot" style={{ background: a.leftColor }} />
                {t(a.left)}
              </span>
            }
          >
            <AdjField refp={sub(refp, tone, a.key)} label={label} min={-100} max={100} integer clamp />
            <span className="adj-balance-right">
              {t(a.right)}
              <i className="adj-dot" style={{ background: a.rightColor }} />
            </span>
          </Row>
        );
      })}
      <RefCheck label={t('Preserve Luminosity')} title={t('Keep each pixel’s lightness so only the colour changes')} refp={sub(refp, 'preserveLuminosity')} />
    </>
  );
}

const BW_WEIGHTS: readonly { key: 'reds' | 'yellows' | 'greens' | 'cyans' | 'blues' | 'magentas'; label: string; color: string; def: number }[] = [
  { key: 'reds', label: 'Reds', color: '#ff0000', def: 40 },
  { key: 'yellows', label: 'Yellows', color: '#ffff00', def: 60 },
  { key: 'greens', label: 'Greens', color: '#00ff00', def: 40 },
  { key: 'cyans', label: 'Cyans', color: '#00ffff', def: 60 },
  { key: 'blues', label: 'Blues', color: '#0000ff', def: 20 },
  { key: 'magentas', label: 'Magentas', color: '#ff00ff', def: 80 },
];

function BlackWhiteEditor({ refp, adj }: { refp: Refs; adj: Adj<'blackWhite'> }) {
  const t = useT();
  const [tintMixed] = useMixed(sub(refp, 'tint'));
  return (
    <>
      {BW_WEIGHTS.map((w) => (
        <Row
          key={w.key}
          className="adj-bw"
          title={t('How light {colors} turn in grey (% of white; default {def} %)', { colors: t(w.label), def: w.def })}
          label={
            <span className="label">
              <i className="adj-dot" style={{ background: w.color }} />
              {t(w.label)}
            </span>
          }
        >
          <AdjField refp={sub(refp, w.key)} label={t(w.label)} min={-200} max={300} integer clamp unit="%" />
        </Row>
      ))}
      <RefCheck label={t('Tint', undefined, { ctx: 'bw' })} title={t('Tint: colour the greyscale result')} refp={sub(refp, 'tint')} />
      {(adj.tint || tintMixed) && <RefColor label={t('Tint Color')} refp={sub(refp, 'tintColor')} />}
    </>
  );
}

function PhotoFilterEditor({ refp }: { refp: Refs }) {
  const t = useT();
  return (
    <>
      <RefColor label={t('Filter Color')} refp={sub(refp, 'color')} />
      <RefNum label={t('Density')} title={t('Density: how strongly the filter colour tints the image')} refp={sub(refp, 'density')} min={0} max={100} integer clamp unit="%" defaultValue={25} />
      <RefCheck label={t('Preserve Luminosity')} title={t('Keep each pixel’s lightness so the filter only tints')} refp={sub(refp, 'preserveLuminosity')} />
    </>
  );
}

function GradientMapEditor({ refp, adj }: { refp: Refs; adj: Adj<'gradientMap'> }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const gradRef = sub(refp, 'gradient');
  const [gradMixed] = useMixed(gradRef);
  return (
    <>
      <div className="adj-caption muted" title={t('Shadows take the left end of the gradient, highlights the right end')}>
        {t('Gradient Used for Grayscale Mapping')}
      </div>
      <GradientEditor id={`${refKey(refp)}:gradient-map`} value={adj.gradient} mixed={gradMixed} onChange={(g, c) => setAt(gradRef, g, c)} />
      <RefCheck label={t('Reverse')} title={t('Reverse: map shadows to the right end of the gradient')} refp={sub(refp, 'reverse')} />
    </>
  );
}

function ThresholdEditor({ refp, adj, histogramLayerId }: { refp: Refs; adj: Adj<'threshold'>; histogramLayerId?: string }) {
  const t = useT();
  const hist = useBackdropHistogram(histogramLayerId);
  return (
    <>
      {histogramLayerId && <HistogramView bins={hist?.norm.rgb ?? null} color="var(--muted)" marker={adj.level} label={t('Histogram of the layers below')} />}
      <RefNum
        label={t('Threshold Level')}
        title={t('Pixels at or above this luminosity turn white, darker ones black')}
        refp={sub(refp, 'level')}
        min={1}
        max={255}
        integer
        clamp
        defaultValue={128}
      />
    </>
  );
}

/**
 * Photoshop-style settings of the adjustment `adj` stored at `refp`: an adjustment layer's
 * `adjustment` or an Adjust effect's param. `histogramLayerId` is the adjustment layer whose
 * backdrop Levels, Curves and Threshold show (and Auto Levels reads); without it they show none.
 */
export function AdjustmentFields({ refp, adj, histogramLayerId }: { refp: Refs; adj: Adjustment; histogramLayerId?: string }) {
  const t = useT();
  switch (adj.type) {
    case 'brightnessContrast':
      return <BrightnessContrastEditor refp={refp} />;
    case 'levels':
      return <LevelsEditor refp={refp} adj={adj} histogramLayerId={histogramLayerId} />;
    case 'curves':
      return <CurvesEditor refp={refp} adj={adj} histogramLayerId={histogramLayerId} />;
    case 'exposure':
      return <ExposureEditor refp={refp} />;
    case 'vibrance':
      return <VibranceEditor refp={refp} />;
    case 'hueSaturation':
      return <HueSaturationEditor refp={refp} adj={adj} />;
    case 'colorBalance':
      return <ColorBalanceEditor refp={refp} />;
    case 'blackWhite':
      return <BlackWhiteEditor refp={refp} adj={adj} />;
    case 'photoFilter':
      return <PhotoFilterEditor refp={refp} />;
    case 'gradientMap':
      return <GradientMapEditor refp={refp} adj={adj} />;
    case 'invert':
      return <p className="adj-note muted">{t('Invert has no settings: every colour becomes its opposite.')}</p>;
    case 'posterize':
      return (
        <RefNum
          label={t('Levels', undefined, { ctx: 'posterize' })}
          title={t('Number of tone levels per channel')}
          refp={sub(refp, 'levels')}
          min={2}
          max={255}
          integer
          clamp
          defaultValue={4}
        />
      );
    case 'threshold':
      return <ThresholdEditor refp={refp} adj={adj} histogramLayerId={histogramLayerId} />;
    case 'effectsOnly':
      return <p className="adj-note muted">{t('Effects on this layer apply to everything below it', undefined, { ctx: 'adjustment' })}</p>;
  }
}

/** Photoshop-style settings of an adjustment layer (the Properties panel body for it). */
export function AdjustmentEditor({ layer }: { layer: AdjustmentLayer }) {
  return <AdjustmentFields refp={{ layerId: layer.id, path: ['adjustment'] }} adj={layer.adjustment} histogramLayerId={layer.id} />;
}
