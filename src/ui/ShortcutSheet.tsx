import { useEffect } from 'react';
import { useT } from './i18n';

/** Every keyboard / mouse shortcut, grouped as in the cheat sheet. ⌘ = Ctrl on Windows / Linux. */
const SHORTCUTS: { group: string; items: [keys: string, what: string][] }[] = [
  {
    group: 'File & history',
    items: [
      ['⌘Z', 'Undo'],
      ['⇧⌘Z  /  ⌘Y', 'Redo'],
      ['⌘S', 'Save project (.pslot.json)'],
      ['⌘O', 'Open project'],
      ['⌘E', 'Export…'],
    ],
  },
  {
    group: 'Tools',
    items: [
      ['V', 'Move tool'],
      ['A', 'Per-letter tool'],
      ['T  /  ⇧T', 'Type tool + a new 2D / 3D text layer, ready to type'],
      ['U', 'Shape tool'],
      ['G', 'Gradient tool'],
      ['D', 'Distort tool'],
      ['L', 'Light tool (Global Light dial)'],
      ['H', 'Hand tool'],
      ['Z', 'Zoom tool'],
      ['Hold Space', 'Hand tool while held'],
    ],
  },
  {
    group: 'Layers',
    items: [
      ['Click', 'Select a layer (panel or canvas)'],
      ['⇧-click', 'Layers panel: select the range from the current layer'],
      ['⌘-click', 'Add / remove a layer from the selection'],
      ['⌘A', 'Select all layers'],
      ['⌘D', 'Deselect'],
      ['Esc', 'Up one level: picked glyphs, effect → part → layer → group → Document (deselect)'],
      ['⇧⌘N', 'New layer: text of the Type tool’s kind, ready to type'],
      ['⌘J', 'Duplicate the selected layers (numbered: “確定 2”)'],
      ['⌘G', 'Group the selected layers (the group’s effects wrap them all)'],
      ['⇧⌘G', 'Ungroup'],
      ['⌥⌘G', 'Create / release clipping mask'],
      ['⌥-click between two rows', 'Layers panel: clip the upper layer to the one below / release'],
      ['Del  /  ⌫', 'Delete the selected layers (or the selected effect)'],
      ['⌘]  /  ⌘[', 'Bring forward / send backward'],
      ['⇧⌘]  /  ⇧⌘[', 'Bring to front / send to back'],
      ['Edit ▸ Transform ▸ Flip Horizontal', 'Mirror the selected layers left ↔ right in place (also in the layer menu and Transform; no shortcut, as in Photoshop)'],
      ['Edit ▸ Transform ▸ Flip Vertical', 'Mirror the selected layers top ↔ bottom in place (also in the layer menu and Transform; no shortcut, as in Photoshop)'],
      ['Drag a row', 'Reorder (moves the whole selection); onto the middle of a group row: into the group'],
      ['Drag an effect row', 'Move it onto another layer, part or group (⌥ copies)'],
      ['Double-click a name', 'Rename (a renamed text layer stops following its text)'],
      ['⌘⌥C  /  ⌘⌥V', 'Copy style / paste it onto every selected layer'],
      ['⌘V', 'Paste an image or SVG from the clipboard as a new 2D layer'],
      ['⌥⇧⌘V', 'Paste an image or SVG as a new 3D (extruded) layer'],
      ['Drop files', 'Images, SVG, GLB or fonts onto the canvas (left half 2D, right half 3D) or onto the Layers panel'],
      ['⇧⌘C', 'Export dialog: copy the PNG to the clipboard'],
    ],
  },
  {
    group: 'Layers panel (focused)',
    items: [
      ['↑ ↓', 'Select the row above / below'],
      ['→  /  ←', 'Twirl open / closed'],
      ['F2  /  ↵ Enter', 'Rename'],
      ['Del  /  ⌫', 'Delete'],
    ],
  },
  {
    group: 'Layers on the canvas',
    items: [
      ['Drag', 'Move (snaps to the comp and other layers)'],
      ['⌘-drag', 'Move without snapping'],
      ['⇧-drag', 'Move along one axis'],
      ['⇧-click', 'Add / remove a layer from the selection'],
      ['Drag empty canvas', 'Marquee-select layers'],
      ['3D arrows', 'Move along X / Y / Z; the centre square moves in the screen plane (⇧ steps)'],
      ['3D arcs', 'Rotate about X / Y / Z: drag along the arc (⇧ 15°)'],
      ['3D ring  /  ⌥-drag', 'Rotate freely, like a trackball (⇧ 15°)'],
      ['⌥-click a title', 'Select the part under the cursor (face, rim, band, side wall, plate)'],
      ['← → ↑ ↓', 'Nudge the selection 1 px'],
      ['⇧ + arrows', 'Nudge 10 px'],
    ],
  },
  {
    group: 'Text',
    items: [
      ['Double-click text', 'Edit the text inline'],
      ['↵ Enter', 'Edit the selected text layer inline'],
      ['Esc  /  ⌘↵  /  click outside', 'Finish inline editing'],
    ],
  },
  {
    group: 'Per-letter (glyphs)',
    items: [
      ['Click a glyph', 'On the selected text layer: pick that glyph'],
      ['⇧-click a glyph', 'Add / remove a glyph'],
      ['Drag empty canvas', 'Glyph marquee (⇧ adds)'],
      ['Drag a glyph', 'Move it (⇧ one axis)'],
      ['Corner handles', 'Scale (⇧ 5 % steps)'],
      ['Top stem (2D)', 'Rotate (⇧ 15°)'],
      ['← → ↑ ↓', 'Nudge 1 px (⇧ 10 px)'],
      ['3D arrows', 'Move along X / Y / Z; the centre square moves in the screen plane (⇧ steps)'],
      ['3D arcs', 'Rotate about X / Y / Z: drag along the arc (⇧ 15°)'],
      ['3D ring  /  ⌥-drag', 'Rotate freely, like a trackball (⇧ 15°)'],
      ['Esc', 'Back to the whole layer'],
    ],
  },
  {
    group: 'On-canvas handles',
    items: [
      ['Gradient line', 'Gradient tool: the selected part’s fill (a layer: its face); drag across the canvas for a new one, the ends set angle / length (⇧ 15°)'],
      ['Shape handles', 'Move tool, shape layer selected, transform controls on: corner, inner, points and tail (⇧ snaps)'],
      ['Warp handle', 'Move tool, warped layer selected, transform controls on: drag to bend (⇧ snaps)'],
    ],
  },
  {
    group: 'View',
    items: [
      ['⌘0', 'Fit the comp in the view'],
      ['⇧⌘Y', 'CMYK gamut warning on / off'],
      ['⌘1', '100 %'],
      ['⌘=  /  ⌘-', 'Zoom in / out'],
      ['⌘-wheel  /  pinch', 'Zoom about the cursor'],
      ['Wheel', 'Pan'],
      ['Space-drag', 'Pan'],
    ],
  },
  {
    group: 'Panels',
    items: [
      ['⌘F', 'Find a setting in Properties, or a style in the Library while it shows (from the canvas or that panel; in a text field, the browser’s find)'],
      ['← →  on a tab', 'Switch tabs in a dock group'],
      ['Double-click a tab strip', 'Collapse / expand the group'],
      ['Drag the dock’s left edge', 'Resize the dock (double-click: default width)'],
      ['Drag between the groups', 'Share the height (double-click: half and half)'],
    ],
  },
  {
    group: 'Number fields',
    items: [
      ['Drag value or label', 'Scrub (⇧ ×10, ⌥ ×0.1)'],
      ['Click the value', 'Type a value'],
      ['↑ ↓', 'Step the value'],
      ['Wheel', 'Step while focused, or with ⌥'],
      ['Double-click the label', 'Reset to the default'],
    ],
  },
  {
    group: 'Help',
    items: [['?', 'Show / hide this sheet']],
  },
];

/** The "?" overlay: every shortcut on one sheet. Closes on Esc, "?", or a click outside. */
export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== '?') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    // Capture, so Esc closes the sheet instead of also deselecting underneath.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal shortcut-sheet" role="dialog" aria-label={t('Keyboard shortcuts')}>
        <div className="modal-head">
          <span>{t('Keyboard shortcuts')}</span>
          <span className="muted shortcut-note">{t('⌘ = Ctrl on Windows')}</span>
          <button className="small right" title={t('Close (Esc)')} aria-label={t('Close shortcuts')} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="shortcut-cols">
          {SHORTCUTS.map((g) => (
            <section key={g.group} className="shortcut-group">
              <h3>{t(g.group)}</h3>
              <dl>
                {g.items.map(([keys, what]) => (
                  <div key={keys + what} className="shortcut-row">
                    <dt>
                      {/* Keys with words (Click, Drag, Wheel) are translated; bare key glyphs stay. */}
                      <kbd>{/[a-z]{3}/.test(keys) ? t(keys) : keys}</kbd>
                    </dt>
                    <dd>{t(what)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
