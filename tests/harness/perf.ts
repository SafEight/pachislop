import type { Engine } from '../../src/engine/Engine';
import { createGeneratorLayer } from '../../src/generators/registry';
import { encodePng, renderStill } from '../../src/io/export';
import { createAdjustmentLayer, createTitle2DLayer, defaultComp } from '../../src/model/defaults';
import type { Layer, Project } from '../../src/model/types';
import { TEMPLATES } from '../../src/presets/templates';
import { makeEffect } from '../../src/store/effects';
import { ridesAlong } from '../../src/store/arrange';
import { ancestorsOf, withDescendants } from '../../src/store/tree';
import { engineHost } from '../../src/ui/engineHost';

// Speed-budget cases. A "preview frame" is Engine.render of the whole comp at 100 % preview
// resolution, not interactive: every node is shaded, run through its effects and composited;
// renderer geometry / SDF caches are warm, as on any edit that leaves the outlines alone.

export interface PerfCase {
  name: string;
  /** Prepared (fonts, environment, models) before the warm-up runs. */
  project: Project;
  setup?: () => void | Promise<void>;
  run: () => void | Promise<void>;
  teardown?: () => void | Promise<void>;
}

/** The heaviest 3D template: 3D plates with a band glow, nested groups and a Photo Filter. */
const HEAVY_3D = 't-bigbonus-3d-groups';

const comp = (name: string, layers: Layer[]): Project => ({ version: 8, name, comp: defaultComp(), layers });

function withEffect(type: string, params: Record<string, number>) {
  const fx = makeEffect(type);
  if (!fx) throw new Error(`unknown effect ${type}`);
  return { ...fx, params: { ...fx.params, ...params } };
}

function generator(type: string, presetId: string) {
  const l = createGeneratorLayer(type, presetId);
  if (!l) throw new Error(`unknown generator ${type}`);
  return l;
}

/**
 * `project` with every drawing layer of the top-level node holding its first 3D title moved by
 * `dx`, as a canvas drag moves it (generators following a moved layer ride along: ridesAlong).
 */
function dragged(project: Project, dx: number): Project {
  const first3D = project.layers.find((l) => l.kind === 'title3d');
  if (!first3D) throw new Error('no 3D title to drag');
  const top = ancestorsOf(project.layers, first3D.id).at(-1) ?? first3D;
  const moved = new Set(withDescendants(project.layers, [top.id]));
  return {
    ...project,
    layers: project.layers.map((l) =>
      moved.has(l.id) && l.kind !== 'group' && l.kind !== 'adjustment' && !ridesAlong(l, moved) ? { ...l, transform: { ...l.transform, x: l.transform.x + dx } } : l,
    ),
  };
}

export function perfCases(engine: Engine): PerfCase[] {
  const preview = (project: Project) => () => engine.render(project, { scale: 1, includeGuides: true });
  const template = TEMPLATES.find((t) => t.id === HEAVY_3D);
  if (!template) throw new Error(`missing template ${HEAVY_3D}`);
  const heavy = template.build();

  const blurAdj = createAdjustmentLayer('effectsOnly');
  blurAdj.effects = [withEffect('gaussianBlur', { radius: 200 })];
  const blur = comp('blur 200', [generator('patternFill', 'zebra'), createTitle2DLayer('確定'), blurAdj]);

  const glowTitle = createTitle2DLayer('確定');
  glowTitle.effects = [withEffect('deepGlow', { radius: 1000 })];
  const deepGlow = comp('deep glow 1000', [glowTitle]);

  const goldDust = comp('金粉', [generator('particles', 'goldDust')]);

  let step = 0;
  return [
    { name: 'preview frame: heavy 3D template', project: heavy, run: preview(heavy) },
    { name: 'generator: 金粉 (2600 particles)', project: goldDust, run: preview(goldDust) },
    { name: 'Gaussian Blur 200 (effects-only adjustment)', project: blur, run: preview(blur) },
    { name: 'Deep Glow radius 1000', project: deepGlow, run: preview(deepGlow) },
    {
      name: 'interactive drag frame: heavy 3D template',
      project: heavy,
      setup: () => {
        engineHost.setInteractive(true);
        engine.render(heavy, { scale: 1, includeGuides: true });
      },
      // Alternates between two positions 1 px apart: a transform-only change every frame.
      run: () => engine.render(dragged(heavy, ++step % 2), { scale: 1, includeGuides: true }),
      teardown: () => engineHost.setInteractive(false),
    },
    {
      name: '2× PNG export (encode included): heavy 3D template',
      project: heavy,
      run: async () => {
        const { image } = await renderStill(engine, heavy, { scale: 2, trim: true, padding: 0, roundTo: 1, trimAlpha: 8, print: null, includeGuides: false });
        if (!(image instanceof ImageData)) throw new Error('expected an 8-bit render');
        await encodePng(image, heavy.comp.dpi);
      },
    },
  ];
}
