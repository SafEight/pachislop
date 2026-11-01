import type { Companion } from '../generators/fromEffect';
import type { EffectInstance, Layer, Project, Title3DProps, TitleStyle2D } from '../model/types';

/**
 * Position of a style part in a look, independent of element ids: 'face', 'side', or a rim /
 * bevel band / backplate by its INDEX in the style's own list (`style.rims` and
 * `style3d.backplates` innermost first, `style3d.bands` face edge → side), e.g. 'rim:2'. A look
 * applied to a layer maps each key to the part at that position of the resulting style.
 */
export type PresetPartKey = 'face' | 'side' | `rim:${number}` | `band:${number}` | `plate:${number}`;

/**
 * A reusable look (Eye Candy "settings" / Photoshop layer style / Element 3D preset).
 * Style dimensions are size-relative already (see model/types.ts), so they transfer as-is.
 * Effect params in comp px were authored for a source of size `refSize` and are scaled by
 * (layer.source.size / refSize) when applied (params whose ParamDef unit is 'px').
 */
export interface StylePreset {
  id: string;
  name: string;
  /** Library section, e.g. 'Classic outline 縁取り', 'Gold & Metal', 'Rainbow & Special', 'Fire & Energy', '3D'. */
  group: string;
  kind: 'title2d' | 'title3d';
  style?: TitleStyle2D; // kind = 'title2d'
  /**
   * kind = 'title3d'. Its `lighting` is the look's environment, lights and tone mapping as
   * overrides that set every value: applying the look gives the layer that lighting of its own
   * and never touches the comp.
   */
  style3d?: Title3DProps;
  /**
   * Names of the material links (Material2D.link / Material3D.link) its style uses that have one
   * (a saved or copied look); unnamed links are named after their material. Applying the look gives
   * its links fresh ids on that layer (pasting a copied style keeps the project's own).
   */
  links?: NonNullable<Project['materialLinks']>;
  effects: EffectInstance[];
  /** Generators that come with the look (bottom first within each place), see Companion. */
  companions?: Companion[];
  /**
   * Effects of the group the look puts the layer and its companions in, run on them together (a
   * deep glow over the title and its fire): what the look applies after a companion. Same px /
   * handle conventions as `effects`.
   */
  groupEffects?: EffectInstance[];
  /**
   * Effects of single style parts (an Outer Glow on the outermost rim only), keyed by part
   * position; same px / handle conventions as `effects`. Keys the applied style has no part for
   * are dropped on apply.
   */
  partEffects: Partial<Record<PresetPartKey, EffectInstance[]>>;
  refSize: number;
  /** Suggested font (applied only if the user opts in / when creating a new layer). */
  fontId?: string;
  builtin: boolean;
}

/** A complete starting document ("New from template"). */
export interface Template {
  id: string;
  name: string; // e.g. '確定 (rainbow)', '激アツ (fire)'
  build(): Project;
}

/**
 * Colourways: named recolour presets that keep a layer's structure and change only its colours
 * (src/presets/colourways.ts). 柄 colourways (ゼブラ / キリン / ヒョウ) are a gold face plus pattern marks.
 */
export type Colourway = 'white' | 'blue' | 'green' | 'purple' | 'red' | 'gold' | 'silver' | 'zebra' | 'giraffe' | 'leopard' | 'rainbow';

export const COLOURWAYS: Colourway[] = ['white', 'blue', 'green', 'purple', 'red', 'gold', 'silver', 'zebra', 'giraffe', 'leopard', 'rainbow'];

/** Signatures implemented in src/presets/apply.ts and src/presets/colourways.ts. */
/** `keepLinks`: the style's material link ids stay as they are (pasting a copied style; see apply.ts). */
export type ApplyPreset = (layer: Layer, preset: StylePreset, opts: { applyFont: boolean; keepLinks?: boolean }) => Layer;
export type ApplyColourway = (layer: Layer, colourway: Colourway) => Layer;
