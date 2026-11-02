import { useState } from 'react';
import type { Comp } from '../../model/types';
import { useT } from '../i18n';
import type { StageMap } from './drag';
import { MOVE_ACTIONS, ROTATE_ACTIONS, arcPoint, gizmoView, startFreeRotate, startGizmoMove, startGizmoRotate, type Axis, type GizmoAction, type Gizmo3DTarget, type Vec3 } from './gizmoEdit';
import { ARM_PX } from './rotation3d';
import { Handle, ROTATE_CURSOR } from './Handle';

// The 3D gizmo of a selected 3D layer (Move tool) and of the picked glyphs of a 3D text
// (Per-letter tool), the same for both (gizmoEdit.ts holds the targets and gestures). A fixed
// schematic, identical everywhere apart from its position, centred on the pivot, X red / Y green
// / Z blue:
// - move arrows along the comp's X (right) / Y (up) / Z (down-left, toward the viewer), the same
//   for a layer and a letter, and a centre square that moves in the screen plane;
// - per comp axis, a quarter ring between the other two axes' arms: dragging along it turns the
//   object about that axis as far as the hand sweeps, all the way round;
// - a thin ring around it all: free rotate, a trackball (like ⌥-drag on the object).
// Hover names the action; a drag shows its axis and value. Every coloured stroke is drawn twice,
// a wide dark halo then the colour, so the handles read on white chrome, black lacquer and rainbow.

const AXES = ['X', 'Y', 'Z'] as const;
/** Radius of the free-rotate ring, CSS px: clear of the axis letters at the arrows' tips. */
const RING_R = ARM_PX + 30;
/** Segments of a drawn rotation arc. */
const ARC_STEPS = 18;
/** Angle (radians) the drawn arc stops short of each end, so its arrowheads clear the move arrows' shafts there. */
const ARC_INSET = 0.32;
/** The gap between the centre square and the arrows' shafts, CSS px. */
const SHAFT_GAP = 11;
/** Move arrowhead length and half width, CSS px. */
const HEAD_LEN = 15;
const HEAD_HALF = 6.5;
/** Rotation arc arrowhead length and half width, CSS px. */
const TIP_LEN = 9;
const TIP_HALF = 5;
/** Distance from an arrow's tip to the centre of its axis letter, CSS px. */
const LABEL_GAP = 13;
const r1 = (v: number) => Math.round(v * 10) / 10;
type Pt = { x: number; y: number };
/** SVG points of a triangle with its point at `p`, pointing along the unit `u`. */
const triangle = (p: Pt, u: Pt, len: number, half: number) => {
  const bx = p.x - u.x * len;
  const by = p.y - u.y * len;
  return `${r1(p.x)},${r1(p.y)} ${r1(bx - u.y * half)},${r1(by + u.x * half)} ${r1(bx + u.y * half)},${r1(by - u.x * half)}`;
};
/** Unit vector from `a` to `b` (null when they coincide). */
const toward = (a: Pt, b: Pt): Pt | null => {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  return len < 1e-3 ? null : { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
};

/** The gesture in progress; `from`: the values it changes (move values or rotations) at its press, so the readout names the ones that change. */
type Active = { action: GizmoAction; axis: Axis | null; kind: 'move' | 'rotate' | 'free'; from: Vec3 };

export function Gizmo3D({ comp, target, stage }: { comp: Comp; target: Gizmo3DTarget; stage: StageMap }) {
  const t = useT();
  const [hover, setHover] = useState<GizmoAction | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const view = gizmoView(comp, target, stage);
  if (!view) return null;
  const { c } = view;
  const end = () => setActive(null);
  const step = `${target.step} ${target.unit}`;
  /** Client px → stage px (the overlay's offset on the page, read at the press: the page is laid out by then). */
  const toStage = (x: number, y: number) => {
    const pc = stage.client(view.at);
    return { x: x - pc.x + c.x, y: y - pc.y + c.y };
  };
  const hovered = (action: GizmoAction) => ({ onPointerEnter: () => setHover(action), onPointerLeave: () => setHover((h) => (h === action ? null : h)) });
  /** Class of a handle's group: lit while dragged ('active') or hovered ('hot'). */
  const lit = (action: GizmoAction, dragged: boolean) => (dragged ? 'active' : !active && hover === action ? 'hot' : '');
  const unit = (v: number) => `${r1(v)} ${target.unit}`;
  const deg = (v: number) => `${r1(v)}°`;
  const now = active?.kind === 'move' ? target.pos : target.rot;
  const readout = !active
    ? hover && t(hover)
    : t(active.action) + AXES.flatMap((a, i) => (Math.abs(now[i] - active.from[i]) > 0.05 ? [` · ${a} ${active.kind === 'move' ? unit(now[i]) : deg(now[i])}`] : [])).join('');
  const guide = active?.kind === 'move' && active.axis !== null ? view.arms[active.axis].arm : null;
  const guideLen = guide ? Math.hypot(guide.x, guide.y) || 1 : 1;
  const arrows = view.arms.map(({ arm }, i) => {
    const len = Math.hypot(arm.x, arm.y) || 1;
    const u = { x: arm.x / len, y: arm.y / len };
    const tip = { x: c.x + arm.x, y: c.y + arm.y };
    // Arrowhead: its point at the tip; the shaft from just outside the centre square.
    const base = { x: tip.x - u.x * HEAD_LEN, y: tip.y - u.y * HEAD_LEN };
    return {
      axis: i as Axis,
      action: MOVE_ACTIONS[i],
      tip,
      base,
      from: { x: c.x + u.x * Math.min(SHAFT_GAP, len / 2), y: c.y + u.y * Math.min(SHAFT_GAP, len / 2) },
      // The shaft takes presses beyond the arcs (drawn at 0.6 of the arm) only, so both stay grabbable where they cross.
      grab: { x: c.x + arm.x * 0.74, y: c.y + arm.y * 0.74 },
      head: triangle(tip, u, HEAD_LEN, HEAD_HALF),
      label: { x: tip.x + u.x * LABEL_GAP, y: tip.y + u.y * LABEL_GAP },
    };
  });
  const startMove = (e: React.PointerEvent, axis: Axis | null) => {
    setActive({ action: axis === null ? 'Move' : MOVE_ACTIONS[axis], axis, kind: 'move', from: target.pos });
    startGizmoMove(e, target, view, axis, end);
  };
  return (
    <g className={`gz3 ${active ? 'dragging' : ''}`}>
      {guide && (
        <line
          className={`gz3-guide ax${active!.axis}`}
          x1={c.x - (guide.x / guideLen) * 4000}
          y1={c.y - (guide.y / guideLen) * 4000}
          x2={c.x + (guide.x / guideLen) * 4000}
          y2={c.y + (guide.y / guideLen) * 4000}
        />
      )}
      <g {...hovered('Free rotate')} className={lit('Free rotate', active?.kind === 'free')}>
        <Handle
          x={c.x}
          y={c.y}
          cursor={ROTATE_CURSOR}
          title={t('Free rotate: drag to turn it like a trackball (Shift: 15° steps; or ⌥-drag the object)')}
          hit={<circle className="hit stroke ring" cx={c.x} cy={c.y} r={RING_R} />}
          onDown={(e) => {
            setActive({ action: 'Free rotate', axis: null, kind: 'free', from: target.rot });
            startFreeRotate(e, target, comp, end, end);
          }}
        >
          <circle className="gz3-halo gz3-ring" cx={c.x} cy={c.y} r={RING_R} />
          <circle className="gz3-ring" cx={c.x} cy={c.y} r={RING_R} />
        </Handle>
      </g>
      {view.arcs.map((arc, i) => {
        const axis = i as Axis;
        /** The arc's points from angle `from` to `to` (radians), and their SVG path. */
        const span = (from: number, to: number) => {
          const pts = Array.from({ length: ARC_STEPS + 1 }, (_, j) => arcPoint(c, arc, from + (j / ARC_STEPS) * (to - from)));
          return { pts, d: `M ${pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ')}` };
        };
        const { d } = span(0, Math.PI / 2);
        // Drawn arc: the quarter less ARC_INSET at each end, an arrowhead beyond each end along it.
        const th0 = ARC_INSET;
        const th1 = Math.PI / 2 - ARC_INSET;
        const { pts: shown, d: drawn } = span(th0, th1);
        const ends = [
          [shown[0], toward(arcPoint(c, arc, th0 + 0.02), shown[0])],
          [shown[ARC_STEPS], toward(arcPoint(c, arc, th1 - 0.02), shown[ARC_STEPS])],
        ] as const;
        const tips = ends.flatMap(([p, u]) => (u ? [triangle({ x: p.x + u.x * TIP_LEN, y: p.y + u.y * TIP_LEN }, u, TIP_LEN, TIP_HALF)] : []));
        const action = ROTATE_ACTIONS[axis];
        return (
          <g key={`arc${i}`} {...hovered(action)} className={`ax${i} ${lit(action, active?.kind === 'rotate' && active.axis === axis)}`}>
            <Handle
              x={c.x}
              y={c.y}
              cursor={ROTATE_CURSOR}
              title={t('Rotate about {axis}: drag along the arc (Shift: 15° steps)', { axis: AXES[i] })}
              hit={<path className="hit stroke" d={d} />}
              onDown={(e) => {
                setActive({ action, axis, kind: 'rotate', from: target.rot });
                startGizmoRotate(e, target, view, axis, toStage, end);
              }}
            >
              <path className="gz3-halo gz3-arc" d={drawn} />
              {tips.map((p, j) => (
                <polygon key={j} className="gz3-halo gz3-tip" points={p} />
              ))}
              <path className="gz3-arc" d={drawn} />
              {tips.map((p, j) => (
                <polygon key={j} className="gz3-tip" points={p} />
              ))}
            </Handle>
          </g>
        );
      })}
      {arrows.map(({ axis, action, grab, from, base, head }) => (
        // Shafts first, then every head above the shafts and arcs.
        <g key={`shaft${axis}`} {...hovered(action)} className={`ax${axis} ${lit(action, active?.kind === 'move' && active.axis === axis)}`}>
          <Handle
            x={c.x}
            y={c.y}
            cursor="move"
            title={t('Move along {axis} (Shift: {step} steps)', { axis: AXES[axis], step })}
            hit={<line className="hit stroke" x1={grab.x} y1={grab.y} x2={base.x} y2={base.y} />}
            onDown={(e) => startMove(e, axis)}
          >
            <line className="gz3-halo gz3-shaft" x1={from.x} y1={from.y} x2={base.x} y2={base.y} />
            <polygon className="gz3-halo gz3-head" points={head} />
            <line className="gz3-shaft" x1={from.x} y1={from.y} x2={base.x} y2={base.y} />
          </Handle>
        </g>
      ))}
      {arrows.map(({ axis, action, tip, head, label }) => (
        <g key={`head${axis}`} {...hovered(action)} className={`ax${axis} ${lit(action, active?.kind === 'move' && active.axis === axis)}`}>
          <Handle
            x={tip.x}
            y={tip.y}
            cursor="move"
            title={t('Move along {axis} (Shift: {step} steps)', { axis: AXES[axis], step })}
            hit={<polygon className="hit head" points={head} />}
            onDown={(e) => startMove(e, axis)}
          >
            <polygon className="gz3-head" points={head} />
            <circle className="gz3-badge" cx={label.x} cy={label.y} r={7.5} />
            <text className="gz3-label" x={label.x} y={label.y} textAnchor="middle" dominantBaseline="central">
              {AXES[axis]}
            </text>
          </Handle>
        </g>
      ))}
      <g {...hovered('Move')} className={lit('Move', active?.kind === 'move' && active.axis === null)}>
        <Handle x={c.x} y={c.y} cursor="move" title={t('Move in the screen plane (Shift: {step} steps)', { step })} onDown={(e) => startMove(e, null)}>
          <rect className="gz3-centre" x={c.x - 6} y={c.y - 6} width={12} height={12} rx={2} />
        </Handle>
      </g>
      {readout && (
        <text className="gz3-readout" x={c.x} y={c.y + RING_R + 18} textAnchor="middle">
          {readout}
        </text>
      )}
    </g>
  );
}
