import type { Comp } from '../../model/types';
import type { TitleLayer } from '../../model/parts';
import { formatMsg } from '../../store/msg';
import { useEditor } from '../../store/store';
import { useT } from '../i18n';
import { oneShot } from '../util';
import { drag, type StageMap } from './drag';
import { layerView, sourceBounds, type Pt } from './geometry';
import { dragGradientHandle, dragGradientLine, gradientHandles, type GradKind } from './gradient';
import { gradientBox, type GradientTarget } from './gradientTarget';
import { Handle } from './Handle';
import { pointerOn, ref, writeGradient } from './paramEdit';
import { dragShapeHandle, shapeHandles, type ShapeHandleKey } from './shapeHandles';

// Direct on-canvas handles for the selected layer's geometric params:
// - Gradient tool: the target part's fill gradient as an Illustrator-style line (t = 0 / t = 1
//   handles, drag the line to slide it; a drag across the canvas lays a new one, as in PS):
//   angle, scale and offset of a 2D Fill or a 3D material gradient;
// - Move tool on a layer node: shape corner / inner radius / point count / tail tip, and the warp bend.

/** Bend % per screen px of vertical travel on the warp handle. */
const BEND_PER_PX = 0.5;

/** History label of a shape-handle drag. */
const SHAPE_EDIT: Record<ShapeHandleKey, string> = { corner: 'Shape corner', inner: 'Shape inner', points: 'Shape points', tail: 'Shape tail' };

/** Tooltip of the gradient line per kind. */
const GRAD_LINE_TITLE: Record<GradKind, string> = {
  linear: 'Linear gradient: drag the line to slide it (offset)',
  radial: 'Radial gradient: drag the line to slide it (offset)',
  angle: 'Angle gradient: drag the line to slide it (offset)',
  reflected: 'Reflected gradient: drag the line to slide it (offset)',
  diamond: 'Diamond gradient: drag the line to slide it (offset)',
};

export function GradientHandles({ comp, target, selectedChars, stage }: { comp: Comp; target: GradientTarget; selectedChars: readonly number[]; stage: StageMap }) {
  const t = useT();
  const { layer, grad: g } = target;
  const box = g && gradientBox(target, g.span, selectedChars);
  if (!g || !box) return null;
  const view = layerView(comp, layer);
  const P = (p: Pt) => stage.S(view.toComp(p, 0));
  const at = pointerOn(comp, layer, stage);
  const h = gradientHandles(g.params, box);
  const startHandle = (e: React.PointerEvent, which: 'a' | 'b') => {
    const key = oneShot(`grad:${layer.id}`);
    const p0 = g.params;
    drag(e, (ev) => {
      const p = at(ev);
      if (p) writeGradient(layer, g, dragGradientHandle(p0, box, which, p, ev.shiftKey), key);
    });
  };
  const startLine = (e: React.PointerEvent) => {
    const key = oneShot(`grad:${layer.id}`);
    const p0 = g.params;
    const q0 = at(e);
    if (!q0) return;
    drag(e, (ev) => {
      const q = at(ev);
      if (q) writeGradient(layer, g, dragGradientLine(p0, box, p0, { x: q.x - q0.x, y: q.y - q0.y }), key);
    });
  };
  const c = P(h.c);
  const a = h.a && P(h.a);
  const b = P(h.b);
  const from = g.params.kind === 'linear' && a ? a : c;
  return (
    <g className="grad-tool">
      <line className="grad-line-hit" x1={from.x} y1={from.y} x2={b.x} y2={b.y} onPointerDown={(e) => e.button === 0 && startLine(e)}>
        <title>{t(GRAD_LINE_TITLE[g.params.kind])}</title>
      </line>
      <line className="grad-line" x1={from.x} y1={from.y} x2={b.x} y2={b.y} />
      {g.params.kind !== 'linear' && <circle className="grad-centre" cx={c.x} cy={c.y} r={3} />}
      {a && (
        <Handle
          x={a.x}
          y={a.y}
          cursor="move"
          title={g.params.kind === 'linear' ? t('Gradient start (first stop): drag to set angle, length and position (Shift: 15°)') : t('Gradient start (first stop): drag to set the offset')}
          onDown={(e) => startHandle(e, 'a')}
        >
          <circle className="handle grad start" cx={a.x} cy={a.y} r={6} />
        </Handle>
      )}
      <Handle
        x={b.x}
        y={b.y}
        cursor="move"
        title={
          g.params.kind === 'angle'
            ? t('Angle gradient start direction (Shift: 15°)')
            : g.params.kind === 'radial' || g.params.kind === 'diamond'
              ? t('Gradient end (last stop): drag to set the size')
              : t('Gradient end (last stop): drag to set angle and length (Shift: 15°)')
        }
        onDown={(e) => startHandle(e, 'b')}
      >
        <circle className="handle grad end" cx={b.x} cy={b.y} r={6} />
      </Handle>
      <text className="grad-label" x={b.x + 10} y={b.y - 8}>
        {formatMsg(target.label, t)}
      </text>
    </g>
  );
}

export function SourceHandles({ comp, layer, stage }: { comp: Comp; layer: TitleLayer; stage: StageMap }) {
  const t = useT();
  const { setAt } = useEditor.getState();
  const view = layerView(comp, layer);
  const P = (p: Pt) => stage.S(view.toComp(p, 0));
  const at = pointerOn(comp, layer, stage);
  const src = layer.source;
  const handles = shapeHandles(layer);
  const startShape = (e: React.PointerEvent, key: ShapeHandleKey) => {
    if (src.kind !== 'shape') return;
    const ck = oneShot(`shape-h:${layer.id}`);
    const p0 = at(e);
    const sx = e.clientX;
    if (!p0) return;
    drag(e, (ev) => {
      const p = at(ev);
      if (!p) return;
      const patch = dragShapeHandle(src, key, p0, p, ev.clientX - sx, ev.shiftKey);
      for (const [k, v] of Object.entries(patch)) setAt(ref(layer, ['source', k]), v, ck, SHAPE_EDIT[key]);
    });
  };

  const warp = layer.warp;
  const { flipX, flipY } = layer.transform;
  const sb = (src.kind === 'text' || src.kind === 'shape') && warp.style !== 'none' ? sourceBounds(layer) : null;
  // Off the top centre (on screen, whatever the flip), where the rotate and point-count handles already sit.
  const bendAt = sb ? P({ x: flipX ? sb.x1 - (sb.x1 - sb.x0) * 0.75 : sb.x0 + (sb.x1 - sb.x0) * 0.75, y: flipY ? sb.y0 : sb.y1 }) : null;
  const startBend = (e: React.PointerEvent) => {
    const ck = oneShot(`bend:${layer.id}`);
    const sy = e.clientY;
    const b0 = warp.bend;
    // Up arcs the layer's top upward; mirrored vertically, that is down on screen.
    const k = flipY ? -BEND_PER_PX : BEND_PER_PX;
    drag(e, (ev) => {
      let v = b0 - (ev.clientY - sy) * k;
      v = ev.shiftKey ? Math.round(v / 10) * 10 : Math.round(v);
      setAt(ref(layer, ['warp', 'bend']), Math.max(-100, Math.min(100, v)), ck, 'Warp bend');
    });
  };

  return (
    <g className="src-handles">
      {handles.map((h) => {
        const q = P(h.at);
        return (
          <Handle key={h.key} x={q.x} y={q.y} cursor={h.key === 'points' ? 'ew-resize' : 'move'} className="shape-h" title={formatMsg(h.title, t)} onDown={(e) => startShape(e, h.key)}>
            <rect className="handle shape" x={q.x - 6} y={q.y - 6} width={12} height={12} transform={`rotate(45 ${q.x} ${q.y})`} />
            <text x={q.x + 10} y={q.y - 8}>
              {formatMsg(h.label, t)}
            </text>
          </Handle>
        );
      })}
      {bendAt && (
        <>
          <line className="bend-stem" x1={bendAt.x} y1={bendAt.y} x2={bendAt.x} y2={bendAt.y - 22} />
          <Handle x={bendAt.x} y={bendAt.y - 22} cursor="ns-resize" className="bend-h" title={t('Warp bend {v}%: drag up / down (Shift: 10% steps)', { v: warp.bend })} onDown={startBend}>
            <circle className="handle bend" cx={bendAt.x} cy={bendAt.y - 22} r={6} />
            <text x={bendAt.x + 10} y={bendAt.y - 26}>
              {t('Bend {v}%', { v: warp.bend })}
            </text>
          </Handle>
        </>
      )}
    </g>
  );
}
