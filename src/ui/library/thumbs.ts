import { ensureFont, getFont } from '../../assets/registry';
import { Engine } from '../../engine/Engine';
import { decodeImage } from '../../engine/layer2d/images';
import { onEnvironmentReady } from '../../engine/three/environment';
import { loadModel, modelStatus, onModelReady } from '../../engine/three/Layer3DRenderer';
import { generatorParams } from '../../generators/registry';
import { isolate, prepareRender } from '../../io/export';
import { companionsOf, ownGroupOf } from '../../model/companions';
import { effectiveLighting } from '../../model/lighting';
import { isTitleLayer } from '../../model/parts';
import type { Layer, Project } from '../../model/types';
import { applyPresetToProject } from '../../presets/apply';
import { applyColourway } from '../../presets/colourways';
import type { Colourway, StylePreset } from '../../presets/types';
import { withDescendants } from '../../store/tree';
import { layoutText } from '../../text/layout';

// Live library thumbnails: each preset rendered with the selected layer's own text/font (with the
// companions and group effects the look brings), each colourway on the selected layer itself (a
// title with its companions and its own group, or a generator / group drawn in its comp).
//
// A DEDICATED offscreen Engine (own WebGL context) renders them: Engine.composite disposes the
// renderers of layers absent from the project it renders, so sharing the viewport engine would
// rebuild the live layers' geometry after every thumbnail. Jobs run one per macrotask so the UI
// never freezes; tiles request only while visible and cancel when they scroll away/unmount.

export const THUMB_W = 160;
export const THUMB_H = 90;
const THUMB_LAYER_ID = 'library-thumb';
const THUMB_GROUP_ID = 'library-thumb-group';
const CACHE_LIMIT = 240;

interface ThumbBase {
  key: string;
  project: Project;
  /** The layer drawn: a title, or for a colourway also a generator or group (with its subtree). */
  layer: Layer;
}

export type PresetThumbJob = ThumbBase & { preset: StylePreset; applyFont: boolean };
export type ColourwayThumbJob = ThumbBase & { colourway: Colourway };
export type ThumbJob = PresetThumbJob | ColourwayThumbJob;

/** null = the render failed (shown as an error tile, not retried for the same key). */
const cache = new Map<string, ImageData | null>();
/** Cached keys whose result is a 3D layer (depends on the comp environment). */
const keys3D = new Set<string>();
/** Per GLB asset id: cached keys rendered while that model was still parsing (drawn without it). */
const keysAwaitingModel = new Map<string, Set<string>>();
const queue = new Map<string, ThumbJob>();
const listeners = new Set<() => void>();
let version = 0;
let engine: Engine | null = null;
let running = false;

const emit = () => {
  version++;
  for (const l of listeners) l();
};

// An async environment (bundled HDRI / custom asset) finished loading: 3D thumbnails rendered
// before it was ready are stale. Dropping them makes visible tiles request a re-render (the
// old image stays on the canvas until the new one lands).
const offEnvReady = onEnvironmentReady(() => {
  if (keys3D.size === 0) return;
  for (const k of keys3D) cache.delete(k);
  keys3D.clear();
  emit();
});
// A GLB finished parsing (once per model: parses are shared by every renderer, so the
// re-renders find it parsed and record nothing — no loop): drop only the tiles drawn without it.
const offModelReady = onModelReady((assetId) => {
  const keys = keysAwaitingModel.get(assetId);
  if (!keys) return;
  keysAwaitingModel.delete(assetId);
  for (const k of keys) {
    cache.delete(k);
    keys3D.delete(k);
  }
  emit();
});
import.meta.hot?.dispose(() => {
  offEnvReady();
  offModelReady();
  engine?.dispose();
});

export const thumbStore = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  getVersion: () => version,
};

export const getThumb = (key: string) => cache.get(key);

/** Queue a render (no-op when cached). Returns a cancel function for the pending request. */
export function requestThumb(job: ThumbJob): () => void {
  if (cache.has(job.key)) return () => {};
  queue.set(job.key, job);
  void pump();
  return () => {
    if (queue.get(job.key) === job) queue.delete(job.key);
  };
}

/** Stable identity of everything (besides the preset) that changes a preset thumbnail. */
export function thumbContentKey(project: Project, layer: Layer, applyFont: boolean): string {
  if (!isTitleLayer(layer)) return 'not-a-title';
  const { scale, rotX, rotY, rotZ, flipX, flipY } = layer.transform;
  const { camera } = project.comp;
  return JSON.stringify([
    layer.kind,
    layer.source,
    // applyPreset keeps the outline ops: warp / distort / weight reshape every thumbnail
    layer.warp,
    layer.distort,
    layer.weight,
    scale,
    rotX,
    rotY,
    rotZ,
    flipX,
    flipY,
    applyFont,
    // no comp lighting: a 3D look sets every lighting value itself (style3d.lighting)
    camera.fov,
    camera.rotX,
    camera.rotY,
    camera.rotZ,
  ]);
}

/**
 * Stable identity of everything (besides the colourway) that changes a colourway thumbnail: the
 * whole layer, since a colourway keeps its structure (a title is drawn centred, so not its
 * position), with its companions and its own group (relative to it), or a generator / group with
 * its subtree in place on the comp.
 */
export function colourwayContentKey(project: Project, layer: Layer): string {
  const { width, height, environment, lights, toneMapping, exposure, camera } = project.comp;
  if (isTitleLayer(layer)) return JSON.stringify([titleThumbLayers(project, layer), layer.kind === 'title3d' ? effectiveLighting(project.comp, layer) : null, camera]);
  const ids = new Set(withDescendants(project.layers, [layer.id]));
  return JSON.stringify([project.layers.filter((l) => ids.has(l.id)), width, height, environment, lights, toneMapping, exposure, camera]);
}

/**
 * Title `src` moved to the comp centre as THUMB_LAYER_ID, alone in its comp (out of its group and
 * clipping), with its companions and its own group (ownGroupOf) when `withCompanions`: what a
 * colourway recolours with it. Free companions keep their place relative to the title; following
 * ones follow the moved title, or its own group (a look's companion over the group's effects).
 */
function titleThumbLayers(project: Project, src: Layer, withCompanions = true): Layer[] {
  const { x, y } = src.transform;
  const own = withCompanions ? ownGroupOf(project.layers, src.id) : null;
  const centred: Layer = {
    ...src,
    id: THUMB_LAYER_ID,
    visible: true,
    solo: false,
    guide: false,
    blend: 'normal',
    clip: false,
    parentId: own ? THUMB_GROUP_ID : undefined,
    transform: { ...src.transform, x: 0, y: 0, z: 0, opacity: 1 },
  };
  if (!withCompanions) return [centred];
  const ids: Record<string, string> = { [src.id]: THUMB_LAYER_ID, ...(own && { [own.id]: THUMB_GROUP_ID }) };
  const companions = new Set(companionsOf(project.layers, src.id));
  return project.layers.flatMap((l): Layer[] => {
    if (l === src) return [centred];
    if (l === own) return [{ ...own, id: THUMB_GROUP_ID, visible: true, solo: false, guide: false, blend: 'normal', clip: false, parentId: undefined, transform: { ...own.transform, opacity: 1 } }];
    if (l.kind !== 'generator' || !companions.has(l)) return [];
    const follow = ids[String(generatorParams(l.generator).follow)];
    return [
      {
        ...l,
        companionOf: THUMB_LAYER_ID,
        parentId: l.parentId !== undefined ? ids[l.parentId] : undefined,
        transform: follow ? l.transform : { ...l.transform, x: l.transform.x - x, y: l.transform.y - y },
        generator: follow ? { ...l.generator, params: { ...l.generator.params, follow } } : l.generator,
      },
    ];
  });
}

/** Layers a job draws: its layer and, for a group, every layer inside it. */
function drawnLayers(job: ThumbJob): Layer[] {
  if (job.layer.kind !== 'group') return [job.layer];
  const ids = new Set(withDescendants(job.project.layers, [job.layer.id]));
  return job.project.layers.filter((l) => ids.has(l.id));
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.size > 0) {
      const [key, job] = queue.entries().next().value as [string, ThumbJob];
      queue.delete(key);
      let result: ImageData | null = null;
      try {
        result = await renderJob(job);
      } catch (e) {
        console.warn(`Library thumbnail “${'preset' in job ? job.preset.name : job.colourway}” failed`, e);
      }
      cache.delete(key);
      cache.set(key, result);
      if ('preset' in job ? job.preset.kind === 'title3d' : drawnLayers(job).some((l) => l.kind === 'title3d')) keys3D.add(key);
      const modelId = isTitleLayer(job.layer) && job.layer.source.kind === 'model' ? job.layer.source.assetId : null;
      if (modelId && modelStatus(modelId) === 'loading') {
        let keys = keysAwaitingModel.get(modelId);
        if (!keys) keysAwaitingModel.set(modelId, (keys = new Set()));
        keys.add(key);
        // a preset that does not draw the model in 3D never started its parse
        void loadModel(modelId);
      }
      while (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next().value as string;
        cache.delete(oldest);
        keys3D.delete(oldest);
      }
      emit();
      // yield to the event loop between renders
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    running = false;
  }
}

function sourceFont(job: ThumbJob): string | undefined {
  const l = job.layer;
  if (!isTitleLayer(l) || l.source.kind !== 'text') return undefined;
  return 'preset' in job && job.applyFont && job.preset.fontId ? job.preset.fontId : l.source.fontId;
}

/** Layer-space half extents of the source before styling (comp px, unscaled). */
function sourceHalfExtent(layer: Layer, fontId: string | undefined): { hw: number; hh: number } {
  if (!isTitleLayer(layer)) return { hw: 1, hh: 1 };
  const src = layer.source;
  if (src.kind === 'text') {
    const font = fontId ? getFont(fontId)?.font : undefined;
    if (!font) throw new Error(`font ${fontId ?? '?'} unavailable`);
    const { bounds } = layoutText({ ...src, fontId: fontId ?? src.fontId }, font);
    if (bounds.x1 <= bounds.x0) return { hw: src.size / 2, hh: src.size / 2 };
    return {
      hw: Math.max(Math.abs(bounds.x0), Math.abs(bounds.x1)),
      hh: Math.max(Math.abs(bounds.y0), Math.abs(bounds.y1)),
    };
  }
  // shapes are `size` tall and size × aspect wide (speech tails / ribbon folds sit in the padding)
  if (src.kind === 'shape') return { hw: (src.size * src.aspect) / 2, hh: src.size / 2 };
  return { hw: src.size / 2, hh: src.size / 2 };
}

/** Outward reach of the style beyond the glyph outline, % of size. */
function styleReach(layer: Layer): number {
  if (layer.kind === 'title2d') {
    let w = 0;
    let off = 0;
    for (const r of layer.style.rims) {
      if (!r.enabled) continue;
      w += r.width;
      off = Math.max(off, Math.abs(r.offsetX), Math.abs(r.offsetY));
    }
    return w + off;
  }
  if (layer.kind === 'title3d') {
    const s = layer.style3d;
    let w = 0;
    for (const b of s.bands) w += Math.max(0, b.width);
    for (const p of s.backplates) if (p.enabled) w += p.grow;
    return w;
  }
  return 0;
}

/**
 * The preset (through applyPresetToProject: with its companions and group effects) or colourway
 * (on the title and its companions) applied to the title, centred in a small comp cropped around it.
 */
function buildThumbProject(job: ThumbJob): Project {
  const { project } = job;
  const alone = { ...project, layers: titleThumbLayers(project, job.layer, !('preset' in job)) };
  const layers =
    'preset' in job
      ? applyPresetToProject(alone, THUMB_LAYER_ID, job.preset, { applyFont: job.applyFont }).layers
      : alone.layers.map((l) => applyColourway(l, job.colourway));
  const layer = layers.find((l) => l.id === THUMB_LAYER_ID);
  if (!layer || !isTitleLayer(layer)) throw new Error('not a title');

  const { hw, hh } = sourceHalfExtent(layer, layer.source.kind === 'text' ? layer.source.fontId : undefined);
  const size = layer.source.size;
  const t = layer.transform;
  const pad = (styleReach(layer) / 100) * size + size * 0.12;
  const w = hw + pad;
  const h = hh + pad;
  const a = (t.rotZ * Math.PI) / 180;
  const cos = Math.abs(Math.cos(a));
  const sin = Math.abs(Math.sin(a));
  const bw = 2 * (w * cos + h * sin) * t.scale;
  const bh = 2 * (w * sin + h * cos) * t.scale;
  const width = Math.ceil(Math.max(bw, (bh * THUMB_W) / THUMB_H, 8));
  const height = Math.ceil((width * THUMB_H) / THUMB_W);

  return {
    ...project,
    comp: {
      ...project.comp,
      width,
      height,
      background: { transparent: true, color: '#000000' },
      camera: { ...project.comp.camera, x: 0, y: 0, zOffset: 0 },
    },
    layers,
  };
}

/**
 * A colourway on a generator or group: the layer (and its subtree) recoloured in place, isolated
 * like a PNG part (what it clips to stays drawn, other layers hidden but present), on the comp
 * widened to the thumbnail's aspect around the same centre with the same 3D projection.
 */
function compThumbProject(job: ColourwayThumbJob): Project {
  const ids = new Set(drawnLayers(job).map((l) => l.id));
  const alone = isolate(job.project, job.layer.id);
  const { comp } = alone;
  const width = Math.max(comp.width, Math.round((comp.height * THUMB_W) / THUMB_H));
  const height = Math.max(comp.height, Math.round((width * THUMB_H) / THUMB_W));
  // The FOV is vertical: a taller comp widens it so the layer keeps its size on screen.
  const fov = height === comp.height ? comp.camera.fov : (2 * Math.atan((height / comp.height) * Math.tan((comp.camera.fov * Math.PI) / 360)) * 180) / Math.PI;
  return {
    ...alone,
    comp: { ...comp, width, height, background: { transparent: true, color: '#000000' }, camera: { ...comp.camera, fov } },
    layers: alone.layers.map((l) => (ids.has(l.id) ? applyColourway(l, job.colourway) : l)),
  };
}

async function renderJob(job: ThumbJob): Promise<ImageData> {
  const e = (engine ??= new Engine(document.createElement('canvas')));
  let project: Project;
  if ('colourway' in job && !isTitleLayer(job.layer)) {
    project = compThumbProject(job);
    await prepareRender(e, project, false);
  } else {
    const fontId = sourceFont(job);
    if (fontId) await ensureFont(fontId);
    // 2D and 3D image layers (traced alpha + face image) draw nothing until the bitmap decodes
    if (isTitleLayer(job.layer) && job.layer.source.kind === 'image') await decodeImage(job.layer.source.assetId);
    project = buildThumbProject(job);
  }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  return e.renderImageData(project, { scale: (THUMB_W * dpr) / project.comp.width, includeGuides: false });
}
