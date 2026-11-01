import { useState } from 'react';
import { addAsset } from '../../assets/registry';
import { imageTrace, noDistort, noWarp, shapeSource } from '../../model/defaults';
import type { Distort, ImageTrace, Layer, LineAdjust, ShapeSource, TextSource, WarpStyle } from '../../model/types';
import { isTitleLayer, type TitleLayer } from '../../model/parts';
import { msg, type Translate } from '../../store/msg';
import { swapImageAsset } from '../../store/imageOps';
import { refKey } from '../../store/paths';
import { useEditor, type PropRef } from '../../store/store';
import { CheckRow, NumberField, NumRow, RefNum, Row, Section, Seg, SelectRow, type Option } from '../controls';
import { FontBrowser } from '../FontBrowser';
import { useT } from '../i18n';
import { oneShot, pickFile, SHAPES, useGesture } from '../util';
import { SHAPE_FIELDS } from '../viewport/shapeHandles';
import { tOpts } from './style/shared';

type SourceLayer = TitleLayer;

/** "Typography", with the values that differ from plain type, so a collapsed group still shows them. */
function typographyTitle(t: Translate, src: TextSource): string {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const on = [
    src.shear ? `${t('Italic')} ${src.shear}°` : '',
    src.hScale !== 1 ? `${t('Width 長体')} ${pct(src.hScale)}` : '',
    src.vScale !== 1 ? `${t('Height 平体')} ${pct(src.vScale)}` : '',
    src.tsume ? `${t('Tsume 詰め')} ${pct(src.tsume)}` : '',
    src.vertical && src.tateChuYoko ? '縦中横' : '',
  ].filter(Boolean);
  return on.length ? `${t('Typography')} · ${on.join(', ')}` : t('Typography');
}

function TextSourceEditor({ layer, src }: { layer: SourceLayer; src: TextSource }) {
  const t = useT();
  const { setAt, setText, setPreviewOverride } = useEditor.getState();
  const g = useGesture(`text:${layer.id}`);
  const r = (k: keyof TextSource) => ({ layerId: layer.id, path: ['source', k] });
  return (
    <>
      <textarea
        className="text-src"
        value={src.text}
        rows={Math.min(6, Math.max(2, src.text.split('\n').length + 1))}
        style={{ fontFamily: `"${src.fontId}", system-ui` }}
        onFocus={g.begin}
        onChange={(e) => {
          // Per-character tweaks follow their characters; a text-named layer follows its text.
          setText(layer.id, e.target.value, g.key());
        }}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <Row label={t('Font')}>
        <FontBrowser
          value={src.fontId}
          onChange={(id) => setAt(r('fontId'), id)}
          onHover={(id) => setPreviewOverride(id ? ({ ...layer, source: { ...src, fontId: id } } as Layer) : null)}
        />
      </Row>
      <RefNum label={t('Size')} refp={r('size')} min={8} max={800} step={1} unit="px" title={t('Em size in comp px — the whole style scales with it')} />
      <RefNum label={t('Line height')} refp={r('lineHeight')} min={0.5} max={3} step={0.01} unit="×" />
      <RefNum label={t('Tracking')} refp={r('tracking')} min={-300} max={1000} step={1} unit="‰" title={t('Thousandths of an em between characters')} />
      <Row label={t('Direction')}>
        <Seg
          value={src.vertical ? 'v' : 'h'}
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
      <Section id="text-typography" defaultOpen={false} title={typographyTitle(t, src)}>
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
        {src.vertical && (
          <CheckRow label="縦中横" value={src.tateChuYoko} onChange={(v) => setAt(r('tateChuYoko'), v, undefined, '縦中横')} title={t('Tate-chu-yoko: runs of 1–3 half-width characters (×3, !!, 50) set upright across the column')} />
        )}
      </Section>
      <LinesEditor layer={layer} src={src} />
      <WarpEditor layer={layer} />
      <DistortEditor layer={layer} />
    </>
  );
}

const NO_LINE: LineAdjust = { scale: 1, dx: 0, dy: 0 };

/** Per-line size and offset (a small 超 over a big 激アツ); columns when the text is vertical. */
function LinesEditor({ layer, src }: { layer: SourceLayer; src: TextSource }) {
  const t = useT();
  const [picked, setPicked] = useState(0);
  const setAt = useEditor((s) => s.setAt);
  const lines = src.text.split('\n');
  if (lines.length < 2) return null;
  const li = Math.min(picked, lines.length - 1);
  const adj = src.lines[li] ?? NO_LINE;
  const col = src.vertical;
  const ref = { layerId: layer.id, path: ['source', 'lines'] };
  const set = (patch: Partial<LineAdjust>, c: string, label: string) => {
    const a = { ...adj, ...patch };
    const next = { ...src.lines };
    if (a.scale === 1 && a.dx === 0 && a.dy === 0 && (a.hScale ?? 1) === 1 && (a.vScale ?? 1) === 1) delete next[li];
    else next[li] = a;
    setAt(ref, next, c, msg(col ? '{edit} (column {n})' : '{edit} (line {n})', { edit: msg(label), n: li + 1 }));
  };
  const id = `${layer.id}:line:${li}`;
  const adjusted = Object.keys(src.lines).length;
  return (
    <Section
      id="per-line"
      title={adjusted ? t(col ? 'Per-column ({n} adjusted)' : 'Per-line ({n} adjusted)', { n: adjusted }) : t(col ? 'Per-column' : 'Per-line')}
      defaultOpen={adjusted > 0}
      actions={
        adjusted > 0 && (
          <button className="small" title={t(col ? 'Reset every column' : 'Reset every line')} onClick={() => setAt(ref, {}, oneShot(id), col ? 'Reset all columns' : 'Reset all lines')}>
            {t('Reset all')}
          </button>
        )
      }
    >
      <div className="char-picker" role="tablist" aria-label={t(col ? 'Pick a column' : 'Pick a line')}>
        {lines.map((text, i) => (
          <button
            key={i}
            role="tab"
            aria-selected={i === li}
            className={`char-btn line-btn ${i === li ? 'active' : ''} ${src.lines[i] ? 'adjusted' : ''}`}
            style={{ fontFamily: `"${src.fontId}", system-ui` }}
            title={t(col ? 'Column {n}: “{text}”' : 'Line {n}: “{text}”', { n: i + 1, text })}
            onClick={() => setPicked(i)}
          >
            {text.trim() ? Array.from(text).slice(0, 6).join('') : t(col ? 'C{n}' : 'L{n}', { n: i + 1 })}
          </button>
        ))}
      </div>
      <NumRow label={t('Scale')} id={`${id}:s`} value={adj.scale} min={0.2} max={3} step={0.01} display={100} unit="%" defaultValue={1} onChange={(v, c) => set({ scale: Math.max(0.05, v) }, c, 'Scale')} title={t("Size of this line's glyphs; the spacing follows")} />
      <NumRow label={t('Width 長体')} id={`${id}:hs`} value={adj.hScale ?? 1} min={0.3} max={2} step={0.01} display={100} unit="%" defaultValue={1} onChange={(v, c) => set({ hScale: Math.max(0.05, v) }, c, 'Width')} title={t("Horizontal glyph scale of this line on top of the text's (< 100% = 長体)")} />
      <NumRow label={t('Height 平体')} id={`${id}:vs`} value={adj.vScale ?? 1} min={0.3} max={2} step={0.01} display={100} unit="%" defaultValue={1} onChange={(v, c) => set({ vScale: Math.max(0.05, v) }, c, 'Height')} title={t("Vertical glyph scale of this line on top of the text's (< 100% = 平体)")} />
      <NumRow label={t('Offset X')} id={`${id}:dx`} value={adj.dx} min={-100} max={100} step={0.5} unit="%" defaultValue={0} onChange={(v, c) => set({ dx: v }, c, 'Offset X')} title={t('% of font size')} />
      <NumRow label={t('Offset Y')} id={`${id}:dy`} value={adj.dy} min={-100} max={100} step={0.5} unit="%" defaultValue={0} onChange={(v, c) => set({ dy: v }, c, 'Offset Y')} title={t('% of font size, + = up')} />
    </Section>
  );
}

const WARP_STYLES: readonly Option<WarpStyle>[] = [
  { value: 'none', label: 'None' },
  { value: 'arc', label: 'Arc' },
  { value: 'arcLower', label: 'Arc Lower' },
  { value: 'arcUpper', label: 'Arc Upper' },
  { value: 'arch', label: 'Arch' },
  { value: 'bulge', label: 'Bulge' },
  { value: 'shellLower', label: 'Shell Lower' },
  { value: 'shellUpper', label: 'Shell Upper' },
  { value: 'flag', label: 'Flag' },
  { value: 'wave', label: 'Wave' },
  { value: 'fish', label: 'Fish' },
  { value: 'rise', label: 'Rise' },
  { value: 'fisheye', label: 'Fish Eye' },
  { value: 'inflate', label: 'Inflate' },
  { value: 'squeeze', label: 'Squeeze' },
  { value: 'twist', label: 'Twist' },
];

/** Photoshop Warp Text over the whole block / shape; rims and bevels follow the warped outline. */
function WarpEditor({ layer }: { layer: SourceLayer }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const w = layer.warp;
  const r = (k: keyof typeof w) => ({ layerId: layer.id, path: ['warp', k] });
  const active = w.style !== 'none' || w.horizontal !== 0 || w.vertical !== 0;
  return (
    <Section
      id="warp"
      title={w.style !== 'none' ? t('Warp · {style}', { style: t(WARP_STYLES.find((o) => o.value === w.style)?.label ?? w.style, undefined, { ctx: 'warp' }) }) : t('Warp')}
      defaultOpen={active}
      actions={
        active && (
          <button className="small" title={t('Remove the warp')} onClick={() => setAt({ layerId: layer.id, path: ['warp'] }, noWarp(), oneShot('warp'), 'Reset warp')}>
            {t('Reset')}
          </button>
        )
      }
    >
      <SelectRow
        label={t('Style')}
        value={w.style}
        options={tOpts(t, WARP_STYLES, 'warp')}
        // Like Photoshop, picking a style from None starts at Bend +50%.
        onChange={(style) => setAt({ layerId: layer.id, path: ['warp'] }, { ...w, style, bend: w.style === 'none' && w.bend === 0 ? 50 : w.bend }, undefined, 'Warp style')}
      />
      {w.style !== 'none' && <RefNum label={t('Bend')} refp={r('bend')} min={-100} max={100} step={1} unit="%" clamp />}
      <RefNum label={t('Horizontal')} refp={r('horizontal')} min={-100} max={100} step={1} unit="%" clamp title={t('Horizontal distortion (パース taper)')} />
      <RefNum label={t('Vertical')} refp={r('vertical')} min={-100} max={100} step={1} unit="%" clamp title={t('Vertical distortion (パース taper)')} />
    </Section>
  );
}

const DISTORT_MODES: readonly Option<Distort['mode']>[] = [
  { value: 'none', label: 'None', title: 'No free distort' },
  { value: 'corners', label: 'Corners', title: 'Perspective / distort: drag the 4 frame corners on the canvas (⇧: symmetric パース)' },
  { value: 'mesh', label: 'Mesh', title: 'Mesh warp: a 4×4 Bézier lattice on the canvas (bulges, swells, flag curls)' },
];

/**
 * Free distort (corners / mesh) and face weight, applied after the warp and before rims, bevels
 * and extrusion. Offsets are edited on the canvas; this section picks the mode and resets.
 */
function DistortEditor({ layer }: { layer: SourceLayer }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const tool = useEditor((s) => s.view.tool === 'distort');
  const setTool = useEditor((s) => s.setTool);
  const d = layer.distort;
  const ref = { layerId: layer.id, path: ['distort'] };
  const moved = d.corners.some((c) => c.x !== 0 || c.y !== 0) || d.mesh.some((c) => c.x !== 0 || c.y !== 0);
  const active = d.mode !== 'none' || layer.weight !== 0;
  return (
    <Section
      id="distort"
      title={d.mode !== 'none' ? t('Distort · {mode}', { mode: t(d.mode === 'corners' ? 'Corners' : 'Mesh') }) : t('Distort')}
      defaultOpen={active}
      actions={
        (moved || d.mode !== 'none') && (
          <button className="small" title={t('Remove the distort (corners and mesh back at rest, mode None)')} onClick={() => setAt(ref, noDistort(), oneShot(`${layer.id}:distort`), 'Reset distort')}>
            {t('Reset')}
          </button>
        )
      }
    >
      <Row label={t('Mode')} title={t('Free distort of the outline over its frame')}>
        <Seg
          value={d.mode}
          options={tOpts(t, DISTORT_MODES)}
          onChange={(mode) => setAt({ layerId: layer.id, path: ['distort', 'mode'] }, mode, undefined, msg('Distort {mode}', { mode: { en: DISTORT_MODES.find((o) => o.value === mode)?.label ?? mode, lower: true } }))}
        />
      </Row>
      <Row label="" title={t('Show the distort handles on the canvas (Distort tool, D)')}>
        <button className={`small ${tool ? 'active' : ''}`} aria-pressed={tool} onClick={() => setTool(tool ? 'move' : 'distort')}>
          ⌗ {t('Edit on canvas')}
        </button>
        {d.mode !== 'none' && (
          <button className="small" title={t('Put the handles of this mode back at rest (keeps the mode)')} onClick={() => setAt(ref, { ...noDistort(), mode: d.mode }, oneShot(`${layer.id}:distort`), 'Reset distort points')}>
            {t('Reset points')}
          </button>
        )}
      </Row>
      <RefNum
        label={t('Weight 太さ')}
        refp={{ layerId: layer.id, path: ['weight'] }}
        min={-5}
        max={5}
        step={0.05}
        unit="%"
        defaultValue={0}
        title={t('Face weight ± (offset path on the glyphs), % of size: + fattens (counters shrink), − thins. Rims, bevels and extrusion grow from the result')}
      />
    </Section>
  );
}

/**
 * The parametric fields of the ShapeSource stored at `base`: kind, height, aspect and the kind's
 * own fields. Shared by shape layers (their source) and shape masks (MaskView).
 */
export function ShapeFields({ src, base }: { src: ShapeSource; base: PropRef }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const r = (...k: string[]): PropRef => ({ layerId: base.layerId, path: [...base.path, ...k] });
  const f = SHAPE_FIELDS[src.shape];
  return (
    <>
      <SelectRow
        label={t('Kind')}
        value={src.shape}
        options={SHAPES.map((s) => ({ value: s.kind, label: t(s.label), title: t(s.hint) }))}
        // Each kind has its own sensible starting parameters; the height carries over.
        onChange={(kind) => setAt(base, shapeSource(kind, src.size), undefined, 'Shape kind')}
      />
      <RefNum label={t('Height')} refp={r('size')} min={8} max={1200} step={1} unit="px" title={t('Shape height in comp px — the whole style scales with it')} />
      <RefNum label={t('Aspect')} refp={r('aspect')} min={0.2} max={8} step={0.01} unit="x" defaultValue={src.shape === 'orb' ? 1 : undefined} title={t('Width ÷ height')} />
      {src.shape === 'orb' && (
        <div className="hint-line">
          {t('保留 orb: a circle on 2D layers; on 3D layers a true sphere (Aspect ≠ 1 makes an ellipsoid). Give it a glossy face and a glow for the classic 保留 look.')}
        </div>
      )}
      {f.corner && <RefNum label={t('Corner')} refp={r('corner')} min={0} max={50} step={0.5} unit="%" clamp title={t('Corner radius, % of height')} />}
      {f.slant && <RefNum label={t('Slant')} refp={r('slant')} min={-45} max={45} step={0.5} unit="deg" clamp title={t('+ leans right')} />}
      {f.points && (
        <RefNum
          label={t(f.points)}
          refp={r('points')}
          min={3}
          max={f.points === 'Sides' ? 16 : 64}
          integer
          clamp
          title={t(f.points === 'Sides' ? 'Number of sides' : 'Number of spikes')}
        />
      )}
      {f.inner && (
        <RefNum
          label={t(f.inner)}
          refp={r('inner')}
          min={f.inner === 'Notch' ? 0 : 0.05}
          max={f.inner === 'Notch' ? 0.9 : 0.98}
          display={100}
          unit="%"
          clamp
          title={t(f.inner === 'Notch' ? 'Notch depth of the folded ends' : 'Inner radius ÷ outer radius (spike depth)')}
        />
      )}
      {f.jitter && (
        <>
          <RefNum label={t('Jitter')} refp={r('jitter')} min={0} max={1} display={100} unit="%" clamp title={t('Random spike variation')} />
          <Row label={t('Seed')}>
            <NumberField
              id={`${refKey(base)}:seed`}
              value={src.seed}
              min={1}
              max={999}
              integer
              slider={false}
              onChange={(v, c) => setAt(r('seed'), v, c, 'Shape seed')}
            />
            <button
              className="small"
              title={t('Another random spike pattern')}
              onClick={() => setAt(r('seed'), 1 + Math.floor(Math.random() * 999), oneShot('seed'), 'Reroll shape')}
            >
              🎲 {t('Reroll')}
            </button>
          </Row>
        </>
      )}
      {f.tail === 'bubble' && (
        <>
          <RefNum label={t('Tail X')} refp={r('tail', 'x')} min={-150} max={150} step={1} unit="%" title={t('Tail tip from the centre, % of height (+ = right)')} />
          <RefNum label={t('Tail Y')} refp={r('tail', 'y')} min={-150} max={150} step={1} unit="%" title={t('Tail tip from the centre, % of height (+ = up)')} />
          <RefNum label={t('Tail width')} refp={r('tail', 'width')} min={2} max={80} step={0.5} unit="%" clamp title={t('Tail base width, % of height')} />
        </>
      )}
      {f.tail === 'fold' && <RefNum label={t('Fold')} refp={r('tail', 'x')} min={0} max={100} step={0.5} unit="%" clamp title={t('Folded-back end length, % of height')} />}
    </>
  );
}

function ShapeSourceEditor({ layer, src }: { layer: SourceLayer; src: ShapeSource }) {
  return (
    <>
      <ShapeFields src={src} base={{ layerId: layer.id, path: ['source'] }} />
      <WarpEditor layer={layer} />
      <DistortEditor layer={layer} />
    </>
  );
}

function AssetSourceEditor({ layer }: { layer: SourceLayer }) {
  const t = useT();
  const src = layer.source;
  if (src.kind === 'text' || src.kind === 'shape') return null;
  const accept = src.kind === 'image' ? 'image/png,image/jpeg,image/webp,image/gif' : src.kind === 'model' ? '.glb' : '.svg,image/svg+xml';
  return (
    <>
      <Row label={t('Asset')}>
        <button
          className="small"
          onClick={async () => {
            const file = await pickFile(accept);
            if (!file) return;
            const mime = src.kind === 'model' ? 'model/gltf-binary' : src.kind === 'svg' ? 'image/svg+xml' : file.type || 'image/png';
            const a = addAsset({ name: file.name, mime, data: await file.arrayBuffer() });
            const st = useEditor.getState();
            const cur = st.project.layers.find((l) => l.id === layer.id);
            // An image's own picture fills its 2D face (plain look): the fill follows the new picture.
            if (isTitleLayer(cur) && cur.source.kind === 'image')
              st.replaceLayer(cur.id, swapImageAsset(cur, cur.source.assetId, a.id), undefined, msg('Replace the image of “{name}”', { name: cur.name }));
            else st.setAt({ layerId: layer.id, path: ['source', 'assetId'] }, a.id);
          }}
        >
          {t('Replace…')}
        </button>
      </Row>
      <RefNum label={t('Size')} refp={{ layerId: layer.id, path: ['source', 'size'] }} min={8} max={2000} step={1} unit="px" title={t('Larger side in comp px')} />
      {layer.kind === 'title3d' && src.kind === 'image' && <ImageTraceEditor layer={layer} />}
    </>
  );
}

/** How a 3D image layer's alpha becomes the outline that is extruded / inflated (ImageSource.trace). */
function ImageTraceEditor({ layer }: { layer: SourceLayer }) {
  const t = useT();
  const r = (key: keyof ImageTrace): PropRef => ({ layerId: layer.id, path: ['source', 'trace', key] });
  const d = imageTrace();
  return (
    <Section id="image-outline" title={t('Image → Outline')}>
      <RefNum
        label={t('Threshold')}
        refp={r('threshold')}
        min={0}
        max={255}
        integer
        clamp
        defaultValue={d.threshold}
        title={t('Alpha at which the outline is drawn: pixels at least this opaque are inside (higher = tighter, drops soft edges and glows)')}
      />
      <RefNum
        label={t('Smooth')}
        refp={r('smooth')}
        min={0}
        max={5}
        step={0.05}
        clamp
        unit="%"
        defaultValue={d.smooth}
        title={t('Rounds the stair-stepped pixel corners of the outline, % of size (0 = follows the pixels exactly)')}
      />
      <RefNum
        label={t('Despeckle')}
        refp={r('despeckle')}
        min={0}
        max={2}
        step={0.01}
        clamp
        unit="%"
        defaultValue={d.despeckle}
        title={t('Drops specks and holes smaller than this area, % of size squared')}
      />
    </Section>
  );
}

/**
 * The source section of a title layer node: text / shape / asset settings (text: typography
 * collapsed), then the outline operations — per-line, warp, distort. Per-character editing is
 * the Letters section's.
 */
export function TextSection({ layer }: { layer: SourceLayer }) {
  const t = useT();
  const src = layer.source;
  const title = src.kind === 'text' ? t('Text') : src.kind === 'shape' ? t('Shape') : t(src.kind === 'model' ? '3D model' : src.kind === 'svg' ? 'SVG logo' : 'Image');
  return (
    <Section id="source" title={title}>
      {src.kind === 'text' ? <TextSourceEditor layer={layer} src={src} /> : src.kind === 'shape' ? <ShapeSourceEditor layer={layer} src={src} /> : <AssetSourceEditor layer={layer} />}
    </Section>
  );
}
