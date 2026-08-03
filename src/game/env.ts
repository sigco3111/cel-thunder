import { hash2, type V3 } from '../shared/math';
import { externals, type FlightEnv } from './externals';

/**
 * The atmosphere/terrain sampler the flight model integrates against.
 *
 * The client must reproduce the server's environment closely or prediction
 * diverges every frame and the reconciliation blend never settles. Density
 * therefore uses the ISA troposphere/stratosphere formulation rather than an
 * eyeballed exponential, and wind is a deterministic function of position and
 * time so both sides agree without replicating it.
 */

const RHO_SL = 1.225;
const T_SL = 288.15;
const L = 0.0065;          // K/m, ISA tropospheric lapse rate
const G0 = 9.80665;
const R_AIR = 287.05287;
const TROPOPAUSE = 11000;  // m
const T_TROPO = T_SL - L * TROPOPAUSE;                                   // 216.65 K
const RHO_TROPO = RHO_SL * Math.pow(1 - L * TROPOPAUSE / T_SL, G0 / (R_AIR * L) - 1);

/** ISA density. Exponent (g/RL - 1) comes from ρ = p/RT with p from the lapse. */
export function airDensity(h: number): number {
  if (h <= 0) return RHO_SL;
  if (h < TROPOPAUSE) {
    return RHO_SL * Math.pow(1 - (L * h) / T_SL, G0 / (R_AIR * L) - 1);
  }
  // Isothermal layer above the tropopause: pure exponential decay.
  return RHO_TROPO * Math.exp(-G0 * (h - TROPOPAUSE) / (R_AIR * T_TROPO));
}

export function speedOfSound(h: number): number {
  const t = h < TROPOPAUSE ? T_SL - L * h : T_TROPO;
  return Math.sqrt(1.4 * R_AIR * t);
}

/**
 * Wind: a prevailing gradient wind that veers and strengthens with altitude
 * (Ekman spiral, roughly), plus slow large-scale gusts. Deterministic in
 * (x, z, y) only — no time term — so a replayed input produces exactly the
 * same trajectory during reconciliation.
 */
export class ClientEnv implements FlightEnv {
  readonly seed: number;
  /** Surface wind bearing (radians, direction the wind blows *toward*). */
  private baseDir = 2.1;
  private baseSpeed = 4.5;

  constructor(seed: number) {
    this.seed = seed;
    // Same seed the server uses, so both derive the same wind field.
    this.baseDir = hash2(seed, 7, 11) * Math.PI * 2;
    this.baseSpeed = 2.5 + hash2(seed, 13, 17) * 5.0;
  }

  airDensity(y: number): number { return airDensity(y); }

  windAt(p: V3, out: V3): V3 {
    const h = Math.max(0, p.y);
    // Friction layer: speed ramps with the 1/7 power law up to ~600 m, then
    // grows slowly toward the jet.
    const shear = h < 600 ? Math.pow(h / 600, 1 / 7) : 1 + (h - 600) / 9000;
    const veer = this.baseDir + Math.min(0.6, h / 3500) * 0.55; // Ekman veering
    const speed = this.baseSpeed * shear;

    // Broad, slowly varying gust field (~3 km cells) — enough to make formation
    // flight feel alive without fighting the pilot.
    const gx = Math.floor(p.x / 3000), gz = Math.floor(p.z / 3000);
    const gust = (hash2(gx, gz, 91) - 0.5) * 2 * Math.min(1, speed * 0.35);
    const gustDir = hash2(gx, gz, 137) * Math.PI * 2;

    out.x = Math.sin(veer) * speed + Math.sin(gustDir) * gust;
    out.y = (hash2(gx, gz, 211) - 0.5) * 1.2;   // gentle vertical component
    out.z = Math.cos(veer) * speed + Math.cos(gustDir) * gust;
    return out;
  }

  terrainHeight(x: number, z: number): number {
    const t = externals().terrain;
    return t ? t.height(x, z) : 0;
  }

  terrainNormal(x: number, z: number, out: V3): V3 {
    const t = externals().terrain;
    if (t) return t.normal(x, z, out);
    out.x = 0; out.y = 1; out.z = 0;
    return out;
  }

  terrainType(x: number, z: number): string {
    const t = externals().terrain;
    return t ? t.type(x, z) : 'grass';
  }

  /**
   * Surface hint for wheel friction, in the shared flight model's encoding:
   * 0 = paved, 1 = soft ground, 2 = water. Landing on grass must cost more
   * rollout than landing on the runway, and ditching must not behave like a
   * taxiway.
   */
  surfaceType(x: number, z: number): number {
    const t = this.terrainType(x, z);
    if (t === 'runway') return 0;
    if (t === 'water') return 2;
    return 1;
  }
}

/**
 * Shared instance. Prediction and presentation must integrate against exactly
 * the same environment or the two disagree about where the ground is, so both
 * subsystems take it from here rather than each building their own.
 */
let shared: ClientEnv | null = null;
export function getClientEnv(seed: number): ClientEnv {
  if (!shared || shared.seed !== seed) shared = new ClientEnv(seed);
  return shared;
}
