import type { ReactNode } from 'react';
import { material3D } from '../../../model/defaults';
import { envKeysSet } from '../../../model/lighting';
import type { GradientSpan, Material3D, MaterialPreset, Surface3D } from '../../../model/types';
import { getRefs, refKey } from '../../../store/paths';
import { useEditor, type Refs } from '../../../store/store';
import { RefChoice, RefColor, RefNum, RefSelect, Section, type Option } from '../../controls';
import { GradientEditor } from '../../GradientEditor';
import { useT } from '../../i18n';
import { oneShot, useMixed } from '../../util';
import { FillKindIcon } from './icons';
import { PatternFields } from './Material2DEditor';
import { material3DClipboard, material3DCss, patternLabel, PRESET_LABELS, presetLabel, sub, tOpts } from './shared';
import { PartReflections } from './Lighting3D';
import { MaterialLink } from './MaterialLink';
import { ClipActions, ColorAmountRow, GroupTitle, SwatchTitle } from './widgets';

const PRESETS = Object.keys(PRESET_LABELS) as MaterialPreset[];

/** Colour type, as the 2D fill's Type: a solid colour (no `gradient`) or a gradient of `gradientKind`. */
type ColourType = 'solid' | Material3D['gradientKind'];
const colourTypeOf = (m: Material3D): ColourType => (m.gradient ? m.gradientKind : 'solid');

const COLOUR_TYPES: readonly { value: ColourType; label: string; title: string }[] = [
  { value: 'solid', label: 'Solid', title: 'Solid colour' },
  { value: 'linear', label: 'Linear', title: 'Linear: a straight ramp along the angle' },
  { value: 'radial', label: 'Radial', title: 'Radial: first stop at the centre, last stop at the corners' },
  { value: 'reflected', label: 'Reflected', title: 'Reflected: first stop along the centre line, mirrored to both edges' },
];
const COLOUR_TYPE_OPTIONS = COLOUR_TYPES.map((k) => ({ ...k, icon: <FillKindIcon kind={k.value} /> }));

const GRAD_SPANS: Option<GradientSpan>[] = [
  { value: 'layer', label: 'Layer', title: 'One ramp across the whole part (every line together)' },
  { value: 'line', label: 'Line', title: 'Every text line (column when vertical) gets the full ramp: a 2-line 虹 title shows the whole spectrum on both lines' },
  { value: 'char', label: 'Char', title: 'Every character gets the full ramp over its own box' },
];

const GRAD_AXES: Option<Material3D['gradientAxis']>[] = [
  { value: 'xy', label: 'Across', title: 'The ramp runs across the letters in the layer plane (type, angle and span apply)' },
  { value: 'depth', label: 'Depth', title: 'The ramp runs front → back along the extrusion: first stop at the front, last at the back (side walls fading red → black)' },
];

const SURFACES: Option<Surface3D['kind']>[] = [
  { value: 'none', label: 'Smooth', title: 'Smooth surface: clean mirror reflections' },
  { value: 'crumple', label: 'Crumple', title: 'Crumpled foil: sharp angular facets that break reflections into shards' },
  { value: 'hammered', label: 'Hammered', title: 'Hammered metal: overlapping round dents, each with its own highlight' },
  { value: 'liquid', label: 'Liquid', title: 'Liquid gold: big smooth warped ripples that pour the reflections across the face' },
];

/**
 * Body of a PBR material editor (Element 3D material), laid out like the 2D material: the
 * essentials always show (preset, colour or gradient, metalness, roughness, env mult., opacity),
 * then the groups Reflections, Glass, Pattern, Finish and Glow. A group header lists what is on
 * inside it, and a feature's extra rows show only while it is on. `refp` addresses the
 * Material3D (or several, edited together: `mat` is the first one's and differing values show
 * “—”); `id` prefixes the groups' remembered open state.
 */
function Material3DFields({ id, refp, mat }: { id: string; refp: Refs; mat: Material3D }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const setEachAt = useEditor((s) => s.setEachAt);
  const r = (key: keyof Material3D) => sub(refp, key);
  const [gradMixed] = useMixed(r('gradient'));
  const ownEnv = envKeysSet(mat.environment).length;
  // Solid drops the gradient; a gradient type adds one (white → the colour) where there is none, in one undo step.
  const pickColourType = (v: ColourType) => {
    if (v === 'solid') {
      setEachAt(refp, (m) => {
        const next = { ...(m as Material3D) };
        delete next.gradient;
        return next;
      });
      return;
    }
    const k = oneShot(refKey(r('gradientKind')));
    const mats = getRefs(useEditor.getState().project, refp) as Material3D[];
    if (mats.some((m) => !m.gradient)) setEachAt(r('gradient'), (g, i) => g ?? { stops: [{ pos: 0, color: '#ffffff' }, { pos: 1, color: mats[i].color }] }, k);
    setAt(r('gradientKind'), v, k);
  };
  const surfaceLabel = t(SURFACES.find((s) => s.value === mat.surface.kind)?.label ?? mat.surface.kind, undefined, { ctx: 'surface' });
  const glassOn = [...(mat.transmission > 0 ? [t('Gem / glass')] : []), ...(mat.glassDepth > 0 ? [t('Glass depth')] : [])];
  const finishOn = [
    ...(mat.surface.kind !== 'none' ? [surfaceLabel] : []),
    ...(mat.flakes > 0 ? [t('Flakes')] : []),
    ...(mat.clearcoat > 0 ? [t('Clearcoat')] : []),
    ...(mat.iridescence > 0 ? [t('Iridescence')] : []),
  ];
  return (
    <>
      <RefSelect label={t('Preset')} refp={r('preset')} options={PRESETS.map((value) => ({ value, label: presetLabel(t, value) }))} pick={(p) => setAt(refp, material3D(p))} />
      <RefChoice label={t('Type')} refp={refp} options={tOpts(t, COLOUR_TYPE_OPTIONS)} read={(m) => colourTypeOf(m as Material3D)} pick={pickColourType} icons />
      {!mat.gradient ? (
        <RefColor label={t('Colour')} refp={r('color')} />
      ) : (
        <>
          <GradientEditor id={refKey(r('gradient'))} value={mat.gradient} mixed={gradMixed} onChange={(g, c) => setAt(r('gradient'), g, c)} />
          <RefChoice label={t('Axis')} title={t('Which way the ramp runs: across the letters, or front → back along the extrusion')} group={t('Gradient axis')} refp={r('gradientAxis')} options={tOpts(t, GRAD_AXES)} />
          {mat.gradientAxis === 'xy' && (
            <>
              <RefChoice
                label={t('Span')}
                title={t('What one full ramp covers (Photoshop “Align with Layer”, Element 3D “Use Layer as UV”)')}
                group={t('Gradient span')}
                refp={r('gradientSpan')}
                options={tOpts(t, GRAD_SPANS)}
              />
              {mat.gradientKind !== 'radial' && (
                <RefNum label={t('Angle')} refp={r('gradientAngle')} min={0} max={360} step={1} unit="deg" defaultValue={90} title={t('Direction of the ramp: 90° = top → bottom on screen, 0° = left → right')} />
              )}
              <RefNum
                label={t('Bend')}
                refp={r('gradientBend')}
                min={-1}
                max={1}
                step={0.01}
                clamp
                defaultValue={0}
                title={t('The ramp bends with the surface like light through a glass dome: slopes see further along it, edges back toward its start, so a band glows as a core inside its neighbour (0 = flat)')}
              />
            </>
          )}
          <RefNum
            label={t('Scale')}
            refp={r('gradientScale')}
            min={0.1}
            max={3}
            step={0.01}
            unit="x"
            defaultValue={1}
            title={
              mat.gradientAxis === 'depth'
                ? t('Ramp length relative to the part depth, from the front (0.5× = the last colour from half the depth on)')
                : t('Ramp length relative to the span box (1× = exactly the box; smaller repeats the end colours)')
            }
          />
          <RefNum
            label={t('Offset')}
            refp={r('gradientOffset')}
            min={-1}
            max={1}
            clamp
            display={100}
            unit="%"
            defaultValue={0}
            title={mat.gradientAxis === 'depth' ? t('Shift the ramp along the depth, % of the part depth') : t('Shift the ramp along its axis, % of the span box')}
          />
        </>
      )}
      <RefNum label={t('Metalness')} refp={r('metalness')} min={0} max={1} clamp display={100} unit="%" />
      <RefNum label={t('Roughness')} refp={r('roughness')} min={0} max={1} clamp display={100} unit="%" />
      <RefNum
        label={t('Env mult.')}
        refp={r('reflectivity')}
        min={0}
        max={4}
        clamp
        unit="x"
        title={t('Element 3D Environment Multiplier: reflection strength (1 = physically based; push to 2+ for 遊技機 gold)')}
      />
      <RefNum label={t('Material opacity')} refp={r('opacity')} min={0} max={1} clamp display={100} unit="%" defaultValue={1} title={t("Opacity of this part's material (the layer's own opacity is in the Layers panel)")} />

      <Section id={`${id}.reflections`} title={<GroupTitle name={t('Reflections')} on={ownEnv ? [t('{n} own environment values', { n: ownEnv })] : []} />} defaultOpen={ownEnv > 0}>
        <RefNum label={t('Spec mult.')} refp={r('specBoost')} min={0} max={4} clamp unit="x" title={t('Element 3D Specular Multiplier: strength of direct-light highlights (1 = physical)')} />
        <div className="sub-head" title={t('Each value is the layer’s unless this part sets its own (a candy face mirroring softbox windows inside gold rims mirroring a street); lights and tone mapping stay the layer’s')}>
          {t('Environment (3D reflections)')}
        </div>
        <PartReflections refp={refp} />
      </Section>

      <Section id={`${id}.glass`} title={<GroupTitle name={t('Glass')} on={glassOn} />} defaultOpen={glassOn.length > 0}>
        <RefNum label={t('Gem / glass')} refp={r('transmission')} min={0} max={1} clamp display={100} unit="%" title={t('Transmission: light passes through the body (gems, crystal)')} />
        {mat.transmission > 0 && (
          <>
            <RefNum label={t('IOR')} refp={r('ior')} min={1} max={2.333} step={0.01} clamp title={t('Index of refraction: glass 1.5, sapphire 1.77, diamond 2.42 (max 2.333)')} />
            <RefNum label={t('Dispersion')} refp={r('dispersion')} min={0} max={1} clamp display={100} unit="%" title={t('Rainbow fire: refraction splits into colours')} />
          </>
        )}
        <RefNum
          label={t('Glass depth')}
          refp={r('glassDepth')}
          min={0}
          max={1}
          clamp
          display={100}
          unit="%"
          title={t('Coloured glass: the colour deepens and darkens where the surface turns away (a longer path through the glass) and clears in the facing core')}
        />
      </Section>

      <Section id={`${id}.pattern`} title={<GroupTitle name={t('Pattern (柄)')} on={mat.pattern.kind === 'none' ? [] : [patternLabel(t, mat.pattern.kind)]} />} defaultOpen={mat.pattern.kind !== 'none'}>
        <PatternFields refp={r('pattern')} pat={mat.pattern} />
        <div className="hint-line">{t('Projected front-on. Relief bumps the surface (和柄 in the bump slot: low relief, opacity 0).')}</div>
      </Section>

      <Section id={`${id}.finish`} title={<GroupTitle name={t('Finish')} on={finishOn} />} defaultOpen={finishOn.length > 0}>
        <RefChoice
          label={t('Surface')}
          title={t('Bend the surface so reflections warp: crumpled foil, hammered metal or liquid gold (projected front-on, like the pattern)')}
          group={t('Surface relief')}
          refp={sub(refp, 'surface', 'kind')}
          options={tOpts(t, SURFACES, 'surface')}
          pick={(v) => setEachAt(r('surface'), (s) => ({ ...(s as Surface3D), kind: v }))}
        />
        {mat.surface.kind !== 'none' && (
          <>
            <RefNum label={t('Strength')} refp={sub(refp, 'surface', 'amount')} min={0} max={1} clamp display={100} unit="%" title={t('How far the surface bends: low = subtle shimmer, high = wild reflections')} />
            <RefNum label={t('Feature size')} refp={sub(refp, 'surface', 'scale')} min={1} max={200} step={0.5} clamp unit="%" title={t('Size of the facets / dents / ripples, % of the source size')} />
            <RefNum label={t('Seed')} refp={sub(refp, 'surface', 'seed')} min={0} max={9999} integer clamp title={t('Variation: a different random layout of the same surface')} />
          </>
        )}
        <RefNum label={t('Flakes')} refp={r('flakes')} min={0} max={1} clamp display={100} unit="%" title={t('Metallic glitter: tiny tilted flakes that sparkle in the light')} />
        {mat.flakes > 0 && <RefNum label={t('Flake size')} refp={r('flakeScale')} min={0.05} max={5} step={0.05} clamp unit="%" title={t('% of the source size')} />}
        <RefNum label={t('Clearcoat')} refp={r('clearcoat')} min={0} max={1} clamp display={100} unit="%" />
        <RefNum label={t('Iridescence')} refp={r('iridescence')} min={0} max={1} clamp display={100} unit="%" />
      </Section>

      <Section id={`${id}.glow`} title={<GroupTitle name={t('Glow')} on={mat.emissiveIntensity > 0 ? [t('Emissive')] : []} />} defaultOpen={mat.emissiveIntensity > 0}>
        <ColorAmountRow label={t('Emissive')} colorRef={r('emissive')} amountRef={r('emissiveIntensity')} max={10} display={1} unit="x" />
      </Section>
    </>
  );
}

/**
 * Collapsible material section with a swatch + preset name in the header and copy/paste. `id`
 * keys its remembered open state and prefixes its groups' (unique on the page); `title` and
 * `note` are shown as given (translated by the caller); `children` are rows of the part shown
 * above the material fields. Several targets (`refp` a list, `mat` the first one's): a
 * striped swatch and “—” for a preset when they differ.
 */
export function Material3DSection({
  id,
  title,
  refp,
  mat,
  defaultOpen = false,
  note,
  children,
}: {
  id: string;
  title: string;
  refp: Refs;
  mat: Material3D;
  defaultOpen?: boolean;
  note?: string;
  children?: ReactNode;
}) {
  const t = useT();
  const [matMixed, presetMixed] = useMixed(refp, sub(refp, 'preset'));
  return (
    <Section
      id={id}
      defaultOpen={defaultOpen}
      title={
        <SwatchTitle css={material3DCss(mat)} mixed={matMixed}>
          {title} <span className="muted">· {presetMixed ? '—' : presetLabel(t, mat.preset)}</span>
        </SwatchTitle>
      }
      actions={
        <>
          <MaterialLink refp={refp} kind="3d" />
          <ClipActions clip={material3DClipboard} value={mat} refp={refp} />
        </>
      }
    >
      {note && <div className="hint-line">{note}</div>}
      {children}
      <Material3DFields id={id} refp={refp} mat={mat} />
    </Section>
  );
}
