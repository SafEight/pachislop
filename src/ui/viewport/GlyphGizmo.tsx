import type { CharAdjust } from '../../model/types';
import { useT, type TVars } from '../i18n';
import { oneShot } from '../util';
import { drag, type StageMap } from './drag';
import type { Pt } from './geometry';
import { snap, writeGlyphs, type TextLayer } from './glyphEdit';
import { pickedText, type GlyphGizmoGeom } from './glyphs';
import { Handle, ROTATE_CURSOR } from './Handle';

// On-canvas per-glyph gizmo: drag a picked glyph to move it (dx / dy), corners scale evenly, the
// side bars set 長体 / 平体 (hScale / vScale); on 2D layers the stem rotates (3D layers move and
// rotate their glyphs with the shared 3D gizmo, Gizmo3D). Shift constrains moves to one axis and
// snaps scale to 5 %, rotation to 15°. Every gesture is one undo step labelled with the picked
// characters.

const DEG = Math.PI / 180;
const r1 = (v: number) => Math.round(v * 10) / 10;

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
/** `from` pushed `px` further away from `c`. */
const outward = (c: Pt, from: Pt, px: number): Pt => {
  const len = Math.hypot(from.x - c.x, from.y - c.y) || 1;
  return { x: from.x + ((from.x - c.x) / len) * px, y: from.y + ((from.y - c.y) / len) * px };
};
const poly = (pts: Pt[]) => pts.map((q) => `${q.x},${q.y}`).join(' ');

export function GlyphGizmo({ layer, gz, stage, indices }: { layer: TextLayer; gz: GlyphGizmoGeom; stage: StageMap; indices: number[] }) {
  const t = useT();
  if (!gz.frame || !gz.pivot || !gz.pivotL) return null;
  const is3D = layer.kind === 'title3d';
  const F = gz.frame.map(stage.S);
  const c = { x: (F[0].x + F[1].x + F[2].x + F[3].x) / 4, y: (F[0].y + F[1].y + F[2].y + F[3].y) / 4 };
  const pivotC = gz.pivot;
  const pivot = stage.S(pivotC);
  const topMid = mid(F[0], F[1]);
  const sides = { left: mid(F[0], F[3]), right: mid(F[1], F[2]), top: topMid, bottom: mid(F[3], F[2]) };
  // Spaced so neighbouring hit areas (HIT_R) stay apart around glyphs of normal on-screen size.
  const rot = outward(c, topMid, 30);
  const chars0 = layer.source.chars;
  const primary = chars0[indices[0]];
  const label = pickedText(layer.source, indices);
  const pivotL = gz.pivotL;

  const startScale = (e: React.PointerEvent) => {
    const key = oneShot(`glyph-scale:${layer.id}`);
    const pc = stage.client(pivotC);
    const d0 = Math.hypot(e.clientX - pc.x, e.clientY - pc.y) || 1;
    const ps0 = primary?.scale ?? 1;
    drag(e, (ev) => {
      let f = Math.hypot(ev.clientX - pc.x, ev.clientY - pc.y) / d0;
      if (ev.shiftKey) f = Math.max(0.05, snap(ps0 * f, 0.05)) / ps0;
      writeGlyphs(layer, chars0, indices, (a) => ({ ...a, scale: Math.max(0.01, Math.round(a.scale * f * 1000) / 1000) }), key, 'Scale {chars}');
    });
  };

  /**
   * 長体 / 平体 from a side handle: the travel along the glyph's own axis changes that side's
   * extent. The layout reflows the scaled glyph; it grows about its centre across a centred
   * line or a column (×2 per px of travel) and from the baseline upward in horizontal text (×1).
   */
  const startSide = (e: React.PointerEvent, side: keyof typeof sides) => {
    const key = oneShot(`glyph-hv:${layer.id}`);
    const horiz = side === 'left' || side === 'right';
    const [a, b] = horiz ? [sides.left, sides.right] : [sides.bottom, sides.top];
    const len0 = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len0;
    const uy = (b.y - a.y) / len0;
    const sign = side === 'right' || side === 'top' ? 1 : -1;
    const src = layer.source;
    const k = horiz ? (src.vertical || src.align === 'center' ? 2 : 1) : src.vertical && src.align === 'center' ? 2 : 1;
    const field = horiz ? 'hScale' : 'vScale';
    const p0 = primary?.[field] ?? 1;
    const sx = e.clientX;
    const sy = e.clientY;
    drag(e, (ev) => {
      const travel = sign * ((ev.clientX - sx) * ux + (ev.clientY - sy) * uy);
      let f = Math.max(0.05, (len0 + k * travel) / len0);
      if (ev.shiftKey) f = Math.max(0.05, snap(p0 * f, 0.05)) / p0;
      writeGlyphs(layer, chars0, indices, (x) => ({ ...x, [field]: Math.max(0.05, Math.round((x[field] ?? 1) * f * 1000) / 1000) }), key, horiz ? '長体/平体 width {chars}' : '長体/平体 height {chars}');
    });
  };

  // Rotation is measured in layer space, so it stays true on orbited 3D layers.
  const angleAt = (clientX: number, clientY: number) => {
    const q = gz.view.fromComp(stage.toComp(clientX, clientY), gz.planeZ);
    return q ? Math.atan2(q.y - pivotL.y, q.x - pivotL.x) / DEG : null;
  };
  const startRotate = (e: React.PointerEvent) => {
    const key = oneShot(`glyph-rot:${layer.id}`);
    const a0 = angleAt(e.clientX, e.clientY);
    const pr0 = primary?.rotate ?? 0;
    if (a0 === null) return;
    drag(e, (ev) => {
      const a = angleAt(ev.clientX, ev.clientY);
      if (a === null) return;
      let delta = -(a - a0); // clockwise on screen = negative in y-up
      delta = ((((delta + 180) % 360) + 360) % 360) - 180;
      if (ev.shiftKey) delta = snap(pr0 + delta, 15) - pr0;
      writeGlyphs(layer, chars0, indices, (x) => ({ ...x, rotate: r1(((((x.rotate + delta + 180) % 360) + 360) % 360) - 180) }), key, 'Rotate {chars}');
    });
  };

  return (
    <g className="glyph-gizmo">
      {gz.selected.map((g) => {
        const pts = gz.polys.get(g.index);
        return pts ? <polygon key={g.index} className="glyph-picked" points={poly(pts.map(stage.S))} /> : null;
      })}
      {/* Visual only: presses inside the frame reach the Viewport, which tells picked from unpicked glyphs. */}
      <polygon className="glyph-frame" points={poly(F)} />
      {!is3D && <line className="rot-stem" x1={topMid.x} y1={topMid.y} x2={rot.x} y2={rot.y} />}
      {F.map((p, i) => (
        <Handle key={i} x={p.x} y={p.y} cursor={i % 2 === 0 ? 'nwse-resize' : 'nesw-resize'} title={t('Scale {chars} (Shift: 5% steps)', { chars: label })} onDown={startScale}>
          <rect className="handle glyph scale" x={p.x - 5} y={p.y - 5} width={10} height={10} />
        </Handle>
      ))}
      {(Object.keys(sides) as (keyof typeof sides)[]).map((s) => {
        const p = sides[s];
        const horiz = s === 'left' || s === 'right';
        // The bar lies along its edge, so it turns with the glyph.
        const [ea, eb] = horiz ? [F[0], F[3]] : [F[0], F[1]];
        const ang = (Math.atan2(eb.y - ea.y, eb.x - ea.x) * 180) / Math.PI;
        return (
          <Handle
            key={s}
            x={p.x}
            y={p.y}
            cursor={horiz ? 'ew-resize' : 'ns-resize'}
            className="side"
            title={
              horiz
                ? t('長体 / 平体 width of {chars}: drag this side (hScale; Shift: 5% steps; corners scale evenly)', { chars: label })
                : t('長体 / 平体 height of {chars}: drag this side (vScale; Shift: 5% steps; corners scale evenly)', { chars: label })
            }
            onDown={(e) => startSide(e, s)}
          >
            <rect className="handle glyph side" x={p.x - 7} y={p.y - 2.5} width={14} height={5} rx={1.5} transform={`rotate(${ang} ${p.x} ${p.y})`} />
          </Handle>
        );
      })}
      {!is3D && (
        <Handle x={rot.x} y={rot.y} cursor={ROTATE_CURSOR} title={t('Rotate {chars} (Shift: 15° steps)', { chars: label })} onDown={startRotate}>
          <circle className="handle glyph rot" cx={rot.x} cy={rot.y} r={6} />
        </Handle>
      )}
      {!is3D && <circle className="pivot glyph" cx={pivot.x} cy={pivot.y} r={2.5} />}
      <text className="glyph-readout" x={F[3].x} y={F[3].y + 16}>
        {readout(primary, is3D, t)}
      </text>
    </g>
  );
}

/** The primary glyph's values in the Letters section's order: position (%), rotation (3D: X, Y, Z), scale, 長体 / 平体. */
function readout(a: CharAdjust | undefined, is3D: boolean, t: (en: string, vars?: TVars) => string) {
  if (!a) return '';
  const pos = is3D ? [a.dx, a.dy, a.dz ?? 0] : [a.dx, a.dy];
  const rot = is3D ? [a.tiltX ?? 0, a.tiltY ?? 0, a.rotate] : [a.rotate];
  const parts = [`${pos.map(r1).join(', ')}%`, rot.map((v) => `${r1(v)}°`).join(', '), `${Math.round(a.scale * 100)}%`];
  if ((a.hScale ?? 1) !== 1 || (a.vScale ?? 1) !== 1) parts.push(t('W {w}% H {h}%', { w: Math.round((a.hScale ?? 1) * 100), h: Math.round((a.vScale ?? 1) * 100) }));
  return parts.join(' · ');
}
