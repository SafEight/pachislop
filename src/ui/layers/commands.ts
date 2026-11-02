import { createElement } from 'react';
import type { GeneratorCategory } from '../../engine/contracts';
import { listGenerators } from '../../generators/registry';
import { ADJUSTMENT_NAMES, createBackgroundLayer } from '../../model/defaults';
import { isTitleLayer, type TitleLayer } from '../../model/parts';
import type { AdjustmentType, EffectInstance, Layer, LayerMask, PartKey, ShapeKind, Title3DLayer } from '../../model/types';
import { errorMsg, formatMsg, type Translate } from '../../store/msg';
import { effectOwnerLabel, maskLabel, partLabel } from '../../store/labels';
import { effectsOf } from '../../store/effects';
import { selectedLayer, useEditor, type AddMaskOpts, type EffectOwner } from '../../store/store';
import { nodeParts } from '../../store/selection';
import { childrenOf } from '../../store/tree';
import { flipTargets } from '../../store/transformOps';
import { GeneratorIcon } from '../generatorIcons';
import { deleteGlint, setGlintEnabled } from '../glint';
import { addFileLayer, addGroupLayer, addShapeLayer, addTextLayer, openSplitImage, replaceWithSvgFile } from '../layerActions';
import type { MenuAnchor } from '../properties/AddEffectMenu';
import { oneShot, SHAPES } from '../util';
import type { CtxEntry, CtxItem } from './LayerContextMenu';
import { bakeMask } from './maskBake';
import { partEnabled, partHasEye } from './parts';

// Commands of the Layers panel: the row context menus, the bottom toolbar's menus and buttons.
// Layer commands act on the whole selection when the row is part of it (as the old ⋯ menu did).

/** What the commands need from the panel. */
export interface PanelUi {
  /** Start inline renaming of a layer row. */
  rename: (layerId: string) => void;
  /** Open the searchable Add Effect menu for `owner` (or several parts of one layer) at `anchor`. */
  addEffect: (owner: EffectOwner | readonly EffectOwner[], anchor: MenuAnchor) => void;
}

const fail = (e: unknown) => useEditor.getState().notify(errorMsg(e), 'error');

/** The selection when `id` is in it, else just `id`. */
export function targetsOf(id: string): string[] {
  const { selectedLayerIds } = useEditor.getState();
  return selectedLayerIds.includes(id) ? selectedLayerIds : [id];
}

/** Set one boolean flag on every listed layer as one undo step. */
function setFlag(ids: readonly string[], flag: 'visible' | 'locked' | 'guide' | 'solo', value: boolean) {
  const st = useEditor.getState();
  const c = oneShot(`lp-${flag}`);
  for (const id of ids) st.setAt({ layerId: id, path: [flag] }, value, c);
}

/** True when the layer has a layer below it in its parent to clip onto (or is clipped already). */
export function canClip(layers: readonly Layer[], l: Layer): boolean {
  return l.clip || childrenOf(layers, l.parentId ?? null)[0]?.id !== l.id;
}

/**
 * New-adjustment-layer menu: Effects only (an After Effects adjustment layer carrying just
 * effects) first, then Photoshop's order (Layer › New Adjustment Layer; Channel Mixer, Color
 * Lookup and Selective Color are not supported). Labels are English i18n keys: the caller
 * translates them with `t`. The Add effect menu lists the same adjustments (bar Effects only).
 */
export const ADJUSTMENT_MENU: { type: AdjustmentType; label: string }[] = (
  ['effectsOnly', 'brightnessContrast', 'levels', 'curves', 'exposure', 'vibrance', 'hueSaturation', 'colorBalance', 'blackWhite', 'photoFilter', 'invert', 'posterize', 'threshold', 'gradientMap'] as const
).map((type) => ({ type, label: ADJUSTMENT_NAMES[type] }));

/** New adjustment ▸ items: Effects only, a separator, then the adjustments (PS order); ⌥ creates it clipped to the layer below. */
export const adjustmentItems = (t: Translate): CtxEntry[] =>
  ADJUSTMENT_MENU.flatMap(({ type, label }): CtxEntry[] => {
    const item: CtxItem = {
      label: t(label, undefined, { ctx: 'adjustment' }),
      hint:
        type === 'effectsOnly'
          ? t('Adds a layer whose effects apply to everything below it, just above the selected layer. ⌥-click: clip it to the layer below')
          : t('Adds the adjustment just above the selected layer. ⌥-click: clip it to the layer below'),
      onSelect: ({ altKey }) => useEditor.getState().addAdjustment(type, { clip: altKey }),
    };
    return type === 'effectsOnly' ? [item, 'sep'] : [item];
  });

/** Menu order of the generator categories (GeneratorCategory). */
const CATEGORY_ORDER: Record<GeneratorCategory, number> = { Particles: 0, Lines: 1, Rings: 2, Light: 3, Energy: 4, Pattern: 5 };

/**
 * ⊕ ▸ Generator ▸ items: the generators under their category headings, each ▸ its presets (the
 * first = the plain add). With a layer selected, a follow generator's presets come first as
 * "on <layer>" (following it, grouped with it), then the free ones (a follow-required one has none).
 */
export const generatorItems = (t: Translate): CtxItem[] => {
  const sel = selectedLayer(useEditor.getState());
  const target = sel && sel.kind !== 'adjustment' ? sel : null;
  return listGenerators()
    .toSorted((a, b) => CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category])
    .map((def) => {
      const free: CtxEntry[] = def.follow === 'required' && target ? [] : def.presets.map((p) => ({
        label: t(p.label),
        hint: t('Adds a {generator} layer just above the selected layer', { generator: t(def.label) }),
        onSelect: () => useEditor.getState().addGenerator(def.type, p.id),
      }));
      const on: CtxEntry[] = def.follow && target
        ? def.presets.map((p) => ({
            label: t('{preset} on “{layer}”', { preset: t(p.label), layer: target.name }),
            hint: t('Adds a {generator} layer following “{layer}”, in a group with it', { generator: t(def.label), layer: target.name }),
            onSelect: () => useEditor.getState().addGenerator(def.type, p.id, target.id),
          }))
        : [];
      return {
        label: t(def.label),
        hint: t(def.description),
        icon: createElement(GeneratorIcon, { type: def.type }),
        group: t(def.category, undefined, { ctx: 'generator' }),
        items: on.length && free.length ? [...on, 'sep', ...free] : [...on, ...free],
      };
    });
};

/** ⊕ New layer ▾ items (also the row context menu's New layer ▸). */
export function newLayerItems(t: Translate): CtxEntry[] {
  const shapes = (dim: '2d' | '3d'): CtxItem[] => SHAPES.map((sh) => ({ label: t(sh.label), hint: t(sh.hint), onSelect: () => addShapeLayer(sh.kind, dim) }));
  return [
    { label: t('2D text'), shortcut: 'T', hint: t('Bevel + rim stack (Eye Candy / layer styles)'), onSelect: () => addTextLayer('2d') },
    { label: t('3D text'), shortcut: '⇧T', hint: t('Extruded metal letters with bands stacked behind (Element 3D)'), onSelect: () => addTextLayer('3d') },
    {
      label: t('Shape', undefined, { ctx: 'layers' }),
      hint: t('Add shape: plates, bands, bursts, bubbles, orbs (2D or 3D). With a text layer selected, the shape goes just below it, fitted around it.'),
      items: [
        { label: t('2D · layer style'), items: shapes('2d') },
        { label: t('3D · extruded'), items: shapes('3d') },
      ],
    },
    {
      label: t('Generator'),
      hint: t('Procedural layer: particles, glints, fire, smoke, corona, lightning, speed lines, sunbursts, light streaks, lens flares, shockwaves, magic circles, brush swirls, full-frame patterns. With a layer selected, “on <layer>” makes it follow that layer'),
      items: generatorItems(t),
    },
    'sep',
    { label: t('SVG logo 2D…'), hint: t('Style the logo shape with face + rims'), onSelect: () => addFileLayer('svg2d').catch(fail) },
    { label: t('SVG logo 3D…'), hint: t('Extrude the logo'), onSelect: () => addFileLayer('svg3d').catch(fail) },
    { label: t('Image…'), hint: t('PNG/JPEG/WebP; alpha shape takes the 2D style'), onSelect: () => addFileLayer('image').catch(fail) },
    { label: t('3D model (.glb)…'), onSelect: () => addFileLayer('model').catch(fail) },
    'sep',
    { label: t('Group'), hint: t('An empty group above the selected layer'), onSelect: addGroupLayer },
    {
      label: t('Background'),
      hint: t('Full-comp fill at the bottom; a guide (not exported) by default'),
      onSelect: () => {
        const bg = createBackgroundLayer();
        const st = useEditor.getState();
        st.edit((p) => ({ ...p, layers: [bg, ...p.layers] }));
        st.selectNode({ kind: 'layer', layerId: bg.id });
      },
    },
  ];
}

/** Context menu of a layer row (also the Layer ▸ submenu of part / effect rows). */
export function layerMenu(t: Translate, layer: Layer, ui: PanelUi, anchor: MenuAnchor): CtxEntry[] {
  const st = useEditor.getState();
  const ids = targetsOf(layer.id);
  const title = isTitleLayer(layer) ? layer : null;
  const group = layer.kind === 'group';
  const noFlip = flipTargets(st.project.layers, ids).length === 0;
  const style: CtxEntry[] = title
    ? [
        'sep',
        { label: t('Copy style', undefined, { ctx: 'layers' }), shortcut: '⌘⌥C', hint: t('Face, rims / 3D materials and effects'), onSelect: () => st.copyStyle(layer.id) },
        { label: t('Paste style', undefined, { ctx: 'layers' }), shortcut: '⌘⌥V', hint: t('Onto every selected layer; px effects scale with the size ratio'), disabled: !st.styleClip, onSelect: () => st.pasteStyle(ids) },
        { label: t('Duplicate as ghost guide'), hint: t('Locked 30% guide copy for matching 図柄 sizes (not exported)'), onSelect: () => st.duplicateAsGhost(layer.id) },
        {
          label: t('Replace with SVG…'),
          hint: t('Swap the text / shape / art for an SVG logo, keeping position, style and effects; sized to the old box'),
          onSelect: () => replaceWithSvgFile(layer.id).catch(fail),
        },
        ...(title.source.kind === 'model'
          ? []
          : [
              title.kind === 'title2d'
                ? {
                    label: t('Convert to 3D layer'),
                    hint: t('Extrude the same text / shape / art with the default 3D look (an image keeps its picture on the face); position and effects stay'),
                    onSelect: () => st.convertLayerKind(layer.id, '3d'),
                  }
                : {
                    label: t('Convert to 2D layer'),
                    hint: t('The same text / shape / art with the default 2D layer style; position and effects stay'),
                    onSelect: () => st.convertLayerKind(layer.id, '2d'),
                  },
            ]),
        ...(title.source.kind === 'image'
          ? [
              {
                label: t('Split image…'),
                hint: t('Cut the picture into its parts (a logo and its word…): one layer each, in a group, each taking its own extrude and style'),
                onSelect: () => openSplitImage(layer.id),
              },
            ]
          : []),
        ...(title.source.kind === 'shape'
          ? [
              { label: t('Fit to layer above'), hint: t('Centre and size this shape around the nearest text / shape above it, plus padding (keeps its rotation)'), onSelect: () => st.fitShapeLayer(layer.id, 'above') },
              { label: t('Fit to layer below'), hint: t('Same, around the nearest text / shape below it'), onSelect: () => st.fitShapeLayer(layer.id, 'below') },
            ]
          : []),
      ]
    : [];
  return [
    { label: t('Duplicate'), shortcut: '⌘J', onSelect: () => st.duplicateLayers(ids) },
    { label: t('Delete'), shortcut: 'Del', hint: group ? t('Deletes the group and its layers') : undefined, onSelect: () => st.removeLayers(ids) },
    { label: t('Rename'), shortcut: 'F2', onSelect: () => ui.rename(layer.id) },
    'sep',
    { label: t('Group', undefined, { ctx: 'layers' }), shortcut: '⌘G', hint: t('One group: its effects run on the members’ composite (a glow around burst + text)'), onSelect: () => st.groupLayers(ids) },
    { label: t('Ungroup'), shortcut: '⇧⌘G', hint: t('Dissolve the group; its layers stay in place'), disabled: !group && !layer.parentId, onSelect: () => st.ungroupLayers(ids) },
    {
      label: layer.clip ? t('Release clipping mask') : t('Create clipping mask'),
      shortcut: '⌥⌘G',
      hint: t('Show the layer only inside the layer below it (⌥-click the line between two rows)'),
      disabled: !canClip(st.project.layers, layer),
      onSelect: () => st.toggleClip(ids),
    },
    { label: t('Add mask'), hint: t('Vector, gradient or layer mask: shows the layer only where the mask is white'), items: addMaskItems(t, layer.id) },
    ...layerMaskEntries(t, layer),
    'sep',
    { label: t('New layer', undefined, { ctx: 'layers' }), hint: t('Same as ⊕ New layer: text, shape, generator, file, group, background'), items: newLayerItems(t) },
    { label: t('New adjustment layer', undefined, { ctx: 'layers' }), items: adjustmentItems(t) },
    { label: t('Add effect to {part}…', { part: layer.name }), onSelect: () => ui.addEffect({ layerId: layer.id, part: null }, anchor) },
    {
      label: t('Arrange'),
      items: [
        { label: t('Bring to front'), shortcut: '⇧⌘]', onSelect: () => st.arrangeLayers(ids, 'front') },
        { label: t('Bring forward'), shortcut: '⌘]', onSelect: () => st.arrangeLayers(ids, 'forward') },
        { label: t('Send backward'), shortcut: '⌘[', onSelect: () => st.arrangeLayers(ids, 'backward') },
        { label: t('Send to back'), shortcut: '⇧⌘[', onSelect: () => st.arrangeLayers(ids, 'back') },
      ],
    },
    {
      label: t('Transform'),
      items: [
        { label: t('Flip Horizontal'), hint: t('Mirror the selected layers left ↔ right in place'), disabled: noFlip, onSelect: () => st.flipLayers(ids, 'x') },
        { label: t('Flip Vertical'), hint: t('Mirror the selected layers top ↔ bottom in place'), disabled: noFlip, onSelect: () => st.flipLayers(ids, 'y') },
      ],
    },
    'sep',
    { label: t('Visible'), checked: layer.visible, onSelect: () => setFlag(ids, 'visible', !layer.visible) },
    { label: t('Lock'), checked: layer.locked, hint: t('Lock (no canvas selection / dragging)'), onSelect: () => setFlag(ids, 'locked', !layer.locked) },
    { label: t('Solo'), checked: layer.solo, hint: t('Solo (show only soloed layers)'), onSelect: () => setFlag(ids, 'solo', !layer.solo) },
    { label: t('Guide layer', undefined, { ctx: 'layers' }), checked: layer.guide, hint: t('Guide layer: visible in the editor, excluded from exports'), onSelect: () => setFlag(ids, 'guide', !layer.guide) },
    ...style,
  ];
}

const layerSubmenu = (t: Translate, layer: Layer, ui: PanelUi, anchor: MenuAnchor): CtxItem => ({
  label: t('Layer “{name}”', { name: layer.name }),
  items: layerMenu(t, layer, ui, anchor),
});

/** Add mask ▾ items for layer `layerId` (the toolbar's mask button and the context menus' Add mask ▸); the new mask is selected. */
export function addMaskItems(t: Translate, layerId: string): CtxEntry[] {
  const add = (kind: LayerMask['kind'], opts?: AddMaskOpts) => () => void useEditor.getState().addMask(layerId, kind, opts);
  const shape = (kind: ShapeKind, label: string): CtxItem => ({ label: t(label), onSelect: add('shape', { shape: kind }) });
  return [
    shape('rect', 'Rectangle'),
    shape('ellipse', 'Ellipse'),
    shape('polygon', 'Polygon'),
    shape('star', 'Star'),
    { label: t('Shape', undefined, { ctx: 'layers' }), items: SHAPES.map((sh) => ({ label: t(sh.label), hint: t(sh.hint), onSelect: add('shape', { shape: sh.kind }) })) },
    'sep',
    { label: t('Linear gradient'), hint: t('Fades the layer out toward its bottom; lay the line with the Gradient tool (G)'), onSelect: add('gradient', { gradient: 'linear' }) },
    { label: t('Radial gradient'), hint: t('Fades the layer out from its middle toward its corners'), onSelect: add('gradient', { gradient: 'radial' }) },
    'sep',
    { label: t('From layer…'), hint: t('Shows the layer where another layer has pixels (by alpha or luminance); pick that layer in Properties'), onSelect: add('layer') },
  ];
}

/** Commands on one mask: show / hide, invert, link, delete, apply (image layers only). */
function maskCommands(t: Translate, layer: Layer, mask: LayerMask): CtxEntry[] {
  const st = useEditor.getState();
  const image = isTitleLayer(layer) && layer.source.kind === 'image';
  return [
    { label: mask.enabled ? t('Disable mask') : t('Enable mask'), shortcut: t('⇧-click'), onSelect: () => st.setMaskEnabled(layer.id, mask.id, !mask.enabled) },
    { label: t('Invert mask'), checked: mask.invert, onSelect: () => st.updateMask(layer.id, mask.id, { invert: !mask.invert }) },
    ...(mask.kind === 'layer'
      ? []
      : [{ label: t('Link mask'), checked: mask.linked, hint: t('Linked: the mask moves, turns and scales with the layer. Unlinked: it stays put on the canvas'), onSelect: () => st.updateMask(layer.id, mask.id, { linked: !mask.linked }) }]),
    { label: t('Delete mask'), shortcut: 'Del', onSelect: () => st.removeMask(layer.id, mask.id) },
    ...(image ? [{ label: t('Apply mask'), hint: t('Bake the mask into the picture’s transparency and remove it'), onSelect: () => bakeMask(layer.id, mask.id).catch(fail) }] : []),
  ];
}

/**
 * A layer row's mask commands: those of its focused mask or its only mask inline, else one
 * submenu per mask (Mask 1 ▸, Mask 2 ▸…).
 */
function layerMaskEntries(t: Translate, layer: Layer): CtxEntry[] {
  const node = useEditor.getState().selectedNode;
  const one = layer.masks.length === 1 ? layer.masks[0] : node?.kind === 'mask' && node.layerId === layer.id ? layer.masks.find((m) => m.id === node.maskId) : undefined;
  if (one) return maskCommands(t, layer, one);
  return layer.masks.map((m) => ({ label: formatMsg(maskLabel(layer, m.id), t), items: maskCommands(t, layer, m) }));
}

/** Context menu of a mask chip. */
export function maskMenu(t: Translate, layer: Layer, mask: LayerMask, ui: PanelUi, anchor: MenuAnchor): CtxEntry[] {
  return [...maskCommands(t, layer, mask), 'sep', { label: t('Add mask'), items: addMaskItems(t, layer.id) }, 'sep', layerSubmenu(t, layer, ui, anchor)];
}

/** Context menu of a style part row; its Add effect covers every selected part when the row is one of several. */
export function partMenu(t: Translate, layer: TitleLayer, part: PartKey, ui: PanelUi, anchor: MenuAnchor): CtxEntry[] {
  const st = useEditor.getState();
  const on = partEnabled(layer, part);
  const name = formatMsg(partLabel(layer, part), t);
  const sel = nodeParts(st.selectedNode, layer.id);
  const parts = sel.length > 1 && sel.includes(part) ? sel : [part];
  return [
    parts.length > 1
      ? { label: t('Add effect to {n} parts…', { n: parts.length }), hint: t('One effect on each selected part, run on its own pixels'), onSelect: () => ui.addEffect(parts.map((p) => ({ layerId: layer.id, part: p })), anchor) }
      : { label: t('Add effect to {part}…', { part: name }), hint: t('Part effects run on this part’s own pixels'), onSelect: () => ui.addEffect({ layerId: layer.id, part }, anchor) },
    ...(partHasEye(layer, part) ? [{ label: t('Visible'), checked: on, onSelect: () => st.setPartEnabled(layer.id, part, !on) }] : []),
    'sep',
    layerSubmenu(t, layer, ui, anchor),
  ];
}

/** Context menu of an effect row. */
export function effectMenu(t: Translate, layer: Layer, owner: EffectOwner, fx: EffectInstance, ui: PanelUi, anchor: MenuAnchor): CtxEntry[] {
  const st = useEditor.getState();
  const list = effectsOf(st.project, owner);
  const at = list.findIndex((x) => x.id === fx.id);
  const layerFx: EffectOwner = { layerId: owner.layerId, part: null };
  return [
    { label: t('Enabled'), checked: fx.enabled, onSelect: () => st.setEffectEnabled(owner, fx.id, !fx.enabled) },
    { label: t('Duplicate effect'), onSelect: () => st.moveEffect(owner, fx.id, owner, at + 1, true) },
    { label: t('Delete effect'), onSelect: () => st.removeEffect(owner, fx.id) },
    ...(owner.part
      ? [{ label: t('Move to layer effects'), hint: t('Run it on the whole layer instead of this part'), onSelect: () => st.moveEffect(owner, fx.id, layerFx, effectsOf(st.project, layerFx).length, false) }]
      : []),
    { label: t('Add effect to {part}…', { part: formatMsg(effectOwnerLabel(layer, owner.part), t) }), onSelect: () => ui.addEffect(owner, anchor) },
    'sep',
    layerSubmenu(t, layer, ui, anchor),
  ];
}

/** Context menu of a 3D title's glint row: on / off and delete (no duplicate or move: there is one glint, computed inside the 3D render). */
export function glintMenu(t: Translate, layer: Title3DLayer, ui: PanelUi, anchor: MenuAnchor): CtxEntry[] {
  const on = layer.style3d.glint.enabled;
  const owner: EffectOwner = { layerId: layer.id, part: null };
  return [
    { label: t('Enabled'), checked: on, onSelect: () => setGlintEnabled([layer.id], !on) },
    { label: t('Delete effect'), onSelect: () => deleteGlint([layer.id]) },
    { label: t('Add effect to {part}…', { part: formatMsg(effectOwnerLabel(layer, null), t) }), onSelect: () => ui.addEffect(owner, anchor) },
    'sep',
    layerSubmenu(t, layer, ui, anchor),
  ];
}
