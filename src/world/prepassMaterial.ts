import * as THREE from 'three';
import { GLSL_COMMON } from '../render/passes/PassCore';
import { HEIGHTFIELD_GLSL } from './terrainMaterial';

/**
 * Depth / normal / velocity prepass materials for the two surfaces whose shape
 * lives entirely in a vertex program: the CDLOD terrain and the Gerstner ocean.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * 'DepthNormalPass' fills the gbuffer with 'scene.overrideMaterial', which
 * throws away every mesh's own vertex program. For a normal mesh that is
 * correct and free — the override runs the same 'position' attribute through
 * the same model matrix. For the terrain it is catastrophic: the position
 * attribute is a unit grid in [0,1] and *all* of the geometry comes from
 * displacing it against the height texture with the per-instance node origin,
 * so the override draws a few dozen coincident 1 m quads at the world origin
 * and writes nothing at all where the landscape actually is. The gbuffer's
 * linear-depth channel over the whole ground therefore stays at the far-plane
 * clear value, which pushes the entire landscape to maximum circle of confusion
 * in 'DofPass', gives the ground zero velocity in 'MotionBlurPass' (a razor
 * sharp world under a motion-blurred aircraft), and denies 'AoPass' any contact
 * occlusion where trees, hangars and flak pits meet the ground. The ocean has
 * the identical problem for the identical reason.
 *
 * THE HOOK
 * --------
 * Both meshes publish 'userData.prepassMaterial'. A prepass that honours it
 * must render that object with the supplied material *instead of* the scene
 * override — and must do so in preference to 'userData.noPrepass', which is set
 * as well so that a prepass which does **not** yet know about the hook skips
 * the mesh entirely rather than stamping the origin artefact. In other words:
 *
 *     const pm = o.userData.prepassMaterial;
 *     if ( pm ) { renderWith( o, pm ); continue; }     // check FIRST
 *     if ( o.userData.noPrepass ) { hide( o ); continue; }
 *
 * The materials below write exactly the contract 'DepthNormalPass' documents:
 *
 *   location 0  rg = octahedral view-space normal
 *               b  = view distance / camera.far
 *               a  = per-object ink id
 *   location 1  rg = screen-space motion vector in UV units
 *
 * 'uInvFar', 'uInkId', 'uPrevViewProj' and (for the ocean, which translates
 * with the camera) 'uPrevModelMatrix' must be filled in by the pass; every
 * other uniform is shared by reference with the surface material, so the depth
 * written here is bit-identical to the depth the beauty pass rasterises.
 */

export interface PrepassMaterial extends THREE.ShaderMaterial {
  /** Uniforms the prepass must drive per frame / per draw. */
  prepassUniforms: {
    uInvFar: THREE.IUniform;
    uInkId: THREE.IUniform;
    uPrevViewProj: THREE.IUniform;
    uPrevModelMatrix: THREE.IUniform;
  };
}

const FRAGMENT = /* glsl */`
  precision highp float;

  ${GLSL_COMMON}

  uniform float uInvFar;
  uniform float uInkId;

  varying vec3  vPreNormal;
  varying float vPreViewZ;
  varying vec4  vPreCur;
  varying vec4  vPrePrev;

  layout(location = 0) out vec4 gNormalDepth;
  layout(location = 1) out vec4 gVelocity;

  void main() {
    vec3 n = normalize( vPreNormal );
    if ( !gl_FrontFacing ) n = -n;
    gNormalDepth = vec4( octEncode( n ), clamp( vPreViewZ * uInvFar, 0.0, 1.0 ), uInkId );
    vec2 cur  = vPreCur.xy  / max( vPreCur.w,  1e-6 );
    vec2 prev = vPrePrev.xy / max( vPrePrev.w, 1e-6 );
    gVelocity = vec4( ( cur - prev ) * 0.5, 0.0, 1.0 );
  }
`;

function baseUniforms(): Record<string, THREE.IUniform> {
  return {
    uInvFar: { value: 1 / 120000 },
    uInkId: { value: 0 },
    uPrevViewProj: { value: new THREE.Matrix4() },
    uPrevModelMatrix: { value: new THREE.Matrix4() },
  };
}

function finish(mat: THREE.ShaderMaterial): PrepassMaterial {
  const m = mat as PrepassMaterial;
  m.prepassUniforms = {
    uInvFar: m.uniforms.uInvFar,
    uInkId: m.uniforms.uInkId,
    uPrevViewProj: m.uniforms.uPrevViewProj,
    uPrevModelMatrix: m.uniforms.uPrevModelMatrix,
  };
  return m;
}

/**
 * Terrain prepass. The displacement, the geomorph and the analytic normal are
 * the same lines as 'terrainMaterial''s vertex program — if one is edited the
 * other must be too, or the gbuffer will disagree with the rasterised surface
 * by up to a patch of morph.
 *
 * The terrain does not move, so previous-frame clip space differs from current
 * only through the camera; 'uPrevModelMatrix' is unused (identity) here.
 */
export function createTerrainPrepassMaterial(
  shared: Record<string, THREE.IUniform>,
): PrepassMaterial {
  const u = baseUniforms();
  u.uHeight = shared.uHeight;
  u.uMapHalf = shared.uMapHalf;
  u.uBakeStep = shared.uBakeStep;
  u.uBakeRes = shared.uBakeRes;
  u.uGrid = shared.uGrid;

  return finish(new THREE.ShaderMaterial({
    name: 'terrainPrepass',
    glslVersion: THREE.GLSL3,
    uniforms: u,
    vertexShader: /* glsl */`
      ${HEIGHTFIELD_GLSL}
      uniform float uGrid;
      uniform mat4  uPrevViewProj;

      attribute vec4 iNode;
      attribute vec2 iMorph;

      varying vec3  vPreNormal;
      varying float vPreViewZ;
      varying vec4  vPreCur;
      varying vec4  vPrePrev;

      void main() {
        vec2 gp = position.xz;
        float nodeSize = iNode.z;
        vec2 wxz = iNode.xy + gp * nodeSize;

        float h0 = hfHeight( wxz );
        float camDist = distance( cameraPosition, vec3( wxz.x, h0, wxz.y ) );
        float morph = clamp( ( camDist - iMorph.x ) * iMorph.y, 0.0, 1.0 );
        vec2 snapped = fract( gp * uGrid * 0.5 ) * ( 2.0 / uGrid );
        wxz -= snapped * nodeSize * morph;

        float hh = hfHeight( wxz );
        float neSelf   = max( uBakeStep, nodeSize / uGrid );
        float neParent = max( uBakeStep, nodeSize * 2.0 / uGrid );
        float ne = mix( neSelf, neParent, morph );
        float hx = hfHeight( wxz + vec2( ne, 0.0 ) );
        float hz = hfHeight( wxz + vec2( 0.0, ne ) );
        vec3 nrm = normalize( vec3( hh - hx, ne, hh - hz ) );

        vec4 world = vec4( wxz.x, hh, wxz.y, 1.0 );
        vec4 mv = viewMatrix * world;
        vPreNormal = normalize( ( viewMatrix * vec4( nrm, 0.0 ) ).xyz );
        vPreViewZ  = -mv.z;
        gl_Position = projectionMatrix * mv;
        vPreCur  = gl_Position;
        // Static surface: only the camera moved.
        vPrePrev = uPrevViewProj * world;
      }
    `,
    fragmentShader: FRAGMENT,
    side: THREE.DoubleSide,
    blending: THREE.NoBlending,
    fog: false,
    lights: false,
  }));
}

/**
 * Ocean prepass. Shares the wave bank source with 'Water' so the gbuffer sees
 * the displaced crests, not the flat disc — otherwise a low pass over a heavy
 * sea gets its depth-of-field and motion blur from a plane that is up to a
 * metre away from the water actually being drawn.
 *
 * The mesh translates with the camera every frame, so this one *does* need
 * 'uPrevModelMatrix'.
 */
export function createWaterPrepassMaterial(
  shared: Record<string, THREE.IUniform>,
  waveGlsl: string,
): PrepassMaterial {
  const u = baseUniforms();
  u.uHeight = shared.uHeight;
  u.uMapHalf = shared.uMapHalf;
  u.uBakeStep = shared.uBakeStep;
  u.uBakeRes = shared.uBakeRes;
  u.uWTime = shared.uWTime;
  u.uSeaState = shared.uSeaState;
  u.uWaterLevel = shared.uWaterLevel;

  return finish(new THREE.ShaderMaterial({
    name: 'waterPrepass',
    glslVersion: THREE.GLSL3,
    uniforms: u,
    vertexShader: /* glsl */`
      ${HEIGHTFIELD_GLSL}
      ${waveGlsl}
      uniform float uWTime;
      uniform float uSeaState;
      uniform float uWaterLevel;
      uniform mat4  uPrevViewProj;
      uniform mat4  uPrevModelMatrix;

      varying vec3  vPreNormal;
      varying float vPreViewZ;
      varying vec4  vPreCur;
      varying vec4  vPrePrev;

      void main() {
        vec3 wpos = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
        float dist = length( position.xz );
        float ground = hfHeight( wpos.xz );
        float shoal = smoothstep( 0.0, 9.0, uWaterLevel - ground );
        vec3 wn; float fold;
        vec3 disp = gerstner( wpos.xz, uWTime, uSeaState * shoal, dist, wn, fold );
        wpos += disp;
        wpos.y += uWaterLevel;
        vec3 nrm = normalize( mix( vec3( 0.0, 1.0, 0.0 ), wn, shoal ) );

        vec4 world = vec4( wpos, 1.0 );
        vec4 mv = viewMatrix * world;
        vPreNormal = normalize( ( viewMatrix * vec4( nrm, 0.0 ) ).xyz );
        vPreViewZ  = -mv.z;
        gl_Position = projectionMatrix * mv;
        vPreCur  = gl_Position;
        // The disc follows the camera, so its own transform changed too: undo
        // this frame's translation and reapply last frame's.
        vec4 local = vec4( wpos - modelMatrix[3].xyz, 1.0 );
        vPrePrev = uPrevViewProj * uPrevModelMatrix * local;
      }
    `,
    fragmentShader: FRAGMENT,
    side: THREE.DoubleSide,
    blending: THREE.NoBlending,
    fog: false,
    lights: false,
  }));
}
