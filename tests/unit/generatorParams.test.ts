import { describe, expect, it } from 'vitest';
import { createGeneratorLayer, getGenerator } from '../../src/generators/registry';
import { generatorParams } from '../../src/io/migrate/generatorParams';
import { createProject } from '../../src/model/defaults';
import type { GeneratorLayer, GradientMask, Project } from '../../src/model/types';

// Migration step 1: generator post-processing params → effects, masks, opacity and layers.

/** A project holding `layers` only. */
function projectOf(...layers: GeneratorLayer[]): Project {
  return { ...createProject(), layers };
}

/** A generator layer of `type` from its first preset, its stored params replaced by the defaults plus `old` (a stored old layer). */
function oldLayer(type: string, old: Record<string, unknown>): GeneratorLayer {
  const l = createGeneratorLayer(type)!;
  const params: GeneratorLayer['generator']['params'] = {};
  for (const pd of getGenerator(type)!.params) params[pd.key] = pd.default;
  return { ...l, effects: [], generator: { type, params: { ...params, ...(old as GeneratorLayer['generator']['params']) } } };
}

describe('generatorParams', () => {
  it('passes current layers through unchanged (idempotent)', () => {
    const p = projectOf(createGeneratorLayer('particles', 'goldDust')!, createGeneratorLayer('speedLines', 'beta')!, createGeneratorLayer('patternFill')!);
    expect(generatorParams(p)).toBe(p);
    const once = generatorParams(projectOf(oldLayer('shockwave', { glow: 20 })));
    expect(generatorParams(once)).toBe(once);
  });

  it('turns a glow into a light Outer Glow at the bottom of the stack, marked fromPreset', () => {
    const l = oldLayer('particles', { glow: 24 });
    l.effects = [{ id: 'mine', type: 'gaussianBlur', enabled: true, params: { radius: 2 } }];
    const [out] = generatorParams(projectOf(l)).layers as GeneratorLayer[];
    expect('glow' in out.generator.params).toBe(false);
    expect(out.effects.map((fx) => fx.type)).toEqual(['outerGlow', 'gaussianBlur']);
    expect(out.effects[0]).toMatchObject({ fromPreset: true, params: { fill: 'layer', mode: 'add', onFace: 1, spread: 0, size: 24, intensity: 0.8 } });
    expect(out.effects[1].fromPreset).toBeUndefined();
  });

  it('scales a ring glow (layer px) by the layer scale', () => {
    const l = oldLayer('brushSwirl', { glow: 10 });
    l.transform = { ...l.transform, scale: 2 };
    const [out] = generatorParams(projectOf(l)).layers as GeneratorLayer[];
    expect(out.effects[0].params).toMatchObject({ size: 20, intensity: 0.6 });
  });

  it('moves the ベタフラ burst fill to a Sunburst layer below and its halftone to effects', () => {
    const l = oldLayer('speedLines', { type: 'beta', opacity: 50, fillBurst: true, burstColor: '#ff0000', halftone: true, dotSize: 6 });
    l.transform = { ...l.transform, opacity: 0.8 };
    const layers = generatorParams(projectOf(l)).layers as GeneratorLayer[];
    expect(layers.map((x) => x.generator.type)).toEqual(['sunburst', 'speedLines']);
    const [burst, lines] = layers;
    expect(lines.transform.opacity).toBeCloseTo(0.8);
    expect(lines.generator.params.opacity).toBe(50);
    expect(burst.transform.opacity).toBeCloseTo(0.4);
    expect(burst.generator.params).toMatchObject({ colorMode: 'ab', colorA: '#ff0000', colorB: '#ff0000', glow: 0 });
    expect(burst.effects).toEqual([]);
    expect(lines.effects.map((fx) => fx.type)).toEqual(['halftone']);
    expect(lines.effects[0].params).toMatchObject({ source: 'alpha', size: 6, fade: 24 });
    for (const k of ['fillBurst', 'burstColor', 'halftone', 'dotSize', 'edgeBlur', 'glow']) expect(k in lines.generator.params).toBe(false);
  });

  it('turns a pattern fade into a linked gradient mask', () => {
    const l = oldLayer('patternFill', { fade: 'radial', fadeX: 10, fadeY: -20, fadeRadius: 300, feather: 120 });
    const [out] = generatorParams(projectOf(l)).layers as GeneratorLayer[];
    const m = out.masks[0] as GradientMask;
    expect(m).toMatchObject({ kind: 'gradient', shape: 'radial', linked: true, x: 10, y: -20, length: 340 });
    expect(m.inner * m.length).toBeCloseTo(260);
    expect(Object.keys(out.generator.params).some((k) => k.startsWith('fade') || k === 'feather' || k === 'opacity')).toBe(false);
  });

  it('turns a sunburst vignette into a radial shading Gradient Overlay', () => {
    const [sun] = generatorParams(projectOf(oldLayer('sunburst', { vignette: 45 }))).layers as GeneratorLayer[];
    expect('vignette' in sun.generator.params).toBe(false);
    expect(sun.effects[0]).toMatchObject({ type: 'gradientOverlay', fromPreset: true, params: { style: 'radial', mode: 'shade' } });
  });
});

describe('generator preset looks', () => {
  it('gives a new layer its own copies of the preset effects', () => {
    const a = createGeneratorLayer('particles', 'goldDust')!;
    const b = createGeneratorLayer('particles', 'goldDust')!;
    expect(a.effects).toHaveLength(1);
    expect(a.effects[0]).toMatchObject({ type: 'outerGlow', fromPreset: true, params: { size: 24, technique: 'softer' } });
    expect(a.effects[0].id).not.toBe(b.effects[0].id);
    expect(createGeneratorLayer('speedLines', 'focus')!.effects).toEqual([]);
  });
});
