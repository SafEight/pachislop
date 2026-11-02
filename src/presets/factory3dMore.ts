import { band3D, bevel3D, glint3D, material3D, shadow3D, uid } from '../model/defaults';
import type { Band3D, Material3D } from '../model/types';
import {
  blackPlate,
  darkMetal,
  edge3D,
  envLook,
  fx,
  g,
  glow3D,
  letter3D,
  letterBevel,
  m3,
  p3,
  plate,
  ring,
  starGlint,
  THREE_D,
} from './factory';
import type { StylePreset } from './types';

// More 3D looks for the Library's 3D group: one letter solid with 2–4 contrasting bands stacked
// behind it (factory.ts `letter3D`: edge rings seated behind the letter's bevel, then plates).
// factory.ts imports this module while it assembles FACTORY_STYLES, so everything is built
// inside `more3DLooks` (called then), never at module load.

/** The extra 3D looks, in Library order. */
export function more3DLooks(): StylePreset[] {
  /** Metal with a horizon-banded ramp (bright top, dark horizon, bright bottom) in one hue. */
  const bandedMetal = (stops: [number, string][], o: Partial<Material3D> = {}): Material3D => ({
    ...material3D('custom'),
    color: stops[Math.floor(stops.length / 2)][1],
    gradient: g(...stops),
    metalness: 1,
    roughness: 0.12,
    clearcoat: 0.6,
    reflectivity: 0.85,
    ...o,
  });

  /** A self-lit neon tube band: the tube glows `color` and its gloss still catches the lights. */
  const neonTube = (grow: number, color: string, intensity = 2.6): Band3D => ({
    ...band3D(grow, 'custom'),
    join: 'round',
    depth: 1,
    bevel: { ...bevel3D(grow, grow / 2, 'tube'), segments: 12 },
    material: { ...material3D('custom'), color, metalness: 0, roughness: 0.2, clearcoat: 1, emissive: color, emissiveIntensity: intensity },
  });

  /** A wide soft halo behind the title (neon spill). */
  const halo = (color: string, size = 34, opacity = 0.8) => fx('outerGlow', { color, size, intensity: 1, spread: 0.05, opacity, mode: 'behind' });

  // ---------- クローム + 青 stack: chrome letter, navy step, blue metal band, white line, navy plate ----------
  const chromeBlue = p3({
    id: 'f-3d-chrome-blue',
    name: 'クローム Chrome + Blue Stack',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      face: m3('chrome', { reflectivity: 0.9 }),
      ...letter3D({
        depth: 10,
        bevel: letterBevel('chamfer', 1.4),
        rings: [ring(0.3, 0.6, darkMetal('#0a1230'), 'step')],
        side: darkMetal('#101830', 0.25),
        plates: [
          plate(3, 'blueMetal', { depth: 6, bevel: bevel3D(1.6, 1.6, 'chamfer') }, { reflectivity: 0.9 }),
          plate(1, 'whiteGloss', { depth: 5, bevel: bevel3D(0.6, 0.6) }),
          plate(2.4, 'blueMetal', { depth: 7, bevel: bevel3D(1.1, 1.1) }, { color: '#0a1c5a', gradient: g([0, '#3060c0'], [0.45, '#0a1c5a'], [0.55, '#020818'], [1, '#2050b0']) }),
          blackPlate(1.2, { depth: 5, bevel: bevel3D(0.6, 0.6) }, { color: '#02040c' }),
        ],
      }),
      shadow: shadow3D(),
      glint: starGlint({ intensity: 0.5, threshold: 1.5, tint: '#eaf4ff' }),
    },
    effects: [...edge3D('#2a7aff', '#02040c'), ...glow3D('#a8d0ff')],
    lighting: envLook('studio', 0),
  });

  // ---------- 漆黒 + 金: black lacquer letter with a round lacquer bevel, gold tube, gold line on black plates ----------
  const lacquerGold = p3({
    id: 'f-3d-lacquer-gold',
    name: '漆黒金 Black Lacquer + Gold',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      face: m3('blackGloss', {
        // the lacquer's sheen: a soft grey sweep and a hard diagonal streak across the black
        gradient: g([0, '#6a6660'], [0.22, '#1a1816'], [0.4, '#000000'], [0.48, '#5a5654'], [0.53, '#0a0a0a'], [0.75, '#000000'], [1, '#26221e']),
        gradientAngle: 70,
        roughness: 0.04,
        reflectivity: 0.8,
        specBoost: 2,
      }),
      ...letter3D({
        depth: 10,
        bevel: letterBevel('round', 1),
        rings: [ring(2, 1.6, m3('punchyGold'), 'round'), ring(0.3, 0.6, darkMetal('#2a1000'), 'step')],
        side: darkMetal('#2a1400', 0.3),
        plates: [
          blackPlate(2.4, { depth: 7 }, { color: '#0a0806' }),
          // the classic banded gold line (punchyGold's banding at plain gold's gloss), kept as designed
          plate(1.4, 'punchyGold', { depth: 5, bevel: bevel3D(1.2, 1.2, 'round') }, { reflectivity: 0.9, roughness: 0.08, specBoost: 1 }),
          blackPlate(1.4, { depth: 5, bevel: bevel3D(0.6, 0.6) }),
        ],
      }),
      shadow: shadow3D(),
      // no glint: the gold's highlights would streak orange across the lacquer
      glint: glint3D(),
    },
    // no highlight glow: its haze would grey the black lacquer
    effects: edge3D('#ffb020'),
    lighting: envLook('studio', 0),
  });

  // ---------- エメラルド: green metal, gold step, deep green band, black plate ----------
  const emerald = p3({
    id: 'f-3d-emerald',
    name: 'エメラルド Emerald Metal',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      face: bandedMetal([
        [0, '#d8ffe0'],
        [0.2, '#4cf07a'],
        [0.44, '#0aa046'],
        [0.52, '#02381a'],
        [0.6, '#08903e'],
        [0.82, '#3ce870'],
        [1, '#b8ffcc'],
      ]),
      ...letter3D({
        depth: 10,
        bevel: letterBevel('chamfer', 1.3),
        rings: [ring(1, 0.9, m3('gold', { reflectivity: 0.9 }), 'round'), ring(0.3, 0.6, darkMetal('#02200c'), 'step')],
        side: darkMetal('#04300f', 0.3),
        plates: [
          plate(2.2, 'greenMetal', { depth: 6, bevel: bevel3D(1.2, 1.2, 'chamfer') }, { color: '#0a5a24', gradient: g([0, '#2ad060'], [0.45, '#06602a'], [0.55, '#01200a'], [1, '#1ab050']) }),
          blackPlate(2.4, { depth: 7 }, { color: '#010a04' }),
        ],
      }),
      shadow: shadow3D(),
      // no glint: the gold ring's highlights would streak orange across the green
      glint: glint3D(),
    },
    effects: [...edge3D('#20e060', '#010804'), ...glow3D('#a0ffb8')],
    lighting: envLook('studio', 40),
  });

  // ---------- バイオレット ネオン: violet chrome, pink neon tube, black band, violet plate ----------
  const violetNeon = p3({
    id: 'f-3d-violet-neon',
    name: 'ネオン紫 Violet Neon Edge',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      face: bandedMetal(
        [
          [0, '#f4e0ff'],
          [0.2, '#c070ff'],
          [0.44, '#7a18d8'],
          [0.52, '#24043e'],
          [0.6, '#6a14c0'],
          [0.82, '#b25cff'],
          [1, '#ecd0ff'],
        ],
        { reflectivity: 0.9 },
      ),
      ...letter3D({
        depth: 9,
        bevel: letterBevel('chamfer', 1.2),
        rings: [ring(0.3, 0.6, darkMetal('#12001e'), 'step')],
        side: darkMetal('#1a0028', 0.3),
        plates: [
          neonTube(1.8, '#ff3cf0', 4),
          blackPlate(2, { depth: 6 }, { color: '#08000e' }),
          plate(1.4, 'purpleMetal', { depth: 5, bevel: bevel3D(1, 1, 'round') }),
          blackPlate(1, { depth: 4, bevel: bevel3D(0.5, 0.5) }),
        ],
      }),
      shadow: shadow3D(),
      glint: starGlint({ intensity: 0.7, threshold: 1.3, tint: '#ffe0ff' }),
    },
    effects: [...edge3D('#d040ff', '#06000a'), halo('#a020ff'), ...glow3D('#ff70f0')],
    lighting: envLook('studio', -40),
  });

  // ---------- パール: iridescent pearl white, pink metal rim, plum step, pale-pink and magenta plates ----------
  const pearlPink = p3({
    id: 'f-3d-pearl-pink',
    name: 'パール Pearl + Pink Rim',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      face: {
        ...material3D('custom'),
        color: '#fff0f6',
        // pastel nacre: pink, lilac and mint sheens that slide with the surface
        gradient: g([0, '#ffffff'], [0.2, '#ffe4f0'], [0.4, '#ecdcff'], [0.5, '#c8b4d8'], [0.58, '#e0f4f0'], [0.78, '#ffe0ec'], [1, '#fff6fa']),
        gradientBend: 0.6,
        metalness: 0.6,
        roughness: 0.15,
        clearcoat: 1,
        iridescence: 1,
        reflectivity: 0.8,
      },
      ...letter3D({
        depth: 10,
        bevel: letterBevel('round', 1.3),
        rings: [ring(0.9, 0.9, bandedMetal([[0, '#ffd8ec'], [0.3, '#ff6ab4'], [0.5, '#a0105a'], [0.7, '#ff58a8'], [1, '#ffc8e2']]), 'round'), ring(0.3, 0.5, darkMetal('#3a0620'), 'step')],
        side: darkMetal('#3a0a24', 0.3),
        plates: [
          plate(2.2, 'whiteGloss', { depth: 6, bevel: bevel3D(1.2, 1.2) }, { color: '#ffd2e6' }),
          plate(2, 'roseGold', { depth: 6, bevel: bevel3D(1, 1, 'chamfer') }, { color: '#c02870', gradient: g([0, '#ff7ab8'], [0.45, '#b01868'], [0.55, '#40001e'], [1, '#e04a94']) }),
          blackPlate(1.2, { depth: 4, bevel: bevel3D(0.5, 0.5) }, { color: '#14000a' }),
        ],
      }),
      shadow: shadow3D(),
      glint: starGlint({ intensity: 0.6, threshold: 1.4, tint: '#fff0f8' }),
    },
    effects: [...edge3D('#ff5aa8', '#1a0010'), ...glow3D('#ffd0e8')],
    lighting: envLook('studio', 0),
  });

  // ---------- 氷結: ice crystal glass over a pale-blue bed, silver chamfer, cyan band, navy plate ----------
  const iceSolids = letter3D({
    depth: 9,
    // the silver chamfer is not the glass's material: the letter has no bevel and every ring is a band
    bevel: bevel3D(0, 0),
    rings: [ring(0.25, 0.4, darkMetal('#06183a'), 'step'), ring(1.3, 1.3, m3('silver', { reflectivity: 0.9 }), 'chamfer'), ring(0.3, 0.6, darkMetal('#06183a'), 'step')],
    side: darkMetal('#0a2040', 0.25),
    plates: [
      plate(1.2, 'blueMetal', { depth: 3 }, { color: '#9ad8ff', gradient: g([0, '#e8f8ff'], [0.5, '#6ac0ff'], [1, '#d0f0ff']) }),
      plate(2, 'blueMetal', { depth: 6, bevel: bevel3D(1.2, 1.2, 'chamfer') }, { color: '#20a0ff', gradient: g([0, '#a0e8ff'], [0.45, '#1890ff'], [0.55, '#04205a'], [1, '#40c0ff']) }),
      blackPlate(2, { depth: 6 }, { color: '#020814' }),
    ],
  });
  const ice = p3({
    id: 'f-3d-ice-crystal',
    name: '氷結 Ice Crystal Glass',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      // big flakes read as frozen crystals catching the light
      face: m3('diamond', { color: '#dff4ff', ior: 1.9, dispersion: 0.5, flakes: 0.15, flakeScale: 3 }),
      ...iceSolids,
      // a horizon-banded pale-blue bed flush behind the face: the glass shows it instead of the dark step
      bands: [
        {
          ...band3D(0, 'silver'),
          depth: 1,
          offset: -iceSolids.depth,
          bevel: bevel3D(0, 0),
          material: m3('silver', { color: '#bfe6ff', gradient: g([0, '#ffffff'], [0.3, '#c8eeff'], [0.46, '#40a8ff'], [0.52, '#0a3a8a'], [0.6, '#3aa0f0'], [0.85, '#d8f4ff'], [1, '#ffffff']) }),
        },
        ...iceSolids.bands,
      ],
      shadow: shadow3D(),
      glint: starGlint({ intensity: 0.6, threshold: 1.4, tint: '#f0faff', length: 26 }),
    },
    effects: [...edge3D('#40c8ff', '#020814'), ...glow3D('#d0f4ff')],
    lighting: envLook('strips', -15),
  });

  // ---------- 炎: fire-ramp metal, gold step, dark band, red plate, black plate ----------
  const fire = p3({
    id: 'f-3d-fire',
    name: '炎 Fire Orange-Red',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      face: bandedMetal(
        [
          [0, '#fff8c0'],
          [0.16, '#ffd828'],
          [0.36, '#ff8a00'],
          [0.48, '#e03000'],
          [0.54, '#5a0400'],
          [0.62, '#c01400'],
          [0.82, '#ff4a08'],
          [1, '#ffb050'],
        ],
        { clearcoat: 1, roughness: 0.12, gradientBend: 0.4 },
      ),
      ...letter3D({
        depth: 11,
        bevel: letterBevel('chamfer', 1.3),
        rings: [ring(0.6, 0.6, m3('punchyGold'), 'step'), ring(0.3, 0.6, darkMetal('#2a0400'), 'step')],
        side: { ...material3D('custom'), color: '#c01000', gradient: g([0, '#ff4a00'], [0.4, '#a00800'], [1, '#100000']), gradientAxis: 'depth', metalness: 0.6, roughness: 0.3, reflectivity: 0.5, clearcoat: 0.4 },
        plates: [
          blackPlate(2.2, { depth: 7 }, { color: '#120200' }),
          plate(1.6, 'redMetal', { depth: 5, bevel: bevel3D(1.1, 1.1, 'chamfer') }),
          blackPlate(1.2, { depth: 4, bevel: bevel3D(0.5, 0.5) }),
        ],
      }),
      shadow: shadow3D(),
      glint: starGlint({ intensity: 0.45, threshold: 1.5, tint: '#fff0c0' }),
    },
    effects: [...edge3D('#ff3a00'), halo('#ff4a00', 30, 0.7), ...glow3D('#ffa020')],
    // the softbox keeps the yellow top saturated (the studio's dark floor turns it olive)
    lighting: envLook('softbox', 25),
  });

  // ---------- ホログラム: iridescent pastel silver, chrome chamfer, lavender band, black plate ----------
  const holo = p3({
    id: 'f-3d-holo-silver',
    name: 'ホロ Holographic Silver',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      face: {
        ...material3D('custom'),
        color: '#f0f0ff',
        gradient: g([0, '#ffd6f4'], [0.2, '#d8e0ff'], [0.38, '#b8fff0'], [0.55, '#fff4c0'], [0.72, '#ffc8e8'], [0.88, '#c0d8ff'], [1, '#e8ffff']),
        gradientAngle: 60,
        gradientBend: 0.8,
        metalness: 1,
        roughness: 0.08,
        reflectivity: 0.9,
        iridescence: 1,
        // fine glitter, not a field of sparks: each flake turned into the light would read as a star
        flakes: 0.2,
        flakeScale: 0.5,
      },
      ...letter3D({
        depth: 10,
        bevel: bevel3D(0, 0),
        rings: [ring(1.4, 1.4, m3('chrome', { reflectivity: 0.9, iridescence: 0.6 }), 'chamfer'), ring(0.3, 0.6, darkMetal('#1a1430'), 'step')],
        side: darkMetal('#1e1a30', 0.25),
        plates: [
          plate(2, 'purpleMetal', { depth: 6, bevel: bevel3D(1.2, 1.2, 'round') }, { color: '#b8a0ff', gradient: g([0, '#f0e0ff'], [0.4, '#a888ff'], [0.55, '#3a2a80'], [1, '#d0c0ff']), iridescence: 0.8 }),
          blackPlate(2.4, { depth: 7 }, { color: '#08061a' }),
        ],
      }),
      shadow: shadow3D(),
      // a handful of crisp 6-ray stars on the hottest chrome points, not every lit flake or face
      glint: starGlint({ intensity: 0.6, threshold: 2, tint: '#ffffff', streaks: 6 }),
    },
    effects: [
      ...edge3D('#b080ff', '#06041a'),
      fx('outerGlow', { fill: 'gradient', gradient: g([0, '#ff70e0'], [0.5, '#8090ff'], [1, '#40f0ff']), size: 18, intensity: 1, spread: 0.15, opacity: 0.8, mode: 'behind' }),
      ...glow3D('#e8e0ff'),
    ],
    lighting: envLook('studio', 60),
  });

  // ---------- 銅: polished rose copper, hot copper chamfer, teal (verdigris) band, copper line, black plate ----------
  const copperFace: Material3D = {
    ...material3D('custom'),
    color: '#e08a68',
    gradient: g([0, '#fff2ea'], [0.16, '#ffc0a4'], [0.36, '#d8724e'], [0.47, '#7a2c18'], [0.53, '#2e0c04'], [0.62, '#a84c30'], [0.82, '#f49c7c'], [1, '#ffdccc']),
    gradientBend: 0.3,
    metalness: 1,
    roughness: 0.06,
    clearcoat: 0.3,
    reflectivity: 0.9,
  };
  // paler and hotter than the face, so every edge flares
  const copperEdge: Material3D = {
    ...copperFace,
    gradient: g([0, '#ffffff'], [0.3, '#ffd0bc'], [0.5, '#b05a3c'], [0.7, '#ffc0a8'], [1, '#fff4ee']),
    roughness: 0.03,
    reflectivity: 1.2,
    specBoost: 2,
  };
  const copper = p3({
    id: 'f-3d-copper-bronze',
    name: '銅 Rose Copper + Teal',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      face: copperFace,
      // the hot chamfer is not the face's material: it is a band, the letter has no bevel
      ...letter3D({
        depth: 10,
        bevel: bevel3D(0, 0),
        rings: [ring(1.3, 1.3, copperEdge, 'chamfer'), ring(0.3, 0.6, darkMetal('#1a0804'), 'step')],
        side: darkMetal('#2a1006', 0.3),
        plates: [
          plate(
            2.8,
            'blueMetal',
            { depth: 6, bevel: bevel3D(1.6, 1.6, 'chamfer') },
            { color: '#0a6a68', gradient: g([0, '#7af0e0'], [0.3, '#18a8a0'], [0.47, '#04403e'], [0.53, '#011614'], [0.65, '#0c7a74'], [1, '#60e0d0']) },
          ),
          plate(0.8, 'custom', { depth: 4, bevel: bevel3D(0.6, 0.6, 'round') }, copperEdge),
          blackPlate(1.6, { depth: 5 }, { color: '#040202' }),
        ],
      }),
      shadow: shadow3D(),
      glint: starGlint({ intensity: 0.4, threshold: 2.2, tint: '#fff0e8' }),
    },
    effects: [...edge3D('#30e0d0', '#040202'), ...glow3D('#ffd0bc', 1)],
    lighting: envLook('studio', 20),
  });

  // ---------- ツートン: gold / silver split face, white line, red / blue split band, black plate ----------
  const twoTone = p3({
    id: 'f-3d-two-tone',
    name: 'ツートン Two-tone Split',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      face: bandedMetal(
        [
          [0, '#fff8d0'],
          [0.25, '#ffd040'],
          [0.499, '#a86400'],
          [0.5, '#e8ecf4'],
          [0.75, '#8a94a8'],
          [1, '#ffffff'],
        ],
        { reflectivity: 0.9 },
      ),
      ...letter3D({
        depth: 10,
        bevel: letterBevel('chamfer', 1.2),
        rings: [ring(0.3, 0.6, darkMetal('#141018'), 'step')],
        side: darkMetal('#1a1418', 0.3),
        plates: [
          plate(1, 'whiteGloss', { depth: 5, bevel: bevel3D(0.7, 0.7) }),
          plate(
            2.4,
            'redMetal',
            { depth: 6, bevel: bevel3D(1.3, 1.3, 'chamfer') },
            { gradient: g([0, '#ff5050'], [0.3, '#d00010'], [0.499, '#600006'], [0.5, '#1050ff'], [0.7, '#0830b0'], [1, '#4a90ff']) },
          ),
          blackPlate(1.6, { depth: 5 }, { color: '#060408' }),
        ],
      }),
      shadow: shadow3D(),
      glint: starGlint({ intensity: 0.6, threshold: 1.4 }),
    },
    effects: [
      ...edge3D('#ff4040', '#060408'),
      fx('outerGlow', { fill: 'gradient', gradient: g([0, '#ff3020'], [0.49, '#ff3020'], [0.51, '#2a70ff'], [1, '#2a70ff']), size: 16, intensity: 1, spread: 0.2, opacity: 0.85, mode: 'behind' }),
      ...glow3D('#fff0d0'),
    ],
    lighting: envLook('studio', 20),
  });

  // ---------- 発光: matte black letter lit cyan from the sides, cyan neon rim, dark band, blue line ----------
  const matteGlow = p3({
    id: 'f-3d-matte-glow',
    name: '発光 Matte Black + Glowing Rim',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      face: {
        ...material3D('custom'),
        color: '#1c2028',
        gradient: g([0, '#3a4250'], [0.45, '#1a1e26'], [0.55, '#0c0e12'], [1, '#242a34']),
        metalness: 0.6,
        roughness: 0.42,
        reflectivity: 0.8,
      },
      ...letter3D({
        depth: 10,
        bevel: letterBevel('chamfer', 1.4),
        rings: [ring(0.3, 0.5, darkMetal('#000000', 0.5), 'step')],
        side: darkMetal('#0a0c10', 0.5),
        plates: [
          neonTube(1.3, '#10e8ff', 4.5),
          plate(2.2, 'custom', { depth: 6, bevel: bevel3D(0.9, 0.9, 'chamfer') }, { color: '#101418', metalness: 0.4, roughness: 0.5, reflectivity: 0.6 }),
          neonTube(0.7, '#10a0ff', 2),
          blackPlate(1, { depth: 4, bevel: bevel3D(0.5, 0.5) }),
        ],
      }),
      shadow: shadow3D(),
      glint: starGlint({ intensity: 0.25, threshold: 2.2, tint: '#e0ffff' }),
    },
    // no highlight glow: its haze would grey the matte face
    effects: [...edge3D('#00e0ff', '#000000'), halo('#00b0ff', 36, 0.85)],
    lighting: {
      ...envLook('night', 0),
      // cyan and blue key lights raking from the sides: the chamfers flare in the rim's colour
      lights: [
        { id: uid(), type: 'directional', color: '#40e8ff', intensity: 4, x: -900, y: 500, z: 150 },
        { id: uid(), type: 'directional', color: '#3070ff', intensity: 3, x: 900, y: -500, z: 150 },
        { id: uid(), type: 'directional', color: '#ffffff', intensity: 1.6, x: 0, y: 400, z: 1200 },
      ],
    },
  });

  return [chromeBlue, lacquerGold, emerald, violetNeon, pearlPink, ice, fire, holo, copper, twoTone, matteGlow];
}
