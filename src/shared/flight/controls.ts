/**
 * Pilot inputs → control-surface commands, plus the secondary systems the
 * stick and the keyboard drive (flaps, gear, airbrakes, wheel brakes, WEP,
 * radiator).
 *
 * The important part is that a control *command* is not a control *deflection*.
 * Stick force scales with dynamic pressure, so above a reference speed a pilot
 * simply cannot hold full deflection. That single rule is what gives every
 * archetype its own character at speed — and because the reference speed is
 * derived from the archetype's own peak roll rate, the Bf 109's notorious
 * aileron stiffening and the A6M's even worse one come straight out of the
 * spec numbers rather than a special case.
 *
 * Above the critical Mach the same controls stiffen further and lose
 * effectiveness as the shock wave sits on the hinge line.
 */

import { clamp, damp } from '../math';
import { DamageBits, InputBits, type InputFrame } from '../protocol';
import { type DerivedSpec, type FlightState } from './types';

/** Flap detents: up / combat / landing. */
const FLAP_DETENTS = [0, 0.35, 1];

/** Actuator rates, fraction per second. */
const FLAP_RATE = 0.34;
const GEAR_RATE = 0.22;
const BRAKE_RATE = 2.4;

/** How sharply held stick force falls off above the reference speed. */
const STICK_EXP = 1.8;

function detentUp(v: number): number {
  for (let i = 0; i < FLAP_DETENTS.length; i++) if (FLAP_DETENTS[i] > v + 1e-3) return FLAP_DETENTS[i];
  return FLAP_DETENTS[FLAP_DETENTS.length - 1];
}
function detentDown(v: number): number {
  for (let i = FLAP_DETENTS.length - 1; i >= 0; i--) if (FLAP_DETENTS[i] < v - 1e-3) return FLAP_DETENTS[i];
  return 0;
}

/**
 * Available control authority for one axis: the fraction of full deflection a
 * pilot can actually hold. Unity up to 'vHeavy', then ∝ 1/V^1.8, then further
 * reduced by compressibility.
 */
export function axisAuthority(ias: number, vHeavy: number, mach: number, machCrit: number): number {
  let a = ias > vHeavy ? Math.pow(vHeavy / Math.max(ias, 1), STICK_EXP) : 1;
  if (mach > machCrit) a *= clamp(1 - 2.4 * (mach - machCrit), 0.22, 1);
  return clamp(a, 0.05, 1);
}

/** Consume one input frame: systems, trim, damage gating and authority. */
export function updateControls(
  st: FlightState, d: DerivedSpec, input: InputFrame, dt: number,
): void {
  const bits = input.bits | 0;
  const rising = bits & ~st.prevBits;
  st.prevBits = bits;
  const dmg = st.dmg;

  // ---- discrete systems --------------------------------------------------
  if (rising & InputBits.GearToggle) st.gearTarget = st.gearTarget > 0.5 ? 0 : 1;
  if (rising & InputBits.FlapsDown) st.flapsTarget = detentUp(st.flapsTarget);
  if (rising & InputBits.FlapsUp) st.flapsTarget = detentDown(st.flapsTarget);
  if (rising & InputBits.Boost) {
    if (st.wep) st.wep = false;
    else if (!st.wepLockout) st.wep = true;
  }
  if (rising & InputBits.Radiator) st.radiatorAuto = !st.radiatorAuto;

  st.airbrakeTarget = (bits & InputBits.BrakeAir) ? 1 : 0;
  const wantWheelBrake = (bits & InputBits.WheelBrake) ? 1 : 0;
  st.wheelBrake = damp(st.wheelBrake, wantWheelBrake, BRAKE_RATE, dt);

  st.throttleCmd = clamp(input.throttle, 0, 1);

  // ---- actuators ---------------------------------------------------------
  // Flaps and gear have real travel times and real speed limits. Exceeding
  // them bends the mechanism rather than politely refusing.
  if (st.flaps > 0.02 && st.ias > d.flapLimit) {
    const over = (st.ias - d.flapLimit) / d.flapLimit;
    st.health = Math.max(0, st.health - over * over * 0.6 * dt);
    if (over > 0.18) { st.flapsTarget = 0; st.damage |= DamageBits.Aileron; }
    else st.flapsTarget = Math.min(st.flapsTarget, 0.35);
  }
  st.flaps += clamp(st.flapsTarget - st.flaps, -FLAP_RATE * dt, FLAP_RATE * dt);
  st.flaps = clamp(st.flaps, 0, 1);

  if (!dmg.gearOk) st.gearTarget = Math.min(st.gearTarget, st.gear);
  if (st.gear > 0.05 && st.ias > d.gearLimit) {
    const over = (st.ias - d.gearLimit) / d.gearLimit;
    st.health = Math.max(0, st.health - over * over * 0.4 * dt);
    if (over > 0.22) st.damage |= DamageBits.GearBroken;
  }
  st.gear += clamp(st.gearTarget - st.gear, -GEAR_RATE * dt, GEAR_RATE * dt);
  st.gear = clamp(st.gear, 0, 1);

  st.airbrake += clamp(st.airbrakeTarget - st.airbrake, -1.6 * dt, 1.6 * dt);
  st.airbrake = clamp(st.airbrake, 0, 1);

  // ---- pilot demand ------------------------------------------------------
  // A wounded pilot is slower and weaker; an unconscious one lets go entirely.
  let ph = dmg.pilot;
  if (!st.pilotConscious) ph = 0;
  const pitchIn = clamp(input.pitch, -1, 1) * ph;
  const rollIn = clamp(input.roll, -1, 1) * ph;
  const yawIn = clamp(input.yaw, -1, 1) * ph;

  st.demandPitch = clamp(pitchIn + st.trimPitch, -1, 1);
  st.demandRoll = clamp(rollIn + st.trimRoll, -1, 1);
  st.demandYaw = clamp(yawIn + st.trimYaw, -1, 1);

  // ---- authority ---------------------------------------------------------
  const mc = d.spec.aero.machCrit;
  st.authPitch = axisAuthority(st.ias, d.vHeavyPitch, st.mach, mc) * dmg.elevator;
  st.authRoll = axisAuthority(st.ias, d.vHeavyRoll, st.mach, mc) * dmg.aileron;
  st.authYaw = axisAuthority(st.ias, d.vHeavyYaw, st.mach, mc) * dmg.rudder;

  // Control-surface command actually delivered. A little lag keeps the cables
  // and the visual deflection from snapping instantaneously.
  const lag = 26;
  st.ctlPitch = damp(st.ctlPitch, st.demandPitch * st.authPitch, lag, dt);
  st.ctlRoll = damp(st.ctlRoll, st.demandRoll * st.authRoll, lag, dt);
  st.ctlYaw = damp(st.ctlYaw, st.demandYaw * st.authYaw, lag, dt);

  // ---- tailwheel steering ------------------------------------------------
  // Effective while the tail is down; it washes out as the aircraft accelerates
  // and the rudder takes over.
  const steerFade = clamp(1 - (st.groundSpeed - 18) / 45, 0.12, 1);
  st.steer = damp(st.steer, clamp(input.yaw, -1, 1) * ph * steerFade, 12, dt);
}

/**
 * Rebuild the run-time damage multipliers from the wire 'DamageBits'. Keeping
 * this a pure function of the replicated bitfield is what lets the client
 * predict damaged flight exactly the way the server simulates it.
 */
export function updateDamageFactors(st: FlightState): void {
  const b = st.damage;
  const f = st.dmg;
  const ripped = (b & DamageBits.WingRipped) !== 0;
  const destroyed = (b & DamageBits.Destroyed) !== 0;

  f.wingLGone = ripped && (b & DamageBits.LeftWing) !== 0;
  f.wingRGone = ripped && (b & DamageBits.RightWing) !== 0;
  f.wingL = f.wingLGone ? 0 : (b & DamageBits.LeftWing) ? 0.66 : 1;
  f.wingR = f.wingRGone ? 0 : (b & DamageBits.RightWing) ? 0.66 : 1;
  f.extraDrag = ((b & DamageBits.LeftWing) ? 0.06 : 0) + ((b & DamageBits.RightWing) ? 0.06 : 0)
    + ((b & DamageBits.Tail) ? 0.05 : 0) + ((b & DamageBits.EngineFire) ? 0.04 : 0);

  f.tail = (b & DamageBits.Tail) ? 0.55 : 1;
  const severed = (b & DamageBits.ControlsSevered) !== 0 || destroyed;
  f.elevator = severed || (b & DamageBits.Elevator) ? 0 : f.tail;
  f.aileron = severed || (b & DamageBits.Aileron) ? 0 : 1;
  f.rudder = severed || (b & DamageBits.Rudder) ? 0 : 1;

  f.engineDead = destroyed || (b & DamageBits.Engine) !== 0;
  f.engine = f.engineDead ? 0 : (b & DamageBits.EngineFire) ? 0.6 : 1;

  f.pilot = (b & DamageBits.PilotDead) || destroyed ? 0 : (b & DamageBits.PilotHit) ? 0.55 : 1;
  f.gearOk = (b & DamageBits.GearBroken) === 0;
}

/** Nudge a trim axis. Exposed so the UI and the AI can share one code path. */
export function adjustTrim(st: FlightState, pitch: number, roll: number, yaw: number): void {
  st.trimPitch = clamp(st.trimPitch + pitch, -0.6, 0.6);
  st.trimRoll = clamp(st.trimRoll + roll, -0.4, 0.4);
  st.trimYaw = clamp(st.trimYaw + yaw, -0.5, 0.5);
}

/**
 * Slow "trim to the stick" assist. Off by default ('rate = 0'); the integrator
 * can enable it for arcade control modes or for AI aircraft that have no
 * business flying out of trim.
 */
export function autoTrim(st: FlightState, stickPitch: number, rate: number, dt: number): void {
  if (rate <= 0) return;
  st.trimPitch = clamp(st.trimPitch + clamp(stickPitch, -1, 1) * rate * dt, -0.6, 0.6);
}
