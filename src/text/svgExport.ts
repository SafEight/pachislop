import type { Title2DLayer, Title3DLayer } from '../model/types';
import { outlinedShapeCmds, outlinedTextLayout } from './ink';
import { cmdsBounds, type Bounds, type PathCmd } from './layout';

// SVG outline export of a title's face (text or shape source, warp / distort / weight applied)
// for hand-off to Illustrator / Element 3D. Coordinates are layer space (comp px at the source
// size, transform not applied) with y flipped to SVG's y-down; the viewBox is fitted to the ink
// bounds.

const n = (v: number) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

function pathData(cmds: PathCmd[]): string {
  const parts: string[] = [];
  for (const c of cmds) {
    switch (c.type) {
      case 'M':
      case 'L':
        parts.push(`${c.type}${n(c.x)} ${n(-c.y)}`);
        break;
      case 'Q':
        parts.push(`Q${n(c.x1)} ${n(-c.y1)} ${n(c.x)} ${n(-c.y)}`);
        break;
      case 'C':
        parts.push(`C${n(c.x1)} ${n(-c.y1)} ${n(c.x2)} ${n(-c.y2)} ${n(c.x)} ${n(-c.y)}`);
        break;
      case 'Z':
        parts.push('Z');
        break;
    }
  }
  return parts.join('');
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

/** Face outlines: one entry per glyph for text, a single entry for a shape (an orb is its circle). */
function faceOutlines(layer: Title2DLayer | Title3DLayer): { title: string; bounds: Bounds; paths: { char?: string; cmds: PathCmd[] }[] } | null {
  const src = layer.source;
  if (src.kind === 'text') {
    const lay = outlinedTextLayout(src, layer);
    if (!lay || lay.glyphs.length === 0) return null;
    return { title: src.text, bounds: lay.bounds, paths: lay.glyphs.map((g) => ({ char: g.char, cmds: g.cmds })) };
  }
  if (src.kind === 'shape') {
    const cmds = outlinedShapeCmds(src, layer);
    if (cmds.length === 0) return null;
    return { title: src.shape, bounds: cmdsBounds(cmds), paths: [{ cmds }] };
  }
  return null;
}

/**
 * SVG document with one <path> per glyph (or one for a shape), filled black, nonzero; null
 * when the source is not text / shape, the font is not loaded yet (await ensureFont first)
 * or there is no outline.
 */
export function titleToSVG(layer: Title2DLayer | Title3DLayer): string | null {
  const face = faceOutlines(layer);
  if (!face) return null;
  const { bounds } = face;
  const x = bounds.x0;
  const y = -bounds.y1;
  const w = Math.max(bounds.x1 - bounds.x0, 1e-3);
  const h = Math.max(bounds.y1 - bounds.y0, 1e-3);
  const paths = face.paths
    .map((p) => `  <path${p.char !== undefined ? ` data-char="${esc(p.char)}"` : ''} d="${pathData(p.cmds)}"/>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(x)} ${n(y)} ${n(w)} ${n(h)}" width="${n(w)}" height="${n(h)}">`,
    `  <title>${esc(face.title)}</title>`,
    `  <g fill="#000000" fill-rule="nonzero">`,
    paths.replace(/^/gm, '  '),
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
}
