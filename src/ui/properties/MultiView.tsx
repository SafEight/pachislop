import { useMemo } from 'react';
import { bandKey, isTitleLayer, rimKey, type TitleLayer } from '../../model/parts';
import type { GeneratorLayer, Layer, PartKey, TextSource, Title2DLayer, Title3DLayer } from '../../model/types';
import { formatMsg } from '../../store/msg';
import { partLabel } from '../../store/labels';
import { useEditor, type PropRef } from '../../store/store';
import { RefNum, Row, Section, Seg } from '../controls';
import { FontBrowser } from '../FontBrowser';
import { useT } from '../i18n';
import { glintListed } from '../glint';
import { SectionScope } from '../sectionMemory';
import { useMixed } from '../util';
import { MultiEffectCard, type EffectTarget } from './EffectCard';
import { GlintCard } from './GlintCard';
import { PartEditor, PartWidth, type PartTarget } from './PartView';
import { partScope, partSwatch, partWidth } from './parts';
import { LayerLightingSection } from './style/Lighting3D';
import { RenderPassesSection, Shape3DSection } from './style/Parts3D';
import { SwatchTitle } from './style/widgets';
import { AlignBar, TransformSection } from './TransformSection';

// Several layers selected: the sections every one of them has, edited together through PropRef
// lists (one undo step per edit, “—” where their values differ). What not every layer has is
// left out; each section says how many layers it edits.

/** The selected layers, the primary (whose values a mixed field falls back to) first, then the rest top-down. */
function useSelectedLayers(primary: Layer): Layer[] {
  const all = useEditor((s) => s.project.layers);
  const ids = useEditor((s) => s.selectedLayerIds);
  return useMemo(() => {
    const byId = new Map(all.map((l) => [l.id, l]));
    const rest = ids.toReversed().flatMap((id) => (id === primary.id ? [] : (byId.get(id) ?? [])));
    return [byId.get(primary.id) ?? primary, ...rest];
  }, [all, ids, primary]);
}

/** `{label} · 3 layers`. */
function Counted({ label, n }: { label: string; n: number }) {
  const t = useT();
  return (
    <>
      {label} <span className="muted">· {t('{n} layers', { n })}</span>
    </>
  );
}

/** Type settings of several text titles; each keeps its own text, lines, warp and distort. */
function MultiTextSection({ layers }: { layers: readonly TitleLayer[] }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const src = layers[0].source as TextSource;
  const r = (k: keyof TextSource): PropRef[] => layers.map((l) => ({ layerId: l.id, path: ['source', k] }));
  const [fontMixed, verticalMixed, alignMixed] = useMixed(r('fontId'), r('vertical'), r('align'));
  return (
    <Section id="source" title={<Counted label={t('Text')} n={layers.length} />}>
      <div className="hint-line">{t('Each layer keeps its own text; these settings edit all of them.')}</div>
      <Row label={t('Font')}>
        <FontBrowser value={src.fontId} onChange={(id) => setAt(r('fontId'), id)} />
        {fontMixed && (
          <span className="muted" title={t('The layers use different fonts; picking one sets it on all of them')}>
            —
          </span>
        )}
      </Row>
      <RefNum label={t('Size')} refp={r('size')} min={8} max={800} step={1} unit="px" title={t('Em size in comp px — the whole style scales with it')} />
      <RefNum label={t('Line height')} refp={r('lineHeight')} min={0.5} max={3} step={0.01} unit="×" />
      <RefNum label={t('Tracking')} refp={r('tracking')} min={-300} max={1000} step={1} unit="‰" title={t('Thousandths of an em between characters')} />
      <Row label={t('Direction')}>
        <Seg
          value={src.vertical ? 'v' : 'h'}
          mixed={verticalMixed}
          options={[
            { value: 'h', label: t('横 Horizontal') },
            { value: 'v', label: t('縦 Vertical') },
          ]}
          onChange={(v) => setAt(r('vertical'), v === 'v')}
        />
      </Row>
      <Row label={t('Align')}>
        <Seg
          value={src.align}
          mixed={alignMixed}
          options={
            src.vertical
              ? [
                  { value: 'start', label: '⤒', title: t('Top') },
                  { value: 'center', label: '↕', title: t('Middle') },
                  { value: 'end', label: '⤓', title: t('Bottom') },
                ]
              : [
                  { value: 'start', label: '⇤', title: t('Left') },
                  { value: 'center', label: '↔', title: t('Centre') },
                  { value: 'end', label: '⇥', title: t('Right') },
                ]
          }
          onChange={(v) => setAt(r('align'), v)}
        />
      </Row>
      <Section id="text-typography" defaultOpen={false} title={t('Typography')}>
        <RefNum label={t('Italic')} refp={r('shear')} min={-30} max={30} step={0.5} unit="deg" title={t('Faux italic shear; 10–15° is the usual pachislot lean')} />
        <RefNum
          label={t('Width 長体')}
          refp={r('hScale')}
          min={0.3}
          max={2}
          step={0.01}
          display={100}
          unit="%"
          defaultValue={1}
          title={t('Horizontal glyph scale (長体 < 100% < 平体 look); advances follow, so the block reflows')}
        />
        <RefNum label={t('Height 平体')} refp={r('vScale')} min={0.3} max={2} step={0.01} display={100} unit="%" defaultValue={1} title={t('Vertical glyph scale (平体 < 100%); line spacing follows')} />
        <RefNum
          label={t('Tsume 詰め')}
          refp={r('tsume')}
          min={0}
          max={1}
          step={0.01}
          display={100}
          unit="%"
          clamp
          defaultValue={0}
          title={t("Proportional spacing for kana, CJK punctuation and symbols: 0 = full-width, 100% = fully proportional (the font's palt / vpal when present)")}
        />
      </Section>
    </Section>
  );
}

/** One shared part (the face, rim 2 of every layer…): `parts[i]` is its key on `layers[i]`. */
interface SharedPart {
  id: string;
  parts: PartKey[];
}

/** The parts every one of `layers` has, front to back: the face, then rims (2D) or the side (while any layer owns one) and bands (3D) by position. */
function sharedParts(layers: readonly TitleLayer[]): SharedPart[] {
  const shared = (id: string, keyOf: (l: TitleLayer) => PartKey): SharedPart => ({ id, parts: layers.map(keyOf) });
  const upTo = (n: number, make: (i: number) => SharedPart) => Array.from({ length: n }, (_, i) => make(i));
  if (layers.every((l): l is Title2DLayer => l.kind === 'title2d')) {
    const rims = Math.min(...layers.map((l) => l.style.rims.length));
    return [shared('face', () => 'face'), ...upTo(rims, (i) => shared(`rim-${i}`, (l) => rimKey((l as Title2DLayer).style.rims[i].id)))];
  }
  if (!layers.every((l): l is Title3DLayer => l.kind === 'title3d')) return [];
  // A GLB model has only its face.
  if (layers.some((l) => l.source.kind === 'model')) return [shared('face', () => 'face')];
  const style = (l: TitleLayer) => (l as Title3DLayer).style3d;
  const bands = Math.min(...layers.map((l) => style(l).bands.length));
  return [
    shared('face', () => 'face'),
    ...(layers.some((l) => style(l).side) ? [shared('side', () => 'side')] : []),
    ...upTo(bands, (i) => shared(`band-${i}`, (l) => bandKey(style(l).bands[i].id))),
  ];
}

/** One shared part as a collapsible section: its name, the layers it spans, a rim's width or band's grow, and the part editor over all of them. */
function SharedPartSection({ layers, part }: { layers: readonly TitleLayer[]; part: SharedPart }) {
  const t = useT();
  const swatches = layers.map((l, i) => partSwatch(l, part.parts[i]));
  const targets: PartTarget[] = layers.map((layer, i) => ({ layer, part: part.parts[i] }));
  const label = formatMsg(partLabel(layers[0], part.parts[0]), t);
  const widths = layers.map((l, i) => partWidth(l, part.parts[i]));
  const width = widths[0];
  return (
    <Section
      id={`multi-${part.id}`}
      defaultOpen={false}
      title={
        <SwatchTitle css={swatches[0]} mixed={swatches.some((s) => s !== swatches[0])}>
          <Counted label={label} n={layers.length} />
        </SwatchTitle>
      }
      actions={width && <PartWidth refs={widths.flatMap((w) => (w ? [w.ref] : []))} max={width.max} grow={width.grow} label={label} />}
    >
      <SectionScope value={partScope(layers[0], [part.parts[0]])}>
        <PartEditor targets={targets} id={`multi-${part.id}`} />
      </SectionScope>
    </Section>
  );
}

/** Appearance of several titles of one kind (all 2D or all 3D): every part they all have. */
function MultiAppearance({ layers }: { layers: readonly TitleLayer[] }) {
  const t = useT();
  const parts = sharedParts(layers);
  if (!parts.length) return null;
  return (
    <Section id="appearance" title={<Counted label={t('Appearance')} n={layers.length} />}>
      <div className="hint-line">{t('The parts all these layers have, by position (Rim 1 = the innermost of each).')}</div>
      {parts.map((p) => (
        <SharedPartSection key={p.id} layers={layers} part={p} />
      ))}
    </Section>
  );
}

/**
 * The effects every one of `layers` has: matched by type and, for repeats, by order (the second
 * Outer Glow of each), listed last-applied first like a stack.
 */
function sharedEffects(layers: readonly Layer[]): EffectTarget[][] {
  const keyed = layers.map((l) => {
    const seen = new Map<string, number>();
    return l.effects.map((fx, index) => {
      const n = (seen.get(fx.type) ?? 0) + 1;
      seen.set(fx.type, n);
      return { key: `${fx.type}#${n}`, target: { owner: { layerId: l.id, part: null }, fx, index } satisfies EffectTarget };
    });
  });
  const [first, ...rest] = keyed;
  return first
    .filter((e) => rest.every((list) => list.some((x) => x.key === e.key)))
    .map((e) => [e.target, ...rest.map((list) => list.find((x) => x.key === e.key)!.target)])
    .toReversed();
}

/** Several layers selected: the sections they all have, edited together (see the top of this file). */
export function MultiView({ layer }: { layer: Layer }) {
  const t = useT();
  const layers = useSelectedLayers(layer);
  const n = layers.length;
  const movable = layers.every((l) => isTitleLayer(l) || l.kind === 'generator') ? (layers as (TitleLayer | GeneratorLayer)[]) : null;
  const titles = layers.every(isTitleLayer) ? (layers as TitleLayer[]) : null;
  const texts = titles?.every((l) => l.source.kind === 'text') ? titles : null;
  const in3D = titles?.every((l): l is Title3DLayer => l.kind === 'title3d') ? (titles as Title3DLayer[]) : null;
  const effects = sharedEffects(layers);
  // The glint card edits every selected 3D title while any lists its glint (as Render passes did).
  const glints = in3D?.some(glintListed) ? in3D : null;
  const nFx = effects.length + (glints ? 1 : 0);
  const names = layers.map((l) => l.name).join(', ');
  return (
    <>
      <div className="hint-line" title={names}>
        {t('{n} layers selected: what they all have edits all of them; “—” marks values that differ.', { n })}
      </div>
      {movable ? (
        <TransformSection layers={movable} />
      ) : (
        <Section id="align" title={t('Align')}>
          <AlignBar />
        </Section>
      )}
      {texts && <MultiTextSection layers={texts} />}
      {titles && <MultiAppearance layers={titles} />}
      {in3D && in3D.every((l) => l.source.kind !== 'model') && <Shape3DSection layers={in3D} />}
      {in3D && <LayerLightingSection layers={in3D} />}
      {nFx > 0 && (
        <Section id="effects" title={<Counted label={t('Effects {n}', { n: nFx })} n={n} />}>
          <div className="hint-line">{t('The effects every layer has (by type); add, reorder or remove effects on each layer.')}</div>
          {glints && <GlintCard layers={glints} />}
          {effects.map((targets) => (
            <MultiEffectCard key={targets.map((x) => x.fx.id).join('|')} targets={targets} />
          ))}
        </Section>
      )}
      {in3D && <RenderPassesSection layers={in3D} />}
    </>
  );
}
