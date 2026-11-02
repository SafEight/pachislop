import { addAsset } from '../../src/assets/registry';
import { listEffects } from '../../src/effects/registry';
import type { GeneratorDef, GeneratorPreset } from '../../src/engine/contracts';
import { createGeneratorLayer, listGenerators } from '../../src/generators/registry';
import { clusterIslands, DEFAULT_MERGE, labelIslands, readPixels } from '../../src/io/imageSplit';
import {
  createAdjustmentLayer,
  createGroupLayer,
  createTitle2DLayer,
  createTitle3DLayer,
  defaultComp,
  imageSource,
  shapeSource,
} from '../../src/model/defaults';
import type { GradientMask, Layer, LayerMask, Project, ShapeMask } from '../../src/model/types';
import { applyPreset, applyPresetToProject } from '../../src/presets/apply';
import { FACTORY_STYLES } from '../../src/presets/factory';
import { TEMPLATES } from '../../src/presets/templates';
import { makeEffect } from '../../src/store/effects';
import { titleLayerFor } from '../../src/store/imageOps';
import { useEditor } from '../../src/store/store';
import { normalizeTree } from '../../src/store/tree';
import { splitImageLayer } from '../../src/ui/layerActions';

// Golden cases: every template, every factory look on a standard title, every generator preset
// alone, every effect with its defaults on a standard 2D title, and a few semantic scenes that
// pin the compositor's tree rules. Each `build` makes a fresh project (fresh random ids), so
// rendering a case twice also checks that nothing depends on ids.

export interface GoldenCase {
  /** `group/name`, file-name safe: the reference is tests/golden/refs/<id>.png. */
  id: string;
  build: () => Project | Promise<Project>;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');

const project = (name: string, layers: Layer[]): Project => ({ version: 10, name, comp: defaultComp(), layers: normalizeTree(layers) });

/** The standard titles: 2D looks and effects on 確定, 3D looks on BIG. */
const title2D = (text = '確定', y = 0) => {
  const l = createTitle2DLayer(text);
  l.transform.y = y;
  return l;
};
const title3D = (text = 'BIG', y = 0) => {
  const l = createTitle3DLayer(text);
  l.transform.y = y;
  return l;
};

function effect(type: string, params: Record<string, number | string | boolean> = {}) {
  const fx = makeEffect(type);
  if (!fx) throw new Error(`unknown effect ${type}`);
  return { ...fx, params: { ...fx.params, ...params } };
}

function generator(type: string, presetId?: string) {
  const l = createGeneratorLayer(type, presetId);
  if (!l) throw new Error(`unknown generator ${type}`);
  return l;
}

/**
 * A generator preset alone; one that must follow a layer follows the standard 2D title, as its
 * companion above or below it as the preset places it.
 */
function generatorProject(def: GeneratorDef, pr: GeneratorPreset): Project {
  const gen = generator(def.type, pr.id);
  if (def.follow !== 'required') return project(pr.label, [gen]);
  const title = title2D();
  const follower: Layer = { ...gen, companionOf: title.id, generator: { ...gen.generator, params: { ...gen.generator.params, follow: title.id } } };
  return project(pr.label, pr.place === 'below' ? [follower, title] : [title, follower]);
}

const inGroup = <L extends Layer>(l: L, group: Layer): L => ({ ...l, parentId: group.id });

// ---------------------------------------------------------------------------------------------
// A synthetic picture for the image scenes: three islands (a two-colour ring with a hole, a
// gradient disc, a small square) on transparency, with antialiased edges. Pure arithmetic, so the
// pixels are identical on every machine.

const PICTURE_ID = 'golden-picture';
const PIC_W = 240;
const PIC_H = 160;

function picturePixels(): ImageData {
  const img = new ImageData(PIC_W, PIC_H);
  const cover = (d: number) => Math.min(1, Math.max(0, 0.5 - d)); // signed distance (px) → coverage
  for (let y = 0; y < PIC_H; y++) {
    for (let x = 0; x < PIC_W; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const ring = Math.abs(Math.hypot(px - 60, py - 80) - 40) - 14; // ring r 26..54
      const disc = Math.hypot(px - 162, py - 70) - 34; // 12 px clear of the ring, 6 of the square: three parts at the default merge
      const square = Math.max(Math.abs(px - 214) - 12, Math.abs(py - 124) - 12);
      const cr = cover(ring);
      const cd = cover(disc);
      const cs = cover(square);
      const a = Math.max(cr, cd, cs);
      const o = (y * PIC_W + x) * 4;
      if (a <= 0) continue;
      if (cr >= cd && cr >= cs) {
        const top = py < 80;
        img.data.set(top ? [230, 40, 30] : [250, 200, 40], o);
      } else if (cd >= cs) {
        const t = (px - 128) / 68;
        img.data.set([Math.round(40 + 180 * t), 120, Math.round(240 - 160 * t)], o);
      } else {
        img.data.set([30, 200, 120], o);
      }
      img.data[o + 3] = Math.round(a * 255);
    }
  }
  return img;
}

let pictureReady: Promise<ImageData> | null = null;

/** Registers the picture as asset PICTURE_ID (once) and resolves its decoded pixels, as the Split dialog reads them. */
function picture(): Promise<ImageData> {
  pictureReady ??= (async () => {
    const canvas = new OffscreenCanvas(PIC_W, PIC_H);
    canvas.getContext('2d')!.putImageData(picturePixels(), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    addAsset({ id: PICTURE_ID, name: 'golden.png', mime: 'image/png', data: await blob.arrayBuffer() });
    return readPixels(await createImageBitmap(blob));
  })();
  return pictureReady;
}

// ---------------------------------------------------------------------------------------------
// Semantic scenes

function adjustmentScene(inside: boolean): Project {
  const below = title2D('BIG', -150);
  const group = createGroupLayer('G');
  const member = inGroup(title2D('確定', 120), group);
  const adj = createAdjustmentLayer('hueSaturation');
  adj.adjustment = { type: 'hueSaturation', hue: 150, saturation: 20, lightness: 0, colorize: false };
  // Inside the group the hue shift reaches only 確定; at top level it reaches BIG too.
  const layers = inside ? [below, member, inGroup(adj, group), group] : [below, member, group, adj];
  return project(inside ? 'adjust in group' : 'adjust outside group', layers);
}

const maskBase = { enabled: true, invert: false, feather: 0, density: 1, linked: true };
const shapeMask = (m: Partial<ShapeMask> = {}): LayerMask => ({
  ...maskBase,
  id: 'shape-mask',
  kind: 'shape',
  source: shapeSource('ellipse', 260),
  x: 0,
  y: 0,
  rotation: 0,
  ...m,
});
const gradientMask = (m: Partial<GradientMask> = {}): LayerMask => ({
  ...maskBase,
  id: 'gradient-mask',
  kind: 'gradient',
  shape: 'linear',
  x: 0,
  y: 120,
  angle: -90,
  length: 240,
  inner: 0,
  mid: 0.5,
  ...m,
});

const look = (id: string) => {
  const p = FACTORY_STYLES.find((s) => s.id === id);
  if (!p) throw new Error(`no look ${id}`);
  return p;
};

function scenes(): GoldenCase[] {
  return [
    {
      id: 'scene/clipping',
      // A full-frame pattern clipped to BIG (whose letter shapes survive the rims) shows only inside its alpha.
      build: () => project('clipping', [title2D('BIG'), { ...generator('patternFill'), clip: true }]),
    },
    { id: 'scene/adjustment-in-group', build: () => adjustmentScene(true) },
    { id: 'scene/adjustment-outside-group', build: () => adjustmentScene(false) },
    {
      id: 'scene/effects-only-gaussian-blur',
      build: () => {
        const adj = createAdjustmentLayer('effectsOnly');
        adj.effects = [effect('gaussianBlur', { radius: 12 })];
        return project('effects-only blur', [title2D('BIG', -150), title2D('確定', 120), adj]);
      },
    },
    {
      id: 'scene/part-effects-2d',
      build: () => {
        const l = title2D();
        const outer = l.style.rims.at(-1);
        if (!outer) throw new Error('default 2D title has no rims');
        l.partEffects = { [`rim:${outer.id}`]: [effect('outerGlow')], face: [effect('innerShadow')] };
        return project('part effects 2D', [l]);
      },
    },
    {
      id: 'scene/part-effects-3d',
      build: () => {
        const l = title3D();
        const band = l.style3d.bands[0];
        if (!band) throw new Error('default 3D title has no bands');
        l.partEffects = { [`band:${band.id}`]: [effect('outerGlow')], side: [effect('dropShadow')] };
        return project('part effects 3D', [l]);
      },
    },
    {
      id: 'scene/nested-hidden-groups',
      // Only BIG is drawn: 確定 sits in a hidden group inside a visible one, 激アツ in a visible
      // group inside a hidden one.
      build: () => {
        const outer = createGroupLayer('outer');
        const hiddenInner = { ...inGroup(createGroupLayer('hidden inner'), outer), visible: false };
        const hiddenOuter = { ...createGroupLayer('hidden outer'), visible: false };
        const shownInner = inGroup(createGroupLayer('shown inner'), hiddenOuter);
        return project('nested hidden groups', [
          inGroup(title2D('激アツ', 200), shownInner),
          shownInner,
          hiddenOuter,
          inGroup(title2D('確定', 0), hiddenInner),
          hiddenInner,
          inGroup(title2D('BIG', -200), outer),
          outer,
        ]);
      },
    },
    {
      id: 'scene/image-3d-plain',
      build: async () => {
        await picture();
        return project('3D image', [titleLayerFor('3d', imageSource(PICTURE_ID, 480), 'golden')]);
      },
    },
    {
      id: 'scene/split-image',
      // Split image… through the real action (cut, PNG-encoded parts, group of layers).
      build: async () => {
        const img = await picture();
        const layer = titleLayerFor('2d', imageSource(PICTURE_ID, 480), 'golden');
        const store = useEditor.getState();
        store.loadProject(project('split image', [layer]));
        const map = labelIslands(img);
        await splitImageLayer(layer.id, img, map, clusterIslands(map, DEFAULT_MERGE));
        const split = useEditor.getState().project;
        if (split.layers.length !== 4) throw new Error(`split image: expected a group of 3 parts, got ${split.layers.length} layers`);
        return split;
      },
    },
    {
      id: 'scene/mask-shape-feather',
      // A feathered, turned ellipse on a rotated title (linked: it turns with the layer), plus an
      // inverted, half-density star.
      build: () => {
        const l = { ...title2D(), effects: [effect('outerGlow')] };
        l.transform.rotZ = 12;
        l.masks = [
          shapeMask({ id: 'a', feather: 18, rotation: 20, source: { ...shapeSource('ellipse', 260), aspect: 2.2 } }),
          shapeMask({ id: 'b', invert: true, density: 0.5, x: 140, source: shapeSource('star', 120) }),
        ];
        return project('shape masks', [l]);
      },
    },
    {
      id: 'scene/mask-gradient-3d',
      build: () => {
        const l = title3D();
        l.masks = [gradientMask({ mid: 0.3 })];
        return project('gradient mask 3D', [l]);
      },
    },
    {
      id: 'scene/mask-group-radial',
      // An unlinked radial mask on a group shapes both members as one.
      build: () => {
        const group = createGroupLayer('G');
        group.masks = [gradientMask({ shape: 'radial', linked: false, y: 0, length: 300, inner: 0.4 })];
        return project('group mask', [inGroup(title2D('BIG', -150), group), inGroup(title2D('確定', 120), group), group]);
      },
    },
    {
      id: 'scene/mask-from-layer-luminance',
      // A hidden sunburst still drives the mask.
      build: () => {
        const rays = { ...generator('sunburst'), visible: false };
        const l = title2D();
        l.masks = [{ ...maskBase, id: 'lm', kind: 'layer', layerId: rays.id, channel: 'luminance' }];
        return project('layer mask', [rays, l]);
      },
    },
    {
      id: 'scene/mask-adjustment',
      // The hue shift applies only inside the rectangle (comp space).
      build: () => {
        const adj = createAdjustmentLayer('hueSaturation');
        adj.adjustment = { type: 'hueSaturation', hue: 150, saturation: 20, lightness: 0, colorize: false };
        adj.masks = [shapeMask({ linked: false, source: shapeSource('rect', 300), x: -200 })];
        return project('masked adjustment', [title2D('BIG', -150), title2D('確定', 120), adj]);
      },
    },
    {
      id: 'scene/flip-2d',
      // Mirrored, rotated title: the drop shadow and bevel light keep their screen direction.
      build: () => {
        const l = { ...title2D('激アツ'), effects: [effect('dropShadow')] };
        l.transform = { ...l.transform, rotZ: 15, flipX: true };
        return project('flip 2D', [l]);
      },
    },
    {
      id: 'scene/flip-3d',
      build: () => {
        const l = title3D();
        l.transform = { ...l.transform, rotY: 20, flipX: true, flipY: true };
        return project('flip 3D', [l]);
      },
    },
    {
      id: 'scene/lighting-per-layer',
      // Each 3D title keeps the lighting of its own look.
      build: () =>
        project('per-layer lighting', [
          applyPreset(title3D('BIG', -170), look('f-3d-gold'), { applyFont: true }),
          applyPreset(title3D('確定', 170), look('f-3d-chrome'), { applyFont: true }),
        ]),
    },
  ];
}

// ---------------------------------------------------------------------------------------------

export function goldenCases(): GoldenCase[] {
  const cases: GoldenCase[] = [
    ...TEMPLATES.map((t) => ({ id: `template/${safe(t.id)}`, build: () => t.build() })),
    ...FACTORY_STYLES.map((p) => ({
      id: `look/${safe(p.id)}`,
      build: () => {
        const t = p.kind === 'title3d' ? title3D() : title2D();
        return applyPresetToProject(project(p.name, [t]), t.id, p, { applyFont: true });
      },
    })),
    ...listGenerators().flatMap((def) =>
      def.presets.map((pr) => ({ id: `generator/${safe(def.type)}-${safe(pr.id)}`, build: () => generatorProject(def, pr) })),
    ),
    ...listEffects().map((def) => ({ id: `effect/${safe(def.type)}`, build: () => project(def.label, [{ ...title2D(), effects: [effect(def.type)] }]) })),
    ...scenes(),
  ];
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new Error(`duplicate golden case id ${c.id}`);
    seen.add(c.id);
  }
  return cases;
}
