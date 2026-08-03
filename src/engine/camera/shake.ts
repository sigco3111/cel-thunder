import * as THREE from 'three';

/**
 * Camera shake, built on a trauma reservoir rather than on decaying impulses.
 *
 * The trauma model (one scalar, 0…1, that events *add* to and that decays at a
 * constant rate) is what makes shake read as force rather than as vibration:
 * amplitude scales with trauma², so a single hit is a firm knock and a burst of
 * cannon fire from six barrels compounds into something that genuinely
 * interferes with aiming, but neither ever pins the camera or stacks to
 * infinity.
 *
 * The displacement itself comes from three decorrelated value-noise channels.
 * Noise, not sine waves: periodic shake reads as an engine vibration and, worse,
 * beats against the frame rate.
 */

const SEEDS = [0, 137, 971, 1733, 2551, 3319];

/** 1-D value noise with a smooth Hermite interpolant, period-free. */
function vnoise(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i + seed) * (1 - u) + hash(i + 1 + seed) * u;
}

function hash(n: number): number {
  let h = Math.imul(n | 0, 374761393);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 2147483648 - 1;   // [-1,1]
}

/** Two octaves: a slow body movement with a fine tremor riding on it. */
function shakeNoise(t: number, seed: number): number {
  return vnoise(t, SEEDS[seed]) * 0.72 + vnoise(t * 2.7 + 11.3, SEEDS[seed] + 61) * 0.28;
}

export class CameraShake {
  /** 0…1. Add to it with 'impulse()'; it bleeds off on its own. */
  trauma = 0;
  /** Sustained component (buffet, engine, gunfire held down) — set every frame. */
  sustained = 0;

  /** Trauma decay per second. ~1.4 gives a firm hit that is gone in 0.7 s. */
  decay = 1.5;
  /** Peak positional excursion at full trauma, metres. */
  positionAmplitude = 0.14;
  /** Peak angular excursion at full trauma, radians. */
  angleAmplitude = 0.026;
  /** Base shake frequency, Hz. */
  frequency = 17;

  private time = 0;
  readonly offset = new THREE.Vector3();
  /** Euler shake in radians: x = pitch, y = yaw, z = roll. */
  readonly angles = new THREE.Vector3();

  impulse(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Advances the shake and writes 'offset' / 'angles'. */
  update(dt: number, intensityScale = 1): void {
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - this.decay * dt);

    const t = Math.min(1, this.trauma + this.sustained);
    if (t <= 0.0005) {
      this.offset.set(0, 0, 0);
      this.angles.set(0, 0, 0);
      return;
    }
    // Quadratic response: small traumas stay subtle, large ones bite.
    const a = t * t * intensityScale;
    const ft = this.time * this.frequency;

    this.offset.set(
      shakeNoise(ft, 0) * this.positionAmplitude * a,
      shakeNoise(ft, 1) * this.positionAmplitude * a,
      shakeNoise(ft, 2) * this.positionAmplitude * a * 0.4,
    );
    this.angles.set(
      shakeNoise(ft * 0.83, 3) * this.angleAmplitude * a,
      shakeNoise(ft * 0.91, 4) * this.angleAmplitude * a,
      // Roll shake is the most nauseating axis; keep it to a third.
      shakeNoise(ft * 1.07, 5) * this.angleAmplitude * a * 0.35,
    );
  }

  reset(): void {
    this.trauma = 0;
    this.sustained = 0;
    this.offset.set(0, 0, 0);
    this.angles.set(0, 0, 0);
  }
}

/**
 * Slow, low-amplitude handheld drift. Used by the scripted screenshot framings
 * so a "locked off" camera still breathes; a mathematically perfect camera
 * reads as a render, not as footage. The fly-by and kill-cam rigs are already
 * moving and do not want it.
 */
export class HandheldDrift {
  amplitude = 0.5;      // metres
  angular = 0.004;      // radians
  frequency = 0.11;     // Hz — slower than a breath

  private time = 0;
  readonly offset = new THREE.Vector3();
  readonly angles = new THREE.Vector3();

  update(dt: number): void {
    this.time += dt;
    const ft = this.time * this.frequency;
    this.offset.set(
      shakeNoise(ft, 0) * this.amplitude,
      shakeNoise(ft + 5.1, 1) * this.amplitude * 0.6,
      shakeNoise(ft + 9.7, 2) * this.amplitude,
    );
    this.angles.set(
      shakeNoise(ft * 1.3 + 2.2, 3) * this.angular,
      shakeNoise(ft * 1.1 + 7.4, 4) * this.angular,
      shakeNoise(ft * 0.7 + 3.9, 5) * this.angular * 0.5,
    );
  }
}
