import { describe, expect, it } from 'vitest';
import { band3D, createTitle2DLayer, createTitle3DLayer, material2D, rim2D, solidFill } from '../../src/model/defaults';
import { hasPartEffects, layerParts, parsePartKey, prunePartEffects } from '../../src/model/parts';
import type { EffectInstance, Title2DLayer, Title3DLayer } from '../../src/model/types';

const rim = (id: string, enabled = true) => rim2D(2, material2D(solidFill('#000000')), { id, enabled });
const fx = (enabled = true): EffectInstance => ({ id: 'e', type: 'outerGlow', enabled, params: {} }) as EffectInstance;

function title2d(rimIds: string[], hideFace = false): Title2DLayer {
  const l = createTitle2DLayer('A');
  return { ...l, style: { ...l.style, rims: rimIds.map((id) => rim(id)), hideFace } };
}

function title3d(bandIds: string[], mode: 'extrude' | 'inflate' = 'extrude'): Title3DLayer {
  const l = createTitle3DLayer('A');
  return { ...l, style3d: { ...l.style3d, mode, bands: bandIds.map((id) => ({ ...band3D(2, 'gold'), id })) } };
}

describe('layerParts', () => {
  it('2D: rims outermost first (style lists innermost first), face last', () => {
    expect(layerParts(title2d(['in', 'mid', 'out']))).toEqual(['rim:out', 'rim:mid', 'rim:in', 'face']);
  });

  it('2D: hidden face is not a part; no rims is just the face', () => {
    expect(layerParts(title2d(['in', 'out'], true))).toEqual(['rim:out', 'rim:in']);
    expect(layerParts(title2d([]))).toEqual(['face']);
  });

  it('2D: a disabled rim is still a part', () => {
    const l = title2d(['a']);
    l.style.rims = [rim('a'), rim('off', false)];
    expect(layerParts(l)).toEqual(['rim:off', 'rim:a', 'face']);
  });

  it('3D: bands outermost first (listed innermost first), the side, the face last', () => {
    expect(layerParts(title3d(['b0', 'b1', 'b2']))).toEqual(['band:b2', 'band:b1', 'band:b0', 'side', 'face']);
  });

  it('3D inflate: the bands are parts too', () => {
    expect(layerParts(title3d(['b0', 'b1'], 'inflate'))).toEqual(['band:b1', 'band:b0', 'side', 'face']);
  });

  it('does not reorder the style lists it reads', () => {
    const l = title3d(['b0', 'b1']);
    layerParts(l);
    expect(l.style3d.bands.map((b) => b.id)).toEqual(['b0', 'b1']);
  });
});

describe('parsePartKey', () => {
  it('splits kind and id at the first colon only', () => {
    expect(parsePartKey('face')).toEqual({ kind: 'face', id: null });
    expect(parsePartKey('side')).toEqual({ kind: 'side', id: null });
    expect(parsePartKey('rim:a:b')).toEqual({ kind: 'rim', id: 'a:b' });
  });
});

describe('prunePartEffects / hasPartEffects', () => {
  it('returns the same object when every key is live and non-empty', () => {
    const l = title2d(['a']);
    l.partEffects = { 'rim:a': [fx()], face: [fx()] };
    expect(prunePartEffects(l)).toBe(l.partEffects);
  });

  it('drops stale keys, empty lists and keys of parts the style hides', () => {
    const l = title2d(['a'], true);
    l.partEffects = { 'rim:a': [fx()], 'rim:gone': [fx()], face: [fx()], 'band:x': [fx()] };
    const kept = { 'rim:a': l.partEffects['rim:a'] };
    expect(prunePartEffects(l)).toEqual(kept);
    l.partEffects = { 'rim:a': [] };
    expect(prunePartEffects(l)).toEqual({});
  });

  it('3D prunes effects of bands that are gone, keeps the side', () => {
    const l = title3d(['b0']);
    l.partEffects = { 'band:b0': [fx()], 'band:gone': [fx()], side: [fx()] };
    expect(Object.keys(prunePartEffects(l))).toEqual(['band:b0', 'side']);
  });

  it('hasPartEffects only counts enabled effects', () => {
    const l = title2d(['a']);
    l.partEffects = { 'rim:a': [fx(false)] };
    expect(hasPartEffects(l)).toBe(false);
    l.partEffects = { 'rim:a': [fx(false), fx(true)] };
    expect(hasPartEffects(l)).toBe(true);
  });
});
