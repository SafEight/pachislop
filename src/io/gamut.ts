// CMYK gamut warning (Photoshop View ▸ Gamut Warning) as a soft proof through an ICC printer profile.
//
// The proof uses Relative Colorimetric with Black Point Compensation, Photoshop's default proof
// setup: a colour warns when its CIEDE2000 difference to what the press prints of it (sRGB → Lab →
// CMYK → Lab through the profile, src/io/icc.ts) exceeds GAMUT_DELTA_E. The profile is the bundled
// Japan Color 2011 Coated (public/icc/) unless the user loaded their own, which is kept in IndexedDB
// so it survives reloads.

import { parseIcc, softProof } from './icc';
import { msg, MsgError } from '../store/msg';

/** ΔE00 above which a colour counts as out of gamut: the usual soft-proof gamut-warning tolerance. */
export const GAMUT_DELTA_E = 2.5;

/** File name of the bundled profile in public/icc/. */
export const BUNDLED_ICC = 'JapanColor2011Coated.icc';

/** The profile the gamut check proofs against. */
export interface GamutProfile {
  /** The profile's description, else its file name. */
  readonly name: string;
  /** Loaded by the user (else the bundled profile). */
  readonly user: boolean;
}

interface Proof {
  readonly info: GamutProfile;
  /** Soft-proof ΔE00 on a GRID³ lattice over sRGB 0..255 (red slowest). */
  readonly deltaE: Float32Array;
  /** Per 18-bit colour (6 bits per channel): 0 = untested, 1 = inside, 2 = outside. Kept across masks. */
  readonly cache: Uint8Array;
}

/** User profile record in IndexedDB. */
interface StoredProfile {
  fileName: string;
  data: ArrayBuffer;
}

const DB = 'pachislot-visuals-icc';
const STORE = 'profiles';
const KEY = 'user';

let active: Proof | null = null;
let pending: Promise<GamutProfile> | null = null;

/**
 * Nodes per channel of the ΔE lattice. A full round trip costs 2–10 µs, too slow for the up to
 * 262k colours of a frame, so the proof is sampled once per profile (~36k proofs) and colours
 * interpolate it trilinearly; that flips ~0.2 % of colours, all within a hair of the threshold.
 */
const GRID = 33;
const STEP = 255 / (GRID - 1);

/** Parses `data` and samples its proof; throws `MsgError` when it isn't a usable CMYK profile. */
function prepare(data: ArrayBuffer, fileName: string, user: boolean): Proof {
  const profile = parseIcc(data);
  const proof = softProof(profile, 'relative', true);
  const deltaE = new Float32Array(GRID ** 3);
  for (let r = 0, k = 0; r < GRID; r++) for (let g = 0; g < GRID; g++) for (let b = 0; b < GRID; b++, k++) deltaE[k] = proof(r * STEP, g * STEP, b * STEP).deltaE;
  return { info: { name: profile.name || fileName.replace(/\.ic[cm]$/i, ''), user }, deltaE, cache: new Uint8Array(1 << 18) };
}

/** Trilinearly interpolated soft-proof ΔE of an sRGB colour (0..255 values). */
function proofDeltaE(lattice: Float32Array, r: number, g: number, b: number): number {
  const fr = r / STEP;
  const fg = g / STEP;
  const fb = b / STEP;
  const i = Math.min(GRID - 2, Math.floor(fr));
  const j = Math.min(GRID - 2, Math.floor(fg));
  const l = Math.min(GRID - 2, Math.floor(fb));
  const tr = fr - i;
  const tg = fg - j;
  const tb = fb - l;
  const k = (i * GRID + j) * GRID + l;
  const lerp = (o: number) => lattice[o] + (lattice[o + 1] - lattice[o]) * tb;
  const c0 = lerp(k) + (lerp(k + GRID) - lerp(k)) * tg;
  const c1 = lerp(k + GRID * GRID) + (lerp(k + GRID * GRID + GRID) - lerp(k + GRID * GRID)) * tg;
  return c0 + (c1 - c0) * tr;
}

async function fetchBundled(): Promise<Proof> {
  const res = await fetch(`${import.meta.env.BASE_URL}icc/${BUNDLED_ICC}`);
  if (!res.ok) throw new MsgError(msg('Could not load the bundled ICC profile (HTTP {status})', { status: res.status }));
  return prepare(await res.arrayBuffer(), BUNDLED_ICC, false);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** The active profile, loading it on first use: the user's stored profile, else the bundled one. */
export function loadGamutProfile(): Promise<GamutProfile> {
  if (active) return Promise.resolve(active.info);
  pending ??= (async () => {
    const stored = await tx<StoredProfile | undefined>('readonly', (s) => s.get(KEY));
    const proof = stored ? prepare(stored.data, stored.fileName, true) : await fetchBundled();
    // A profile picked while this was loading wins.
    active ??= proof;
    return active.info;
  })().finally(() => {
    pending = null;
  });
  return pending;
}

/** Makes `file` (an .icc / .icm CMYK printer profile) the active profile and remembers it. */
export async function loadUserGamutProfile(file: File): Promise<GamutProfile> {
  const data = await file.arrayBuffer();
  const proof = prepare(data, file.name, true);
  const stored: StoredProfile = { fileName: file.name, data };
  await tx('readwrite', (s) => s.put(stored, KEY));
  active = proof;
  return proof.info;
}

/** Forgets the user's profile and goes back to the bundled one. */
export async function restoreBundledGamutProfile(): Promise<GamutProfile> {
  const proof = await fetchBundled();
  await tx('readwrite', (s) => s.delete(KEY));
  active = proof;
  return proof.info;
}

/** Pixels with less alpha than this (0..255) are too faint to matter on paper and never warn. */
const MIN_ALPHA = 26;

/**
 * Out-of-gamut mask of straight-alpha sRGB pixels against the active profile (`loadGamutProfile`
 * must have resolved): 255 where a visible pixel can't print, else 0. Colours are tested once per
 * 18-bit value (the cell centre, 6 bits per channel; finer than the profile's own round-trip
 * noise) and remembered for the profile's lifetime, so repeated masks only test new colours.
 */
export function gamutMask(img: ImageData): { mask: Uint8Array; outside: number; visible: number } {
  if (!active) throw new Error('gamutMask: no ICC profile loaded');
  const { cache, deltaE } = active;
  const { data } = img;
  const n = img.width * img.height;
  const mask = new Uint8Array(n);
  let outside = 0;
  let visible = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (data[p + 3] < MIN_ALPHA) continue;
    visible++;
    const key = ((data[p] >> 2) << 12) | ((data[p + 1] >> 2) << 6) | (data[p + 2] >> 2);
    let v = cache[key];
    if (v === 0) {
      v = proofDeltaE(deltaE, (data[p] & 0xfc) | 2, (data[p + 1] & 0xfc) | 2, (data[p + 2] & 0xfc) | 2) > GAMUT_DELTA_E ? 2 : 1;
      cache[key] = v;
    }
    if (v === 2) {
      mask[i] = 255;
      outside++;
    }
  }
  return { mask, outside, visible };
}
