import { describe, expect, it } from 'vitest';
import { backplate3D, band3D, createGroupLayer, createTitle2DLayer, createTitle3DLayer, defaultComp, material2D, rim2D, solidFill } from '../../src/model/defaults';
import { effectiveLighting, LIGHTING_KEYS, lightingKeysSet } from '../../src/model/lighting';
import type { Comp, EffectInstance, GeneratorLayer, Layer, Project, Title2DLayer, Title3DLayer } from '../../src/model/types';
import { applyPreset, applyPresetToProject, canApplyPreset, presetFromLayer } from '../../src/presets/apply';
import { factoryStyle } from '../../src/presets/factory';
import type { StylePreset } from '../../src/presets/types';

const rims = (ids: string[]) => ids.map((id) => rim2D(2, material2D(solidFill('#000000')), { id }));
const glow = (tag: string): EffectInstance => ({ id: tag, type: 'outerGlow', enabled: true, params: { tag } }) as EffectInstance;
const tagsOf = (list: EffectInstance[] | undefined) => (list ?? []).map((e) => e.params.tag);
const proj = (layers: Layer[], comp: Comp = defaultComp()): Project => ({ version: 10, name: 'T', comp, layers });

function title2d(rimIds: string[]): Title2DLayer {
  const l = createTitle2DLayer('A');
  return { ...l, style: { ...l.style, rims: rims(rimIds) } };
}

function title3d(plateIds: string[], bandIds: string[]): Title3DLayer {
  const l = createTitle3DLayer('A');
  return {
    ...l,
    style3d: {
      ...l.style3d,
      backplates: plateIds.map((id) => ({ ...backplate3D(4, 'gold'), id })),
      bands: bandIds.map((id) => ({ ...band3D(2, 2, 'gold'), id })),
    },
  };
}

function preset2d(rimIds: string[], partEffects: StylePreset['partEffects'], extra: Partial<StylePreset> = {}): StylePreset {
  return { id: 'p', name: 'P', group: 'Test', kind: 'title2d', style: title2d(rimIds).style, effects: [], partEffects, refSize: 200, builtin: true, ...extra };
}

describe('applyPreset part effects', () => {
  it('maps rim positions onto the applied style’s rims and drops positions it lacks', () => {
    const target = title2d(['t0', 't1', 't2', 't3']);
    target.partEffects = { 'rim:t3': [glow('old')] };
    const out = applyPreset(target, preset2d(['s0', 's1'], { 'rim:0': [glow('inner')], 'rim:1': [glow('outer')], 'rim:3': [glow('lost')], face: [glow('face')] }), {
      applyFont: false,
    }) as Title2DLayer;
    // The applied style's rims (the preset's), not the target's: the old part effects go with the old style.
    expect(out.style.rims.map((r) => r.id)).toEqual(['s0', 's1']);
    expect(Object.keys(out.partEffects).sort()).toEqual(['face', 'rim:s0', 'rim:s1']);
    expect(tagsOf(out.partEffects['rim:s0'])).toEqual(['inner']);
    expect(tagsOf(out.partEffects['rim:s1'])).toEqual(['outer']);
    expect(tagsOf(out.partEffects.face)).toEqual(['face']);
  });

  it('drops face effects when the applied style hides the face, and 3D-only positions on a 2D style', () => {
    const p = preset2d(['s0'], { face: [glow('face')], side: [glow('side')], 'band:0': [glow('band')], 'rim:0': [glow('rim')] });
    p.style = { ...p.style!, hideFace: true };
    const out = applyPreset(title2d(['t0']), p, { applyFont: false }) as Title2DLayer;
    expect(Object.keys(out.partEffects)).toEqual(['rim:s0']);
  });

  it('ignores empty lists and gives effects fresh ids', () => {
    const p = preset2d(['s0'], { 'rim:0': [], face: [glow('f')] });
    const out = applyPreset(title2d([]), p, { applyFont: false }) as Title2DLayer;
    expect(Object.keys(out.partEffects)).toEqual(['face']);
    expect(out.partEffects.face![0].id).not.toBe('f');
    expect(out.partEffects.face![0].id).not.toBe(p.partEffects.face![0].id);
  });

  it('3D: plate / band positions map by index; bands are dropped in inflate mode', () => {
    const src = title3d(['p0', 'p1'], ['b0', 'b1']);
    const preset: StylePreset = {
      id: 'p',
      name: 'P',
      group: 'Test',
      kind: 'title3d',
      style3d: src.style3d,
      effects: [],
      partEffects: { 'plate:1': [glow('plate1')], 'plate:2': [glow('nope')], 'band:0': [glow('band0')], side: [glow('side')] },
      refSize: 200,
      builtin: true,
    };
    const out = applyPreset(title3d([], []), preset, { applyFont: false }) as Title3DLayer;
    expect(Object.keys(out.partEffects).sort()).toEqual(['band:b0', 'plate:p1', 'side']);
    expect(tagsOf(out.partEffects['plate:p1'])).toEqual(['plate1']);

    const inflate = { ...preset, style3d: { ...src.style3d, mode: 'inflate' as const } };
    const flat = applyPreset(title3d([], []), inflate, { applyFont: false }) as Title3DLayer;
    expect(Object.keys(flat.partEffects).sort()).toEqual(['plate:p1', 'side']);
  });

  it('round trip: presetFromLayer keys part effects by position, so a look moves between layers with different rim ids', () => {
    const from = title2d(['a', 'b', 'c']);
    from.partEffects = { 'rim:c': [glow('outermost')], 'rim:a': [glow('innermost')], 'rim:stale': [glow('stale')] };
    const preset = presetFromLayer(proj([from]), from.id, 'Look', 'User');
    expect(Object.keys(preset.partEffects).sort()).toEqual(['rim:0', 'rim:2']);

    // Applying swaps in the preset's style (cloned), so the result's rim ids are the source's.
    const out = applyPreset(title2d(['x', 'y']), preset, { applyFont: false }) as Title2DLayer;
    const outRims = out.style.rims.map((r) => r.id);
    expect(outRims).toEqual(['a', 'b', 'c']);
    expect(tagsOf(out.partEffects[`rim:${outRims[2]}`])).toEqual(['outermost']);
    expect(tagsOf(out.partEffects[`rim:${outRims[0]}`])).toEqual(['innermost']);
    // The preset's style is a copy: editing the result does not change the preset.
    out.style.rims[0].width = 99;
    expect(preset.style!.rims[0].width).toBe(2);
  });
});

describe('applyPreset effect transfer', () => {
  it('scales px params by size / refSize and keeps unitless params', () => {
    const shadow = { id: 's', type: 'dropShadow', enabled: true, params: { distance: 10, size: 4, spread: 0.2, angle: 60 } } as EffectInstance;
    const target = title2d([]);
    target.source = { ...target.source, size: 400 };
    const out = applyPreset(target, preset2d([], {}, { effects: [shadow], refSize: 100 }), { applyFont: false });
    expect(out.effects[0].params).toMatchObject({ distance: 40, size: 16, spread: 0.2, angle: 60 });
    expect(shadow.params.distance).toBe(10);
  });

  it('handle positions are layer-relative: captured minus the layer position, applied scaled plus the new position', () => {
    const blur = (x: number, y: number) => ({ id: 'f', type: 'radialBlur', enabled: true, params: { centerX: x, centerY: y } }) as EffectInstance;
    const from = title2d([]);
    from.transform = { ...from.transform, x: 50, y: -20 };
    from.effects = [blur(70, 10)];
    const preset = presetFromLayer(proj([from]), from.id, 'Look', 'User');
    expect(preset.effects[0].params).toMatchObject({ centerX: 20, centerY: 30 });

    const to = title2d([]);
    to.transform = { ...to.transform, x: -30, y: 5 };
    to.source = { ...to.source, size: from.source.size * 2 };
    const out = applyPreset(to, preset, { applyFont: false });
    expect(out.effects[0].params).toMatchObject({ centerX: -30 + 40, centerY: 5 + 60 });
  });

  it('keeps id, transform, group membership and clipping; applies the font only when asked', () => {
    const target: Layer = { ...title2d([]), id: 'keep', parentId: 'grp', clip: true };
    const p = preset2d([], {}, { fontId: 'other-font' });
    const out = applyPreset(target, p, { applyFont: false });
    expect(out).toMatchObject({ id: 'keep', parentId: 'grp', clip: true, transform: target.transform });
    if (out.kind !== 'title2d' || out.source.kind !== 'text') throw new Error('expected a 2D text title');
    expect(out.source.fontId).not.toBe('other-font');
    const withFont = applyPreset(target, p, { applyFont: true });
    if (withFont.kind !== 'title2d' || withFont.source.kind !== 'text') throw new Error('expected a 2D text title');
    expect(withFont.source.fontId).toBe('other-font');
  });

  it('converts a text title to the preset’s kind; refuses non-titles', () => {
    const out = applyPreset(title2d([]), { ...preset2d([], {}), kind: 'title3d', style: undefined, style3d: title3d([], ['b']).style3d }, { applyFont: false });
    expect(out.kind).toBe('title3d');
    const group = createGroupLayer('g');
    expect(canApplyPreset(group, preset2d([], {}))).toBe(false);
    expect(() => applyPreset(group, preset2d([], {}), { applyFont: false })).toThrow();
  });
});

describe('3D look lighting', () => {
  it('a factory 3D look sets every lighting value, the ones it leaves out from the default comp', () => {
    const look = factoryStyle('f-3d-gold');
    const lighting = look.style3d?.lighting;
    if (!lighting) throw new Error('expected the look to carry its lighting');
    expect(lightingKeysSet(lighting)).toEqual(LIGHTING_KEYS);
    expect(lighting.environment.preset).toBe('softbox');
    expect(lighting.toneMapping).toBe('punch');
    expect(lighting.lights?.map((l) => l.type)).toEqual(defaultComp().lights.map((l) => l.type));
  });

  it('applying a 3D look gives the layer that lighting as its own (fresh light ids)', () => {
    const look = factoryStyle('f-3d-gold');
    const out = applyPreset(title3d([], []), look, { applyFont: false });
    if (out.kind !== 'title3d' || !look.style3d) throw new Error('expected a 3D look');
    expect(out.style3d.lighting.environment).toEqual(look.style3d.lighting.environment);
    expect(out.style3d.lighting.lights?.map((l) => l.id)).not.toEqual(look.style3d.lighting.lights?.map((l) => l.id));
  });

  it('a saved 3D look records the layer’s effective lighting as values it sets: its own, else the comp’s', () => {
    const comp = { ...defaultComp(), exposure: 1.7 };
    const plain = title3d([], []);
    expect(presetFromLayer(proj([plain], comp), plain.id, 'Look', 'User').style3d?.lighting).toEqual(effectiveLighting(comp, null));
    const own = { ...plain, style3d: { ...plain.style3d, lighting: { environment: { blur: 0.4 }, exposure: 0.5 } } };
    const saved = presetFromLayer(proj([own], comp), own.id, 'Look', 'User').style3d?.lighting;
    expect(saved).toEqual({ ...effectiveLighting(comp, null), environment: { ...comp.environment, blur: 0.4 }, exposure: 0.5 });
  });
});

describe('applyPresetToProject companions', () => {
  const glints = { generator: { type: 'glints', params: { size: 40, color: '#ffffff' } }, place: 'above' as const, blend: 'add' as const };
  const fire = { generator: { type: 'fire', params: {} }, place: 'below' as const };
  const gens = (p: Project) => p.layers.filter((l): l is GeneratorLayer => l.kind === 'generator');

  it('puts the companions with the layer in a group named after it, following it, px params scaled', () => {
    const t = { ...title2d([]), name: '確定', blend: 'screen' as const, transform: { ...title2d([]).transform, x: 30, opacity: 0.5 } };
    t.source = { ...t.source, size: 400 };
    const look = preset2d([], {}, { companions: [glints, fire], refSize: 200 });
    const out = applyPresetToProject(proj([t]), t.id, look, { applyFont: false });
    const [below, layer, above, group] = out.layers;
    expect(out.layers.map((l) => l.kind)).toEqual(['generator', 'title2d', 'generator', 'group']);
    expect(group).toMatchObject({ name: '確定', blend: 'screen', transform: { opacity: 0.5 } });
    expect(layer).toMatchObject({ id: t.id, parentId: group.id, blend: 'normal', transform: { x: 30, opacity: 1 } });
    for (const g of [below, above]) expect(g).toMatchObject({ parentId: group.id, companionOf: t.id, generator: { params: { follow: t.id } } });
    expect(below).toMatchObject({ generator: { type: 'fire' } });
    expect(above).toMatchObject({ blend: 'add', generator: { type: 'glints', params: { size: 80 } } });
    // A following companion draws where the layer is: its own transform stays the identity.
    expect(above.transform.x).toBe(0);
  });

  it('replaces the previous look\'s companions and group effects, reusing the layer\'s own group', () => {
    const t = title2d([]);
    const deep = { ...glow('deep'), fromPreset: true as const };
    const first = applyPresetToProject(proj([t]), t.id, preset2d([], {}, { companions: [glints], groupEffects: [deep] }), { applyFont: false });
    const group = first.layers.find((l) => l.kind === 'group')!;
    expect(tagsOf(group.effects)).toEqual(['deep']);
    const second = applyPresetToProject(first, t.id, preset2d([], {}, { companions: [fire] }), { applyFont: false });
    expect(gens(second).map((g) => g.generator.type)).toEqual(['fire']);
    expect(second.layers.filter((l) => l.kind === 'group').map((l) => l.id)).toEqual([group.id]);
    expect(second.layers.find((l) => l.id === group.id)!.effects).toEqual([]);
  });

  it('places companions above the layer\'s clip group, an outer one around its group, a free one at its position', () => {
    const t = { ...title2d([]), transform: { ...title2d([]).transform, x: -40, y: 12 } };
    const clipped = { ...title2d([]), id: 'c', clip: true };
    const flare = { generator: { type: 'lensFlare', params: { follow: '' } }, place: 'above' as const };
    const outer = { ...glints, outer: true as const };
    const look = preset2d([], {}, { companions: [glints, flare, outer], groupEffects: [glow('g')] });
    const out = applyPresetToProject(proj([t, clipped]), t.id, look, { applyFont: false });
    const inner = out.layers.find((l) => l.id === t.id)!.parentId!;
    const ids = out.layers.map((l) => (l.id === t.id ? 'T' : l.id === 'c' ? 'C' : l.id === inner ? 'G1' : l.kind));
    expect(ids).toEqual(['T', 'C', 'generator', 'generator', 'G1', 'generator', 'group']);
    const [g1, g2, g3] = gens(out);
    expect(g1.generator.params.follow).toBe(t.id);
    expect(g2).toMatchObject({ generator: { params: { follow: '' } }, transform: { x: -40, y: 12 } });
    expect(g3).toMatchObject({ companionOf: t.id, generator: { params: { follow: inner } } });
  });

  it('look A (companions, group effects, an outer one) then look B (none) leaves the layer flat, as it was', () => {
    const t = { ...title2d([]), clip: true, blend: 'screen' as const, transform: { ...title2d([]).transform, opacity: 0.5 } };
    const base = { ...title2d([]), id: 'base' };
    const a = preset2d([], {}, { companions: [fire, { ...glints, outer: true as const }], groupEffects: [glow('g')] });
    const withA = applyPresetToProject(proj([base, t]), t.id, a, { applyFont: false });
    expect(withA.layers.filter((l) => l.kind === 'group').every((g) => g.kind === 'group' && g.companionGroupOf !== undefined)).toBe(true);
    const withB = applyPresetToProject(withA, t.id, preset2d([], {}), { applyFont: false });
    expect(withB.layers.map((l) => l.id)).toEqual(['base', t.id]);
    expect(withB.layers[1]).toMatchObject({ clip: true, blend: 'screen', transform: { opacity: 0.5 } });
    expect(withB.layers[1].parentId).toBeUndefined();
  });

  it('keeps a group the user made, and a companion group that still has its own effects', () => {
    const g = createGroupLayer('mine');
    const t = { ...title2d([]), parentId: g.id };
    const withA = applyPresetToProject(proj([t, g]), t.id, preset2d([], {}, { companions: [glints] }), { applyFont: false });
    const withB = applyPresetToProject(withA, t.id, preset2d([], {}), { applyFont: false });
    expect(withB.layers.map((l) => l.id)).toEqual([t.id, g.id]);
    const solo = title2d([]);
    const fxA = applyPresetToProject(proj([solo]), solo.id, preset2d([], {}, { companions: [glints] }), { applyFont: false });
    const grp = fxA.layers.find((l) => l.kind === 'group')!;
    const userFx = { ...fxA, layers: fxA.layers.map((l) => (l === grp ? { ...l, effects: [glow('user')] } : l)) };
    expect(applyPresetToProject(userFx, solo.id, preset2d([], {}), { applyFont: false }).layers.map((l) => l.kind)).toEqual(['title2d', 'group']);
  });

  it('round trip: presetFromLayer captures companions (following, free, outer) and the group effects', () => {
    const t = title2d([]);
    const look = preset2d([], {}, { companions: [fire, { ...glints, outer: true as const }], groupEffects: [glow('g')] });
    const applied = applyPresetToProject(proj([t]), t.id, look, { applyFont: false });
    const back = presetFromLayer(applied, t.id, 'Look', 'User');
    expect(back.companions?.map((c) => [c.generator.type, c.place, c.outer ?? false, 'follow' in c.generator.params])).toEqual([
      ['fire', 'below', false, false],
      ['glints', 'above', true, false],
    ]);
    expect(tagsOf(back.groupEffects)).toEqual(['g']);
  });
});
