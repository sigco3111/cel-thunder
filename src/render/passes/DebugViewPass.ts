import * as THREE from 'three';
import { GLSL_COMMON, GLSL_SRGB, drawFullScreen, makePassMaterial } from './PassCore';

export type DebugView = 'off' | 'normals' | 'depth' | 'velocity' | 'ao' | 'bloom' | 'id';

const MODE_INDEX: Record<Exclude<DebugView, 'off'>, number> = {
  normals: 0, depth: 1, velocity: 2, ao: 3, bloom: 4, id: 5,
};

/**
 * Buffer inspector for the critique harness. Not part of the shipping chain —
 * 'RenderSystem.setDebugView(...)' routes the frame through this instead of the
 * grade so a reviewer can see exactly what the ink and AO passes are reading.
 */
export class DebugViewPass {
  readonly material: THREE.ShaderMaterial;

  constructor() {
    this.material = makePassMaterial(FRAG, {
      tSrc: { value: null },
      uMode: { value: 0 },
      uFar: { value: 120000 },
    });
  }

  render(
    renderer: THREE.WebGLRenderer,
    view: Exclude<DebugView, 'off'>,
    src: THREE.Texture,
    far: number,
    dst: THREE.WebGLRenderTarget | null,
  ): void {
    this.material.uniforms.tSrc.value = src;
    this.material.uniforms.uMode.value = MODE_INDEX[view];
    this.material.uniforms.uFar.value = far;
    drawFullScreen(renderer, this.material, dst);
  }

  dispose(): void { this.material.dispose(); }
}

const FRAG = /* glsl */`
  precision highp float;
  ${GLSL_COMMON}
  ${GLSL_SRGB}

  uniform sampler2D tSrc;
  uniform int   uMode;
  uniform float uFar;
  varying vec2 vUv;

  void main() {
    vec4 s = texture2D( tSrc, vUv );
    vec3 c;

    if ( uMode == 0 ) {
      c = octDecode( s.rg ) * 0.5 + 0.5;
    } else if ( uMode == 1 ) {
      // Log-scaled so both the cockpit and the horizon are legible at once.
      float z = s.b * uFar;
      c = vec3( clamp( log( 1.0 + z ) / log( 1.0 + uFar ), 0.0, 1.0 ) );
    } else if ( uMode == 2 ) {
      c = vec3( 0.5 + s.rg * 12.0, 0.5 );
    } else if ( uMode == 3 ) {
      c = vec3( s.r );
    } else if ( uMode == 4 ) {
      c = s.rgb * 0.5;
    } else {
      float id = s.a;
      c = 0.35 + 0.65 * vec3( fract( id * 7.13 ), fract( id * 13.7 ), fract( id * 23.3 ) );
    }

    gl_FragColor = vec4( linearToSRGB( c ), 1.0 );
  }
`;
