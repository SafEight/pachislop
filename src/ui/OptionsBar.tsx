import type { ComponentType } from 'react';
import { noDistort } from '../model/defaults';
import { isTitleLayer, type TitleLayer } from '../model/parts';
import type { Distort, Layer, TextSource } from '../model/types';
import { maskLabel } from '../store/labels';
import { formatMsg, msg } from '../store/msg';
import { selectedLayer, useEditor, type AlignMode, type Tool } from '../store/store';
import { ColorInput, NumberField, Seg, type Option } from './controls';
import { FontBrowser } from './FontBrowser';
import { useT } from './i18n';
import { ToolIcon } from './Toolbar';
import { oneShot, SHAPES, stepZoom, TOOLS, useSpaceHand } from './util';
import { gradientTarget } from './viewport/gradientTarget';
import { selectedMask } from './viewport/mask';

// The options bar under the top bar (Photoshop's): the active tool's settings, one row.

const DIMS: readonly Option<'2d' | '3d'>[] = [
  { value: '2d', label: '2D', title: '2D: layer style (bevel, rims, Eye Candy effects)' },
  { value: '3d', label: '3D', title: '3D: extruded (Element 3D style)' },
];

/** 2D / 3D for the next text or shape the tool creates (view.textKind). */
function DimSeg() {
  const kind = useEditor((s) => s.view.textKind);
  const setView = useEditor((s) => s.setView);
  const t = useT();
  return (
    <span className="ob-group" role="group" aria-label={t('New layers are 2D or 3D')}>
      <Seg value={kind} options={DIMS.map((o) => ({ ...o, title: t(o.title!) }))} onChange={(v) => setView({ textKind: v })} />
    </span>
  );
}

const ALIGNS: { a: AlignMode; icon: string; label: string }[] = [
  { a: 'left', icon: '⇤', label: 'left edges' },
  { a: 'hcenter', icon: '↔', label: 'horizontal centres' },
  { a: 'right', icon: '⇥', label: 'right edges' },
  { a: 'top', icon: '⤒', label: 'top edges' },
  { a: 'vmiddle', icon: '↕', label: 'vertical centres' },
  { a: 'bottom', icon: '⤓', label: 'bottom edges' },
];

function MoveOptions() {
  const autoSelect = useEditor((s) => s.view.autoSelect);
  const showHandles = useEditor((s) => s.view.showHandles);
  const ids = useEditor((s) => s.selectedLayerIds);
  const { setView, alignLayers, distributeLayers } = useEditor.getState();
  const t = useT();
  const to = ids.length >= 2 ? t("the {n} selected layers' common box", { n: ids.length }) : t('the comp');
  return (
    <>
      <span className="ob-group" role="group" aria-label={t('Auto-Select')}>
        <span className="ob-label">{t('Auto-Select:')}</span>
        <Seg
          value={autoSelect}
          options={[
            { value: 'layer', label: t('Layer'), title: t('A canvas click selects the layer under the cursor (inside groups too)') },
            { value: 'group', label: t('Group'), title: t('A canvas click selects the top-level group of the layer under the cursor') },
          ]}
          onChange={(v) => setView({ autoSelect: v })}
        />
      </span>
      <label className="ob-check" title={t('Bounding box with scale and rotate handles around the selection')}>
        <input type="checkbox" checked={showHandles} aria-label={t('Show transform controls')} onChange={(e) => setView({ showHandles: e.target.checked })} />
        {t('Show transform controls')}
      </label>
      <span className="ob-sep" />
      <span className="ob-group align-btns" role="group" aria-label={t('Align')} title={t("Line the layers' boxes up with {to} (rims included, effects not)", { to })}>
        {ALIGNS.map((al) => (
          <button
            key={al.a}
            className="small"
            disabled={!ids.length}
            title={t('Align {what} to {to}', { what: t(al.label), to })}
            aria-label={t('Align {what}', { what: t(al.label) })}
            onClick={() => alignLayers(ids, al.a)}
          >
            {al.icon}
          </button>
        ))}
      </span>
      <span className="ob-group align-btns" role="group" aria-label={t('Distribute')}>
        <button
          className="small"
          disabled={ids.length < 3}
          title={t('Distribute horizontally: equal gaps between the selected layers (3+)')}
          aria-label={t('Distribute horizontally: equal gaps between the selected layers (3+)')}
          onClick={() => distributeLayers(ids, 'x')}
        >
          ⇹
        </button>
        <button
          className="small"
          disabled={ids.length < 3}
          title={t('Distribute vertically: equal gaps between the selected layers (3+)')}
          aria-label={t('Distribute vertically: equal gaps between the selected layers (3+)')}
          onClick={() => distributeLayers(ids, 'y')}
        >
          ⇳
        </button>
      </span>
    </>
  );
}

/** The selected text layer (primary selection), if it is one. */
function selectedText(s: Parameters<typeof selectedLayer>[0]): (TitleLayer & { source: TextSource }) | null {
  const l = selectedLayer(s);
  return isTitleLayer(l) && l.source.kind === 'text' ? (l as TitleLayer & { source: TextSource }) : null;
}

/** Face colour of a title layer when it is one flat colour, else null (gradient / image face). */
function solidFace(l: TitleLayer): string | null {
  if (l.kind === 'title2d') return l.style.face.fill.kind === 'solid' ? l.style.face.fill.color : null;
  return l.style3d.face.gradient ? null : l.style3d.face.color;
}

/** Make the face of `l` the flat colour `c` (a gradient face becomes solid). */
function setFaceColor(l: TitleLayer, c: string, coalesce: string) {
  const { setAt } = useEditor.getState();
  if (l.kind === 'title2d') {
    const fill = l.style.face.fill;
    if (fill.kind === 'solid') setAt({ layerId: l.id, path: ['style', 'face', 'fill', 'color'] }, c, coalesce);
    else setAt({ layerId: l.id, path: ['style', 'face', 'fill'] }, { ...fill, kind: 'solid', color: c }, coalesce);
  } else {
    const face = l.style3d.face;
    if (!face.gradient) setAt({ layerId: l.id, path: ['style3d', 'face', 'color'] }, c, coalesce);
    else setAt({ layerId: l.id, path: ['style3d', 'face'] }, { ...face, color: c, gradient: undefined }, coalesce);
  }
}

/**
 * Text tool: 2D / 3D for new text, then font, size, tracking and face colour. With a text layer
 * selected they edit it; otherwise they set the defaults of the next new text (view.textDefaults).
 */
function TextOptions() {
  const layer = useEditor(selectedText);
  const defaults = useEditor((s) => s.view.textDefaults);
  const { setAt, setView, setPreviewOverride } = useEditor.getState();
  const t = useT();
  const src = layer?.source;
  const setDefaults = (patch: Partial<typeof defaults>) => setView({ textDefaults: { ...useEditor.getState().view.textDefaults, ...patch } });
  const ref = (k: keyof TextSource) => ({ layerId: layer!.id, path: ['source', k] });
  const face = layer ? solidFace(layer) : defaults.fill;
  const target = layer ? t('Editing “{name}”', { name: layer.name }) : t('Defaults for the next new text');
  return (
    <>
      <DimSeg />
      <span className="ob-sep" />
      <span className="ob-field" title={t('Font')}>
        <FontBrowser
          value={src?.fontId ?? defaults.fontId}
          onChange={(id) => (layer ? setAt(ref('fontId'), id) : setDefaults({ fontId: id }))}
          onHover={(id) => layer && setPreviewOverride(id ? ({ ...layer, source: { ...layer.source, fontId: id } } as Layer) : null)}
        />
      </span>
      <span className="ob-field" title={t('Em size in comp px — the whole style scales with it')}>
        <span className="ob-label">{t('Size')}</span>
        <NumberField
          id={`ob-text-size:${layer?.id ?? 'default'}`}
          label={t('Size')}
          value={src?.size ?? defaults.size}
          min={8}
          max={800}
          step={1}
          unit="px"
          slider={false}
          onChange={(v, c) => (layer ? setAt(ref('size'), v, c) : setDefaults({ size: v }))}
        />
      </span>
      <span className="ob-field" title={t('Thousandths of an em between characters')}>
        <span className="ob-label">{t('Tracking')}</span>
        <NumberField
          id={`ob-text-tracking:${layer?.id ?? 'default'}`}
          label={t('Tracking')}
          value={src?.tracking ?? defaults.tracking}
          min={-300}
          max={1000}
          step={1}
          unit="‰"
          slider={false}
          onChange={(v, c) => (layer ? setAt(ref('tracking'), v, c) : setDefaults({ tracking: v }))}
        />
      </span>
      <span className="ob-field" title={t('Face colour: a gradient face becomes this flat colour')}>
        <span className="ob-label">{t('Colour')}</span>
        <ColorInput
          id={`ob-text-fill:${layer?.id ?? 'default'}`}
          label={t('Face colour')}
          value={face ?? '#ffffff'}
          onChange={(c, k) => (layer ? setFaceColor(layer, c, k) : setDefaults({ fill: c }))}
        />
        {face === null && <span className="muted">{layer ? t('Gradient') : t('Preset look')}</span>}
        {!layer && defaults.fill !== null && (
          <button className="small" title={t('New text keeps the preset look (gold face)')} aria-label={t('Back to the preset look')} onClick={() => setDefaults({ fill: null })}>
            ✕
          </button>
        )}
      </span>
      <span className="muted ob-note ellipsis">{target}</span>
    </>
  );
}

/** Shape tool: 2D / 3D and the shape the next drag draws (view.shapeKind). */
function ShapeOptions() {
  const shapeKind = useEditor((s) => s.view.shapeKind);
  const setView = useEditor((s) => s.setView);
  const t = useT();
  return (
    <>
      <DimSeg />
      <span className="ob-sep" />
      <span className="ob-group ob-chips" role="group" aria-label={t('Shape')}>
        {SHAPES.map((sh) => (
          <button
            key={sh.kind}
            className={`small ${shapeKind === sh.kind ? 'active' : ''}`}
            aria-pressed={shapeKind === sh.kind}
            aria-label={t(sh.label)}
            title={t(sh.hint)}
            onClick={() => setView({ shapeKind: sh.kind })}
          >
            {t(sh.label)}
          </button>
        ))}
      </span>
    </>
  );
}

/** Gradient tool: which fill (or gradient mask) a drag lays its gradient into, picked by the selected node. */
function GradientOptions() {
  const project = useEditor((s) => s.project);
  const node = useEditor((s) => s.selectedNode);
  const t = useT();
  const sm = selectedMask(project, node);
  if (sm)
    return sm.mask.kind === 'gradient' ? (
      <>
        <span className="ob-label">{t('Target:')}</span>
        <span className="ob-target ellipsis">
          {sm.layer.name} › {formatMsg(maskLabel(sm.layer, sm.mask.id), t)}
        </span>
        <span className="muted ob-note">{t('Drag on the canvas to lay the mask’s gradient: opaque at the press, transparent where you let go (Shift: 15°)')}</span>
      </>
    ) : (
      <span className="muted ob-note">{t('Only gradient masks take the Gradient tool: select a gradient mask, or a layer for its fill')}</span>
    );
  const target = gradientTarget(project, node);
  if (!target) return <span className="muted ob-note">{t('Select a title layer, one of its parts or an effect: the drag sets that fill’s gradient')}</span>;
  return (
    <>
      <span className="ob-label">{t('Target:')}</span>
      <span className="ob-target ellipsis" title={t('The fill the drag sets: the selected part’s, else the face’s')}>
        {target.layer.name} › {formatMsg(target.label, t)}
      </span>
      {!target.grad && <span className="muted ob-note">{t('Not a gradient')}</span>}
    </>
  );
}

const DISTORT_MODES: readonly Option<Distort['mode']>[] = [
  { value: 'none', label: 'None', title: 'No free distort' },
  { value: 'corners', label: 'Corners', title: 'Perspective / distort: drag the 4 frame corners on the canvas (⇧: symmetric パース)' },
  { value: 'mesh', label: 'Mesh', title: 'Mesh warp: a 4×4 Bézier lattice on the canvas (bulges, swells, flag curls)' },
];

/** Distort tool: the selected text / shape layer's free-distort mode, and Reset. */
function DistortOptions() {
  const layer = useEditor((s) => {
    const l = selectedLayer(s);
    return isTitleLayer(l) && (l.source.kind === 'text' || l.source.kind === 'shape') ? l : null;
  });
  const setAt = useEditor((s) => s.setAt);
  const t = useT();
  if (!layer) return <span className="muted ob-note">{t('Select a text or shape layer to distort it')}</span>;
  const d = layer.distort;
  const moved = d.corners.some((c) => c.x !== 0 || c.y !== 0) || d.mesh.some((c) => c.x !== 0 || c.y !== 0);
  return (
    <>
      <span className="ob-group" role="group" aria-label={t('Mode')}>
        <span className="ob-label">{t('Mode')}</span>
        <Seg
          value={d.mode}
          options={DISTORT_MODES.map((o) => ({ ...o, label: t(o.label), title: t(o.title!) }))}
          onChange={(mode) =>
            setAt({ layerId: layer.id, path: ['distort', 'mode'] }, mode, undefined, msg('Distort {mode}', { mode: { en: DISTORT_MODES.find((o) => o.value === mode)?.label ?? mode, lower: true } }))
          }
        />
      </span>
      <button
        className="small"
        disabled={!moved && d.mode === 'none'}
        title={t('Remove the distort (corners and mesh back at rest, mode None)')}
        aria-label={t('Reset distort')}
        onClick={() => setAt({ layerId: layer.id, path: ['distort'] }, noDistort(), oneShot(`${layer.id}:distort`), 'Reset distort')}
      >
        {t('Reset')}
      </button>
    </>
  );
}

/** Light tool: the comp's Global Light, which bevels, shadows and satin with "Use Global Light" follow. */
function LightOptions() {
  const gl = useEditor((s) => s.project.comp.globalLight);
  const setAt = useEditor((s) => s.setAt);
  const t = useT();
  return (
    <>
      <span className="ob-field" title={t('Global light angle (Photoshop: counter-clockwise from 3 o’clock; 120° = upper left)')}>
        <span className="ob-label">{t('Angle')}</span>
        <NumberField
          id="ob-global-angle"
          label={t('Angle')}
          value={gl.angle}
          min={0}
          max={360}
          step={1}
          unit="°"
          slider={false}
          onChange={(v, c) => setAt({ layerId: null, path: ['comp', 'globalLight', 'angle'] }, v, c)}
        />
      </span>
      <span className="ob-field" title={t('Global light altitude: 0° grazing, 90° straight on')}>
        <span className="ob-label">{t('Altitude')}</span>
        <NumberField
          id="ob-global-altitude"
          label={t('Altitude')}
          value={gl.altitude}
          min={0}
          max={90}
          step={1}
          unit="°"
          clamp
          slider={false}
          onChange={(v, c) => setAt({ layerId: null, path: ['comp', 'globalLight', 'altitude'] }, v, c)}
        />
      </span>
      <span className="muted ob-note">{t('Shared by every bevel, shadow and satin set to Use Global Light')}</span>
    </>
  );
}

const ZOOMS: { v: 'fit' | number; label: string }[] = [
  { v: 'fit', label: 'Fit' },
  { v: 0.5, label: '50%' },
  { v: 1, label: '100%' },
  { v: 2, label: '200%' },
];

/** Hand / Zoom tools: zoom presets and steps. */
function ZoomOptions() {
  const zoom = useEditor((s) => s.view.zoom);
  const fitScale = useEditor((s) => s.fitScale);
  const setView = useEditor((s) => s.setView);
  const t = useT();
  return (
    <>
      <span className="ob-group" role="group" aria-label={t('Zoom')}>
        <button className="small" title={t('Zoom out (⌘-)')} aria-label={t('Zoom out')} onClick={() => stepZoom(-1)}>
          −
        </button>
        <span className="ob-readout">{Math.round((zoom === 'fit' ? fitScale : zoom) * 100)}%</span>
        <button className="small" title={t('Zoom in (⌘=)')} aria-label={t('Zoom in')} onClick={() => stepZoom(1)}>
          +
        </button>
      </span>
      <span className="ob-group" role="group" aria-label={t('Zoom presets')}>
        {ZOOMS.map((z) => {
          const label = z.v === 'fit' ? t(z.label, undefined, { ctx: 'zoom' }) : z.label;
          return (
            <button
              key={String(z.v)}
              className={`small ${zoom === z.v ? 'active' : ''}`}
              aria-pressed={zoom === z.v}
              aria-label={label}
              title={z.v === 'fit' ? t('Fit comp in view') + ' (⌘0)' : z.v === 1 ? t('Zoom {z}', { z: z.label }) + ' (⌘1)' : t('Zoom {z}', { z: z.label })}
              onClick={() => setView({ zoom: z.v, panX: 0, panY: 0 })}
            >
              {label}
            </button>
          );
        })}
      </span>
    </>
  );
}

/** Per-letter tool: no settings, so the bar says how it works. */
function GlyphOptions() {
  const t = useT();
  return <span className="muted ob-note">{t('Click a glyph of any text layer to select it and move, scale, rotate or tilt it on its own')}</span>;
}

const OPTIONS: Record<Tool, ComponentType> = {
  move: MoveOptions,
  glyph: GlyphOptions,
  text: TextOptions,
  shape: ShapeOptions,
  gradient: GradientOptions,
  distort: DistortOptions,
  light: LightOptions,
  hand: ZoomOptions,
  zoom: ZoomOptions,
};

/** The options bar: the active tool's name and its options (Space held = the Hand tool's). */
export function OptionsBar() {
  const tool = useEditor((s) => s.view.tool);
  const active = useSpaceHand() ? 'hand' : tool;
  const t = useT();
  const info = TOOLS.find((x) => x.tool === active)!;
  const Options = OPTIONS[active];
  return (
    <div className="optionsbar" role="region" aria-label={t('Options bar')}>
      <span className="ob-tool" title={t(info.hint)}>
        <ToolIcon tool={active} />
        {t(info.label)}
      </span>
      <span className="ob-sep" />
      <Options />
    </div>
  );
}
