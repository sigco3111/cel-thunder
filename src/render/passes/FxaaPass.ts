import * as THREE from 'three';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { FULLSCREEN_VERT, drawFullScreen } from './PassCore';

/**
 * Final anti-aliasing.
 *
 * The renderer is created with 'antialias: false' on purpose — MSAA cannot
 * resolve the two things this renderer actually aliases, which are the ink
 * lines (a post-process, invisible to MSAA) and the hard quantised band edges
 * of the toon ramp (a shading discontinuity inside a triangle, also invisible
 * to MSAA). Both are luminance edges, which is exactly FXAA's domain.
 *
 * This wraps three's FXAA 3.11 fragment shader — the one genuinely
 * off-the-shelf piece in the chain — with the full-screen-triangle vertex
 * shader the rest of the passes use, and runs it on sRGB-encoded data, which is
 * what FXAA's luminance thresholds assume.
 */
export class FxaaPass {
  readonly material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        resolution: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: FXAAShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
      fog: false,
      lights: false,
    });
  }

  setSize(width: number, height: number): void {
    (this.material.uniforms.resolution.value as THREE.Vector2)
      .set(1 / Math.max(1, width), 1 / Math.max(1, height));
  }

  render(
    renderer: THREE.WebGLRenderer,
    src: THREE.Texture,
    dst: THREE.WebGLRenderTarget | null,
  ): void {
    this.material.uniforms.tDiffuse.value = src;
    drawFullScreen(renderer, this.material, dst);
  }

  dispose(): void { this.material.dispose(); }
}
