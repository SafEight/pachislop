// Document model (stills only — there is no time axis anywhere). Everything here is plain
// JSON-serializable data: the store holds it, project files save it, the engine renders it.
//
// Coordinates: comp pixels, (0,0) = comp centre, +x right, +y UP, +z toward the viewer.
//
// SIZE-RELATIVE UNITS: every dimension inside a title style (rim widths and offsets, bevel
// sizes, inner-glow size, 3D depth/bevel/backplate sizes) is a PERCENTAGE OF THE SOURCE
// `size` (font em size for text, fitted size for SVG/image/model). Changing the font size
// therefore keeps the whole look intact, and style presets transfer between layers.
// Effect parameters (src/effects) stay in comp pixels.

export interface GradientStop {
  pos: number; // 0..1
  color: string; // #rrggbb
  /** Stop opacity 0..1 (Photoshop opacity stops, merged into the colour stop). Absent = 1. */
  alpha?: number;
  /**
   * Photoshop colour midpoint between THIS stop and the next, 0.05..0.95 of the gap
   * (0.5 = linear blend). Absent = 0.5. Ignored on the last stop.
   */
  mid?: number;
}

export interface Gradient {
  stops: GradientStop[];
  /**
   * Interpolation between stops. 'rgb' = linear-light RGB (current behaviour); 'vivid' = OKLCH
   * (shorter hue arc), so blue→white or red→green keep chroma through the middle instead of
   * greying out. Absent = 'rgb'.
   */
  interp?: 'rgb' | 'vivid';
}

/**
 * One stored effect / generator param. Besides scalars and gradients, a param can hold a whole
 * structured value (ParamDef kind 'material2d': a Material2D; 'adjustment': an Adjustment), edited
 * by its own editor through ordinary path edits below `params[key]` (store setAt), so undo labels
 * and coalescing work as for any other field.
 */
export type ParamValue = number | string | boolean | Gradient | Material2D | Adjustment;

export interface EffectInstance {
  id: string;
  type: string; // EffectDef.type
  enabled: boolean;
  params: Record<string, ParamValue>;
  /**
   * Added by a generator preset (GeneratorPreset.effects) or by migrating a generator param into
   * an effect: applying another preset to the layer replaces it. Absent = the user's own.
   */
  fromPreset?: true;
}

export type BlendMode = 'normal' | 'add' | 'screen' | 'multiply' | 'overlay';

export interface Transform {
  x: number;
  y: number;
  z: number; // 3D only
  rotX: number; // degrees, 3D only
  rotY: number; // degrees, 3D only
  rotZ: number; // degrees
  scale: number; // 1 = 100%
  /**
   * Mirror the layer left ↔ right / top ↔ bottom about its position, before rotZ (Photoshop Edit ›
   * Transform › Flip Horizontal / Vertical). Applies to everything the layer draws: text, shape,
   * image, 3D solid, generator, linked masks; effects run on the flipped pixels.
   */
  flipX: boolean;
  flipY: boolean;
  opacity: number; // 0..1
}

// ---------- fills ----------

/**
 * What a gradient spans (Photoshop "Align with Layer" / Element 3D "Use Layer as UV"):
 * - 'layer': the element's whole bounding box (one ramp across every line);
 * - 'line': each text line (column when vertical) gets the full ramp over its own box, so a
 *   two-line 虹 title shows the whole spectrum on both lines;
 * - 'char': each glyph gets the full ramp over its own box.
 * Pixels outside every glyph box (rims, counters) use the box of the NEAREST glyph / line.
 * Non-text sources (shapes, SVG, images, models) always behave as 'layer'.
 */
export type GradientSpan = 'layer' | 'line' | 'char';

/**
 * Photoshop gradient types. 'angle' sweeps around the span centre starting at `angle`;
 * 'reflected' mirrors a linear ramp around the span centre (centre = stop 0, both edges =
 * stop 1); 'diamond' is the L1 (rhombus) version of radial. 'shapeBurst' follows the outline
 * like Photoshop's Stroke "Shape Burst": stop 0 at the element edge, stop 1 at the deepest
 * inside point (face) or across the rim band (rims); it ignores span/angle.
 */
export type FillKind = 'solid' | 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond' | 'shapeBurst' | 'image';

/**
 * Image fill (Photoshop Pattern Overlay with an imported picture, TextStudio "fill image"):
 * the asset is placed over the span box chosen by `Fill.span`, cover-fitted at scale 1.
 */
export interface ImageFill {
  assetId: string; // asset data is an image blob (src/assets/registry.ts)
  scale: number; // 1 = cover the span box
  offsetX: number; // fraction of the span box width, +right
  offsetY: number; // fraction of the span box height, +up
  rotate: number; // degrees, clockwise on screen
  /** Repeat the image (true) or clamp to its edge colour (false). */
  tile: boolean;
}

/** How a colour fills an element. Gradients span the box chosen by `span`. */
export interface Fill {
  kind: FillKind;
  color: string; // used when kind = 'solid'
  gradient: Gradient; // used for every gradient kind
  angle: number; // linear / reflected / angle: degrees, 90 = top→bottom (clockwise on screen, 0 = left→right)
  /** Gradient span relative to the span box (1 = exactly the box). */
  scale: number;
  /** Shift along the gradient axis, -1..1 of the span. */
  offset: number;
  span: GradientSpan;
  /** Used when kind = 'image'. */
  image?: ImageFill;
}

// ---------- content sources ----------

/** Per-character manual adjustment (Photoshop-style per-glyph tweaks without outlining). */
export interface CharAdjust {
  dx: number; // % of size
  dy: number; // % of size, +up
  /**
   * 1 = unchanged. The glyph's advance scales with it (the line reflows, like Photoshop setting a
   * smaller point size on one character), and it sits on the baseline (horizontal) or the column
   * centre line (vertical): 約80% / 元祖…再び small–big–small on one line.
   */
  scale: number;
  /** 長体 / 平体 for this glyph on top of the source's: horizontal / vertical scale (absent = 1). */
  hScale?: number;
  vScale?: number;
  rotate: number; // degrees, clockwise on screen
  /**
   * 3D layers only (Element 3D per-character offsets): push the glyph toward the viewer
   * (% of size, +z) and tilt it around its own centre (degrees, as the layer's Transform:
   * tiltX = top toward the viewer, as rotX; tiltY = right side away from the viewer, the front
   * turning right, as rotY). The glyph, its bands and its own backplate stack
   * (grown from that glyph alone) move as one rigid solid; the other glyphs share one plate.
   * Absent = 0. 2D layers ignore them.
   */
  dz?: number;
  tiltX?: number;
  tiltY?: number;
  /**
   * Face material override for this character (split-colour words such as 激 red / アツ gold,
   * 赤文字 inside a セリフ). Rims stay continuous around the whole word. 2D layers read `face`,
   * 3D layers read `face3d`; absent = the layer's face.
   */
  face?: Material2D;
  face3d?: Material3D;
  /**
   * 3D only: this glyph's bevel band materials (index-aligned with `style3d.bands`; a missing
   * entry = the layer's band) and side material, so a white 元祖 loses the gold bands too.
   */
  bands3d?: (Material3D | null)[];
  side3d?: Material3D;
}

/** Per-line adjustment (a small 超 over a big 激アツ): keyed by line / column index. */
export interface LineAdjust {
  /** Size multiplier for this line's glyphs (1 = unchanged); line spacing follows the scaled size. */
  scale: number;
  dx: number; // % of size
  dy: number; // % of size, +up
  /** 長体 / 平体 for this line on top of the source's (absent = 1). */
  hScale?: number;
  vScale?: number;
}

export interface TextSource {
  kind: 'text';
  text: string; // may contain '\n'
  fontId: string; // font registry id (src/assets/registry.ts)
  size: number; // em size in comp px
  tracking: number; // thousandths of an em added between characters (Photoshop/AE "tracking")
  lineHeight: number; // multiple of size
  align: 'start' | 'center' | 'end'; // per line (per column when vertical)
  vertical: boolean; // 縦書き: columns top→bottom, right→left; uses the font's 'vert' glyphs
  /** Faux italic shear in degrees (positive leans right), applied around the block centre. */
  shear: number;
  /** Keyed by character index in Array.from(text) (code points, '\n' included). */
  chars: Record<number, CharAdjust>;
  /** Keyed by line index (0 = first line / rightmost column); absent = unchanged. */
  lines: Record<number, LineAdjust>;
  /**
   * 長体 / 平体 (condensed / expanded type): horizontal and vertical glyph scale, 1 = unchanged.
   * Advances and line spacing follow, so the block reflows like Photoshop's character scale.
   */
  hScale: number;
  vScale: number;
  /**
   * Proportional spacing (詰め) 0..1: 0 = full-width advances; 1 = fully proportional — the font's
   * 'palt' / 'vpal' GPOS values when it has them, else advances fitted to the glyph's ink box.
   * Applies to kana, CJK punctuation and full-width symbols; Latin keeps its own metrics.
   */
  tsume: number;
  /** 縦中横: in vertical text, runs of 1–3 half-width characters (×3, !!, 50) set upright across the column. */
  tateChuYoko: boolean;
}

export interface SvgSource {
  kind: 'svg';
  assetId: string; // asset data is SVG text
  size: number; // px; fitted so the larger side equals this
}

export interface ImageSource {
  kind: 'image';
  assetId: string; // asset data is an image blob
  size: number; // px; fitted so the larger side equals this
  /**
   * How the image's alpha becomes an outline where one is needed (3D extrusion / inflate,
   * backplates and bevels grown from the silhouette; Element 3D-style "extrude a logo PNG").
   * 2D layers keep using the alpha directly and ignore it.
   */
  trace: ImageTrace;
}

export interface ImageTrace {
  /** Alpha (0..255) at which the outline is drawn: pixels at or above it are inside. */
  threshold: number;
  /** Corner smoothing of the traced outline, % of size (0 = follows the pixels exactly). */
  smooth: number;
  /** Holes and specks smaller than this area (% of size², squared units) are dropped. */
  despeckle: number;
}

export interface ModelSource {
  kind: 'model';
  assetId: string; // asset data is GLB
  size: number; // px; bounding box fitted so the larger side equals this
}

/** Built-in parametric shapes (plates まくら, bands 帯, cut-in frames, starbursts, 保留 orbs, セリフ枠). */
export type ShapeKind =
  | 'rect' // rounded rectangle / capsule plate (corner)
  | 'parallelogram' // slanted band / cut-in frame (slant, corner)
  | 'ellipse' // circle / badge (flat disc in 3D, extruded like any outline)
  | 'orb' // 保留 orb: a circle in 2D; a true sphere (ellipsoid when aspect ≠ 1) in 3D
  | 'polygon' // regular polygon: hexagon, octagon… (points = sides, corner)
  | 'star' // regular star (points, inner)
  | 'burst' // ギザギザ starburst / explosion plate (points, inner, jitter, seed)
  | 'shield' // emblem shield (corner)
  | 'speech' // rounded speech bubble with a tail (corner, tail)
  | 'shout' // jagged shout bubble with a tail (points, inner, jitter, seed, tail)
  | 'ribbon'; // banner with notched, folded-back ends (inner = notch depth, tail.x = fold length)

/**
 * A vector shape used as a title source; it gets the full 2D material / rim stack or the 3D
 * extrusion exactly like text. Geometry lives in the same y-up layer space as text, centred.
 */
export interface ShapeSource {
  kind: 'shape';
  shape: ShapeKind;
  /** Shape height in comp px; the reference size for size-relative style units (like a font em). */
  size: number;
  /** Width / height. */
  aspect: number;
  /** Corner radius, % of size (rect, parallelogram, polygon, shield, speech). */
  corner: number;
  /** Lean in degrees, positive leans right (parallelogram, ribbon). */
  slant: number;
  /** Spike count (star, burst, shout) or side count (polygon). */
  points: number;
  /** Inner radius ratio 0..1 (star, burst, shout); ribbon: notch depth 0..1 of the end height. */
  inner: number;
  /** Random spike variation 0..1 (burst, shout). */
  jitter: number;
  seed: number;
  /**
   * speech/shout: tail tip relative to the shape centre (x, y in % of size, +y up) and tail base
   * width (% of size). ribbon: x = folded-end length (% of size); y, width unused.
   */
  tail: { x: number; y: number; width: number };
}

/**
 * Photoshop "Warp Text" applied to the source outlines (text and shape sources only) before
 * rims / bevels / extrusion, so ring widths stay even. bend and distortions are -100..100 (%);
 * horizontal / vertical distortion is the perspective-like taper (パース).
 */
export type WarpStyle =
  | 'none'
  | 'arc'
  | 'arcLower'
  | 'arcUpper'
  | 'arch'
  | 'bulge'
  | 'shellLower'
  | 'shellUpper'
  | 'flag'
  | 'wave'
  | 'fish'
  | 'rise'
  | 'fisheye'
  | 'inflate'
  | 'squeeze'
  | 'twist';

export interface Warp {
  style: WarpStyle;
  bend: number;
  horizontal: number;
  vertical: number;
}

/** A 2D offset. */
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Free distort (Photoshop Edit ▸ Transform ▸ Perspective / Distort, Kittl mesh warp), applied to
 * the outlines AFTER warp and BEFORE weight / rims / bevels / extrusion, so ring widths stay even.
 * Offsets are fractions of the undistorted frame box (x of its width, y of its height, +y up).
 * - 'corners': a projective map moving the 4 frame corners, ordered TL, TR, BR, BL.
 * - 'mesh': a bicubic Bézier patch whose 16 control points (row-major from the top-left, 4×4)
 *   start evenly spaced over the frame and are moved by `mesh[i]`.
 */
export interface Distort {
  mode: 'none' | 'corners' | 'mesh';
  corners: [Vec2, Vec2, Vec2, Vec2];
  mesh: Vec2[]; // length 16
}

/**
 * Base outline a rim / backplate grows from (北斗 / カバネリ one-piece plates):
 * - 'contour': the element outline itself (follows every glyph bump); `close` > 0 first grows the
 *   outline by `close` and shrinks it back (morphological closing), bridging gaps between glyphs
 *   and filling notches narrower than ~2 × close;
 * - 'hull': the convex hull of the whole element;
 * - 'box': a box around the element with chamfered corners (`corner`), leaning by `slant` degrees
 *   (positive leans right; add the text shear to follow italic titles).
 * The rim's own width / grow is then added on top of that base.
 */
export interface PlateShape {
  kind: 'contour' | 'hull' | 'box';
  close: number; // % of size, contour only
  corner: number; // % of size, box only
  slant: number; // degrees, box only
}

// ---------- patterns (柄) ----------

/**
 * Procedural pattern drawn over a material: maker patterns (zebra, giraffe, leopard, tiger,
 * checker, hazard "DANGER" stripes, sakura) and 和柄 (seigaiha 青海波, asanoha 麻の葉, shippo 七宝,
 * kikko 亀甲, uroko 鱗). The same GLSL drives 2D and 3D (src/engine/patterns.ts).
 */
export type PatternKind =
  | 'none'
  | 'zebra'
  | 'tiger'
  | 'giraffe'
  | 'leopard'
  | 'checker'
  | 'hazard'
  | 'stripes'
  | 'dots'
  | 'sakura'
  | 'seigaiha'
  | 'asanoha'
  | 'shippo'
  | 'kikko'
  | 'uroko'
  /** A tileable imported image (machine-specific 激アツ柄); its luminance is the mark mask, so colourways recolour it. */
  | 'custom';

export interface Pattern {
  kind: PatternKind;
  /** Colour of the marks (stripes, patches, spots, lines, petals). */
  color: string;
  /** Secondary colour: leopard spot centres, sakura centres, checker/hazard alternate cells. */
  color2: string;
  /** 0..1 */
  opacity: number;
  /** Motif size, % of size. */
  scale: number;
  /** Degrees, clockwise on screen. */
  angle: number;
  seed: number;
  /** kind = 'custom': tileable image asset; tiled at `scale` % of size per tile. */
  assetId?: string;
  /** 0..1: how much of the material's bevel lighting / reflections still shows on the marks. */
  shade: number;
  /** 0..1: marks are raised into the surface (2D: added to the bevel height; 3D: normal bump). */
  relief: number;
}

// ---------- 2D title style (Eye Candy / Photoshop layer-style replacement) ----------

export type BevelProfile2D = 'smooth' | 'button' | 'mesa' | 'chamfer' | 'ridge' | 'cove' | 'stepped' | 'custom';

/** Photoshop "gloss contour" equivalent: remaps the lit surface for metallic banding. */
export type GlossContour = 'linear' | 'ring' | 'doubleRing' | 'cove' | 'roundedSteps' | 'sawtooth' | 'custom';

/**
 * Photoshop-style contour / curve: output y for input x, both 0..1. Points are sorted by x and
 * always include x = 0 and x = 1. Smooth points interpolate with a monotone cubic; `corner`
 * points make a sharp kink (Photoshop's "Corner" checkbox). Renderers bake it to a 256-entry LUT.
 */
export interface CurvePoint {
  x: number;
  y: number;
  corner: boolean;
}

export interface Curve {
  points: CurvePoint[];
}

export interface Bevel2D {
  enabled: boolean;
  profile: BevelProfile2D;
  /** Height profile across the bevel when `profile` = 'custom': x = 0 at the edge → 1 at `size` inside; y = height. */
  profileCurve: Curve;
  size: number; // % of size — how far the bevel reaches in from the element edge (sizeMode 'fixed')
  /**
   * Eye Candy スケーリング モード: 'fixed' (固定) reaches `size` in everywhere; 'fit' (適合) reaches
   * `fit` % of the LOCAL half-thickness (the largest inscribed circle covering each pixel), so thin
   * and thick strokes alike dome to their centre line; a rim fits across its own band (a tube).
   */
  sizeMode: 'fixed' | 'fit';
  fit: number; // % of the local half-thickness (sizeMode 'fit')
  depth: number; // 0..10 strength (Photoshop depth / 100)
  soften: number; // % of size — smoothing of the height field
  /** Photoshop convention: direction the light comes FROM, degrees counter-clockwise from +x; 120 = upper-left. */
  lightAngle: number;
  lightAltitude: number; // degrees 0..90
  /** Photoshop "Use Global Light": take angle / altitude from `comp.globalLight` instead. */
  useGlobalLight: boolean;
  gloss: GlossContour;
  /** Gloss contour used when `gloss` = 'custom'. */
  glossCurve: Curve;
  highlightColor: string;
  highlightOpacity: number; // 0..1, screen-blended
  shadowColor: string;
  shadowOpacity: number; // 0..1, multiply-blended
}

/** Gradient-map metal finish: luminance of the shaded element is mapped through a ramp. */
export interface Finish2D {
  enabled: boolean;
  gradient: Gradient; // dark → light ramp (e.g. gold ramp)
  amount: number; // 0..1 mix with the unmapped result
}

export type Texture2DKind =
  | 'none'
  | 'noise'
  | 'sparkle'
  | 'brushed'
  | 'hairline'
  | 'spun'
  | 'flakes'
  | 'ripple'
  | 'grunge'
  | 'clouds'
  | 'hammered'
  | 'crumple'
  | 'liquid';

export interface Texture2D {
  kind: Texture2DKind;
  amount: number; // 0..1
  scale: number; // % of size (feature size)
  blend: 'overlay' | 'softLight' | 'screen' | 'multiply';
  seed: number;
  /**
   * 'color': blended over the lit colour (current behaviour). 'surface': the texture's height is
   * added to the bevel height field BEFORE lighting / gloss contour / finish ramp, so metal
   * bands bend into crumpled-foil or liquid-gold reflections; `blend` is then ignored.
   */
  target: 'color' | 'surface';
  /** Degrees, counter-clockwise on screen: direction of the brushed / hairline grain (0 = horizontal); turns every kind. */
  angle: number;
}

/**
 * Anisotropic metal sheen (the old Metal Texture effect's highlight): a bright band across the
 * element perpendicular to the texture's grain direction (`texture.angle`), shaped by the
 * texture kind: brushed / hairline and the rest a soft band, 'spun' a pair of radial lobes
 * around the element centre, 'flakes' facets catching the light. Modulated by the grain.
 */
export interface Sheen2D {
  enabled: boolean;
  color: string;
  amount: number; // 0..3
  /** −1..1: where the band sits across the element (spun / flakes: turns the lobes / light). */
  position: number;
  /** 0.05..2: band width as a share of the element half-size (spun: lobe width, flakes: facet spread). */
  width: number;
}

/**
 * Coloured glass body (the old Glass effect): what is seen through the element (its fill, or for
 * a Material effect the layer's own pixels, bent by `Material2D.refraction`) takes the glass
 * colour, deepens like thick glass, darkens on steep slopes (Fresnel rim), and light entering on
 * the lit side focuses into a caustic band inside the far edge. The body is `opacity` opaque;
 * rims, caustics and the bevel highlight stay more opaque.
 */
export interface Glass2D {
  enabled: boolean;
  color: string;
  tint: number; // 0..1 how much the glass colour replaces what is seen through it
  opacity: number; // 0..1 body opacity
  edge: number; // 0..1 Fresnel rim darkening
  caustic: number; // 0..2 caustic band + inner body glow
}

export interface InnerGlow2D {
  enabled: boolean;
  color: string;
  size: number; // % of size
  opacity: number; // 0..1
  noise: number; // 0..1 grit (the "ジャリジャリ" sparkle)
}

/** Glossy cap: a soft white band over the upper part of the element (艶 highlight). */
export interface Gloss2D {
  enabled: boolean;
  opacity: number; // 0..1
  position: number; // 0..1 fraction of element height from the top where the band ends
  softness: number; // 0..1
  curve: number; // -1..1 bend of the band edge (0 = straight, >0 arcs downward in the middle)
  /** Tilt of the band, degrees clockwise on screen (0 = horizontal; ~-25 = the 北斗 diagonal streak). */
  angle: number;
}

/**
 * Photoshop Satin: the element's own silhouette, offset by ±`distance` along `angle` and
 * blurred by `size`; the absolute difference of the two copies (through `contour`, optionally
 * inverted) is blended over the element in `color`. Gives the inner liquid-metal sheen.
 */
export interface Satin2D {
  enabled: boolean;
  color: string;
  blend: 'normal' | 'multiply' | 'screen' | 'overlay';
  opacity: number; // 0..1
  angle: number; // degrees, Photoshop convention (counter-clockwise from +x)
  /** Take `angle` from `comp.globalLight` instead. */
  useGlobalLight: boolean;
  distance: number; // % of size
  size: number; // % of size (blur)
  contour: Curve;
  invert: boolean;
}

/** Reflection panoramas of `Reflection2D` (Eye Candy's 反射イメージ categories): tone-mapped Poly Haven photos in public/reflections. */
export type ReflectionMap2D = 'highway' | 'city' | 'sky' | 'studio';

/**
 * Environment reflection map (Eye Candy Bevel / Chrome 反射イメージ): the bevel's surface normal
 * mirrors the view into a photographic panorama (sky above the horizon, ground below, the centre
 * straight back at the viewer, so flat areas show the horizon), blurred by `blur`. It replaces
 * the fill by `amount` BEFORE the bevel highlight / shadow, finish ramp and the rest, so slopes
 * facing up reflect sky and slopes facing down reflect the ground, steady on screen when the
 * layer turns.
 */
export interface Reflection2D {
  enabled: boolean;
  map: ReflectionMap2D;
  amount: number; // 0..1
  blur: number; // 0..100 (Eye Candy's ぼかし)
  /** Turns the panorama about the vertical axis, degrees (slides the reflections sideways). */
  rotation: number;
  /** 0..1: keep the fill's colour as coloured glass (dark reflections deepen it, the brightest run to white). */
  colorize: number;
}

export interface Material2D {
  fill: Fill;
  /**
   * Photoshop "Fill Opacity" 0..1: scales the element's own fill + shading while elements behind it
   * still show through (rims under a 0.2 face = hollow glass). Effects still see the full shape.
   */
  opacity: number;
  bevel: Bevel2D;
  /** Environment reflection map, mirrored by the bevel normals (2D chrome). */
  reflection: Reflection2D;
  finish: Finish2D;
  /** Pattern marks over the metal finish (柄 colourways and looks), under the satin / texture / inner glow / gloss. */
  pattern: Pattern;
  satin: Satin2D;
  texture: Texture2D;
  innerGlow: InnerGlow2D;
  gloss: Gloss2D;
  /**
   * Lens bend, % of size (0 = off): the bevel slopes (and surface textures) shift where the fill
   * is read, like light refracting through a dome, so a gradient fill's horizon waves along the
   * bevel (liquid chrome) and glass bends what is behind it.
   */
  refraction: number;
  glass: Glass2D;
  sheen: Sheen2D;
  /**
   * Linked material id (Project.materialLinks): every material of the same kind with this id is the
   * same material, kept equal by the store (src/model/links.ts). Absent = unlinked. Renderers ignore it.
   */
  link?: string;
}

/**
 * One outline ring (縁取り / 外枠) behind the face. Rims are listed INNERMOST FIRST; rim k's
 * outline is the face outline grown by the SUM of widths of rims 0..k, so each rim shows
 * as a band of its own width. Drawn outermost (back) first.
 */
export interface Rim2D {
  id: string;
  enabled: boolean;
  width: number; // % of size
  join: 'miter' | 'round' | 'bevel';
  /** Fill the counters (holes of 口, B, O…) so the rim is a solid plate. */
  fillCounters: boolean;
  /** Base outline the rim grows from (contour / hull / slanted box); see PlateShape. */
  plate: PlateShape;
  /** Drop the rim down/right to make a "seated" base (% of size, +y down on screen). */
  offsetX: number;
  offsetY: number;
  material: Material2D;
}

/**
 * かすれ / distressed edges (brush-kanji titles): directional streak noise thresholded inside a band
 * along the OUTER silhouette, cutting the face and every rim coherently (same mask for all).
 */
export interface Erode2D {
  enabled: boolean;
  amount: number; // 0..1, how much of the edge band is eaten
  /** Width of the affected band inward from the outer silhouette, % of size. */
  edge: number;
  /** Streak length, % of size (dry-brush drag marks). */
  scale: number;
  /** Streak direction, degrees clockwise on screen (0 = horizontal drag). */
  angle: number;
  seed: number;
}

export interface TitleStyle2D {
  face: Material2D;
  rims: Rim2D[];
  /**
   * Knockout (Photoshop "Knockout: Shallow"): the face area punches through every rim to full
   * transparency, leaving only the outline rings (hollow neon tubes, 狙え).
   */
  knockout: boolean;
  erode: Erode2D;
  /**
   * Export part split only (src/io/psd.ts builds temporary copies with it; never saved by the UI):
   * skip shading the face element. Rims still grow from the source outline.
   */
  hideFace?: boolean;
}

// ---------- 3D title style (Element 3D replacement) ----------

export type MaterialPreset =
  | 'custom'
  | 'gold'
  | 'punchyGold'
  | 'paleGold'
  | 'roseGold'
  | 'chrome'
  | 'silver'
  | 'copper'
  | 'redMetal'
  | 'blueMetal'
  | 'greenMetal'
  | 'purpleMetal'
  | 'blackGloss'
  | 'whiteGloss'
  | 'rainbow'
  | 'glass'
  | 'plastic'
  | 'emissive'
  | 'candy'
  | 'diamond'
  | 'ruby'
  | 'sapphire'
  | 'emerald';

export interface Material3D {
  preset: MaterialPreset;
  color: string;
  /** Optional colour gradient across the part (in layer space). Overrides `color` when set. */
  gradient?: Gradient;
  gradientKind: 'linear' | 'radial' | 'reflected';
  gradientAngle: number; // degrees, 90 = top→bottom on screen (linear / reflected)
  /** Same meaning as Fill.span; 'line' / 'char' use the glyph boxes recorded at extrusion. */
  gradientSpan: GradientSpan;
  /** Same meaning as Fill.scale / Fill.offset. */
  gradientScale: number;
  gradientOffset: number;
  /**
   * 'xy': the gradient runs across the layer plane (gradientKind / angle / span apply).
   * 'depth': it runs front → back along the extrusion (stop 0 at the part's front z, stop 1 at its
   * back), so side walls fade red → black with depth; kind / angle / span are ignored.
   */
  gradientAxis: 'xy' | 'depth';
  /**
   * -1..1: the ramp bends with the surface like light refracted through a dome (xy axis only):
   * slopes facing along the ramp see further along it, slopes facing back see back toward its
   * start, and edges turned away see back toward the start, so a band glows as a core inside
   * its neighbour instead of a flat stripe. 0 = flat in the layer plane.
   */
  gradientBend: number;
  metalness: number; // 0..1
  roughness: number; // 0..1
  /** Element 3D "Environment Multiplier": scales image-based reflections. 1 = physical, up to 4. */
  reflectivity: number; // 0..4
  /** Element 3D "Specular Multiplier": scales direct-light highlights. 1 = physical, up to 4. */
  specBoost: number; // 0..4
  clearcoat: number; // 0..1
  iridescence: number; // 0..1
  /** Gem / glass body: transmission 0..1, index of refraction 1..2.333, dispersion 0..1 (fire). */
  transmission: number;
  ior: number;
  dispersion: number;
  /**
   * Coloured-glass depth 0..1 (absorption): the base colour deepens, saturates and darkens where
   * the surface turns away from the viewer (a longer path through the glass) and clears in the
   * facing core, so a dome of candy glass reads thick instead of flat.
   */
  glassDepth: number;
  /** Metallic glitter flakes (normal-map sparkle): strength 0..1 and flake size % of size. */
  flakes: number;
  flakeScale: number;
  /** Pattern colour overlay and / or relief bump, projected front-on in layer space. */
  pattern: Pattern;
  /** Surface normal perturbation (crumpled foil, hammered, liquid gold), projected front-on. */
  surface: Surface3D;
  emissive: string;
  emissiveIntensity: number;
  opacity: number; // 0..1
  /**
   * The environment values this part sets itself (preset, intensity, rotation, grade, blur,
   * repeat); every absent one comes from its layer (model/lighting.ts): a candy face can mirror
   * softbox windows while its gold rims mirror a contrasty street. `{}` = all the layer's. Lights
   * and tone mapping are always the layer's.
   */
  environment: EnvironmentOverrides;
  /** Linked material id, as Material2D.link (3D materials link only with 3D ones). */
  link?: string;
}

/** Large-scale normal perturbation: bends reflections the way 2D `Texture2D.target = 'surface'` does. */
export interface Surface3D {
  kind: 'none' | 'crumple' | 'hammered' | 'liquid';
  amount: number; // 0..1 normal strength
  scale: number; // % of size, feature size
  seed: number;
}

export type BevelProfile3D = 'flat' | 'round' | 'chamfer' | 'cove' | 'step' | 'inset' | 'tube';

/** Cross-section of one bevel (Element 3D Bevel Segments / Bevel Curve). */
export interface BevelShape3D {
  width: number; // % of size, extent in the outline plane (direction: Title3DProps.bevelPosition)
  depth: number; // % of size, extent in z
  profile: BevelProfile3D;
  /** Facets for curved profiles (round / cove / step), 1..24. Generators may add more at large export scales. */
  segments: number;
  /** -1..1 exponent bend of the profile: 0 = as designed, >0 fuller / rounder, <0 pinched toward a cove. */
  curve: number;
}

/**
 * A ring of the bevel. Bands run from the face edge outward to the side wall, so a single
 * extrusion can show the multi-outline look (e.g. gold face, white band, red band). Where the
 * stack sits relative to the glyph outline is Title3DProps.bevelPosition: grown outward from it
 * like a stroke, or cut inward (Element 3D: the silhouette stays the glyph outline, the face is
 * inset by the total band width, thin strokes narrow the bevel and counters stay open).
 */
export interface BevelBand3D extends BevelShape3D {
  id: string;
  material: Material3D;
}

/**
 * Backplate (Element 3D under-plate / 外枠 in 3D): the text outline grown by `grow`, counters
 * optionally filled, extruded as a separate solid behind the main extrusion. Listed innermost
 * first; plate k grows by the SUM of `grow` of plates 0..k.
 */
export interface Backplate3D {
  id: string;
  enabled: boolean;
  grow: number; // % of size
  join: 'miter' | 'round';
  fillCounters: boolean;
  /** Base outline the plate grows from (contour / hull / slanted box); see PlateShape. */
  plate: PlateShape;
  depth: number; // % of size
  /** Gap behind the previous solid (% of size). */
  zGap: number;
  bevel: BevelShape3D;
  face: Material3D;
  side: Material3D;
}

/** Shadow catcher (Element 3D "Matte Shadow"): an invisible plane that only receives the title's shadow. */
export interface Shadow3D {
  enabled: boolean;
  /** Shadow tint (遊技機 practice: coloured, not black). */
  color: string;
  opacity: number; // 0..1
  softness: number; // 0..1
}

/**
 * Glint / bloom keyed to the 3D render's HDR specular highlights (before tone mapping), with
 * optional star streaks (Blender Glare "Streaks" / "Simple Star"). Alpha-preserving.
 */
export interface Glint3D {
  enabled: boolean;
  /** Linear HDR luminance above which pixels glint (≈1 = only highlights brighter than white). */
  threshold: number;
  intensity: number; // 0..4
  /** Bloom radius, % of size. */
  radius: number;
  /** Streak count: 0 = bloom only, else 2, 4, 6 or 8. */
  streaks: number;
  /** Streak length, % of size. */
  length: number;
  /** Streak rotation, degrees. */
  angle: number;
  tint: string;
}

/** Ambient occlusion on the 3D render (Element 3D SSAO): darkens crevices between bands and plates. */
export interface AO3D {
  enabled: boolean;
  /** Sample radius, % of size. */
  radius: number;
  intensity: number; // 0..2
}

export interface Title3DProps {
  /**
   * 'extrude': straight extrusion with bevel bands (Element 3D). 'inflate': a puffy height field
   * built from the outline's distance field (Illustrator 3D Inflate / ぷっくり buttons): the front
   * rises by `inflate.height` following `inflate.profile` (x = distance from the edge / max inset,
   * y = height), the back is flat; bands are ignored, backplates and side still apply.
   * `inflate.smoothness` (0..100, Eye Candy's 滑らかさ): 0 shades the mesh's own facets; above 0
   * the shading follows the exact profile slope (no facet ripples on mirror finishes) and the
   * ridges along the middle of every stroke round off more as it grows. `inflate.detail` (1..4)
   * multiplies the height grid's density (12 nodes across the widest inset at 1), so the crisp
   * ridges of a chiselled profile run straight instead of zigzagging along the grid.
   */
  mode: 'extrude' | 'inflate';
  inflate: { height: number; profile: Curve; smoothness: number; detail: number }; // height: % of size
  depth: number; // % of size — straight side-wall depth of the main extrusion
  curveSegments: number;
  /**
   * Counter-rotate the environment with the layer's own rotX / rotY, so reflections stay as they
   * look head-on when the title is tilted (tilted gold stays bright instead of mirroring dim sky).
   */
  envLock: boolean;
  /**
   * Oblique extrusion (飛び出し / LUSTR 押し出し角度): the back of every solid is shifted by
   * `skew` × its z distance from the front face, so the side walls show head-on. x = right,
   * y = up, in units of depth (0 = straight back; 0.5 = the back moves half the depth).
   */
  skew: { x: number; y: number };
  face: Material3D;
  /**
   * Image sources only: how much of the picture shows on the front face (0..1), projected
   * straight on and lit by the face material (1 = the image's own colours as the base colour,
   * 0 = the face material alone). Other sources ignore it.
   */
  faceImage: number;
  /**
   * Image sources only: how much of the picture shows on the bevel bands and side walls (0..1),
   * projected straight on like the face, so each edge takes the colour of the image at that
   * point of the outline (Element 3D-style extruded logo). Other sources ignore it.
   */
  edgeImage: number;
  bands: BevelBand3D[]; // face edge → side; empty = no bevel
  /**
   * Where the bevel bands sit relative to the glyph outline, like Photoshop's Stroke Position.
   * 'outside': bands grow outward, the face keeps the full glyph shape and widening a band
   * fattens the silhouette; 'inside': bands are cut inward from the outline (Element 3D), the
   * silhouette stays put and widening a band shrinks the face; 'center': half each way.
   * Backplates grow from the outermost band edge, so they never overlap the bands.
   */
  bevelPosition: 'outside' | 'center' | 'inside';
  side: Material3D;
  backplates: Backplate3D[];
  shadow: Shadow3D;
  glint: Glint3D;
  ao: AO3D;
  /**
   * The lighting values this layer sets itself (Element 3D: every layer has its own environment);
   * every absent one comes from the comp (Document properties), see model/lighting.ts.
   * `{ environment: {} }` = all the document's. Applying a 3D look sets all of them, so one
   * layer's look never changes another layer.
   */
  lighting: LightingOverrides;
}

/** Environment, lights and tone mapping a 3D layer renders with (same meaning as the Comp fields): the resolved values. */
export type Lighting3D = Pick<Comp, 'environment' | 'lights' | 'toneMapping' | 'exposure'>;

/** A 3D environment's values (Comp.environment). */
export type Environment3D = Comp['environment'];

/**
 * Environment values a 3D layer or part sets itself, each on its own; absent = inherited (part ←
 * layer ← document). `preset` and `customAssetId` are one value: setting the preset also sets
 * which custom HDR it uses (none when absent), and `customAssetId` without `preset` is ignored.
 */
export type EnvironmentOverrides = Partial<Environment3D>;

/** Lighting values a 3D layer sets itself; absent = the document's. `lights` is one value: the whole list. */
export interface LightingOverrides {
  environment: EnvironmentOverrides;
  toneMapping?: Comp['toneMapping'];
  exposure?: number;
  lights?: Light3D[];
}

// ---------- layers ----------

interface LayerBase {
  id: string;
  name: string;
  visible: boolean;
  solo: boolean;
  locked: boolean;
  /** Guide layer (like AE guide layers): visible in the editor, excluded from exports. */
  guide: boolean;
  blend: BlendMode;
  transform: Transform;
  effects: EffectInstance[]; // applied in comp space after the layer is drawn
  /**
   * Photoshop clipping mask (⌥⌘G): the layer only shows inside the content (alpha, before the
   * base's own effects) of its clip base — the nearest layer BELOW it with the same parent that
   * is not clipped itself. Clipped layers composite onto the base in stack order with their own
   * blend / opacity / effects; the base's effects apply to the base only. A clipped adjustment
   * layer adjusts only its clip group. Ignored when there is no base (bottom of its parent).
   */
  clip: boolean;
  /**
   * Id of the GroupLayer this layer belongs to (absent = top level). Groups nest to any depth.
   * Every group's whole subtree sits contiguously DIRECTLY BELOW the group in `Project.layers`
   * (lower indexes), in stack order; `parentId` always names an existing group.
   */
  parentId?: string;
  /**
   * Layer masks (Photoshop vector / gradient masks, After Effects track mattes), multiplied
   * together in list order: the layer shows where every enabled mask is opaque. See LayerMask.
   * Empty = unmasked.
   */
  masks: LayerMask[];
}

interface MaskBase {
  id: string;
  enabled: boolean;
  /** Swap shown and hidden areas (Photoshop Invert / mask subtract). */
  invert: boolean;
  /** Edge softness: Gaussian feather radius, comp px. */
  feather: number;
  /** How strongly the mask hides, 0..1 (Photoshop Density): 0.5 = hidden areas still show at 50 %. */
  density: number;
  /**
   * Linked (Photoshop's chain icon): the mask is placed in the layer's own space and moves,
   * turns and scales with it. Unlinked: placed in comp space, the layer moves under it.
   * Coordinates below are comp px in that space (origin = layer position or comp centre, +y up).
   */
  linked: boolean;
}

/** Shape mask (vector mask): a parametric shape placed at `x` / `y`, turned by `rotation` (degrees, clockwise). */
export interface ShapeMask extends MaskBase {
  kind: 'shape';
  source: ShapeSource;
  x: number;
  y: number;
  rotation: number;
}

/**
 * Gradient mask (a black-to-white gradient painted on a Photoshop layer mask): opaque at the
 * start point, transparent at the end point, along `mid` (0..1, where it is half transparent).
 * Linear: from (x, y) for `length` comp px toward `angle` (degrees, counter-clockwise from +x).
 * Radial: opaque inside `length` × `inner` around (x, y), transparent at `length`.
 */
export interface GradientMask extends MaskBase {
  kind: 'gradient';
  shape: 'linear' | 'radial';
  x: number;
  y: number;
  angle: number;
  length: number;
  /** Radial only: share of `length` that stays fully opaque, 0..1. */
  inner: number;
  mid: number;
}

/**
 * Layer mask from another layer (After Effects track matte): that layer drawn alone, with its
 * effects, in comp space, used by alpha or by luminance (× alpha). Always comp space (`linked`
 * is ignored). The source layer still draws normally unless the user hides it.
 */
export interface LayerSourceMask extends MaskBase {
  kind: 'layer';
  layerId: string;
  channel: 'alpha' | 'luminance';
}

export type LayerMask = ShapeMask | GradientMask | LayerSourceMask;

/**
 * A part of a title's style that can carry its own effects (an Outer Glow on the outermost rim
 * only, an Inner Shadow on the face only). 2D: 'face' and `rim:<Rim2D.id>`. 3D: 'face',
 * `band:<BevelBand3D.id>`, 'side' and `plate:<Backplate3D.id>`. See src/model/parts.ts.
 */
export type PartKey = 'face' | 'side' | `rim:${string}` | `band:${string}` | `plate:${string}`;

/** Effects per style part, run on that part's own pixels before the layer effects. Keys of parts that no longer exist are dropped by normalisation. */
export type PartEffects = Partial<Record<PartKey, EffectInstance[]>>;

/** Outline operations shared by text and shape sources, applied after warp and before rims / bevels / extrusion. */
interface OutlineOps {
  warp: Warp;
  distort: Distort;
  /**
   * Face weight ± (Illustrator Offset Path on the glyphs): % of size, >0 fattens (counters
   * shrink), <0 thins. Rims, bevels and extrusion grow from the offset outline.
   */
  weight: number;
}

export interface Title2DLayer extends LayerBase, OutlineOps {
  kind: 'title2d';
  source: TextSource | ShapeSource | SvgSource | ImageSource;
  style: TitleStyle2D;
  partEffects: PartEffects;
}

export interface Title3DLayer extends LayerBase, OutlineOps {
  kind: 'title3d';
  source: TextSource | ShapeSource | SvgSource | ImageSource | ModelSource;
  style3d: Title3DProps;
  partEffects: PartEffects;
}

/** Full-comp background (solid / gradient) — handy for mockups; effects can add rays etc. */
export interface BackgroundLayer extends LayerBase {
  kind: 'background';
  fill: Fill;
}

/**
 * Photoshop layer group (⌘G): its members (see LayerBase.parentId) are composited together
 * (isolated, like a PS group set to Normal), adjustment layers inside it adjust only the members
 * below them, then the group's effects run on that composite (one glow around burst + text), then
 * the composite is drawn with the group's blend and `transform.opacity`. The group's other
 * transform fields are unused by the renderer; moving / scaling a group edits its members.
 */
export interface GroupLayer extends LayerBase {
  kind: 'group';
  /** Layer panel only: members hidden in the list. */
  collapsed: boolean;
  /**
   * Made to hold layer `companionGroupOf` (or such a group) with its companions (GeneratorLayer.
   * companionOf): when replacing them leaves it holding just that one member with nothing of its
   * own, it is dissolved again (dissolveCompanionGroups). Absent = the user's own group.
   */
  companionGroupOf?: string;
}

/** Levels for one channel (Photoshop Levels): input black / white points and gamma, output range. Values 0..255 like PS. */
export interface LevelsChannel {
  inBlack: number; // 0..253
  inWhite: number; // 2..255
  gamma: number; // 0.01..9.99, 1 = linear
  outBlack: number; // 0..255
  outWhite: number; // 0..255
}

export type AdjustChannel = 'rgb' | 'r' | 'g' | 'b';

/** Shadow / midtone / highlight shift of Color Balance: cyan↔red, magenta↔green, yellow↔blue, each -100..100. */
export interface ColorBalanceRange {
  cyanRed: number;
  magentaGreen: number;
  yellowBlue: number;
}

/**
 * Photoshop adjustment-layer operations. They work like Photoshop's, on sRGB-encoded straight
 * colour of the composite below (not on the linear working values), and keep its alpha.
 */
export type Adjustment =
  | { type: 'brightnessContrast'; brightness: number /* -150..150 */; contrast: number /* -50..100 */ }
  | { type: 'levels'; channels: Record<AdjustChannel, LevelsChannel> }
  | { type: 'curves'; channels: Record<AdjustChannel, Curve> }
  | { type: 'exposure'; exposure: number /* stops, -20..20 */; offset: number /* -0.5..0.5 */; gamma: number /* 0.01..9.99 */ }
  | { type: 'vibrance'; vibrance: number /* -100..100 */; saturation: number /* -100..100 */ }
  | { type: 'hueSaturation'; hue: number /* -180..180 */; saturation: number /* -100..100 */; lightness: number /* -100..100 */; colorize: boolean }
  | { type: 'colorBalance'; shadows: ColorBalanceRange; midtones: ColorBalanceRange; highlights: ColorBalanceRange; preserveLuminosity: boolean }
  | {
      type: 'blackWhite';
      reds: number; // -200..300 (%), PS defaults 40 / 60 / 40 / 60 / 20 / 80
      yellows: number;
      greens: number;
      cyans: number;
      blues: number;
      magentas: number;
      tint: boolean;
      tintColor: string;
    }
  | { type: 'photoFilter'; color: string; density: number /* 0..100 */; preserveLuminosity: boolean }
  | { type: 'gradientMap'; gradient: Gradient; reverse: boolean }
  | { type: 'invert' }
  | { type: 'posterize'; levels: number /* 2..255 */ }
  | { type: 'threshold'; level: number /* 1..255 */ }
  /** No colour change: the layer only carries effects (After Effects adjustment layer with effects). */
  | { type: 'effectsOnly' };

export type AdjustmentType = Adjustment['type'];

/**
 * Adjustment layer (Photoshop adjustment layer + After Effects adjustment layer): changes the
 * composite of everything below it inside its parent (the whole comp below it at top level), or
 * only its clip group when `clip` is set. Draws nothing itself. Order: the adjustment, then its
 * `effects` run on that adjusted composite (Wave, Chromatic Aberration, Gaussian Blur… over all
 * the layers below at once); then `transform.opacity` and `blend` mix the result over the
 * unadjusted composite. Effects that draw outside the content (glows) draw over the whole
 * composite below, and alpha follows the effects (a blur softens the composite's edges too).
 */
export interface AdjustmentLayer extends LayerBase {
  kind: 'adjustment';
  adjustment: Adjustment;
}

/** A generator's settings: `type` names a GeneratorDef (src/generators/registry.ts); missing params take its defaults. */
export interface GeneratorInstance {
  type: string;
  params: Record<string, ParamValue>;
}

/**
 * Generator layer (Particular / 集中線 / Radio Waves style): draws procedural content on its own
 * — particle fields, speed lines, shockwave rings, light streaks, magic circles, brush swirls,
 * sunbursts, glints, fire, full-frame 柄. Its drawing is centred on the layer position (transform
 * x / y) and turned / scaled with rotZ / scale; full-frame types cover the whole comp whatever the
 * transform. A follow generator following a layer (its `follow` param) draws where that layer is,
 * its own transform an offset on top. Takes effects, clipping, blend and opacity like any layer.
 */
export interface GeneratorLayer extends LayerBase {
  kind: 'generator';
  generator: GeneratorInstance;
  /**
   * Id of the layer a look (StylePreset.companions) or "on <layer>" made this generator for:
   * applying a look to that layer replaces its companions. Absent = a layer of its own.
   */
  companionOf?: string;
}

export type Layer = Title2DLayer | Title3DLayer | BackgroundLayer | GroupLayer | AdjustmentLayer | GeneratorLayer;

// ---------- composition ----------

/** Photographic environments: the 2D reflection maps' panoramas (public/reflections) around a 3D layer. */
export type PhotoEnvPreset = 'highway' | 'city' | 'sky';

export type EnvPreset = 'studio' | 'softbox' | 'strips' | 'backlit' | 'under' | 'sunset' | 'neon' | 'gold' | 'night' | PhotoEnvPreset | 'custom';

export interface Light3D {
  id: string;
  type: 'directional' | 'point' | 'ambient';
  color: string;
  intensity: number;
  x: number;
  y: number;
  z: number;
}

export interface Comp {
  width: number;
  height: number;
  /** Exported background. Transparent by default: titles are delivered as alpha PNGs. */
  background: { transparent: boolean; color: string };
  camera: {
    fov: number; // vertical degrees
    x: number;
    y: number;
    zOffset: number; // added to the auto distance that maps z=0 to 1 unit = 1 px
    rotX: number;
    rotY: number;
    rotZ: number;
  };
  /** Photoshop Global Light: shared by bevels / satin / shadows that opt in. Angle: degrees CCW from +x (120 = upper-left). */
  globalLight: { angle: number; altitude: number };
  environment: {
    preset: EnvPreset;
    customAssetId?: string; // .hdr / image equirect when preset = 'custom'
    intensity: number;
    rotation: number; // degrees around Y — slides reflections across metal
    /** Multiplies the environment's colour (#ffffff = unchanged), like Element 3D's Tint. */
    tint: string;
    /** Element 3D Physical Environment contrast / saturation (1 = unchanged, 0..3). */
    contrast: number;
    saturation: number;
    /**
     * Element 3D environment blur, 0..1: every reflection of this environment is at least this
     * blurred (a floor on the roughness its lookups use; 1 = fully diffuse). Light highlights stay
     * as sharp as each material's own roughness. Like every environment value, a layer or part
     * that does not set its own inherits it.
     */
    blur: number;
    /**
     * Element 3D environment tiling, 0.25..8 each: repeatX wraps the panorama that many times
     * around the 360° (2 = twice, each copy in half the turn: more, narrower reflections),
     * repeatY tiles it that many times from bottom to top. Both centre on the view straight ahead.
     */
    repeatX: number;
    repeatY: number;
  };
  lights: Light3D[];
  /**
   * Tone mapping + exposure applied by 3D layer renderers to their own output. 'punch' tone-maps
   * luminance only and keeps each pixel's colour ratios, so saturated gold / red stay saturated.
   */
  toneMapping: 'none' | 'aces' | 'agx' | 'neutral' | 'punch';
  exposure: number;
  /** 3D layers render at this multiple of the output resolution and downsample (Element 3D supersampling). */
  supersample: 1 | 2 | 3;
  /** Print resolution written into PNG pHYs / PSD resolution and used for mm sizing (72 = screen). */
  dpi: number;
}

export interface Project {
  version: 9;
  name: string;
  comp: Comp;
  /** Index 0 is the BOTTOM layer; last is drawn on top. */
  layers: Layer[];
  /**
   * Names of the linked-material ids (Material2D.link / Material3D.link) in use, e.g. "Gold" for
   * the four plate materials of a rainbow glass title; '' = named after the material. Absent in files without links.
   */
  materialLinks?: Record<string, { name: string }>;
}
