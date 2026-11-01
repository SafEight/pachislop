import { useEditor, type PreviewBg, type PreviewRes, type Tool } from '../../store/store';
import { ColorInput } from '../controls';
import { useT } from '../i18n';

// The slim bar under the canvas (Photoshop's bottom-left status): zoom, preview resolution,
// backdrop, 引き目 checks, guides, 3D orbit drag, CMYK gamut warning, comp size and a hint for
// the active tool. Everything here is view state: never exported, never undone.

const ZOOMS: { v: 'fit' | number; label: string }[] = [
  { v: 'fit', label: 'Fit' },
  { v: 0.5, label: '50%' },
  { v: 1, label: '100%' },
  { v: 2, label: '200%' },
];
const RES: { v: PreviewRes; label: string; title: string }[] = [
  { v: 1, label: 'Full', title: 'Preview at full comp resolution' },
  { v: 0.5, label: '½', title: 'Preview at half resolution (faster)' },
  { v: 0.25, label: '¼', title: 'Preview at quarter resolution (fastest)' },
];
const BGS: { v: PreviewBg; label: string }[] = [
  { v: 'checker', label: 'Checker' },
  { v: 'black', label: 'Black' },
  { v: 'white', label: 'White' },
  { v: 'custom', label: 'Colour' },
];
const DISTANCES: { v: number; label: string }[] = [
  { v: 0.5, label: '50%' },
  { v: 0.25, label: '25%' },
  { v: 0.125, label: '12.5%' },
];

/** What a press does with each tool (the status bar's hint). */
const TOOL_HINT: Record<Tool, string> = {
  move: 'Move: drag a layer (snaps; ⌘ free, ⇧ one axis / add) · ⌘-click: the other Auto-Select level · drag empty: marquee · ⌥-drag 3D: orbit',
  glyph: 'Per-letter: click a glyph of any text layer · drag it to move · ⇧-click adds · ⌥-drag 3D: depth · drag empty: marquee glyphs · Esc: back',
  text: 'Text: click the canvas to add text · click a text layer to type in it',
  shape: 'Shape: drag to draw the shape (⇧ keeps its proportions) · click adds it at the default size',
  gradient: 'Gradient: drag across the layer to lay the fill (⇧ 15°) · drag the handles to adjust · click picks a layer',
  distort: 'Distort: drag the corner / mesh handles (⇧ symmetric パース) · click picks a layer',
  light: "Light: drag the dial to aim the bevels' global light (⇧ altitude)",
  hand: 'Hand: drag to pan (or hold Space with any tool)',
  zoom: 'Zoom: click to zoom in · ⌥-click to zoom out · drag a rect to zoom to it',
};

/** `d`: CSS px per comp px of the current view; `tool`: the effective tool (Hand while Space is held). */
export function StatusBar({ d, tool }: { d: number; tool: Tool }) {
  const t = useT();
  const view = useEditor((s) => s.view);
  const comp = useEditor((s) => s.project.comp);
  const { setView } = useEditor.getState();
  return (
    <div className="status-bar">
      <span className="group">
        {ZOOMS.map((z) => (
          <button
            key={String(z.v)}
            className={view.zoom === z.v ? 'active' : ''}
            aria-pressed={view.zoom === z.v}
            onClick={() => setView({ zoom: z.v, panX: 0, panY: 0 })}
            title={z.v === 'fit' ? t('Fit comp in view') : t('Zoom {z}', { z: z.label })}
            aria-label={z.v === 'fit' ? t('Fit comp in view') : t('Zoom {z}', { z: z.label })}
          >
            {z.v === 'fit' ? t(z.label, undefined, { ctx: 'zoom' }) : z.label}
          </button>
        ))}
        <span className="muted zoom-readout">{Math.round(d * 100)}%</span>
      </span>
      <span className="group" title={t('Preview resolution (export always renders at full quality)')}>
        <span className="muted">{t('Res')}</span>
        {RES.map((r) => (
          <button key={r.v} className={view.previewRes === r.v ? 'active' : ''} aria-pressed={view.previewRes === r.v} title={t(r.title)} aria-label={t(r.title)} onClick={() => setView({ previewRes: r.v })}>
            {r.v === 1 ? t(r.label) : r.label}
          </button>
        ))}
      </span>
      <span className="group" title={t('Viewport backdrop (view only — never exported)')}>
        <span className="muted">{t('Bg')}</span>
        {BGS.map((b) => (
          <button
            key={b.v}
            className={view.previewBg === b.v ? 'active' : ''}
            aria-pressed={view.previewBg === b.v}
            title={t('Viewport backdrop (view only — never exported)')}
            aria-label={t(b.label)}
            onClick={() => setView({ previewBg: b.v })}
          >
            {t(b.label)}
          </button>
        ))}
        {view.previewBg === 'custom' && <ColorInput id="view-bg" value={view.previewBgColor} onChange={(c) => setView({ previewBgColor: c })} />}
      </span>
      <span className="group" title={t('引き目 check (view only — never exported)')}>
        <span className="muted">引き目</span>
        <button
          className={view.distance ? 'active' : ''}
          aria-pressed={view.distance}
          onClick={() => setView({ distance: !view.distance })}
          title={t('Distance: an inset of the comp at real LCD scale, to check readability from the seat')}
          aria-label={t('Distance')}
        >
          {t('Distance')}
        </button>
        {view.distance && (
          <select
            value={view.distanceScale}
            title={t('Inset scale (comp px → screen px)')}
            aria-label={t('Inset scale (comp px → screen px)')}
            onChange={(e) => setView({ distanceScale: Number(e.target.value) })}
          >
            {DISTANCES.map((o) => (
              <option key={o.v} value={o.v}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        <button
          className={view.valueCheck ? 'active' : ''}
          aria-pressed={view.valueCheck}
          onClick={() => setView({ valueCheck: !view.valueCheck })}
          title={t('Value: greyscale preview to check light/dark separation of face and rims')}
          aria-label={t('Value')}
        >
          {t('Value')}
        </button>
      </span>
      <span className="group">
        <button
          className={view.safeGuides ? 'active' : ''}
          aria-pressed={view.safeGuides}
          onClick={() => setView({ safeGuides: !view.safeGuides })}
          title={t('Title/action-safe areas and centre lines')}
          aria-label={t('Guides')}
        >
          {t('Guides')}
        </button>
        <button
          className={view.orbit ? 'active' : ''}
          aria-pressed={view.orbit}
          onClick={() => setView({ orbit: !view.orbit })}
          title={t('Orbit: dragging a 3D layer rotates it (X/Y). Alt/Option-drag orbits without this toggle.')}
          aria-label={t('Orbit')}
        >
          ⟲ {t('Orbit')}
        </button>
        <button
          className={view.gamut ? 'active' : ''}
          aria-pressed={view.gamut}
          onClick={() => setView({ gamut: !view.gamut })}
          title={t("Gamut warning (⇧⌘Y): hatch colours the active CMYK ICC profile can't print (soft proof, relative colorimetric)")}
          aria-label={t('CMYK gamut warning on / off')}
        >
          CMYK
        </button>
      </span>
      <span className="muted size-readout" title={t('Comp size (px)')}>
        {comp.width}×{comp.height} px
      </span>
      <span className="muted right hint" title={t(TOOL_HINT[tool])}>
        {t(TOOL_HINT[tool])}
      </span>
    </div>
  );
}
