import type { Comp } from '../../model/types';
import { useEditor } from '../../store/store';
import { useT } from '../i18n';
import { oneShot } from '../util';
import { drag } from './drag';
import type { Pt } from './geometry';
import { Handle } from './Handle';

// Photoshop Global Light on the canvas (Light tool): a small dial beside the selected layer, or
// at the comp's top-right corner. The knob sits where the light comes FROM (angle, degrees CCW
// from +x) and nearer the centre the higher the light (altitude 90° = centre, like Photoshop's
// light sphere). Drag sets the angle, ⇧-drag the altitude; Shift is the only way to change
// altitude so a sweep never tips it by accident.

/** Dial radius, CSS px. */
const R = 26;
const DEG = Math.PI / 180;

/** `at`: overlay px of the layer's top-right corner (or a point inside the comp's); the dial sits just up-right of it. */
export function LightDial({ comp, at }: { comp: Comp; at: Pt }) {
  const t = useT();
  const { angle, altitude } = comp.globalLight;
  const c = { x: at.x + R + 10, y: at.y - R - 10 };
  const rr = R * Math.cos(altitude * DEG);
  const knob = { x: c.x + Math.cos(angle * DEG) * rr, y: c.y - Math.sin(angle * DEG) * rr };
  const ref = (k: 'angle' | 'altitude') => ({ layerId: null, path: ['comp', 'globalLight', k] });
  const start = (e: React.PointerEvent) => {
    const key = oneShot('global-light');
    const svg = (e.currentTarget as Element).closest('svg');
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    drag(e, (ev) => {
      const dx = ev.clientX - r.left - c.x;
      const dy = -(ev.clientY - r.top - c.y);
      const { setAt } = useEditor.getState();
      if (ev.shiftKey) {
        const alt = Math.acos(Math.min(1, Math.hypot(dx, dy) / R)) / DEG;
        setAt(ref('altitude'), Math.round(Math.max(0, Math.min(90, alt))), key, 'Global light altitude');
        return;
      }
      if (Math.hypot(dx, dy) < 2) return;
      setAt(ref('angle'), Math.round(Math.atan2(dy, dx) / DEG), key, 'Global light angle');
    });
  };
  return (
    <g className="light-dial">
      <circle className="light-dial-ring" cx={c.x} cy={c.y} r={R} />
      <line className="light-dial-ray" x1={c.x} y1={c.y} x2={knob.x} y2={knob.y} />
      <circle className="light-dial-centre" cx={c.x} cy={c.y} r={2} />
      <Handle
        x={knob.x}
        y={knob.y}
        cursor="crosshair"
        className="light-h"
        title={t('Global light {angle}° · altitude {altitude}°: drag to aim (⇧-drag: altitude, centre = overhead)', { angle, altitude })}
        onDown={start}
      >
        <circle className="handle light" cx={knob.x} cy={knob.y} r={6} />
      </Handle>
      <text className="light-dial-label" x={c.x} y={c.y - R - 6} textAnchor="middle">
        ☀ {angle}° / {altitude}°
      </text>
    </g>
  );
}
