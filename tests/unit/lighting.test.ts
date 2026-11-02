import { describe, expect, it } from 'vitest';
import { migrateProject } from '../../src/io/project';
import { createProject, createTitle3DLayer, defaultComp, material3D, plateShape } from '../../src/model/defaults';
import { effectiveLighting, lightingSource, noLighting, resolveEnvironment, withEnvValue, withoutEnvValue } from '../../src/model/lighting';
import type { Environment3D, Lighting3D, Material3D, Project, Title3DLayer } from '../../src/model/types';

// Loose JSON as it comes out of an older file.
type Json = Record<string, any>;

const env = (o: Partial<Environment3D> = {}): Environment3D => ({ ...defaultComp().environment, ...o });

describe('effectiveLighting', () => {
  const comp = { ...defaultComp(), exposure: 1.3, environment: env({ preset: 'custom', customAssetId: 'hdr', blur: 0.2, repeatX: 2 }) };
  const layer = { style3d: { lighting: { environment: { rotation: 40, blur: 0.5 }, toneMapping: 'punch' as const } } };

  it('takes each value from the nearest level that sets it: part, layer, document', () => {
    const part: Material3D = { ...material3D('gold'), environment: { preset: 'city', repeatX: 1 } };
    expect(effectiveLighting(comp, null)).toEqual({ environment: comp.environment, lights: comp.lights, toneMapping: comp.toneMapping, exposure: 1.3 });
    const l = effectiveLighting(comp, layer);
    expect(l.environment).toEqual({ ...comp.environment, rotation: 40, blur: 0.5 });
    expect([l.toneMapping, l.exposure]).toEqual(['punch', 1.3]);
    const p = effectiveLighting(comp, layer, part);
    // the preset carries its custom HDR: a part picking 'city' drops the document's
    expect(p.environment).toEqual({ ...env({ preset: 'city' }), intensity: comp.environment.intensity, rotation: 40, blur: 0.5, repeatX: 1 });
    expect(p.lights).toBe(comp.lights);
    expect([lightingSource(layer, 'blur', part), lightingSource(layer, 'repeatX', part), lightingSource(layer, 'preset', part)]).toEqual(['layer', 'part', 'part']);
    expect([lightingSource(layer, 'exposure'), lightingSource(layer, 'toneMapping')]).toEqual(['document', 'layer']);
  });

  it('a level that sets nothing passes its parent environment through unchanged (same object)', () => {
    expect(resolveEnvironment(comp.environment, {})).toBe(comp.environment);
    expect(effectiveLighting(comp, { style3d: { lighting: noLighting() } }).environment).toBe(comp.environment);
  });

  it('setting and resetting the preset moves its custom HDR with it', () => {
    const set = withEnvValue({ blur: 0.1 }, 'preset', comp.environment);
    expect(set).toEqual({ blur: 0.1, preset: 'custom', customAssetId: 'hdr' });
    expect(withoutEnvValue(set, 'preset')).toEqual({ blur: 0.1 });
  });
});

/**
 * A v7 project: per-layer lighting whole or null, part environments whole or null. Its 3D style
 * is in the v4–v10 shape (one ring, one backplate) and inflated, so the v11 conversion keeps every
 * material where it can be checked: the ring a band switched off, the plate the next band, the
 * side wall on the letter.
 */
function v7(layerLighting: Lighting3D | null, partEnv: Environment3D | null, docBlur = 0): { json: Json; layer: Title3DLayer } {
  const layer = createTitle3DLayer('A');
  const p: Project = { ...createProject(), comp: { ...defaultComp(), environment: env({ blur: docBlur }) }, layers: [layer] };
  const j: Json = structuredClone(p);
  j.version = 7;
  const { bevel, bands: _, ...s3 }: Json = j.layers[0].style3d;
  j.layers[0].style3d = s3;
  s3.mode = 'inflate';
  s3.lighting = layerLighting;
  s3.face.environment = partEnv;
  s3.side = { ...material3D('silver'), environment: null };
  s3.bands = [{ id: 'ring', ...bevel, material: { ...material3D('chrome'), environment: null } }];
  const plate = { id: 'plate', enabled: true, grow: 2, join: 'miter', fillCounters: true, plate: plateShape(), depth: 10, zGap: 0, bevel };
  s3.backplates = [{ ...plate, face: { ...material3D('gold'), environment: partEnv }, side: { ...material3D('gold'), environment: null } }];
  j.layers[0].source.chars = { 0: { dx: 0, dy: 0, scale: 1, rotate: 0, bands3d: [{ ...material3D('chrome'), environment: partEnv }], side3d: { ...material3D('chrome'), environment: null } } };
  return { json: j, layer };
}

const own = (l: Lighting3D): Lighting3D => structuredClone(l);
const style = (p: Project) => (p.layers[0] as Title3DLayer).style3d;

describe('v7 → v8 lighting migration', () => {
  const whole: Lighting3D = { environment: env({ preset: 'softbox', rotation: 25, blur: 0.3, repeatX: 2 }), lights: defaultComp().lights, toneMapping: 'punch', exposure: 1 };

  it('a layer without its own lighting sets none; one with its own sets every value', () => {
    expect(style(migrateProject(v7(null, null).json)).lighting).toEqual(noLighting());
    expect(style(migrateProject(v7(own(whole), null).json)).lighting).toEqual(whole);
  });

  it('a part environment sets its values, except repeats of 1 and a blur the layer’s already reached', () => {
    const p = migrateProject(v7(own(whole), env({ preset: 'city', intensity: 4, blur: 0.2, repeatX: 1, repeatY: 3 })).json);
    const want = { ...env({ preset: 'city', intensity: 4, repeatY: 3 }) };
    delete (want as Partial<Environment3D>).blur;
    delete (want as Partial<Environment3D>).repeatX;
    expect(style(p).face.environment).toEqual(want);
    expect(style(p).bands[1].material.environment).toEqual(want);
    expect(style(p).side?.environment).toEqual({});
    const chars = (p.layers[0] as Title3DLayer).source;
    if (chars.kind !== 'text') throw new Error('expected text');
    expect(chars.chars[0].bands3d?.[0]?.environment).toEqual(want);
    expect(chars.chars[0].side3d?.environment).toEqual({});
  });

  it('a part blur above the layer’s stays the part’s; under a layer without lighting the document’s blur is the floor', () => {
    expect(style(migrateProject(v7(own(whole), env({ blur: 0.6 })).json)).face.environment.blur).toBe(0.6);
    expect(style(migrateProject(v7(null, env({ blur: 0.3 }), 0.4).json)).face.environment.blur).toBeUndefined();
    expect(style(migrateProject(v7(null, env({ blur: 0.5 }), 0.4).json)).face.environment.blur).toBe(0.5);
  });

  it('renders every part as before (blur: max of part and layer), except a repeat of 1 now follows the layer', () => {
    const part = env({ preset: 'city', blur: 0.1, repeatX: 1, repeatY: 1 });
    const p = migrateProject(v7(own(whole), part).json);
    const got = effectiveLighting(p.comp, p.layers[0] as Title3DLayer, style(p).face).environment;
    expect(got).toEqual({ ...part, blur: Math.max(part.blur, whole.environment.blur), repeatX: whole.environment.repeatX });
  });

  it('v8 data passes unchanged: a part’s explicit blur 0 and repeat 1 stay set', () => {
    const layer = createTitle3DLayer('A');
    layer.style3d.lighting = { environment: { blur: 0.5 } };
    layer.style3d.face = { ...layer.style3d.face, environment: { blur: 0, repeatX: 1 } };
    const p: Project = { ...createProject(), layers: [layer] };
    expect(migrateProject(structuredClone(p))).toEqual(p);
  });
});
