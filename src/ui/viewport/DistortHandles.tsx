import type { TitleLayer } from '../../model/parts';
import { noDistort } from '../../model/defaults';
import type { Comp, Distort, Vec2 } from '../../model/types';
import { useEditor } from '../../store/store';
import { distortFrame, distortPoint } from '../../text/ink';
import type { Bounds } from '../../text/layout';
import { useT } from '../i18n';
import { oneShot } from '../util';
import { drag, type StageMap } from './drag';
import { layerView, type Pt } from './geometry';
import { Handle } from './Handle';

// Free distort on the canvas (Photoshop Edit ▸ Transform ▸ Distort / Perspective, Kittl mesh):
// 'corners' shows the 4 frame corners, 'mesh' the 16 Bézier control points with the patch's
// lattice. Dragging writes offsets in fractions of the undistorted frame (x of its width, y of
// its height, +y up), measured in layer space so rotated / orbited layers stay exact. ⇧-drag
// also moves the mirrored point (left ↔ right) the opposite way: symmetric パース.

/** Corner order TL, TR, BR, BL → its left-right mirror. */
const CORNER_MIRROR = [1, 0, 3, 2];
/** Samples per lattice curve in mesh mode (corners mode lines are straight). */
const LATTICE_STEPS = 24;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

/** Rest position of corner `i` (TL, TR, BR, BL) or mesh point `i` (row-major from the top-left). */
function restPoint(f: Bounds, mode: 'corners' | 'mesh', i: number): Pt {
  if (mode === 'corners') return { x: i === 0 || i === 3 ? f.x0 : f.x1, y: i < 2 ? f.y1 : f.y0 };
  return { x: f.x0 + ((i % 4) / 3) * (f.x1 - f.x0), y: f.y1 - (Math.floor(i / 4) / 3) * (f.y1 - f.y0) };
}

/** Control point `i` of the distort: its rest position plus the stored offset. */
function controlPoint(f: Bounds, d: Distort, mode: 'corners' | 'mesh', i: number): Pt {
  const o = mode === 'corners' ? d.corners[i] : d.mesh[i];
  const p = restPoint(f, mode, i);
  return { x: p.x + o.x * (f.x1 - f.x0), y: p.y + o.y * (f.y1 - f.y0) };
}

export function DistortHandles({ comp, layer, stage }: { comp: Comp; layer: TitleLayer; stage: StageMap }) {
  const t = useT();
  const frame = distortFrame(layer);
  if (!frame || frame.x1 - frame.x0 < 1e-6 || frame.y1 - frame.y0 < 1e-6) return null;
  const f = frame;
  const view = layerView(comp, layer);
  const P = (p: Pt) => stage.S(view.toComp(p, 0));
  const d = layer.distort;
  // 'none' edits as corners: the first drag switches the distort on.
  const mode: 'corners' | 'mesh' = d.mode === 'mesh' ? 'mesh' : 'corners';
  const n = mode === 'corners' ? 4 : 16;
  const pts = Array.from({ length: n }, (_, i) => P(controlPoint(f, d, mode, i)));
  const w = f.x1 - f.x0;
  const h = f.y1 - f.y0;
  const ref = { layerId: layer.id, path: ['distort'] };

  const start = (e: React.PointerEvent, i: number) => {
    const key = oneShot(`distort:${layer.id}`);
    const d0: Distort = { ...d, mode };
    const p0 = view.fromComp(stage.toComp(e.clientX, e.clientY), 0);
    if (!p0) return;
    const mirror = mode === 'corners' ? CORNER_MIRROR[i] : Math.floor(i / 4) * 4 + (3 - (i % 4));
    drag(e, (ev) => {
      const p = view.fromComp(stage.toComp(ev.clientX, ev.clientY), 0);
      if (!p) return;
      const dx = (p.x - p0.x) / w;
      const dy = (p.y - p0.y) / h;
      const list: Vec2[] = [...(mode === 'corners' ? d0.corners : d0.mesh)];
      const base = list[i];
      list[i] = { x: r4(base.x + dx), y: r4(base.y + dy) };
      if (ev.shiftKey) {
        const m = (mode === 'corners' ? d0.corners : d0.mesh)[mirror];
        list[mirror] = { x: r4(m.x - dx), y: r4(m.y + dy) };
      }
      const next: Distort = mode === 'corners' ? { ...d0, corners: list as Distort['corners'] } : { ...d0, mesh: list };
      useEditor.getState().setAt(ref, next, key, mode === 'corners' ? 'Distort corner' : 'Mesh warp');
    });
  };

  // Lattice: the distorted frame's thirds (the mesh's patch lines), sampled through the forward
  // map; a projective map keeps lines straight, so corners mode needs only the end points.
  const curve = (a: Pt, b: Pt) => {
    const steps = d.mode === 'mesh' ? LATTICE_STEPS : 1;
    const out: string[] = [];
    for (let k = 0; k <= steps; k++) {
      const u = k / steps;
      const p = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
      const q = P(d.mode === 'none' ? p : distortPoint(f, d, p));
      out.push(`${q.x},${q.y}`);
    }
    return out.join(' ');
  };
  const lattice: string[] = [];
  for (let k = 0; k <= 3; k++) {
    const x = f.x0 + (k / 3) * w;
    const y = f.y0 + (k / 3) * h;
    lattice.push(curve({ x, y: f.y0 }, { x, y: f.y1 }), curve({ x: f.x0, y }, { x: f.x1, y }));
  }
  // Mesh: the Bézier control polygon (handles joined along rows and columns).
  const hull: string[] = [];
  if (mode === 'mesh')
    for (let k = 0; k < 4; k++) {
      hull.push([0, 1, 2, 3].map((c) => `${pts[k * 4 + c].x},${pts[k * 4 + c].y}`).join(' '));
      hull.push([0, 1, 2, 3].map((r) => `${pts[r * 4 + k].x},${pts[r * 4 + k].y}`).join(' '));
    }
  // Reset sits centred under the lowest point of the lattice.
  const bottom = { x: pts.reduce((s, q) => s + q.x, 0) / pts.length, y: Math.max(...pts.map((q) => q.y)) };
  const active = d.mode !== 'none';
  return (
    <g className={`distort ${mode}`}>
      {lattice.map((s, k) => (
        <polyline key={k} className={`distort-lattice ${k < 2 || k > 5 ? 'edge' : ''}`} points={s} />
      ))}
      {hull.map((s, k) => (
        <polyline key={`h${k}`} className="distort-hull" points={s} />
      ))}
      {pts.map((q, i) => (
        <Handle
          key={i}
          x={q.x}
          y={q.y}
          cursor="move"
          className="distort-h"
          title={
            mode === 'corners'
              ? t('Distort corner {n}: drag to move (⇧: mirror the opposite side for symmetric パース)', { n: i + 1 })
              : t('Distort mesh point {n}: drag to move (⇧: mirror the opposite side for symmetric パース)', { n: i + 1 })
          }
          onDown={(e) => start(e, i)}
        >
          {mode === 'corners' || [0, 3, 12, 15].includes(i) ? (
            <rect className="handle distort" x={q.x - 5} y={q.y - 5} width={10} height={10} />
          ) : (
            <circle className="handle distort inner" cx={q.x} cy={q.y} r={4.5} />
          )}
        </Handle>
      ))}
      {active && (
        <g
          className="distort-reset"
          role="button"
          aria-label={t('Reset the distort')}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            e.preventDefault();
            useEditor.getState().setAt(ref, { ...noDistort(), mode: d.mode }, undefined, 'Reset distort');
          }}
        >
          <title>{t('Reset the distort (keeps the mode)')}</title>
          <rect x={bottom.x - 24} y={bottom.y + 14} width={48} height={18} rx={3} />
          <text x={bottom.x} y={bottom.y + 27} textAnchor="middle">
            {t('Reset')}
          </text>
        </g>
      )}
    </g>
  );
}
