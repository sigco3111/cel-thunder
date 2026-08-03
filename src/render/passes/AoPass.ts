import * as THREE from 'three';
import type { QualityTier } from '../../engine/context';
import {
  GLSL_COMMON, GLSL_VIEWPOS, disposeRT, drawFullScreen, makePassMaterial, makeRT,
  type FrameInfo,
} from './PassCore';

/**
 * Horizon-based ambient occlusion.
 *
 * Chosen over a hemisphere-sampling SSAO because HBAO needs no random sample
 * kernel, no normal-oriented reflection trick and no bilateral upsample of a
 * noisy signal to look clean — it marches a handful of screen-space directions
 * and takes the highest horizon angle it finds, which converges fast and, with
 * a *screen-locked* rotation, is completely stable frame to frame. That last
 * property matters more here than raw accuracy: any temporal instability in the
 * AO would read as crawling dirt inside the flat shading bands.
 *
 * Runs at half resolution (AO is a low-frequency signal) and is cross-bilateral
 * blurred with a depth-similarity weight so it does not leak across silhouettes
 * and undo the ink pass's work.
 */
export class AoPass {
  private aoMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private rtA: THREE.WebGLRenderTarget;
  private rtB: THREE.WebGLRenderTarget;
  private dirs = 6;
  private steps = 4;

  constructor(width: number, height: number) {
    const w = Math.max(1, width >> 1);
    const h = Math.max(1, height >> 1);
    // r = occlusion, g = the depth it was computed at (the bilateral blur's
    // rejection term, kept here to avoid a second gbuffer fetch per tap).
    this.rtA = makeRT(w, h, { name: 'ao' });
    this.rtB = makeRT(w, h, { name: 'ao-blur' });

    this.aoMat = makePassMaterial(AO_FRAG, {
      tGB: { value: null },
      uProjParams: { value: new THREE.Vector2(1, 1) },
      uFar: { value: 120000 },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 2.6 },
      uProjScale: { value: 800 },
      uMaxRadiusPx: { value: 56 },
      uIntensity: { value: 1.15 },
      // Tangent-plane bias. Generous on purpose: a low pass over terrain puts
      // the ground at a few degrees of incidence, where interpolated normals
      // and half-resolution depth disagree enough to self-occlude a flat field.
      uBias: { value: 0.14 },
    }, { AO_DIRS: 6, AO_STEPS: 4 });

    this.blurMat = makePassMaterial(BLUR_FRAG, {
      tAO: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uDirection: { value: new THREE.Vector2(1, 0) },
      uDepthSigma: { value: 0.06 },
    });
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, width >> 1);
    const h = Math.max(1, height >> 1);
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
  }

  setQuality(q: QualityTier): void {
    const dirs = q === 'ultra' ? 8 : q === 'high' ? 6 : 4;
    const steps = q === 'ultra' ? 5 : 4;
    if (dirs === this.dirs && steps === this.steps) return;
    this.dirs = dirs; this.steps = steps;
    this.aoMat.defines.AO_DIRS = dirs;
    this.aoMat.defines.AO_STEPS = steps;
    this.aoMat.needsUpdate = true;
  }

  get texture(): THREE.Texture { return this.rtA.texture; }

  render(renderer: THREE.WebGLRenderer, gbuffer: THREE.Texture, info: FrameInfo): void {
    const halfTexel = _v2a.set(2 / info.width, 2 / info.height);

    const a = this.aoMat.uniforms;
    a.tGB.value = gbuffer;
    (a.uProjParams.value as THREE.Vector2).copy(info.projParams);
    (a.uTexel.value as THREE.Vector2).copy(halfTexel);
    a.uFar.value = info.far;
    a.uProjScale.value = info.projScale;
    // Cap the screen-space march so a low-flying pass over terrain does not
    // turn into a 200-pixel-wide gather on the pixels nearest the camera.
    a.uMaxRadiusPx.value = Math.max(12, info.height * 0.05);
    drawFullScreen(renderer, this.aoMat, this.rtA);

    const b = this.blurMat.uniforms;
    (b.uTexel.value as THREE.Vector2).copy(halfTexel);
    b.tAO.value = this.rtA.texture;
    (b.uDirection.value as THREE.Vector2).set(1, 0);
    drawFullScreen(renderer, this.blurMat, this.rtB);

    b.tAO.value = this.rtB.texture;
    (b.uDirection.value as THREE.Vector2).set(0, 1);
    drawFullScreen(renderer, this.blurMat, this.rtA);
  }

  dispose(): void {
    disposeRT(this.rtA);
    disposeRT(this.rtB);
    this.aoMat.dispose();
    this.blurMat.dispose();
  }
}

const _v2a = new THREE.Vector2();

const AO_FRAG = /* glsl */`
  precision highp float;

  ${GLSL_COMMON}
  ${GLSL_VIEWPOS}

  uniform sampler2D tGB;
  uniform vec2  uTexel;        // half-resolution texel size
  uniform float uRadius;       // world-space sampling radius, metres
  uniform float uProjScale;    // pixels per metre at one metre
  uniform float uMaxRadiusPx;
  uniform float uIntensity;
  uniform float uBias;         // tangent-plane bias, kills self-occlusion

  varying vec2 vUv;

  void main() {
    vec4 g = texture2D( tGB, vUv );
    float z = g.b * uFar;
    if ( g.b > 0.9995 ) { gl_FragColor = vec4( 1.0, g.b, 0.0, 1.0 ); return; }

    vec3 P = viewPosAt( vUv, z );
    vec3 N = octDecode( g.rg );

    // Project the world radius to screen. Full-res pixels, halved because we
    // are marching in a half-resolution buffer's texel space.
    float radiusPx = clamp( uRadius * uProjScale / max( z, 0.05 ), 3.0, uMaxRadiusPx ) * 0.5;

    float rot = ign( gl_FragCoord.xy );
    float occ = 0.0;

    // Smallest height difference the gbuffer could possibly have resolved.
    //
    // The linear-depth channel is a HALF float carrying z/far with far = 120 km,
    // so its absolute resolution is z * 2^-10: 0.3 m at 300 m, 3 m at 3 km. Past
    // about a kilometre that staircase is *larger than uRadius*, and HBAO reads
    // its iso-depth terraces as real geometry. On a ground plane seen at a
    // shallow angle the terraces are horizontal screen bands, which is exactly
    // the scanline-striped grey quads (and the ragged glyph-like blobs where the
    // terraces cross the field relief) that were being painted over the whole
    // lower half of every low-altitude frame.
    //
    // Rejecting differences below the quantum removes them without a wider
    // gbuffer. It also retires the pass gracefully with distance, which is
    // correct on its own terms: a 2.6 m world radius at 3 km projects to well
    // under a pixel, so there is no occlusion left to compute there anyway.
    float quantum = z * 0.0012 + 0.02;

    for ( int d = 0; d < AO_DIRS; d ++ ) {
      float ang = ( float( d ) + rot ) * ( 6.2831853 / float( AO_DIRS ) );
      vec2 dir = vec2( cos( ang ), sin( ang ) );

      float best = 0.0;
      for ( int s = 1; s <= AO_STEPS; s ++ ) {
        float t = ( float( s ) - 0.5 + rot * 0.5 ) / float( AO_STEPS ) * radiusPx;
        vec2 suv = vUv + dir * t * uTexel;
        vec4 gs = texture2D( tGB, suv );
        if ( gs.b > 0.9995 ) continue;

        vec3 S = viewPosAt( suv, gs.b * uFar );
        vec3 D = S - P;
        float len = length( D );
        if ( len < 1e-4 ) continue;

        // Sine of the elevation angle above the tangent plane, with the
        // unresolvable part of the height difference taken off first.
        float sinE = ( dot( D, N ) - quantum ) / len;
        // Quadratic falloff: samples at the radius edge contribute nothing, so
        // the AO does not pop as geometry crosses the sampling boundary.
        float att = clamp( 1.0 - ( len * len ) / ( uRadius * uRadius ), 0.0, 1.0 );
        best = max( best, ( sinE - uBias ) * att );
      }
      occ += max( best, 0.0 );
    }

    occ /= float( AO_DIRS );
    float ao = clamp( 1.0 - occ * uIntensity, 0.0, 1.0 );
    // Store depth alongside so the blur can reject across silhouettes without
    // a second gbuffer fetch per tap.
    gl_FragColor = vec4( ao, g.b, 0.0, 1.0 );
  }
`;

const BLUR_FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D tAO;
  uniform vec2 uTexel;
  uniform vec2 uDirection;
  uniform float uDepthSigma;

  varying vec2 vUv;

  void main() {
    vec2 c = texture2D( tAO, vUv ).rg;
    float sum = c.r * 0.2270270270;
    float wsum = 0.2270270270;

    // 9-tap gaussian, linear-sampling offsets, gated by relative depth.
    const float offs[4] = float[4]( 1.3846153846, 3.2307692308, 5.1076923077, 7.0 );
    const float wts[4]  = float[4]( 0.3162162162, 0.0702702703, 0.0140540541, 0.0035 );

    for ( int i = 0; i < 4; i ++ ) {
      vec2 o = uDirection * uTexel * offs[ i ];
      vec2 a = texture2D( tAO, vUv + o ).rg;
      vec2 b = texture2D( tAO, vUv - o ).rg;
      // Relative depth difference: an absolute threshold would be meaningless
      // across a range that spans 0.35 m to 120 km.
      float ref = max( c.g, 1e-5 );
      float wa = wts[ i ] * exp( -abs( a.g - c.g ) / ( ref * uDepthSigma ) );
      float wb = wts[ i ] * exp( -abs( b.g - c.g ) / ( ref * uDepthSigma ) );
      sum += a.r * wa + b.r * wb;
      wsum += wa + wb;
    }

    gl_FragColor = vec4( sum / max( wsum, 1e-4 ), c.g, 0.0, 1.0 );
  }
`;
