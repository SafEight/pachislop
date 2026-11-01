import { useSyncExternalStore } from 'react';
import { getAsset, listAssets, registry } from '../../../assets/registry';
import { withoutLink } from '../../../model/links';
import type { Fill, FillKind, Gradient, GradientStop, Material2D, Material3D, MaterialPreset, PatternKind } from '../../../model/types';
import type { Translate } from '../../../store/msg';
import type { PropRef, Refs } from '../../../store/store';
import { gradientCss } from '../../util';

/** A PropRef (or every PropRef of a list, edited together) extended by more path segments. */
export function sub(r: PropRef, ...path: (string | number)[]): PropRef;
export function sub(r: Refs, ...path: (string | number)[]): Refs;
export function sub(r: Refs, ...path: (string | number)[]): Refs {
  return 'path' in r ? { layerId: r.layerId, path: [...r.path, ...path] } : r.map((x) => ({ layerId: x.layerId, path: [...x.path, ...path] }));
}

/** Static option lists keep their English labels / titles (the i18n keys); translate them for display, in context `ctx` when a label is ambiguous. */
export function tOpts<O extends { label: string; title?: string }>(t: Translate, opts: readonly O[], ctx?: string): (Omit<O, 'label' | 'title'> & { label: string; title?: string })[] {
  const c = ctx === undefined ? undefined : { ctx };
  return opts.map((o) => ({ ...o, label: t(o.label, undefined, c), title: o.title === undefined ? undefined : t(o.title, undefined, c) }));
}

export const FILL_KINDS: readonly { value: FillKind; label: string; title: string }[] = [
  { value: 'solid', label: 'Solid', title: 'Solid colour' },
  { value: 'linear', label: 'Linear', title: 'Linear gradient along the angle' },
  { value: 'radial', label: 'Radial', title: 'Radial gradient from the centre' },
  { value: 'angle', label: 'Angle', title: 'Angle gradient: sweeps clockwise around the centre, starting at the angle' },
  { value: 'reflected', label: 'Reflected', title: 'Reflected gradient: first stop in the middle, last stop at both ends' },
  { value: 'diamond', label: 'Diamond', title: 'Diamond gradient: first stop in the centre, last stop at the corners' },
  { value: 'shapeBurst', label: 'Shape burst', title: 'Shape burst: follows the outline, first stop at the edge, last stop deepest inside (rims: across the band)' },
  { value: 'image', label: 'Image', title: 'Image fill: a picture cover-fitted over the span box, then scaled / moved / rotated / tiled' },
];

export const PATTERNS: readonly { value: PatternKind; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'zebra', label: 'Zebra ゼブラ' },
  { value: 'tiger', label: 'Tiger 虎' },
  { value: 'giraffe', label: 'Giraffe キリン' },
  { value: 'leopard', label: 'Leopard 豹' },
  { value: 'checker', label: 'Checker チェッカー' },
  { value: 'hazard', label: 'Hazard DANGER' },
  { value: 'stripes', label: 'Stripes ストライプ' },
  { value: 'dots', label: 'Polka dots 水玉' },
  { value: 'sakura', label: 'Sakura 桜' },
  { value: 'seigaiha', label: 'Seigaiha 青海波' },
  { value: 'asanoha', label: 'Asanoha 麻の葉' },
  { value: 'shippo', label: 'Shippo 七宝' },
  { value: 'kikko', label: 'Kikko 亀甲' },
  { value: 'uroko', label: 'Uroko 鱗' },
  { value: 'custom', label: 'Custom image (tiled) 独自柄' },
];

export const patternLabel = (t: Translate, kind: PatternKind) => t(PATTERNS.find((p) => p.value === kind)?.label ?? kind);

// Object URLs for image-asset thumbnails, one per asset for the session (assets are immutable).
const assetUrls = new Map<string, string>();

/** A blob: URL showing an image asset, or null when the asset is missing. */
export function assetUrl(assetId: string): string | null {
  const hit = assetUrls.get(assetId);
  if (hit) return hit;
  const a = getAsset(assetId);
  if (!a) return null;
  const url = URL.createObjectURL(new Blob([a.data], { type: a.mime }));
  assetUrls.set(assetId, url);
  return url;
}

/** Raster image assets usable as image fills / custom patterns (re-renders when assets change). */
export function useImageAssets() {
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  return listAssets().filter((a) => a.mime.startsWith('image/') && a.mime !== 'image/svg+xml' && a.mime !== 'image/vnd.radiance');
}

/** CSS background previewing a Fill (model angle 90 = top→bottom = CSS 180°). */
export function fillCss(f: Fill): string {
  if (f.kind === 'solid') return f.color;
  if (f.kind === 'image') {
    const url = f.image?.assetId ? assetUrl(f.image.assetId) : null;
    return url ? `url("${url}") center / cover no-repeat, ${f.color}` : f.color;
  }
  return gradientCss(f.gradient, f.angle + 90, f.kind);
}

/** CSS background previewing a 3D material (gradient, glow colour or base colour). */
export function material3DCss(m: Material3D) {
  if (m.gradient) return gradientCss(m.gradient, m.gradientAngle + 90, m.gradientKind);
  return m.emissiveIntensity > 0.5 ? m.emissive : m.color;
}

// ---------- chrome horizon (hard edge between two coincident stops) ----------

const byPos = (g: Gradient) => [...g.stops].sort((a, b) => a.pos - b.pos);

/** Remap stop positions piecewise-linearly so `from` lands on `to` (0 and 1 stay put). */
function remapStops(stops: GradientStop[], from: number, to: number): GradientStop[] {
  return stops.map((s) => ({
    ...s,
    pos: s.pos <= from ? (from > 0 ? (s.pos / from) * to : 0) : from < 1 ? to + ((s.pos - from) / (1 - from)) * (1 - to) : 1,
  }));
}

/** Position of the hard horizon (two coincident stops of different colour nearest the middle), or null. */
export function findHorizon(g: Gradient): number | null {
  const s = byPos(g);
  let best: number | null = null;
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i + 1].pos - s[i].pos < 1e-3 && s[i].color !== s[i + 1].color) {
      if (best === null || Math.abs(s[i].pos - 0.5) < Math.abs(best - 0.5)) best = s[i].pos;
    }
  }
  return best;
}

/**
 * Pinch the two stops either side of the middle into a hard edge at their midpoint (the chrome
 * sky / ground horizon); the stops above and below are squeezed proportionally. A stop that sat
 * at an end keeps a copy there so each side keeps its colour band.
 */
export function pinchHorizon(g: Gradient): Gradient {
  const s = byPos(g);
  if (s.length < 2) return g;
  let j = s.findIndex((st) => st.pos > 0.5);
  if (j <= 0) j = j === 0 ? 1 : s.length - 1;
  const a = s[j - 1];
  const b = s[j];
  const h = Math.min(0.98, Math.max(0.02, (a.pos + b.pos) / 2));
  const lower = s.slice(0, j).map((st) => ({ ...st, pos: a.pos > 0 ? (st.pos / a.pos) * h : 0 }));
  const upper = s.slice(j).map((st) => ({ ...st, pos: b.pos < 1 ? h + ((st.pos - b.pos) / (1 - b.pos)) * (1 - h) : 1 }));
  if (a.pos <= 0) lower.push({ ...a, pos: h });
  if (b.pos >= 1) upper.unshift({ ...b, pos: h });
  return { ...g, stops: [...lower, ...upper] };
}

/** Move the horizon found by findHorizon to `h` (0..1), squeezing the stops on each side. */
export function moveHorizon(g: Gradient, h: number): Gradient {
  const from = findHorizon(g);
  if (from === null) return g;
  return { ...g, stops: remapStops(byPos(g), from, Math.min(0.98, Math.max(0.02, h))) };
}

export const PRESET_LABELS: Record<MaterialPreset, string> = {
  custom: 'Custom',
  gold: 'Gold',
  punchyGold: 'Punchy gold 派手金',
  paleGold: 'Pale gold',
  roseGold: 'Rose gold',
  chrome: 'Chrome',
  silver: 'Silver',
  copper: 'Copper',
  redMetal: 'Red metal',
  blueMetal: 'Blue metal',
  greenMetal: 'Green metal',
  purpleMetal: 'Purple metal',
  blackGloss: 'Black gloss',
  whiteGloss: 'White gloss',
  rainbow: 'Rainbow (iridescent)',
  candy: 'Candy glitter キャンディ',
  diamond: 'Diamond ダイヤ',
  ruby: 'Ruby ルビー',
  sapphire: 'Sapphire サファイア',
  emerald: 'Emerald エメラルド',
  glass: 'Glass',
  plastic: 'Plastic',
  emissive: 'Emissive (glowing)',
};

const HAS_JA = /[\u3040-\u30ff\u3400-\u9fff]/;

/** Display name of a material preset; names that already carry Japanese (派手金, ダイヤ…) show as they are. */
export function presetLabel(t: Translate, p: MaterialPreset): string {
  const s = PRESET_LABELS[p];
  return HAS_JA.test(s) ? s : t(s);
}

/**
 * In-memory clipboard shared by every editor instance of one value type (e.g. "copy this rim's
 * material, paste onto the face"). Not persisted; components re-render when it changes.
 */
export interface Clipboard<T> {
  copy(v: T): void;
  /** A fresh deep copy of the clipboard content (null when empty). */
  paste(): T | null;
  /** Hook: whether anything has been copied. */
  useHas(): boolean;
}

/** `clean` prepares a copied value (a material leaves its link behind: pasting edits the target's own). */
function createClipboard<T>(clean: (v: T) => T = (v) => v): Clipboard<T> {
  let value: T | null = null;
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };
  return {
    copy(v) {
      value = structuredClone(clean(v));
      for (const fn of listeners) fn();
    },
    paste: () => (value === null ? null : structuredClone(value)),
    useHas: () => useSyncExternalStore(subscribe, () => value !== null),
  };
}

export const material2DClipboard = createClipboard<Material2D>(withoutLink);
export const material3DClipboard = createClipboard<Material3D>(withoutLink);
