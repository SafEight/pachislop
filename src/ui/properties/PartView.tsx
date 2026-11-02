import { parsePartKey, type TitleLayer } from '../../model/parts';
import type { Material2D, Material3D, PartKey, Title2DLayer, Title3DLayer } from '../../model/types';
import { formatMsg } from '../../store/msg';
import { partLabel } from '../../store/labels';
import { getIn, refKey } from '../../store/paths';
import { useEditor, type PropRef } from '../../store/store';
import { IconBtn, NumberField, Section } from '../controls';
import { useT } from '../i18n';
import { partEnabled, partHasEye } from '../layers/parts';
import { SectionScope } from '../sectionMemory';
import { useRefValue } from '../util';
import { EffectStack } from './EffectCard';
import { addPart, canMovePart, duplicatePart, isInheritedSide, movePart, ownSides, partScope, refsOf, removePart, SIDE_SAME_AS, stackPos, usePartPage } from './parts';
import { Material3DSection } from './style/Material3DEditor';
import { Face2DEditor, PartMaterial2D, RimEditor, type RimTarget } from './style/Parts2D';
import { BandEditor, Face3DEditor, SideEditor, type Stack3DTarget } from './style/Parts3D';

/** + Rim (2D) or + Band (3D) button; the new part is selected. GLB models have no stacks. */
export function AddPartButtons({ layer }: { layer: TitleLayer }) {
  const t = useT();
  if (layer.kind === 'title2d')
    return (
      <button className="small" title={t('Add a rim outside the outermost one')} onClick={() => addPart(layer, 'rim')}>
        + {t('Rim')}
      </button>
    );
  if (layer.source.kind === 'model') return null;
  return (
    <button className="small" title={t('Add a band behind the last one: an outline copy of the letters, 2 % wider, in the next colour')} onClick={() => addPart(layer, 'band')}>
      + {t('Band', undefined, { ctx: 'bevel' })}
    </button>
  );
}

/** Show / hide toggle of a part where `setPartEnabled` applies (rims, bands, the 2D face); an empty cell elsewhere, so rows line up. */
export function PartEye({ layer, part }: { layer: TitleLayer; part: PartKey }) {
  const t = useT();
  const setPartEnabled = useEditor((s) => s.setPartEnabled);
  if (!partHasEye(layer, part)) return <span className="part-eye" aria-hidden />;
  const name = formatMsg(partLabel(layer, part), t);
  const on = partEnabled(layer, part);
  const label = on ? t('Hide {part}', { part: name }) : t('Show {part}', { part: name });
  return (
    <button
      className={`part-eye ${on ? 'on' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={on}
      onClick={(e) => {
        e.stopPropagation();
        setPartEnabled(layer.id, part, !on);
      }}
    >
      {on ? '●' : ''}
    </button>
  );
}

/**
 * Reorder (↑ toward the face, ↓ outward), duplicate and remove a rim / band; on a 3D face whose
 * side walls show it, Own side (they get a copy of the face to differ, and the Side row shows);
 * on a 3D side, ✕ (back to the face's) while it has its own material, Own while it shows the
 * face (listed only for its effects); nothing for the 2D face.
 */
export function PartActions({ layer, part }: { layer: TitleLayer; part: PartKey }) {
  const t = useT();
  if (layer.kind === 'title3d' && (part === 'face' || part === 'side')) {
    if (layer.source.kind === 'model') return <span className="part-actions" />;
    const side = formatMsg(partLabel(layer, 'side'), t);
    const sameAs = formatMsg(SIDE_SAME_AS, t);
    const own = (e: React.MouseEvent) => {
      e.stopPropagation();
      ownSides([layer], true);
      useEditor.getState().selectNode({ kind: 'part', layerId: layer.id, part: 'side' });
    };
    return (
      <span className="part-actions">
        {!isInheritedSide(layer, 'side') ? (
          part === 'side' && (
            <IconBtn title={t('{part}: {source}', { part: side, source: sameAs })} onClick={() => ownSides([layer], false)}>
              ✕
            </IconBtn>
          )
        ) : part === 'face' ? (
          <button className="small" title={t('Give the side walls their own copy of the face material, so they can differ (Side row)')} onClick={own}>
            {t('Own side')}
          </button>
        ) : (
          <button className="small" title={t('Give {part} its own copy of the material it follows ({source}), to edit on its own', { part: side, source: sameAs })} onClick={own}>
            {t('Own')}
          </button>
        )}
      </span>
    );
  }
  return (
    <span className="part-actions">
      {stackPos(layer, part) && (
        <>
          <IconBtn title={t('Move up')} disabled={!canMovePart(layer, part, -1)} onClick={() => movePart(layer, part, -1)}>
            ▲
          </IconBtn>
          <IconBtn title={t('Move down')} disabled={!canMovePart(layer, part, 1)} onClick={() => movePart(layer, part, 1)}>
            ▼
          </IconBtn>
          <IconBtn title={t('Duplicate')} onClick={() => duplicatePart(layer, part)}>
            ⧉
          </IconBtn>
          <IconBtn title={t('Remove')} danger onClick={() => removePart(layer, part)}>
            ✕
          </IconBtn>
        </>
      )}
    </span>
  );
}

/**
 * A rim's width or a band's grow (`grow`) on its Appearance row, the number most often changed,
 * without opening the part: one layer's, or (`refs` of several layers) all at once, where typing
 * sets them all and scrubbing widens each by the same amount. Clicks stay off the row (no
 * reselecting).
 */
export function PartWidth({ refs, max, grow, label }: { refs: readonly PropRef[]; max: number; grow: boolean; label: string }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const setEachAt = useEditor((s) => s.setEachAt);
  const refp = refsOf(refs);
  const { value, mixed } = useRefValue(refp);
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  const several = refs.length > 1;
  const title = grow
    ? several
      ? t('Grow of {part} on every layer: typing sets them all, scrubbing grows each by the same amount', { part: label })
      : t('Grow of {part} beyond the solid in front of it: drag to scrub, click to type', { part: label })
    : several
      ? t('Width of {part} on every layer: typing sets them all, scrubbing widens each by the same amount', { part: label })
      : t('Width of {part}: drag to scrub, click to type', { part: label });
  return (
    <span className="part-width" title={title} onClick={(e) => e.stopPropagation()}>
      <NumberField
        id={refKey(refp)}
        label={grow ? t('{part} grow', { part: label }) : t('{part} width', { part: label })}
        value={num(value)}
        mixed={mixed}
        onChange={(v, c) => setAt(refp, v, c)}
        onOffset={(d, c) => setEachAt(refp, (v) => Math.max(0, num(v) + d), c)}
        min={0}
        max={max}
        step={0.05}
        unit="%"
        slider={false}
      />
    </span>
  );
}

/** A style part of a title, as the part editors take them (several may span layers). */
export interface PartTarget {
  layer: TitleLayer;
  part: PartKey;
}

/** Where the material a part shows first lives: the 2D face / a rim's, the 3D face / own side / a band's; null for a missing part or a side that shows the face. */
function materialPath(layer: TitleLayer, part: PartKey): (string | number)[] | null {
  const kind = parsePartKey(part).kind;
  const index = stackPos(layer, part)?.index ?? -1;
  if (layer.kind === 'title2d') return kind === 'face' ? ['style', 'face'] : index >= 0 ? ['style', 'rims', index, 'material'] : null;
  if (kind === 'face') return ['style3d', 'face'];
  if (kind === 'side') return layer.style3d.side ? ['style3d', 'side'] : null;
  return index < 0 ? null : ['style3d', 'bands', index, 'material'];
}

/**
 * The editor of one or several parts: their material first, then their geometry (see Parts2D /
 * Parts3D). Parts of one kind (Bands 2 and 4, or rim 2 of three titles) show everything they
 * share; parts of different kinds share only their material (a band's front). 2D and 3D
 * materials never mix: such a target list shows nothing. `id` prefixes the sections' remembered
 * open state.
 */
export function PartEditor({ targets, id }: { targets: readonly PartTarget[]; id?: string }) {
  const t = useT();
  const flat = targets.map(({ layer, part }) => ({ layer, part, kind: parsePartKey(part).kind, index: stackPos(layer, part)?.index ?? -1 }));
  const in2D = flat.flatMap((x) => (x.layer.kind === 'title2d' ? [{ ...x, layer: x.layer }] : []));
  const in3D = flat.flatMap((x) => (x.layer.kind === 'title3d' ? [{ ...x, layer: x.layer }] : []));
  if (!flat.length || (in2D.length && in3D.length)) return null;
  const kinds = new Set(flat.map((x) => x.kind));
  if (kinds.size === 1) {
    const [kind] = kinds;
    if (in2D.length) {
      if (kind === 'face') return <Face2DEditor layers={in2D.map((x): Title2DLayer => x.layer)} id={id} />;
      const rims = in2D.filter((x) => x.index >= 0).map((x): RimTarget => ({ layer: x.layer, index: x.index }));
      return rims.length ? <RimEditor rims={rims} id={id} /> : null;
    }
    const layers = in3D.map((x): Title3DLayer => x.layer);
    if (kind === 'face') return <Face3DEditor layers={layers} id={id} />;
    if (kind === 'side') return <SideEditor layers={layers} id={id} />;
    const stack = in3D.filter((x) => x.index >= 0).map((x): Stack3DTarget => ({ layer: x.layer, index: x.index }));
    if (!stack.length) return null;
    return <BandEditor bands={stack} id={id} />;
  }
  const refs = flat.flatMap(({ layer, part }) => {
    const path = materialPath(layer, part);
    return path ? [{ layer, ref: { layerId: layer.id, path } satisfies PropRef }] : [];
  });
  if (!refs.length) return null;
  const first = getIn(refs[0].layer, refs[0].ref.path);
  const refp = refsOf(refs.map((r) => r.ref));
  const prefix = id ?? 'part';
  const note = <div className="hint-line">{t('Parts of different kinds share only their material (a band’s front).')}</div>;
  return in2D.length ? (
    <>
      {note}
      <PartMaterial2D id={`${prefix}-material`} refp={refp} mat={first as Material2D} />
    </>
  ) : (
    <>
      {note}
      <Material3DSection id={`${prefix}-material`} title={t('Material')} refp={refp} mat={first as Material3D} defaultOpen />
    </>
  );
}

/** The effects on one part only, after its editor. */
function PartEffects({ layer, part }: { layer: TitleLayer; part: PartKey }) {
  const t = useT();
  const n = layer.partEffects[part]?.length ?? 0;
  return (
    <Section id="part-effects" title={n ? t('Effects {n}', { n }) : t('Effects')}>
      <div className="hint-line">{t("Only on {part}: these run on this part's own pixels, before the layer's effects.", { part: formatMsg(partLabel(layer, part), t) })}</div>
      <EffectStack owner={{ layerId: layer.id, part }} />
    </Section>
  );
}

/**
 * The selected part(s) of `layer` edited inside its Appearance list, under their row
 * (Illustrator's Appearance panel): one part shows its editor and its own effects; several show
 * one editor of their shared fields under a "3 parts: Band 2, Band 4, Side" header.
 */
export function PartsInline({ layer, parts }: { layer: TitleLayer; parts: readonly PartKey[] }) {
  const t = useT();
  const names = parts.map((p) => formatMsg(partLabel(layer, p), t)).join(', ');
  return (
    <div className="sty-inline" role="group" aria-label={parts.length > 1 ? t('{n} parts: {names}', { n: parts.length, names }) : names}>
      {parts.length > 1 && <div className="sty-inline-head">{t('{n} parts: {names}', { n: parts.length, names })}</div>}
      <SectionScope value={partScope(layer, parts)}>
        <PartEditor targets={parts.map((part) => ({ layer, part }))} />
        {parts.length === 1 && <PartEffects layer={layer} part={parts[0]} />}
      </SectionScope>
    </div>
  );
}

/**
 * Part page (⤢ from the part's row in Appearance): toolbar (show / reorder / duplicate / remove,
 * back into the layer page, add), the part's editor, then the effects on this part only.
 */
export function PartView({ layer, part }: { layer: TitleLayer; part: PartKey }) {
  const t = useT();
  return (
    <>
      <div className="props-toolbar">
        <PartEye layer={layer} part={part} />
        <PartActions layer={layer} part={part} />
        <IconBtn title={t('Edit in the layer page (Appearance)')} onClick={() => usePartPage.setState({ key: null })}>
          ⤡
        </IconBtn>
        <span className="right">
          <AddPartButtons layer={layer} />
        </span>
      </div>
      <PartEditor targets={[{ layer, part }]} />
      <PartEffects layer={layer} part={part} />
    </>
  );
}
