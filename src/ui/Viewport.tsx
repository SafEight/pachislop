import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { registry } from '../assets/registry';
import { effectAngle, getEffect, globalLitAngle } from '../effects/registry';
import { globalFromAngle } from '../effects/globalLight';
import { Engine } from '../engine/Engine';
import type { EffectDef } from '../engine/contracts';
import { onLayer2DInvalidate } from '../engine/layer2d/Title2DRenderer';
import { onEnvironmentReady } from '../engine/three/environment';
import { onModelReady } from '../engine/three/Layer3DRenderer';
import { shapeSource } from '../model/defaults';
import { isTitleLayer, parsePartKey } from '../model/parts';
import type { Layer, PartKey, Project } from '../model/types';
import { errorMsg, formatMsg, msg, type Msg } from '../store/msg';
import { partLabel } from '../store/labels';
import { effectsOf } from '../store/effects';
import { useEditor, type EditorState, type Tool } from '../store/store';
import { previewProject } from '../store/view';
import { ancestorsOf, rootIds, unionCompBounds, withDescendants } from '../store/tree';
import type { Bounds } from '../text/layout';
import './canvas.css';
import { useT } from './i18n';
import { GamutOverlay } from './GamutOverlay';
import { engineHost } from './engineHost';
import { addShapeLayer, addTextLayer } from './layerActions';
import { isTyping, oneShot, useLatest, useSpaceHand } from './util';
import { DistortHandles } from './viewport/DistortHandles';
import { drag, isDoublePress, press, type StageMap } from './viewport/drag';
import { useFileDrop } from './viewport/FileDrop';
import { GeneratorHandles } from './viewport/GeneratorHandles';
import {
  inPolygon,
  isFullFrame,
  layerHit,
  layerLocalBounds,
  layerSelectionBounds,
  layerView,
  nearPolygon,
  onAspectsChanged,
  partLocalBounds,
  ptsBounds,
  sourceBounds,
  sourceOutline,
  svgPath,
  viewCorners,
  type Pt,
} from './viewport/geometry';
import { Gizmo3D } from './viewport/Gizmo3D';
import { glyphTarget, layerTarget, startFreeRotate } from './viewport/gizmoEdit';
import { GlyphGizmo } from './viewport/GlyphGizmo';
import { nudgeGlyphs, startGlyphMove, type TextLayer } from './viewport/glyphEdit';
import { glyphGizmo, type GlyphGizmoGeom } from './viewport/glyphs';
import { gradientTarget } from './viewport/gradientTarget';
import { ARROW_PX, Handle, ROTATE_CURSOR, SNAP_PX } from './viewport/Handle';
import { LightDial } from './viewport/LightDial';
import { selectedMask } from './viewport/mask';
import { MaskHandles } from './viewport/MaskHandles';
import { GradientHandles, SourceHandles } from './viewport/ParamHandles';
import { startGradientLay, startMaskGradientLay } from './viewport/paramEdit';
import { clampTo, numParam, whenOk, wrapAngle } from './viewport/params';
import { autoSelectTarget, hitLeaf, pickable, type DrawsAt } from './viewport/pick';
import { previewWindow, type SharpWindow } from './viewport/previewWindow';
import { StatusBar } from './viewport/StatusBar';
import { TextEditOverlay } from './viewport/TextEditOverlay';

/** window.devicePixelRatio, updated when it changes (browser zoom, moving to another display). */
function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [dpr]);
  return dpr;
}

const DEG = Math.PI / 180;
/** The view as the preview's draw callback reads it (Viewport sets it on every render). */
interface PreviewView {
  /** Display px per comp px; device px per display px. */
  d: number;
  dpr: number;
  /** Render px per comp px of the whole-comp preview (while something moves), and of the settled one (previewWindow). */
  base: number;
  sharp: number;
  /** The part of the comp inside the viewport, comp px (origin comp centre, +y up). */
  visible: Bounds;
  /** A pan or zoom changed the view within SETTLE_MS: the settled render waits. */
  moving: boolean;
}
/** Quiet time after a pan or zoom before the preview renders the new view at the display's pixels. */
const SETTLE_MS = 150;
/** Screen px around a press within which a full-frame generator counts as drawn there (alpha pick). */
const PICK_ALPHA_PX = 4;
/** Straight alpha a full-frame generator must reach near the press to be picked. */
const PICK_ALPHA_MIN = 0.05;
/** Screen px around an ⌥-click within which a title's style part counts as under it. */
const PART_PICK_PX = 1;
/** Screen px around the glyph gizmo box that still count as the box (presses there never leave per-letter mode). */
const FRAME_SLACK_PX = 12;
/** Display scale limits (CSS px per comp px), shared by the wheel and the Zoom tool. */
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;
/** Zoom tool click steps (Photoshop's ladder). */
const ZOOM_STEPS = [0.05, 0.0625, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 12, 16];
/** Smallest shape the Shape tool draws, comp px (a drag shorter than this still makes a visible shape). */
const MIN_SHAPE_PX = 4;

/** A snap guide in comp coordinates. */
interface SnapLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A line a dragged box can snap to on one axis; `span` (other axis) is null for comp lines. */
interface SnapTarget {
  v: number;
  span: [number, number] | null;
}

/** A rubber band on the canvas (comp box) and what it does on release. */
interface Band {
  box: Bounds;
  kind: 'layers' | 'glyphs' | 'zoom' | 'shape';
}

/**
 * Best snap of a box's edges / centre (`edges`, one axis) to `targets` within `tol` comp px:
 * the shift to apply and the target hit, or null.
 */
function bestSnap(edges: number[], targets: SnapTarget[], tol: number): { shift: number; target: SnapTarget } | null {
  let best: { shift: number; target: SnapTarget } | null = null;
  for (const t of targets)
    for (const e of edges) {
      const shift = t.v - e;
      if (Math.abs(shift) <= tol && (!best || Math.abs(shift) < Math.abs(best.shift))) best = { shift, target: t };
    }
  return best;
}

/** Comp box spanned by two comp points. */
const boxOf = (a: Pt, b: Pt): Bounds => ({ x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) });

export function Viewport() {
  const areaRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState({ w: 800, h: 450 });
  const [error, setError] = useState<Msg | null>(null);
  const [snapLines, setSnapLines] = useState<SnapLine[]>([]);
  const [band, setBand] = useState<Band | null>(null);
  const [altDown, setAltDown] = useState(false);
  const project = useEditor((s) => s.project);
  const override = useEditor((s) => s.previewOverride);
  const selectedId = useEditor((s) => s.selectedLayerId);
  const selectedIds = useEditor((s) => s.selectedLayerIds);
  const selectedNode = useEditor((s) => s.selectedNode);
  const selectedChars = useEditor((s) => s.selectedChars);
  const textEditId = useEditor((s) => s.textEditLayerId);
  const view = useEditor((s) => s.view);
  const { setView, selectLayer, selectLayers, toggleLayerSelection, nudgeLayers, transformLayers, beginTextEdit, setAt, edit, selectChars, setFitScale } = useEditor.getState();
  const t = useT();
  // Space held is the Hand tool whatever the strip says (App tracks the key).
  const tool: Tool = useSpaceHand() ? 'hand' : view.tool;
  const insetRef = useRef<HTMLCanvasElement>(null);
  const maskViewRef = useRef<HTMLCanvasElement | null>(null);
  // The View mask canvas mounts after the store change that turns it on: draw it once it is there.
  const maskViewMount = useCallback((c: HTMLCanvasElement | null) => {
    maskViewRef.current = c;
    if (c) engineHost.invalidate();
  }, []);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const dpr = useDevicePixelRatio();
  /** The view as the draw callback needs it (set below on every render). */
  const previewView = useRef<PreviewView>({ d: 1, dpr: 1, base: 1, sharp: 1, visible: { x0: 0, y0: 0, x1: 0, y1: 0 }, moving: true });
  /** The canvas element, and the window of the comp it holds (null: the whole comp). */
  const canvasEl = useRef<HTMLCanvasElement | null>(null);
  const placed = useRef<SharpWindow['place'] | null>(null);
  const settleTimer = useRef(0);
  useSyncExternalStore(registry.subscribe, registry.getVersion); // fonts loaded → boxes change
  useEffect(() => onAspectsChanged(bump), []);

  const comp = project.comp;
  const shown = previewProject(project, override);
  const layer = shown.layers.find((l) => l.id === selectedId);

  // Engine + render scheduling: draw when the (previewed) project, the view or assets change.
  // The engine lives as long as the canvas element: made when it mounts, disposed when it goes.
  const canvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasEl.current = canvas;
    if (!canvas) return;
    let engine: Engine;
    try {
      engine = new Engine(canvas);
    } catch (e) {
      setError(msg('WebGL2 unavailable: {error}', { error: errorMsg(e) }));
      return;
    }
    engineHost.engine = engine;
    let raf = 0;
    const draw = () => {
      raf = 0;
      const s = useEditor.getState();
      const v = previewView.current;
      try {
        const shownNow = previewProject(s.project, s.previewOverride);
        const { comp } = shownNow;
        // Settled (no drag, scrub, pan or zoom going on): the visible part at the display's device
        // pixels; else the whole comp at the preview scale, with the interactive cache.
        const onScreen = v.visible.x1 > v.visible.x0 && v.visible.y1 > v.visible.y0;
        const sharp = !engine.isInteractive && !v.moving && onScreen ? previewWindow(shownNow, v.visible, v.sharp, v.base) : null;
        if (sharp) engine.render(shownNow, { scale: sharp.scale, includeGuides: true, window: sharp.window });
        else engine.render(shownNow, { scale: v.base, includeGuides: true });
        placed.current = sharp?.place ?? null;
        placeCanvas(canvas, placed.current, comp, v.d, v.dpr);
        // 引き目 inset: copy the frame now, while the WebGL drawing buffer is still valid; a
        // window holds only part of the comp, so the inset then gets the whole comp of its own.
        const inset = insetRef.current;
        if (s.view.distance && inset) {
          const bg = s.view.previewBg === 'checker' ? '#18181e' : s.view.previewBg === 'white' ? '#ffffff' : s.view.previewBg === 'black' ? '#000000' : s.view.previewBgColor;
          const w = Math.max(1, Math.round(inset.clientWidth * v.dpr));
          drawInset(inset, sharp ? imageCanvas(engine.renderOverview(shownNow, { scale: w / comp.width, includeGuides: true })) : canvas, bg);
        }
        // View mask: the layer's combined mask, greyscale, at the whole-comp preview's resolution.
        const maskView = maskViewRef.current;
        if (s.view.viewMask && maskView) drawMaskView(maskView, engine.renderMaskPreview(shownNow, s.view.viewMask, 'combined', Math.round(Math.max(comp.width, comp.height) * v.base)));
      } catch (e) {
        console.error(e);
      }
    };
    const invalidate = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    engineHost.invalidate = invalidate;
    const unsub = useEditor.subscribe((s, prev) => {
      if (
        s.project !== prev.project ||
        s.previewOverride !== prev.previewOverride ||
        s.view.viewMask !== prev.view.viewMask ||
        (s.view.distance && (!prev.view.distance || s.view.distanceScale !== prev.view.distanceScale || s.view.previewBg !== prev.view.previewBg || s.view.previewBgColor !== prev.view.previewBgColor))
      )
        invalidate();
    });
    const unsubReg = registry.subscribe(invalidate);
    const unsub2d = onLayer2DInvalidate(invalidate);
    const unsubEnv = onEnvironmentReady(invalidate);
    const unsubModel = onModelReady(invalidate);
    invalidate();
    return () => {
      unsub();
      unsubReg();
      unsub2d();
      unsubEnv();
      unsubModel();
      cancelAnimationFrame(raf);
      engineHost.engine = null;
      engineHost.invalidate = () => {};
      engine.dispose();
    };
  }, []);

  useLayoutEffect(() => {
    const el = areaRef.current!;
    const ro = new ResizeObserver(() => setAvail({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = Math.max(0.02, Math.min((avail.w - 48) / comp.width, (avail.h - 48) / comp.height));
  useEffect(() => setFitScale(fit), [fit, setFitScale]);
  const d = view.zoom === 'fit' ? fit : view.zoom;
  const dw = comp.width * d;
  const dh = comp.height * d;
  // stage origin on the device pixel grid, so a 1:1 frame is not resampled by the browser
  const left = Math.round(((avail.w - dw) / 2 + view.panX) * dpr) / dpr;
  const top = Math.round(((avail.h - dh) / 2 + view.panY) * dpr) / dpr;
  // Settled, the preview renders the visible part of the comp at the display's device pixels
  // (× the preview resolution; previewWindow), so edges stay as crisp as a 1:1 render at every
  // zoom. While a drag, scrub, pan or zoom goes on it renders the whole comp at `base`: device
  // pixels up to comp × previewRes (a larger whole frame costs too much to redraw per move;
  // beyond it the browser magnifies), with the interactive cache.
  const base = Math.min(view.previewRes, d * dpr);
  const sharp = d * dpr * view.previewRes;
  // the part of the stage inside the viewport area, comp px (origin comp centre, +y up)
  const vx0 = Math.max(0, -left) / d - comp.width / 2;
  const vx1 = Math.min(dw, avail.w - left) / d - comp.width / 2;
  const vy0 = comp.height / 2 - Math.min(dh, avail.h - top) / d;
  const vy1 = comp.height / 2 - Math.max(0, -top) / d;
  useLayoutEffect(() => {
    const v = previewView.current;
    Object.assign(v, { d, dpr, base, sharp, visible: { x0: vx0, y0: vy0, x1: vx1, y1: vy1 }, moving: true });
    // the frame on the canvas follows the stage at once; the new view renders once it settles
    if (canvasEl.current) placeCanvas(canvasEl.current, placed.current, comp, d, dpr);
    clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      v.moving = false;
      engineHost.invalidate();
    }, SETTLE_MS);
    // meanwhile a window that no longer covers the visible part gives way to the whole comp
    const p = placed.current;
    const cw = comp.width / 2;
    const ch = comp.height / 2;
    if (p && (p.x > vx0 + cw || p.x + p.width < vx1 + cw || p.y > ch - vy1 || p.y + p.height < ch - vy0)) engineHost.invalidate();
  }, [comp, d, dpr, base, sharp, vx0, vx1, vy0, vy1]);
  useEffect(() => () => clearTimeout(settleTimer.current), []);

  // comp (centre origin, y-up) ↔ stage px ↔ client px
  const S = (p: Pt) => ({ x: (p.x + comp.width / 2) * d, y: (comp.height / 2 - p.y) * d });
  const toCompPt = (clientX: number, clientY: number): Pt => {
    const r = areaRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left - left) / d - comp.width / 2, y: comp.height / 2 - (clientY - r.top - top) / d };
  };
  const stage: StageMap = {
    d,
    S,
    toComp: toCompPt,
    client(p) {
      const r = areaRef.current!.getBoundingClientRect();
      const q = S(p);
      return { x: q.x + r.left + left, y: q.y + r.top + top };
    },
  };
  const fileDrop = useFileDrop(toCompPt);

  /** Set the display scale to `nd` keeping the comp point under client (x, y) in place. */
  const live = useLatest({ d, avail, view });
  const zoomAt = (clientX: number, clientY: number, nd: number) => {
    const { d, view, avail } = live.current;
    const r = areaRef.current!.getBoundingClientRect();
    const cx = clientX - r.left - avail.w / 2;
    const cy = clientY - r.top - avail.h / 2;
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nd));
    const k = z / d;
    setView({ zoom: z, panX: cx - (cx - view.panX) * k, panY: cy - (cy - view.panY) * k });
  };

  // Wheel: pinch / Ctrl-or-Cmd + wheel zooms about the cursor; plain wheel pans.
  const onWheel = useEffectEvent((e: WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, d * Math.exp(-e.deltaY * 0.01));
    else setView({ panX: view.panX - e.deltaX, panY: view.panY - e.deltaY });
  });
  useEffect(() => {
    const el = areaRef.current!;
    const listener = (e: WheelEvent) => onWheel(e);
    el.addEventListener('wheel', listener, { passive: false });
    return () => el.removeEventListener('wheel', listener);
  }, []);

  // Zoom tool: ⌥ shows the zoom-out cursor.
  useEffect(() => {
    if (tool !== 'zoom') return;
    const onKey = (e: KeyboardEvent) => setAltDown(e.altKey);
    const onBlur = () => setAltDown(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, [tool]);

  const startPan = (e: React.PointerEvent) => {
    const sx = e.clientX;
    const sy = e.clientY;
    const { panX, panY } = view;
    if (view.zoom === 'fit') setView({ zoom: fit });
    drag(e, (ev) => setView({ panX: panX + ev.clientX - sx, panY: panY + ev.clientY - sy }), undefined, { interactive: false });
  };

  /** Zoom tool: click steps in (⌥: out) about the cursor; a drag zooms to the dragged rect. */
  const startZoom = (e: React.PointerEvent) => {
    const a = toCompPt(e.clientX, e.clientY);
    let box: Bounds | null = null;
    const out = e.altKey;
    press(
      e,
      {
        onClick: () => {
          const z = out ? ZOOM_STEPS.findLast((s) => s < d / 1.001) : ZOOM_STEPS.find((s) => s > d * 1.001);
          zoomAt(e.clientX, e.clientY, z ?? (out ? MIN_ZOOM : MAX_ZOOM));
        },
        onDrag: (ev) => {
          box = boxOf(a, toCompPt(ev.clientX, ev.clientY));
          setBand({ box, kind: 'zoom' });
        },
        onEnd: () => {
          setBand(null);
          if (!box || (box.x1 - box.x0) * d < 4 || (box.y1 - box.y0) * d < 4) return;
          const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(avail.w / (box.x1 - box.x0), avail.h / (box.y1 - box.y0))));
          // Centre the rect: its centre q lands at the area centre when pan = (−q.x, q.y) × zoom.
          setView({ zoom: z, panX: (-(box.x0 + box.x1) / 2) * z, panY: ((box.y0 + box.y1) / 2) * z });
        },
      },
      { interactive: false },
    );
  };

  /**
   * Move gesture on the selected layers (⌥ on a single 3D layer: free rotate, as the 3D gizmo's
   * ring). The moving layers' common box snaps its edges and centre to the comp edges / centre
   * and to other visible layers' edges / centres (⌘/Ctrl held: no snapping); Shift constrains to
   * the dominant axis. `onClick` runs when the press never travels.
   */
  const startLayerDrag = (e: React.PointerEvent, target: Layer, onClick?: () => void) => {
    const st = useEditor.getState();
    if (target.kind === 'title3d' && e.altKey && !target.locked && st.selectedLayerIds.length <= 1) return startFreeRotate(e, layerTarget(target), comp, onClick);
    const key = oneShot(`drag:${target.id}`);
    const sx = e.clientX;
    const sy = e.clientY;
    const layers = st.project.layers;
    const picked = st.selectedLayerIds.includes(target.id) ? st.selectedLayerIds : [target.id];
    const moving = new Set(withDescendants(layers, picked));
    // Groups move through their descendants (nudgeLayers); a group's members are not listed again.
    const ids = rootIds(layers, picked).filter((id) => {
      const l = layers.find((x) => x.id === id);
      return !!l && !l.locked && l.kind !== 'background';
    });
    // A full-frame generator has no box: its origin (the centre of its pattern / burst) snaps.
    const boxes = ids.map((id) => {
      const l = layers.find((x) => x.id === id)!;
      return viewBounds(comp, l, layers) ?? (isFullFrame(l) ? { x0: l.transform.x, y0: l.transform.y, x1: l.transform.x, y1: l.transform.y } : null);
    });
    const box0 = boxes.reduce<Bounds | null>((u, b) => (!b ? u : !u ? b : { x0: Math.min(u.x0, b.x0), y0: Math.min(u.y0, b.y0), x1: Math.max(u.x1, b.x1), y1: Math.max(u.y1, b.y1) }), null);
    const W = comp.width / 2;
    const H = comp.height / 2;
    const xs: SnapTarget[] = [-W, 0, W].map((v) => ({ v, span: null }));
    const ys: SnapTarget[] = [-H, 0, H].map((v) => ({ v, span: null }));
    for (const l of layers) {
      // Groups snap through their members; adjustments, backgrounds and full-frame generators have no box.
      if (moving.has(l.id) || !l.visible || !(isTitleLayer(l) || l.kind === 'generator')) continue;
      const b = viewBounds(comp, l, layers);
      if (!b) continue;
      for (const v of [b.x0, (b.x0 + b.x1) / 2, b.x1]) xs.push({ v, span: [b.y0, b.y1] });
      for (const v of [b.y0, (b.y0 + b.y1) / 2, b.y1]) ys.push({ v, span: [b.x0, b.x1] });
    }
    // nudgeLayers applies deltas: track what this gesture has applied so far.
    let applied = { x: 0, y: 0 };
    press(e, {
      onClick,
      onDrag: (ev) => {
        let dx = ev.clientX - sx;
        let dy = ev.clientY - sy;
        if (ev.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        let x = Math.round(dx / d);
        let y = Math.round(-dy / d);
        const lines: SnapLine[] = [];
        if (box0 && !(ev.metaKey || ev.ctrlKey)) {
          const b = { x0: box0.x0 + x, x1: box0.x1 + x, y0: box0.y0 + y, y1: box0.y1 + y };
          const sxHit = dx === 0 && ev.shiftKey ? null : bestSnap([b.x0, (b.x0 + b.x1) / 2, b.x1], xs, SNAP_PX / d);
          const syHit = dy === 0 && ev.shiftKey ? null : bestSnap([b.y0, (b.y0 + b.y1) / 2, b.y1], ys, SNAP_PX / d);
          // Snapped positions stay exact (sub-pixel) so the boxes really line up.
          if (sxHit) x = round2(x + sxHit.shift);
          if (syHit) y = round2(y + syHit.shift);
          const fy0 = b.y0 + (syHit?.shift ?? 0);
          const fy1 = b.y1 + (syHit?.shift ?? 0);
          const fx0 = b.x0 + (sxHit?.shift ?? 0);
          const fx1 = b.x1 + (sxHit?.shift ?? 0);
          if (sxHit) {
            const [a, z] = sxHit.target.span ? [Math.min(fy0, sxHit.target.span[0]), Math.max(fy1, sxHit.target.span[1])] : [-H, H];
            lines.push({ x1: sxHit.target.v, y1: a, x2: sxHit.target.v, y2: z });
          }
          if (syHit) {
            const [a, z] = syHit.target.span ? [Math.min(fx0, syHit.target.span[0]), Math.max(fx1, syHit.target.span[1])] : [-W, W];
            lines.push({ x1: a, y1: syHit.target.v, x2: z, y2: syHit.target.v });
          }
        }
        setSnapLines(lines);
        if (x === applied.x && y === applied.y) return;
        nudgeLayers(ids, round2(x - applied.x), round2(y - applied.y), key);
        applied = { x, y };
      },
      onEnd: () => setSnapLines([]),
    });
  };

  /** Rubber-band selection from a press on empty canvas: layers (Auto-Select level), or glyphs of `glyphLayer`. */
  const startMarquee = (e: React.PointerEvent, glyphLayer: TextLayer | null, onClick: () => void) => {
    const a = toCompPt(e.clientX, e.clientY);
    const add = e.shiftKey;
    const st0 = useEditor.getState();
    const layers = st0.project.layers;
    press(
      e,
      {
        onClick,
        onDrag: (ev) => {
          const r = boxOf(a, toCompPt(ev.clientX, ev.clientY));
          setBand({ box: r, kind: glyphLayer ? 'glyphs' : 'layers' });
          if (glyphLayer) {
            const gz = glyphGizmo(comp, glyphLayer, []);
            const hit = gz ? gz.glyphs.filter((g) => intersects(r, ptsBounds(gz.polys.get(g.index) ?? []))).map((g) => g.index) : [];
            selectChars(add ? [...new Set([...st0.selectedChars, ...hit])].sort((x, y) => x - y) : hit);
            return;
          }
          const ok = pickable(layers);
          const hit = layers
            .filter(ok)
            .filter((l) => {
              const lb = viewBounds(comp, l, layers);
              return lb && intersects(r, lb);
            })
            .map((l) => autoSelectTarget(layers, l, view.autoSelect).id);
          const ids = [...new Set(add ? [...st0.selectedLayerIds, ...hit] : hit)];
          if (ids.length) selectLayers(ids);
          else selectLayer(null);
        },
        onEnd: () => setBand(null),
      },
      { interactive: false },
    );
  };

  /**
   * Move tool pick at comp point p: the topmost hit layer (full-frame generators only where they
   * draw and nothing with a box is hit), raised to its top-level group by Auto-Select 'group'
   * (`invert`, the ⌘-click, swaps the level and nothing else applies). Without ⌘: at layer
   * level the selected layer wins when it is under the cursor (drag it out from under others),
   * and a press inside a selected group picks that group, so it moves as one (Photoshop).
   */
  const pickAt = (s: EditorState, p: Pt, invert: boolean): Layer | undefined => {
    const layers = s.project.layers;
    const level = invert ? (s.view.autoSelect === 'group' ? 'layer' : 'group') : s.view.autoSelect;
    const sel = invert ? undefined : layers.find((l) => l.id === s.selectedLayerId);
    // A full-frame generator is under the press where its alpha (drawn alone, at thumbnail
    // resolution) reaches PICK_ALPHA_MIN within PICK_ALPHA_PX screen px of it.
    const drawsAt: DrawsAt = (l, q) => (engineHost.engine?.layerAlphaAt(s.project, l.id, q, PICK_ALPHA_PX / d) ?? 0) >= PICK_ALPHA_MIN;
    const leaf = level === 'layer' && sel && pickable(layers)(sel) && layerHit(comp, sel, p) ? sel : hitLeaf(comp, layers, p, undefined, drawsAt);
    if (!leaf) return undefined;
    if (sel?.kind === 'group' && ancestorsOf(layers, leaf.id).some((g) => g.id === sel.id)) return sel;
    return autoSelectTarget(layers, leaf, level);
  };

  /** Click (no drag) with the tools that only point at layers: select what is under the cursor. */
  const pickClick = (s: EditorState, p: Pt, invert: boolean) => () => {
    const hit = pickAt(s, p, invert);
    if (hit?.id !== s.selectedLayerId) selectLayer(hit?.id ?? null);
  };

  const isEmptyPress = (e: React.PointerEvent) => e.target === e.currentTarget || !!(e.target as Element).closest('.stage');

  /** The text layer double-clicked under p (the selected one first), for typing in place. */
  const textUnder = (s: EditorState, p: Pt): TextLayer | undefined => {
    const layers = s.project.layers;
    const sel = layers.find((l) => l.id === s.selectedLayerId);
    if (sel && pickable(layers)(sel) && isTitleLayer(sel) && sel.source.kind === 'text' && layerHit(comp, sel, p)) return sel as TextLayer;
    return hitLeaf(comp, layers, p, (l) => isTitleLayer(l) && l.source.kind === 'text') as TextLayer | undefined;
  };

  /**
   * Double-click a text layer with Move / per-letter: type in place. Checked in the capture
   * phase, so a second press that lands on a gizmo handle (narrow glyphs are mostly handle)
   * still opens the editor.
   */
  const onAreaPointerDownCapture = (e: React.PointerEvent) => {
    if (e.button !== 0 || (tool !== 'move' && tool !== 'glyph') || !isDoublePress(e)) return;
    const s = useEditor.getState();
    if (s.textEditLayerId) return;
    const hit = textUnder(s, toCompPt(e.clientX, e.clientY));
    if (hit) {
      e.preventDefault();
      e.stopPropagation();
      beginTextEdit(hit.id);
    }
  };

  /** Move tool: select (Auto-Select), then drag to move; ⇧ adds / removes; ⌥-click: the title's part under the cursor; empty: marquee. */
  const onMovePress = (e: React.PointerEvent, s: EditorState, p: Pt) => {
    if (e.altKey && !e.shiftKey && !(e.metaKey || e.ctrlKey)) {
      // ⌥-click on a title selects the style part under the cursor (face, rim, band, side, plate);
      // an ⌥-drag still moves it (free-rotates a 3D title).
      const layers = s.project.layers;
      const sel = layers.find((l) => l.id === s.selectedLayerId);
      const title = isTitleLayer(sel) && pickable(layers)(sel) && layerHit(comp, sel, p) ? sel : hitLeaf(comp, layers, p, isTitleLayer);
      if (isTitleLayer(title)) {
        if (title.id !== s.selectedLayerId || s.selectedLayerIds.length > 1) selectLayer(title.id);
        startLayerDrag(e, title, () => {
          const st = useEditor.getState();
          const part = engineHost.engine?.partAt(st.project, title.id, p, PART_PICK_PX / d);
          if (part) st.selectNode({ kind: 'part', layerId: title.id, part });
        });
        return;
      }
    }
    const target = pickAt(s, p, e.metaKey || e.ctrlKey);
    if (!target) {
      if (isEmptyPress(e)) startMarquee(e, null, () => selectLayer(null));
      return;
    }
    if (e.shiftKey) {
      toggleLayerSelection(target.id);
      if (!useEditor.getState().selectedLayerIds.includes(target.id)) {
        e.preventDefault();
        return;
      }
      startLayerDrag(e, target);
      return;
    }
    const multi = s.selectedLayerIds.length > 1 && s.selectedLayerIds.includes(target.id);
    if (!multi) selectLayer(target.id);
    else if (target.id !== s.selectedLayerId) selectLayers(s.selectedLayerIds, target.id);
    // PS: clicking (without dragging) one layer of a multi-selection selects it alone.
    startLayerDrag(e, target, multi ? () => selectLayer(target.id) : undefined);
  };

  /**
   * Per-letter tool: a press on a glyph of any text layer selects that layer and glyph and
   * drags it (⇧ adds to the pick on the same layer; ⌥ on 3D rotates it freely, as the 3D gizmo's
   * ring). Around the picked glyphs' gizmo box the press belongs to the gizmo; on empty canvas a
   * drag marquees glyphs of the selected text and a click drops the pick.
   */
  const onGlyphPress = (e: React.PointerEvent, s: EditorState, p: Pt) => {
    const layers = s.project.layers;
    const ok = pickable(layers);
    const sel = layers.find((l) => l.id === s.selectedLayerId);
    const textSel = sel && ok(sel) && isTitleLayer(sel) && sel.source.kind === 'text' ? (sel as TextLayer) : null;
    const glyphAt = (l: TextLayer, chars: readonly number[]) => {
      const gz = glyphGizmo(comp, l, chars);
      return { gz, hit: gz ? [...gz.glyphs].reverse().find((g) => inPolygon(gz.polys.get(g.index) ?? [], p)) : undefined };
    };
    const grab = (l: TextLayer, chars: number[], gz: GlyphGizmoGeom, onClick?: () => void) => {
      const free = e.altKey ? glyphTarget(l, chars, gz) : null;
      if (free) startFreeRotate(e, free, comp, onClick);
      else startGlyphMove(e, l, chars, gz, stage, onClick);
    };
    if (textSel) {
      const { gz, hit } = glyphAt(textSel, s.selectedChars);
      if (gz && s.selectedChars.length > 0) {
        // Just around the gizmo box (a near-miss on a handle) belongs to the gizmo, even over a
        // neighbouring glyph; only a press clearly on another glyph picks it.
        const inFrame = !!gz.frame && inPolygon(gz.frame, p);
        const nearFrame = !inFrame && !!gz.frame && nearPolygon(gz.frame, p, FRAME_SLACK_PX / d);
        const picked = new Set(s.selectedChars);
        if (hit && !picked.has(hit.index) && !nearFrame) {
          const next = e.shiftKey ? [...s.selectedChars, hit.index].sort((x, y) => x - y) : [hit.index];
          selectChars(next);
          grab(textSel, next, glyphGizmo(comp, textSel, next)!);
          return;
        }
        if (hit || inFrame || nearFrame) {
          // Shift-click (no drag) on a picked glyph drops it from the pick.
          const drop = hit && e.shiftKey ? () => selectChars(s.selectedChars.filter((i) => i !== hit.index)) : undefined;
          grab(textSel, s.selectedChars, gz, drop);
          return;
        }
      } else if (hit) {
        selectChars([hit.index]);
        grab(textSel, [hit.index], glyphGizmo(comp, textSel, [hit.index])!);
        return;
      }
    }
    // A glyph of another text layer (topmost first): select that layer and the glyph.
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      if (!ok(l) || !isTitleLayer(l) || l.source.kind !== 'text' || l.id === textSel?.id || !layerHit(comp, l, p)) continue;
      const { hit } = glyphAt(l as TextLayer, []);
      if (!hit) continue;
      selectLayer(l.id);
      selectChars([hit.index]);
      grab(l as TextLayer, [hit.index], glyphGizmo(comp, l, [hit.index])!);
      return;
    }
    if (!isEmptyPress(e)) return;
    if (textSel) startMarquee(e, textSel, () => selectChars([]));
    else press(e, { onClick: () => selectLayer(null) }, { interactive: false });
  };

  /** Text tool: a click on a text layer types in it; anywhere else it adds a text there. */
  const onTextPress = (e: React.PointerEvent, s: EditorState, p: Pt) => {
    const hit = textUnder(s, p);
    const kind = s.view.textKind;
    // On release: the new inline editor must not lose focus to the press's own default action.
    press(e, { onClick: () => (hit ? beginTextEdit(hit.id) : addTextLayer(kind, p)) }, { interactive: false });
  };

  /** Shape tool: drag a box to add the options bar's shape sized to it (⇧ keeps its proportions); a click adds the default size there. */
  const onShapePress = (e: React.PointerEvent, s: EditorState, a: Pt) => {
    const kind = s.view.shapeKind;
    const dim = s.view.textKind;
    const def = shapeSource(kind);
    let box: Bounds | null = null;
    press(
      e,
      {
        onClick: () => {
          const h = def.size / 2;
          const w = (def.size * def.aspect) / 2;
          addShapeLayer(kind, dim, { x0: a.x - w, y0: a.y - h, x1: a.x + w, y1: a.y + h });
        },
        onDrag: (ev) => {
          const b = toCompPt(ev.clientX, ev.clientY);
          let w = Math.max(MIN_SHAPE_PX, Math.abs(b.x - a.x));
          let h = Math.max(MIN_SHAPE_PX, Math.abs(b.y - a.y));
          if (ev.shiftKey) {
            // The shape's own proportions, fitted to the larger side of the drag.
            if (w / h > def.aspect) h = w / def.aspect;
            else w = h * def.aspect;
          }
          box = boxOf(a, { x: a.x + Math.sign(b.x - a.x || 1) * w, y: a.y + Math.sign(b.y - a.y || 1) * h });
          setBand({ box, kind: 'shape' });
        },
        onEnd: () => {
          setBand(null);
          if (box) addShapeLayer(kind, dim, box);
        },
      },
      { interactive: false },
    );
  };

  const onAreaPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || (e.button === 0 && tool === 'hand')) return startPan(e);
    if (e.button !== 0) return;
    const s = useEditor.getState();
    if (s.textEditLayerId) return; // the inline editor's blur ends editing
    const p = toCompPt(e.clientX, e.clientY);
    const invert = e.metaKey || e.ctrlKey;
    switch (tool) {
      case 'move':
        return onMovePress(e, s, p);
      case 'glyph':
        return onGlyphPress(e, s, p);
      case 'text':
        return onTextPress(e, s, p);
      case 'shape':
        return onShapePress(e, s, p);
      case 'zoom':
        return startZoom(e);
      case 'gradient': {
        // A selected gradient mask takes the drag: its line runs from the press to the pointer.
        const sm = selectedMask(s.project, s.selectedNode);
        if (sm?.mask.kind === 'gradient' && !sm.layer.locked) return startMaskGradientLay(e, sm.layer, sm.mask, stage, pickClick(s, p, invert));
        const target = gradientTarget(s.project, s.selectedNode);
        if (target && startGradientLay(e, comp, target, s.selectedChars, stage, pickClick(s, p, invert))) return;
        return press(e, { onClick: pickClick(s, p, invert) }, { interactive: false });
      }
      default:
        // Distort / Light: their handles take their presses; a click elsewhere picks a layer.
        return press(e, { onClick: pickClick(s, p, invert) }, { interactive: false });
    }
  };

  // Arrow keys nudge picked glyphs (App's layer nudge stands aside while glyphs are picked).
  useEffect(() => {
    let burst = '';
    let at = 0;
    const onKey = (e: KeyboardEvent) => {
      if (!e.key.startsWith('Arrow') || e.metaKey || e.ctrlKey || isTyping(e.target)) return;
      const st = useEditor.getState();
      const l = st.project.layers.find((x) => x.id === st.selectedLayerId);
      if (!st.selectedChars.length || !isTitleLayer(l) || l.locked || l.source.kind !== 'text') return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
      const now = performance.now();
      if (now - at > 800) burst = `glyph-nudge:${l.id}:${now}`;
      at = now;
      nudgeGlyphs(l as TextLayer, st.selectedChars, dx, dy, burst);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---------- overlay geometry ----------
  const editing = textEditId ? shown.layers.find((l) => l.id === textEditId) : undefined;
  const title = isTitleLayer(layer) ? layer : null;
  const gen = layer?.kind === 'generator' ? layer : null;
  // Title and generator layers have a box of their own, through their transform.
  const boxed = title ?? gen;
  const lview = boxed ? layerView(comp, boxed) : null;
  // A group's box is the union of its descendants' boxes (it has no geometry of its own);
  // adjustment layers and backgrounds get none.
  const groupBox = layer?.kind === 'group' && layer.visible ? unionCompBounds(shown.layers, [layer.id]) : null;
  const groupCentre = groupBox ? { x: (groupBox.x0 + groupBox.x1) / 2, y: (groupBox.y0 + groupBox.y1) / 2 } : null;
  const compBox: Bounds = { x0: -comp.width / 2, y0: -comp.height / 2, x1: comp.width / 2, y1: comp.height / 2 };
  // Handles sit on the drawn content (source + rims / backplates; a generator's bounds, the comp
  // box for full-frame ones); a faint outer box shows the effects' reach.
  const box = boxed && boxed.visible ? layerLocalBounds(boxed, shown.layers) : null;
  const corners = lview && box ? viewCorners(lview, box).map(S) : gen?.visible ? boundsCorners(compBox).map(S) : groupBox ? boundsCorners(groupBox).map(S) : null;
  const fxBox = boxed && boxed.visible ? layerSelectionBounds(boxed) : null;
  const fxCorners = lview && fxBox && box && (fxBox.x0 !== box.x0 || fxBox.y1 !== box.y1) ? viewCorners(lview, fxBox).map(S) : null;
  const pivot = lview ? S(lview.toComp({ x: 0, y: 0 })) : groupCentre ? S(groupCentre) : null;
  const rotHandle = (() => {
    if (!corners) return null;
    const tc = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
    const cc = { x: (corners[0].x + corners[2].x) / 2, y: (corners[0].y + corners[2].y) / 2 };
    const len = Math.hypot(tc.x - cc.x, tc.y - cc.y) || 1;
    return { from: tc, at: { x: tc.x + ((tc.x - cc.x) / len) * 28, y: tc.y + ((tc.y - cc.y) / len) * 28 } };
  })();
  // Other members of a multi-selection get a thin box (groups: their descendants' box).
  const others = selectedIds
    .filter((id) => id !== selectedId)
    .map((id) => shown.layers.find((l) => l.id === id))
    .filter((l): l is Layer => !!l && l.visible)
    .map((l) => {
      if (l.kind === 'group') {
        const gb = unionCompBounds(shown.layers, [l.id]);
        return gb ? { id: l.id, pts: boundsCorners(gb).map(S) } : null;
      }
      const b = layerLocalBounds(l, shown.layers);
      if (b) return { id: l.id, pts: viewCorners(layerView(comp, l), b).map(S) };
      return isFullFrame(l) ? { id: l.id, pts: boundsCorners(compBox).map(S) } : null;
    })
    .filter((x) => x !== null);

  /** Comp point the layer scales / rotates about: its anchor, or a group's box centre. */
  const pivotOf = (l: Layer) => (l.kind === 'group' ? (groupCentre ?? { x: 0, y: 0 }) : layerView(comp, l).toComp({ x: 0, y: 0 }));

  const startScale = (e: React.PointerEvent, l: Layer) => {
    const key = oneShot(`scale:${l.id}`);
    const about = pivotOf(l);
    const c = stage.client(about);
    const d0 = Math.hypot(e.clientX - c.x, e.clientY - c.y) || 1;
    const s0 = l.transform.scale;
    const base = useEditor.getState().project.layers;
    drag(e, (ev) => {
      const f = Math.hypot(ev.clientX - c.x, ev.clientY - c.y) / d0;
      if (l.kind === 'group') {
        // Descendants scale together about the group centre, from the gesture-start snapshot.
        transformLayers([l.id], { scale: ev.shiftKey ? Math.max(0.05, Math.round(f * 20) / 20) : Math.round(f * 1000) / 1000, about }, key, 'Scale group', base);
        return;
      }
      let s = s0 * f;
      s = ev.shiftKey ? Math.round(s * 20) / 20 : Math.round(s * 1000) / 1000;
      edit((p) => withTransform(p, l.id, { scale: Math.max(0.01, s) }), key, 'Scale');
    });
  };

  const startRotate = (e: React.PointerEvent, l: Layer) => {
    const key = oneShot(`rot:${l.id}`);
    const about = pivotOf(l);
    const c = stage.client(about);
    const a0 = Math.atan2(e.clientY - c.y, e.clientX - c.x) / DEG;
    const r0 = l.transform.rotZ;
    const base = useEditor.getState().project.layers;
    drag(e, (ev) => {
      const a = Math.atan2(ev.clientY - c.y, ev.clientX - c.x) / DEG;
      if (l.kind === 'group') {
        let delta = ((((a - a0 + 180) % 360) + 360) % 360) - 180;
        delta = ev.shiftKey ? Math.round(delta / 15) * 15 : Math.round(delta * 10) / 10;
        transformLayers([l.id], { rotate: delta, about }, key, 'Rotate group', base);
        return;
      }
      let rot = r0 + a - a0;
      rot = ((((rot + 180) % 360) + 360) % 360) - 180;
      rot = ev.shiftKey ? Math.round(rot / 15) * 15 : Math.round(rot * 10) / 10;
      edit((p) => withTransform(p, l.id, { rotZ: rot }), key, 'Rotate');
    });
  };

  // ---------- selected parts ----------
  // Part nodes (or an effect of a part) on the primary layer outline those parts: 2D faces by
  // their outline, 2D rims by their grown box; 3D parts are named together on the layer box.
  const partKeys: readonly PartKey[] =
    title && selectedNode?.layerId === title.id
      ? selectedNode.kind === 'parts'
        ? selectedNode.parts
        : (selectedNode.kind === 'part' || selectedNode.kind === 'effect') && selectedNode.part !== null
          ? [selectedNode.part]
          : []
      : [];
  type XY = { x: number; y: number };
  type PartShape = { key: string; label: string; at: XY; path: string | null; pts: XY[] | null };
  const partShapes = ((): PartShape[] => {
    if (!title || !title.visible || !partKeys.length || !lview || !corners) return [];
    if (title.kind === 'title3d') return [{ key: 'parts', label: partKeys.map((k) => formatMsg(partLabel(title, k), t)).join(', '), at: corners[0], path: null, pts: null }];
    return partKeys.flatMap((partKey): PartShape[] => {
      const label = formatMsg(partLabel(title, partKey), t);
      const cmds = parsePartKey(partKey).kind === 'face' ? sourceOutline(title) : null;
      if (cmds && cmds.length > 0) {
        const sb = sourceBounds(title);
        return [{ key: partKey, label, at: sb ? S(viewCorners(lview, sb)[0]) : corners[0], path: svgPath(cmds, (p) => S(lview.toComp(p))), pts: null }];
      }
      const pb = partLocalBounds(title, partKey);
      const pts = pb ? viewCorners(lview, pb).map(S) : null;
      return pts ? [{ key: partKey, label, at: pts[0], path: null, pts }] : [];
    });
  })();

  // ---------- effect handles (the selected effect node's) ----------
  const fxNode = selectedNode?.kind === 'effect' ? selectedNode : null;
  const fxLayer = fxNode ? shown.layers.find((l) => l.id === fxNode.layerId) : undefined;
  const fxList = fxNode && fxLayer ? effectsOf(shown, { layerId: fxNode.layerId, part: fxNode.part }) : [];
  const fxIndex = fxNode ? fxList.findIndex((f) => f.id === fxNode.effectId) : -1;
  const fx = fxIndex >= 0 ? fxList[fxIndex] : undefined;
  const def = fx ? getEffect(fx.type) : undefined;
  const fxRef = (key: string) => ({
    layerId: fxNode!.layerId,
    path: fxNode!.part ? ['partEffects', fxNode!.part, fxIndex, 'params', key] : ['effects', fxIndex, 'params', key],
  });
  // Direction arrows start at the layer's anchor (a group: its box centre).
  const fxOrigin = (() => {
    if (!fxLayer) return null;
    if (fxLayer.kind !== 'group') return { x: fxLayer.transform.x, y: fxLayer.transform.y };
    const gb = unionCompBounds(shown.layers, [fxLayer.id]);
    return gb ? { x: (gb.x0 + gb.x1) / 2, y: (gb.y0 + gb.y1) / 2 } : { x: 0, y: 0 };
  })();
  const fxHandlesOn = !!fx && !editing && tool !== 'hand' && tool !== 'zoom';

  const pointHandles =
    fxHandlesOn && fx && def?.handles
      ? def.handles
          .filter((h) => whenOk(def.params, fx.params, h.when))
          .map((h) => ({ h, p: { x: numParam(def.params, fx.params, h.x).v, y: numParam(def.params, fx.params, h.y).v } }))
      : [];
  const arrows =
    fxHandlesOn && fx && fxOrigin && def?.directions
      ? def.directions
          .filter((a) => whenOk(def.params, fx.params, a.when))
          .map((a) => {
            // Use Global Light: the arrow shows (and its drag sets) comp.globalLight instead of the param.
            const ang = effectAngle(fx, a.angle, comp);
            const len = a.length ? numParam(def.params, fx.params, a.length).v : ARROW_PX / d;
            const dir = a.convention === 'cwFromRight' ? { x: Math.cos(ang * DEG), y: -Math.sin(ang * DEG) } : { x: Math.cos(ang * DEG), y: Math.sin(ang * DEG) };
            const o = fxOrigin;
            const shownLen = Math.max(len, 24 / d);
            return { a, from: S(o), to: S({ x: o.x + dir.x * shownLen, y: o.y + dir.y * shownLen }) };
          })
      : [];

  const startPointHandle = (e: React.PointerEvent, h: { x: string; y: string }) => {
    if (!def || !fx) return;
    const key = oneShot(`fxh:${fx.id}`);
    const px = numParam(def.params, fx.params, h.x).pd;
    const py = numParam(def.params, fx.params, h.y).pd;
    drag(e, (ev) => {
      let p = toCompPt(ev.clientX, ev.clientY);
      if (ev.shiftKey) p = { x: Math.abs(p.x) * d < SNAP_PX ? 0 : p.x, y: Math.abs(p.y) * d < SNAP_PX ? 0 : p.y };
      setAt(fxRef(h.x), Math.round(clampTo(px, p.x)), key);
      setAt(fxRef(h.y), Math.round(clampTo(py, p.y)), key);
    });
  };

  const startArrow = (e: React.PointerEvent, a: NonNullable<EffectDef['directions']>[number]) => {
    if (!def || !fx || !fxOrigin) return;
    const key = oneShot(`fxd:${fx.id}`);
    const pa = numParam(def.params, fx.params, a.angle).pd;
    const pl = a.length ? numParam(def.params, fx.params, a.length).pd : undefined;
    const o = fxOrigin;
    drag(e, (ev) => {
      const p = toCompPt(ev.clientX, ev.clientY);
      const vx = p.x - o.x;
      const vy = p.y - o.y;
      let ang = Math.atan2(a.convention === 'cwFromRight' ? -vy : vy, vx) / DEG;
      if (ev.shiftKey) ang = Math.round(ang / 15) * 15;
      const spec = globalLitAngle(fx, a.angle);
      if (spec) setAt({ layerId: null, path: ['comp', 'globalLight', 'angle'] }, Math.round(globalFromAngle(spec, wrapAngle(pa, ang))), key, 'Global light angle');
      else setAt(fxRef(a.angle), Math.round(wrapAngle(pa, ang)), key);
      if (a.length) setAt(fxRef(a.length), Math.round(clampTo(pl, Math.hypot(vx, vy))), key);
    });
  };

  // ---------- per tool ----------
  const textLayer = title && title.source.kind === 'text' && title.visible ? (title as TextLayer) : null;
  const glyphTool = tool === 'glyph' && !!textLayer && !textLayer.locked && !editing;
  const glyphMode = glyphTool && selectedChars.length > 0;
  const gz = glyphTool && textLayer ? glyphGizmo(comp, textLayer, selectedChars) : null;
  // Characters with their own face colour get a marker on their glyph box.
  const faced = new Set(
    gz && textLayer
      ? Object.entries(textLayer.source.chars)
          .filter(([, a]) => (textLayer.kind === 'title2d' ? a.face : a.face3d || a.bands3d || a.side3d))
          .map(([k]) => Number(k))
      : [],
  );
  const poly = (pts: Pt[]) => pts.map((q) => `${q.x},${q.y}`).join(' ');
  const usable = title && title.visible && !title.locked && !editing ? title : null;
  // A mask node edits the mask (its own handles below), not the layer's transform.
  const transformHandles = tool === 'move' && view.showHandles && !!layer && !layer.locked && !editing && selectedNode?.kind !== 'mask';
  // Shape / warp handles belong to the layer itself: Move tool on a layer node.
  const sourceHandles = usable && transformHandles && selectedNode?.kind === 'layer' ? usable : null;
  const distortLayer = tool === 'distort' && usable && (usable.source.kind === 'text' || usable.source.kind === 'shape') ? usable : null;
  const gradTarget = tool === 'gradient' && usable ? gradientTarget(shown, selectedNode) : null;
  // A generator's own handles (centre, radius, angle…) while its layer node is selected, with every tool that points at layers.
  const genHandles = gen && gen.visible && !gen.locked && !editing && tool !== 'hand' && tool !== 'zoom' && selectedNode?.kind === 'layer' ? gen : null;
  // The Global Light dial: beside the selected layer, else at the comp's top-right corner.
  const lightAt = tool === 'light' && !editing ? (corners ? corners.reduce((b, q) => (q.x - q.y > b.x - b.y ? q : b), corners[0]) : { x: dw - 72, y: 72 }) : null;
  // The selected shape / gradient mask: outlined with every tool, editable with Move (and the Gradient tool on a gradient mask).
  const maskSel = editing ? null : selectedMask(shown, selectedNode);
  const maskShown = maskSel && maskSel.mask.kind !== 'layer' ? { layer: maskSel.layer, mask: maskSel.mask } : null;
  const maskActive = !!maskShown && !maskShown.layer.locked && (tool === 'move' || (tool === 'gradient' && maskShown.mask.kind === 'gradient'));
  // View mask (⌥-click a mask chip): the layer's combined mask replaces the frame on screen.
  const maskViewLayer = view.viewMask ? shown.layers.find((l) => l.id === view.viewMask && l.masks.length > 0) : undefined;

  const stageBg =
    view.previewBg === 'checker' ? undefined : { background: view.previewBg === 'black' ? '#000' : view.previewBg === 'white' ? '#fff' : view.previewBgColor };
  // A single selected 3D layer gets the 3D gizmo instead of the rotate stem; picked glyphs of a 3D text get it too.
  const gizmoLayer = transformHandles && layer?.kind === 'title3d' && layer.visible && selectedIds.length === 1 ? layer : null;
  const glyphGizmo3D = glyphMode && gz && textLayer ? glyphTarget(textLayer, selectedChars, gz) : null;
  const cursorClass = `tool-${tool}${tool === 'zoom' && altDown ? ' zoom-out' : ''}`;
  return (
    <div className="viewport">
      <div
        className={`viewport-area ${cursorClass}`}
        ref={areaRef}
        onPointerDownCapture={onAreaPointerDownCapture}
        onPointerDown={onAreaPointerDown}
        {...fileDrop.handlers}
      >
        {error && <div className="viewport-error">{formatMsg(error, t)}</div>}
        <div className={`stage ${view.previewBg === 'checker' ? 'checker' : ''} ${editing ? 'text-editing' : ''}`} style={{ left, top, width: dw, height: dh, ...stageBg }}>
          <canvas ref={canvasRef} className={view.valueCheck ? 'value-check' : ''} />
          {view.gamut && <GamutOverlay />}
          {maskViewLayer && <canvas ref={maskViewMount} className="mask-view" style={{ width: dw, height: dh }} />}
        </div>
        {view.distance && (
          <div className="distance-inset" title={t('引き目: the comp at real LCD scale')}>
            <canvas
              ref={insetRef}
              className={view.valueCheck ? 'value-check' : ''}
              style={{ width: comp.width * view.distanceScale, height: comp.height * view.distanceScale }}
            />
            <span className="muted">引き目 {Math.round(view.distanceScale * 1000) / 10}%</span>
          </div>
        )}
        {maskViewLayer && (
          <div className="mask-view-badge" style={{ left, top }} onPointerDown={(e) => e.stopPropagation()}>
            <span>{t('Mask of “{name}”', { name: maskViewLayer.name })}</span>
            <button type="button" title={t('Show the image again (or ⌥-click the mask chip)')} onClick={() => setView({ viewMask: null })}>
              ✕
            </button>
          </div>
        )}
        <svg className="overlay" style={{ left, top, width: dw, height: dh }} width={dw} height={dh}>
          <rect className="comp-outline" x={0} y={0} width={dw} height={dh} />
          {view.safeGuides && (
            <g className="safe">
              <rect x={dw * 0.05} y={dh * 0.05} width={dw * 0.9} height={dh * 0.9} />
              <rect x={dw * 0.1} y={dh * 0.1} width={dw * 0.8} height={dh * 0.8} />
              <line x1={dw / 2} y1={0} x2={dw / 2} y2={dh} />
              <line x1={0} y1={dh / 2} x2={dw} y2={dh / 2} />
            </g>
          )}
          {others.map((o) => (
            <polygon key={o.id} className="sel-box other" points={poly(o.pts)} />
          ))}
          {gz &&
            gz.glyphs.map((g) => {
              const pts = gz.polys.get(g.index);
              return pts ? <polygon key={g.index} className={`glyph-box ${faced.has(g.index) ? 'has-face' : ''}`} points={poly(pts.map(S))} /> : null;
            })}
          {layer && corners && !layer.locked && !editing && (
            <g className={`selection ${glyphTool ? 'glyph-mode' : ''}`}>
              {fxCorners && (
                <polygon className="fx-box" points={poly(fxCorners)}>
                  <title>{t("Reach of the layer's effects")}</title>
                </polygon>
              )}
              <polygon className="sel-box" points={poly(corners)} />
              {transformHandles && !gizmoLayer && rotHandle && <line className="rot-stem" x1={rotHandle.from.x} y1={rotHandle.from.y} x2={rotHandle.at.x} y2={rotHandle.at.y} />}
              {transformHandles &&
                corners.map((c, i) => (
                  <Handle key={i} x={c.x} y={c.y} cursor={i % 2 === 0 ? 'nwse-resize' : 'nesw-resize'} title={t('Drag to scale (Shift: 5% steps)')} onDown={(e) => startScale(e, layer)}>
                    <rect className="handle scale" x={c.x - 5} y={c.y - 5} width={10} height={10} />
                  </Handle>
                ))}
              {transformHandles && !gizmoLayer && rotHandle && (
                <Handle x={rotHandle.at.x} y={rotHandle.at.y} cursor={ROTATE_CURSOR} title={t('Drag to rotate (Shift: 15° steps)')} onDown={(e) => startRotate(e, layer)}>
                  <circle className="handle rot" cx={rotHandle.at.x} cy={rotHandle.at.y} r={6} />
                </Handle>
              )}
              {transformHandles && !gizmoLayer && pivot && <circle className="pivot" cx={pivot.x} cy={pivot.y} r={3} />}
            </g>
          )}
          {gizmoLayer && <Gizmo3D key={`layer:${gizmoLayer.id}`} comp={comp} target={layerTarget(gizmoLayer)} stage={stage} />}
          {!editing &&
            partShapes.map((shape) => (
              <g key={shape.key} className="part-outline">
                {shape.path && <path d={shape.path} />}
                {shape.pts && <polygon points={poly(shape.pts)} />}
                <text x={shape.at.x} y={shape.at.y - 6}>
                  {shape.label}
                </text>
              </g>
            ))}
          {sourceHandles && <SourceHandles comp={comp} layer={sourceHandles} stage={stage} />}
          {gradTarget && <GradientHandles comp={comp} target={gradTarget} selectedChars={selectedChars} stage={stage} />}
          {distortLayer && <DistortHandles comp={comp} layer={distortLayer} stage={stage} />}
          {genHandles && <GeneratorHandles comp={comp} layer={genHandles} stage={stage} />}
          {maskShown && <MaskHandles layer={maskShown.layer} mask={maskShown.mask} stage={stage} active={maskActive} />}
          {glyphMode && gz && textLayer && <GlyphGizmo layer={textLayer} gz={gz} stage={stage} indices={selectedChars} />}
          {/* Above the glyph handles: the side bars it may cover have twins on the other side (left / bottom). */}
          {glyphGizmo3D && <Gizmo3D key={`glyph:${glyphGizmo3D.id}`} comp={comp} target={glyphGizmo3D} stage={stage} />}
          {lightAt && <LightDial comp={comp} at={lightAt} />}
          {band && (
            <rect
              className={`marquee ${band.kind}`}
              x={S({ x: band.box.x0, y: band.box.y1 }).x}
              y={S({ x: band.box.x0, y: band.box.y1 }).y}
              width={(band.box.x1 - band.box.x0) * d}
              height={(band.box.y1 - band.box.y0) * d}
            />
          )}
          {snapLines.map((ln, i) => {
            const a = S({ x: ln.x1, y: ln.y1 });
            const b = S({ x: ln.x2, y: ln.y2 });
            return <line key={i} className="snap" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
          })}
          {arrows.map(({ a, from, to }) => (
            <g key={a.angle} className="fx-arrow">
              <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
              <Handle
                x={to.x}
                y={to.y}
                cursor="move"
                title={a.length ? t('{label}: drag to set direction and distance (Shift: 15°)', { label: t(a.label) }) : t('{label}: drag to set direction (Shift: 15°)', { label: t(a.label) })}
                onDown={(e) => startArrow(e, a)}
              >
                <circle className="handle dir" cx={to.x} cy={to.y} r={7} />
              </Handle>
              <text x={to.x + 10} y={to.y - 8}>
                {t(a.label)}
              </text>
            </g>
          ))}
          {pointHandles.map(({ h, p }) => {
            const q = S(p);
            return (
              <g key={h.x} className="fx-point">
                <Handle x={q.x} y={q.y} cursor="move" title={t('{label}: drag to move (Shift snaps to centre)', { label: t(h.label) })} onDown={(e) => startPointHandle(e, h)}>
                  <circle className="handle pt" cx={q.x} cy={q.y} r={8} />
                </Handle>
                <line x1={q.x - 12} y1={q.y} x2={q.x + 12} y2={q.y} />
                <line x1={q.x} y1={q.y - 12} x2={q.x} y2={q.y + 12} />
                <text x={q.x + 12} y={q.y - 10}>
                  {t(h.label)}
                </text>
              </g>
            );
          })}
        </svg>
        {isTitleLayer(editing) && editing.source.kind === 'text' && (
          <TextEditOverlay layer={editing as TextLayer} comp={comp} stage={stage} left={left} top={top} />
        )}
        {fileDrop.overlay}
      </div>
      <StatusBar d={d} tool={tool} />
    </div>
  );
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Corners of an axis-aligned comp box: TL, TR, BR, BL (screen order). */
const boundsCorners = (b: Bounds): Pt[] => [
  { x: b.x0, y: b.y1 },
  { x: b.x1, y: b.y1 },
  { x: b.x1, y: b.y0 },
  { x: b.x0, y: b.y0 },
];

/** Put the View mask image (the whole comp frame, greyscale) into its canvas. */
function drawMaskView(c: HTMLCanvasElement, img: ImageData) {
  if (c.width !== img.width) c.width = img.width;
  if (c.height !== img.height) c.height = img.height;
  c.getContext('2d')?.putImageData(img, 0, 0);
}

/** Axis-aligned comp box of a layer's content (source + rims / backplates, a generator's bounds; 3D layers projected; groups: their descendants), or null (full-frame generators too). */
function viewBounds(comp: Project['comp'], l: Layer, layers: readonly Layer[]): Bounds | null {
  if (l.kind === 'group') return unionCompBounds(layers, [l.id]);
  const b = layerLocalBounds(l, layers);
  return b ? ptsBounds(viewCorners(layerView(comp, l), b)) : null;
}

const intersects = (a: Bounds, b: Bounds) => a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;

/** Draw the rendered frame (the whole comp) into the 引き目 inset at its CSS size × devicePixelRatio. */
function drawInset(inset: HTMLCanvasElement, frame: HTMLCanvasElement | OffscreenCanvas, bg: string) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(inset.clientWidth * dpr));
  const h = Math.max(1, Math.round(inset.clientHeight * dpr));
  if (inset.width !== w) inset.width = w;
  if (inset.height !== h) inset.height = h;
  const ctx = inset.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(frame, 0, 0, frame.width, frame.height, 0, 0, w, h);
}

/** `img` on a canvas of its own, for drawInset. */
function imageCanvas(img: ImageData): OffscreenCanvas {
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d')?.putImageData(img, 0, 0);
  return c;
}

/**
 * Lay the preview canvas over the part of the stage its frame shows: `place` (comp px from the
 * comp's top-left corner, previewWindow) or, null, the whole comp; `d` display px per comp px.
 * A window's corner snaps to the device pixel grid, so a window at the display's scale maps 1:1
 * to its pixels (the stage origin is on that grid too).
 */
function placeCanvas(canvas: HTMLCanvasElement, place: SharpWindow['place'] | null, comp: Project['comp'], d: number, dpr: number) {
  const s = canvas.style;
  s.position = 'absolute';
  s.left = `${place ? Math.round(place.x * d * dpr) / dpr : 0}px`;
  s.top = `${place ? Math.round(place.y * d * dpr) / dpr : 0}px`;
  s.width = `${(place ? place.width : comp.width) * d}px`;
  s.height = `${(place ? place.height : comp.height) * d}px`;
}

function withTransform(p: Project, id: string, patch: Partial<Layer['transform']>) {
  return { ...p, layers: p.layers.map((l) => (l.id === id ? ({ ...l, transform: { ...l.transform, ...patch } } as Layer) : l)) };
}
