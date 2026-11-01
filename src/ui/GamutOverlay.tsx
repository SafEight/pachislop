import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { BUNDLED_ICC, GAMUT_DELTA_E, gamutMask, loadGamutProfile, loadUserGamutProfile, restoreBundledGamutProfile, type GamutProfile } from '../io/gamut';
import { errorMsg, msg } from '../store/msg';
import { useEditor } from '../store/store';
import { engineHost } from './engineHost';
import { useT } from './i18n';
import { pickFile, usePopover } from './util';
import './export.css';

/** Longest side of the render the gamut mask is computed on, in px. */
const MASK_MAX = 640;
/** Quiet time after the last edit before the mask is recomputed (a render + per-colour soft proof). */
const DEBOUNCE_MS = 350;

/** The badge is a button that keeps the badge's look (and the focus ring). */
const BADGE_BUTTON: CSSProperties = { background: 'none', border: 0, padding: 0, margin: 0, color: 'inherit', font: 'inherit', cursor: 'pointer' };

/** 45° hatch tile: magenta and dark stripes, readable over any colour. */
function hatchTile(dpr: number): HTMLCanvasElement {
  const s = Math.round(8 * dpr);
  const tile = document.createElement('canvas');
  tile.width = tile.height = s;
  const ctx = tile.getContext('2d')!;
  ctx.fillStyle = '#1a001a';
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = '#ff2bd6';
  ctx.lineWidth = s / 3;
  ctx.beginPath();
  // The diagonal plus its wrapped neighbours so the tile repeats seamlessly.
  for (const o of [-s, 0, s]) {
    ctx.moveTo(o, s);
    ctx.lineTo(o + s, 0);
  }
  ctx.stroke();
  return tile;
}

/**
 * CMYK gamut warning over the viewport (Photoshop View ▸ Gamut Warning): pixels of the export
 * (guides excluded) whose colour the proof profile's press can't reproduce are hatched, with the
 * share of visible pixels affected and the profile's name in a corner badge. The badge opens a
 * menu to load the printer's own ICC profile or go back to the bundled one (src/io/gamut.ts).
 *
 * Mount it inside the element that exactly covers the comp on screen; it fills that element
 * (`position: absolute; inset: 0`); only the badge takes pointer events.
 */
export function GamutOverlay() {
  const t = useT();
  const project = useEditor((s) => s.project);
  const notify = useEditor((s) => s.notify);
  const ref = useRef<HTMLCanvasElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const pop = usePopover(anchor, 'left');
  const [profile, setProfile] = useState<GamutProfile | null>(null);
  /** Loading the stored or bundled profile failed, so there is nothing to proof against. */
  const [failed, setFailed] = useState(false);
  const [mask, setMask] = useState<HTMLCanvasElement | null>(null);
  const [share, setShare] = useState<number | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    let live = true;
    loadGamutProfile().then(
      (p) => live && setProfile(p),
      (e: unknown) => {
        if (!live) return;
        setFailed(true);
        notify(errorMsg(e), 'error');
      },
    );
    return () => {
      live = false;
    };
  }, [notify]);

  const switchTo = async (next: Promise<GamutProfile>, file: string) => {
    pop.setOpen(false);
    try {
      const p = await next;
      setProfile(p);
      setFailed(false);
      notify(msg('Proof profile: {name}', { name: p.name }));
    } catch (e) {
      notify(msg('Could not open {file}: {error}', { file, error: errorMsg(e) }), 'error');
    }
  };
  const loadOwn = async () => {
    const f = await pickFile('.icc,.icm,application/vnd.iccprofile');
    if (f) await switchTo(loadUserGamutProfile(f), f.name);
  };

  // Recompute the mask after edits settle, and when the profile changes.
  useEffect(() => {
    if (!profile) return;
    const timer = setTimeout(() => {
      const engine = engineHost.engine;
      if (!engine) return;
      const { width: cw, height: ch } = project.comp;
      const img = engine.renderImageData(project, { scale: Math.min(1, MASK_MAX / Math.max(cw, ch)), includeGuides: false });
      // The render reused the preview's pool; let the preview redraw at its own scale.
      engineHost.invalidate();
      const r = gamutMask(img);
      const m = document.createElement('canvas');
      m.width = img.width;
      m.height = img.height;
      const out = new ImageData(img.width, img.height);
      for (let i = 0; i < r.mask.length; i++) out.data[i * 4 + 3] = r.mask[i];
      m.getContext('2d')!.putImageData(out, 0, 0);
      setMask(m);
      setShare(r.visible ? r.outside / r.visible : 0);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [project, profile]);

  // Track the on-screen size of the comp box.
  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !mask || !size.w || !size.h) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(mask, 0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = ctx.createPattern(hatchTile(dpr), 'repeat')!;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';
  }, [mask, size]);

  const pct = share === null ? null : share * 100;
  const status = !profile
    ? t('CMYK gamut: no profile')
    : pct === null
      ? t('CMYK gamut: proofing…')
      : pct === 0
        ? t('CMYK gamut: all printable')
        : t('CMYK gamut: {pct} % out', { pct: pct < 0.1 ? '<0.1' : pct.toFixed(1) });
  const bundledHint = t('Japan Color 2011 Coated (bundled, from the ICC Profile Registry)');
  return (
    <div className="gamut-overlay">
      <canvas ref={ref} className="gamut-canvas" aria-hidden />
      {(profile || failed) && (
        // Clicks on the badge must not reach the viewport (marquee, deselect).
        <div className={`gamut-badge${pct ? ' warn' : ''}`} ref={anchor} onPointerDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            style={BADGE_BUTTON}
            aria-haspopup="menu"
            aria-expanded={pop.open}
            aria-label={profile ? t('Proof profile: {name}', { name: profile.name }) : t('Load ICC profile…')}
            title={
              profile
                ? t('CMYK gamut warning: a soft proof through the ICC profile “{name}” (Relative Colorimetric with black point compensation). Hatched colours would print more than ΔE {de} off. Click to change the profile.', {
                    name: profile.name,
                    de: GAMUT_DELTA_E,
                  })
                : t('No ICC profile could be loaded. Click to load one.')
            }
            onClick={() => pop.setOpen(!pop.open)}
          >
            <span role="status">{status}</span>
            {profile && ` · ${profile.name}`}
          </button>
          {pop.open && (
            <div className="menu-pop" style={pop.style} role="menu">
              <button className="menu-item" role="menuitem" title={t('Proof against your printer’s CMYK profile; it is remembered on this computer')} aria-label={t('Load ICC profile…')} onClick={loadOwn}>
                {t('Load ICC profile…')}
                <span className="mi-hint">{t('A CMYK printer profile (.icc / .icm), e.g. JapanColor2001Coated.icc from Photoshop')}</span>
              </button>
              <button
                className="menu-item"
                role="menuitem"
                disabled={!failed && !profile?.user}
                title={bundledHint}
                aria-label={t('Use bundled profile')}
                onClick={() => switchTo(restoreBundledGamutProfile(), BUNDLED_ICC)}
              >
                {t('Use bundled profile')}
                <span className="mi-hint">{bundledHint}</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
