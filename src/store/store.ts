import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { createProject } from '../model/defaults';
import type { AdjustmentType, Layer, LayerMask, ParamValue, PartKey, Project, ShapeKind, Title2DLayer, Title3DLayer } from '../model/types';
import type { PxBox } from '../io/imageSplit';
import type { StylePreset } from '../presets/types';
import type { AlignMode, ArrangeOp } from './arrange';
import type { Core } from './core';
import { effectsSlice } from './effectsOps';
import { historySlice } from './history';
import { imageSlice } from './imageOps';
import { layerSlice } from './layerOps';
import { masksSlice, type AddMaskOpts, type MaskPatch } from './masksOps';
import type { Text } from './msg';
import { notifySlice } from './notify';
import type { Path } from './paths';
import { selectionSlice } from './selection';
import { textSlice } from './textOps';
import { transformSlice } from './transformOps';
import type { LayerXform } from './tree';
import { DEFAULT_VIEW, viewSlice } from './view';

export type { AlignMode, ArrangeOp } from './arrange';
export type { AddMaskOpts, MaskPatch } from './masksOps';
export type { LayerXform } from './tree';
export type { Path } from './paths';

/**
 * A row of the Layers panel the user can focus: a layer, one style part of a title, several parts
 * of one title (2+, ⇧ / ⌘-clicked; edited together), one effect, or one layer mask.
 */
export type NodeRef =
  | { kind: 'layer'; layerId: string }
  | { kind: 'part'; layerId: string; part: PartKey }
  | { kind: 'parts'; layerId: string; parts: PartKey[] }
  | { kind: 'effect'; layerId: string; part: PartKey | null; effectId: string }
  | { kind: 'mask'; layerId: string; maskId: string };
/** Whose effect stack: `part` null = the layer's / group's own effects, else that title part's. */
export type EffectOwner = { layerId: string; part: PartKey | null };
/** Tool strip tools (Photoshop keys V A T U G D L H Z). */
export type Tool = 'move' | 'glyph' | 'text' | 'shape' | 'gradient' | 'distort' | 'light' | 'hand' | 'zoom';
/**
 * Where layers land in the stack: just above / below layer `aboveId` / `belowId` (below = under
 * its whole subtree) in its parent, or `into` a group (null = top level) at `index` among that
 * parent's children counted from the BOTTOM (default: on top).
 */
export type LayerDest = { aboveId: string } | { belowId: string } | { into: string | null; index?: number };

/** One piece of a split image (splitImageLayer): its image asset and where it was cut from the picture (px). */
export interface ImagePiece {
  assetId: string;
  box: PxBox;
}

/** What the next new text layer starts with (Text tool options bar, edited while no text layer is selected). */
export interface TextDefaults {
  fontId: string;
  /** Text size, comp px. */
  size: number;
  /** Letter spacing, as TextSource.tracking. */
  tracking: number;
  /** Solid face colour '#rrggbb'; null = the factory look. */
  fill: string | null;
}

/** Address of a value: relative to a layer (layerId set) or to the project root (layerId null). */
export interface PropRef {
  layerId: string | null;
  path: Path;
}
/**
 * One value or the same value in several places (several layers' rim widths, several parts'
 * colours), edited together: read with getRef (the shared value or MIXED), written with setAt.
 */
export type Refs = PropRef | readonly PropRef[];

export type PreviewRes = 1 | 0.5 | 0.25;
/** 'fit' or a display scale (1 = 100%). */
export type Zoom = 'fit' | number;
export type PreviewBg = 'checker' | 'black' | 'white' | 'custom';

/** Editor-only view settings (never exported, not part of undo history). */
export interface ViewState {
  /** Active tool-strip tool. */
  tool: Tool;
  /** Move tool: a canvas click picks the deepest layer ('layer') or its top-level group ('group'), like PS Auto-Select. */
  autoSelect: 'layer' | 'group';
  /** Kind of layer the Text tool (and shapes) create. */
  textKind: '2d' | '3d';
  /** Shape the Shape tool creates. */
  shapeKind: ShapeKind;
  /** Layers panel twirl state per layer id (title parts list / group children); absent = groups open, titles closed. */
  expanded: Record<string, boolean>;
  textDefaults: TextDefaults;
  /** Move tool: scale / rotate handles on the canvas. */
  showHandles: boolean;
  zoom: Zoom;
  /** Pan offset of the stage centre in screen px. */
  panX: number;
  panY: number;
  /** Upper bound of the preview frame, × comp px; below it the frame matches the display's device pixels (Viewport). */
  previewRes: PreviewRes;
  previewBg: PreviewBg;
  previewBgColor: string;
  /** Title/action-safe + centre guides. */
  safeGuides: boolean;
  /** Dragging a 3D layer orbits it (rotX/rotY) instead of moving it (Alt/Option-drag does too). */
  orbit: boolean;
  /** 引き目 distance check: an inset of the comp drawn at `distanceScale` of its pixel size. */
  distance: boolean;
  /** Inset scale, comp px → CSS px (0.25 ≈ an LCD seen from the seat). */
  distanceScale: number;
  /** 引き目 value check: the viewport (and inset) shown in greyscale. */
  valueCheck: boolean;
  /** CMYK gamut warning (⇧⌘Y): hatch colours an offset press can't print (GamutOverlay). */
  gamut: boolean;
  /** “View mask” (⌥-click a mask chip): this layer's combined enabled masks drawn greyscale over the canvas; null = off. */
  viewMask: string | null;
}

export interface Toast {
  id: number;
  text: Text;
  kind: 'info' | 'error';
}

/** An in-app yes / no question (replaces `confirm()`); App renders it. */
export interface ConfirmRequest {
  title: Text;
  message: Text;
  /** Label of the confirming button. */
  ok: Text;
}

/**
 * The TopBar's offer to rename a project still named after its title text, once that text was
 * retyped. The proposed name is read live from the layer's text.
 */
export interface RenameOffer {
  layerId: string;
  /** The project name matched the whole text (lines joined by spaces), not just its first line. */
  whole: boolean;
}

/**
 * One undo step. In `past`, `project` is the state BEFORE the edit named `label`; in `future`
 * it is the state AFTER it.
 */
export interface HistoryStep {
  project: Project;
  label: Text;
}


export interface EditorState {
  project: Project;
  /** Primary selected layer: the one Properties shows. */
  selectedLayerId: string | null;
  /** All selected layers, bottom first; always contains `selectedLayerId` when that is non-null. */
  selectedLayerIds: string[];
  /**
   * Focused Layers-panel node: a 'layer' node of the primary selected layer when a layer is just
   * selected, or one of its parts / effects / masks. Its layerId is always `selectedLayerId`; null
   * when nothing is selected. Effect and mask nodes show their on-canvas handles.
   */
  selectedNode: NodeRef | null;
  /**
   * Characters (indices into Array.from(text)) picked in the Text tab, ascending; the first is
   * the primary one whose values the editors show. Empty = none.
   */
  selectedChars: number[];
  /** Text layer whose text is being edited inline on the canvas (the Viewport draws the editor). */
  textEditLayerId: string | null;
  /**
   * Transient hover preview, not undoable: a layer rendered in place of the one with the same id,
   * or a whole project (a look adds companions and a group) rendered instead of the current one.
   */
  previewOverride: Layer | Project | null;
  view: ViewState;
  /** Display scale (comp px → CSS px) that 'fit' zoom currently resolves to; written by the Viewport. */
  fitScale: number;
  toast: Toast | null;
  past: HistoryStep[];
  future: HistoryStep[];
  lastCoalesce: string | null;
  /** Copied layer look (⌘⌥C), carried as a StylePreset so pasting reuses applyPreset. */
  styleClip: StylePreset | null;

  /** Open in-app confirmation, if any; answered through `answerConfirm`. */
  confirmation: (ConfirmRequest & { resolve: (ok: boolean) => void }) | null;
  renameOffer: RenameOffer | null;

  /**
   * Replace the project through a pure function. Same `coalesce` key as the previous edit = one
   * undo step. `label` names the step in History (derived from what changed when omitted).
   */
  edit(fn: (p: Project) => Project, coalesce?: string, label?: Text): void;
  /**
   * Set one value at every target of `ref`, in one undo step. The History label defaults to a
   * description of the path (“Rim width”, “Rim width on 3 layers”, “Colour of 4 parts”).
   */
  setAt(ref: Refs, value: unknown, coalesce?: string, label?: Text): void;
  /**
   * Set every target of `ref` from its own value at the start of the gesture `coalesce` (or its
   * current value without one), in one undo step: relative edits of mixed values (a scrub that
   * adds the same offset to every layer's rim width).
   */
  setEachAt(ref: Refs, fn: (start: unknown, index: number) => unknown, coalesce?: string, label?: Text): void;
  /** Undoable whole-project replacement. Selection moves to the top non-guide layer (none when there is none). */
  setProject(p: Project, label?: Text): void;
  /**
   * setProject after an in-app confirmation (skipped when the current comp has no non-guide
   * layers, so there is nothing to lose). Resolves false when the user cancels.
   */
  replaceProject(p: Project, label: Text, what: Text): Promise<boolean>;
  /** Replace the project and reset history (autosave restore). */
  loadProject(p: Project): void;
  /** Ask a yes / no question in-app; resolves false on cancel (or when another question replaces it). */
  confirm(req: ConfirmRequest): Promise<boolean>;
  answerConfirm(ok: boolean): void;
  /** Accept (rename the project to the offered name) or dismiss the rename offer; it is not offered again for this project. */
  settleRenameOffer(accept: boolean): void;

  /**
   * Add a layer and select it: at `at` when given (Layers-panel file drops, backing shapes), else
   * just above the primary selection inside the same parent (top level when none). Inserted inside
   * a clip group (above a clipped layer, or between a base and its clipped layers) it is clipped
   * too, as in PS.
   */
  addLayer(layer: Layer, at?: LayerDest): void;
  /**
   * Add a shape layer just below title `targetId`, fitted around it (see fitShapeTo); it takes
   * the title's rotation.
   */
  addBackingShape(shape: Title2DLayer | Title3DLayer, targetId: string): void;
  /** Re-fit a shape layer around the nearest text / shape title above or below it in the stack (keeps its rotation). */
  fitShapeLayer(id: string, to: 'above' | 'below'): void;
  /** Deleting a group deletes its subtree; the selection moves to a neighbour in the same parent, else to the parent. */
  removeLayers(ids: string[]): void;
  /**
   * Copies (groups with their subtrees) land just above their originals — above a base's whole
   * clip group, so the copy doesn't steal its clipped layers — and become the selection.
   */
  duplicateLayers(ids: string[]): void;
  /**
   * Move the layers (groups with their subtrees, bases with the layers clipped to them) as one
   * block: just above / below layer `aboveId` / `belowId` (below = under its whole subtree) in its
   * parent, or `into` a group (null = top level) at `index` among that parent's other children
   * counted from the BOTTOM (default: on top). Landing inside a clip group clips the moved layers;
   * a clipped layer moved out of one is released. Moving a group into its own subtree is refused.
   */
  moveLayers(ids: string[], to: LayerDest): void;
  /** Photoshop Arrange (⌘] / ⌘[ / ⌘⇧] / ⌘⇧[); see arrange(). */
  arrangeLayers(ids: string[], op: ArrangeOp): void;
  /** Translate the movable layers (groups: their descendants) by comp px (+y up); same `coalesce` = one undo step. */
  nudgeLayers(ids: string[], dx: number, dy: number, coalesce?: string): void;
  /**
   * Move / scale / rotate the listed layers as one (groups: their descendants; a group's own
   * transform is never touched). Each layer's transform becomes `xf` applied to its transform in
   * `base` (a gesture-start snapshot of project.layers; default: the current layers), so a drag
   * passes absolute factors and never drifts. `xf.about` defaults to the centre of the layers'
   * common comp box in `base`. Locked layers (or inside a locked group) stay put.
   */
  transformLayers(ids: string[], xf: LayerXform, coalesce?: string, label?: Text, base?: readonly Layer[]): void;
  /**
   * Edit ▸ Transform ▸ Flip Horizontal ('x') / Vertical ('y') of the listed layers (groups: their
   * descendants; a group's own transform is never touched), as one undo step: each movable layer
   * toggles flipX / flipY and its rotations mirror with it, so the result is the screen mirror;
   * positions mirror about the centre of the layers' common comp box, which stays put (as in
   * Photoshop, one layer included). Locked layers (or inside a locked group) stay put.
   */
  flipLayers(ids: string[], axis: 'x' | 'y'): void;
  /**
   * ⌘G: put the layers (bases with their clipped layers) in a new group, selected, at the
   * topmost one's place in that one's parent; returns its id (null when nothing was listed).
   */
  groupLayers(ids: string[]): string | null;
  /** ⇧⌘G: dissolve the listed groups and the parents of listed non-groups; their children take the group's place in its parent. */
  ungroupLayers(ids: string[]): void;
  /** ⌥⌘G on the selection (or `ids`): clip them to the layer below, or release them (and the clipped layers above them) when all are clipped. */
  toggleClip(ids?: string[]): void;
  /** New adjustment layer just above the primary selection in its parent, selected; clipped when `opts.clip` or when inserted inside a clip group. Returns its id. */
  addAdjustment(type: AdjustmentType, opts?: { clip?: boolean }): string;
  /**
   * New generator layer of `type` from preset `presetId` (default: its first preset) just above
   * the primary selection in its parent, selected (clipped when inserted inside a clip group),
   * named “<preset> N” in the UI language. With `on` (a layer id) a follow generator instead
   * follows that layer as its companion, in a group with it, above or below it as the preset's
   * `place` says. Returns its id; null for an unknown type.
   */
  addGenerator(type: string, presetId?: string, on?: string): string | null;
  /**
   * Replace a generator layer's params with preset `presetId`'s, as one undo step: transform,
   * effects and the picked source layers ('layer' params) are kept. A layer still named after
   * one of its type's presets (“金粉 2”) takes the new preset's numbered name.
   */
  applyGeneratorPreset(layerId: string, presetId: string): void;
  renameLayer(id: string, name: string): void;
  /** Align to the layers' common box (2+ movable) or to the comp (1); a group aligns as one box, a full-frame generator as the comp. */
  alignLayers(ids: string[], mode: AlignMode): void;
  /** Equal gaps between 3+ layers along an axis; the outermost two stay. */
  distributeLayers(ids: string[], axis: 'x' | 'y'): void;
  patchLayer(id: string, patch: Partial<Layer>, coalesce?: string, label?: Text): void;
  replaceLayer(id: string, layer: Layer, coalesce?: string, label?: Text): void;
  /**
   * Swap a title layer's source for an imported SVG (asset `assetId`), keeping transform, style
   * and effects: sized to fit the old source box and centred where it was.
   */
  replaceWithSvg(id: string, assetId: string, name: string): void;
  /**
   * Turn a 2D title into a 3D one or back, as one undo step: the source (text, shape, SVG or
   * image), transform, warp / distort / weight, effects, masks, name, parent, clip and the layer flags
   * stay; the style becomes the target kind's default look, as a new layer of that kind gets it
   * (titleLayerFor: an image takes the plain image look). Model sources are refused (3D only).
   */
  convertLayerKind(id: string, kind: '2d' | '3d'): void;
  /**
   * Layer via Cut, automated (SplitImageDialog): replace image layer `id` by a group named after
   * it that holds one layer per piece, “<name> 1”, “<name> 2”… left to right (1 on top), as one
   * undo step. `size`: the layer's picture in px; each piece is an image asset cut from it at
   * `box`. Every piece layer keeps the kind, style (its size-relative units rescaled, so every
   * dimension stays as it was), effects and flags, and is placed so its piece lands exactly where
   * it was (rotation, scale and position composed). The group takes the layer's place and clip,
   * and is selected.
   */
  splitImageLayer(id: string, size: { w: number; h: number }, pieces: readonly ImagePiece[]): void;
  /**
   * 図柄 size matching: a locked guide copy at 30 % opacity just above the layer. Selection
   * stays on the original so it can be retyped / resized against the ghost.
   */
  duplicateAsGhost(id: string): void;
  copyStyle(id: string): void;
  /** Paste the copied look onto every listed layer of the same kind; px effect params scale by the size ratio. */
  pasteStyle(ids: string[]): void;
  /**
   * Change a text layer's text, keeping per-character adjustments on the same characters
   * (see remapChars). Layers still named after their text (textName) follow it.
   */
  setText(layerId: string, text: string, coalesce?: string): void;
  /** Single selection (null = none); focuses the layer node. */
  selectLayer(id: string | null): void;
  /** Replace the selection; `primary` defaults to the current primary if listed, else the last id. */
  selectLayers(ids: string[], primary?: string): void;
  /** ⌘-click: add / remove one layer; an added layer becomes the primary. */
  toggleLayerSelection(id: string): void;
  /**
   * Focus a node (null = select nothing). Layer nodes select like a click (`additive` = ⌘-click
   * toggle, `range` = ⇧-click: every panel-visible layer between the last clicked layer and this
   * one). A part / effect / mask node makes its layer the primary (kept in the multi-selection
   * when already selected). Part nodes: `additive` toggles the part in / out of the layer's
   * selected parts, `range` selects the parts listed between the last clicked part and this one;
   * 2+ parts become a 'parts' node, one a 'part' node, none the layer node.
   */
  selectNode(node: NodeRef | null, opts?: { additive?: boolean; range?: boolean }): void;
  setTool(tool: Tool): void;
  /** Open inline text editing of a text layer on the canvas (selects it alone). */
  beginTextEdit(id: string): void;
  endTextEdit(): void;

  /**
   * Append an effect (top of the stack) to `owner`, its params from `params` where given, else
   * defaults; focus it and return its id; null when the type is unknown or the owner can't take
   * effects. Several owners (selected parts) get one effect each in one undo step, and the
   * selection stays; the first one's id is returned.
   */
  addEffect(owner: EffectOwner | readonly EffectOwner[], type: string, params?: Readonly<Record<string, ParamValue>>): string | null;
  removeEffect(owner: EffectOwner, effectId: string): void;
  setEffectEnabled(owner: EffectOwner, effectId: string, enabled: boolean): void;
  /**
   * Move (or with `copy`, copy with fresh ids) one effect or a block of them, in the listed
   * order, to `to` so the first lands at array index `index` of `to`'s list after the operation
   * (0 = applied first). Same owner + copy = duplicate. One undo step; the (first) moved effect
   * is focused. Refused with a notice when `to` can't take effects (a missing layer or part).
   */
  moveEffect(from: EffectOwner, effectId: string | readonly string[], to: EffectOwner, index: number, copy: boolean): void;
  /** Show / hide a style part: 2D rim → its `enabled`, 2D face → `!style.hideFace`, 3D plate → its `enabled`; 3D face / side / bands have no switch (no-op). */
  setPartEnabled(layerId: string, part: PartKey, enabled: boolean): void;

  /**
   * Add a layer mask on top of `layerId`'s list, focus it and return its id. Fitted to the layer's
   * content box (linked, in layer space; a group: its children's box, else the comp, unlinked):
   * a shape mask is that box's rectangle (or `opts.shape` inside it), a linear gradient runs from
   * opaque at the top to transparent at the bottom, a radial one fades out to the corners, a layer
   * mask reads `opts.source` (default: the nearest usable layer above, else below). Null (with a
   * notice) when a layer mask has no layer to read.
   */
  addMask(layerId: string, kind: LayerMask['kind'], opts?: AddMaskOpts): string | null;
  removeMask(layerId: string, maskId: string): void;
  /** Change fields of one mask; same `coalesce` = one undo step; the History label defaults to the changed field (“Mask 1 feather”). */
  updateMask(layerId: string, maskId: string, patch: MaskPatch, coalesce?: string, label?: Text): void;
  setMaskEnabled(layerId: string, maskId: string, enabled: boolean): void;
  /** Move one mask to array `index` of its layer's list after the move (0 = applied first). */
  moveMask(layerId: string, maskId: string, index: number): void;
  /**
   * Apply mask (image layers only): show image asset `assetId` (the picture with the mask baked
   * into its alpha, see ui/layers/maskBake) in place of the old one and drop the mask, as one
   * undo step.
   */
  applyMask(layerId: string, maskId: string, assetId: string): void;
  selectChars(indices: number[]): void;

  setPreviewOverride(override: Layer | Project | null): void;
  setView(patch: Partial<ViewState>): void;
  setFitScale(scale: number): void;
  notify(text: Text, kind?: Toast['kind']): void;

  undo(): void;
  redo(): void;
  /** Jump to the state after `applied` steps of the history (0 = the oldest kept state). */
  jumpTo(applied: number): void;
}

const createEditorStore = () =>
  create<EditorState>()((set, get) => {
    const core: Core = { set, get, anchor: null, partAnchor: null, renameSettled: false, namePending: new Set(), gestureBase: null };
    return {
      project: createProject(),
      selectedLayerId: null,
      selectedLayerIds: [],
      selectedNode: null,
      selectedChars: [],
      textEditLayerId: null,
      previewOverride: null,
      view: DEFAULT_VIEW,
      fitScale: 1,
      toast: null,
      past: [],
      future: [],
      lastCoalesce: null,
      styleClip: null,
      confirmation: null,
      renameOffer: null,

      ...historySlice(core),
      ...notifySlice(core),
      ...textSlice(core),
      ...layerSlice(core),
      ...transformSlice(core),
      ...imageSlice(core),
      ...selectionSlice(core),
      ...effectsSlice(core),
      ...masksSlice(core),
      ...viewSlice(core),
    };
  });

// Dev HMR re-executes this module when any dependency (e.g. an effect file) changes; keep one
// store instance so already-mounted subscribers and new imports agree.
const hotData = import.meta.hot?.data as { useEditor?: UseBoundStore<StoreApi<EditorState>> } | undefined;
export const useEditor = hotData?.useEditor ?? createEditorStore();
if (hotData) hotData.useEditor = useEditor;

/** Currently selected layer (or undefined). */
export const selectedLayer = (s: { project: Project; selectedLayerId: string | null }) =>
  s.project.layers.find((l) => l.id === s.selectedLayerId);
