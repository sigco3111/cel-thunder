import * as THREE from 'three';
import { GLSL_COMMON, disposeRT, drawFullScreen, makePassMaterial, makeRT } from './PassCore';

/**
 * Progressive dual-filter bloom.
 *
 * A threshold prefilter feeds a pyramid that is downsampled with a 13-tap
 * partial-Karis-average kernel and rebuilt with a 9-tap tent, each level added
 * back into the one above it. That is the Jimenez/Call-of-Duty scheme: the
 * overlapping wide kernels produce a smooth, wide, energy-conserving glow with
 * no ringing and — critically for a game full of tracer fire — no fireflies,
 * because the first downsample averages in inverse-luminance space.
 *
 * Tuning intent: tracers, muzzle flash, exhaust and sun glint carry values well
 * above 1.0 and bloom hard; a white-painted aircraft under a bright sun sits
 * just under the knee and stays crisp. That is what the threshold plus soft
 * knee buys — a hard threshold would make the aircraft pop in and out of
 * blooming as it rolls.
 */
export class BloomPass {
  private prefilter: THREE.ShaderMaterial;
  private down: THREE.ShaderMaterial;
  private up: THREE.ShaderMaterial;
  private mips: THREE.WebGLRenderTarget[] = [];
  private levels = 5;
  private maxLevels = 6;
  private width = 1;
  private height = 1;

  constructor(width: number, height: number) {
    this.prefilter = makePassMaterial(PREFILTER_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: 1.05 },
      uKnee: { value: 0.6 },
      uClamp: { value: 24.0 },
    });

    this.down = makePassMaterial(DOWN_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uKaris: { value: 0 },
    });

    this.up = makePassMaterial(UP_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1.0 },
    });
    // Upsampled levels accumulate into the level above them.
    this.up.blending = THREE.AdditiveBlending;

    this.setSize(width, height);
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    for (let i = 0; i < this.maxLevels; i++) {
      const w = Math.max(1, width >> (i + 1));
      const h = Math.max(1, height >> (i + 1));
      if (this.mips[i]) this.mips[i].setSize(w, h);
      else this.mips[i] = makeRT(w, h, { name: `bloom${i}` });
    }
  }

  /** Number of pyramid levels; fewer levels = tighter, cheaper glow. */
  setLevels(n: number): void {
    this.levels = Math.max(2, Math.min(this.maxLevels, n));
  }

  get texture(): THREE.Texture { return this.mips[0].texture; }

  setThreshold(threshold: number, knee: number): void {
    this.prefilter.uniforms.uThreshold.value = threshold;
    this.prefilter.uniforms.uKnee.value = knee;
  }

  render(renderer: THREE.WebGLRenderer, src: THREE.Texture): void {
    const n = this.levels;

    this.prefilter.uniforms.tSrc.value = src;
    (this.prefilter.uniforms.uTexel.value as THREE.Vector2)
      .set(1 / this.width, 1 / this.height);
    drawFullScreen(renderer, this.prefilter, this.mips[0]);

    for (let i = 1; i < n; i++) {
      const srcRT = this.mips[i - 1];
      this.down.uniforms.tSrc.value = srcRT.texture;
      (this.down.uniforms.uTexel.value as THREE.Vector2)
        .set(1 / srcRT.width, 1 / srcRT.height);
      // Karis averaging only on the first reduction: that is where a single
      // 10,000-nit tracer pixel would otherwise survive as a square blob.
      this.down.uniforms.uKaris.value = i === 1 ? 1 : 0;
      drawFullScreen(renderer, this.down, this.mips[i]);
    }

    for (let i = n - 1; i > 0; i--) {
      const srcRT = this.mips[i];
      this.up.uniforms.tSrc.value = srcRT.texture;
      (this.up.uniforms.uTexel.value as THREE.Vector2)
        .set(1 / srcRT.width, 1 / srcRT.height);
      // No clear: the destination already holds its own downsampled level and
      // additive blending accumulates the pyramid in place.
      drawFullScreen(renderer, this.up, this.mips[i - 1]);
    }
  }

  dispose(): void {
    for (const m of this.mips) disposeRT(m);
    this.mips.length = 0;
    this.prefilter.dispose();
    this.down.dispose();
    this.up.dispose();
  }
}

const PREFILTER_FRAG = /* glsl */`
  precision highp float;
  ${GLSL_COMMON}

  uniform sampler2D tSrc;
  uniform vec2  uTexel;
  uniform float uThreshold;
  uniform float uKnee;
  uniform float uClamp;
  varying vec2 vUv;

  void main() {
    // 4-tap box at the source resolution: halves the aliasing that a bare
    // point sample would fold into the pyramid.
    vec3 c = texture2D( tSrc, vUv + uTexel * vec2( -0.5, -0.5 ) ).rgb;
    c += texture2D( tSrc, vUv + uTexel * vec2(  0.5, -0.5 ) ).rgb;
    c += texture2D( tSrc, vUv + uTexel * vec2( -0.5,  0.5 ) ).rgb;
    c += texture2D( tSrc, vUv + uTexel * vec2(  0.5,  0.5 ) ).rgb;
    c *= 0.25;

    c = min( c, vec3( uClamp ) );

    // Quadratic soft knee (Unreal / Bloom "scatter"): the response is C1 across
    // the threshold, so a surface drifting through it brightens smoothly.
    float br = max( c.r, max( c.g, c.b ) );
    float knee = uThreshold * uKnee + 1e-5;
    float soft = clamp( br - uThreshold + knee, 0.0, 2.0 * knee );
    soft = soft * soft / ( 4.0 * knee );
    float w = max( soft, br - uThreshold ) / max( br, 1e-5 );

    gl_FragColor = vec4( c * w, 1.0 );
  }
`;

const DOWN_FRAG = /* glsl */`
  precision highp float;
  ${GLSL_COMMON}

  uniform sampler2D tSrc;
  uniform vec2  uTexel;
  uniform float uKaris;
  varying vec2 vUv;

  vec3 fetch( vec2 o ) { return texture2D( tSrc, vUv + o * uTexel ).rgb; }

  float karisWeight( vec3 c ) { return 1.0 / ( 1.0 + lumaOf( c ) ); }

  vec3 group( vec3 a, vec3 b, vec3 c, vec3 d ) {
    if ( uKaris > 0.5 ) {
      float wa = karisWeight( a ), wb = karisWeight( b );
      float wc = karisWeight( c ), wd = karisWeight( d );
      return ( a * wa + b * wb + c * wc + d * wd ) / max( wa + wb + wc + wd, 1e-5 );
    }
    return ( a + b + c + d ) * 0.25;
  }

  void main() {
    vec3 a = fetch( vec2( -2.0,  2.0 ) );
    vec3 b = fetch( vec2(  0.0,  2.0 ) );
    vec3 c = fetch( vec2(  2.0,  2.0 ) );
    vec3 d = fetch( vec2( -2.0,  0.0 ) );
    vec3 e = fetch( vec2(  0.0,  0.0 ) );
    vec3 f = fetch( vec2(  2.0,  0.0 ) );
    vec3 g = fetch( vec2( -2.0, -2.0 ) );
    vec3 h = fetch( vec2(  0.0, -2.0 ) );
    vec3 i = fetch( vec2(  2.0, -2.0 ) );
    vec3 j = fetch( vec2( -1.0,  1.0 ) );
    vec3 k = fetch( vec2(  1.0,  1.0 ) );
    vec3 l = fetch( vec2( -1.0, -1.0 ) );
    vec3 m = fetch( vec2(  1.0, -1.0 ) );

    vec3 result  = group( j, k, l, m ) * 0.5;
    result += group( a, b, d, e ) * 0.125;
    result += group( b, c, e, f ) * 0.125;
    result += group( d, e, g, h ) * 0.125;
    result += group( e, f, h, i ) * 0.125;

    gl_FragColor = vec4( result, 1.0 );
  }
`;

const UP_FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D tSrc;
  uniform vec2  uTexel;
  uniform float uRadius;
  varying vec2 vUv;

  void main() {
    vec2 o = uTexel * uRadius;
    // 3x3 tent filter — the exact inverse of the box downsample, which is why
    // the reconstructed pyramid has no visible level boundaries.
    vec3 s = texture2D( tSrc, vUv + vec2( -o.x,  o.y ) ).rgb * 1.0;
    s += texture2D( tSrc, vUv + vec2(  0.0,  o.y ) ).rgb * 2.0;
    s += texture2D( tSrc, vUv + vec2(  o.x,  o.y ) ).rgb * 1.0;
    s += texture2D( tSrc, vUv + vec2( -o.x,  0.0 ) ).rgb * 2.0;
    s += texture2D( tSrc, vUv                      ).rgb * 4.0;
    s += texture2D( tSrc, vUv + vec2(  o.x,  0.0 ) ).rgb * 2.0;
    s += texture2D( tSrc, vUv + vec2( -o.x, -o.y ) ).rgb * 1.0;
    s += texture2D( tSrc, vUv + vec2(  0.0, -o.y ) ).rgb * 2.0;
    s += texture2D( tSrc, vUv + vec2(  o.x, -o.y ) ).rgb * 1.0;
    gl_FragColor = vec4( s / 16.0, 1.0 );
  }
`;
