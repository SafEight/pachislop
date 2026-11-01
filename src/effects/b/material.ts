import * as THREE from 'three';
import type { EffectDef, EffectPreset } from '../../engine/contracts';
import { disposeMaterialSlot, emptyMaterialSlot, MaterialPass, NO_PLACEMENT, sized, type MaterialSlot } from '../../engine/layer2d/materialPass';
import type { PassKit } from '../../engine/passkit';
import { bevel2D, CHROME_RAMP, GRADIENTS, glass2D, material2D, reflection2D, sheen2D, solidFill } from '../../model/defaults';
import { isMaterial2D } from '../../model/gradient';
import type { Material2D, Texture2D } from '../../model/types';
import { bounds } from '../lib';
import { N, num, S, sel } from './common';

// Material: the layer's (group's, part's, generator's) shape shaded as a 2D title material. Its
// param is a whole Material2D, rendered by the title parts' own shader (engine/layer2d/
// materialPass.ts) and edited with their own editor, so every knob works the same on a face, a
// rim or any layer: bevel & emboss, reflection map, metal finish, pattern, satin, texture,
// sheen, glass, inner glow, gloss. The shape is the input's alpha; the colour is the input's own
// pixels ('layer') or the material's fill. Material dimensions are % of `size` comp px.

/** The input's alpha → R (half float, so the output keeps the input's coverage exactly). */
const ALPHA_FRAG = /* glsl */ `
uniform sampler2D tSrc; out vec4 o;
void main() { o = vec4(texelFetch(tSrc, ivec2(gl_FragCoord.xy), 0).a); }`;

interface PassState {
  pass: MaterialPass;
  alpha: THREE.ShaderMaterial;
  slot: MaterialSlot;
  mask: THREE.WebGLRenderTarget | null;
  /** Names each run's mask in the slot keys: new pixels every run, so every field is rebuilt. */
  runs: number;
}

const states = new Map<PassKit, PassState>();

function state(kit: PassKit): PassState {
  let st = states.get(kit);
  if (!st) {
    st = { pass: new MaterialPass(kit), alpha: kit.shader({ uniforms: { tSrc: { value: null } }, fragmentShader: ALPHA_FRAG }), slot: emptyMaterialSlot(), mask: null, runs: 0 };
    states.set(kit, st);
  }
  return st;
}

// ---------- presets ----------

/** Eye Candy chrome: a Fit bevel domed to the centre mirroring the highway, through a metal ramp. */
const chrome = (ramp: Material2D['finish']['gradient']) =>
  material2D(solidFill('#ffffff'), {
    bevel: bevel2D({ profile: 'smooth', sizeMode: 'fit', fit: 100, depth: 5, soften: 1, gloss: 'linear', highlightOpacity: 0.7, shadowOpacity: 0.35 }),
    reflection: reflection2D({ enabled: true, blur: 20 }),
    finish: { enabled: true, gradient: structuredClone(ramp), amount: 1 },
  });

/** Brushed / flaked metal over the layer's own colours, with a sheen. */
function metal(kind: Texture2D['kind'], scale: number, amount: number): Material2D {
  const m = material2D(solidFill('#ffffff'), { sheen: sheen2D({ enabled: true }) });
  return { ...m, texture: { ...m.texture, kind, amount, scale } };
}

/** A lit, rounded bevel over the layer's own colours. */
const BEVEL = (): Material2D =>
  material2D(solidFill('#ffffff'), { bevel: bevel2D({ profile: 'smooth', size: 8, depth: 3, soften: 1, gloss: 'linear', highlightOpacity: 0.85, shadowOpacity: 0.45 }) });

const PRESETS: EffectPreset[] = [
  { id: 'bevel', label: 'Bevel', params: { colorMode: 'layer', material: BEVEL() } },
  { id: 'chrome', label: 'Chrome', params: { colorMode: 'fill', material: chrome(CHROME_RAMP) } },
  { id: 'gold', label: 'Gold chrome', params: { colorMode: 'fill', material: chrome(GRADIENTS.goldRamp) } },
  {
    id: 'glass',
    label: 'Glass',
    params: {
      colorMode: 'layer',
      material: material2D(solidFill('#ffffff'), {
        bevel: bevel2D({ profile: 'smooth', size: 9, depth: 3.4, soften: 2, gloss: 'linear', highlightOpacity: 1, shadowOpacity: 0 }),
        refraction: 6,
        glass: glass2D({ enabled: true }),
      }),
    },
  },
  { id: 'brushed', label: 'Brushed metal', params: { colorMode: 'layer', material: metal('hairline', 1.5, 0.3) } },
  { id: 'spun', label: 'Spun metal', params: { colorMode: 'layer', material: metal('spun', 1.5, 0.3) } },
  { id: 'leaf', label: 'Gold leaf', params: { colorMode: 'layer', material: metal('flakes', 3, 0.4) } },
];

const material: EffectDef = {
  type: 'material',
  label: 'Material',
  category: 'Material',
  description:
    'Bevel, chrome, glass or metal grain on the shape: the same material as a title’s face and rims (bevel & emboss, reflection map, ' +
    'metal finish, pattern, satin, texture, sheen, glass, inner glow, gloss), over the layer’s own colours or its own fill.',
  params: [
    sel('colorMode', 'Colour', 'layer', [
      ['layer', 'Layer colours'],
      ['fill', 'Material fill'],
    ]),
    num('size', 'Size (100 %)', 200, 10, 2000, 'px', 1),
    { key: 'material', label: 'Material', kind: 'material2d', default: BEVEL(), fillWhen: { key: 'colorMode', value: 'fill' } },
  ],
  presets: PRESETS,
  apply(ctx, input, output, p) {
    const mat = isMaterial2D(p.material) ? p.material : BEVEL();
    const { kit, width: w, height: h, pxScale } = ctx;
    const st = state(kit);
    st.mask = sized(st.mask, w, h, THREE.RedFormat, THREE.HalfFloatType);
    st.alpha.uniforms.tSrc.value = input;
    kit.run(st.alpha, st.mask);
    const slot = st.slot;
    slot.shape = st.mask;
    slot.shapeKey = `fx${++st.runs}`;
    const size = Math.max(1, N(p, 'size'));
    const unit = (size * pxScale) / 100;
    st.pass.prepare(slot, mat, unit, { w, h }, 0);
    // Comp px (origin the render centre, +y up) at render px (0, 0): patterns and textures sit on the comp.
    const origin = { x: -w / 2 / pxScale, y: -h / 2 / pxScale };
    kit.clear(output);
    st.pass.shade(
      {
        mat,
        slot,
        unit,
        size,
        m: pxScale,
        patternOrigin: origin,
        textureOrigin: origin,
        box: bounds(ctx, input).texture,
        bandPx: 0,
        span: null,
        picture: S(p, 'colorMode') === 'fill' ? null : input,
        pictureLinear: true,
        place: NO_PLACEMENT,
        comp: ctx.comp,
      },
      output,
    );
  },
  dispose() {
    for (const st of states.values()) {
      st.pass.dispose();
      st.alpha.dispose();
      st.mask?.dispose();
      disposeMaterialSlot(st.slot);
    }
    states.clear();
  },
};

export const MATERIAL_EFFECTS: EffectDef[] = [material];
