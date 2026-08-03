/**
 * The two limits that are not aerodynamic: what the airframe will take, and
 * what the pilot will take.
 *
 * **Structure.** Wings do not fail the instant the needle passes the limit —
 * they fail from accumulated overload. A fatigue term integrates the cube of
 * the overload ratio, so riding a little over the limit is survivable for a
 * while, a hard snatch above it is not, and repeated abuse eventually costs a
 * wing even at loads that were individually "fine". Above VNE the control
 * surfaces flutter, and flutter destroys hinges in seconds.
 *
 * **Pilot.** Blood does not leave the head instantly, and it does not come
 * back instantly either. A reserve accumulator with an onset rate proportional
 * to the overload and a slower recovery reproduces the real shape: a snap 7 g
 * pull is fine, holding 5 g for eight seconds is not, and once you have
 * greyed out it takes a few seconds of unloading to see again. Push far enough
 * and the pilot is out cold and the controls go slack — which is exactly the
 * behaviour that makes negative-g manoeuvres feel dangerous.
 */

import { clamp, smoothstep } from '../math';
import { DamageBits } from '../protocol';
import type { DerivedSpec, FlightState } from './types';

/** Sustained load above which cerebral blood pressure starts to fail, g. */
const G_GREY_ON = 3.6;
/** Seconds of reserve at one g above the onset threshold. */
const G_POS_TAU = 5.5;
/** Recovery rate of the positive-g reserve, per second. */
const G_POS_RECOVER = 0.42;
/** Negative-g tolerance is far lower and the onset is far faster. */
const G_RED_ON = 1.7;
const G_NEG_TAU = 2.6;
const G_NEG_RECOVER = 0.55;
/** Seconds of forced unconsciousness once the reserve is fully spent. */
const KO_TIME = 3.0;

export function updatePilot(st: FlightState, dt: number): void {
  const g = st.gLoad;

  // ---- positive g --------------------------------------------------------
  if (g > G_GREY_ON) st.gStrainPos += ((g - G_GREY_ON) / G_POS_TAU) * dt;
  else st.gStrainPos -= G_POS_RECOVER * dt;
  st.gStrainPos = clamp(st.gStrainPos, 0, 1.6);

  // ---- negative g --------------------------------------------------------
  if (g < -G_RED_ON) st.gStrainNeg += ((-g - G_RED_ON) / G_NEG_TAU) * dt;
  else st.gStrainNeg -= G_NEG_RECOVER * dt;
  st.gStrainNeg = clamp(st.gStrainNeg, 0, 1.6);

  st.blackout = smoothstep(0.30, 0.98, st.gStrainPos);
  st.redout = smoothstep(0.22, 0.90, st.gStrainNeg);

  // ---- consciousness -----------------------------------------------------
  if (st.gStrainPos >= 1.0 || st.gStrainNeg >= 1.0) st.koTimer = KO_TIME;
  else if (st.koTimer > 0) st.koTimer = Math.max(0, st.koTimer - dt);
  const dead = (st.damage & (DamageBits.PilotDead | DamageBits.Destroyed)) !== 0;
  st.pilotConscious = !dead && st.koTimer <= 0;

  if (st.blackout >= st.redout) {
    st.gEffect = st.blackout;
    st.gEffectSign = 1;
  } else {
    st.gEffect = st.redout;
    st.gEffectSign = -1;
  }
  if (!st.pilotConscious) st.gEffect = Math.max(st.gEffect, dead ? 1 : 0.92);
}

export function updateStructure(st: FlightState, d: DerivedSpec, dt: number): void {
  const aero = d.spec.aero;
  const mag = Math.abs(st.gLoad);
  if (mag > st.gPeak) st.gPeak = mag;

  // ---- spar fatigue ------------------------------------------------------
  // Negative g is far harder on a WWII wing structure than positive: the spar
  // caps are sized for the pull-up case.
  const effective = st.gLoad < 0 ? mag * 1.55 : mag;
  const ratio = effective / Math.max(aero.gLimit, 1);
  if (ratio > 0.85) {
    const over = ratio - 0.85;
    st.gFatigue += over * over * over * 25 * dt;
  } else {
    st.gFatigue = Math.max(0, st.gFatigue - 0.015 * dt);
  }
  // Existing wing damage weakens the spar it is attached to.
  if (st.damage & (DamageBits.LeftWing | DamageBits.RightWing)) st.gFatigue += 0.05 * dt * (ratio > 0.6 ? 1 : 0);

  if ((st.gFatigue >= 1 || ratio > 1.45) && !(st.damage & DamageBits.WingRipped)) {
    // The wing carrying the most load lets go first — deterministic, and it
    // means a wing lost in a rolling pull departs on the loaded side.
    const left = st.liftL >= st.liftR;
    st.damage |= DamageBits.WingRipped | (left ? DamageBits.LeftWing : DamageBits.RightWing);
    st.health = Math.max(0, st.health - 0.55);
    st.gFatigue = 1;
  }

  // ---- flutter -----------------------------------------------------------
  const vRatio = st.ias / Math.max(aero.vne, 1);
  st.flutter = smoothstep(0.97, 1.08, vRatio);
  if (st.flutter > 0) {
    st.flutterDamage += st.flutter * st.flutter * 0.5 * dt;
    st.health = Math.max(0, st.health - st.flutter * 0.02 * dt);
    if (st.flutterDamage >= 1) {
      // Whichever surface is working hardest is the one that departs.
      const p = Math.abs(st.ctlPitch), r = Math.abs(st.ctlRoll), y = Math.abs(st.ctlYaw);
      if (p >= r && p >= y) st.damage |= DamageBits.Elevator;
      else if (r >= y) st.damage |= DamageBits.Aileron;
      else st.damage |= DamageBits.Rudder;
      st.health = Math.max(0, st.health - 0.15);
      st.flutterDamage = 0.35;
    }
  } else {
    st.flutterDamage = Math.max(0, st.flutterDamage - 0.05 * dt);
  }

  // Flutter and structural distress are felt through the airframe.
  if (st.flutter > 0) st.buffet = Math.max(st.buffet, st.flutter * 0.85);
  if (ratio > 0.9) st.buffet = Math.max(st.buffet, clamp((ratio - 0.9) * 2.2, 0, 0.7));

  if (st.health <= 0) st.damage |= DamageBits.Destroyed;
}
