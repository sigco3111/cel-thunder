import * as THREE from 'three';
import type { QualityTier } from '../../engine/context';
import {
  GLSL_COMMON, disposeRT, drawFullScreen, makePassMaterial, makeRT, type FrameInfo,
} from './PassCore';

/**
 * Cinematic depth of field, focused on the player's aircraft.
 *
 * Three stages, the middle two at half resolution:
 *   1. CoC + downsample — thin-lens circle of confusion packed into alpha.
 *   2. Golden-angle disc gather — a scatter-as-gather bokeh: a neighbour
 *      contributes only if *its* circle of confusion is wide enough to reach
 *      this pixel, which is what stops sharp foreground detail from being
 *      smeared by a blurry background behind it.
 *   3. Composite — blend against the sharp image by CoC.
 *
 * Deliberately restrained: a dogfight is read at the silhouette level and a
 * heavy bokeh would fight the ink lines. The subject and its immediate
 * neighbourhood are sharp, the few hundred metres behind it fall off, and past
 * the hyperfocal distance (see COC_GLSL) the world returns to fully sharp — so
 * terrain, sea and horizon are never touched by this pass.
 */
export class DofPass {
  private focusMat: THREE.ShaderMaterial;
  private cocMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private compositeMat: THREE.ShaderMaterial;
  private rtCoc: THREE.WebGLRenderTarget;
  private rtBlur: THREE.WebGLRenderTarget;
  /** 1x1 ping-pong holding the smoothed focus distance, normalised by far. */
  private rtFocus: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private focusIndex = 0;
  private taps = 16;

  /** CPU-side estimate, for stats and as the autofocus hint. */
  private focus = 400;

  constructor(width: number, height: number) {
    const w = Math.max(1, width >> 1);
    const h = Math.max(1, height >> 1);
    this.rtCoc = makeRT(w, h, { name: 'dof-coc' });
    this.rtBlur = makeRT(w, h, { name: 'dof-blur' });
    this.rtFocus = [
      makeRT(1, 1, { filter: THREE.NearestFilter, name: 'dof-focus0' }),
      makeRT(1, 1, { filter: THREE.NearestFilter, name: 'dof-focus1' }),
    ];

    this.focusMat = makePassMaterial(FOCUS_FRAG, {
      tGB: { value: null },
      tPrev: { value: null },
      uFar: { value: 120000 },
      uHint: { value: -1 },
      uRate: { value: 0.1 },
    });

    this.cocMat = makePassMaterial(COC_FRAG, {
      tColor: { value: null },
      tGB: { value: null },
      tFocus: { value: null },
      uFar: { value: 120000 },
      uStrength: { value: DEFAULT_STRENGTH },
      uNearScale: { value: 0.75 },
      uHyper: { value: new THREE.Vector2(HYPERFOCAL_K, HYPERFOCAL_MIN) },
    });

    this.blurMat = makePassMaterial(BLUR_FRAG, {
      tCoc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uMaxRadius: { value: 6.0 },
    }, { DOF_TAPS: 16 });

    this.compositeMat = makePassMaterial(COMPOSITE_FRAG, {
      tColor: { value: null },
      tBlur: { value: null },
      tGB: { value: null },
      tFocus: { value: null },
      uFar: { value: 120000 },
      uStrength: { value: DEFAULT_STRENGTH },
      uNearScale: { value: 0.75 },
      uHyper: { value: new THREE.Vector2(HYPERFOCAL_K, HYPERFOCAL_MIN) },
      /** Hard ceiling on how much of the blurred image a *background* pixel may
       *  ever take. The near field is deliberately not capped. */
      uFarCap: { value: 0.35 },
    });
  }

  setSize(width: number, height: number): void {
    this.rtCoc.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1));
    this.rtBlur.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1));
  }

  setQuality(q: QualityTier): void {
    const taps = q === 'ultra' ? 24 : 16;
    if (taps === this.taps) return;
    this.taps = taps;
    this.blurMat.defines.DOF_TAPS = taps;
    this.blurMat.needsUpdate = true;
  }

  /**
   * @param target   Distance to the subject in metres, or <= 0 for autofocus.
   * @param dt       Frame time; focus is damped so the rack is never instant.
   */
  setFocusTarget(target: number, dt: number): void {
    this.hint = target;
    this.dt = dt;
    if (target > 0) {
      // ~4.5 Hz exponential approach: fast enough to track a manoeuvring
      // target, slow enough that a passing tree does not pull focus. Across a
      // cut there is nothing to approach *from*, so it snaps.
      if (this.snap) this.focus = target;
      else this.focus += (target - this.focus) * (1 - Math.exp(-4.5 * dt));
    }
  }

  private hint = -1;
  private dt = 1 / 60;
  /** Set by snapFocus(); consumed by the next render(). */
  private snap = false;

  /**
   * Discards the focus history so the next frame lands on its new subject
   * immediately.
   *
   * Called across a camera cut. Both halves of the focus have to be reset — the
   * CPU-side estimate used for stats and the 1x1 GPU ping-pong that actually
   * drives the shader — or the pass racks in from the previous shot's distance
   * over about half a second, and a shot composed 20 m from the subject
   * inherits the focus of one composed 400 m from it. Since a background pixel
   * at the wrong focus takes near-field defocus, that reads as the subject
   * being the only soft thing in an otherwise sharp frame.
   */
  snapFocus(): void {
    this.snap = true;
  }

  get focusDistance(): number { return this.focus; }

  render(
    renderer: THREE.WebGLRenderer,
    color: THREE.Texture,
    gbuffer: THREE.Texture,
    dst: THREE.WebGLRenderTarget,
    info: FrameInfo,
    strength: number,
  ): void {
    // --- autofocus (1x1, stays on the GPU) --------------------------------
    // The focus distance never travels back to the CPU: a readback would stall
    // the pipeline for a single float. Instead it lives in a 1x1 target that
    // is ping-ponged and exponentially damped in the shader, so the DOF is
    // correct even with no player entity (spectator, replay, menu camera).
    const prev = this.rtFocus[this.focusIndex];
    const nextFocus = this.rtFocus[this.focusIndex ^ 1];
    const f = this.focusMat.uniforms;
    f.tGB.value = gbuffer;
    f.tPrev.value = prev.texture;
    f.uFar.value = info.far;
    f.uHint.value = this.hint;
    f.uRate.value = this.snap ? 1 : 1 - Math.exp(-4.5 * this.dt);
    this.snap = false;
    drawFullScreen(renderer, this.focusMat, nextFocus);
    this.focusIndex ^= 1;

    const c = this.cocMat.uniforms;
    c.tColor.value = color;
    c.tGB.value = gbuffer;
    c.tFocus.value = nextFocus.texture;
    c.uFar.value = info.far;
    c.uStrength.value = strength;
    drawFullScreen(renderer, this.cocMat, this.rtCoc);

    const b = this.blurMat.uniforms;
    b.tCoc.value = this.rtCoc.texture;
    (b.uTexel.value as THREE.Vector2).set(2 / info.width, 2 / info.height);
    // Cap the bokeh at ~1% of frame height so the effect scales with the image
    // rather than with the buffer resolution.
    b.uMaxRadius.value = Math.max(3, info.height * 0.006);
    drawFullScreen(renderer, this.blurMat, this.rtBlur);

    const o = this.compositeMat.uniforms;
    o.tColor.value = color;
    o.tBlur.value = this.rtBlur.texture;
    o.tGB.value = gbuffer;
    o.tFocus.value = nextFocus.texture;
    o.uFar.value = info.far;
    o.uStrength.value = strength;
    drawFullScreen(renderer, this.compositeMat, dst);
  }

  dispose(): void {
    disposeRT(this.rtCoc);
    disposeRT(this.rtBlur);
    disposeRT(this.rtFocus[0]);
    disposeRT(this.rtFocus[1]);
    this.focusMat.dispose();
    this.cocMat.dispose();
    this.blurMat.dispose();
    this.compositeMat.dispose();
  }
}

/**
 * Aperture equivalent: the circle of confusion the thin-lens term saturates to
 * far behind the subject, before the hyperfocal falloff is applied. Small on
 * purpose — this is a long lens on a 30 m subject, not a portrait lens on a
 * face. RenderSystem passes its own value per frame.
 */
const DEFAULT_STRENGTH = 0.13;

/**
 * Hyperfocal distance as a multiple of the focus distance, with a floor in
 * metres. 8x/200 m means a 25 m chase subject has everything past ~200 m sharp
 * and a 400 m cinematic subject has everything past ~3.2 km sharp, which is
 * roughly how a real long lens behaves at those subject distances.
 */
const HYPERFOCAL_K = 8.0;
const HYPERFOCAL_MIN = 200.0;

/**
 * Signed circle of confusion. Positive behind the focus plane, negative in
 * front. '(z - focus) / z' is the thin-lens form with the aperture and focal
 * length folded into 'uStrength'.
 *
 * The important half of this function is what happens far behind the subject.
 * The bare thin-lens term *saturates* at 'uStrength' as z goes to infinity, so
 * used on its own it hands the same defocus to a wingman 200 m back, the ridge
 * line at 8 km and the horizon at 60 km — the whole world equally soft, which
 * is exactly the tilt-shift-miniature look the frame must not have. A real lens
 * has a hyperfocal distance H: focused at H, everything from H/2 to infinity is
 * inside the acceptable circle of confusion, i.e. sharp. So the background term
 * is ramped back to zero by H, which for a 30 m chase subject is a couple of
 * hundred metres: aircraft close behind the subject still separate from it,
 * terrain, sea, cloud and horizon stay crisp.
 *
 * The near field is untouched by that falloff — a foreground object's CoC is
 * negative and genuinely unbounded, which is what makes a wing root sliding
 * past the lens read as a real camera.
 */
const COC_GLSL = /* glsl */`
  uniform sampler2D tFocus;
  uniform float uStrength;
  uniform float uNearScale;
  uniform vec2  uHyper;      // x = hyperfocal multiple of focus, y = floor in m
  uniform float uFar;

  float focusDistance() {
    return max( texture2D( tFocus, vec2( 0.5 ) ).r * uFar, 1.0 );
  }

  float cocOf( float z, float focus ) {
    float c = ( z - focus ) / max( z, 0.05 ) * uStrength;
    if ( c > 0.0 ) {
      float H = max( focus * uHyper.x, uHyper.y );
      // Background defocus peaks shortly behind the subject and is gone by the
      // hyperfocal distance.
      c *= 1.0 - smoothstep( H * 0.45, H, z );
    } else {
      // The near field is compressed: 'z - focus' is unbounded below, and a
      // cockpit frame 40 cm from the lens would otherwise swamp the frame.
      c *= uNearScale;
    }
    return clamp( c, -1.0, 1.0 );
  }
`;

/**
 * Autofocus, 1x1. Picks the nearest surface inside a small centre reticle —
 * that is the thing the player is aiming at — damps toward it, and never leaves
 * the GPU. A CPU hint (the player's own aircraft, whose distance the game
 * already knows exactly) overrides the measurement when one is available.
 */
const FOCUS_FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D tGB;
  uniform sampler2D tPrev;
  uniform float uFar;
  uniform float uHint;
  uniform float uRate;
  varying vec2 vUv;

  float depthAt( vec2 uv ) {
    float d = texture2D( tGB, uv ).b;
    return d > 0.9995 ? -1.0 : d;
  }

  void main() {
    float target;

    if ( uHint > 0.0 ) {
      target = uHint / uFar;
    } else {
      // Five taps across a small centre region; nearest non-sky wins.
      float best = 1e9;
      for ( int i = 0; i < 5; i ++ ) {
        vec2 o = i == 0 ? vec2( 0.0 ) :
                 i == 1 ? vec2(  0.03, 0.0 ) :
                 i == 2 ? vec2( -0.03, 0.0 ) :
                 i == 3 ? vec2( 0.0,  0.04 ) : vec2( 0.0, -0.04 );
        float d = depthAt( vec2( 0.5 ) + o );
        if ( d > 0.0 ) best = min( best, d );
      }
      // All sky: park focus well out so the horizon stays sharp.
      target = best > 1e8 ? ( 4000.0 / uFar ) : best;
    }

    float prev = texture2D( tPrev, vec2( 0.5 ) ).r;
    // Uninitialised (first frame) — snap rather than racking in from zero.
    float f = prev <= 1e-6 ? target : mix( prev, target, uRate );
    gl_FragColor = vec4( f, 0.0, 0.0, 1.0 );
  }
`;

const COC_FRAG = /* glsl */`
  precision highp float;
  ${GLSL_COMMON}
  ${COC_GLSL}

  uniform sampler2D tColor;
  uniform sampler2D tGB;
  varying vec2 vUv;

  void main() {
    // Sky was never written by the prepass; its stored depth is the far plane,
    // so it takes the same defocus as distant terrain instead of snapping sharp.
    float z = texture2D( tGB, vUv ).b * uFar;
    gl_FragColor = vec4( texture2D( tColor, vUv ).rgb, cocOf( z, focusDistance() ) );
  }
`;

const BLUR_FRAG = /* glsl */`
  precision highp float;
  ${GLSL_COMMON}

  uniform sampler2D tCoc;
  uniform vec2  uTexel;
  uniform float uMaxRadius;
  varying vec2 vUv;

  void main() {
    vec4 c0 = texture2D( tCoc, vUv );
    float r = abs( c0.a ) * uMaxRadius;

    vec3 sum = c0.rgb;
    float wsum = 1.0;

    // Screen-locked rotation: an animated one would make the bokeh boil.
    float rot = ign( gl_FragCoord.xy ) * 6.2831853;

    for ( int i = 0; i < DOF_TAPS; i ++ ) {
      float fi = float( i ) + 0.5;
      float t = fi / float( DOF_TAPS );
      // Golden-angle spiral with sqrt radial spacing = uniform disc density.
      float ang = fi * 2.39996323 + rot;
      float rad = sqrt( t );
      vec2 o = vec2( cos( ang ), sin( ang ) ) * rad * max( r, uMaxRadius * 0.15 );

      vec4 s = texture2D( tCoc, vUv + o * uTexel );
      float sr = abs( s.a ) * uMaxRadius;
      // Scatter as gather: this neighbour only reaches us if its own circle of
      // confusion is at least as large as the distance between us.
      float w = clamp( sr - length( o ) + 1.0, 0.0, 1.0 );
      sum += s.rgb * w;
      wsum += w;
    }

    gl_FragColor = vec4( sum / max( wsum, 1e-4 ), c0.a );
  }
`;

const COMPOSITE_FRAG = /* glsl */`
  precision highp float;
  ${GLSL_COMMON}
  ${COC_GLSL}

  uniform sampler2D tColor;
  uniform sampler2D tBlur;
  uniform sampler2D tGB;
  uniform float uFarCap;
  varying vec2 vUv;

  void main() {
    vec3 sharp = texture2D( tColor, vUv ).rgb;
    vec4 blur  = texture2D( tBlur, vUv );
    float z = texture2D( tGB, vUv ).b * uFar;
    float coc = cocOf( z, focusDistance() );

    // Near-field CoC from the blurred buffer bleeds *over* sharp geometry, so
    // take whichever is stronger to avoid a hard edge around foreground blur.
    float near = max( max( -coc, 0.0 ), max( -blur.a, 0.0 ) );
    float far  = max( coc, 0.0 );

    // Foreground defocus may go all the way to the blurred image — that is the
    // out-of-focus wing sliding past the lens. Background defocus is capped:
    // beyond a third of the blurred image the environment stops reading as
    // "behind the subject" and starts reading as "out of focus photograph".
    float amount = max(
      smoothstep( 0.02, 0.45, near ),
      smoothstep( 0.01, max( uStrength, 0.02 ), far ) * uFarCap
    );
    gl_FragColor = vec4( mix( sharp, blur.rgb, amount ), 1.0 );
  }
`;
