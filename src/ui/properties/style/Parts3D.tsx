import { useRef } from 'react';
import type { Backplate3D, BevelProfile3D, Glint3D, PlateShape, Title3DLayer, Title3DProps } from '../../../model/types';
import { bandKey } from '../../../model/parts';
import { partLabel } from '../../../store/labels';
import { formatMsg } from '../../../store/msg';
import { refKey } from '../../../store/paths';
import { useEditor, type PropRef, type Refs } from '../../../store/store';
import { Menu, NumberField, RefCheck, RefColor, RefNum, Row, Section, Seg } from '../../controls';
import { useOpenSection } from '../../sectionMemory';
import { useT } from '../../i18n';
import { oneShot, useGesture, useMixed, useRefValue } from '../../util';
import { BevelPreview } from './BevelPreview';
import { CurveEditor } from './CurveEditor';
import { PlateIcon, Profile3DIcon } from './icons';
import { Material3DSection } from './Material3DEditor';
import { refsOf } from '../parts';
import { sub, tOpts } from './shared';
import { IconChoice } from './widgets';

// Element 3D replacement split by part: the face, the side walls, each bevel band and each
// backplate get their own editor (Properties › part node). What belongs to no part sits on the
// layer node: its Shape section (extrude / inflate, depth, skew, bevel position and the bands as a
// compact list) and its Render passes (glint, AO, shadow catcher); lighting is Lighting3D's.

const PROFILES: readonly { value: BevelProfile3D; label: string }[] = [
  { value: 'flat', label: 'Flat (ledge)' },
  { value: 'round', label: 'Round' },
  { value: 'chamfer', label: 'Chamfer' },
  { value: 'cove', label: 'Cove (concave)' },
  { value: 'step', label: 'Step' },
  { value: 'inset', label: 'Inset (recessed)' },
  { value: 'tube', label: 'Tube (half-round)' },
];
const PROFILE_OPTIONS = PROFILES.map((p) => ({ ...p, icon: <Profile3DIcon profile={p.value} /> }));

const JOINS = [
  { value: 'miter', label: 'Miter' },
  { value: 'round', label: 'Round' },
] as const;

const SEGMENTS_TIP = 'Bevel segments: facets of curved profiles (round, cove, step, or any riser bent by Curve). Large exports add more automatically.';
const CURVE_TIP = 'Bevel curve: bends the profile. > 0 fuller / rounder (stays high, drops late), < 0 pinched toward a cove (drops right at the inner edge).';

const PLATE_KINDS: readonly { value: PlateShape['kind']; label: string; title: string }[] = [
  { value: 'contour', label: 'Contour', title: 'The plate follows the letters (Close bridges the gaps between them)' },
  { value: 'hull', label: 'Hull', title: 'Convex hull of the whole title: one smooth slab' },
  { value: 'box', label: 'Box', title: 'A box around the title with cut corners, leaning by Slant (北斗 / カバネリ plates); italic text adds its shear' },
];
const PLATE_OPTIONS = PLATE_KINDS.map((p) => ({ ...p, icon: <PlateIcon kind={p.value} /> }));

const MODES = [
  { value: 'extrude', label: 'Extrude', title: 'Flat face with bevel bands and a straight side wall (Element 3D)' },
  { value: 'inflate', label: 'Inflate', title: 'Puffy surface rising from the outline (ぷっくり buttons, 保留 icons); bevel bands are ignored' },
] as const;

const BEVEL_POSITIONS = [
  { value: 'outside', label: 'Outside', title: 'Bands grow outward from the glyph outline like a Photoshop stroke: the face keeps the whole letter and wider bands fatten the silhouette' },
  { value: 'center', label: 'Center', title: 'Bands straddle the glyph outline, half inside and half outside' },
  { value: 'inside', label: 'Inside', title: 'Bands are cut inward from the glyph outline (Element 3D): the silhouette stays put and wider bands shrink the face' },
] as const;

/** Plates whose grow adds nothing beyond the previous plate are hidden behind it (or disabled). */
function plateHidden(p: Backplate3D): string | null {
  if (!p.enabled) return 'Disabled: not rendered';
  if (p.grow <= 0) return 'Hidden: no grow beyond the previous solid, so it sits fully behind it. Raise Grow to show it.';
  return null;
}


const STREAK_COUNTS = [
  { value: '0', label: 'None' },
  { value: '2', label: '2' },
  { value: '4', label: '4' },
  { value: '6', label: '6' },
  { value: '8', label: '8' },
] as const;

/**
 * One render pass inside Render passes: the header checkbox switches it on (and opens its
 * settings); while it's off the body says what it does. Over several layers (`refp` a list) the
 * box is indeterminate while only some have it on, and the settings show while any has.
 */
function PassSection({ id, title, refp, about, children }: { id: string; title: string; refp: Refs; about: string; children: React.ReactNode }) {
  const setAt = useEditor((s) => s.setAt);
  const openSection = useOpenSection();
  const { value, mixed } = useRefValue(sub(refp, 'enabled'));
  const on = mixed || value === true;
  return (
    <Section
      id={id}
      title={title}
      defaultOpen={false}
      enabled={on}
      enabledMixed={mixed}
      onToggle={(v) => {
        setAt(sub(refp, 'enabled'), v);
        if (v) openSection(id);
      }}
    >
      {on ? children : <div className="hint-line">{about}</div>}
    </Section>
  );
}

/** Element 3D Matte Shadow: tinted shadow on an invisible catcher behind the title. */
function ShadowSection({ refp }: { refp: Refs }) {
  const t = useT();
  return (
    <PassSection id="pass-shadow" title={t('Shadow catcher')} refp={refp} about={t('Shadow on an invisible wall behind the title (needs a directional light)')}>
      <RefColor label={t('Colour')} refp={sub(refp, 'color')} />
      <div className="hint-line">{t('遊技機 practice: coloured (deep red / brown / navy), not black.')}</div>
      <RefNum label={t('Opacity')} refp={sub(refp, 'opacity')} min={0} max={1} clamp display={100} unit="%" />
      <RefNum label={t('Softness')} refp={sub(refp, 'softness')} min={0} max={1} clamp display={100} unit="%" title={t('Blur of the shadow edge, relative to the title size')} />
    </PassSection>
  );
}

/** HDR glint: bloom + star streaks keyed to the specular highlights, before tone mapping. `glint`: the first layer's. */
function GlintSection({ refp, glint }: { refp: Refs; glint: Glint3D }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const [streaksMixed] = useMixed(sub(refp, 'streaks'));
  return (
    <PassSection id="pass-glint" title={t('Glint')} refp={refp} about={t('Bloom and star streaks on highlights brighter than the threshold')}>
      <RefNum label={t('Threshold')} refp={sub(refp, 'threshold')} min={0} max={8} step={0.05} title={t('HDR luminance above which pixels glint (1 ≈ brighter than white)')} />
      <RefNum label={t('Intensity')} refp={sub(refp, 'intensity')} min={0} max={4} step={0.01} clamp unit="x" />
      <RefNum label={t('Bloom radius')} refp={sub(refp, 'radius')} min={0} max={40} step={0.1} unit="%" title={t('% of the source size')} />
      <Row label={t('Streaks')}>
        <Seg
          value={String(glint.streaks) as (typeof STREAK_COUNTS)[number]['value']}
          mixed={streaksMixed}
          options={STREAK_COUNTS.map((o) => (o.value === '0' ? { ...o, label: t(o.label) } : o))}
          onChange={(v) => setAt(sub(refp, 'streaks'), Number(v))}
        />
      </Row>
      {(streaksMixed || glint.streaks > 0) && (
        <>
          <RefNum label={t('Length')} refp={sub(refp, 'length')} min={0} max={200} step={0.5} unit="%" title={t('% of the source size')} />
          <RefNum label={t('Angle')} refp={sub(refp, 'angle')} min={-180} max={180} step={0.5} unit="deg" title={t('Clockwise on screen')} />
        </>
      )}
      <RefColor label={t('Tint')} refp={sub(refp, 'tint')} />
    </PassSection>
  );
}

const AO_TIP = 'Ambient occlusion (Element 3D SSAO): darkens the crevices where bands meet and where backplates sit behind the letters, so the stack reads as separate solids.';

/** Element 3D SSAO: screen-space ambient occlusion over the 3D render. */
function AOSection({ refp }: { refp: Refs }) {
  const t = useT();
  return (
    <PassSection id="pass-ao" title={t('Ambient occlusion')} refp={refp} about={t(AO_TIP)}>
      <RefNum label={t('Radius')} refp={sub(refp, 'radius')} min={0} max={20} step={0.1} unit="%" defaultValue={4} title={t('Sample radius, % of the title size: how far apart two surfaces can be and still shade each other')} />
      <RefNum label={t('Intensity')} refp={sub(refp, 'intensity')} min={0} max={2} step={0.01} clamp unit="x" defaultValue={1} title={t('Darkness of the occlusion (1 = physical, 2 = exaggerated)')} />
    </PassSection>
  );
}

/** Pad size (px) and the skew at its edge (units of depth); typed values may go further. */
const SKEW_PAD = 72;
const SKEW_EDGE = 1;

const SKEW_TIP =
  'Oblique extrusion 飛び出し: drag to shift the back of every solid (dot = where the back goes, in units of depth; centre = straight back). Shift snaps to 0.05 · arrow keys nudge 0.01 (Shift 0.1) · double-click resets.';

/** Round to `q` without float noise (skew is shown with 2 decimals). */
const snapTo = (v: number, q: number) => Number((Math.round(v / q) * q).toFixed(2));

/**
 * 2D drag pad for `style3d.skew` (x = right, y = up). One drag or one burst of arrow keys is
 * one undo step.
 */
function SkewPad({ refp, skew }: { refp: Refs; skew: Title3DProps['skew'] }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const g = useGesture(refKey(refp));
  const keyBurst = useRef(false);
  const half = SKEW_PAD / 2;
  const r = half - 5;
  const edge = (v: number) => Math.max(-SKEW_EDGE, Math.min(SKEW_EDGE, v));
  const dotX = half + (edge(skew.x) / SKEW_EDGE) * r;
  const dotY = half - (edge(skew.y) / SKEW_EDGE) * r;

  const fromPointer = (el: Element, cx: number, cy: number, snap: boolean) => {
    const b = el.getBoundingClientRect();
    const rPx = (r * b.width) / SKEW_PAD;
    const q = snap ? 0.05 : 0.01;
    const x = snapTo(edge(((cx - (b.left + b.width / 2)) / rPx) * SKEW_EDGE), q);
    const y = snapTo(edge((((b.top + b.height / 2) - cy) / rPx) * SKEW_EDGE), q);
    setAt(refp, { x, y }, g.key());
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (!d) return;
    e.preventDefault();
    if (!keyBurst.current) {
      g.begin();
      keyBurst.current = true;
    }
    setAt(refp, { x: snapTo(skew.x + d[0], 0.01), y: snapTo(skew.y + d[1], 0.01) }, g.key());
  };

  return (
    <svg
      role="slider"
      tabIndex={0}
      aria-label={t('Extrusion skew pad (飛び出し)')}
      aria-valuemin={-SKEW_EDGE}
      aria-valuemax={SKEW_EDGE}
      aria-valuenow={skew.x}
      aria-valuetext={t('X {x}, Y {y} × depth', { x: skew.x.toFixed(2), y: skew.y.toFixed(2) })}
      width={SKEW_PAD}
      height={SKEW_PAD}
      viewBox={`0 0 ${SKEW_PAD} ${SKEW_PAD}`}
      style={{ flex: 'none', cursor: 'crosshair', touchAction: 'none', background: 'var(--bg0)', border: '1px solid var(--line)', borderRadius: 3 }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.focus();
        keyBurst.current = false;
        g.begin();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        fromPointer(el, e.clientX, e.clientY, e.shiftKey);
        const move = (ev: PointerEvent) => fromPointer(el, ev.clientX, ev.clientY, ev.shiftKey);
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      }}
      onDoubleClick={() => setAt(refp, { x: 0, y: 0 }, oneShot(`${refKey(refp)}:reset`))}
      onKeyDown={onKeyDown}
      onBlur={() => {
        keyBurst.current = false;
      }}
    >
      <title>{t(SKEW_TIP)}</title>
      <rect x={half - r / 2} y={half - r / 2} width={r} height={r} fill="none" style={{ stroke: 'var(--line)' }} strokeDasharray="2 2" />
      <line x1={half} y1={2} x2={half} y2={SKEW_PAD - 2} style={{ stroke: 'var(--line)' }} />
      <line x1={2} y1={half} x2={SKEW_PAD - 2} y2={half} style={{ stroke: 'var(--line)' }} />
      <line x1={half} y1={half} x2={dotX} y2={dotY} strokeWidth={1.5} style={{ stroke: 'var(--muted)' }} />
      <circle cx={dotX} cy={dotY} r={4} stroke="#000" strokeWidth={1} style={{ fill: 'var(--accent)' }} />
    </svg>
  );
}

const pts = (...p: [number, number][]) => ({ points: p.map(([x, y]) => ({ x, y, corner: false })) });

/** Inflate height profiles (x = distance from the edge / largest inset, y = height). */
const INFLATE_PRESETS = [
  { label: 'Dome', curve: pts([0, 0], [0.35, 0.8], [1, 1]) },
  { label: 'Round', curve: pts([0, 0], [0.1, 0.44], [0.3, 0.71], [0.6, 0.92], [1, 1]) },
  { label: 'Cushion', curve: pts([0, 0], [0.2, 0.8], [0.45, 1], [1, 1]) },
  { label: 'Cone', curve: pts([0, 0], [1, 1]) },
  { label: 'Bubble', curve: pts([0, 0.25], [0.15, 0.75], [0.5, 0.97], [1, 1]) },
];

const styleRef = (layer: Title3DLayer, ...path: (string | number)[]): PropRef => ({ layerId: layer.id, path: ['style3d', ...path] });

/** The same style3d path on every layer of `layers`, as one target or a list. */
const styleRefs = (layers: readonly Title3DLayer[], ...path: (string | number)[]) => refsOf(layers.map((l) => styleRef(l, ...path)));

/** A band or backplate of a title, by its index in `style3d.bands` / `style3d.backplates`. */
export interface Stack3DTarget {
  layer: Title3DLayer;
  index: number;
}

/**
 * The face of a 3D title: its material; on a GLB model the one material applied over the whole
 * model. An image source adds how much of its picture shows on the face and on the bands and
 * sides, above the material that lights it. Like every part editor here it renders on the part
 * page or inline under a part row; `id` (default "part") prefixes its sections' remembered open
 * state, unique on the page. `layers`: the titles whose faces are edited together (one for a
 * single part); the model note and image rows show when they apply to all of them.
 */
export function Face3DEditor({ layers, id = 'part' }: { layers: readonly Title3DLayer[]; id?: string }) {
  const t = useT();
  const model = layers.every((l) => l.source.kind === 'model');
  return (
    <Material3DSection
      id={`${id}-material`}
      title={model ? t('Model material') : t('Material')}
      refp={styleRefs(layers, 'face')}
      mat={layers[0].style3d.face}
      defaultOpen
      note={model ? t("Applies to the whole model. Preset 'Custom' keeps the model's own materials.") : undefined}
    >
      {layers.every((l) => l.source.kind === 'image') && (
        <>
          <RefNum
            label={t('Image on face')}
            refp={styleRefs(layers, 'faceImage')}
            min={0}
            max={1}
            clamp
            display={100}
            unit="%"
            defaultValue={1}
            title={t('How much of the picture shows on the front face, projected straight on and lit by the face material (0 = the material alone)')}
          />
          <RefNum
            label={t('Image on edges')}
            refp={styleRefs(layers, 'edgeImage')}
            min={0}
            max={1}
            clamp
            display={100}
            unit="%"
            defaultValue={0}
            title={t("How much of the picture shows on the bevel bands and sides: each edge takes the colour of the picture at its outline, lit by that part's material (0 = the materials alone)")}
          />
        </>
      )}
    </Material3DSection>
  );
}

/** The straight side walls of the extrusion: their material, then their depth (shown in the cross-section of a single title). */
export function SideEditor({ layers, id = 'part' }: { layers: readonly Title3DLayer[]; id?: string }) {
  const t = useT();
  const st = layers[0].style3d;
  return (
    <>
      <Material3DSection id={`${id}-material`} title={t('Material')} refp={styleRefs(layers, 'side')} mat={st.side} defaultOpen />
      <Section id={`${id}-geometry`} title={t('Geometry')}>
        {layers.length === 1 && <BevelPreview st={st} activeSide />}
        {layers.some((l) => l.style3d.mode === 'inflate') && <div className="hint-line">{t('Inflate mode: the side wall is the inflated rim, its depth still applies.')}</div>}
        <RefNum label={t('Depth')} refp={styleRefs(layers, 'depth')} min={0} max={100} step={0.1} unit="%" title={t('Straight side-wall depth')} />
      </Section>
    </>
  );
}

/** Bevel bands, one or several edited together: their material, then their cross-section (shown in the bevel preview for a single band). */
export function BandEditor({ bands, id = 'part' }: { bands: readonly Stack3DTarget[]; id?: string }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const { layer, index } = bands[0];
  const st = layer.style3d;
  const band = st.bands[index];
  const refp = refsOf(bands.map((b) => styleRef(b.layer, 'bands', b.index)));
  const profile = useRefValue(sub(refp, 'profile'));
  return (
    <>
      <Material3DSection id={`${id}-material`} title={t('Material')} refp={sub(refp, 'material')} mat={band.material} defaultOpen />
      <Section id={`${id}-geometry`} title={t('Geometry')}>
        {bands.length === 1 && <BevelPreview st={st} activeBand={index} />}
        {bands.some((b) => b.layer.style3d.mode === 'inflate') && <div className="hint-line">{t('Inflate mode: the puffy front replaces the bands (they apply again in Extrude).')}</div>}
        <RefNum label={t('Width')} refp={sub(refp, 'width')} min={0} max={10} step={0.05} unit="%" title={t('Extent in the outline plane')} />
        <RefNum label={t('Depth')} refp={sub(refp, 'depth')} min={0} max={10} step={0.05} unit="%" title={t('Extent in z')} />
        <IconChoice label={t('Profile')} value={band.profile} mixed={profile.mixed} options={tOpts(t, PROFILE_OPTIONS)} onChange={(v) => setAt(sub(refp, 'profile'), v)} />
        <RefNum label={t('Segments')} refp={sub(refp, 'segments')} min={1} max={24} integer clamp defaultValue={6} title={t(SEGMENTS_TIP)} />
        <RefNum label={t('Curve')} refp={sub(refp, 'curve')} min={-1} max={1} step={0.01} clamp defaultValue={0} title={t(CURVE_TIP)} />
      </Section>
    </>
  );
}

/**
 * Backplates (外枠), one or several edited together: their front and edge materials, then their
 * geometry (outline growth and shape, their own extrusion, and their bevel with the bands'
 * Profile / Segments / Curve names). Shape-specific rows show while every plate has that shape.
 */
export function PlateEditor({ plates, id = 'part' }: { plates: readonly Stack3DTarget[]; id?: string }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const { layer, index } = plates[0];
  const st = layer.style3d;
  const plate = st.backplates[index];
  const refp = refsOf(plates.map((p) => styleRef(p.layer, 'backplates', p.index)));
  const shapeRef = sub(refp, 'plate');
  const shape = useRefValue(sub(shapeRef, 'kind'));
  const join = useRefValue(sub(refp, 'join'));
  const profile = useRefValue(sub(refp, 'bevel', 'profile'));
  const kind = shape.mixed ? null : (shape.value as PlateShape['kind']);
  const hidden = plates.length === 1 ? plateHidden(plate) : null;
  return (
    <>
      <Material3DSection id={`${id}-material`} title={t('Front material')} refp={sub(refp, 'face')} mat={plate.face} defaultOpen note={hidden ? t(hidden) : undefined} />
      <Material3DSection id={`${id}-material-edge`} title={t('Edge material')} refp={sub(refp, 'side')} mat={plate.side} defaultOpen />
      <Section id={`${id}-geometry`} title={t('Geometry')}>
        {plates.length === 1 && <BevelPreview st={st} activePlate={index} />}
        <RefNum label={t('Grow')} refp={sub(refp, 'grow')} min={0} max={15} step={0.05} unit="%" title={t('Outline growth beyond the previous plate')} />
        <IconChoice label={t('Shape')} value={plate.plate.kind} mixed={shape.mixed} options={tOpts(t, PLATE_OPTIONS)} onChange={(v) => setAt(sub(shapeRef, 'kind'), v)} />
        {kind === 'contour' && (
          <RefNum label={t('Close', undefined, { ctx: 'plate' })} refp={sub(shapeRef, 'close')} min={0} max={10} step={0.05} unit="%" defaultValue={0} title={t('Bridge gaps and notches narrower than about twice this (% of size), so the plate runs as one piece behind the letters')} />
        )}
        {kind === 'box' && (
          <>
            <RefNum label={t('Chamfer')} refp={sub(shapeRef, 'corner')} min={0} max={20} step={0.1} unit="%" defaultValue={4} title={t('Chamfer cut off each corner of the box (% of size)')} />
            <RefNum label={t('Slant')} refp={sub(shapeRef, 'slant')} min={-45} max={45} step={0.5} unit="deg" defaultValue={0} title={t("Lean of the box sides (positive leans right); the text's italic shear is added")} />
          </>
        )}
        <Row label={t('Joins')} title={t('How the plate turns the corners of the letters')}>
          <Seg value={plate.join} mixed={join.mixed} options={tOpts(t, JOINS)} onChange={(v) => setAt(sub(refp, 'join'), v)} />
        </Row>
        <RefCheck label={t('Fill counters')} refp={sub(refp, 'fillCounters')} title={t('Fill the holes of 口, B, O… so the plate is solid')} />
        <RefNum label={t('Depth')} refp={sub(refp, 'depth')} min={0} max={60} step={0.1} unit="%" />
        <RefNum label={t('Z gap')} refp={sub(refp, 'zGap')} min={0} max={20} step={0.1} unit="%" title={t('Gap behind the previous solid')} />
        <div className="sub-head">{t('Bevel')}</div>
        <RefNum label={t('Bevel width')} refp={sub(refp, 'bevel', 'width')} min={0} max={10} step={0.05} unit="%" />
        <RefNum label={t('Bevel depth')} refp={sub(refp, 'bevel', 'depth')} min={0} max={10} step={0.05} unit="%" />
        <IconChoice label={t('Profile')} value={plate.bevel.profile} mixed={profile.mixed} options={tOpts(t, PROFILE_OPTIONS)} onChange={(v) => setAt(sub(refp, 'bevel', 'profile'), v)} />
        <RefNum label={t('Segments')} refp={sub(refp, 'bevel', 'segments')} min={1} max={24} integer clamp defaultValue={6} title={t(SEGMENTS_TIP)} />
        <RefNum label={t('Curve')} refp={sub(refp, 'bevel', 'curve')} min={-1} max={1} step={0.01} clamp defaultValue={0} title={t(CURVE_TIP)} />
      </Section>
    </>
  );
}

/**
 * The 3D shape of titles (the layer node's Shape section): extrude or inflate, depth, the inflate
 * profile, outline detail, skew, and the bevel bands as a compact list (width, depth, profile;
 * the name opens the band part) with their position and cross-section. GLB models have none.
 * Several layers (a multi-selection) edit together; their bands are listed by position, as far
 * as every layer has that band.
 */
export function Shape3DSection({ layers }: { layers: readonly Title3DLayer[] }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const layer = layers[0];
  const single = layers.length === 1;
  const st = layer.style3d;
  const base = styleRefs(layers);
  const profileRef = sub(base, 'inflate', 'profile');
  const inflate = st.mode === 'inflate';
  const [modeMixed, profileMixed, positionMixed] = useMixed(sub(base, 'mode'), profileRef, sub(base, 'bevelPosition'));
  const bands = Math.min(...layers.map((l) => l.style3d.bands.length));
  const title = layers.every((l) => l.source.kind === 'shape') ? t('3D shape') : t('Shape', undefined, { ctx: '3d' });
  return (
    <Section id="shape3d" title={single ? title : `${title} · ${t('{n} layers', { n: layers.length })}`}>
      <Row label={t('Mode')} title={t('How the front is built')}>
        <Seg value={st.mode} mixed={modeMixed} options={tOpts(t, MODES)} onChange={(v) => setAt(sub(base, 'mode'), v)} />
      </Row>
      <RefNum label={t('Depth')} refp={sub(base, 'depth')} min={0} max={100} step={0.1} unit="%" title={t('Extrusion depth: the straight side wall, % of size')} />
      {inflate && (
        <>
          <RefNum label={t('Height')} refp={sub(base, 'inflate', 'height')} min={0} max={60} step={0.1} unit="%" defaultValue={12} title={t('How far the surface rises above its outline at the top of the profile (% of size)')} />
          <CurveEditor
            id={refKey(profileRef)}
            label={t('Inflate profile')}
            value={st.inflate.profile}
            mixed={profileMixed}
            presets={INFLATE_PRESETS}
            xLabel={t('Edge → centre')}
            yLabel={t('Height')}
            onChange={(c, k) => setAt(profileRef, c, k)}
          />
          <RefNum
            label={t('Smoothness')}
            refp={sub(base, 'inflate', 'smoothness')}
            min={0}
            max={100}
            step={1}
            defaultValue={0}
            title={t('0 shades the mesh facets. Above 0 the shading follows the exact profile (no ripples on chrome) and the ridge down each stroke rounds off more as it grows.')}
          />
          <RefNum
            label={t('Detail')}
            refp={sub(base, 'inflate', 'detail')}
            min={1}
            max={4}
            integer
            clamp
            defaultValue={1}
            title={t('Density of the height grid. Raise it when the ridges of a chiselled profile zigzag; each step costs render time.')}
          />
        </>
      )}
      <RefNum label={t('Outline detail')} refp={sub(base, 'curveSegments')} min={1} max={32} integer clamp title={t('Smoothness of glyph curves')} />
      <div className="sty-light">
        <SkewPad refp={sub(base, 'skew')} skew={st.skew} />
        <div className="sty-light-nums">
          <RefNum label={t('Skew X')} refp={sub(base, 'skew', 'x')} min={-1} max={1} step={0.01} unit="x" defaultValue={0} title={t('Oblique extrusion: the back shifts right by this × its depth (negative = left)')} />
          <RefNum label={t('Skew Y')} refp={sub(base, 'skew', 'y')} min={-1} max={1} step={0.01} unit="x" defaultValue={0} title={t('Oblique extrusion: the back shifts up by this × its depth (negative = down)')} />
        </div>
      </div>
      <div className="sub-head">{t('Bevel bands ({n})', { n: bands })}</div>
      <Row label={t('Position')} title={t('Where the bevel bands sit on the glyph outline, like the Position of a Photoshop stroke. Backplates grow from the outermost band edge.')}>
        <Seg value={st.bevelPosition} mixed={positionMixed} options={tOpts(t, BEVEL_POSITIONS)} onChange={(v) => setAt(sub(base, 'bevelPosition'), v)} />
      </Row>
      {inflate && <div className="hint-line">{t('Inflate mode: the puffy front replaces the bands (they apply again in Extrude).')}</div>}
      <BandList layers={layers} count={bands} />
      {single && <BevelPreview st={st} />}
    </Section>
  );
}

/** The bevel bands inline, inner to outer: name (opens the band part), width, depth, profile; the first `count`, of every layer of `layers` together. */
function BandList({ layers, count }: { layers: readonly Title3DLayer[]; count: number }) {
  const t = useT();
  if (!count) return null;
  return (
    <div className={`band-list ${layers[0].style3d.mode === 'inflate' ? 'off' : ''}`} role="table" aria-label={t('Bevel bands')}>
      <div className="band-row head" role="row">
        <span role="columnheader" />
        <span role="columnheader" title={t('Extent in the outline plane')}>
          {t('Width')}
        </span>
        <span role="columnheader" title={t('Extent in z')}>
          {t('Depth')}
        </span>
        <span role="columnheader">{t('Profile')}</span>
      </div>
      {layers[0].style3d.bands.slice(0, count).map((band, i) => (
        <BandListRow key={band.id} layers={layers} index={i} />
      ))}
    </div>
  );
}

/** Band `index` of every layer of `layers` as one row of BandList (one layer: its name opens the band part). */
function BandListRow({ layers, index }: { layers: readonly Title3DLayer[]; index: number }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const setEachAt = useEditor((s) => s.setEachAt);
  const selectNode = useEditor((s) => s.selectNode);
  const layer = layers[0];
  const band = layer.style3d.bands[index];
  const refp = styleRefs(layers, 'bands', index);
  const [widthMixed, depthMixed, profileMixed] = useMixed(sub(refp, 'width'), sub(refp, 'depth'), sub(refp, 'profile'));
  const part = bandKey(band.id);
  const name = formatMsg(partLabel(layer, part), t);
  const profile = profileMixed ? undefined : PROFILE_OPTIONS.find((p) => p.value === band.profile);
  const shift = (key: 'width' | 'depth') => (d: number, c: string) => setEachAt(sub(refp, key), (v) => Math.max(0, (typeof v === 'number' ? v : 0) + d), c);
  return (
    <div className="band-row" role="row">
      {layers.length === 1 ? (
        <button className="link band-name" role="cell" title={t('Edit {part}: material, segments and curve', { part: name })} onClick={() => selectNode({ kind: 'part', layerId: layer.id, part })}>
          {name}
        </button>
      ) : (
        <span className="band-name" role="cell" title={t('{part} of the {n} layers', { part: name, n: layers.length })}>
          {name}
        </span>
      )}
      <span role="cell">
        <NumberField
          id={refKey(sub(refp, 'width'))}
          label={t('{part} width', { part: name })}
          value={band.width}
          mixed={widthMixed}
          onOffset={shift('width')}
          min={0}
          max={10}
          step={0.05}
          unit="%"
          slider={false}
          onChange={(v, c) => setAt(sub(refp, 'width'), v, c)}
        />
      </span>
      <span role="cell">
        <NumberField
          id={refKey(sub(refp, 'depth'))}
          label={t('{part} depth', { part: name })}
          value={band.depth}
          mixed={depthMixed}
          onOffset={shift('depth')}
          min={0}
          max={10}
          step={0.05}
          unit="%"
          slider={false}
          onChange={(v, c) => setAt(sub(refp, 'depth'), v, c)}
        />
      </span>
      <span role="cell">
        <Menu
          className="band-profile"
          label={profile?.icon ?? (profileMixed ? '—' : band.profile)}
          title={t('{part} profile: {profile}', { part: name, profile: profileMixed ? '—' : t(profile?.label ?? band.profile) })}
          items={PROFILE_OPTIONS.map((p) => ({
            label: (
              <span className="band-profile-item">
                {p.icon} {t(p.label)}
              </span>
            ),
            onClick: () => setAt(sub(refp, 'profile'), p.value),
          }))}
        />
      </span>
    </div>
  );
}

/**
 * Render passes of 3D titles, collapsed in one section: glint, ambient occlusion, shadow catcher.
 * Several layers (a multi-selection) edit together; the title lists the passes any of them has on.
 */
export function RenderPassesSection({ layers }: { layers: readonly Title3DLayer[] }) {
  const t = useT();
  const any = (pass: 'glint' | 'ao' | 'shadow') => layers.some((l) => l.style3d[pass].enabled);
  const on = [any('glint') && t('Glint'), any('ao') && t('Ambient occlusion'), any('shadow') && t('Shadow catcher')].filter(Boolean);
  const name = layers.length === 1 ? t('Render passes') : `${t('Render passes')} · ${t('{n} layers', { n: layers.length })}`;
  return (
    <Section id="render-passes" defaultOpen={false} title={on.length ? `${name} · ${on.join(', ')}` : name}>
      <GlintSection refp={styleRefs(layers, 'glint')} glint={layers[0].style3d.glint} />
      <AOSection refp={styleRefs(layers, 'ao')} />
      <ShadowSection refp={styleRefs(layers, 'shadow')} />
    </Section>
  );
}
