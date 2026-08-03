import * as THREE from 'three';
import { smokeSprite, fireSprite } from './textures';
import { LAYER_BLOOM } from '../../render/CelMaterial';

/**
 * Pooled billboard particles for battle damage: engine smoke, oil mist, fuel
 * vapour, flame and wreck fires.
 *
 * This is deliberately *not* a general-purpose VFX system — 'VfxSystem' owns
 * explosions and hit sparks. What lives here is only what has to be emitted
 * from a specific animated part of a specific aircraft every frame, because
 * that emission is a function of the damage state this subsystem already owns.
 *
 * One 'BillboardField' = one draw call. Simulation is on the CPU: at the
 * particle counts a dogfight actually produces (a few hundred) the transform
 * upload dominates anyway, and CPU simulation lets smoke inherit the emitter's
 * velocity, which is what makes a damaged aircraft trail properly instead of
 * dragging a static plume.
 */

export interface EmitOptions {
  /** Initial size, metres. */
  size: number;
  /** Size at end of life, metres. */
  growth: number;
  life: number;
  /** Vertical buoyancy, m/s². Hot smoke rises, cold oil mist does not. */
  buoyancy: number;
  /** Aerodynamic drag coefficient, 1/s — how fast the puff matches the airflow. */
  drag: number;
  color: THREE.Color;
  /** Colour at end of life; smoke cools from near-black to grey. */
  colorEnd: THREE.Color;
  alpha: number;
  spin: number;
}

interface Particle {
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  age: number; life: number;
  size0: number; size1: number;
  rot: number; rotVel: number;
  cr0: number; cg0: number; cb0: number;
  cr1: number; cg1: number; cb1: number;
  alpha: number;
  buoyancy: number; drag: number;
  live: boolean;
}

export class BillboardField {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;

  private parts: Particle[] = [];
  private free: number[] = [];
  private capacity: number;

  private posArr: Float32Array;
  private parArr: Float32Array;   // size, rotation, alpha, _
  private colArr: Float32Array;

  private aPos: THREE.InstancedBufferAttribute;
  private aPar: THREE.InstancedBufferAttribute;
  private aCol: THREE.InstancedBufferAttribute;

  private live = 0;

  constructor(capacity: number, texture: THREE.Texture, additive: boolean) {
    this.capacity = capacity;

    const base = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = base.index;
    this.geo.attributes.position = base.attributes.position;
    this.geo.attributes.uv = base.attributes.uv;
    base.dispose();

    this.posArr = new Float32Array(capacity * 3);
    this.parArr = new Float32Array(capacity * 4);
    this.colArr = new Float32Array(capacity * 3);
    this.aPos = new THREE.InstancedBufferAttribute(this.posArr, 3);
    this.aPar = new THREE.InstancedBufferAttribute(this.parArr, 4);
    this.aCol = new THREE.InstancedBufferAttribute(this.colArr, 3);
    for (const a of [this.aPos, this.aPar, this.aCol]) a.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iPos', this.aPos);
    this.geo.setAttribute('iPar', this.aPar);
    this.geo.setAttribute('iCol', this.aCol);
    this.geo.instanceCount = 0;

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uFogColor: { value: new THREE.Color(0.62, 0.74, 0.86) },
        uFogFar: { value: 26000 },
        uSoft: { value: additive ? 0 : 1 },
      },
      vertexShader: /* glsl */`
        attribute vec3 iPos;
        attribute vec4 iPar;   // size, rotation, alpha, seed
        attribute vec3 iCol;

        varying vec2  vUv;
        varying vec3  vCol;
        varying float vAlpha;
        varying float vDist;

        void main() {
          float c = cos( iPar.y ), s = sin( iPar.y );
          vec2 p = vec2(
            position.x * c - position.y * s,
            position.x * s + position.y * c
          ) * iPar.x;

          vec4 view = modelViewMatrix * vec4( iPos, 1.0 );
          view.xy += p;
          vDist = -view.z;
          vUv = uv;
          vCol = iCol;
          vAlpha = iPar.z;
          gl_Position = projectionMatrix * view;
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        uniform vec3  uFogColor;
        uniform float uFogFar;
        uniform float uSoft;

        varying vec2  vUv;
        varying vec3  vCol;
        varying float vAlpha;
        varying float vDist;

        void main() {
          vec4 t = texture2D( uMap, vUv );
          float a = t.a * vAlpha;
          if ( a < 0.004 ) discard;
          vec3 col = t.rgb * vCol;
          // Aerial perspective: distant smoke must sit in the same haze as the
          // terrain behind it or it reads as a decal pasted on the sky.
          float aerial = ( 1.0 - exp( -vDist / uFogFar ) ) * uSoft;
          col = mix( col, uFogColor, aerial * 0.8 );
          gl_FragColor = vec4( col, a );
        }
      `,
      transparent: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
    });

    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = additive ? 'fireField' : 'smokeField';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 11 : 9;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    if (additive) this.mesh.layers.enable(LAYER_BLOOM);

    for (let i = 0; i < capacity; i++) {
      this.parts.push({
        px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0,
        age: 0, life: 1, size0: 1, size1: 1, rot: 0, rotVel: 0,
        cr0: 1, cg0: 1, cb0: 1, cr1: 1, cg1: 1, cb1: 1,
        alpha: 1, buoyancy: 0, drag: 1, live: false,
      });
      this.free.push(i);
    }
  }

  setFog(color: THREE.Color, far: number): void {
    this.mat.uniforms.uFogColor.value.copy(color);
    this.mat.uniforms.uFogFar.value = far;
  }

  get activeCount(): number { return this.live; }

  /** Spawns one particle. Silently drops when the pool is exhausted. */
  emit(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    o: EmitOptions,
  ): void {
    const idx = this.free.pop();
    if (idx === undefined) return;
    const p = this.parts[idx];
    p.px = x; p.py = y; p.pz = z;
    p.vx = vx; p.vy = vy; p.vz = vz;
    p.age = 0; p.life = o.life;
    p.size0 = o.size; p.size1 = o.growth;
    p.rot = Math.random() * Math.PI * 2;
    p.rotVel = (Math.random() - 0.5) * o.spin;
    p.cr0 = o.color.r; p.cg0 = o.color.g; p.cb0 = o.color.b;
    p.cr1 = o.colorEnd.r; p.cg1 = o.colorEnd.g; p.cb1 = o.colorEnd.b;
    p.alpha = o.alpha;
    p.buoyancy = o.buoyancy;
    p.drag = o.drag;
    p.live = true;
    this.live++;
  }

  /**
   * @param wind ambient air velocity — particles decelerate toward it, which is
   *        what turns an emitted plume into a trail behind a moving aircraft.
   */
  update(dt: number, wind: THREE.Vector3): void {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) {
      const p = this.parts[i];
      if (!p.live) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.live = false;
        this.free.push(i);
        this.live--;
        continue;
      }
      const t = p.age / p.life;

      // Exponential relaxation toward the air mass — frame-rate independent.
      const k = 1 - Math.exp(-p.drag * dt);
      p.vx += (wind.x - p.vx) * k;
      p.vy += (wind.y - p.vy) * k;
      p.vz += (wind.z - p.vz) * k;
      // Buoyancy decays as the puff cools and mixes.
      p.vy += p.buoyancy * (1 - t) * dt;

      p.px += p.vx * dt; p.py += p.vy * dt; p.pz += p.vz * dt;
      p.rot += p.rotVel * dt;

      if (n < this.capacity) {
        const i3 = n * 3, i4 = n * 4;
        this.posArr[i3] = p.px; this.posArr[i3 + 1] = p.py; this.posArr[i3 + 2] = p.pz;
        // Puffs expand fast at birth then asymptote, matching turbulent mixing.
        const grow = 1 - Math.pow(1 - t, 2.2);
        this.parArr[i4] = p.size0 + (p.size1 - p.size0) * grow;
        this.parArr[i4 + 1] = p.rot;
        // Fade in quickly, out slowly — a puff that pops into existence is the
        // classic particle-system tell.
        const fade = Math.min(1, t * 9) * (1 - t) * (1 - t);
        this.parArr[i4 + 2] = p.alpha * fade;
        this.parArr[i4 + 3] = i;
        this.colArr[i3] = p.cr0 + (p.cr1 - p.cr0) * t;
        this.colArr[i3 + 1] = p.cg0 + (p.cg1 - p.cg0) * t;
        this.colArr[i3 + 2] = p.cb0 + (p.cb1 - p.cb0) * t;
        n++;
      }
    }
    this.geo.instanceCount = n;
    if (n > 0) {
      this.aPos.needsUpdate = true;
      this.aPar.needsUpdate = true;
      this.aCol.needsUpdate = true;
    }
  }

  clear(): void {
    this.free.length = 0;
    for (let i = 0; i < this.capacity; i++) { this.parts[i].live = false; this.free.push(i); }
    this.live = 0;
    this.geo.instanceCount = 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------------------
// Damage emission presets
// ---------------------------------------------------------------------------

const c = (h: number) => new THREE.Color(h);

/**
 * Presets tuned against gun-camera footage. The distinguishing feature of each
 * failure is its *colour and opacity*, not its shape: white glycol, translucent
 * blue oil smoke, sooty black fuel fire, thin grey vapour. A pilot reads which
 * system the enemy has lost from that alone, so the values matter.
 */
export const SMOKE_PRESETS = {
  /** Damaged engine: thin, pale grey, intermittent. */
  engineLight: {
    size: 0.9, growth: 7, life: 2.4, buoyancy: 1.4, drag: 2.2,
    color: c(0x9aa0a6), colorEnd: c(0xb8bcc0), alpha: 0.32, spin: 1.4,
  } as EmitOptions,
  /** Failing engine: dense and dark. */
  engineHeavy: {
    size: 1.3, growth: 13, life: 3.6, buoyancy: 1.0, drag: 1.7,
    color: c(0x2a2724), colorEnd: c(0x6a6560), alpha: 0.60, spin: 1.1,
  } as EmitOptions,
  /** Burning fuel: black, greasy, long-lived. */
  fire: {
    size: 1.6, growth: 22, life: 5.0, buoyancy: 2.6, drag: 1.2,
    color: c(0x14120f), colorEnd: c(0x4a443c), alpha: 0.78, spin: 0.8,
  } as EmitOptions,
  /** Oil: translucent blue-brown mist that streaks rather than billows. */
  oil: {
    size: 0.5, growth: 3.4, life: 1.5, buoyancy: -0.4, drag: 3.4,
    color: c(0x3d3126), colorEnd: c(0x6b5a49), alpha: 0.26, spin: 2.0,
  } as EmitOptions,
  /** Punctured tank: white fuel vapour, dissipates fast. */
  fuel: {
    size: 0.45, growth: 4.5, life: 1.1, buoyancy: 0.2, drag: 4.0,
    color: c(0xe8ecf0), colorEnd: c(0xf4f6f8), alpha: 0.24, spin: 2.4,
  } as EmitOptions,
  /** Coolant/glycol: brilliant white, the classic Merlin death sentence. */
  coolant: {
    size: 0.7, growth: 6.0, life: 2.0, buoyancy: 0.9, drag: 2.6,
    color: c(0xf2f5f8), colorEnd: c(0xdfe4ea), alpha: 0.42, spin: 1.8,
  } as EmitOptions,
  /** Wreck burning on the ground: huge, slow, rising column. */
  wreck: {
    size: 2.6, growth: 34, life: 7.5, buoyancy: 4.2, drag: 0.7,
    color: c(0x121110), colorEnd: c(0x585149), alpha: 0.82, spin: 0.5,
  } as EmitOptions,
  /**
   * Rocket motor exhaust: a dense white cordite trail that hangs in the air
   * behind the salvo. Ballistite burns clean and bright, nothing like the oily
   * black of a fuel fire, and it is the visual signature of a rocket attack —
   * so it is long-lived and barely buoyant, and it drifts with the wind rather
   * than rising.
   */
  rocket: {
    size: 0.8, growth: 9.0, life: 2.6, buoyancy: 0.5, drag: 2.4,
    color: c(0xd8dade), colorEnd: c(0xa8adb4), alpha: 0.38, spin: 1.6,
  } as EmitOptions,
  /** Debris trail. */
  debris: {
    size: 0.35, growth: 2.6, life: 1.2, buoyancy: 0.6, drag: 3.0,
    color: c(0x4a453e), colorEnd: c(0x8c867d), alpha: 0.30, spin: 2.6,
  } as EmitOptions,
};

export const FIRE_PRESETS = {
  /** Engine fire: short licks streaming aft. */
  engine: {
    size: 0.9, growth: 1.9, life: 0.45, buoyancy: 3.0, drag: 3.0,
    color: c(0xffb060), colorEnd: c(0xff5820), alpha: 0.85, spin: 3.0,
  } as EmitOptions,
  /** Wing tank alight. */
  wing: {
    size: 1.3, growth: 3.0, life: 0.6, buoyancy: 3.4, drag: 2.6,
    color: c(0xffc880), colorEnd: c(0xff4a12), alpha: 0.9, spin: 2.4,
  } as EmitOptions,
  /** Wreck pyre. */
  wreck: {
    size: 2.4, growth: 6.5, life: 1.2, buoyancy: 6.0, drag: 1.6,
    color: c(0xfff0c0), colorEnd: c(0xd83c10), alpha: 0.95, spin: 1.6,
  } as EmitOptions,
};

export function makeSmokeField(capacity: number): BillboardField {
  return new BillboardField(capacity, smokeSprite(), false);
}

export function makeFireField(capacity: number): BillboardField {
  return new BillboardField(capacity, fireSprite(), true);
}
