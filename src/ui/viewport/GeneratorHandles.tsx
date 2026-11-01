import type { CSSProperties } from 'react';
import type { GeneratorDef } from '../../engine/contracts';
import { followTarget, getGenerator } from '../../generators/registry';
import type { Comp, GeneratorLayer } from '../../model/types';
import { useEditor, type PropRef } from '../../store/store';
import { useT } from '../i18n';
import { oneShot } from '../util';
import { drag, type StageMap } from './drag';
import { layerView, type Pt } from './geometry';
import { ARROW_PX, Handle, SNAP_PX } from './Handle';
import { clampTo, numParam, whenOk, wrapAngle } from './params';

// On-canvas handles of the selected generator layer's def (GeneratorDef handles / directions /
// sizes). Their params are in LAYER space (origin at the layer position, +y up, before the
// layer's rotZ / scale), so everything is drawn and dragged through the layer transform.

const DEG = Math.PI / 180;
/** Segments of a drawn size ellipse. */
const ELLIPSE_SEGMENTS = 72;

type SizeSpec = NonNullable<GeneratorDef['sizes']>[number];
type DirSpec = NonNullable<GeneratorDef['directions']>[number];
type Side = 'r' | 'l' | 't' | 'b';

const SIDES: { side: Side; axis: 'x' | 'y'; sx: number; sy: number }[] = [
  { side: 'r', axis: 'x', sx: 1, sy: 0 },
  { side: 'l', axis: 'x', sx: -1, sy: 0 },
  { side: 't', axis: 'y', sx: 0, sy: 1 },
  { side: 'b', axis: 'y', sx: 0, sy: -1 },
];

/** The resize cursor along the screen direction from → to. */
function resizeCursor(from: Pt, to: Pt): CSSProperties['cursor'] {
  const a = Math.atan2(to.y - from.y, to.x - from.x) / DEG;
  return (['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'] as const)[Math.round((((a % 180) + 180) % 180) / 45) % 4];
}

export function GeneratorHandles({ comp, layer, stage }: { comp: Comp; layer: GeneratorLayer; stage: StageMap }) {
  const t = useT();
  const def = getGenerator(layer.generator.type);
  if (!def) return null;
  const { setAt } = useEditor.getState();
  const values = layer.generator.params;
  const view = layerView(comp, layer);
  const P = (q: Pt) => stage.S(view.toComp(q));
  const at = (ev: { clientX: number; clientY: number }) => view.fromComp(stage.toComp(ev.clientX, ev.clientY));
  const ref = (key: string): PropRef => ({ layerId: layer.id, path: ['generator', 'params', key] });
  const num = (key: string) => numParam(def.params, values, key);
  /** Screen px per layer px. */
  const k = stage.d * (Math.abs(layer.transform.scale) || 1e-6);

  // Following a layer, its positions are relative to that layer: no point or size handles.
  const following = followTarget(layer.generator) !== '';
  const points = following ? [] : (def.handles ?? []).filter((h) => whenOk(def.params, values, h.when));
  const startPoint = (e: React.PointerEvent, h: { x: string; y: string }) => {
    const key = oneShot(`genh:${layer.id}`);
    const px = num(h.x).pd;
    const py = num(h.y).pd;
    drag(e, (ev) => {
      let q = at(ev);
      if (!q) return;
      // Shift snaps each axis to the layer origin.
      if (ev.shiftKey) q = { x: Math.abs(q.x) * k < SNAP_PX ? 0 : q.x, y: Math.abs(q.y) * k < SNAP_PX ? 0 : q.y };
      setAt(ref(h.x), Math.round(clampTo(px, q.x)), key);
      setAt(ref(h.y), Math.round(clampTo(py, q.y)), key);
    });
  };

  const arrows = (def.directions ?? [])
    .filter((a) => whenOk(def.params, values, a.when))
    .map((a) => {
      const ang = num(a.angle).v * DEG;
      const len = Math.max(a.length ? num(a.length).v : ARROW_PX / k, 24 / k);
      const dir = a.convention === 'cwFromRight' ? { x: Math.cos(ang), y: -Math.sin(ang) } : { x: Math.cos(ang), y: Math.sin(ang) };
      return { a, from: P({ x: 0, y: 0 }), to: P({ x: dir.x * len, y: dir.y * len }) };
    });
  const startArrow = (e: React.PointerEvent, a: DirSpec) => {
    const key = oneShot(`gend:${layer.id}`);
    const pa = num(a.angle).pd;
    const pl = a.length ? num(a.length).pd : undefined;
    drag(e, (ev) => {
      const q = at(ev);
      if (!q) return;
      let ang = Math.atan2(a.convention === 'cwFromRight' ? -q.y : q.y, q.x) / DEG;
      if (ev.shiftKey) ang = Math.round(ang / 15) * 15;
      setAt(ref(a.angle), Math.round(wrapAngle(pa, ang)), key);
      if (a.length) setAt(ref(a.length), Math.round(clampTo(pl, Math.hypot(q.x, q.y))), key);
    });
  };

  const sizes = (following ? [] : (def.sizes ?? []))
    .filter((s) => whenOk(def.params, values, s.when))
    .map((s) => {
      const c = { x: s.x ? num(s.x).v : 0, y: s.y ? num(s.y).v : 0 };
      const rx = Math.max(0, num(s.rx).v);
      const ry = s.ry ? Math.max(0, num(s.ry).v) : rx;
      const outline =
        s.shape === 'box'
          ? [P({ x: c.x - rx, y: c.y + ry }), P({ x: c.x + rx, y: c.y + ry }), P({ x: c.x + rx, y: c.y - ry }), P({ x: c.x - rx, y: c.y - ry })]
          : Array.from({ length: ELLIPSE_SEGMENTS }, (_, i) => {
              const u = (i / ELLIPSE_SEGMENTS) * 2 * Math.PI;
              return P({ x: c.x + rx * Math.cos(u), y: c.y + ry * Math.sin(u) });
            });
      const centre = P(c);
      const sides = SIDES.map((sd) => ({ ...sd, q: P({ x: c.x + sd.sx * rx, y: c.y + sd.sy * ry }) }));
      return { s, c, outline, centre, sides };
    });
  const startSize = (e: React.PointerEvent, s: SizeSpec, c: Pt, axis: 'x' | 'y') => {
    const key = oneShot(`gens:${layer.id}`);
    const prx = num(s.rx).pd;
    const pry = s.ry ? num(s.ry).pd : undefined;
    const rx0 = num(s.rx).v;
    const ry0 = s.ry ? num(s.ry).v : rx0;
    drag(e, (ev) => {
      const q = at(ev);
      if (!q) return;
      const r = Math.abs(axis === 'x' ? q.x - c.x : q.y - c.y);
      if (!s.ry) {
        setAt(ref(s.rx), Math.round(clampTo(prx, r)), key);
        return;
      }
      const r0 = axis === 'x' ? rx0 : ry0;
      if (ev.shiftKey && rx0 > 0 && ry0 > 0 && r0 > 0) {
        // Shift keeps the proportions of the press.
        setAt(ref(s.rx), Math.round(clampTo(prx, (rx0 * r) / r0)), key);
        setAt(ref(s.ry), Math.round(clampTo(pry, (ry0 * r) / r0)), key);
        return;
      }
      if (axis === 'x') setAt(ref(s.rx), Math.round(clampTo(prx, r)), key);
      else setAt(ref(s.ry), Math.round(clampTo(pry, r)), key);
    });
  };

  return (
    <g className="gen-handles">
      {sizes.map(({ s, c, outline, centre, sides }) => (
        <g key={s.rx} className="gen-size">
          <polygon className="gen-size-outline" points={outline.map((q) => `${q.x},${q.y}`).join(' ')} />
          {sides.map((sd) => (
            <Handle
              key={sd.side}
              x={sd.q.x}
              y={sd.q.y}
              cursor={resizeCursor(centre, sd.q)}
              title={s.ry ? t('{label}: drag to resize (Shift: keep proportions)', { label: t(s.label) }) : t('{label}: drag to set the radius', { label: t(s.label) })}
              onDown={(e) => startSize(e, s, c, sd.axis)}
            >
              <rect className="handle size" x={sd.q.x - 4.5} y={sd.q.y - 4.5} width={9} height={9} />
            </Handle>
          ))}
          <text x={sides[0].q.x + 10} y={sides[0].q.y - 8}>
            {t(s.label)}
          </text>
        </g>
      ))}
      {arrows.map(({ a, from, to }) => (
        <g key={a.angle} className="fx-arrow">
          <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
          <Handle
            x={to.x}
            y={to.y}
            cursor="move"
            title={a.length ? t('{label}: drag to set direction and distance (Shift: 15°)', { label: t(a.label) }) : t('{label}: drag to set direction (Shift: 15°)', { label: t(a.label) })}
            onDown={(e) => startArrow(e, a)}
          >
            <circle className="handle dir" cx={to.x} cy={to.y} r={7} />
          </Handle>
          <text x={to.x + 10} y={to.y - 8}>
            {t(a.label)}
          </text>
        </g>
      ))}
      {points.map((h) => {
        const q = P({ x: num(h.x).v, y: num(h.y).v });
        return (
          <g key={h.x} className="fx-point">
            <Handle x={q.x} y={q.y} cursor="move" title={t('{label}: drag to move (Shift snaps to centre)', { label: t(h.label) })} onDown={(e) => startPoint(e, h)}>
              <circle className="handle pt" cx={q.x} cy={q.y} r={8} />
            </Handle>
            <line x1={q.x - 12} y1={q.y} x2={q.x + 12} y2={q.y} />
            <line x1={q.x} y1={q.y - 12} x2={q.x} y2={q.y + 12} />
            <text x={q.x + 12} y={q.y - 10}>
              {t(h.label)}
            </text>
          </g>
        );
      })}
    </g>
  );
}
