/**
 * Fire.
 *
 * Fire is the most feared damage state in a piston fighter and it should feel
 * like it. The rules here are drawn from how it actually behaved:
 *
 *  - It starts in something flammable: a fuel tank, an oil tank, the engine
 *    bay, or an ammunition tray. Incendiary rounds start it far more often
 *    than plain AP, and self-sealing tanks roughly halve the odds.
 *  - It *spreads*. A wing-tank fire walks along the spar into the wing skin
 *    and out to the aileron; an engine fire walks back through the firewall.
 *  - It can be blown out by diving fast and side-slipping, which is exactly
 *    what pilots were trained to do — but the chance drops sharply the longer
 *    it has been burning, because by then the structure itself is alight.
 *  - If it is not put out it eventually kills the aeroplane.
 */

import { clamp, smoothstep, type Rng } from '../math';
import { type FireState, ModuleId, MODULE_ADJACENCY } from './types';

/** Modules that can sustain a fire at all. Aluminium skin does not burn. */
export function isFlammable(m: ModuleId): boolean {
  switch (m) {
    case ModuleId.Engine:
    case ModuleId.OilTank:
    case ModuleId.FuelFuselage:
    case ModuleId.FuelLeft:
    case ModuleId.FuelRight:
    case ModuleId.AmmoLeft:
    case ModuleId.AmmoRight:
    case ModuleId.WingLeft:
    case ModuleId.WingRight:
    case ModuleId.Fuselage:
    case ModuleId.TailBoom:
    case ModuleId.Pilot:
      return true;
    default:
      return false;
  }
}

/** How readily a module sustains combustion once lit, 0..1. */
export function fuelLoad(m: ModuleId): number {
  switch (m) {
    case ModuleId.FuelLeft:
    case ModuleId.FuelRight:
    case ModuleId.FuelFuselage: return 1.0;
    case ModuleId.OilTank: return 0.75;
    case ModuleId.Engine: return 0.70;
    case ModuleId.AmmoLeft:
    case ModuleId.AmmoRight: return 0.55;
    case ModuleId.WingLeft:
    case ModuleId.WingRight: return 0.40;
    case ModuleId.Fuselage: return 0.35;
    case ModuleId.TailBoom: return 0.25;
    case ModuleId.Pilot: return 0.30;
    default: return 0.15;
  }
}

/** Damage per second a fire of unit intensity does to the module it is in. */
export const FIRE_DPS = 26;
/** Damage per second bled into adjacent modules. */
export const FIRE_SPILL_DPS = 7;
/** Seconds between spread attempts. */
export const FIRE_SPREAD_PERIOD = 2.2;

export function findFire(fires: FireState[], m: ModuleId): FireState | undefined {
  for (let i = 0; i < fires.length; i++) if (fires[i].module === m) return fires[i];
  return undefined;
}

/** Start (or intensify) a fire. Returns true if a *new* fire was created. */
export function igniteModule(fires: FireState[], m: ModuleId, intensity: number): boolean {
  const existing = findFire(fires, m);
  if (existing) {
    existing.intensity = clamp(existing.intensity + intensity * 0.5, 0, 1);
    return false;
  }
  if (fires.length >= 6) return false;   // bounded for sanity
  fires.push({ module: m, intensity: clamp(intensity, 0.15, 1), burnT: 0, spreadT: 0 });
  return true;
}

/**
 * Probability *per second* that the slipstream blows a fire out.
 *
 * The three terms are: dynamic pressure (you must be fast — below ~150 km/h
 * nothing happens), side-slip (yawing the airframe pushes the flame away from
 * the structure rather than along it), and an exponential decay with burn time
 * because after twenty seconds the aluminium itself is burning and no amount
 * of airflow will help.
 */
export function extinguishRate(
  fire: FireState, iasMs: number, sideslipRad: number,
): number {
  const speedTerm = smoothstep(38, 125, iasMs);            // ~135 to 450 km/h
  const slipDeg = Math.abs(sideslipRad) * 180 / Math.PI;
  const slipTerm = 0.30 + 0.70 * clamp(slipDeg / 11, 0, 1);
  // Half-life of roughly 8 s in "still put-out-able" terms.
  const ageTerm = Math.exp(-fire.burnT / 8.5);
  const intensityTerm = clamp(1.25 - fire.intensity, 0.15, 1);
  return 0.55 * speedTerm * slipTerm * ageTerm * intensityTerm;
}

export interface FireTickResult {
  /** Damage to apply, indexed by module. Reused buffer — read it immediately. */
  damage: Float32Array;
  /** Fires that went out this tick. */
  extinguished: ModuleId[];
  /** Fires that started this tick by spreading. */
  spread: ModuleId[];
}

const _dmg = new Float32Array(64);
const _ext: ModuleId[] = [];
const _spr: ModuleId[] = [];
const _result: FireTickResult = { damage: _dmg, extinguished: _ext, spread: _spr };

/**
 * Advance all fires on one aircraft.
 *
 * 'moduleAlive(m)' lets the caller veto spreading into a module that has
 * already been shot away (there is nothing left there to burn).
 */
export function stepFires(
  fires: FireState[], dt: number, iasMs: number, sideslipRad: number,
  rng: Rng, moduleAlive: (m: ModuleId) => boolean,
): FireTickResult {
  _dmg.fill(0);
  _ext.length = 0;
  _spr.length = 0;

  for (let i = fires.length - 1; i >= 0; i--) {
    const f = fires[i];
    f.burnT += dt;
    f.spreadT += dt;

    // Fires grow toward the module's fuel load, then plateau.
    const target = fuelLoad(f.module);
    f.intensity = clamp(f.intensity + (target - f.intensity) * dt * 0.35, 0, 1);

    _dmg[f.module] += FIRE_DPS * f.intensity * dt;

    // Heat soak into neighbours even without ignition.
    const adj = MODULE_ADJACENCY[f.module];
    for (let k = 0; k < adj.length; k++) {
      _dmg[adj[k]] += FIRE_SPILL_DPS * f.intensity * dt;
    }

    // Spread attempt.
    if (f.spreadT >= FIRE_SPREAD_PERIOD) {
      f.spreadT = 0;
      for (let k = 0; k < adj.length; k++) {
        const m = adj[k];
        if (!isFlammable(m) || !moduleAlive(m)) continue;
        if (findFire(fires, m)) continue;
        const chance = 0.14 * f.intensity * (0.35 + fuelLoad(m));
        if (rng.next() < chance) {
          if (igniteModule(fires, m, 0.25)) _spr.push(m);
          break;   // at most one new seat of fire per attempt
        }
      }
    }

    // Extinguish attempt.
    const rate = extinguishRate(f, iasMs, sideslipRad);
    if (rate > 0 && rng.next() < 1 - Math.exp(-rate * dt)) {
      _ext.push(f.module);
      fires.splice(i, 1);
    }
  }

  return _result;
}

/** Largest active fire intensity — drives VFX scale and the HUD warning. */
export function maxFireIntensity(fires: FireState[]): number {
  let m = 0;
  for (let i = 0; i < fires.length; i++) if (fires[i].intensity > m) m = fires[i].intensity;
  return m;
}

/** Total seconds the longest-burning fire has been alight. */
export function longestBurn(fires: FireState[]): number {
  let m = 0;
  for (let i = 0; i < fires.length; i++) if (fires[i].burnT > m) m = fires[i].burnT;
  return m;
}
