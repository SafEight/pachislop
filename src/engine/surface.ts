import type * as THREE from 'three';
import type { Comp, Project } from '../model/types';
import type { LayerRenderContext, LayerRenderer } from './contracts';
import type { LeafLayer } from './drawTree';
import { createGeneratorRenderer } from './GeneratorRenderer';
import { createBackgroundRenderer, createTitle2DRenderer } from './layer2d/Title2DRenderer';
import { FrameSource, type SourceHost } from './layerSource';
import type { PassKit } from './passkit';
import { createLayer3DRenderer } from './three/Layer3DRenderer';
import type { EnvironmentManager } from './three/environment';

const DEG = Math.PI / 180;

export type RendererMap = Map<string, { kind: LeafLayer['kind']; r: LayerRenderer }>;

/** A render size with its pool, the layer context for it and the renderer instances to draw with. */
export interface Surface {
  kit: PassKit;
  width: number;
  height: number;
  scale: number;
  ctx: LayerRenderContext;
  renderers: RendererMap;
  /** The other layers drawn alone for generators (also `ctx.layerSource`), released at the end of the frame. */
  source: FrameSource;
}

/** Render px of `project`'s comp at `scale` render px per comp px. */
export function sizeFor(project: Project, scale: number) {
  return {
    w: Math.max(1, Math.round(project.comp.width * scale)),
    h: Math.max(1, Math.round(project.comp.height * scale)),
  };
}

/** The renderer instance in `map` for `layer`, (re)created when missing or of another kind. */
export function rendererFor(layer: LeafLayer, map: RendererMap): LayerRenderer {
  const existing = map.get(layer.id);
  if (existing && existing.kind === layer.kind) return existing.r;
  existing?.r.dispose();
  let r: LayerRenderer;
  switch (layer.kind) {
    case 'title3d':
      r = createLayer3DRenderer();
      break;
    case 'title2d':
      r = createTitle2DRenderer();
      break;
    case 'background':
      r = createBackgroundRenderer();
      break;
    case 'generator':
      r = createGeneratorRenderer();
      break;
  }
  map.set(layer.id, { kind: layer.kind, r });
  return r;
}

/** Dispose the renderers in `map` of layers `project` no longer has. */
export function pruneRenderers(map: RendererMap, project: Project) {
  if (map.size === 0) return;
  const live = new Set(project.layers.map((l) => l.id));
  for (const [id, entry] of map) {
    if (!live.has(id)) {
      entry.r.dispose();
      map.delete(id);
    }
  }
}

/** Dispose every renderer in `map` and empty it. */
export function disposeRenderers(map: RendererMap) {
  for (const { r } of map.values()) r.dispose();
  map.clear();
}

/** Builds the Surfaces of a render (camera aimed, layer context, FrameSource) and closes their sources when it ends. */
export class Surfaces {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly env: EnvironmentManager;
  private readonly sourceHost: SourceHost;
  /** FrameSources of the render in progress: closed (their alphas released) when it ends. */
  private readonly sources: FrameSource[] = [];

  constructor(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, env: EnvironmentManager, sourceHost: SourceHost) {
    this.renderer = renderer;
    this.camera = camera;
    this.env = env;
    this.sourceHost = sourceHost;
  }

  /**
   * Size `kit` to `w`×`h`, aim `camera` (the engine's by default) and build the layer context for
   * rendering `project`.
   */
  surface(project: Project, kit: PassKit, scale: number, w: number, h: number, draft: boolean, renderers: RendererMap, camera = this.camera): Surface {
    kit.setSize(w, h);
    aimCamera(camera, project);
    const { comp } = project;
    const ctx: LayerRenderContext = {
      renderer: this.renderer,
      kit,
      project,
      width: w,
      height: h,
      pxScale: scale,
      camera,
      envMap: (e) => this.env.update(e, scale),
      draft,
    };
    return this.withSource({ kit, width: w, height: h, scale, ctx, renderers }, comp);
  }

  /** `base` with a FrameSource of its own (also as `ctx.layerSource`), closed by closeSources when the render ends. */
  withSource(base: Omit<Surface, 'source'>, keyComp: Comp): Surface {
    const source = new FrameSource(base, keyComp, this.sourceHost);
    base.ctx.layerSource = source;
    this.sources.push(source);
    return { ...base, source };
  }

  closeSources() {
    for (const src of this.sources) src.close();
    this.sources.length = 0;
  }
}

/** Aim `camera` at `project`'s comp: 1 world unit = 1 comp px on the z = 0 plane. */
function aimCamera(camera: THREE.PerspectiveCamera, project: Project) {
  const { comp } = project;
  const cam = comp.camera;
  const fov = Math.min(170, Math.max(1, cam.fov));
  const dist = comp.height / 2 / Math.tan((fov * DEG) / 2);
  camera.fov = fov;
  camera.aspect = comp.width / comp.height;
  camera.near = Math.max(1, dist * 0.01);
  camera.far = dist * 20;
  camera.position.set(cam.x, cam.y, dist + cam.zOffset);
  camera.rotation.set(cam.rotX * DEG, cam.rotY * DEG, cam.rotZ * DEG);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}
