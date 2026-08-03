import { AIRCRAFT, type AircraftSpec } from '../../shared/aircraft';
import { airDensity } from '../Telemetry';

/**
 * Derived performance figures for the hangar stat card.
 *
 * These are computed from the archetype's aerodynamics rather than typed in as
 * a second set of numbers, so a balance change to the flight model shows up in
 * the hangar automatically and can never disagree with what the aircraft
 * actually does in the air.
 *
 * The physics is standard first-order performance analysis:
 *   power required = parasite + induced,
 *   P_req(v) = ½ρv³S·Cd0 + 2W²/(ρvS·πeAR)
 * sampled over the speed range. Where that curve meets available shaft power
 * gives top speed; the biggest gap gives best rate of climb; the tightest
 * sustainable load factor gives the turn time.
 */

const G = 9.80665;
const PROP_ETA = 0.80;    // propeller efficiency at cruise/high speed

export interface Perf {
  /** Maximum true airspeed at critical altitude, m/s. */
  topSpeed: number;
  /** Best rate of climb at sea level, m/s. */
  climb: number;
  /** Sustained 360° turn time at sea level, s. */
  turnTime: number;
  /** Roll rate, deg/s. */
  rollRate: number;
  /** Burst mass in kJ of muzzle energy per second (HE weighted). */
  firepower: number;
  /** Composite toughness index. */
  survivability: number;
  /** Wing loading, kg/m². */
  wingLoading: number;
  /** Power-to-weight, kW/tonne. */
  powerToWeight: number;
  /** Sea-level stall speed, clean, m/s. */
  stallSpeed: number;
  /** Service ceiling estimate, m. */
  ceiling: number;
}

const cache = new Map<string, Perf>();

export function performanceOf(spec: AircraftSpec): Perf {
  const hit = cache.get(spec.id);
  if (hit) return hit;

  const a = spec.aero;
  const W = a.mass * G;
  const AR = (a.span * a.span) / a.wingArea;
  const k = 1 / (Math.PI * a.oswald * AR);

  const powerAt = (alt: number, wep: boolean) => {
    const e = spec.engine;
    const fall = Math.max(0, alt - e.critAlt) / 6000 * e.altFalloff;
    const rise = Math.min(1, alt / Math.max(1, e.critAlt)) * 0.14;   // ram + supercharger gain
    return e.powerKw * 1000 * (wep ? e.wepMul : 1) * Math.max(0.35, 1 + rise - fall);
  };

  const preq = (v: number, rho: number, n = 1) => {
    const q = 0.5 * rho * v * v;
    const cl = (n * W) / (q * a.wingArea);
    const cd = a.cd0 + k * cl * cl;
    return q * a.wingArea * cd * v;
  };

  // --- top speed at critical altitude ------------------------------------
  const rhoCrit = airDensity(spec.engine.critAlt);
  const pCrit = powerAt(spec.engine.critAlt, true) * PROP_ETA;
  let topSpeed = 60;
  for (let v = 60; v < 260; v += 0.5) {
    if (preq(v, rhoCrit) > pCrit) break;
    topSpeed = v;
  }
  // Compressibility bites above the critical Mach number.
  const machLimit = a.machCrit * 340 * 1.06;
  topSpeed = Math.min(topSpeed, machLimit, a.vne * 1.28);

  // --- best rate of climb at sea level -----------------------------------
  const rho0 = airDensity(0);
  const pSl = powerAt(0, true) * PROP_ETA;
  let climb = 0;
  for (let v = 40; v < 200; v += 0.5) {
    const excess = pSl - preq(v, rho0);
    const rate = excess / W;
    if (rate > climb) climb = rate;
  }

  // --- sustained turn -----------------------------------------------------
  let bestRate = 0;
  for (let v = 45; v < 200; v += 0.5) {
    const q = 0.5 * rho0 * v * v;
    const nLift = (q * a.wingArea * a.clMax) / W;
    // Largest n whose induced drag still fits inside available power.
    let nPow = 1;
    for (let n = 1; n <= nLift && n <= a.gLimit; n += 0.05) {
      if (preq(v, rho0, n) <= pSl) nPow = n; else break;
    }
    const n = Math.min(nLift, nPow, a.gLimit);
    if (n <= 1.02) continue;
    const rate = (G * Math.sqrt(n * n - 1)) / v;   // rad/s
    if (rate > bestRate) bestRate = rate;
  }
  const turnTime = bestRate > 0 ? (2 * Math.PI) / bestRate : 40;

  // --- armament -----------------------------------------------------------
  let firepower = 0;
  for (const g of spec.guns) {
    const kinetic = 0.5 * g.mass * g.muzzle * g.muzzle;          // joules per round
    const chemical = g.he * 1e-3 * 4.2e6 * 0.55;                 // TNT-equivalent, damped
    firepower += (g.count * g.rpm / 60) * (kinetic + chemical) / 1000; // kJ/s
  }

  const d = spec.damage;
  const survivability = d.hull + d.wing * 2 + d.tail + d.engine
    + (d.armour.pilotBack + d.armour.pilotFront + d.armour.engineFront) * 9
    + (d.selfSealing ? 70 : 0);

  const stallSpeed = Math.sqrt((2 * W) / (rho0 * a.wingArea * a.clMax));

  // Service ceiling: where best climb falls to 0.5 m/s.
  let ceiling = 0;
  for (let alt = 0; alt <= 13000; alt += 250) {
    const rho = airDensity(alt);
    const p = powerAt(alt, false) * PROP_ETA;
    let best = 0;
    for (let v = 50; v < 220; v += 2) {
      const rate = (p - preq(v, rho)) / W;
      if (rate > best) best = rate;
    }
    if (best < 0.5) break;
    ceiling = alt;
  }

  const perf: Perf = {
    topSpeed, climb, turnTime,
    rollRate: a.rollRate * 57.29578,
    firepower, survivability,
    wingLoading: a.mass / a.wingArea,
    powerToWeight: (spec.engine.powerKw / a.mass) * 1000,
    stallSpeed, ceiling,
  };
  cache.set(spec.id, perf);
  return perf;
}

export interface StatRange { min: number; max: number }

let ranges: Record<string, StatRange> | null = null;

/** Min/max across the roster, so bars are comparisons and not absolutes. */
export function statRanges(): Record<string, StatRange> {
  if (ranges) return ranges;
  const keys: (keyof Perf)[] = ['topSpeed', 'climb', 'turnTime', 'rollRate', 'firepower', 'survivability'];
  const r: Record<string, StatRange> = {};
  for (const key of keys) {
    let min = Infinity, max = -Infinity;
    for (const s of AIRCRAFT) {
      const v = performanceOf(s)[key] as number;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    // Pad by 8 % so the best aircraft does not peg the bar at exactly 100 %.
    const pad = (max - min) * 0.08 || 1;
    r[key] = { min: min - pad, max: max + pad };
  }
  ranges = r;
  return r;
}

/** Normalised 0..1 bar value; 'invert' for stats where lower is better. */
export function statFraction(key: keyof Perf, value: number, invert = false): number {
  const r = statRanges()[key as string];
  if (!r) return 0.5;
  const t = (value - r.min) / Math.max(1e-6, r.max - r.min);
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return invert ? 1 - c : c;
}
