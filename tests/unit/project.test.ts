import { describe, expect, it } from 'vitest';
import { migrateEffects, migrateProject, parseProjectFile, toBase64 } from '../../src/io/project';
import { backplate3D, band3D, createBackgroundLayer, createProject, createTitle2DLayer, createTitle3DLayer, imageSource, material2D, material3D, solidFill } from '../../src/model/defaults';
import { charSide, plateSide, sideMaterial } from '../../src/model/sides';
import type { CharAdjust, EffectInstance, Material2D, Material3D, Project, Title2DLayer, Title3DLayer, Title3DProps } from '../../src/model/types';

// Loose JSON as it comes out of an older file.
type Json = Record<string, any>;

const effect = (type: string, params: Json): EffectInstance => ({ id: `${type}-id`, type, enabled: true, params }) as EffectInstance;

/**
 * A current (v6) project that an older file migrates to exactly: values the migration fills
 * with the OLD behaviour (useGlobalLight false, tateChuYoko false, bevelPosition 'inside') are
 * set to those here. Has a 3D text title with a backplate and per-char face, a 2D text title with
 * per-char face / scale, a 2D image title, and layer effects.
 */
function currentProject(): Project {
  const p: Project = { ...createProject(), layers: [createBackgroundLayer(), createTitle3DLayer('確定'), createTitle2DLayer('BIG BONUS')] };
  const off2D = (m: Material2D) => {
    m.bevel.useGlobalLight = false;
    m.satin.useGlobalLight = false;
  };
  const t3 = p.layers[1] as Title3DLayer;
  t3.style3d.bevelPosition = 'inside';
  t3.style3d.backplates = [backplate3D(4, 'chrome')];
  if (t3.source.kind !== 'text') throw new Error('expected text');
  t3.source.tateChuYoko = false;
  t3.source.chars = { 0: { dx: 1, dy: 0, scale: 1.2, rotate: 0, face3d: { ...t3.style3d.face } } };

  const t2 = p.layers[2] as Title2DLayer;
  off2D(t2.style.face);
  t2.style.rims.forEach((r) => off2D(r.material));
  if (t2.source.kind !== 'text') throw new Error('expected text');
  t2.source.tateChuYoko = false;
  const charFace = material2D(solidFill('#ff0000'));
  off2D(charFace);
  t2.source.chars = { 2: { dx: 5, dy: -3, scale: 0.8, rotate: 10, face: charFace } };
  t2.effects = [effect('dropShadow', { angle: 60, distance: 10, size: 14, useGlobalLight: false })];

  const img = { ...createTitle2DLayer('img'), source: imageSource('asset-1', 300) };
  off2D(img.style.face);
  img.style.rims.forEach((r) => off2D(r.material));
  p.layers.push(img);
  return p;
}

/**
 * `p` as an older `version` file would store it: every field added since v4 removed (no per-layer
 * or per-part lighting), and every 3D side stored (v4–v9 had no inherited sides).
 */
function v4Like(p: Project, version: number): Json {
  const j: Json = structuredClone(p);
  j.version = version;
  delete j.comp.globalLight;
  delete j.comp.dpi;
  const strip2D = (m: Json) => {
    delete m.opacity;
    delete m.bevel.useGlobalLight;
    delete m.satin.useGlobalLight;
    delete m.texture.target;
    delete m.texture.angle;
    delete m.gloss.angle;
    delete m.refraction;
    delete m.glass;
    delete m.sheen;
  };
  const strip3D = (m: Json) => {
    delete m.gradientAxis;
    delete m.surface;
    delete m.environment;
  };
  for (const l of j.layers) {
    delete l.clip;
    if (l.kind === 'background') continue;
    for (const k of ['warp', 'distort', 'weight', 'partEffects']) delete l[k];
    for (const fx of l.effects) if (fx.type === 'dropShadow') delete fx.params.useGlobalLight;
    const s = l.source;
    if (s.kind === 'text') {
      for (const k of ['hScale', 'vScale', 'tsume', 'tateChuYoko', 'lines']) delete s[k];
      for (const c of Object.values<Json>(s.chars)) {
        if (c.face) strip2D(c.face);
        if (c.face3d) strip3D(c.face3d);
      }
    }
    if (s.kind === 'image') delete s.trace;
    if (l.kind === 'title2d') {
      delete l.style.knockout;
      delete l.style.erode;
      strip2D(l.style.face);
      for (const r of l.style.rims) {
        delete r.plate;
        strip2D(r.material);
      }
    } else {
      const s3 = l.style3d;
      for (const k of ['mode', 'inflate', 'envLock', 'bevelPosition', 'faceImage', 'edgeImage', 'lighting']) delete s3[k];
      s3.side ??= structuredClone(s3.bands.at(-1)?.material ?? s3.face);
      for (const b of s3.backplates) b.side ??= structuredClone(b.face);
      strip3D(s3.face);
      strip3D(s3.side);
      for (const b of s3.bands) strip3D(b.material);
      for (const b of s3.backplates) {
        delete b.plate;
        strip3D(b.face);
        strip3D(b.side);
      }
    }
  }
  return j;
}

describe('migrateProject', () => {
  it.each([4, 5])('a v%i project gains every current field, with the old behaviour where documented', (version) => {
    const want = currentProject();
    const old = v4Like(want, version);
    // The sample really has none of the newer fields.
    expect(JSON.stringify(old)).not.toMatch(/useGlobalLight|tateChuYoko|bevelPosition|gradientAxis|"surface"|"clip"|partEffects|"trace"|"dpi"|"erode"|"plate"|"weight"/);
    const snapshot = structuredClone(old);
    const got = migrateProject(old);
    expect(got.version).toBe(10);
    expect(got).toEqual(want);
    // The input is not modified.
    expect(old).toEqual(snapshot);
  });

  it('keeps per-character offsets and scales as stored (the v4 scale compensation is a separate, font-aware step)', () => {
    const got = migrateProject(v4Like(currentProject(), 4));
    const t2 = got.layers[2] as Title2DLayer;
    if (t2.source.kind !== 'text') throw new Error('expected text');
    expect(t2.source.chars[2]).toMatchObject({ dx: 5, dy: -3, scale: 0.8, rotate: 10 });
  });

  it('a v6 file from before image tracing and face images gets them', () => {
    const want = currentProject();
    const old: Json = structuredClone(want);
    delete old.layers[3].source.trace;
    delete old.layers[1].style3d.faceImage;
    expect(migrateProject(old)).toEqual(want);
  });

  it('keeps values that are present instead of overwriting them with fill values', () => {
    const old = v4Like(currentProject(), 4);
    old.comp.globalLight = { angle: 45 };
    old.comp.dpi = 300;
    old.layers[2].style.face.bevel.useGlobalLight = true;
    old.layers[2].source.tateChuYoko = true;
    old.layers[2].effects[0].params.useGlobalLight = true;
    old.layers[1].style3d.bevelPosition = 'outside';
    old.layers[1].style3d.face.surface = { kind: 'brushed' };
    old.layers[2].clip = true;
    const got = migrateProject(old);
    expect(got.comp.globalLight).toEqual({ angle: 45, altitude: 30 });
    expect(got.comp.dpi).toBe(300);
    const t2 = got.layers[2] as Title2DLayer;
    const t3 = got.layers[1] as Title3DLayer;
    expect(t2.style.face.bevel.useGlobalLight).toBe(true);
    expect(t2.source.kind === 'text' && t2.source.tateChuYoko).toBe(true);
    expect(t2.effects[0].params.useGlobalLight).toBe(true);
    expect(t2.clip).toBe(true);
    expect(t3.style3d.bevelPosition).toBe('outside');
    // A partial nested object keeps its fields and gets the rest.
    expect(t3.style3d.face.surface).toEqual({ kind: 'brushed', amount: 0.5, scale: 20, seed: 1 });
  });

  it('is idempotent (current data passes through unchanged)', () => {
    const once = migrateProject(v4Like(currentProject(), 4));
    expect(migrateProject(once)).toEqual(once);
    const current = createProject();
    expect(migrateProject(current)).toEqual(current);
  });

  it('migrates part effects of v6 titles', () => {
    const p = currentProject();
    const t2 = p.layers[2] as Title2DLayer;
    t2.partEffects = { face: [effect('dropShadow', { angle: 30 })] };
    const got = migrateProject(p).layers[2] as Title2DLayer;
    expect(got.partEffects.face![0].params.useGlobalLight).toBe(false);
  });

  it.each([1, 2, 3])('refuses a version %i project, naming the version and the supported ones', (version) => {
    expect(() => migrateProject({ ...v4Like(currentProject(), 4), version })).toThrow(new RegExp(`version ${version} project.*version 4 to 10`));
  });

  it.each([11, 0, '7', undefined])('refuses version %s as unsupported', (version) => {
    expect(() => migrateProject({ ...v4Like(currentProject(), 4), version })).toThrow(/Unsupported project version .* \(expected 4 to 10\)/);
  });

  it('refuses non-projects', () => {
    for (const bad of [null, 'x', [], { version: 7, comp: {} }, { version: 7, layers: [] }, { version: 7, layers: {}, comp: {} }])
      expect(() => migrateProject(bad)).toThrow('Not a Pachislop project');
  });
});

describe('v8 → v9 tiltY', () => {
  /** A project with a 3D text title whose glyphs carry `chars`, stored as `version`. */
  const withChars = (version: number, chars: Record<number, CharAdjust>): Json => {
    const t3 = createTitle3DLayer('確定');
    if (t3.source.kind !== 'text') throw new Error('expected text');
    t3.source.chars = chars;
    return { ...structuredClone({ ...createProject(), layers: [t3] }), version };
  };
  const charsOf = (p: Project) => {
    const t3 = p.layers[0] as Title3DLayer;
    if (t3.source.kind !== 'text') throw new Error('expected text');
    return t3.source.chars;
  };

  it('negates a v8 glyph’s tiltY and keeps its other 3D adjustments', () => {
    const got = migrateProject(withChars(8, { 0: { dx: 0, dy: 0, scale: 1, rotate: 0, tiltX: 12, tiltY: 20, dz: 5 } }));
    expect(got.version).toBe(10);
    expect(charsOf(got)[0]).toMatchObject({ tiltX: 12, tiltY: -20, dz: 5 });
  });

  it('leaves a glyph without tiltY without it', () => {
    const got = migrateProject(withChars(8, { 1: { dx: 0, dy: 0, scale: 1, rotate: 0, tiltX: 12 } }));
    expect(charsOf(got)[1]).not.toHaveProperty('tiltY');
    expect(charsOf(got)[1].tiltX).toBe(12);
  });

  it('passes v9 data unchanged (migrating twice equals once)', () => {
    const v9 = migrateProject(withChars(9, { 0: { dx: 0, dy: 0, scale: 1, rotate: 0, tiltX: 12, tiltY: 20, dz: 5 } }));
    expect(charsOf(v9)[0].tiltY).toBe(20);
    const once = migrateProject(withChars(8, { 0: { dx: 0, dy: 0, scale: 1, rotate: 0, tiltY: 20 } }));
    expect(migrateProject(once)).toEqual(once);
  });
});

describe('v9 → v10 inherited sides', () => {
  const mat = (preset: Material3D['preset'], o: Partial<Material3D> = {}): Material3D => ({ ...material3D(preset), ...o });
  /** A 3D text title stored as `version` with `style` over the default one and letters `chars`. */
  const stored = (version: number, style: Partial<Title3DProps>, chars: Record<number, CharAdjust> = {}): Json => {
    const t3 = createTitle3DLayer('確定');
    if (t3.source.kind !== 'text') throw new Error('expected text');
    t3.source.chars = chars;
    return { ...structuredClone({ ...createProject(), layers: [{ ...t3, style3d: { ...t3.style3d, ...style } }] }), version };
  };
  const style = (p: Project) => (p.layers[0] as Title3DLayer).style3d;
  const charsOf = (p: Project) => {
    const t3 = p.layers[0] as Title3DLayer;
    if (t3.source.kind !== 'text') throw new Error('expected text');
    return t3.source.chars;
  };
  const band = (m: Material3D) => ({ ...band3D(1, 1, 'custom', 'round'), material: m });
  const plate = (face: Material3D, side: Material3D) => ({ ...backplate3D(2, 'custom'), face, side });

  it('a side equal to its outermost band, a plate edge equal to its front and a bandless side equal to the face inherit', () => {
    const gold = mat('gold', { link: 'g' });
    const got = migrateProject(stored(9, { bands: [band(mat('chrome')), band(gold)], side: { ...gold }, backplates: [plate(mat('blackGloss'), mat('blackGloss'))] }));
    expect(got.version).toBe(10);
    expect(style(got)).not.toHaveProperty('side');
    expect(style(got).backplates[0]).not.toHaveProperty('side');
    expect(sideMaterial(style(got))).toEqual(gold);
    const flat = migrateProject(stored(9, { bands: [], face: mat('silver'), side: mat('silver') }));
    expect(style(flat)).not.toHaveProperty('side');
  });

  it('a side with another material or its own link stays, and so does an edge unlike its front', () => {
    const other = migrateProject(stored(9, { bands: [band(mat('gold'))], side: mat('redMetal'), backplates: [plate(mat('gold'), mat('chrome'))] }));
    expect(style(other).side?.preset).toBe('redMetal');
    expect(style(other).backplates[0].side?.preset).toBe('chrome');
    const linked = migrateProject(stored(9, { bands: [band(mat('gold'))], side: mat('gold', { link: 'own' }) }));
    expect(style(linked).side?.link).toBe('own');
  });

  it('letters keep the side they showed: an equal own side inherits, a letter owning its outermost band gets a copy', () => {
    const gold = mat('gold');
    const chars: Record<number, CharAdjust> = {
      0: { dx: 0, dy: 0, scale: 1, rotate: 0, face3d: mat('whiteGloss'), side3d: { ...gold, link: 'g' } },
      1: { dx: 0, dy: 0, scale: 1, rotate: 0, bands3d: [mat('redMetal')] },
      2: { dx: 0, dy: 0, scale: 1, rotate: 0, bands3d: [mat('redMetal')], side3d: mat('redMetal') },
      3: { dx: 0, dy: 0, scale: 1, rotate: 0, side3d: { ...gold } },
    };
    const old = stored(9, { bands: [band({ ...gold, link: 'g' })], side: { ...gold, link: 'g' } }, chars);
    const oldStyle = old.layers[0].style3d as Title3DProps;
    const got = migrateProject(old);
    expect(style(got)).not.toHaveProperty('side');
    const c = charsOf(got);
    // 0's own side deep-equals its new neighbour, the layer's band (link included)
    expect(c[0]).not.toHaveProperty('side3d');
    // 1 owns its band but showed the layer's side: it keeps an unlinked copy of it
    expect(c[1].side3d).toEqual(gold);
    // 2's own side equals its own band, its neighbour now
    expect(c[2]).not.toHaveProperty('side3d');
    // 3's own side lacks the band's link: it stays
    expect(c[3].side3d).toEqual(gold);
    // every letter shows what it showed (the renders stay the same)
    for (const k of [0, 1, 2, 3]) expect({ ...charSide(style(got), c[k]), link: undefined }).toEqual({ ...(chars[k].side3d ?? oldStyle.side!), link: undefined });
  });

  it('v10 data keeps an owned side equal to its neighbour; migrating twice equals once', () => {
    const gold = mat('gold');
    const v10 = migrateProject(stored(10, { bands: [band(gold)], side: { ...gold }, backplates: [plate(gold, { ...gold })] }));
    expect(style(v10).side).toEqual(gold);
    expect(plateSide(style(v10).backplates[0])).toEqual(gold);
    expect(style(v10).backplates[0].side).toEqual(gold);
    const once = migrateProject(stored(9, { bands: [band(gold)], side: { ...gold } }, { 0: { dx: 0, dy: 0, scale: 1, rotate: 0, bands3d: [mat('chrome')] } }));
    expect(migrateProject(once)).toEqual(once);
  });
});

describe('migrateEffects', () => {
  const oldGlow = (params: Json) => effect('deepGlow', params);

  it('fills a missing useGlobalLight with false only on effects that have the param', () => {
    const shadow = effect('dropShadow', { angle: 60 });
    const glow = effect('outerGlow', { size: 10 });
    const [s, g] = migrateEffects([shadow, glow]);
    expect(s.params).toEqual({ angle: 60, useGlobalLight: false });
    expect(g).toBe(glow);
    expect(shadow.params).toEqual({ angle: 60 });
  });

  it('turns an old two-blur Deep Glow into the light glow', () => {
    const [fx] = migrateEffects([oldGlow({ innerRadius: 10, outerRadius: 120, innerIntensity: 1, outerIntensity: 0.5, tint: '#ff0000', tintAmount: 0.8, threshold: 0.5, exposure: 1, onFace: 0.3 })]);
    for (const k of ['innerRadius', 'outerRadius', 'innerIntensity', 'outerIntensity', 'tint']) expect(fx.params).not.toHaveProperty(k);
    expect(fx.params).toMatchObject({ radius: 120, exposure: 0, knee: 0.1, colorMode: 'custom', color: '#ff0000', tintAmount: 0, onFace: 0.3 });
    // Same scattered energy: (1.2 · 1 + 3 · 0.5) · 2^1.
    expect(fx.params.intensity).toBeCloseTo(5.4, 9);
    // sRGB 0.5 is linear ≈ 0.214.
    expect(fx.params.threshold).toBeCloseTo(0.214, 3);
    expect(fx.params.falloff).toBeGreaterThanOrEqual(0);
    expect(fx.params.falloff).toBeLessThanOrEqual(100);
  });

  it('a weak tint tints the layer colours instead of replacing them', () => {
    const [fx] = migrateEffects([oldGlow({ tint: '#00ff00', tintAmount: 0.3 })]);
    expect(fx.params).toMatchObject({ colorMode: 'layer', tintAmount: 0.3, tintInner: '#00ff00', tintOuter: '#00ff00', radius: 240 });
    expect(fx.params).not.toHaveProperty('color');
  });

  it('more outer light means a longer haze (lower falloff); intensity is capped at 8', () => {
    const falloff = (outerIntensity: number) => migrateEffects([oldGlow({ outerIntensity })])[0].params.falloff as number;
    expect(falloff(0.2)).toBeGreaterThan(falloff(1.5));
    expect(falloff(0)).toBe(100);
    expect(migrateEffects([oldGlow({ innerIntensity: 5, outerIntensity: 5, exposure: 3 })])[0].params.intensity).toBe(8);
  });

  it('leaves a current Deep Glow alone', () => {
    const current = oldGlow({ exposure: 1, radius: 200, tintAmount: 0.4, tintInner: '#ffffff' });
    expect(migrateEffects([current])[0]).toBe(current);
  });

  it('is idempotent: applying it twice equals applying it once', () => {
    const effects = [
      oldGlow({ innerRadius: 20, outerRadius: 300, tint: '#ffb43c', tintAmount: 0.6, threshold: 0.02 }),
      oldGlow({ outerIntensity: 0.1, tintAmount: 0.2 }),
      effect('dropShadow', { angle: 60 }),
      effect('innerShadow', { angle: 60, useGlobalLight: true }),
      effect('bevel', {}),
      effect('outerGlow', {}),
      effect('noSuchEffect', { innerRadius: 3 }),
    ];
    const once = migrateEffects(effects);
    const twice = migrateEffects(once);
    expect(twice).toEqual(once);
    twice.forEach((fx, i) => expect(fx, `effect ${i}`).toBe(once[i]));
  });
});

describe('parseProjectFile', () => {
  const file = (version: number, projectVersion = version) =>
    JSON.stringify({
      format: 'pslot',
      version,
      project: { ...v4Like(currentProject(), projectVersion) },
      fonts: [{ id: 'f1', name: 'Font', data: toBase64(new Uint8Array([1, 2, 3]).buffer) }],
      assets: [{ id: 'a1', name: 'A', data: toBase64(new Uint8Array([250, 0]).buffer) }],
    });

  it('upgrades an older file and notes it; decodes embedded blobs', () => {
    const b = parseProjectFile(file(4));
    expect(b.version).toBe(4);
    expect(b.project.version).toBe(10);
    expect(b.notes).toHaveLength(1);
    expect([...new Uint8Array(b.fonts[0].data)]).toEqual([1, 2, 3]);
    expect(b.assets[0]).toMatchObject({ id: 'a1', mime: 'application/octet-stream' });
    expect([...new Uint8Array(b.assets[0].data)]).toEqual([250, 0]);
  });

  it('a current file has no notes', () => {
    expect(parseProjectFile(file(10)).notes).toEqual([]);
  });

  it('refuses a file whose version disagrees with its project, and non-JSON', () => {
    expect(() => parseProjectFile(file(10, 4))).toThrow(/Unsupported project version 10/);
    expect(() => parseProjectFile('{')).toThrow('JSON parse failed');
    expect(() => parseProjectFile('{"format":"other"}')).toThrow('Not a Pachislop project file');
  });
});
