/**
 * International Standard Atmosphere, plus the airspeed conversions the rest of
 * the model and the HUD need.
 *
 * The ISA is a piecewise-defined function of geopotential altitude; below
 * 11 km temperature falls linearly at 6.5 K/km and pressure follows the
 * hydrostatic power law, above it the lower stratosphere is isothermal and
 * pressure decays exponentially. WWII fighters live entirely inside the first
 * two layers, but the third is included so a stray bomber at 20 km still gets
 * sane numbers instead of a NaN.
 */

import { v3, vset, type V3 } from '../math';
import {
  GAMMA, P0, RHO0, R_AIR, T0, type AtmoSample, type Environment,
} from './types';

/** Temperature lapse rate in the troposphere, K/m. */
const LAPSE = 0.0065;
/** Tropopause altitude, m. */
const H_TROP = 11000;
/** Temperature and pressure at the tropopause. */
const T_TROP = T0 - LAPSE * H_TROP;            // 216.65 K
const P_TROP = P0 * Math.pow(T_TROP / T0, 9.80665 / (R_AIR * LAPSE)); // ≈ 22632 Pa
/** Top of the isothermal layer, m. */
const H_STRAT = 20000;
const P_STRAT = P_TROP * Math.exp(-9.80665 * (H_STRAT - H_TROP) / (R_AIR * T_TROP));
/** Lapse rate above 20 km (temperature rises again), K/m. */
const LAPSE2 = -0.001;

/** ISA temperature, K. */
export function isaTemperature(y: number): number {
  if (y < H_TROP) return T0 - LAPSE * Math.max(y, -2000);
  if (y < H_STRAT) return T_TROP;
  return T_TROP - LAPSE2 * (Math.min(y, 47000) - H_STRAT);
}

/** ISA static pressure, Pa. */
export function isaPressure(y: number): number {
  if (y < H_TROP) {
    const t = T0 - LAPSE * Math.max(y, -2000);
    return P0 * Math.pow(t / T0, 9.80665 / (R_AIR * LAPSE));
  }
  if (y < H_STRAT) return P_TROP * Math.exp(-9.80665 * (y - H_TROP) / (R_AIR * T_TROP));
  const t = isaTemperature(y);
  return P_STRAT * Math.pow(t / T_TROP, 9.80665 / (R_AIR * -LAPSE2));
}

/** ISA density, kg/m³. */
export function isaDensity(y: number): number {
  return isaPressure(y) / (R_AIR * isaTemperature(y));
}

/** Speed of sound for a given static temperature, m/s. */
export function soundSpeed(temperatureK: number): number {
  return Math.sqrt(GAMMA * R_AIR * temperatureK);
}

const _atmo: AtmoSample = { density: RHO0, pressure: P0, temperature: T0, soundSpeed: 340.294 };

/**
 * Sample the whole atmosphere at once. Returns a shared scratch object by
 * default — copy it if you need to keep it. Zero allocation in the hot path.
 */
export function atmosphereAt(y: number, out: AtmoSample = _atmo): AtmoSample {
  const t = isaTemperature(y);
  const p = isaPressure(y);
  out.temperature = t;
  out.pressure = p;
  out.density = p / (R_AIR * t);
  out.soundSpeed = Math.sqrt(GAMMA * R_AIR * t);
  return out;
}

/**
 * Equivalent airspeed — what a pitot-static ASI actually shows once you strip
 * out instrument and position error. EAS is the speed that gives the same
 * dynamic pressure at sea level, which is exactly what structural limits,
 * stall speeds and control forces care about, so the model uses it everywhere
 * "IAS" is mentioned.
 */
export function tasToEas(tas: number, density: number): number {
  return tas * Math.sqrt(Math.max(density, 1e-4) / RHO0);
}

/** Inverse of {@link tasToEas}. */
export function easToTas(eas: number, density: number): number {
  return eas / Math.sqrt(Math.max(density, 1e-4) / RHO0);
}

/**
 * Pressure altitude for a given static pressure — used by the altimeter and by
 * the supercharger model, which cares about pressure rather than height.
 */
export function pressureAltitude(pressure: number): number {
  const p = Math.max(pressure, 1);
  if (p > P_TROP) return (T0 / LAPSE) * (1 - Math.pow(p / P0, (R_AIR * LAPSE) / 9.80665));
  return H_TROP - (R_AIR * T_TROP / 9.80665) * Math.log(p / P_TROP);
}

// ---------------------------------------------------------------------------
// Reference environments
// ---------------------------------------------------------------------------

const _wind = v3();
const _norm = v3(0, 1, 0);

export interface FlatEnvOptions {
  /** Ground height, m ASL. */
  groundY?: number;
  /** Steady wind, world frame, m/s. */
  wind?: V3;
  /** Peak gust amplitude, m/s. Deterministic — derived from position, not time. */
  gust?: number;
  /** 0 paved, 1 soft. */
  surface?: number;
}

/**
 * A flat, ISA, optionally windy world. Used by the self-test, by the trim
 * solver and by the server until the terrain subsystem is online. The gust
 * field is a smooth deterministic function of position only, so replays and
 * client prediction reproduce it exactly.
 */
export function flatEnvironment(opts: FlatEnvOptions = {}): Environment {
  const groundY = opts.groundY ?? 0;
  const wx = opts.wind?.x ?? 0, wy = opts.wind?.y ?? 0, wz = opts.wind?.z ?? 0;
  const gust = opts.gust ?? 0;
  const surf = opts.surface ?? 0;
  return {
    airDensity: isaDensity,
    windAt(pos: V3, out: V3 = _wind): V3 {
      if (gust <= 0) return vset(out, wx, wy, wz);
      // Three incommensurable spatial frequencies → a non-repeating, smooth,
      // purely positional gust field. No time term, so it is replay-safe.
      const a = Math.sin(pos.x * 0.0031 + pos.z * 0.0017) * Math.cos(pos.y * 0.0043);
      const b = Math.sin(pos.z * 0.0027 - pos.x * 0.0011) * Math.cos(pos.y * 0.0029);
      const c = Math.sin(pos.x * 0.0019 + pos.y * 0.0037);
      return vset(out, wx + gust * a, wy + gust * 0.4 * c, wz + gust * b);
    },
    terrainHeight: () => groundY,
    terrainNormal(_x: number, _z: number, out: V3 = _norm): V3 {
      return vset(out, 0, 1, 0);
    },
    surfaceType: () => surf,
  };
}

/** Convenience: clamp a density query so callers cannot divide by zero. */
export function safeDensity(env: Environment, y: number): number {
  const d = env.airDensity(y);
  return d > 1e-4 && isFinite(d) ? d : 1e-4;
}

export const ISA = {
  temperature: isaTemperature,
  pressure: isaPressure,
  density: isaDensity,
  soundSpeed,
  T0, P0, RHO0, tropopause: H_TROP,
};
