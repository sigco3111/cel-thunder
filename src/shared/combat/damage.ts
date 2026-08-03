/**
 * The modular damage model.
 *
 * The design rule here is that *nothing is scalar*. There is no "health bar"
 * that ticks down until the aeroplane explodes. Every consequence is physical
 * and traceable to a specific module:
 *
 *   engine hit      -> lost manifold pressure, then an oil leak, then the
 *                      bearings run dry and the crank seizes and you are a
 *                      glider with a very draggy propeller
 *   fuel tank hit   -> a leak (you may not make it home) and, if the tank is
 *                      not self-sealing, an ignition roll
 *   pilot hit       -> greying out, then unconsciousness, then nobody flying
 *   wing spar hit   -> the wing is still there, but it will fold the next time
 *                      you pull hard, and the g at which it folds depends on
 *                      how much spar is left
 *   control run hit -> that axis is simply gone, possibly jammed at whatever
 *                      deflection it was carrying
 *   ammo tray hit   -> a chance the whole belt goes off at once, which is not
 *                      survivable
 *
 * The flight model never reads this state directly: it asks for
 * 'computeDamageEffects()' and multiplies its clean-aircraft coefficients by
 * what comes back.
 */

import { clamp, lerp } from '../math';
import { DamageBits } from '../protocol';
import { type AircraftSpec, AIRCRAFT_BY_ID } from '../aircraft';
import {
  type AircraftDamageState, type DamageEffects, type DamageEvent,
  type DamageStepInput, type HitResult, type FireState,
  DamageEventKind, ModuleId, MODULE_COUNT, AmmoType,
  newDamageEffects, isIncendiaryAmmo, seedRng,
} from './types';
import { stepFires, igniteModule, findFire, maxFireIntensity, longestBurn, isFlammable } from './fire';

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Hit points for a module, derived from the archetype's DamageSpec so that a
 * tough P-51 really is tougher than a Zero everywhere, not just in one number.
 */
function moduleHp(spec: AircraftSpec, m: ModuleId): number {
  const d = spec.damage;
  switch (m) {
    case ModuleId.Fuselage: return d.hull;
    case ModuleId.Engine: return d.engine;
    case ModuleId.PropHub: return d.engine * 0.45;
    case ModuleId.Radiator: return d.engine * 0.22;
    case ModuleId.OilTank: return d.engine * 0.26;
    case ModuleId.FuelFuselage: return d.hull * 0.30;
    case ModuleId.FuelLeft:
    case ModuleId.FuelRight: return d.wing * 0.45;
    case ModuleId.Pilot: return 100;
    case ModuleId.AmmoLeft:
    case ModuleId.AmmoRight: return d.wing * 0.32;
    case ModuleId.WingLeft:
    case ModuleId.WingRight: return d.wing;
    case ModuleId.SparLeft:
    case ModuleId.SparRight: return d.wing * 0.80;
    case ModuleId.AileronLeft:
    case ModuleId.AileronRight: return d.tail * 0.34;
    case ModuleId.TailBoom: return d.tail * 1.35;
    case ModuleId.HStab: return d.tail * 0.62;
    case ModuleId.VStab: return d.tail * 0.58;
    case ModuleId.Elevator: return d.tail * 0.34;
    case ModuleId.Rudder: return d.tail * 0.32;
    case ModuleId.CablePitch:
    case ModuleId.CableRoll:
    case ModuleId.CableYaw: return 14;
    case ModuleId.GearLeft:
    case ModuleId.GearRight: return d.wing * 0.25;
    default: return 60;
  }
}

export function createDamageState(
  spec: AircraftSpec, entityId: number, team: number, ownerId: number, seed = 1,
): AircraftDamageState {
  const hp = new Float32Array(MODULE_COUNT);
  const hpMax = new Float32Array(MODULE_COUNT);
  for (let m = 0; m < MODULE_COUNT; m++) {
    const v = moduleHp(spec, m as ModuleId);
    hp[m] = v; hpMax[m] = v;
  }
  return {
    entityId, specId: spec.id, team, ownerId,
    hp, hpMax, out: new Uint8Array(MODULE_COUNT),
    bits: 0,
    enginePower: 1, oil: 1, oilLeak: 0, coolant: 1, coolantLeak: 0,
    engineTemp: 0, engineSeized: false,
    fuelKg: spec.damage.fuel, fuelMaxKg: spec.damage.fuel, fuelLeak: 0,
    selfSealing: spec.damage.selfSealing,
    spar: Float32Array.from([1, 1]),
    wingOff: [false, false],
    tailOff: false,
    ctlPitch: 1, ctlRoll: 1, ctlYaw: 1,
    biasPitch: 0, biasRoll: 0, biasYaw: 0,
    pilotHp: 100, pilotKo: 0, pilotDead: false, pilotBailed: false,
    cookoff: Float32Array.from([-1, -1]),
    fires: [],
    destroyed: false, killer: 0, killerEntity: 0,
    lastHitTime: 0, totalDamage: 0,
    rng: seedRng(seed ^ Math.imul(entityId, 2654435761)),
  };
}

/** Reset a state for respawn without reallocating it. */
export function resetDamageState(st: AircraftDamageState, spec: AircraftSpec): void {
  for (let m = 0; m < MODULE_COUNT; m++) {
    st.hp[m] = st.hpMax[m] = moduleHp(spec, m as ModuleId);
    st.out[m] = 0;
  }
  st.bits = 0;
  st.enginePower = 1; st.oil = 1; st.oilLeak = 0; st.coolant = 1; st.coolantLeak = 0;
  st.engineTemp = 0; st.engineSeized = false;
  st.fuelKg = st.fuelMaxKg = spec.damage.fuel;
  st.fuelLeak = 0; st.selfSealing = spec.damage.selfSealing;
  st.spar[0] = st.spar[1] = 1;
  st.wingOff[0] = st.wingOff[1] = false;
  st.tailOff = false;
  st.ctlPitch = st.ctlRoll = st.ctlYaw = 1;
  st.biasPitch = st.biasRoll = st.biasYaw = 0;
  st.pilotHp = 100; st.pilotKo = 0; st.pilotDead = false; st.pilotBailed = false;
  st.cookoff[0] = st.cookoff[1] = -1;
  st.fires.length = 0;
  st.destroyed = false; st.killer = 0; st.killerEntity = 0;
  st.lastHitTime = 0; st.totalDamage = 0;
  st.rng = seedRng(st.entityId ^ 0x9e3779b9);
}

function specOf(st: AircraftDamageState): AircraftSpec {
  return AIRCRAFT_BY_ID[st.specId] ?? AIRCRAFT_BY_ID[Object.keys(AIRCRAFT_BY_ID)[0]];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const _events: DamageEvent[] = [];

function ev(
  out: DamageEvent[], st: AircraftDamageState, kind: DamageEventKind,
  module: ModuleId | -1, by: number, byEntity: number, severity: number,
  x: number, y: number, z: number, time: number,
): void {
  out.push({ kind, entityId: st.entityId, module, by, byEntity, severity, x, y, z, time });
}

// ---------------------------------------------------------------------------
// applyDamage
// ---------------------------------------------------------------------------

const LEFT_MODULES = new Set<ModuleId>([
  ModuleId.WingLeft, ModuleId.SparLeft, ModuleId.FuelLeft,
  ModuleId.AmmoLeft, ModuleId.AileronLeft, ModuleId.GearLeft,
]);

/** Which wing (0 = left, 1 = right, -1 = neither) a module belongs to. */
export function wingSideOf(m: ModuleId): number {
  if (LEFT_MODULES.has(m)) return 0;
  switch (m) {
    case ModuleId.WingRight:
    case ModuleId.SparRight:
    case ModuleId.FuelRight:
    case ModuleId.AmmoRight:
    case ModuleId.AileronRight:
    case ModuleId.GearRight: return 1;
    default: return -1;
  }
}

/**
 * Apply one resolved hit. Returns the list of consequential events; the array
 * is reused unless the caller supplies its own, so drain it before the next
 * call.
 */
export function applyDamage(
  st: AircraftDamageState, hit: HitResult, out: DamageEvent[] = _events,
): DamageEvent[] {
  if (out === _events) out.length = 0;
  if (st.destroyed) return out;
  if (hit.targetId !== st.entityId) return out;
  if (hit.module < 0 || hit.module >= MODULE_COUNT) return out;
  const m = hit.module as ModuleId;

  const t = hit.time;
  const by = hit.ownerId, byE = hit.shooterEntity;
  st.lastHitTime = t;

  // A pure ricochet off armour is worth reporting even though it does almost
  // nothing — the "clang" is important feedback.
  if (hit.type === 'ricochet') {
    ev(out, st, DamageEventKind.Ricochet, m, by, byE, hit.angleDeg, hit.px, hit.py, hit.pz, t);
  } else if (hit.type === 'stop' && hit.effectiveArmourMm > 2) {
    ev(out, st, DamageEventKind.ArmourStopped, m, by, byE, hit.effectiveArmourMm, hit.px, hit.py, hit.pz, t);
  }

  let dmg = hit.damage;
  if (dmg <= 0 && hit.ignite <= 0) { syncBits(st); return out; }

  // Armour that stopped the round still transmits some spall and shock, but
  // the module behind it is largely spared.
  if (hit.type === 'stop' && hit.effectiveArmourMm > 2) dmg *= 0.22;
  if (hit.type === 'ricochet') dmg *= 0.6;

  st.totalDamage += dmg;
  applyModuleDamage(st, m, dmg, by, byE, hit.px, hit.py, hit.pz, t, out);

  // --- module-specific consequences ------------------------------------
  const frac = dmg / Math.max(1, st.hpMax[m]);

  switch (m) {
    case ModuleId.Engine: {
      // Every hit costs manifold pressure. A shattered cylinder is permanent.
      const loss = clamp(frac * 1.25, 0, 0.9);
      st.enginePower = clamp(st.enginePower - loss, 0, 1);
      ev(out, st, DamageEventKind.EnginePowerLoss, m, by, byE, st.enginePower, hit.px, hit.py, hit.pz, t);
      if (st.rng.next() < clamp(frac * 2.2, 0.05, 0.85)) {
        st.oilLeak += lerp(0.012, 0.09, clamp(frac * 2, 0, 1));
        st.bits |= DamageBits.OilLeak;
        ev(out, st, DamageEventKind.OilLeak, m, by, byE, st.oilLeak, hit.px, hit.py, hit.pz, t);
      }
      if (st.rng.next() < clamp(frac * 1.6, 0.03, 0.7)) {
        st.coolantLeak += lerp(0.02, 0.14, clamp(frac * 2, 0, 1));
        ev(out, st, DamageEventKind.CoolantLeak, m, by, byE, st.coolantLeak, hit.px, hit.py, hit.pz, t);
      }
      break;
    }
    case ModuleId.OilTank: {
      st.oilLeak += lerp(0.02, 0.16, clamp(frac * 2.5, 0, 1));
      st.bits |= DamageBits.OilLeak;
      ev(out, st, DamageEventKind.OilLeak, m, by, byE, st.oilLeak, hit.px, hit.py, hit.pz, t);
      break;
    }
    case ModuleId.Radiator: {
      st.coolantLeak += lerp(0.05, 0.30, clamp(frac * 2.5, 0, 1));
      ev(out, st, DamageEventKind.CoolantLeak, m, by, byE, st.coolantLeak, hit.px, hit.py, hit.pz, t);
      break;
    }
    case ModuleId.FuelFuselage:
    case ModuleId.FuelLeft:
    case ModuleId.FuelRight: {
      // Self-sealing rubber closes a rifle-calibre hole almost completely; a
      // 20 mm hole is beyond it.
      const holeMm = Math.max(hit.calibre, 8);
      const sealed = st.selfSealing ? clamp(1 - (holeMm - 8) / 22, 0, 1) : 0;
      const leak = (0.05 + 0.02 * holeMm) * (1 - sealed * 0.88);
      if (leak > 0.01) {
        st.fuelLeak += leak;
        st.bits |= DamageBits.FuelLeak;
        ev(out, st, DamageEventKind.FuelLeak, m, by, byE, leak, hit.px, hit.py, hit.pz, t);
      }
      break;
    }
    case ModuleId.Pilot: {
      const wound = dmg * 1.35;
      st.pilotHp = Math.max(0, st.pilotHp - wound);
      st.bits |= DamageBits.PilotHit;
      ev(out, st, DamageEventKind.PilotHit, m, by, byE, wound, hit.px, hit.py, hit.pz, t);
      if (st.pilotHp <= 0) {
        st.pilotDead = true;
        st.bits |= DamageBits.PilotDead;
        ev(out, st, DamageEventKind.PilotDead, m, by, byE, 1, hit.px, hit.py, hit.pz, t);
        kill(st, by, byE, hit.px, hit.py, hit.pz, t, out);
      } else if (st.rng.next() < clamp(wound / 45, 0.08, 0.85)) {
        // Wounded but conscious-ish: a blackout of a few seconds, which at low
        // altitude is usually fatal anyway.
        st.pilotKo = Math.max(st.pilotKo, lerp(1.5, 9, clamp(wound / 60, 0, 1)));
        ev(out, st, DamageEventKind.PilotKnockedOut, m, by, byE, st.pilotKo, hit.px, hit.py, hit.pz, t);
      }
      break;
    }
    case ModuleId.AmmoLeft:
    case ModuleId.AmmoRight: {
      const side = m === ModuleId.AmmoLeft ? 0 : 1;
      // Detonation odds rise sharply with the energy dumped into the tray and
      // are far higher for incendiary rounds.
      let p = clamp(frac * 0.55, 0, 0.5);
      if (isIncendiaryAmmo(hit.ammo)) p *= 2.1;
      if (hit.heGrams > 0) p += clamp(hit.heGrams / 90, 0, 0.3);
      if (st.rng.next() < p) {
        ev(out, st, DamageEventKind.AmmoDetonation, m, by, byE, 1, hit.px, hit.py, hit.pz, t);
        // The belt going off takes the surrounding structure with it.
        const wing = side === 0 ? ModuleId.SparLeft : ModuleId.SparRight;
        applyModuleDamage(st, wing, st.hpMax[wing] * 1.5, by, byE, hit.px, hit.py, hit.pz, t, out);
        applyModuleDamage(st, side === 0 ? ModuleId.WingLeft : ModuleId.WingRight,
          st.hpMax[ModuleId.WingLeft] * 1.2, by, byE, hit.px, hit.py, hit.pz, t, out);
        ripWing(st, side, by, byE, hit.px, hit.py, hit.pz, t, out);
      } else {
        st.cookoff[side] = Math.max(st.cookoff[side], lerp(4, 12, st.rng.next()));
      }
      break;
    }
    case ModuleId.CablePitch: {
      severAxis(st, 'pitch', by, byE, hit.px, hit.py, hit.pz, t, out);
      break;
    }
    case ModuleId.CableRoll: {
      severAxis(st, 'roll', by, byE, hit.px, hit.py, hit.pz, t, out);
      break;
    }
    case ModuleId.CableYaw: {
      severAxis(st, 'yaw', by, byE, hit.px, hit.py, hit.pz, t, out);
      break;
    }
    case ModuleId.GearLeft:
    case ModuleId.GearRight: {
      if (st.out[m]) st.bits |= DamageBits.GearBroken;
      break;
    }
    default: break;
  }

  // --- ignition ---------------------------------------------------------
  if (hit.ignite > 0 && isFlammable(m) && !st.destroyed) {
    let p = hit.ignite;
    if (m === ModuleId.FuelLeft || m === ModuleId.FuelRight || m === ModuleId.FuelFuselage) {
      // A nearly empty tank is a bomb full of vapour; a full one is a heat
      // sink. Both are worse than a self-sealing one.
      const fill = clamp(st.fuelKg / Math.max(1, st.fuelMaxKg), 0, 1);
      p *= lerp(1.35, 0.75, fill);
      if (st.selfSealing) p *= 0.45;
    } else if (m === ModuleId.Engine || m === ModuleId.OilTank) {
      p *= 0.85;
    } else {
      p *= 0.35;
    }
    if (st.rng.next() < p) {
      if (igniteModule(st.fires, m, 0.3 + 0.4 * st.rng.next())) {
        ev(out, st, DamageEventKind.FireStarted, m, by, byE, 1, hit.px, hit.py, hit.pz, t);
      }
    }
  }

  checkStructure(st, by, byE, hit.px, hit.py, hit.pz, t, out);
  syncBits(st);
  return out;
}

/** Raw hit-point subtraction plus the destroyed-module transition. */
function applyModuleDamage(
  st: AircraftDamageState, m: ModuleId, dmg: number,
  by: number, byE: number, x: number, y: number, z: number, t: number,
  out: DamageEvent[],
): void {
  if (dmg <= 0) return;
  const before = st.hp[m];
  st.hp[m] = Math.max(0, before - dmg);
  ev(out, st, DamageEventKind.ModuleDamaged, m, by, byE, dmg, x, y, z, t);
  if (before > 0 && st.hp[m] <= 0) {
    st.out[m] = 1;
    ev(out, st, DamageEventKind.ModuleDestroyed, m, by, byE, 1, x, y, z, t);
    onModuleDestroyed(st, m, by, byE, x, y, z, t, out);
  }
}

function onModuleDestroyed(
  st: AircraftDamageState, m: ModuleId,
  by: number, byE: number, x: number, y: number, z: number, t: number,
  out: DamageEvent[],
): void {
  switch (m) {
    case ModuleId.Engine:
    case ModuleId.PropHub:
      st.enginePower = 0;
      st.engineSeized = true;
      st.bits |= DamageBits.Engine;
      ev(out, st, DamageEventKind.EngineSeized, m, by, byE, 1, x, y, z, t);
      break;
    case ModuleId.OilTank:
      st.oilLeak = Math.max(st.oilLeak, 0.35);
      break;
    case ModuleId.Radiator:
      st.coolantLeak = Math.max(st.coolantLeak, 0.5);
      break;
    case ModuleId.SparLeft: ripWing(st, 0, by, byE, x, y, z, t, out); break;
    case ModuleId.SparRight: ripWing(st, 1, by, byE, x, y, z, t, out); break;
    case ModuleId.WingLeft:
      // The skin can be shot away without the spar failing, but past a point
      // there is nothing left holding the spar's load path together.
      applyModuleDamage(st, ModuleId.SparLeft, st.hpMax[ModuleId.SparLeft] * 0.45, by, byE, x, y, z, t, out);
      break;
    case ModuleId.WingRight:
      applyModuleDamage(st, ModuleId.SparRight, st.hpMax[ModuleId.SparRight] * 0.45, by, byE, x, y, z, t, out);
      break;
    case ModuleId.TailBoom:
      st.tailOff = true;
      st.bits |= DamageBits.Tail;
      ev(out, st, DamageEventKind.StructuralFailure, m, by, byE, 1, x, y, z, t);
      kill(st, by, byE, x, y, z, t, out);
      break;
    case ModuleId.Elevator:
    case ModuleId.HStab:
      st.bits |= DamageBits.Elevator;
      severAxis(st, 'pitch', by, byE, x, y, z, t, out);
      break;
    case ModuleId.Rudder:
    case ModuleId.VStab:
      st.bits |= DamageBits.Rudder;
      severAxis(st, 'yaw', by, byE, x, y, z, t, out);
      break;
    case ModuleId.AileronLeft:
    case ModuleId.AileronRight:
      st.bits |= DamageBits.Aileron;
      st.ctlRoll = Math.min(st.ctlRoll, 0.45);
      break;
    case ModuleId.Fuselage:
      ev(out, st, DamageEventKind.StructuralFailure, m, by, byE, 1, x, y, z, t);
      kill(st, by, byE, x, y, z, t, out);
      break;
    case ModuleId.Pilot:
      if (!st.pilotDead) {
        st.pilotDead = true;
        st.bits |= DamageBits.PilotDead;
        kill(st, by, byE, x, y, z, t, out);
      }
      break;
    case ModuleId.GearLeft:
    case ModuleId.GearRight:
      st.bits |= DamageBits.GearBroken;
      break;
    default: break;
  }
}

function ripWing(
  st: AircraftDamageState, side: number,
  by: number, byE: number, x: number, y: number, z: number, t: number,
  out: DamageEvent[],
): void {
  if (st.wingOff[side]) return;
  st.wingOff[side] = true;
  st.bits |= DamageBits.WingRipped;
  st.bits |= side === 0 ? DamageBits.LeftWing : DamageBits.RightWing;
  // Everything mounted on that wing goes with it.
  const mods = side === 0
    ? [ModuleId.WingLeft, ModuleId.SparLeft, ModuleId.FuelLeft, ModuleId.AmmoLeft, ModuleId.AileronLeft, ModuleId.GearLeft]
    : [ModuleId.WingRight, ModuleId.SparRight, ModuleId.FuelRight, ModuleId.AmmoRight, ModuleId.AileronRight, ModuleId.GearRight];
  for (const mm of mods) { st.hp[mm] = 0; st.out[mm] = 1; }
  // ...along with any fire that was burning in it.
  for (let i = st.fires.length - 1; i >= 0; i--) {
    if (mods.indexOf(st.fires[i].module) >= 0) st.fires.splice(i, 1);
  }
  ev(out, st, DamageEventKind.WingRipped, side === 0 ? ModuleId.WingLeft : ModuleId.WingRight,
    by, byE, 1, x, y, z, t);
  // Losing a wing in flight is not survivable in a WWII fighter.
  kill(st, by, byE, x, y, z, t, out);
}

function severAxis(
  st: AircraftDamageState, axis: 'pitch' | 'roll' | 'yaw',
  by: number, byE: number, x: number, y: number, z: number, t: number,
  out: DamageEvent[],
): void {
  // A cut cable does not centre the surface — it leaves it wherever the
  // airload puts it, which is why a severed elevator so often means a
  // slow, uncontrollable pitch-down.
  const jam = (st.rng.next() * 2 - 1) * 0.35;
  if (axis === 'pitch') {
    if (st.ctlPitch === 0) return;
    st.ctlPitch = 0; st.biasPitch = jam;
  } else if (axis === 'roll') {
    if (st.ctlRoll === 0) return;
    st.ctlRoll = 0; st.biasRoll = jam;
  } else {
    if (st.ctlYaw === 0) return;
    st.ctlYaw = 0; st.biasYaw = jam;
  }
  st.bits |= DamageBits.ControlsSevered;
  ev(out, st, DamageEventKind.ControlSevered, -1, by, byE, jam, x, y, z, t);
}

function kill(
  st: AircraftDamageState, by: number, byE: number,
  x: number, y: number, z: number, t: number, out: DamageEvent[],
): void {
  if (st.destroyed) return;
  st.destroyed = true;
  st.killer = by;
  st.killerEntity = byE;
  st.bits |= DamageBits.Destroyed;
  ev(out, st, DamageEventKind.Destroyed, -1, by, byE, 1, x, y, z, t);
}

/** Cross-checks that can trip after any damage source. */
function checkStructure(
  st: AircraftDamageState, by: number, byE: number,
  x: number, y: number, z: number, t: number, out: DamageEvent[],
): void {
  st.spar[0] = clamp(st.hp[ModuleId.SparLeft] / Math.max(1, st.hpMax[ModuleId.SparLeft]), 0, 1);
  st.spar[1] = clamp(st.hp[ModuleId.SparRight] / Math.max(1, st.hpMax[ModuleId.SparRight]), 0, 1);
  if (!st.wingOff[0] && st.spar[0] <= 0) ripWing(st, 0, by, byE, x, y, z, t, out);
  if (!st.wingOff[1] && st.spar[1] <= 0) ripWing(st, 1, by, byE, x, y, z, t, out);
}

// ---------------------------------------------------------------------------
// Per-tick evolution
// ---------------------------------------------------------------------------

const _stepEvents: DamageEvent[] = [];
const _defaultStep: DamageStepInput = {
  time: 0, gLoad: 1, ias: 100, tas: 100, altitude: 0, sideslip: 0,
  throttle: 0.8, radiatorOpen: true, gLimit: 9, fuelBurn: 0, x: 0, y: 0, z: 0,
};

/**
 * Advance leaks, fires, overheating, cook-off timers, pilot recovery and
 * g-load induced structural failure. Call once per server tick per live
 * aircraft. Returns the events raised (array reused unless 'out' is given).
 */
export function stepDamage(
  st: AircraftDamageState, input: DamageStepInput, dt: number, out: DamageEvent[] = _stepEvents,
): DamageEvent[] {
  if (out === _stepEvents) out.length = 0;
  if (dt <= 0) return out;
  const inp = input ?? _defaultStep;
  const t = inp.time;
  const { x, y, z } = inp;

  if (st.destroyed) {
    // Keep fires burning on a wreck for the VFX layer, but stop the rest.
    if (st.fires.length) stepFires(st.fires, dt, inp.ias, inp.sideslip, st.rng, () => false);
    return out;
  }

  // --- fluids ---------------------------------------------------------
  if (st.oilLeak > 0) {
    st.oil = clamp(st.oil - st.oilLeak * dt, 0, 1);
    st.bits |= DamageBits.OilLeak;
  }
  if (st.coolantLeak > 0) st.coolant = clamp(st.coolant - st.coolantLeak * dt, 0, 1);
  if (st.fuelLeak > 0) {
    st.fuelKg = Math.max(0, st.fuelKg - st.fuelLeak * dt);
    st.bits |= DamageBits.FuelLeak;
  }
  if (inp.fuelBurn > 0 && !st.engineSeized) {
    st.fuelKg = Math.max(0, st.fuelKg - inp.fuelBurn * dt);
  }

  // --- engine thermal state -------------------------------------------
  if (!st.engineSeized) {
    // Heat generated by power setting, removed by coolant, oil film and ram
    // air. With no coolant an engine at full throttle cooks in about 40 s;
    // with no oil the bearings go faster still.
    const cooling = (0.35 + 0.65 * st.coolant) * (inp.radiatorOpen ? 1 : 0.62)
      * (0.45 + 0.55 * clamp(inp.tas / 110, 0, 1));
    const heat = 0.30 * (0.25 + 0.75 * inp.throttle) * st.enginePower;
    const oilPenalty = (1 - st.oil) * 0.55;
    st.engineTemp = clamp(st.engineTemp + (heat + oilPenalty - cooling * 0.42) * dt, 0, 2.2);

    if (st.engineTemp > 1) {
      // Running hot burns the engine out progressively.
      const rate = (st.engineTemp - 1) * 22;
      applyModuleDamage(st, ModuleId.Engine, rate * dt, st.killer, st.killerEntity, x, y, z, t, out);
      st.enginePower = clamp(st.enginePower - (st.engineTemp - 1) * 0.09 * dt, 0, 1);
    }
    if (st.oil <= 0.001 && !st.engineSeized) {
      // Dry bearings: a couple of seconds of grinding, then it stops.
      applyModuleDamage(st, ModuleId.Engine, st.hpMax[ModuleId.Engine] * 0.42 * dt, st.killer, st.killerEntity, x, y, z, t, out);
    }
    if (st.enginePower <= 0.02 && st.hp[ModuleId.Engine] <= 0 && !st.engineSeized) {
      st.engineSeized = true;
      ev(out, st, DamageEventKind.EngineSeized, ModuleId.Engine, st.killer, st.killerEntity, 1, x, y, z, t);
    }
  }
  if (st.fuelKg <= 0.01) {
    // Fuel starvation is not engine damage — restore-able if you had a second
    // tank — but from the flight model's point of view the power is gone.
    st.enginePower = 0;
  }

  // --- pilot ----------------------------------------------------------
  if (st.pilotKo > 0) {
    st.pilotKo -= dt;
    if (st.pilotKo <= 0) {
      st.pilotKo = 0;
      ev(out, st, DamageEventKind.PilotRecovered, ModuleId.Pilot, 0, 0, 1, x, y, z, t);
    }
  }
  if (st.pilotHp > 0 && st.pilotHp < 100 && !st.pilotDead) {
    // Slow bleed from an untreated wound. Enough to matter over a long flight
    // home, not enough to be an instant second death.
    const bleed = (1 - st.pilotHp / 100) * 0.55;
    st.pilotHp = Math.max(0, st.pilotHp - bleed * dt);
    if (st.pilotHp <= 0) {
      st.pilotDead = true;
      st.bits |= DamageBits.PilotDead;
      ev(out, st, DamageEventKind.PilotDead, ModuleId.Pilot, st.killer, st.killerEntity, 1, x, y, z, t);
      kill(st, st.killer, st.killerEntity, x, y, z, t, out);
    }
  }

  // --- ammunition cook-off --------------------------------------------
  for (let s = 0; s < 2; s++) {
    if (st.cookoff[s] > 0) {
      st.cookoff[s] -= dt;
      if (st.cookoff[s] <= 0) {
        st.cookoff[s] = -1;
        const mod = s === 0 ? ModuleId.AmmoLeft : ModuleId.AmmoRight;
        if (st.rng.next() < 0.45) {
          ev(out, st, DamageEventKind.AmmoDetonation, mod, st.killer, st.killerEntity, 1, x, y, z, t);
          ripWing(st, s, st.killer, st.killerEntity, x, y, z, t, out);
        }
      }
    }
  }

  // --- fire ------------------------------------------------------------
  if (st.fires.length > 0) {
    const res = stepFires(st.fires, dt, inp.ias, inp.sideslip, st.rng,
      (m) => st.hp[m] > 0 && !isDetached(st, m));
    for (let m = 0; m < MODULE_COUNT; m++) {
      const d = res.damage[m];
      if (d > 0 && !isDetached(st, m as ModuleId)) {
        applyModuleDamage(st, m as ModuleId, d, st.killer, st.killerEntity, x, y, z, t, out);
      }
    }
    for (const m of res.spread) ev(out, st, DamageEventKind.FireSpread, m, st.killer, st.killerEntity, 1, x, y, z, t);
    for (const m of res.extinguished) ev(out, st, DamageEventKind.FireOut, m, 0, 0, 1, x, y, z, t);
    // Fire eats fuel and cooks the engine bay.
    if (findFire(st.fires, ModuleId.Engine)) st.engineTemp = Math.min(2.2, st.engineTemp + 0.5 * dt);
    st.fuelKg = Math.max(0, st.fuelKg - 0.35 * st.fires.length * dt);
  }
  if (findFire(st.fires, ModuleId.Engine)) st.bits |= DamageBits.EngineFire;
  else st.bits &= ~DamageBits.EngineFire;

  // --- structural failure under g --------------------------------------
  // A spar with holes in it does not fail at the book limit any more. This is
  // the mechanism that makes a wing hit *matter* even when nothing visibly
  // broke: the aircraft flies fine until the pilot pulls, and then it doesn't.
  const gAbs = Math.abs(inp.gLoad);
  for (let s = 0; s < 2; s++) {
    if (st.wingOff[s]) continue;
    const integrity = st.spar[s];
    const limit = inp.gLimit * (0.30 + 0.70 * integrity);
    if (gAbs > limit) {
      const over = (gAbs - limit) / Math.max(1, limit);
      const sparMod = s === 0 ? ModuleId.SparLeft : ModuleId.SparRight;
      // Overstress damage is superlinear — a small exceedance is survivable,
      // a big one folds the wing immediately.
      applyModuleDamage(st, sparMod, st.hpMax[sparMod] * over * over * 7 * dt,
        st.killer, st.killerEntity, x, y, z, t, out);
    }
  }
  checkStructure(st, st.killer, st.killerEntity, x, y, z, t, out);
  syncBits(st);
  return out;
}

function isDetached(st: AircraftDamageState, m: ModuleId): boolean {
  const side = wingSideOf(m);
  if (side >= 0) return st.wingOff[side];
  if (st.tailOff) {
    return m === ModuleId.TailBoom || m === ModuleId.HStab || m === ModuleId.VStab
      || m === ModuleId.Elevator || m === ModuleId.Rudder;
  }
  return false;
}

// ---------------------------------------------------------------------------
// DamageBits mirror
// ---------------------------------------------------------------------------

/** Recompute the replicated DamageBits from the full state. */
export function syncBits(st: AircraftDamageState): number {
  let b = st.bits & (DamageBits.PilotHit | DamageBits.PilotDead
    | DamageBits.FuelLeak | DamageBits.OilLeak | DamageBits.ControlsSevered
    | DamageBits.GearBroken | DamageBits.Destroyed | DamageBits.WingRipped);

  if (st.hp[ModuleId.WingLeft] < st.hpMax[ModuleId.WingLeft] * 0.55 || st.wingOff[0]) b |= DamageBits.LeftWing;
  if (st.hp[ModuleId.WingRight] < st.hpMax[ModuleId.WingRight] * 0.55 || st.wingOff[1]) b |= DamageBits.RightWing;
  if (st.hp[ModuleId.TailBoom] < st.hpMax[ModuleId.TailBoom] * 0.6 || st.tailOff) b |= DamageBits.Tail;
  if (st.out[ModuleId.Rudder] || st.out[ModuleId.VStab]) b |= DamageBits.Rudder;
  if (st.out[ModuleId.Elevator] || st.out[ModuleId.HStab]) b |= DamageBits.Elevator;
  if (st.out[ModuleId.AileronLeft] || st.out[ModuleId.AileronRight]) b |= DamageBits.Aileron;
  if (st.hp[ModuleId.Engine] < st.hpMax[ModuleId.Engine] * 0.7 || st.engineSeized) b |= DamageBits.Engine;
  if (findFire(st.fires, ModuleId.Engine) || findFire(st.fires, ModuleId.OilTank)) b |= DamageBits.EngineFire;
  if (st.destroyed) b |= DamageBits.Destroyed;

  st.bits = b;
  return b;
}

/** Overall structural condition 0..1, for the replicated 'health' byte. */
export function healthFraction(st: AircraftDamageState): number {
  if (st.destroyed) return 0;
  // Weighted toward the things that actually keep you flying.
  const w: [ModuleId, number][] = [
    [ModuleId.Fuselage, 3], [ModuleId.WingLeft, 2], [ModuleId.WingRight, 2],
    [ModuleId.SparLeft, 2], [ModuleId.SparRight, 2], [ModuleId.TailBoom, 2],
    [ModuleId.Engine, 2], [ModuleId.HStab, 1], [ModuleId.VStab, 1],
  ];
  let num = 0, den = 0;
  for (const [m, k] of w) {
    num += k * clamp(st.hp[m] / Math.max(1, st.hpMax[m]), 0, 1);
    den += k;
  }
  const struct = num / den;
  const crew = st.pilotDead ? 0 : clamp(st.pilotHp / 100, 0, 1);
  return clamp(Math.min(struct, 0.35 + 0.65 * crew), 0, 1);
}

// ---------------------------------------------------------------------------
// computeDamageEffects
// ---------------------------------------------------------------------------

const _fx = newDamageEffects();

/**
 * Translate the damage state into the modifiers the flight model consumes.
 * The returned object is reused; copy it if you need to keep it.
 */
export function computeDamageEffects(
  st: AircraftDamageState, out: DamageEffects = _fx,
): DamageEffects {
  const spec = specOf(st);
  const fx = out;

  // --- powerplant -----------------------------------------------------
  fx.engineSeized = st.engineSeized;
  const engFrac = clamp(st.hp[ModuleId.Engine] / Math.max(1, st.hpMax[ModuleId.Engine]), 0, 1);
  const propFrac = clamp(st.hp[ModuleId.PropHub] / Math.max(1, st.hpMax[ModuleId.PropHub]), 0, 1);
  let power = st.enginePower * (0.25 + 0.75 * engFrac);
  // Losing coolant or oil does not stop the engine immediately, it just means
  // it will not make rated power and will not do it for long.
  power *= clamp(0.55 + 0.45 * st.coolant, 0, 1);
  power *= clamp(0.65 + 0.35 * st.oil, 0, 1);
  power *= clamp(0.35 + 0.65 * propFrac, 0, 1);
  if (st.fuelKg <= 0.01) power = 0;
  if (st.engineSeized) power = 0;
  fx.powerScale = clamp(power, 0, 1);
  fx.rpmScale = st.engineSeized ? 0 : clamp(0.35 + 0.65 * fx.powerScale, 0, 1);

  // --- drag -----------------------------------------------------------
  let cd = 0;
  // Every shot-out module is a hole or a missing fairing.
  const skinLoss =
    (1 - st.hp[ModuleId.WingLeft] / Math.max(1, st.hpMax[ModuleId.WingLeft])) +
    (1 - st.hp[ModuleId.WingRight] / Math.max(1, st.hpMax[ModuleId.WingRight])) +
    (1 - st.hp[ModuleId.Fuselage] / Math.max(1, st.hpMax[ModuleId.Fuselage])) +
    (1 - st.hp[ModuleId.TailBoom] / Math.max(1, st.hpMax[ModuleId.TailBoom]));
  cd += skinLoss * 0.0042;
  // A seized engine is a huge flat plate: the prop stops and acts as a disc.
  if (st.engineSeized) cd += 0.028;
  else if (fx.powerScale < 0.15) cd += 0.012;   // windmilling
  if (st.out[ModuleId.GearLeft] || st.out[ModuleId.GearRight]) cd += spec.aero.gearCd * 0.5;
  if (st.wingOff[0] || st.wingOff[1]) cd += 0.035;
  fx.cd0Add = cd;

  // --- lift and asymmetry ----------------------------------------------
  const wl = st.wingOff[0] ? 0 : clamp(0.45 + 0.55 * st.hp[ModuleId.WingLeft] / Math.max(1, st.hpMax[ModuleId.WingLeft]), 0, 1);
  const wr = st.wingOff[1] ? 0 : clamp(0.45 + 0.55 * st.hp[ModuleId.WingRight] / Math.max(1, st.hpMax[ModuleId.WingRight]), 0, 1);
  fx.clScale = clamp((wl + wr) * 0.5, 0, 1);
  // Asymmetric lift: the surviving wing rolls the aircraft toward the dead one.
  // Positive = roll right, so a dead *left* wing gives a negative moment.
  fx.rollMomentAdd = (wl - wr) * -0.16;
  // Asymmetric drag from a missing wing or a hanging gear leg.
  let yaw = 0;
  if (st.wingOff[0]) yaw -= 0.05;
  if (st.wingOff[1]) yaw += 0.05;
  if (st.out[ModuleId.GearLeft] !== st.out[ModuleId.GearRight]) {
    yaw += st.out[ModuleId.GearLeft] ? -0.018 : 0.018;
  }
  fx.yawMomentAdd = yaw;
  fx.pitchMomentAdd = st.out[ModuleId.Elevator] ? -0.05 : 0;
  if (st.tailOff) fx.pitchMomentAdd -= 0.22;

  // --- control authority -----------------------------------------------
  const ail = 0.5 * (
    (st.out[ModuleId.AileronLeft] ? 0 : clamp(st.hp[ModuleId.AileronLeft] / Math.max(1, st.hpMax[ModuleId.AileronLeft]), 0, 1)) +
    (st.out[ModuleId.AileronRight] ? 0 : clamp(st.hp[ModuleId.AileronRight] / Math.max(1, st.hpMax[ModuleId.AileronRight]), 0, 1)));
  const elev = st.tailOff ? 0
    : Math.min(
      clamp(st.hp[ModuleId.Elevator] / Math.max(1, st.hpMax[ModuleId.Elevator]), 0, 1),
      0.35 + 0.65 * clamp(st.hp[ModuleId.HStab] / Math.max(1, st.hpMax[ModuleId.HStab]), 0, 1));
  const rud = st.tailOff ? 0
    : Math.min(
      clamp(st.hp[ModuleId.Rudder] / Math.max(1, st.hpMax[ModuleId.Rudder]), 0, 1),
      0.35 + 0.65 * clamp(st.hp[ModuleId.VStab] / Math.max(1, st.hpMax[ModuleId.VStab]), 0, 1));

  fx.rollAuthority = clamp(st.ctlRoll * ail * (st.wingOff[0] || st.wingOff[1] ? 0.25 : 1), 0, 1);
  fx.pitchAuthority = clamp(st.ctlPitch * elev, 0, 1);
  fx.yawAuthority = clamp(st.ctlYaw * rud, 0, 1);
  fx.pitchBias = st.biasPitch;
  fx.rollBias = st.biasRoll;
  fx.yawBias = st.biasYaw;

  // --- structure --------------------------------------------------------
  const weakest = Math.min(st.spar[0], st.spar[1]);
  fx.gLimitScale = clamp(0.30 + 0.70 * weakest, 0.2, 1);
  fx.rollInertiaScale = (st.wingOff[0] || st.wingOff[1]) ? 0.45 : 1;

  // --- mass and balance --------------------------------------------------
  const wingMass = spec.aero.mass * 0.085;
  let dm = st.fuelKg - st.fuelMaxKg;
  let cgx = 0;
  if (st.wingOff[0]) { dm -= wingMass; cgx += spec.aero.span * 0.11; }
  if (st.wingOff[1]) { dm -= wingMass; cgx -= spec.aero.span * 0.11; }
  if (st.tailOff) {
    const tailMass = spec.aero.mass * 0.045;
    dm -= tailMass;
    fx.cgShiftZ = spec.geom.length * 0.10;
  } else fx.cgShiftZ = 0;
  fx.massDelta = dm;
  fx.cgShiftX = cgx;

  // --- crew --------------------------------------------------------------
  fx.pilotControl = (st.pilotDead || st.pilotBailed || st.pilotKo > 0) ? 0 : 1;

  // --- presentation ------------------------------------------------------
  fx.fireIntensity = maxFireIntensity(st.fires);
  fx.smokeBlack = clamp((1 - st.oil) * 0.8 + (1 - engFrac) * 0.6 + fx.fireIntensity * 0.5, 0, 1);
  fx.smokeWhite = clamp((1 - st.coolant) * 0.9 + (st.fuelLeak > 0 ? 0.35 : 0), 0, 1);

  return fx;
}

// ---------------------------------------------------------------------------
// Queries used by the HUD, the killfeed and the AI
// ---------------------------------------------------------------------------

/** Human-readable reason the aircraft went down; '' if it is still flying. */
export function killReason(st: AircraftDamageState): string {
  if (!st.destroyed) return '';
  if (st.wingOff[0] || st.wingOff[1]) return 'wing torn off';
  if (st.tailOff) return 'tail shot away';
  if (st.pilotDead) return 'pilot killed';
  if (st.fires.length > 0) return 'burned';
  if (st.hp[ModuleId.Fuselage] <= 0) return 'airframe destroyed';
  return 'destroyed';
}

/** Is this aircraft flyable at all? Used by the AI to decide to bail out. */
export function isFlyable(st: AircraftDamageState): boolean {
  if (st.destroyed || st.pilotDead) return false;
  if (st.wingOff[0] || st.wingOff[1] || st.tailOff) return false;
  if (st.ctlPitch === 0 && st.ctlRoll === 0) return false;
  return true;
}

/** Seconds of burning so far — the HUD counts this down as your survival odds. */
export function fireBurnTime(st: AircraftDamageState): number {
  return longestBurn(st.fires);
}

export type { FireState };
