import { useEffect, useEffectEvent, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { decodeImage, getBitmap } from '../engine/layer2d/images';
import { clusterIslands, DEFAULT_MERGE, labelIslands, partsOf, readPixels, type ImagePart, type IslandMap, type PxBox } from '../io/imageSplit';
import { isTitleLayer } from '../model/parts';
import { errorMsg, formatMsg, msg, MsgError, type Msg } from '../store/msg';
import { useEditor } from '../store/store';
import { NumRow, Seg } from './controls';
import { useT } from './i18n';
import { splitImageLayer } from './layerActions';
import './splitImage.css';

// Layer ▸ Split image…: Photoshop's Layer via Cut, automated. The picture's alpha islands are
// grouped into parts by the merge distance (io/imageSplit.ts); each part is tinted and boxed in
// its own colour. Click selects a part, ⇧-click merges another into it or splits a merged part
// back into its islands, and Draw box makes the islands a dragged rectangle touches one part.
// Split replaces the layer by a group with one layer per part (store.splitImageLayer).

const PALETTE = ['#ff6b3d', '#2f9bff', '#3fd17a', '#ffc233', '#b26bff', '#18c8c8', '#ff4f9a', '#a3d13b', '#ff9a8f', '#6b8cff'];
const colorOf = (i: number) => PALETTE[i % PALETTE.length];
const RGB = PALETTE.map((h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16)));

interface Loaded {
  bmp: ImageBitmap;
  img: ImageData;
  map: IslandMap;
}

type Mode = 'pick' | 'box';

/** Islands of `map` that a source-px rectangle touches. */
const islandsIn = (map: IslandMap, r: PxBox) => map.islands.flatMap((b, i) => (b.x0 < r.x1 && r.x0 < b.x1 && b.y0 < r.y1 && r.y0 < b.y1 ? [i] : []));

const pct = (v: number, of: number) => `${(v / of) * 100}%`;

export function SplitImageDialog({ layerId, onClose }: { layerId: string; onClose: () => void }) {
  const t = useT();
  const layer = useEditor((s) => s.project.layers.find((l) => l.id === layerId));
  const image = isTitleLayer(layer) && layer.source.kind === 'image' ? layer : null;
  const assetId = image?.source.kind === 'image' ? image.source.assetId : null;
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<Msg | null>(null);
  const [merge, setMerge] = useState(DEFAULT_MERGE);
  const [parts, setParts] = useState<ImagePart[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>('pick');
  const [drag, setDrag] = useState<{ start: { x: number; y: number }; client: { x: number; y: number }; rect: PxBox } | null>(null);
  const [busy, setBusy] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const tintRef = useRef<HTMLCanvasElement>(null);

  // The layer went away (undo, delete): nothing to split.
  useEffect(() => {
    if (!image) onClose();
  }, [image, onClose]);

  useEffect(() => {
    if (!assetId) return;
    let live = true;
    (async () => {
      await decodeImage(assetId);
      const bmp = getBitmap(assetId);
      if (!bmp) throw new MsgError(msg('The image could not be decoded'));
      // Let “Finding the parts…” paint before the full-resolution pass.
      await new Promise((r) => requestAnimationFrame(r));
      const img = readPixels(bmp);
      if (live) setData({ bmp, img, map: labelIslands(img) });
    })().catch((e: unknown) => live && setError(errorMsg(e)));
    return () => {
      live = false;
    };
  }, [assetId]);

  // A new picture or merge distance starts over from its clustering, adjusted while rendering
  // (no frame shows the old parts over the new picture).
  const [clustered, setClustered] = useState<{ data: Loaded; merge: number } | null>(null);
  if (data && (clustered?.data !== data || clustered.merge !== merge)) {
    setClustered({ data, merge });
    setParts(clusterIslands(data.map, merge));
    setSel(null);
  }

  // The picture, once, at the working grid's resolution.
  useEffect(() => {
    const c = baseRef.current;
    if (!data || !c) return;
    const { map, bmp } = data;
    c.width = map.cols;
    c.height = map.rows;
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, map.width / map.cell, map.height / map.cell);
  }, [data]);

  const partOfIsland = useMemo(() => {
    const out = new Int32Array(data?.map.islands.length ?? 0).fill(-1);
    parts.forEach((p, pi) => p.islands.forEach((i) => (out[i] = pi)));
    return out;
  }, [data, parts]);

  // Each part's pixels tinted in its colour (the selected one stronger).
  useEffect(() => {
    const c = tintRef.current;
    if (!data || !c) return;
    const { map } = data;
    c.width = map.cols;
    c.height = map.rows;
    const tint = new ImageData(map.cols, map.rows);
    const px = tint.data;
    for (let i = 0; i < map.owner.length; i++) {
      const a = map.alpha[i];
      const o = map.owner[i];
      if (!a || o < 0) continue;
      const p = partOfIsland[o];
      if (p < 0) continue;
      const [r, g, b] = RGB[p % RGB.length];
      px[i * 4] = r;
      px[i * 4 + 1] = g;
      px[i * 4 + 2] = b;
      px[i * 4 + 3] = Math.round(a * (p === sel ? 0.75 : 0.45));
    }
    c.getContext('2d')!.putImageData(tint, 0, 0);
  }, [data, partOfIsland, sel]);

  const split = async () => {
    if (!data || parts.length < 2 || busy) return;
    setBusy(true);
    try {
      await splitImageLayer(layerId, data.img, data.map, parts);
      onClose();
    } catch (e) {
      useEditor.getState().notify(errorMsg(e), 'error');
      setBusy(false);
    }
  };
  const splitFromKey = useEffectEvent(() => void split());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        splitFromKey();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  if (!image) return null;
  const map = data?.map;

  /** Pointer → source px. */
  const toPx = (e: ReactPointerEvent) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * map!.width, y: ((e.clientY - r.top) / r.height) * map!.height };
  };

  /** The part under a source-px point: the part of the island there, else the smallest part box around it. */
  const hit = (x: number, y: number): number | null => {
    if (!map) return null;
    const cx = Math.min(map.cols - 1, Math.max(0, Math.floor(x / map.cell)));
    const cy = Math.min(map.rows - 1, Math.max(0, Math.floor(y / map.cell)));
    const c = cy * map.cols + cx;
    if (map.alpha[c] > 0 && map.owner[c] >= 0 && partOfIsland[map.owner[c]] >= 0) return partOfIsland[map.owner[c]];
    let best: number | null = null;
    let area = Infinity;
    parts.forEach(({ box: b }, i) => {
      const a = (b.x1 - b.x0) * (b.y1 - b.y0);
      if (x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1 && a < area) {
        best = i;
        area = a;
      }
    });
    return best;
  };

  /** Replace the parts by `groups` of islands and select the one holding island `keep`. */
  const regroup = (groups: number[][], keep: number | null) => {
    const next = partsOf(map!, groups);
    setParts(next);
    setSel(keep === null ? null : next.findIndex((p) => p.islands.includes(keep)));
  };

  const pick = (p: number | null, shift: boolean) => {
    if (p === null) {
      if (!shift) setSel(null);
      return;
    }
    if (!shift || sel === null) return setSel(p);
    const others = parts.filter((_, i) => i !== p && i !== sel).map((q) => q.islands);
    if (p === sel) {
      // ⇧-click on the selected part: back into its islands.
      if (parts[p].islands.length > 1) regroup([...others, ...parts[p].islands.map((i) => [i])], null);
      return;
    }
    const merged = [...parts[sel].islands, ...parts[p].islands];
    regroup([...others, merged], merged[0]);
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!map || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const s = toPx(e);
    setDrag({ start: s, client: { x: e.clientX, y: e.clientY }, rect: { x0: s.x, y0: s.y, x1: s.x, y1: s.y } });
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || mode !== 'box') return;
    const p = toPx(e);
    const s = drag.start;
    setDrag({ ...drag, rect: { x0: Math.min(s.x, p.x), y0: Math.min(s.y, p.y), x1: Math.max(s.x, p.x), y1: Math.max(s.y, p.y) } });
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || !map) return;
    setDrag(null);
    const dragged = Math.hypot(e.clientX - drag.client.x, e.clientY - drag.client.y) > 3;
    if (mode === 'box' && dragged) {
      const inside = islandsIn(map, drag.rect);
      if (!inside.length) return;
      const taken = new Set(inside);
      const rest = parts.map((p) => p.islands.filter((i) => !taken.has(i)));
      regroup([...rest, inside], inside[0]);
      return;
    }
    const p = toPx(e);
    pick(hit(p.x, p.y), e.shiftKey);
  };

  const n = parts.length;
  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal split-dialog" role="dialog" aria-modal aria-labelledby="split-title" onKeyDown={(e) => e.stopPropagation()}>
        <div className="modal-head" id="split-title">
          <span>{t('Split image “{name}”', { name: image.name })}</span>
          <button className="icon-btn right" onClick={onClose} title={t('Close')} aria-label={t('Close')}>
            ✕
          </button>
        </div>
        <div className="split-body">
          <div className="split-bar">
            <Seg
              value={mode}
              onChange={setMode}
              options={[
                { value: 'pick', label: t('Select'), title: t('Click a part to select it; ⇧-click another part to merge it in, ⇧-click a merged part to split it into its islands') },
                { value: 'box', label: t('Draw box'), title: t('Drag a rectangle: the islands it touches become one part') },
              ]}
            />
            <div className="split-merge">
              <NumRow
                label={t('Merge distance')}
                title={t('Islands closer than this (% of the image’s long side) become one part')}
                value={merge}
                onChange={(v) => setMerge(v)}
                min={0}
                max={10}
                step={0.1}
                unit="%"
                clamp
                defaultValue={DEFAULT_MERGE}
                id="split-merge"
              />
            </div>
            <span className="split-count" aria-live="polite">
              {data ? (n === 1 ? t('1 part') : t('{n} parts', { n })) : ''}
            </span>
          </div>
          <div
            ref={stageRef}
            className={`split-stage checker ${mode}`}
            style={map ? { aspectRatio: `${map.width} / ${map.height}`, width: `min(1100px, 86vw, calc(62vh * ${map.width / map.height}))` } : undefined}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={() => setDrag(null)}
          >
            {!data && <div className="split-status">{error ? formatMsg(error, t) : t('Finding the parts…')}</div>}
            <canvas ref={baseRef} hidden={!data} />
            <canvas ref={tintRef} hidden={!data} />
            {map &&
              parts.map((p, i) => (
                <div
                  key={p.islands[0]}
                  className={`split-box${i === sel ? ' sel' : ''}`}
                  style={{ left: pct(p.box.x0, map.width), top: pct(p.box.y0, map.height), width: pct(p.box.x1 - p.box.x0, map.width), height: pct(p.box.y1 - p.box.y0, map.height), borderColor: colorOf(i) }}
                >
                  <span style={{ background: colorOf(i) }}>{i + 1}</span>
                </div>
              ))}
            {map && drag && mode === 'box' && (
              <div
                className="split-rect"
                style={{ left: pct(drag.rect.x0, map.width), top: pct(drag.rect.y0, map.height), width: pct(drag.rect.x1 - drag.rect.x0, map.width), height: pct(drag.rect.y1 - drag.rect.y0, map.height) }}
              />
            )}
          </div>
          <div className="hint-line">
            {map && !map.islands.length
              ? t('The image has no opaque pixels to split')
              : mode === 'box'
                ? t('Drag a rectangle: the islands it touches become one part')
                : t('Click a part to select it; ⇧-click another part to merge it in, ⇧-click a merged part to split it into its islands')}
          </div>
        </div>
        <div className="modal-foot">
          <button onClick={onClose} title="Esc">
            {t('Cancel')}
          </button>
          <button className="primary" disabled={!data || n < 2 || busy} onClick={() => void split()} title={t('One layer per part, in a group named after the layer (Enter)')}>
            {busy ? t('Splitting…') : t('Split')}
          </button>
        </div>
      </div>
    </div>
  );
}
