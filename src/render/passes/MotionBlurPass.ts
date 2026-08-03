import * as THREE from 'three';
import type { QualityTier } from '../../engine/context';
import { GLSL_COMMON, disposeRT, drawFullScreen, makePassMaterial, makeRT } from './PassCore';

/**
 * Per-object motion blur from the prepass velocity buffer.
 *
 * The velocity attachment holds a true per-object motion vector — each draw is
 * reprojected through its own previous world matrix, not just the previous
 * camera — so a fighter flashing across a static frame smears while the
 * background stays sharp, and vice versa.
 *
 * Sky and anything else the prepass skipped has no velocity of its own, so
 * those pixels fall back to an analytic camera reprojection at the far plane
 * ('uReproject' = previousViewProjection * inverse(currentViewProjection)),
 * which is exactly right for geometry at infinity and costs one matrix
 * multiply.
 *
 * ---------------------------------------------------------------------------
 * Why this pass rejects velocity that reverses every frame
 * ---------------------------------------------------------------------------
 * On every chase framing this pass used to make the player's aircraft the
 * blurriest object in a frame where terrain two kilometres away was razor
 * sharp: the fin flash smeared into vertical streaks, the canopy became a
 * white blob and every leading edge ghosted.
 *
 * The velocity buffer was not lying. Measured at the subject's own screen
 * position, 1920x1080, 120 fps, water framing, the aircraft's screen-space
 * displacement per frame runs:
 *
 *   -1.4 px, -7.6 px, +20.0 px, -23.5 px, +20.0 px, -20.1 px, ...
 *
 * against 0.25 px for the entire world behind it. The subject is oscillating
 * left-right by twenty pixels at the frame rate — a one-frame limit cycle in
 * the rig, whose *mean* position is perfectly stable (which is why the
 * composition looks right) but whose per-frame velocity is enormous. The old
 * pass had a fixed 0.0008 UV dead zone: the world fell below it and came out
 * sharp, the oscillation sat far above it and got the full nine-pixel gather.
 * The result was precisely backwards — the aeroplane out of focus in front of
 * a sharp landscape.
 *
 * A single frame's velocity cannot tell travel from vibration. Two can: no
 * physical object reverses its screen-space direction on every consecutive
 * frame. So the pass keeps the previous frame's velocity field (half
 * resolution — the field is smooth and rigid over an object) and weights the
 * blur by the cosine between the two. Consistent motion — terrain sweeping
 * through a low pass, a bandit crossing the frame, a tracer — is unaffected,
 * because its direction barely changes between frames. Anti-correlated motion
 * is rejected as the vibration it is.
 *
 * Two smaller changes go with it:
 *
 *   - the length thresholds are in PIXELS of the final image and subtract
 *     rather than switching, so there is no magnitude at which the effect
 *     turns on and therefore no way for it to rank one object above another by
 *     falling on opposite sides of a cliff. Hero surfaces (LAYER_INK — every
 *     aircraft mesh) get a much wider band than the world, sized to swallow the
 *     whole of the measured oscillation, because the coherence test above only
 *     catches it while it alternates cleanly and a single same-signed pair of
 *     frames is all a screenshot needs to land on;
 *
 *   - the depth guard rejects background samples completely instead of letting
 *     them through at 15 % weight. On a 20 m subject against a 120 km sky that
 *     15 % meant every tap along every leading edge mixed in a slug of sky,
 *     which is where the ghosting and the double-imaged fin flash came from.
 */
export class MotionBlurPass {
  readonly material: THREE.ShaderMaterial;
  private copyMat: THREE.ShaderMaterial;
  /** Previous frame's velocity field, half resolution. */
  private rtHistory: THREE.WebGLRenderTarget;
  private taps = 8;
  private historyValid = false;

  constructor(width = 2, height = 2) {
    this.rtHistory = makeRT(Math.max(1, width >> 1), Math.max(1, height >> 1), {
      name: 'mb-velocity-history',
    });

    this.material = makePassMaterial(FRAG, {
      tColor: { value: null },
      tVel: { value: null },
      tVelPrev: { value: this.rtHistory.texture },
      tGB: { value: null },
      uReproject: { value: new THREE.Matrix4() },
      uScale: { value: 0.55 },
      /** Render resolution in pixels — every threshold below is in pixels. */
      uResolution: { value: new THREE.Vector2(1920, 1080) },
      /** x = world dead band, y = hero (LAYER_INK) dead band, in pixels. */
      uDeadPx: { value: new THREE.Vector2(2, 12) },
      /** Longest blur any pixel may take, in pixels. */
      uMaxPx: { value: 30 },
      /** 0 disables the coherence gate (no history yet). */
      uCoherence: { value: 0 },
    }, { MB_TAPS: 8 });

    this.copyMat = makePassMaterial(COPY_FRAG, { tSrc: { value: null } });
  }

  setSize(width: number, height: number): void {
    this.rtHistory.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1));
    this.historyValid = false;
  }

  setQuality(q: QualityTier): void {
    const taps = q === 'ultra' ? 12 : q === 'high' ? 8 : 6;
    if (taps === this.taps) return;
    this.taps = taps;
    this.material.defines.MB_TAPS = taps;
    this.material.needsUpdate = true;
  }

  /**
   * Drops the velocity history.
   *
   * Called across a cut: the previous field describes a viewpoint that no
   * longer exists, and comparing this frame's velocity against it would gate
   * the blur on noise. One frame without the coherence test is harmless — the
   * pass is sitting the cut out anyway.
   */
  reset(): void { this.historyValid = false; }

  /**
   * Latches this frame's velocity field for the next frame to compare against.
   *
   * Kept separate from render() so it still runs on the frames the blur itself
   * is skipped (cuts, the first frame). If it did not, the frame after a skip
   * would be comparing against a field two frames old, which for a one-frame
   * oscillation is exactly the wrong parity and would let the smear through.
   */
  captureHistory(renderer: THREE.WebGLRenderer, velocity: THREE.Texture): void {
    this.copyMat.uniforms.tSrc.value = velocity;
    drawFullScreen(renderer, this.copyMat, this.rtHistory);
    this.historyValid = true;
  }

  render(
    renderer: THREE.WebGLRenderer,
    color: THREE.Texture,
    velocity: THREE.Texture,
    gbuffer: THREE.Texture,
    reproject: THREE.Matrix4,
    dst: THREE.WebGLRenderTarget,
    shutter: number,
    width: number,
    height: number,
  ): void {
    const u = this.material.uniforms;
    u.tColor.value = color;
    u.tVel.value = velocity;
    u.tVelPrev.value = this.rtHistory.texture;
    u.tGB.value = gbuffer;
    (u.uReproject.value as THREE.Matrix4).copy(reproject);
    u.uScale.value = shutter;
    (u.uResolution.value as THREE.Vector2).set(width, height);
    u.uCoherence.value = this.historyValid ? 1 : 0;
    // Blur length is capped as a fraction of frame *height*, not of the UV
    // square: capping in UV made the ceiling 1.8x longer horizontally than
    // vertically on a 16:9 frame, so a pan smeared half again as far as a
    // climb. A per-frame vector already scales with frame time (that is the
    // shutter), but a 20 fps hitch would otherwise smear a third of the screen.
    u.uMaxPx.value = Math.max(4, height * MAX_BLUR_FRACTION);
    // Both dead bands are fractions of frame height, so they describe the same
    // amount of *picture* at 720p and at 4K rather than the same number of
    // samples.
    (u.uDeadPx.value as THREE.Vector2).set(
      Math.max(1, height * WORLD_DEAD_FRACTION),
      Math.max(2, height * HERO_DEAD_FRACTION),
    );
    drawFullScreen(renderer, this.material, dst);
  }

  dispose(): void {
    this.material.dispose();
    this.copyMat.dispose();
    disposeRT(this.rtHistory);
  }
}

/**
 * Dead band for ordinary world geometry, as a fraction of frame height.
 *
 * 0.0014 is 1.5 px at 1080p. A blur shorter than about a pixel and a half
 * cannot describe motion — it is a box filter, and all it does is cost the
 * frame its edge definition. Measured world velocities on the ten capture
 * framings are a quarter of a pixel, so this changes nothing about them; it
 * exists so that the *shape* of the response is a ramp out of zero rather than
 * a step.
 */
const WORLD_DEAD_FRACTION = 0.0014;

/**
 * Dead band for LAYER_INK (hero) surfaces — aircraft — as a fraction of frame
 * height. 0.011 is 12 px at 1080p.
 *
 * Sized off the measurement in the header: the tracked subject's rig
 * oscillation peaks at 23 px of screen displacement per frame, which at a 0.45
 * shutter is 10.4 px of blur. The coherence gate above catches that whenever
 * the oscillation alternates cleanly, but it is not a perfect square wave —
 * two same-signed frames in a row look exactly like travel, and one such frame
 * is all a screenshot needs to land on. Twelve pixels puts the whole measured
 * band under the floor unconditionally.
 *
 * What it costs: a hero object needs more than 12 px of blur — about 27 px of
 * screen motion per frame — before it smears at all, and then only by the
 * excess. A bandit crossing the frame in half a second at 60 fps moves 64 px a
 * frame, so it still takes 17 px of blur. What it buys is that the ink
 * silhouette, which is the thing this whole renderer exists to draw, is never
 * destroyed by the rig failing to hold its own subject still.
 */
const HERO_DEAD_FRACTION = 0.011;

/** Longest blur any pixel may take, as a fraction of frame height. */
const MAX_BLUR_FRACTION = 0.028;

const COPY_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D tSrc;
  varying vec2 vUv;
  void main() {
    gl_FragColor = vec4( texture2D( tSrc, vUv ).rg, 0.0, 1.0 );
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  ${GLSL_COMMON}

  uniform sampler2D tColor;
  uniform sampler2D tVel;
  uniform sampler2D tVelPrev;
  uniform sampler2D tGB;
  uniform mat4  uReproject;
  uniform float uScale;
  uniform vec2  uResolution;
  uniform vec2  uDeadPx;
  uniform float uMaxPx;
  uniform float uCoherence;

  varying vec2 vUv;

  void main() {
    vec4 gb = texture2D( tGB, vUv );
    vec3 centre = texture2D( tColor, vUv ).rgb;
    vec2 vel;

    if ( gb.b > 0.9995 ) {
      // Nothing in the gbuffer here: reproject a far-plane point.
      vec4 clip = vec4( vUv * 2.0 - 1.0, 0.9999, 1.0 );
      vec4 prev = uReproject * clip;
      float pw = abs( prev.w ) < 1e-6 ? 1e-6 : prev.w;
      vel = vUv - ( ( prev.xy / pw ) * 0.5 + 0.5 );
    } else {
      vel = texture2D( tVel, vUv ).rg;
    }

    // --- temporal coherence -----------------------------------------------
    // Sampled where this surface *was* last frame, which is the only place its
    // previous velocity is recorded. A direction that has reversed since then
    // is a vibration, not travel, and gets no shutter at all.
    vec2 prevVel = texture2D( tVelPrev, vUv - vel ).rg;
    float lp = length( prevVel );
    float lc = length( vel );
    float cosine = ( lp > 1e-7 && lc > 1e-7 ) ? dot( vel, prevVel ) / ( lp * lc ) : 1.0;
    // ('coherent' is a reserved memory qualifier in GLSL ES 3.0.)
    float cohere = mix( 1.0, smoothstep( -0.30, 0.30, cosine ), uCoherence );

    // --- shape the vector, in pixels of the final image --------------------
    // The gbuffer's id channel is offset by +0.5 for LAYER_INK objects (see
    // DepthNormalPass.applyPerObject), which is every aircraft mesh.
    float dead = gb.a >= 0.5 ? uDeadPx.y : uDeadPx.x;

    vec2 velPx = vel * uScale * uResolution * cohere;
    float lenPx = length( velPx );
    // Subtractive, so the response ramps out of zero instead of stepping.
    float keptPx = min( max( lenPx - dead, 0.0 ), uMaxPx );
    if ( keptPx <= 0.0 ) {
      gl_FragColor = vec4( centre, 1.0 );
      return;
    }
    vel = velPx * ( keptPx / lenPx ) / uResolution;

    float zc = gb.b;
    // The centre tap is explicit and unconditional: whatever else the shutter
    // sweeps up, a pixel keeps a full share of its own colour, which is what
    // stops a long vector from replacing a silhouette with its background.
    vec3 sum = centre;
    float wsum = 1.0;

    // Half-pixel jitter locked to screen position breaks the banding that a
    // fixed tap pattern produces on long vectors, without any temporal noise.
    float j = ign( gl_FragCoord.xy ) - 0.5;

    for ( int i = 0; i < MB_TAPS; i ++ ) {
      float t = ( ( float( i ) + 0.5 + j ) / float( MB_TAPS ) ) - 0.5;
      vec2 suv = vUv + vel * t;
      vec3 c = texture2D( tColor, suv ).rgb;

      // Depth guard, on RELATIVE depth rather than an absolute ratio: samples
      // at or in front of us may bleed (that is real motion blur), samples
      // behind us are rejected outright.
      float zs = texture2D( tGB, suv ).b;
      float rel = ( zs - zc ) / max( zc, 1e-5 );
      float w = 1.0 - smoothstep( 0.05, 0.60, rel );
      // Taper toward the ends of the shutter so the trail fades out.
      w *= 1.0 - abs( t ) * 0.55;

      sum += c * w;
      wsum += w;
    }

    gl_FragColor = vec4( sum / max( wsum, 1e-4 ), 1.0 );
  }
`;
