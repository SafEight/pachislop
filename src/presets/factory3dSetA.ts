import { band3D, bevel3D, material3D, pattern, shadow3D, uid } from '../model/defaults';
import type { Band3D, Material3D } from '../model/types';
import { blackPlate, darkMetal, edge3D, envLook, fx, g, glow3D, letter3D, letterBevel, m3, p3, plate, ring, starGlint, THREE_D } from './factory';
import type { StylePreset } from './types';

// 3D looks, set A: gem, lacquer, glass and stone materials, each with its own band stack.
// factory.ts imports this module while it assembles FACTORY_STYLES, so everything is built
// inside `setA3DLooks` (called then), never at module load.

/** Set A's 3D looks, in Library order. */
export function setA3DLooks(): StylePreset[] {
  /** A band flush behind the face (no grow, no bevel): what a glass or gem face shows through itself. */
  const bed = (depth: number, material: Material3D): Band3D => ({ ...band3D(0, 'custom'), depth: 1, offset: -depth, bevel: bevel3D(0, 0), material });

  // ---------- サファイア: faceted sapphire over a bright blue bed, chrome chamfer frame, navy and black plates ----------
  const sapphireSolids = letter3D({
    depth: 9,
    // the chrome frame is not the gem's material: the letter has no bevel and every ring is a band
    bevel: bevel3D(0, 0),
    rings: [ring(0.25, 0.4, darkMetal('#020a2a'), 'step'), ring(1.3, 1.3, m3('chrome', { reflectivity: 0.9 }), 'chamfer'), ring(0.3, 0.6, darkMetal('#020a2a'), 'step')],
    side: darkMetal('#0a1430', 0.25),
    plates: [
      plate(2.2, 'blueMetal', { depth: 6, bevel: bevel3D(1.2, 1.2, 'chamfer') }, { color: '#0a1c6a', gradient: g([0, '#3a6ae0'], [0.45, '#0a2080'], [0.55, '#020830'], [1, '#2a58d0']) }),
      plate(0.8, 'silver', { depth: 4, bevel: bevel3D(0.6, 0.6, 'round') }),
      blackPlate(1.6, { depth: 5 }, { color: '#01030c' }),
    ],
  });
  const sapphire = p3({
    id: 'f-3d-sapphire',
    name: 'サファイア Sapphire + Silver Frame',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      // big crumple facets, not flakes: each facet refracts the blue bed at its own angle like a cut stone
      face: m3('sapphire', { color: '#1a48ff', surface: { kind: 'crumple', amount: 0.3, scale: 32, seed: 3 } }),
      ...sapphireSolids,
      bands: [
        bed(sapphireSolids.depth, m3('blueMetal', { gradient: g([0, '#b8d8ff'], [0.3, '#4a8cff'], [0.46, '#0a40e0'], [0.52, '#021060'], [0.6, '#1048d8'], [0.85, '#60a0ff'], [1, '#c8e0ff']) })),
        ...sapphireSolids.bands,
      ],
      shadow: shadow3D(),
      glint: starGlint({ intensity: 0.6, threshold: 1.5, tint: '#e8f0ff' }),
    },
    effects: [...edge3D('#2a6aff', '#01030c'), ...glow3D('#a8c8ff')],
    lighting: envLook('studio', -60),
  });

  // ---------- 朱塗り: vermilion lacquer, gold-leaf chamfer, black urushi band with gold seigaiha 蒔絵, vermilion line ----------
  const shu = p3({
    id: 'f-3d-shu-lacquer',
    name: '朱塗り Vermilion Lacquer + Gold Leaf',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      face: {
        ...material3D('custom'),
        color: '#e0280e',
        // the lacquer's sheen: a pale sweep and a hard streak across the vermilion
        gradient: g([0, '#ff9a6a'], [0.2, '#f03a14'], [0.4, '#a01002'], [0.47, '#ff7048'], [0.53, '#8a0a00'], [0.75, '#b81404'], [1, '#ff5a30']),
        gradientAngle: 70,
        metalness: 0.1,
        roughness: 0.05,
        clearcoat: 1,
        reflectivity: 0.8,
        specBoost: 1.6,
      },
      ...letter3D({
        depth: 10,
        bevel: letterBevel('round', 1),
        rings: [
          // 金箔 gold leaf: pale gold with fine creases that break the lights into bright flecks
          ring(1.5, 1.3, m3('paleGold', { reflectivity: 1.3, surface: { kind: 'crumple', amount: 0.08, scale: 3, seed: 4 } }), 'chamfer'),
          ring(0.3, 0.6, darkMetal('#2a0800'), 'step'),
        ],
        side: darkMetal('#2a0a02', 0.3),
        plates: [
          blackPlate(
            3,
            { depth: 7, bevel: bevel3D(1, 1, 'round') },
            { color: '#080404', pattern: pattern({ kind: 'seigaiha', color: '#d8a640', opacity: 0.55, scale: 5, shade: 0.8 }) },
          ),
          plate(1, 'redMetal', { depth: 4, bevel: bevel3D(0.8, 0.8, 'round') }, { color: '#d02008', gradient: g([0, '#ff6a40'], [0.45, '#c01806'], [0.55, '#500600'], [1, '#e83a14']) }),
          blackPlate(1, { depth: 4, bevel: bevel3D(0.5, 0.5) }),
        ],
      }),
      shadow: shadow3D(),
      // only the hottest gold-leaf flecks throw stars
      glint: starGlint({ intensity: 0.4, threshold: 3, tint: '#fff4e0' }),
    },
    effects: [...edge3D('#ff4a1a', '#0a0200'), ...glow3D('#ffb070', 0.8)],
    lighting: envLook('studio', 20),
  });

  // ---------- 黒曜石: chipped black glass, black-chrome chamfer, thin gold line, smoky glass band, gold line, black plate ----------
  const blackGlass = (o: Partial<Material3D> = {}): Material3D => ({
    ...material3D('custom'),
    color: '#06060a',
    metalness: 0,
    roughness: 0.02,
    clearcoat: 1,
    reflectivity: 1.2,
    specBoost: 2,
    ...o,
  });
  const obsidian = p3({
    id: 'f-3d-obsidian',
    name: '黒曜石 Obsidian Glass + Gold Line',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      // conchoidal chips: a few big crumple facets catch the strip lights as sharp shards on the black
      face: blackGlass({ reflectivity: 0.5, clearcoat: 0.3, iridescence: 0.6, surface: { kind: 'crumple', amount: 0.2, scale: 45, seed: 9 } }),
      ...letter3D({
        depth: 10,
        // the black-chrome chamfer is not the glass's material: the letter has no bevel and every ring is a band
        bevel: bevel3D(0, 0),
        rings: [
          ring(1.1, 1.1, darkMetal('#3a3a44', 0.04), 'chamfer'),
          ring(0.5, 0.5, m3('punchyGold'), 'step'),
          ring(0.25, 0.5, darkMetal('#000000', 0.5), 'step'),
        ],
        side: darkMetal('#08080c', 0.3),
        plates: [
          plate(2.4, 'custom', { depth: 6, bevel: bevel3D(1.4, 1.4, 'chamfer') }, blackGlass({ color: '#2a2438' })),
          plate(0.6, 'punchyGold', { depth: 4, bevel: bevel3D(0.5, 0.5, 'round') }),
          blackPlate(1.4, { depth: 5 }, { color: '#000000' }),
        ],
      }),
      shadow: shadow3D(),
      glint: starGlint({ intensity: 0.5, threshold: 1.8, tint: '#ffffff' }),
    },
    effects: [...edge3D('#c89030', '#000000'), ...glow3D('#ffe0a0', 0.6)],
    lighting: envLook('strips', 10),
  });

  // ---------- ローズゴールド: rose gold, dark step, chocolate band, cream line, dark chocolate plate ----------
  const chocolate = (hi: string, mid: string, lo: string): Material3D =>
    m3('copper', { color: mid, gradient: g([0, hi], [0.45, mid], [0.55, lo], [1, hi]), roughness: 0.15, clearcoat: 1, metalness: 0.5, reflectivity: 0.6 });
  const roseChoc = p3({
    id: 'f-3d-rose-chocolate',
    name: 'ローズゴールド Rose Gold + Chocolate',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      // rose gold with a deeper horizon than the preset's: the face shades blush → chocolate → blush
      face: m3('roseGold', {
        reflectivity: 0.9,
        gradient: g([0, '#fff2ee'], [0.22, '#ffc0b0'], [0.44, '#c86a62'], [0.52, '#4a1418'], [0.6, '#b85a58'], [0.8, '#ffb8aa'], [1, '#fff0ee']),
      }),
      ...letter3D({
        depth: 10,
        bevel: letterBevel('round', 1.3),
        rings: [ring(0.3, 0.6, darkMetal('#200804'), 'step')],
        side: darkMetal('#2a0e08', 0.3),
        plates: [
          plate(2.6, 'custom', { depth: 6, bevel: bevel3D(1.4, 1.4, 'round') }, chocolate('#a0583a', '#4a1e0c', '#100400')),
          plate(0.7, 'whiteGloss', { depth: 4, bevel: bevel3D(0.6, 0.6, 'round') }, { color: '#ffe4d8' }),
          plate(2, 'custom', { depth: 6, bevel: bevel3D(1, 1, 'chamfer') }, chocolate('#5a2a18', '#200a04', '#050100')),
          blackPlate(0.8, { depth: 4, bevel: bevel3D(0.5, 0.5) }, { color: '#060100' }),
        ],
      }),
      shadow: shadow3D(),
      glint: starGlint({ intensity: 0.5, threshold: 1.6, tint: '#fff0ea' }),
    },
    effects: [...edge3D('#ff9a80', '#0a0200'), ...glow3D('#ffd0c0')],
    lighting: envLook('softbox', 30),
  });

  // ---------- カーボン: carbon-weave gunmetal, hot orange chamfer, gunmetal band, orange line, black plate ----------
  const hotOrange: Material3D = { ...material3D('custom'), color: '#ff6a00', metalness: 0.6, roughness: 0.12, clearcoat: 1, reflectivity: 0.9, emissive: '#ff4a00', emissiveIntensity: 2 };
  const gunmetal = (o: Partial<Material3D> = {}): Material3D => ({
    ...material3D('custom'),
    color: '#3a3e46',
    gradient: g([0, '#d8e0ec'], [0.2, '#6a7280'], [0.44, '#2a2e36'], [0.52, '#08090c'], [0.6, '#30343c'], [0.85, '#7a8290'], [1, '#c8d0dc']),
    metalness: 1,
    roughness: 0.18,
    clearcoat: 1,
    reflectivity: 0.85,
    ...o,
  });
  const carbon = p3({
    id: 'f-3d-carbon-orange',
    name: 'カーボン Carbon Gunmetal + Hot Orange',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      face: gunmetal({ pattern: pattern({ kind: 'checker', color: '#020306', color2: '#3a3e48', opacity: 0.75, scale: 1.1, angle: 45, shade: 0.9, relief: 0.6 }) }),
      ...letter3D({
        depth: 10,
        bevel: bevel3D(0, 0),
        rings: [ring(1.4, 1.3, hotOrange, 'chamfer'), ring(0.3, 0.6, darkMetal('#100400'), 'step')],
        side: darkMetal('#14161a', 0.3),
        plates: [
          plate(2.4, 'custom', { depth: 6, bevel: bevel3D(1.3, 1.3, 'chamfer') }, gunmetal({ roughness: 0.25 })),
          plate(0.6, 'custom', { depth: 4, bevel: bevel3D(0.5, 0.5, 'round') }, { ...hotOrange, emissiveIntensity: 2.5 }),
          blackPlate(1.4, { depth: 5 }, { color: '#020202' }),
        ],
      }),
      shadow: shadow3D(),
      glint: starGlint({ intensity: 0.4, threshold: 2.4, tint: '#fff0e0' }),
    },
    effects: [...edge3D('#ff5a00', '#000000'), fx('outerGlow', { color: '#ff4a00', size: 28, intensity: 1, spread: 0.05, opacity: 0.6, mode: 'behind' })],
    lighting: {
      ...envLook('studio', -20),
      lights: [
        { id: uid(), type: 'directional', color: '#ff8a30', intensity: 2.5, x: 900, y: -300, z: 200 },
        { id: uid(), type: 'directional', color: '#ffffff', intensity: 1.4, x: -300, y: 600, z: 1200 },
      ],
    },
  });

  // ---------- オーロラ: teal → violet metal, chrome chamfer, navy band, teal line, navy plate ----------
  const aurora = p3({
    id: 'f-3d-aurora',
    name: 'オーロラ Aurora Teal → Violet',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      face: {
        ...material3D('custom'),
        color: '#30c0d0',
        gradient: g([0, '#e0fff8'], [0.15, '#30f0d0'], [0.35, '#0aa8c8'], [0.47, '#0a2a70'], [0.53, '#200850'], [0.65, '#7030e0'], [0.85, '#c060ff'], [1, '#f8d8ff']),
        gradientAngle: 100,
        gradientBend: 0.5,
        metalness: 1,
        roughness: 0.12,
        clearcoat: 0.6,
        reflectivity: 0.85,
        iridescence: 0.3,
      },
      ...letter3D({
        depth: 10,
        // the chrome chamfer is not the face's material: the letter has no bevel and every ring is a band
        bevel: bevel3D(0, 0),
        rings: [ring(1.1, 1.1, m3('chrome', { reflectivity: 0.9 }), 'chamfer'), ring(0.3, 0.6, darkMetal('#040a24'), 'step')],
        side: darkMetal('#08102a', 0.3),
        plates: [
          plate(2.4, 'blueMetal', { depth: 6, bevel: bevel3D(1.3, 1.3, 'round') }, { color: '#0a1440', gradient: g([0, '#2a4a9a'], [0.45, '#0a1440'], [0.55, '#02040e'], [1, '#22408a']) }),
          plate(0.7, 'custom', { depth: 4, bevel: bevel3D(0.6, 0.6, 'round') }, { color: '#20f0d0', metalness: 0.5, roughness: 0.15, clearcoat: 1, emissive: '#10c0b0', emissiveIntensity: 1 }),
          blackPlate(1.8, { depth: 6 }, { color: '#02030c' }),
        ],
      }),
      shadow: shadow3D(),
      glint: starGlint({ intensity: 0.5, threshold: 1.6, tint: '#e8fff8' }),
    },
    effects: [
      ...edge3D('#40e0d0', '#02030c'),
      fx('outerGlow', { fill: 'gradient', gradient: g([0, '#20f0c0'], [0.5, '#4080ff'], [1, '#a040ff']), size: 22, intensity: 1, spread: 0.1, opacity: 0.8, mode: 'behind' }),
      ...glow3D('#c0f0ff', 0.8),
    ],
    lighting: envLook('studio', -10),
  });

  // ---------- アメジスト: violet crystal over a lilac bed, silver round frame, lilac band, plum plate ----------
  const amethystSolids = letter3D({
    depth: 9,
    // the silver frame is not the crystal's material: the letter has no bevel and every ring is a band
    bevel: bevel3D(0, 0),
    rings: [ring(0.25, 0.4, darkMetal('#14041e'), 'step'), ring(1.3, 1.3, m3('silver', { reflectivity: 0.9 }), 'round'), ring(0.3, 0.6, darkMetal('#14041e'), 'step')],
    side: darkMetal('#1a0a26', 0.3),
    plates: [
      plate(2.2, 'purpleMetal', { depth: 6, bevel: bevel3D(1.2, 1.2, 'round') }, { color: '#c8a8f0', gradient: g([0, '#f4e8ff'], [0.4, '#c0a0f0'], [0.55, '#4a2a70'], [1, '#e0d0ff']), metalness: 0.6 }),
      blackPlate(2, { depth: 6 }, { color: '#0c0214' }),
    ],
  });
  const amethyst = p3({
    id: 'f-3d-amethyst',
    name: 'アメジスト Amethyst Crystal + Silver',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      // small crumple facets: a cluster of crystal points, each refracting the lilac bed its own way
      face: m3('sapphire', { color: '#a040ff', dispersion: 0.5, surface: { kind: 'crumple', amount: 0.3, scale: 18, seed: 11 } }),
      ...amethystSolids,
      bands: [
        bed(amethystSolids.depth, m3('purpleMetal', { gradient: g([0, '#f8e8ff'], [0.3, '#d090ff'], [0.46, '#9030f0'], [0.52, '#3a0870'], [0.6, '#8028e0'], [0.85, '#d8a0ff'], [1, '#fff0ff']) })),
        ...amethystSolids.bands,
      ],
      shadow: shadow3D(),
      glint: starGlint({ intensity: 0.5, threshold: 1.7, tint: '#f8f0ff', streaks: 6 }),
    },
    effects: [...edge3D('#b060ff', '#0a0210'), ...glow3D('#e0c0ff')],
    lighting: envLook('studio', 40),
  });

  // ---------- 翡翠: carved jade stone, gold round rim, pale celadon band, black lacquer plate ----------
  const jade = p3({
    id: 'f-3d-jade',
    name: '翡翠 Jade Stone + Gold Rim',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      face: {
        ...material3D('custom'),
        color: '#3aa070',
        gradient: g([0, '#b8f8d8'], [0.2, '#30c07c'], [0.45, '#0a7442'], [0.55, '#023a1a'], [0.7, '#0a7c4a'], [0.9, '#40cc8c'], [1, '#b8f8dc']),
        gradientBend: 0.6,
        metalness: 0,
        // polished stone: a soft body sheen under a crisp coat highlight
        roughness: 0.25,
        clearcoat: 1,
        reflectivity: 0.5,
        // a faint green glow from inside the stone: the turned-away sides stay jade, never grey
        emissive: '#0a6a3a',
        emissiveIntensity: 0.3,
        // 七宝 carving: a low relief that only the light picks out
        pattern: pattern({ kind: 'shippo', color: '#a0f0c0', opacity: 0.12, scale: 8, shade: 1, relief: 0.5 }),
      },
      ...letter3D({
        depth: 10,
        bevel: letterBevel('round', 1.3),
        rings: [ring(1.3, 1.2, m3('gold', { reflectivity: 0.9 }), 'round'), ring(0.3, 0.6, darkMetal('#1a0c00'), 'step')],
        side: darkMetal('#0a1a0e', 0.3),
        plates: [
          plate(2.2, 'whiteGloss', { depth: 6, bevel: bevel3D(1.2, 1.2, 'round') }, { color: '#d8f0dc' }),
          blackPlate(2, { depth: 6, bevel: bevel3D(0.8, 0.8) }, { color: '#010402' }),
        ],
      }),
      shadow: shadow3D(),
      glint: starGlint({ intensity: 0.4, threshold: 2.4, tint: '#fff8e0' }),
    },
    effects: [...edge3D('#40d080', '#010402'), ...glow3D('#c8ffd8', 0.7)],
    lighting: envLook('softbox', 20),
  });

  return [sapphire, shu, obsidian, roseChoc, carbon, aurora, amethyst, jade];
}
