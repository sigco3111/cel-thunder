/**
 * GLSL snippets shared by the sky, cloud, god-ray and rain passes.
 *
 * Every sky shader is authored against GLSL ES 3.00 ('glslVersion: GLSL3' on a
 * plain ShaderMaterial). Three then supplies '#define varying in' for the
 * fragment stage and leaves output declaration to us, which is exactly what the
 * multiple-render-target cloud pass needs. Passes that end up on screen declare
 * 'pc_fragColor' and '#define gl_FragColor' so three's own
 * '#include <colorspace_fragment>' still works — that keeps the sky correct
 * whether it is drawn straight to the canvas (sRGB encode) or into the
 * composer's linear HDR buffer (no-op).
 */

/** Declares the single colour output plus the gl_FragColor alias. */
export const GLSL3_OUT = /* glsl */`
layout(location = 0) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
`;

export const COMMON = /* glsl */`
#ifndef PI
#define PI 3.14159265359
#endif

float saturate1( float x ) { return clamp( x, 0.0, 1.0 ); }
vec3  saturate3( vec3 x )  { return clamp( x, vec3( 0.0 ), vec3( 1.0 ) ); }

float remap( float v, float a, float b, float c, float d ) {
  return c + ( v - a ) / ( b - a ) * ( d - c );
}
float remapC( float v, float a, float b, float c, float d ) {
  return clamp( remap( v, a, b, c, d ), min( c, d ), max( c, d ) );
}

float luma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

// Interleaved gradient noise (Jimenez). Cheap, temporally stable when the
// frame index is folded in, and far better behaved than a hash for ray-start
// dithering — the error it produces is high frequency, which the temporal
// filter removes almost completely.
float ign( vec2 p ) {
  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}

float hash11( float p ) {
  p = fract( p * 0.1031 );
  p *= p + 33.33;
  return fract( p * ( p + p ) );
}

float hash13( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.zyx + 31.32 );
  return fract( ( p.x + p.y ) * p.z );
}

vec3 hash33( vec3 p ) {
  p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
  p += dot( p, p.yxz + 33.33 );
  return fract( ( p.xxy + p.yxx ) * p.zyx );
}

// Gradient-free value noise; enough for milky way dust and lunar maria.
float vnoise3( vec3 p ) {
  vec3 i = floor( p );
  vec3 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float n000 = hash13( i + vec3( 0.0, 0.0, 0.0 ) );
  float n100 = hash13( i + vec3( 1.0, 0.0, 0.0 ) );
  float n010 = hash13( i + vec3( 0.0, 1.0, 0.0 ) );
  float n110 = hash13( i + vec3( 1.0, 1.0, 0.0 ) );
  float n001 = hash13( i + vec3( 0.0, 0.0, 1.0 ) );
  float n101 = hash13( i + vec3( 1.0, 0.0, 1.0 ) );
  float n011 = hash13( i + vec3( 0.0, 1.0, 1.0 ) );
  float n111 = hash13( i + vec3( 1.0, 1.0, 1.0 ) );
  return mix(
    mix( mix( n000, n100, f.x ), mix( n010, n110, f.x ), f.y ),
    mix( mix( n001, n101, f.x ), mix( n011, n111, f.x ), f.y ), f.z );
}

float fbm3( vec3 p, int octaves ) {
  float s = 0.0, a = 0.5, n = 0.0;
  for ( int i = 0; i < 6; i ++ ) {
    if ( i >= octaves ) break;
    s += a * vnoise3( p );
    n += a;
    a *= 0.5;
    p *= 2.03;
  }
  return s / max( n, 1e-5 );
}

/**
 * Ray/sphere intersection with the sphere centred at the origin.
 * Returns false when the ray misses entirely.
 */
bool raySphere( vec3 ro, vec3 rd, float r, out float t0, out float t1 ) {
  float b = dot( ro, rd );
  float c = dot( ro, ro ) - r * r;
  float h = b * b - c;
  if ( h < 0.0 ) { t0 = 0.0; t1 = 0.0; return false; }
  h = sqrt( h );
  t0 = -b - h;
  t1 = -b + h;
  return true;
}

/**
 * The soft staircase that turns continuous lighting into painted value steps.
 *
 * Two things make this read as art rather than as posterisation:
 *   - the input is gamma-compressed before quantising, so the steps land where
 *     the eye expects them instead of bunching in the highlights;
 *   - each step edge is a smoothstep of width 'soft', so the boundary has the
 *     slightly soft, brush-loaded quality of a painted edge.
 */
float celQuantise( float x, float bands, float soft ) {
  float g = pow( clamp( x, 0.0, 1.0 ), 0.4545 );
  float f = g * bands;
  float i = floor( f );
  float fr = f - i;
  float e = smoothstep( 0.5 - soft, 0.5 + soft, fr );
  return pow( ( i + e ) / bands, 2.2 );
}

/** Saturation adjust around luminance. */
vec3 adjustSaturation( vec3 c, float s ) {
  return mix( vec3( luma( c ) ), c, s );
}

// --- Atmosphere constants (Bruneton 2017 fits, metres / m^-1) --------------
#define R_GROUND 6360000.0
#define R_ATMOS  6420000.0
#define H_RAYLEIGH 8000.0
#define H_MIE      1200.0
const vec3 BETA_RAYLEIGH = vec3( 5.802e-6, 13.558e-6, 33.1e-6 );
#define BETA_MIE 3.996e-6

float phaseRayleigh( float mu ) { return ( 3.0 / ( 16.0 * PI ) ) * ( 1.0 + mu * mu ); }

/** Cornette-Shanks: the standard well-behaved approximation to Mie. */
float phaseMie( float mu, float g ) {
  float g2 = g * g;
  return ( 3.0 / ( 8.0 * PI ) ) * ( ( 1.0 - g2 ) * ( 1.0 + mu * mu ) )
    / ( ( 2.0 + g2 ) * pow( max( 1.0 + g2 - 2.0 * g * mu, 1e-4 ), 1.5 ) );
}

/** Henyey-Greenstein, used for the cloud phase function. */
float phaseHG( float mu, float g ) {
  float g2 = g * g;
  return ( 1.0 - g2 ) / ( 4.0 * PI * pow( max( 1.0 + g2 - 2.0 * g * mu, 1e-4 ), 1.5 ) );
}
`;

/**
 * Single-scattering integration used by the sky LUT. Split out so the LUT pass
 * and any future aerial-perspective LUT can share exactly one implementation.
 */
export const ATMOSPHERE = /* glsl */`
vec3 computeSkyRadiance( float altitude, vec3 rd, vec3 sunDir, float haze, float irradiance ) {
  vec3 ro = vec3( 0.0, R_GROUND + altitude, 0.0 );

  float a0, a1;
  if ( ! raySphere( ro, rd, R_ATMOS, a0, a1 ) ) return vec3( 0.0 );
  float tMax = a1;

  // Stop at the planet for downward rays; the terrain covers those anyway but
  // the horizon line has to land in the right place.
  float g0, g1;
  bool hitGround = raySphere( ro, rd, R_GROUND, g0, g1 ) && g0 > 0.0;
  if ( hitGround ) tMax = min( tMax, g0 );
  tMax = min( tMax, 480000.0 );

  const int VIEW_STEPS = 14;
  const int LIGHT_STEPS = 5;
  float ds = tMax / float( VIEW_STEPS );

  float betaM = BETA_MIE * haze;
  float odR = 0.0, odM = 0.0;
  vec3 sumR = vec3( 0.0 ), sumM = vec3( 0.0 );

  for ( int i = 0; i < VIEW_STEPS; i ++ ) {
    vec3 p = ro + rd * ( ( float( i ) + 0.5 ) * ds );
    float h = max( 0.0, length( p ) - R_GROUND );
    float dR = exp( -h / H_RAYLEIGH ) * ds;
    float dM = exp( -h / H_MIE ) * ds;
    odR += dR;
    odM += dM;

    // Optical depth toward the sun. No explicit shadow test is needed: when the
    // sun is below the local horizon the light path passes through the planet,
    // the clamped height collapses to zero, the density saturates and the
    // transmittance falls to nothing on its own. That gives a smooth earth
    // shadow and a physically shaped twilight wedge for free.
    float lodR = 0.0, lodM = 0.0;
    float l0, l1;
    if ( raySphere( p, sunDir, R_ATMOS, l0, l1 ) ) {
      float lds = max( l1, 0.0 ) / float( LIGHT_STEPS );
      for ( int j = 0; j < LIGHT_STEPS; j ++ ) {
        vec3 q = p + sunDir * ( ( float( j ) + 0.5 ) * lds );
        float hq = length( q ) - R_GROUND;
        // Negative height means "inside the planet": clamp to sea-level density
        // so the column blocks light instead of silently vanishing.
        hq = max( hq, 0.0 );
        lodR += exp( -hq / H_RAYLEIGH ) * lds;
        lodM += exp( -hq / H_MIE ) * lds;
      }
    }

    vec3 tau = BETA_RAYLEIGH * ( odR + lodR ) + vec3( betaM * 1.1 * ( odM + lodM ) );
    vec3 T = exp( -tau );
    sumR += T * dR;
    sumM += T * dM;
  }

  float mu = dot( rd, sunDir );
  vec3 result = ( sumR * BETA_RAYLEIGH * phaseRayleigh( mu )
                + sumM * betaM * phaseMie( mu, 0.76 ) ) * irradiance;

  // Ground bounce: without it, the band just below the horizon reads as a hole.
  if ( hitGround ) {
    float sunUp = saturate1( sunDir.y );
    vec3 groundTint = vec3( 0.19, 0.21, 0.15 );
    result += groundTint * sunUp * irradiance * 0.0022 * exp( -BETA_RAYLEIGH * odR * 1.5 );
  }

  return max( result, vec3( 0.0 ) );
}
`;
