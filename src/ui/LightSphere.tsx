import type { KeyboardEvent } from 'react';
import { engineHost } from './engineHost';
import { useT } from './i18n';
import { useGesture } from './util';

// Eye Candy-style light-direction sphere: drag the highlight; distance from the centre sets
// the altitude/elevation (centre = 90°, rim = 0°), direction sets the angle. Arrow keys nudge:
// ←/→ turn the angle, ↑/↓ raise / lower the altitude (Shift ×10).

const DEG = Math.PI / 180;

export interface LightSphereProps {
  /** Degrees. 'ccwFromRight': 0 = right, 90 = up (Photoshop). 'cwFromRight': 0 = right, 90 = down. */
  angle: number;
  /** Degrees above the horizon, 0..90. */
  altitude: number;
  convention?: 'ccwFromRight' | 'cwFromRight';
  onChange: (angle: number, altitude: number, coalesce: string) => void;
  id: string;
  size?: number;
  /** Accessible name (screen readers), already translated; defaults to “Light direction”. */
  label?: string;
}

export function LightSphere({ angle, altitude, convention = 'ccwFromRight', onChange, id, size = 72, label }: LightSphereProps) {
  const t = useT();
  const g = useGesture(id);
  const R = size / 2 - 4;
  const sign = convention === 'ccwFromRight' ? -1 : 1; // screen y is down
  const r = Math.cos(Math.max(0, Math.min(90, altitude)) * DEG) * R;
  const lx = size / 2 + Math.cos(angle * DEG) * r;
  const ly = size / 2 + sign * Math.sin(angle * DEG) * r;

  const fromPointer = (el: HTMLElement, cx: number, cy: number, snap: boolean) => {
    const b = el.getBoundingClientRect();
    const dx = cx - (b.left + b.width / 2);
    const dy = cy - (b.top + b.height / 2);
    const d = Math.min(1, Math.hypot(dx, dy) / R);
    let a = Math.atan2(sign * dy, dx) / DEG;
    if (a < 0) a += 360;
    let alt = Math.acos(d) / DEG;
    if (snap) {
      a = Math.round(a / 15) * 15;
      alt = Math.round(alt / 5) * 5;
    }
    onChange(Math.round(a) % 360, Math.round(alt), g.key());
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 1;
    // ← / → turn the light the way the arrow points on screen at the top of the sphere
    const da = { ArrowLeft: step, ArrowRight: -step }[e.key] ?? 0;
    const dAlt = { ArrowUp: step, ArrowDown: -step }[e.key] ?? 0;
    if (!da && !dAlt) return;
    e.preventDefault();
    const a = (((Math.round(angle) + da * -sign) % 360) + 360) % 360;
    onChange(a, Math.max(0, Math.min(90, Math.round(altitude) + dAlt)), `${id}:key`);
  };

  return (
    <div className="light-sphere-wrap">
      <div
        className="light-sphere"
        role="slider"
        tabIndex={0}
        aria-label={label ?? t('Light direction')}
        aria-valuetext={t('angle {angle}°, altitude {altitude}°', { angle: Math.round(angle), altitude: Math.round(altitude) })}
        style={{
          width: size,
          height: size,
          background: `radial-gradient(circle at ${lx}px ${ly}px, #fff 0, #ffe9a8 ${R * 0.18}px, #8a7440 ${R * 0.9}px, #1b160c ${R * 1.6}px)`,
        }}
        title={t('Drag the light (Shift snaps to 15°/5°). Centre = overhead, rim = grazing. Arrow keys: ←/→ angle, ↑/↓ altitude (Shift ×10).')}
        onKeyDown={onKey}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.focus();
          g.begin();
          engineHost.setInteractive(true);
          const el = e.currentTarget;
          el.setPointerCapture(e.pointerId);
          fromPointer(el, e.clientX, e.clientY, e.shiftKey);
          const move = (ev: PointerEvent) => fromPointer(el, ev.clientX, ev.clientY, ev.shiftKey);
          const up = () => {
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
            el.removeEventListener('pointercancel', up);
            engineHost.setInteractive(false);
          };
          el.addEventListener('pointermove', move);
          el.addEventListener('pointerup', up);
          el.addEventListener('pointercancel', up);
        }}
      >
        <span className="light-dot" style={{ left: lx, top: ly }} />
      </div>
      <div className="light-readout">
        <div>
          <span className="muted">{t('Angle')}</span> {Math.round(angle)}°
        </div>
        <div>
          <span className="muted">{t('Altitude')}</span> {Math.round(altitude)}°
        </div>
      </div>
    </div>
  );
}
