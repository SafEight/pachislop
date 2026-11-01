import { Engine } from '../../src/engine/Engine';
import { prepareRender, renderStill, type StillOptions } from '../../src/io/export';
import { engineHost } from '../../src/ui/engineHost';
import { goldenCases, type GoldenCase } from './cases';
import { perfCases, type PerfCase } from './perf';

// Render harness page (tests/harness/index.html), driven by Playwright through `window.harness`:
// the app's engine and export path without the editor UI, so nothing else (layer thumbnails,
// Library previews, the preview loop) renders in between. Its engine is installed as
// engineHost.engine, as the Viewport does.

/** Golden renders: the PNG export path at 0.25×, trimmed, unrounded, guides excluded. */
const GOLDEN_STILL: StillOptions = { scale: 0.25, trim: true, padding: 0, roundTo: 1, trimAlpha: 8, print: null, includeGuides: false };

export interface Rendered {
  width: number;
  height: number;
  /** Straight-alpha sRGB RGBA bytes, base64. */
  rgba: string;
  warning?: string;
}

export interface GoldenResult {
  image: Rendered;
  /** The second render of a fresh build, when it differed from the first (nondeterminism). */
  rerender?: Rendered;
}

const engine = new Engine(document.createElement('canvas'));
engineHost.engine = engine;

const golden = new Map<string, GoldenCase>(goldenCases().map((c) => [c.id, c]));
const perf = new Map<string, PerfCase>(perfCases(engine).map((c) => [c.name, c]));

function base64(bytes: Uint8ClampedArray): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

async function still(c: GoldenCase): Promise<{ image: ImageData; warning?: string }> {
  const r = await renderStill(engine, await c.build(), GOLDEN_STILL);
  if (!(r.image instanceof ImageData)) throw new Error(`${c.id}: expected an 8-bit render`);
  return { image: r.image, warning: r.warning === undefined ? undefined : JSON.stringify(r.warning) };
}

const rendered = (r: { image: ImageData; warning?: string }): Rendered => ({ width: r.image.width, height: r.image.height, rgba: base64(r.image.data), warning: r.warning });

const same = (a: ImageData, b: ImageData) => a.width === b.width && a.height === b.height && a.data.every((v, i) => v === b.data[i]);

/** Separate perf timings: GPU work submitted by `run` is waited for (a 1-px read of the canvas) before the clock stops. */
function gpuSync() {
  const gl = engine.renderer.getContext();
  engine.renderer.setRenderTarget(null);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
}

const harness = {
  goldenIds: (): string[] => [...golden.keys()],

  /** Builds and renders case `id` twice from scratch; `rerender` is set when the two differ. */
  async renderGolden(id: string): Promise<GoldenResult> {
    const c = golden.get(id);
    if (!c) throw new Error(`unknown golden case ${id}`);
    const first = await still(c);
    const second = await still(c);
    return same(first.image, second.image) ? { image: rendered(first) } : { image: rendered(first), rerender: rendered(second) };
  },

  perfNames: (): string[] => [...perf.keys()],

  /** Loads case `name`'s assets and runs it `warmup` times untimed. */
  async perfSetup(name: string, warmup: number): Promise<void> {
    const c = perf.get(name);
    if (!c) throw new Error(`unknown perf case ${name}`);
    await prepareRender(engine, c.project, true);
    await c.setup?.();
    for (let i = 0; i < warmup; i++) await c.run();
    gpuSync();
  },

  /** One timed run of case `name`, ms. */
  async perfRun(name: string): Promise<number> {
    const c = perf.get(name);
    if (!c) throw new Error(`unknown perf case ${name}`);
    gpuSync();
    const t0 = performance.now();
    await c.run();
    gpuSync();
    return performance.now() - t0;
  },

  async perfTeardown(name: string): Promise<void> {
    await perf.get(name)?.teardown?.();
  },
};

declare global {
  interface Window {
    harness?: typeof harness;
  }
}

window.harness = harness;
