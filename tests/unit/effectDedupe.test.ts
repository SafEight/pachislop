import { describe, expect, it } from 'vitest';
import { getEffect } from '../../src/effects/registry';
import { dedupeEffects, effectDedupe } from '../../src/io/migrate/effectDedupe';
import { createProject, createTitle2DLayer } from '../../src/model/defaults';
import type { Adjustment, EffectInstance, Title2DLayer } from '../../src/model/types';

const fx = (type: string, params: EffectInstance['params'] = {}, enabled = true): EffectInstance => ({ id: `${type}-id`, type, enabled, params });
const levelsOf = (e: EffectInstance) => (e.params.adjustment as Extract<Adjustment, { type: 'levels' }>).channels.rgb;

describe('effectDedupe (migration step 2)', () => {
  it('leaves stacks without removed effects as they are', () => {
    const stack = [fx('outerGlow'), fx('keyline')];
    expect(dedupeEffects(stack)).toBe(stack);
  });

  it('replaces every removed type in place, keeping id, enabled flag and stack position, and is idempotent', () => {
    const old = ['gradientGlow', 'stroke', 'longShadow', 'shine', 'rainbow', 'hueSaturation', 'colorAdjust', 'gradientMap'];
    for (const type of old) {
      const stack = [fx('dropShadow'), fx(type, {}, false), fx('grain')];
      const out = dedupeEffects(stack);
      expect(out[0]).toBe(stack[0]);
      expect(out.at(-1)).toBe(stack[2]);
      const mid = out.slice(1, -1);
      expect(mid.length, type).toBeGreaterThan(0);
      expect(mid[0].id).toBe(`${type}-id`);
      for (const e of mid) {
        expect(getEffect(e.type), `${type} → ${e.type}`).toBeDefined();
        expect(e.enabled).toBe(false);
      }
      expect(dedupeEffects(out)).toBe(out);
    }
  });

  it('Gradient Glow → a Precise glow coloured by distance from the edge', () => {
    const [outer] = dedupeEffects([fx('gradientGlow', { width: 20, softness: 0.6, opacity: 0.8 })]);
    expect(outer).toMatchObject({ type: 'outerGlow', params: { fill: 'distance', technique: 'precise', size: 20, spread: 0.4, intensity: 1, opacity: 0.8, mode: 'behind' } });
    const [inner] = dedupeEffects([fx('gradientGlow', { inner: true })]);
    expect(inner).toMatchObject({ type: 'innerGlow', params: { fill: 'distance', technique: 'precise', size: 34, choke: 0.25, mode: 'normal' } });
  });

  it('Multi Stroke → keylines: from the layer with cumulative widths when first, else around the stack ring by ring', () => {
    const first = dedupeEffects([fx('stroke', { width1: 5, width2: 0, width3: 4 })]);
    expect(first.map((e) => [e.type, e.params.width, e.params.color, e.params.follow])).toEqual([
      ['keyline', 9, '#2a0000', 'layer'],
      ['keyline', 5, '#ffffff', 'layer'],
    ]);
    const after = dedupeEffects([fx('outerGlow'), fx('stroke', { opacity: 0.6 })]).slice(1);
    expect(after.map((e) => [e.params.width, e.params.follow, e.params.threshold])).toEqual([
      [5, 'stack', 0.3],
      [9, 'stack', 0.3],
      [4, 'stack', 0.3],
    ]);
  });

  it('Long Shadow → an unshaded one-colour Extrude, at the angle the global light gave it', () => {
    const [e] = dedupeEffects([fx('longShadow', { angle: 10, useGlobalLight: true, length: 300, fade: 0.5 })], 120);
    expect(e).toMatchObject({ type: 'extrude2d', params: { angle: 60, length: 300, fade: 0.5, shading: 0, edge: 0, opacity: 0.55 } });
    expect(dedupeEffects([fx('longShadow', { angle: 10 })])[0].params.angle).toBe(10);
  });

  it('Shine and Rainbow → Gradient Overlay', () => {
    const [shine] = dedupeEffects([fx('shine', { angle: -30, width: 40 })]);
    expect(shine).toMatchObject({ type: 'gradientOverlay', params: { style: 'sweep', angle: 30, length: 200, mode: 'light', amount: 0.9 } });
    const [rainbow] = dedupeEffects([fx('rainbow', { scale: 2, mode: 'overlay' })]);
    expect(rainbow).toMatchObject({ type: 'gradientOverlay', params: { style: 'linear', scale: 0.5, offset: 0.5, wrap: 'repeat', mode: 'overlay' } });
  });

  it('Color Adjust → Exposure + Levels + Levels (the brightness / contrast line)', () => {
    const out = dedupeEffects([fx('colorAdjust', { exposure: 1, gamma: 0.9, contrast: 0.12 })]);
    expect(out.map((e) => (e.params.adjustment as Adjustment).type)).toEqual(['exposure', 'levels', 'levels']);
    expect(levelsOf(out[1])).toMatchObject({ inBlack: 0, inWhite: 255, gamma: 0.9 });
    const line = levelsOf(out[2]);
    expect(line.inBlack).toBeCloseTo((0.06 / 1.12) * 255);
    expect(line.inWhite).toBeCloseTo((1.06 / 1.12) * 255);
    expect([line.outBlack, line.outWhite]).toEqual([0, 255]);
  });

  it('runs over layer and part effects of a project', () => {
    const p = { ...createProject(), layers: [createTitle2DLayer()] };
    const t = p.layers.find((l): l is Title2DLayer => l.kind === 'title2d')!;
    t.effects = [fx('hueSaturation')];
    t.partEffects = { face: [fx('gradientMap')] };
    const out = effectDedupe(p).layers.find((l): l is Title2DLayer => l.id === t.id)!;
    expect(out.effects[0].type).toBe('adjust');
    expect(out.partEffects.face?.[0].type).toBe('adjust');
  });
});
