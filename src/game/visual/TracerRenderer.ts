import * as THREE from 'three';
import { EntityKind, type EntityState } from '../../shared/protocol';
import { LAYER_BLOOM } from '../../render/CelMaterial';

/**
 * Every tracer in the sky in one draw call.
 *
 * A tracer is not a dot. At 850 m/s a round covers 14 m in a single 16 ms
 * frame, and both the eye and a camera integrate that into a streak — drawing
 * a point sprite is the single most common reason browser air-combat games look
 * cheap. So each round is an instanced quad stretched along its own velocity,
 * with the head at the true position and a tail trailing behind it.
 *
 * The quad is built in *view space*: the streak axis is projected onto the
 * screen plane and the quad extruded along it. That gives correct foreshortening
 * for free (a round coming straight at you collapses to a dot, exactly as it
 * should) and guarantees the billboard is perfectly camera-facing, so it never
 * skews or clips into the geometry it passes.
 *
 * Optics of the fragment: a very tight near-white core, a wide warm halo around
 * it (the eye's own glare plus the incandescent gas sheath), and a short
 * exponential trail behind the head. Three terms, all additive.
 */

const MAX_TRACERS = 1536;

/** Per-calibre presentation. Keyed by the projectile's wire 'typeId', which the
 *  server sets to 'round(calibre)' clamped to 4 bits. */
interface Calibre {
  color: THREE.Color;
  width: number;      // metres
  lenScale: number;   // metres of streak per m/s of speed
  intensity: number;
  /** Fraction of rounds that are loaded as tracers in a typical belt. */
  tracerRatio: number;
}

const CALIBRES: Calibre[] = [];
{
  const def = (id: number, hex: number, width: number, lenScale: number, intensity: number, ratio: number) => {
    CALIBRES[id] = { color: new THREE.Color(hex), width, lenScale, intensity, tracerRatio: ratio };
  };
  // Rifle-calibre: thin, pale, very fast, one tracer in five.
  for (let i = 0; i <= 9; i++) def(i, 0xfff0a8, 0.10, 0.016, 0.85, 0.20);
  // Heavy machine guns (12.7 / 13 mm): warmer and fatter.
  def(10, 0xffc470, 0.15, 0.019, 1.05, 0.25);
  def(11, 0xffc470, 0.15, 0.019, 1.05, 0.25);
  def(12, 0xff9d4d, 0.17, 0.020, 1.15, 0.25);
  def(13, 0xffb45a, 0.17, 0.020, 1.15, 0.25);
  def(14, 0xffcf5c, 0.20, 0.022, 1.30, 0.33);
  // 20 mm and up: fat golden bolts, one in three.
  def(15, 0xffd36b, 0.24, 0.023, 1.45, 0.33);
}
const DEFAULT_CALIBRE = CALIBRES[15];

export class TracerRenderer {
  /** Plain 'Mesh' over an 'InstancedBufferGeometry': the renderer then takes
   *  its instance count from 'geometry.instanceCount', and we avoid carrying an
   *  unused per-instance matrix that the shader never reads. */
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;

  private aPos: THREE.InstancedBufferAttribute;
  private aVel: THREE.InstancedBufferAttribute;
  private aColor: THREE.InstancedBufferAttribute;
  private aParams: THREE.InstancedBufferAttribute;

  private posArr: Float32Array;
  private velArr: Float32Array;
  private colArr: Float32Array;
  private parArr: Float32Array;

  private count = 0;
  private capacity = MAX_TRACERS;

  constructor(quality: number) {
    this.capacity = Math.max(256, Math.round(MAX_TRACERS * quality));

    // Unit quad in the XY plane; the vertex shader treats x as across the
    // streak and y as along it (y = +0.5 is the head).
    const base = new THREE.PlaneGeometry(1, 1, 1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = base.index;
    this.geo.attributes.position = base.attributes.position;
    this.geo.attributes.uv = base.attributes.uv;
    base.dispose();

    this.posArr = new Float32Array(this.capacity * 3);
    this.velArr = new Float32Array(this.capacity * 3);
    this.colArr = new Float32Array(this.capacity * 3);
    this.parArr = new Float32Array(this.capacity * 4);

    this.aPos = new THREE.InstancedBufferAttribute(this.posArr, 3);
    this.aVel = new THREE.InstancedBufferAttribute(this.velArr, 3);
    this.aColor = new THREE.InstancedBufferAttribute(this.colArr, 3);
    this.aParams = new THREE.InstancedBufferAttribute(this.parArr, 4);
    for (const a of [this.aPos, this.aVel, this.aColor, this.aParams]) a.setUsage(THREE.DynamicDrawUsage);

    this.geo.setAttribute('iPos', this.aPos);
    this.geo.setAttribute('iVel', this.aVel);
    this.geo.setAttribute('iColor', this.aColor);
    this.geo.setAttribute('iParams', this.aParams);
    this.geo.instanceCount = 0;

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        // Screen-space floor on streak width, in radians of FOV. Without it a
        // distant tracer thins below one pixel and starts to strobe.
        uMinAngular: { value: 0.0016 },
        uGlow: { value: 1.0 },
      },
      vertexShader: /* glsl */`
        attribute vec3 iPos;
        attribute vec3 iVel;
        attribute vec3 iColor;
        attribute vec4 iParams;   // x = width, y = length, z = intensity, w = seed

        uniform float uMinAngular;

        varying vec3  vColor;
        varying vec2  vLocal;     // x across [-1,1], y along [0,1] with 1 = head
        varying float vIntensity;
        varying float vSquash;    // 1 = fully side-on, 0 = head-on

        void main() {
          vec4 view = modelViewMatrix * vec4( iPos, 1.0 );
          vec3 vAxis = ( modelViewMatrix * vec4( iVel, 0.0 ) ).xyz;

          float axisLen = length( vAxis );
          vec2 dir = axisLen > 1e-5 ? vAxis.xy : vec2( 0.0, 1.0 );
          float planar = length( dir );
          // Foreshortening: only the on-screen component of the velocity
          // stretches the streak. Head-on rounds collapse to a bright dot.
          vSquash = axisLen > 1e-5 ? planar / axisLen : 0.0;
          dir = planar > 1e-5 ? dir / planar : vec2( 0.0, 1.0 );
          vec2 perp = vec2( -dir.y, dir.x );

          float dist = max( 0.05, -view.z );
          // Widen to a one-pixel-ish minimum at long range.
          float width = max( iParams.x, uMinAngular * dist );
          float len = iParams.y * vSquash;

          float along = position.y + 0.5;          // 0 = tail, 1 = head
          view.xy += dir * ( ( along - 1.0 ) * len ) + perp * ( position.x * width );

          vLocal = vec2( position.x * 2.0, along );
          vColor = iColor;
          vIntensity = iParams.z;
          gl_Position = projectionMatrix * view;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform float uGlow;
        varying vec3  vColor;
        varying vec2  vLocal;
        varying float vIntensity;
        varying float vSquash;

        void main() {
          float u = vLocal.x;
          float t = vLocal.y;
          float u2 = u * u;

          // Three optical terms. Exponentials rather than smoothsteps because
          // a real glare falls off multiplicatively and never reaches a hard
          // edge — a smoothstep edge is visible as a quad boundary at night.
          float core  = exp( -u2 * 26.0 ) * pow( t, 4.0 );
          float halo  = exp( -u2 *  3.0 ) * pow( t, 1.4 ) * 0.42;
          float trail = exp( -u2 * 10.0 ) * t * t * 0.30;

          // A head-on round has no streak to fade along, so restore its head.
          core += exp( -u2 * 26.0 ) * ( 1.0 - vSquash ) * 0.8;

          float a = ( core + halo + trail ) * vIntensity * uGlow;
          if ( a < 0.004 ) discard;

          vec3 hot = mix( vColor, vec3( 1.0 ), 0.88 );
          vec3 col = hot * core + vColor * ( halo + trail ) * 1.25;
          gl_FragColor = vec4( col, clamp( a, 0.0, 1.0 ) );
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      fog: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'tracers';
    this.mesh.frustumCulled = false;      // one draw call; culling it is pointless
    this.mesh.renderOrder = 12;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.layers.enable(LAYER_BLOOM);
  }

  setQuality(q: number): void {
    this.mat.uniforms.uGlow.value = 0.85 + q * 0.3;
  }

  begin(): void { this.count = 0; }

  /**
   * Adds one round. 'id' selects a deterministic belt position so the same
   * round is a tracer on every client and across reconnects.
   */
  push(e: EntityState): void {
    if (this.count >= this.capacity) return;
    const cal = CALIBRES[e.typeId & 15] ?? DEFAULT_CALIBRE;

    const speed = Math.hypot(e.vx, e.vy, e.vz);
    if (speed < 1) return;

    // Belt composition: most rounds are plain ball and show almost nothing.
    // Rendering only the tracers would make the stream too sparse to read, so
    // ball rounds get a dim, short streak — which is what a gun camera sees.
    const isTracer = ((e.id * 2654435761) >>> 0) / 4294967296 < cal.tracerRatio;
    const intensity = isTracer ? cal.intensity : cal.intensity * 0.16;
    const width = isTracer ? cal.width : cal.width * 0.55;
    const len = Math.min(34, Math.max(2.5, speed * cal.lenScale * (isTracer ? 1 : 0.55)));

    const i = this.count++;
    const i3 = i * 3, i4 = i * 4;
    this.posArr[i3] = e.px; this.posArr[i3 + 1] = e.py; this.posArr[i3 + 2] = e.pz;
    // Normalised: the shader needs the direction, and the magnitude is already
    // baked into 'len'.
    const inv = 1 / speed;
    this.velArr[i3] = e.vx * inv; this.velArr[i3 + 1] = e.vy * inv; this.velArr[i3 + 2] = e.vz * inv;
    this.colArr[i3] = cal.color.r; this.colArr[i3 + 1] = cal.color.g; this.colArr[i3 + 2] = cal.color.b;
    this.parArr[i4] = width;
    this.parArr[i4 + 1] = len;
    this.parArr[i4 + 2] = intensity;
    this.parArr[i4 + 3] = i;
  }

  /** Convenience: sweep the whole entity map. */
  collect(entities: Map<number, EntityState>): void {
    this.begin();
    for (const e of entities.values()) {
      if (e.kind === EntityKind.Projectile) this.push(e);
    }
    this.end();
  }

  end(): void {
    this.geo.instanceCount = this.count;
    if (this.count === 0) return;
    this.aPos.needsUpdate = true;
    this.aVel.needsUpdate = true;
    this.aColor.needsUpdate = true;
    this.aParams.needsUpdate = true;
  }

  get active(): number { return this.count; }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
