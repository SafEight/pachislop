import { useContext, useEffect, useRef, useState } from 'react';
import { withoutLink } from '../../model/links';
import type { CharAdjust, Material2D, Material3D, TextSource } from '../../model/types';
import type { TitleLayer } from '../../model/parts';
import { applyColourway, COLOURWAY_INFO } from '../../presets/colourways';
import { COLOURWAYS, type Colourway } from '../../presets/types';
import { msg, type Msg } from '../../store/msg';
import { useEditor } from '../../store/store';
import { NumRow, Row, Section } from '../controls';
import { useT } from '../i18n';
import { FindProbe, useOpenSection } from '../sectionMemory';
import { oneShot } from '../util';
import { isNeutralAdjust, mapAdjusts, NO_ADJUST } from '../viewport/glyphs';
import { InfoTip } from './InfoTip';
import { firstLetter } from './searchIndex';
import { CharMaterials3D } from './style/CharMaterials3D';
import { Material2DEditor } from './style/Material2DEditor';
import { Material3DSection } from './style/Material3DEditor';
import { fillCss, material2DClipboard, material3DCss } from './style/shared';
import { MaterialLink } from './style/MaterialLink';
import { ClipActions, SwatchTitle } from './style/widgets';

// The Letters section of a text title: per-character offsets, scale, rotation, 3D push / tilt and
// split-colour faces. It sits after Appearance (it is about how single letters look), not in Text.

type SourceLayer = TitleLayer;

/** CSS swatch of a character's face override for the layer's kind, or null. */
function faceCss(layer: SourceLayer, a: CharAdjust | undefined): string | null {
  if (layer.kind === 'title2d') return a?.face ? fillCss(a.face.fill) : null;
  return a?.face3d ? material3DCss(a.face3d) : null;
}

/**
 * Split-colour faces (激 red / アツ gold): colour chips (the colourways' faces), custom face
 * editor and clear, for the picked characters. 2D layers write `face`, 3D layers `face3d`; rims
 * stay whole-word.
 */
function CharFaceEditor({ layer, src, selected }: { layer: SourceLayer; src: TextSource; selected: number[] }) {
  const t = useT();
  const [custom, setCustom] = useState(false);
  const setAt = useEditor((s) => s.setAt);
  const chars = Array.from(src.text);
  const is2d = layer.kind === 'title2d';
  const key = is2d ? 'face' : 'face3d';
  const primary = selected[0];
  const picked = selected.map((i) => chars[i]).join('');
  const ref = { layerId: layer.id, path: ['source', 'chars'] };

  /** Rewrite the face of every picked character (null = remove the override). */
  const setFaces = (face: (i: number) => CharAdjust['face'] | CharAdjust['face3d'] | null, label: Msg) => {
    const next = { ...src.chars };
    for (const i of selected) {
      const base: CharAdjust = { ...(next[i] ?? NO_ADJUST) };
      delete base[key];
      // Clearing a 3D character's face also drops its own band / side materials.
      if (!is2d && !face(i)) {
        delete base.bands3d;
        delete base.side3d;
      }
      const f = face(i);
      // A letter's face is its own (copied out of a linked layer face, it leaves the link behind).
      const a: CharAdjust = !f ? base : is2d ? { ...base, face: structuredClone(withoutLink(f as Material2D)) } : { ...base, face3d: structuredClone(withoutLink(f as Material3D)) };
      if (isNeutralAdjust(a)) delete next[i];
      else next[i] = a;
    }
    setAt(ref, next, oneShot(`${layer.id}:face`), label);
  };
  /** The layer's face in colourway `c`: the colour chips keep the layer's own face structure. */
  const colourFace = (c: Colourway) => {
    const recoloured = applyColourway(layer, c);
    return recoloured.kind === 'title2d' ? recoloured.style.face : recoloured.kind === 'title3d' ? recoloured.style3d.face : null;
  };
  const layerFace = layer.kind === 'title2d' ? layer.style.face : layer.style3d.face;
  const primaryFace = src.chars[primary]?.[key];
  const faceRef = { layerId: layer.id, path: ['source', 'chars', primary, key] };
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
              onClick={() => setFaces(() => colourFace(c), msg('Face {colour} “{chars}”', { colour: COLOURWAY_INFO[c].name, chars: picked }))}
            >
              {COLOURWAY_INFO[c].label}
            </button>
          ))}
        </span>
      </Row>
      <Row label="">
        <button
          className={`small ${custom ? 'active' : ''}`}
          title={t("Edit this character's face material")}
          onClick={() => {
            if (!custom) setFaces((i) => src.chars[i]?.[key] ?? layerFace, msg('Custom face “{chars}”', { chars: picked }));
            setCustom(!custom);
          }}
        >
          {t('Custom…')}
        </button>
        <button className="small" disabled={!selected.some((i) => src.chars[i]?.[key])} onClick={() => setFaces(() => null, msg('Clear face “{chars}”', { chars: picked }))}>
          {t('Clear')}
        </button>
      </Row>
      {custom && primaryFace && (
        <div className="char-face-editor">
          {selected.length > 1 && (
            <Row label="">
              <button className="small" title={t('Copy this face onto every picked character')} onClick={() => setFaces(() => primaryFace, msg('Match face “{chars}”', { chars: picked }))}>
                {t('Apply to all {n} picked', { n: selected.length })}
              </button>
            </Row>
          )}
          {layer.kind === 'title2d' && src.chars[primary]?.face ? (
            <Section
              id="char-face"
              title={<SwatchTitle css={fillCss(src.chars[primary].face.fill)}>{t('Face of “{char}”', { char: chars[primary] })}</SwatchTitle>}
              actions={
                <>
                  <MaterialLink refp={faceRef} kind="2d" />
                  <ClipActions clip={material2DClipboard} value={src.chars[primary].face} refp={faceRef} />
                </>
              }
            >
              <Material2DEditor id="char-face" refp={faceRef} mat={src.chars[primary].face} />
            </Section>
          ) : layer.kind === 'title3d' && src.chars[primary]?.face3d ? (
            <Material3DSection id="char-face3d" title={t('Face of “{char}”', { char: chars[primary] })} refp={faceRef} mat={src.chars[primary].face3d} defaultOpen />
          ) : null}
          {layer.kind === 'title3d' && <CharMaterials3D layer={layer} src={src} selected={selected} />}
        </div>
      )}
    </>
  );
}

/**
 * Letters section of a text title (per-character editing): pick letters, then offset, scale,
 * rotate (and push / tilt in 3D) them, and give them their own face (and 3D bands and side). It
 * opens by itself when the Per-letter tool is active or glyphs are picked on the canvas.
 */
export function LettersSection({ layer, src }: { layer: SourceLayer; src: TextSource }) {
  const t = useT();
  const picked0 = useEditor((s) => s.selectedChars);
  // The search index shows a letter's fields as if the first letter were picked (PropertySearch picks it on landing).
  const probe = useContext(FindProbe);
  const selected = probe && !picked0.length ? firstLetter(src.text) : picked0;
  const active = useEditor((s) => s.view.tool === 'glyph' || s.selectedChars.length > 0);
  const { selectChars, setAt } = useEditor.getState();
  const openSection = useOpenSection();
  const anchor = useRef<HTMLDivElement>(null);
  const wasActive = useRef(active);
  useEffect(() => {
    if (active) openSection('letters');
    // Came on while the page was showing: bring the section into view too.
    if (active && !wasActive.current) requestAnimationFrame(() => anchor.current?.scrollIntoView({ block: 'nearest' }));
    wasActive.current = active;
  }, [active, openSection]);
  const chars = Array.from(src.text);
  const ref = { layerId: layer.id, path: ['source', 'chars'] };
  const primary = selected.length ? selected[0] : null;
  const adj = primary !== null ? (src.chars[primary] ?? NO_ADJUST) : null;
  const picked = selected.map((i) => chars[i]).join('');
  /** Set the same values on every picked character (one undo step per gesture). */
  const setAdj = (patch: Partial<CharAdjust>, c: string, label: string) => setAt(ref, mapAdjusts(src.chars, selected, (a) => ({ ...a, ...patch })), c, label);
  /** Click: pick one; Shift-click: range from the primary; ⌘/Ctrl-click: toggle. Whitespace is never picked. */
  const pick = (i: number, e: React.MouseEvent) => {
    let next: number[];
    if (e.shiftKey && primary !== null) {
      next = [];
      for (let k = Math.min(primary, i); k <= Math.max(primary, i); k++) if (!/\s/.test(chars[k])) next.push(k);
    } else if (e.metaKey || e.ctrlKey) next = selected.includes(i) ? selected.filter((k) => k !== i) : [...selected, i].sort((a, b) => a - b);
    else next = selected.length === 1 && selected[0] === i ? [] : [i];
    selectChars(next);
  };
  const id = `${layer.id}:char:${selected.join(',')}`;
  const adjustedCount = Object.keys(src.chars).length;
  const help =
    layer.kind === 'title3d'
      ? t('Pick characters above (Shift-click a range), or click a glyph of the selected layer in the viewport, then move, scale, rotate, push and tilt them on the canvas (⇧-click or drag a marquee to pick more; Esc returns to the layer).')
      : t('Pick characters above (Shift-click a range), or click a glyph of the selected layer in the viewport, then move, scale, rotate them on the canvas (⇧-click or drag a marquee to pick more; Esc returns to the layer).');
  return (
    <div ref={anchor}>
      <Section
        id="letters"
        defaultOpen={false}
        title={
          <>
            {adjustedCount ? t('Letters ({n} adjusted)', { n: adjustedCount }) : t('Letters')}
            <InfoTip text={help} />
          </>
        }
        actions={
          adjustedCount > 0 && (
            <button className="small" title={t('Remove all per-character adjustments')} onClick={() => setAt(ref, {}, oneShot(id), 'Reset all characters')}>
              {t('Reset all')}
            </button>
          )
        }
      >
        <div className="char-picker" title={t('Pick a character (Shift-click: range, ⌘-click: add) — or click a glyph of the selected layer in the viewport')}>
          {chars.map((ch, i) => {
            if (ch === '\n') return <span key={i} className="char-break" />;
            if (/\s/.test(ch)) return null;
            const face = faceCss(layer, src.chars[i]);
            return (
              <button
                key={i}
                className={`char-btn ${selected.includes(i) ? 'active' : ''} ${src.chars[i] ? 'adjusted' : ''} ${face ? 'has-face' : ''}`}
                style={{ fontFamily: `"${src.fontId}", system-ui`, ...(face ? { '--face': face } : {}) } as React.CSSProperties}
                title={face ? t('Own face colour') : undefined}
                onClick={(e) => pick(i, e)}
              >
                {ch}
              </button>
            );
          })}
        </div>
        {adj && primary !== null ? (
          <>
            <NumRow label={t('Offset X')} id={`${id}:dx`} value={adj.dx} min={-50} max={50} step={0.1} unit="%" defaultValue={0} onChange={(v, c) => setAdj({ dx: v }, c, 'Character offset X')} title={t('% of font size')} />
            <NumRow label={t('Offset Y')} id={`${id}:dy`} value={adj.dy} min={-50} max={50} step={0.1} unit="%" defaultValue={0} onChange={(v, c) => setAdj({ dy: v }, c, 'Character offset Y')} title={t('% of font size, + = up')} />
            <NumRow label={t('Scale')} id={`${id}:s`} value={adj.scale} min={0.2} max={3} step={0.01} display={100} unit="%" defaultValue={1} onChange={(v, c) => setAdj({ scale: Math.max(0.01, v) }, c, 'Character scale')} />
            <NumRow label={t('Width 長体')} id={`${id}:hs`} value={adj.hScale ?? 1} min={0.3} max={2} step={0.01} display={100} unit="%" defaultValue={1} onChange={(v, c) => setAdj({ hScale: Math.max(0.05, v) }, c, 'Character width (長体/平体)')} title={t("Horizontal glyph scale on top of the text's; < 100% = 長体 (condensed). The line reflows. Also: the side bars of the canvas gizmo")} />
            <NumRow label={t('Height 平体')} id={`${id}:vs`} value={adj.vScale ?? 1} min={0.3} max={2} step={0.01} display={100} unit="%" defaultValue={1} onChange={(v, c) => setAdj({ vScale: Math.max(0.05, v) }, c, 'Character height (長体/平体)')} title={t("Vertical glyph scale on top of the text's; < 100% = 平体 (flattened). Also: the top / bottom bars of the canvas gizmo")} />
            <NumRow label={t('Rotate')} id={`${id}:r`} value={adj.rotate} min={-180} max={180} step={0.5} unit="deg" defaultValue={0} onChange={(v, c) => setAdj({ rotate: v }, c, 'Character rotation')} title={t('Clockwise on screen')} />
            {layer.kind === 'title3d' && (
              <>
                <NumRow label={t('Push Z')} id={`${id}:dz`} value={adj.dz ?? 0} min={-100} max={100} step={0.5} unit="%" defaultValue={0} onChange={(v, c) => setAdj({ dz: v }, c, 'Character push Z')} title={t('% of font size, + = toward the viewer')} />
                <NumRow label={t('Tilt X')} id={`${id}:tx`} value={adj.tiltX ?? 0} min={-89} max={89} step={0.5} unit="deg" clamp defaultValue={0} onChange={(v, c) => setAdj({ tiltX: v }, c, 'Character tilt X')} title={t('+ = top toward the viewer')} />
                <NumRow label={t('Tilt Y')} id={`${id}:ty`} value={adj.tiltY ?? 0} min={-89} max={89} step={0.5} unit="deg" clamp defaultValue={0} onChange={(v, c) => setAdj({ tiltY: v }, c, 'Character tilt Y')} title={t('+ = right side toward the viewer')} />
              </>
            )}
            <CharFaceEditor key={`${layer.id}:${selected.join(',')}`} layer={layer} src={src} selected={selected} />
            <Row label="">
              <button
                className="small"
                disabled={!selected.some((i) => src.chars[i])}
                onClick={() => {
                  const rest = { ...src.chars };
                  for (const i of selected) delete rest[i];
                  setAt(ref, rest, oneShot(id), msg('Reset “{chars}”', { chars: picked }));
                }}
              >
                {t('Reset “{chars}”', { chars: picked })}
              </button>
            </Row>
          </>
        ) : (
          <div className="hint-line">{t('Pick letters above, or click a glyph on the canvas.')}</div>
        )}
      </Section>
    </div>
  );
}
