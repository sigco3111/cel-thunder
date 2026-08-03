import * as THREE from 'three';
import type { QualityTier } from '../../engine/context';
import { GLSL_COMMON, GLSL_VIEWPOS, drawFullScreen, makePassMaterial, type FrameInfo } from './PassCore';

/**
 * INK EDGE PASS — the signature effect.
 *
 * A Roberts-cross (4 diagonal taps) or Sobel-style (8 taps) difference over the
 * prepass gbuffer, combining three independent edge cues, and compositing the
 * ambient-occlusion term at the same time so the whole thing costs one
 * full-screen pass instead of two.
 *
 * The three cues
 * --------------
 * 1. DEPTH, with plane rejection. The naive 'abs(dz) > k' test is what turns
 *    grazing terrain into black mush: at 5 degrees of slope, neighbouring
 *    pixels are legitimately tens of metres apart in depth and every one of
 *    them reads as an edge. So instead of comparing the neighbour to the
 *    centre, we compare it to where the centre's *tangent plane* says it should
 *    be. Given the centre's view position P and view normal N, a neighbouring
 *    pixel's ray R hits that plane at
 *
 *        z_pred = dot(N, P) / dot(N, R)
 *
 *    A continuous surface — however steep — has z_actual == z_pred and produces
 *    no edge. A real occlusion boundary does not. As the surface turns edge-on,
 *    dot(N, R) approaches zero, z_pred explodes, and the tolerance (which
 *    includes the predicted gradient) explodes with it, so grazing surfaces
 *    silently stop generating depth edges instead of going solid black.
 *    Only neighbours *behind* the plane count, which draws the line on the near
 *    side of a silhouette exactly once instead of on both sides.
 *
 * 2. NORMALS, for interior creases (panel joins, wing roots, control surfaces,
 *    gun bulges). Weighted by per-tap plane consistency so a silhouette does not
 *    also fire the normal term and produce a double-weight line, and faded at
 *    grazing incidence where interpolated normals are least trustworthy.
 *
 * 3. OBJECT ID, so two aircraft crossing at the same depth with parallel
 *    surfaces still separate. Gated on a small relative depth step so that
 *    adjacent terrain tiles — different objects, continuous surface — do not
 *    get a line down every seam.
 *
 * Stability: line width is expressed in pixels of the internal render target,
 * never in world units, so it is constant on screen and independent of
 * distance, FOV and resolution scaling. Nothing in the pass is time-varying, so
 * there is no source of temporal shimmer beyond ordinary geometric aliasing,
 * which the FXAA at the end of the chain resolves.
 *
 * Colour: the line is never black. It is the surface colour underneath, pushed
 * darker and *more saturated*, then nudged toward a deep indigo. That is what
 * ink on a printed cel actually looks like, and it keeps a red-nosed fighter's
 * outline reading red rather than as a hole punched in the frame.
 */
export class InkPass {
  readonly material: THREE.ShaderMaterial;
  private hq = true;

  constructor() {
    this.material = makePassMaterial(FRAG, {
      tColor: { value: null },
      tGB: { value: null },
      tAO: { value: null },

      uProjParams: { value: new THREE.Vector2(1, 1) },
      uFar: { value: 120000 },
      uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },

      uWidth: { value: 1.0 },
      uDepthSens: { value: 0.010 },
      uNormalSens: { value: 1.5 },
      uNormalWeight: { value: 0.85 },
      uIdWeight: { value: 0.75 },
      uFade: { value: new THREE.Vector2(2600, 9000) },
      uFadeHero: { value: new THREE.Vector2(4200, 13000) },
      uFadeInterior: { value: new THREE.Vector2(420, 2400) },
      uOpacity: { value: 0.92 },
      /** Line-width multiplier on LAYER_INK surfaces (see uInkId packing). */
      uHeroWidth: { value: 2.4 },
      /**
       * Distance over which the hero multiplier rolls *in*, metres.
       *
       * The heavy line exists so a fighter two hundred metres away still reads
       * as the subject of the frame. It is actively harmful on the aircraft
       * filling the foreground: see uHeroWidth's use below.
       */
      uHeroNear: { value: new THREE.Vector2(70, 260) },
      /** Distance over which the hero multiplier rolls back out to 1. */
      uHeroRange: { value: new THREE.Vector2(400, 1800) },

      uDarken: { value: 0.20 },
      uSaturate: { value: 1.85 },
      uTint: { value: new THREE.Color(0.055, 0.06, 0.11) },
      uTintAmount: { value: 0.45 },
      uFloor: { value: new THREE.Color(0.014, 0.016, 0.026) },

      uAOEnabled: { value: 1 },
      uAOStrength: { value: 0.85 },
      uAOTint: { value: new THREE.Color(0.62, 0.72, 0.95) },
    }, { INK_TAPS: 8 });
  }

  setQuality(q: QualityTier): void {
    // Roberts cross (4 diagonal taps) below 'high'. Diagonals alone are the
    // cheapest kernel that still catches axis-aligned panel joins; the extra
    // four axis taps mainly buy smoother diagonal lines.
    const hq = q === 'high' || q === 'ultra';
    if (hq === this.hq) return;
    this.hq = hq;
    this.material.defines.INK_TAPS = hq ? 8 : 4;
    this.material.needsUpdate = true;
  }

  /** 'outlineWidth' comes from Settings; 1.0 is a ~2 px line at 1080p. */
  update(info: FrameInfo, outlineWidth: number, aoEnabled: boolean, aoStrength: number): void {
    const u = this.material.uniforms;
    (u.uProjParams.value as THREE.Vector2).copy(info.projParams);
    (u.uTexel.value as THREE.Vector2).copy(info.texel);
    u.uFar.value = info.far;
    // Scale with vertical resolution so the line keeps the same *apparent*
    // weight at 720p and at 4K instead of getting hairline thin. INK_WIDTH_PX
    // is the tap radius in pixels at 1080p for ordinary surfaces: one pixel of
    // search draws a line thinner than the FXAA at the end of the chain, which
    // is why the ink read as "almost not there" on the aircraft.
    u.uWidth.value = outlineWidth * INK_WIDTH_PX * Math.max(0.75, info.height / 1080);
    u.uAOEnabled.value = aoEnabled ? 1 : 0;
    u.uAOStrength.value = aoStrength;
  }

  render(
    renderer: THREE.WebGLRenderer,
    color: THREE.Texture,
    gbuffer: THREE.Texture,
    ao: THREE.Texture | null,
    dst: THREE.WebGLRenderTarget,
  ): void {
    const u = this.material.uniforms;
    u.tColor.value = color;
    u.tGB.value = gbuffer;
    u.tAO.value = ao;
    drawFullScreen(renderer, this.material, dst);
  }

  dispose(): void { this.material.dispose(); }
}

/**
 * Edge-detect tap radius in pixels at 1080p, before 'settings.outlineWidth' and
 * before the hero multiplier. Hero surfaces end up around 2.4 px, which is a
 * line you can see at gameplay distance without it turning a distant furball
 * into blobs.
 */
const INK_WIDTH_PX = 1.15;

const FRAG = /* glsl */`
  precision highp float;

  ${GLSL_COMMON}
  ${GLSL_VIEWPOS}

  uniform sampler2D tColor;
  uniform sampler2D tGB;
  uniform sampler2D tAO;

  uniform vec2  uTexel;
  uniform float uWidth;
  uniform float uDepthSens;
  uniform float uNormalSens;
  uniform float uNormalWeight;
  uniform float uIdWeight;
  uniform vec2  uFade;
  uniform vec2  uFadeHero;
  uniform vec2  uFadeInterior;
  uniform float uOpacity;
  uniform float uHeroWidth;
  uniform vec2  uHeroNear;
  uniform vec2  uHeroRange;

  uniform float uDarken;
  uniform float uSaturate;
  uniform vec3  uTint;
  uniform float uTintAmount;
  uniform vec3  uFloor;

  uniform float uAOEnabled;
  uniform float uAOStrength;
  uniform vec3  uAOTint;

  varying vec2 vUv;

  // Anything at or beyond this fraction of the far plane was never written by
  // the prepass: sky, clouds, tracers. No ink, no AO.
  const float SKY = 0.9995;

  struct Edges { float d; float n; float i; };

  void tap(
    vec2 uv, vec2 offset, vec3 nc, vec3 Pc, vec3 Rc, float zc, float idc,
    inout Edges e
  ) {
    vec2 suv = uv + offset;
    vec4 g   = texture2D( tGB, suv );
    float zs = g.b * uFar;
    vec3  ns = octDecode( g.rg );

    // --- plane-predicted depth for this neighbour -------------------------
    vec3  R      = rayAt( suv );
    float denom  = dot( nc, R );
    float zPred  = abs( denom ) < 1e-6 ? zc * 6.0 : dot( nc, Pc ) / denom;
    zPred        = clamp( zPred, zc * 0.15, zc * 6.0 );

    // Tolerance carries the predicted gradient, so a steep-but-continuous
    // surface widens its own acceptance band automatically.
    float grad = abs( zPred - zc );
    float tol  = uDepthSens * zc + grad * 1.35 + 0.04;

    float behind = ( zs - zPred ) / tol - 1.0;
    float dEdge  = clamp( behind, 0.0, 1.0 );

    // --- the mirrored test ------------------------------------------------
    // A neighbour many times farther away is usually a silhouette, but not on
    // a grazing surface: level flight over terrain legitimately puts the next
    // pixel up several times farther away with no edge between them. Gating
    // that shortcut on incidence (the old 'facing' term) deleted the outline
    // from the entire mid-to-far ground plane — every ridge line, runway edge
    // and building silhouette on a low pass, which is the game's signature
    // shot. So gate it on the *neighbour's* own tangent plane instead: predict
    // where the centre pixel should be from the far surface's plane, and only
    // call it an occlusion boundary if the centre is well in front of that
    // prediction too. On a continuous grazing plane both surfaces agree and
    // nothing fires; across a real silhouette neither prediction holds.
    vec3  Ps    = R * zs;
    float denom2 = dot( ns, Rc );
    float zBack  = abs( denom2 ) < 1e-6 ? zc * 6.0 : dot( ns, Ps ) / denom2;
    float tol2   = uDepthSens * zc + abs( zBack - zs ) * 1.35 + 0.04;
    float front  = clamp( ( zBack - zc ) / tol2 - 1.0, 0.0, 1.0 );

    float ratio = clamp( ( zs / max( zc, 1e-3 ) - 1.7 ) * 1.1, 0.0, 1.0 );
    dEdge = max( dEdge, min( ratio, front ) );

    e.d = max( e.d, dEdge );

    // --- interior creases -------------------------------------------------
    float consistency = 1.0 - clamp( abs( zs - zPred ) / ( tol * 2.0 ), 0.0, 1.0 );
    float bend = ( 1.0 - dot( nc, ns ) ) * uNormalSens;
    e.n = max( e.n, clamp( bend, 0.0, 1.0 ) * consistency );

    // --- object separation ------------------------------------------------
    float idStep = step( 0.6 / 255.0, abs( idc - g.a ) );
    float depthStep = step( uDepthSens * 0.4, abs( zs - zc ) / max( zc, 1e-3 ) );
    e.i = max( e.i, idStep * depthStep );
  }

  void main() {
    vec4  gc  = texture2D( tGB, vUv );
    vec3  col = texture2D( tColor, vUv ).rgb;
    float zc  = gc.b * uFar;

    if ( gc.b > SKY ) {
      gl_FragColor = vec4( col, 1.0 );
      return;
    }

    vec3 nc  = octDecode( gc.rg );
    vec3 Pc  = viewPosAt( vUv, zc );
    vec3 V   = normalize( -Pc );
    float ndv = abs( dot( nc, V ) );

    // ------------------------------------------------------------------
    // Ambient occlusion, applied *before* the ink so lines darken over an
    // already-occluded surface rather than fighting it.
    //
    // The AO is quantised into three steps and biased toward the darkest
    // shading band. A continuous grey multiply would smear the toon ramp's
    // flat plateaus into gradients — exactly the thing the art direction
    // forbids — so instead AO mostly acts where the surface is already in
    // shadow (deepening it, and tinting it cool rather than grey) with only a
    // quarter-strength contact darkening allowed in lit areas for genuinely
    // tight crevices.
    // ------------------------------------------------------------------
    if ( uAOEnabled > 0.5 ) {
      float ao = texture2D( tAO, vUv ).r;
      float aoq = floor( ao * 3.0 + 0.35 ) / 3.0;
      aoq = mix( aoq, ao, 0.25 );

      float lum = lumaOf( col );
      float darkBand = 1.0 - smoothstep( 0.10, 0.44, lum );
      float amount = uAOStrength * mix( 0.25, 1.0, darkBand );

      col *= mix( 1.0, aoq, amount );
      col = mix( col, col * uAOTint, ( 1.0 - aoq ) * amount * 0.55 );
    }

    // ------------------------------------------------------------------
    // Edge detection
    // ------------------------------------------------------------------
    // Hero objects (LAYER_INK — every aircraft mesh) carry the +0.5 offset the
    // prepass packs into the id channel. They get a heavier line that survives
    // further out, so a fighter reads as the subject of the frame while the
    // vegetation and buildings behind it stay a fine graphic texture instead of
    // competing with it. This is the treatment LAYER_INK exists to select.
    // The heavy line is for the *subject*, not for every aircraft on the map:
    // a fighter 2 km away is 30 px across, and a 2.8 px outline around it is
    // the "distant aircraft turn into black blobs" failure the brief calls out.
    // So the extra weight is rolled off with distance back to the ordinary
    // line, while the fade below keeps a thin outline much further out.
    float heroId = step( 0.5, gc.a );

    // ...and it has to roll off on the NEAR side too, which is the half that
    // was missing and the reason the subject of every chase framing read as
    // tinted glass.
    //
    // A line's job is to describe a shape. Its width therefore has to be
    // measured against the shape, not against the screen: 2.4 x 1.15 px of tap
    // radius draws a five-to-eight pixel band, which is a crisp graphic edge on
    // a fighter 300 m away whose wing is 200 px across, and a flood on the same
    // fighter at 25 m whose wing chord is 40 px on screen. At chase distance
    // the leading edge, the trailing edge, both hinge lines and the wing root
    // all bloom to that width, merge, and cover a third of the wing in
    // near-black indigo at 0.92 opacity. What is left between the strokes is
    // the paint, which by then has no value separation from the terrain behind
    // it — so the eye resolves the aeroplane as a wireframe over the landscape
    // rather than as a solid. That is verbatim the critique's "only the ink
    // strokes and the roundel decal are opaque".
    //
    // 70-260 m is chosen off the framings rather than out of the air: the
    // chase cameras sit the player at 18-45 m, so the subject gets the plain
    // line; a wingman or a bandit in the 200-400 m band where the heavy line
    // actually buys legibility gets all of it.
    float hero = heroId
      * smoothstep( uHeroNear.x, uHeroNear.y, zc )
      * ( 1.0 - smoothstep( uHeroRange.x, uHeroRange.y, zc ) );

    vec2 o = uTexel * uWidth * mix( 1.0, uHeroWidth, hero );
    vec3 Rc = rayAt( vUv );

    Edges e = Edges( 0.0, 0.0, 0.0 );
    tap( vUv, vec2( -o.x, -o.y ), nc, Pc, Rc, zc, gc.a, e );
    tap( vUv, vec2(  o.x, -o.y ), nc, Pc, Rc, zc, gc.a, e );
    tap( vUv, vec2( -o.x,  o.y ), nc, Pc, Rc, zc, gc.a, e );
    tap( vUv, vec2(  o.x,  o.y ), nc, Pc, Rc, zc, gc.a, e );
    #if INK_TAPS > 4
      tap( vUv, vec2(  0.0, -o.y ), nc, Pc, Rc, zc, gc.a, e );
      tap( vUv, vec2(  0.0,  o.y ), nc, Pc, Rc, zc, gc.a, e );
      tap( vUv, vec2( -o.x,  0.0 ), nc, Pc, Rc, zc, gc.a, e );
      tap( vUv, vec2(  o.x,  0.0 ), nc, Pc, Rc, zc, gc.a, e );
    #endif

    // Interior detail must vanish long before silhouettes do, otherwise a
    // distant furball turns into a cloud of scribbles.
    // The *fade* still keys off the raw hero bit, not off the width ramp: how
    // far out a silhouette survives is a property of what the object is, not of
    // how wide its line happens to be at this distance.
    vec2  fade      = mix( uFade, uFadeHero, heroId );
    float silFade   = 1.0 - smoothstep( fade.x, fade.y, zc );
    float interFade = 1.0 - smoothstep( uFadeInterior.x, uFadeInterior.y, zc );

    float silhouette = max( e.d, e.i * uIdWeight ) * silFade;
    // Creases still fade at true edge-on incidence, where an interpolated
    // vertex normal is meaningless — but the old 0.10..0.36 window took out
    // everything below ~21 degrees of depression, i.e. the whole ground plane
    // on a low pass. Only the last few degrees are actually untrustworthy.
    float crease     = e.n * uNormalWeight * interFade * smoothstep( 0.02, 0.11, ndv );

    float edge = max( silhouette, crease );
    float line = smoothstep( 0.18, 0.62, edge ) * uOpacity;

    // ------------------------------------------------------------------
    // Ink colour: darker, more saturated version of what is underneath.
    // ------------------------------------------------------------------
    float l = lumaOf( col );
    vec3 sat = max( mix( vec3( l ), col, uSaturate ), vec3( 0.0 ) );
    vec3 ink = sat * uDarken;
    ink = mix( ink, uTint * ( 0.35 + 0.9 * l ), uTintAmount );
    ink = max( ink, uFloor );

    gl_FragColor = vec4( mix( col, ink, line ), 1.0 );
  }
`;
