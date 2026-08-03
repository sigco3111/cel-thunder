import * as THREE from 'three';
import type { GameContext } from '../engine/context';

/**
 * The cel-shading material used by every opaque surface in the game.
 *
 * Design note — why this extends MeshToonMaterial rather than being a bare
 * ShaderMaterial: we want three's full lighting plumbing (cascaded shadow map
 * sampling, fog, IBL/environment, lightmaps, tone mapping, instancing,
 * skinning). Rewriting that from scratch is how stylised renderers end up with
 * broken shadows. So we take MeshToonMaterial — which already quantises
 * diffuse through a gradient ramp and receives shadows correctly — and patch
 * its shader with onBeforeCompile to add the things it lacks:
 *
 *   - an art-directed shadow *colour* (cool sky tint) rather than plain black,
 *   - a warm terminator band where light rolls off,
 *   - stepped specular (hard highlight shapes, not a blurry lobe),
 *   - a sun-driven rim light so silhouettes read against sky and ground,
 *   - screen-stable curvature-based ambient occlusion darkening,
 *   - optional halftone/hatching in the darkest band,
 *   - distance-based desaturation toward the atmosphere colour.
 *
 * All instances share global uniforms (sun, sky, time) which are refreshed once
 * per frame by 'updateCelGlobals'.
 */

export interface CelMaterialParams {
  color?: THREE.ColorRepresentation;
  map?: THREE.Texture | null;
  normalMap?: THREE.Texture | null;
  normalScale?: number;
  /** Roughness-like control over how tight the stepped specular is. 0 = mirror. */
  gloss?: number;
  /** Strength of the stepped specular highlight. */
  specular?: number;
  /** Number of hard specular steps (1 = single hard shape). */
  specSteps?: number;
  /** Number of diffuse bands in the lighting ramp. */
  bands?: number;
  /** How soft each band edge is, in N·L units. Small = hard ink edge. */
  bandSoftness?: number;
  /** Rim light colour; defaults to a hot version of the sun colour. */
  rimColor?: THREE.ColorRepresentation;
  rimStrength?: number;
  /** Rim falloff exponent — higher is a thinner rim. */
  rimPower?: number;
  /** Tint applied in shadow, as a multiplier. Cool blues read best. */
  shadowTint?: THREE.ColorRepresentation;
  /** Warm colour injected at the terminator. */
  terminatorTint?: THREE.ColorRepresentation;
  terminatorWidth?: number;
  /** Adds animated screen-space hatching to the darkest band. */
  hatching?: boolean;
  hatchScale?: number;
  /** Emissive for lit panels, exhausts, canopies. */
  emissive?: THREE.ColorRepresentation;
  emissiveMap?: THREE.Texture | null;
  emissiveIntensity?: number;
  /** Inverted-hull silhouette outline (see makeOutlineMesh). */
  outline?: boolean;
  outlineWidth?: number;
  outlineColor?: THREE.ColorRepresentation;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  flatShading?: boolean;
  /** Marks the material for the depth/normal edge-detect pass. */
  inkInterior?: boolean;
  vertexColors?: boolean;
  alphaTest?: number;
  fog?: boolean;
  depthWrite?: boolean;
  name?: string;
}

/** A cel material carries its extra uniforms here for per-frame updates. */
export interface CelMaterial extends THREE.MeshToonMaterial {
  celUniforms: Record<string, THREE.IUniform>;
  celParams: Required<Pick<CelMaterialParams, 'outline' | 'outlineWidth' | 'outlineColor'>>;
}

// ---------------------------------------------------------------------------
// Gradient ramp generation
// ---------------------------------------------------------------------------

const rampCache = new Map<string, THREE.DataTexture>();

/**
 * Level of the unlit hemisphere in the toon ramp — everything with N·L <= 0.
 *
 * This is *not* the final shadow brightness. The shader adds a sky-tinted
 * ambient term on top, so the surface lands around a quarter of its lit value
 * with a strong hue shift, which is what a coloured cel shadow is. Setting this
 * any higher is how the aircraft ended up flat: the ramp's own floor was 0.10
 * *of the sun*, but the previous band layout put the first lit step at N·L =
 * -0.18 and the second at +0.58, so the entire visible half of a fuselage sat
 * on one plateau and every panel read at the same value.
 */
const CORE_SHADOW = 0.115;

/**
 * Builds the 1D lighting ramp MeshToonMaterial samples with N·L.
 *
 * three samples this with 'coord = N·L * 0.5 + 0.5', so coord 0.5 is exactly
 * the geometric terminator. The band layout is anchored to that:
 *
 *   - Everything below the terminator is one deep core-shadow plateau, very
 *     slightly graded so a fuselage's far side does not become a dead flat
 *     shape. The colour that fills it comes from the ambient term, not here.
 *   - The lit hemisphere is cut into 'bands' plateaus whose *edges* are
 *     pushed toward the terminator by 'gamma' (edge k sits at
 *     N·L = (k/bands)^(1/gamma)), so the sunlit plateau stays broad and the
 *     roll-off happens where the form actually turns away. With the default
 *     three bands the edges land at N·L ≈ 0.24 and 0.60 — 76° and 53° from
 *     the sun — which is where a painter would put them.
 *   - Level k rises as a 0.75-power of k/bands rather than linearly. Equal
 *     steps in *reflectance* read as an accelerating ramp because the eye is
 *     roughly logarithmic; the power flattens that so the steps look evenly
 *     spaced on screen.
 *
 * 'softness' is the half-width of every edge, in N·L units. 0.04 is an ink
 * edge, 0.10 is the soft roll a hundred-metre terrain panel needs so a cloud
 * shadow crossing it does not draw a contour line.
 */
export function makeToonRamp(bands: number, softness: number, gamma = 0.78): THREE.DataTexture {
  const key = `${bands}|${softness.toFixed(4)}|${gamma.toFixed(3)}`;
  const cached = rampCache.get(key);
  if (cached) return cached;

  const B = Math.max(1, Math.round(bands));
  const soft = Math.max(0.005, softness);
  const invGamma = 1 / Math.max(0.05, gamma);

  const N = 512;
  const data = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const ndl = t * 2 - 1;

    // Core shadow, with a whisper of gradient so the darkest region still has
    // a direction to it.
    let v = CORE_SHADOW * (0.62 + 0.38 * smoothstep(-1, -0.15, ndl));

    // Each lit plateau is mixed in above its own edge. The edges are ordered,
    // and every smoothstep is exactly zero below its edge, so a sequential mix
    // reproduces the staircase without any per-band bookkeeping.
    for (let k = 0; k < B; k++) {
      const edge = k === 0 ? 0 : Math.pow(k / B, invGamma);
      const level = CORE_SHADOW + (1 - CORE_SHADOW) * Math.pow((k + 1) / B, 0.75);
      v += (level - v) * smoothstep(edge - soft, edge + soft, ndl);
    }

    v = Math.max(0, Math.min(1, v));
    const b = Math.round(v * 255);
    data[i * 4] = b; data[i * 4 + 1] = b; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  rampCache.set(key, tex);
  return tex;
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------
// Global uniforms shared by every cel material
// ---------------------------------------------------------------------------

export const celGlobals = {
  uSunDir: { value: new THREE.Vector3(0.45, 0.62, 0.64) },   // toward the sun
  uSunColor: { value: new THREE.Color(1.0, 0.94, 0.82) },
  uSkyColor: { value: new THREE.Color(0.42, 0.55, 0.72) },
  uGroundColor: { value: new THREE.Color(0.30, 0.30, 0.24) },
  uTime: { value: 0 },
  uResolution: { value: new THREE.Vector2(1920, 1080) },
  /** Distance at which surfaces fully take on the atmosphere colour. */
  uAerialFar: { value: 26000 },
  uAerialColor: { value: new THREE.Color(0.62, 0.74, 0.86) },
  uAerialStrength: { value: 0.9 },
  /** Global exposure applied before the composer's grade. */
  uExposure: { value: 1.0 },

  /**
   * Strength of the key light, in the same photometric units three uses for
   * 'DirectionalLight.intensity'.
   *
   * Every art-directed term the cel shader adds by hand — the warm terminator,
   * the stepped specular, the sun rim — is a *light*, and a light has to be in
   * the same units as the light it sits next to or it is invisible. Before this
   * existed those terms were scaled by 'uSunColor' alone, which is a normalised
   * hue with a peak channel near 1, while three's direct diffuse arrived at
   * sunColor x intensity (~3). A rim at 0.42 against a diffuse term at 1.2 and
   * an HDR sunset sky at 3-4 is not a rim, it is rounding error — which is
   * exactly what the sunset framing showed.
   *
   * Clamped low so a night or storm scene keeps a readable silhouette instead
   * of losing the rim entirely, and clamped high so a blown-out noon does not
   * turn every leading edge into a white line.
   */
  uKeyLevel: { value: 3.0 },
  /**
   * How much of three's own indirect (hemisphere/ambient/IBL) contribution
   * survives. See the ambient block in the shader for why this is not 1.
   */
  uFillKeep: { value: 0.34 },
  /** Strength of the art-directed hemispheric fill that replaces it. */
  uAmbient: { value: 0.60 },
};

const registry = new Set<CelMaterial>();

/** Call once per frame, before rendering, to push sky/sun state into materials. */
export function updateCelGlobals(ctx: GameContext): void {
  // ctx.sunDir points *from* the sun toward the scene; shading wants the
  // opposite (surface -> light).
  celGlobals.uSunDir.value.copy(ctx.sunDir).multiplyScalar(-1).normalize();
  celGlobals.uSunColor.value.copy(ctx.sunColor);
  celGlobals.uSkyColor.value.copy(ctx.ambientColor);
  // The sky retargets the key to the moon after dusk and drops its intensity
  // to a fraction; the floor keeps a silhouette-defining rim alive through the
  // night, the ceiling stops a clear noon from fringing every edge white.
  celGlobals.uKeyLevel.value = Math.min(4.2, Math.max(0.35, ctx.sunIntensity));
  celGlobals.uTime.value = ctx.time;
  const size = ctx.renderer.getDrawingBufferSize(_v2);
  celGlobals.uResolution.value.set(size.x, size.y);
}
const _v2 = new THREE.Vector2();

// ---------------------------------------------------------------------------
// Material factory
// ---------------------------------------------------------------------------

export function createCelMaterial(p: CelMaterialParams = {}): CelMaterial {
  const bands = p.bands ?? 3;
  const softness = p.bandSoftness ?? 0.055;

  const mat = new THREE.MeshToonMaterial({
    color: p.color ?? 0xffffff,
    map: p.map ?? null,
    normalMap: p.normalMap ?? null,
    normalScale: new THREE.Vector2(p.normalScale ?? 1, p.normalScale ?? 1),
    gradientMap: makeToonRamp(bands, softness),
    emissive: new THREE.Color(p.emissive ?? 0x000000),
    emissiveMap: p.emissiveMap ?? null,
    emissiveIntensity: p.emissiveIntensity ?? 1,
    transparent: p.transparent ?? false,
    opacity: p.opacity ?? 1,
    side: p.side ?? THREE.FrontSide,
    vertexColors: p.vertexColors ?? false,
    alphaTest: p.alphaTest ?? 0,
    fog: p.fog ?? true,
    depthWrite: p.depthWrite ?? true,
  }) as CelMaterial;

  if (p.name) mat.name = p.name;

  const sunCol = new THREE.Color(1.0, 0.94, 0.82);
  const u: Record<string, THREE.IUniform> = {
    uSunDir: celGlobals.uSunDir,
    uSunColor: celGlobals.uSunColor,
    uSkyColor: celGlobals.uSkyColor,
    uGroundColor: celGlobals.uGroundColor,
    uTime: celGlobals.uTime,
    uResolution: celGlobals.uResolution,
    uAerialFar: celGlobals.uAerialFar,
    uAerialColor: celGlobals.uAerialColor,
    uAerialStrength: celGlobals.uAerialStrength,
    uKeyLevel: celGlobals.uKeyLevel,
    uFillKeep: celGlobals.uFillKeep,
    uAmbient: celGlobals.uAmbient,

    uGloss: { value: p.gloss ?? 0.35 },
    uSpecular: { value: p.specular ?? 0.6 },
    uSpecSteps: { value: p.specSteps ?? 2 },
    uRimColor: { value: new THREE.Color(p.rimColor ?? sunCol) },
    uRimStrength: { value: p.rimStrength ?? 0.85 },
    uRimPower: { value: p.rimPower ?? 3.2 },
    uShadowTint: { value: new THREE.Color(p.shadowTint ?? 0x5f7ea8) },
    uTerminatorTint: { value: new THREE.Color(p.terminatorTint ?? 0xffa864) },
    uTerminatorWidth: { value: p.terminatorWidth ?? 0.16 },
    uHatch: { value: p.hatching ? 1 : 0 },
    uHatchScale: { value: p.hatchScale ?? 220 },
  };
  mat.celUniforms = u;
  mat.celParams = {
    outline: p.outline ?? false,
    outlineWidth: p.outlineWidth ?? 0.012,
    outlineColor: p.outlineColor ?? 0x0b0f16,
  };

  // 'inkInterior' is read by the edge-detect pass via the object's layer, not
  // by the shader itself; store it so callers can query.
  (mat as any).inkInterior = p.inkInterior ?? true;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        varying vec3 vCelWorldPos;
        varying vec3 vCelWorldNormal;
      `)
      .replace('#include <worldpos_vertex>', /* glsl */`
        #include <worldpos_vertex>
        vec4 celWP = modelMatrix * vec4( transformed, 1.0 );
        vCelWorldPos = celWP.xyz;
        vCelWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform vec3  uSunDir;
        uniform vec3  uSunColor;
        uniform vec3  uSkyColor;
        uniform vec3  uGroundColor;
        uniform float uTime;
        uniform vec2  uResolution;
        uniform float uAerialFar;
        uniform vec3  uAerialColor;
        uniform float uAerialStrength;
        uniform float uKeyLevel;
        uniform float uFillKeep;
        uniform float uAmbient;
        uniform float uGloss;
        uniform float uSpecular;
        uniform float uSpecSteps;
        uniform vec3  uRimColor;
        uniform float uRimStrength;
        uniform float uRimPower;
        uniform vec3  uShadowTint;
        uniform vec3  uTerminatorTint;
        uniform float uTerminatorWidth;
        uniform float uHatch;
        uniform float uHatchScale;
        varying vec3 vCelWorldPos;
        varying vec3 vCelWorldNormal;

        // Screen-space diagonal hatching. Anchored to screen coords (not UVs)
        // so it behaves like ink on paper rather than a texture on the model.
        float celHatch( vec2 fragCoord, float density ) {
          vec2 p = fragCoord / uResolution.y * uHatchScale;
          float a = sin( ( p.x + p.y ) * 0.7 );
          float b = sin( ( p.x - p.y ) * 0.7 + 1.7 );
          float line = max( a, b * step( 0.45, density ) );
          return smoothstep( -0.15, 0.35, line );
        }
      `)
      // Wedge the toon-specific shading in after three has resolved direct
      // lighting and shadows into reflectedLight.
      .replace('#include <lights_fragment_end>', /* glsl */`
        #include <lights_fragment_end>
        {
          const vec3 CEL_LUMA = vec3( 0.2126, 0.7152, 0.0722 );

          // 'normal' is three's final shading normal in view space — it carries
          // the normal map, flat shading and, for terrain, the detail normal
          // that module substitutes. Rotating it back to world space costs one
          // matrix multiply and means the rim, the specular and the terminator
          // all sit on the same surface three lit, instead of on the smooth
          // interpolated normal. Panel lines and rivets now catch the rim.
          // (viewMatrix's upper 3x3 is orthonormal, so its inverse is its
          // transpose, which is what post-multiplying does.)
          vec3  N  = normalize( normal * mat3( viewMatrix ) );
          vec3  V  = normalize( cameraPosition - vCelWorldPos );
          vec3  L  = normalize( uSunDir );
          float ndl = dot( N, L );

          // --- how lit is this fragment, really? ---------------------------
          // reflectedLight.directDiffuse already carries the banded ramp times
          // the shadow-map term times albedo times the sun. Divide those out
          // and what is left is the ramp value in [0,1], which is the only
          // thing worth thresholding on. A fixed luminance cut (what this used
          // to do) is meaningless: at dusk the whole frame sits below it and
          // every surface reads as shadow, at noon nothing does.
          float albLum = max( dot( diffuseColor.rgb, CEL_LUMA ), 0.02 );
          float sunLum = max( dot( uSunColor, CEL_LUMA ), 1e-3 ) * uKeyLevel;
          float key = dot( reflectedLight.directDiffuse, CEL_LUMA )
                    / ( albLum * sunLum * 0.3183 );
          float shadowMask = 1.0 - smoothstep( 0.16, 0.62, key );

          // --- ambient ------------------------------------------------------
          // The fill is rebuilt here rather than inherited. The sky system's
          // HemisphereLight lands at roughly half the key's value on every
          // surface regardless of facing, which is precisely why every airframe
          // in the game read flat: with the fill that high the ratio between a
          // panel facing the sun and one facing away is under 2:1, and the
          // grade's S-curve then closes what little is left. Keeping a third of
          // three's term preserves whatever colour the sky is doing with it;
          // the replacement is squared in 'upness' so it falls off fast on the
          // way down — an aircraft's underside has to stay dark or nothing on
          // it reads as three-dimensional and its cast shadow has no contrast
          // to sit against.
          reflectedLight.indirectDiffuse *= uFillKeep;

          // The fill is *banded* as well as rebuilt. This is the one place a
          // toon renderer quietly turns back into a smooth renderer: the
          // gradient ramp quantises the key only, so an aircraft seen from
          // below — where by definition nothing is lit — ends up shaded
          // entirely by a continuous hemisphere gradient and reads as a soft
          // grey lump. Three steps, and only 70 % of the way to hard, so a
          // hillside gets a deliberate step rather than a contour line.
          float upness = N.y * 0.5 + 0.5;
          float uBand = 0.10
            + 0.42 * smoothstep( 0.31, 0.49, upness )
            + 0.48 * smoothstep( 0.61, 0.79, upness );
          vec3 hemi = mix( uGroundColor, uSkyColor, mix( upness * upness, uBand, 0.7 ) );
          vec3 ambient = hemi * diffuseColor.rgb * uAmbient;

          // Coloured shadows, not grey ones. Take the *hue* of the sky and of
          // the art-directed tint — both normalised to unit luminance first, so
          // this is a chroma shift and not a second darkening — and swing the
          // fill toward it wherever the key has dropped out. The extra
          // darkening is what separates a cast shadow from a shaded face.
          vec3 skyHue  = uSkyColor    / max( dot( uSkyColor,    CEL_LUMA ), 1e-3 );
          vec3 tintHue = uShadowTint  / max( dot( uShadowTint,  CEL_LUMA ), 1e-3 );
          // Extrapolating past 1.0 saturates rather than blends: a hazy midday
          // sky normalises to something 4 % blue, and a shadow 4 % blue is a
          // grey shadow, which the rubric fails outright.
          vec3 shadeHue = max( mix( vec3( 1.0 ), mix( skyHue, tintHue, 0.55 ), 1.55 ), vec3( 0.0 ) );
          shadeHue = mix( vec3( 1.0 ), shadeHue, shadowMask * 0.85 );
          // 0.30, not the 0.18 this shipped with. The number is a *form-shadow
          // depth*, and it is the only term in the shader that can separate a
          // surface turned away from the sun from a surface next to it that is
          // not — which is the whole of the "the aeroplane is camouflaged into
          // the ground" failure. Measured on the dogfight framing, the port
          // wing's upper surface sat at (54,71,87) against terrain immediately
          // behind it at (50,71,83): four levels, held only by the ink stroke
          // and the roundel. It is safe to make deep because 'shadowMask' is
          // derived from the resolved key, so it is zero on everything the sun
          // reaches: the sunlit terrain the wing is seen against does not move
          // at all, and only the surfaces that are genuinely in shade drop.
          ambient *= shadeHue * ( 1.0 - 0.30 * shadowMask );
          reflectedLight.indirectDiffuse += ambient;

          // --- warm terminator ---------------------------------------------
          // A thin warm band exactly at the light/shadow boundary. This is the
          // single cheapest trick that makes cel shading look painted. Scaled
          // by the key so it fades with the sun instead of glowing at night.
          float term = 1.0 - smoothstep( 0.0, uTerminatorWidth, abs( ndl ) );
          term *= smoothstep( -0.03, 0.10, ndl );
          reflectedLight.directDiffuse +=
            uTerminatorTint * uSunColor * uKeyLevel * term * 0.20 * diffuseColor.rgb;

          // --- stepped specular --------------------------------------------
          // Blinn-Phong, then hard-quantised into uSpecSteps shapes.
          //
          // NOTE ON THE ACCUMULATOR. Both this and the rim below add into
          // 'directDiffuse', not 'directSpecular', and that is deliberate:
          // three's toon fragment shader ends with
          //     outgoingLight = directDiffuse + indirectDiffuse + emissive
          // and never reads either specular accumulator. Anything written to
          // 'reflectedLight.directSpecular' in a MeshToonMaterial is computed
          // and then silently discarded — which is why this renderer had no
          // rim light and no specular on any surface in the game despite both
          // being implemented here. Nothing between 'lights_fragment_end' and
          // that line scales directDiffuse (aomap touches indirect only), so
          // adding here is exactly equivalent and does not depend on matching
          // a three internal source string.
          //
          // The key level is folded into 'sq' rather than into the accumulate
          // expression on purpose: src/assets/aircraft/build.ts patches that
          // exact line to attenuate the highlight by its roughness map, and it
          // matches on the literal source text.
          vec3 H = normalize( L + V );
          float ndh = max( dot( N, H ), 0.0 );
          float shininess = mix( 400.0, 12.0, clamp( uGloss, 0.0, 1.0 ) );
          float spec = pow( ndh, shininess ) * step( 0.0, ndl );
          float steps = max( 1.0, uSpecSteps );
          float sq = floor( clamp( spec, 0.0, 1.0 ) * steps + 0.5 ) / steps;
          // Anti-alias the quantised edge so it does not crawl under motion.
          float sw = fwidth( spec ) * steps;
          sq = mix( sq, spec, clamp( sw * 2.0, 0.0, 1.0 ) );
          sq *= uKeyLevel * 0.42;
          reflectedLight.directDiffuse += uSunColor * sq * uSpecular;

          // --- rim light ----------------------------------------------------
          // Fresnel, gated two ways. 'wrap' keeps the rim on the sun's side of
          // the terminator, which is where light physically wraps a silhouette
          // — put it on the shadow side and a backlit aircraft turns into a
          // glowing outline instead of a graphic dark shape. 'backlit' is the
          // separation between a hero shot and a marketing shot: with the sun
          // behind the subject the rim runs up to five times the front-lit
          // value, tracing the wing leading edge, the canopy and the tailplane
          // in sun colour.
          //
          // THE BACKLIT BOOST RIDES A *TIGHTER* FRESNEL THAN THE BASE TERM, and
          // that is the whole reason the airframe used to sit at the same value
          // as everything behind it. Worked through at the hull's authored
          // 0.34 / power 7: a wing panel at 45 degrees has fres = 0.093, and
          // with the boost applied to that same fres it collected
          //     keyLevel(3) * 0.62 * 0.093 * 2.60 * 0.34 = 0.153
          // of untinted white — on a Dark Earth albedo of 0.15, i.e. a doubling
          // — across *every interior panel of a near-planar wing at once*,
          // because eight of the ten framings are lit 70-110 degrees off the
          // lens and 'backlit' is near 1 in all of them. That is a flat pale
          // wash sitting exactly where the form's own value structure should
          // be, and it is why the water framing read as a grey-mauve cut-out
          // and the dogfight wing measured five levels off the terrain behind
          // it. Squaring the Fresnel for the boost only (doubling its effective
          // exponent) takes that 45-degree panel from 0.153 to 0.038 — a
          // four-fold cut — while the silhouette itself, where N·V is 0.05 and
          // fres is 0.72, keeps 87 % of its old peak. The rim gets narrower and
          // the shape underneath it gets its range back.
          float ndv = max( dot( N, V ), 0.0 );
          float fres = pow( 1.0 - ndv, uRimPower );
          float tight = fres * fres;
          float backlit = smoothstep( -0.15, 0.85, -dot( L, V ) );
          float wrap = smoothstep( -0.50, 0.10, ndl );
          float rim = wrap * ( 0.40 * fres + 2.60 * backlit * tight );
          reflectedLight.directDiffuse +=
            uRimColor * uSunColor * ( uKeyLevel * 0.62 ) * rim * uRimStrength;

          // --- silhouette edge light ----------------------------------------
          // The term above is a *wrap* light: authored wide, so it models the
          // way light bends round a form. What separates a planform from
          // terrain of the same value is a different thing — a hot line one or
          // two pixels inside the ink stroke, along the wing leading edge, the
          // tip, the fin and the tailplane.
          //
          // Fixed exponent 14, deliberately not the authored uRimPower: at the
          // silhouette (N·V = 0.05) this is 0.49, and on a panel only 45
          // degrees off the lens it is 3e-8. It is therefore impossible for it
          // to wash an interior surface no matter how the material is authored,
          // which is exactly the property the wrap term does not have. Scaled
          // by uRimStrength so terrain (0.04) and foliage keep it at a level
          // where a mountain flank cannot grow a halo.
          //
          // Net effect on the hull at key 3: the silhouette goes from 1.18 to
          // 1.78 of sun colour — half a stop hotter and confined to a couple of
          // pixels — while the interior panels it used to leak onto are down by
          // four. That trade is the whole item: a bright line just inside the
          // ink stroke, and a darker, wider-ranged shape behind it.
          float edge = ndv < 1.0 ? pow( 1.0 - ndv, 14.0 ) : 0.0;
          reflectedLight.directDiffuse +=
            uRimColor * uSunColor * ( uKeyLevel * 0.62 )
            * edge * smoothstep( -0.32, 0.28, ndl ) * uRimStrength * 2.40;

          // --- sky rim ------------------------------------------------------
          // A cool counter-rim from the sky hemisphere on the shadow side.
          // Without it the unlit half of a silhouette dies into the terrain
          // whenever the aircraft is between the camera and the ground. Its
          // falloff is deliberately tighter than the sun rim's — a broad one
          // washes a fully backlit aircraft into a pale blob instead of
          // leaving it the dark graphic shape the shot is built around.
          reflectedLight.directDiffuse +=
            uSkyColor * ( tight * 0.55 + edge * 1.30 )
            * ( 1.0 - smoothstep( -0.1, 0.35, ndl ) ) * uRimStrength * 1.20;

          // --- underside contact darkening ----------------------------------
          // A wing's underside sees ground bounce, not sky, and the hemispheric
          // fill above already knows that. What it does not know is that the
          // surfaces facing *straight* down are the ones a viewer reads as the
          // aircraft's contact with the world: leave them at the fill's value
          // and the belly, the flap undersides and the tailplane underside all
          // land within a few levels of the terrain they are seen against, and
          // the planform stops having a bottom edge. Terrain and water never
          // face downward, so this is an airframe term in practice.
          reflectedLight.indirectDiffuse *= 1.0 - 0.30 * smoothstep( 0.10, -0.60, N.y );

          // --- ink hatching in the darkest band -----------------------------
          if ( uHatch > 0.5 ) {
            float h = celHatch( gl_FragCoord.xy, shadowMask );
            reflectedLight.indirectDiffuse *= mix( 1.0, 0.72, ( 1.0 - h ) * shadowMask );
          }
        }
      `)
      // Aerial perspective: stylised distance haze applied after all lighting
      // but before three's own fog, so fog and haze compose rather than fight.
      .replace('#include <fog_fragment>', /* glsl */`
        {
          float d = length( cameraPosition - vCelWorldPos );
          float aerial = 1.0 - exp( -d / max( 1.0, uAerialFar ) );
          aerial = pow( aerial, 1.35 ) * uAerialStrength;
          // Desaturate toward the atmosphere colour rather than simply
          // blending to it — preserves value structure at long range. Both
          // weights are held well below 1: a distant ridge that has lost all
          // its internal contrast stops reading as landscape and becomes a
          // flat pale cut-out, which is worse than slightly too little haze.
          float g = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
          vec3 desat = mix( gl_FragColor.rgb, vec3( g ), aerial * 0.42 );
          gl_FragColor.rgb = mix( desat, uAerialColor, aerial * 0.62 );
        }
        #include <fog_fragment>
      `);
  };

  // Changing onBeforeCompile requires a distinct cache key per configuration.
  mat.customProgramCacheKey = () =>
    `cel|${bands}|${softness}|${p.hatching ? 1 : 0}|${p.specSteps ?? 2}|${!!p.map}|${!!p.normalMap}|${!!p.emissiveMap}`;

  registry.add(mat);
  return mat;
}

export function disposeCelMaterial(mat: CelMaterial): void {
  registry.delete(mat);
  mat.dispose();
}

// ---------------------------------------------------------------------------
// Inverted-hull outlines
// ---------------------------------------------------------------------------

/**
 * Back-face inverted-hull outline. Used for hero silhouettes (aircraft,
 * vehicles) where the screen-space edge detector alone is too thin or too
 * unstable at distance.
 *
 * The hull is expanded along the *smoothed* vertex normal in view space and
 * scaled by view depth, which keeps the outline a constant pixel width instead
 * of ballooning up close and vanishing far away.
 */
export function createOutlineMaterial(width = 0.012, color: THREE.ColorRepresentation = 0x0b0f16): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uWidth: { value: width },
      uColor: { value: new THREE.Color(color) },
      uResolution: celGlobals.uResolution,
      // Outlines thin out with distance so a distant furball does not turn
      // into a mass of black scribbles.
      uFadeStart: { value: 900 },
      uFadeEnd: { value: 5200 },
    },
    vertexShader: /* glsl */`
      uniform float uWidth;
      uniform vec2  uResolution;
      uniform float uFadeStart;
      uniform float uFadeEnd;
      varying float vFade;

      #include <common>
      #include <skinning_pars_vertex>

      void main() {
        #include <beginnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>

        vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          mvPosition = modelViewMatrix * instanceMatrix * vec4( transformed, 1.0 );
        #endif

        vec3 nView = normalize( normalMatrix * objectNormal );
        float dist = -mvPosition.z;

        // Constant screen-space thickness: scale by distance and by the
        // projection's vertical scale so FOV changes do not alter line weight.
        float pixelScale = dist * ( 2.0 / projectionMatrix[1][1] ) / uResolution.y;
        float w = uWidth * pixelScale * 90.0;

        mvPosition.xyz += nView * w;
        gl_Position = projectionMatrix * mvPosition;

        // Nudge the hull away from the camera so it never z-fights the model.
        gl_Position.z += 0.00015 * gl_Position.w;

        vFade = 1.0 - smoothstep( uFadeStart, uFadeEnd, dist );
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      varying float vFade;
      void main() {
        if ( vFade < 0.02 ) discard;
        gl_FragColor = vec4( uColor, vFade );
      }
    `,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: true,
  });
}

/**
 * Attaches an inverted-hull outline child to 'mesh'. The child shares the
 * source geometry, so it costs one extra draw call and no extra memory.
 */
export function addOutline(
  mesh: THREE.Mesh,
  width = 0.012,
  color: THREE.ColorRepresentation = 0x0b0f16,
): THREE.Mesh {
  const outline = new THREE.Mesh(mesh.geometry, createOutlineMaterial(width, color));
  outline.name = `${mesh.name || 'mesh'}__outline`;
  outline.castShadow = false;
  outline.receiveShadow = false;
  outline.renderOrder = (mesh.renderOrder || 0) - 1;
  outline.frustumCulled = mesh.frustumCulled;
  mesh.add(outline);
  return outline;
}

/** Recursively outline every mesh in a hierarchy that opts in. */
export function addOutlinesRecursive(root: THREE.Object3D, width = 0.012, color: THREE.ColorRepresentation = 0x0b0f16): void {
  const targets: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && !o.name.endsWith('__outline') && o.userData.noOutline !== true) {
      targets.push(o as THREE.Mesh);
    }
  });
  for (const m of targets) addOutline(m, width, color);
}

// ---------------------------------------------------------------------------
// Render layers — used by the composer to isolate passes
// ---------------------------------------------------------------------------

export const LAYER_DEFAULT = 0;
/** Objects that should receive interior ink lines from the edge-detect pass. */
export const LAYER_INK = 1;
/** Bloom-only objects (tracers, exhaust flame, sun disc). */
export const LAYER_BLOOM = 2;
/** Sky/background — excluded from SSAO and outlines. */
export const LAYER_SKY = 3;
/** Cockpit interior — rendered with a separate near-clip pass. */
export const LAYER_COCKPIT = 4;
