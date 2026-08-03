import * as THREE from 'three';
import type { QualityTier } from '../../engine/context';

/**
 * Shared plumbing for the post-processing chain.
 *
 * Everything here is deliberately tiny and allocation-free at runtime: a single
 * full-screen triangle, a handful of GLSL snippets that every pass includes,
 * and a render-target factory that keeps format/filter choices in one place.
 *
 * Why a full-screen *triangle* instead of a quad: a quad rasterises as two
 * triangles with a diagonal seam along which the GPU runs helper invocations
 * twice and, more importantly, derivatives (fwidth) are discontinuous. One
 * oversized triangle avoids both and is marginally cheaper to submit.
 */

// ---------------------------------------------------------------------------
// Full-screen triangle
// ---------------------------------------------------------------------------

const _quadGeometry = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  return g;
})();

const _quadCamera = new THREE.Camera();
const _quadScene = new THREE.Scene();
const _quadMesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material> =
  new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(_quadGeometry, new THREE.MeshBasicMaterial());
_quadMesh.frustumCulled = false;
_quadScene.add(_quadMesh);

/**
 * Draws one full-screen pass. 'target === null' means the canvas.
 *
 * The renderer is expected to have 'autoClear = false' (the Game sets that), so
 * clearing is explicit and a pass can composite additively into an existing
 * target simply by not asking for a clear.
 */
export function drawFullScreen(
  renderer: THREE.WebGLRenderer,
  material: THREE.Material,
  target: THREE.WebGLRenderTarget | null,
  clear = false,
): void {
  _quadMesh.material = material;
  renderer.setRenderTarget(target);
  if (clear) renderer.clear(true, false, false);
  renderer.render(_quadScene, _quadCamera);
}

/** Vertex shader every full-screen pass uses. Bypasses all matrices. */
export const FULLSCREEN_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }
`;

/** Builds a full-screen ShaderMaterial with sane post-processing defaults. */
export function makePassMaterial(
  fragmentShader: string,
  uniforms: Record<string, THREE.IUniform>,
  defines: Record<string, string | number> = {},
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms,
    defines,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
    fog: false,
    lights: false,
  });
}

// ---------------------------------------------------------------------------
// Render targets
// ---------------------------------------------------------------------------

export interface RTOptions {
  /** Half-float everywhere by default: the chain carries values > 1 (bloom,
   *  sun glint, emissive tracers) and 8-bit intermediates band visibly in the
   *  large flat areas a cel look is made of. */
  type?: THREE.TextureDataType;
  format?: THREE.PixelFormat;
  filter?: THREE.MagnificationTextureFilter;
  depth?: boolean;
  /** Colour attachment count — >1 gives an MRT target. */
  count?: number;
  name?: string;
}

export function makeRT(w: number, h: number, o: RTOptions = {}): THREE.WebGLRenderTarget {
  const filter = o.filter ?? THREE.LinearFilter;
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: o.type ?? THREE.HalfFloatType,
    format: o.format ?? THREE.RGBAFormat,
    minFilter: filter,
    magFilter: filter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: o.depth ?? false,
    stencilBuffer: false,
    generateMipmaps: false,
    count: o.count ?? 1,
  });
  for (const t of rt.textures) {
    // The chain is scene-referred linear light until the grade pass encodes to
    // sRGB. Tagging NoColorSpace stops three from injecting any conversion when
    // these textures are sampled by built-in materials.
    t.colorSpace = THREE.NoColorSpace;
    t.generateMipmaps = false;
  }
  if (o.name) rt.texture.name = o.name;
  return rt;
}

// ---------------------------------------------------------------------------
// Per-frame view constants shared by every pass
// ---------------------------------------------------------------------------

export interface FrameInfo {
  /** Internal render resolution in pixels (may be below the canvas size). */
  width: number;
  height: number;
  /** 1 / resolution. */
  texel: THREE.Vector2;
  near: number;
  far: number;
  /** (tan(fovY/2) * aspect, tan(fovY/2)) — turns NDC into a view-space ray. */
  projParams: THREE.Vector2;
  /** Pixels subtended by one metre at one metre of depth: 0.5*h/tan(fovY/2). */
  projScale: number;
  quality: QualityTier;
  dt: number;
  time: number;
  frame: number;
}

export function updateFrameInfo(
  info: FrameInfo,
  camera: THREE.PerspectiveCamera,
  w: number,
  h: number,
): void {
  info.width = w;
  info.height = h;
  info.texel.set(1 / Math.max(1, w), 1 / Math.max(1, h));
  info.near = camera.near;
  info.far = camera.far;
  const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
  info.projParams.set(tanHalf * camera.aspect, tanHalf);
  info.projScale = (0.5 * h) / tanHalf;
}

// ---------------------------------------------------------------------------
// GLSL snippets
// ---------------------------------------------------------------------------

/**
 * Common helpers. Included verbatim by most passes.
 *
 * 'octDecode' unpacks the octahedral view-space normal written by the depth /
 * normal prepass. Octahedral packing gives ~1 degree of error in two channels,
 * which is far better than the three-channel [0,1] remap for the same storage
 * and leaves the third and fourth channels free for depth and an object id.
 */
export const GLSL_COMMON = /* glsl */`
  float lumaOf( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

  vec2 octSignNotZero( vec2 v ) {
    return vec2( v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0 );
  }

  vec2 octEncode( vec3 n ) {
    n /= ( abs( n.x ) + abs( n.y ) + abs( n.z ) + 1e-8 );
    vec2 e = n.z >= 0.0 ? n.xy : ( 1.0 - abs( n.yx ) ) * octSignNotZero( n.xy );
    return e * 0.5 + 0.5;
  }

  vec3 octDecode( vec2 f ) {
    f = f * 2.0 - 1.0;
    vec3 n = vec3( f.x, f.y, 1.0 - abs( f.x ) - abs( f.y ) );
    float t = max( -n.z, 0.0 );
    n.xy += vec2( n.x >= 0.0 ? -t : t, n.y >= 0.0 ? -t : t );
    return normalize( n );
  }

  /**
   * Interleaved gradient noise (Jorge Jimenez). Screen-locked and time
   * independent on purpose: any temporal component here would show up as
   * crawling grain in the AO and the bokeh.
   */
  float ign( vec2 p ) {
    return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
  }

  float hash12( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }
`;

/**
 * View-space reconstruction. 'uProjParams' is (tanHalfFov*aspect, tanHalfFov)
 * and depth is stored as a normalised view distance so the ray is simply
 * scaled: no inverse projection matrix, no matrix multiply per tap.
 */
export const GLSL_VIEWPOS = /* glsl */`
  uniform vec2  uProjParams;
  uniform float uFar;

  /** Direction of the view ray through uv, with z = -1 (view space). */
  vec3 rayAt( vec2 uv ) {
    return vec3( ( uv * 2.0 - 1.0 ) * uProjParams, -1.0 );
  }

  /** View-space position of a pixel, given its *positive* view distance. */
  vec3 viewPosAt( vec2 uv, float z ) {
    return rayAt( uv ) * z;
  }
`;

/** sRGB transfer function, applied once at the very end of the chain. */
export const GLSL_SRGB = /* glsl */`
  vec3 linearToSRGB( vec3 c ) {
    c = max( c, vec3( 0.0 ) );
    return mix( c * 12.92,
                1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055,
                step( vec3( 0.0031308 ), c ) );
  }
`;

/** Disposes a render target and all of its colour attachments. */
export function disposeRT(rt: THREE.WebGLRenderTarget | null): void {
  if (!rt) return;
  for (const t of rt.textures) t.dispose();
  if (rt.depthTexture) rt.depthTexture.dispose();
  rt.dispose();
}
