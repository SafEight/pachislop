import type { Warp, WarpStyle } from '../model/types';
import { cmdsBounds, type Bounds, type PathCmd, type TextLayout } from './layout';
import { remapCmds, type PointMap, type Pt } from './remap';

// Photoshop "Warp Text" on outlines. Photoshop bakes every warp style into a Bezier patch
// (cubic 4×4 / 4×2 / 4×3, quadratic 3×3) over the text box; the constructions below are the
// ones Patchy reverse-engineered from Photoshop 2026 COM captures (control points match to
// ~1e-6 px): https://github.com/shabanmohd/patchy/blob/main/docs/warp.md and
// src/core/warp_mesh.cpp. Horizontal / vertical distortion scale the mesh rows / columns,
// which gives Photoshop's perspective-like taper.
//
// The mesh lives in CONTENT space like Photoshop's: origin at the box's top-left, +y DOWN,
// size w × h. Points map layer → (u, v) ∈ [0,1]² → patch → back to layer space (y-up).
// Unlike Photoshop (which keeps the bottom corners of an arc where they were), the warped
// frame is re-centred on the box centre so a layer does not drift as its bend changes.
//
// The warp mesh constructions are ported from Patchy (MIT License,
// Copyright (c) 2026 Seth A. Robinson); full notice in THIRD_PARTY_NOTICES.md.

interface Mesh {
  /** Control points per row (u direction) and rows (v direction), 2..4 each. */
  nu: number;
  nv: number;
  /** Row-major, content space (y-down). */
  xs: number[];
  ys: number[];
}

function identityMesh(w: number, h: number, nu: number, nv: number): Mesh {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let r = 0; r < nv; r++) {
    for (let c = 0; c < nu; c++) {
      xs.push((w * c) / (nu - 1));
      ys.push((h * r) / (nv - 1));
    }
  }
  return { nu, nv, xs, ys };
}

/**
 * One row of the classic cubic circle-arc approximation: the arc over the chord (ax,y)–(bx,y)
 * with central angle 2·theta, bulging toward −y (up in content space) when `up`.
 */
function arcRow(m: Mesh, ax: number, bx: number, y: number, theta: number, up: boolean) {
  const s = Math.sin(theta);
  const c = Math.cos(theta);
  const radius = (bx - ax) / (2 * s);
  const handle = (4 / 3) * Math.tan(theta / 2) * radius;
  const dy = up ? -handle * s : handle * s;
  m.xs.push(ax, ax + handle * c, bx - handle * c, bx);
  m.ys.push(y, y + dy, y + dy, y);
}

function flatRow(m: Mesh, w: number, y: number) {
  m.xs.push(0, w / 3, (2 * w) / 3, w);
  m.ys.push(y, y, y, y);
}

/** Photoshop's negative arc is the positive arc flipped: y → h − y, rows reversed. */
function mirrorRows(m: Mesh, h: number): Mesh {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let r = m.nv - 1; r >= 0; r--) {
    for (let c = 0; c < m.nu; c++) {
      xs.push(m.xs[r * m.nu + c]);
      ys.push(h - m.ys[r * m.nu + c]);
    }
  }
  return { nu: m.nu, nv: m.nv, xs, ys };
}

/** Control mesh of a warp style at `bend` (−100..100) over a w × h content box. */
function styleMesh(style: WarpStyle, bend: number, w: number, h: number): Mesh {
  const b = Math.min(100, Math.max(-100, bend));
  if (style === 'none' || b === 0) return identityMesh(w, h, 4, 2);
  const theta = (Math.abs(b) * Math.PI) / 200;
  const d = (2 * h * b) / 100; // flag / wave / fish / rise displacement (height based)
  const m: Mesh = { nu: 4, nv: 2, xs: [], ys: [] };
  switch (style) {
    case 'arc': {
      // Top corners swing out about the bottom corners (radius h); both edges arc with the
      // same central angle, so the band keeps its thickness.
      const s = Math.sin(theta);
      arcRow(m, -h * s, w + h * s, h * (1 - Math.cos(theta)), theta, true);
      arcRow(m, 0, w, h, theta, true);
      return b < 0 ? mirrorRows(m, h) : m;
    }
    case 'arcLower':
    case 'arcUpper':
      // One edge stays straight; the other arcs away from the box (+) or into it (−).
      flatRow(m, w, 0);
      arcRow(m, 0, w, h, theta, b < 0);
      return style === 'arcUpper' ? mirrorRows(m, h) : m;
    case 'arch':
    case 'bulge':
      // Arch: both edges bow the same way; bulge: the bottom bows the opposite way.
      arcRow(m, 0, w, 0, theta, b > 0);
      arcRow(m, 0, w, h, theta, style === 'bulge' ? b < 0 : b > 0);
      return m;
    case 'shellLower':
    case 'shellUpper': {
      // Two flat rows; the 2h/3 row's end points rotate by theta about the anchor corners,
      // and the shell edge fans out (+) or arcs into the box (−).
      const s = Math.sin(theta);
      const c = Math.cos(theta);
      m.nv = 4;
      flatRow(m, w, 0);
      flatRow(m, w, h / 3);
      if (b > 0) {
        const r = (2 * h) / 3;
        m.xs.push(-r * s, w / 3, (2 * w) / 3, w + r * s);
        m.ys.push(r * c, (2 * h) / 3, (2 * h) / 3, r * c);
        arcRow(m, -h * s, w + h * s, h * c, theta, false);
      } else {
        const r = h / 3;
        m.xs.push(-r * s, w / 3, (2 * w) / 3, w + r * s);
        m.ys.push(h - r * c, (2 * h) / 3, (2 * h) / 3, h - r * c);
        arcRow(m, 0, w, h, theta, true);
      }
      return style === 'shellUpper' ? mirrorRows(m, h) : m;
    }
    case 'flag':
      flatRow(m, w, 0);
      flatRow(m, w, h);
      m.ys[1] -= d;
      m.ys[2] += d;
      m.ys[5] -= d;
      m.ys[6] += d;
      return m;
    case 'wave':
      // Edges stay flat; only the middle row waves (the S runs opposite to flag's).
      m.nv = 3;
      flatRow(m, w, 0);
      flatRow(m, w, h / 2);
      flatRow(m, w, h);
      m.ys[5] += d;
      m.ys[6] -= d;
      return m;
    case 'fish':
      // Flag's S on the top edge, the inverted S on the bottom: pinches head and tail.
      flatRow(m, w, 0);
      flatRow(m, w, h);
      m.ys[1] -= d;
      m.ys[2] += d;
      m.ys[5] += d;
      m.ys[6] -= d;
      return m;
    case 'rise':
      // Rigid column ramp: the left half drops, the right half stays.
      flatRow(m, w, 0);
      flatRow(m, w, h);
      m.ys[0] += d;
      m.ys[1] += d;
      m.ys[4] += d;
      m.ys[5] += d;
      return m;
    case 'fisheye': {
      // Interior points move toward their nearest corner by bend/50 (on the corners at 50).
      const f = identityMesh(w, h, 4, 4);
      const t = b / 50;
      for (let r = 1; r <= 2; r++) {
        for (let c = 1; c <= 2; c++) {
          const i = r * 4 + c;
          f.xs[i] += t * ((c === 1 ? 0 : w) - f.xs[i]);
          f.ys[i] += t * ((r === 1 ? 0 : h) - f.ys[i]);
        }
      }
      return f;
    }
    case 'inflate':
    case 'squeeze': {
      // Quadratic 3×3: edge midpoints slide a quarter of the extent per 50 %. Inflate pushes
      // all four out; squeeze pushes top / bottom out and pinches the sides in.
      const q = identityMesh(w, h, 3, 3);
      const dx = (w * b) / 200;
      const dy = (h * b) / 200;
      q.ys[1] -= dy;
      q.ys[7] += dy;
      q.xs[3] += style === 'inflate' ? -dx : dx;
      q.xs[5] += style === 'inflate' ? dx : -dx;
      return q;
    }
    case 'twist': {
      // Interior ring circulates by the full extent per 100 % (clockwise on screen for +).
      const t = identityMesh(w, h, 4, 4);
      const mx = (w * Math.abs(b)) / 100;
      const my = (h * Math.abs(b)) / 100;
      if (b > 0) {
        t.xs[5] += mx;
        t.ys[6] += my;
        t.xs[10] -= mx;
        t.ys[9] -= my;
      } else {
        t.ys[5] += my;
        t.xs[6] -= mx;
        t.ys[10] -= my;
        t.xs[9] += mx;
      }
      return t;
    }
  }
}

/**
 * Photoshop's distortion: vertical first scales every ROW about the midpoint of its two edge
 * points by 1 + (2v − 1)·vertical, then horizontal scales every COLUMN likewise by
 * 1 + (2u − 1)·horizontal (Photoshop's order and pivot rule).
 */
function distort(m: Mesh, horizontal: number, vertical: number) {
  const hz = Math.min(100, Math.max(-100, horizontal)) / 100;
  const vt = Math.min(100, Math.max(-100, vertical)) / 100;
  const scale = (idx: number[], k: number) => {
    const a = idx[0];
    const z = idx[idx.length - 1];
    const mx = (m.xs[a] + m.xs[z]) / 2;
    const my = (m.ys[a] + m.ys[z]) / 2;
    for (const i of idx) {
      m.xs[i] = mx + (m.xs[i] - mx) * k;
      m.ys[i] = my + (m.ys[i] - my) * k;
    }
  };
  if (vt !== 0) {
    for (let r = 0; r < m.nv; r++) {
      scale(Array.from({ length: m.nu }, (_, c) => r * m.nu + c), 1 + (2 * (r / (m.nv - 1)) - 1) * vt);
    }
  }
  if (hz !== 0) {
    for (let c = 0; c < m.nu; c++) {
      scale(Array.from({ length: m.nv }, (_, r) => r * m.nu + c), 1 + (2 * (c / (m.nu - 1)) - 1) * hz);
    }
  }
}

/** Bernstein weights of degree n−1 at t (n = 2..4). */
function bernstein(n: number, t: number, out: number[]) {
  const s = 1 - t;
  if (n === 2) {
    out[0] = s;
    out[1] = t;
  } else if (n === 3) {
    out[0] = s * s;
    out[1] = 2 * s * t;
    out[2] = t * t;
  } else {
    out[0] = s * s * s;
    out[1] = 3 * s * s * t;
    out[2] = 3 * s * t * t;
    out[3] = t * t * t;
  }
}

/** Layer-space point map for a warp over `box`, plus the warped frame. */
interface Warper extends PointMap {
  /** Layer-space bounds of the warped box; centred on the box centre. */
  frame: Bounds;
}

function makeWarper(box: Bounds, warp: Warp): Warper | null {
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  if (!(w > 1e-6) || !(h > 1e-6)) return null;
  const m = styleMesh(warp.style, warp.bend, w, h);
  distort(m, warp.horizontal, warp.vertical);
  const wu = [0, 0, 0, 0];
  const wv = [0, 0, 0, 0];
  const evalMesh = (u: number, v: number): Pt => {
    bernstein(m.nu, u, wu);
    bernstein(m.nv, v, wv);
    let x = 0;
    let y = 0;
    for (let r = 0; r < m.nv; r++) {
      for (let c = 0; c < m.nu; c++) {
        const k = wu[c] * wv[r];
        x += k * m.xs[r * m.nu + c];
        y += k * m.ys[r * m.nu + c];
      }
    }
    return { x, y };
  };
  // Re-centre: the warped frame's bounds (sampled along the four box edges) keep the box centre.
  let fx0 = Infinity, fy0 = Infinity, fx1 = -Infinity, fy1 = -Infinity;
  const N = 64;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    for (const p of [evalMesh(t, 0), evalMesh(t, 1), evalMesh(0, t), evalMesh(1, t)]) {
      fx0 = Math.min(fx0, p.x);
      fx1 = Math.max(fx1, p.x);
      fy0 = Math.min(fy0, p.y);
      fy1 = Math.max(fy1, p.y);
    }
  }
  const sx = w / 2 - (fx0 + fx1) / 2;
  const sy = h / 2 - (fy0 + fy1) / 2;
  const size = Math.max(w, h, fx1 - fx0, fy1 - fy0);
  return {
    map: (p) => {
      const q = evalMesh((p.x - box.x0) / w, (box.y1 - p.y) / h);
      return { x: box.x0 + q.x + sx, y: box.y1 - q.y - sy };
    },
    tol: Math.max(size * 1.5e-4, 1e-3),
    span: Math.max(w, h) / 8,
    frame: { x0: box.x0 + fx0 + sx, y0: box.y1 - fy1 - sy, x1: box.x0 + fx1 + sx, y1: box.y1 - fy0 - sy },
  };
}

/** True when the warp leaves outlines untouched (renderers may skip it entirely). */
export function warpIsIdentity(warp: Warp): boolean {
  return (warp.style === 'none' || warp.bend === 0) && warp.horizontal === 0 && warp.vertical === 0;
}

/**
 * Photoshop Warp Text over `box` (the whole text block / shape bounds, y-up layer space).
 * Returns `cmds` itself when the warp is an identity; otherwise new closed contours of
 * M / L / Q commands with curves re-fitted to within ~0.015 % of the box size.
 */
export function warpCmds(cmds: PathCmd[], box: Bounds, warp: Warp): PathCmd[] {
  if (warpIsIdentity(warp)) return cmds;
  const wp = makeWarper(box, warp);
  return wp ? remapCmds(cmds, wp) : cmds;
}

/** Layer-space bounds of `box` after the warp (re-centred on the box centre); `box` for an identity. */
export function warpFrame(box: Bounds, warp: Warp): Bounds {
  if (warpIsIdentity(warp)) return box;
  return makeWarper(box, warp)?.frame ?? box;
}

/**
 * Warp every glyph of a layout over the block's FRAME (the layout without per-character
 * offsets / rotations), keeping `index` / `char` / `line` (so per-character / per-line overrides
 * still find their glyph) and mapping `center`. The warp field depends only on the frame, so
 * moving one glyph leaves every other warped glyph where it was; the adjusted glyph follows the
 * field (extrapolated smoothly past the frame edge). The warped frame stays centred on the
 * origin (no drift as the bend changes); `bounds` are the warped ink bounds. Returns `layout`
 * itself for an identity warp so downstream caches stay hot.
 */
export function warpLayout(layout: TextLayout, warp: Warp): TextLayout {
  if (warpIsIdentity(warp) || layout.glyphs.length === 0) return layout;
  const wp = makeWarper(layout.frame, warp);
  if (!wp) return layout;
  const glyphs = layout.glyphs.map((g) => ({ ...g, cmds: remapCmds(g.cmds, wp), center: wp.map(g.center) }));
  const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const g of glyphs) cmdsBounds(g.cmds, bounds);
  return { glyphs, bounds, frame: wp.frame };
}
