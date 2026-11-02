import { describe, expect, it } from 'vitest';
import { createGroupLayer, createTitle2DLayer, defaultComp } from '../../src/model/defaults';
import type { EffectInstance, GeneratorLayer, Layer, Project } from '../../src/model/types';
import { contentEffects, contentEffectsOfLook } from '../../src/io/migrate/contentEffects';
import type { StylePreset } from '../../src/presets/types';

const fx = (type: string, params: EffectInstance['params'] = {}, enabled = true): EffectInstance => ({ id: `${type}-${Math.random()}`, type, enabled, params });
const proj = (layers: Layer[]): Project => ({ version: 10, name: 'T', comp: defaultComp(), layers });
const shape = (p: Project) => p.layers.map((l) => (l.kind === 'generator' ? `${l.generator.type}` : l.kind === 'group' ? `[${l.name}]` : l.name));
const gens = (p: Project) => p.layers.filter((l): l is GeneratorLayer => l.kind === 'generator');

describe('contentEffects (migration step 4)', () => {
  it('[e1, sparkles, e2]: a group carrying e2 around the layer (e1) and a Glints companion following it', () => {
    const t = { ...createTitle2DLayer('確定'), effects: [fx('outerGlow'), fx('sparkles', { placement: 'hero', size: 52 }), fx('dropShadow')] };
    const out = contentEffects(proj([t]));
    expect(shape(out)).toEqual(['確定', 'glints', '[確定]']);
    const [layer, glints, group] = out.layers;
    expect(layer.effects.map((e) => e.type)).toEqual(['outerGlow']);
    expect(group.effects.map((e) => e.type)).toEqual(['dropShadow']);
    expect(group).toMatchObject({ companionGroupOf: t.id });
    expect(glints).toMatchObject({ blend: 'add', companionOf: t.id, parentId: group.id, generator: { params: { follow: t.id, placement: 'hero', size: 52 } } });
  });

  it('consecutive content effects are siblings, a later behind one further down; the next run follows the group', () => {
    const t = { ...createTitle2DLayer('激'), effects: [fx('fire'), fx('smoke'), fx('lightning'), fx('deepGlow'), fx('sparkles')] };
    const out = contentEffects(proj([t]));
    expect(shape(out)).toEqual(['smoke', 'fire', '激', 'lightning', '[激]', 'glints', '[激]']);
    const inner = out.layers[4];
    expect(inner.effects.map((e) => e.type)).toEqual(['deepGlow']);
    const glints = gens(out).find((g) => g.generator.type === 'glints')!;
    expect(glints).toMatchObject({ companionOf: t.id, generator: { params: { follow: inner.id } } });
  });

  it('keeps a free lens flare free, hides companions of disabled effects, burst rays behind go below', () => {
    const t = { ...createTitle2DLayer('A'), effects: [fx('lensFlare', { x: 10 }), fx('starGlint', {}, false), fx('burstRays', { placement: 'behind' })] };
    const out = contentEffects(proj([t]));
    expect(shape(out)).toEqual(['sunburst', 'A', 'lensFlare', 'glints', '[A]']);
    const [rays, flare, glint] = gens(out);
    expect(flare.generator.params.follow).toBe('');
    expect(glint.visible).toBe(false);
    expect(rays.generator.params).toMatchObject({ style: 'wedges', onLayer: 'all', centre: 'point', follow: t.id });
  });

  it('particle burst in front and behind: two Particles layers, the back half below, the front half above', () => {
    const t = { ...createTitle2DLayer('A'), effects: [fx('particleBurst', { glow: 0 })] };
    const out = contentEffects(proj([t]));
    expect(shape(out)).toEqual(['particles', 'A', 'particles', '[A]']);
    const [back, front] = gens(out);
    expect(back.generator.params).toMatchObject({ emitter: 'layer', split: 'back', travel: 180 });
    expect(front).toMatchObject({ blend: 'add', generator: { params: { split: 'front' } }, effects: [] });
  });

  it('takes over the layer’s place: clipping, blend and opacity go to the group; groups get their own effects converted', () => {
    const base = createTitle2DLayer('base');
    const t = { ...createTitle2DLayer('A'), clip: true, blend: 'screen' as const, transform: { ...createTitle2DLayer('A').transform, opacity: 0.6 }, effects: [fx('sparkles')] };
    const g = { ...createGroupLayer('G'), effects: [fx('fire')] };
    const member = { ...createTitle2DLayer('m'), parentId: g.id };
    const out = contentEffects(proj([base, t, member, g]));
    const wrap = out.layers.find((l) => l.kind === 'group' && l.name === 'A')!;
    expect(wrap).toMatchObject({ clip: true, blend: 'screen', transform: { opacity: 0.6 } });
    expect(out.layers.find((l) => l.id === t.id)).toMatchObject({ clip: false, blend: 'normal', transform: { opacity: 1 } });
    expect(out.layers.find((l) => l.id === g.id)!.effects).toEqual([]);
    expect(gens(out).find((l) => l.generator.type === 'fire')!.generator.params.follow).toBe(g.id);
  });

  it('is idempotent and leaves projects without content effects alone', () => {
    const plain = proj([{ ...createTitle2DLayer('A'), effects: [fx('outerGlow')] }]);
    expect(contentEffects(plain).layers).toEqual(plain.layers);
    const once = contentEffects(proj([{ ...createTitle2DLayer('A'), effects: [fx('sparkles')] }]));
    expect(contentEffects(once).layers).toEqual(once.layers);
  });

  it('turns a particles layer-alpha emitter into following', () => {
    const l: GeneratorLayer = { ...(createGroupLayer('x') as unknown as GeneratorLayer), kind: 'generator', generator: { type: 'particles', params: { emitter: 'layer', layer: 'L1' } } };
    expect(contentEffects(proj([l])).layers[0]).toMatchObject({ generator: { params: { emitter: 'layer', follow: 'L1', edgeWidth: 6 } } });
  });
});

describe('contentEffectsOfLook', () => {
  it('cuts a look into effects, companions, group effects and outer companions', () => {
    const look = {
      id: 'u',
      name: 'U',
      group: 'User',
      kind: 'title2d',
      effects: [fx('outerGlow'), fx('backlight'), fx('deepGlow'), fx('sparkles')],
      partEffects: {},
      refSize: 200,
      builtin: false,
    } as StylePreset;
    const out = contentEffectsOfLook(look);
    expect(out.effects.map((e) => e.type)).toEqual(['outerGlow']);
    expect(out.groupEffects?.map((e) => e.type)).toEqual(['deepGlow']);
    expect(out.companions?.map((c) => [c.generator.type, c.place, c.outer ?? false])).toEqual([
      ['backlight', 'below', false],
      ['glints', 'above', true],
    ]);
    expect(contentEffectsOfLook(out)).toBe(out);
  });
});
