import * as THREE from 'three';
import { GLSL_COMMON, GLSL_SRGB, drawFullScreen, makePassMaterial, type FrameInfo } from './PassCore';
import { LUT_SIZE, buildGradeLut } from './Lut3D';

/**
 * Colour grade — the last creative pass, and the one that decides whether the
 * frame reads as a film still or as a WebGL demo.
 *
 * Order of operations, and why:
 *
 *   1. Chromatic aberration is applied at *fetch* time, radially and with a
 *      quartic falloff, so it is genuinely invisible for the middle two thirds
 *      of the frame and only touches the corners — lens character, not a filter.
 *   2. Bloom is added in scene-referred linear light, before tone mapping, so
 *      the glow compresses through the same shoulder as everything else instead
 *      of sitting on top of the image as a milky wash.
 *   3. Exposure, then a hue-preserving highlight rolloff (Reinhard-Jodie),
 *      then a filmic S-curve in perceptual space. The S is applied gently and
 *      blended against identity: a hard filmic curve would eat the flat
 *      plateaus that the toon ramp exists to create.
 *   4. The procedural 3D LUT carries the whole creative look (see Lut3D.ts).
 *   5. Vignette darkens *and* desaturates, which is what a real lens does and
 *      reads far less like a black oval pasted over the corners.
 *   6. Film grain, luminance-weighted so it lives in the mid-tones.
 *   7. sRGB encode. Everything downstream (FXAA) wants perceptual space.
 */
export type GradeFeature = 'lut' | 'vignette' | 'grain' | 'chromatic';

export class GradePass {
  readonly material: THREE.ShaderMaterial;
  private lut: THREE.Data3DTexture;
  /** Grain phase index, advanced on a fixed 12 Hz clock (see update). */
  private grainPhase = 0;
  private grainClock = 0;

  constructor() {
    this.lut = buildGradeLut(1);

    this.material = makePassMaterial(FRAG, {
      tColor: { value: null },
      tBloom: { value: null },
      tLut: { value: this.lut },

      uExposure: { value: 1.0 },
      uBloom: { value: 0.55 },
      uBloomTint: { value: new THREE.Color(1.0, 0.94, 0.86) },

      uContrast: { value: 0.30 },
      uShoulder: { value: 1.55 },
      /** Tone-curve pivot, in gamma-encoded units. ~18 % scene grey. */
      uPivot: { value: 0.44 },
      /** Straight-line gain about the pivot. 1.0 = no expansion. */
      uGain: { value: 1.30 },

      uLutScale: { value: (LUT_SIZE - 1) / LUT_SIZE },
      uLutOffset: { value: 1 / (2 * LUT_SIZE) },
      uLutAmount: { value: 1.0 },

      /** Inner and outer radius as a fraction of the corner radius. */
      uVignette: { value: new THREE.Vector2(0.82, 1.02) },
      uVignetteDark: { value: 0.82 },
      uVignetteDesat: { value: 0.22 },
      uVignetteAmount: { value: 1.0 },

      uChromatic: { value: 0.7 },
      uGrain: { value: 0.016 },
      uGrainPhase: { value: new THREE.Vector2() },
      uAspect: { value: 1.777 },
    });
  }

  /**
   * Enabled flag and authored strength are kept apart on purpose.
   *
   * These four uniforms have two owners: the A/B harness, which switches a
   * feature off and on, and the art-direction tuning API, which changes how
   * strong it is. When 'setFeature' wrote literals, the second owner lost —
   * every tuned value was silently reset by the next frame's toggle sweep. The
   * uniform is now derived from (enabled ? base : 0) and both callers write
   * their own half of that.
   */
  private readonly featureOn: Record<GradeFeature, boolean> = {
    lut: true, vignette: true, grain: true, chromatic: true,
  };

  private readonly featureBase: Record<GradeFeature, number> = {
    // Chromatic aberration: 0.7 puts the corner R/B split at ~2.5 px at 1080p.
    // Higher reads as a filter rather than as glass — at 0.95 the fringe was
    // legible on individual tree cards in the bottom corners.
    lut: 1.0, vignette: 1.0, grain: 0.016, chromatic: 0.7,
  };

  /** Toggles used by the A/B debug harness. */
  setFeature(name: GradeFeature, on: boolean): void {
    if (this.featureOn[name] === on) return;
    this.featureOn[name] = on;
    this.applyFeature(name);
  }

  /** Authored strength of a feature; survives every toggle. */
  setFeatureAmount(name: GradeFeature, value: number): void {
    this.featureBase[name] = value;
    this.applyFeature(name);
  }

  getFeatureAmount(name: GradeFeature): number { return this.featureBase[name]; }

  private applyFeature(name: GradeFeature): void {
    const v = this.featureOn[name] ? this.featureBase[name] : 0;
    const u = this.material.uniforms;
    switch (name) {
      case 'lut': u.uLutAmount.value = v; break;
      case 'vignette': u.uVignetteAmount.value = v; break;
      case 'grain': u.uGrain.value = v; break;
      case 'chromatic': u.uChromatic.value = v; break;
    }
  }

  update(info: FrameInfo, exposure: number, bloomIntensity: number): void {
    const u = this.material.uniforms;
    u.uExposure.value = exposure;
    u.uBloom.value = bloomIntensity;
    u.uAspect.value = info.width / Math.max(1, info.height);

    // Grain that does not crawl: the pattern itself is locked to screen space,
    // and it is re-seeded on a fixed 12 Hz clock rather than every frame. At
    // render rate the eye integrates successive frames into a directionless
    // shimmer; at 12 Hz — the rate a film projector actually presents new
    // grain at — it reads as emulsion sitting still on the image.
    this.grainClock += info.dt;
    if (this.grainClock >= 1 / 12) {
      this.grainClock %= 1 / 12;
      this.grainPhase = (this.grainPhase + 1) & 7;
    }
    const p = this.grainPhase;
    (u.uGrainPhase.value as THREE.Vector2).set(
      GRAIN_OFFSETS[p * 2],
      GRAIN_OFFSETS[p * 2 + 1],
    );
  }

  render(
    renderer: THREE.WebGLRenderer,
    color: THREE.Texture,
    bloom: THREE.Texture | null,
    dst: THREE.WebGLRenderTarget | null,
  ): void {
    const u = this.material.uniforms;
    u.tColor.value = color;
    u.tBloom.value = bloom;
    if (bloom === null) u.uBloom.value = 0;
    drawFullScreen(renderer, this.material, dst);
  }

  dispose(): void {
    this.lut.dispose();
    this.material.dispose();
  }
}

/** Eight fixed sub-pixel offsets: enough variety to avoid a fixed-pattern
 *  look, few enough that no offset ever reads as motion. */
const GRAIN_OFFSETS = [
  0.0, 0.0, 37.3, 11.7, 91.1, 53.9, 17.5, 71.3,
  63.7, 29.1, 5.3, 97.7, 45.9, 83.1, 23.7, 41.5,
];

const FRAG = /* glsl */`
  precision highp float;
  ${GLSL_COMMON}
  ${GLSL_SRGB}

  uniform sampler2D tColor;
  uniform sampler2D tBloom;
  uniform highp sampler3D tLut;

  uniform float uExposure;
  uniform float uBloom;
  uniform vec3  uBloomTint;
  uniform float uContrast;
  uniform float uShoulder;
  uniform float uPivot;
  uniform float uGain;
  uniform float uLutScale;
  uniform float uLutOffset;
  uniform float uLutAmount;
  uniform vec2  uVignette;
  uniform float uVignetteDark;
  uniform float uVignetteDesat;
  uniform float uVignetteAmount;
  uniform float uChromatic;
  uniform float uGrain;
  uniform vec2  uGrainPhase;
  uniform float uAspect;

  varying vec2 vUv;

  void main() {
    vec2 d = vUv - 0.5;
    float r2 = dot( d, d );

    // --- chromatic aberration (edges only) --------------------------------
    // r^4 falloff: at half radius the shift is 1/16 of its corner value, i.e.
    // a fraction of a pixel. Only the extreme corners fringe.
    float ca = uChromatic * r2 * r2;
    vec2 shift = d * ca * 0.02;
    vec3 col;
    col.r = texture2D( tColor, vUv + shift ).r;
    col.g = texture2D( tColor, vUv ).g;
    col.b = texture2D( tColor, vUv - shift ).b;

    // --- bloom (still linear, still scene-referred) -----------------------
    if ( uBloom > 0.0 ) {
      col += texture2D( tBloom, vUv ).rgb * uBloom * uBloomTint;
    }

    col *= uExposure;

    // --- highlight rolloff -------------------------------------------------
    // Reinhard-Jodie: per-channel Reinhard would swing hues as one channel
    // clips before the others (a red tracer turning orange then white). This
    // blends the luminance-based and per-channel forms weighted by the
    // per-channel result, keeping hue stable right up into the clip.
    float l = lumaOf( col );
    vec3 tvL = col / ( 1.0 + l / uShoulder );
    vec3 tvC = col / ( 1.0 + col / uShoulder );
    col = mix( tvL, tvC, clamp( tvC, 0.0, 1.0 ) );
    col = clamp( col, 0.0, 1.0 );

    // --- contrast in perceptual space --------------------------------------
    // Reinhard alone is a *very* flat curve: with a shoulder of 1.35 a scene
    // value of 1.0 lands at 0.58 linear, i.e. 78 % grey on screen, and an
    // outdoor daylight frame ends up with every mid-tone stacked in the top
    // third of the range. That is the entire "underexposed photograph of a
    // foggy day" look — not too dark, too *narrow*.
    //
    // So: expand about a pivot first (a straight gain, which is what a print
    // stock's straight-line section is), then lay the soft S on top of that to
    // put the toe and shoulder back. Both run on the gamma-encoded value so
    // the pivot sits where the eye puts mid-grey rather than where the maths
    // does, and the S is blended against identity by uContrast so the flat
    // plateaus the toon ramp exists to create survive the treatment.
    vec3 p = pow( col, vec3( 1.0 / 2.2 ) );
    p = ( p - uPivot ) * uGain + uPivot;
    vec3 s = p * p * ( 3.0 - 2.0 * p );
    p = mix( p, s, uContrast );
    col = pow( clamp( p, 0.0, 1.0 ), vec3( 2.2 ) );

    // --- creative grade: procedural 3D LUT --------------------------------
    vec3 lutUvw = clamp( col, 0.0, 1.0 ) * uLutScale + uLutOffset;
    vec3 graded = texture( tLut, lutUvw ).rgb;
    col = mix( col, graded, uLutAmount );

    // --- vignette ----------------------------------------------------------
    // Normalised by the *corner* radius, so the falloff is a true circle that
    // reaches full strength only in the corners. Scaling by aspect alone (and
    // comparing against a fixed threshold) made the term saturate a third of
    // the way in from the left and right edges while the top and bottom never
    // got there — two dark vertical bands, not lens falloff.
    vec2 vd = d * vec2( uAspect, 1.0 );
    float vr = length( vd ) / max( length( vec2( uAspect, 1.0 ) ) * 0.5, 1e-4 );
    float v = smoothstep( uVignette.x, uVignette.y, vr ) * uVignetteAmount;
    col *= mix( 1.0, uVignetteDark, v );
    col = mix( col, vec3( lumaOf( col ) ) * 0.94, v * uVignetteDesat );

    // --- film grain --------------------------------------------------------
    if ( uGrain > 0.0 ) {
      float n = hash12( gl_FragCoord.xy + uGrainPhase );
      // Mid-tone weighted: emulsion grain vanishes in the clear base (blacks)
      // and in fully exposed highlights.
      float lw = lumaOf( col );
      float w = 1.0 - abs( lw * 2.0 - 1.0 );
      col += ( n - 0.5 ) * uGrain * ( 0.25 + 0.75 * w );
    }

    gl_FragColor = vec4( linearToSRGB( max( col, vec3( 0.0 ) ) ), 1.0 );
  }
`;
