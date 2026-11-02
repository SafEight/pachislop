import { useContext, useEffect, useRef } from 'react';
import type { CharAdjust, TextSource } from '../../model/types';
import type { TitleLayer } from '../../model/parts';
import { msg } from '../../store/msg';
import { useEditor } from '../../store/store';
import { NumRow, Row, Section } from '../controls';
import { useT } from '../i18n';
import { FindProbe, useOpenSection } from '../sectionMemory';
import { oneShot } from '../util';
import { mapAdjusts, NO_ADJUST } from '../viewport/glyphs';
import { InfoTip } from './InfoTip';
import { LetterMaterials } from './LetterMaterials';
import { firstLetter } from './searchIndex';
import { fillCss, material3DCss } from './style/shared';

// The Letters section of a text title: per-character offsets, scale, rotation, 3D push / tilt and
// split-colour faces. It sits after Appearance (it is about how single letters look), not in Text.

type SourceLayer = TitleLayer;

/** CSS swatch of a character's face override for the layer's kind, or null. */
function faceCss(layer: SourceLayer, a: CharAdjust | undefined): string | null {
  if (layer.kind === 'title2d') return a?.face ? fillCss(a.face.fill) : null;
  return a?.face3d ? material3DCss(a.face3d) : null;
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
            <NumRow label="X" id={`${id}:dx`} value={adj.dx} min={-50} max={50} step={0.1} unit="%" defaultValue={0} onChange={(v, c) => setAdj({ dx: v }, c, 'Character X')} title={t('% of font size, + = right')} />
            <NumRow label="Y" id={`${id}:dy`} value={adj.dy} min={-50} max={50} step={0.1} unit="%" defaultValue={0} onChange={(v, c) => setAdj({ dy: v }, c, 'Character Y')} title={t('% of font size, + = up')} />
            {layer.kind === 'title3d' && (
              <>
                <NumRow label="Z" id={`${id}:dz`} value={adj.dz ?? 0} min={-100} max={100} step={0.5} unit="%" defaultValue={0} onChange={(v, c) => setAdj({ dz: v }, c, 'Character Z')} title={t('% of font size, + = toward the viewer')} />
                <NumRow label={t('Rotation X')} id={`${id}:tx`} value={adj.tiltX ?? 0} min={-89} max={89} step={0.5} unit="deg" clamp defaultValue={0} onChange={(v, c) => setAdj({ tiltX: v }, c, 'Character rotation X')} title={t('+ = top toward the viewer')} />
                <NumRow label={t('Rotation Y')} id={`${id}:ty`} value={adj.tiltY ?? 0} min={-89} max={89} step={0.5} unit="deg" clamp defaultValue={0} onChange={(v, c) => setAdj({ tiltY: v }, c, 'Character rotation Y')} title={t('+ = right side away from the viewer')} />
              </>
            )}
            <NumRow
              label={layer.kind === 'title3d' ? t('Rotation Z') : t('Rotation')}
              id={`${id}:r`}
              value={adj.rotate}
              min={-180}
              max={180}
              step={0.5}
              unit="deg"
              defaultValue={0}
              onChange={(v, c) => setAdj({ rotate: v }, c, layer.kind === 'title3d' ? 'Character rotation Z' : 'Character rotation')}
              title={t('Clockwise on screen')}
            />
            <NumRow label={t('Scale')} id={`${id}:s`} value={adj.scale} min={0.2} max={3} step={0.01} display={100} unit="%" defaultValue={1} onChange={(v, c) => setAdj({ scale: Math.max(0.01, v) }, c, 'Character scale')} />
            <NumRow label={t('Width 長体')} id={`${id}:hs`} value={adj.hScale ?? 1} min={0.3} max={2} step={0.01} display={100} unit="%" defaultValue={1} onChange={(v, c) => setAdj({ hScale: Math.max(0.05, v) }, c, 'Character width (長体/平体)')} title={t("Horizontal glyph scale on top of the text's; < 100% = 長体 (condensed). The line reflows. Also: the side bars of the canvas gizmo")} />
            <NumRow label={t('Height 平体')} id={`${id}:vs`} value={adj.vScale ?? 1} min={0.3} max={2} step={0.01} display={100} unit="%" defaultValue={1} onChange={(v, c) => setAdj({ vScale: Math.max(0.05, v) }, c, 'Character height (長体/平体)')} title={t("Vertical glyph scale on top of the text's; < 100% = 平体 (flattened). Also: the top / bottom bars of the canvas gizmo")} />
            <LetterMaterials key={layer.id} layer={layer} src={src} selected={selected} />
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
