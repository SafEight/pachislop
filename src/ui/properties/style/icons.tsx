import { useId } from 'react';
import { curveFn, GLOSS_FN, PROFILE_2D_FN } from '../../../engine/layer2d/contours';
import type { BevelProfile2D, BevelProfile3D, Curve, FillKind, GlossContour, PlateShape } from '../../../model/types';

// Tiny SVG glyphs for the bevel profile / gloss contour / fill kind pickers (Photoshop / Eye
// Candy style). 2D profiles and contours use the renderer's own functions (contours.ts).

const W = 20;
const H = 14;
const SAMPLES = 24;

/** The function an icon draws: a preset, or the custom curve when given 'custom'. */
function profileFn(profile: BevelProfile2D, curve?: Curve): (t: number) => number {
  if (profile !== 'custom') return PROFILE_2D_FN[profile];
  return curve ? curveFn(curve) : (t) => t;
}
function glossFn(contour: GlossContour, curve?: Curve): (x: number) => number {
  if (contour !== 'custom') return GLOSS_FN[contour];
  return curve ? curveFn(curve) : (x) => x;
}

/**
 * 3D band cross-section points [o, h] as in the extruder: o 0 = inner edge → 1 = outer edge,
 * h = drop in z as a fraction of the band depth (negative = rises toward the viewer).
 */
function profile3D(p: BevelProfile3D): [number, number][] {
  const arc = (f: (u: number) => [number, number]) => Array.from({ length: 9 }, (_, k) => f(((k / 8) * Math.PI) / 2));
  switch (p) {
    case 'flat':
      return [
        [0, 0],
        [1, 0],
        [1, 1],
      ];
    case 'round':
      return arc((u) => [Math.sin(u), 1 - Math.cos(u)]);
    case 'chamfer':
      return [
        [0, 0],
        [1, 1],
      ];
    case 'cove':
      return arc((u) => [1 - Math.cos(u), Math.sin(u)]);
    case 'step':
      return [
        [0, 0],
        [0.15, 0.5],
        [0.5, 0.5],
        [0.65, 1],
        [1, 1],
      ];
    case 'inset':
      return [
        [0, 0],
        [0.4, -1],
        [1, -1],
      ];
    case 'tube':
      return Array.from({ length: 17 }, (_, k): [number, number] => [(1 - Math.cos((k / 16) * Math.PI)) / 2, -Math.sin((k / 16) * Math.PI)]);
  }
}

const pts = (list: [number, number][]) => list.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');

/** Half cross-section of a bevelled 2D element: edge on the left rising to the plateau. */
export function Profile2DIcon({ profile, curve }: { profile: BevelProfile2D; curve?: Curve }) {
  const f = profileFn(profile, curve);
  const x0 = 1;
  const x1 = 13;
  const pts2 = Array.from({ length: SAMPLES * 2 + 1 }, (_, i): [number, number] => {
    const t = i / (SAMPLES * 2);
    return [x0 + t * (x1 - x0), H - 1 - f(t) * (H - 4)];
  });
  return (
    <svg className="sty-icon" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden>
      <polygon points={pts([[x0, H - 1], ...pts2, [W - 1, pts2[pts2.length - 1][1]], [W - 1, H - 1]])} />
      {profile === 'custom' && <CurveDots curve={curve} map={(x, y) => [x0 + x * (x1 - x0), H - 1 - y * (H - 4)]} />}
    </svg>
  );
}

/** Contour curve (input → output) in a small framed square. */
export function ContourIcon({ contour, curve }: { contour: GlossContour; curve?: Curve }) {
  const f = glossFn(contour, curve);
  const s = H - 2;
  const line = Array.from({ length: SAMPLES * 2 + 1 }, (_, i): [number, number] => {
    const x = i / (SAMPLES * 2);
    return [4 + x * s, 1 + (1 - f(x)) * s];
  });
  return (
    <svg className="sty-icon" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden>
      <rect className="frame" x={4} y={1} width={s} height={s} />
      <polyline className="curve" points={pts(line)} />
      {contour === 'custom' && <CurveDots curve={curve} map={(x, y) => [4 + x * s, 1 + (1 - y) * s]} />}
    </svg>
  );
}

/** Point markers that tell a custom curve's icon apart from the presets. */
function CurveDots({ curve, map }: { curve?: Curve; map: (x: number, y: number) => [number, number] }) {
  if (!curve) return null;
  return curve.points.map((p, i) => {
    const [cx, cy] = map(p.x, p.y);
    return <circle key={i} cx={cx} cy={cy} r={1.4} fill="var(--accent)" />;
  });
}

/** Fill type swatch: stop 0 = full ink, stop 1 = faint, laid out like the renderer's mapping. */
export function FillKindIcon({ kind }: { kind: FillKind }) {
  const id = useId();
  const ink = (o: number) => ({ stopColor: 'currentColor', stopOpacity: o });
  let body;
  switch (kind) {
    case 'solid':
      body = <rect x={1} y={1} width={W - 2} height={H - 2} fill="currentColor" />;
      break;
    case 'linear':
    case 'reflected':
      body = (
        <>
          <defs>
            <linearGradient id={id}>
              {kind === 'reflected' && <stop offset="0" style={ink(0.15)} />}
              <stop offset={kind === 'reflected' ? '0.5' : '0'} style={ink(1)} />
              <stop offset="1" style={ink(0.15)} />
            </linearGradient>
          </defs>
          <rect x={1} y={1} width={W - 2} height={H - 2} fill={`url(#${id})`} />
        </>
      );
      break;
    case 'radial':
      body = (
        <>
          <defs>
            <radialGradient id={id}>
              <stop offset="0" style={ink(1)} />
              <stop offset="1" style={ink(0.15)} />
            </radialGradient>
          </defs>
          <rect x={1} y={1} width={W - 2} height={H - 2} fill={`url(#${id})`} />
        </>
      );
      break;
    case 'angle': {
      // Clockwise sweep from 3 o'clock in 12 wedges, fading like the ramp.
      const n = 12;
      const cx = W / 2;
      const cy = H / 2;
      const r = 9;
      body = (
        <>
          <clipPath id={id}>
            <rect x={1} y={1} width={W - 2} height={H - 2} />
          </clipPath>
          <g clipPath={`url(#${id})`}>
            {Array.from({ length: n }, (_, i) => {
              const a0 = (i / n) * 2 * Math.PI;
              const a1 = ((i + 1) / n) * 2 * Math.PI + 0.02;
              const p = (a: number) => `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
              return <path key={i} d={`M${cx},${cy} L${p(a0)} L${p(a1)} Z`} fill="currentColor" fillOpacity={1 - 0.85 * (i / (n - 1))} />;
            })}
          </g>
        </>
      );
      break;
    }
    case 'diamond':
      body = [1, 0.75, 0.5, 0.25].map((k, i) => (
        <polygon
          key={i}
          points={pts([
            [W / 2, H / 2 - k * 6],
            [W / 2 + k * 9, H / 2],
            [W / 2, H / 2 + k * 6],
            [W / 2 - k * 9, H / 2],
          ])}
          style={{ opacity: 1 }}
          fill="currentColor"
          fillOpacity={0.15 + 0.28 * i}
        />
      ));
      break;
    case 'shapeBurst':
      // Insets of a letter-ish outline: faint at the edge, full ink at the deepest point.
      body = [0, 1.5, 3, 4.5].map((k, i) => (
        <rect key={i} x={1 + k} y={1 + k * 0.7} width={W - 2 - 2 * k} height={H - 2 - 1.4 * k} rx={2} fill="currentColor" fillOpacity={0.15 + 0.28 * i} />
      ));
      break;
    case 'image':
      // A picture: frame, sun and mountains.
      body = (
        <>
          <rect x={1.5} y={1.5} width={W - 3} height={H - 3} fill="none" stroke="currentColor" strokeOpacity={0.6} />
          <circle cx={6} cy={5} r={1.6} fill="currentColor" />
          <path d={`M2,${H - 2} L8,6 L11,9 L14,5.5 L${W - 2},${H - 2} Z`} fill="currentColor" fillOpacity={0.75} />
        </>
      );
      break;
  }
  return (
    <svg className="sty-icon" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden>
      {body}
    </svg>
  );
}

/** Plate base kind: the outline hugging two letters, their convex hull, or a slanted chamfered box. */
export function PlateIcon({ kind }: { kind: PlateShape['kind'] }) {
  const letters = 'M3,11 L3,3 L8,3 L8,6 L6,6 L6,11 Z M10,11 L10,5 L17,5 L17,11 L14,11 L14,8 L13,8 L13,11 Z';
  const plate =
    kind === 'contour'
      ? 'M1.5,12.5 L1.5,1.5 L9.5,1.5 L9.5,3.5 L18.5,3.5 L18.5,12.5 Z'
      : kind === 'hull'
        ? 'M1.5,12.5 L1.5,1.5 L9.5,1.5 L18.5,3.5 L18.5,12.5 Z'
        : 'M3.5,12.5 L1,9 L3,1.5 L17,1.5 L19,5 L17,12.5 Z';
  return (
    <svg className="sty-icon" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden>
      <path d={plate} fill="currentColor" fillOpacity={0.35} stroke="currentColor" strokeWidth={0.8} strokeLinejoin="round" />
      <path d={letters} fill="currentColor" />
    </svg>
  );
}

/** Corner cross-section of the extrusion: face plane on the left, band profile, side wall on the right. */
export function Profile3DIcon({ profile }: { profile: BevelProfile3D }) {
  const raw = profile3D(profile);
  const hs = raw.map(([, h]) => h);
  const minH = Math.min(...hs);
  const span = Math.max(...hs) - minH || 1;
  const curve = raw.map(([o, h]): [number, number] => [5 + o * 10, 2 + ((h - minH) / span) * 8]);
  const wallX = curve[curve.length - 1][0];
  return (
    <svg className="sty-icon" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden>
      <polygon points={pts([[1, curve[0][1]], ...curve, [wallX, H - 1], [1, H - 1]])} />
    </svg>
  );
}

/** Two chain links: a linked material (Material2D.link / Material3D.link). */
export function LinkIcon() {
  return (
    <svg className="link-icon" viewBox="0 0 12 12" width={11} height={11} aria-hidden>
      <path d="M5,3.5 L6.5,2 a2.1,2.1 0 0 1 3,3 L8,6.5 M7,8.5 L5.5,10 a2.1,2.1 0 0 1 -3,-3 L4,5.5 M4.4,7.6 L7.6,4.4" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" />
    </svg>
  );
}
