import * as THREE from 'three';
import { damageDecalAtlas, scarTexture, DECAL_COLS, DECAL_ROWS } from './textures';

/**
 * Two decal systems.
 *
 * 'BulletHoleField' punches battle damage onto aircraft skins. The decals are
 * stored in each aircraft's *local* space and re-composed against its world
 * matrix every frame, so a hole stays welded to the panel it was made in
 * through any manoeuvre — and because every hole in the match lives in one
 * 'InstancedMesh', all of them together cost a single draw call.
 *
 * 'GroundScarField' burns wreck scorches into the terrain. Those are static
 * once placed, so they are plain pooled meshes laid on the ground plane.
 */

const MAX_HOLES = 512;
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _up = new THREE.Vector3();
const _n = new THREE.Vector3();

interface Hole {
  /** Owning aircraft view id; -1 when free. */
  owner: number;
  /** Transform in the owner's local space. */
  local: THREE.Matrix4;
  /** Atlas cell. */
  cx: number; cy: number;
  bornAt: number;
  alpha: number;
}

export class BulletHoleField {
  readonly mesh: THREE.InstancedMesh;
  private holes: Hole[] = [];
  private aAtlas: THREE.InstancedBufferAttribute;
  private atlasArr: Float32Array;
  private capacity: number;
  /** Live world matrices are recomposed here each frame. */
  private matrices: THREE.Matrix4[] = [];

  constructor(capacity = MAX_HOLES) {
    this.capacity = capacity;
    const geo = new THREE.PlaneGeometry(1, 1);
    const tex = damageDecalAtlas();

    this.atlasArr = new Float32Array(capacity * 3);
    this.aAtlas = new THREE.InstancedBufferAttribute(this.atlasArr, 3);
    this.aAtlas.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iAtlas', this.aAtlas);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: tex },
        uCols: { value: DECAL_COLS },
        uRows: { value: DECAL_ROWS },
        uSunDir: { value: new THREE.Vector3(0.45, 0.62, 0.64) },
        uFadeFar: { value: 2600 },
      },
      vertexShader: /* glsl */`
        // NOTE: three declares instanceMatrix itself whenever USE_INSTANCING is
        // set on an InstancedMesh, so redeclaring it here is a GLSL compile
        // error ("redefinition"), not a harmless duplicate.
        attribute vec3 iAtlas;      // x = col, y = row, z = alpha

        uniform float uCols;
        uniform float uRows;
        uniform vec3  uSunDir;
        uniform float uFadeFar;

        varying vec2  vUv;
        varying float vAlpha;
        varying float vShade;

        void main() {
          vec2 cell = vec2( 1.0 / uCols, 1.0 / uRows );
          vUv = ( uv + vec2( iAtlas.x, iAtlas.y ) ) * cell;

          vec4 world = modelMatrix * instanceMatrix * vec4( position, 1.0 );
          // The decal quad's own +Z is the surface normal it was stamped onto.
          vec3 nrm = normalize( ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 1.0, 0.0 ) ).xyz );
          // A hole on a shaded panel must not glow: modulate by the same
          // sun term the cel material uses, flattened so it never vanishes.
          vShade = 0.45 + 0.55 * clamp( dot( nrm, uSunDir ) * 0.5 + 0.5, 0.0, 1.0 );

          vec4 view = viewMatrix * world;
          // Fade out at range — a cloud of black dots on a distant aircraft
          // reads as noise, not as damage.
          vAlpha = iAtlas.z * ( 1.0 - smoothstep( uFadeFar * 0.5, uFadeFar, -view.z ) );
          gl_Position = projectionMatrix * view;
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        varying vec2  vUv;
        varying float vAlpha;
        varying float vShade;
        void main() {
          vec4 t = texture2D( uMap, vUv );
          float a = t.a * vAlpha;
          if ( a < 0.01 ) discard;
          gl_FragColor = vec4( t.rgb * vShade, a );
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.name = 'bulletHoles';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.count = 0;
    for (let i = 0; i < capacity; i++) this.matrices.push(new THREE.Matrix4());
  }

  setSunDir(d: THREE.Vector3): void {
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uSunDir.value.copy(d).multiplyScalar(-1);
  }

  /**
   * Stamps a hole. 'worldPos'/'worldNormal' come from the hit event; 'owner'
   * supplies the aircraft transform the decal is frozen into.
   */
  add(
    owner: number, ownerMatrix: THREE.Matrix4,
    worldPos: THREE.Vector3, worldNormal: THREE.Vector3,
    calibre: number, time: number,
  ): void {
    // Oldest-first eviction, but never evict a hole younger than 4 s or a
    // sustained burst would erase its own start.
    let slot = -1;
    if (this.holes.length < this.capacity) {
      slot = this.holes.length;
      this.holes.push({ owner: -1, local: new THREE.Matrix4(), cx: 0, cy: 0, bornAt: 0, alpha: 0 });
    } else {
      let oldest = Infinity;
      for (let i = 0; i < this.holes.length; i++) {
        const h = this.holes[i];
        if (h.owner < 0) { slot = i; break; }
        if (h.bornAt < oldest) { oldest = h.bornAt; slot = i; }
      }
      if (slot < 0) return;
    }

    const h = this.holes[slot];
    h.owner = owner;
    h.bornAt = time;
    // Calibre picks the atlas column; the row is a variant so repeated hits on
    // the same panel do not tile visibly.
    h.cx = calibre >= 20 ? 2 : calibre >= 12 ? 1 : 0;
    h.cy = ((slot * 2654435761) >>> 0) % DECAL_ROWS;
    h.alpha = 0.95;

    _n.copy(worldNormal);
    if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0);
    _n.normalize();
    _up.set(0, 1, 0);
    if (Math.abs(_n.y) > 0.95) _up.set(1, 0, 0);
    _m4.lookAt(_v.set(0, 0, 0), _n, _up);
    _q.setFromRotationMatrix(_m4);
    // Random roll so a burst does not produce a row of identically oriented holes.
    _q.multiply(_tmpQ.setFromAxisAngle(_zAxis, Math.random() * Math.PI * 2));

    const size = calibre >= 20 ? 0.75 : calibre >= 12 ? 0.5 : 0.34;
    // Lift the quad off the skin along the normal; polygon offset alone is not
    // enough on a curved surface at long range.
    _v.copy(worldPos).addScaledVector(_n, 0.035);
    _m4.compose(_v, _q, _scale.setScalar(size));

    h.local.copy(ownerMatrix).invert().multiply(_m4);
  }

  /** Drops every decal belonging to 'owner' (aircraft despawned or recycled). */
  releaseOwner(owner: number): void {
    for (const h of this.holes) if (h.owner === owner) h.owner = -1;
  }

  /**
   * Re-composes live decals against their owners' current world matrices.
   * 'resolve' returns the owner transform, or null if that aircraft is gone or
   * currently culled.
   */
  update(resolve: (owner: number) => THREE.Matrix4 | null, time: number): void {
    let n = 0;
    for (const h of this.holes) {
      if (h.owner < 0) continue;
      const owner = resolve(h.owner);
      if (!owner) continue;
      if (n >= this.capacity) break;
      // Fresh holes flash bright for a moment: hot metal and burnt paint.
      const age = time - h.bornAt;
      const a = h.alpha * (age < 0.25 ? 0.6 + 1.6 * (0.25 - age) : 1);
      this.matrices[n].multiplyMatrices(owner, h.local);
      this.mesh.setMatrixAt(n, this.matrices[n]);
      const i3 = n * 3;
      this.atlasArr[i3] = h.cx; this.atlasArr[i3 + 1] = h.cy; this.atlasArr[i3 + 2] = Math.min(1, a);
      n++;
    }
    this.mesh.count = n;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.aAtlas.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

const _tmpQ = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _scale = new THREE.Vector3(1, 1, 1);

// ---------------------------------------------------------------------------

interface Scar { mesh: THREE.Mesh; bornAt: number; live: boolean }

/**
 * Scorch marks left where a wreck burns out. Pooled and long-lived: a battle
 * should leave a readable history on the ground, so they persist for minutes
 * and only fade when the pool wraps.
 */
export class GroundScarField {
  readonly group = new THREE.Group();
  private pool: Scar[] = [];
  private next = 0;

  constructor(capacity = 24) {
    this.group.name = 'groundScars';
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const tex = scarTexture();
    for (let i = 0; i < capacity; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false, opacity: 0,
        polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.renderOrder = 2;
      m.frustumCulled = true;
      this.group.add(m);
      this.pool.push({ mesh: m, bornAt: 0, live: false });
    }
  }

  add(x: number, y: number, z: number, normal: THREE.Vector3, radius: number, time: number): void {
    const s = this.pool[this.next];
    this.next = (this.next + 1) % this.pool.length;
    s.live = true;
    s.bornAt = time;
    s.mesh.visible = true;
    s.mesh.position.set(x, y + 0.12, z);
    s.mesh.scale.set(radius * 2, 1, radius * 2);
    // Lay the quad into the slope so it does not float on a hillside.
    _n.copy(normal).normalize();
    s.mesh.quaternion.setFromUnitVectors(_upY, _n);
    s.mesh.rotateY(Math.random() * Math.PI * 2);
  }

  update(time: number): void {
    for (const s of this.pool) {
      if (!s.live) continue;
      const age = time - s.bornAt;
      const mat = s.mesh.material as THREE.MeshBasicMaterial;
      // Scorch darkens over the first second, then holds, then weathers away.
      mat.opacity = Math.min(1, age * 2.4) * (1 - Math.max(0, (age - 150) / 60));
      if (mat.opacity <= 0.01) { s.live = false; s.mesh.visible = false; }
    }
  }

  dispose(): void {
    for (const s of this.pool) (s.mesh.material as THREE.Material).dispose();
    this.pool[0]?.mesh.geometry.dispose();
  }
}

const _upY = new THREE.Vector3(0, 1, 0);
