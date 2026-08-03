import * as THREE from 'three';
import { FULLSCREEN_VERT } from './fullscreen';
import { COMMON, ATMOSPHERE, GLSL3_OUT } from './shaderLib';
import type { SkyUniforms } from './sharedUniforms';

/**
 * Sky = two passes.
 *
 * 1. **Scattering LUT** (128 x 96, HDR, offscreen). Single-scattering Rayleigh
 *    + Mie integrated properly, but only over the two angles the radiance
 *    actually depends on for a spherically symmetric atmosphere: view zenith
 *    angle and azimuth relative to the sun. That turns a 2-million-pixel,
 *    70-sample integral into a 12k-texel one — about 0.05 ms — and the LUT only
 *    needs rebuilding when the sun or the camera altitude moves meaningfully.
 *
 * 2. **Backdrop** (full resolution, drawn first in the game scene). Samples the
 *    LUT, then does everything that cannot live in a 2D LUT: the sun disc with
 *    limb darkening, the moon with a real phase, stars, the milky way, two
 *    scrolling cirrus layers, the distant cumulus deck on the horizon — and the
 *    stylisation pass that turns physically-correct radiance into something
 *    that reads as painted.
 *
 * The stylisation is deliberately applied *after* the physics rather than
 * instead of it. Quantising a correct gradient keeps the hue rotation from
 * zenith to horizon, the Chappuis dip at twilight and the Mie aureole around
 * the sun; hand-authoring those is exactly where stylised skies usually fall
 * apart.
 */

export const SKY_LUT_WIDTH = 128;
export const SKY_LUT_HEIGHT = 96;


export function createSkyLutMaterial(u: SkyUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'SkyLut',
    glslVersion: THREE.GLSL3,
    uniforms: {
      uSunCosZenith: { value: 0.7 },
      uAltitude: u.uAltitudeLut,
      uHaze: u.uHaze,
      uIrradiance: { value: 22 },
    },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: /* glsl */`
      precision highp float;
      ${GLSL3_OUT}
      ${COMMON}
      ${ATMOSPHERE}

      uniform float uSunCosZenith;
      uniform float uAltitude;
      uniform float uHaze;
      uniform float uIrradiance;

      varying vec2 vUv;

      void main() {
        // u -> azimuth from the sun in [0, PI]; the atmosphere is symmetric
        // about the sun-zenith plane so half the sphere is enough.
        float phi = vUv.x * PI;

        // v -> view zenith, warped by a square so texels bunch near the horizon
        // where the gradient is steepest.
        float s = vUv.y * 2.0 - 1.0;
        float ct = sign( s ) * s * s;
        float st = sqrt( max( 0.0, 1.0 - ct * ct ) );

        vec3 rd = vec3( st * cos( phi ), ct, st * sin( phi ) );
        float sct = clamp( uSunCosZenith, -1.0, 1.0 );
        vec3 sunDir = vec3( sqrt( max( 0.0, 1.0 - sct * sct ) ), sct, 0.0 );

        vec3 L = computeSkyRadiance( uAltitude, rd, sunDir, uHaze, uIrradiance );
        gl_FragColor = vec4( L, 1.0 );
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
}

export function createSkyBackdropMaterial(
  u: SkyUniforms,
  lut: THREE.Texture,
  cirrusTex: THREE.Texture,
): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    name: 'SkyBackdrop',
    glslVersion: THREE.GLSL3,
    uniforms: {
      uLut: { value: lut },
      uCirrus: { value: cirrusTex },
      uLutTexel: { value: new THREE.Vector2(1 / SKY_LUT_WIDTH, 1 / SKY_LUT_HEIGHT) },
      uDeckUvScale: { value: 1 / 190000 },
      uSunDiscBrightness: { value: 34 },

      uTime: u.uTime,
      uCamPos: u.uCamPos,
      uInvViewProj: u.uInvViewProj,
      uSunDir: u.uSunDir,
      uSunColor: u.uSunColor,
      uSunAngularRadius: u.uSunAngularRadius,
      uMoonDir: u.uMoonDir,
      uMoonColor: u.uMoonColor,
      uMoonIllum: u.uMoonIllum,
      uMoonAngularRadius: u.uMoonAngularRadius,
      uStarRot: u.uStarRot,
      uNight: u.uNight,

      uZenithColor: u.uZenithColor,
      uHorizonColor: u.uHorizonColor,
      uTwilight: u.uTwilight,
      uSkyExposure: u.uSkyExposure,
      uSkyBands: u.uSkyBands,
      uSkyBandSoft: u.uSkyBandSoft,
      uSkyBandAmount: u.uSkyBandAmount,
      uSkySaturation: u.uSkySaturation,
      uOvercast: u.uOvercast,
      uWhiteout: u.uWhiteout,
      uWhiteoutColor: u.uWhiteoutColor,
      uHorizonWarm: u.uHorizonWarm,
      uHorizonWarmAmount: u.uHorizonWarmAmount,

      uCirrusAmount: u.uCirrusAmount,
      uCirrusHeight: u.uCirrusHeight,
      uCirrusOffset: u.uCirrusOffset,
      uCirrusOffset2: u.uCirrusOffset2,
      uDeckAmount: u.uDeckAmount,
      uDeckHeight: u.uDeckHeight,
      uDeckOffset: u.uDeckOffset,
      uDeckNear: u.uDeckNear,
      uCloudMaxDist: u.uCloudMaxDist,
      uCloudPlanetR: u.uCloudPlanetR,
      uSilver: u.uSilver,
      uAerialFar: u.uAerialFar,
      uCloudLit: u.uCloudLit,
      uCloudCore: u.uCloudCore,
      uCloudBands: u.uCloudBands,
      uCloudBandSoft: u.uCloudBandSoft,

      uLightningFlash: u.uLightningFlash,
      uLightningColor: u.uLightningColor,
    },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: /* glsl */`
      precision highp float;
      ${GLSL3_OUT}
      ${COMMON}

      uniform sampler2D uLut;
      uniform sampler2D uCirrus;
      uniform vec2  uLutTexel;
      uniform float uDeckUvScale;
      uniform float uSunDiscBrightness;

      uniform float uTime;
      uniform vec3  uCamPos;
      uniform mat4  uInvViewProj;
      uniform vec3  uSunDir;
      uniform vec3  uSunColor;
      uniform float uSunAngularRadius;
      uniform vec3  uMoonDir;
      uniform vec3  uMoonColor;
      uniform float uMoonIllum;
      uniform float uMoonAngularRadius;
      uniform mat4  uStarRot;
      uniform float uNight;

      uniform vec3  uZenithColor;
      uniform vec3  uHorizonColor;
      uniform vec3  uTwilight;
      uniform float uSkyExposure;
      uniform float uSkyBands;
      uniform float uSkyBandSoft;
      uniform float uSkyBandAmount;
      uniform float uSkySaturation;
      uniform float uOvercast;
      uniform float uWhiteout;
      uniform vec3  uWhiteoutColor;
      uniform vec3  uHorizonWarm;
      uniform float uHorizonWarmAmount;

      uniform float uCirrusAmount;
      uniform float uCirrusHeight;
      uniform vec2  uCirrusOffset;
      uniform vec2  uCirrusOffset2;
      uniform float uDeckAmount;
      uniform float uDeckHeight;
      uniform vec2  uDeckOffset;
      uniform float uDeckNear;
      uniform float uCloudMaxDist;
      uniform float uCloudPlanetR;
      uniform float uSilver;
      uniform float uAerialFar;
      uniform vec3  uCloudLit;
      uniform vec3  uCloudCore;
      uniform float uCloudBands;
      uniform float uCloudBandSoft;

      uniform float uLightningFlash;
      uniform vec3  uLightningColor;

      varying vec2 vNdc;
      varying vec2 vUv;

      // -- sky LUT -----------------------------------------------------------
      vec3 sampleSkyLut( vec3 rd ) {
        float ct = clamp( rd.y, -1.0, 1.0 );
        vec2 dh = rd.xz;
        vec2 sh = uSunDir.xz;
        float dl = length( dh ), sl = length( sh );
        float cosPhi = ( dl > 1e-5 && sl > 1e-5 ) ? clamp( dot( dh, sh ) / ( dl * sl ), -1.0, 1.0 ) : 1.0;
        float lu = acos( cosPhi ) / PI;
        float lv = 0.5 + 0.5 * sign( ct ) * sqrt( abs( ct ) );
        // Inset by half a texel so the extreme angles are not smeared by clamp.
        lu = lu * ( 1.0 - uLutTexel.x ) + uLutTexel.x * 0.5;
        lv = lv * ( 1.0 - uLutTexel.y ) + uLutTexel.y * 0.5;
        return texture( uLut, vec2( lu, lv ) ).rgb;
      }

      // -- stars --------------------------------------------------------------
      // Lattice-on-a-shell: the view direction is scaled onto a sphere of
      // radius N, and only lattice cells whose jittered point happens to land
      // near that shell produce a star. That gives an even, non-repeating
      // distribution with a single hash per pixel instead of a 3x3x3 search.
      vec3 starField( vec3 eq ) {
        vec3 p = eq * 214.0;
        vec3 c = floor( p );
        vec3 h = hash33( c );
        float exists = step( 0.930, h.z );
        vec3 sp = c + 0.15 + h * 0.7;
        float d = length( p - sp );

        float mag = hash11( h.x * 71.3 + h.y * 13.7 );
        float radius = mix( 0.032, 0.115, pow( mag, 4.0 ) );

        // Analytic minimum size. One lattice cell subtends 1/214 rad = 4.7 mrad,
        // so the authored radii are 0.15-0.54 mrad — smaller than the 0.6-1.1
        // mrad a pixel covers at any sane FOV. Point-sampled, most of the field
        // would be sub-pixel dots that wink in and out as the camera turns, and
        // nothing downstream can fix that: the backdrop goes into the HDR scene
        // buffer with no MSAA, and FXAA cannot reconstruct a dot that was never
        // sampled. 'fwidth' of the *continuous* lattice position (not of 'd',
        // which jumps at every cell boundary) gives the pixel footprint here.
        float px = length( fwidth( p ) ) * 0.5 + 1e-6;
        float rEff = max( radius, px * 1.15 );
        // Conserve total flux as the disc is widened, or antialiasing would make
        // the whole sky brighter — a widened star must be correspondingly dimmer.
        float energy = ( radius * radius ) / ( rEff * rEff );

        float core = smoothstep( rEff, rEff * 0.35, d );
        // The halo has to widen with the core for the same reason.
        float halo = exp( -d / ( rEff * 2.4 ) ) * 0.26;

        // Scintillation: atmospheric, so it is stronger near the horizon. Damped
        // on stars that had to be widened — twinkle on a star that is already at
        // the sampling limit is indistinguishable from aliasing, and reads as it.
        float tw = 1.0 - ( 0.28 - 0.28 * ( 1.0 - energy ) )
                 * ( 1.0 - sin( uTime * ( 1.7 + mag * 5.0 ) + mag * 41.0 ) );
        // O/B stars are blue, K/M are orange; bias the population warm-ish.
        vec3 tint = mix( vec3( 0.72, 0.82, 1.0 ), vec3( 1.0, 0.84, 0.66 ), hash11( mag * 51.7 + 3.1 ) );
        // Magnitude distribution: a handful of bright stars carry the eye, the
        // rest are a faint field. A linear brightness spread reads as noise.
        return tint * ( core + halo ) * exists * energy
             * ( 0.45 + pow( mag, 2.6 ) * 7.0 ) * tw;
      }

      vec3 milkyWay( vec3 eq ) {
        // Galactic north pole in equatorial coordinates (RA 12h51m, Dec +27.1).
        const vec3 GAL_POLE = vec3( -0.8677, -0.1978, 0.4560 );
        float band = 1.0 - abs( dot( eq, GAL_POLE ) );
        band = pow( saturate1( band ), 10.0 );
        float dust = fbm3( eq * 8.0, 4 );
        float lanes = 1.0 - smoothstep( 0.44, 0.78, fbm3( eq * 21.0 + 5.0, 3 ) );
        return vec3( 0.30, 0.33, 0.46 ) * band * ( 0.28 + dust * 0.95 ) * lanes * 1.1;
      }

      // -- moon ---------------------------------------------------------------
      float moonAlbedo( vec3 n ) {
        float maria = fbm3( n * 3.2 + 11.0, 4 );
        float a = mix( 0.58, 1.0, smoothstep( 0.40, 0.60, maria ) );
        float craters = fbm3( n * 15.0, 3 );
        a *= 0.86 + 0.30 * craters;
        return clamp( a, 0.0, 1.3 );
      }

      vec3 moonDisc( vec3 rd ) {
        float cosM = dot( rd, uMoonDir );
        if ( cosM < 0.9 ) return vec3( 0.0 );
        float ang = acos( clamp( cosM, -1.0, 1.0 ) );
        float r = ang / uMoonAngularRadius;

        vec3 col = vec3( 0.0 );

        // Soft aureole around the disc — thin high cloud always produces one.
        col += uMoonColor * exp( -ang * 130.0 ) * 0.16 * uMoonIllum;

        if ( r < 1.02 ) {
          vec3 upRef = abs( uMoonDir.y ) > 0.95 ? vec3( 1.0, 0.0, 0.0 ) : vec3( 0.0, 1.0, 0.0 );
          vec3 mx = normalize( cross( upRef, uMoonDir ) );
          vec3 my = cross( uMoonDir, mx );
          vec2 d2 = vec2( dot( rd, mx ), dot( rd, my ) ) / uMoonAngularRadius;
          float z = sqrt( max( 0.0, 1.0 - dot( d2, d2 ) ) );
          vec3 n = normalize( mx * d2.x + my * d2.y + uMoonDir * z );

          // Phase comes out of the real sun direction, so it is always correct
          // relative to where the sun actually is below the horizon.
          float nl = max( dot( n, uSunDir ), 0.0 );
          // Lunar regolith backscatters hard; Lambert alone looks like a
          // billiard ball. This is a crude opposition-effect approximation.
          float lunar = pow( nl, 0.55 );
          float albedo = moonAlbedo( n );
          float edge = 1.0 - smoothstep( 0.97, 1.02, r );
          vec3 surface = uMoonColor * albedo * ( lunar * 1.15 + 0.035 );
          // Earthshine on the dark limb.
          surface += uMoonColor * 0.022 * ( 1.0 - uMoonIllum ) * albedo;
          col += surface * edge * 2.6;
        }
        return col;
      }

      // -- cirrus -------------------------------------------------------------
      //
      // Deliberately *not* a texture lookup. One anisotropic tiling texture
      // sampled on one shell is what produced the mechanically parallel stripe
      // field: every streak was the same streak, at the same angle, at the same
      // spacing, repeated to the edge of the frame. No amount of layering hides
      // that, because the thing being repeated is the thing you can see.
      //
      // What replaces it is a procedural field with three properties a tiled
      // texture cannot have at any cost: the flow direction varies across the
      // sky, the domain is warped so filaments hook and fray instead of running
      // as ruled ribbons, and a low-frequency patch mask thins the sheet to
      // nothing over most of the dome so cirrus arrives in streaks and banks of
      // different length and density rather than as wallpaper.
      float cHash( vec2 p ) {
        vec3 q = fract( p.xyx * vec3( 0.1031, 0.1030, 0.0973 ) );
        q += dot( q, q.yzx + 33.33 );
        return fract( ( q.x + q.y ) * q.z );
      }
      float cNoise( vec2 p ) {
        vec2 i = floor( p ), f = fract( p );
        f = f * f * ( 3.0 - 2.0 * f );
        return mix( mix( cHash( i ), cHash( i + vec2( 1.0, 0.0 ) ), f.x ),
                    mix( cHash( i + vec2( 0.0, 1.0 ) ), cHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
      }

      // Coverage (x) and filament value (y) for one cirrus sheet.
      //   p    position on the sheet; 1.0 unit = 10 km
      //   px   screen footprint of 'p', so octaves can be dropped before they alias
      //   ang  mean jet-stream heading for this sheet
      //   sd   decorrelates the sheets
      //   amt  coverage drive
      vec2 cirrusMask( vec2 p, float px, float ang, float sd, float amt ) {
        // 1. Where there is any cirrus at all. Stretched along the mean flow so
        //    the field breaks into banks and streaks of different lengths rather
        //    than round clumps, and low enough in places that the sheet vanishes.
        vec2 d0 = vec2( cos( ang ), sin( ang ) );
        vec2 n0 = vec2( -d0.y, d0.x );
        vec2 pf = vec2( dot( p, d0 ) * 0.26, dot( p, n0 ) );
        float bankMask = cNoise( pf * 0.34 + sd )
                    + 0.55 * cNoise( pf * 0.79 + sd * 1.7 + 4.1 )
                    + 0.25 * cNoise( pf * 1.71 + sd * 2.3 + 8.7 );
        bankMask = smoothstep( 1.06 - amt * 1.05, 1.66 - amt * 0.80, bankMask );
        if ( bankMask < 0.004 ) return vec2( 0.0 );

        // 2. The heading is not constant. A bend field shears it by up to ~40
        //    degrees over a few tens of kilometres — short enough that the
        //    variation happens *inside* the frame rather than beyond it, which
        //    is the difference between streaks that splay and cross and streaks
        //    that only look parallel because you are seeing one bend of a very
        //    long wave. That was still the single biggest tell left.
        float bend = ( cNoise( p * 0.17 + sd * 3.3 ) - 0.5 )
                   + 0.5 * ( cNoise( p * 0.43 + sd * 7.1 + 2.6 ) - 0.5 );
        float a = ang + bend * 1.35;
        vec2 dir = vec2( cos( a ), sin( a ) );
        vec2 nrm = vec2( -dir.y, dir.x );

        // 3. Domain warp at three scales, one along the flow and two across it.
        //    This is what puts the hook on the end of a fallstreak and frays the
        //    tail; straight anisotropic noise gives blunt-ended ribbons. The two
        //    sheets drift at different speeds and headings, so the warped fields
        //    slide through each other rather than translating as one block.
        vec2 q = p;
        q += dir * ( cNoise( p * 0.29 + sd * 11.0 ) - 0.5 ) * 3.1;
        q += nrm * ( cNoise( p * 0.57 + sd * 5.5 + 1.9 ) - 0.5 ) * 0.95;
        q += nrm * ( cNoise( p * 1.63 + sd * 2.9 + 6.3 ) - 0.5 ) * 0.24;

        // 4. Filaments: ridged octaves in the local flow frame. Each octave is
        //    rotated ~9 degrees from the last so no two share an axis, and each
        //    fades out once its period approaches the pixel footprint — which is
        //    also what stops the shell's perspective convergence turning into a
        //    comb in the last few degrees above the horizon.
        vec2 e = vec2( dot( q, dir ) * 0.11, dot( q, nrm ) );
        float f = 0.0, norm = 0.0, amp = 1.0, sc = 2.4;
        for ( int i = 0; i < 5; i ++ ) {
          float w = amp * smoothstep( 1.05, 0.30, sc * px );
          if ( w > 0.003 ) {
            float n = cNoise( e * sc + float( i ) * 23.0 + sd );
            f += w * ( 1.0 - abs( n * 2.0 - 1.0 ) );
          }
          norm += amp;
          // A slow amplitude falloff on purpose. Cirrus is *striated*: the fine
          // octaves are the fibres inside a streak, and at a conventional 0.5
          // gain they vanish under the base band and the layer comes out as
          // smooth ribbons — closer to a contrail than to ice.
          amp *= 0.62;
          sc *= 2.31;
          e = mat2( 0.982, 0.190, -0.190, 0.982 ) * e;
        }
        f /= max( norm, 1e-4 );

        // 5. Coverage. 'bankMask' both gates and thins, so opacity varies
        //    continuously along a streak and drops to zero between banks.
        float cov = smoothstep( 0.60 - amt * 0.34, 0.90 - amt * 0.24, f ) * bankMask;
        return vec2( cov, f );
      }

      vec4 cirrusShell( vec3 rd, float height, float ang, float sd, float amt, vec2 adv ) {
        // Reject rays pointing away from the sheet *before* any noise is
        // evaluated. The backdrop is a depth-test-free fullscreen pass, so in a
        // framing like 'hero' two thirds of the pixels are looking at terrain
        // and would otherwise pay for two full cirrus fields whose alpha the
        // grazing fade below multiplies by zero anyway.
        float side = uCamPos.y < height ? 1.0 : -1.0;
        if ( rd.y * side < 0.010 ) return vec4( 0.0 );

        // Same art-directed planet radius the volumetric layer curves against,
        // so the two systems meet at the same altitude.
        vec3 ro = vec3( 0.0, uCloudPlanetR + uCamPos.y, 0.0 );
        float t0, t1;
        if ( ! raySphere( ro, rd, uCloudPlanetR + height, t0, t1 ) ) return vec4( 0.0 );
        float t = uCamPos.y < height ? t1 : t0;
        if ( t <= 0.0 || t > 900000.0 ) return vec4( 0.0 );

        const float CS = 1.0 / 10000.0;
        vec2 p = ( uCamPos.xz + rd.xz * t ) * CS + adv;
        // Analytic screen footprint of 'p': a pixel subtends ~1.6 mrad at this
        // FOV, and a shell crossed at a grazing angle stretches that by 1/|rd.y|.
        // Cheaper than fwidth and, unlike fwidth, still defined after the
        // early-outs below diverge between neighbouring pixels.
        float px = t * 0.0016 * CS / max( abs( rd.y ), 0.035 );

        vec2 m = cirrusMask( p, px, ang, sd, amt );
        if ( m.x < 0.004 ) return vec4( 0.0 );
        float b = m.y;

        float alpha = m.x * amt * 1.85;
        // Grazing rays travel through kilometres of ice and wash out.
        alpha *= smoothstep( 0.010, 0.13, abs( rd.y ) );
        alpha *= exp( -t * 2.6e-6 );
        if ( alpha < 0.002 ) return vec4( 0.0 );

        float mu = dot( rd, uSunDir );
        // Ice plates are strongly forward scattering — this is what produces the
        // brilliant silver streak of cirrus that sits near the sun. The lobe has
        // to be clamped: an uncapped HG peak is several hundred percent and
        // turns the whole upper sky white whenever the sun is low.
        float fwd = min( phaseHG( mu, 0.84 ) * 4.0 + phaseHG( mu, 0.2 ) * 1.0, 2.6 );
        float e = celQuantise( saturate1( 0.16 + b * 0.72 + fwd * 0.26 ), 4.0, 0.13 );
        // A cirrus shell at 8-9 km is above the terminator: when the sun has set
        // for the ground it is still in direct, and *unusually clean*, sunlight
        // — barely any of the air mass the horizon beam went through. That is
        // the whole reason a sunset sky is on fire overhead while the land below
        // is already blue, and 0.70 x the ground-level sun colour rendered it as
        // grey lint instead. Boost hard as the sun drops, and un-redden slightly
        // because the light reaching that altitude has lost far less blue.
        float high = 1.0 - smoothstep( 0.02, 0.34, uSunDir.y );
        vec3 sunHigh = mix( uSunColor, uSunColor * vec3( 1.0, 1.14, 1.30 ), high * 0.45 );
        vec3 lit = sunHigh * ( 0.82 + fwd * 0.50 ) * ( 1.0 + 1.35 * high );
        vec3 shade = mix( uHorizonColor, uZenithColor, 0.35 ) * ( 0.80 + 0.35 * high );
        vec3 col = mix( shade, lit, e );
        col = mix( col, uHorizonColor * 1.15, 1.0 - exp( -t / max( uAerialFar * 4.0, 1.0 ) ) );
        return vec4( col, alpha );
      }

      // -- distant cumulus deck ----------------------------------------------
      // Sits beyond the volumetric raymarch range on a real-curvature shell, so
      // the world reads as continuing past the playable box instead of ending.
      vec4 horizonDeck( vec3 rd ) {
        if ( uDeckAmount < 0.003 ) return vec4( 0.0 );
        vec3 ro = vec3( 0.0, uCloudPlanetR + uCamPos.y, 0.0 );
        float t0, t1;
        if ( ! raySphere( ro, rd, uCloudPlanetR + uDeckHeight, t0, t1 ) ) return vec4( 0.0 );
        float t = uCamPos.y < uDeckHeight ? t1 : t0;
        if ( t <= 0.0 || t > 800000.0 ) return vec4( 0.0 );

        // Fade in only past the volumetric range so the two never double up.
        // 'uDeckNear' collapses to almost zero when volumetrics are switched
        // off, at which point this shell is the *only* cloud in the sky and has
        // to carry the near field as well.
        float range = smoothstep( uCloudMaxDist * uDeckNear,
                                  uCloudMaxDist * ( uDeckNear + 0.73 ), t );
        if ( range < 0.002 ) return vec4( 0.0 );

        vec2 uv = ( uCamPos.xz + rd.xz * t ) * uDeckUvScale;
        float base = texture( uCirrus, uv + uDeckOffset ).b;
        float fine = texture( uCirrus, uv * 3.3 - uDeckOffset * 0.6 ).a;
        float m = base * 1.25 + fine * 0.42 - 0.34;
        float cov = smoothstep( 0.66 - uDeckAmount * 0.46, 0.98 - uDeckAmount * 0.42, m );
        float alpha = cov * range * saturate1( uDeckAmount * 1.1 );
        if ( alpha < 0.002 ) return vec4( 0.0 );

        // Fake the cumulus form. The coverage mask doubles as a height proxy,
        // so tops catch light and the flat bases stay in cool shadow; the
        // horizontal gradient of that mask stands in for a surface normal, which
        // is what puts a lit face on the sunward side of each distant tower
        // instead of shading the whole deck by view angle alone.
        float top = saturate1( m * 1.4 - 0.15 );
        // Cauliflower. One extra tap of the same texture at nine times the
        // scale, folded into the height proxy ONLY (not into the coverage, so
        // the deck's silhouette is unchanged and the noise cannot make it
        // fringe). Without it the deck's shading is driven entirely by a mask
        // whose finest feature is a kilometre across, which is why a 120x60
        // sample of it measured a standard deviation of 1.3 over seven thousand
        // pixels: a flat, untextured, unshaded surface covering a third of the
        // clouds framing, and a rubric automatic failure. Weighted by 'cov' so
        // it only exists where there is cloud to carry it.
        float bump = texture( uCirrus, uv * 9.1 + uDeckOffset * 1.7 ).a;
        float bump2 = texture( uCirrus, uv * 23.0 - uDeckOffset * 0.4 ).b;
        float relief = ( bump * 0.66 + bump2 * 0.34 ) - 0.5;
        top = saturate1( top + relief * 0.62 * cov );
        vec2 duv = vec2( 2.5 / 512.0 );
        float gx = texture( uCirrus, uv + vec2( duv.x, 0.0 ) + uDeckOffset ).b
                 - texture( uCirrus, uv - vec2( duv.x, 0.0 ) + uDeckOffset ).b;
        float gy = texture( uCirrus, uv + vec2( 0.0, duv.y ) + uDeckOffset ).b
                 - texture( uCirrus, uv - vec2( 0.0, duv.y ) + uDeckOffset ).b;
        // The relief has to reach the NORMAL as well as the height, or the
        // towers get a value gradient with no terminator on them and still read
        // as paint. Two extra taps of the fine field, differenced the same way.
        float bx = texture( uCirrus, uv * 9.1 + vec2( duv.x * 9.1, 0.0 ) + uDeckOffset * 1.7 ).a
                 - texture( uCirrus, uv * 9.1 - vec2( duv.x * 9.1, 0.0 ) + uDeckOffset * 1.7 ).a;
        float bz = texture( uCirrus, uv * 9.1 + vec2( 0.0, duv.y * 9.1 ) + uDeckOffset * 1.7 ).a
                 - texture( uCirrus, uv * 9.1 - vec2( 0.0, duv.y * 9.1 ) + uDeckOffset * 1.7 ).a;
        vec3 nrm = normalize( vec3( -( gx * 7.0 + bx * 5.5 * cov ), 0.55,
                                    -( gy * 7.0 + bz * 5.5 * cov ) ) );
        vec3 sunFlat = normalize( vec3( uSunDir.x, max( uSunDir.y, 0.05 ), uSunDir.z ) );
        float side = saturate1( dot( nrm, sunFlat ) * 0.5 + 0.5 );
        // Range widened from 1.06 to 1.34 of the quantiser's input span, so the
        // deck actually reaches both the shadow band and the fully lit band
        // instead of living inside one and a half steps.
        float e = celQuantise( saturate1( top * 0.58 + side * 0.76 - 0.10 ),
                               uCloudBands, uCloudBandSoft );

        vec3 fill = mix( uHorizonColor, uZenithColor, 0.30 ) * 1.25 + 0.012;
        vec3 lit  = uCloudLit * uSunColor;
        vec3 col  = mix( uCloudCore * fill, lit, e );
        // Backlit rim: at this range the deck is almost always between the
        // camera and a low sun, and that thin bright edge is most of what makes
        // a distant cloud bank read as three-dimensional.
        float mu = dot( rd, uSunDir );
        // Peaks where the coverage mask crosses its own threshold — i.e. on the
        // silhouette, and nowhere else.
        float rim = cov * ( 1.0 - cov ) * 4.0;
        col += uSunColor * uSilver * rim * pow( saturate1( mu ), 3.0 ) * 0.9;
        // CAPPED at 0.55, and this one line is the whole of the "the cloud deck
        // is flat paint" automatic failure.
        //
        // 't' out here is two to four hundred kilometres, so the unclamped
        // exponential is 0.98-1.00 and this mix was not applying aerial
        // perspective to the deck at all — it was REPLACING it, wholesale, with
        // a single flat colour. Every value the block above computes (the
        // quantised terminator, the lit face, the backlit rim, the cauliflower
        // relief) was being thrown away one line later, which is why a 120x60
        // sample of the deck measured a standard deviation of 1.4 over seven
        // thousand pixels no matter what was done to the shading.
        //
        // A cap is the correct model as well as the correct picture: a cloud
        // bank is emissive-bright against the sky rather than dark against it,
        // so the airlight added in front of it does not swamp it the way it
        // swamps a dark ridge at the same range — which is exactly why a distant
        // cumulus line still reads as cumulus when the coast under it has gone.
        col = mix( col, uHorizonColor * 1.1,
                   min( 1.0 - exp( -t / max( uAerialFar * 2.2, 1.0 ) ), 0.55 ) );
        return vec4( col, alpha );
      }

      void main() {
        vec4 wp = uInvViewProj * vec4( vNdc, 1.0, 1.0 );
        vec3 rd = normalize( wp.xyz / wp.w - uCamPos );

        // ---- physical atmosphere ----
        vec3 sky = sampleSkyLut( rd ) * uSkyExposure;

        // Night floor: the model correctly integrates to near zero, but a dead
        // black sky reads as a bug. Airglow + scattered moonlight.
        float moonUp = saturate1( uMoonDir.y * 3.0 );
        sky += uNight * ( vec3( 0.0042, 0.0068, 0.0148 )
             + uMoonColor * 0.010 * uMoonIllum * moonUp );

        // Twilight wedge: brightest low in the sky and strongest toward the
        // sun's azimuth, which is exactly where the multiply-scattered light
        // the single-scattering integral drops actually comes from.
        {
          vec2 sunAz = normalize( uSunDir.xz + vec2( 1e-5, 0.0 ) );
          vec2 viewAz = normalize( rd.xz + vec2( 1e-5, 0.0 ) );
          float toward = 0.55 + 0.45 * saturate1( dot( sunAz, viewAz ) );
          float lowness = pow( saturate1( 1.0 - rd.y * 0.85 ), 2.2 );
          sky += uTwilight * lowness * toward;
        }

        // ---- whiteout compression -------------------------------------------
        //
        // THIS is the horizon band that four rounds of critique have called a
        // "broad structureless cream wash", and it is worth being exact about
        // where it comes from, because every previous attempt went after the
        // wrong term. Killing the stylised haze band below moves it by nothing.
        // Killing the deck, the cirrus, the bloom, the cel material's aerial
        // perspective and the grade's shoulder each move it by one to four
        // levels. Measured on hero at x=1500 with ALL of those disabled, the
        // profile still ran: blue (153,188,203) at the top of frame, then a
        // 200-pixel plateau at 210-213 with a chroma of six, then the horizon.
        // The band is the SCATTERING CURVE ITSELF.
        //
        // Single scattering saturates. Past about four air masses the integral
        // has spent all of its Rayleigh colour — the blue is scattered out of
        // the beam faster than it is scattered into it — so every direction
        // inside fifteen degrees of the horizon converges on the same pale
        // cream, and a converged region is by definition structureless. A real
        // sky does not do this, because multiple scattering redistributes that
        // light back into the rest of the dome and carries its colour with it.
        // We do not integrate multiple scattering; this is the cheapest
        // defensible stand-in for the part of it that matters to the picture.
        //
        // Two moves, both keyed on elevation alone so no weather or sun state
        // can put the plateau back:
        //
        //   CHROMA — mix the band back toward the zenith's own hue at constant
        //            luminance. The result is that the pale cream is confined
        //            to the two or three degrees that genuinely earn it and the
        //            sky above it is blue again, which is what gives the land
        //            and sea underneath something to separate against.
        //   VALUE  — a small dip through the transition only, so the profile
        //            has a slope through the band instead of a plateau. Held
        //            to 14 %: any more and the sky grows a visible dark ring.
        //
        // Gated off for a low sun. A sunset horizon is broadly and legitimately
        // gold, and de-creaming it would destroy the one framing in this build
        // that scores. Gated by azimuth too: the sky toward the sun is pale for
        // real reasons, the sky away from it is not.
        {
          vec2 sa2 = normalize( uSunDir.xz + vec2( 1e-5, 0.0 ) );
          vec2 va2 = normalize( rd.xz + vec2( 1e-5, 0.0 ) );
          float az = dot( sa2, va2 ) * 0.5 + 0.5;          // 1 = toward the sun
          float dayGate = smoothstep( 0.055, 0.30, uSunDir.y ) * ( 1.0 - uNight );
          // 1.7 deg -> 13.5 deg above the true horizon.
          float upEl = smoothstep( 0.030, 0.235, rd.y );
          float w = upEl * dayGate * ( 0.62 + 0.38 * ( 1.0 - az ) );

          float Lh = luma( sky );
          vec3 blueHue = uZenithColor / max( luma( uZenithColor ), 1e-4 );
          sky = mix( sky, Lh * blueHue, w * 0.58 );

          // The dip lives in the transition band only — it is zero at the
          // horizon (which must stay the brightest part of the sky) and zero
          // again by the time the dome is properly blue.
          float mid = upEl * ( 1.0 - smoothstep( 0.235, 0.62, rd.y ) );
          sky *= 1.0 - 0.14 * mid * dayGate;
        }

        // ---- stylisation ----
        // Horizon haze band.
        //
        // Three things were wrong with the previous one and they all read as
        // the same defect: a blown cream bar across the middle of the frame.
        //
        //  - Too broad. pow( 1 - |y|, 6 ) still carries a third of its strength
        //    eight degrees up, so the band covered the whole lower sky instead
        //    of the few degrees of genuinely thick air that produce it.
        //  - Unbounded. An additive term proportional to the sky's own
        //    luminance very nearly doubled it at the horizon, which clips —
        //    and a clipped band cannot read as depth, only as a blown edge.
        //  - One fixed cream regardless of the sun. A midday horizon is a cool
        //    grey-blue milk; it was coming out the same colour as a sunset.
        //
        // So: a narrow core with a faint skirt under it, tinted between cool
        // and warm haze by sun elevation *and* by azimuth — the warm side of a
        // hazy horizon is the sun's side, the opposite side stays grey — and
        // applied as a bounded blend toward a colour whose luminance is pinned
        // near the sky's own rather than as an open-ended add. A blend cannot
        // introduce the green fringe an additive term was protecting against,
        // because the target colour is authored, not the product of two hues.
        float sunAz;
        {
          vec2 sa = normalize( uSunDir.xz + vec2( 1e-5, 0.0 ) );
          vec2 va = normalize( rd.xz + vec2( 1e-5, 0.0 ) );
          sunAz = dot( sa, va ) * 0.5 + 0.5;
        }
        float toward = 0.40 + 0.60 * sunAz * sunAz;
        float lowSun = 1.0 - smoothstep( 0.03, 0.42, uSunDir.y );
        // Tightest when the sun is down, because that is the case where the
        // band is bright and a broad one reads as a cream bar. In daylight the
        // band carries no luminance lift worth speaking of, only hue, so it can
        // afford a deeper skirt and do the job of real aerial perspective.
        //
        float hzn = saturate1( 1.0 - abs( rd.y ) );
        float hz = pow( hzn, mix( 11.0, 16.0, lowSun ) )
                 + mix( 0.20, 0.14, lowSun ) * pow( hzn, mix( 4.0, 5.0, lowSun ) );
        // Near neutral, a shade cool. Not the blue-white it was: any tint whose
        // green sits above its red re-introduces the fringe it is here to kill.
        vec3 hazeTint = mix( vec3( 0.895, 0.880, 0.900 ), uHorizonWarm,
                             saturate1( ( 0.26 + 0.74 * lowSun ) * toward ) );
        // Azimuth shapes the *colour* strongly and the *weight* only mildly:
        // the anti-sun horizon is grey rather than gold, but it is still hazy,
        // and leaving it out was what let the teal survive on that side.
        float warmW = saturate1( hz * uHorizonWarmAmount
                     * ( 0.72 + 0.28 * sunAz ) * ( 1.0 - uNight * 0.7 ) );
        // The only luminance lift left is the one a low sun actually earns, and
        // only on its own side of the sky.
        float hazeLift = 1.14 + 0.30 * lowSun * sunAz;
        sky = mix( sky, hazeTint * luma( sky ) * hazeLift, warmW );

        // Saturate around the *hue* rather than the value, and protect the
        // near-white horizon so the boost cannot re-introduce a colour cast in
        // the region it was just cleaned out of.
        //
        // The boost is also clamped so it can never drive a channel negative. A
        // clear zenith already has essentially no red in it; pushing saturation
        // hard there does not make it bluer, it clips red to zero across the top
        // third of the frame and throws away the tonal information the value
        // bands below are supposed to be drawn from.
        {
          float Ls = luma( sky );
          float mn = min( min( sky.r, sky.g ), sky.b );
          float sMax = ( Ls > mn + 1e-5 ) ? Ls / ( Ls - mn ) : 64.0;
          float s = min( mix( uSkySaturation, 1.0, warmW * 0.5 ), 0.97 * sMax );
          sky = adjustSaturation( sky, max( s, 1.0 ) );
        }

        // Broad value bands — the whole "painted sky" read.
        //
        // Quantised through a Reinhard-style compressor so the steps stay
        // meaningful in the very bright region near the sun, and then *renormed*
        // into the sub-range a sky actually occupies. Without that renorm a
        // typical frame spans only 0.2-0.6 of the compressed scale and collects
        // one and a half band edges — which reads as a gradient with an
        // occasional artefact in it rather than as a deliberate choice. Across
        // the useful range the same band count gives four or five clean steps.
        float L = luma( sky );
        float x = L / ( 1.0 + L );
        const float B0 = 0.09, B1 = 0.62;
        float xn = saturate1( ( x - B0 ) / B1 );
        float xq = celQuantise( xn, uSkyBands, uSkyBandSoft ) * B1 + B0;
        float Lq = xq / max( 1.0 - xq, 1e-4 );
        sky *= mix( 1.0, Lq / max( L, 1e-5 ), uSkyBandAmount );

        // ---- horizon fringe guard ----
        //
        // The scattering gradient runs from a strongly cyan blue at altitude to
        // a warm cream at the horizon. Green is a large channel at *both* ends,
        // so wherever the two meet green becomes the largest channel outright
        // and the frame gets a teal bar sitting between the sky and whatever is
        // on the horizon. That is a fringe, not a colour: no atmosphere is
        // green, and there is no exposure at which a viewer reads it as one.
        //
        // Fixing it by widening the haze band works but costs the thing the
        // band was narrowed for — it puts the milk back. So this is a separate,
        // strictly local term: it fires only where green actually exceeds both
        // of its neighbours, only in the lower sky, and it moves the pixel
        // toward its own luminance, so it can change hue but never value.
        {
          float gx = saturate1( ( sky.g - max( sky.r, sky.b ) ) * 3.4
                              / max( sky.g, 1e-4 ) );
          float lowSky = smoothstep( 0.42, 0.015, abs( rd.y ) );
          sky = mix( sky, vec3( luma( sky ) ) * vec3( 1.04, 1.0, 0.98 ),
                     gx * lowSky * 0.92 );
        }

        // ---- night sky contents ----
        if ( uNight > 0.002 ) {
          vec3 eq = rd * mat3( uStarRot );
          vec3 night = starField( eq ) + milkyWay( eq );
          // Extinct near the horizon, and washed out by moonlight.
          night *= smoothstep( -0.02, 0.16, rd.y );
          night *= 1.0 - 0.55 * uMoonIllum * moonUp;
          sky += night * uNight;
          sky += moonDisc( rd ) * uNight;
        }

        // ---- sun ----
        float sunUpMask = smoothstep( -0.022, 0.006, uSunDir.y );
        float cosSun = dot( rd, uSunDir );
        float ang = acos( clamp( cosSun, -1.0, 1.0 ) );
        float r = ang / uSunAngularRadius;
        if ( r < 1.25 ) {
          float rc = min( r, 1.0 );
          float mu = sqrt( max( 0.0, 1.0 - rc * rc ) );
          // Eddington limb darkening with visual-band coefficients. Without it
          // the disc reads as a flat sticker.
          float limb = 1.0 - 0.60 * ( 1.0 - mu ) - 0.18 * ( 1.0 - mu * mu );
          limb *= 1.0 - smoothstep( 0.93, 1.02, r );
          sky += uSunColor * limb * uSunDiscBrightness * sunUpMask;
        }
        float cs = max( cosSun, 0.0 );
        // Three-lobe aureole: the tight core feeds the bloom, the wide skirt is
        // the Mie forward peak the LUT under-resolves at this texel density.
        sky += uSunColor * sunUpMask * (
            pow( cs, 2600.0 ) * 2.4
          + pow( cs, 260.0 ) * 0.13
          + pow( cs, 26.0 ) * 0.018 );

        // ---- layered cloud shells ----
        vec4 deck = horizonDeck( rd );
        sky = mix( sky, deck.rgb, deck.a );

        // Two sheets, ~2.5 km apart in altitude and ~55 degrees apart in mean
        // heading. Real cirrus is never a single sheet, and the crossing angle
        // between two of them is most of what stops a fibrous field reading as
        // a ruled pattern — the upper sheet is also thinner and finer, which
        // gives the sky a depth cue it cannot get from one shell.
        if ( uCirrusAmount > 0.003 ) {
          vec4 cirB = cirrusShell( rd, uCirrusHeight * 1.31, -0.62, 13.7,
                                   uCirrusAmount * 0.58, uCirrusOffset2 * 3.4 );
          sky = mix( sky, cirB.rgb, cirB.a );
          vec4 cirA = cirrusShell( rd, uCirrusHeight, 0.38, 0.0,
                                   uCirrusAmount, uCirrusOffset * 5.2 );
          sky = mix( sky, cirA.rgb, cirA.a );
        }

        // ---- under-deck grey -------------------------------------------------
        //
        // Everything above this point is a clear-sky solution (see 'uOvercast').
        // A deck does exactly two things to the sky seen from underneath it, and
        // both are cheap: it removes the chroma, because the base of a cloud is
        // spectrally flat, and it takes the value down. Applied here, after the
        // sun disc and the cirrus and deck shells, because none of those are
        // visible through a storm either.
        if ( uOvercast > 0.002 ) {
          // Cool grey rather than neutral. A rain sky is blue-grey; a perfectly
          // neutral one reads as a blown-out white card with no weather in it.
          vec3 grey = vec3( luma( sky ) ) * vec3( 0.93, 0.97, 1.07 );
          sky = mix( sky, grey, uOvercast * 0.90 );
          sky *= 1.0 - 0.50 * uOvercast;
        }

        // ---- whiteout --------------------------------------------------------
        //
        // Inside cloud there is no sky. A faint vertical gradient survives —
        // more light comes down through a cloud than up through it, and that
        // gradient is the only attitude cue a pilot in the soup has — but the
        // stars, the sun, the deck and the horizon are all gone.
        if ( uWhiteout > 0.002 ) {
          vec3 murk = uWhiteoutColor * ( 0.86 + 0.28 * saturate1( rd.y * 0.5 + 0.5 ) );
          sky = mix( sky, murk, uWhiteout );
        }

        // ---- lightning ----
        sky += uLightningColor * uLightningFlash * ( 0.35 + 0.65 * saturate1( rd.y + 0.2 ) );

        // Ordered dither: 8-bit output across a 6-stop sky gradient bands badly
        // without it, and the band structure we deliberately added makes the
        // artefact more visible, not less. Night needs several times more,
        // because the whole visible range there is only a few code values wide.
        sky += ( ign( gl_FragCoord.xy ) - 0.5 ) * ( ( 1.5 + 4.0 * uNight ) / 255.0 );

        gl_FragColor = vec4( max( sky, vec3( 0.0 ) ), 1.0 );
        #include <colorspace_fragment>
      }
    `,
    depthTest: false,
    depthWrite: false,
    transparent: false,
    fog: false,
    side: THREE.DoubleSide,
  });
  return mat;
}
