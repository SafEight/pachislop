import { band3D, bevel2D, bevel3D, erode2D, material2D, material3D, rim2D, solidFill } from '../model/defaults';
import { hexToRgb, sampleGradient } from '../model/gradient';
import { bandsGrow, letterOutside } from '../model/bands';
import type { EffectInstance, Gradient, Material2D, Material3D, Title2DLayer, Title3DLayer } from '../model/types';
import { joinMsgs, msg, type Msg, type Text } from '../store/msg';

// Style lint (src/ui/properties/StyleLint.tsx): flags the mistakes practitioners call amateur,
// each with the rule it breaks and, where the repair is mechanical, a one-click fix. Colours
// are judged on a representative sample of each element (its fill gradient, through the
// gradient-map finish in 2D) in CIE L*a*b*, so lightness and hue match what the eye compares.

type TitleLayer = Title2DLayer | Title3DLayer;
type RGB = [number, number, number];
type Lab = [number, number, number];

export interface LintIssue {
  /** Stable per rule and element (React key). */
  id: string;
  /** English template + values, translated where it is shown. */
  message: Msg;
  /** The practice the issue breaks, with its source (tooltip). */
  rule: Text;
  /** `label` is an English UI literal (the i18n key). */
  fix?: { label: string; apply(l: TitleLayer): TitleLayer };
}

// ---------- thresholds ----------

/** Adjacent elements closer than this in L* blur into one shape at a glance. */
const MIN_DELTA_L = 12;
/** Below this L* both rings are black: two dark rings read as one thick keyline, which is fine. */
const DARK_L = 25;
/** Banded metals (L* range wider than this) separate from each other through their banding. */
const BANDED = 30;
/** Chroma (C*) above which a colour counts as a hue rather than a neutral. */
const CHROMATIC = 25;
/** Hues within this many degrees (a*b* angle) are one colour family (gold vs yellow). */
const HUE_FAMILY = 30;
/** A gradient whose chromatic samples spread wider than this is a spectrum (虹), not one hue. */
const SPECTRUM_SPREAD = 120;
/** Total rim width below this (% of size) disappears on busy backgrounds. */
const MIN_RIMS = 5;
/** Approximate stem width of the heavy display faces pachislot titles use (% of em). */
const STEM = 16;

const RULES: Record<string, Text> = {
  contrast:
    'Keep lightness contrast between neighbouring rings: a light face takes a dark rim and vice versa, alternating outward (marumarutelop 袋文字; megabenri 縁取り).',
  hues: 'Never use three chromatic hues across face and rims: keep rims achromatic (white / black / silver) or in the face’s own hue family (marumarutelop 袋文字).',
  thin: msg('Rims under ~{min}% of the size vanish on busy machine backgrounds; production stacks total 7–10% (まぺろに / megabenri).', { min: MIN_RIMS }),
  thick: msg('Rims thicker than the strokes (≈{stem}% of the size for heavy faces) eat into the letters and flood the counters; use a heavy font or thinner rims (smallppt 縁取り文字).', { stem: STEM }),
  shadow: 'A hard black drop shadow reads cheap: opacity 0.5–0.7, a large soft blur and a small offset, tinted toward the face colour (marumarutelop; CGWORLD).',
  span: 'Rainbow titles carry the whole spectrum on EACH line (varietytelop 虹文字): a layer-wide ramp gives every line only part of it.',
  noop: 'A switch that is on but changes nothing hides the reason a look doesn’t work: Hollow letters needs rims to show and a face fill opacity below 100 % (as Photoshop’s Knockout); かすれ needs an amount and an edge width.',
};

// ---------- colour ----------

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const labF = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);

/** sRGB 0..1 → CIE L*a*b* (D65). */
function toLab([r, g, b]: RGB): Lab {
  const R = toLinear(r);
  const G = toLinear(g);
  const B = toLinear(b);
  const fx = labF((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const fy = labF(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const fz = labF((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const SAMPLES = 9;
const rampSamples = (g: Gradient): RGB[] => Array.from({ length: SAMPLES }, (_, i) => sampleGradient(g, i / (SAMPLES - 1)));
const luma601 = ([r, g, b]: RGB) => 0.299 * r + 0.587 * g + 0.114 * b;

/** 2D element colours: the fill, pushed through the gradient-map finish by its amount. */
function samples2D(m: Material2D): RGB[] {
  const fill = m.fill.kind === 'solid' ? [hexToRgb(m.fill.color)] : rampSamples(m.fill.gradient);
  if (!m.finish.enabled) return fill;
  const a = m.finish.amount;
  return fill.map((c) => {
    const f = sampleGradient(m.finish.gradient, luma601(c));
    return [c[0] + (f[0] - c[0]) * a, c[1] + (f[1] - c[1]) * a, c[2] + (f[2] - c[2]) * a];
  });
}

/** 3D element colours: the gradient when set (it replaces `color`), else the colour. */
const samples3D = (m: Material3D): RGB[] => (m.gradient?.stops.length ? rampSamples(m.gradient) : [hexToRgb(m.color)]);

interface Element {
  name: Msg;
  /** Mean L*. */
  L: number;
  /** L* range across the element's samples (metal banding). */
  spread: number;
  /** Mean a*b* hue (degrees) of the chromatic samples; null = neutral or a spectrum. */
  hue: number | null;
  spectrum: boolean;
}

const hueOf = ([, a, b]: Lab) => ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
const hueDist = (x: number, y: number) => Math.min(Math.abs(x - y), 360 - Math.abs(x - y));

function element(name: Msg, rgb: RGB[]): Element {
  const labs = rgb.map(toLab);
  const Ls = labs.map((c) => c[0]);
  const L = Ls.reduce((s, v) => s + v, 0) / Ls.length;
  const spread = Math.max(...Ls) - Math.min(...Ls);
  const chroma = labs.filter(([, a, b]) => Math.hypot(a, b) > CHROMATIC);
  const hues = chroma.map(hueOf);
  const spectrum = hues.some((h) => hues.some((k) => hueDist(h, k) > SPECTRUM_SPREAD));
  if (spectrum || chroma.length * 2 < labs.length) return { name, L, spread, hue: null, spectrum };
  const a = chroma.reduce((s, c) => s + c[1], 0);
  const b = chroma.reduce((s, c) => s + c[2], 0);
  return { name, L, spread, hue: hueOf([0, a, b]), spectrum };
}

// ---------- fixes ----------

/** A ring whose lightness is opposite to the pair it separates (dark between light, light between dark). */
const separatorColor = (meanL: number) => (meanL > 50 ? '#0a0604' : '#ffffff');

function insertRim2D(l: Title2DLayer, at: number, color: string): Title2DLayer {
  const light = color === '#ffffff';
  const material = material2D(solidFill(color), light ? { bevel: bevel2D({ size: 0.8, depth: 2, gloss: 'linear', highlightOpacity: 0.6, shadowOpacity: 0.3 }) } : {});
  const rims = [...l.style.rims];
  rims.splice(at, 0, rim2D(1, material));
  return { ...l, style: { ...l.style, rims } };
}

/** `l` with a thin separator band inserted before band `at`, seated where the solid in front of it ends its bevel. */
function insertBand3D(l: Title3DLayer, at: number, color: string): Title3DLayer {
  const light = color === '#ffffff';
  const s = l.style3d;
  const front = at > 0 ? s.bands[at - 1].depth : s.depth;
  const band = { ...band3D(0.4, 'custom'), depth: front, offset: -front, bevel: bevel3D(0.4, 0.6, 'step') };
  band.material = light ? material3D('whiteGloss') : { ...band.material, color, metalness: 1, roughness: 0.4, reflectivity: 0.6 };
  const bands = [...s.bands];
  bands.splice(at, 0, band);
  return { ...l, style3d: { ...s, bands } };
}

/** Every 2D rim width × `k`; in 3D the letter's bevel width and every band's grow and bevel width × `k`. */
function scaleRims<L extends TitleLayer>(l: L, k: number): L {
  if (l.kind === 'title2d') return { ...l, style: { ...l.style, rims: l.style.rims.map((r) => ({ ...r, width: r.width * k })) } };
  const s = l.style3d;
  return {
    ...l,
    style3d: { ...s, bevel: { ...s.bevel, width: s.bevel.width * k }, bands: s.bands.map((b) => ({ ...b, grow: b.grow * k, bevel: { ...b.bevel, width: b.bevel.width * k } })) },
  };
}

// ---------- rules ----------

const isText = (l: TitleLayer) => l.source.kind === 'text';
const multiLine = (l: TitleLayer) => l.source.kind === 'text' && l.source.text.trim().includes('\n');

/**
 * Lettering rings, face then outward. Dropped bases (offset rims) are shadow weight, not a ring;
 * 3D bands right behind the letter in its own material read as the letter itself. Non-text
 * sources (plates, orbs) are not lettering: no rings.
 */
function rings(l: TitleLayer): { el: Element; insertAt: number | null }[] {
  if (!isText(l)) return [];
  if (l.kind === 'title2d') {
    const out = [{ el: element(msg('Face'), samples2D(l.style.face)), insertAt: null as number | null }];
    l.style.rims.forEach((r, i) => {
      if (r.enabled && r.offsetX === 0 && r.offsetY === 0) out.push({ el: element(msg('Rim {n}', { n: i + 1 }), samples2D(r.material)), insertAt: i });
    });
    return out;
  }
  const s = l.style3d;
  const same = (m: Material3D) => m.preset === s.face.preset && m.color === s.face.color && JSON.stringify(m.gradient) === JSON.stringify(s.face.gradient);
  const lead = s.bands.findIndex((b) => b.enabled && !same(b.material));
  const first = lead < 0 ? s.bands.length : lead;
  const out = [{ el: element(msg('Face'), samples3D(s.face)), insertAt: null as number | null }];
  s.bands.forEach((b, i) => {
    if (i >= first && b.enabled) out.push({ el: element(msg('Band {n}', { n: i + 1 }), samples3D(b.material)), insertAt: i });
  });
  return out;
}

function contrastIssues(l: TitleLayer): LintIssue[] {
  const rs = rings(l);
  const out: LintIssue[] = [];
  for (let i = 1; i < rs.length; i++) {
    const a = rs[i - 1].el;
    const b = rs[i].el;
    // A spectrum spans every lightness (its neighbours are judged by hue); two blacks are one
    // thick keyline; two banded metals separate through their banding.
    if (a.spectrum || b.spectrum || (a.L < DARK_L && b.L < DARK_L) || (a.spread > BANDED && b.spread > BANDED)) continue;
    const dL = Math.abs(a.L - b.L);
    if (dL >= MIN_DELTA_L) continue;
    const at = rs[i].insertAt;
    const color = separatorColor((a.L + b.L) / 2);
    out.push({
      id: `contrast-${i}`,
      message: msg('{a} and {b} are close in lightness (ΔL {dL}): they merge into one band.', { a: a.name, b: { ...b.name, lower: true }, dL: dL.toFixed(0) }),
      rule: RULES.contrast,
      fix:
        at === null
          ? undefined
          : {
              label: color === '#ffffff' ? 'Insert a white line' : 'Insert a dark line',
              apply: (x) => (x.kind === 'title2d' ? insertRim2D(x, at, color) : insertBand3D(x, at, color)),
            },
    });
  }
  return out;
}

function hueIssues(l: TitleLayer): LintIssue[] {
  const families: { hue: number; names: Msg[] }[] = [];
  for (const { el } of rings(l)) {
    if (el.hue === null) continue;
    const fam = families.find((f) => hueDist(f.hue, el.hue!) < HUE_FAMILY);
    if (fam) fam.names.push(el.name);
    else families.push({ hue: el.hue, names: [el.name] });
  }
  if (families.length < 3) return [];
  const list = joinMsgs(
    families.map((f) => joinMsgs(f.names, ' + ')),
    ' / ',
  );
  return [{ id: 'hues', message: msg("{n} chromatic hues ({list}): the eye can't find the face.", { n: families.length, list }), rule: RULES.hues }];
}

/** Rim total (2D rims; 3D the letter's bevel outside its outline + band grows), % of size. */
const rimTotal = (l: TitleLayer) => (l.kind === 'title2d' ? l.style.rims.reduce((s, r) => s + (r.enabled ? r.width : 0), 0) : letterOutside(l.style3d) + bandsGrow(l.style3d));

function thicknessIssues(l: TitleLayer): LintIssue[] {
  if (!isText(l)) return [];
  const total = rimTotal(l);
  // 3D titles read their edge from the extrusion; only 2D rims can be too thin.
  if (l.kind === 'title2d' && total > 0 && total < MIN_RIMS) {
    const k = 8 / total;
    return [{ id: 'thin', message: msg('Rims total {total}% of the size: too thin to hold the title together.', { total: total.toFixed(1) }), rule: RULES.thin, fix: { label: 'Scale rims to 8%', apply: (x) => scaleRims(x, k) } }];
  }
  if (total > STEM) {
    const k = 12 / total;
    return [{ id: 'thick', message: msg('Rims total {total}% of the size: thicker than the letter strokes.', { total: total.toFixed(1) }), rule: RULES.thick, fix: { label: 'Scale rims to 12%', apply: (x) => scaleRims(x, k) } }];
  }
  return [];
}

/** Hard: opaque, barely blurred and near-black. */
const hardShadow = (fx: EffectInstance, size: number) =>
  fx.enabled &&
  fx.type === 'dropShadow' &&
  Number(fx.params.opacity) > 0.8 &&
  Number(fx.params.size) < size * 0.04 &&
  typeof fx.params.color === 'string' &&
  luma601(hexToRgb(fx.params.color)) < 0.15;

function shadowIssues(l: TitleLayer): LintIssue[] {
  const size = l.source.size;
  const out: LintIssue[] = [];
  if (l.effects.some((fx) => hardShadow(fx, size)))
    out.push({
      id: 'shadow',
      message: msg('Hard black drop shadow (opaque, almost no blur).'),
      rule: RULES.shadow,
      fix: {
        label: 'Soften it',
        apply: (x) => ({
          ...x,
          effects: x.effects.map((fx) => (hardShadow(fx, size) ? { ...fx, params: { ...fx.params, opacity: 0.6, size: Math.round(size * 0.07) } } : fx)),
        }),
      },
    });
  if (l.kind === 'title3d') {
    const sh = l.style3d.shadow;
    if (sh.enabled && sh.opacity > 0.8 && sh.softness < 0.25 && luma601(hexToRgb(sh.color)) < 0.15)
      out.push({
        id: 'shadow3d',
        message: msg('Hard black shadow catcher (opaque, almost no softness).'),
        rule: RULES.shadow,
        fix: { label: 'Soften it', apply: (x) => (x.kind === 'title3d' ? { ...x, style3d: { ...x.style3d, shadow: { ...x.style3d.shadow, opacity: 0.6, softness: 0.5 } } } : x) },
      });
  }
  return out;
}

const isSpectrum2D = (m: Material2D) => m.fill.kind !== 'solid' && element(msg(''), rampSamples(m.fill.gradient)).spectrum;
const isSpectrum3D = (m: Material3D) => !!m.gradient?.stops.length && element(msg(''), rampSamples(m.gradient)).spectrum;

function spanIssues(l: TitleLayer): LintIssue[] {
  if (!multiLine(l)) return [];
  if (l.kind === 'title2d') {
    const bad = (m: Material2D) => isSpectrum2D(m) && m.fill.span === 'layer';
    if (!bad(l.style.face) && !l.style.rims.some((r) => bad(r.material))) return [];
    const fix = (m: Material2D): Material2D => (bad(m) ? { ...m, fill: { ...m.fill, span: 'line' } } : m);
    return [
      {
        id: 'span',
        message: msg('Rainbow fill spans the whole block: each line only gets part of the spectrum.'),
        rule: RULES.span,
        fix: {
          label: 'Span each line',
          apply: (x) => (x.kind === 'title2d' ? { ...x, style: { ...x.style, face: fix(x.style.face), rims: x.style.rims.map((r) => ({ ...r, material: fix(r.material) })) } } : x),
        },
      },
    ];
  }
  const s = l.style3d;
  const bad = (m: Material3D) => isSpectrum3D(m) && m.gradientSpan === 'layer';
  if (!bad(s.face) && !s.bands.some((b) => bad(b.material))) return [];
  const fix = (m: Material3D): Material3D => (bad(m) ? { ...m, gradientSpan: 'line' } : m);
  return [
    {
      id: 'span',
      message: msg('Rainbow material spans the whole block: each line only gets part of the spectrum.'),
      rule: RULES.span,
      fix: {
        label: 'Span each line',
        apply: (x) =>
          x.kind === 'title3d' ? { ...x, style3d: { ...x.style3d, face: fix(x.style3d.face), bands: x.style3d.bands.map((b) => ({ ...b, material: fix(b.material) })) } } : x,
      },
    },
  ];
}

/**
 * v5 settings that are on but render nothing (each fixable in one click): Hollow letters
 * (knockout) without rims or over an opaque face, かすれ at amount / edge 0.
 */
function noopIssues(l: TitleLayer): LintIssue[] {
  const out: LintIssue[] = [];
  if (l.kind === 'title3d') return out;
  const { knockout, erode, rims, face } = l.style;
  if (knockout && !rims.some((r) => r.enabled && r.width > 0))
    out.push({
      id: 'knockout-rims',
      message: msg('Hollow letters is on but there are no rims to cut through: the face simply disappears.'),
      rule: RULES.noop,
      fix: { label: 'Turn Hollow letters off', apply: (x) => (x.kind === 'title2d' ? { ...x, style: { ...x.style, knockout: false } } : x) },
    });
  else if (knockout && face.opacity >= 1)
    out.push({
      id: 'knockout-face',
      message: msg('Hollow letters is on under an opaque face: the face covers the hollow it cuts.'),
      rule: RULES.noop,
      fix: { label: 'Face fill opacity 0', apply: (x) => (x.kind === 'title2d' ? { ...x, style: { ...x.style, face: { ...x.style.face, opacity: 0 } } } : x) },
    });
  if (erode.enabled && !(erode.amount > 0 && erode.edge > 0)) {
    const start = erode2D();
    out.push({
      id: 'erode-zero',
      message: msg(erode.amount > 0 ? 'かすれ is on with edge 0: nothing is eroded.' : 'かすれ is on with amount 0: nothing is eroded.'),
      rule: RULES.noop,
      fix: {
        label: 'Use the starting amount',
        apply: (x) =>
          x.kind === 'title2d'
            ? { ...x, style: { ...x.style, erode: { ...x.style.erode, amount: x.style.erode.amount > 0 ? x.style.erode.amount : start.amount, edge: x.style.erode.edge > 0 ? x.style.erode.edge : start.edge } } }
            : x,
      },
    });
  }
  return out;
}

/** All issues of a title layer's style, most visible first. */
export function lintStyle(l: TitleLayer): LintIssue[] {
  return [...noopIssues(l), ...spanIssues(l), ...contrastIssues(l), ...hueIssues(l), ...thicknessIssues(l), ...shadowIssues(l)];
}
