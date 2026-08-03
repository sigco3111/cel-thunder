import * as THREE from 'three';
import { createCelMaterial, type CelMaterial } from '../render/CelMaterial';
import {
  BAKE_RES, BAKE_STEP, BIOME, MAP_HALF, MAP_SIZE, SEA_LEVEL,
} from './heightfield';
import type { WorldTextures } from './TerrainTextures';

/**
 * The terrain surface material.
 *
 * It is a *patched* CelMaterial, not a bespoke shader: everything the art
 * direction demands (banded diffuse, cool shadow tint, warm terminator,
 * stepped specular, rim, aerial perspective) already lives in CelMaterial and
 * comes with three's shadow/fog plumbing intact. What is added here is:
 *
 *   vertex   — CDLOD grid morphing and displacement from the baked heightfield
 *              texture, plus an analytic surface normal;
 *   fragment — altitude/slope/moisture biome blending, triplanar rock so
 *              cliffs are not smeared, hard sedimentary banding on those
 *              cliffs, procedural farmland with furrows and hedgerows, forest
 *              floor darkening that matches where the tree instances go, wet
 *              sand at the waterline, and a value quantisation pass that
 *              posterises the albedo without touching its hue.
 *
 * The height function 'hfHeight' here is a byte-exact mirror of
 * 'Heightfield.heightAt' on the CPU — both are a bilinear tap of the same
 * baked texture, so the rendered surface and ground collision cannot drift.
 */

// ---------------------------------------------------------------------------
// Shared GLSL
// ---------------------------------------------------------------------------

/** Height-texture sampling. Shared by the terrain and the water shader. */
export const HEIGHTFIELD_GLSL = /* glsl */`
  uniform sampler2D uHeight;
  uniform float uMapHalf;
  uniform float uBakeStep;
  uniform float uBakeRes;

  // Manual bilinear over an R32F texture. Hand-rolled rather than relying on
  // hardware filtering because float32 linear filtering is an optional WebGL2
  // extension, and because doing it explicitly guarantees the GPU reconstructs
  // exactly the same surface the CPU heightfield query does.
  float hfHeight( vec2 p ) {
    vec2 t = clamp( ( p + uMapHalf ) / uBakeStep, 0.0, uBakeRes );
    vec2 i0 = floor( t );
    vec2 f  = t - i0;
    ivec2 c0 = ivec2( i0 );
    ivec2 c1 = min( c0 + ivec2( 1 ), ivec2( int( uBakeRes ) ) );
    float h00 = texelFetch( uHeight, ivec2( c0.x, c0.y ), 0 ).r;
    float h10 = texelFetch( uHeight, ivec2( c1.x, c0.y ), 0 ).r;
    float h01 = texelFetch( uHeight, ivec2( c0.x, c1.y ), 0 ).r;
    float h11 = texelFetch( uHeight, ivec2( c1.x, c1.y ), 0 ).r;
    return mix( mix( h00, h10, f.x ), mix( h01, h11, f.x ), f.y );
  }
`;

/** Cheap hash/noise used for macro variation, fields and strata jitter. */
export const NOISE_GLSL = /* glsl */`
  float tHash( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }
  float tNoise( vec2 p ) {
    vec2 i = floor( p ), f = fract( p );
    f = f * f * ( 3.0 - 2.0 * f );
    float a = tHash( i );
    float b = tHash( i + vec2( 1.0, 0.0 ) );
    float c = tHash( i + vec2( 0.0, 1.0 ) );
    float d = tHash( i + vec2( 1.0, 1.0 ) );
    return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
  }
  float tFbm( vec2 p ) {
    float s = 0.0, a = 0.5;
    const mat2 R = mat2( 0.80, -0.60, 0.60, 0.80 );
    for ( int i = 0; i < 4; i++ ) { s += tNoise( p ) * a; p = R * p * 2.03; a *= 0.5; }
    return s / 0.9375;
  }
`;

/**
 * Forest density. Mirrored exactly by 'forestDensity()' in Vegetation.ts so
 * the ground tint and the tree instances always agree — nothing looks worse
 * than a dark green forest floor with no trees on it.
 *
 * The shape of this function is the whole reason the woodland reads as
 * woodland. The previous version *added* noise to a smooth suitability term,
 * which produces a field whose histogram is a broad hump around 0.3 — i.e.
 * every square metre of the map is "a bit forested", which scatters lonely
 * trees uniformly over everything. Real vegetation is close to binary at the
 * hundred-metre scale: dense stands with abrupt, ragged perimeters, and open
 * ground between them.
 *
 * So: build ONE composite noise field, then threshold it hard. The two coarse
 * octaves decide where the blocks are; the fine octave exists only to shred the
 * perimeter, because a block boundary drawn on a smooth field looks stamped.
 * The threshold itself is driven by moisture, macro variation and slope, which
 * is what makes stands sit in damp valley bottoms and on sheltered flanks
 * instead of being sprinkled at random.
 */
export const FOREST_GLSL = /* glsl */`
  float forestDensity( vec2 p, float h, float slope, float moisture, float macro ) {
    // Where trees can grow at all: above the shore, below the treeline, off
    // anything a root system could not hold.
    float suit = smoothstep( 6.0, 38.0, h )
               * ( 1.0 - smoothstep( 880.0, 1300.0, h ) )
               * ( 1.0 - smoothstep( 0.34, 0.62, slope ) );
    if ( suit <= 0.001 ) return 0.0;

    // Block layout (~2 km), internal structure (~600 m), edge shredding (~170 m).
    float n = tNoise( p * 0.00051 ) * 0.56
            + tNoise( p * 0.00168 ) * 0.29
            + tNoise( p * 0.00610 ) * 0.15;

    // A wetter, more sheltered, higher-macro site is forested at a lower noise
    // value, so the stands migrate toward the ground that should carry them.
    float thr = 0.605
              - moisture * 0.20
              - ( macro - 0.5 ) * 0.30
              - smoothstep( 0.06, 0.30, slope ) * 0.05;

    // A 0.075 window against a field carrying 0.15 of high-frequency energy is
    // what turns a contour of the noise into a ragged wood edge.
    return clamp( smoothstep( thr, thr + 0.075, n ) * suit, 0.0, 1.0 );
  }
`;

/**
 * Cultivated land — the parcel layout, shared with the vegetation scatterer.
 *
 * Farmland is *surveyed*, not tiled. A square lattice with a domain warp — what
 * this used to be — reads instantly as a checkerboard, because every parcel has
 * the same area, four sides and the same two edge directions. Real agricultural
 * land is a patchwork of irregular convex polygons whose areas span more than an
 * order of magnitude, laid out around watercourses and contours, with the small
 * parcels clustered (a bocage district) and the big ones clustered somewhere
 * else (open prairie).
 *
 * The construction here gives exactly that from one Voronoi evaluation:
 *
 *  1. A jittered Voronoi at ~170 m gives irregular convex polygons with four to
 *     seven sides — the correct primitive for a cadastral parcel.
 *  2. Each cell then points at a random 4-neighbour, or at itself. Cells that
 *     resolve to the same root are ONE parcel, so a parcel is a union of one to
 *     five Voronoi cells: non-convex, of widely varying area, and with the long
 *     thin shapes real strip holdings have.
 *  3. The probability of pointing at a neighbour is itself a slow noise field,
 *     so whole districts come out finely divided while others come out open.
 *  4. The lattice is domain-warped by two noise octaves plus a term
 *     proportional to terrain elevation, which drags boundaries along the
 *     contours instead of letting them run dead straight across a slope.
 *
 * 'parcelAt' returns (rootX, rootY, idHash, edgeDistance). The edge distance is
 * a true distance to the Voronoi bisector — but only against neighbours in a
 * *different* parcel, which is what makes internal cell walls disappear when
 * cells merge.
 */
export const FIELD_GLSL = /* glsl */`
  /** Base Voronoi cell pitch, metres. A merged parcel is 1-5 of these. */
  const float PARCEL_M = 146.0;
  const float PARCEL_JIT = 0.95;

  // Every hash argument here is an integer lattice coordinate plus an INTEGER
  // offset. That is load-bearing: Vegetation.ts mirrors this function to decide
  // where hedgerow trees go, GLSL evaluates it in float32 and JS in float64,
  // and tHash is a hash rather than an interpolant — a one-ulp difference in
  // its argument returns an unrelated value. Integers are exact in both.
  vec2 tHash2( vec2 p ) { return vec2( tHash( p ), tHash( p + 271.0 ) ); }

  /**
   * The cell this cell belongs to. One level of union only: deeper pointer
   * chasing is not idempotent (a cell and its parent can resolve differently)
   * and shows up as single-cell specks punched out of a parcel.
   */
  vec2 parcelRoot( vec2 g, float mergeP ) {
    if ( tHash( g + 613.0 ) > mergeP ) return g;
    float u = tHash( g + 1493.0 );
    vec2 o = u < 0.25 ? vec2(  1.0,  0.0 )
           : u < 0.50 ? vec2( -1.0,  0.0 )
           : u < 0.75 ? vec2(  0.0,  1.0 )
                      : vec2(  0.0, -1.0 );
    return g + o;
  }

  /** Domain warp applied to the parcel lattice, in cell units. */
  vec2 parcelWarp( vec2 world, float elev ) {
    vec2 w = vec2( tNoise( world * 0.000206 ), tNoise( world * 0.000206 + 53.7 ) ) - 0.5;
    w += ( vec2( tNoise( world * 0.00081 + 11.0 ), tNoise( world * 0.00081 + 91.0 ) ) - 0.5 ) * 0.42;
    // Contour drag: boundaries bend as the ground rises, which is what stops
    // a hedge running arrow-straight up a hillside.
    w += vec2( elev * 0.00135, elev * -0.00098 );
    return w * 2.3;
  }

  vec4 parcelAt( vec2 world, float elev, float mergeP, bool wantEdge ) {
    vec2 fp = world / PARCEL_M + parcelWarp( world, elev );
    vec2 ip = floor( fp );
    vec2 f  = fp - ip;

    vec2 mg = vec2( 0.0 ), mr = vec2( 0.0 );
    float md = 8.0;
    for ( int j = -1; j <= 1; j++ ) {
      for ( int i = -1; i <= 1; i++ ) {
        vec2 g = vec2( float( i ), float( j ) );
        vec2 r = g + 0.5 + ( tHash2( ip + g ) - 0.5 ) * PARCEL_JIT - f;
        float d = dot( r, r );
        if ( d < md ) { md = d; mr = r; mg = g; }
      }
    }

    vec2 root = parcelRoot( ip + mg, mergeP );
    float id = tHash( root + 89.0 );
    if ( !wantEdge ) return vec4( root, id, 1.0 );

    float edge = 8.0;
    for ( int j = -1; j <= 1; j++ ) {
      for ( int i = -1; i <= 1; i++ ) {
        if ( i == 0 && j == 0 ) continue;
        vec2 g = mg + vec2( float( i ), float( j ) );
        vec2 rt = parcelRoot( ip + g, mergeP );
        // Same parcel: the cell wall between them is not a boundary at all.
        if ( abs( rt.x - root.x ) < 0.5 && abs( rt.y - root.y ) < 0.5 ) continue;
        vec2 r = g + 0.5 + ( tHash2( ip + g ) - 0.5 ) * PARCEL_JIT - f;
        vec2 d = r - mr;
        float dl = length( d );
        if ( dl > 1e-4 ) edge = min( edge, dot( 0.5 * ( mr + r ), d / dl ) );
      }
    }
    return vec4( root, id, edge );
  }

  /**
   * Slowly varying probability that a cell merges into its neighbour. This is
   * the dial that makes parcel *area* vary by more than an order of magnitude
   * across a landscape: districts where it is low come out finely divided
   * (bocage), districts where it is high come out as big open holdings.
   */
  float parcelMergeP( vec2 world ) {
    return 0.30 + 0.62 * tNoise( world * 0.00062 );
  }
`;

// ---------------------------------------------------------------------------
// Material
// ---------------------------------------------------------------------------

export interface TerrainMaterialDeps {
  heightTex: THREE.DataTexture;
  maskTex: THREE.DataTexture;
  textures: WorldTextures;
  /** Quads per patch edge — the CDLOD morph needs it. */
  grid: number;
}

export interface TerrainMaterial extends CelMaterial {
  terrainUniforms: Record<string, THREE.IUniform>;
}

/**
 * Ground haze builds up roughly twice as fast as haze on an aircraft a few
 * hundred metres away, because you are looking through the densest, dustiest
 * part of the boundary layer along its length. Kept as a ratio against the
 * shared, weather-driven celGlobals value rather than as a constant.
 */
// Widened from 0.58/1.17. The old pair took the ground to its haze asymptote
// by about fifteen kilometres, which on a 65 km map means the outer half of
// every landscape frame was already a flat cream slab — the "oversized blown
// haze band" that was flattening the depth cue it exists to create. Pushing
// the falloff out and easing the strength keeps ridge lines separating by
// value all the way to the map edge, which is what makes distance read.
export const AERIAL_FAR_SCALE = 0.66;
export const AERIAL_STRENGTH_SCALE = 1.06;

export function createTerrainMaterial(deps: TerrainMaterialDeps): TerrainMaterial {
  const mat = createCelMaterial({
    name: 'terrain',
    color: 0xffffff,
    bands: 4,
    // Softer than an aircraft's bands on purpose. Terrain is the one surface
    // that presents a hundred-thousand-square-metre panel of near-constant
    // normal, so any gradient laid over it — a cloud shadow's penumbra, the
    // aerial ramp — crosses a band edge as a hard contour hundreds of metres
    // long, and reads as a rendering fault rather than as art direction.
    bandSoftness: 0.105,
    gloss: 0.86,
    specular: 0.10,
    specSteps: 1,
    // Terrain must have almost no rim: on a mountain flank the Fresnel term
    // covers half the screen and washes the whole massif pale.
    rimStrength: 0.04,
    rimPower: 5.5,
    shadowTint: 0x5c7ba8,
    terminatorTint: 0xffab6a,
    terminatorWidth: 0.13,
    inkInterior: false,
    fog: true,
  }) as TerrainMaterial;

  const t = deps.textures;
  const u: Record<string, THREE.IUniform> = {
    uHeight: { value: deps.heightTex },
    uMask: { value: deps.maskTex },
    uMapHalf: { value: MAP_HALF },
    uMapSize: { value: MAP_SIZE },
    uBakeStep: { value: BAKE_STEP },
    uBakeRes: { value: BAKE_RES },
    uGrid: { value: deps.grid },

    uRockAlb: { value: t.albedo[0] }, uRockNrm: { value: t.normal[0] },
    uGrassAlb: { value: t.albedo[1] }, uGrassNrm: { value: t.normal[1] },
    uSandAlb: { value: t.albedo[2] }, uSandNrm: { value: t.normal[2] },
    uSnowAlb: { value: t.albedo[3] }, uSnowNrm: { value: t.normal[3] },

    // Metres per texture repeat. Rock is tighter because it is seen on cliffs
    // at close range; grass is looser because it is seen from 500 m up.
    uTexScale: { value: new THREE.Vector4(26.0, 24.0, 15.0, 34.0) },
    uSeaLevel: { value: SEA_LEVEL },
    uBeachTop: { value: BIOME.beachTop },
    uBeachFade: { value: BIOME.beachFade },
    uSnowLine: { value: BIOME.snowLine },
    uSnowFade: { value: BIOME.snowFade },
    uRockSlope: { value: BIOME.rockSlope },
    uRockFade: { value: BIOME.rockFade },
    /** Tonal steps the albedo value is posterised into. */
    uQuantSteps: { value: 7.0 },
    uQuantAmount: { value: 0.46 },
    uNormalStrength: { value: 0.85 },
    /** Distance over which fine texture detail dissolves into biome colour. */
    uDetailNear: { value: 900.0 },
    uDetailFar: { value: 7000.0 },
    uFieldStrength: { value: 1.0 },
    /**
     * Range beyond which hedgerow geometry stops being evaluated. The second
     * Voronoi pass — the one that measures distance to the parcel boundary — is
     * roughly half the cost of the farmland block, and past this range a hedge
     * is under a pixel wide, so it buys nothing but shimmer.
     */
    uFieldEdgeDist: { value: 4200.0 },

    // Terrain-local aerial perspective. These shadow the shared celGlobals
    // uniforms of the same name (assigned after CelMaterial's own, so they
    // win): ground haze has to build up far faster than haze on an aircraft
    // 300 m away, or a 20 km ridge line reads as if it were a kilometre off.
    // uAerialColor stays shared so the sky system still drives its hue.
    //
    // The *ratio* is the art direction, not the absolute value: WorldSystem
    // recomputes these every frame as celGlobals.uAerialFar * AERIAL_FAR_SCALE
    // so that flying into a squall thickens the ground haze along with
    // everything else. Shadowing them with a constant is what previously left
    // the two largest things on screen — the land and the sea — immune to the
    // weather system.
    uAerialFar: { value: 26000 * AERIAL_FAR_SCALE },
    uAerialStrength: { value: 0.9 * AERIAL_STRENGTH_SCALE },

    // --- the road between the two aerodromes ------------------------------
    // A 26-vehicle supply column driving across open wheat is an immersion
    // break from a kilometre up, so the road is painted into the surface with
    // exactly the curve GroundTargets drives the convoy along.
    uRoadA: { value: new THREE.Vector2() },
    uRoadB: { value: new THREE.Vector2() },
    uRoadOn: { value: 0 },

    // Flattened aerodrome pads: (x, z, sin heading, cos heading). Cultivation
    // and the road are masked off these — a runway with a wheat field painted
    // across it is the single most immersion-breaking thing a procedural
    // terrain shader can do, and the pad is perfectly level so every other
    // farmland test passes there with flying colours.
    uPad: { value: [new THREE.Vector4(0, 0, 0, 1), new THREE.Vector4(0, 0, 0, 1)] },
    uPadHalf: { value: new THREE.Vector2(990, 480) },
    uPadCount: { value: 0 },
  };
  mat.terrainUniforms = u;

  const celCompile = mat.onBeforeCompile;

  mat.onBeforeCompile = (shader, renderer) => {
    celCompile.call(mat, shader, renderer);
    Object.assign(shader.uniforms, u);

    // ---------------------------------------------------------------- vertex
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        ${HEIGHTFIELD_GLSL}
        uniform float uGrid;
        attribute vec4 iNode;    // originX, originZ, size, level
        attribute vec2 iMorph;   // morphStart, 1 / (morphEnd - morphStart)
        varying vec3  vWPos;
      `)
      // Everything is computed here because <beginnormal_vertex> is the first
      // chunk in the vertex program: the displaced position must exist before
      // three computes the view normal, the shadow coordinate or the fog depth.
      .replace('#include <beginnormal_vertex>', /* glsl */`
        vec2 gp = position.xz;                       // grid coords in [0,1]
        float nodeSize = iNode.z;
        vec2 wxz = iNode.xy + gp * nodeSize;

        // --- CDLOD geomorph -------------------------------------------------
        // Odd grid vertices slide onto their even neighbour as the patch
        // approaches the distance at which its parent level takes over. At the
        // seam between two levels morph is exactly 1, so the finer patch's
        // edge is bit-identical to the coarser one: no cracks, and because the
        // slide is continuous, no popping either.
        float h0 = hfHeight( wxz );
        float camDist = distance( cameraPosition, vec3( wxz.x, h0, wxz.y ) );
        float morph = clamp( ( camDist - iMorph.x ) * iMorph.y, 0.0, 1.0 );
        vec2 snapped = fract( gp * uGrid * 0.5 ) * ( 2.0 / uGrid );
        wxz -= snapped * nodeSize * morph;

        float hh = hfHeight( wxz );

        // Surface normal by forward differences at this patch's own sampling
        // rate — using the patch spacing rather than the texel spacing keeps
        // distant LODs from aliasing into shimmering noise.
        //
        // The epsilon has to be morphed along with the geometry, or the LOD
        // boundary is a *shading* seam even though it is geometrically
        // watertight: a level-L patch filters the normal over nodeSize/uGrid
        // metres while the level-(L+1) patch that replaces it filters over
        // twice that, so the two meet with a visible step in how smooth the
        // ground looks. Ramping the epsilon to the parent's value exactly as
        // the vertex slide completes makes the filter width continuous across
        // the transition — the seam that was visible along every LOD ring in
        // the low pass comes entirely from this.
        float neSelf   = max( uBakeStep, nodeSize / uGrid );
        float neParent = max( uBakeStep, nodeSize * 2.0 / uGrid );
        float ne = mix( neSelf, neParent, morph );
        float hx = hfHeight( wxz + vec2( ne, 0.0 ) );
        float hz = hfHeight( wxz + vec2( 0.0, ne ) );
        vec3 objectNormal = normalize( vec3( hh - hx, ne, hh - hz ) );

        vec3 celTerrainPos = vec3( wxz.x, hh, wxz.y );
        vWPos = celTerrainPos;
      `)
      .replace('#include <begin_vertex>', /* glsl */`
        vec3 transformed = celTerrainPos;
      `);

    // -------------------------------------------------------------- fragment
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform sampler2D uMask;
        uniform float uMapHalf;
        uniform float uMapSize;
        uniform sampler2D uRockAlb;  uniform sampler2D uRockNrm;
        uniform sampler2D uGrassAlb; uniform sampler2D uGrassNrm;
        uniform sampler2D uSandAlb;  uniform sampler2D uSandNrm;
        uniform sampler2D uSnowAlb;  uniform sampler2D uSnowNrm;
        uniform vec4  uTexScale;
        uniform float uSeaLevel;
        uniform float uBeachTop;
        uniform float uBeachFade;
        uniform float uSnowLine;
        uniform float uSnowFade;
        uniform float uRockSlope;
        uniform float uRockFade;
        uniform float uQuantSteps;
        uniform float uQuantAmount;
        uniform float uNormalStrength;
        uniform float uDetailNear;
        uniform float uDetailFar;
        uniform float uFieldStrength;
        uniform float uFieldEdgeDist;
        uniform vec2  uRoadA;
        uniform vec2  uRoadB;
        uniform float uRoadOn;
        uniform vec4  uPad[2];
        uniform vec2  uPadHalf;
        uniform float uPadCount;
        varying vec3  vWPos;

        ${NOISE_GLSL}
        ${FOREST_GLSL}
        ${FIELD_GLSL}

        /**
         * Perpendicular distance, in metres, to the supply road — the same
         * sine-pair wander GroundTargets uses to lay the convoy out, so the
         * trucks drive on the tarmac rather than through the crop.
         *
         * The offset is applied along the segment normal, so the orthogonal
         * projection of P onto the straight chord is already within a couple of
         * per cent of the correct curve parameter; refining it would cost a
         * Newton step for a sub-metre gain on a 7 m road.
         */
        /** Mirror of Heightfield.padT: 0 at a pad centre, 1 at its edge. */
        float padT( vec2 P ) {
          float best = 8.0;
          for ( int k = 0; k < 2; k++ ) {
            if ( float( k ) >= uPadCount ) break;
            vec2 d = P - uPad[k].xy;
            float a = d.x * uPad[k].z + d.y * uPad[k].w;
            float b = d.x * uPad[k].w - d.y * uPad[k].z;
            best = min( best, max( abs( a ) / uPadHalf.x, abs( b ) / uPadHalf.y ) );
          }
          return best;
        }

        float roadDistance( vec2 P ) {
          vec2 ab = uRoadB - uRoadA;
          float len = max( length( ab ), 1.0 );
          vec2 dir = ab / len;
          vec2 nrm = vec2( -dir.y, dir.x );
          float t = clamp( dot( P - uRoadA, dir ) / len, 0.0, 1.0 );
          float off = sin( t * 9.1 ) * 420.0 + sin( t * 3.3 ) * 900.0;
          vec2 c = uRoadA + ab * t + nrm * off;
          return length( P - c );
        }

        // Perturbed world normal, produced in <map_fragment> and consumed a few
        // chunks later in <normal_fragment_maps>.
        vec3 gTerrainN;

        /**
         * Authoring convenience: every literal colour in this shader is written
         * the way an artist would pick it (sRGB), but the pipeline is linear
         * and the textures are hardware-decoded from SRGB8. Convert so the two
         * sources match.
         */
        vec3 sRGB( vec3 c ) { return pow( c, vec3( 2.2 ) ); }

        /**
         * Posterise the *value* of a colour while preserving its hue and
         * saturation. Quantising RGB directly shifts hue in ugly ways; this
         * scales the colour toward the quantised luminance instead. fwidth
         * feathering keeps the steps from crawling under camera motion.
         */
        vec3 quantiseValue( vec3 c, float steps, float amount ) {
          float v = max( dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 );
          float s = v * steps;
          float i = floor( s );
          float f = s - i;
          // The feather floor is not decoration. On a large, gently shaded
          // surface — a 300 m field — fwidth of the scaled luminance is close
          // to zero, so a 0.02 floor makes every step a hard contour and any
          // small albedo mottle straddling a step edge breaks into hard blobs.
          // Keeping a minimum feather costs nothing and turns those into a
          // gradient the eye reads as surface.
          float aa = clamp( fwidth( s ) * 0.9, 0.075, 0.5 );
          float e = smoothstep( 0.5 - aa, 0.5 + aa, f );
          float q = ( i + e ) / steps;
          return c * mix( 1.0, q / v, amount );
        }

        // NOTE: every texture fetch below uses textureGrad with derivatives
        // taken from the (branch-free) world position. Plain texture2D inside
        // the biome 'if' blocks would take its derivatives in divergent
        // control flow, which is undefined and shows up as mip sparkle exactly
        // along biome seams.

        /** Whiteout-blended triplanar normal, world space. */
        vec3 triplanarNormal( sampler2D tex, vec3 p, vec3 dx, vec3 dy, vec3 n, vec3 w, float sc ) {
          vec3 nx = textureGrad( tex, p.zy * sc, dx.zy * sc, dy.zy * sc ).xyz * 2.0 - 1.0;
          vec3 ny = textureGrad( tex, p.xz * sc, dx.xz * sc, dy.xz * sc ).xyz * 2.0 - 1.0;
          vec3 nz = textureGrad( tex, p.xy * sc, dx.xy * sc, dy.xy * sc ).xyz * 2.0 - 1.0;
          vec3 tx = vec3( nx.xy + n.zy, abs( nx.z ) * n.x );
          vec3 ty = vec3( ny.xy + n.xz, abs( ny.z ) * n.y );
          vec3 tz = vec3( nz.xy + n.xy, abs( nz.z ) * n.z );
          return normalize( tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z );
        }

        /** Planar (XZ) tangent-space normal lifted into world space. */
        vec3 planarNormal( sampler2D tex, vec2 uv, vec2 dx, vec2 dy, vec3 n ) {
          vec3 t = textureGrad( tex, uv, dx, dy ).xyz * 2.0 - 1.0;
          vec3 T = normalize( vec3( 1.0, 0.0, 0.0 ) - n * n.x );
          vec3 B = cross( n, T );
          return normalize( T * t.x + B * t.y + n * t.z );
        }
      `)
      // Replaces the (empty) map lookup with the whole terrain surface
      // evaluation: albedo into diffuseColor, normal into gTerrainN.
      .replace('#include <map_fragment>', /* glsl */`
        {
          vec3  P = vWPos;
          vec3  dPx = dFdx( P );
          vec3  dPy = dFdy( P );
          vec3  N = normalize( vCelWorldNormal );
          float slope = sqrt( max( 0.0, 1.0 - N.y * N.y ) );
          float camDist = length( cameraPosition - P );
          // Fine texture detail is meaningless past a couple of kilometres and
          // only produces shimmer; dissolve it into flat biome colour instead.
          float detail = 1.0 - smoothstep( uDetailNear, uDetailFar, camDist );

          vec4 mask = texture2D( uMask, ( P.xz + uMapHalf ) / uMapSize );
          float moisture = mask.r;
          float river    = mask.g;
          float rockM    = mask.b;
          float macro    = mask.a;

          // --- biome weights ------------------------------------------------
          float snowJitter = ( tFbm( P.xz * 0.0011 ) - 0.5 ) * 340.0;
          float wSnow = smoothstep( uSnowLine - uSnowFade + snowJitter,
                                    uSnowLine + uSnowFade + snowJitter, P.y );
          // Snow does not cling to near-vertical rock.
          // Snow slides off anything steep; the exposed rock underneath is
          // what gives high peaks their graphic black-and-white read.
          wSnow *= 1.0 - smoothstep( 0.38, 0.72, slope );

          float wRock = smoothstep( uRockSlope - uRockFade, uRockSlope + uRockFade, slope );
          wRock = max( wRock, rockM * smoothstep( 0.20, 0.50, slope ) );
          // Above the treeline the ground is bare scree even where it is not
          // especially steep; below it, only real crags show rock.
          wRock = max( wRock, smoothstep( 1000.0, 1650.0, P.y ) * smoothstep( 0.14, 0.46, slope ) );

          float wSand = 1.0 - smoothstep( uBeachTop - uBeachFade, uBeachTop + uBeachFade, P.y );
          wSand *= 1.0 - smoothstep( 0.25, 0.5, slope );
          // River banks are sand/shingle too.
          wSand = max( wSand, smoothstep( 0.45, 0.85, river ) * ( 1.0 - smoothstep( 0.2, 0.45, slope ) ) * 0.55 );

          float wGrass = clamp( 1.0 - wRock - wSnow - wSand, 0.0, 1.0 );
          float total = wRock + wSnow + wSand + wGrass + 1e-4;
          wRock /= total; wSnow /= total; wSand /= total; wGrass /= total;

          // --- macro variation ----------------------------------------------
          // Breaks the tiling without a second set of texture fetches.
          float macroN = tFbm( P.xz * 0.00085 );
          float macroN2 = tFbm( P.xz * 0.0047 );
          float macroTint = 0.80 + 0.40 * macroN;

          vec3 albedo = vec3( 0.0 );
          vec3 wnorm = N;

          // --- grass / farmland / forest ------------------------------------
          if ( wGrass > 0.002 ) {
            float gs = 1.0 / uTexScale.y;
            vec2 guv = P.xz * gs;
            // Scale mixing: a second tap of the same tile at an incommensurate
            // scale and rotation. The two repeats beat against each other with
            // a period far longer than either, which is what kills the visible
            // grid of a single tiled texture. One extra fetch, and it is the
            // single highest-value fetch in this shader.
            const mat2 GR = mat2( 0.7373, -0.6755, 0.6755, 0.7373 );
            vec2 guv2 = ( GR * P.xz ) * gs * 0.2874;
            vec3 g = mix(
              textureGrad( uGrassAlb, guv, dPx.xz * gs, dPy.xz * gs ).rgb,
              textureGrad( uGrassAlb, guv2, ( GR * dPx.xz ) * gs * 0.2874, ( GR * dPy.xz ) * gs * 0.2874 ).rgb,
              0.42 );
            // Blend toward the tile's own mean at distance so the terrain
            // reads as biome blocks, not as a vibrating texture.
            g = mix( sRGB( vec3( 0.300, 0.372, 0.205 ) ), g, 0.35 + 0.65 * detail );

            float forest = forestDensity( P.xz, P.y, slope, moisture, macro );
            // Forest floor: darker, bluer, and with canopy-scale mottling that
            // keeps reading after the tree billboards have faded out. The
            // mottling has to be at canopy scale (~25 m crowns clumping over
            // ~160 m) or the wood reads as a flat green stain from 500 m.
            float canopy = tFbm( P.xz * 0.0062 ) * 0.65 + tNoise( P.xz * 0.041 ) * 0.35;
            vec3 forestCol = mix( sRGB( vec3( 0.126, 0.196, 0.124 ) ), sRGB( vec3( 0.222, 0.322, 0.182 ) ), canopy );
            g = mix( g, forestCol, forest * 0.86 );

            // --- farmland ------------------------------------------------
            // Cultivation is the only thing that gives low-altitude ground a
            // *scale reference* and a man-made line to read against, so it is
            // deliberately widespread. What it must not be is regular: see
            // FIELD_GLSL for why the parcels are a merged Voronoi rather than a
            // warped lattice.
            float farm = ( 1.0 - smoothstep( 0.12, 0.46, forest ) ) * uFieldStrength
              * ( 1.0 - smoothstep( 0.16, 0.33, slope ) )
              * smoothstep( 3.0, 26.0, P.y ) * ( 1.0 - smoothstep( 520.0, 860.0, P.y ) )
              * smoothstep( 0.92, 0.44, macro )
              // Floodplain and riverbank stay as rough grazing.
              * ( 1.0 - smoothstep( 0.30, 0.62, river ) )
              // Aerodrome grass, not arable.
              * smoothstep( 1.0, 1.55, padT( P.xz ) );
            if ( farm > 0.003 ) {
              float mergeP = parcelMergeP( P.xz );
              // Hedgerow geometry is sub-texel past a few kilometres; below
              // that the second Voronoi loop is pure shimmer, so drop it and
              // keep only the parcel colours, which are the read at altitude.
              bool wantEdge = camDist < uFieldEdgeDist;
              vec4 pc = parcelAt( P.xz, P.y, mergeP, wantEdge );
              float id = pc.z;
              float id2 = tHash( pc.xy + 4211.0 );
              float id3 = tHash( pc.xy + 7717.0 );

              // Ploughing runs along the parcel, so the direction is per
              // parcel, not per pixel, and neighbouring parcels rarely agree.
              float ang = id * 3.14159;
              vec2 dir = vec2( cos( ang ), sin( ang ) );
              // Two scales of ploughing. The furrows themselves are 5-11 m and
              // only survive to ~1.2 km before they alias, so a coarser strip
              // pattern (~150 m, the width of a real medieval strip field)
              // carries the read at altitude.
              float pitch = mix( 0.52, 1.30, id2 );
              float fphase = dot( P.xz, dir ) * pitch;
              // Analytic anti-aliasing, not a distance ramp. A 5-11 m furrow
              // seen at a shallow angle from 600 m has a screen period well
              // under a pixel, and sampling it there produced the moire that
              // laid pale horizontal bands right across the county — bands that
              // crossed field boundaries and therefore read as a rendering
              // fault rather than as ploughing. Fade each pattern out exactly
              // when its own footprint reaches the Nyquist limit.
              float furAA = 1.0 - smoothstep( 0.9, 2.6, fwidth( fphase ) );
              float fur = sin( fphase );
              fur = floor( fur * 1.5 + 1.5 ) / 2.0;          // 3 hard tonal steps
              fur *= furAA;
              float sphase = dot( P.xz, dir ) * 0.042;
              float strip = floor( sin( sphase ) * 1.0 + 1.0 )
                          * ( 1.0 - smoothstep( 0.9, 2.6, fwidth( sphase ) ) );

              // Crop rotation. Weighted so that pasture and cereal dominate and
              // bare earth is the minority — a landscape of ploughed brown
              // reads as autumn mud, not as summer 1940.
              vec3 crop;
              float arable = 1.0;
              if      ( id2 < 0.13 ) { crop = sRGB( vec3( 0.612, 0.556, 0.336 ) ); }              // ripe wheat
              else if ( id2 < 0.24 ) { crop = sRGB( vec3( 0.542, 0.512, 0.348 ) ); }              // barley / stubble
              else if ( id2 < 0.42 ) { crop = sRGB( vec3( 0.312, 0.412, 0.216 ) ); }              // young cereal
              else if ( id2 < 0.53 ) { crop = sRGB( vec3( 0.392, 0.330, 0.248 ) ); }              // ploughed earth
              else if ( id2 < 0.66 ) { crop = sRGB( vec3( 0.256, 0.352, 0.196 ) ); }              // root crop
              else if ( id2 < 0.81 ) { crop = sRGB( vec3( 0.348, 0.446, 0.240 ) ); arable = 0.35; } // ley
              else                   { crop = sRGB( vec3( 0.316, 0.424, 0.248 ) ); arable = 0.0; }  // permanent pasture
              // Per-parcel value spread. Without it, every wheat field in the
              // county is the identical yellow and the patchwork reads as a
              // paint-by-numbers key.
              crop *= 0.84 + 0.30 * id3;
              // Ploughing is a texture cue, not a pattern: the albedo is
              // posterised a few lines further down, so a 20% modulation here
              // comes out the other side as a full tonal step and the county
              // ends up hatched. Keep both patterns inside one quantisation
              // band so they read as surface rather than as stripes.
              crop *= 0.925 + 0.15 * fur * arable;
              crop *= 0.963 + 0.065 * strip * arable;
              crop *= 0.93 + 0.15 * tFbm( P.xz * 0.085 );

              if ( wantEdge ) {
                // Boundary furniture, in metres of distance from the bisector.
                // The raw Voronoi bisector is a dead-straight segment; a real
                // hedge wanders by a couple of metres, and without that wobble
                // the whole county reads as a Voronoi diagram.
                float edgeM = pc.w * PARCEL_M
                            + ( tNoise( P.xz * 0.045 ) - 0.5 ) * 5.0;
                // Widen a little with distance so the line stays at least a
                // pixel, but nowhere near enough to turn into a black web.
                float lodW = min( 2.4, 1.0 + camDist * 0.0009 );
                // Not every boundary is planted. Open holdings divided only by
                // a change of crop are as characteristic as bocage, and mixing
                // the two is what stops the boundary web reading as a mesh.
                float hedged = step( 0.22, tHash( pc.xy + 331.0 ) );
                // A minority are a metalled track with pale verges.
                // Decorrelated from 'id' on purpose: reusing it would make
                // every tracked boundary share a ploughing direction.
                float track = step( 0.84, fract( id * 7.31 + id3 * 3.13 ) );
                float wHedge = ( 2.5 + 2.0 * id3 ) * lodW;
                float hedge = ( 1.0 - smoothstep( wHedge * 0.5, wHedge, edgeM ) )
                            * max( hedged, track );
                vec3 hedgeCol = mix(
                  sRGB( vec3( 0.152, 0.214, 0.126 ) ),      // hedge / treeline
                  sRGB( vec3( 0.520, 0.470, 0.372 ) ),      // chalk track
                  track );
                // Headland: the turning strip a plough leaves unsown inside
                // every boundary. Subtle, but it is the cue that says "worked".
                float head = 1.0 - smoothstep( wHedge, wHedge + 13.0, edgeM );
                crop = mix( crop, crop * 1.09, head * 0.5 * arable );
                crop = mix( crop, hedgeCol, hedge * ( 0.80 - 0.24 * track ) );
              }
              g = mix( g, crop, farm );
            }

            // --- supply road --------------------------------------------
            if ( uRoadOn > 0.5 ) {
              float rd = roadDistance( P.xz );
              float lodW = 1.0 + camDist * 0.0012;
              float carriage = 1.0 - smoothstep( 3.0 * lodW, 4.4 * lodW, rd );
              float verge    = 1.0 - smoothstep( 5.0 * lodW, 8.5 * lodW, rd );
              // The road is graded, so it will not climb a cliff or ford a
              // river bed; fade it out where it would have to.
              float ok = ( 1.0 - smoothstep( 0.16, 0.30, slope ) ) * smoothstep( 1.0, 6.0, P.y )
                       * smoothstep( 1.0, 1.4, padT( P.xz ) );
              g = mix( g, sRGB( vec3( 0.352, 0.336, 0.298 ) ) * ( 0.86 + 0.28 * tFbm( P.xz * 0.09 ) ),
                       carriage * ok );
              g = mix( g, sRGB( vec3( 0.402, 0.412, 0.268 ) ),
                       clamp( verge - carriage, 0.0, 1.0 ) * ok * 0.55 );
            }

            // Dry lee slopes / wet valley floors.
            g *= mix( 1.12, 0.86, moisture );
            albedo += g * wGrass;
            wnorm = mix( wnorm, planarNormal( uGrassNrm, guv, dPx.xz * gs, dPy.xz * gs, N ), wGrass * detail );
          }

          // --- rock: triplanar + sedimentary banding -------------------------
          if ( wRock > 0.002 ) {
            vec3 bw = pow( abs( N ), vec3( 5.0 ) );
            bw /= ( bw.x + bw.y + bw.z );
            float rs = 1.0 / uTexScale.x;
            vec3 r =
              textureGrad( uRockAlb, P.zy * rs, dPx.zy * rs, dPy.zy * rs ).rgb * bw.x +
              textureGrad( uRockAlb, P.xz * rs, dPx.xz * rs, dPy.xz * rs ).rgb * bw.y +
              textureGrad( uRockAlb, P.xy * rs, dPx.xy * rs, dPy.xy * rs ).rgb * bw.z;
            r = mix( sRGB( vec3( 0.430, 0.415, 0.395 ) ), r, 0.30 + 0.70 * detail );

            // Hard graphic strata. The band index is quantised, not smoothed —
            // this is the single most recognisable cel-terrain cue and it must
            // read as printed bands, not as a gradient.
            // Bedding planes are tilted, not horizontal, and they are tens of
            // metres thick. Perfectly level 5 m rings read as a contour map,
            // which is the classic procedural-terrain tell.
            float bandCoord = ( P.y + P.x * 0.13 - P.z * 0.08 ) * 0.0105
                            + tFbm( P.xz * 0.0016 ) * 2.4;
            float band = floor( fract( bandCoord ) * 3.0 ) / 3.0;
            // Gate hard on slope: strata belong on crags. Painted onto gentle
            // ground they turn into contour lines, which is worse than nothing.
            float bandMix = smoothstep( 0.44, 0.74, slope );
            r *= mix( 1.0, 0.84 + 0.30 * band, bandMix );
            // Iron staining in the lower bands.
            r = mix( r, r * vec3( 1.18, 0.96, 0.80 ), bandMix * ( 1.0 - band ) * 0.30 );

            albedo += r * wRock;
            wnorm = mix( wnorm, triplanarNormal( uRockNrm, P, dPx, dPy, N, bw, rs ), wRock * detail );
          }

          // --- sand ----------------------------------------------------------
          if ( wSand > 0.002 ) {
            float ss = 1.0 / uTexScale.z;
            vec2 suv = P.xz * ss;
            vec3 sc = textureGrad( uSandAlb, suv, dPx.xz * ss, dPy.xz * ss ).rgb;
            sc = mix( sRGB( vec3( 0.700, 0.640, 0.500 ) ), sc, 0.35 + 0.65 * detail );
            // Wet sand: darker and more saturated for the first few metres
            // above the waterline, with a hard-ish tide line.
            float wet = 1.0 - smoothstep( uSeaLevel + 0.4, uSeaLevel + 3.2, P.y );
            sc *= mix( 1.0, 0.60, wet );
            albedo += sc * wSand;
            wnorm = mix( wnorm, planarNormal( uSandNrm, suv, dPx.xz * ss, dPy.xz * ss, N ), wSand * detail * 0.7 );
          }

          // --- snow ------------------------------------------------------------
          if ( wSnow > 0.002 ) {
            float ns = 1.0 / uTexScale.w;
            vec2 nuv = P.xz * ns;
            vec3 sn = textureGrad( uSnowAlb, nuv, dPx.xz * ns, dPy.xz * ns ).rgb;
            sn = mix( sRGB( vec3( 0.880, 0.915, 0.965 ) ), sn, 0.35 + 0.65 * detail );
            albedo += sn * wSnow;
            wnorm = mix( wnorm, planarNormal( uSnowNrm, nuv, dPx.xz * ns, dPy.xz * ns, N ), wSnow * detail * 0.8 );
          }

          albedo *= macroTint;
          albedo *= 0.93 + 0.14 * macroN2;
          albedo = quantiseValue( albedo, uQuantSteps, uQuantAmount * detail );

          diffuseColor.rgb *= albedo;
          gTerrainN = normalize( mix( N, wnorm, uNormalStrength ) );
        }
      `)
      // three's normal chunk works in view space; hand it the world normal we
      // built, converted with the view matrix (the terrain model matrix is
      // identity, so no model rotation is involved).
      .replace('#include <normal_fragment_maps>', /* glsl */`
        normal = normalize( ( viewMatrix * vec4( gTerrainN, 0.0 ) ).xyz );
      `)
      // Tint the haze by view-to-sun angle.
      //
      // CelMaterial has already blended this fragment toward a single averaged
      // uAerialColor; this re-tints exactly that contribution rather than
      // adding a second layer of haze on top of it, so the amount of
      // atmosphere is unchanged and only its colour moves.
      //
      // Aerial perspective is dominated by forward Mie scattering, so the air
      // is warm and bright looking toward the sun and cool and blue looking
      // away from it — by a factor of several. Painting it as one colour is
      // what turned the horizon into an identical band of cream on every
      // heading in all ten frames; with the swing in, the same haze becomes a
      // gradient across the frame and starts doing the work of a depth cue
      // again. It also tracks the sun automatically, so a low sun warms the
      // band and a high one cools it with no extra plumbing.
      .replace('#include <fog_fragment>', /* glsl */`
        {
          float hd = length( cameraPosition - vWPos );
          float ha = pow( 1.0 - exp( -hd / max( 1.0, uAerialFar ) ), 1.35 ) * uAerialStrength;
          vec3  hv = normalize( vWPos - cameraPosition );
          float phase = dot( hv, normalize( uSunDir ) );
          vec3 warm = uAerialColor * vec3( 1.13, 1.02, 0.86 ) + uSunColor * 0.05;
          vec3 cool = uAerialColor * vec3( 0.84, 0.92, 1.11 );
          vec3 haze = mix( cool, warm, smoothstep( -0.60, 0.80, phase ) );
          gl_FragColor.rgb += ( haze - uAerialColor ) * ( ha * 0.62 );
        }
        #include <fog_fragment>
      `);
  };

  mat.customProgramCacheKey = () => 'cel-terrain-v1';
  return mat;
}
