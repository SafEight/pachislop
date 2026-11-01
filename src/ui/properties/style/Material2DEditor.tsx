import { contourPresets, glossCurve, profileCurve, profilePresets, type CurvePreset } from '../../../engine/layer2d/contours';
import { GRADIENTS } from '../../../model/defaults';
import type { Bevel2D, BevelProfile2D, Curve, GlossContour, Material2D, Pattern, PatternKind, ReflectionMap2D, Satin2D, Texture2D } from '../../../model/types';
import { getRefs, refKey } from '../../../store/paths';
import { useEditor, type PropRef, type Refs } from '../../../store/store';
import { IconBtn, NumberField, RefCheck, RefColor, RefNum, RefSelect, Row, Section, Seg } from '../../controls';
import { GradientEditor } from '../../GradientEditor';
import { useT } from '../../i18n';
import { LightSphere } from '../../LightSphere';
import { gradientCss, gradientPresetLabel, oneShot, useMixed } from '../../util';
import { CurveEditor } from './CurveEditor';
import { FillEditor } from './FillEditor';
import { ContourIcon, Profile2DIcon } from './icons';
import { patternLabel, PATTERNS, sub, tOpts } from './shared';
import { ColorAmountRow, FeatureToggle, GroupTitle, IconChoice, ImageAssetPicker } from './widgets';

const PROFILES: readonly { value: BevelProfile2D; label: string }[] = [
  { value: 'smooth', label: 'Smooth' },
  { value: 'button', label: 'Button (rounded)' },
  { value: 'mesa', label: 'Mesa (steep edge, flat top)' },
  { value: 'chamfer', label: 'Chamfer (straight)' },
  { value: 'ridge', label: 'Ridge' },
  { value: 'cove', label: 'Cove (concave)' },
  { value: 'stepped', label: 'Stepped' },
  { value: 'custom', label: 'Custom curve (starts from the current profile)' },
];

const CONTOURS: readonly { value: GlossContour; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'ring', label: 'Ring' },
  { value: 'doubleRing', label: 'Ring – double' },
  { value: 'cove', label: 'Cove – deep' },
  { value: 'roundedSteps', label: 'Rounded steps' },
  { value: 'sawtooth', label: 'Sawtooth' },
  { value: 'custom', label: 'Custom curve (starts from the current contour)' },
];

const SATIN_BLENDS: readonly { value: Satin2D['blend']; label: string }[] = [
  { value: 'multiply', label: 'Multiply' },
  { value: 'normal', label: 'Normal' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
];

const REFLECTION_MAPS: readonly { value: ReflectionMap2D; label: string }[] = [
  { value: 'highway', label: 'Highway (高速道路)' },
  { value: 'city', label: 'City street' },
  { value: 'sky', label: 'Blue sky' },
  { value: 'studio', label: 'Studio softboxes' },
];

const BEVEL_SCALING: readonly { value: Bevel2D['sizeMode']; label: string }[] = [
  { value: 'fixed', label: 'Fixed size' },
  { value: 'fit', label: 'Fit to stroke' },
];

// Built once: fitting the preset curves samples each function a few thousand times.
let presetCache: { contour: CurvePreset[]; profile: CurvePreset[] } | null = null;
const presets = () => (presetCache ??= { contour: contourPresets(), profile: profilePresets() });

const QUICK_RAMPS = ['goldRamp', 'paleGoldRamp', 'silverRamp', 'redRamp', 'blueRamp', 'greenRamp', 'purpleRamp', 'copperRamp'] as const;

const TEXTURES: readonly { value: Texture2D['kind']; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'noise', label: 'Noise' },
  { value: 'sparkle', label: 'Sparkle (glitter)' },
  { value: 'brushed', label: 'Brushed metal' },
  { value: 'hairline', label: 'Hairline (fine brushed lines)' },
  { value: 'spun', label: 'Spun metal (radial)' },
  { value: 'flakes', label: 'Flakes / gold leaf' },
  { value: 'ripple', label: 'Ripple' },
  { value: 'grunge', label: 'Grunge' },
  { value: 'clouds', label: 'Clouds' },
  { value: 'hammered', label: 'Hammered' },
  { value: 'crumple', label: 'Crumpled foil' },
  { value: 'liquid', label: 'Liquid metal' },
];
const TEXTURE_BLENDS: readonly { value: Texture2D['blend']; label: string }[] = [
  { value: 'overlay', label: 'Overlay' },
  { value: 'softLight', label: 'Soft light' },
  { value: 'screen', label: 'Screen' },
  { value: 'multiply', label: 'Multiply' },
];
const TEXTURE_TARGETS: readonly { value: Texture2D['target']; label: string; title: string }[] = [
  { value: 'color', label: 'Colour', title: 'Blend the texture over the shaded colour' },
  {
    value: 'surface',
    label: 'Surface',
    title: 'Bend the surface: the texture joins the bevel height before lighting, gloss contour and metal finish, so metal bands warp (crumpled foil, liquid gold)',
  },
];

/** Kinds that paint color2 (spot / blossom centres, alternate cells). */
const USES_COLOR2: Partial<Record<PatternKind, true>> = { leopard: true, checker: true, hazard: true, sakura: true };

/** The comp's global light (Photoshop "Use Global Light"), addressed from the project root. */
const GLOBAL_LIGHT: PropRef = { layerId: null, path: ['comp', 'globalLight'] };

/**
 * Pattern (柄) controls for a Pattern object at `refp` (shared by the 2D and 3D material
 * editors so both stay identical). Rows only; callers wrap it in their own Section. Over several
 * targets `pat` is the first one's.
 */
export function PatternFields({ refp, pat }: { refp: Refs; pat: Pattern }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const r = (...path: string[]) => sub(refp, ...path);
  const [seedMixed] = useMixed(r('seed'));
  const custom = pat.kind === 'custom';
  return (
    <>
      <RefSelect label={t('Kind')} refp={r('kind')} options={tOpts(t, PATTERNS)} />
      {custom && (
        <ImageAssetPicker
          label={t('Tile')}
          title={t('A tileable image: its brightness (× alpha) is where the marks go, so colourways recolour it')}
          assetId={pat.assetId}
          onPick={(id) => setAt(r('assetId'), id, oneShot(refKey(r('assetId'))))}
        />
      )}
      {pat.kind !== 'none' && (
        <>
          <RefColor label={t('Marks')} refp={r('color')} />
          {USES_COLOR2[pat.kind] && <RefColor label={t('Colour 2')} refp={r('color2')} />}
          <RefNum label={t('Marks opacity')} refp={r('opacity')} min={0} max={1} clamp display={100} unit="%" />
          <RefNum label={t('Scale')} refp={r('scale')} min={1} max={60} step={0.5} unit="%" title={custom ? t('Tile width') : t('Motif size')} />
          <RefNum label={t('Angle')} refp={r('angle')} min={-180} max={180} step={1} unit="deg" title={t('Clockwise on screen')} />
          {!custom && (
            <Row label={t('Seed')}>
              <NumberField id={refKey(r('seed'))} label={t('Seed')} value={pat.seed} mixed={seedMixed} onChange={(v, c) => setAt(r('seed'), v, c)} min={0} max={9999} integer slider={false} />
              <IconBtn title={t('New random seed')} onClick={() => setAt(r('seed'), Math.floor(Math.random() * 10000))}>
                🎲
              </IconBtn>
            </Row>
          )}
          <RefNum label={t('Shade')} refp={r('shade')} min={0} max={1} clamp display={100} unit="%" title={t('How much of the bevel lighting / reflections still shows on the marks')} />
          <RefNum label={t('Relief')} refp={r('relief')} min={0} max={1} clamp display={100} unit="%" title={t('Raise the marks into the surface (embossed)')} />
        </>
      )}
    </>
  );
}

/**
 * One 2D material (a face, a rim, or a Material effect's param), laid out like the 3D material:
 * the essentials always show (fill and fill opacity, then the bevel basics), then the groups
 * Reflections, Glass, Pattern, Finish and Glow. A group header lists what is on inside it, and a
 * feature's rows show only while it is on. `refp` addresses the Material2D, `mat` is its value;
 * `id` prefixes the groups' remembered open state (unique on the page). `fill` false hides the
 * fill (a Material effect shading the layer's own colours) and keeps the fill opacity. Several
 * targets (`refp` a list) edit together: `mat` is the first one's, which decides the rows shown;
 * differing values show “—”.
 */
export function Material2DEditor({ id, refp, mat, fill = true }: { id: string; refp: Refs; mat: Material2D; fill?: boolean }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const setEachAt = useEditor((s) => s.setEachAt);
  const globalLight = useEditor((s) => s.project.comp.globalLight);
  const r = (...path: (string | number)[]) => sub(refp, ...path);
  const { bevel, reflection, finish, pattern, satin, texture, innerGlow, gloss, glass, sheen } = mat;
  const [profileMixed, profileCurveMixed, glossMixed, glossCurveMixed, sizeModeMixed, finishGradMixed, targetMixed, seedMixed, satinContourMixed] = useMixed(
    r('bevel', 'profile'),
    r('bevel', 'profileCurve'),
    r('bevel', 'gloss'),
    r('bevel', 'glossCurve'),
    r('bevel', 'sizeMode'),
    r('finish', 'gradient'),
    r('texture', 'target'),
    r('texture', 'seed'),
    r('satin', 'contour'),
  );
  const textureLabel = t(TEXTURES.find((x) => x.value === texture.kind)?.label ?? texture.kind);
  const finishKey = JSON.stringify(finish.gradient);
  const curveEditor = (cr: Refs, value: Curve, mixed: boolean, label: string, list: CurvePreset[], xLabel?: string, yLabel?: string) => (
    <CurveEditor id={refKey(cr)} label={t(label)} value={value} mixed={mixed} presets={list} xLabel={xLabel && t(xLabel)} yLabel={yLabel && t(yLabel)} onChange={(c, k) => setAt(cr, c, k)} />
  );
  // Choosing 'custom' seeds each target's curve from the preset it used, as one undo step.
  const pickCurve = <K extends 'profile' | 'gloss'>(key: K, curveKey: 'profileCurve' | 'glossCurve', seed: (was: Bevel2D[K]) => Curve, v: Bevel2D[K]) => {
    const k = oneShot(refKey(r('bevel', key)));
    const was = getRefs(useEditor.getState().project, r('bevel', key)) as Bevel2D[K][];
    if (v === 'custom' && was.some((w) => w !== 'custom')) setEachAt(r('bevel', curveKey), (c, i) => (was[i] === 'custom' ? c : seed(was[i])), k);
    setAt(r('bevel', key), v, k);
  };
  const pickProfile = (v: BevelProfile2D) => pickCurve('profile', 'profileCurve', (p) => profileCurve(p), v);
  const pickGloss = (v: GlossContour) => pickCurve('gloss', 'glossCurve', (g) => glossCurve(g), v);
  const profileOptions = tOpts(t, PROFILES).map((p) => ({ ...p, icon: <Profile2DIcon profile={p.value} curve={bevel.profileCurve} /> }));
  const contourOptions = tOpts(t, CONTOURS).map((c) => ({ ...c, icon: <ContourIcon contour={c.value} curve={bevel.glossCurve} /> }));
  // With "Use global light" the sphere and fields edit the comp's light, like Photoshop.
  const bevelLight = bevel.useGlobalLight
    ? { angle: sub(GLOBAL_LIGHT, 'angle') as Refs, altitude: sub(GLOBAL_LIGHT, 'altitude') as Refs, value: globalLight }
    : { angle: r('bevel', 'lightAngle'), altitude: r('bevel', 'lightAltitude'), value: { angle: bevel.lightAngle, altitude: bevel.lightAltitude } };
  /** Names of the features that are on, for a group header. */
  const on = (...features: [string, boolean][]) => features.filter(([, v]) => v).map(([name]) => name);
  const reflectionsOn = on([t('Reflection map'), reflection.enabled], [t('Refraction'), mat.refraction !== 0]);
  const finishOn = on([t('Metal finish'), finish.enabled], [textureLabel, texture.kind !== 'none'], [t('Satin'), satin.enabled], [t('Sheen'), sheen.enabled]);
  const glowOn = on([t('Inner glow'), innerGlow.enabled], [t('Gloss cap (艶)'), gloss.enabled]);

  return (
    <>
      {fill && <FillEditor refp={r('fill')} fill={mat.fill} />}
      <RefNum
        label={t('Fill opacity')}
        refp={r('opacity')}
        min={0}
        max={1}
        clamp
        display={100}
        unit="%"
        defaultValue={1}
        title={t("Photoshop Fill Opacity: fades this element's fill and shading while what lies behind shows through (0% = hollow)")}
      />

      <FeatureToggle label={t('Bevel & emboss')} refp={r('bevel', 'enabled')} />
      {bevel.enabled && (
        <>
          <IconChoice label={t('Profile')} value={bevel.profile} mixed={profileMixed} options={profileOptions} onChange={pickProfile} />
          {bevel.profile === 'custom' && curveEditor(r('bevel', 'profileCurve'), bevel.profileCurve, profileCurveMixed, 'Bevel profile', presets().profile, 'Edge → in', 'Height')}
          <Row label={t('Scaling', undefined, { ctx: 'bevel' })} title={t('Fixed: the bevel reaches the same distance in everywhere. Fit (Eye Candy): a share of each stroke’s own half-thickness, so thin and thick strokes alike dome to their centre (rims become tubes)')}>
            <Seg value={bevel.sizeMode} mixed={sizeModeMixed} options={tOpts(t, BEVEL_SCALING)} onChange={(v) => setAt(r('bevel', 'sizeMode'), v)} />
          </Row>
          {bevel.sizeMode === 'fit' ? (
            <RefNum label={t('Bevel width')} refp={r('bevel', 'fit')} min={5} max={100} step={0.1} clamp unit="%" title={t('Share of the local half-thickness the bevel covers (100 % = to the centre line)')} />
          ) : (
            <RefNum label={t('Size')} refp={r('bevel', 'size')} min={0} max={10} step={0.05} unit="%" title={t('How far the bevel reaches in from the edge')} />
          )}
          <RefNum label={t('Depth')} refp={r('bevel', 'depth')} min={0} max={10} clamp title={t('Strength of the shading (Photoshop depth ÷ 100)')} />
          <div className="sty-light">
            <LightSphere
              id={refKey(bevelLight.angle)}
              label={bevel.useGlobalLight ? t('Global light direction') : t('Bevel light direction')}
              angle={bevelLight.value.angle}
              altitude={bevelLight.value.altitude}
              convention="ccwFromRight"
              onChange={(angle, alt, c) => {
                // Same coalesce key → one undo step per drag for both values.
                setAt(bevelLight.angle, angle, c);
                setAt(bevelLight.altitude, alt, c);
              }}
            />
            <div className="sty-light-nums">
              <RefNum
                label={t('Angle')}
                refp={bevelLight.angle}
                min={0}
                max={360}
                step={1}
                unit="deg"
                title={bevel.useGlobalLight ? t('Direction the light comes from; 120° = upper-left — shared by every bevel, satin and shadow that uses the global light') : t('Direction the light comes from; 120° = upper-left')}
              />
              <RefNum label={t('Altitude')} refp={bevelLight.altitude} min={0} max={90} step={1} clamp unit="deg" title={bevel.useGlobalLight ? t('Global light altitude — shared by every bevel, satin and shadow that uses the global light') : t('Height of the light above the surface')} />
            </div>
          </div>
          <RefCheck label={t('Use global light')} refp={r('bevel', 'useGlobalLight')} title={t("Take the angle and altitude from the comp's global light (one light for every layer style)")} />
          <Section id={`${id}.bevel-shading`} title={t('Bevel shading')} defaultOpen={false}>
            <RefNum label={t('Soften')} refp={r('bevel', 'soften')} min={0} max={5} step={0.05} unit="%" />
            <IconChoice label={t('Gloss contour')} value={bevel.gloss} mixed={glossMixed} options={contourOptions} onChange={pickGloss} />
            {bevel.gloss === 'custom' && curveEditor(r('bevel', 'glossCurve'), bevel.glossCurve, glossCurveMixed, 'Gloss contour', presets().contour)}
            <ColorAmountRow label={t('Highlight', undefined, { ctx: 'bevel' })} colorRef={r('bevel', 'highlightColor')} color={bevel.highlightColor} amountRef={r('bevel', 'highlightOpacity')} amount={bevel.highlightOpacity} />
            <ColorAmountRow label={t('Shadow', undefined, { ctx: 'bevel' })} colorRef={r('bevel', 'shadowColor')} color={bevel.shadowColor} amountRef={r('bevel', 'shadowOpacity')} amount={bevel.shadowOpacity} />
          </Section>
        </>
      )}

      <Section id={`${id}.reflections`} title={<GroupTitle name={t('Reflections')} on={reflectionsOn} />} defaultOpen={reflectionsOn.length > 0}>
        <FeatureToggle label={t('Reflection map')} refp={r('reflection', 'enabled')} title={t('Eye Candy reflection map: the bevel mirrors a photographic panorama')} />
        {reflection.enabled && (
          <>
            <RefSelect label={t('Map')} refp={r('reflection', 'map')} options={tOpts(t, REFLECTION_MAPS)} />
            <RefNum
              label={t('Amount')}
              refp={r('reflection', 'amount')}
              min={0}
              max={1}
              clamp
              display={100}
              unit="%"
              title={t('How much of the fill the reflection replaces (Eye Candy chrome: 100 %); the bevel highlight and shadow still light it')}
            />
            <RefNum label={t('Blur')} refp={r('reflection', 'blur')} min={0} max={100} step={1} clamp title={t('Blur of the reflection map (Eye Candy ぼかし)')} />
            <RefNum label={t('Rotation')} refp={r('reflection', 'rotation')} min={-180} max={180} step={1} unit="deg" title={t('Turns the panorama sideways to choose what the slopes reflect')} />
            <RefNum
              label={t('Keep fill colour')}
              refp={r('reflection', 'colorize')}
              min={0}
              max={1}
              clamp
              display={100}
              unit="%"
              title={t('Tint the reflection with the fill like coloured glass: dark reflections deepen the colour, only the brightest run to white')}
            />
          </>
        )}
        <RefNum
          label={t('Refraction')}
          refp={r('refraction')}
          min={-50}
          max={50}
          step={0.1}
          unit="%"
          defaultValue={0}
          title={t('How far the bevel slopes bend the fill like a lens (glass); negative values mirror, so up-facing slopes show what is above (liquid chrome horizons)')}
        />
      </Section>

      <Section id={`${id}.glass`} title={<GroupTitle name={t('Glass')} on={on([t('Coloured glass'), glass.enabled])} />} defaultOpen={glass.enabled}>
        <FeatureToggle label={t('Coloured glass')} refp={r('glass', 'enabled')} title={t('A tinted, translucent glass body with dark edges and caustic light')} />
        {glass.enabled && (
          <>
            <ColorAmountRow label={t('Colour')} colorRef={r('glass', 'color')} color={glass.color} amountRef={r('glass', 'tint')} amount={glass.tint} />
            <RefNum label={t('Glass opacity')} refp={r('glass', 'opacity')} min={0} max={1} clamp display={100} unit="%" title={t('Opacity of the glass body; edges, caustics and highlights stay more opaque')} />
            <RefNum label={t('Edge darkening')} refp={r('glass', 'edge')} min={0} max={1} clamp display={100} unit="%" title={t('Dark Fresnel rim on the steep bevel slopes')} />
            <RefNum label={t('Caustic')} refp={r('glass', 'caustic')} min={0} max={2} clamp display={100} unit="%" title={t('Light focused into a glowing band inside the far edge, and the inner body glow (needs the bevel)')} />
          </>
        )}
      </Section>

      <Section id={`${id}.pattern`} title={<GroupTitle name={t('Pattern (柄)')} on={pattern.kind === 'none' ? [] : [patternLabel(t, pattern.kind)]} />} defaultOpen={pattern.kind !== 'none'}>
        <PatternFields refp={r('pattern')} pat={pattern} />
      </Section>

      <Section id={`${id}.finish`} title={<GroupTitle name={t('Finish')} on={finishOn} />} defaultOpen={finishOn.length > 0}>
        <FeatureToggle label={t('Metal finish')} refp={r('finish', 'enabled')} title={t('Gradient map: the shaded light and dark run through a metal ramp (gold, silver…)')} />
        <Row label={t('Ramp')} className="sty-ramps" title={t('A click turns the metal finish on with that ramp')}>
          {QUICK_RAMPS.map((name) => (
            <button
              key={name}
              className={`sty-ramp ${finish.enabled && JSON.stringify(GRADIENTS[name]) === finishKey ? 'on' : ''}`}
              title={gradientPresetLabel(t, name)}
              style={{ background: gradientCss(GRADIENTS[name]) }}
              onClick={() => setEachAt(r('finish'), (f) => ({ ...(f as Material2D['finish']), enabled: true, gradient: structuredClone(GRADIENTS[name]) }))}
            />
          ))}
        </Row>
        {finish.enabled && (
          <>
            <GradientEditor id={refKey(r('finish', 'gradient'))} value={finish.gradient} mixed={finishGradMixed} presets={(n) => n.endsWith('Ramp')} onChange={(g, c) => setAt(r('finish', 'gradient'), g, c)} />
            <RefNum label={t('Amount')} refp={r('finish', 'amount')} min={0} max={1} clamp display={100} unit="%" />
          </>
        )}

        <RefSelect label={t('Texture')} refp={r('texture', 'kind')} options={tOpts(t, TEXTURES)} />
        {texture.kind !== 'none' && (
          <>
            <Row label={t('Applies to')} title={t('Colour blend, or a bumped surface that bends the lighting and metal bands')}>
              <Seg value={texture.target} mixed={targetMixed} options={tOpts(t, TEXTURE_TARGETS)} onChange={(v) => setAt(r('texture', 'target'), v)} />
            </Row>
            <RefNum
              label={t('Amount')}
              refp={r('texture', 'amount')}
              min={0}
              max={1}
              clamp
              display={100}
              unit="%"
              title={texture.target === 'surface' ? t('Bump strength (how steeply the surface bends)') : t('Blend strength')}
            />
            <RefNum label={t('Scale')} refp={r('texture', 'scale')} min={0.5} max={100} step={0.1} unit="%" title={t('Feature size (liquid metal reads best around 30–60 %)')} />
            <RefNum label={t('Angle')} refp={r('texture', 'angle')} min={-180} max={180} step={1} unit="deg" defaultValue={0} title={t('Direction of the grain (brushed and hairline lines), counter-clockwise; turns every kind')} />
            {texture.target === 'color' && <RefSelect label={t('Blend')} refp={r('texture', 'blend')} options={tOpts(t, TEXTURE_BLENDS)} />}
            <Row label={t('Seed')}>
              <NumberField id={refKey(r('texture', 'seed'))} label={t('Texture seed')} value={texture.seed} mixed={seedMixed} onChange={(v, c) => setAt(r('texture', 'seed'), v, c)} min={0} max={9999} integer slider={false} />
              <IconBtn title={t('New random seed')} onClick={() => setAt(r('texture', 'seed'), Math.floor(Math.random() * 10000))}>
                🎲
              </IconBtn>
            </Row>
          </>
        )}

        <FeatureToggle label={t('Satin')} refp={r('satin', 'enabled')} />
        {satin.enabled && (
          <>
            <ColorAmountRow label={t('Colour')} colorRef={r('satin', 'color')} color={satin.color} amountRef={r('satin', 'opacity')} amount={satin.opacity} />
            <RefSelect label={t('Blend')} refp={r('satin', 'blend')} options={tOpts(t, SATIN_BLENDS)} />
            <RefNum
              label={t('Angle')}
              refp={satin.useGlobalLight ? sub(GLOBAL_LIGHT, 'angle') : r('satin', 'angle')}
              min={-180}
              max={180}
              step={1}
              unit="deg"
              title={
                satin.useGlobalLight
                  ? t('Direction of the offset copies (counter-clockwise from right, like Photoshop) — shared by every bevel, satin and shadow that uses the global light')
                  : t('Direction of the offset copies (counter-clockwise from right, like Photoshop)')
              }
            />
            <RefCheck label={t('Use global light')} refp={r('satin', 'useGlobalLight')} title={t("Take the satin angle from the comp's global light")} />
            <RefNum label={t('Distance')} refp={r('satin', 'distance')} min={0} max={20} step={0.1} unit="%" title={t('How far the two silhouette copies are shifted')} />
            <RefNum label={t('Size')} refp={r('satin', 'size')} min={0} max={20} step={0.1} unit="%" title={t('Blur of the silhouette copies')} />
            <div className="sub-head" title={t('Maps the difference of the two shifted copies to satin strength')}>
              {t('Contour')}
            </div>
            {curveEditor(r('satin', 'contour'), satin.contour, satinContourMixed, 'Satin contour', presets().contour)}
            <RefCheck label={t('Invert')} refp={r('satin', 'invert')} title={t("Invert the contour (Photoshop's default: colour where the copies agree)")} />
          </>
        )}

        <FeatureToggle label={t('Sheen')} refp={r('sheen', 'enabled')} title={t('Runs across the texture’s grain direction; spun and flake textures shape it their own way.')} />
        {sheen.enabled && (
          <>
            <ColorAmountRow label={t('Colour')} colorRef={r('sheen', 'color')} color={sheen.color} amountRef={r('sheen', 'amount')} amount={sheen.amount} max={3} />
            <RefNum
              label={t('Position')}
              refp={r('sheen', 'position')}
              min={-1}
              max={1}
              clamp
              display={100}
              unit="%"
              title={t('Where the sheen band sits across the element (spun metal: turns the lobes; flakes: moves the light)')}
            />
            <RefNum label={t('Width')} refp={r('sheen', 'width')} min={0.05} max={2} clamp display={100} unit="%" title={t('Band width, as a share of the element’s half size')} />
          </>
        )}
      </Section>

      <Section id={`${id}.glow`} title={<GroupTitle name={t('Glow')} on={glowOn} />} defaultOpen={glowOn.length > 0}>
        <FeatureToggle label={t('Inner glow')} refp={r('innerGlow', 'enabled')} />
        {innerGlow.enabled && (
          <>
            <RefColor label={t('Colour')} refp={r('innerGlow', 'color')} />
            <RefNum label={t('Size')} refp={r('innerGlow', 'size')} min={0} max={10} step={0.05} unit="%" />
            <RefNum label={t('Opacity')} refp={r('innerGlow', 'opacity')} min={0} max={1} clamp display={100} unit="%" />
            <RefNum label={t('Grit')} refp={r('innerGlow', 'noise')} min={0} max={1} clamp display={100} unit="%" title={t('Noise (ジャリジャリ sparkle)')} />
          </>
        )}
        <FeatureToggle label={t('Gloss cap (艶)')} refp={r('gloss', 'enabled')} />
        {gloss.enabled && (
          <>
            <RefNum label={t('Opacity')} refp={r('gloss', 'opacity')} min={0} max={1} clamp display={100} unit="%" />
            <RefNum label={t('Position')} refp={r('gloss', 'position')} min={0} max={1} clamp display={100} unit="%" title={t('Where the band ends, from the top of the element')} />
            <RefNum label={t('Softness')} refp={r('gloss', 'softness')} min={0} max={1} clamp display={100} unit="%" />
            <RefNum label={t('Curve')} refp={r('gloss', 'curve')} min={-1} max={1} clamp title={t('Bend of the band edge (> 0 arcs downward in the middle)')} />
            <RefNum
              label={t('Angle')}
              refp={r('gloss', 'angle')}
              min={-90}
              max={90}
              step={1}
              unit="deg"
              defaultValue={0}
              title={t('Tilt of the band, clockwise on screen (0 = horizontal; about −25° = the 北斗 diagonal streak)')}
            />
          </>
        )}
      </Section>
    </>
  );
}
