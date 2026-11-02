import { describe, expect, it } from 'vitest';
import { migrateProject } from '../../src/io/project';
import { backplate3D, createTitle2DLayer, createTitle3DLayer, defaultComp, material3D } from '../../src/model/defaults';
import { forEachMaterial, linkedSlots } from '../../src/model/links';
import type { Layer, Material3D, Project, Title2DLayer, Title3DLayer } from '../../src/model/types';
import { applyPresetToProject, presetFromLayer } from '../../src/presets/apply';
import { applyColourway } from '../../src/presets/colourways';
import { FACTORY_STYLES } from '../../src/presets/factory';
import { TEMPLATES } from '../../src/presets/templates';
import { syncLinks } from '../../src/store/links';
import { getIn, updateIn } from '../../src/store/paths';

const proj = (layers: Layer[], materialLinks?: Project['materialLinks']): Project => ({ version: 9, name: 'T', comp: defaultComp(), layers, ...(materialLinks ? { materialLinks } : {}) });

const rainbowGlass = () => FACTORY_STYLES.find((s) => s.id === 'f-3d-rainbow-glass-gold')!;
/** A 3D title wearing the rainbow glass look (its two gold tubes are one link named Gold). */
function rainbowTitle(): Project {
  const t = createTitle3DLayer('BIG');
  return applyPresetToProject(proj([t]), t.id, rainbowGlass(), { applyFont: false });
}

/** A 3D title with two plates whose fronts and edges are all linked to `gold`. */
function goldPlates(id = 'gold'): Title3DLayer {
  const l = createTitle3DLayer('7');
  const gold: Material3D = { ...material3D('gold'), link: id };
  const plate = () => ({ ...backplate3D(2, 'gold'), face: { ...gold }, side: { ...gold } });
  return { ...l, style3d: { ...l.style3d, backplates: [plate(), plate()] } };
}

const plateMats = (p: Project, i = 0) => (p.layers[i] as Title3DLayer).style3d.backplates.flatMap((b) => [b.face, b.side]);

describe('syncLinks', () => {
  it('mirrors an edit inside one linked material to the others, across layers', () => {
    const prev = proj([goldPlates(), goldPlates()]);
    const next = syncLinks(prev, updateIn(prev, ['layers', 1, 'style3d', 'backplates', 0, 'side', 'roughness'], () => 0.9));
    expect([...plateMats(next, 0), ...plateMats(next, 1)].map((m) => m.roughness)).toEqual(Array(8).fill(0.9));
  });

  it('returns the same project when nothing linked changed', () => {
    const prev = proj([goldPlates()]);
    const next = updateIn(prev, ['layers', 0, 'name'], () => 'x');
    expect(syncLinks(prev, next)).toBe(next);
  });

  it('keeps the link of a material rewritten without one (preset, colourway, paste) and mirrors it', () => {
    const prev = proj([goldPlates()]);
    const next = syncLinks(prev, updateIn(prev, ['layers', 0, 'style3d', 'backplates', 1, 'face'], () => material3D('chrome')));
    expect(plateMats(next).map((m) => [m.preset, m.link])).toEqual(Array(4).fill(['chrome', 'gold']));
  });

  it('an own empty link key unlinks: the key goes, the others stay linked and unchanged', () => {
    const prev = proj([goldPlates()]);
    const m = (prev.layers[0] as Title3DLayer).style3d.backplates[0].face;
    const next = syncLinks(prev, updateIn(prev, ['layers', 0, 'style3d', 'backplates', 0, 'face'], () => ({ ...m, link: undefined, roughness: 1 })));
    const mats = plateMats(next);
    expect('link' in mats[0]).toBe(false);
    expect(mats.slice(1).map((x) => [x.link, x.roughness])).toEqual(Array(3).fill(['gold', m.roughness]));
  });

  it('a duplicated layer joins its links without touching the originals', () => {
    const prev = proj([goldPlates()]);
    const next = { ...prev, layers: [...prev.layers, { ...structuredClone(prev.layers[0]), id: 'copy' }] };
    const out = syncLinks(prev, next);
    expect(out.layers[0]).toBe(prev.layers[0]);
    expect(linkedSlots(out, 'gold', '3d')).toHaveLength(8);
  });

  it('drops the names of links nothing uses any more', () => {
    const prev = proj([goldPlates()], { gold: { name: 'Gold' }, gone: { name: 'Old' } });
    const out = syncLinks(prev, { ...prev, name: 'renamed' });
    expect(out.materialLinks).toEqual({ gold: { name: 'Gold' } });
  });

  it('2D and 3D materials with the same id are separate links', () => {
    const t2 = createTitle2DLayer('A');
    const two: Title2DLayer = { ...t2, style: { ...t2.style, face: { ...t2.style.face, link: 'gold' } } };
    const prev = proj([goldPlates(), two]);
    const out = syncLinks(prev, updateIn(prev, ['layers', 0, 'style3d', 'backplates', 0, 'face', 'roughness'], () => 0.5));
    expect(out.layers[1]).toBe(two);
  });
});

describe('links in looks and templates', () => {
  it('every link of every factory look and template holds equal materials (renders unchanged)', () => {
    const projects = [
      ...TEMPLATES.map((t) => t.build()),
      ...FACTORY_STYLES.map((p) => {
        const l = p.kind === 'title2d' ? createTitle2DLayer('A') : createTitle3DLayer('A');
        return applyPresetToProject(proj([l]), l.id, p, { applyFont: false });
      }),
    ];
    for (const p of projects) {
      const groups = new Map<string, string[]>();
      for (const s of linkedSlots(p)) groups.set(`${s.kind}:${s.link}`, [...(groups.get(`${s.kind}:${s.link}`) ?? []), JSON.stringify(s.mat)]);
      for (const mats of groups.values()) expect(new Set(mats).size).toBe(1);
      expect(syncLinks(p, p)).toBe(p);
    }
  });

  it('the rainbow glass look’s four gold materials are one link named Gold', () => {
    const p = rainbowTitle();
    const gold = linkedSlots(p).filter((s) => p.materialLinks?.[s.link]?.name === 'Gold');
    expect(gold.map((s) => s.key.split(':').at(-1))).toEqual(['face', 'side', 'face', 'side']);
  });

  it('a look gets fresh link ids per layer; its names join the project', () => {
    const a = createTitle3DLayer('A');
    const b = createTitle3DLayer('B');
    let p = proj([a, b]);
    p = applyPresetToProject(p, a.id, rainbowGlass(), { applyFont: false });
    p = applyPresetToProject(p, b.id, rainbowGlass(), { applyFont: false });
    const ids = (l: Layer) => new Set(linkedSlots(proj([l])).map((s) => s.link));
    const [ia, ib] = [ids(p.layers[0]), ids(p.layers[1])];
    expect([...ia].some((id) => ib.has(id))).toBe(false);
    expect(Object.values(p.materialLinks ?? {}).filter((n) => n.name === 'Gold')).toHaveLength(2);
  });

  it('a pasted style keeps the project’s links and drops unknown ones', () => {
    const src = goldPlates('known');
    const p = proj([src, createTitle3DLayer('B')], { known: { name: 'Gold' } });
    const clip = presetFromLayer(p, src.id, 'clip', 'Clipboard');
    expect(clip.links).toEqual({ known: { name: 'Gold' } });
    const kept = applyPresetToProject(p, p.layers[1].id, clip, { applyFont: false, keepLinks: true });
    expect(linkedSlots(kept, 'known')).toHaveLength(8);
    const other = createTitle3DLayer('C');
    const dropped = applyPresetToProject(proj([other]), other.id, clip, { applyFont: false, keepLinks: true });
    expect(linkedSlots(dropped)).toHaveLength(0);
  });

  it('a colourway keeps links and gives every material of a link the same result', () => {
    const l = rainbowTitle().layers.find((x) => x.kind === 'title3d')!;
    for (const c of ['red', 'blue', 'zebra'] as const) {
      const out = applyColourway(l, c);
      const groups = new Map<string, string[]>();
      forEachMaterial(out, (s) => s.mat.link && groups.set(s.mat.link, [...(groups.get(s.mat.link) ?? []), JSON.stringify(s.mat)]));
      expect(groups.size).toBeGreaterThan(0);
      for (const mats of groups.values()) expect(new Set(mats).size).toBe(1);
    }
  });

  it('files keep links and their names', () => {
    const p = proj([goldPlates()], { gold: { name: 'Gold' } });
    const back = migrateProject(JSON.parse(JSON.stringify(p)));
    expect(back.materialLinks).toEqual({ gold: { name: 'Gold' } });
    expect(getIn(back, ['layers', 0, 'style3d', 'backplates', 1, 'side', 'link'])).toBe('gold');
  });
});
