import * as THREE from 'three';

/**
 * Implicit-Euler damped springs.
 *
 * Explicit springs are the classic camera bug: they are only conditionally
 * stable, so the frame the game hitches — exactly the frame you least want the
 * camera to explode — the spring overshoots and the view snaps. The implicit
 * form below is unconditionally stable for any 'dt', 'frequency' and 'damping',
 * at the cost of being slightly over-damped at very large steps, which is
 * precisely the failure mode you want.
 *
 * Parameters are expressed the way a designer thinks about them:
 *   'frequency' — how many times per second it would oscillate if undamped;
 *                 raise it to make the camera stiffer.
 *   'damping'   — 1 is critically damped (fastest approach with no overshoot),
 *                 below 1 overshoots, above 1 crawls in.
 *
 * Derivation: solving
 *     v₁ = v₀ + h(−2ζω·v₁ − ω²(x₁ − t)),  x₁ = x₀ + h·v₁
 * for v₁ and x₁ gives the closed form used here.
 */

export class SpringScalar {
  value: number;
  velocity = 0;
  constructor(initial = 0) { this.value = initial; }

  step(target: number, dt: number, frequency: number, damping = 1): number {
    if (dt <= 0) return this.value;
    const omega = 2 * Math.PI * frequency;
    const f = 1 + 2 * dt * damping * omega;
    const oo = omega * omega;
    const hoo = dt * oo;
    const hhoo = dt * hoo;
    const detInv = 1 / (f + hhoo);
    const detX = f * this.value + dt * this.velocity + hhoo * target;
    const detV = this.velocity + hoo * (target - this.value);
    this.value = detX * detInv;
    this.velocity = detV * detInv;
    return this.value;
  }

  set(v: number): void { this.value = v; this.velocity = 0; }
}

export class SpringVec3 {
  readonly value = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();

  step(target: THREE.Vector3, dt: number, frequency: number, damping = 1): THREE.Vector3 {
    if (dt <= 0) return this.value;
    const omega = 2 * Math.PI * frequency;
    const f = 1 + 2 * dt * damping * omega;
    const oo = omega * omega;
    const hoo = dt * oo;
    const hhoo = dt * hoo;
    const detInv = 1 / (f + hhoo);

    const x = this.value, v = this.velocity;
    const nx = (f * x.x + dt * v.x + hhoo * target.x) * detInv;
    const ny = (f * x.y + dt * v.y + hhoo * target.y) * detInv;
    const nz = (f * x.z + dt * v.z + hhoo * target.z) * detInv;
    v.set(
      (v.x + hoo * (target.x - x.x)) * detInv,
      (v.y + hoo * (target.y - x.y)) * detInv,
      (v.z + hoo * (target.z - x.z)) * detInv,
    );
    x.set(nx, ny, nz);
    return x;
  }

  set(v: THREE.Vector3): void { this.value.copy(v); this.velocity.set(0, 0, 0); }
  setXYZ(x: number, y: number, z: number): void { this.value.set(x, y, z); this.velocity.set(0, 0, 0); }
}

/** Spring on an angle, taking the shortest way round the circle. */
export class SpringAngle {
  private s = new SpringScalar(0);
  get value(): number { return this.s.value; }

  step(target: number, dt: number, frequency: number, damping = 1): number {
    // Unwrap the target into the same revolution as the current value so the
    // spring never takes the long way round after crossing ±π.
    let t = target;
    const d = t - this.s.value;
    if (d > Math.PI) t -= Math.PI * 2;
    else if (d < -Math.PI) t += Math.PI * 2;
    return this.s.step(t, dt, frequency, damping);
  }

  set(v: number): void { this.s.set(v); }
}

/**
 * Critically damped exponential smoothing toward a quaternion.
 * Slerp with a frame-rate-independent blend factor — good enough for camera
 * orientation, and far cheaper (and more stable) than a quaternion spring.
 */
export function dampQuat(
  current: THREE.Quaternion, target: THREE.Quaternion, rate: number, dt: number,
): THREE.Quaternion {
  const t = 1 - Math.exp(-rate * dt);
  return current.slerp(target, t);
}

export const dampScalar = (a: number, b: number, rate: number, dt: number): number =>
  a + (b - a) * (1 - Math.exp(-rate * dt));

export function dampVec3(
  current: THREE.Vector3, target: THREE.Vector3, rate: number, dt: number,
): THREE.Vector3 {
  return current.lerp(target, 1 - Math.exp(-rate * dt));
}
