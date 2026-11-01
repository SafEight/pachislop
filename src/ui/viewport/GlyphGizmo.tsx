import type { CharAdjust } from '../../model/types';
import { useT, type TVars } from '../i18n';
import { oneShot } from '../util';
import { drag, type StageMap } from './drag';
import type { Pt } from './geometry';
import { snap, startGlyphMove, writeGlyphs, type TextLayer } from './glyphEdit';
import { pickedText, type GlyphGizmoGeom } from './glyphs';
import { Handle, ROTATE_CURSOR } from './Handle';

// On-canvas per-glyph gizmo: drag a picked glyph to move it (dx / dy), corners scale evenly, the
// side bars set 長体 / 平体 (hScale / vScale), the stem
// rotates; on 3D layers ⌥-drag or the Z handle pushes in depth (dz) and the two arc handles
// tilt (tiltX / tiltY). Shift constrains moves to one axis and snaps scale to 5 %, rotation
// and tilt to 15°. Every gesture is one undo step labelled with the picked characters.

const DEG = Math.PI / 180;
/** Tilt degrees per screen px of handle travel. */
const TILT_PER_PX = 0.5;
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
  const tiltXAt = outward(c, sides.bottom, 28);
  const tiltYAt = outward(c, sides.right, 28);
  const zAt = outward(c, F[1], 30);
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

  const startTilt = (e: React.PointerEvent, axis: 'x' | 'y') => {
    const key = oneShot(`glyph-tilt:${layer.id}`);
    const sx = e.clientX;
    const sy = e.clientY;
    const t0 = (axis === 'x' ? primary?.tiltX : primary?.tiltY) ?? 0;
    // A mirrored axis turns the other way on screen: the handles keep their screen sides.
    const mirror = (axis === 'x' ? layer.transform.flipY : layer.transform.flipX) ? -1 : 1;
    drag(e, (ev) => {
      // Bottom handle: dragging down pulls the bottom toward the viewer (−tiltX). Right handle: dragging right brings the right side forward (+tiltY).
      let delta = mirror * (axis === 'x' ? -(ev.clientY - sy) * TILT_PER_PX : (ev.clientX - sx) * TILT_PER_PX);
      if (ev.shiftKey) delta = snap(t0 + delta, 15) - t0;
      const clampT = (v: number) => r1(Math.max(-89, Math.min(89, v)));
      writeGlyphs(layer, chars0, indices, (a) => (axis === 'x' ? { ...a, tiltX: clampT((a.tiltX ?? 0) + delta) } : { ...a, tiltY: clampT((a.tiltY ?? 0) + delta) }), key, 'Tilt {chars}');
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
      <line className="rot-stem" x1={topMid.x} y1={topMid.y} x2={rot.x} y2={rot.y} />
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
      <Handle x={rot.x} y={rot.y} cursor={ROTATE_CURSOR} title={t('Rotate {chars} (Shift: 15° steps)', { chars: label })} onDown={startRotate}>
        <circle className="handle glyph rot" cx={rot.x} cy={rot.y} r={6} />
      </Handle>
      {is3D && (
        <>
          <Handle x={tiltXAt.x} y={tiltXAt.y + 5} cursor="ns-resize" title={t('Tilt {chars} about X: drag up / down (Shift: 15° steps)', { chars: label })} onDown={(e) => startTilt(e, 'x')}>
            <path className="handle glyph tilt" d={arcPath(tiltXAt, 'h')} />
          </Handle>
          <Handle x={tiltYAt.x + 5} y={tiltYAt.y} cursor="ew-resize" title={t('Tilt {chars} about Y: drag left / right (Shift: 15° steps)', { chars: label })} onDown={(e) => startTilt(e, 'y')}>
            <path className="handle glyph tilt" d={arcPath(tiltYAt, 'v')} />
          </Handle>
          <Handle
            x={zAt.x}
            y={zAt.y}
            cursor="ns-resize"
            className="z"
            title={t('Push {chars} in Z: drag up = toward the viewer (Shift: 5% steps; or ⌥-drag the glyph)', { chars: label })}
            onDown={(e) => startGlyphMove(e, layer, indices, gz, stage, true)}
          >
            <circle className="handle glyph z" cx={zAt.x} cy={zAt.y} r={8} />
            <text className="z-label" x={zAt.x} y={zAt.y + 3.5} textAnchor="middle">
              Z
            </text>
          </Handle>
        </>
      )}
      <circle className="pivot glyph" cx={pivot.x} cy={pivot.y} r={2.5} />
      <text className="glyph-readout" x={F[3].x} y={F[3].y + 16}>
        {readout(primary, is3D, t)}
      </text>
    </g>
  );
}

/** A short double-headed arc handle centred on `p`: 'h' spans left-right (bottom tilt), 'v' up-down (side tilt). */
function arcPath(p: Pt, dir: 'h' | 'v') {
  const r = 9;
  return dir === 'h'
    ? `M ${p.x - r} ${p.y - 3} Q ${p.x} ${p.y + 7} ${p.x + r} ${p.y - 3} L ${p.x + r} ${p.y + 3} Q ${p.x} ${p.y + 13} ${p.x - r} ${p.y + 3} Z`
    : `M ${p.x - 3} ${p.y - r} Q ${p.x + 7} ${p.y} ${p.x - 3} ${p.y + r} L ${p.x + 3} ${p.y + r} Q ${p.x + 13} ${p.y} ${p.x + 3} ${p.y - r} Z`;
}

function readout(a: CharAdjust | undefined, is3D: boolean, t: (en: string, vars?: TVars) => string) {
  if (!a) return '';
  const parts = [`${r1(a.dx)}, ${r1(a.dy)}%`, `${Math.round(a.scale * 100)}%`, `${r1(a.rotate)}°`];
  if ((a.hScale ?? 1) !== 1 || (a.vScale ?? 1) !== 1) parts.push(t('W {w}% H {h}%', { w: Math.round((a.hScale ?? 1) * 100), h: Math.round((a.vScale ?? 1) * 100) }));
  if (is3D && (a.dz || a.tiltX || a.tiltY)) parts.push(`z ${r1(a.dz ?? 0)}%`, t('tilt {x}° / {y}°', { x: r1(a.tiltX ?? 0), y: r1(a.tiltY ?? 0) }));
  return parts.join(' · ');
}
