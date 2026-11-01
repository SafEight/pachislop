import type * as THREE from 'three';
import { isTitleLayer, layerParts } from '../model/parts';
import type { PartKey, Project } from '../model/types';
import type { Compositor } from './compositor';
import { drawTree, findNode, inspectView } from './drawTree';
import { PassKit } from './passkit';
import type { Readback } from './readback';
import { disposeRenderers, pruneRenderers, rendererFor, sizeFor, type RendererMap, type Surfaces } from './surface';

/**
 * Longer side (render px) of the comp when rendering a layer thumbnail: one fixed small size, so
 * the thumbnail pool never resizes between calls (a resize reallocates every pooled target).
 */
const THUMB_RENDER_SIDE = 256;
/** Longest side (render px) of the comp for partAt: comp px up to this, so thin rims still resolve. */
const PART_RENDER_SIDE = 2048;
/** Alpha a part needs under the point to be picked before the parts behind it are tried; below it the strongest part wins. */
const PART_ALPHA_PICK = 0.5;
/** Weaker than this (anti-aliasing fringe) nothing is picked. */
const PART_ALPHA_MIN = 0.1;

/**
 * `img` (straight alpha) cropped to its alpha box and box-filtered down so its longer side is at
 * most `maxSide` (never enlarged); null when fully transparent.
 */
function trimToFit(img: ImageData, maxSide: number): ImageData | null {
  const { width: w, height: h, data } = img;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (data[(y * w + x) * 4 + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
  if (x1 < 0) return null;
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const k = Math.min(1, Math.max(1, maxSide) / Math.max(bw, bh));
  const tw = Math.max(1, Math.round(bw * k));
  const th = Math.max(1, Math.round(bh * k));
  const out = new ImageData(tw, th);
  for (let ty = 0; ty < th; ty++) {
    const sy0 = y0 + Math.floor((ty * bh) / th);
    const sy1 = Math.max(sy0 + 1, y0 + Math.floor(((ty + 1) * bh) / th));
    for (let tx = 0; tx < tw; tx++) {
      const sx0 = x0 + Math.floor((tx * bw) / tw);
      const sx1 = Math.max(sx0 + 1, x0 + Math.floor(((tx + 1) * bw) / tw));
      // average premultiplied, so transparent pixels do not darken the edges
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let y = sy0; y < sy1; y++)
        for (let x = sx0; x < sx1; x++) {
          const i = (y * w + x) * 4;
          const pa = data[i + 3];
          r += data[i] * pa;
          g += data[i + 1] * pa;
          b += data[i + 2] * pa;
          a += pa;
        }
      const o = (ty * tw + tx) * 4;
      const n = (sx1 - sx0) * (sy1 - sy0);
      if (a > 0) {
        out.data[o] = Math.round(r / a);
        out.data[o + 1] = Math.round(g / a);
        out.data[o + 2] = Math.round(b / a);
      }
      out.data[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

/**
 * Editor inspection renders of one layer or what an adjustment layer receives (thumbnails,
 * Levels / Curves histograms, alpha picking, layer masks): in pools and renderers of their own.
 */
export class Probes {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly surfaces: Surfaces;
  private readonly compositor: Compositor;
  private readonly readback: Readback;
  /**
   * Renderer instances for thumbnails and backdrops: their small draft renders would otherwise
   * rebuild the preview renderers' size- and draft-keyed geometry every time.
   */
  private readonly renderers: RendererMap = new Map();
  /** Pools of renderThumb (fixed size), renderBackdrop and renderMask, apart from the preview's (created on first use). */
  private thumbKit: PassKit | null = null;
  private backdropKit: PassKit | null = null;
  private maskKit: PassKit | null = null;
  /** Pool and renderers of partAt: comp-size draft renders, kept apart from the thumbnails' fixed small size. */
  private partKit: PassKit | null = null;
  private readonly partRenderers: RendererMap = new Map();

  constructor(renderer: THREE.WebGLRenderer, surfaces: Surfaces, compositor: Compositor, readback: Readback) {
    this.renderer = renderer;
    this.surfaces = surfaces;
    this.compositor = compositor;
    this.readback = readback;
  }

  /** See Engine.renderBackdrop. */
  renderBackdrop(project: Project, adjustmentLayerId: string, opts: { scale: number }): ImageData {
    const view = inspectView(project, adjustmentLayerId);
    const { w, h } = sizeFor(project, opts.scale);
    const kit = (this.backdropKit ??= new PassKit(this.renderer));
    const s = this.surfaces.surface(view, kit, opts.scale, w, h, true, this.renderers);
    const probe = (this.compositor.probe = { id: adjustmentLayerId, rt: null as THREE.WebGLRenderTarget | null });
    try {
      kit.release(this.compositor.drawNodes(drawTree(view, true), this.compositor.background(kit, view.comp), s, null));
    } finally {
      this.compositor.probe = null;
    }
    this.surfaces.closeSources();
    this.compositor.masks.sweep();
    pruneRenderers(this.renderers, project);
    if (!probe.rt) return new ImageData(w, h);
    const out = this.readback.readImage(probe.rt.texture, w, h, 'backdrop');
    kit.release(probe.rt);
    return out;
  }

  /** See Engine.renderThumb. */
  renderThumb(project: Project, layerId: string, maxSide: number): ImageData | null {
    const view = inspectView(project, layerId);
    const node = findNode(drawTree(view, true), layerId);
    if (!node || node.kind === 'adjust') return null;
    const scale = Math.max(THUMB_RENDER_SIDE, Math.ceil(maxSide)) / Math.max(project.comp.width, project.comp.height);
    const { w, h } = sizeFor(project, scale);
    const kit = (this.thumbKit ??= new PassKit(this.renderer));
    const px = this.compositor.renderUnit(node, this.surfaces.surface(view, kit, scale, w, h, true, this.renderers), null);
    this.surfaces.closeSources();
    this.compositor.masks.sweep();
    const img = this.readback.readImage(px.texture, w, h, 'thumb');
    kit.release(px);
    pruneRenderers(this.renderers, project);
    return trimToFit(img, maxSide);
  }

  /**
   * See Engine.renderMaskPreview / renderLayerMask: mask `maskId` of layer `layerId` (enabled or
   * not; 'combined' = its enabled masks together) over the whole comp at `scale`, `draft` or not.
   */
  renderMask(project: Project, layerId: string, maskId: string, scale: number, draft: boolean): ImageData {
    const { w, h } = sizeFor(project, scale);
    const layer = project.layers.find((l) => l.id === layerId);
    const mask = maskId === 'combined' ? null : layer?.masks.find((m) => m.id === maskId);
    const kit = (this.maskKit ??= new PassKit(this.renderer));
    const s = this.surfaces.surface(project, kit, scale, w, h, draft, this.renderers);
    const { masks } = this.compositor;
    let img: ImageData;
    if (!layer || mask === undefined) img = masks.readGrey(null, s);
    else if (mask) {
      const rt = masks.single(layer, mask, s);
      img = masks.readGrey(rt?.texture ?? null, s);
      if (rt) kit.release(rt);
    } else img = masks.readGrey(masks.combined(layer, s), s);
    this.surfaces.closeSources();
    masks.sweep();
    pruneRenderers(this.renderers, project);
    return img;
  }

  /** See Engine.layerAlphaAt. */
  layerAlphaAt(project: Project, layerId: string, p: { x: number; y: number }, radius: number): number {
    const scale = THUMB_RENDER_SIDE / Math.max(project.comp.width, project.comp.height);
    const { w, h } = sizeFor(project, scale);
    const r = Math.max(0, radius) * scale;
    // render px, GL rows (bottom first, +y up)
    const cx = p.x * scale + w / 2;
    const cy = p.y * scale + h / 2;
    if (cx + r < 0 || cx - r > w || cy + r < 0 || cy - r > h) return 0;
    const view = inspectView(project, layerId);
    const node = findNode(drawTree(view, true), layerId);
    if (!node || node.kind === 'adjust') return 0;
    const kit = (this.thumbKit ??= new PassKit(this.renderer));
    const px = this.compositor.renderUnit(node, this.surfaces.surface(view, kit, scale, w, h, true, this.renderers), null);
    this.surfaces.closeSources();
    this.compositor.masks.sweep();
    const bytes = this.readback.toBytes(px.texture, w, h, 'thumb');
    kit.release(px);
    pruneRenderers(this.renderers, project);
    const x0 = Math.min(w - 1, Math.max(0, Math.floor(cx - r)));
    const y0 = Math.min(h - 1, Math.max(0, Math.floor(cy - r)));
    const x1 = Math.min(w, Math.max(x0 + 1, Math.ceil(cx + r)));
    const y1 = Math.min(h, Math.max(y0 + 1, Math.ceil(cy + r)));
    const buf = new Uint8Array((x1 - x0) * (y1 - y0) * 4);
    this.renderer.readRenderTargetPixels(bytes, x0, y0, x1 - x0, y1 - y0, buf);
    let a = 0;
    for (let i = 3; i < buf.length; i += 4) if (buf[i] > a) a = buf[i];
    return a / 255;
  }

  /** See Engine.partAt. */
  partAt(project: Project, layerId: string, p: { x: number; y: number }, radius: number): PartKey | null {
    const scale = Math.min(1, PART_RENDER_SIDE / Math.max(project.comp.width, project.comp.height));
    const { w, h } = sizeFor(project, scale);
    const r = Math.max(0, radius) * scale;
    // render px, GL rows (bottom first, +y up)
    const cx = p.x * scale + w / 2;
    const cy = p.y * scale + h / 2;
    if (cx + r < 0 || cx - r > w || cy + r < 0 || cy - r > h) return null;
    const view = inspectView(project, layerId);
    const layer = view.layers.find((l) => l.id === layerId);
    if (!isTitleLayer(layer)) return null;
    const x0 = Math.min(w - 1, Math.max(0, Math.floor(cx - r)));
    const y0 = Math.min(h - 1, Math.max(0, Math.floor(cy - r)));
    const x1 = Math.min(w, Math.max(x0 + 1, Math.ceil(cx + r)));
    const y1 = Math.min(h, Math.max(y0 + 1, Math.ceil(cy + r)));
    const buf = new Uint8Array((x1 - x0) * (y1 - y0) * 4);
    const kit = (this.partKit ??= new PassKit(this.renderer));
    const { ctx } = this.surfaces.surface(view, kit, scale, w, h, true, this.partRenderers);
    const renderer = rendererFor(layer, this.partRenderers);
    let best: PartKey | null = null;
    let bestA = PART_ALPHA_MIN;
    // Front to back: each part alone (3D: still occluded by the others, so only its visible pixels).
    for (const part of layerParts(layer).reverse()) {
      const rt = kit.acquire();
      ctx.parts = [part];
      try {
        renderer.render(layer, ctx, rt);
      } finally {
        ctx.parts = undefined;
      }
      const bytes = this.readback.toBytes(rt.texture, w, h, 'part');
      kit.release(rt);
      this.renderer.readRenderTargetPixels(bytes, x0, y0, x1 - x0, y1 - y0, buf);
      let a = 0;
      for (let i = 3; i < buf.length; i += 4) if (buf[i] > a) a = buf[i];
      if (a / 255 >= PART_ALPHA_PICK) {
        best = part;
        break;
      }
      if (a / 255 > bestA) {
        best = part;
        bestA = a / 255;
      }
    }
    this.surfaces.closeSources();
    pruneRenderers(this.partRenderers, project);
    return best;
  }

  dispose() {
    disposeRenderers(this.renderers);
    disposeRenderers(this.partRenderers);
    this.partKit?.dispose();
    this.thumbKit?.dispose();
    this.backdropKit?.dispose();
    this.maskKit?.dispose();
  }
}
