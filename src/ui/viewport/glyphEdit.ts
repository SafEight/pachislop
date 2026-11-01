import type { TitleLayer } from '../../model/parts';
import type { CharAdjust, Layer, TextSource } from '../../model/types';
import { msg } from '../../store/msg';
import { useEditor } from '../../store/store';
import { oneShot } from '../util';
import { press, type StageMap } from './drag';
import type { Pt } from './geometry';
import { mapAdjusts, pickedText, type GlyphGizmoGeom } from './glyphs';

// Per-glyph edits of the glyph tool (GlyphGizmo, the Viewport's glyph presses and arrow keys):
// each writes the picked glyphs' CharAdjust as one undo step labelled with the picked characters.

export type TextLayer = TitleLayer & { source: TextSource };

const r2 = (v: number) => Math.round(v * 100) / 100;
export const snap = (v: number, step: number) => Math.round(v / step) * step;

const charsRef = (layer: Layer) => ({ layerId: layer.id, path: ['source', 'chars'] });

/** Write `fn` over the picked glyphs, computed from the gesture's starting `chars`; `label` is the History template, `{chars}` the picked characters. */
export function writeGlyphs(layer: TextLayer, chars0: TextSource['chars'], indices: number[], fn: (a: CharAdjust, i: number) => CharAdjust, key: string, label: string) {
  useEditor.getState().setAt(charsRef(layer), mapAdjusts(chars0, indices, fn), key, msg(label, { chars: pickedText(layer.source, indices) }));
}

/** Comp px of a screen drag → % of size along the layer (2D: un-rotated; 3D: on the glyph's plane). */
function layerDelta(gz: GlyphGizmoGeom, p0: Pt, p1: Pt): Pt | null {
  const a = gz.view.fromComp(p0, gz.planeZ);
  const b = gz.view.fromComp(p1, gz.planeZ);
  return a && b ? { x: b.x - a.x, y: b.y - a.y } : null;
}

/**
 * Move the picked glyphs with the pointer (dx / dy); with `depth`, vertical travel pushes them
 * in z instead (3D: up = toward the viewer). Shift: one axis.
 */
export function startGlyphMove(e: React.PointerEvent, layer: TextLayer, indices: number[], gz: GlyphGizmoGeom, stage: StageMap, depth: boolean, onClick?: (ev: PointerEvent) => void) {
  const chars0 = layer.source.chars;
  const size = layer.source.size;
  const p0 = stage.toComp(e.clientX, e.clientY);
  const sx = e.clientX;
  const sy = e.clientY;
  const key = oneShot(`glyph-move:${layer.id}`);
  const scale = Math.max(1e-6, Math.abs(layer.transform.scale));
  press(e, {
    onClick,
    onDrag: (ev) => {
      if (depth) {
        const dz = ((-(ev.clientY - sy) / stage.d / scale) / size) * 100;
        writeGlyphs(layer, chars0, indices, (a) => ({ ...a, dz: r2((a.dz ?? 0) + (ev.shiftKey ? snap(dz, 5) : dz)) }), key, 'Push {chars}');
        return;
      }
      let cx = ev.clientX;
      let cy = ev.clientY;
      if (ev.shiftKey) {
        if (Math.abs(cx - sx) > Math.abs(cy - sy)) cy = sy;
        else cx = sx;
      }
      const dl = layerDelta(gz, p0, stage.toComp(cx, cy));
      if (!dl) return;
      const dx = (dl.x / size) * 100;
      const dy = (dl.y / size) * 100;
      writeGlyphs(layer, chars0, indices, (a) => ({ ...a, dx: r2(a.dx + dx), dy: r2(a.dy + dy) }), key, 'Move {chars}');
    },
  });
}

/** Nudge the picked glyphs by comp px (arrow keys; a flipped layer's mirrored axis nudges the other way, so the glyph moves with the arrow). */
export function nudgeGlyphs(layer: TextLayer, indices: number[], dxPx: number, dyPx: number, key: string) {
  const k = 100 / layer.source.size / Math.max(1e-6, Math.abs(layer.transform.scale));
  const kx = layer.transform.flipX ? -k : k;
  const ky = layer.transform.flipY ? -k : k;
  writeGlyphs(layer, layer.source.chars, indices, (a) => ({ ...a, dx: r2(a.dx + dxPx * kx), dy: r2(a.dy + dyPx * ky) }), key, 'Nudge {chars}');
}
