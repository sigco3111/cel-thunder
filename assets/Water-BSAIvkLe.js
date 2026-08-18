import{t as e}from"./rolldown-runtime-DK3Fl9T5.js";import{W as t,a as n,at as r,d as i,gt as a,ht as o,o as s}from"./three-DX5A0S2e.js";import{i as c}from"./CelMaterial-CVwppb4H.js";import{n as l}from"./prepassMaterial-tyYm_pPR.js";import{l as u,n as d}from"./heightfield-Bq8ZrAGy.js";import{i as f,r as p}from"./terrainMaterial-BVXvnx3L.js";var m=e({WATER_AERIAL_FAR_SCALE:()=>y,WATER_AERIAL_STRENGTH_SCALE:()=>b,WAVE_GLSL:()=>C,Water:()=>x}),h=224,g=148,_=11e4,v=9,y=1.31,b=1.06,x=class{mesh;material;prepassMaterial;uni;constructor(e,n){let r=S(),a=c({name:`water`,color:16777215,bands:3,bandSoftness:.1,gloss:.06,specular:0,specSteps:2,rimStrength:0,shadowTint:4157340,terminatorTint:9426640,terminatorWidth:.1,transparent:!0,depthWrite:!1,inkInterior:!1,fog:!0}),s={uHeight:{value:e},uMapHalf:{value:u},uBakeStep:{value:32},uBakeRes:{value:d},uFoam:{value:n.foam},uWaterNrm:{value:n.waterNormal},uWaterLevel:{value:0},uWTime:{value:0},uSeaState:{value:.85},uShallowCol:{value:new i(5491124)},uMidCol:{value:new i(1339535)},uDeepCol:{value:new i(467002)},uFoamCol:{value:new i(15398655)},uSkyLow:{value:new i(11128808)},uSkyHigh:{value:new i(4094404)},uDepthBands:{value:5},uDepthQuant:{value:.22},uFoamWidth:{value:9},uCamXZ:{value:new o},uAerialFar:{value:26e3*y},uAerialStrength:{value:.9*b},uHorizonFade:{value:new o(27e3,62e3)}};a.waterUniforms=s,this.uni=s;let f=a.onBeforeCompile;a.onBeforeCompile=(e,t)=>{f.call(a,e,t),Object.assign(e.uniforms,s),w(e)},a.customProgramCacheKey=()=>`cel-water-v2`,this.material=a,this.prepassMaterial=l(s,C),this.mesh=new t(r,a),this.mesh.name=`ocean`,this.mesh.frustumCulled=!1,this.mesh.castShadow=!1,this.mesh.receiveShadow=!0,this.mesh.renderOrder=5,this.mesh.matrixAutoUpdate=!1,this.mesh.userData.prepassMaterial=this.prepassMaterial}update(e,t){let n=Math.round(e.position.x/4)*4,r=Math.round(e.position.z/4)*4;this.mesh.position.set(n,0,r),this.mesh.updateMatrix(),this.mesh.updateMatrixWorld(!0),this.uni.uWTime.value=t,this.uni.uCamXZ.value.set(e.position.x,e.position.z)}dispose(){this.mesh.geometry.dispose(),this.material.dispose(),this.prepassMaterial.dispose()}};function S(){let e=h,t=g,i=33153,o=new Float32Array(i*3),c=new Float32Array(i*3);c[1]=1;let l=Math.exp(v)-1;for(let n=1;n<=t;n++){let r=n/t,i=_*(Math.exp(v*r)-1)/l;for(let t=0;t<e;t++){let r=t/e*Math.PI*2,a=(1+(n-1)*e+t)*3;o[a]=Math.cos(r)*i,o[a+1]=0,o[a+2]=Math.sin(r)*i,c[a+1]=1}}let u=new Uint32Array(198240),d=0;for(let t=0;t<e;t++)u[d++]=0,u[d++]=1+(t+1)%e,u[d++]=1+t;for(let n=1;n<t;n++){let t=1+(n-1)*e,r=1+n*e;for(let n=0;n<e;n++){let i=(n+1)%e;u[d++]=t+n,u[d++]=r+i,u[d++]=r+n,u[d++]=t+n,u[d++]=t+i,u[d++]=r+i}}let f=new s;return f.setAttribute(`position`,new n(o,3)),f.setAttribute(`normal`,new n(c,3)),f.setIndex(new n(u,1)),f.boundingSphere=new r(new a,_*1.1),f}var C=`
  const int  W_COUNT = 5;
  const vec4 W_DATA[5] = vec4[5](
    vec4(  0.94,  0.34, 212.0, 0.58 ),
    vec4(  0.71, -0.71, 103.0, 0.34 ),
    vec4(  0.35,  0.94,  52.0, 0.20 ),
    vec4( -0.60,  0.80,  25.0, 0.105 ),
    vec4(  0.99, -0.14,  11.5, 0.055 )
  );
  const float W_Q = 0.82;   // steepness: 1.0 would produce self-intersecting crests

  /**
   * Evaluates the wave bank at world XZ. Returns the displacement, and writes
   * the analytic normal and the fold factor (the vertical Jacobian term — it
   * drops toward zero exactly where a crest is about to break, which is where
   * whitecaps belong).
   */
  vec3 gerstner( vec2 p, float t, float amp, float dist, out vec3 nrm, out float fold ) {
    vec3 disp = vec3( 0.0 );
    vec3 n = vec3( 0.0, 1.0, 0.0 );
    fold = 1.0;
    for ( int i = 0; i < W_COUNT; i++ ) {
      vec4 w = W_DATA[i];
      float L = w.z;
      float k = 6.2831853 / L;
      float c = sqrt( 9.81 / k );
      // Short waves are pure aliasing beyond a few hundred metres; fade each
      // component out at a distance proportional to its own wavelength.
      float lod = 1.0 - smoothstep( 55.0 * L, 420.0 * L, dist );
      float A = w.w * amp * lod;
      vec2  d = normalize( w.xy );
      float f = k * ( dot( d, p ) - c * t );
      float sf = sin( f ), cf = cos( f );
      disp.xz += d * ( W_Q * A * cf );
      disp.y  += A * sf;
      float ka = k * A;
      n.x -= d.x * ka * cf;
      n.z -= d.y * ka * cf;
      n.y -= W_Q * ka * sf;
      fold -= W_Q * ka * sf;
    }
    nrm = normalize( n );
    return disp;
  }
`;function w(e){e.vertexShader=e.vertexShader.replace(`#include <common>`,`
      #include <common>
      ${p}
      ${C}
      uniform float uWTime;
      uniform float uSeaState;
      uniform float uWaterLevel;
      varying vec3  vWWorld;
      varying vec3  vWNormal;
      varying float vWFold;
      varying float vWDepth;
      varying float vWDist;
    `).replace(`#include <beginnormal_vertex>`,`
      // The mesh follows the camera, so local -> world is a pure translation.
      vec3 wpos = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
      float dist = length( position.xz );
      float ground = hfHeight( wpos.xz );
      float depth = uWaterLevel - ground;
      // Waves must die as the bottom comes up, otherwise crests punch through
      // the beach and the shoreline crawls.
      float shoal = smoothstep( 0.0, 9.0, depth );
      vec3 wn; float fold;
      vec3 disp = gerstner( wpos.xz, uWTime, uSeaState * shoal, dist, wn, fold );
      wpos += disp;
      wpos.y += uWaterLevel;

      vec3 objectNormal = normalize( mix( vec3( 0.0, 1.0, 0.0 ), wn, shoal ) );
      vec3 celWaterPos = wpos;
      vWWorld  = wpos;
      vWNormal = objectNormal;
      vWFold   = fold;
      vWDepth  = depth;
      vWDist   = dist;
    `).replace(`#include <begin_vertex>`,`
      // The mesh transform is a pure translation (it follows the camera), so
      // undoing it is a subtraction rather than a matrix inverse.
      vec3 transformed = celWaterPos - modelMatrix[3].xyz;
    `),e.fragmentShader=e.fragmentShader.replace(`#include <common>`,`
      #include <common>
      ${p}
      ${f}
      uniform sampler2D uFoam;
      uniform sampler2D uWaterNrm;
      uniform float uWTime;
      uniform float uSeaState;
      uniform float uWaterLevel;
      uniform float uDepthBands;
      uniform float uFoamWidth;
      uniform vec3  uShallowCol;
      uniform vec3  uMidCol;
      uniform vec3  uDeepCol;
      uniform vec3  uFoamCol;
      uniform vec3  uSkyLow;
      uniform vec3  uSkyHigh;
      uniform float uDepthQuant;
      uniform vec2  uHorizonFade;
      varying vec3  vWWorld;
      varying vec3  vWNormal;
      varying float vWFold;
      varying float vWDepth;
      varying float vWDist;

      vec3 gWaterN;
      float gFresnel;
      vec3 gReflect;
      float gGlitter;
      /** RMS wave slope at this fragment — drives the width of the sun path. */
      float gSlopeSigma;
      /** 0 below the horizon, 1 with the sun properly up. */
      float gSunUp;

      vec3 sRGB( vec3 c ) { return pow( c, vec3( 2.2 ) ); }

      /** Hard-stepped band with an fwidth-feathered edge (no crawling). */
      float bandStep( float x, float edge ) {
        float aa = max( fwidth( x ), 1e-4 );
        return smoothstep( edge - aa, edge + aa, x );
      }
    `).replace(`#include <map_fragment>`,`
      {
        vec3  P = vWWorld;
        // Per-fragment depth (the vertex value is only correct at the posts).
        float ground = hfHeight( P.xz );
        float depth = uWaterLevel - ground;
        if ( depth < 0.0 ) discard;

        vec3 V = normalize( cameraPosition - P );

        // --- surface normal -------------------------------------------------
        //
        // THREE wave bands, an order of magnitude apart, each retired when its
        // own features drop under a few pixels. One detail scale — what this
        // used to be — is precisely why the sea read as a painted plane: the
        // chop at the bottom of the frame had the same *on-screen* frequency as
        // the chop at the horizon, which is geometrically impossible and reads
        // instantly as wallpaper. A real sea has a spectrum, and what survives
        // at range is only its long end.
        //
        // The cut distances come from the projection: at 1080p one metre
        // subtends roughly 935/d pixels, so a feature of size F is gone at
        // d ~ 300*F. Chop features are ~4 m (out by 1.5 km), wind waves ~20 m
        // (out by 7 km), swell ~110 m (out past 30 km, i.e. the whole map).
        // Each band's amplitude is lifted as the shorter ones die so the total
        // slope — and therefore the amount of texture the sea shows — stays
        // roughly constant from the bow to the horizon.
        float fadeChop  = 1.0 - smoothstep(  250.0,  1800.0, vWDist );
        float fadeWind  = 1.0 - smoothstep( 1600.0,  8000.0, vWDist );
        float fadeSwell = 1.0 - smoothstep( 6000.0, 34000.0, vWDist );

        vec2 uv1 = P.xz * 0.0280 + vec2( uWTime *  0.0130, uWTime *  0.0090 );
        vec2 uv2 = P.xz * 0.0062 - vec2( uWTime *  0.0042, uWTime *  0.0061 );
        vec2 uv3 = P.xz * 0.00115 + vec2( uWTime * 0.0013, uWTime * -0.0009 );
        vec2 d1 = ( texture2D( uWaterNrm, uv1 ).xy * 2.0 - 1.0 ) * fadeChop;
        vec2 d2 = ( texture2D( uWaterNrm, uv2 ).xy * 2.0 - 1.0 ) * fadeWind  * ( 0.55 + 0.75 * ( 1.0 - fadeChop ) );
        vec2 d3 = ( texture2D( uWaterNrm, uv3 ).xy * 2.0 - 1.0 ) * fadeSwell * ( 0.30 + 0.95 * ( 1.0 - fadeWind ) );
        vec2 slope = d1 * 0.60 + d2 * 0.85 + d3 * 1.05;
        vec3 N = normalize( vWNormal + vec3( slope.x, 0.0, slope.y )
                 * ( 0.62 * uSeaState * smoothstep( 0.0, 6.0, depth ) ) );
        gWaterN = N;
        // Kept for the glitter path: an open sea presents a wider spread of
        // facet orientations than a sheltered one, and the width of that
        // spread IS the width of the sun's reflection.
        gSlopeSigma = 0.052 + 0.165 * uSeaState * ( 0.55 + 0.45 * length( slope ) );
        gSunUp = smoothstep( -0.03, 0.11, normalize( uSunDir ).y );
        float detailFade = fadeChop;

        // --- subsurface colour ------------------------------------------------
        //
        // Three superposed exponentials — the physical form of Beer-Lambert
        // absorption — so the ramp is continuous from turquoise through teal to
        // the abyss with no boundary anywhere in it. The previous version drove
        // a quantised parameter through a two-segment mix, which put a hard
        // colour terminator across the open sea at a fixed depth: the single
        // most-cited defect in the water frames.
        //
        // Red is absorbed first (~7 m), green next, blue last, which is what
        // makes shoal water read as turquoise rather than as pale navy.
        vec3 shallowC = sRGB( uShallowCol );
        vec3 midC     = sRGB( uMidCol );
        vec3 deepC    = sRGB( uDeepCol );
        vec3 body = deepC
                  + ( midC - deepC ) * exp( -depth * 0.0265 )
                  + ( shallowC - midC ) * exp( -depth * vec3( 0.152, 0.098, 0.076 ) );

        // Residual cel step, on VALUE only and heavily feathered. This is the
        // stylisation the art direction asks for; it must not reintroduce a
        // colour boundary, so it scales the whole colour toward a quantised
        // luminance instead of switching between two ramp segments.
        {
          float v = max( dot( body, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 );
          float s = pow( v, 0.45 ) * uDepthBands;
          float i = floor( s );
          float f = s - i;
          float aa = clamp( fwidth( s ) * 0.9, 0.085, 0.5 );
          float qv = pow( ( i + smoothstep( 0.5 - aa, 0.5 + aa, f ) ) / uDepthBands, 1.0 / 0.45 );
          body *= mix( 1.0, qv / v, uDepthQuant );
        }

        // Silt near river mouths and the surf zone: warms the shallows.
        float silt = ( 1.0 - smoothstep( 0.0, 7.0, depth ) ) * 0.35;
        body = mix( body, body * vec3( 1.30, 1.18, 0.86 ), silt );

        // --- foam --------------------------------------------------------------
        // Shore foam: a wash band that advances and retreats up the beach, cut
        // to a hard edge against an animated foam texture. Depth comes from the
        // terrain field, so this line is exactly where the water meets the land.
        // Foam has to key off the *horizontal* distance to the waterline, not
        // off depth. Depth alone turns any shallow body — a river, a lagoon —
        // entirely white, because every part of it is within a few metres of
        // the surface. Dividing by the sea-bed gradient converts depth into a
        // distance-to-shore in metres, which behaves correctly on both a steep
        // headland and a flat estuary.
        float ge = 6.0;
        vec2 bedGrad = vec2( hfHeight( P.xz + vec2( ge, 0.0 ) ) - ground,
                             hfHeight( P.xz + vec2( 0.0, ge ) ) - ground ) / ge;
        float bedSlope = max( length( bedGrad ), 0.018 );
        float shoreDist = depth / bedSlope;

        float wash = sin( uWTime * 0.55 + tFbm( P.xz * 0.004 ) * 6.0 ) * 0.5 + 0.5;
        float shoreT = 1.0 - shoreDist / ( uFoamWidth * 4.0 * ( 0.55 + 0.75 * wash ) );
        vec2 fuv = P.xz * 0.055;
        float ftex = texture2D( uFoam, fuv + vec2( uWTime * 0.010, uWTime * 0.006 ) ).a;
        float ftex2 = texture2D( uFoam, fuv * 2.3 - vec2( uWTime * 0.021, uWTime * 0.017 ) ).a;
        float foamNoise = ftex * 0.65 + ftex2 * 0.5;
        float shoreFoam = bandStep( shoreT * ( 0.45 + foamNoise ), 0.42 );
        // A tight bright line right at the waterline holds the silhouette.
        shoreFoam = max( shoreFoam, 1.0 - smoothstep( 0.0, 2.5, shoreDist ) );

        // Breaking crests, inshore: the Gerstner fold factor collapsing.
        float crest = 1.0 - smoothstep( 0.28, 0.72, vWFold );
        crest *= 0.35 + 0.85 * foamNoise;
        float crestFoam = bandStep( crest, 0.30 ) * smoothstep( 3.0, 12.0, depth );

        // Whitecaps, offshore.
        //
        // The fold factor cannot carry these: the wave amplitude is
        // deliberately faded with distance to stop the mesh aliasing, so 'fold'
        // converges to 1 and the far sea goes glassy — exactly where a real
        // Force-4/5 swell is at its most broken. Drive the offshore caps from a
        // field of their own instead, scrolling along the dominant swell
        // direction at a scale that still resolves at ten kilometres, and
        // threshold it hard so they read as graphic flecks rather than as a
        // grey wash. This is what stops the horizon reading as a milky band.
        //
        // Scale matters more than anything else here. A whitecap is five to
        // fifteen metres of broken water, and driving it from a 500 m noise
        // field — the first thing I tried — paints continent-sized pale
        // shapes that read as ice floes, not as a sea. Two bands: a coarse one
        // that decides which stretch of water is breaking (the gust pattern),
        // and a fine one that cuts individual caps out of it.
        // Cost note: this is evaluated over most of the frame in a seaward
        // shot, so it is deliberately two noise lookups and not two fbms.
        float caps = 0.0;
        float capRange = 1.0 - smoothstep( 2200.0, 9000.0, vWDist );
        if ( capRange > 0.002 && depth > 8.0 ) {
          vec2 windDir = normalize( vec2( 0.94, 0.34 ) );
          vec2 capUv = P.xz * 0.052 - windDir * uWTime * 0.34;
          vec2 gustUv = P.xz * 0.0058 - windDir * uWTime * 0.030;
          float gust = smoothstep( 0.34, 0.70, tNoise( gustUv ) );
          float capField = tNoise( capUv ) * 0.68 + tNoise( capUv * 2.9 + 19.0 ) * 0.32;
          float capThr = mix( 0.80, 0.60, uSeaState * gust );
          caps = bandStep( capField, capThr ) * gust
               // Only on the windward face of the long swell, so the caps sit
               // in streaks along the wave train instead of as dots.
               * smoothstep( 0.10, 0.55, 1.0 - vWFold + 0.34 * uSeaState )
               * smoothstep( 8.0, 40.0, depth )
               // Sub-pixel past this: a cap is 5-15 m of foam. Letting them
               // survive further is what smears a milky band along the horizon
               // in place of water.
               * capRange;
        }

        // Shore foam is a metre-scale structure; it must go long before the
        // offshore caps do, or the coast draws a hard white line at 15 km.
        shoreFoam *= 1.0 - smoothstep( 4000.0, 11000.0, vWDist );
        float foam = clamp( max( shoreFoam, max( crestFoam * 0.85, caps * 0.72 ) ), 0.0, 1.0 );

        vec3 col = mix( body, sRGB( uFoamCol ), foam );

        // --- reflection ---------------------------------------------------------
        //
        // Composed from the LIVE sky state, not from two authored constants.
        // Two fixed blues is why the sea reflected nothing recognisable in any
        // frame and stayed North-Sea grey-blue under a full sunset: the surface
        // that should be the most obvious mirror in the shot was the one thing
        // in it that ignored the time of day. uAerialColor is the sky system's
        // own horizon colour and uSkyColor its ambient, so keying off them
        // makes the sea track the sky for free.
        vec3 R = reflect( -V, N );
        float up = clamp( R.y, 0.0, 1.0 );
        vec3 horizonCol = mix( sRGB( uSkyLow ), uAerialColor, 0.70 );
        vec3 zenithCol  = mix( sRGB( uSkyHigh ), uSkyColor, 0.55 );
        vec3 sky = mix( horizonCol, zenithCol, pow( up, 0.55 ) );
        // Broad forward-scatter glow around the reflected sun, which is what
        // lays copper across the whole seaward half of a sunset frame.
        // Two widths: a tight glow at the reflected sun and a very broad wash
        // that covers most of the sky. The broad term is what a sunset actually
        // does — the warm half of the sky is enormous — and without it the sea
        // away from the sun stays a dead grey-violet under a copper sky.
        float sunAlign = max( dot( R, normalize( uSunDir ) ), 0.0 );
        float glow = pow( sunAlign, 7.0 ) * 0.85 + pow( sunAlign, 1.4 ) * 0.20;
        // A low sun reddens and broadens the whole reflected hemisphere.
        float lowSun = 1.0 - smoothstep( 0.05, 0.42, normalize( uSunDir ).y );
        sky = mix( sky, sky * vec3( 1.16, 1.00, 0.84 ) + uSunColor * 0.07, lowSun * gSunUp * 0.8 );
        sky += uSunColor * glow * gSunUp;
        // March the reflected ray against the heightfield: three taps is enough
        // to know whether a headland or a hill blocks the sky in that direction.
        float occ = 0.0;
        for ( int i = 1; i <= 3; i++ ) {
          float s = float( i ) * float( i ) * 190.0;
          vec3 sp = P + R * s;
          occ = max( occ, step( sp.y, hfHeight( sp.xz ) ) * ( 1.0 - float( i ) * 0.22 ) );
        }
        // Reflected land reads as a dark, desaturated version of the shore.
        sky = mix( sky, sky * vec3( 0.30, 0.36, 0.28 ), occ * 0.85 );
        gReflect = sky;

        // Schlick, biased so the horizon goes properly mirror-like.
        gFresnel = 0.02 + 0.98 * pow( 1.0 - clamp( dot( N, V ), 0.0, 1.0 ), 4.2 );

        // --- geometric masking at grazing incidence --------------------------
        //
        // Flat-surface Fresnel says the sea at 89 degrees is a perfect mirror,
        // so the far water renders at exactly the radiance of the sky it
        // reflects and the coastline stops existing. Measured on hero: sky
        // (184,191,187) against sea (184,190,185) — one level, across the whole
        // right half of the frame, for four consecutive rounds.
        //
        // What flat Fresnel leaves out is geometry. A wind-roughened surface
        // seen almost edge-on is largely self-shadowed: most of the facets that
        // would send sky into the eye are hidden behind the crest in front of
        // them, so the MEAN reflectance over the slope distribution falls well
        // below the flat value. That is the Smith masking term of any
        // microfacet model, and it is the reason a photograph of the sea always
        // shows the water a shade darker than the sky above it no matter how
        // hazy the day is. Putting it back is simultaneously the physics fix and
        // the art-direction fix: the horizon becomes a line again.
        //
        // Keyed on grazing angle and on sea state — glass water really does
        // mirror the sky, chop does not.
        float grazeM = 1.0 - clamp( dot( N, V ), 0.0, 1.0 );
        gFresnel *= 1.0 - ( 0.30 + 0.22 * uSeaState )
                  * smoothstep( 0.55, 0.97, grazeM );

        // Glitter mask: high-frequency sparkle that breaks the sun path into
        // individual glints in the near field and averages into a continuous
        // sheet further out, which is what the eye actually sees.
        // World coordinates reach 30 km; multiplying them by 1.7 overruns
        // float32 mantissa precision inside the hash and the noise degenerates
        // into banding. Wrap first — the pattern is high frequency, so the
        // 1 km period is invisible.
        vec2 gp = mod( P.xz, 1024.0 ) * 1.7 + uWTime * 0.6;
        gGlitter = mix( 1.0, smoothstep( 0.44, 0.92, tFbm( gp ) ), detailFade );

        diffuseColor.rgb = col;
        // Shallow water lets the sand read through; deep water is opaque.
        float alpha = mix( 0.42, 1.0, smoothstep( 0.15, 4.5, depth ) );
        alpha = max( alpha, foam );
        alpha = max( alpha, gFresnel * 0.9 );
        diffuseColor.a = clamp( alpha, 0.0, 1.0 );
      }
    `).replace(`#include <normal_fragment_maps>`,`
      normal = normalize( ( viewMatrix * vec4( gWaterN, 0.0 ) ).xyz );
    `).replace(`#include <opaque_fragment>`,`
      #include <opaque_fragment>
      {
        vec3 V = normalize( cameraPosition - vWWorld );
        vec3 N = gWaterN;
        vec3 L = normalize( uSunDir );

        // Fresnel-weighted sky reflection over the body colour.
        //
        // The tint gain is >1, which is a deliberate lift on the near water —
        // but it must not survive to the horizon. Past ~20 km every fragment is
        // at grazing incidence, so gFresnel pins to 1 and the sea ends up
        // rendering *brighter than the sky it is reflecting*: a physically
        // impossible white slab along the horizon. Fade the gain to unity as
        // the reflection becomes mirror-like, which is the only regime where
        // the reflected value is the whole answer.
        vec3 reflTint = mix( 0.55 + 0.75 * uSunColor, vec3( 1.0 ), gFresnel );
        // 0.86 -> 0.74. At a steep look-down the Fresnel term is already small,
        // so this mostly affects the middle of the frame, where the old weight
        // left the sea reading as a sheet of sky rather than as water with a
        // colour of its own.
        gl_FragColor.rgb = mix( gl_FragColor.rgb, gReflect * reflTint, gFresnel * 0.74 );

        // --- dissolve the disc's rim ----------------------------------------
        // The ocean is a finite 110 km disc that follows the camera. At 2 km
        // altitude the true horizon is ~160 km away, so the rim of the mesh
        // falls *inside* the visible horizon and cuts a dead-straight edge
        // across the frame — the white streak this used to draw over every
        // shot. Fade the sea into the atmosphere over the outer half of the
        // disc: by the time the geometry runs out there is nothing left to see,
        // which is also what a real hazy horizon does.
        float rim = 1.0 - smoothstep( uHorizonFade.x, uHorizonFade.y, vWDist );
        gl_FragColor.a *= rim;

        // --- the sun path ----------------------------------------------------
        //
        // The bright column under the sun is NOT a specular lobe. It is the
        // statistics of the wave slopes: the sea mirrors the sun wherever a
        // facet happens to be tilted by the right amount, and the *spread* of
        // available tilts sets the shape of the path. A Blinn-Phong exponent —
        // what this used to be — can only ever produce a small round blob at
        // the exact mirror point, which is why there was no sun path anywhere
        // in the set, least of all in the sunset frame where it should have
        // been the subject of the shot.
        //
        // So model the slope distribution directly. 'e' is how far this facet
        // is from the orientation that would put the sun in the eye; dividing
        // it by an ANISOTROPIC sigma is what makes the path a tall column
        // rather than a disc, because the run of sea between the observer and
        // the mirror point offers many more chances to satisfy the condition
        // along the view azimuth than across it.
        vec3 H = normalize( L + V );
        vec3 e = H - N * dot( H, N );
        vec3 T = normalize( vec3( -V.x, 0.0, -V.z ) + vec3( 1e-5, 0.0, 0.0 ) );
        vec3 B = cross( vec3( 0.0, 1.0, 0.0 ), T );
        float sig = gSlopeSigma;
        float ex = dot( e, T ) / ( sig * 2.45 );   // along the path — long axis
        float ey = dot( e, B ) / ( sig * 0.62 );   // across it — narrow axis
        float path = exp( -( ex * ex + ey * ey ) );

        // Cut into three hard shapes: a broad wash, a bright body, and a
        // blazing core. Stepped, because a smooth lobe reads as default
        // three.js water and the whole point of the style is that it does not.
        float sheen = bandStep( path, 0.055 ) * 0.20
                    + bandStep( path, 0.30  ) * 0.46
                    + bandStep( path, 0.78  ) * 0.85;
        // Individual glints near the camera, a continuous sheet far away.
        sheen *= 0.30 + 0.95 * gGlitter;
        // Only the atmosphere may take the path away, and only where the sun
        // itself is up. The old hard kill at 4-22 km is exactly what removed
        // the reflection from every frame in which it would have mattered.
        sheen *= rim * gSunUp;
        gl_FragColor.rgb += uSunColor * sheen * ( 0.55 + 0.85 * uSeaState );
        gl_FragColor.a = clamp( gl_FragColor.a + sheen * 0.4, 0.0, 1.0 );
      }
    `).replace(`#include <fog_fragment>`,`
      {
        float hd = length( cameraPosition - vWWorld );
        float ha = pow( 1.0 - exp( -hd / max( 1.0, uAerialFar ) ), 1.35 ) * uAerialStrength;
        vec3  hv = normalize( vWWorld - cameraPosition );
        float phase = dot( hv, normalize( uSunDir ) );
        vec3 warm = uAerialColor * vec3( 1.13, 1.02, 0.86 ) + uSunColor * 0.05;
        vec3 cool = uAerialColor * vec3( 0.84, 0.92, 1.11 );
        vec3 haze = mix( cool, warm, smoothstep( -0.60, 0.80, phase ) );
        gl_FragColor.rgb += ( haze - uAerialColor ) * ( ha * 0.62 );
      }
      #include <fog_fragment>
      {
        // --- independent value floor for the sea ---------------------------
        //
        // The last of the three terms that were converging the water on the
        // sky. Aerial perspective blends toward uAerialColor, three's fog
        // blends toward the same horizon colour again, and the reflection above
        // is the sky by construction — so however each one is tuned, their
        // fixed point is "sea == sky" and the coastline dies at exactly the
        // distance where the picture needs it most.
        //
        // The fix is not to weaken any of them. It is to state the invariant
        // the picture actually depends on and enforce it: THE SEA IS NEVER
        // BRIGHTER THAN A FIXED FRACTION OF THE ATMOSPHERE IN FRONT OF IT.
        // That is true of every photograph of a coastline ever taken, and
        // because it is a ratio applied in scene-referred light it survives the
        // tone curve, the shoulder and the LUT as an ordering guarantee rather
        // than as a number that has to be re-tuned per grade.
        //
        // Applied only where the haze has actually taken over (it must not
        // touch near water, whose sun path is legitimately the brightest thing
        // in the sunset framing), and as a scale on the whole colour so the
        // hue is untouched.
        float hd2 = length( cameraPosition - vWWorld );
        float ha2 = pow( 1.0 - exp( -hd2 / max( 1.0, uAerialFar ) ), 1.35 );
        float capW = smoothstep( 0.16, 0.62, ha2 );
        float ceilL = dot( uAerialColor, vec3( 0.2126, 0.7152, 0.0722 ) )
                    * mix( 4.0, 0.80, capW );
        float curL = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
        gl_FragColor.rgb *= min( 1.0, ceilL / max( curL, 1e-4 ) );
      }
    `)}export{m as i,b as n,x as r,y as t};
//# sourceMappingURL=Water-BSAIvkLe.js.map