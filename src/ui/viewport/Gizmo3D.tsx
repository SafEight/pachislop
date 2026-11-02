import { useState } from 'react';
import type { Comp } from '../../model/types';
import { useT } from '../i18n';
import type { StageMap } from './drag';
import { ARM_PX, MOVE_ACTIONS, ROTATE_ACTIONS, arcPoint, gizmoView, startFreeRotate, startGizmoMove, startGizmoRotate, type Axis, type GizmoAction, type Gizmo3DTarget } from './gizmoEdit';
import { Handle, ROTATE_CURSOR } from './Handle';

// The 3D gizmo of a selected 3D layer (Move tool) and of the picked glyphs of a 3D text
// (Per-letter tool), the same for both (gizmoEdit.ts holds the targets and gestures). Fixed
// on-screen size, centred on the pivot, X red / Y green / Z blue:
// - move arrows along each axis, drawn through the gizmo's oblique view (gizmoEdit.ts: the true
//   projection plus half the depth down-left), and a centre square that moves in the screen plane;
// - one quarter of each rotation's gimbal ring, between two axes of its frame: dragging along
//   it turns the object as far as the hand sweeps, all the way round;
// - a thin ring around it all: free rotate, a trackball (like ⌥-drag on the object).
// Hover names the action; a drag shows its axis and value.

const AXES = ['X', 'Y', 'Z'] as const;
/** Radius of the free-rotate ring, CSS px. */
const RING_R = ARM_PX + 20;
/** Segments of a drawn rotation arc. */
const ARC_STEPS = 18;
/** The gap between the centre square and the arrows' shafts, CSS px. */
const SHAFT_GAP = 10;
const r1 = (v: number) => Math.round(v * 10) / 10;

type Active = { action: GizmoAction; axis: Axis | null; kind: 'move' | 'rotate' | 'free' };

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
  const readout = !active
    ? hover && t(hover)
    : active.kind === 'free'
      ? `${t(active.action)} · X ${deg(target.rot[0])} · Y ${deg(target.rot[1])} · Z ${deg(target.rot[2])}`
      : active.kind === 'rotate'
        ? `${t(active.action)} · ${deg(target.rot[active.axis!])}`
        : active.axis === null
          ? `${t(active.action)} · X ${unit(target.pos[0])} · Y ${unit(target.pos[1])} · Z ${unit(target.pos[2])}`
          : `${t(active.action)} · ${unit(target.pos[active.axis])}`;
  const guide = active?.kind === 'move' && active.axis !== null ? view.arms[active.axis].arm : null;
  const guideLen = guide ? Math.hypot(guide.x, guide.y) || 1 : 1;
  const arrows = view.arms.map(({ arm }, i) => {
    const len = Math.hypot(arm.x, arm.y) || 1;
    const ux = arm.x / len;
    const uy = arm.y / len;
    const tip = { x: c.x + arm.x, y: c.y + arm.y };
    // Arrowhead: 11 px long, 9 px wide, its point at the tip; the shaft from just outside the centre square.
    const base = { x: tip.x - ux * 11, y: tip.y - uy * 11 };
    return {
      axis: i as Axis,
      action: MOVE_ACTIONS[i],
      tip,
      base,
      from: { x: c.x + ux * Math.min(SHAFT_GAP, len / 2), y: c.y + uy * Math.min(SHAFT_GAP, len / 2) },
      // The shaft takes presses beyond the arcs (drawn at 0.6 of the arm) only, so both stay grabbable where they cross.
      grab: { x: c.x + arm.x * 0.74, y: c.y + arm.y * 0.74 },
      head: `${tip.x},${tip.y} ${base.x - uy * 4.5},${base.y + ux * 4.5} ${base.x + uy * 4.5},${base.y - ux * 4.5}`,
      label: { x: tip.x + ux * 10, y: tip.y + uy * 10 },
    };
  });
  const startMove = (e: React.PointerEvent, axis: Axis | null) => {
    setActive({ action: axis === null ? 'Move' : MOVE_ACTIONS[axis], axis, kind: 'move' });
    startGizmoMove(e, target, view, axis, end);
  };
  return (
    <g className={`gz3 ${active ? 'dragging' : ''}`}>
      <defs>
        {AXES.map((_, i) => (
          <marker key={i} id={`gz3-tip-${i}`} className={`ax${i}`} viewBox="0 0 10 10" refX={5} refY={5} markerWidth={3.5} markerHeight={3.5} orient="auto-start-reverse">
            <path className="gz3-tip" d="M0,0 L10,5 L0,10 z" />
          </marker>
        ))}
      </defs>
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
            setActive({ action: 'Free rotate', axis: null, kind: 'free' });
            startFreeRotate(e, target, comp, end, end);
          }}
        >
          <circle className="gz3-ring" cx={c.x} cy={c.y} r={RING_R} />
        </Handle>
      </g>
      {view.arcs.map((arc, i) => {
        const axis = i as Axis;
        const pts = Array.from({ length: ARC_STEPS + 1 }, (_, j) => arcPoint(c, arc, (j / ARC_STEPS) * (Math.PI / 2)));
        const d = `M ${pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ')}`;
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
                setActive({ action, axis, kind: 'rotate' });
                startGizmoRotate(e, target, view, axis, toStage, end);
              }}
            >
              <path className="gz3-arc" d={d} markerStart={`url(#gz3-tip-${i})`} markerEnd={`url(#gz3-tip-${i})`} />
            </Handle>
          </g>
        );
      })}
      {arrows.map(({ axis, action, grab, from, base }) => (
        // Shafts first: where arrows overlap on screen (two axes pointing alike), every head stays on top.
        <g key={`shaft${axis}`} {...hovered(action)} className={`ax${axis} ${lit(action, active?.kind === 'move' && active.axis === axis)}`}>
          <Handle
            x={c.x}
            y={c.y}
            cursor="move"
            title={t('Move along {axis} (Shift: {step} steps)', { axis: AXES[axis], step })}
            hit={<line className="hit stroke" x1={grab.x} y1={grab.y} x2={base.x} y2={base.y} />}
            onDown={(e) => startMove(e, axis)}
          >
            <line className="gz3-shaft" x1={from.x} y1={from.y} x2={base.x} y2={base.y} />
          </Handle>
        </g>
      ))}
      {/* Longer arrows' heads last: where heads overlap, each keeps its own point. */}
      {arrows.toSorted((a, b) => Math.hypot(a.tip.x - c.x, a.tip.y - c.y) - Math.hypot(b.tip.x - c.x, b.tip.y - c.y)).map(({ axis, action, tip, head, label }) => (
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
            <text className="gz3-label" x={label.x} y={label.y + 4} textAnchor="middle">
              {AXES[axis]}
            </text>
          </Handle>
        </g>
      ))}
      <g {...hovered('Move')} className={lit('Move', active?.kind === 'move' && active.axis === null)}>
        <Handle x={c.x} y={c.y} cursor="move" title={t('Move in the screen plane (Shift: {step} steps)', { step })} onDown={(e) => startMove(e, null)}>
          <rect className="gz3-centre" x={c.x - 5} y={c.y - 5} width={10} height={10} />
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
