import { useContext, useEffect } from 'react';
import { ADJUSTMENT_NAMES } from '../../model/defaults';
import type { TitleLayer } from '../../model/parts';
import type { AdjustmentLayer, BackgroundLayer, Layer, PartKey } from '../../model/types';
import { formatMsg } from '../../store/msg';
import { partLabel } from '../../store/labels';
import { useEditor } from '../../store/store';
import { IconBtn, Section } from '../controls';
import { useT } from '../i18n';
import { useCompanionSides } from '../companions';
import { erodeListed } from '../erode';
import { glintListed } from '../glint';
import { partEnabled } from '../layers/parts';
import { listedParts } from '../layers/rows';
import { useOpenSection, useSectionsOpen, SectionScope } from '../sectionMemory';
import { AdjustmentEditor } from './AdjustmentEditor';
import { AppearanceRow, AppearanceStack, type RowClick } from './AppearanceRow';
import { EffectStack } from './EffectCard';
import { GeneratorView } from './GeneratorView';
import { GroupView } from './GroupView';
import { LettersSection } from './LettersSection';
import { AddPartButtons, PartActions, PartEye, PartsInline, PartWidth } from './PartView';
import { isInheritedSide, partSummary, partSwatch, partWidth, usePartPage } from './parts';
import { FillEditor } from './style/FillEditor';
import { PartLinkBadge } from './style/MaterialLink';
import { LayerLightingSection } from './style/Lighting3D';
import { RenderPassesSection, Shape3DSection } from './style/Parts3D';
import { fillCss } from './style/shared';
import { SwatchTitle } from './style/widgets';
import { StyleLint } from './StyleLint';
import { TextSection } from './TextSection';
import { TransformSection } from './TransformSection';

/** Appearance row click: plain = edit this part in place (again: collapse to the layer), ⌘ = add / remove it, ⇧ = the range from the last clicked part. */
function clickPart(layer: TitleLayer, part: PartKey, alone: boolean, e: RowClick) {
  const { selectNode } = useEditor.getState();
  const node = { kind: 'part', layerId: layer.id, part } as const;
  if (e.shiftKey) selectNode(node, { range: true });
  else if (e.metaKey || e.ctrlKey) selectNode(node, { additive: true });
  else selectNode(alone ? { kind: 'layer', layerId: layer.id } : node);
}

/**
 * Appearance of a title: its parts front to back (face first, a hidden 2D face still listed so
 * its eye can bring it back; 3D: the letter's face, its side while it has a material of its own,
 * then the bands), each with eye, swatch, name, a one-line summary and, for a rim or band, its
 * width / grow field. Clicking a row selects the part and edits it right under its row
 * (Illustrator's Appearance panel); ⇧ / ⌘ select several, edited together in one block under
 * the last of them. `expanded`: the selected parts. GLB models only have their face material.
 */
function AppearanceList({ layer, expanded }: { layer: TitleLayer; expanded: readonly PartKey[] }) {
  const t = useT();
  const parts = layer.kind === 'title3d' && layer.source.kind === 'model' ? (['face'] as const) : listedParts(layer);
  const shown = parts.filter((p) => expanded.includes(p));
  const last = shown[shown.length - 1];
  return (
    <AppearanceStack label={t('Style parts')} shownKey={shown.join('|')}>
      {parts.map((part) => {
        const name = formatMsg(partLabel(layer, part), t);
        const summary = partSummary(t, layer, part);
        const width = partWidth(layer, part);
        const sel = shown.includes(part);
        const alone = sel && shown.length === 1;
        return (
          <AppearanceRow
            key={part}
            sel={sel}
            open={part === last}
            off={!partEnabled(layer, part)}
            inherited={isInheritedSide(layer, part)}
            title={t('{part}: {summary} — click to edit here, ⇧ / ⌘-click to edit several', { part: name, summary })}
            onClick={(e) => clickPart(layer, part, alone, e)}
            eye={<PartEye layer={layer} part={part} />}
            swatch={partSwatch(layer, part)}
            badge={<PartLinkBadge layer={layer} part={part} />}
            name={name}
            summary={summary}
            width={width && <PartWidth refs={[width.ref]} max={width.max} grow={width.grow} label={name} />}
            actions={
              <>
                <PartActions layer={layer} part={part} />
                {alone && (
                  <IconBtn title={t('Open {part} on its own page', { part: name })} onClick={() => usePartPage.setState({ key: `${layer.id}:${part}` })}>
                    ⤢
                  </IconBtn>
                )}
              </>
            }
          >
            <PartsInline layer={layer} parts={shown} />
          </AppearanceRow>
        );
      })}
    </AppearanceStack>
  );
}

/**
 * Copy / Paste style (⌥⌘C / ⌥⌘V) on the Appearance header, where the style is shown: the user asked
 * for them here. Paste goes onto the selection, as in the Edit menu.
 */
function StyleClipButtons({ layer }: { layer: TitleLayer }) {
  const t = useT();
  const copyStyle = useEditor((s) => s.copyStyle);
  const pasteStyle = useEditor((s) => s.pasteStyle);
  const clipKind = useEditor((s) => s.styleClip?.kind);
  const pasteHint = !clipKind
    ? t('No style copied yet (⌘⌥C on a title layer)')
    : clipKind !== layer.kind
      ? t('The copied style is {dim}; convert this layer to {dim} to paste it', { dim: clipKind === 'title2d' ? '2D' : '3D' })
      : `${t('Paste layer style')} (⌥⌘V)`;
  return (
    <>
      <button className="small" title={`${t('Copy layer style')} (⌥⌘C)`} onClick={() => copyStyle(layer.id)}>
        {t('Copy')}
      </button>
      <button className="small" title={pasteHint} disabled={clipKind !== layer.kind} onClick={() => pasteStyle(useEditor.getState().selectedLayerIds)}>
        {t('Paste')}
      </button>
    </>
  );
}

/**
 * Title layer node, ordered by how often things change: transform, source (text / shape / asset),
 * Appearance (parts, edited in place, with the style check and copy / paste style), Letters
 * (per-character), for 3D the Shape and Lighting, then effects (a 3D title's glint or a 2D
 * title's かすれ pinned first) and the 3D Render passes. Blend and opacity are the Layers panel
 * header's; 2D ⇄ 3D conversion is a layer command (context menu). `parts`: the selected parts,
 * expanded in Appearance.
 */
function TitleView({ layer, parts }: { layer: TitleLayer; parts: readonly PartKey[] }) {
  const t = useT();
  const { front, back } = useCompanionSides(layer.id);
  const n = layer.effects.length + (glintListed(layer) || erodeListed(layer) ? 1 : 0) + front.length + back.length;
  const openSection = useOpenSection();
  const scope = useContext(SectionScope);
  const appearanceOpen = useSectionsOpen((s) => s[`${scope}/appearance`] ?? true);
  // A part selected while Appearance is closed opens it: its editor lives there.
  useEffect(() => {
    if (parts.length && !appearanceOpen) openSection('appearance');
  }, [parts.length, appearanceOpen, openSection]);
  return (
    <>
      <TransformSection layers={[layer]} />
      <TextSection layer={layer} />
      <Section
        id="appearance"
        title={t('Appearance')}
        actions={
          <>
            <StyleLint layer={layer} />
            <StyleClipButtons layer={layer} />
            <AddPartButtons layer={layer} />
          </>
        }
      >
        <AppearanceList layer={layer} expanded={parts} />
      </Section>
      {layer.source.kind === 'text' && <LettersSection layer={layer} src={layer.source} />}
      {layer.kind === 'title3d' && (
        <>
          {layer.source.kind !== 'model' && <Shape3DSection layers={[layer]} />}
          <LayerLightingSection layers={[layer]} />
        </>
      )}
      <Section id="effects" title={n ? t('Effects {n}', { n }) : t('Effects')}>
        <EffectStack owner={{ layerId: layer.id, part: null }} />
      </Section>
      {layer.kind === 'title3d' && <RenderPassesSection layers={[layer]} />}
    </>
  );
}

/** Background node: its fill, and the effects that run on it. */
function BackgroundView({ layer }: { layer: BackgroundLayer }) {
  const t = useT();
  const { front, back } = useCompanionSides(layer.id);
  const n = layer.effects.length + front.length + back.length;
  return (
    <>
      <Section id="background-fill" title={<SwatchTitle css={fillCss(layer.fill)}>{t('Fill')}</SwatchTitle>}>
        <FillEditor refp={{ layerId: layer.id, path: ['fill'] }} fill={layer.fill} />
        <div className="hint-line">
          {layer.guide ? t('This background is a guide: shown in the editor, excluded from export.') : t('This background is exported with the title.')}{' '}
          {t('Background layers are guides by default — toggle “guide” in the Layers panel.')}
        </div>
      </Section>
      <Section id="effects" title={n ? t('Effects {n}', { n }) : t('Effects')}>
        <EffectStack owner={{ layerId: layer.id, part: null }} />
      </Section>
    </>
  );
}

/**
 * Adjustment node: the adjustment's settings, then the effects that run on the adjusted
 * composite. An Effects only layer is just its effects, so its note heads the Effects section.
 */
function AdjustmentView({ layer }: { layer: AdjustmentLayer }) {
  const t = useT();
  const n = layer.effects.length;
  const effectsOnly = layer.adjustment.type === 'effectsOnly';
  return (
    <>
      {!effectsOnly && (
        <Section id="adjustment" title={t(ADJUSTMENT_NAMES[layer.adjustment.type], undefined, { ctx: 'adjustment' })}>
          <AdjustmentEditor layer={layer} />
        </Section>
      )}
      <Section id={effectsOnly ? 'effects-only' : 'effects'} title={n ? t('Effects {n}', { n }) : t('Effects')}>
        {effectsOnly && <AdjustmentEditor layer={layer} />}
        <EffectStack owner={{ layerId: layer.id, part: null }} />
      </Section>
    </>
  );
}

/** Layer node of any kind; for a title, `parts` are its selected parts, edited in place in Appearance. */
export function LayerView({ layer, parts = [] }: { layer: Layer; parts?: readonly PartKey[] }) {
  switch (layer.kind) {
    case 'title2d':
    case 'title3d':
      return <TitleView layer={layer} parts={parts} />;
    case 'group':
      return <GroupView layer={layer} />;
    case 'background':
      return <BackgroundView layer={layer} />;
    case 'adjustment':
      return <AdjustmentView layer={layer} />;
    case 'generator':
      return <GeneratorView layer={layer} />;
  }
}
