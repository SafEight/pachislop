import { zip, type AsyncZippable } from 'fflate';
import { ensureFont } from '../assets/registry';
import { preloadTitle2D } from '../engine/layer2d/Title2DRenderer';
import { onEnvironmentReady } from '../engine/three/environment';
import { modelStatus } from '../engine/three/Layer3DRenderer';
import { effectFillsComp } from '../effects/registry';
import { drawnLayers, drawTree, type DrawNode, type LeafLayer } from '../engine/drawTree';
import type { Engine } from '../engine/Engine';
import type { ImageData16 } from '../engine/readback';
import { generatorFillsComp, generatorParams, getGenerator } from '../generators/registry';
import { isTitleLayer } from '../model/parts';
import type { EffectInstance, Layer, Project, Title2DLayer, Title3DLayer } from '../model/types';
import { english, errorMsg, formatMsg, joinMsgs, msg, MsgError, type Msg, type MsgList } from '../store/msg';
import { ancestorsOf, clipBaseOf, clippedTo, isClipped, withDescendants } from '../store/tree';
import { titleToSVG } from '../text/svgExport';
import { adler32Combine, writeChunk } from './pngChunk';
import type { PngPixels, PngReply, PngRequest, PngShare } from './pngWorker';

// Still export at any scale (82%, 2×…), optional trim-to-content (rendered on an enlarged comp
// so glows/fire/shadows never clip at the canvas edge), sides rounded to a multiple of 4/8 px,
// 8- or 16-bit PNG, and per-layer PNG parts (each layer trimmed alone).
//
// Enlarging works because comp coordinates are centre-relative: a project whose comp is
// larger keeps every layer where it was relative to the centre. The camera FOV is widened in
// step so the 3D projection (camera distance, px per unit at z = 0) is unchanged.
//
// Every output is a `Frame`: a rectangle in output px relative to the comp centre. Any render
// of the same comp into the same frame registers pixel-for-pixel, which is what same-size layer
// parts and the layered PSD (psd.ts) rely on.

/** Output sides are padded to a multiple of this many px (CGWORLD delivery practice: 4 or 8). */
export type RoundTo = 1 | 4 | 8;

/** Bits per channel of exported pixels. */
export type BitDepth = 8 | 16;

/** Exported pixels: straight-alpha sRGB RGBA, top row first, at 8 (ImageData) or 16 bits per channel. */
export type ExportImage = ImageData | ImageData16;

export interface StillOptions {
  /** Output pixels per comp pixel, any positive factor (0.82 = 82%). Reduced with a warning when above the GPU limit. */
  scale: number;
  /** Crop to the content's bounding box (+ `padding`) after rendering on an enlarged canvas. */
  trim: boolean;
  /** Padding around trimmed content, in comp px (multiplied by the scale). */
  padding: number;
  /** Pad the output symmetrically (around the content centre) so both sides are multiples of this, in output px. */
  roundTo: RoundTo;
  /**
   * Alpha (1..255) a pixel needs to count as content when trimming: faint 3D haze and glow tails
   * below it don't extend the box (they are still drawn inside it).
   */
  trimAlpha: number;
  /** Print page: replaces `scale`, `trim` and `roundTo` (the comp scaled to cover the page, centred). */
  print: PrintSize | null;
  /** Render guide layers too (normally excluded from exports). */
  includeGuides: boolean;
  /**
   * Bits per channel (default 8). 8-bit output is dithered before the quantize; 16-bit output is
   * read back undithered from the float composite. Trimming always measures on 8-bit renders.
   */
  bitDepth?: BitDepth;
  signal?: AbortSignal;
}

/** Print page size; the resolution is the comp's `dpi`. */
export interface PrintSize {
  /** Trimmed page size in mm. */
  widthMm: number;
  heightMm: number;
  /** Bleed added on every side, in mm (0 = none; 3 is the Japanese print standard 塗り足し). */
  bleedMm: number;
}

/** Default `trimAlpha`: 8/255 ≈ 3 % opacity. */
export const DEFAULT_TRIM_ALPHA = 8;
/** Standard print bleed (塗り足し), mm. */
export const PRINT_BLEED_MM = 3;

/** Whole px for `mm` at `dpi`. */
export const mmToPx = (mm: number, dpi: number) => Math.round((mm / 25.4) * dpi);
export const pxToMm = (px: number, dpi: number) => (px / dpi) * 25.4;

/** Output px of a print page at `dpi`: the trimmed page and the bleed per side. */
export function printPixels(p: PrintSize, dpi: number): { w: number; h: number; bleed: number } {
  return { w: Math.max(1, mmToPx(p.widthMm, dpi)), h: Math.max(1, mmToPx(p.heightMm, dpi)), bleed: Math.max(0, mmToPx(p.bleedMm, dpi)) };
}

/** Output px per comp px so the comp covers the trimmed page. */
export function printScale(p: PrintSize, dpi: number, compW: number, compH: number): number {
  const { w, h } = printPixels(p, dpi);
  return Math.max(w / compW, h / compH);
}

export interface StillResult {
  image: ExportImage;
  /** Every warning of the render, joined with “; ”. */
  warning?: MsgList;
}

// ---------------------------------------------------------------------------------------------
// Files

/**
 * PNG encoder workers (pngWorker.ts): deflate is CPU-bound, so it runs off the main thread, a
 * large image is deflated in row bands on every worker at once, and batches (layer parts, PNG
 * ZIPs) encode in parallel while the next item renders. One core is left to the main
 * thread. A 4× export (5010 × 4320) took 2.2 s on 4 workers, 1.8 s on 7 (8-core Chromium).
 */
const PNG_WORKERS = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1));

/** Images up to this many px are one band: splitting them saves little and costs a band boundary each. */
const PNG_BAND_PIXELS = 1 << 20;

type PngBand = Extract<PngReply, { idat: unknown }>;

/** One `pngBytes` call, whose bands are jobs. */
interface PngEncode {
  /** Takes the reply for band `band`. */
  done: (band: number, reply: PngBand) => void;
  /** Ends the encode with `e`, cancelling its other jobs. */
  fail: (e: unknown) => void;
}

interface PngJob {
  request: PngRequest;
  /** The request's pixel buffer or port, and the top band's ports to the others. */
  transfer: Transferable[];
  encode: PngEncode;
  /** Index of the band in its encode, top first. */
  band: number;
}

interface PngSlot {
  worker: Worker;
  job: PngJob | null;
  /** Until the worker reports `ready`. */
  loading: boolean;
}

/** Jobs waiting for a free worker, oldest first. */
const pngQueue: PngJob[] = [];
/** Live workers (at most PNG_WORKERS), created on demand and kept for later exports. */
const pngSlots: PngSlot[] = [];

/** Drops a failed or cancelled worker; its replacement is created by the next job. */
function retirePng(slot: PngSlot) {
  slot.worker.terminate();
  pngSlots.splice(pngSlots.indexOf(slot), 1);
}

/** Removes `encode`'s queued jobs and stops the workers running its others. */
function cancelPng(encode: PngEncode) {
  for (let k = pngQueue.length - 1; k >= 0; k--) if (pngQueue[k].encode === encode) pngQueue.splice(k, 1);
  for (const slot of pngSlots.filter((s) => s.job?.encode === encode)) retirePng(slot);
}

function startPngWorker(): PngSlot {
  const slot: PngSlot = { worker: new Worker(new URL('./pngWorker.ts', import.meta.url), { type: 'module' }), job: null, loading: true };
  const fail = (e: MsgError) => {
    const job = slot.job;
    retirePng(slot);
    job?.encode.fail(e);
    pumpPng();
  };
  slot.worker.onmessage = (e: MessageEvent<PngReply>) => {
    if ('ready' in e.data) {
      slot.loading = false;
      pumpPng();
      return;
    }
    const job = slot.job!;
    slot.job = null;
    if ('idat' in e.data) job.encode.done(job.band, e.data);
    else job.encode.fail(new MsgError(msg('PNG encoding failed: {error}', { error: e.data.error })));
    pumpPng();
  };
  // Uncaught worker errors only happen while loading it (the encoder reports its own); a load failure is a plain Event.
  slot.worker.onerror = (e) => fail(new MsgError(e.message ? msg('PNG encoding failed: {error}', { error: e.message }) : msg('The PNG encoder could not start')));
  slot.worker.onmessageerror = () => fail(new MsgError(msg('PNG encoding failed: {error}', { error: 'unreadable reply from the encoder' })));
  pngSlots.push(slot);
  return slot;
}

/**
 * Hands queued jobs to idle workers, starting workers up to PNG_WORKERS one at a time: Chromium
 * (150) fails to load all but one of several workers started at once from the same script.
 */
function pumpPng() {
  while (pngQueue.length) {
    let slot = pngSlots.find((s) => !s.job);
    if (!slot && pngSlots.length < PNG_WORKERS && !pngSlots.some((s) => s.loading)) {
      try {
        slot = startPngWorker();
      } catch (e) {
        // e.g. a CSP forbidding workers: a real failure for this job, not a reason to encode on the main thread.
        pngQueue.shift()!.encode.fail(new MsgError(msg('PNG encoding failed: {error}', { error: errorMsg(e) })));
        continue;
      }
    }
    if (!slot) return;
    const job = pngQueue.shift()!;
    slot.job = job;
    // A loading worker takes its job too: the message waits for its script.
    slot.worker.postMessage(job.request, job.transfer);
  }
}

/**
 * PNG bytes: IHDR (8- or 16-bit RGBA), sRGB (perceptual), pHYs (`dpi`), the IDAT chunk of each
 * band (`rows` rows each), then for several bands an IDAT with the zlib stream's Adler-32, and IEND.
 */
function assemblePng(w: number, h: number, depth: BitDepth, dpi: number, bands: PngBand[], rows: number[]): Uint8Array<ArrayBuffer> {
  const idatLength = bands.reduce((n, b) => n + b.idat.length, 0);
  const trailer = bands.length > 1 ? 12 + 4 : 0;
  // Signature + IHDR, sRGB, pHYs, the IDATs, IEND: each chunk is 12 bytes around its data.
  const png = new Uint8Array(8 + (12 + 13) + (12 + 1) + (12 + 9) + idatLength + trailer + 12);
  const view = new DataView(png.buffer);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let at = writeChunk(png, 8, 'IHDR', 13, (o) => {
    view.setUint32(o, w);
    view.setUint32(o + 4, h);
    png.set([depth, 6, 0, 0, 0], o + 8); // bit depth, RGBA, deflate, standard filtering, no interlace
  });
  at = writeChunk(png, at, 'sRGB', 1, (o) => (png[o] = 0)); // perceptual
  // Pixels per metre (unit 1), so Photoshop and print RIPs open the file at its size.
  const ppm = Math.max(1, Math.round(dpi / 0.0254));
  at = writeChunk(png, at, 'pHYs', 9, (o) => {
    view.setUint32(o, ppm);
    view.setUint32(o + 4, ppm);
    png[o + 8] = 1;
  });
  for (const b of bands) {
    png.set(b.idat, at);
    at += b.idat.length;
  }
  if (trailer) {
    // Each band's checksum covers its filtered rows: a filter-type byte and w × 4 samples each.
    let adler = bands[0].adler;
    for (let k = 1; k < bands.length; k++) adler = adler32Combine(adler, bands[k].adler, rows[k] * (1 + (w * 4 * depth) / 8));
    at = writeChunk(png, at, 'IDAT', 4, (o) => view.setUint32(o, adler));
  }
  writeChunk(png, at, 'IEND', 0, () => {});
  return png;
}

/**
 * PNG bytes of `img` (straight-alpha sRGB RGBA, 8 or 16 bits per channel) with an `sRGB` chunk
 * and a `pHYs` chunk (`dpi`), encoded losslessly on the workers (see pngWorker.ts); the RGB of
 * fully transparent pixels is written as 0. An image over PNG_BAND_PIXELS is split into one row
 * band per worker, deflated in parallel. The pixel buffer is transferred to the worker with the
 * top band, not copied, and that worker copies the other bands' rows to theirs: `img` is the
 * encoder's from this call on and must not be used afterwards. `signal` cancels the encode,
 * stopping its workers mid-encode.
 */
export function pngBytes(img: ExportImage, dpi: number, signal?: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const { width: w, height: h } = img;
    const data: PngPixels = img.data;
    const depth = depthOf(img);
    const count = Math.max(1, Math.min(PNG_WORKERS, h, Math.ceil((w * h) / PNG_BAND_PIXELS)));
    const rows = Array.from({ length: count }, (_, k) => Math.round((h * (k + 1)) / count) - Math.round((h * k) / count));
    const bands: PngBand[] = [];
    let left = count;
    const onAbort = () => {
      encode.fail(abortError());
      pumpPng();
    };
    const encode: PngEncode = {
      done: (band, reply) => {
        bands[band] = reply;
        if (--left) return;
        signal?.removeEventListener('abort', onAbort);
        resolve(assemblePng(w, h, depth, dpi, bands, rows));
      },
      fail: (e) => {
        signal?.removeEventListener('abort', onAbort);
        cancelPng(encode);
        reject(e);
      },
    };
    const share: PngShare[] = [];
    const jobs: PngJob[] = [];
    for (let k = 1, y = rows[0]; k < count; y += rows[k++]) {
      const { port1, port2 } = new MessageChannel();
      share.push({ port: port1, y, h: rows[k] });
      jobs.push({ request: { w, h: rows[k], data: port2, share: [], first: false, last: k === count - 1 }, transfer: [port2], encode, band: k });
    }
    jobs.unshift({ request: { w, h: rows[0], data, share, first: true, last: count === 1 }, transfer: [data.buffer, ...share.map((s) => s.port)], encode, band: 0 });
    signal?.addEventListener('abort', onAbort, { once: true });
    // Queued top band first: the other bands' workers wait for the rows it sends.
    pngQueue.push(...jobs);
    pumpPng();
  });
}

/** `pngBytes` as a PNG Blob. */
export async function encodePng(img: ExportImage, dpi: number, signal?: AbortSignal): Promise<Blob> {
  return new Blob([(await pngBytes(img, dpi, signal)) as Uint8Array<ArrayBuffer>], { type: 'image/png' });
}

/**
 * The PNG files of a batch export, encoded on the worker pool while the caller renders the next
 * item. `add` hands the image to `pngBytes` (don't use it afterwards) and then waits while jobs
 * queue for a busy pool (every worker has a frame or a band of one), so raw frames don't pile up
 * in memory; it throws once an earlier encode has failed. `files` resolves with every file in
 * `add` order.
 */
export function pngBatch(dpi: number, signal?: AbortSignal) {
  const files: Promise<{ name: string; data: Uint8Array }>[] = [];
  const pending = new Set<Promise<void>>();
  let failure: { error: unknown } | null = null;
  return {
    async add(name: string, image: ExportImage): Promise<void> {
      const file = pngBytes(image, dpi, signal).then((data) => ({ name, data }));
      files.push(file);
      // Also marks `file` handled: its failure surfaces from `add` / `files`, never as unhandled when the batch stops early.
      const settled: Promise<void> = file.then(
        () => void pending.delete(settled),
        (error: unknown) => {
          pending.delete(settled);
          failure ??= { error };
        },
      );
      pending.add(settled);
      while (pngQueue.length && pending.size && !failure) await Promise.race(pending);
      if (failure) throw failure.error;
    },
    files: () => Promise.all(files),
  };
}

/** Stored (level 0) ZIP: PNGs are already deflated. */
export function zipFiles(files: { name: string; data: Uint8Array }[]): Promise<Blob> {
  const tree: AsyncZippable = {};
  for (const f of files) tree[f.name] = f.data;
  return new Promise((resolve, reject) => {
    zip(tree, { level: 0 }, (err, out) => (err ? reject(err) : resolve(new Blob([out as Uint8Array<ArrayBuffer>], { type: 'application/zip' }))));
  });
}

/** Strips characters that are illegal in file names on common filesystems; keeps CJK etc. Empty when nothing is left. */
export function safeWordName(word: string): string {
  // eslint-disable-next-line no-control-regex
  return word.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '').trim().replace(/\s+/g, '_').replace(/^\.+/, '');
}

/**
 * Half-width (ASCII) file-name form of `s`: NFKC folds full-width letters, digits and symbols
 * (＋１００Ｇ → +100G) and × becomes x. Null when anything non-ASCII remains (CJK words).
 */
export function asciiName(s: string): string | null {
  const t = safeWordName(s.normalize('NFKC').replace(/[×✕✖]/g, 'x'));
  return /^[\x21-\x7e]+$/.test(t) ? t : null;
}

const pad = (n: number, total: number) => String(n).padStart(String(total).length, '0');

/** `stem`, or `stem_2`, `stem_3`… when already used. */
export function uniqueStem(stem: string, used: Set<string>): string {
  let out = stem;
  for (let n = 2; used.has(out.toLowerCase()); n++) out = `${stem}_${n}`;
  used.add(out.toLowerCase());
  return out;
}

// ---------------------------------------------------------------------------------------------
// Abort / pacing

export const isAbortError = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/** The error a cancelled export rejects with (see isAbortError). */
const abortError = () => new DOMException('Export cancelled', 'AbortError');

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

/** Macrotask yield so React can paint progress between items. */
export const yieldToUI = () => new Promise<void>((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------------------------
// Rendering helpers

const DEG = Math.PI / 180;
/** Engine clamps the vertical FOV to 170°; keep the widened FOV below that. */
const MAX_FOV = 170;
/** Longest side of the low-resolution probe render used to size the trimmed canvas. */
const PROBE_MAX = 2048;

/** Every title / background layer the engine draws (group members and clipped layers included), in stack order. */
export function renderedLeaves(project: Project, includeGuides: boolean): LeafLayer[] {
  return drawnLayers(drawTree(project, includeGuides)).filter((l): l is LeafLayer => l.kind !== 'group' && l.kind !== 'adjustment');
}

/** How long an export waits for an HDRI environment to finish loading before rendering without it. */
const ENV_TIMEOUT_MS = 20_000;

/** Resolves true once every environment 3D layers and their parts render with (model/lighting.ts) is ready (or false after the timeout). */
function waitForEnvironment(engine: Engine, project: Project): Promise<boolean> {
  if (engine.environmentReady(project)) return Promise.resolve(true);
  // lib is ES2023 (no Promise.withResolvers typing): executor form keeps timeout + unsubscribe together.
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      unsub();
      resolve(false);
    }, ENV_TIMEOUT_MS);
    const unsub = onEnvironmentReady(() => {
      if (!engine.environmentReady(project)) return;
      clearTimeout(timer);
      unsub();
      resolve(true);
    });
  });
}

/** How long an export waits for GLB models to finish parsing before rendering without them. */
const MODEL_TIMEOUT_MS = 20_000;

/** Resolves once every drawn GLB model has parsed or failed (or after the timeout) with the model layers that will draw nothing. */
async function waitForModels(engine: Engine, project: Project, includeGuides: boolean, layers: LeafLayer[]): Promise<Title3DLayer[]> {
  const models = layers.filter((l): l is Title3DLayer => l.kind === 'title3d' && l.source.kind === 'model');
  if (models.length === 0) return [];
  let timer = 0;
  const timeout = new Promise<void>((resolve) => {
    timer = window.setTimeout(resolve, MODEL_TIMEOUT_MS);
  });
  await Promise.race([engine.modelsReady(project, includeGuides), timeout]);
  clearTimeout(timer);
  return models.filter((l) => l.source.kind === 'model' && modelStatus(l.source.assetId) !== 'loaded');
}

/**
 * Loads every font used by a rendered text layer, decodes image sources (2D and 3D: the 3D trace
 * and face image read the same cache) and parses GLB models (renderers draw nothing until then).
 * Returns warnings for unknown fonts and for what did not load in time.
 */
export async function prepareRender(engine: Engine, project: Project, includeGuides: boolean): Promise<Msg[]> {
  const warnings: Msg[] = [];
  const layers = renderedLeaves(project, includeGuides);
  for (const l of layers) {
    if (l.kind === 'generator') {
      for (const id of getGenerator(l.generator.type)?.fonts?.(generatorParams(l.generator)) ?? []) await ensureFont(id);
      continue;
    }
    if (!isTitleLayer(l) || l.source.kind !== 'text') continue;
    const font = await ensureFont(l.source.fontId);
    if (!font) warnings.push(msg('Layer "{name}": font "{font}" is not available, so it renders empty', { name: l.name, font: l.source.fontId }));
  }
  await preloadTitle2D(project);
  const [envReady, missingModels] = await Promise.all([
    layers.some((l) => l.kind === 'title3d') ? waitForEnvironment(engine, project) : true,
    waitForModels(engine, project, includeGuides, layers),
  ]);
  if (!envReady) warnings.push(msg('3D environment (HDRI) did not finish loading — reflections rendered without it'));
  for (const l of missingModels) warnings.push(msg('Model “{name}” was not ready and is missing from the export', { name: l.name }));
  return warnings;
}

/** Same project on a comp of `w × h` comp px around the same centre, with the same 3D projection. */
function enlarged(project: Project, w: number, h: number): Project {
  const { comp } = project;
  if (w === comp.width && h === comp.height) return project;
  const fov = 2 * Math.atan((h / comp.height) * Math.tan((comp.camera.fov * DEG) / 2)) / DEG;
  return { ...project, comp: { ...comp, width: w, height: h, camera: { ...comp.camera, fov } } };
}

/** Largest comp height for which the widened FOV stays within the engine's clamp. */
function maxHeightForFov(project: Project): number {
  const { height, camera } = project.comp;
  const fov = Math.min(MAX_FOV, Math.max(1, camera.fov));
  return Math.floor((height * Math.tan(((MAX_FOV - 1) * DEG) / 2)) / Math.tan((fov * DEG) / 2));
}

/** True when the composite has opaque pixels independent of the titles (comp colour / background layers). */
function hasOpaqueBackdrop(project: Project, includeGuides: boolean): boolean {
  return !project.comp.background.transparent || renderedLeaves(project, includeGuides).some((l) => l.kind === 'background');
}

/** The project without its backdrop: transparent comp, background layers and their companions (rays on them) hidden. Used to measure content. */
function withoutBackdrop(project: Project): Project {
  const backdrops = new Set(project.layers.filter((l) => l.kind === 'background').map((l) => l.id));
  return {
    ...project,
    comp: { ...project.comp, background: { ...project.comp.background, transparent: true } },
    layers: project.layers.map((l) => (l.kind === 'background' || (l.kind === 'generator' && l.companionOf && backdrops.has(l.companionOf)) ? { ...l, visible: false } : l)),
  };
}

interface Bounds {
  /** Inclusive start, exclusive end, in pixels. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Output rectangle in output px relative to the comp centre (+y down, like image rows). `w` and
 * `h` are whole px; `x`/`y` may be half px when a canvas side is odd.
 */
export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Bounding box of pixels with alpha ≥ `minAlpha` (1..255), or null when there are none. */
function alphaBounds(img: ImageData, minAlpha: number): Bounds | null {
  const { width: w, height: h } = img;
  // RGBA bytes read as little-endian u32: alpha is the top byte.
  const px = new Uint32Array(img.data.buffer, img.data.byteOffset, w * h);
  const min = Math.min(255, Math.max(1, Math.round(minAlpha))) * 0x1000000;
  const rowEmpty = (y: number) => {
    for (let i = y * w, end = i + w; i < end; i++) if (px[i] >= min) return false;
    return true;
  };
  let y0 = 0;
  while (y0 < h && rowEmpty(y0)) y0++;
  if (y0 === h) return null;
  let y1 = h;
  while (rowEmpty(y1 - 1)) y1--;
  let x0 = w;
  let x1 = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * w;
    for (let x = 0; x < x0; x++) {
      if (px[row + x] >= min) {
        x0 = x;
        break;
      }
    }
    for (let x = w - 1; x >= x1; x--) {
      if (px[row + x] >= min) {
        x1 = x + 1;
        break;
      }
    }
  }
  return { x0, y0, x1, y1 };
}

/** Transparent `w × h` pixels at `depth` bits per channel. */
export function blankImage(depth: BitDepth, w: number, h: number): ExportImage {
  return depth === 16 ? { width: w, height: h, data: new Uint16Array(w * h * 4) } : new ImageData(w, h);
}

/** Bits per channel of `img`. */
export const depthOf = (img: ExportImage): BitDepth => (img.data instanceof Uint16Array ? 16 : 8);

/** Some pixel of `img` is not fully transparent. */
function hasPixels(img: ExportImage): boolean {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i]) return true;
  return false;
}

/** `w × h` window of `img` at (x0, y0), at its bit depth; parts outside the image are transparent. */
function cropImage(img: ExportImage, x0: number, y0: number, w: number, h: number): ExportImage {
  if (x0 === 0 && y0 === 0 && w === img.width && h === img.height) return img;
  const out = blankImage(depthOf(img), w, h);
  const sx0 = Math.max(0, x0);
  const sx1 = Math.min(img.width, x0 + w);
  if (sx1 <= sx0) return out;
  for (let y = 0; y < h; y++) {
    const sy = y0 + y;
    if (sy < 0 || sy >= img.height) continue;
    const row = sy * img.width;
    out.data.set(img.data.subarray((row + sx0) * 4, (row + sx1) * 4), (y * w + sx0 - x0) * 4);
  }
  return out;
}

/** Top-left pixel of `f` in a canvas render of `width × height`. */
const frameOrigin = (f: Frame, width: number, height: number) => ({ x: Math.round(width / 2 + f.x), y: Math.round(height / 2 + f.y) });

function cropFrame(img: ExportImage, f: Frame): ExportImage {
  const o = frameOrigin(f, img.width, img.height);
  return cropImage(img, o.x, o.y, f.w, f.h);
}

function fitsIn(img: ImageData, f: Frame): boolean {
  const o = frameOrigin(f, img.width, img.height);
  return o.x >= 0 && o.y >= 0 && o.x + f.w <= img.width && o.y + f.h <= img.height;
}

/** Pads `f` symmetrically (odd remainders go right / down) so both sides are multiples of `m`. */
export function roundFrame(f: Frame, m: RoundTo): Frame {
  const w = Math.ceil(f.w / m) * m;
  const h = Math.ceil(f.h / m) * m;
  return { x: f.x - Math.floor((w - f.w) / 2), y: f.y - Math.floor((h - f.h) / 2), w, h };
}

/** Smallest frame containing both. */
export function unionFrame(a: Frame | null, b: Frame): Frame {
  if (!a) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.ceil(Math.max(a.x + a.w, b.x + b.w) - x), h: Math.ceil(Math.max(a.y + a.h, b.y + b.h) - y) };
}

/** Thrown when a render has no pixels to export. */
class NothingToExport extends MsgError {
  constructor() {
    super(msg('Nothing to export: every exported layer is empty, hidden or a guide'));
  }
}

// ---------------------------------------------------------------------------------------------
// Export context: one comp, one scale, one set of canvas limits for every render of an export

export interface ExportContext {
  engine: Engine;
  /** Comp size in comp px. */
  cw: number;
  ch: number;
  /** Output px per comp px after the GPU clamp. */
  scale: number;
  includeGuides: boolean;
  /** Trim threshold, alpha 1..255 (StillOptions.trimAlpha). */
  trimAlpha: number;
  /** Print page frame (replaces the comp frame), or null. */
  page: Frame | null;
  /** Largest canvas margins per side, in comp px (GPU texture limit; FOV clamp with 3D layers). */
  mxMax: number;
  myMax: number;
  maxTex: number;
  signal?: AbortSignal;
  /** Bits per channel of renderFrame's output (measuring renders are always 8-bit). */
  depth: BitDepth;
  /** Export-wide warnings (scale reduced, clipping), deduplicated by their English text; add with `warn`. */
  warnings: Map<string, Msg>;
}

/**
 * Checks the scale against the GPU limit and derives the canvas limits from `project` (every
 * project later rendered with this context must share its comp and layer kinds). Assets are
 * loaded separately per project with `prepareRender`.
 */
export function exportContext(engine: Engine, project: Project, opts: StillOptions): ExportContext {
  const { width: cw, height: ch, dpi } = project.comp;
  if (opts.print && !(opts.print.widthMm > 0 && opts.print.heightMm > 0 && dpi > 0)) throw new MsgError(msg('Print size and resolution must be above 0'));
  let scale = opts.print ? printScale(opts.print, dpi, cw, ch) : opts.scale;
  if (!(scale > 0) || !Number.isFinite(scale)) throw new MsgError(msg('Scale must be a positive number'));
  const warnings = new Map<string, Msg>();
  const maxTex = engine.renderer.capabilities.maxTextureSize;
  const fit = Math.min(maxTex / cw, maxTex / ch);
  if (scale > fit) {
    scale = Math.floor(fit * 100) / 100;
    const m = msg('Scale reduced to {pct}% (GPU texture limit {max}px)', { pct: Math.round(scale * 100), max: maxTex });
    warnings.set(formatMsg(m, english), m);
  }
  // Comp-px canvas limits at the final scale (and the FOV clamp when 3D layers are present).
  const maxW = Math.max(cw, Math.floor(maxTex / scale));
  const has3D = project.layers.some((l) => l.kind === 'title3d');
  const maxH = Math.max(ch, Math.min(Math.floor(maxTex / scale), has3D ? maxHeightForFov(project) : Infinity));
  return {
    engine,
    cw,
    ch,
    scale,
    includeGuides: opts.includeGuides,
    trimAlpha: opts.trimAlpha,
    page: opts.print ? pageFrame(opts.print, dpi) : null,
    // Margins are whole comp px per side so the comp centre stays on the same pixel grid.
    mxMax: Math.floor((maxW - cw) / 2),
    myMax: Math.floor((maxH - ch) / 2),
    maxTex,
    signal: opts.signal,
    depth: opts.bitDepth ?? 8,
    warnings,
  };
}

/** Adds an export-wide warning once. */
const warn = (c: ExportContext, m: Msg) => void c.warnings.set(formatMsg(m, english), m);

const clippedWarning = (c: ExportContext) =>
  msg('Content reaches the largest renderable canvas (GPU limit {max}px) and may be clipped; lower the scale', { max: c.maxTex });

function renderCanvas(c: ExportContext, project: Project, mx: number, my: number, s = c.scale): ImageData {
  return c.engine.renderImageData(enlarged(project, c.cw + 2 * mx, c.ch + 2 * my), { scale: s, includeGuides: c.includeGuides });
}

/** A print page (trim size + bleed per side) as a frame centred on the comp. */
function pageFrame(p: PrintSize, dpi: number): Frame {
  const { w, h, bleed } = printPixels(p, dpi);
  return { x: -(w + 2 * bleed) / 2, y: -(h + 2 * bleed) / 2, w: w + 2 * bleed, h: h + 2 * bleed };
}

/** The comp itself as a frame (the print page in print mode). */
export function compFrame(c: ExportContext): Frame {
  if (c.page) return c.page;
  const w = Math.max(1, Math.round(c.cw * c.scale));
  const h = Math.max(1, Math.round(c.ch * c.scale));
  return { x: -w / 2, y: -h / 2, w, h };
}

/** Smallest canvas margins (comp px per side) whose render contains `f`, within the limits. */
function marginsFor(c: ExportContext, f: Frame): { mx: number; my: number; clipped: boolean } {
  const need = (ext: number, comp: number, max: number) => {
    let m = Math.max(0, Math.ceil(ext / c.scale - comp / 2));
    while (m < max && Math.round((comp + 2 * m) * c.scale) < 2 * ext) m++;
    m = Math.min(m, max);
    return { m, short: Math.round((comp + 2 * m) * c.scale) < 2 * ext };
  };
  const x = need(Math.max(-f.x, f.x + f.w), c.cw, c.mxMax);
  const y = need(Math.max(-f.y, f.y + f.h), c.ch, c.myMax);
  return { mx: x.m, my: y.m, clipped: x.short || y.short };
}

/**
 * Renders `project` into `f` at the context's bit depth. Registers pixel-for-pixel with every
 * other render into the same frame.
 */
export async function renderFrame(c: ExportContext, project: Project, f: Frame): Promise<ExportImage> {
  await yieldToUI();
  throwIfAborted(c.signal);
  const { mx, my, clipped } = marginsFor(c, f);
  if (clipped) warn(c, clippedWarning(c));
  if (c.depth === 8) return cropFrame(renderCanvas(c, project, mx, my), f);
  return cropFrame(c.engine.renderImageData16(enlarged(project, c.cw + 2 * mx, c.ch + 2 * my), { scale: c.scale, includeGuides: c.includeGuides }), f);
}

/**
 * The combined enabled masks of layer `layerId` of `project` in `f` (registered with renderFrame):
 * opaque 8-bit greyscale, r = g = b = 255 where the layer shows.
 */
export async function renderMaskFrame(c: ExportContext, project: Project, layerId: string, f: Frame): Promise<ImageData> {
  await yieldToUI();
  throwIfAborted(c.signal);
  const { mx, my } = marginsFor(c, f);
  // An 8-bit render crops to an 8-bit image.
  return cropFrame(c.engine.renderLayerMask(enlarged(project, c.cw + 2 * mx, c.ch + 2 * my), layerId, { scale: c.scale }), f) as ImageData;
}

interface Measured {
  /** Content + padding (not rounded). */
  frame: Frame;
  /** Full-scale render the frame was measured on. */
  img: ImageData;
  /** `img` is the final look (nothing had to be removed for measuring). */
  exact: boolean;
}

/** Bounds `b` of an image reach both opposite edges (a band wider or taller than the image). */
const spansImage = (b: Bounds, img: ImageData) => (b.x0 === 0 && b.x1 === img.width) || (b.y0 === 0 && b.y1 === img.height);
const touchesEdge = (b: Bounds, img: ImageData) => b.x0 === 0 || b.y0 === 0 || b.x1 === img.width || b.y1 === img.height;

/** `project` with the top-level layers `ids` hidden (a hidden group hides its subtree, a hidden clip base its clipped layers). */
function hideItems(project: Project, ids: ReadonlySet<string>): Project {
  return { ...project, layers: project.layers.map((l) => (ids.has(l.id) ? { ...l, visible: false } : l)) };
}

/** `project` drawing only the top-level `nodes` with their subtrees and clipped layers (others hidden, not removed, so their renderer caches stay). */
function onlyItems(project: Project, nodes: readonly DrawNode[]): Project {
  const keep = new Set(drawnLayers(nodes).map((l) => l.id));
  return { ...project, layers: project.layers.map((l) => (keep.has(l.id) || !l.visible ? l : { ...l, visible: false })) };
}

const fillsComp = (effects: readonly EffectInstance[] | undefined) => !!effects?.some(effectFillsComp);
/**
 * The layer fills the comp: a full-frame generator (generatorFillsComp), or an effect of it or of one of
 * its style parts does (an adjustment layer's effects too). Unknown generator types draw nothing.
 */
export function layerFillsComp(l: Layer): boolean {
  if (l.kind === 'generator' && generatorFillsComp(l.generator)) return true;
  return fillsComp(l.effects) || (isTitleLayer(l) && Object.values(l.partEffects).some(fillsComp));
}

/** Longest side of the comp-size probe used to find full-bleed items. */
const BLEED_PROBE_MAX = 512;

/**
 * Top-level nodes that would fill any canvas they are rendered on, so trimming can never contain
 * them: a node with a full-frame generator or an effect that fills the comp anywhere in its subtree
 * or clip group (focus / burst rays behind a cut-in band, a 柄 fill, such an effect on an
 * adjustment layer inside it), or one whose comp-size render spans the comp from edge to edge (a
 * band wider than the comp). A top-level adjustment layer runs its effects on everything below
 * it, so one whose effects fill the comp makes itself and every node below it full-bleed (the
 * conservative route: they are measured clipped to the comp together). The geometric test only
 * runs when the whole comp-size render reaches an edge at all; adjustment layers draw nothing
 * alone and are never full-bleed by it.
 */
function fullBleedNodes(c: ExportContext, project: Project): DrawNode[] {
  const nodes = drawTree(project, c.includeGuides);
  const below = nodes.findLastIndex((n) => n.kind === 'adjust' && layerFillsComp(n.layer));
  const bleed = nodes.filter((n, i) => i <= below || drawnLayers([n]).some(layerFillsComp));
  const s = Math.min(c.scale, BLEED_PROBE_MAX / Math.max(c.cw, c.ch));
  const all = renderCanvas(c, bleed.length ? hideItems(project, new Set(bleed.map((n) => n.layer.id))) : project, 0, 0, s);
  const b = alphaBounds(all, c.trimAlpha);
  if (!b || !touchesEdge(b, all)) return bleed;
  for (const n of nodes) {
    if (n.kind === 'adjust' || bleed.includes(n)) continue;
    const img = renderCanvas(c, onlyItems(project, [n]), 0, 0, s);
    const ib = alphaBounds(img, c.trimAlpha);
    if (ib && spansImage(ib, img)) bleed.push(n);
  }
  return bleed;
}

/**
 * Measures the trimmed content of `project` (pixels with alpha ≥ trimAlpha; null when there are
 * none). An opaque backdrop (comp colour or background layers) is excluded from the measurement.
 * Full-bleed nodes (see fullBleedNodes) are measured clipped to the comp, with padding only where
 * that stays inside the comp; the rest is probed at low resolution on a canvas enlarged by half
 * the comp's longest side per edge (doubling while content touches the edge, up to the GPU
 * texture limit), then rendered at full scale just large enough for content + padding.
 */
async function measure(c: ExportContext, project: Project, padding: number): Promise<Measured> {
  const measured = hasOpaqueBackdrop(project, c.includeGuides) ? withoutBackdrop(project) : project;
  await yieldToUI();
  throwIfAborted(c.signal);
  const bleed = fullBleedNodes(c, measured);
  if (!bleed.length) {
    const m = await measureEnlarged(c, measured, padding);
    if (!m) throw new NothingToExport();
    return { ...m, exact: measured === project };
  }
  const rest = await measureEnlarged(c, hideItems(measured, new Set(bleed.map((n) => n.layer.id))), padding);
  const img = renderCanvas(c, onlyItems(measured, bleed), 0, 0);
  const b = alphaBounds(img, c.trimAlpha);
  if (!b && !rest) throw new NothingToExport();
  let frame = rest?.frame ?? null;
  if (b) {
    const p = Math.round(Math.max(0, padding) * c.scale);
    const x0 = Math.max(0, b.x0 - p);
    const y0 = Math.max(0, b.y0 - p);
    const clipped = { x: x0 - img.width / 2, y: y0 - img.height / 2, w: Math.min(img.width, b.x1 + p) - x0, h: Math.min(img.height, b.y1 + p) - y0 };
    frame = unionFrame(frame, clipped);
  }
  return { frame: frame!, img, exact: false };
}

/** Content + padding of `project` on an enlarged canvas (see measure), or null when it is empty. */
async function measureEnlarged(c: ExportContext, project: Project, padding: number): Promise<Omit<Measured, 'exact'> | null> {
  const { cw, ch, scale, mxMax, myMax } = c;
  const pad = Math.max(0, padding);

  // 1. Low-resolution probe: half-extents of the content around the comp centre, in comp px.
  let mx = Math.min(mxMax, Math.ceil(Math.max(cw, ch) / 2) + Math.ceil(pad));
  let my = Math.min(myMax, Math.ceil(Math.max(cw, ch) / 2) + Math.ceil(pad));
  let half: { x: number; y: number; px: number };
  for (;;) {
    await yieldToUI();
    throwIfAborted(c.signal);
    const W = cw + 2 * mx;
    const H = ch + 2 * my;
    const img = renderCanvas(c, project, mx, my, Math.min(scale, 1, PROBE_MAX / W, PROBE_MAX / H));
    const b = alphaBounds(img, c.trimAlpha);
    if (!b) return null;
    const touchX = b.x0 === 0 || b.x1 === img.width;
    const touchY = b.y0 === 0 || b.y1 === img.height;
    const growX = touchX && mx < mxMax;
    const growY = touchY && my < myMax;
    if (growX || growY) {
      if (growX) mx = Math.min(mxMax, 2 * mx + 1);
      if (growY) my = Math.min(myMax, 2 * my + 1);
      continue;
    }
    if (touchX || touchY) warn(c, clippedWarning(c));
    const sx = img.width / W;
    const sy = img.height / H;
    half = {
      x: Math.max(Math.abs(b.x0 / sx - W / 2), Math.abs(b.x1 / sx - W / 2)),
      y: Math.max(Math.abs(b.y0 / sy - H / 2), Math.abs(b.y1 / sy - H / 2)),
      // Probe pixels are coarse: allow two of them (in comp px) of slack.
      px: 2 / Math.min(sx, sy),
    };
    break;
  }

  // 2. Full-scale render on a canvas that fits content + padding (never smaller than the comp).
  let fx = Math.min(mxMax, Math.max(0, Math.ceil(half.x + pad + half.px - cw / 2)));
  let fy = Math.min(myMax, Math.max(0, Math.ceil(half.y + pad + half.px - ch / 2)));
  const padPx = Math.round(pad * scale);
  for (;;) {
    await yieldToUI();
    throwIfAborted(c.signal);
    const img = renderCanvas(c, project, fx, fy);
    const b = alphaBounds(img, c.trimAlpha);
    if (!b) return null;
    const want = { x0: b.x0 - padPx, y0: b.y0 - padPx, x1: b.x1 + padPx, y1: b.y1 + padPx };
    const outX = want.x0 < 0 || want.x1 > img.width || (padPx === 0 && (b.x0 === 0 || b.x1 === img.width));
    const outY = want.y0 < 0 || want.y1 > img.height || (padPx === 0 && (b.y0 === 0 || b.y1 === img.height));
    const growX = outX && fx < mxMax;
    const growY = outY && fy < myMax;
    if (growX || growY) {
      if (growX) fx = Math.min(mxMax, fx + Math.max(8, Math.ceil(cw / 4)));
      if (growY) fy = Math.min(myMax, fy + Math.max(8, Math.ceil(ch / 4)));
      continue;
    }
    if (outX || outY) warn(c, clippedWarning(c));
    const x0 = Math.max(0, want.x0);
    const y0 = Math.max(0, want.y0);
    const frame = {
      x: x0 - img.width / 2,
      y: y0 - img.height / 2,
      w: Math.min(img.width, want.x1) - x0,
      h: Math.min(img.height, want.y1) - y0,
    };
    return { frame, img };
  }
}

/** Trimming applies (print pages are never trimmed). */
const trims = (opts: StillOptions) => opts.trim && !opts.print;
/** Side rounding of the output (none for print pages: their size is exact). */
export const roundingOf = (opts: StillOptions): RoundTo => (opts.print ? 1 : opts.roundTo);

/** The (unrounded) frame `project` exports into: trimmed content + padding, the comp, or the print page. */
export async function contentFrame(c: ExportContext, project: Project, opts: StillOptions): Promise<Frame> {
  return trims(opts) ? (await measure(c, project, opts.padding)).frame : compFrame(c);
}

/**
 * One still into its own frame (trimmed + rounded, the comp rounded, or the print page). A 16-bit
 * still is measured on 8-bit renders, then rendered again at 16 bits.
 */
async function stillImage(c: ExportContext, project: Project, opts: StillOptions): Promise<ExportImage> {
  if (!trims(opts)) {
    const img = await renderFrame(c, project, roundFrame(compFrame(c), roundingOf(opts)));
    if (!hasPixels(img)) throw new NothingToExport();
    return img;
  }
  const m = await measure(c, project, opts.padding);
  const f = roundFrame(m.frame, opts.roundTo);
  return c.depth === 8 && m.exact && fitsIn(m.img, f) ? cropFrame(m.img, f) : renderFrame(c, project, f);
}

/** One download: its blob and file name, the PNG file names inside, and the export's warnings. */
export interface ZipResult {
  blob: Blob;
  fileName: string;
  files: string[];
  warnings: Msg[];
}

/** `files` as one download: the PNG itself when there is a single file, else a stored ZIP named `zipName`. */
async function bundle(files: { name: string; data: Uint8Array }[], zipName: string, warnings: Msg[]): Promise<ZipResult> {
  const names = files.map((f) => f.name);
  if (files.length === 1)
    return { blob: new Blob([files[0].data as Uint8Array<ArrayBuffer>], { type: 'image/png' }), fileName: files[0].name, files: names, warnings };
  return { blob: await zipFiles(files), fileName: zipName, files: names, warnings };
}

// ---------------------------------------------------------------------------------------------
// Still

/** Renders one still at `opts.scale`, trimmed and rounded as asked. */
export async function renderStill(engine: Engine, project: Project, opts: StillOptions): Promise<StillResult> {
  const c = exportContext(engine, project, opts);
  const warnings = await prepareRender(engine, project, opts.includeGuides);
  throwIfAborted(opts.signal);
  const image = await stillImage(c, project, opts);
  const all = [...warnings, ...c.warnings.values()];
  return all.length ? { image, warning: joinMsgs(all, '; ') } : { image };
}

/** Output size in px of a single still with these options (trimmed exports are measured by rendering). */
export async function measureOutput(engine: Engine, project: Project, opts: StillOptions): Promise<{ w: number; h: number; warnings: Msg[] }> {
  const c = exportContext(engine, project, opts);
  const warnings = await prepareRender(engine, project, opts.includeGuides);
  throwIfAborted(opts.signal);
  const f = roundFrame(await contentFrame(c, project, opts), roundingOf(opts));
  return { w: f.w, h: f.h, warnings: [...warnings, ...c.warnings.values()] };
}

// ---------------------------------------------------------------------------------------------
// Per-layer PNG parts (Photoshop "Quick Export layers as PNG")

export interface LayerPartsOptions extends StillOptions {
  /** `{name}` part of every file name. */
  baseName: string;
  /** With `trim`: every PNG gets the largest trimmed size (then rounded), each centred on its own layer's content. */
  sameSize: boolean;
  onProgress: (done: number, total: number) => void;
}

/**
 * `project` drawing only the layers `keep` (others hidden, not removed, so their renderer caches
 * stay), with no backdrop. Kept layers whose group isn't kept move to the top level (out of its
 * effects); `as` swaps in a copy of a kept layer (a title part, an effect-free base). `rootId`,
 * when given, draws alone: visible, unclipped, normal blend, full opacity. The kept layers move to
 * the bottom of the stack in their order, so every group's subtree stays contiguous below it and
 * no hidden layer ends up below a kept one as its clip base.
 */
export function drawOnly(project: Project, keep: ReadonlySet<string>, rootId: string | null, as: (l: Layer) => Layer = (l) => l): Project {
  const hidden: Layer[] = [];
  const kept: Layer[] = [];
  for (const orig of project.layers) {
    if (!keep.has(orig.id)) {
      hidden.push(orig.visible ? { ...orig, visible: false } : orig);
      continue;
    }
    const l = as(orig);
    const parentId = l.parentId && keep.has(l.parentId) ? l.parentId : undefined;
    kept.push(
      l.id === rootId
        ? ({ ...l, visible: true, solo: false, guide: false, clip: false, blend: 'normal', parentId, transform: { ...l.transform, opacity: 1 } } as Layer)
        : parentId === l.parentId
          ? l
          : { ...l, parentId },
    );
  }
  return { ...project, comp: { ...project.comp, background: { ...project.comp.background, transparent: true } }, layers: [...kept, ...hidden] };
}

/**
 * `project` drawing only layer `id` (see drawOnly), out of its group. A group keeps its subtree and
 * effects, a clip base its clipped layers; a clipped layer keeps its clip base (drawn too, alone in
 * its place) so the clip still applies.
 */
export function isolate(project: Project, id: string): Project {
  const { layers } = project;
  const target = layers.find((l) => l.id === id);
  const base = target?.clip ? clipBaseOf(layers, id) : null;
  const group = !target ? [] : base ? [base, target] : [target, ...clippedTo(layers, target.id)];
  const keep = new Set(withDescendants(layers, group.map((l) => l.id)));
  return drawOnly(project, keep, (base ?? target)?.id ?? null, (l) => (l.id === id && base ? { ...l, visible: true, solo: false, guide: false } : l));
}

/** Duplicate suffixes added by the layer panel and Photoshop (`Orb copy copy`, `Orb copy 2`, `オーブのコピー`). */
const COPY_SUFFIX = /(\s*(copy|のコピー)(\s*\d+)?)+$/i;

interface LayerPart {
  /** The top-level layer: a title, or a group (exported as one part), with its clipped layers. */
  layer: Layer;
  /** The project drawing only this part. */
  project: Project;
  file: string;
}

/**
 * Every visible, non-guide (unless `includeGuides`) top-level title layer, generator layer or
 * group (one part, its effects and the layers clipped to it included), bottom → top, with its file
 * name `${base}_${layer}.png`: the half-width layer name without duplicate suffixes (`layerNN`
 * when it isn't ASCII, e.g. 確定). Background layers are mockup backdrops and are left out;
 * adjustment layers draw nothing alone and are not parts.
 */
export function layerParts(project: Project, baseName: string, includeGuides: boolean): LayerPart[] {
  const layers = drawTree(project, includeGuides)
    .map((n) => n.layer)
    .filter((l) => l.kind !== 'background' && l.kind !== 'adjustment');
  const base = safeWordName(baseName) || 'title';
  const used = new Set<string>();
  return layers.map((l, i) => {
    const name = asciiName(l.name.replace(COPY_SUFFIX, '')) ?? `layer${pad(i + 1, layers.length)}`;
    return { layer: l, project: isolate(project, l.id), file: `${uniqueStem(`${base}_${name}`, used)}.png` };
  });
}

/**
 * Every `layerParts` layer rendered alone. With `trim` each PNG is cropped to its own layer +
 * padding, or with `sameSize` to the largest of those boxes centred on its own content;
 * untrimmed parts all share the comp frame. Empty layers are skipped with a warning. One part
 * downloads as a PNG, several as `${base}_layers.zip`.
 */
export async function exportLayerParts(engine: Engine, project: Project, opts: LayerPartsOptions): Promise<ZipResult> {
  const parts = layerParts(project, opts.baseName, opts.includeGuides);
  if (!parts.length) throw new MsgError(msg('Nothing to export: no visible title layers'));
  const c = exportContext(engine, project, opts);
  const warnings = await prepareRender(engine, project, opts.includeGuides);
  throwIfAborted(opts.signal);
  const shared = trims(opts) && opts.sameSize && parts.length > 1;
  const total = parts.length * (shared ? 2 : 1);
  let done = 0;
  opts.onProgress(0, total);
  const skip = (p: LayerPart, e: unknown) => {
    if (!(e instanceof NothingToExport)) throw e;
    warnings.push(msg('Layer "{name}" is empty and was skipped', { name: p.layer.name }));
  };

  // Same size: every trimmed box first, then each grown (centred) to the largest one.
  const frames = new Map<LayerPart, Frame>();
  if (shared) {
    for (const p of parts) {
      try {
        frames.set(p, (await measure(c, p.project, opts.padding)).frame);
      } catch (e) {
        skip(p, e);
      }
      opts.onProgress(++done, total);
    }
    const sides = [...frames.values()];
    const w = Math.ceil(Math.max(0, ...sides.map((f) => f.w)) / opts.roundTo) * opts.roundTo;
    const h = Math.ceil(Math.max(0, ...sides.map((f) => f.h)) / opts.roundTo) * opts.roundTo;
    for (const [p, f] of frames) frames.set(p, { x: f.x - Math.floor((w - f.w) / 2), y: f.y - Math.floor((h - f.h) / 2), w, h });
  }

  const pngs = pngBatch(project.comp.dpi, opts.signal);
  for (const p of parts) {
    let image: ExportImage | null = null;
    const f = frames.get(p);
    if (f) image = await renderFrame(c, p.project, f);
    else if (!shared) {
      try {
        image = await stillImage(c, p.project, opts);
      } catch (e) {
        skip(p, e);
      }
    }
    if (image) await pngs.add(p.file, image);
    opts.onProgress(++done, total);
  }
  const files = await pngs.files();
  if (!files.length) throw new NothingToExport();
  throwIfAborted(opts.signal);
  return bundle(files, `${safeWordName(opts.baseName) || 'title'}_layers.zip`, [...warnings, ...c.warnings.values()]);
}

// ---------------------------------------------------------------------------------------------
// SVG outlines

/**
 * Face outlines of the listed text / shape title layers (a group: those in its subtree; fonts
 * loaded first): one layer → a single `${base}.svg`; several → ZIP of `${base}_${layer}.svg`.
 * Other layers are skipped (generator layers and image-source titles, 2D or 3D, with a warning:
 * they have no vector outlines). Clipping masks and layer masks don't apply to outlines: clipped
 * and masked layers (a mask of the layer or of a group around it) are exported whole, with a warning.
 */
export async function exportSvg(project: Project, layerIds: string[], baseName: string): Promise<{ blob: Blob; fileName: string; warnings: Msg[] }> {
  const ids = new Set(withDescendants(project.layers, layerIds));
  const layers = project.layers.filter(
    (l): l is Title2DLayer | Title3DLayer => ids.has(l.id) && isTitleLayer(l) && (l.source.kind === 'text' || l.source.kind === 'shape'),
  );
  if (!layers.length) throw new MsgError(msg('Nothing to export: SVG outlines need a title layer with a text or shape source'));
  const files: { name: string; svg: string }[] = [];
  const warnings: Msg[] = project.layers.flatMap((l) =>
    !ids.has(l.id)
      ? []
      : l.kind === 'generator'
        ? [msg('Layer "{name}" is a generator layer: it has no outlines and was skipped', { name: l.name })]
        : isTitleLayer(l) && l.source.kind === 'image'
          ? [msg('Layer "{name}" is an image: it has no vector outlines and was skipped', { name: l.name })]
          : [],
  );
  const used = new Set<string>();
  for (const l of layers) {
    if (l.source.kind === 'text') await ensureFont(l.source.fontId);
    const svg = titleToSVG(l);
    if (!svg) throw new MsgError(msg('Layer "{name}": outlines unavailable (font not loaded or empty text)', { name: l.name }));
    if (isClipped(project.layers, l.id)) warnings.push(msg('Layer "{name}" is clipped; its SVG outlines are not clipped', { name: l.name }));
    if ([l, ...ancestorsOf(project.layers, l.id)].some((x) => x.masks.some((m) => m.enabled)))
      warnings.push(msg('Layer "{name}" is masked; its SVG outlines are not masked', { name: l.name }));
    const stem = uniqueStem(`${baseName}_${safeWordName(l.name) || 'layer'}`, used);
    files.push({ name: `${stem}.svg`, svg });
  }
  if (files.length === 1) return { blob: new Blob([files[0].svg], { type: 'image/svg+xml' }), fileName: `${baseName}.svg`, warnings };
  const enc = new TextEncoder();
  const zipped = await zipFiles(files.map((f) => ({ name: f.name, data: enc.encode(f.svg) })));
  return { blob: zipped, fileName: `${baseName}_svg.zip`, warnings };
}
