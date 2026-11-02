import { band3D, bevel3D, glint3D, material3D, pattern, shadow3D, uid } from '../model/defaults';
import type { Band3D, Material3D } from '../model/types';
import { blackPlate, darkMetal, edge3D, envLook, fx, g, glow3D, letter3D, letterBevel, m3, p3, plate, ring, starGlint, THREE_D } from './factory';
import type { StylePreset } from './types';

// A second set of 3D looks for the Library's 3D group, each a material family the others lack
// (neon glass, porcelain, titanium, galaxy, lava, 金銀, acid, sakura). Same structure as
// factory3dMore.ts: one letter solid, edge rings seated behind its bevel, then plates. factory.ts
// imports this module while it assembles FACTORY_STYLES, so everything is built inside
// `setB3DLooks` (called then), never at module load.

/** The Set B 3D looks, in Library order. */
export function setB3DLooks(): StylePreset[] {
  /** Metal with a horizon-banded ramp (bright top, dark horizon, bright bottom). */
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

  /** A self-lit neon tube band. */
  const neonTube = (grow: number, color: string, intensity = 2.6): Band3D => ({
    ...band3D(grow, 'custom'),
    join: 'round',
    depth: 1,
    bevel: { ...bevel3D(grow, grow / 2, 'tube'), segments: 12 },
    material: { ...material3D('custom'), color, metalness: 0, roughness: 0.2, clearcoat: 1, emissive: color, emissiveIntensity: intensity },
  });

  /** A wide soft halo behind the title. */
  const halo = (color: string, size = 34, opacity = 0.8) => fx('outerGlow', { color, size, intensity: 1, spread: 0.05, opacity, mode: 'behind' });

  // ---------- ネオン管: white-hot pink tube letters (inward round bevel, depth-ramped emission), cyan tube outline ----------
  const neonGlass = p3({
    id: 'f-3d-neon-glass',
    name: 'ネオン管 Neon Glass Tube',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      // The bevel is cut inward and rounds the stroke edge; the depth ramp keeps the face
      // white-hot and turns the bevel pink, then dark glass toward the back.
      bevelPosition: 'inside',
      face: {
        ...material3D('custom'),
        color: '#ff3cc8',
        gradient: g([0, '#fff0fa'], [0.03, '#ff40c8'], [0.08, '#3a0830'], [0.16, '#0a0610'], [1, '#04030a']),
        gradientAxis: 'depth',
        metalness: 0,
        roughness: 0.04,
        clearcoat: 1,
        reflectivity: 1.2,
        specBoost: 1.5,
        emissive: '#ffffff',
        emissiveIntensity: 2.5,
      },
      ...letter3D({
        depth: 8,
        bevel: { ...bevel3D(2.6, 2.4, 'round'), segments: 10 },
        rings: [ring(0.3, 0.5, darkMetal('#06040c', 0.3), 'step')],
        side: darkMetal('#08060e', 0.3),
        plates: [neonTube(1.1, '#20e0ff', 3.5), blackPlate(2.2, { depth: 6 }, { color: '#04030a' }), plate(0.8, 'chrome', { depth: 4, bevel: bevel3D(0.5, 0.5) }, { color: '#606878' })],
      }),
      shadow: shadow3D(),
      // no glint: star streaks across the glowing tubes read as clutter
      glint: glint3D(),
    },
    effects: [...edge3D('#ff40c8', '#000000'), halo('#ff20b0', 30, 0.75), ...glow3D('#ff60d0', 1)],
    lighting: {
      ...envLook('night', 0),
      lights: [
        { id: uid(), type: 'directional', color: '#ffffff', intensity: 2, x: -600, y: 800, z: 1000 },
        { id: uid(), type: 'directional', color: '#60e0ff', intensity: 1.5, x: 900, y: -300, z: 300 },
      ],
    },
  });

  // ---------- 染付: white porcelain, cobalt glaze tube, white line, cobalt seigaiha plate, navy plate ----------
  const cobalt = (o: Partial<Material3D> = {}): Material3D => ({
    ...material3D('custom'),
    color: '#0a1e90',
    gradient: g([0, '#3058f0'], [0.4, '#0a1e90'], [0.55, '#010630'], [1, '#1a40c8']),
    metalness: 0,
    roughness: 0.1,
    clearcoat: 1,
    reflectivity: 0.6,
    ...o,
  });
  const porcelain = p3({
    id: 'f-3d-sometsuke',
    name: '染付 Porcelain + Cobalt',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      // glazed white body: soft sheen, the lower strokes falling into a cool blue-grey shade
      face: {
        ...material3D('custom'),
        color: '#f4f6fa',
        gradient: g([0, '#ffffff'], [0.55, '#eef2f8'], [0.85, '#c4cee0'], [1, '#98a6c0']),
        gradientBend: 0.6,
        metalness: 0,
        roughness: 0.2,
        clearcoat: 1,
        reflectivity: 0.5,
      },
      ...letter3D({
        depth: 10,
        bevel: letterBevel('round', 1.2),
        rings: [ring(0.3, 0.5, darkMetal('#06104a'), 'step')],
        side: cobalt({ gradient: g([0, '#2048d0'], [1, '#020830']), gradientAxis: 'depth' }),
        plates: [
          plate(2.2, 'custom', { depth: 6, bevel: bevel3D(0.8, 0.8, 'round') }, cobalt()),
          plate(0.6, 'whiteGloss', { depth: 5, bevel: bevel3D(0.5, 0.5) }, { color: '#f0f4ff' }),
          // 青海波 waves painted in white on the cobalt
          plate(2.4, 'custom', { depth: 6, bevel: bevel3D(1, 1, 'chamfer') }, cobalt({ pattern: pattern({ kind: 'seigaiha', color: '#e8f0ff', opacity: 0.7, scale: 5, shade: 0.7 }) })),
          blackPlate(1.2, { depth: 4, bevel: bevel3D(0.5, 0.5) }, { color: '#020618' }),
        ],
      }),
      shadow: shadow3D(),
      glint: starGlint({ intensity: 0.35, threshold: 2.2, tint: '#f0f6ff', length: 20 }),
    },
    // no highlight glow: its haze would grey the white glaze
    effects: edge3D('#2a5aff', '#020618'),
    lighting: envLook('softbox', 30),
  });

  // ---------- チタン: brushed blue anodised steel, satin titanium chamfer, gunmetal band, blue line ----------
  const titanium = (o: Partial<Material3D> = {}): Material3D => ({
    ...material3D('custom'),
    color: '#9aa0aa',
    gradient: g([0, '#e8ecf2'], [0.4, '#8a909c'], [0.52, '#3a3e48'], [0.62, '#7a808c'], [1, '#d8dce4']),
    metalness: 1,
    roughness: 0.26,
    reflectivity: 0.9,
    ...o,
  });
  const brushed = pattern({ kind: 'stripes', color: '#ffffff', opacity: 0.12, scale: 0.8, angle: 0, shade: 0.9, relief: 0.4 });
  const blueTitanium = p3({
    id: 'f-3d-titanium',
    name: 'チタン Blue Anodised Titanium',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      face: bandedMetal(
        [
          [0, '#b8d8ff'],
          [0.22, '#3a8aff'],
          [0.45, '#0c3aa8'],
          [0.53, '#020c38'],
          [0.62, '#0a40b8'],
          [0.84, '#2a7cff'],
          [1, '#a0ccff'],
        ],
        { roughness: 0.22, clearcoat: 0, pattern: brushed },
      ),
      ...letter3D({
        depth: 10,
        bevel: letterBevel('chamfer', 1.2),
        rings: [ring(1.2, 1.2, titanium(), 'chamfer'), ring(0.3, 0.6, darkMetal('#0a0e16'), 'step')],
        side: darkMetal('#141820', 0.3),
        plates: [
          plate(2.2, 'custom', { depth: 6, bevel: bevel3D(1.4, 1.4, 'chamfer') }, titanium({ color: '#3a3e46', gradient: g([0, '#8a909a'], [0.45, '#2a2e36'], [0.55, '#0a0c10'], [1, '#6a707a']), pattern: brushed })),
          plate(0.7, 'blueMetal', { depth: 4, bevel: bevel3D(0.6, 0.6) }),
          blackPlate(1.2, { depth: 4, bevel: bevel3D(0.5, 0.5) }, { color: '#04060a' }),
        ],
      }),
      shadow: shadow3D(),
      glint: starGlint({ intensity: 0.35, threshold: 2, tint: '#e0eeff', streaks: 2, angle: 0, length: 24 }),
    },
    effects: [...edge3D('#2a7aff', '#04060a'), ...glow3D('#b0d4ff', 1)],
    lighting: envLook('strips', 0),
  });

  // ---------- 銀河: navy-violet nebula face with star flakes, chrome rim, navy band, black plate ----------
  const galaxy = p3({
    id: 'f-3d-galaxy',
    name: '銀河 Galaxy Starfield',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      // metal flakes under the night environment's few point lights: sparse star sparkle on deep navy
      face: {
        ...material3D('custom'),
        color: '#141a70',
        gradient: g([0, '#4a2ab0'], [0.25, '#141a70'], [0.42, '#6a1a9a'], [0.56, '#08082a'], [0.75, '#1a40a0'], [1, '#7a2ab0']),
        gradientAngle: 120,
        gradientBend: 0.4,
        metalness: 1,
        roughness: 0.2,
        clearcoat: 1,
        reflectivity: 1,
        flakes: 1,
        flakeScale: 0.6,
      },
      ...letter3D({
        depth: 10,
        bevel: bevel3D(0, 0),
        // the silver rim mirrors the studio (the night environment would dull it)
        rings: [ring(1.3, 1.3, m3('chrome', { reflectivity: 0.9, environment: { preset: 'studio' } }), 'chamfer'), ring(0.3, 0.6, darkMetal('#04061a'), 'step')],
        side: darkMetal('#0a0c22', 0.3),
        plates: [
          plate(2.2, 'blueMetal', { depth: 6, bevel: bevel3D(1.2, 1.2, 'round') }, { color: '#16206a', gradient: g([0, '#4a5ac0'], [0.45, '#141c60'], [0.55, '#04061e'], [1, '#3a48a8']) }),
          plate(0.7, 'silver', { depth: 4, bevel: bevel3D(0.6, 0.6) }, { environment: { preset: 'studio' } }),
          blackPlate(1.2, { depth: 4, bevel: bevel3D(0.5, 0.5) }, { color: '#02020a' }),
        ],
      }),
      shadow: shadow3D(),
      glint: starGlint({ intensity: 0.35, threshold: 2.5, tint: '#e8eeff', length: 22 }),
    },
    effects: [...edge3D('#6a5aff', '#02020a'), ...glow3D('#c0c8ff', 1)],
    lighting: {
      ...envLook('night', 0),
      lights: [
        { id: uid(), type: 'directional', color: '#ffffff', intensity: 3, x: -600, y: 800, z: 1000 },
        { id: uid(), type: 'directional', color: '#a0b0ff', intensity: 2, x: 800, y: -400, z: 600 },
      ],
    },
  });

  // ---------- 溶岩: basalt crust plates (giraffe marks, lit, crumpled) split by magma cracks, ember tube, basalt plate ----------
  const basalt = { kind: 'crumple', amount: 0.5, scale: 3, seed: 5 } as const;
  const lava = p3({
    id: 'f-3d-lava',
    name: '溶岩 Lava Crust',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      // The magma is the base colour (white-hot top → red bottom) showing in the gaps between the
      // giraffe patches; the patches are lit crust with relief. Emission would glow through the
      // crust too, so the cracks are bright by colour and the halo / glow effects.
      face: {
        ...material3D('custom'),
        color: '#ff7a00',
        gradient: g([0, '#ffd040'], [0.45, '#ff7a00'], [1, '#e02000']),
        metalness: 0,
        roughness: 0.45,
        clearcoat: 0.2,
        surface: basalt,
        pattern: pattern({ kind: 'giraffe', color: '#2a2420', opacity: 1, scale: 5, shade: 1, relief: 1, seed: 3 }),
      },
      ...letter3D({
        depth: 10,
        bevel: letterBevel('round', 1),
        rings: [ring(0.3, 0.5, darkMetal('#000000', 0.6), 'step')],
        side: { ...material3D('custom'), color: '#200400', gradient: g([0, '#ff4a00'], [0.3, '#5a0800'], [1, '#080000']), gradientAxis: 'depth', metalness: 0, roughness: 0.6, emissive: '#ffffff', emissiveIntensity: 0.6 },
        plates: [
          neonTube(1.2, '#ff5a00', 3.5),
          plate(2.4, 'custom', { depth: 7, bevel: bevel3D(1.2, 1.2, 'chamfer') }, { color: '#1e1a18', metalness: 0.4, roughness: 0.5, surface: basalt }),
          blackPlate(1, { depth: 4, bevel: bevel3D(0.5, 0.5) }, { color: '#000000' }),
        ],
      }),
      shadow: shadow3D(),
      glint: glint3D(),
    },
    effects: [...edge3D('#ff4a00', '#000000'), halo('#ff3000', 30, 0.7), ...glow3D('#ff7a20', 1.2)],
    lighting: envLook('studio', 0),
  });

  // ---------- 金銀: silver letter, chrome chamfer, dark step, banded gold tube, gold plate, black plate ----------
  const richGold = (o: Partial<Material3D> = {}) =>
    bandedMetal(
      [
        [0, '#fff6c8'],
        [0.2, '#ffd23a'],
        [0.42, '#c07800'],
        [0.52, '#3a1800'],
        [0.6, '#a86200'],
        [0.82, '#ffc828'],
        [1, '#fff0b0'],
      ],
      o,
    );
  const kinGin = p3({
    id: 'f-3d-kin-gin',
    name: '金銀 Silver on Gold',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      face: bandedMetal(
        [
          [0, '#ffffff'],
          [0.22, '#dfe4ec'],
          [0.44, '#8a92a2'],
          [0.52, '#2a2e38'],
          [0.6, '#7a8292'],
          [0.82, '#d8dee8'],
          [1, '#ffffff'],
        ],
        { reflectivity: 0.85, roughness: 0.1 },
      ),
      ...letter3D({
        depth: 10,
        bevel: letterBevel('chamfer', 1.3),
        rings: [ring(0.3, 0.6, darkMetal('#14100a'), 'step')],
        side: darkMetal('#2a1800', 0.3),
        plates: [
          { ...plate(2.6, 'custom', { depth: 6, join: 'round', bevel: { ...bevel3D(2.6, 1.8, 'round'), segments: 10 } }), material: richGold({ reflectivity: 0.9 }) },
          blackPlate(0.8, { depth: 5, bevel: bevel3D(0.5, 0.5) }, { color: '#0a0600' }),
          { ...plate(2.2, 'custom', { depth: 6, bevel: bevel3D(1.4, 1.4, 'chamfer') }), material: richGold({ roughness: 0.16 }) },
          blackPlate(1.2, { depth: 4, bevel: bevel3D(0.5, 0.5) }, { color: '#060300' }),
        ],
      }),
      shadow: shadow3D(),
      glint: starGlint({ intensity: 0.35, threshold: 2.2, tint: '#fff8e8', length: 20 }),
    },
    effects: [...edge3D('#ffb020', '#060300'), ...glow3D('#fff0c8', 1)],
    lighting: envLook('studio', 20),
  });

  // ---------- 毒: acid-green glowing candy, black step, hazard-striped band, green line, black plate ----------
  const toxic = p3({
    id: 'f-3d-toxic',
    name: '毒 Toxic Acid Glow',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      face: {
        ...material3D('custom'),
        color: '#40d000',
        // acid-green candy metal banded to near black at the horizon, lit a little from within
        gradient: g([0, '#e0ff80'], [0.2, '#7aff10'], [0.42, '#1a8a00'], [0.52, '#021a00'], [0.62, '#20a000'], [0.85, '#8aff20'], [1, '#d8ff90']),
        gradientBend: 0.5,
        metalness: 0.6,
        roughness: 0.1,
        clearcoat: 1,
        reflectivity: 0.8,
        emissive: '#ffffff',
        emissiveIntensity: 0.3,
      },
      ...letter3D({
        depth: 10,
        bevel: letterBevel('round', 1.3),
        rings: [ring(0.4, 0.6, darkMetal('#000000', 0.4), 'step')],
        side: darkMetal('#041000', 0.4),
        plates: [
          plate(3, 'custom', { depth: 6, bevel: bevel3D(1, 1, 'chamfer') }, { color: '#0a0c08', metalness: 0.3, roughness: 0.3, clearcoat: 0.8, pattern: pattern({ kind: 'hazard', color: '#0a0c08', color2: '#8aff00', opacity: 1, scale: 4, angle: 0, shade: 0.6 }) }),
          neonTube(0.8, '#60ff00', 3),
          blackPlate(1.4, { depth: 4, bevel: bevel3D(0.5, 0.5) }, { color: '#000000' }),
        ],
      }),
      shadow: shadow3D(),
      // no glint: the self-lit face would streak green stars across it
      glint: glint3D(),
    },
    effects: [...edge3D('#60ff00', '#000000'), halo('#40ff00', 32, 0.7), ...glow3D('#a0ff40', 1)],
    // dark night environment (the studio's softboxes wash the clearcoat white) with white key and
    // acid-green lights raking from both sides, so the banding stays crisp head-on and tilted
    lighting: {
      ...envLook('night', 0),
      lights: [
        { id: uid(), type: 'directional', color: '#ffffff', intensity: 2.5, x: -600, y: 800, z: 1000 },
        { id: uid(), type: 'directional', color: '#a0ff40', intensity: 3, x: 900, y: -500, z: 200 },
        { id: uid(), type: 'directional', color: '#e0ff80', intensity: 3, x: -900, y: 500, z: 200 },
      ],
    },
  });

  // ---------- 桜: sakura-pink pearl with petal print, white tube, gold step, white plate, gold line ----------
  const sakura = p3({
    id: 'f-3d-sakura',
    name: '桜 Sakura Pearl',
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      face: {
        ...material3D('custom'),
        color: '#ffb0cc',
        gradient: g([0, '#fff0f6'], [0.22, '#ffb8d4'], [0.44, '#e8609a'], [0.53, '#8a1a50'], [0.63, '#f080b0'], [0.85, '#ffc8de'], [1, '#fff4f8']),
        gradientBend: 0.5,
        metalness: 0.5,
        roughness: 0.16,
        clearcoat: 1,
        iridescence: 0.5,
        reflectivity: 0.8,
        pattern: pattern({ kind: 'sakura', color: '#fff4f8', color2: '#ff5a9a', opacity: 0.55, scale: 9, shade: 0.7, seed: 4 }),
      },
      ...letter3D({
        depth: 10,
        bevel: letterBevel('round', 1.2),
        rings: [ring(0.3, 0.5, darkMetal('#4a0a28'), 'step')],
        side: darkMetal('#3a0a20', 0.3),
        plates: [
          plate(2, 'whiteGloss', { depth: 6, join: 'round', bevel: { ...bevel3D(2, 1.4, 'round'), segments: 10 } }),
          plate(1.4, 'punchyGold', { depth: 5, bevel: bevel3D(1.1, 1.1, 'chamfer') }),
          plate(1.6, 'whiteGloss', { depth: 5, bevel: bevel3D(0.8, 0.8) }, { color: '#ffe8f0' }),
          blackPlate(1, { depth: 4, bevel: bevel3D(0.5, 0.5) }, { color: '#2a0418' }),
        ],
      }),
      shadow: shadow3D(),
      glint: starGlint({ intensity: 0.35, threshold: 2, tint: '#fff0f6', length: 20 }),
    },
    effects: [...edge3D('#ff70a8', '#2a0418'), ...glow3D('#ffd8e8', 0.8)],
    lighting: envLook('softbox', 0),
  });

  return [neonGlass, porcelain, blueTitanium, galaxy, lava, kinGin, toxic, sakura];
}
