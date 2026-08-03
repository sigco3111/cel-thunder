import * as THREE from 'three';
import { GLSL_COMMON, disposeRT, makeRT } from './PassCore';

/**
 * Depth / normal / velocity prepass.
 *
 * Renders every opaque object a second time into a two-attachment MRT target:
 *
 *   attachment 0 (RGBA16F)  rg = octahedral view-space normal
 *                           b  = view distance / camera.far   (0..1)
 *                           a  = per-object id, quantised to 1/255, offset by
 *                                +0.5 for LAYER_INK (hero) objects
 *   attachment 1 (RGBA16F)  rg = screen-space motion vector in UV units
 *                                (this frame's position minus last frame's)
 *
 * Why not read the hardware depth buffer instead: with a 0.35 m near plane and
 * a 120 km far plane, a 24-bit non-linear depth buffer resolves roughly 4 m at
 * 5 km — and reconstructing linear depth from it costs a divide per tap. A
 * half-float *linear* distance has constant ~0.05% relative precision at every
 * range (2.4 m at 5 km, 15 cm at 300 m), is one multiply to use, and stays
 * stable if the far plane is ever changed.
 *
 * The normal written here is the interpolated *vertex* normal, deliberately not
 * the normal-mapped one. Panel lines and rivets are normal-map detail; feeding
 * them to the edge detector turns every aircraft into a scribble that boils
 * under motion. Geometry creases are what the ink pass is looking for.
 *
 * ---------------------------------------------------------------------------
 * Why this pass does NOT use 'scene.overrideMaterial'
 * ---------------------------------------------------------------------------
 * An override material replaces the *whole* program, vertex stage included. Any
 * mesh whose shape only exists inside its own vertex shader therefore collapses:
 * the CDLOD terrain (position is a unit grid displaced from a heightfield
 * texture, per-instance node origin in an attribute) drew as a pile of 1x1 m
 * quads at the world origin, the Gerstner ocean drew as a flat disc, and the
 * billboarded tree cards drew as unrotated quads at the mesh origin. The
 * gbuffer was therefore empty over most of the frame — no coastline ink, no
 * terrain silhouettes, no contact AO, far-plane depth feeding DOF and motion
 * blur across the entire landscape.
 *
 * So instead of one override material, each drawn mesh is temporarily swapped
 * to a prepass material *derived from its own*:
 *
 *   - a mesh (or its material) can name one explicitly in
 *     'userData.prepassMaterial' — the opt-in hook for anything exotic;
 *   - otherwise, if the source material customises its program through
 *     'onBeforeCompile', that same patch is replayed onto this pass's shader.
 *     Every vertex-displacing material in the project (terrain, water,
 *     vegetation cards) patches the standard '<common>' / '<beginnormal_vertex>'
 *     / '<begin_vertex>' chunk seams, which this pass's vertex program also
 *     includes, so the displacement comes across verbatim while the fragment
 *     stage stays ours (its fragment replacements simply find no match here);
 *   - alpha-tested materials get a variant that samples the same map and
 *     discards, so foliage is a real silhouette in the gbuffer rather than a
 *     solid card or a hole;
 *   - everything else uses one shared material per face side.
 *
 * Materials are derived once and cached, so the steady-state cost is one
 * WeakMap lookup and one field assignment per drawn object.
 */

/** Per-object velocity history. Latched on the CPU for every candidate object
 *  (see render()), not inside a draw call, so frustum-culled objects keep a
 *  current history and do not smear on the frame they re-enter view. */
interface VelocityRecord {
  /** Matrix the current frame reprojects through. */
  prev: THREE.Matrix4;
  /** Matrix latched this frame; becomes 'prev' next frame. */
  cur: THREE.Matrix4;
  /** Sweep frame this record was last touched. */
  frame: number;
}

type MeshLike = THREE.Object3D & {
  isMesh?: boolean;
  isPoints?: boolean;
  isLine?: boolean;
  isSprite?: boolean;
  material?: THREE.Material | THREE.Material[];
};

/** Materials three itself installs; anything else is a custom program patch. */
const DEFAULT_ON_BEFORE_COMPILE = THREE.Material.prototype.onBeforeCompile;

/** Bit of LAYER_INK (CelMaterial), the layer hero objects are tagged with. */
const INK_LAYER_BIT = 1 << 1;

export class DepthNormalPass {
  target: THREE.WebGLRenderTarget;

  /** Frame constants, shared by reference with every prepass material. */
  private readonly uPrevViewProj: THREE.IUniform<THREE.Matrix4> = { value: new THREE.Matrix4() };
  private readonly uInvFar: THREE.IUniform<number> = { value: 1 / 120000 };

  /** One plain material per face side (FrontSide / BackSide / DoubleSide). */
  private readonly bySide = new Map<THREE.Side, THREE.ShaderMaterial>();
  /** Derived variants, keyed by the material they were derived from. */
  private readonly derived = new WeakMap<THREE.Material, THREE.ShaderMaterial>();
  /** Externally supplied prepass materials this pass has hooked. */
  private readonly adopted = new WeakSet<THREE.ShaderMaterial>();
  /** Everything created here, for dispose(). */
  private readonly owned: THREE.ShaderMaterial[] = [];

  private readonly velocity_ = new WeakMap<THREE.Object3D, VelocityRecord>();
  private frameId = 0;

  /** Objects temporarily hidden for this pass; restored immediately after. */
  private hidden: THREE.Object3D[] = [];
  /** Objects whose material was swapped; restored immediately after. */
  private swapped: THREE.Object3D[] = [];
  private swappedMaterials: (THREE.Material | THREE.Material[])[] = [];

  private readonly clearColor = new THREE.Color(0, 0, 1);

  constructor(width: number, height: number) {
    this.target = makeRT(width, height, {
      count: 2,
      depth: true,
      filter: THREE.NearestFilter,
      name: 'gbuffer',
    });

    // Expose the hardware depth buffer as a texture as well as the packed
    // linear depth. The composer itself only ever uses the linear channel, but
    // forward-rendered effects that run *inside* the main scene pass — soft
    // particles, contact-faded decals — need standard non-linear device depth
    // so they can use three's own perspectiveDepthToViewZ. The prepass draws
    // the same opaque geometry with the same camera, so its depth buffer is
    // bit-identical to the scene pass's and can be sampled while the scene is
    // still being drawn without a feedback loop.
    // DEPTH24_STENCIL8 specifically, not DEPTH_COMPONENT24: ANGLE rejects a
    // plain depth texture read through a float sampler2D with
    // "mismatch between texture format and sampler type", which is exactly how
    // a forward pass wants to sample it. The packed depth-stencil format reads
    // back cleanly and costs the same memory.
    const depthTex = new THREE.DepthTexture(width, height);
    depthTex.format = THREE.DepthStencilFormat;
    depthTex.type = THREE.UnsignedInt248Type;
    depthTex.minFilter = THREE.NearestFilter;
    depthTex.magFilter = THREE.NearestFilter;
    depthTex.name = 'gbuffer-depth';
    this.target.depthTexture = depthTex;
  }

  setSize(width: number, height: number): void {
    this.target.setSize(Math.max(1, width), Math.max(1, height));
  }

  /** Normal + depth attachment. */
  get gbuffer(): THREE.Texture { return this.target.textures[0]; }
  /** Screen-space velocity attachment. */
  get velocity(): THREE.Texture { return this.target.textures[1]; }
  /** Hardware (non-linear) device depth, for forward effects. */
  get depthTexture(): THREE.DepthTexture | null { return this.target.depthTexture; }

  // -------------------------------------------------------------------------
  // Material factory
  // -------------------------------------------------------------------------

  private createMaterial(
    side: THREE.Side,
    source: THREE.Material | null,
    alphaMap: THREE.Texture | null,
    alphaCutoff: number,
  ): THREE.ShaderMaterial {
    const uniforms: Record<string, THREE.IUniform> = {
      // Per-draw; written by applyPerObject just before the draw is issued.
      uPrevModelMatrix: { value: new THREE.Matrix4() },
      uInkId: { value: 0 },
      // Per-frame; shared by reference across every prepass material so one
      // write per frame updates all of them.
      uPrevViewProj: this.uPrevViewProj,
      uInvFar: this.uInvFar,
    };
    const defines: Record<string, string | number> = {};
    if (alphaMap) {
      uniforms.tPrepassAlpha = { value: alphaMap };
      uniforms.uAlphaCutoff = { value: alphaCutoff };
      defines.PREPASS_ALPHATEST = 1;
    }

    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms,
      defines,
      vertexShader: PREPASS_VERT,
      fragmentShader: PREPASS_FRAG,
      side,
      blending: THREE.NoBlending,
      fog: false,
      lights: false,
    });
    mat.name = source ? `prepass:${source.name || source.type}` : 'prepass';

    if (source !== null && DepthNormalPass.patchAffectsVertex(source)) {
      // Replay the source material's program patch onto our shader. Its vertex
      // replacements land (same chunk seams); its fragment replacements find no
      // match and drop out; its uniforms are merged into ours by reference, so
      // they keep tracking whatever the owning subsystem writes each frame.
      const patch = source.onBeforeCompile;
      mat.onBeforeCompile = (shader, renderer) => {
        patch.call(source, shader, renderer);
      };
      // Two materials patched by different closures must not share a compiled
      // program. The default cache key is onBeforeCompile.toString(), which for
      // the wrapper above is identical for every derived material — hence an
      // explicit key built from the source's own.
      const srcKey = source.customProgramCacheKey ? source.customProgramCacheKey() : source.uuid;
      mat.customProgramCacheKey = () => `prepass|${srcKey}|${alphaMap ? 'at' : 'op'}`;
    }

    mat.onBeforeRender = (
      _renderer: THREE.WebGLRenderer,
      _scene: THREE.Scene,
      _camera: THREE.Camera,
      _geometry: THREE.BufferGeometry,
      object: THREE.Object3D,
    ) => { this.applyPerObject(mat, object); };

    this.owned.push(mat);
    return mat;
  }

  /**
   * Per-object uniforms. 'onBeforeRender' fires once per draw call, before the
   * uniforms are uploaded, which is the only hook that lets one material carry
   * per-object data.
   */
  private applyPerObject(mat: THREE.ShaderMaterial, object: THREE.Object3D): void {
    const rec = this.velocity_.get(object);
    const u = mat.uniforms;
    if (u.uPrevModelMatrix) {
      (u.uPrevModelMatrix.value as THREE.Matrix4).copy(rec ? rec.prev : object.matrixWorld);
    }
    // Object id gives the ink pass a silhouette cue between two surfaces that
    // happen to share depth and normal (two aircraft overlapping mid-turn).
    //
    // The top half of the range is reserved for LAYER_INK — the hero objects
    // the codebase already tags (every aircraft mesh does). The ink pass reads
    // that one bit to give aircraft a heavier, longer-lived outline than the
    // terrain and vegetation behind them, which is the whole point of having
    // the layer. Ids stay at least 1/255 apart within each half, which a
    // half-float resolves comfortably at 0.5.
    if (u.uInkId) {
      const hero = (object.layers.mask & INK_LAYER_BIT) !== 0;
      u.uInkId.value = ((object.id * 61) % 127) / 255 + (hero ? 0.5 : 0);
    }
    mat.uniformsNeedUpdate = true;
  }

  private baseFor(side: THREE.Side): THREE.ShaderMaterial {
    let m = this.bySide.get(side);
    if (m === undefined) {
      m = this.createMaterial(side, null, null, 0);
      this.bySide.set(side, m);
    }
    return m;
  }

  /**
   * Takes over a prepass material this pass did not create.
   *
   * A mesh whose shape only exists in its own vertex program can publish a
   * ready-made gbuffer material through 'userData.prepassMaterial' (the terrain
   * and the ocean both do). It owns the shader; this pass owns the four
   * uniforms that describe the frame and the draw, so they are filled in here
   * by the same hook the built-in materials use.
   */
  private adopt(mat: THREE.ShaderMaterial): THREE.ShaderMaterial {
    if (this.adopted.has(mat)) return mat;
    this.adopted.add(mat);
    mat.onBeforeRender = (
      _renderer: THREE.WebGLRenderer,
      _scene: THREE.Scene,
      _camera: THREE.Camera,
      _geometry: THREE.BufferGeometry,
      object: THREE.Object3D,
    ) => {
      const u = mat.uniforms;
      if (u.uPrevViewProj) (u.uPrevViewProj.value as THREE.Matrix4).copy(this.uPrevViewProj.value);
      if (u.uInvFar) u.uInvFar.value = this.uInvFar.value;
      this.applyPerObject(mat, object);
    };
    return mat;
  }

  /**
   * The prepass material for one source material.
   *
   * Resolved once per source material and cached — including the negative
   * answer, because deciding it involves dry-running the material's program
   * patch, which must not happen once per object per frame.
   */
  private materialFor(src: THREE.Material): THREE.ShaderMaterial {
    const cached = this.derived.get(src);
    if (cached !== undefined) return cached;

    const anyMat = src as THREE.Material & { map?: THREE.Texture | null };
    const alphaMap = src.alphaTest > 0 ? (anyMat.map ?? null) : null;
    const patched = DepthNormalPass.patchAffectsVertex(src);

    // The common case — an ordinary opaque material with the stock vertex
    // program — needs no variant of its own.
    const mat = (!patched && alphaMap === null)
      ? this.baseFor(src.side)
      : this.createMaterial(src.side, src, alphaMap, src.alphaTest);
    this.derived.set(src, mat);
    return mat;
  }

  /**
   * Does replaying this material's program patch actually change our vertex
   * program?
   *
   * Most 'onBeforeCompile' hooks in the project are fragment-only (the
   * roughness-attenuated specular on aircraft paint, for instance). Deriving a
   * variant for those would cost a material and a shader program per source
   * material and buy nothing, so the patch is dry-run against a throwaway
   * shader object first. Every patch here is a pure string rewrite plus a
   * uniform merge, so running it twice is free of side effects — and if one
   * ever throws, treating it as fragment-only is the safe answer, because the
   * same call would have thrown inside the real compile.
   */
  private static patchAffectsVertex(src: THREE.Material): boolean {
    if (src.onBeforeCompile === DEFAULT_ON_BEFORE_COMPILE) return false;
    const probe = {
      vertexShader: PREPASS_VERT,
      fragmentShader: PREPASS_FRAG,
      uniforms: {} as Record<string, THREE.IUniform>,
      defines: {} as Record<string, unknown>,
    };
    try {
      (src.onBeforeCompile as unknown as (s: typeof probe) => void).call(src, probe);
    } catch {
      return false;
    }
    return probe.vertexShader !== PREPASS_VERT;
  }

  /**
   * Decides whether a material may appear in the gbuffer at all.
   *
   * Alpha-tested geometry belongs here (it becomes a real silhouette through
   * the discard variant). Genuinely translucent surfaces do not: they would
   * punch their whole quad into depth. The exception is a transparent material
   * that is really an opaque *surface* drawn late — the ocean is the one in
   * this project — which opts in through 'userData.forcePrepass'.
   */
  private static includes(m: THREE.Material): boolean {
    if (m.userData.noPrepass === true) return false;
    if (m.userData.forcePrepass === true) return true;
    if (m.transparent !== true) return true;
    return false;
  }

  /**
   * @param layerMask  Camera layer mask restricting the pass to opaque, inkable
   *                   geometry (sky domes, tracers and other bloom-only props
   *                   are excluded by living on their own layers).
   */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    prevViewProj: THREE.Matrix4,
    layerMask: number,
  ): void {
    this.frameId++;

    this.uPrevViewProj.value.copy(prevViewProj);
    this.uInvFar.value = 1 / camera.far;

    // World matrices must be current *before* the sweep, or the velocity latch
    // reads last frame's transform as this frame's. renderer.render() would do
    // this itself a moment later; doing it early is idempotent and cheap
    // (the dirty flags are already cleared the second time round).
    scene.updateMatrixWorld();

    // --- decide, per object, what this pass draws --------------------------
    const hidden = this.hidden;
    const swapped = this.swapped;
    const swappedMaterials = this.swappedMaterials;
    hidden.length = 0;
    swapped.length = 0;
    swappedMaterials.length = 0;

    scene.traverseVisible((o) => {
      const any = o as MeshLike;
      if (any.isMesh !== true) {
        // Points, sprites and lines have no meaningful surface normal, and a
        // sprite would write a camera-facing quad over whatever is behind it.
        if (any.isPoints === true || any.isSprite === true || any.isLine === true) {
          if (o.visible) { o.visible = false; hidden.push(o); }
        }
        return;
      }
      const src = any.material;
      let replacement: THREE.ShaderMaterial | null = null;
      const forced = o.userData.forcePrepass === true;

      // An explicitly published gbuffer material wins over everything else,
      // including 'noPrepass' — a mesh that supplies one sets that flag too, so
      // that a prepass which does not honour the hook skips it rather than
      // stamping a collapsed version of it at the world origin.
      const explicit = (o.userData.prepassMaterial
        ?? (Array.isArray(src) ? undefined : src?.userData.prepassMaterial)) as
        THREE.ShaderMaterial | undefined;

      if (explicit) {
        replacement = this.adopt(explicit);
      } else if (o.userData.noPrepass === true) {
        replacement = null;
      } else if (Array.isArray(src)) {
        // Multi-material meshes: all groups share one prepass material, so a
        // single translucent group disqualifies the whole mesh (it would be the
        // one group we could not honour).
        const usable = src.length > 0 && src.every((m) => forced || DepthNormalPass.includes(m));
        replacement = usable ? this.materialFor(src[0]) : null;
      } else if (src) {
        replacement = (forced || DepthNormalPass.includes(src)) ? this.materialFor(src) : null;
      }

      if (replacement === null) {
        o.visible = false; hidden.push(o);
        return;
      }

      // --- velocity history, latched for every candidate ------------------
      let rec = this.velocity_.get(o);
      if (rec === undefined) {
        rec = { prev: o.matrixWorld.clone(), cur: o.matrixWorld.clone(), frame: this.frameId };
        this.velocity_.set(o, rec);
      } else {
        // An object that was not swept last frame — just spawned, or hidden
        // for a while — has no usable history. Reprojecting through a matrix
        // several frames old is what makes an aircraft re-entering frame smear
        // across a quarter of the screen on its first visible frame.
        if (rec.frame !== this.frameId - 1) rec.cur.copy(o.matrixWorld);
        rec.prev.copy(rec.cur);
        rec.cur.copy(o.matrixWorld);
        rec.frame = this.frameId;
      }

      swapped.push(o);
      swappedMaterials.push(src as THREE.Material | THREE.Material[]);
      (o as THREE.Mesh).material = replacement;
    });

    const prevBackground = scene.background;
    const prevMask = camera.layers.mask;
    const prevClearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(_prevClear);

    // A Scene.background of type Color force-clears inside render(); drop it so
    // our own clear value survives.
    scene.background = null;
    camera.layers.mask = layerMask;

    // Clear to (0,0,1,1): depth = far, velocity = 0. Both 0 and 1 are fixed
    // points of every colour transfer function, so no colour management can
    // corrupt the clear value.
    //
    // The alpha *must* be 1: the renderer is premultiplied-alpha, so
    // WebGLState.setClear multiplies the clear RGB by the clear alpha, and a
    // clear alpha of 0 would silently zero the depth channel — which reads
    // downstream as "the sky is 0 m away" and puts the entire frame into
    // maximum near-field defocus.
    try {
      renderer.setRenderTarget(this.target);
      renderer.setClearColor(this.clearColor, 1);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
    } finally {
      renderer.setClearColor(_prevClear, prevClearAlpha);
      camera.layers.mask = prevMask;
      scene.background = prevBackground;
      for (let i = 0; i < swapped.length; i++) {
        (swapped[i] as THREE.Mesh).material = swappedMaterials[i];
      }
      for (const o of hidden) o.visible = true;
      hidden.length = 0;
      swapped.length = 0;
      swappedMaterials.length = 0;
    }
  }

  dispose(): void {
    disposeRT(this.target);
    for (const m of this.owned) m.dispose();
    this.owned.length = 0;
    this.bySide.clear();
  }
}

const _prevClear = new THREE.Color();

const PREPASS_VERT = /* glsl */`
  #include <common>
  #include <batching_pars_vertex>
  #include <morphtarget_pars_vertex>
  #include <skinning_pars_vertex>

  uniform mat4 uPrevModelMatrix;
  uniform mat4 uPrevViewProj;

  varying vec3  vViewNormal;
  varying float vViewZ;
  varying vec4  vCurClip;
  varying vec4  vPrevClip;

  #ifdef PREPASS_ALPHATEST
    varying vec2 vPrepassUv;
  #endif

  void main() {
    #include <batching_vertex>
    #include <beginnormal_vertex>
    #include <morphinstance_vertex>
    #include <morphnormal_vertex>
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    #include <defaultnormal_vertex>
    #include <begin_vertex>
    #include <morphtarget_vertex>
    #include <skinning_vertex>
    #include <project_vertex>

    vViewNormal = transformedNormal;
    vViewZ      = -mvPosition.z;
    vCurClip    = gl_Position;

    #ifdef PREPASS_ALPHATEST
      vPrepassUv = uv;
    #endif

    // Reproject through last frame's transform. The *current* instance /
    // batching matrix is intentionally reused: per-instance motion is not
    // tracked, so instanced props read as rigid with their parent, which
    // is correct for the static scatter they are used for.
    vec4 prevObject = vec4( transformed, 1.0 );
    #ifdef USE_BATCHING
      prevObject = batchingMatrix * prevObject;
    #endif
    #ifdef USE_INSTANCING
      prevObject = instanceMatrix * prevObject;
    #endif
    vPrevClip = uPrevViewProj * uPrevModelMatrix * prevObject;
  }
`;

const PREPASS_FRAG = /* glsl */`
  precision highp float;

  ${GLSL_COMMON}

  uniform float uInvFar;
  uniform float uInkId;

  varying vec3  vViewNormal;
  varying float vViewZ;
  varying vec4  vCurClip;
  varying vec4  vPrevClip;

  #ifdef PREPASS_ALPHATEST
    uniform sampler2D tPrepassAlpha;
    uniform float uAlphaCutoff;
    varying vec2 vPrepassUv;
  #endif

  layout(location = 0) out vec4 gNormalDepth;
  layout(location = 1) out vec4 gVelocity;

  void main() {
    #ifdef PREPASS_ALPHATEST
      // Foliage and other cut-out geometry: the same test the forward material
      // does, so the silhouette in the gbuffer is the silhouette on screen.
      if ( texture( tPrepassAlpha, vPrepassUv ).a < uAlphaCutoff ) discard;
    #endif

    vec3 n = normalize( vViewNormal );
    // Single-sided-authored geometry (open cockpits, foliage cards, terrain
    // skirts) is drawn with whatever side its own material asks for; flip the
    // normal on back faces so it still points at the viewer.
    if ( !gl_FrontFacing ) n = -n;

    gNormalDepth = vec4( octEncode( n ), clamp( vViewZ * uInvFar, 0.0, 1.0 ), uInkId );

    vec2 cur  = vCurClip.xy  / max( vCurClip.w,  1e-6 );
    vec2 prev = vPrevClip.xy / max( vPrevClip.w, 1e-6 );
    // NDC delta halved converts to UV units.
    gVelocity = vec4( ( cur - prev ) * 0.5, 0.0, 1.0 );
  }
`;
