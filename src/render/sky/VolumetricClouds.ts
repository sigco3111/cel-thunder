import * as THREE from 'three';
import { FULLSCREEN_VERT, PassRunner, makeHdrTarget, makeScreenLayer } from './fullscreen';
import { COMMON, GLSL3_OUT } from './shaderLib';
import type { SkyUniforms } from './sharedUniforms';
import type { CloudNoiseSet } from './noise';

/**
 * Raymarched volumetric clouds, cel-shaded.
 *
 * ## Pipeline
 *
 *   depth (external or self-generated)
 *        -> march   (half res, MRT: premultiplied scatter + transmittance, mean distance)
 *        -> resolve (temporal reprojection into a ping-ponged history buffer)
 *        -> godrays (quarter of that again, radial blur of the transmittance)
 *        -> composite (full res, depth-aware upsample + ink contour + height fog),
 *           drawn inside the game scene as the first transparent object
 *
 * ## Why the lighting is structured the way it is
 *
 * The obvious way to cel-shade a volumetric is to quantise the shading of every
 * sample. That does not work: integrating hundreds of independently quantised
 * samples averages the steps straight back out and you get grey soup with a
 * faint stripe in it.
 *
 * Instead the march accumulates *energy* and *visibility weight* separately,
 * producing one number per pixel — the visibility-weighted mean sunlight energy
 * of everything the ray saw. Quantising **that** produces large, coherent,
 * painted value shapes across a whole cloud tower, which is what anime cumulus
 * actually look like. The same weighted-mean trick gives us a stable mean depth
 * (for temporal reprojection and aerial perspective) and a stable rim term.
 *
 * ## Cost control
 *
 *   - half-resolution march with a 4-frame Halton jitter and reprojection;
 *   - two-level marching: 3x coarse steps through empty sky, fine steps with
 *     detail erosion and a light march only once density is found;
 *   - step length grows with distance, so a 38 km ray costs ~100 iterations
 *     rather than ~400;
 *   - transmittance early-out at 0.015;
 *   - 'ctx.settings.cloudSteps' scales the iteration budget directly.
 */

const HALTON: readonly [number, number][] = [
  [0.5, 0.3333333], [0.25, 0.6666667], [0.75, 0.1111111], [0.125, 0.4444444],
  [0.625, 0.7777778], [0.375, 0.2222222], [0.875, 0.5555556], [0.0625, 0.8888889],
];

// ---------------------------------------------------------------------------
// Shared GLSL: the cloud density field
// ---------------------------------------------------------------------------

const CLOUD_FIELD = /* glsl */`
uniform sampler3D uShape;
uniform sampler3D uDetail;
uniform sampler2D uWeather;

uniform vec3  uCamPos;
uniform float uTime;
uniform float uCloudBase;
uniform float uCloudTop;
uniform float uCoverage;
uniform float uDensity;
uniform float uCloudType;
uniform float uShapeScale;
uniform float uDetailScale;
uniform float uWeatherScale;
uniform vec3  uWind;
uniform vec2  uWeatherOffset;
uniform float uCloudPlanetR;
uniform float uCloudMaxDist;

/**
 * Altitude above the *camera-centred* cloud sphere.
 *
 * Centring the sphere under the camera rather than at the world origin is
 * deliberate: it keeps the curvature relative to the viewer, so cloud bases
 * always bend down toward the observer's horizon and never rise up at the far
 * corners of the map the way a world-anchored sphere would over 64 km.
 */
float altitudeAt( vec3 p ) {
  vec3 d = vec3( p.x - uCamPos.x, p.y + uCloudPlanetR, p.z - uCamPos.z );
  return length( d ) - uCloudPlanetR;
}

/**
 * Vertical density profile per cloud type. Stratus is a thin sheet near the
 * base, cumulus is a rounded mass through the middle, cumulonimbus fills the
 * whole slab and spreads at the top (the anvil).
 */
float heightGradient( float h, float type ) {
  float st = remapC( h, 0.0, 0.07, 0.0, 1.0 ) * remapC( h, 0.20, 0.36, 1.0, 0.0 );
  float cu = remapC( h, 0.0, 0.22, 0.0, 1.0 ) * remapC( h, 0.55, 0.96, 1.0, 0.0 );
  float cb = remapC( h, 0.0, 0.09, 0.0, 1.0 ) * remapC( h, 0.84, 1.00, 1.0, 0.0 );
  float wS = saturate1( 1.0 - type * 2.0 );
  float wC = saturate1( 1.0 - abs( type - 0.5 ) * 2.0 );
  float wB = saturate1( type * 2.0 - 1.0 );
  return st * wS + cu * wC + cb * wB;
}

/** Convective clouds carry more water aloft, so density rises with height. */
float densityProfile( float h ) {
  return remapC( h, 0.0, 0.14, 0.0, 1.0 ) * remapC( h, 0.88, 1.0, 1.0, 0.25 ) * ( 0.4 + 0.7 * h );
}

/**
 * Cloud density at a world point, given a pre-fetched weather sample.
 *
 * Splitting the weather lookup out matters for performance, not tidiness: the
 * light march walks at most ~3 km horizontally from its origin, over which the
 * weather field (30-40 km per tile) is effectively constant. Reusing the
 * primary sample's coverage removes one of the two texture fetches from the
 * single hottest loop in the whole renderer.
 */
float cloudDensityCore( vec3 p, int lod, vec3 w, out float hOut ) {
  float cov = w.x, type = w.y, hScale = w.z;
  float alt = altitudeAt( p );
  // Local cloud-top height. A single flat slab ceiling is what turns any
  // coverage above about 0.6 into an overcast pudding: every ray hits the same
  // altitude, the surface normal is straight up everywhere, and the whole field
  // renders as one pale sheet with nothing to shade. Letting the weather map
  // decide how far each part of the field convects is the difference between a
  // cloud *layer* and a cloud *scape* — tall towers, short humps, and a top
  // surface with a silhouette.
  float thick = max( ( uCloudTop - uCloudBase ) * hScale, 1.0 );
  float h = ( alt - uCloudBase ) / thick;
  hOut = h;
  if ( h < 0.0 || h > 1.0 || cov <= 0.002 ) return 0.0;

  vec3 sp = ( p + uWind ) * uShapeScale;
  vec4 sh = textureLod( uShape, sp, 0.0 );

  // Rebuild the low-frequency FBM from the three stored Worley octaves and use
  // it to carve the Perlin base: this is what gives cauliflower edges rather
  // than the smooth blobs a plain Perlin threshold produces.
  float lowFbm = sh.g * 0.625 + sh.b * 0.25 + sh.a * 0.125;
  float base = saturate1( remap( sh.r, lowFbm - 1.0, 1.0, 0.0, 1.0 ) );
  base *= heightGradient( h, type );

  float d = saturate1( remap( base, 1.0 - cov, 1.0, 0.0, 1.0 ) ) * cov;
  if ( d <= 0.0 ) return 0.0;

  if ( lod == 0 ) {
    // Detail erosion. The wind offset is exaggerated and a slow vertical drift
    // is added so the small features evolve and shear instead of translating
    // rigidly with the mass.
    vec3 dp = ( p + uWind * 1.7 ) * uDetailScale + vec3( 0.0, uTime * 0.006, 0.0 );
    vec3 det = textureLod( uDetail, dp, 0.0 ).rgb;
    float dFbm = det.r * 0.625 + det.g * 0.25 + det.b * 0.125;
    // Wispy filaments at the base, billowy cauliflower at the top.
    float m = mix( 1.0 - dFbm, dFbm, saturate1( h * 3.0 ) );
    d = saturate1( remap( d, m * 0.34, 1.0, 0.0, 1.0 ) );
  }

  return d * uDensity * densityProfile( h );
}

/** Fetches the weather sample for 'p' into (coverage, cloud type, top height). */
vec3 sampleWeather( vec3 p ) {
  // textureLod, not texture: inside a raymarch the screen-space derivatives of
  // the sample position are meaningless (neighbouring pixels are kilometres
  // apart in world space), so automatic mip selection picks a near-top mip and
  // the coverage field breaks into visible blocks. This one call is the
  // difference between clean cloud silhouettes and a pixelated mess at range.
  vec2 wuv = p.xz * uWeatherScale + uWeatherOffset;
  vec4 wm = textureLod( uWeather, wuv, 0.0 );
  return vec3(
    // Capped below 1: at full saturation the base-shape threshold
    // 'remap(base, 1-cov, 1, ...)' degenerates to the identity and stops
    // carving cloud out of the slab altogether.
    min( saturate1( wm.r * ( 0.5 + uCoverage ) + ( uCoverage - 0.55 ) ), 0.86 ),
    saturate1( wm.g * 0.62 + uCloudType * 0.72 - 0.17 ),
    // How far this part of the field convects, as a fraction of the authored
    // slab depth. Tied to the variation channel and to coverage, because in a
    // real field the deepest towers stand where the most moisture is.
    0.40 + 0.60 * saturate1( wm.a * 0.80 + wm.r * 0.42 - 0.06 ) );
}

/** Convenience wrapper for callers that do not already have a weather sample. */
float cloudDensity( vec3 p, int lod, out float hOut ) {
  return cloudDensityCore( p, lod, sampleWeather( p ), hOut );
}
`;

// ---------------------------------------------------------------------------
// Pass 1 — raymarch (MRT)
// ---------------------------------------------------------------------------

export function createCloudMarchMaterial(u: SkyUniforms, noise: CloudNoiseSet): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'CloudMarch',
    glslVersion: THREE.GLSL3,
    uniforms: {
      uShape: { value: noise.shape },
      uDetail: { value: noise.detail },
      uWeather: { value: noise.weather },
      uDepth: { value: null as THREE.Texture | null },
      uJitter: { value: new THREE.Vector2() },

      uTime: u.uTime, uFrame: u.uFrame,
      uCamPos: u.uCamPos, uCamFwd: u.uCamFwd,
      uInvViewProj: u.uInvViewProj, uNear: u.uNear, uFar: u.uFar,
      uSunDir: u.uSunDir, uSunColor: u.uSunColor,
      uZenithColor: u.uZenithColor, uHorizonColor: u.uHorizonColor,

      uCloudBase: u.uCloudBase, uCloudTop: u.uCloudTop,
      uCoverage: u.uCoverage, uDensity: u.uDensity, uCloudType: u.uCloudType,
      uShapeScale: u.uShapeScale, uDetailScale: u.uDetailScale, uWeatherScale: u.uWeatherScale,
      uWind: u.uWind, uWeatherOffset: u.uWeatherOffset,
      uCloudPlanetR: u.uCloudPlanetR, uCloudMaxDist: u.uCloudMaxDist,
      uCloudAmbient: u.uCloudAmbient, uSilver: u.uSilver,
      uSigma: u.uSigma, uPowder: u.uPowder, uEnergyGain: u.uEnergyGain,
      uSteps: u.uCloudSteps, uLightSteps: u.uCloudLightSteps,

      uCloudBands: u.uCloudBands, uCloudBandSoft: u.uCloudBandSoft,
      uCloudCelMix: u.uCloudCelMix,
      uCloudLit: u.uCloudLit, uCloudCore: u.uCloudCore, uCloudRim: u.uCloudRim,
      uCloudGround: u.uCloudGround, uCloudForm: u.uCloudForm,
      uCloudRimStrength: u.uCloudRimStrength,
      uAerialFar: u.uAerialFar,

      uBoltPos: u.uBoltPos, uBoltIntensity: u.uBoltIntensity,
      uLightningColor: u.uLightningColor,
      uNight: u.uNight,
    },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: /* glsl */`
      precision highp float;
      precision highp sampler3D;

      layout(location = 0) out vec4 outScatter;  // rgb premultiplied in-scatter, a transmittance
      layout(location = 1) out vec4 outAux;      // r mean distance, g opacity

      ${COMMON}
      ${CLOUD_FIELD}

      uniform sampler2D uDepth;
      uniform vec2  uJitter;
      uniform float uFrame;
      uniform vec3  uCamFwd;
      uniform mat4  uInvViewProj;
      uniform float uNear, uFar;

      uniform vec3  uSunDir, uSunColor;
      uniform vec3  uZenithColor, uHorizonColor;
      uniform float uCloudAmbient, uSilver;
      uniform float uSigma, uPowder, uEnergyGain;
      uniform float uSteps, uLightSteps;
      uniform float uCloudBands, uCloudBandSoft, uCloudCelMix;
      uniform vec3  uCloudLit, uCloudCore, uCloudRim, uCloudGround;
      uniform float uCloudForm;
      uniform float uCloudRimStrength;
      uniform float uAerialFar;
      uniform vec3  uBoltPos, uLightningColor;
      uniform float uBoltIntensity;
      uniform float uNight;

      varying vec2 vNdc;
      varying vec2 vUv;

      // Cone offsets for the light march. Sampling a cone rather than a line
      // approximates the finite angular size of the sun and, more importantly,
      // stops thin sheets from producing a razor-edged shadow terminator.
      const vec3 CONE[6] = vec3[6](
        vec3(  0.38,  0.34,  0.24 ),
        vec3( -0.31,  0.42, -0.19 ),
        vec3(  0.22, -0.36,  0.41 ),
        vec3( -0.44, -0.21, -0.33 ),
        vec3(  0.06,  0.48, -0.45 ),
        vec3(  0.00,  0.00,  0.00 )
      );

      float lightOpticalDepth( vec3 p, vec3 w, float steps ) {
        float thick = max( uCloudTop - uCloudBase, 1.0 );
        float stepLen = thick * 0.05;
        float t = 0.0;
        float od = 0.0;
        float hDummy;
        for ( int i = 0; i < 6; i ++ ) {
          if ( float( i ) >= steps ) break;
          t += stepLen;
          // 0.18, not 0.55. The cone stands in for the sun's finite angular
          // size (and for the fact that a hard shadow terminator on a thin
          // sheet looks wrong); at 0.55 the far taps land nearly two kilometres
          // sideways, deep inside neighbouring towers, so every sample —
          // including the ones on a fully exposed sunlit top — came back
          // reporting a thick sunward column. That is why a lit cloud deck was
          // rendering the same pale blue as its own underside.
          vec3 q = p + uSunDir * t + CONE[ i ] * t * 0.18;
          od += cloudDensityCore( q, 1, w, hDummy ) * stepLen;
          // Once the sunward column is this thick the sample is fully shadowed;
          // the remaining samples cannot change the result by a visible amount.
          if ( od * uSigma > 4.0 ) return od;
          // Geometric growth: near samples resolve the local shadow, the far
          // one catches the bulk of a neighbouring tower for almost nothing.
          stepLen *= 1.9;
        }
        od += cloudDensityCore( p + uSunDir * thick * 2.4, 1, w, hDummy ) * thick * 0.6;
        return od;
      }

      /**
       * Outward surface normal of the cloud at 'p', from the gradient of the
       * density field.
       *
       * This is the piece that turns the layer from a stain into sculpture. The
       * transmittance integral on its own is *correct* and *flat*: under a
       * developed deck every ray is fully shadowed, so the visibility-weighted
       * mean energy is the same small number across the whole underside and the
       * quantiser has nothing to draw with. A gradient at the first hit gives
       * the ray a surface to shade, which is what a painter would have drawn —
       * sunward faces, cool undersides, a terminator running over each billow.
       *
       * Six lod-1 samples (no detail octave, and the caller's weather sample is
       * reused) once per pixel, not per march step.
       */
      vec3 cloudNormal( vec3 p, vec3 w, float e ) {
        float hD;
        vec3 g = vec3(
          cloudDensityCore( p + vec3( e, 0.0, 0.0 ), 1, w, hD )
        - cloudDensityCore( p - vec3( e, 0.0, 0.0 ), 1, w, hD ),
          cloudDensityCore( p + vec3( 0.0, e, 0.0 ), 1, w, hD )
        - cloudDensityCore( p - vec3( 0.0, e, 0.0 ), 1, w, hD ),
          cloudDensityCore( p + vec3( 0.0, 0.0, e ), 1, w, hD )
        - cloudDensityCore( p - vec3( 0.0, 0.0, e ), 1, w, hD ) );
        float l = length( g );
        // Deep inside a uniform mass there is no gradient at all. Falling back
        // to "up" is the honest answer — the mean outward direction of a cumulus
        // surface — and it keeps the term from flickering on interior pixels.
        return l < 1e-7 ? vec3( 0.0, 1.0, 0.0 ) : -g * ( 1.0 / l );
      }

      void main() {
        vec2 ndc = vNdc + uJitter;
        vec4 wp = uInvViewProj * vec4( ndc, 1.0, 1.0 );
        vec3 rd = normalize( wp.xyz / wp.w - uCamPos );

        float camY = uCamPos.y;
        vec3 ro = vec3( 0.0, uCloudPlanetR + camY, 0.0 );
        float rb = uCloudPlanetR + uCloudBase;
        float rt = uCloudPlanetR + uCloudTop;

        float b0, b1, c0, c1;
        bool hb = raySphere( ro, rd, rb, b0, b1 );
        bool ht = raySphere( ro, rd, rt, c0, c1 );

        float tStart = 0.0;
        float tEnd = -1.0;
        if ( camY < uCloudBase ) {
          // Under the deck: enter where the ray leaves the base shell.
          if ( ht && b1 > 0.0 ) { tStart = b1; tEnd = c1; }
        } else if ( camY < uCloudTop ) {
          // Inside the layer.
          tStart = 0.0;
          tEnd = ( hb && b0 > 0.0 ) ? b0 : c1;
        } else {
          // Above the deck, looking down into it.
          if ( ht && c1 > 0.0 ) {
            tStart = max( c0, 0.0 );
            tEnd = ( hb && b0 > 0.0 ) ? b0 : c1;
          }
        }

        // Opaque geometry clips the march. Reconstructing distance from the
        // depth buffer is what makes aircraft and terrain correctly occlude
        // clouds instead of the clouds being a flat sky layer.
        float dz = texture( uDepth, vUv ).x;
        if ( dz < 0.9999995 ) {
          float viewZ = ( uNear * uFar ) / ( ( uFar - uNear ) * dz - uFar );
          float sceneDist = ( -viewZ ) / max( dot( rd, uCamFwd ), 1e-3 );
          tEnd = min( tEnd, sceneDist );
        }

        tStart = max( tStart, 0.0 );
        tEnd = min( tEnd, uCloudMaxDist );

        // Mid-layer distance is the reprojection fallback for empty pixels.
        float midDist = clamp( ( tStart + max( tEnd, tStart ) ) * 0.5, 1.0, uCloudMaxDist );

        if ( tEnd <= tStart + 1.0 ) {
          outScatter = vec4( 0.0, 0.0, 0.0, 1.0 );
          outAux = vec4( midDist, 0.0, 0.0, 1.0 );
          return;
        }

        float thick = max( uCloudTop - uCloudBase, 1.0 );
        // Step length is set by the layer thickness, not the ray length: what
        // matters is resolving vertical structure, and the ray can be 38 km.
        float baseStep = max( thick / max( uSteps * 0.62, 8.0 ), 26.0 );
        float coarseStep = baseStep * 3.0;

        // Ray-start dither. Without it the march produces concentric shells;
        // with it the error becomes high-frequency noise the temporal filter
        // removes almost entirely.
        float jit = ign( gl_FragCoord.xy + vec2( mod( uFrame, 16.0 ) * 13.7 ) );
        // Golden-ratio decorrelation gives a second, independent dither from
        // the same hash.
        float jit2 = fract( jit + 0.6180339887 );
        float t = tStart + jit * coarseStep;

        float T = 1.0;
        float lightAccum = 0.0, rimAccum = 0.0, boltAccum = 0.0;
        float distAccum = 0.0, hAccum = 0.0, wSum = 0.0;

        float mu = dot( rd, uSunDir );
        // Two-lobe HG: a strong forward lobe for the silver lining plus a weak
        // backward lobe so clouds do not go flat when the sun is behind you.
        float phase = max( phaseHG( mu, 0.72 ), 0.62 * phaseHG( mu, -0.22 ) ) * 4.2;

        bool fine = false;
        int misses = 0;
        int budget = int( clamp( uSteps * 1.9, 36.0, 112.0 ) );
        float h = 0.0;

        // First significant hit along the ray — the surface the eye reads as
        // "the cloud". Kept so the shading pass can take a gradient there.
        bool  haveFirst = false;
        vec3  firstP = vec3( 0.0 );
        vec3  firstW = vec3( 0.0, 0.0, 1.0 );

        for ( int i = 0; i < 128; i ++ ) {
          if ( i >= budget || t > tEnd || T < 0.015 ) break;
          vec3 p = uCamPos + rd * t;

          // Distance-growing steps: doubling roughly every 5 km keeps the far
          // field affordable while the near field stays fully resolved.
          float grow = min( 1.0 + t * ( 1.0 / 8000.0 ), 4.5 );

          // Cheap altitude reject before any texture work: outside the slab
          // there is nothing to sample and the weather fetch would be wasted.
          float altH = ( altitudeAt( p ) - uCloudBase ) / max( uCloudTop - uCloudBase, 1.0 );
          if ( altH < 0.0 || altH > 1.0 ) {
            t += ( fine ? baseStep : coarseStep ) * grow;
            continue;
          }
          vec3 wx = sampleWeather( p );

          if ( ! fine ) {
            float d = cloudDensityCore( p, 1, wx, h );
            if ( d > 0.0 ) {
              // Back up one coarse step so the entry surface is not skipped,
              // and re-dither with a decorrelated offset. Without this second
              // jitter every ray enters cloud on the same coarse lattice and
              // the temporal filter has nothing but concentric rings to average.
              t = max( t - coarseStep * grow, tStart ) + jit2 * baseStep;
              fine = true;
              misses = 0;
              continue;
            }
            t += coarseStep * grow;
          } else {
            float d = cloudDensityCore( p, 0, wx, h );
            if ( d <= 0.0 ) {
              misses ++;
              if ( misses > 6 ) fine = false;
              t += baseStep * grow;
            } else {
              misses = 0;
              if ( ! haveFirst ) { haveFirst = true; firstP = p; firstW = wx; }
              // Dissolve into haze rather than popping at the march boundary.
              d *= 1.0 - smoothstep( uCloudMaxDist * 0.7, uCloudMaxDist, t );

              float dt = baseStep * grow;
              float ext = d * uSigma;
              float dT = exp( -ext * dt );
              float w = T * ( 1.0 - dT );

              // Samples this far back are barely visible; a two-tap shadow is
              // indistinguishable there and saves the bulk of the light march.
              float lsteps = T > 0.10 ? uLightSteps : 2.0;
              float od = lightOpticalDepth( p, wx, lsteps ) * uSigma;
              // Multiple-scattering approximation (Wrenninge's octave trick):
              // sum several Beer terms with progressively smaller extinction.
              // Single scattering alone renders every cloud base as flat black,
              // because in reality almost all the light down there arrived by
              // bouncing several times. Two extra exp() buys the entire
              // interior gradient that makes a cumulus read as volume.
              // The constant is a diffuse-reflectance floor. Without it this sum
              // decays to zero and a thick cloud tends to black, whereas a real
              // one tends to its albedo — around 0.7-0.9 — because the photons
              // that cannot get through come back out of the face they went in.
              // Normalised so od = 0 still returns exactly 1.
              float beer = ( exp( -od ) + 0.50 * exp( -od * 0.30 )
                           + 0.22 * exp( -od * 0.09 ) + 0.055 ) * ( 1.0 / 1.775 );
              // Powder term: light entering near a sun-facing edge scatters
              // back out, so those edges are genuinely darker than Beer alone.
              float powder = 1.0 - exp( -od * 2.0 - ext * dt * 3.0 );
              float energy = beer * ( 1.0 - uPowder + uPowder * powder * 2.0 );

              lightAccum += energy * w;
              // The rim only survives where the sunward optical depth is tiny —
              // i.e. the thin lit shell on the sun side of a tower.
              rimAccum += smoothstep( 0.75, 0.06, od ) * smoothstep( 0.04, 0.30, d ) * w;
              distAccum += t * w;
              hAccum += h * w;

              if ( uBoltIntensity > 0.001 ) {
                vec3 toB = uBoltPos - p;
                boltAccum += w * uBoltIntensity * 4.0e6 / ( 1.0e6 + dot( toB, toB ) );
              }

              wSum += w;
              T *= dT;
              t += dt;
            }
          }
        }

        float alpha = 1.0 - T;
        if ( wSum < 1e-5 ) {
          outScatter = vec4( 0.0, 0.0, 0.0, 1.0 );
          outAux = vec4( midDist, 0.0, 0.0, 1.0 );
          return;
        }

        float invW = 1.0 / wSum;
        float E    = lightAccum * invW;
        float rim  = rimAccum * invW;
        float dist = distAccum * invW;
        float hMean = hAccum * invW;
        float bolt = boltAccum * invW;

        // ---- cel shading -------------------------------------------------
        // One quantisation for the whole ray. See the file header for why this
        // is done here rather than per sample.

        // The surface the eye reads as "the cloud", and how it faces the sun.
        // The sample spacing is a twentieth of the layer thickness — coarse
        // enough to sit above the detail-erosion frequency (a gradient taken at
        // erosion scale is noise, not form) and fine enough to resolve one
        // billow of a cumulus tower.
        vec3 nrm = ( haveFirst && uCloudForm > 0.002 )
          ? cloudNormal( firstP, firstW, max( thick * 0.05, 40.0 ) )
          : vec3( 0.0, 1.0, 0.0 );
        float ndl = dot( nrm, uSunDir );
        float sunny = saturate1( ndl * 0.5 + 0.5 );
        // A painted cumulus has a hard, high terminator: most of what you see is
        // either "sun side" or "shadow side", joined by a narrow warm transition
        // and topped by a small hot facet. That shape is authored here rather
        // than left to the quantiser, because the quantiser is downstream of the
        // *sum* of every lighting term and would smear it.
        float form = mix( 0.30, 1.12, smoothstep( 0.28, 0.82, sunny ) )
                   + 0.17 * smoothstep( 0.88, 1.00, sunny );

        // The phase function must not scale the *whole* reflectance. Multiple
        // scattering inside a cloud is very nearly isotropic, so a cumulus is
        // bright white from almost every direction and the Henyey-Greenstein
        // lobe only adds the forward-scatter bonus on top. Folding it in as a
        // plain multiplier (0.55 + 0.45 * phase) dimmed every cloud not being
        // looked at within 40 degrees of the sun to two thirds of its value,
        // which is most of the clouds in most frames.
        float phaseTerm = 0.86 + 0.40 * min( phase, 3.0 );
        float Ew = E * phaseTerm * mix( 1.0, form, uCloudForm );
        // Expand rather than merely scale. The raw weighted-mean energy of a
        // developed deck only spans about 0.05-0.5 between its base and its
        // sunlit top, which lands entirely inside one or two of the four cel
        // bands — so the whole layer came out as a single flat value. A power
        // curve stretches that range across the full ramp, which is what lets
        // the quantiser draw core, shadow, warm mid and full sun as four
        // distinct painted shapes on one cloud.
        float Ep = pow( max( Ew * uEnergyGain, 0.0 ), 0.70 );
        // Skylight is the other half of a cloud's illumination and it reaches
        // the tops far more than the bases. It goes in *before* the quantiser so
        // it lands inside the painted band structure instead of washing a flat
        // grey over it — which is what an ambient term added afterwards does.
        float skyAccess = saturate1( nrm.y * 0.5 + 0.5 );
        Ep += ( 0.035 + 0.09 * skyAccess ) * uCloudAmbient * mix( 0.6, 1.0, saturate1( hMean ) );

        float q = celQuantise( saturate1( Ep ), uCloudBands, uCloudBandSoft );
        q = mix( saturate1( Ep ), q, uCloudCelMix );

        // Four-stop painted ramp rather than a two-colour lerp. The extra
        // stops are what separate "cel shaded" from "posterised": a cool
        // shadow step and a distinctly *warmer* mid step, so the terminator
        // carries a hue rotation instead of just a value change.
        vec3 skyTint = mix( uHorizonColor, uZenithColor, 0.42 );
        // What a cloud is lit by when the sun cannot reach it: skylight from
        // above and bounce off the ground below. Both are real, both are what
        // keeps the core a saturated colour instead of a hole in the frame. A
        // cumulus base measures 15-25 % of the luminance of its own sunlit top;
        // at 3 % it stops reading as cloud and starts reading as a smudge.
        vec3 fill    = skyTint * 1.30 + uCloudGround * 0.85 + 0.010;
        vec3 pLit    = uCloudLit * uSunColor;                               // full sun
        vec3 pCore   = uCloudCore * fill;                                   // blue-violet core
        vec3 pShadow = mix( pCore, pLit, 0.19 ) * vec3( 0.86, 0.94, 1.18 ); // cool shadow
        vec3 pMid    = mix( pCore, pLit, 0.62 ) * vec3( 1.09, 1.00, 0.88 ); // warm mid
        float s0 = saturate1( q / 0.34 );
        float s1 = saturate1( ( q - 0.34 ) / 0.30 );
        float s2 = saturate1( ( q - 0.64 ) / 0.36 );
        vec3 col = mix( mix( mix( pCore, pShadow, s0 ), pMid, s1 ), pLit, s2 );

        // Bases sit in their own shadow; tops catch skylight. Kept gentle now
        // that the normal term carries the form: 'hMean' is the scattering-
        // weighted mean height along the ray, so a camera just above the deck
        // looking *down* gets a low mean even though what it can see is a sunlit
        // top, and a deep floor here paints that whole frame flat blue.
        col *= mix( 0.88, 1.04, saturate1( hMean * 1.20 + 0.06 ) );

        // Ground bounce lands on the underside, which is exactly where the sun
        // does not. Keying it on a downward-facing normal lifts the base of a
        // tower without touching its shadow side, and gives the deck a warm
        // reflected note off the farmland that separates it from the sky.
        col += uCloudGround * uCloudAmbient * saturate1( -nrm.y ) * 1.6;

        // Hard sunward rim — the crisp bright contour of a backlit cumulus.
        col += uCloudRim * uSunColor * rim * uCloudRimStrength;

        // Silver lining: forward-scattered light punching through a thin edge.
        // It needs *both* conditions — the sun roughly behind the cloud and the
        // cloud thin enough right here to transmit. Keying it on the accumulated
        // alpha as well as on the phase angle is what confines it to the rim of
        // the silhouette instead of glazing the whole tower.
        float thinEdge = smoothstep( 0.99, 0.40, alpha );
        col += uSunColor * uSilver * ( pow( saturate1( mu ), 3.0 ) * 0.95 + 0.09 )
             * thinEdge * E * 2.4;

        // In-cloud lightning.
        col += uLightningColor * bolt;

        // Aerial perspective. Distant towers must sit in the same haze the
        // terrain does or the depth cue breaks — and a 25 km cumulus that is
        // still full contrast is the single loudest "this is a render" tell.
        float ap = 1.0 - exp( -dist / max( uAerialFar * 1.05, 1.0 ) );
        col = mix( col, uHorizonColor * 1.06, ap * 0.80 );

        // Night: clouds keep a little moonlight and a lot of blue.
        col = mix( col, col * vec3( 0.55, 0.66, 1.0 ) * 0.55, uNight * 0.85 );

        // Clamp before the temporal filter: one Inf from a degenerate ray
        // would otherwise be smeared across the history buffer for seconds.
        col = clamp( col, vec3( 0.0 ), vec3( 48.0 ) );
        outScatter = vec4( col * alpha, T );
        outAux = vec4( dist, alpha, 0.0, 1.0 );
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
}

// ---------------------------------------------------------------------------
// Pass 2 — temporal resolve
// ---------------------------------------------------------------------------

export function createCloudResolveMaterial(u: SkyUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'CloudResolve',
    glslVersion: THREE.GLSL3,
    uniforms: {
      uCurrent: { value: null as THREE.Texture | null },
      uCurrentAux: { value: null as THREE.Texture | null },
      uHistory: { value: null as THREE.Texture | null },
      uTexel: { value: new THREE.Vector2() },
      uBlend: { value: 0.14 },
      uReset: { value: 1 },
      uCamPos: u.uCamPos,
      uInvViewProj: u.uInvViewProj,
      uPrevViewProj: u.uPrevViewProj,
    },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: /* glsl */`
      precision highp float;
      layout(location = 0) out vec4 outColor;

      uniform sampler2D uCurrent;
      uniform sampler2D uCurrentAux;
      uniform sampler2D uHistory;
      uniform vec2  uTexel;
      uniform float uBlend;
      uniform float uReset;
      uniform vec3  uCamPos;
      uniform mat4  uInvViewProj;
      uniform mat4  uPrevViewProj;

      varying vec2 vNdc;
      varying vec2 vUv;

      void main() {
        vec4 cur = texture( uCurrent, vUv );
        float dist = texture( uCurrentAux, vUv ).r;

        // Reproject through the cloud's own mean depth. Using a fixed plane
        // instead would smear towers against the sky whenever the camera rolls.
        vec4 wp = uInvViewProj * vec4( vNdc, 1.0, 1.0 );
        vec3 rd = normalize( wp.xyz / wp.w - uCamPos );
        vec3 world = uCamPos + rd * max( dist, 1.0 );
        vec4 pc = uPrevViewProj * vec4( world, 1.0 );

        float valid = step( 1e-4, pc.w );
        vec2 prevUv = pc.xy / max( pc.w, 1e-4 ) * 0.5 + 0.5;
        valid *= step( 0.0, prevUv.x ) * step( prevUv.x, 1.0 )
               * step( 0.0, prevUv.y ) * step( prevUv.y, 1.0 );
        valid *= 1.0 - clamp( uReset, 0.0, 1.0 );

        vec4 hist = texture( uHistory, prevUv );

        // Neighbourhood clamp in a cross pattern. This is what keeps the
        // history from ghosting a cloud edge across the sky during hard turns.
        vec4 n0 = texture( uCurrent, vUv + vec2( uTexel.x, 0.0 ) );
        vec4 n1 = texture( uCurrent, vUv - vec2( uTexel.x, 0.0 ) );
        vec4 n2 = texture( uCurrent, vUv + vec2( 0.0, uTexel.y ) );
        vec4 n3 = texture( uCurrent, vUv - vec2( 0.0, uTexel.y ) );
        vec4 mn = min( cur, min( min( n0, n1 ), min( n2, n3 ) ) );
        vec4 mx = max( cur, max( max( n0, n1 ), max( n2, n3 ) ) );
        // Widen the box slightly: a tight clamp throws away the sub-pixel
        // detail the jittered march is there to accumulate in the first place.
        vec4 mid = ( mn + mx ) * 0.5;
        mn = mid + ( mn - mid ) * 1.12;
        mx = mid + ( mx - mid ) * 1.12;
        hist = clamp( hist, mn, mx );

        float a = mix( 1.0, uBlend, valid );
        outColor = mix( hist, cur, a );
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
}

// ---------------------------------------------------------------------------
// Pass 3 — crepuscular rays
// ---------------------------------------------------------------------------

export function createGodRayMaterial(u: SkyUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'GodRays',
    glslVersion: THREE.GLSL3,
    uniforms: {
      uCloud: { value: null as THREE.Texture | null },
      uDepth: { value: null as THREE.Texture | null },
      uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
      uSamples: { value: 24 },
      uDecay: { value: 0.965 },
      uSpread: { value: 0.68 },
      uStrength: { value: 1 },
      uNear: u.uNear, uFar: u.uFar,
    },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: /* glsl */`
      precision highp float;
      layout(location = 0) out vec4 outColor;

      uniform sampler2D uCloud;
      uniform sampler2D uDepth;
      uniform vec2  uSunUv;
      uniform float uSamples;
      uniform float uDecay;
      uniform float uSpread;
      uniform float uStrength;

      varying vec2 vUv;

      void main() {
        // Occlusion buffer: light reaches the pixel only where there is no
        // geometry and the clouds are not blocking it. Marching that buffer
        // radially toward the sun is the classic Mitchell screen-space
        // approximation of an integral through a participating medium.
        vec2 delta = ( vUv - uSunUv ) * ( uSpread / uSamples );
        vec2 c = vUv;
        float illum = 1.0;
        float sum = 0.0;
        for ( int i = 0; i < 32; i ++ ) {
          if ( float( i ) >= uSamples ) break;
          c -= delta;
          float t = texture( uCloud, c ).a;
          float dz = texture( uDepth, c ).x;
          float sky = smoothstep( 0.99980, 0.99999, dz );
          sum += t * sky * illum;
          illum *= uDecay;
        }
        sum /= uSamples;
        // Fade out toward the frame edges so the effect does not read as a
        // hard vignette when the sun is just off screen.
        float edge = 1.0 - smoothstep( 0.55, 1.35, length( vUv - uSunUv ) );
        outColor = vec4( vec3( sum * uStrength * edge ), 1.0 );
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
}

// ---------------------------------------------------------------------------
// Pass 4 — composite into the scene
// ---------------------------------------------------------------------------

export function createCloudCompositeMaterial(u: SkyUniforms, weatherTex: THREE.Texture): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    name: 'CloudComposite',
    glslVersion: THREE.GLSL3,
    uniforms: {
      uCloud: { value: null as THREE.Texture | null },
      uDepth: { value: null as THREE.Texture | null },
      uGodRays: { value: null as THREE.Texture | null },
      uCloudTexel: { value: new THREE.Vector2() },
      uHasGodRays: { value: 0 },
      uWeather: { value: weatherTex },
      uWeatherScale: u.uWeatherScale,
      uWeatherOffset: u.uWeatherOffset,

      uCamPos: u.uCamPos, uCamFwd: u.uCamFwd,
      uInvViewProj: u.uInvViewProj, uNear: u.uNear, uFar: u.uFar,
      uSunDir: u.uSunDir, uSunColor: u.uSunColor,
      uHorizonColor: u.uHorizonColor, uZenithColor: u.uZenithColor,
      uCloudInk: u.uCloudInk, uCloudInkAmount: u.uCloudInkAmount,
      uCloudInkWidth: u.uCloudInkWidth, uResolution: u.uResolution,
      uGodRayStrength: u.uGodRayStrength,
      uGroundFog: u.uGroundFog, uGroundFogHeight: u.uGroundFogHeight,
      uCloudMaxDist: u.uCloudMaxDist,
      uNight: u.uNight,
    },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: /* glsl */`
      precision highp float;
      ${GLSL3_OUT}
      ${COMMON}

      uniform sampler2D uCloud;
      uniform sampler2D uDepth;
      uniform sampler2D uGodRays;
      uniform sampler2D uWeather;
      uniform vec2  uCloudTexel;
      uniform float uHasGodRays;
      uniform float uWeatherScale;
      uniform vec2  uWeatherOffset;

      uniform vec3  uCamPos, uCamFwd;
      uniform mat4  uInvViewProj;
      uniform float uNear, uFar;
      uniform vec3  uSunDir, uSunColor;
      uniform vec3  uHorizonColor, uZenithColor;
      uniform vec3  uCloudInk;
      uniform float uCloudInkAmount;
      uniform float uCloudInkWidth;
      uniform vec2  uResolution;
      uniform float uGodRayStrength;
      uniform float uGroundFog, uGroundFogHeight;
      uniform float uCloudMaxDist;
      uniform float uNight;

      varying vec2 vNdc;
      varying vec2 vUv;

      float linearDepth( float dz ) {
        if ( dz >= 0.9999995 ) return 1e9;
        return -( ( uNear * uFar ) / ( ( uFar - uNear ) * dz - uFar ) );
      }

      /**
       * Analytic optical depth of an exponential height-fog layer along a ray.
       * Closed form: integrating rho0 * exp(-y/H) along y = y0 + rd.y * t.
       * Doing this analytically rather than marching is what makes fog banks
       * essentially free.
       */
      float heightFogOD( vec3 ro, vec3 rd, float L, float density ) {
        if ( density <= 1e-9 ) return 0.0;
        float H = max( uGroundFogHeight, 1.0 );
        float base = density * exp( -max( ro.y, 0.0 ) / H );
        float ry = rd.y;
        if ( abs( ry ) < 1e-4 ) return base * L;
        return base * ( H / ry ) * ( 1.0 - exp( -ry * L / H ) );
      }

      void main() {
        vec4 wp = uInvViewProj * vec4( vNdc, 1.0, 1.0 );
        vec3 rd = normalize( wp.xyz / wp.w - uCamPos );

        float dzRef = texture( uDepth, vUv ).x;
        float linRef = linearDepth( dzRef );

        // ---- depth-aware upsample -------------------------------------------
        // A plain bilinear fetch of a half-res buffer bleeds cloud across the
        // silhouette of any aircraft in front of it. Compare the depth each
        // low-res tap was marched against; if the tap disagrees with this
        // pixel, fall back to the nearest-matching tap instead of blending.
        vec2 f = vUv / uCloudTexel - 0.5;
        vec2 baseUv = ( floor( f ) + 0.5 ) * uCloudTexel;

        // Rotated-grid 4-tap tent. A single bilinear fetch of a 0.38x buffer
        // leaves visible texel corners wherever cloud meets bright sky; four
        // half-texel diagonal taps average those away for the cost of three
        // extra fetches, without touching the silhouette itself (the ink pass
        // below re-sharpens it).
        vec2 d1 = uCloudTexel * 0.42;
        vec4 bilinear = ( texture( uCloud, vUv + vec2(  d1.x,  d1.y ) )
                        + texture( uCloud, vUv + vec2( -d1.x,  d1.y ) )
                        + texture( uCloud, vUv + vec2(  d1.x, -d1.y ) )
                        + texture( uCloud, vUv + vec2( -d1.x, -d1.y ) ) ) * 0.25;

        vec4 nearest = bilinear;
        float bestErr = 1e30;
        float worstErr = 0.0;
        for ( int i = 0; i < 4; i ++ ) {
          vec2 o = vec2( float( i & 1 ), float( ( i >> 1 ) & 1 ) ) * uCloudTexel;
          vec2 tuv = baseUv + o;
          float lin = linearDepth( texture( uDepth, tuv ).x );
          float err = abs( lin - linRef );
          worstErr = max( worstErr, err );
          if ( err < bestErr ) { bestErr = err; nearest = texture( uCloud, tuv ); }
        }
        // Tolerance scales with distance: absolute depth error grows with range
        // and a fixed threshold would trip on every distant surface.
        float tol = 1.0 + linRef * 0.03;
        vec4 cloud = mix( bilinear, nearest, step( tol, worstErr ) );

        vec3 scatter = cloud.rgb;
        float T = clamp( cloud.a, 0.0, 1.0 );

        // ---- ink contour -----------------------------------------------------
        // Gradient of transmittance is sharpest exactly on the cloud silhouette,
        // so a cheap 4-tap difference gives a clean drawn outline without an
        // extra pass or any geometry.
        //
        // The taps are offset by a fixed number of *screen* pixels, not by one
        // march-buffer texel. Measured in texels the same cloud got a 2.0 px
        // line at ultra, 2.6 px at high and 4.2 px at low — one asset, three
        // line weights, changing under the player whenever the adaptive governor
        // stepped quality. The brief asks for constant screen-space width.
        //
        // Because the offset is now smaller than a texel at every tier, the raw
        // gradient across a hard edge is only (offset / texel) of the full step.
        // Dividing it back out ('perTexel') recovers a resolution-independent
        // measure of edge strength, so the *threshold* is stable even though the
        // *width* is fixed in pixels.
        vec2 inkStep = vec2( uCloudInkWidth ) / max( uResolution, vec2( 1.0 ) );
        float perTexel = clamp( uCloudInkWidth / max( uResolution.x * uCloudTexel.x, 1e-4 ),
                                0.08, 1.0 );
        float t0 = texture( uCloud, vUv + vec2( inkStep.x, 0.0 ) ).a;
        float t1 = texture( uCloud, vUv - vec2( inkStep.x, 0.0 ) ).a;
        float t2 = texture( uCloud, vUv + vec2( 0.0, inkStep.y ) ).a;
        float t3 = texture( uCloud, vUv - vec2( 0.0, inkStep.y ) ).a;
        float grad = max( max( abs( T - t0 ), abs( T - t1 ) ), max( abs( T - t2 ), abs( T - t3 ) ) )
                   / perTexel;
        // A soft, wispy edge spreads the same transmittance change over several
        // texels, so it never reaches the threshold a hard edge does and the
        // line used to appear and vanish along a single cloud's outline. Taking
        // a fractional power flattens that difference without inking flat areas
        // (where 'grad' really is zero).
        float ink = smoothstep( 0.10, 0.46, pow( grad, 0.62 ) ) * uCloudInkAmount;
        // ...and only on the cloud, never on open sky.
        ink *= smoothstep( 0.015, 0.16, 1.0 - T );
        // Darken the scatter and firm up the edge; together they read as a
        // deliberate contour line rather than as a compression artefact.
        scatter = mix( scatter, scatter * uCloudInk * 2.2, ink );
        T *= 1.0 - 0.28 * ink;

        // ---- god rays ---------------------------------------------------------
        vec3 shafts = vec3( 0.0 );
        if ( uHasGodRays > 0.5 ) {
          float g = texture( uGodRays, vUv ).r;
          // Only in front of the camera, and only where you are looking near
          // the sun — shafts appearing behind you would be nonsense.
          float toward = saturate1( dot( rd, uSunDir ) );
          // Shafts are an *accent*: the radial integral already returns close to
          // 1 across open sky, so it needs a small coefficient and a tight
          // angular window or it becomes a full-screen additive wash.
          //
          // The 0.10 floor was that wash. It put a tenth of full shaft strength
          // on every sky pixel in the frame regardless of where the sun was,
          // and with the source just off the left edge the radial blur smeared
          // it into one broad diagonal wedge across the upper sky with no
          // origin visible anywhere — a lens artefact, not a crepuscular ray.
          // Shafts now fall off to nothing away from the sun, which is the only
          // place they can physically be.
          float lobe = 0.02 + 0.98 * pow( toward, 5.0 );
          shafts = uSunColor * g * uGodRayStrength * 0.30 * lobe;
        }

        // ---- ground fog banks -------------------------------------------------
        float L = min( linRef, uCloudMaxDist * 1.6 );
        // Fog banks, not a uniform sheet: modulate the layer density by the
        // weather map sampled halfway along the ray. Real radiation fog pools
        // in low ground and along rivers, so the density has to have structure
        // measured in kilometres or it reads as a rendering setting.
        vec2 fuv = ( uCamPos.xz + rd.xz * min( L, 6000.0 ) * 0.5 ) * uWeatherScale * 2.6 + uWeatherOffset;
        float bank = textureLod( uWeather, fuv, 0.0 ).b;
        float fogDensity = uGroundFog * ( 0.30 + 1.85 * bank * bank );
        float fogOd = heightFogOD( uCamPos, rd, L, fogDensity );
        float fogA = 1.0 - exp( -fogOd );
        // Fog is lit by the sun it faces: forward scattering makes a bank glow
        // when you look into the light and stay cool blue when you look away.
        float mu = dot( rd, uSunDir );
        vec3 fogCol = mix( uHorizonColor * 1.05, uSunColor * 1.25, saturate1( phaseHG( mu, 0.55 ) * 2.2 ) );
        fogCol = mix( fogCol, uZenithColor * 0.7, uNight * 0.8 );

        // Composite order: fog over the scene, clouds over that, shafts added.
        // The blend function is ( src = ONE, dst = SRC_ALPHA ), so alpha here is
        // the total transmittance of everything this pass puts in front.
        float outAlpha = ( 1.0 - fogA ) * T;
        vec3 src = fogCol * fogA * T + scatter + shafts;

        gl_FragColor = vec4( max( src, vec3( 0.0 ) ), outAlpha );
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.SrcAlphaFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  return mat;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface CloudQuality {
  /** Fraction of the drawing buffer the march runs at (0.5 = quarter the pixels). */
  renderScale: number;
  /** Primary march budget; scaled from ctx.settings.cloudSteps. */
  steps: number;
  /** Light-march samples, 3..6. */
  lightSteps: number;
  /** Radial blur taps for the god rays, 0 disables. */
  godRaySamples: number;
  /** History blend weight for the new frame; lower = smoother but laggier. */
  temporalBlend: number;
}

export class VolumetricClouds {
  readonly compositeMesh: THREE.Mesh;

  private readonly runner = new PassRunner();
  private readonly marchMat: THREE.ShaderMaterial;
  private readonly resolveMat: THREE.ShaderMaterial;
  private readonly godMat: THREE.ShaderMaterial;
  private readonly compositeMat: THREE.ShaderMaterial;

  private marchRT!: THREE.WebGLRenderTarget;
  private history: THREE.WebGLRenderTarget[] = [];
  private godRT!: THREE.WebGLRenderTarget;
  private historyIndex = 0;

  private width = 0;
  private height = 0;
  private scale = 0.5;
  private frame = 0;
  private needsReset = true;

  /** Screen-space position of the sun, updated by the owner each frame. */
  readonly sunUv = new THREE.Vector2(0.5, 0.5);
  sunOnScreen = false;

  constructor(private readonly u: SkyUniforms, noise: CloudNoiseSet) {
    this.marchMat = createCloudMarchMaterial(u, noise);
    this.resolveMat = createCloudResolveMaterial(u);
    this.godMat = createGodRayMaterial(u);
    this.compositeMat = createCloudCompositeMaterial(u, noise.weather);
    // renderOrder -500 puts the composite first in the transparent queue, so it
    // lands on top of all opaque geometry but underneath tracers and explosions.
    this.compositeMesh = makeScreenLayer(this.compositeMat, -500, 'skyCloudComposite');
    this.compositeMesh.layers.enable(3);
  }

  applyQuality(q: CloudQuality): void {
    this.u.uCloudSteps.value = q.steps;
    this.u.uCloudLightSteps.value = q.lightSteps;
    this.godMat.uniforms.uSamples.value = q.godRaySamples;
    this.resolveMat.uniforms.uBlend.value = q.temporalBlend;
    if (Math.abs(q.renderScale - this.scale) > 0.001) {
      this.scale = q.renderScale;
      if (this.width > 0) this.resize(this.width, this.height, true);
    }
  }

  /** Invalidate the temporal history (camera teleport, weather cut, resize). */
  reset(): void { this.needsReset = true; }

  resize(width: number, height: number, force = false): void {
    const w = Math.max(8, Math.round(width * this.scale));
    const h = Math.max(8, Math.round(height * this.scale));
    if (!force && this.width === width && this.height === height && this.marchRT) return;
    this.width = width;
    this.height = height;

    this.marchRT?.dispose();
    for (const rt of this.history) rt.dispose();
    this.godRT?.dispose();

    this.marchRT = makeHdrTarget(w, h, 2);
    this.history = [makeHdrTarget(w, h), makeHdrTarget(w, h)];
    this.godRT = makeHdrTarget(Math.max(4, w >> 1), Math.max(4, h >> 1));

    this.resolveMat.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.compositeMat.uniforms.uCloudTexel.value.set(1 / w, 1 / h);
    this.needsReset = true;
  }

  /**
   * Runs the offscreen half of the cloud pipeline. Must be called with the
   * camera matrices already final for this frame; the composite mesh is then
   * drawn by whoever renders the scene.
   */
  render(renderer: THREE.WebGLRenderer, depth: THREE.Texture, godRaysEnabled: boolean): void {
    if (!this.marchRT) return;
    this.frame++;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    // Sub-pixel jitter in NDC units so successive frames sample different
    // points inside each low-resolution texel; the temporal filter then
    // reconstructs detail the half-res buffer could not hold on its own.
    const [jx, jy] = HALTON[this.frame & 7];
    const w = this.marchRT.width, h = this.marchRT.height;
    (this.marchMat.uniforms.uJitter.value as THREE.Vector2).set(
      (jx - 0.5) * 2 / w, (jy - 0.5) * 2 / h,
    );
    this.marchMat.uniforms.uDepth.value = depth;
    this.runner.render(renderer, this.marchMat, this.marchRT);

    const src = this.history[this.historyIndex];
    const dst = this.history[this.historyIndex ^ 1];
    this.resolveMat.uniforms.uCurrent.value = this.marchRT.textures[0];
    this.resolveMat.uniforms.uCurrentAux.value = this.marchRT.textures[1];
    this.resolveMat.uniforms.uHistory.value = src.texture;
    this.resolveMat.uniforms.uReset.value = this.needsReset ? 1 : 0;
    this.runner.render(renderer, this.resolveMat, dst);
    this.historyIndex ^= 1;
    this.needsReset = false;

    const useGodRays = godRaysEnabled && this.sunOnScreen
      && (this.godMat.uniforms.uSamples.value as number) > 0;
    if (useGodRays) {
      this.godMat.uniforms.uCloud.value = dst.texture;
      this.godMat.uniforms.uDepth.value = depth;
      (this.godMat.uniforms.uSunUv.value as THREE.Vector2).copy(this.sunUv);
      this.runner.render(renderer, this.godMat, this.godRT);
    }

    this.compositeMat.uniforms.uCloud.value = dst.texture;
    this.compositeMat.uniforms.uDepth.value = depth;
    this.compositeMat.uniforms.uGodRays.value = this.godRT.texture;
    this.compositeMat.uniforms.uHasGodRays.value = useGodRays ? 1 : 0;

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  dispose(): void {
    this.marchRT?.dispose();
    for (const rt of this.history) rt.dispose();
    this.godRT?.dispose();
    this.marchMat.dispose();
    this.resolveMat.dispose();
    this.godMat.dispose();
    this.compositeMat.dispose();
    this.runner.dispose();
  }
}
