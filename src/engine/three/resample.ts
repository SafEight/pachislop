import * as THREE from 'three';
import type { PassKit } from '../passkit';

// Supersampling resolve for 3D layers (Element 3D supersampling): a k× render (per axis) is
// reduced to the layer's output grid with a separable Mitchell–Netravali filter
// (B = C = 1/3), 2 output px of support. Unlike a k×k box it suppresses the stair-step
// aliasing a box keeps on near-horizontal edges, with only a faint, alpha-safe overshoot.
// Input and output are premultiplied linear.

const FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform int uK; // source texels per output px along the axis
uniform ivec2 uAxis;
in vec2 vUv;
out vec4 o;
float mitchell( float x ) {
  x = abs( x );
  const float B = 1.0 / 3.0;
  const float C = 1.0 / 3.0;
  if ( x < 1.0 ) return ( ( 12.0 - 9.0 * B - 6.0 * C ) * x * x * x + ( -18.0 + 12.0 * B + 6.0 * C ) * x * x + ( 6.0 - 2.0 * B ) ) / 6.0;
  if ( x < 2.0 ) return ( ( -B - 6.0 * C ) * x * x * x + ( 6.0 * B + 30.0 * C ) * x * x + ( -12.0 * B - 48.0 * C ) * x + ( 8.0 * B + 24.0 * C ) ) / 6.0;
  return 0.0;
}
void main() {
  ivec2 p = ivec2( gl_FragCoord.xy );
  ivec2 size = textureSize( tSrc, 0 );
  bool horizontal = uAxis.x == 1;
  float k = float( uK );
  int last = ( horizontal ? size.x : size.y ) - 1;
  // centre of this output px in source texels along the axis
  float c = ( float( horizontal ? p.x : p.y ) + 0.5 ) * k;
  ivec2 base = horizontal ? ivec2( 0, p.y ) : ivec2( p.x, 0 );
  int j0 = int( floor( c - 2.0 * k ) );
  int j1 = int( ceil( c + 2.0 * k ) );
  vec4 s = vec4( 0.0 );
  float ws = 0.0;
  for ( int j = j0; j <= j1; j ++ ) {
    float w = mitchell( ( float( j ) + 0.5 - c ) / k );
    if ( w == 0.0 ) continue;
    s += texelFetch( tSrc, base + uAxis * clamp( j, 0, last ), 0 ) * w;
    ws += w;
  }
  o = s / ws;
  o = vec4( max( o.rgb, vec3( 0.0 ) ), clamp( o.a, 0.0, 1.0 ) );
}
`;

export class Downsampler {
  private readonly kit: PassKit;
  private readonly mat: THREE.ShaderMaterial;
  /** Horizontal pass result: output width × source height. */
  private readonly mid: THREE.WebGLRenderTarget;

  constructor(kit: PassKit) {
    this.kit = kit;
    this.mat = kit.shader({
      uniforms: { tSrc: { value: null }, uK: { value: 1 }, uAxis: { value: new THREE.Vector2(1, 0) } },
      fragmentShader: FRAG,
    });
    this.mid = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.mid.texture.colorSpace = THREE.LinearSRGBColorSpace;
  }

  /** Reduce `src` (k × target size per axis) into `target`. */
  run(src: THREE.WebGLRenderTarget, target: THREE.WebGLRenderTarget, k: number) {
    if (this.mid.width !== target.width || this.mid.height !== src.height) this.mid.setSize(target.width, src.height);
    const u = this.mat.uniforms;
    u.uK.value = k;
    u.tSrc.value = src.texture;
    u.uAxis.value.set(1, 0);
    this.kit.run(this.mat, this.mid);
    u.tSrc.value = this.mid.texture;
    u.uAxis.value.set(0, 1);
    this.kit.run(this.mat, target);
  }

  dispose() {
    this.mat.dispose();
    this.mid.dispose();
  }
}
