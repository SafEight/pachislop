import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_TRIM_ALPHA,
  encodePng,
  exportLayerParts,
  exportSvg,
  isAbortError,
  layerParts,
  measureOutput,
  printPixels,
  PRINT_BLEED_MM,
  pxToMm,
  renderStill,
  type BitDepth,
  type PrintSize,
  type RoundTo,
  type StillOptions,
} from '../io/export';
import { safeFileName } from '../io/project';
import { exportPartsZip, exportPsd } from '../io/psd';
import { isTitleLayer, type TitleLayer } from '../model/parts';
import type { Project } from '../model/types';
import { errorMsg, formatMsg, joinMsgs, msg, MsgError, verbatim, type Text } from '../store/msg';
import { useEditor } from '../store/store';
import { withDescendants } from '../store/tree';
import { CheckRow, NumberField, NumRow, Row, Seg, Tabs } from './controls';
import { engineHost } from './engineHost';
import { useT } from './i18n';
import { tOpts } from './properties/style/shared';
import { downloadBlob } from './util';
import './export.css';

type Mode = 'image' | 'psd' | 'svg';
type Scope = 'selected' | 'all';
type ImageOutput = 'single' | 'layers';
type PsdFormat = 'psd' | 'parts';
type SizeMode = 'scale' | 'print';

const MODES = [
  { value: 'image', label: 'Image', title: 'One transparent PNG, or every layer as its own trimmed PNG' },
  { value: 'psd', label: 'PSD', title: 'Layered PSD or registered PNG parts for compositing' },
  { value: 'svg', label: 'SVG', title: 'Text face outlines for hand-off' },
] as const;

const IMAGE_OUTPUTS = [
  { value: 'single', label: 'Single image', title: 'The whole composite as one PNG' },
  { value: 'layers', label: 'Per layer (PNG parts)', title: 'Each visible top-level title layer or group alone, trimmed to its own bounds (Photoshop Quick Export layers)' },
] as const;

const SCOPES = [
  { value: 'selected', label: 'Selected layer', title: 'The selected title layer, or every title layer in the selected group' },
  { value: 'all', label: 'All title layers' },
] as const;

const ROUNDS = [
  { value: '1', label: 'Off', title: 'Exact trimmed size' },
  { value: '4', label: '4 px', title: 'Both sides a multiple of 4 px' },
  { value: '8', label: '8 px', title: 'Both sides a multiple of 8 px (8 px cut grid)' },
] as const;

const PSD_FORMATS = [
  { value: 'psd', label: 'Layered PSD', title: 'One layer per comp layer, blend modes and opacity kept' },
  { value: 'parts', label: 'Registered PNGs', title: 'The same layers / parts as PNGs on one shared canvas, so they register; for per-layer trimmed PNGs use Image ▸ Per layer' },
] as const;

const BIT_DEPTHS = [
  { value: '8', label: '8-bit', title: '8 bits per channel, dithered: what most tools expect' },
  { value: '16', label: '16-bit', title: '16 bits per channel: smooth glows and gradients without banding, for grading and compositing' },
] as const;

const SIZE_MODES = [
  { value: 'scale', label: 'Scale', title: 'Output pixels per comp pixel (screen / machine delivery)' },
  { value: 'print', label: 'Print (mm @ dpi)', title: 'A print page in millimetres at the comp resolution: the comp scaled to cover the page, centred' },
] as const;

const QUICK_SCALES = [100, 200, 400];

/** Common print resolutions (dpi). */
const DPI_PRESETS = [72, 300, 350];

/** Size in mm with one decimal, without a trailing .0. */
const mm = (v: number) => String(Math.round(v * 10) / 10);

/** `W × H px`, plus the size in mm when the comp has a print resolution (not 72 dpi). Numbers and units only, so never translated. */
const sizeText = (w: number, h: number, dpi: number) => verbatim(`${w} × ${h} px${dpi !== 72 ? ` · ${mm(pxToMm(w, dpi))} × ${mm(pxToMm(h, dpi))} mm @ ${dpi} dpi` : ''}`);

/** Options that persist between exports (and sessions). The file name follows the project instead. */
interface Prefs {
  mode: Mode;
  /** Output scale in % (82 = 82%). */
  scalePct: number;
  sizeMode: SizeMode;
  /** Print page (trim size) in mm. */
  printW: number;
  printH: number;
  /** Add PRINT_BLEED_MM of bleed per side. */
  bleed: boolean;
  trim: boolean;
  /** Trim threshold: alpha 1..255 a pixel needs to count as content. */
  trimAlpha: number;
  padding: number;
  roundTo: RoundTo;
  includeGuides: boolean;
  imageOutput: ImageOutput;
  /** Per-layer parts: one shared size for every PNG. */
  sameSize: boolean;
  scope: Scope;
  /** Registered PNG parts: half-width file names. */
  ascii: boolean;
  psdFormat: PsdFormat;
  splitTitles: boolean;
  /** PNG bits per channel (layered PSDs are always 8-bit). */
  bitDepth: BitDepth;
}

const DEFAULT_PREFS: Prefs = {
  mode: 'image',
  scalePct: 200,
  sizeMode: 'scale',
  printW: 100,
  printH: 50,
  bleed: false,
  trim: true,
  trimAlpha: DEFAULT_TRIM_ALPHA,
  padding: 16,
  roundTo: 1,
  includeGuides: false,
  imageOutput: 'single',
  sameSize: false,
  scope: 'all',
  ascii: true,
  psdFormat: 'psd',
  splitTitles: true,
  bitDepth: 8,
};

const PREFS_KEY = 'pachislot-visuals.export';

/** Stored prefs merged over the defaults; fields of the wrong type (or unknown values) are dropped. */
function loadPrefs(): Prefs {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null');
  } catch {
    return DEFAULT_PREFS;
  }
  if (!raw || typeof raw !== 'object') return DEFAULT_PREFS;
  const out: Record<string, unknown> = { ...DEFAULT_PREFS };
  for (const [k, v] of Object.entries(raw)) {
    if (k in DEFAULT_PREFS && typeof v === typeof DEFAULT_PREFS[k as keyof Prefs]) out[k] = v;
  }
  const p = out as unknown as Prefs;
  return {
    ...p,
    mode: MODES.some((m) => m.value === p.mode) ? p.mode : DEFAULT_PREFS.mode,
    imageOutput: IMAGE_OUTPUTS.some((o) => o.value === p.imageOutput) ? p.imageOutput : DEFAULT_PREFS.imageOutput,
    sizeMode: SIZE_MODES.some((m) => m.value === p.sizeMode) ? p.sizeMode : DEFAULT_PREFS.sizeMode,
    printW: p.printW > 0 ? p.printW : DEFAULT_PREFS.printW,
    printH: p.printH > 0 ? p.printH : DEFAULT_PREFS.printH,
    trimAlpha: p.trimAlpha >= 1 && p.trimAlpha <= 255 ? p.trimAlpha : DEFAULT_PREFS.trimAlpha,
    roundTo: ([1, 4, 8] as const).find((r) => r === p.roundTo) ?? 1,
    bitDepth: p.bitDepth === 16 ? 16 : 8,
    scalePct: p.scalePct > 0 ? p.scalePct : DEFAULT_PREFS.scalePct,
  };
}

/** The first few of `files`, comma-separated. */
const fileNames = (files: string[]) => `${files.slice(0, 4).join(', ')}${files.length > 4 ? ', …' : ''}`;

interface Outcome {
  blob: Blob;
  fileName: string;
  warnings: Text[];
}

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const project = useEditor((s) => s.project);
  const selectedLayerId = useEditor((s) => s.selectedLayerId);
  const selected = project.layers.find((l) => l.id === selectedLayerId);
  const titles = project.layers.filter(isTitleLayer);
  // A selected group stands for the title layers in its subtree (nested groups included).
  const selectedTitles = useMemo((): TitleLayer[] => {
    if (selected?.kind !== 'group') return isTitleLayer(selected) ? [selected] : [];
    const inside = new Set(withDescendants(project.layers, [selected.id]));
    return project.layers.filter((l): l is TitleLayer => inside.has(l.id) && isTitleLayer(l));
  }, [project.layers, selected]);

  const [prefs, setPrefsState] = useState(loadPrefs);
  const set = <K extends keyof Prefs>(key: K, value: Prefs[K]) =>
    setPrefsState((prev) => {
      const next = { ...prev, [key]: value };
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      return next;
    });
  const { mode, trim, roundTo, scope } = prefs;
  const scoped = scope === 'selected' ? selectedTitles : titles;
  const [fileName, setFileName] = useState(() => safeFileName(project.name));
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [status, setStatus] = useState<{ text: Text; error: boolean } | null>(null);
  const [measured, setMeasured] = useState<{ key: string; project: Project; w: number; h: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const scale = prefs.scalePct / 100;
  const busy = progress !== null;
  useEffect(() => {
    if (busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    // Capture, so Esc closes the dialog instead of also reaching the editor underneath; not while exporting (Cancel stops that).
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onClose]);
  const { width, height } = project.comp;
  const base = safeFileName(fileName);
  const perLayer = mode === 'image' && prefs.imageOutput === 'layers';

  const { dpi } = project.comp;
  const print: PrintSize | null =
    prefs.sizeMode === 'print' ? { widthMm: prefs.printW, heightMm: prefs.printH, bleedMm: prefs.bleed ? PRINT_BLEED_MM : 0 } : null;
  // The print resolution is the comp's (saved with the project, written into PNG / PSD).
  const setDpi = (v: number, coalesce = 'export-dpi') => useEditor.getState().edit((p) => ({ ...p, comp: { ...p.comp, dpi: v } }), coalesce, 'Print resolution');
  const still: StillOptions = { scale, trim, padding: prefs.padding, roundTo, trimAlpha: prefs.trimAlpha, print, includeGuides: prefs.includeGuides };
  const stillKey = JSON.stringify(still);
  // ag-psd writes 8-bit PSDs only; every PNG output takes the chosen depth.
  const layeredPsd = mode === 'psd' && prefs.psdFormat === 'psd';
  const bitDepth: BitDepth = layeredPsd ? 8 : prefs.bitDepth;
  const parts = useMemo(() => (perLayer ? layerParts(project, base, prefs.includeGuides) : []), [perLayer, project, base, prefs.includeGuides]);
  const partFiles = parts.map((p) => p.file);

  const outlined = (l: TitleLayer) => l.source.kind === 'text' || l.source.kind === 'shape';
  const svgLayerIds = scoped.filter(outlined).map((l) => l.id);
  const blocker: Text | null =
    !engineHost.engine && mode !== 'svg'
      ? 'The renderer is not ready'
      : perLayer && !partFiles.length
        ? 'No visible title layers to export'
        : mode === 'svg' && !svgLayerIds.length
          ? scope === 'selected'
            ? 'Select a title layer (or a group) with a text or shape source'
            : 'The project has no text or shape title layers'
          : print && !(dpi > 0 && print.widthMm > 0 && print.heightMm > 0)
            ? 'Enter a page size and resolution above 0'
            : !print && !(scale > 0)
              ? 'Enter a scale above 0%'
              : null;

  const ext =
    mode === 'image'
      ? perLayer && partFiles.length > 1
        ? '_layers.zip'
        : '.png'
      : mode === 'svg'
        ? svgLayerIds.length > 1
          ? '_svg.zip'
          : '.svg'
        : prefs.psdFormat === 'psd'
          ? '.psd'
          : '_parts.zip';

  /**
   * Runs one export job with progress, cancel and status reporting; `body` returns the file to
   * download (or null). `failure` reports any other error.
   */
  const runJob = async (
    body: (signal: AbortSignal, onProgress: (done: number, total: number) => void) => Promise<Outcome | null>,
    failure: 'Export failed: {error}' | 'Copy failed: {error}' = 'Export failed: {error}',
  ) => {
    const st = useEditor.getState();
    const ac = new AbortController();
    abortRef.current = ac;
    setStatus(null);
    setProgress({ done: 0, total: 1 });
    try {
      const out = await body(ac.signal, (done, total) => setProgress({ done, total }));
      if (!out) return;
      downloadBlob(out.blob, out.fileName);
      const exported = msg('Exported {file}', { file: out.fileName });
      setStatus((prev) => ({ text: joinMsgs([exported, ...(prev ? [prev.text] : []), ...out.warnings], ' · '), error: false }));
      st.notify(exported);
      if (out.warnings.length) st.notify(joinMsgs(out.warnings, '; '), 'error');
    } catch (err) {
      if (isAbortError(err)) setStatus({ text: 'Cancelled', error: false });
      else {
        const text = msg(failure, { error: errorMsg(err) });
        setStatus({ text, error: true });
        st.notify(text, 'error');
      }
    } finally {
      abortRef.current = null;
      setProgress(null);
      engineHost.invalidate();
    }
  };

  const run = () =>
    runJob(async (signal, onProgress) => {
      const current = useEditor.getState().project;
      // Every scoped title goes in: exportSvg skips the ones without outlines (image sources) with a warning.
      if (mode === 'svg') return exportSvg(current, scoped.map((l) => l.id), base);
      const engine = engineHost.engine;
      if (!engine) throw new MsgError(msg('The renderer is not ready'));
      if (mode === 'image' && !perLayer) {
        const r = await renderStill(engine, current, { ...still, bitDepth, signal });
        setStatus({ text: print ? sizeNote : sizeText(r.image.width, r.image.height, current.comp.dpi), error: false });
        return { blob: await encodePng(r.image, current.comp.dpi, signal), fileName: `${base}.png`, warnings: r.warning ? [r.warning] : [] };
      }
      if (perLayer) return exportLayerParts(engine, current, { ...still, bitDepth, signal, onProgress, baseName: base, sameSize: prefs.sameSize });
      const opts = { ...still, bitDepth, signal, onProgress, baseName: base, ascii: prefs.ascii, splitTitles: prefs.splitTitles };
      const r = prefs.psdFormat === 'psd' ? await exportPsd(engine, current, opts) : await exportPartsZip(engine, current, opts);
      return { blob: r.blob, fileName: `${base}${prefs.psdFormat === 'psd' ? '.psd' : '_parts.zip'}`, warnings: r.warnings };
    });

  /** Copy takes the single-image PNG only. */
  const copyable = mode === 'image' && !perLayer;
  /**
   * The single image to the clipboard instead of a download. Rendered 8-bit whatever the bit
   * depth: browsers re-encode clipboard PNGs to 8 bits without the dpi, and the dithered 8-bit
   * render is the one that survives that without banding.
   */
  const copy = () =>
    runJob(async (signal) => {
      const engine = engineHost.engine;
      if (!engine) throw new MsgError(msg('The renderer is not ready'));
      const current = useEditor.getState().project;
      const rendered = renderStill(engine, current, { ...still, bitDepth: 8, signal });
      const png = rendered.then((r) => encodePng(r.image, current.comp.dpi, signal));
      // The pending PNG goes in now, while the click's user activation lasts (Safari requires it).
      const written = navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).then(
        () => null,
        (e: unknown) => e,
      );
      // A render / encode error first: the clipboard would only report that its data failed.
      const [r] = await Promise.all([rendered, png]);
      const clipboardError = await written;
      if (clipboardError) throw clipboardError;
      const st = useEditor.getState();
      const copied = msg('Copied {w} × {h} px to the clipboard', { w: r.image.width, h: r.image.height });
      setStatus({ text: joinMsgs([copied, ...(r.warning ? [r.warning] : [])], ' · '), error: false });
      st.notify(copied);
      if (r.warning) st.notify(r.warning, 'error');
      return null;
    }, 'Copy failed: {error}');
  const copyTitle = !copyable
    ? t('Copy takes a single image: choose Image ▸ Single image')
    : bitDepth === 16
      ? t('Copy the PNG to the clipboard instead of saving it (⇧⌘C). It goes as 8-bit: browsers re-encode clipboard images, dropping 16-bit and the dpi')
      : t('Copy the PNG to the clipboard instead of saving it (⇧⌘C); browsers re-encode clipboard images without the dpi');
  // ⇧⌘C copies while the dialog is open (re-subscribed each render, so it calls the current `copy`).
  useEffect(() => {
    if (busy || !copyable || blocker) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || e.code !== 'KeyC') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void copy();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  /** Trimmed single-frame exports (image, PSD) can be measured before exporting. */
  const measurable = !print && trim && ((mode === 'image' && !perLayer) || mode === 'psd');
  const measureSize = () =>
    runJob(async (signal) => {
      const engine = engineHost.engine;
      if (!engine) throw new MsgError(msg('The renderer is not ready'));
      const current = useEditor.getState().project;
      const r = await measureOutput(engine, current, { ...still, signal });
      setMeasured({ key: stillKey, project: current, w: r.w, h: r.h });
      setStatus(r.warnings.length ? { text: joinMsgs(r.warnings, ' · '), error: false } : null);
      return null;
    });

  const roundUp = (v: number) => Math.ceil(v / roundTo) * roundTo;
  const shared = perLayer && prefs.sameSize;
  const shownMeasure = measurable && measured && measured.key === stillKey && measured.project === project ? measured : null;
  const page = print ? printPixels(print, dpi) : null;
  // Output size before exporting: exact for the comp / print page, measured on demand when trimmed.
  const pageSize = print && page ? `${page.w + 2 * page.bleed} × ${page.h + 2 * page.bleed} px · ${mm(print.widthMm + 2 * print.bleedMm)} × ${mm(print.heightMm + 2 * print.bleedMm)} mm @ ${dpi} dpi` : '';
  const sizeNote: Text = print && page
    ? print.bleedMm
      ? msg('{size} (incl. {bleed} mm bleed)', { size: pageSize, bleed: mm(print.bleedMm) })
      : verbatim(pageSize)
    : !trim
      ? sizeText(roundUp(Math.round(width * scale)), roundUp(Math.round(height * scale)), dpi)
      : shownMeasure
        ? sizeText(shownMeasure.w, shownMeasure.h, dpi)
        : joinMsgs([perLayer ? 'each layer trimmed' : 'trimmed', ...(roundTo > 1 ? [msg('sides × {n}', { n: roundTo })] : []), ...(shared ? ['same size'] : [])], ', ');

  const delivery = (
    <>
      <Row label={t('Size')} title={t('Scale the comp, or size a print page in millimetres')}>
        <Seg value={prefs.sizeMode} options={tOpts(t, SIZE_MODES, 'export')} onChange={(v) => set('sizeMode', v)} />
      </Row>
      {print ? (
        <>
          <Row label={t('Page')} title={t('Trimmed page size (仕上がりサイズ) in mm; the comp is scaled to cover it, centred')}>
            <span className="xp-mm">
              <NumberField id="export-print-w" label={t('Page width')} value={prefs.printW} onChange={(v) => set('printW', v)} min={1} max={2000} step={1} unit="mm" clamp slider={false} />
            </span>
            <span className="muted">×</span>
            <span className="xp-mm">
              <NumberField id="export-print-h" label={t('Page height')} value={prefs.printH} onChange={(v) => set('printH', v)} min={1} max={2000} step={1} unit="mm" clamp slider={false} />
            </span>
          </Row>
          <Row label={t('Resolution')} title={t('Print resolution in dpi, saved with the project: written into the PNG (pHYs) and the PSD')}>
            <Seg
              value={String(dpi)}
              options={DPI_PRESETS.map((d) => ({ value: String(d), label: String(d), title: `${d} dpi` }))}
              onChange={(v) => setDpi(Number(v), `export-dpi-${v}`)}
            />
            <span className="xp-scale">
              <NumberField id="export-dpi" label={t('Resolution')} value={dpi} onChange={(v, k) => setDpi(v, k)} min={1} max={2400} integer clamp unit="dpi" slider={false} />
            </span>
          </Row>
          <CheckRow
            label={t('Bleed')}
            value={prefs.bleed}
            onChange={(v) => set('bleed', v)}
            title={t('Add {mm} mm of bleed (塗り足し) on every side; the artwork continues into it', { mm: PRINT_BLEED_MM })}
          />
        </>
      ) : (
        <Row label={t('Scale', undefined, { ctx: 'export' })} title={t('Output pixels per comp pixel')}>
          <Seg
            value={String(prefs.scalePct)}
            options={QUICK_SCALES.map((p) => ({ value: String(p), label: `${p / 100}×`, title: `${Math.round((width * p) / 100)} × ${Math.round((height * p) / 100)} px` }))}
            onChange={(v) => set('scalePct', Number(v))}
          />
          <span className="xp-scale">
            <NumberField id="export-scale" label={t('Scale', undefined, { ctx: 'export' })} value={prefs.scalePct} onChange={(v) => set('scalePct', v)} min={1} max={800} step={1} unit="%" clamp slider={false} />
          </span>
        </Row>
      )}
      <Row label={t('Output')} title={t('Size of the exported image')}>
        <span className="xp-size" role="status">
          {formatMsg(sizeNote, t)}
        </span>
        {measurable && (
          <button className="small" disabled={!!blocker} onClick={() => void measureSize()} title={t('Render the trimmed box now to show its exact size')}>
            {shownMeasure ? t('Re-measure') : t('Measure')}
          </button>
        )}
      </Row>
      <Row label={t('Bit depth')} title={t('Bits per channel of the exported PNGs')}>
        {layeredPsd ? (
          <span className="muted">{t('8-bit: Photoshop files are written 8 bits per channel (use Registered PNGs for 16-bit)')}</span>
        ) : (
          <Seg value={String(prefs.bitDepth) as '8' | '16'} options={tOpts(t, BIT_DEPTHS)} onChange={(v) => set('bitDepth', Number(v) as BitDepth)} />
        )}
      </Row>
      {!print && (
        <>
          <CheckRow label={t('Trim')} value={trim} onChange={(v) => set('trim', v)} title={t('Crop to the visible pixels; glows and effects past the comp edge are kept')} />
          {trim && (
            <>
              <NumRow
                label={t('Padding')}
                id="export-padding"
                value={prefs.padding}
                onChange={(v) => set('padding', Math.max(0, Math.round(v)))}
                min={0}
                max={200}
                integer
                clamp
                unit="px"
                defaultValue={DEFAULT_PREFS.padding}
                title={t('Transparent margin around the trimmed content, in comp px (× scale)')}
              />
              <NumRow
                label={t('Trim alpha')}
                id="export-trim-alpha"
                value={prefs.trimAlpha}
                onChange={(v) => set('trimAlpha', v)}
                min={1}
                max={64}
                integer
                clamp
                unit="/255"
                defaultValue={DEFAULT_TRIM_ALPHA}
                title={t("Pixels fainter than this alpha (out of 255) don't extend the trimmed box, so faint 3D haze and glow tails don't blow it up; they're still drawn inside it. 8 ≈ 3 % opacity")}
              />
            </>
          )}
          <Row label={t('Round sides')} title={t('Pad symmetrically so width and height are multiples of 4 / 8 px; the content centre stays put')}>
            <Seg value={String(roundTo) as '1' | '4' | '8'} options={tOpts(t, ROUNDS)} onChange={(v) => set('roundTo', Number(v) as RoundTo)} />
          </Row>
        </>
      )}
      <CheckRow label={t('Guides')} value={prefs.includeGuides} onChange={(v) => set('includeGuides', v)} title={t('Render guide layers too (normally left out; hidden layers in PSDs)')} />
    </>
  );

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal xp-dialog" onKeyDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{t('Export')}</span>
          <button className="icon-btn right" disabled={busy} onClick={onClose} title={t('Close')} aria-label={t('Close')}>
            ✕
          </button>
        </div>
        <Tabs value={mode} tabs={tOpts(t, MODES)} onChange={(m) => !busy && set('mode', m)} />
        <div className="xp-scroll">
          <fieldset className="body xp-body" disabled={busy}>
            <Row label={perLayer ? '{name}' : t('File name')}>
              <input className="xp-name" aria-label={t('File name')} value={fileName} onChange={(e) => setFileName(e.target.value)} spellCheck={false} />
              <span className="muted">{ext}</span>
            </Row>

            {mode === 'image' && (
              <>
                <Row label={t('Output')} title={t('One composite PNG, or every layer as its own PNG')}>
                  <Seg value={prefs.imageOutput} options={tOpts(t, IMAGE_OUTPUTS)} onChange={(v) => set('imageOutput', v)} />
                </Row>
                {perLayer && (
                  <>
                    {trim && (
                      <CheckRow
                        label={t('Same size')}
                        value={prefs.sameSize}
                        onChange={(v) => set('sameSize', v)}
                        title={t('Every PNG gets the size of the largest trimmed layer (then rounded), each centred on its own layer')}
                      />
                    )}
                    <div className="notes muted">
                      {t(
                        'Each visible top-level title layer or group alone at full opacity with the layers clipped to it, trimmed to its own bounds; a layer group is one part with its effects, 3D layers export whole, background layers are skipped and adjustment layers apply to the part they sit in. Files are {pattern}. For rim / face / fx parts use PSD ▸ Split titles.',
                        { pattern: '{name}_{layer}' },
                      )}
                    </div>
                    {partFiles.length > 0 && (
                      <div className="notes muted xp-files" title={parts.map((p) => (p.layer.kind === 'group' ? t('{file} (group “{name}”)', { file: p.file, name: p.layer.name }) : p.file)).join('\n')}>
                        {t(partFiles.length === 1 ? '{n} PNG: {files}' : '{n} PNGs: {files}', { n: partFiles.length, files: fileNames(partFiles) })}
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            {mode === 'svg' && (
              <Row label={t('Apply to')}>
                <Seg value={scope} options={tOpts(t, SCOPES)} onChange={(v) => set('scope', v)} />
              </Row>
            )}

            {mode === 'psd' && (
              <>
                <Row label={t('Format')}>
                  <Seg value={prefs.psdFormat} options={tOpts(t, PSD_FORMATS)} onChange={(v) => set('psdFormat', v)} />
                </Row>
                <CheckRow
                  label={t('Split titles')}
                  value={prefs.splitTitles}
                  onChange={(v) => set('splitTitles', v)}
                  title={t('Each 2D title becomes a group: every rim alone, the face alone (hidden, each with its own part effects) and the full layer with effects (fx)')}
                />
                {prefs.psdFormat === 'parts' && (
                  <CheckRow label={t('ASCII only')} value={prefs.ascii} onChange={(v) => set('ascii', v)} title={t('Half-width part file names (non-ASCII layer names become layerNN)')} />
                )}
                <div className="notes muted">
                  {t(
                    'All layers share one canvas and register. Layer groups stay groups, nested as in the app; a group with effects keeps its members hidden under its baked render (fx). Clipped layers keep their clipping masks (layers clipped to a group are written already masked). Adjustment layers stay Photoshop adjustment layers; one Photoshop can\'t express is baked into a pixel layer “(baked)” over the layers it covers, which are hidden. Registered PNGs always bake adjustment layers. Blend modes map to Photoshop (add → Linear Dodge); Photoshop blends in sRGB, so add / screen layers can look slightly different there.',
                  )}
                </div>
              </>
            )}

            {mode === 'svg' ? (
              <div className="notes muted">
                {t('Face outlines of text and shape layers at source size (styles, rims and effects are not included). Several layers export as a ZIP.')}
              </div>
            ) : (
              <div className="xp-group">{delivery}</div>
            )}

            {!project.comp.background.transparent && mode !== 'svg' && !perLayer && (
              <div className="notes muted">
                {t('Comp background is opaque ({color}); turn on transparency in comp settings for alpha PNGs.', { color: project.comp.background.color })}
              </div>
            )}
            {blocker && <div className="notes muted">{formatMsg(blocker, t)}</div>}
            {progress && (
              <div className="progress">
                <div className="bar" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
                <span>
                  {progress.done} / {progress.total}
                </span>
              </div>
            )}
            {status && <div className={`status ${status.error ? 'error' : 'muted'}`}>{formatMsg(status.text, t)}</div>}
          </fieldset>
        </div>
        <div className="modal-foot xp-foot">
          <span className="xp-local muted" title={t('Rendering, fonts and exported files stay in this browser; the app makes no network requests')}>
            {t('Local only — nothing leaves this computer')}
          </span>
          {busy ? (
            <button onClick={() => abortRef.current?.abort()}>{t('Cancel')}</button>
          ) : (
            <>
              <button onClick={onClose}>{t('Close')}</button>
              <button disabled={!!blocker || !copyable} onClick={() => void copy()} title={copyTitle}>
                {t('Copy')}
              </button>
              <button className="primary" disabled={!!blocker} onClick={() => void run()}>
                {t('Export')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
