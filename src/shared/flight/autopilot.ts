/**
 * A compact rate-following autopilot built on top of the flight model.
 *
 * It exists for three reasons and all three are load-bearing:
 *
 *  - the trim solver needs something that can fly the aircraft to a steady
 *    state so the resulting control positions *are* the trim;
 *  - the self-test needs something that can fly a circuit, a take-off and a
 *    landing without a human;
 *  - the AI subsystem needs an inner loop it can steer with high-level goals
 *    instead of reinventing pitch/bank/throttle control.
 *
 * The structure is the conventional cascade: outer loops produce an attitude
 * demand, inner loops close on body rates. Everything is deterministic and
 * allocation-free apart from the small state object.
 */

import { clamp } from '../math';
import { type InputFrame, InputBits } from '../protocol';
import type { AircraftSpec } from '../aircraft';
import type { FlightState } from './types';

export interface AutopilotGoal {
  /** Hold this altitude, m ASL. Ignored if 'vs' or 'pitch' is set. */
  altitude?: number;
  /** Hold this vertical speed, m/s. Ignored if 'pitch' is set. */
  vs?: number;
  /** Hold this pitch attitude, rad. */
  pitch?: number;
  /** Hold this heading, rad. Ignored if 'bank' is set. */
  heading?: number;
  /** Hold this bank angle, rad. */
  bank?: number;
  /** Hold this indicated airspeed, m/s. Ignored if 'throttle' is set. */
  speed?: number;
  /** Fixed throttle, 0..1. */
  throttle?: number;
  /** Maximum bank the outer loop will command, rad. */
  maxBank?: number;
  /** Maximum load factor the pitch loop will pull. */
  maxG?: number;
  /** Extra input bits to OR into the produced frame. */
  bits?: number;
  /** Direct stick overrides (used by the self-test to fly manoeuvres). */
  stickPitch?: number;
  stickRoll?: number;
  stickYaw?: number;
  /** Disable the automatic turn coordinator. */
  noCoordinate?: boolean;
}

export interface Autopilot {
  thrI: number;
  pitchI: number;
  yawI: number;
  frame: InputFrame;
}

export function newAutopilot(): Autopilot {
  return {
    thrI: 0.5, pitchI: 0, yawI: 0,
    frame: { seq: 0, dt: 0, pitch: 0, roll: 0, yaw: 0, throttle: 0.5, bits: 0, aimX: 0, aimY: 0 },
  };
}

const wrapPi = (a: number): number => {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
};

/** Produce one input frame. The returned object is reused — do not retain it. */
export function autopilotStep(
  ap: Autopilot, st: FlightState, spec: AircraftSpec, goal: AutopilotGoal, dt: number,
): InputFrame {
  const f = ap.frame;
  f.seq = (f.seq + 1) & 0xffff;
  f.dt = dt;
  f.bits = goal.bits ?? 0;

  const maxBank = goal.maxBank ?? 1.05;
  const maxG = goal.maxG ?? 4.0;
  const V = Math.max(st.tas, 12);

  // ---- lateral -----------------------------------------------------------
  let bankCmd = 0;
  if (goal.bank !== undefined) {
    bankCmd = clamp(goal.bank, -maxBank, maxBank);
  } else if (goal.heading !== undefined) {
    const err = wrapPi(goal.heading - st.heading);
    bankCmd = clamp(err * 1.35, -maxBank, maxBank);
  }
  let rollIn: number;
  if (goal.stickRoll !== undefined) {
    rollIn = goal.stickRoll;
  } else {
    const bankErr = wrapPi(bankCmd - st.rollAngle);
    const rateCmd = clamp(bankErr * 1.9, -2.2, 2.2);
    rollIn = clamp((rateCmd - st.rollRate) * 0.85, -1, 1);
  }

  // ---- longitudinal ------------------------------------------------------
  let pitchIn: number;
  if (goal.stickPitch !== undefined) {
    pitchIn = goal.stickPitch;
  } else {
    let pitchCmd: number;
    if (goal.pitch !== undefined) {
      pitchCmd = goal.pitch;
    } else {
      let vsCmd: number;
      if (goal.vs !== undefined) vsCmd = goal.vs;
      else if (goal.altitude !== undefined) vsCmd = clamp((goal.altitude - st.altitude) * 0.32, -22, 22);
      else vsCmd = 0;
      const gammaCmd = Math.asin(clamp(vsCmd / V, -0.55, 0.55));
      // Attitude = flight path + alpha, so the loop does not fight the trim.
      pitchCmd = gammaCmd + clamp(st.alpha, -0.25, 0.35);
    }
    // Bank costs lift; feed it forward instead of waiting for the altitude
    // error to build.
    const bankComp = clamp(1 / Math.max(Math.cos(clamp(st.rollAngle, -1.3, 1.3)), 0.35) - 1, 0, 2);
    const attErr = clamp(pitchCmd - st.pitchAngle, -0.6, 0.6);
    let rateCmd = clamp(attErr * 1.7, -1.1, 1.1) + bankComp * 0.22;
    // Never ask for more than the g budget allows.
    const rateLimit = (maxG * 9.80665) / V;
    rateCmd = clamp(rateCmd, -rateLimit * 0.5, rateLimit);
    const rateErr = rateCmd - st.pitchRate;
    ap.pitchI = clamp(ap.pitchI + rateErr * 0.55 * dt, -0.7, 0.7);
    pitchIn = clamp(rateErr * 1.5 + ap.pitchI, -1, 1);
    // Do not drive the wing past the stall to hold an altitude.
    if (st.alpha > spec.aero.stallAlpha * 0.94 && pitchIn > 0) pitchIn *= 0.15;
  }

  // ---- directional -------------------------------------------------------
  let yawIn: number;
  if (goal.stickYaw !== undefined) {
    yawIn = goal.stickYaw;
  } else if (goal.noCoordinate) {
    yawIn = 0;
  } else {
    // Zero the sideslip. Positive beta means the nose is left of the flight
    // path, so it takes right rudder.
    const err = st.beta;
    ap.yawI = clamp(ap.yawI + err * 0.5 * dt, -0.5, 0.5);
    yawIn = clamp(err * 4.0 + ap.yawI - st.yawRate * 0.35, -1, 1);
  }

  // ---- throttle ----------------------------------------------------------
  let thr: number;
  if (goal.throttle !== undefined) {
    thr = clamp(goal.throttle, 0, 1);
    ap.thrI = thr;
  } else if (goal.speed !== undefined) {
    const err = goal.speed - st.ias;
    ap.thrI = clamp(ap.thrI + err * 0.035 * dt, 0, 1);
    thr = clamp(ap.thrI + err * 0.02, 0, 1);
  } else {
    thr = ap.thrI;
  }

  f.pitch = clamp(pitchIn, -1, 1);
  f.roll = clamp(rollIn, -1, 1);
  f.yaw = clamp(yawIn, -1, 1);
  f.throttle = thr;
  return f;
}

/** Convenience: an all-zero input frame (reused, do not retain). */
const _idle: InputFrame = {
  seq: 0, dt: 0, pitch: 0, roll: 0, yaw: 0, throttle: 0, bits: 0, aimX: 0, aimY: 0,
};
export function idleInput(throttle = 0, bits = 0): InputFrame {
  _idle.pitch = 0; _idle.roll = 0; _idle.yaw = 0;
  _idle.throttle = throttle; _idle.bits = bits;
  return _idle;
}

export { InputBits, wrapPi };
