import { useState } from 'react';
import { withoutLink, type AnyMaterial } from '../../model/links';
import { bandKey, parsePartKey, type TitleLayer } from '../../model/parts';
import { charSideNeighbour, sideSource, withCharSide } from '../../model/sides';
import type { CharAdjust, Material2D, Material3D, PartKey, TextSource } from '../../model/types';
import { applyColourway, COLOURWAY_INFO } from '../../presets/colourways';
import { COLOURWAYS } from '../../presets/types';
import { partLabel } from '../../store/labels';
import { formatMsg, msg, type Text } from '../../store/msg';
import { getIn } from '../../store/paths';
import { useEditor, type PropRef } from '../../store/store';
import { IconBtn, Row } from '../controls';
import { useT } from '../i18n';
import { oneShot } from '../util';
import { mapAdjusts } from '../viewport/glyphs';
import { AppearanceRow, AppearanceStack, type RowClick } from './AppearanceRow';
import { materialCss, materialSummary, partMaterial, refsOf, stackPos } from './parts';
import { Material3DSection } from './style/Material3DEditor';
import { MaterialLinkBadge } from './style/MaterialLink';
import { PartMaterial2D } from './style/Parts2D';

// A letter's own materials in the Letters section, listed like the layer's Appearance: 2D its
// face; 3D its face, bevel bands and side (a white 元祖 inside a gold word loses the gold bands
// too). A part the letter doesn't own shows the layer's material, its side the letter's own
// neighbour (model/sides.ts: a letter owning its outermost band shows that band on its side
// while the layer's side follows its band); Own gives the picked letters a copy of what they
// show, ✕ hands that one part back. Every edit applies to all picked letters.

/** The parts a letter can own, as the layer's part keys: 2D the face; 3D face, bands (none in inflate mode, which ignores them) and side. */
function letterParts(layer: TitleLayer): PartKey[] {
  if (layer.kind === 'title2d') return ['face'];
  const bands = layer.style3d.mode === 'inflate' ? [] : layer.style3d.bands.map((b) => bandKey(b.id));
  return ['face', ...bands, 'side'];
}

/** Where a letter keeps its own material for `part`, inside its CharAdjust: `face` (2D), `face3d`, `bands3d[k]` (index-aligned with the layer's bands) or `side3d`. */
function ownPath(layer: TitleLayer, part: PartKey): (string | number)[] {
  if (layer.kind === 'title2d') return ['face'];
  const { kind } = parsePartKey(part);
  if (kind === 'face') return ['face3d'];
  if (kind === 'side') return ['side3d'];
  return ['bands3d', stackPos(layer, part)?.index ?? -1];
}

/** The letter's own material for `part`, or undefined when it uses the layer's. */
const ownOf = (layer: TitleLayer, a: CharAdjust | undefined, part: PartKey) => (getIn(a, ownPath(layer, part)) ?? undefined) as AnyMaterial | undefined;

/** What letter `a` shows for `part` while it doesn't own it: the layer's material; for a 3D side, the letter's neighbour. */
const inheritedOf = (layer: TitleLayer, a: CharAdjust | undefined, part: PartKey) =>
  layer.kind === 'title3d' && part === 'side' ? charSideNeighbour(layer.style3d, a) : partMaterial(layer, part);

/**
 * What a letter's side follows while it doesn't own it, when that is the letter's own band or
 * face (“Same as Band 2”, “Same as face”); null when it is the layer's.
 */
function charSideSource(layer: TitleLayer, a: CharAdjust | undefined): Text | null {
  if (layer.kind !== 'title3d' || layer.style3d.side) return null;
  const i = sideSource(layer.style3d);
  if (i === null) return a?.face3d ? msg('Same as face') : null;
  return a?.bands3d?.[i] ? msg('Same as {part}', { part: partLabel(layer, bandKey(layer.style3d.bands[i].id)) }) : null;
}

/**
 * `a` owning a copy of `m` for `part` (a linked material leaves its link behind), or using the
 * layer's again (`m` null); `bands3d` goes once no band is the letter's own.
 */
function withOwn(layer: TitleLayer, a: CharAdjust, part: PartKey, m: AnyMaterial | null): CharAdjust {
  const out = { ...a };
  const own = m && structuredClone(withoutLink(m));
  if (layer.kind === 'title2d') {
    if (own) out.face = own as Material2D;
    else delete out.face;
    return out;
  }
  const { kind } = parsePartKey(part);
  if (kind === 'face' || kind === 'side') {
    const key = kind === 'face' ? 'face3d' : 'side3d';
    if (own) out[key] = own as Material3D;
    else delete out[key];
    return out;
  }
  const k = stackPos(layer, part)?.index;
  if (k === undefined) return out;
  const bands = layer.style3d.bands.map((_, i) => (i === k ? (own as Material3D | null) : (a.bands3d?.[i] ?? null)));
  if (bands.some(Boolean)) out.bands3d = bands;
  else delete out.bands3d;
  return out;
}

/** `a` with every own material dropped: the layer's face, bands and side again. */
function withoutOwn(a: CharAdjust): CharAdjust {
  const { face: _f, face3d: _f3, bands3d: _b, side3d: _s, ...rest } = a;
  return rest;
}

/**
 * The rows selected after a click on `key`, as in the layer's Appearance: plain = this row alone
 * (again, when it is the only one: none), ⌘ = add / remove it, ⇧ = the range from `anchor` (the
 * last clicked row).
 */
function clickRows(keys: readonly PartKey[], selected: readonly PartKey[], anchor: PartKey | null, key: PartKey, e: RowClick): PartKey[] {
  if (e.shiftKey && anchor !== null && keys.includes(anchor)) {
    const [a, b] = [keys.indexOf(anchor), keys.indexOf(key)].sort((x, y) => x - y);
    return keys.slice(a, b + 1);
  }
  if (e.metaKey || e.ctrlKey) return selected.includes(key) ? selected.filter((k) => k !== key) : keys.filter((k) => k === key || selected.includes(k));
  return selected.length === 1 && selected[0] === key ? [] : [key];
}

/**
 * The own materials of the picked letters (`selected`, non-empty) of a text title: face colour
 * chips, Match face / Reset all to layer's, then one Appearance row per part, its material edited
 * under its row (⇧ / ⌘: several parts together, over every picked letter).
 */
export function LetterMaterials({ layer, src, selected }: { layer: TitleLayer; src: TextSource; selected: readonly number[] }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const [rows, setRows] = useState<{ sel: readonly PartKey[]; anchor: PartKey | null }>({ sel: [], anchor: null });
  const is2d = layer.kind === 'title2d';
  const chars = Array.from(src.text);
  const picked = selected.map((i) => chars[i]).join('');
  const parts = letterParts(layer);
  const shown = parts.filter((p) => rows.sel.includes(p));
  const last = shown[shown.length - 1];
  const own = (i: number, part: PartKey) => ownOf(layer, src.chars[i], part);
  const anyOwn = selected.some((i) => parts.some((p) => own(i, p)));
  const partsText = (keys: readonly PartKey[]): Text => (keys.length === 1 ? partLabel(layer, keys[0]) : msg('{n} parts', { n: keys.length }));

  /** Rewrite every picked letter, one undo step. */
  const update = (fn: (a: CharAdjust) => CharAdjust, label: Text) =>
    setAt({ layerId: layer.id, path: ['source', 'chars'] }, mapAdjusts(src.chars, selected, fn), oneShot(`${layer.id}:letterMaterials`), label);
  /** Give the picked letters a copy of what they show for each of `keys` they don't own yet, and edit them. */
  const ownParts = (keys: readonly PartKey[]) => {
    update((a) => keys.reduce((b, p) => (ownOf(layer, b, p) ? b : withOwn(layer, b, p, inheritedOf(layer, b, p))), a), msg('Own {part} “{chars}”', { part: partsText(keys), chars: picked }));
    setRows({ sel: keys, anchor: keys[keys.length - 1] });
  };
  const resetPart = (part: PartKey) => update((a) => withOwn(layer, a, part, null), msg('Reset {part} “{chars}” to the layer’s', { part: partLabel(layer, part), chars: picked }));
  /** Bands and side take the letter's face (its own, else the layer's); the side follows the bands when that shows the same. */
  const matchFace = () =>
    update((a) => {
      const face = ownOf(layer, a, 'face') ?? partMaterial(layer, 'face');
      const banded = parts.filter((p) => p !== 'face' && p !== 'side').reduce((b, p) => withOwn(layer, b, p, face), a);
      return layer.kind === 'title3d' && face ? withCharSide(layer.style3d, banded, structuredClone(withoutLink(face as Material3D))) : banded;
    }, msg('Bands = face “{chars}”', { chars: picked }));

  const editor = () => {
    const targets = selected.flatMap((i) => shown.map((p) => ({ i, p })));
    const first = own(selected[0], shown[0]);
    if (!first || targets.some(({ i, p }) => !own(i, p))) {
      const follows = new Set(selected.map((i) => charSideSource(layer, src.chars[i])).map((s) => (s ? formatMsg(s, t) : null)));
      const source = shown.length === 1 && shown[0] === 'side' && follows.size === 1 ? [...follows][0] : null;
      return (
        <div className="hint-line">
          {source
            ? t('{source}: the letter’s own. Own it to edit the side for “{chars}” only.', { source, chars: picked })
            : t("Uses the layer's material. Own it to edit it for “{chars}” only.", { chars: picked })}{' '}
          <button className="small" onClick={() => ownParts(shown)}>
            {t('Own')}
          </button>
        </div>
      );
    }
    const refp = refsOf(targets.map(({ i, p }): PropRef => ({ layerId: layer.id, path: ['source', 'chars', i, ...ownPath(layer, p)] })));
    return is2d ? (
      <PartMaterial2D id="char-material" refp={refp} mat={first as Material2D} />
    ) : (
      <Material3DSection id="char-material" title={t('Material')} refp={refp} mat={first as Material3D} defaultOpen />
    );
  };
  const names = shown.map((p) => formatMsg(partLabel(layer, p), t)).join(', ');
  // Built once, for the open row only (the last selected one).
  const inline = last && (
    <div className="sty-inline" role="group" aria-label={names}>
      {shown.length > 1 && <div className="sty-inline-head">{t('{n} parts: {names}', { n: shown.length, names })}</div>}
      {editor()}
    </div>
  );

  return (
    <>
      <Row label={t('Face')} title={t('Per-character face colour (split-colour words); rims stay continuous around the word')}>
        <span className="face-chips">
          {COLOURWAYS.map((c) => (
            <button
              key={c}
              className="face-chip"
              title={t('{colour} face for “{chars}”', { colour: COLOURWAY_INFO[c].name, chars: picked })}
              style={{ background: COLOURWAY_INFO[c].faceCss }}
              onClick={() => {
                // The layer's face in colourway `c`: the chips keep the layer's own face structure.
                const recoloured = applyColourway(layer, c);
                const face = recoloured.kind === 'title2d' ? recoloured.style.face : recoloured.kind === 'title3d' ? recoloured.style3d.face : null;
                update((a) => withOwn(layer, a, 'face', face), msg('Face {colour} “{chars}”', { colour: COLOURWAY_INFO[c].name, chars: picked }));
              }}
            >
              {COLOURWAY_INFO[c].label}
            </button>
          ))}
        </span>
      </Row>
      <Row label={t('Materials')} title={t("The picked letters' own materials; the rest of the word keeps the layer's")}>
        {!is2d && (
          <button className="small" title={t('Give “{chars}” the face material on every band and the side (a white 元祖 in a gold word)', { chars: picked })} onClick={matchFace}>
            {t('Match face')}
          </button>
        )}
        <button className="small" disabled={!anyOwn} title={t("“{chars}” uses the layer's materials again", { chars: picked })} onClick={() => update(withoutOwn, msg('Reset materials “{chars}”', { chars: picked }))}>
          {t("Reset all to layer's")}
        </button>
      </Row>
      <AppearanceStack label={t('Materials of “{chars}”', { chars: picked })} shownKey={shown.join('|')}>
        {parts.map((part) => {
          const name = formatMsg(partLabel(layer, part), t);
          const mats = selected.map((i) => own(i, part));
          const owned = mats.filter(Boolean).length;
          const css = new Set(selected.map((i, k) => mats[k] ?? inheritedOf(layer, src.chars[i], part)).map((m) => (m ? materialCss(m) : 'transparent')));
          /** A letter's summary: its own material's, else what it follows. */
          const summaryOf = (i: number, m: AnyMaterial | undefined) => {
            if (m) return materialSummary(t, m).join(' · ');
            const source = part === 'side' ? charSideSource(layer, src.chars[i]) : null;
            return source ? formatMsg(source, t) : t("Layer's");
          };
          const summaries = new Set(selected.map((i, k) => summaryOf(i, mats[k])));
          const summary = summaries.size === 1 ? [...summaries][0] : '—';
          const sel = shown.includes(part);
          const resetTo = part === 'side' ? charSideSource(layer, src.chars[selected[0]]) : null;
          return (
            <AppearanceRow
              key={part}
              sel={sel}
              open={part === last}
              inherited={!owned}
              title={t('{part}: {summary} — click to edit here, ⇧ / ⌘-click to edit several', { part: name, summary })}
              onClick={(e) => setRows({ sel: clickRows(parts, shown, rows.anchor, part, e), anchor: part })}
              swatch={[...css][0]}
              swatchMixed={css.size > 1}
              badge={<MaterialLinkBadge mats={mats} kind={is2d ? '2d' : '3d'} />}
              name={name}
              summary={summary}
              actions={
                <>
                  {owned < selected.length && (
                    <button
                      className="small"
                      title={t("Give “{chars}” its own copy of the layer's {part}", { chars: picked, part: name })}
                      onClick={(e) => {
                        e.stopPropagation();
                        ownParts([part]);
                      }}
                    >
                      {t('Own')}
                    </button>
                  )}
                  {owned > 0 && (
                    <IconBtn title={resetTo ? formatMsg(resetTo, t) : t("Reset to layer's")} onClick={() => resetPart(part)}>
                      ✕
                    </IconBtn>
                  )}
                </>
              }
            >
              {inline}
            </AppearanceRow>
          );
        })}
      </AppearanceStack>
    </>
  );
}
