import type { GradientMask, Layer, ShapeMask } from '../../model/types';
import { maskLabel } from '../../store/labels';
import { formatMsg } from '../../store/msg';
import { useEditor } from '../../store/store';
import { cmdsBounds } from '../../text/layout';
import { shapeCmds } from '../../text/shapes';
import { useT } from '../i18n';
import { oneShot } from '../util';
import { drag, type StageMap } from './drag';
import { svgPath, viewCorners, type Pt } from './geometry';
import { Handle, HIT_R, ROTATE_CURSOR } from './Handle';
import { dragGradientMask, gradientMaskLine, maskShapeView, maskView, rotateShapeMask, scaleShapeMask, type GradientMaskHandle } from './mask';
import { dragShapeHandle, sourceShapeHandles, type ShapeHandleKey } from './shapeHandles';

// The selected mask on the canvas (Photoshop vector / gradient masks): a shape mask's dashed
// outline with move, scale (corners even, sides one axis), rotate and parametric shape handles;
// a gradient mask's line (the Gradient tool's line UI) with start, end, midpoint and radial inner
// handles. `active` = editable (Move tool; Gradient tool for gradient masks); else outline only.

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Move gesture of a mask by its own-space pointer travel (Shift: one screen axis). */
function startMaskMove(e: React.PointerEvent, layer: Layer, mask: ShapeMask | GradientMask, stage: StageMap) {
  const key = oneShot(`mask-move:${mask.id}`);
  const space = maskView(layer, mask);
  const sx = e.clientX;
  const sy = e.clientY;
  const q0 = space.fromComp(stage.toComp(sx, sy));
  if (!q0) return;
  drag(e, (ev) => {
    let cx = ev.clientX;
    let cy = ev.clientY;
    if (ev.shiftKey) {
      if (Math.abs(cx - sx) > Math.abs(cy - sy)) cy = sy;
      else cx = sx;
    }
    const q = space.fromComp(stage.toComp(cx, cy));
    if (q) useEditor.getState().updateMask(layer.id, mask.id, { x: r2(mask.x + q.x - q0.x), y: r2(mask.y + q.y - q0.y) }, key, 'Move mask');
  });
}

export function MaskHandles({ layer, mask, stage, active }: { layer: Layer; mask: ShapeMask | GradientMask; stage: StageMap; active: boolean }) {
  return mask.kind === 'shape' ? <ShapeMaskHandles layer={layer} mask={mask} stage={stage} active={active} /> : <GradientMaskHandles layer={layer} mask={mask} stage={stage} active={active} />;
}

function ShapeMaskHandles({ layer, mask, stage, active }: { layer: Layer; mask: ShapeMask; stage: StageMap; active: boolean }) {
  const t = useT();
  const view = maskShapeView(layer, mask);
  const P = (p: Pt) => stage.S(view.toComp(p));
  const at = (ev: { clientX: number; clientY: number }) => view.fromComp(stage.toComp(ev.clientX, ev.clientY));
  const space = maskView(layer, mask);
  const src = mask.source;
  const cmds = shapeCmds(src);
  if (cmds.length === 0) return null;
  const outline = svgPath(cmds, P);
  const label = formatMsg(maskLabel(layer, mask.id), t);
  if (!active)
    return (
      <g className="mask-shape">
        <path className="mask-outline" d={outline} />
      </g>
    );
  const { updateMask } = useEditor.getState();
  const corners = viewCorners(view, cmdsBounds(cmds)).map(stage.S);
  const boxMid = mid(corners[0], corners[2]);
  const grip = 2 * HIT_R;
  // A shape handle on a corner scale handle (a sharp rectangle's Corner) shows inset along that
  // corner's diagonal, like Photoshop's live-corner widget, so both stay grabbable.
  const shapeHs = sourceShapeHandles(src).map((h) => {
    const q = P(h.at);
    const c = corners.find((k) => Math.hypot(q.x - k.x, q.y - k.y) < grip);
    if (!c) return { ...h, q };
    const dl = Math.hypot(boxMid.x - c.x, boxMid.y - c.y) || 1;
    return { ...h, q: { x: c.x + ((boxMid.x - c.x) / dl) * grip, y: c.y + ((boxMid.y - c.y) / dl) * grip } };
  });
  const top = mid(corners[0], corners[1]);
  // A side handle a shape handle sits on (a star's top tip) gives way: the opposite side still stretches that axis.
  const sides = [
    { at: top, axis: 'y' as const, cursor: 'ns-resize' },
    { at: mid(corners[1], corners[2]), axis: 'x' as const, cursor: 'ew-resize' },
    { at: mid(corners[2], corners[3]), axis: 'y' as const, cursor: 'ns-resize' },
    { at: mid(corners[3], corners[0]), axis: 'x' as const, cursor: 'ew-resize' },
  ].filter((s) => !shapeHs.some((h) => Math.hypot(h.q.x - s.at.x, h.q.y - s.at.y) < grip));
  const centre = P({ x: 0, y: 0 });
  const len = Math.hypot(top.x - boxMid.x, top.y - boxMid.y) || 1;
  const rot = { x: top.x + ((top.x - boxMid.x) / len) * 28, y: top.y + ((top.y - boxMid.y) / len) * 28 };

  const startScale = (e: React.PointerEvent, axis: 'xy' | 'x' | 'y') => {
    const key = oneShot(`mask-scale:${mask.id}`);
    const q0 = at(e);
    if (!q0) return;
    drag(e, (ev) => {
      const q = at(ev);
      if (q) updateMask(layer.id, mask.id, { source: { ...src, ...scaleShapeMask(src, axis, q0, q, ev.shiftKey) } }, key, 'Scale mask');
    });
  };
  const startRotate = (e: React.PointerEvent) => {
    const key = oneShot(`mask-rot:${mask.id}`);
    const m0 = space.fromComp(stage.toComp(e.clientX, e.clientY));
    if (!m0) return;
    drag(e, (ev) => {
      const m = space.fromComp(stage.toComp(ev.clientX, ev.clientY));
      if (m) updateMask(layer.id, mask.id, { rotation: rotateShapeMask(mask, m0, m, ev.shiftKey) }, key, 'Rotate mask');
    });
  };
  // The handle's shape-space point moves by the pointer's travel, so a press off it (or on an inset grip) never jumps.
  const startShape = (e: React.PointerEvent, k: ShapeHandleKey, h0: Pt) => {
    const key = oneShot(`mask-shape:${mask.id}`);
    const p0 = at(e);
    const sx = e.clientX;
    if (!p0) return;
    drag(e, (ev) => {
      const p = at(ev);
      if (p) updateMask(layer.id, mask.id, { source: { ...src, ...dragShapeHandle(src, k, h0, { x: h0.x + p.x - p0.x, y: h0.y + p.y - p0.y }, ev.clientX - sx, ev.shiftKey) } }, key, 'Mask shape');
    });
  };

  return (
    <g className="mask-shape">
      <path className="mask-outline" d={outline} />
      <path className="mask-outline-hit" d={outline} onPointerDown={(e) => e.button === 0 && startMaskMove(e, layer, mask, stage)}>
        <title>{t('{mask}: drag the outline to move it (Shift: one axis)', { mask: label })}</title>
      </path>
      <polygon className="mask-box" points={corners.map((q) => `${q.x},${q.y}`).join(' ')} />
      <line className="rot-stem" x1={top.x} y1={top.y} x2={rot.x} y2={rot.y} />
      {corners.map((c, i) => (
        <Handle key={`c${i}`} x={c.x} y={c.y} cursor={i % 2 === 0 ? 'nwse-resize' : 'nesw-resize'} title={t('Drag to scale the mask (Shift: 5% steps)')} onDown={(e) => startScale(e, 'xy')}>
          <rect className="handle mask scale" x={c.x - 5} y={c.y - 5} width={10} height={10} />
        </Handle>
      ))}
      {sides.map((s, i) => (
        <Handle
          key={`s${i}`}
          x={s.at.x}
          y={s.at.y}
          cursor={s.cursor}
          title={s.axis === 'x' ? t('Drag to stretch the mask’s width') : t('Drag to stretch the mask’s height')}
          onDown={(e) => startScale(e, s.axis)}
        >
          <rect className="handle mask side" x={s.at.x - 4} y={s.at.y - 4} width={8} height={8} />
        </Handle>
      ))}
      <Handle x={rot.x} y={rot.y} cursor={ROTATE_CURSOR} title={t('Drag to rotate the mask (Shift: 15° steps)')} onDown={startRotate}>
        <circle className="handle mask rot" cx={rot.x} cy={rot.y} r={6} />
      </Handle>
      <Handle x={centre.x} y={centre.y} cursor="move" title={t('{mask}: drag to move it (Shift: one axis)', { mask: label })} onDown={(e) => startMaskMove(e, layer, mask, stage)}>
        <circle className="handle mask move" cx={centre.x} cy={centre.y} r={5} />
        <line className="mask-cross" x1={centre.x - 10} y1={centre.y} x2={centre.x + 10} y2={centre.y} />
        <line className="mask-cross" x1={centre.x} y1={centre.y - 10} x2={centre.x} y2={centre.y + 10} />
      </Handle>
      {shapeHs.map(({ q, ...h }) => {
        return (
          <Handle key={h.key} x={q.x} y={q.y} cursor={h.key === 'points' ? 'ew-resize' : 'move'} className="shape-h" title={formatMsg(h.title, t)} onDown={(e) => startShape(e, h.key, h.at)}>
            <rect className="handle shape" x={q.x - 6} y={q.y - 6} width={12} height={12} transform={`rotate(45 ${q.x} ${q.y})`} />
            <text x={q.x + 10} y={q.y - 8}>
              {formatMsg(h.label, t)}
            </text>
          </Handle>
        );
      })}
      {/* Left of the top-left corner, clear of the corner handle and the shape handles' own labels (drawn to their right). */}
      <text className="mask-label" x={corners[0].x - 10} y={corners[0].y - 8} textAnchor="end">
        {label}
      </text>
    </g>
  );
}

function GradientMaskHandles({ layer, mask, stage, active }: { layer: Layer; mask: GradientMask; stage: StageMap; active: boolean }) {
  const t = useT();
  const space = maskView(layer, mask);
  const P = (p: Pt) => stage.S(space.toComp(p));
  const line = gradientMaskLine(mask);
  const a = P(line.a);
  const b = P(line.b);
  const m = P(line.mid);
  const inner = line.inner && P(line.inner);
  const radial = mask.shape === 'radial';
  const radius = Math.hypot(b.x - a.x, b.y - a.y);
  const label = formatMsg(maskLabel(layer, mask.id), t);
  // A small inner edge would hide under the centre handle: its grip keeps 2 hit radii out along the line.
  const innerR = inner ? Math.hypot(inner.x - a.x, inner.y - a.y) : 0;
  const grip = 2 * HIT_R;
  const innerAt = inner && innerR < grip ? { x: a.x + ((b.x - a.x) / (radius || 1)) * grip, y: a.y + ((b.y - a.y) / (radius || 1)) * grip } : inner;

  // Drags move the handle's point by the pointer's travel, so a press off its centre (or on the inner edge's offset grip) never jumps.
  const startHandle = (e: React.PointerEvent, which: GradientMaskHandle) => {
    const key = oneShot(`mask-grad:${mask.id}`);
    const p0 = space.fromComp(stage.toComp(e.clientX, e.clientY));
    const h0 = which === 'a' ? line.a : which === 'b' ? line.b : which === 'mid' ? line.mid : line.inner;
    if (!p0 || !h0) return;
    drag(e, (ev) => {
      const p = space.fromComp(stage.toComp(ev.clientX, ev.clientY));
      if (p) useEditor.getState().updateMask(layer.id, mask.id, dragGradientMask(mask, which, { x: h0.x + p.x - p0.x, y: h0.y + p.y - p0.y }, ev.shiftKey ? space : null), key, 'Mask gradient');
    });
  };

  return (
    <g className="grad-tool mask-grad">
      {radial && <circle className="mask-radius" cx={a.x} cy={a.y} r={radius} />}
      {radial && inner && <circle className="mask-radius inner" cx={a.x} cy={a.y} r={Math.hypot(inner.x - a.x, inner.y - a.y)} />}
      {active && (
        <line className="grad-line-hit" x1={a.x} y1={a.y} x2={b.x} y2={b.y} onPointerDown={(e) => e.button === 0 && startMaskMove(e, layer, mask, stage)}>
          <title>{t('{mask}: drag the line to move the gradient (Shift: one axis)', { mask: label })}</title>
        </line>
      )}
      <line className="grad-line" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
      {active ? (
        <>
          <Handle
            x={a.x}
            y={a.y}
            cursor="move"
            title={radial ? t('Mask gradient centre (opaque): drag to move it') : t('Mask gradient start (opaque): drag to set angle, length and position (Shift: 15°)')}
            onDown={(e) => startHandle(e, 'a')}
          >
            <circle className="handle grad start" cx={a.x} cy={a.y} r={6} />
          </Handle>
          {innerAt && (
            <Handle x={innerAt.x} y={innerAt.y} cursor="move" title={t('Mask gradient inner edge: drag along the line (fully opaque inside)')} onDown={(e) => startHandle(e, 'inner')}>
              <circle className="handle grad inner" cx={innerAt.x} cy={innerAt.y} r={4.5} />
            </Handle>
          )}
          <Handle x={m.x} y={m.y} cursor="move" title={t('Mask gradient midpoint (half transparent): drag along the line')} onDown={(e) => startHandle(e, 'mid')}>
            <rect className="handle grad mid" x={m.x - 4.5} y={m.y - 4.5} width={9} height={9} transform={`rotate(45 ${m.x} ${m.y})`} />
          </Handle>
          <Handle
            x={b.x}
            y={b.y}
            cursor="move"
            title={radial ? t('Mask gradient edge (transparent): drag to set the radius') : t('Mask gradient end (transparent): drag to set angle and length (Shift: 15°)')}
            onDown={(e) => startHandle(e, 'b')}
          >
            <circle className="handle grad end" cx={b.x} cy={b.y} r={6} />
          </Handle>
        </>
      ) : (
        <>
          <circle className="grad-centre" cx={a.x} cy={a.y} r={3} />
          <circle className="grad-centre" cx={b.x} cy={b.y} r={3} />
        </>
      )}
      <text className="grad-label" x={b.x + 10} y={b.y - 8}>
        {label}
      </text>
    </g>
  );
}
