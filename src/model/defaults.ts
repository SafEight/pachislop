import { DEFAULT_FONT_ID } from '../assets/registry';
import { noLighting } from './lighting';
import type {
  Adjustment,
  AdjustmentLayer,
  AdjustmentType,
  ColorBalanceRange,
  Distort,
  Erode2D,
  GroupLayer,
  LevelsChannel,
  PlateShape,
  Vec2,
  AO3D,
  BackgroundLayer,
  Band3D,
  Bevel2D,
  Curve,
  Reflection2D,
  BevelProfile3D,
  BevelShape3D,
  Comp,
  Fill,
  Glass2D,
  Glint3D,
  Gradient,
  ImageSource,
  ImageTrace,
  Material2D,
  Material3D,
  MaterialPreset,
  Pattern,
  Project,
  Rim2D,
  Shadow3D,
  Satin2D,
  Sheen2D,
  ShapeKind,
  ShapeSource,
  TextSource,
  Title2DLayer,
  Title3DLayer,
  TitleStyle2D,
  Transform,
  Warp,
} from './types';

export const uid = () => crypto.randomUUID().slice(0, 8);

const g = (...stops: [number, string][]): Gradient => ({ stops: stops.map(([pos, color]) => ({ pos, color })) });

/**
 * Gradient library. Metal ramps are DARK→LIGHT luminance ramps for the gradient-map finish
 * (Finish2D) unless named *Fill; fill gradients run top→bottom. Hex stops come from the
 * researched production recipes (まぺろに 確定, ヒロデザch gold, rainbow 確定 caption).
 */
export const GRADIENTS: Record<string, Gradient> = {
  // gradient-map ramps (dark → light)
  // Gold darks run orange → red-brown, never olive / khaki: measured on official machine art
  // (Sammy 北斗 / カバネリ gold: S ≈ 0.79, V ≈ 0.87 with orange-red shadows).
  goldRamp: g([0, '#3a0c00'], [0.25, '#a83800'], [0.5, '#f08c00'], [0.75, '#ffd23a'], [1, '#fff8d6']),
  paleGoldRamp: g([0, '#3a2a08'], [0.4, '#a8873a'], [0.75, '#f3e3a6'], [1, '#ffffff']),
  silverRamp: g([0, '#14161c'], [0.35, '#5d6474'], [0.7, '#c9cfdb'], [1, '#ffffff']),
  redRamp: g([0, '#2a0000'], [0.4, '#a10010'], [0.75, '#ff3a3a'], [1, '#fff0f0']),
  blueRamp: g([0, '#000a2a'], [0.4, '#0a3cc9'], [0.75, '#4fb4ff'], [1, '#f0fbff']),
  greenRamp: g([0, '#002a08'], [0.4, '#0a9c2a'], [0.75, '#5cff6e'], [1, '#f0fff0']),
  purpleRamp: g([0, '#16002a'], [0.4, '#7a12c9'], [0.75, '#d77bff'], [1, '#fff0ff']),
  copperRamp: g([0, '#2a0d00'], [0.4, '#a3461a'], [0.75, '#ffad7a'], [1, '#fff3ea']),
  roseGoldRamp: g([0, '#2a0a06'], [0.4, '#a5584a'], [0.75, '#f7c1ad'], [1, '#fff4ef']),
  // face fills (top → bottom)
  goldFill: g([0, '#7a2a00'], [0.25, '#fff4c8'], [0.49, '#8a3000'], [0.6, '#ffc860'], [0.79, '#a84400'], [1, '#ffe890']),
  goldBandsFill: g([0, '#e8a020'], [0.2, '#fff6b0'], [0.4, '#f0a820'], [0.6, '#ffc840'], [0.8, '#c05a08'], [1, '#ffe070']),
  goldRimFill: g([0, '#8a2c00'], [0.17, '#ffe470'], [0.33, '#c05a00'], [0.5, '#ffbe30'], [0.67, '#fff0a0'], [0.83, '#f09a10'], [1, '#ffe060']),
  silverFill: g([0, '#ffffff'], [0.45, '#c9ced8'], [0.5, '#6b7280'], [0.75, '#e6e9ef'], [1, '#9aa1ad']),
  redFill: g([0, '#ff5a5a'], [0.45, '#e00012'], [1, '#5a0000']),
  blueFill: g([0, '#e0f4ff'], [0.45, '#1a7aff'], [1, '#001a6a']),
  greenFill: g([0, '#e8ffe0'], [0.45, '#1fd12a'], [1, '#00470a']),
  yellowFill: g([0, '#fffbd0'], [0.45, '#ffe600'], [1, '#d08a00']),
  paleGoldRimFill: g([0, '#7a6030'], [0.2, '#fbf0c0'], [0.4, '#b89a58'], [0.6, '#f6e7b4'], [0.8, '#a88a4a'], [1, '#f8eecb']),
  chromeFill: g([0, '#ffffff'], [0.2, '#d8e6f5'], [0.47, '#7c8ea6'], [0.5, '#1c222c'], [0.56, '#5a4a3a'], [0.75, '#d9c9b0'], [1, '#ffffff']),
  hologramFill: g([0, '#b8f6ff'], [0.2, '#ffc6f5'], [0.4, '#fff7c0'], [0.6, '#c6ffdc'], [0.8, '#c9c5ff'], [1, '#b8f6ff']),
  // White kept as a narrow highlight band: a wide white stop washes the neighbouring hues pastel.
  rainbowFill: g([0, '#f64849'], [0.17, '#f63bfc'], [0.34, '#029cff'], [0.52, '#36f7f1'], [0.58, '#ffffff'], [0.64, '#2ee860'], [0.78, '#10da0d'], [1, '#ffff0d']),
  rainbowSpectrum: g([0, '#ff2a2a'], [0.17, '#ff9b00'], [0.33, '#fff200'], [0.5, '#2bff3a'], [0.67, '#00c8ff'], [0.83, '#3a3aff'], [1, '#d22cff']),
  blackCrimsonRadial: g([0, '#ff1a3a'], [0.55, '#6a0010'], [1, '#000000']),
  blackGreenRadial: g([0, '#3dff6a'], [0.55, '#00501a'], [1, '#000000']),
  fire: g([0, '#fffbe0'], [0.3, '#ffd000'], [0.65, '#ff4a00'], [1, '#7a0000']),
  ice: g([0, '#ffffff'], [0.5, '#7fe8ff'], [1, '#0048ff']),
  coronaPurple: g([0, '#ffffff'], [0.3, '#f0a0ff'], [0.65, '#a020ff'], [1, '#30006a']),
};

/** Neutral chrome ramp: a photographic reflection map's lightness, its colour cast dropped, contrast kept (liquid chrome looks, the Material effect's Chrome). */
export const CHROME_RAMP: Gradient = g([0, '#1c1c1c'], [0.45, '#9a9a9a'], [0.8, '#f0f0f0'], [1, '#ffffff']);

export function defaultTransform(): Transform {
  return { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0, scale: 1, flipX: false, flipY: false, opacity: 1 };
}

// ---------- 2D ----------

export function solidFill(color: string): Fill {
  return { kind: 'solid', color, gradient: g([0, color], [1, color]), angle: 90, scale: 1, offset: 0, span: 'layer' };
}

export function linearFill(gradient: Gradient, angle = 90, span: Fill['span'] = 'layer'): Fill {
  return { kind: 'linear', color: gradient.stops[0]?.color ?? '#ffffff', gradient, angle, scale: 1, offset: 0, span };
}

/** Curve from [x, y] pairs (smooth points); append `true` as a third item for a corner point. */
export function curve(...pts: ([number, number] | [number, number, boolean])[]): Curve {
  return { points: pts.map(([x, y, corner]) => ({ x, y, corner: corner ?? false })) };
}

/** Identity contour (y = x): the starting point for custom gloss / satin contours. */
export const linearCurve = (): Curve => curve([0, 0], [1, 1]);

export function bevel2D(overrides: Partial<Bevel2D> = {}): Bevel2D {
  return {
    enabled: true,
    profile: 'smooth',
    profileCurve: curve([0, 0], [0.5, 0.75], [1, 1]),
    size: 3,
    sizeMode: 'fixed',
    fit: 70,
    depth: 3,
    soften: 0,
    lightAngle: 120,
    lightAltitude: 30,
    useGlobalLight: true,
    gloss: 'ring',
    glossCurve: linearCurve(),
    highlightColor: '#ffffff',
    highlightOpacity: 0.85,
    shadowColor: '#000000',
    shadowOpacity: 0.6,
    ...overrides,
  };
}

/** Satin off; the fields hold Photoshop's defaults scaled to size-relative units. */
export function satin2D(overrides: Partial<Satin2D> = {}): Satin2D {
  return {
    enabled: false,
    color: '#000000',
    blend: 'multiply',
    opacity: 0.5,
    angle: 19,
    useGlobalLight: false,
    distance: 5,
    size: 7,
    contour: curve([0, 0], [0.5, 1], [1, 0]),
    invert: true,
    ...overrides,
  };
}

/** No pattern; the fields hold sensible starting values for when a kind is picked. */
export function pattern(overrides: Partial<Pattern> = {}): Pattern {
  return { kind: 'none', color: '#000000', color2: '#ffffff', opacity: 1, scale: 12, angle: 0, seed: 1, shade: 0.6, relief: 0, ...overrides };
}

/** Reflection map off; the fields hold Eye Candy's starting values for when it is switched on. */
export function reflection2D(overrides: Partial<Reflection2D> = {}): Reflection2D {
  return { enabled: false, map: 'highway', amount: 1, blur: 75, rotation: 0, colorize: 0, ...overrides };
}

/** Glass off; the fields hold the old Glass effect's starting values for when it is switched on. */
export function glass2D(overrides: Partial<Glass2D> = {}): Glass2D {
  return { enabled: false, color: '#3cc8ff', tint: 1, opacity: 0.7, edge: 0.7, caustic: 0.7, ...overrides };
}

/** Sheen off; the fields hold the old Metal Texture effect's starting values for when it is switched on. */
export function sheen2D(overrides: Partial<Sheen2D> = {}): Sheen2D {
  return { enabled: false, color: '#ffffff', amount: 0.7, position: -0.25, width: 0.35, ...overrides };
}

export function material2D(fill: Fill, overrides: Partial<Material2D> = {}): Material2D {
  return {
    fill,
    opacity: 1,
    bevel: bevel2D({ enabled: false }),
    reflection: reflection2D(),
    finish: { enabled: false, gradient: GRADIENTS.goldRamp, amount: 1 },
    pattern: pattern(),
    satin: satin2D(),
    texture: { kind: 'none', amount: 0.3, scale: 4, blend: 'overlay', seed: 1, target: 'color', angle: 0 },
    innerGlow: { enabled: false, color: '#ffffff', size: 2, opacity: 0.6, noise: 0 },
    gloss: { enabled: false, opacity: 0.55, position: 0.45, softness: 0.15, curve: 0.25, angle: 0 },
    refraction: 0,
    glass: glass2D(),
    sheen: sheen2D(),
    ...overrides,
  };
}

/** Rim / plate base outline: the element's own contour, no closing. */
export function plateShape(overrides: Partial<PlateShape> = {}): PlateShape {
  return { kind: 'contour', close: 0, corner: 4, slant: 0, ...overrides };
}

export function rim2D(width: number, material: Material2D, overrides: Partial<Rim2D> = {}): Rim2D {
  return { id: uid(), enabled: true, width, join: 'miter', fillCounters: true, plate: plateShape(), offsetX: 0, offsetY: 0, material, ...overrides };
}

/** かすれ off; the fields hold a dry-brush starting point for when it's switched on. */
export function erode2D(overrides: Partial<Erode2D> = {}): Erode2D {
  return { enabled: false, amount: 0.5, edge: 6, scale: 12, angle: 0, seed: 1, ...overrides };
}

/** The classic gold outline look: gradient-mapped bevelled gold face, black / white / red rims. */
export function defaultTitleStyle2D(): TitleStyle2D {
  return {
    face: material2D(linearFill(GRADIENTS.goldFill), {
      bevel: bevel2D({ size: 3, depth: 3, gloss: 'ring' }),
      finish: { enabled: true, gradient: GRADIENTS.goldRamp, amount: 0.85 },
      innerGlow: { enabled: true, color: '#fff3b0', size: 1.5, opacity: 0.5, noise: 0.35 },
      gloss: { enabled: true, opacity: 0.45, position: 0.45, softness: 0.12, curve: 0.25, angle: 0 },
    }),
    rims: [
      rim2D(1.5, material2D(solidFill('#1a0a00'))),
      rim2D(2.5, material2D(solidFill('#ffffff'), { bevel: bevel2D({ size: 1.5, depth: 2 }) })),
      rim2D(4, material2D(linearFill(GRADIENTS.redFill), { bevel: bevel2D({ size: 2.5, depth: 3, highlightOpacity: 0.6 }) })),
      rim2D(2.5, material2D(solidFill('#000000')), { offsetY: 3 }),
    ],
    knockout: false,
    erode: erode2D(),
  };
}

// ---------- 3D ----------

/**
 * Gold metal banding (top → bottom): warm white-hot top, saturated yellow, an orange → red-brown
 * horizon just below the middle, then orange-yellow. No near-white mid stops: a metal reflects
 * the environment TINTED by this colour, so pale stops read khaki and dark yellows read olive.
 */
const GOLD_BANDING = g([0, '#fff4b0'], [0.18, '#ffd400'], [0.42, '#ff9800'], [0.5, '#b83000'], [0.58, '#ff7c00'], [0.8, '#ffb800'], [1, '#ffe070']);

const PRESET_VALUES: Record<Exclude<MaterialPreset, 'custom'>, Partial<Material3D> & { color: string }> = {
  // Metals carry a banded tint gradient (top → bottom: white-hot, mid tone, dark band just
  // below the middle, mid tone, pale) — the classic pachislot metal banding, which reads
  // head-on AND rotated, independent of what the environment happens to reflect.
  gold: {
    color: '#ffc000',
    metalness: 1,
    roughness: 0.08,
    // No clearcoat: an untinted coat lays a pale, unsaturated reflection over the metal.
    clearcoat: 0,
    gradient: GOLD_BANDING,
  },
  /** 遊技機 gold pushed past physical (Element 3D Spec / Env multipliers): punchier highlights. */
  punchyGold: {
    color: '#ffc000',
    metalness: 1,
    roughness: 0.2,
    reflectivity: 2,
    specBoost: 2,
    clearcoat: 0,
    gradient: GOLD_BANDING,
  },
  paleGold: {
    color: '#f3dc9a',
    metalness: 1,
    roughness: 0.1,
    clearcoat: 0.3,
    gradient: g([0, '#fffef5'], [0.22, '#fbeec0'], [0.45, '#d2b26a'], [0.52, '#7d6430'], [0.6, '#c9a85f'], [0.8, '#f7e7b0'], [1, '#fffbe8']),
  },
  roseGold: {
    color: '#ffb59a',
    metalness: 1,
    roughness: 0.1,
    clearcoat: 0.3,
    gradient: g([0, '#fff5f0'], [0.22, '#ffd0bd'], [0.45, '#d98a6e'], [0.52, '#7d3f2c'], [0.6, '#c97c62'], [0.8, '#ffcbb6'], [1, '#fff0ea']),
  },
  chrome: {
    color: '#ffffff',
    metalness: 1,
    roughness: 0.04,
    gradient: g([0, '#ffffff'], [0.22, '#e8eef5'], [0.45, '#8a94a3'], [0.52, '#2e343d'], [0.6, '#7d8794'], [0.8, '#dde4ee'], [1, '#ffffff']),
  },
  silver: {
    color: '#d8dde6',
    metalness: 1,
    roughness: 0.14,
    clearcoat: 0.3,
    gradient: g([0, '#ffffff'], [0.22, '#e3e7ee'], [0.45, '#a3abb8'], [0.52, '#555c68'], [0.6, '#9aa2af'], [0.8, '#dfe4eb'], [1, '#f7f9fc']),
  },
  copper: {
    color: '#ff8a52',
    metalness: 1,
    roughness: 0.12,
    clearcoat: 0.3,
    gradient: g([0, '#fff0e0'], [0.22, '#ffb48a'], [0.45, '#d0652a'], [0.52, '#6e2a0c'], [0.6, '#c05a24'], [0.8, '#ffa77a'], [1, '#ffe6d6']),
  },
  redMetal: {
    color: '#ff1d2d',
    metalness: 0.9,
    roughness: 0.15,
    clearcoat: 1,
    gradient: g([0, '#ff8a8a'], [0.22, '#ff3b3b'], [0.45, '#d0101c'], [0.52, '#5a0008'], [0.6, '#b80c18'], [0.8, '#ff3030'], [1, '#ff9a9a']),
  },
  blueMetal: {
    color: '#2a6bff',
    metalness: 0.9,
    roughness: 0.15,
    clearcoat: 1,
    gradient: g([0, '#8cc4ff'], [0.22, '#3d8bff'], [0.45, '#1048d0'], [0.52, '#03154f'], [0.6, '#0e3fb8'], [0.8, '#3a85ff'], [1, '#86beff']),
  },
  greenMetal: {
    color: '#18d63a',
    metalness: 0.9,
    roughness: 0.15,
    clearcoat: 1,
    gradient: g([0, '#96ffa2'], [0.22, '#38f052'], [0.45, '#10b02a'], [0.52, '#03420c'], [0.6, '#0e9a24'], [0.8, '#34e84e'], [1, '#90ff9c']),
  },
  purpleMetal: {
    color: '#a43aff',
    metalness: 0.9,
    roughness: 0.15,
    clearcoat: 1,
    gradient: g([0, '#dcaeff'], [0.22, '#ad55ff'], [0.45, '#7d1ed0'], [0.52, '#2c0552'], [0.6, '#6a18b8'], [0.8, '#a84cff'], [1, '#d6a6ff']),
  },
  blackGloss: { color: '#050505', metalness: 0.2, roughness: 0.08, clearcoat: 1 },
  whiteGloss: { color: '#ffffff', metalness: 0, roughness: 0.15, clearcoat: 1 },
  /**
   * 虹 paint: saturated hues as the DIFFUSE colour under a clear gloss coat (research: rainbow
   * titles read as paint plus a gold rim). A full metal multiplies the hues into coloured
   * reflections and goes olive / navy when orbited; low metalness keeps them pure at any angle.
   * The ramp is the uneven 7-hue spectrum with a white horizon stop, spanning each LINE so a
   * two-line title shows the whole spectrum on both lines. Low reflectivity keeps the tone
   * mapper from washing the hues to pastel; the white emissive is tinted by the gradient
   * (engine/three/materials.ts), a small self-lit floor in the hues' own colours.
   */
  rainbow: {
    color: '#ffffff',
    metalness: 0.2,
    roughness: 0.2,
    reflectivity: 0.4,
    clearcoat: 1,
    iridescence: 0.1,
    emissive: '#ffffff',
    emissiveIntensity: 0.1,
    gradientSpan: 'line',
    gradient: g([0, '#ff1e2a'], [0.16, '#ff8c00'], [0.32, '#ffe800'], [0.39, '#ffffff'], [0.46, '#7cf04a'], [0.54, '#22e03a'], [0.68, '#00b4ff'], [0.84, '#2a3cff'], [1, '#b026ff']),
  },
  glass: { color: '#d4f2ff', metalness: 0, roughness: 0.02, opacity: 0.22, clearcoat: 1 },
  plastic: { color: '#ff3b3b', metalness: 0, roughness: 0.35, clearcoat: 0.8 },
  emissive: { color: '#000000', metalness: 0, roughness: 0.5, emissive: '#ffe066', emissiveIntensity: 3 },
  /** Candy-apple paint: tinted metal under clearcoat with glitter flakes. */
  candy: { color: '#e0102a', metalness: 0.85, roughness: 0.35, clearcoat: 1, flakes: 0.8, flakeScale: 0.8, reflectivity: 1.4, specBoost: 1.5 },
  // Gems (宝石 premium looks). Flakes act as facets on flat faces; IOR is clamped to three's 2.333.
  diamond: { color: '#f4f9ff', metalness: 0, roughness: 0.02, transmission: 1, ior: 2.333, dispersion: 0.8, reflectivity: 1.6, specBoost: 2, flakes: 0.5, flakeScale: 2 },
  ruby: { color: '#ff1030', metalness: 0, roughness: 0.03, transmission: 1, ior: 1.77, dispersion: 0.3, reflectivity: 1.5, specBoost: 2 },
  sapphire: { color: '#1650ff', metalness: 0, roughness: 0.03, transmission: 1, ior: 1.77, dispersion: 0.3, reflectivity: 1.5, specBoost: 2 },
  emerald: { color: '#10c050', metalness: 0, roughness: 0.04, transmission: 1, ior: 1.58, dispersion: 0.2, reflectivity: 1.4, specBoost: 2 },
};

export function material3D(preset: MaterialPreset = 'gold'): Material3D {
  const base: Material3D = {
    preset,
    color: '#ffffff',
    gradientKind: 'linear',
    gradientAngle: 90,
    gradientSpan: 'layer',
    gradientScale: 1,
    gradientOffset: 0,
    gradientAxis: 'xy',
    gradientBend: 0,
    metalness: 0,
    roughness: 0.3,
    reflectivity: 1,
    specBoost: 1,
    clearcoat: 0,
    iridescence: 0,
    transmission: 0,
    ior: 1.5,
    dispersion: 0,
    glassDepth: 0,
    environment: {},
    flakes: 0,
    flakeScale: 0.6,
    pattern: pattern(),
    surface: { kind: 'none', amount: 0.5, scale: 20, seed: 1 },
    emissive: '#000000',
    emissiveIntensity: 0,
    opacity: 1,
  };
  return preset === 'custom' ? base : { ...base, ...PRESET_VALUES[preset], preset };
}

/** A bevel cross-section (width 0 = none). */
export function bevel3D(width: number, depth: number, profile: BevelProfile3D = 'round'): BevelShape3D {
  return { width, depth, profile, segments: 6, curve: 0 };
}

export function ao3D(overrides: Partial<AO3D> = {}): AO3D {
  return { enabled: false, radius: 4, intensity: 1, ...overrides };
}

/** A band growing `grow` % of size beyond the previous solid, sitting right behind it, in `preset`. */
export function band3D(grow: number, preset: MaterialPreset): Band3D {
  return {
    id: uid(),
    enabled: true,
    grow,
    join: 'miter',
    fillCounters: false,
    shape: plateShape(),
    depth: 6,
    offset: 0,
    bevel: bevel3D(1, 1),
    material: material3D(preset),
  };
}

// ---------- layers ----------

/** Outline tracing of an image's alpha (ImageSource.trace): half-opaque edge, light smoothing, specks dropped. */
export const imageTrace = (): ImageTrace => ({ threshold: 128, smooth: 0.5, despeckle: 0.05 });

/** Image source for asset `assetId`, fitted so its larger side is `size` px. */
export function imageSource(assetId: string, size: number): ImageSource {
  return { kind: 'image', assetId, size, trace: imageTrace() };
}

export function textSource(text: string, size = 200): TextSource {
  return {
    kind: 'text',
    text,
    fontId: DEFAULT_FONT_ID,
    size,
    tracking: 0,
    lineHeight: 1.1,
    align: 'center',
    vertical: false,
    shear: 0,
    chars: {},
    lines: {},
    hScale: 1,
    vScale: 1,
    tsume: 0,
    tateChuYoko: true,
  };
}

/** Fields every new layer starts with (named `name`, visible, unclipped, identity transform, no effects). */
export const layerBase = (name: string) => ({
  id: uid(),
  name,
  visible: true,
  solo: false,
  locked: false,
  guide: false,
  blend: 'normal' as const,
  transform: defaultTransform(),
  effects: [],
  clip: false,
  masks: [],
});

export function createTitle2DLayer(text = 'BIG BONUS'): Title2DLayer {
  return { ...layerBase(text.split('\n')[0] || 'Title'), kind: 'title2d', source: textSource(text), ...outlineOps(), style: defaultTitleStyle2D(), partEffects: {} };
}

export function noWarp(): Warp {
  return { style: 'none', bend: 0, horizontal: 0, vertical: 0 };
}

/** Identity free distort: corners and the 4×4 mesh at rest. */
export function noDistort(): Distort {
  const z = (): Vec2 => ({ x: 0, y: 0 });
  return { mode: 'none', corners: [z(), z(), z(), z()], mesh: Array.from({ length: 16 }, z) };
}

/** Warp / distort / weight at rest, for title layers. */
export function outlineOps(): { warp: Warp; distort: Distort; weight: number } {
  return { warp: noWarp(), distort: noDistort(), weight: 0 };
}

export function shadow3D(overrides: Partial<Shadow3D> = {}): Shadow3D {
  return { enabled: false, color: '#2a0a00', opacity: 0.6, softness: 0.5, ...overrides };
}

export function glint3D(overrides: Partial<Glint3D> = {}): Glint3D {
  return { enabled: false, threshold: 1, intensity: 1, radius: 6, streaks: 4, length: 40, angle: 0, tint: '#fff4dc', ...overrides };
}

/** Starting parameters per shape kind (height `size` px). */
export function shapeSource(shape: ShapeKind, size = 300): ShapeSource {
  const s: ShapeSource = {
    kind: 'shape',
    shape,
    size,
    aspect: 1,
    corner: 0,
    slant: 0,
    points: 16,
    inner: 0.7,
    jitter: 0,
    seed: 1,
    tail: { x: -30, y: -70, width: 25 },
  };
  switch (shape) {
    case 'rect':
      return { ...s, aspect: 3.5, corner: 18 };
    case 'parallelogram':
      return { ...s, aspect: 4.5, slant: 20, corner: 4 };
    case 'polygon':
      return { ...s, points: 6, aspect: 1.15, corner: 4 };
    case 'star':
      return { ...s, points: 5, inner: 0.45 };
    case 'burst':
      return { ...s, aspect: 1.6, points: 18, inner: 0.72, jitter: 0.35 };
    case 'shield':
      return { ...s, aspect: 0.85, corner: 10 };
    case 'speech':
      return { ...s, aspect: 2.2, corner: 45 };
    case 'shout':
      return { ...s, aspect: 2, points: 22, inner: 0.82, jitter: 0.4 };
    case 'ribbon':
      return { ...s, aspect: 4.5, inner: 0.35, tail: { x: 40, y: 0, width: 0 } };
    default:
      return s;
  }
}

export function createTitle3DLayer(text = '確定'): Title3DLayer {
  return {
    ...layerBase(text.split('\n')[0] || '3D Title'),
    kind: 'title3d',
    source: textSource(text),
    ...outlineOps(),
    partEffects: {},
    style3d: {
      mode: 'extrude',
      inflate: { height: 12, profile: curve([0, 0], [0.35, 0.8], [1, 1]), smoothness: 0, detail: 1 },
      depth: 14,
      curveSegments: 8,
      bevel: bevel3D(2.5, 2.5),
      bevelPosition: 'outside',
      envLock: false,
      skew: { x: 0, y: 0 },
      face: material3D('gold'),
      faceImage: 1,
      edgeImage: 0,
      lighting: noLighting(),
      bands: [],
      shadow: shadow3D(),
      glint: glint3D(),
      ao: ao3D(),
    },
  };
}

export function createBackgroundLayer(): BackgroundLayer {
  return {
    ...layerBase('Background'),
    guide: true, // preview backdrop; exports stay transparent unless un-guided
    kind: 'background',
    fill: { kind: 'radial', color: '#10081c', gradient: g([0, '#3a0a4a'], [0.6, '#12041c'], [1, '#000000']), angle: 90, scale: 1, offset: 0, span: 'layer' },
  };
}

/** Empty group named `name` (members are attached by setting their parentId). */
export function createGroupLayer(name = 'Group'): GroupLayer {
  return { ...layerBase(name), kind: 'group', collapsed: false };
}

const levelsChannel = (): LevelsChannel => ({ inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 });
const balance = (): ColorBalanceRange => ({ cyanRed: 0, magentaGreen: 0, yellowBlue: 0 });

/** Photoshop's defaults for a new adjustment of `type` (a no-op where Photoshop's is). */
export function defaultAdjustment(type: AdjustmentType): Adjustment {
  switch (type) {
    case 'brightnessContrast':
      return { type, brightness: 0, contrast: 0 };
    case 'levels':
      return { type, channels: { rgb: levelsChannel(), r: levelsChannel(), g: levelsChannel(), b: levelsChannel() } };
    case 'curves':
      return { type, channels: { rgb: linearCurve(), r: linearCurve(), g: linearCurve(), b: linearCurve() } };
    case 'exposure':
      return { type, exposure: 0, offset: 0, gamma: 1 };
    case 'vibrance':
      return { type, vibrance: 0, saturation: 0 };
    case 'hueSaturation':
      return { type, hue: 0, saturation: 0, lightness: 0, colorize: false };
    case 'colorBalance':
      return { type, shadows: balance(), midtones: balance(), highlights: balance(), preserveLuminosity: true };
    case 'blackWhite':
      return { type, reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, tintColor: '#e1d3b3' };
    case 'photoFilter':
      return { type, color: '#ec8a00', density: 25, preserveLuminosity: true };
    case 'gradientMap':
      return { type, gradient: g([0, '#000000'], [1, '#ffffff']), reverse: false };
    case 'invert':
      return { type };
    case 'posterize':
      return { type, levels: 4 };
    case 'threshold':
      return { type, level: 128 };
    case 'effectsOnly':
      return { type };
  }
}

/** Photoshop's adjustment names, used as default layer names (translated in the UI where shown as labels). */
export const ADJUSTMENT_NAMES: Record<AdjustmentType, string> = {
  brightnessContrast: 'Brightness/Contrast',
  levels: 'Levels',
  curves: 'Curves',
  exposure: 'Exposure',
  vibrance: 'Vibrance',
  hueSaturation: 'Hue/Saturation',
  colorBalance: 'Color Balance',
  blackWhite: 'Black & White',
  photoFilter: 'Photo Filter',
  gradientMap: 'Gradient Map',
  invert: 'Invert',
  posterize: 'Posterize',
  threshold: 'Threshold',
  effectsOnly: 'Effects only',
};

export function createAdjustmentLayer(type: AdjustmentType): AdjustmentLayer {
  return { ...layerBase(ADJUSTMENT_NAMES[type]), kind: 'adjustment', adjustment: defaultAdjustment(type) };
}

export function defaultComp(): Comp {
  return {
    width: 1920,
    height: 1080,
    background: { transparent: true, color: '#000000' },
    camera: { fov: 30, x: 0, y: 0, zOffset: 0, rotX: 0, rotY: 0, rotZ: 0 },
    globalLight: { angle: 120, altitude: 30 },
    environment: { preset: 'studio', intensity: 1, rotation: 0, tint: '#ffffff', contrast: 1, saturation: 1, blur: 0, repeatX: 1, repeatY: 1 },
    lights: [
      { id: uid(), type: 'directional', color: '#ffffff', intensity: 2, x: -600, y: 800, z: 1000 },
      { id: uid(), type: 'ambient', color: '#ffffff', intensity: 0.3, x: 0, y: 0, z: 0 },
    ],
    toneMapping: 'neutral',
    exposure: 1,
    supersample: 3,
    dpi: 72,
  };
}

/** A new project: the default comp and no layers (the viewport shows its checkerboard). */
export function createProject(): Project {
  return { version: 11, name: 'Untitled', comp: defaultComp(), layers: [] };
}
