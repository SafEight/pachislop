import type * as THREE from 'three';
import type { Adjustment, BlendMode, Comp, EffectInstance, Gradient, Layer, Material2D, ParamValue, PartKey, Project } from '../model/types';
import type { Bounds } from '../text/layout';
import type { PassKit } from './passkit';

/**
 * The whole render a target belongs to. Normally the target IS the whole render: the comp
 * (possibly enlarged, see io/export.ts `enlarged`) at pxScale, `width`×`height` render px with
 * the comp centre at its centre, and `x` = `y` = 0. A preview window (Engine.render `window`)
 * renders only a part of it: the target is then the `ctx.width`×`ctx.height` px of the whole
 * render whose bottom-left pixel is (`x`, `y`) (render px, GL convention: +y up), and must hold
 * the very pixels the whole render has there. So comp px ↔ target px go through `compCentre`
 * (engine/frame.ts), never `ctx.width / 2`; anything laid out over the whole frame (its edges,
 * corners, size) uses `width` / `height` here; pass sizes stay `ctx.width` / `ctx.height`.
 * GLSL: the comp centre in target px is uniform `uCentre` where a shader needs it.
 */
export interface RenderFrame {
  width: number;
  height: number;
  x: number;
  y: number;
}

/** Context handed to layer renderers for one render. */
export interface LayerRenderContext {
  renderer: THREE.WebGLRenderer;
  kit: PassKit;
  project: Project;
  width: number; // render target pixel size
  height: number;
  pxScale: number; // render pixels per comp pixel (preview < 1, export ≥ 1)
  /** The whole render this target is (a window of); see RenderFrame. */
  frame: RenderFrame;
  /** Comp camera. 1 world unit = 1 comp pixel on the z=0 plane. */
  camera: THREE.PerspectiveCamera;
  /**
   * PMREM-filtered map of `environment` (the effective one of a 3D layer or part, model/lighting.ts)
   * at this render's scale; null while it loads.
   */
  envMap(environment: Comp['environment']): THREE.Texture | null;
  /**
   * Interactive preview frame (engineHost.setInteractive): the renderer may trade quality for
   * speed (coarser tessellation, no AO, …). Draft pixels are only ever shown while the user
   * drags; the engine renders every layer again with `draft: false` on release.
   */
  draft: boolean;
  /**
   * Title layers only: draw just these style parts (src/model/parts.ts), for per-part effects.
   * Undefined = the whole layer. 2D: the other parts are not drawn (knockout still erases
   * what the face covers). 3D: the other parts still occlude (depth only), so each part shows
   * exactly its visible pixels and the isolated renders of all parts tile the full render.
   * The engine passes contiguous runs of `layerParts` order (one run per render; a part with
   * effects alone), several renders per frame with the same layer and context otherwise.
   * 3D only: `[]` draws just the matte shadow (style3d.shadow) the whole title casts, which part
   * runs never draw; the engine requests it when the shadow is enabled and puts it under the parts.
   */
  parts?: readonly PartKey[];
  /**
   * Set by the engine for every render: the frame's other layers drawn alone, for generator
   * layers (GeneratorContext.layerAlpha / layerAlphaKey / layerBounds / layerContent / layerContentKey).
   */
  layerSource?: LayerSource;
}

/**
 * Renders one layer's content, transformed into comp space, into `target`
 * (premultiplied linear RGBA, see passkit.ts). Must fully overwrite/clear `target`.
 * Layer opacity and blend mode are applied by the compositor, NOT by the renderer.
 * One instance per layer id; it may cache geometry/textures between renders and must
 * rebuild them when the relevant layer data changes (compare by reference or a key).
 * If something it needs is still loading (font, asset) it draws what it can and the
 * registry's change event triggers a re-render.
 */
export interface LayerRenderer {
  render(layer: Layer, ctx: LayerRenderContext, target: THREE.WebGLRenderTarget): void;
  dispose(): void;
}

/** Other layers of the frame drawn alone at the render's size (see GeneratorContext for the rules). */
export interface LayerSource {
  alpha(id: string): THREE.Texture | null;
  alphaKey(id: string): string | null;
  bounds(id: string): Bounds | null;
  content(id: string): THREE.Texture | null;
  contentKey(id: string): string | null;
}

// ---------- effects ----------

/** Fields every effect parameter has. */
interface ParamCommon {
  key: string;
  label: string;
  /**
   * Show this control only while param `key` equals `value` (or one of `value`). Hidden params
   * still apply with their stored value.
   */
  when?: { key: string; value: string | boolean | string[] };
}

export type ParamDef = ParamCommon &
  (
    | {
        kind: 'number';
        default: number;
        min: number;
        max: number;
        step?: number;
        /** 'px' params are in comp pixels; multiply by ctx.pxScale for render pixels. */
        unit?: 'px' | 'deg' | '%' | 'x';
      }
    | { kind: 'color'; default: string }
    | { kind: 'bool'; default: boolean }
    | { kind: 'select'; default: string; options: { value: string; label: string }[] }
    | { kind: 'gradient'; default: Gradient }
    /** Id of another layer in the project ('' = none); the UI shows a layer picker. */
    | { kind: 'layer'; default: '' }
    /**
     * Structured value (a whole Material2D) edited by its own editor (ParamControl): the editor
     * writes below `params[key]` through ordinary path edits, so undo labels name the field.
     * `fillWhen`: the material's Fill section shows only while param `key` equals `value` (the
     * Material effect shades the layer's own colours otherwise).
     */
    | { kind: 'material2d'; default: Material2D; fillWhen?: { key: string; value: string } }
    /**
     * One adjustment (Levels, Curves, Hue/Saturation…), the same operation and editor as an
     * adjustment layer's; edited below `params[key]` like 'material2d'.
     */
    | { kind: 'adjustment'; default: Adjustment }
  );

/** Add-menu groups, in menu order (see src/ui/properties/AddEffectMenu.tsx). */
export type EffectCategory = 'Glow' | 'Blur' | 'Shadow' | 'Material' | 'Color' | 'Distort';

/**
 * What effects and generators share, and all the shared GPU helpers (effects/lib.ts,
 * effects/b/common.ts, generators/common.ts) need: a GeneratorContext also satisfies it.
 */
export interface PassContext {
  renderer: THREE.WebGLRenderer;
  kit: PassKit;
  width: number;
  height: number;
  pxScale: number;
  /** The whole render the target is (a window of): see RenderFrame. */
  frame: RenderFrame;
  /**
   * Id of the layer (or group) whose pixels an effect gets as `input`; `${layerId}#${PartKey}`
   * for a part's own effects (PartEffects), which run on that part's pixels alone. For a
   * generator, the id of the generator layer.
   */
  layerId: string;
  /** The comp being rendered: `comp.globalLight` drives effects with `useGlobalLight` on. */
  comp: Comp;
  /**
   * Interactive preview frame (see LayerRenderContext.draft): the effect may trade quality for
   * speed, e.g. skip GPU→CPU readbacks and reuse what it measured for `layerId` last frame.
   */
  draft: boolean;
}

export interface EffectContext extends PassContext {
  /**
   * The pixels of the layer, group or part (for an adjustment layer: the adjusted composite)
   * BEFORE any of its effects: same size and convention as `input` (comp-size, premultiplied
   * linear), and the same texture as `input` for the first effect of the stack. Effects that
   * take a shape from the silhouette (emission edge, crack layout, keyline, aura source) read it
   * here, so an earlier glow, shadow or stroke does not move that shape, and still composite
   * over `input`.
   */
  content: THREE.Texture;
}

/** Resolved parameter values (defaults filled in for missing keys). */
export type EffectParams = Record<string, ParamValue>;

/** A named starting point of an effect (Material's Chrome, Glass…): params over the instance's current ones. */
export interface EffectPreset {
  id: string;
  label: string;
  params: Partial<EffectParams>;
}

export interface EffectDef {
  type: string; // stable id stored in projects, e.g. 'outerGlow'
  label: string; // UI name, e.g. 'Outer Glow'
  category: EffectCategory;
  description: string;
  params: ParamDef[];
  /**
   * On-canvas handles. Each names two number params holding a comp-px position
   * (origin = comp centre, +y up) that the user can drag in the viewport.
   * `when`: show the handle only while select param `key` currently equals `value`.
   */
  handles?: { x: string; y: string; label: string; when?: { key: string; value: string } }[];
  /** Named starting points shown as chips on the effect card (Chrome, Glass… of Material): params over the current ones. Label in English, translated by the UI. */
  presets?: EffectPreset[];
  /**
   * Direction handles: an angle param (degrees, in this effect's own convention given by
   * `convention`) plus an optional length/distance param in comp px. The viewport draws
   * an arrow from the layer's centre that can be dragged. `when` as for handles.
   */
  directions?: {
    angle: string;
    length?: string;
    label: string;
    convention: 'cwFromRight' | 'ccwFromRight';
    when?: { key: string; value: string };
  }[];
  /**
   * Light direction pair (angle + elevation degrees) shown as a draggable light sphere
   * instead of two sliders. `convention` as above for the angle.
   */
  light?: { angle: string; elevation: string; convention: 'cwFromRight' | 'ccwFromRight' };
  /**
   * How far (comp px, conservative) this effect can draw outside the layer's ink with params
   * `p`: the selection box pads by it. Omit for effects that stay inside the ink or fill the
   * whole comp (burst rays, lens flare). Read it through `effectReach()` in effects/registry.
   */
  reach?(p: EffectParams): number;
  /**
   * True when, with params `p`, this effect draws to the edges of whatever canvas it gets
   * (burst rays 'behind', lens flare streaks, full-frame colour): its layer has no finite ink
   * box, so a trimmed export measures that layer clipped to the comp instead of growing the
   * canvas after it. Read it through `effectFillsComp()` in effects/registry.
   */
  fillsComp?(p: EffectParams): boolean;
  /**
   * How far (comp px, conservative) back into its input (and `content`) each pixel this effect
   * writes can look with params `p`, when that neighbourhood is all that decides it: no
   * measurement over the whole layer or frame (layer box, ink box, grids), nothing laid out over
   * the frame. A preview window (Engine.render `window`) then needs only that margin around what
   * it shows, not the whole layer (ui/viewport/previewWindow.ts). Null or omitted: it may depend
   * on the whole layer. Read it through `effectGather()` in effects/registry.
   */
  gather?(p: EffectParams): number | null;
  /**
   * Read `input` and write the full result to `output` (both comp-size, premultiplied linear).
   * `input` and `output` are always different targets. Scratch targets come from
   * ctx.kit.acquire()/release(). Output must be a deterministic function of input and params.
   */
  apply(ctx: EffectContext, input: THREE.Texture, output: THREE.WebGLRenderTarget, p: EffectParams): void;
  dispose?(): void;
}

// ---------- generators (GeneratorLayer) ----------

/** Add-menu groups for generators, in menu order. */
export type GeneratorCategory = 'Particles' | 'Lines' | 'Rings' | 'Light' | 'Energy' | 'Pattern';

export interface GeneratorContext {
  renderer: THREE.WebGLRenderer;
  kit: PassKit;
  /** Render target size in pixels (the comp at `pxScale`, possibly enlarged by export margins, or a window of that: `frame`). */
  width: number;
  height: number;
  /** Render pixels per comp pixel. */
  pxScale: number;
  /** The whole render the target is (a window of): see RenderFrame. */
  frame: RenderFrame;
  comp: Comp;
  /** Id of the generator layer. */
  layerId: string;
  /** Interactive preview frame: may trade quality for speed (fewer particles, no blur passes). */
  draft: boolean;
  /**
   * Layer space → render pixels: layer space is comp px with the origin at the layer position
   * (transform x / y) and +y up, already turned by rotZ and scaled by `scale`; render pixels
   * have the origin at the target's bottom-left (GL convention). Build geometry in layer space
   * and apply this; full-frame fills map fragments back with its inverse.
   */
  layerToRender: THREE.Matrix3;
  /**
   * Layer `id` drawn alone (with its effects and clipped layers) in RENDER pixels on a target of
   * this size, premultiplied — use `.a` as a mask (focus shape of speed lines, particle emitter).
   * Drawn like a layer thumbnail: shown even when it or its groups are hidden (so a hidden layer
   * can serve as an emitter, and isolated exports keep the shape), solo ignored, guides drawn.
   * Null when the id is '', missing, an adjustment layer, still draws nothing (empty group, hidden
   * clip base), a generator currently rendering (this layer itself or one that asked for it), or
   * a group / clip base holding one (a cycle). Rendered once per frame and id; valid until the
   * frame ends.
   */
  layerAlpha(id: string): THREE.Texture | null;
  /**
   * A string that changes whenever `layerAlpha(id)`'s pixels could change (that layer, its
   * ancestors, the layers drawn with it, the layers they reference through 'layer' params, the
   * comp, render size, pxScale, draft), null exactly when `layerAlpha(id)` is null. Cheap: no GPU
   * work, so key CPU readbacks of the alpha by it.
   */
  layerAlphaKey(id: string): string | null;
  /** Comp-px box (origin comp centre, +y up) of that layer's alpha, or null. */
  layerBounds(id: string): Bounds | null;
  /**
   * Layer `id`'s pixels BEFORE its own effects, in render pixels on a target of this size,
   * premultiplied linear: what an effect on that layer got as `EffectContext.content` (part
   * effects included; no clipped layers, no layer masks). Follow generators take the shape they
   * grow from here (outline, inside, emission edge). Same null, cycle and caching rules as
   * `layerAlpha`; valid until the frame ends.
   */
  layerContent(id: string): THREE.Texture | null;
  /** As `layerAlphaKey`, for `layerContent(id)` (null exactly when it is null). */
  layerContentKey(id: string): string | null;
}

/**
 * A named starting point of a generator (金粉, 火の粉, 紙吹雪…): params over the defaults, and the
 * layer-level look that goes with them (blend, effects). Label in English, translated by the UI.
 */
export interface GeneratorPreset {
  id: string;
  label: string;
  params: Partial<EffectParams>;
  /** Layer blend a new layer from this preset gets (light-like looks: 'add'); applying the preset to an existing layer sets it too. Absent = Normal / unchanged. */
  blend?: BlendMode;
  /**
   * Effects of the look (a glow, a vignette), at the bottom of the layer's stack: a new layer gets
   * copies marked `fromPreset`; applying the preset to an existing layer replaces the effects the
   * previous preset added (`fromPreset`) and keeps the user's own. Missing params take the effect's
   * defaults; ids are replaced on copy.
   */
  effects?: EffectInstance[];
  /** Layer opacity (0..1) a new layer from this preset gets, like `blend`; absent = 1 / unchanged. */
  opacity?: number;
  /** Follow generators added "on <layer>" (a companion): above (absent) or below the followed layer. */
  place?: 'above' | 'below';
}

export interface GeneratorDef {
  type: string; // stable id stored in projects, e.g. 'speedLines'
  label: string; // UI name, e.g. 'Speed Lines'
  category: GeneratorCategory;
  description: string;
  params: ParamDef[];
  /** Starting points shown in the add menu and the Properties preset row; the first is used for a plain "add". */
  presets: GeneratorPreset[];
  /** On-canvas point handles (two number params, LAYER-space comp px), as EffectDef.handles. */
  handles?: { x: string; y: string; label: string; when?: { key: string; value: string } }[];
  /** On-canvas direction arrows from the layer origin, as EffectDef.directions. */
  directions?: { angle: string; length?: string; label: string; convention: 'cwFromRight' | 'ccwFromRight'; when?: { key: string; value: string } }[];
  /**
   * On-canvas size handles: a box / ellipse (`shape`, absent = ellipse) of half-width `rx` and
   * half-height `ry` (number params, comp px) around the centre `x` / `y` (number params,
   * layer-space comp px; absent = the layer origin). `ry` absent = circle / square.
   */
  sizes?: { rx: string; ry?: string; x?: string; y?: string; shape?: 'ellipse' | 'box'; label: string; when?: { key: string; value: string } }[];
  /**
   * Layer-space comp-px box the generator can draw into with params `p` while free (not
   * following a layer): selection box, picking, thumbnails. Null = it fills the whole comp
   * (full-frame types). Read through `generatorFillsComp()` in generators/registry, which also
   * covers following.
   */
  bounds(p: EffectParams): Bounds | null;
  /**
   * Follow-capable generators (their first param is `followParam()`, generators/common.ts):
   * 'required' = it draws nothing until a layer is picked (the UI says "pick a layer"),
   * 'optional' = free (own x / y) or following. While following, it draws in comp space where
   * the followed layer is, and its own transform is an offset on top (`followOffset`).
   */
  follow?: 'required' | 'optional';
  /**
   * While following a layer: how far (comp px, conservative) it can draw outside that layer's
   * ink with params `p` (the selection box grows the followed layer's box by it), or null when
   * it then still fills the whole comp (burst rays). Required with `follow`.
   */
  followReach?(p: EffectParams): number | null;
  /** Ids of fonts (src/assets/registry.ts) the render needs with params `p` (text rings); exports load them first. */
  fonts?(p: EffectParams): string[];
  /**
   * Draw into `target` (render size, premultiplied linear RGBA), fully overwriting it. Must be a
   * deterministic function of params (seeded randomness) and look the same at every export
   * scale: positions and sizes are comp px × pxScale. Scratch targets from ctx.kit.acquire().
   */
  render(ctx: GeneratorContext, target: THREE.WebGLRenderTarget, p: EffectParams): void;
  dispose?(): void;
}
