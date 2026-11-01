import { describe, expect, it } from 'vitest';
import { getEffect } from '../../src/effects/registry';
import { materialEffects, migrateMaterialEffects } from '../../src/io/migrate/materialEffects';
import { createProject, createTitle2DLayer } from '../../src/model/defaults';
import type { EffectInstance, Material2D, Title2DLayer } from '../../src/model/types';

const fx = (type: string, params: EffectInstance['params'] = {}, enabled = true): EffectInstance => ({ id: `${type}-id`, type, enabled, params });
const mat = (e: EffectInstance) => e.params.material as Material2D;

describe('materialEffects (migration step 3)', () => {
  it('leaves stacks without the removed material effects as they are', () => {
    const stack = [fx('outerGlow'), fx('material')];
    expect(migrateMaterialEffects(stack)).toBe(stack);
  });

  it('turns Bevel, Chrome, Glass and Metal Texture into Material in place, keeping id and enabled flag, idempotently', () => {
    for (const type of ['bevel', 'chrome', 'glass', 'metalTexture']) {
      const stack = [fx('dropShadow'), fx(type, {}, false), fx('grain')];
      const out = migrateMaterialEffects(stack);
      expect(out[0]).toBe(stack[0]);
      expect(out[2]).toBe(stack[2]);
      expect(out[1]).toMatchObject({ id: `${type}-id`, type: 'material', enabled: false, params: { size: 200, colorMode: type === 'chrome' ? 'fill' : 'layer' } });
      expect(getEffect('material')!.params.map((p) => p.key).sort()).toEqual(Object.keys(out[1].params).sort());
      expect(migrateMaterialEffects(out)).toBe(out);
    }
  });

  it('Bevel → a bevel of the same width, height, smoothness and light (px → % of the 200 px size)', () => {
    const b = mat(migrateMaterialEffects([fx('bevel', { width: 30, depth: 70, smooth: 3, angle: 60, elevation: 25, profile: 'chamfer', useGlobalLight: true })])[0]).bevel;
    expect(b).toMatchObject({ enabled: true, profile: 'chamfer', sizeMode: 'fixed', size: 15, soften: 3, lightAngle: 60, lightAltitude: 25, useGlobalLight: true, gloss: 'linear' });
    expect(b.depth).toBeCloseTo(0.7 / 0.35);
    // The round button profile is sampled into a custom curve; a missing flag predates the global light.
    const round = mat(migrateMaterialEffects([fx('bevel')])[0]).bevel;
    expect(round.profile).toBe('custom');
    expect(round.profileCurve.points[0]).toMatchObject({ x: 0, y: 0 });
    expect(round.profileCurve.points.at(-1)).toMatchObject({ x: 1, y: 1 });
    expect(round.useGlobalLight).toBe(false);
    // More shadow depth → a stronger shadow multiply.
    const shadow = (s: number) => mat(migrateMaterialEffects([fx('bevel', { shadow: s })])[0]).bevel.shadowOpacity;
    expect(shadow(90)).toBeGreaterThan(shadow(30));
    expect(shadow(0)).toBe(0);
  });

  it('Chrome → its map as a top-to-bottom fill, bent by a mirroring (negative) refraction, the tint folded into the stops', () => {
    const m = mat(migrateMaterialEffects([fx('chrome', { map: 'gold', horizon: 20, repeat: 2, tint: '#ff0000', tintAmount: 100, distortion: 70 })])[0]);
    expect(m.fill).toMatchObject({ kind: 'linear', angle: 90, span: 'line' });
    expect(m.fill.scale).toBeCloseTo(1 / 0.85);
    expect(m.fill.offset).toBeCloseTo(-0.085);
    expect(m.fill.gradient.stops.every((s) => /^#[0-9a-f]{2}0000$/.test(s.color))).toBe(true);
    expect(m.refraction).toBeLessThan(0);
    const custom = { stops: [{ pos: 0, color: '#123456' }, { pos: 1, color: '#abcdef' }] };
    expect(mat(migrateMaterialEffects([fx('chrome', { map: 'custom', gradient: custom })])[0]).fill.gradient).toEqual(custom);
  });

  it('Glass → Glass2D with the old colour, body, edge and caustic; refraction px → %; no shadow', () => {
    const m = mat(migrateMaterialEffects([fx('glass', { color: '#ff00aa', opacity: 40, tint: 80, edge: 50, caustic: 150, refraction: 20 })])[0]);
    expect(m.glass).toEqual({ enabled: true, color: '#ff00aa', tint: 0.8, opacity: 0.4, edge: 0.5, caustic: 1.5 });
    expect(m.refraction).toBe(10);
    expect(m.bevel.shadowOpacity).toBe(0);
  });

  it('Metal Texture → texture kind, grain size, direction and strength, and the sheen', () => {
    const one = (params: EffectInstance['params']) => mat(migrateMaterialEffects([fx('metalTexture', params)])[0]);
    expect(one({ mode: 'radial', scale: 4, angle: 30, strength: 50 }).texture).toMatchObject({ kind: 'spun', scale: 2, angle: 30, amount: 0.5, blend: 'overlay', target: 'color' });
    expect(one({ mode: 'hairline', scale: 4 }).texture.kind).toBe('hairline');
    expect(one({ mode: 'hairline', scale: 4 }).texture.scale).toBeCloseTo(0.9);
    expect(one({ mode: 'flake' }).texture.kind).toBe('flakes');
    expect(one({ sheen: false, sheenPosition: 40, sheenAmount: 120, sheenWidth: 50, sheenColor: '#ffee00' }).sheen).toEqual({ enabled: false, color: '#ffee00', amount: 1.2, position: 0.4, width: 0.5 });
    expect(one({}).bevel.enabled).toBe(false);
  });

  it('runs over every layer and part stack of a project', () => {
    const p = { ...createProject(), layers: [createTitle2DLayer()] };
    const t = p.layers.find((l): l is Title2DLayer => l.kind === 'title2d')!;
    t.effects = [fx('glass')];
    t.partEffects = { face: [fx('bevel')] };
    const out = materialEffects(p).layers.find((l): l is Title2DLayer => l.id === t.id)!;
    expect(out.effects[0].type).toBe('material');
    expect(out.partEffects.face![0].type).toBe('material');
  });
});
