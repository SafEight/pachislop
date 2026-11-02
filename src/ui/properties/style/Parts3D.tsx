import { useRef } from 'react';
import { bandSide, sideMaterial } from '../../../model/bands';
import type { Band3D, BevelProfile3D, Material3D, PlateShape, Title3DLayer, Title3DProps } from '../../../model/types';
import { refKey } from '../../../store/paths';
import { useEditor, type PropRef, type Refs } from '../../../store/store';
import { RefCheck, RefChoice, RefColor, RefNum, Row, Section } from '../../controls';
import { useOpenSection } from '../../sectionMemory';
import { useT } from '../../i18n';
import { oneShot, useGesture, useMixed, useRefValue } from '../../util';
import { BevelPreview } from './BevelPreview';
import { CurveEditor } from './CurveEditor';
import { PlateIcon, Profile3DIcon } from './icons';
import { Material3DSection } from './Material3DEditor';
import { ownBandSides, ownSides, refsOf } from '../parts';
import { material3DCss, sub, tOpts } from './shared';
import { SwatchTitle } from './widgets';

// Element 3D replacement split by part (model/bands.ts): the letter's face (its material covers
// the face, bevel and side walls), its side walls while they have a material of their own, and
// each band (a whole extruded outline copy stacked behind) get their own editor (Properties ›
// part node). What belongs to no part sits on the layer node: its Shape section (extrude /
// inflate, the letter's depth and bevel, skew) and its Render passes (AO, shadow catcher; the
// glint is listed as an effect, GlintCard); lighting is Lighting3D's.

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

const BAND_SHAPES: readonly { value: PlateShape['kind']; label: string; title: string }[] = [
  { value: 'contour', label: 'Contour', title: 'The band follows the letters (Close bridges the gaps between them)' },
  { value: 'hull', label: 'Hull', title: 'Convex hull of the whole title: one smooth slab' },
  { value: 'box', label: 'Box', title: 'A box around the title with cut corners, leaning by Slant (北斗 / カバネリ plates); italic text adds its shear' },
];
const SHAPE_OPTIONS = BAND_SHAPES.map((p) => ({ ...p, icon: <PlateIcon kind={p.value} /> }));

const MODES = [
  { value: 'extrude', label: 'Extrude', title: 'Flat face with one bevel and a straight side wall, the bands stacked behind (Element 3D)' },
  { value: 'inflate', label: 'Inflate', title: 'Puffy surface rising from the outline (ぷっくり buttons, 保留 icons); the letter’s bevel is ignored, the bands still apply' },
] as const;

const BEVEL_POSITIONS = [
  { value: 'outside', label: 'Outside', title: 'The bevel grows outward from the glyph outline like a Photoshop stroke: the face keeps the whole letter and a wider bevel fattens the silhouette' },
  { value: 'center', label: 'Center', title: 'The bevel straddles the glyph outline, half inside and half outside' },
  { value: 'inside', label: 'Inside', title: 'The bevel is cut inward from the glyph outline (Element 3D): the silhouette stays put and a wider bevel shrinks the face' },
] as const;

/** A band whose grow adds nothing beyond the solid in front of it is hidden behind it (or disabled). */
function bandHidden(b: Band3D): string | null {
  if (!b.enabled) return 'Disabled: not rendered';
  if (b.grow <= 0) return 'Hidden: no grow beyond the previous solid, so it sits fully behind it. Raise Grow to show it.';
  return null;
}

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

const AO_TIP = 'Ambient occlusion (Element 3D SSAO): darkens the crevices between the letter and its bands, so the stack reads as separate solids.';

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

/** A band of a title, by its index in `style3d.bands`. */
export interface Stack3DTarget {
  layer: Title3DLayer;
  index: number;
}

/**
 * The letter of a 3D title: its material (the face, bevel and, without a side of its own, side
 * walls); on a GLB model the one material applied over the whole model. An image source adds how
 * much of its picture shows on the face and on the letter's bevel and side walls, above the
 * material that lights it. Like every part editor here it renders on the part page or inline
 * under a part row; `id` (default "part") prefixes its sections' remembered open state, unique on
 * the page. `layers`: the titles whose faces are edited together (one for a single part); the
 * model note and image rows show when they apply to all of them.
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
            title={t("How much of the picture shows on the letter's bevel and side walls: each edge takes the colour of the picture at its outline, lit by the letter's material (0 = the materials alone)")}
          />
        </>
      )}
    </Material3DSection>
  );
}

/**
 * A side wall without a material of its own (model/bands.ts), in place of its editor: the section
 * names what it shows over its swatch, and Own gives it a copy to edit on its own.
 */
function InheritedMaterial({ id, title, sameAs, mat, onOwn }: { id: string; title: string; sameAs: string; mat: Material3D; onOwn: () => void }) {
  const t = useT();
  return (
    <Section
      id={id}
      defaultOpen
      title={
        <SwatchTitle css={material3DCss(mat)}>
          {title} <span className="muted">· {sameAs}</span>
        </SwatchTitle>
      }
    >
      <Row label={title} title={t('{source}: editing that material changes this one too. Own gives this one a copy to edit on its own.', { source: sameAs })}>
        <span className="muted">{sameAs}</span>
        <button className="small" onClick={onOwn}>
          {t('Own')}
        </button>
      </Row>
    </Section>
  );
}

/**
 * The letter's straight side walls: their own material (while they have none, what they show,
 * with Own; ✕ hands them back to the face), then the letter's depth (shown in the cross-section
 * of a single title).
 */
export function SideEditor({ layers, id = 'part' }: { layers: readonly Title3DLayer[]; id?: string }) {
  const t = useT();
  const st = layers[0].style3d;
  const inherited = layers.filter((l) => !l.style3d.side);
  return (
    <>
      {inherited.length ? (
        <InheritedMaterial
          id={`${id}-material`}
          title={t('Material')}
          sameAs={inherited.length === layers.length ? t('Same as face') : t('Same as face on {n} of {total} layers', { n: inherited.length, total: layers.length })}
          mat={sideMaterial(inherited[0].style3d)}
          onOwn={() => ownSides(inherited, true)}
        />
      ) : (
        <Material3DSection id={`${id}-material`} title={t('Material')} refp={styleRefs(layers, 'side')} mat={sideMaterial(st)} defaultOpen>
          <Row label={t('Side')} title={t('The side walls show the face material again')}>
            <button className="small" onClick={() => ownSides(layers, false)}>
              ✕ {t('Same as face')}
            </button>
          </Row>
        </Material3DSection>
      )}
      <Section id={`${id}-geometry`} title={t('Geometry')}>
        {layers.length === 1 && <BevelPreview st={st} activeSide />}
        {layers.some((l) => l.style3d.mode === 'inflate') && <div className="hint-line">{t('Inflate mode: the side wall is the inflated rim, its depth still applies.')}</div>}
        <RefNum label={t('Depth')} refp={styleRefs(layers, 'depth')} min={0} max={100} step={0.1} unit="%" title={t("Straight side-wall depth of the letter behind its bevel")} />
      </Section>
    </>
  );
}

/**
 * Bands, one or several edited together: their material first (and their side wall: the band's
 * material, with Own, or one of its own, with ✕), then their geometry: how far they grow beyond
 * the solid in front, their own extrusion and z offset, the base shape they grow from (shape rows
 * show while every band has that shape), joins, counters and their bevel.
 */
export function BandEditor({ bands, id = 'part' }: { bands: readonly Stack3DTarget[]; id?: string }) {
  const t = useT();
  const { layer, index } = bands[0];
  const st = layer.style3d;
  const band = st.bands[index];
  const refp = refsOf(bands.map((b) => styleRef(b.layer, 'bands', b.index)));
  const shapeRef = sub(refp, 'shape');
  const shape = useRefValue(sub(shapeRef, 'kind'));
  const kind = shape.mixed ? null : (shape.value as PlateShape['kind']);
  const hidden = bands.length === 1 ? bandHidden(band) : null;
  const inheritedSides = bands.filter((b) => !b.layer.style3d.bands[b.index].side);
  return (
    <>
      <Material3DSection id={`${id}-material`} title={t('Material')} refp={sub(refp, 'material')} mat={band.material} defaultOpen note={hidden ? t(hidden) : undefined} />
      {inheritedSides.length ? (
        <InheritedMaterial
          id={`${id}-material-side`}
          title={t('Side wall')}
          sameAs={inheritedSides.length === bands.length ? t('Same as band') : t('Same as band on {n} of {total} bands', { n: inheritedSides.length, total: bands.length })}
          mat={band.material}
          onOwn={() => ownBandSides(inheritedSides, true)}
        />
      ) : (
        <Material3DSection id={`${id}-material-side`} title={t('Side wall')} refp={sub(refp, 'side')} mat={bandSide(band)} defaultOpen>
          <Row label={t('Side wall')} title={t("The side wall shows the band's material again")}>
            <button className="small" onClick={() => ownBandSides(bands, false)}>
              ✕ {t('Same as band')}
            </button>
          </Row>
        </Material3DSection>
      )}
      <Section id={`${id}-geometry`} title={t('Geometry')}>
        {bands.length === 1 && <BevelPreview st={st} activeBand={index} />}
        <RefNum label={t('Grow')} refp={sub(refp, 'grow')} min={0} max={15} step={0.05} unit="%" title={t('Outline growth beyond the solid in front of it (the letter or the previous band)')} />
        <RefNum label={t('Depth')} refp={sub(refp, 'depth')} min={0} max={60} step={0.1} unit="%" title={t("Straight side-wall depth behind the band's bevel")} />
        <RefNum
          label={t('Offset')}
          refp={sub(refp, 'offset')}
          min={-60}
          max={20}
          step={0.1}
          unit="%"
          defaultValue={0}
          title={t("Gap behind the previous solid's back (Element 3D Z-Offset); negative slides the band forward, at most to where the previous solid's bevel ends")}
        />
        <RefChoice label={t('Shape')} refp={sub(shapeRef, 'kind')} options={tOpts(t, SHAPE_OPTIONS)} icons />
        {kind === 'contour' && (
          <RefNum label={t('Close', undefined, { ctx: 'plate' })} refp={sub(shapeRef, 'close')} min={0} max={10} step={0.05} unit="%" defaultValue={0} title={t('Bridge gaps and notches narrower than about twice this (% of size), so the band runs as one piece behind the letters')} />
        )}
        {kind === 'box' && (
          <>
            <RefNum label={t('Chamfer')} refp={sub(shapeRef, 'corner')} min={0} max={20} step={0.1} unit="%" defaultValue={4} title={t('Chamfer cut off each corner of the box (% of size)')} />
            <RefNum label={t('Slant')} refp={sub(shapeRef, 'slant')} min={-45} max={45} step={0.5} unit="deg" defaultValue={0} title={t("Lean of the box sides (positive leans right); the text's italic shear is added")} />
          </>
        )}
        <RefChoice label={t('Joins')} title={t('How the band turns the corners of the letters')} refp={sub(refp, 'join')} options={tOpts(t, JOINS)} />
        <RefCheck label={t('Fill counters')} refp={sub(refp, 'fillCounters')} title={t('Fill the holes of 口, B, O… so the band is solid')} />
        <div className="sub-head">{t('Bevel')}</div>
        <RefNum label={t('Bevel width')} refp={sub(refp, 'bevel', 'width')} min={0} max={10} step={0.05} unit="%" title={t("Inward from the band's edge; 0 = no bevel")} />
        <RefNum label={t('Bevel depth')} refp={sub(refp, 'bevel', 'depth')} min={0} max={10} step={0.05} unit="%" title={t('Extent in z')} />
        <RefChoice label={t('Profile')} refp={sub(refp, 'bevel', 'profile')} options={tOpts(t, PROFILE_OPTIONS)} icons />
        <RefNum label={t('Segments')} refp={sub(refp, 'bevel', 'segments')} min={1} max={24} integer clamp defaultValue={6} title={t(SEGMENTS_TIP)} />
        <RefNum label={t('Curve')} refp={sub(refp, 'bevel', 'curve')} min={-1} max={1} step={0.01} clamp defaultValue={0} title={t(CURVE_TIP)} />
      </Section>
    </>
  );
}

/**
 * The 3D shape of titles (the layer node's Shape section): extrude or inflate, the letter's depth,
 * the inflate profile, the letter's one bevel (its cross-section and where it sits on the glyph
 * outline), outline detail, skew, and the cross-section of the letter and its bands. GLB models
 * have none. Several layers (a multi-selection) edit together.
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
  const [profileMixed] = useMixed(profileRef);
  const title = layers.every((l) => l.source.kind === 'shape') ? t('3D shape') : t('Shape', undefined, { ctx: '3d' });
  return (
    <Section id="shape3d" title={single ? title : `${title} · ${t('{n} layers', { n: layers.length })}`}>
      <RefChoice label={t('Mode')} title={t('How the front is built')} refp={sub(base, 'mode')} options={tOpts(t, MODES)} />
      <RefNum label={t('Depth')} refp={sub(base, 'depth')} min={0} max={100} step={0.1} unit="%" title={t("Extrusion depth: the letter's straight side wall behind its bevel, % of size")} />
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
      <div className="sub-head">{t('Bevel')}</div>
      {inflate && <div className="hint-line">{t('Inflate mode: the puffy front replaces the letter’s bevel (it applies again in Extrude); the bands still apply.')}</div>}
      <RefNum label={t('Bevel width')} refp={sub(base, 'bevel', 'width')} min={0} max={10} step={0.05} unit="%" title={t("The letter's bevel across the outline plane (% of size); 0 = a sharp edge. Position sets where it sits.")} />
      <RefNum label={t('Bevel depth')} refp={sub(base, 'bevel', 'depth')} min={0} max={10} step={0.05} unit="%" title={t('Extent in z')} />
      <RefChoice label={t('Profile')} refp={sub(base, 'bevel', 'profile')} options={tOpts(t, PROFILE_OPTIONS)} icons />
      <RefNum label={t('Segments')} refp={sub(base, 'bevel', 'segments')} min={1} max={24} integer clamp defaultValue={6} title={t(SEGMENTS_TIP)} />
      <RefNum label={t('Curve')} refp={sub(base, 'bevel', 'curve')} min={-1} max={1} step={0.01} clamp defaultValue={0} title={t(CURVE_TIP)} />
      <RefChoice
        label={t('Position')}
        title={t("Where the letter's bevel sits on the glyph outline, like the Position of a Photoshop stroke. The bands grow from the letter's silhouette.")}
        refp={sub(base, 'bevelPosition')}
        options={tOpts(t, BEVEL_POSITIONS)}
      />
      {single && <BevelPreview st={st} />}
    </Section>
  );
}

/**
 * Render passes of 3D titles, collapsed in one section: ambient occlusion and the shadow catcher
 * (the glint is an effect card, GlintCard). Several layers (a multi-selection) edit together; the
 * title lists the passes any of them has on.
 */
export function RenderPassesSection({ layers }: { layers: readonly Title3DLayer[] }) {
  const t = useT();
  const any = (pass: 'ao' | 'shadow') => layers.some((l) => l.style3d[pass].enabled);
  const on = [any('ao') && t('Ambient occlusion'), any('shadow') && t('Shadow catcher')].filter(Boolean);
  const name = layers.length === 1 ? t('Render passes') : `${t('Render passes')} · ${t('{n} layers', { n: layers.length })}`;
  return (
    <Section id="render-passes" defaultOpen={false} title={on.length ? `${name} · ${on.join(', ')}` : name}>
      <AOSection refp={styleRefs(layers, 'ao')} />
      <ShadowSection refp={styleRefs(layers, 'shadow')} />
    </Section>
  );
}
