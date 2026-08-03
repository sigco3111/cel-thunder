import * as THREE from 'three';

/**
 * Shared full-screen plumbing for the sky subsystem.
 *
 * Everything the sky draws is either an offscreen post-style pass or a
 * screen-aligned layer inside the main scene, so both cases share one geometry
 * and one vertex shader.
 *
 * We use a single oversized triangle rather than a quad: it avoids the
 * diagonal seam where two triangles meet (which causes duplicated quad-level
 * shading and, with heavy raymarch shaders, a measurable cost) and it needs no
 * index buffer.
 *
 * The vertex shader hands the fragment shader the interpolated NDC position
 * rather than a UV. That is deliberate — reconstructing the view ray from NDC
 * is resolution-independent, so the same material works whether it is drawn
 * into the canvas, into a half-resolution buffer, or into whatever HDR target
 * the composer eventually owns, with no uniform to keep in sync.
 */

let _triangle: THREE.BufferGeometry | null = null;

export function fullscreenTriangleGeometry(): THREE.BufferGeometry {
  if (_triangle) return _triangle;
  const g = new THREE.BufferGeometry();
  // Clip-space triangle that strictly contains [-1,1]^2.
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -1, -1, 0,
     3, -1, 0,
    -1,  3, 0,
  ]), 3));
  // three's non-raw shader prefix always declares 'normal' and 'uv'; supplying
  // them keeps the attribute bindings clean even though nothing reads them.
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1,
  ]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
    0, 0, 2, 0, 0, 2,
  ]), 2));
  // A bounding sphere is required by three even for non-culled objects when
  // something (e.g. a shadow pass) asks for it.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
  _triangle = g;
  return g;
}

/**
 * Vertex shader used by every sky pass.
 *
 * 'vNdc' is the position in normalised device coordinates; 'vUv' is the same
 * value remapped to [0,1] for texture lookups. gl_Position.z is pinned to the
 * far plane so that, in the rare case a caller enables depth testing, the layer
 * sits behind all geometry instead of in front of it.
 */
export const FULLSCREEN_VERT = /* glsl */`
varying vec2 vNdc;
varying vec2 vUv;
void main() {
  vNdc = position.xy;
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4( position.xy, 1.0, 1.0 );
}
`;

/** A screen-aligned mesh that lives inside the game scene. */
export function makeScreenLayer(material: THREE.Material, renderOrder: number, name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(fullscreenTriangleGeometry(), material);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

/**
 * Minimal offscreen blitter. Owns one private scene/camera pair so that
 * rendering a pass never disturbs the game scene's traversal state.
 */
export class PassRunner {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly mesh: THREE.Mesh;
  private readonly placeholder = new THREE.MeshBasicMaterial();

  constructor() {
    this.mesh = new THREE.Mesh(fullscreenTriangleGeometry(), this.placeholder);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.scene.add(this.mesh);
    // No auto-update needed: nothing in this scene ever moves.
    this.scene.matrixWorldAutoUpdate = false;
  }

  render(renderer: THREE.WebGLRenderer, material: THREE.Material, target: THREE.WebGLRenderTarget | null): void {
    this.mesh.material = material;
    renderer.setRenderTarget(target);
    // The triangle covers every pixel, so clearing would be pure bandwidth.
    renderer.render(this.scene, this.camera);
    this.mesh.material = this.placeholder;
  }

  dispose(): void {
    this.placeholder.dispose();
  }
}

/** Standard options for the sky's intermediate HDR buffers. */
export function makeHdrTarget(w: number, h: number, count = 1): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    count,
  });
  for (const t of rt.textures) t.colorSpace = THREE.NoColorSpace;
  return rt;
}
