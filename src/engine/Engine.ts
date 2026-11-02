import * as THREE from 'three';
import type { PartKey, Project } from '../model/types';
import { Compositor } from './compositor';
import { drawnLayers, drawTree } from './drawTree';
import { InteractiveCache } from './interactive';
import { measureAlpha } from './layerSource';
import { PassKit } from './passkit';
import { Probes } from './probes';
import { Readback, type ImageData16 } from './readback';
import { disposeRenderers, pruneRenderers, sizeFor, Surfaces, type RendererMap } from './surface';
import { layerEnvironments, loadModel } from './three/Layer3DRenderer';
import { EnvironmentManager } from './three/environment';

// Dev: the live Engine (and its compiled materials) outlives hot updates (ui/engineHost.ts), so an
// edit to renderer code would keep drawing with the old code. This module is the boundary every
// renderer edit reaches: reload the page instead (the project survives through the autosave).
import.meta.hot?.accept(() => location.reload());

export interface RenderOptions {
  /** Render pixels per comp pixel. */
  scale: number;
  /** Draw guide layers (editor preview: true; exports: false). */
  includeGuides: boolean;
}

/** A rectangle of the whole render: render px from its top-left corner (DOM convention), whole px. */
export interface PreviewWindow {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The renderer of a canvas: preview and export composites of a project, and the editor's
 * inspection renders. Coordinates the pieces in this folder: surfaces (render size, camera,
 * layer context), the compositor, interactive reuse, probes and readback.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly kit: PassKit;
  readonly camera = new THREE.PerspectiveCamera(30, 1, 1, 100000);
  private readonly env: EnvironmentManager;
  private readonly layerRenderers: RendererMap = new Map();
  private readonly compositor: Compositor;
  private readonly surfaces: Surfaces;
  private readonly readback: Readback;
  private readonly probes: Probes;
  private readonly cache: InteractiveCache;
  /**
   * Pool of windowed preview renders (render's `window`), kept apart from `kit` so the
   * interactive cache's pixels survive them; freed once a settled preview renders without one.
   */
  private windowKit: PassKit | null = null;
  /** renderOverview's pool and renderers (another scale than the window's: kept apart so neither rebuilds the other's caches); freed with windowKit. */
  private overviewKit: PassKit | null = null;
  private readonly overviewRenderers: RendererMap = new Map();
  private interactive = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.kit = new PassKit(this.renderer);
    this.env = new EnvironmentManager(this.renderer);
    this.compositor = new Compositor(this.kit);
    this.readback = new Readback(this.kit);
    this.surfaces = new Surfaces(this.renderer, this.camera, this.env, {
      renderAlone: (n, s) => this.compositor.renderAlone(n, s),
      renderContent: (n, s) => this.compositor.renderContent(n, s),
      measure: measureAlpha,
    });
    this.probes = new Probes(this.renderer, this.surfaces, this.compositor, this.readback);
    this.cache = new InteractiveCache(this.renderer, this.camera, this.compositor, this.surfaces);
  }

  /**
   * Interactive mode (canvas drags, scrubbing): while on, preview renders reuse each top-level
   * node's last pixels when only its leaves' x / y / rotZ / scale (all by the same screen move)
   * or its own opacity / blend changed (drawn moved). A move that would show where the frame
   * cut those pixels (light past the comp edge) renders the node once on an enlarged frame
   * (the comp plus a margin) that later moves reuse while it covers the comp; a top-level group
   * that can't be reused is re-composited from its direct children's cached pixels,
   * re-rendering only the children that changed beyond a move or would show such a cut.
   * Changed nodes holding 3D render at INTERACTIVE_SCALE with supersample 1 and `draft`. The
   * caller re-renders after switching off for one full-quality frame.
   */
  setInteractive(on: boolean) {
    this.interactive = on;
  }

  /** setInteractive's current state. */
  get isInteractive(): boolean {
    return this.interactive;
  }

  /**
   * Render the composite to the canvas: the whole comp at `opts.scale`, or with `window` just
   * that part of the whole render (the canvas sized to it), with the very pixels the whole
   * render has there as long as everything those pixels depend on lies inside the window (the
   * caller's margin: glows, blurs, the layers a generator or effect measures). A windowed
   * render is never interactive, draws every node at full quality in a pool of its own and
   * leaves the interactive cache as it was; the whole-comp pool keeps only the cache's pixels
   * meanwhile (its scratch targets grow back on the next whole-comp render).
   */
  render(project: Project, opts: RenderOptions & { window?: PreviewWindow }) {
    const { w, h } = sizeFor(project, opts.scale);
    const win = opts.window;
    if (!win) {
      if (!this.interactive) this.dropWindowKit();
      this.renderer.setSize(w, h, false);
      const result = this.composite(project, opts.scale, w, h, opts.includeGuides, true);
      this.readback.toCanvas(result.texture);
      this.kit.release(result);
      return;
    }
    const x = Math.max(0, Math.min(w - 1, Math.round(win.x)));
    const y = Math.max(0, Math.min(h - 1, Math.round(win.y)));
    const ww = Math.max(1, Math.min(w - x, Math.round(win.width)));
    const wh = Math.max(1, Math.min(h - y, Math.round(win.height)));
    this.renderer.setSize(ww, wh, false);
    const kit = (this.windowKit ??= new PassKit(this.renderer));
    const s = this.surfaces.surface(project, kit, opts.scale, ww, wh, false, this.layerRenderers, this.camera, { width: w, height: h, x, y: h - y - wh });
    const acc = this.compositor.background(kit, project.comp);
    const result = this.compositor.drawNodes(drawTree(project, opts.includeGuides), acc, s, null);
    this.endFrame(project);
    this.readback.toCanvas(result.texture);
    kit.release(result);
    this.kit.trim();
  }

  private dropWindowKit() {
    for (const kit of [this.windowKit, this.overviewKit]) {
      if (!kit) continue;
      this.compositor.masks.release(kit);
      kit.dispose();
    }
    this.windowKit = this.overviewKit = null;
    disposeRenderers(this.overviewRenderers);
  }

  /**
   * The whole composite at `opts.scale`, full quality, as straight-alpha sRGB pixels (top row
   * first), in a pool and renderers of its own: the preview's pools and interactive cache stay
   * as they are. The 引き目 inset beside a windowed preview, whose canvas holds only the window.
   */
  renderOverview(project: Project, opts: RenderOptions): ImageData {
    const { w, h } = sizeFor(project, opts.scale);
    const kit = (this.overviewKit ??= new PassKit(this.renderer));
    const s = this.surfaces.surface(project, kit, opts.scale, w, h, false, this.overviewRenderers);
    const result = this.compositor.drawNodes(drawTree(project, opts.includeGuides), this.compositor.background(kit, project.comp), s, null);
    this.endFrame(project);
    pruneRenderers(this.overviewRenderers, project);
    const out = this.readback.readImage(result.texture, w, h, 'overview');
    kit.release(result);
    return out;
  }

  /** Render at `opts.scale` × comp resolution; returns straight-alpha sRGB pixels, top row first. */
  renderImageData(project: Project, opts: RenderOptions): ImageData {
    // export sizes would resize the held preview pixels with the pool: let them go
    this.cache.drop();
    const { w, h } = sizeFor(project, opts.scale);
    const result = this.composite(project, opts.scale, w, h, opts.includeGuides, false);
    const out = this.readback.readImage(result.texture, w, h, 'export');
    this.kit.release(result);
    return out;
  }

  /**
   * renderImageData at 16 bits per channel: the HDR composite un-premultiplied and sRGB-encoded
   * in float, undithered, read back in row strips and rounded to 0..65535.
   */
  renderImageData16(project: Project, opts: RenderOptions): ImageData16 {
    this.cache.drop();
    const { w, h } = sizeFor(project, opts.scale);
    const result = this.composite(project, opts.scale, w, h, opts.includeGuides, false);
    const out = this.readback.readImage16(result.texture, w, h);
    this.kit.release(result);
    return out;
  }

  /**
   * The composite adjustment layer `adjustmentLayerId` receives, as straight-alpha sRGB 8-bit
   * pixels at `opts.scale` × comp resolution (top row first), for the Levels / Curves histogram:
   * at top level everything below it over the comp background, inside a group the group's
   * members below it, when clipped its clip group's base and lower clipped layers inside the
   * base's content alpha. Draft quality, own pool and renderers: the preview is not disturbed.
   * The adjustment and its groups count as shown and solo is ignored; transparent when it
   * still draws nothing (its clip base is hidden, or it is not an adjustment layer).
   */
  renderBackdrop(project: Project, adjustmentLayerId: string, opts: { scale: number }): ImageData {
    return this.probes.renderBackdrop(project, adjustmentLayerId, opts);
  }

  /**
   * Layer or group `layerId` drawn alone, with its effects, the layers clipped to it and its
   * layer masks (no backdrop, its own blend / opacity not applied, shown even when hidden), as
   * straight-alpha sRGB pixels cropped to the alpha box and scaled down to fit `maxSide` px (never enlarged).
   * Null when it draws nothing or is an adjustment layer. Cheap: draft, supersample 1, the comp
   * at THUMB_RENDER_SIDE px in its own pool and renderers, so the preview is not disturbed.
   */
  renderThumb(project: Project, layerId: string, maxSide: number): ImageData | null {
    return this.probes.renderThumb(project, layerId, maxSide);
  }

  /**
   * Largest straight alpha (0..1) of layer or group `layerId` drawn alone exactly as renderThumb
   * draws it (same view, scale, pool and renderers; no crop) within the box `p` ± `radius` (comp
   * px, origin comp centre, +y up; clamped to the comp); 0 when nothing draws there. Canvas
   * picking of layers without a finite box (full-frame generators).
   */
  layerAlphaAt(project: Project, layerId: string, p: { x: number; y: number }, radius: number): number {
    return this.probes.layerAlphaAt(project, layerId, p, radius);
  }

  /**
   * The style part of title layer `layerId` drawn at `p` ± `radius` (comp px, origin comp centre,
   * +y up): each part rendered alone (no effects; 3D parts still occluded by the others), front to
   * back, the first with at least half coverage, else the strongest; null off the title. Canvas
   * ⌥-click on a part. Draft renders at comp resolution (capped) in a pool and renderers of its own.
   */
  partAt(project: Project, layerId: string, p: { x: number; y: number }, radius: number): PartKey | null {
    return this.probes.partAt(project, layerId, p, radius);
  }

  /**
   * Mask `maskId` of layer `layerId` (enabled or not: the Layers panel chips), or with
   * 'combined' its enabled masks together as the composite uses them (canvas "View mask"), over
   * the whole comp: comp aspect with the longer side round(`maxSide`) px, top row first, opaque
   * greyscale (r = g = b = mask × 255, white = shown). All white for a missing layer or mask, or
   * no enabled mask. Draft, in its own pool and renderers: the preview is not disturbed.
   */
  renderMaskPreview(project: Project, layerId: string, maskId: string | 'combined', maxSide: number): ImageData {
    const { width, height } = project.comp;
    return this.probes.renderMask(project, layerId, maskId, Math.max(1, maxSide) / Math.max(width, height), true);
  }

  /**
   * renderMaskPreview at full quality over the whole canvas of `project` at `opts.scale` × comp
   * resolution (renderImageData's size and framing): the combined enabled masks of `layerId`, or
   * mask `opts.maskId` alone (PSD layer masks, Apply mask). Own pool: the preview is not disturbed.
   */
  renderLayerMask(project: Project, layerId: string, opts: { scale: number; maskId?: string }): ImageData {
    return this.probes.renderMask(project, layerId, opts.maskId ?? 'combined', opts.scale, false);
  }

  /**
   * False while an environment (softbox HDRI / photo / custom HDR) of any 3D layer `project`
   * draws (guides included) is still loading — its effective one and its parts'
   * (model/lighting.ts); starts the loads.
   */
  environmentReady(project: Project): boolean {
    let ready = true;
    for (const l of drawnLayers(drawTree(project, true))) {
      if (l.kind !== 'title3d') continue;
      for (const e of layerEnvironments(project.comp, l)) if (!this.env.ready(e)) ready = false;
    }
    return ready;
  }

  /**
   * Resolves once the GLB of every model layer `project` draws has parsed or failed, starting
   * the parses. Parses are shared by every renderer (Layer3DRenderer), so whichever renderer
   * draws the layer next — existing or recreated — draws the model.
   */
  modelsReady(project: Project, includeGuides: boolean): Promise<void> {
    const loads: Promise<void>[] = [];
    for (const l of drawnLayers(drawTree(project, includeGuides))) if (l.kind === 'title3d' && l.source.kind === 'model') loads.push(loadModel(l.source.assetId));
    return Promise.all(loads).then(() => undefined);
  }

  /**
   * Returns a pool RT holding the premultiplied linear composite; caller releases it.
   * `preview`: keep every top-level node's pixels for interactive reuse (and reuse them while interactive).
   */
  private composite(project: Project, scale: number, w: number, h: number, includeGuides: boolean, preview: boolean) {
    const full = this.surfaces.surface(project, this.kit, scale, w, h, preview && this.interactive, this.layerRenderers);
    const acc = this.compositor.background(this.kit, project.comp);
    const top = drawTree(project, includeGuides);
    const result = preview ? this.cache.drawCached(top, acc, full, project, scale, this.interactive) : this.compositor.drawNodes(top, acc, full, null);
    this.endFrame(project);
    return result;
  }

  /** What every render does when its composite is done: frame sources closed, unused masks and gone layers' renderers freed. */
  private endFrame(project: Project) {
    this.surfaces.closeSources();
    this.compositor.masks.sweep();
    pruneRenderers(this.layerRenderers, project);
  }

  dispose() {
    this.cache.dispose();
    this.dropWindowKit();
    disposeRenderers(this.layerRenderers);
    this.probes.dispose();
    this.compositor.masks.dispose();
    this.env.dispose();
    this.readback.dispose();
    this.kit.dispose();
    this.renderer.dispose();
  }
}
