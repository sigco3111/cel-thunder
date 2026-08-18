import{t as e}from"./rolldown-runtime-DK3Fl9T5.js";import{_t as t,ht as n}from"./three-DX5A0S2e.js";import{i as r}from"./CelMaterial-CVwppb4H.js";import{i,l as a,n as o,u as s}from"./heightfield-Bq8ZrAGy.js";var c=e({AERIAL_FAR_SCALE:()=>p,AERIAL_STRENGTH_SCALE:()=>m,FIELD_GLSL:()=>f,FOREST_GLSL:()=>d,HEIGHTFIELD_GLSL:()=>l,NOISE_GLSL:()=>u,createTerrainMaterial:()=>h}),l=`
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
`,u=`
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
`,d=`
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
`,f=`
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
`,p=.66,m=1.06;function h(e){let c=r({name:`terrain`,color:16777215,bands:4,bandSoftness:.105,gloss:.86,specular:.1,specSteps:1,rimStrength:.04,rimPower:5.5,shadowTint:6060968,terminatorTint:16755562,terminatorWidth:.13,inkInterior:!1,fog:!0}),h=e.textures,g={uHeight:{value:e.heightTex},uMask:{value:e.maskTex},uMapHalf:{value:a},uMapSize:{value:s},uBakeStep:{value:32},uBakeRes:{value:o},uGrid:{value:e.grid},uRockAlb:{value:h.albedo[0]},uRockNrm:{value:h.normal[0]},uGrassAlb:{value:h.albedo[1]},uGrassNrm:{value:h.normal[1]},uSandAlb:{value:h.albedo[2]},uSandNrm:{value:h.normal[2]},uSnowAlb:{value:h.albedo[3]},uSnowNrm:{value:h.normal[3]},uTexScale:{value:new t(26,24,15,34)},uSeaLevel:{value:0},uBeachTop:{value:i.beachTop},uBeachFade:{value:i.beachFade},uSnowLine:{value:i.snowLine},uSnowFade:{value:i.snowFade},uRockSlope:{value:i.rockSlope},uRockFade:{value:i.rockFade},uQuantSteps:{value:7},uQuantAmount:{value:.46},uNormalStrength:{value:.85},uDetailNear:{value:900},uDetailFar:{value:7e3},uFieldStrength:{value:1},uHedgeMaxPx:{value:30},uAerialFar:{value:26e3*p},uAerialStrength:{value:.9*m},uRoadA:{value:new n},uRoadB:{value:new n},uRoadOn:{value:0},uPad:{value:[new t(0,0,0,1),new t(0,0,0,1)]},uPadHalf:{value:new n(990,480)},uPadCount:{value:0}};c.terrainUniforms=g;let _=c.onBeforeCompile;return c.onBeforeCompile=(e,t)=>{_.call(c,e,t),Object.assign(e.uniforms,g),e.vertexShader=e.vertexShader.replace(`#include <common>`,`
        #include <common>
        ${l}
        uniform float uGrid;
        attribute vec4 iNode;    // originX, originZ, size, level
        attribute vec2 iMorph;   // morphStart, 1 / (morphEnd - morphStart)
        varying vec3  vWPos;
      `).replace(`#include <beginnormal_vertex>`,`
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
      `).replace(`#include <begin_vertex>`,`
        vec3 transformed = celTerrainPos;
      `),e.fragmentShader=e.fragmentShader.replace(`#include <common>`,`
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
        uniform float uHedgeMaxPx;
        uniform vec2  uRoadA;
        uniform vec2  uRoadB;
        uniform float uRoadOn;
        uniform vec4  uPad[2];
        uniform vec2  uPadHalf;
        uniform float uPadCount;
        varying vec3  vWPos;

        ${u}
        ${d}
        ${f}

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
      `).replace(`#include <map_fragment>`,`
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

          // Ground metres covered by one screen pixel.
          //
          // Every level-of-detail decision below is made against this rather
          // than against camera distance. A hedge 8 km away seen from directly
          // above and the same hedge 800 m away seen at a grazing angle are the
          // same rendering problem; only the footprint knows that. Using
          // distance instead is what produced a *curved boundary* across the
          // landscape in every high frame — a contour of constant range has no
          // business being visible in a picture of farmland.
          float px = max( length( dPx.xz ), length( dPy.xz ) );

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
          // River banks are shingle too — but only the bed itself. The old
          // threshold caught the whole floodplain and painted hectares of
          // hillside a pale near-white, which from altitude read as a scatter
          // of bald patches and was the single loudest source of the "confetti"
          // note against hero. Shingle is a ribbon, not a region.
          wSand = max( wSand, smoothstep( 0.66, 0.95, river ) * ( 1.0 - smoothstep( 0.2, 0.45, slope ) ) * 0.34 );

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
            vec3 gTex = mix(
              textureGrad( uGrassAlb, guv, dPx.xz * gs, dPy.xz * gs ).rgb,
              textureGrad( uGrassAlb, guv2, ( GR * dPx.xz ) * gs * 0.2874, ( GR * dPy.xz ) * gs * 0.2874 ).rgb,
              0.42 );
            // Blend toward the tile's own mean at distance so the terrain
            // reads as biome blocks, not as a vibrating texture.
            vec3 g = mix( sRGB( vec3( 0.300, 0.372, 0.205 ) ), gTex, 0.35 + 0.65 * detail );

            float forest = forestDensity( P.xz, P.y, slope, moisture, macro );
            // Forest floor: darker, bluer, and with canopy-scale mottling that
            // keeps reading after the tree billboards have faded out. Three
            // scales — ~25 m crowns, ~160 m clumping, and a ~740 m stand term.
            // The stand term is the one that matters from altitude: without it
            // every wood in a high frame collapses to a single flat dark-green
            // stain the moment the finer octaves drop below a pixel, which is
            // what made the wooded half of hud and dogfight read as untextured
            // paint against the fields.
            float canopy = tFbm( P.xz * 0.0062 ) * 0.56
                         + tNoise( P.xz * 0.041 ) * 0.28
                         + tNoise( P.xz * 0.00135 ) * 0.44;
            canopy = clamp( canopy * 0.86, 0.0, 1.0 );
            // Contrast pushed hard, and the range widened at BOTH ends. The
            // note against dogfight and hud is that everything outside the
            // arable districts is "flat untextured dark green with no field
            // system at all" — and it is, because those regions are woodland,
            // where nothing else in this shader draws. Woodland is not flat:
            // it is rides, clearings, a compartment felled last winter and a
            // stand of conifer next to a stand of beech, and the value spread
            // between those is larger than the spread across a whole county of
            // fields. Squaring the mask concentrates the light values into the
            // crowns and leaves the gaps between stands genuinely dark.
            float stand = canopy * canopy * ( 3.0 - 2.0 * canopy );
            vec3 forestCol = mix( sRGB( vec3( 0.074, 0.128, 0.086 ) ),
                                  sRGB( vec3( 0.286, 0.396, 0.212 ) ), stand );
            // Rides and clearings: a narrow band of the same noise the stands
            // are cut from, painted as rough grass. One ridged threshold, so
            // they come out as lines through the wood rather than as blobs.
            //
            // Inside the 'forest' branch, not outside it. This is an fbm — four
            // noise taps — and the surrounding block runs on essentially every
            // grass fragment in the frame, i.e. most of the screen in eight of
            // the ten framings. Paying for it on open farmland where 'forest'
            // is zero and the result is multiplied away cost enough to drop the
            // dogfight framing a quality tier.
            if ( forest > 0.02 ) {
              float ride = 1.0 - smoothstep( 0.0, 0.020, abs( tFbm( P.xz * 0.0074 + 61.0 ) - 0.52 ) );
              forestCol = mix( forestCol, sRGB( vec3( 0.296, 0.348, 0.206 ) ), ride * 0.55 );
            }
            g = mix( g, forestCol, forest * 0.90 );

            // --- farmland ------------------------------------------------
            // Cultivation is the only thing that gives low-altitude ground a
            // *scale reference* and a man-made line to read against, so it is
            // deliberately widespread. What it must not be is regular: see
            // FIELD_GLSL for why the parcels are a merged Voronoi rather than a
            // warped lattice.
            // Land that is *enclosed* at all: not wooded, not steep, not
            // flooded, off the aerodrome, below the moor line.
            float enclosed = ( 1.0 - smoothstep( 0.12, 0.46, forest ) )
              * ( 1.0 - smoothstep( 0.19, 0.38, slope ) )
              * smoothstep( 2.0, 22.0, P.y ) * ( 1.0 - smoothstep( 600.0, 980.0, P.y ) )
              // Floodplain and riverbank stay as rough grazing.
              * ( 1.0 - smoothstep( 0.34, 0.66, river ) )
              // Aerodrome grass, not arable.
              * smoothstep( 1.0, 1.55, padT( P.xz ) );
            // How *arable* the district is. This used to gate cultivation
            // outright, which meant the entire field system — parcels, hedges,
            // crop colour, everything — switched off along one contour of a
            // smooth noise field, and the landscape ended on a soft but
            // perfectly readable curve with flat green beyond it. Enclosure is
            // near-universal in this country; only the crop changes. So the
            // district term now only *thins* the patchwork toward rough
            // grazing, and the parcel web never terminates anywhere.
            float district = smoothstep( 0.94, 0.40, macro );
            float farm = enclosed * mix( 0.38, 1.0, district ) * uFieldStrength;
            if ( farm > 0.003 ) {
              float mergeP = parcelMergeP( P.xz );
              // Hedgerows are drawn wherever a screen pixel is small enough to
              // carry one. Past that the second Voronoi loop is pure shimmer,
              // but the cut is made on footprint and preceded by a fade, so
              // there is no ring anywhere in the picture.
              float edgeFade = 1.0 - smoothstep( uHedgeMaxPx * 0.62, uHedgeMaxPx, px );
              bool wantEdge = edgeFade > 0.002;
              vec4 pc = parcelAt( P.xz, P.y, mergeP, wantEdge );
              float id = pc.z;
              float id2 = tHash( pc.xy + 4211.0 );
              float id3 = tHash( pc.xy + 7717.0 );
              // Out in the grazing districts the rotation skews to ley and
              // permanent pasture rather than to cereal, so the thinning of
              // the patchwork also reads as a change of land use.
              id2 = mix( 0.58 + 0.42 * id2, id2, district );

              // Ploughing runs along the parcel, so the direction is per
              // parcel, not per pixel, and neighbouring parcels rarely agree.
              float ang = id * 3.14159;
              vec2 dir = vec2( cos( ang ), sin( ang ) );
              float across = dot( P.xz, dir );

              // TWO scales of working, and the second one is the whole reason
              // this landscape now reads as farmland from altitude.
              //
              // Drill rows are 5-12 m. Their screen period drops below a pixel
              // at about a kilometre, and past that sampling them produced the
              // moire that used to lay pale bands across the county — so they
              // are faded out analytically, exactly when their own footprint
              // reaches Nyquist. That left NOTHING above a kilometre: every
              // parcel in hero, dogfight and hud came out a flat slab of paint
              // with no crop direction at all. The tramline strips below are
              // 34-96 m, which is still eight pixels wide from four kilometres
              // up, and they carry the direction cue after the rows have gone.
              float pitch = mix( 0.52, 1.30, id2 );
              float fphase = across * pitch;
              float furAA = 1.0 - smoothstep( 0.9, 2.6, fwidth( fphase ) );
              float fur = sin( fphase );
              fur = floor( fur * 1.5 + 1.5 ) / 2.0;          // 3 hard tonal steps
              fur *= furAA;

              float spitch = 6.2831853 / mix( 34.0, 96.0, id3 );
              float sphase = across * spitch;
              float stripAA = 1.0 - smoothstep( 0.9, 2.6, fwidth( sphase ) );
              float strip = ( floor( sin( sphase ) * 1.5 + 1.5 ) / 2.0 ) * stripAA;

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
              // ends up hatched. Keep the drill rows inside one quantisation
              // band so they read as surface rather than as stripes.
              crop *= 0.930 + 0.14 * fur * arable;
              // The tramlines carry MORE contrast once the drill rows have
              // faded, so the total amount of visible working stays roughly
              // constant from two hundred metres to six kilometres instead of
              // collapsing to a flat polygon somewhere in between.
              // Grass leys and permanent pasture are cut and grazed rather than
              // drilled, so they get the same tramlines at a third of the
              // contrast — enough to give a 400 m foreground field a scale
              // reference instead of leaving it one unbroken slab of paint.
              float worked = max( arable, 0.42 );
              crop *= 1.0 + ( strip - 0.5 ) * mix( 0.23, 0.115, furAA ) * worked;

              // Within-field variation: soil, drainage, and the lie of the
              // land. Offset PER PARCEL, so the pattern belongs to the field
              // and changes across the hedge instead of washing over it. The
              // 76 m octave is what survives to altitude; the 27 m and 12 m
              // ones are faded on footprint so they cannot alias.
              vec2 fo = pc.xy * 3.7;
              float soil = tNoise( P.xz * 0.0132 + fo ) - 0.5;
              soil += ( tNoise( P.xz * 0.0355 + fo ) - 0.5 ) * 0.62
                    * ( 1.0 - smoothstep( 3.0, 9.0, px ) );
              // The amplitude has to clear a quantisation band to survive. The
              // albedo is posterised into seven steps a few lines below, so a
              // 10% wobble sits inside one band and is thrown away — which is
              // precisely why a 400 m pasture rendered as one flat slab even
              // with the variation already present. Give it enough to cross a
              // step and it comes out the far side as posterised patches of
              // soil and drainage, which is both the truthful read and the
              // house style.
              crop *= 1.0 + soil * ( 0.34 + 0.22 * ( 1.0 - arable ) );
              // A 240 m drainage/aspect term with NO footprint fade on it at
              // all. Everything else inside a parcel is faded out on screen
              // footprint because it would alias, which is correct — and which
              // is also why a field seen from three kilometres ended up a flat
              // slab of paint however much variation it carried up close. This
              // octave's period is a kilometre and a half on screen at that
              // range: it cannot alias, so it never has to be removed, and it
              // is the only thing keeping a distant parcel from being one
              // value. Offset per parcel so it changes across a hedge.
              crop *= 1.0 + ( tNoise( P.xz * 0.0042 + fo * 0.31 ) - 0.5 ) * 0.21;
              crop *= 1.0 + ( tFbm( P.xz * 0.085 ) - 0.5 ) * 0.24
                    * ( 1.0 - smoothstep( 1.6, 5.0, px ) );

              // Surface grain. The crop colour REPLACES the grass tile, so
              // without this a cultivated parcel is a flat slab of paint —
              // which is exactly how the whole foreground of low.png came out.
              // Modulating the crop by the tile's own value relief puts a real
              // surface back on the field, and because it comes from a
              // world-space mip-mapped texture its on-screen frequency scales
              // with distance for free: no hand-tuned stipple, no perspective
              // mismatch, and it dissolves to nothing at range on its own.
              float grain = dot( gTex, vec3( 0.2126, 0.7152, 0.0722 ) ) * ( 1.0 / 0.1421 );
              // Kept deliberately below the amplitude of the soil term above.
              // The albedo is posterised, so the two variations ADD before they
              // are stepped: push both hard and a smooth grain turns into hard
              // salt-and-pepper speckle, which is the "stipple" that got this
              // texture deleted a round ago. Broad variation carries the read,
              // grain only carries the surface.
              // Clump the roughness with the same field that drives the soil,
              // so the sward is smooth in some parts of a field and rough in
              // others. A grain of constant amplitude over four hundred metres
              // reads as film noise laid over the picture; a grain that varies
              // reads as ground.
              float grainAmt = 0.40 * ( 0.70 + 0.60 * clamp( soil + 0.5, 0.0, 1.0 ) );
              crop *= mix( 1.0, clamp( grain, 0.62, 1.50 ), grainAmt );

              if ( wantEdge ) {
                // Boundary furniture, in metres of distance from the bisector.
                // The raw Voronoi bisector is a dead-straight segment; a real
                // hedge wanders by a couple of metres, and without that wobble
                // the whole county reads as a Voronoi diagram. The wobble is
                // 22 m across, so it has to be faded on footprint like
                // everything else or it becomes boundary shimmer.
                float edgeM = pc.w * PARCEL_M
                            + ( tNoise( P.xz * 0.045 ) - 0.5 ) * 5.0
                              * ( 1.0 - smoothstep( 3.0, 11.0, px ) );
                // Not every boundary is planted, and the ones that are are not
                // all planted the same.
                //
                // This is the "hard-edged flat Voronoi polygons with uniform
                // dark-navy boundary strokes" note, and the polygons are not
                // the problem — a cadastral parcel really is a convex-ish
                // polygon. The problem is that every stroke around them was the
                // same weight and the same value, and a closed web of identical
                // lines is a stained-glass window whatever shape the cells are.
                // Real enclosure is a mixture: thick bocage on one side of a
                // field, a low bank on another, a wire fence that does not read
                // from the air at all on a third, and a chalk track on a fourth.
                // 'bt' picks between them per boundary.
                float bt = tHash( pc.xy + 331.0 );
                // Under 0.34: nothing planted. The field edge is then carried
                // only by the change of crop across it, which is exactly how an
                // open holding reads from four thousand feet.
                float hedged = step( 0.34, bt );
                // A minority are a metalled track with pale verges.
                // Decorrelated from 'id' on purpose: reusing it would make
                // every tracked boundary share a ploughing direction.
                float track = step( 0.85, fract( id * 7.31 + id3 * 3.13 ) );

                // True half-width of the planted boundary, in metres. Spread
                // wide: 1.4 m is a wire fence on a bank, 6.4 m is a mature
                // hedge with standard trees in it, and having BOTH in one
                // frame is most of what makes the web stop reading as a mesh.
                float hw = 1.4 + 5.0 * bt * bt;
                // Filtered half-width. The line is never allowed to be thinner
                // than about three quarters of a pixel, and its opacity drops
                // in exact proportion to how far it had to be widened — so the
                // integrated darkness it contributes to the pixel is conserved.
                // That is the whole trick: it is a correctly mip-mapped line.
                // It cannot shimmer, because it is never sub-pixel; it cannot
                // vanish on a ring, because nothing switches; and from ten
                // kilometres up the hedgerow web comes out as the faint grey
                // reticulation it actually is in a photograph.
                float fw = max( hw, px * 0.75 );
                float hedge = ( 1.0 - smoothstep( fw * 0.45, fw, edgeM ) )
                            * ( hw / fw ) * max( hedged, track ) * edgeFade;
                // Three boundary materials, not two. The middle one — a grassy
                // bank or a low earth lynchet, LIGHTER than the crop rather
                // than darker — is the one that was missing, and it is the one
                // that breaks the "every line in the county is the same dark
                // navy" read most cheaply: a web made of alternating dark and
                // pale strokes cannot be traced as a single mesh.
                float bank = step( 0.72, fract( bt * 5.31 + 0.17 ) );
                vec3 hedgeCol = mix(
                  sRGB( vec3( 0.163, 0.222, 0.132 ) ),      // hedge / treeline
                  sRGB( vec3( 0.430, 0.446, 0.286 ) ),      // grassed bank
                  bank );
                hedgeCol = mix( hedgeCol,
                  sRGB( vec3( 0.520, 0.470, 0.372 ) ),      // chalk track
                  track );
                // Per-boundary value spread, widened from +/-23 % to +/-38 %.
                hedgeCol *= 0.66 + 0.72 * tHash( pc.xy + 1777.0 );
                // Headland: the turning strip a plough leaves unsown inside
                // every boundary. Subtle, but it is the cue that says "worked".
                float head = ( 1.0 - smoothstep( fw, fw + 14.0, edgeM ) )
                           * ( 1.0 - smoothstep( 5.0, 13.0, px ) );
                crop = mix( crop, crop * 1.09, head * 0.5 * arable );
                // Per-boundary OPACITY as well as per-boundary colour. A hedge
                // that has been laid recently is a thin dark line; one that has
                // grown out is a solid band of scrub. Anything under about half
                // strength reads from the air as a tonal change rather than as
                // a stroke, which is the third of the four boundary types.
                crop = mix( crop, hedgeCol,
                  hedge * ( 0.84 - 0.26 * track ) * ( 0.42 + 0.58 * bt ) );
              }
              g = mix( g, crop, farm );
            }

            // --- supply road --------------------------------------------
            if ( uRoadOn > 0.5 ) {
              float rd = roadDistance( P.xz );
              // Footprint-filtered exactly like the hedgerows. The old rule
              // widened the carriageway in proportion to camera distance with
              // no cap, so from ten kilometres a 7 m lane rendered as a 110 m
              // grey band — the "ruler-straight road at constant width" running
              // to the horizon in hud. Keep it one pixel wide and let its
              // opacity carry the distance instead.
              float rw = max( 3.8, px * 0.75 );
              float vw = max( 7.6, px * 1.30 );
              float carriage = ( 1.0 - smoothstep( rw * 0.55, rw, rd ) ) * ( 3.8 / rw );
              float verge    = ( 1.0 - smoothstep( vw * 0.62, vw, rd ) ) * ( 7.6 / vw );
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
      `).replace(`#include <normal_fragment_maps>`,`
        normal = normalize( ( viewMatrix * vec4( gTerrainN, 0.0 ) ).xyz );
      `).replace(`#include <fog_fragment>`,`
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
        {
          // --- independent value floor for the land ------------------------
          //
          // Same invariant the sea now enforces (see Water.ts): three separate
          // terms — the cel material's aerial perspective, three's own fog and
          // the tint above — all have "ground == atmosphere" as their fixed
          // point, so however each is tuned, a distant coastline or ridge line
          // converges on the sky and the frame loses its depth cue. Ground is
          // always darker than the air in front of it; state that and enforce
          // it as a ratio, which survives the tone curve as an ordering
          // guarantee.
          //
          // The land's ceiling is higher than the sea's (0.88 against 0.80):
          // a chalk down or a ripe wheat field genuinely can approach the value
          // of a hazy sky, whereas open water at grazing incidence cannot.
          // Weighted in only once the haze dominates, so foreground terrain and
          // the gold mid-ground of the sunset framing are untouched.
          float hd2 = length( cameraPosition - vWPos );
          float ha2 = pow( 1.0 - exp( -hd2 / max( 1.0, uAerialFar ) ), 1.35 );
          float capW = smoothstep( 0.20, 0.70, ha2 );
          float ceilL = dot( uAerialColor, vec3( 0.2126, 0.7152, 0.0722 ) )
                      * mix( 4.0, 0.88, capW );
          float curL = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
          gl_FragColor.rgb *= min( 1.0, ceilL / max( curL, 1e-4 ) );
        }
      `)},c.customProgramCacheKey=()=>`cel-terrain-v1`,c}export{h as a,u as i,m as n,c as o,l as r,p as t};
//# sourceMappingURL=terrainMaterial-BVXvnx3L.js.map