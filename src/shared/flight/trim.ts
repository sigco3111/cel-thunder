/**
 * Trim solver.
 *
 * Trim is an *equilibrium* problem, not a snapshot problem. The obvious
 * approach — fly the autopilot until it looks settled, then freeze whatever
 * control positions it happened to be holding — does not work, and the reason
 * is worth writing down because it cost a long debugging session:
 *
 *   The autopilot holds altitude with the elevator and speed with the
 *   throttle. It can therefore sit at zero vertical speed while carrying a
 *   real force imbalance, because its own feedback is cancelling it. Freeze
 *   the sticks at that instant and hand the aircraft back to a pilot who is
 *   holding them still, and the imbalance is suddenly unopposed. The result is
 *   an excited phugoid: a ~50 s oscillation that swaps 100 m of altitude for a
 *   few km/h of airspeed. The residual vertical speed at the moment of
 *   hand-over is ~0.01 m/s and tells you nothing at all.
 *
 * So this solves the real thing: full six-degree-of-freedom steady straight
 * and level flight. Six unknowns —
 *
 *   θ   pitch attitude          φ   bank angle
 *   δe  elevator trim           δa  aileron trim
 *   δr  rudder trim             τ   throttle
 *
 * — against six equilibrium conditions:
 *
 *   1..3  the three components of acceleration (vertical, along the flight
 *         path, and lateral) are zero
 *   4..6  the three body-axis angular accelerations are zero
 *
 * The lateral half is not optional decoration. A single-engined piston fighter
 * at cruise power carries a real propeller torque and a real slipstream swirl
 * over the fin; solve only the longitudinal problem and leave the aileron and
 * rudder trims at zero, and the aeroplane rolls off into a textbook spiral
 * divergence — 4° of bank after five seconds, 60° after ninety, and into the
 * ground before three minutes are up. The bank angle has to be an unknown too,
 * because cancelling the torque needs the classic wing-low solution: a degree
 * or so of bank held against a little rudder.
 *
 * The residuals are measured by *pinning* the aircraft at the exact target
 * condition, stepping the real integrator so that the stiff powerplant states
 * (shaft speed, blade pitch, manifold pressure, slipstream) converge for that
 * throttle and airspeed, and then reading the accelerations from one final
 * unpinned step. Damped Newton with a finite-difference Jacobian converges in
 * a handful of iterations.
 *
 * Because the residuals come from 'stepFlight' itself, the solution is always
 * exactly consistent with whatever the aerodynamics currently do — the same
 * property the old settle-and-freeze approach had, without the phugoid.
 */

import { q, qmul, qnorm, v3 } from '../math';
import type { AircraftSpec } from '../aircraft';
import { autopilotStep, newAutopilot } from './autopilot';
import { easToTas, isaDensity } from './atmosphere';
import { createFlightState, spawnInFlight, stepFlight } from './step';
import type { Environment, FlightState } from './types';
import type { InputFrame } from '../protocol';

export interface TrimOptions {
  /** Heading to trim on, rad. */
  heading?: number;
  /** Flap setting to trim with, 0..1. */
  flaps?: number;
  /** Gear position to trim with, 0..1. */
  gear?: number;
  /** Seconds of autopilot settling before the Newton solve. */
  settle?: number;
  /** Integration step, s. Keep at the tick rate for determinism. */
  dt?: number;
  /** Max Newton iterations. */
  iterations?: number;
}

export interface TrimResult {
  state: FlightState;
  /** Residual vertical speed one step after trimming, m/s. */
  residualVs: number;
  /** Residual airspeed drift one step after trimming, m/s. */
  residualIas: number;
  /**
   * Worst residual *acceleration*, m/s² — the honest measure of trim quality,
   * and the one to assert on. Below ~2e-3 the aircraft holds altitude
   * open-loop for minutes.
   */
  residualAccel: number;
  /** Worst residual angular acceleration, rad/s². */
  residualAlpha: number;
  /** Newton iterations actually used. */
  iterations: number;
  converged: boolean;
}

const N = 6;
type Vec6 = [number, number, number, number, number, number];

// --- scratch ---------------------------------------------------------------
const _qy = q();
const _qp = q();
const _qr = q();
const _qt = q();

/**
 * Force an aircraft into the exact condition being solved for: bank φ, pitch
 * attitude θ, on 'heading', velocity purely horizontal at 'tas', no rotation.
 */
function pin(
  st: FlightState, altitude: number, heading: number, theta: number, phi: number, tas: number,
): void {
  // Nose-up is a NEGATIVE rotation about body +X and right-wing-down is a
  // NEGATIVE rotation about body +Z (see the sign notes in types.ts), so the
  // Euler composition is yaw(+Y) · pitch(−X) · roll(−Z).
  const hy = heading * 0.5, hp = -theta * 0.5, hr = -phi * 0.5;
  _qy.x = 0; _qy.y = Math.sin(hy); _qy.z = 0; _qy.w = Math.cos(hy);
  _qp.x = Math.sin(hp); _qp.y = 0; _qp.z = 0; _qp.w = Math.cos(hp);
  _qr.x = 0; _qr.y = 0; _qr.z = Math.sin(hr); _qr.w = Math.cos(hr);
  qmul(_qp, _qr, _qt);
  qmul(_qy, _qt, st.rot);
  qnorm(st.rot);

  st.pos.y = altitude;
  st.vel.x = Math.sin(heading) * tas;
  st.vel.y = 0;
  st.vel.z = Math.cos(heading) * tas;
  st.omega.x = 0; st.omega.y = 0; st.omega.z = 0;
}

/**
 * Equilibrium residuals at a candidate trim point, written into 'out' as
 * [vertical, axial, lateral, ω̇x, ω̇y, ω̇z].
 */
function residuals(
  st: FlightState, spec: AircraftSpec, env: Environment,
  altitude: number, heading: number, tas: number,
  x: Vec6, inp: InputFrame, dt: number, maxSettle: number, out: Vec6,
): void {
  const [theta, phi, trimPitch, trimRoll, trimYaw, throttle] = x;
  st.trimPitch = trimPitch;
  st.trimRoll = trimRoll;
  st.trimYaw = trimYaw;
  inp.throttle = throttle;

  // Let the stiff powerplant states settle *at* the condition. Re-pinning after
  // every step stops the airframe wandering off while the engine converges, so
  // what comes out is the engine's steady state for exactly this (throttle,
  // airspeed, altitude) rather than for some drifting neighbouring point.
  //
  // Fuel is held at its entry value throughout. Every other engine state
  // (shaft speed, blade pitch, oil and coolant temperature) has an equilibrium
  // it settles to; the fuel tank is a pure integrator and never does. Left
  // free, it burns ~0.8 kg during an 8 s settle, which is a ~2.5e-3 m/s² lift
  // excess — the same order as the residual being solved for. That made F(x)
  // depend on how many evaluations had already run rather than on x, and the
  // Newton iteration stalled on a floor it could not get under.
  //
  // The cooling system is frozen for the same reason, and it is the subtler of
  // the two. Oil and coolant temperature settle over *minutes*, and with the
  // radiator on automatic the shutter tracks coolant temperature, so radiator
  // drag — and therefore the axial residual — keeps creeping long after every
  // engine state has converged to the last bit. Measured on the P-51: thrust,
  // shaft speed, blade pitch and slipstream are all bit-identical by t = 10 s
  // while the axial residual is still decaying with a ~17 s tail. 'trimFlight'
  // soaks the thermal state to equilibrium once, up front, and then holds it
  // there; the trim that comes out is the trim for a warmed-through engine,
  // which is the condition that matters.
  const fuel0 = st.fuel;
  const oil0 = st.oilTemp, cool0 = st.coolantTemp, rad0 = st.radiator;
  const restore = (): void => {
    st.fuel = fuel0;
    st.oilTemp = oil0; st.coolantTemp = cool0; st.radiator = rad0;
  };

  // How long "settled" takes is an airframe property, not a constant: the
  // P-51's heavier propeller and slower governor need roughly twice the Bf
  // 109's. A fixed settle long enough for the worst case wastes it on the rest,
  // and one tuned for the average leaves the P-51's Jacobian wrong by a factor
  // of seven — which showed up as the solver slamming the throttle between 0.31
  // and 0.82 and never converging. So run until thrust actually stops moving.
  const win = Math.max(1, Math.round(0.5 / dt));   // convergence window, 0.5 s
  const minSteps = Math.round(2.0 / dt);
  const maxSteps = Math.round(maxSettle / dt);
  let prevThrust = Infinity;
  for (let i = 0; i < maxSteps; i++) {
    pin(st, altitude, heading, theta, phi, tas);
    stepFlight(st, spec, inp, env, dt);
    restore();
    if (i % win === win - 1) {
      // Tolerance is relative to thrust because that is what the axial residual
      // is made of: 1e-6 of ~4 kN is 4 mN, which is a ~1e-6 m/s² error — two
      // orders below the residual the Newton iteration is chasing.
      const t = st.thrust;
      if (i >= minSteps && Math.abs(t - prevThrust) <= 1e-6 * Math.max(100, Math.abs(t))) break;
      prevThrust = t;
    }
  }

  // One clean unpinned step: whatever the aircraft does in it *is* the residual.
  pin(st, altitude, heading, theta, phi, tas);
  stepFlight(st, spec, inp, env, dt);
  restore();

  // Decompose the horizontal velocity into along-track and cross-track.
  const ax = Math.sin(heading), az = Math.cos(heading);
  const along = st.vel.x * ax + st.vel.z * az;
  const cross = st.vel.x * az - st.vel.z * ax;
  out[0] = st.vel.y / dt;               // vertical acceleration, m/s²
  out[1] = (along - tas) / dt;          // rate of change of speed, m/s²
  out[2] = cross / dt;                  // lateral acceleration, m/s²
  out[3] = st.alphaDotBody.x;           // pitching, rad/s²
  out[4] = st.alphaDotBody.y;           // yawing,   rad/s²
  out[5] = st.alphaDotBody.z;           // rolling,  rad/s²
}

/** Solve an N×N system by Gaussian elimination with partial pivoting. */
function solveN(A: number[][], b: number[]): number[] | null {
  const m: number[][] = [];
  for (let r = 0; r < N; r++) m.push([...A[r], b[r]]);
  for (let col = 0; col < N; col++) {
    let piv = col;
    for (let r = col + 1; r < N; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) < 1e-16) return null;
    if (piv !== col) { const t = m[piv]; m[piv] = m[col]; m[col] = t; }
    const d = m[col][col];
    for (let c = col; c <= N; c++) m[col][c] /= d;
    for (let r = 0; r < N; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let c = col; c <= N; c++) m[r][c] -= f * m[col][c];
    }
  }
  const out: number[] = [];
  for (let r = 0; r < N; r++) {
    if (!isFinite(m[r][N])) return null;
    out.push(m[r][N]);
  }
  return out;
}

const clampN = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Per-unknown limits: θ, φ, δe, δa, δr, τ. */
const LO: Vec6 = [-0.5, -0.6, -0.6, -0.4, -0.5, 0];
const HI: Vec6 = [0.5, 0.6, 0.6, 0.4, 0.5, 1];
/** Finite-difference steps — big enough to clear integrator noise, small
 *  enough to stay linear. */
const FD: Vec6 = [3e-4, 3e-4, 4e-3, 4e-3, 4e-3, 1e-2];
/** Largest move any single Newton iteration may make in each unknown. */
const CAP: Vec6 = [0.06, 0.08, 0.35, 0.3, 0.3, 0.35];

/** Angular residuals are in rad/s²; weight them into the force error metric. */
function errOf(f: Vec6): number {
  return Math.max(
    Math.abs(f[0]), Math.abs(f[1]), Math.abs(f[2]),
    Math.abs(f[3]) * 8, Math.abs(f[4]) * 8, Math.abs(f[5]) * 8,
  );
}

/**
 * Return an aircraft in steady level flight at 'altitude' and 'ias', with the
 * trim tabs set so that a pilot holding the stick central stays there.
 */
export function trimFlight(
  spec: AircraftSpec, env: Environment, altitude: number, ias: number,
  opts: TrimOptions = {},
): TrimResult {
  const dt = opts.dt ?? 1 / 60;
  const heading = opts.heading ?? 0;
  const settle = opts.settle ?? 16;
  const maxIter = opts.iterations ?? 14;
  const rho = env.airDensity(altitude) || isaDensity(altitude);
  const tas = easToTas(ias, rho);

  const st = createFlightState(spec, v3(0, altitude, 0), q());
  spawnInFlight(st, spec, env, altitude, tas, heading, 0.7);
  if (opts.flaps !== undefined) { st.flaps = opts.flaps; st.flapsTarget = opts.flaps; }
  if (opts.gear !== undefined) { st.gear = opts.gear; st.gearTarget = opts.gear; }

  // ---- phase 1: autopilot settle -----------------------------------------
  // This does not produce the trim; it produces a good *starting guess* and,
  // more importantly, a warm engine and a converged slipstream.
  const ap = newAutopilot();
  const steps = Math.round(settle / dt);
  for (let i = 0; i < steps; i++) {
    const inp = autopilotStep(ap, st, spec, { altitude, speed: ias, heading }, dt);
    if (opts.flaps !== undefined) st.flapsTarget = opts.flaps;
    if (opts.gear !== undefined) st.gearTarget = opts.gear;
    stepFlight(st, spec, inp, env, dt);
  }

  const inp: InputFrame = {
    seq: 0, dt, pitch: 0, roll: 0, yaw: 0, throttle: st.throttleCmd, bits: 0, aimX: 0, aimY: 0,
  };
  // Start from what the autopilot found. In level flight θ ≈ α.
  const x: Vec6 = [
    clampN(st.alpha, LO[0], HI[0]),
    clampN(st.rollAngle, LO[1], HI[1]),
    clampN(st.demandPitch, LO[2], HI[2]),
    clampN(st.demandRoll, LO[3], HI[3]),
    clampN(st.demandYaw, LO[4], HI[4]),
    clampN(st.throttleCmd, LO[5], HI[5]),
  ];

  /**
   * Run the cooling system to its steady state at the candidate trim point,
   * with everything else pinned. The Newton solve freezes the thermal state
   * (see 'residuals'), so it has to be frozen at the *right* value: the
   * radiator shutter position sets radiator drag, and 5 points of shutter is
   * worth enough drag to walk the aeroplane 10 m downhill in a minute.
   */
  const soakThermal = (at: Vec6): void => {
    const fuel0 = st.fuel;
    st.trimPitch = at[2]; st.trimRoll = at[3]; st.trimYaw = at[4];
    inp.throttle = at[5];
    const maxSoak = Math.round(600 / dt);
    const win = Math.round(5 / dt);
    let prev = Infinity;
    for (let i = 0; i < maxSoak; i++) {
      pin(st, altitude, heading, at[0], at[1], tas);
      stepFlight(st, spec, inp, env, dt);
      st.fuel = fuel0;
      if (i % win === win - 1) {
        if (Math.abs(st.coolantTemp - prev) < 1e-5) break;
        prev = st.coolantTemp;
      }
    }
  };

  // ---- phases 2 and 3, alternated -----------------------------------------
  // Thermal state and trim are weakly coupled in both directions: the throttle
  // the solver picks sets the heat load, and the shutter that heat load calls
  // for sets part of the drag the solver is trimming against. Soaking once
  // before the solve is not enough — the soak would be for the *initial guess*
  // throttle, and the answer would be trimmed for a radiator position the
  // aeroplane does not actually hold. Alternating the two converges the pair;
  // the coupling is weak enough that three rounds is plenty.

  const F: Vec6 = [0, 0, 0, 0, 0, 0];
  const Fp: Vec6 = [0, 0, 0, 0, 0, 0];
  const xp: Vec6 = [0, 0, 0, 0, 0, 0];
  const J: number[][] = [];
  for (let r = 0; r < N; r++) J.push(new Array(N).fill(0));

  // Newton requires the residual to be a function of the unknowns *alone*, and
  // the throttle spool (1.6–2 s), the constant-speed governor and the
  // slipstream all carry history. 'residuals' settles them out adaptively; this
  // is only the ceiling on how long it may take.
  const maxSettle = 40;

  // 'best' tracks the lowest-residual point seen, so a Newton step that
  // overshoots can never make the returned trim worse than the starting guess.
  let bestErr = Infinity;
  const best: Vec6 = [...x] as Vec6;
  let iter = 0;

  for (let pass = 0; pass < 3; pass++) {
    soakThermal(x);
    // The frozen thermal state has moved, so previous residuals no longer
    // describe this problem; start the running best over.
    bestErr = Infinity;
    for (let k = 0; k < maxIter; k++, iter++) {
      residuals(st, spec, env, altitude, heading, tas, x, inp, dt, maxSettle, F);
      const err = errOf(F);
      if (err < bestErr) { bestErr = err; for (let i = 0; i < N; i++) best[i] = x[i]; }
      if (err < 2e-5) break;

      for (let c = 0; c < N; c++) {
        // Step away from a saturated bound rather than into it.
        const h = x[c] + FD[c] > HI[c] ? -FD[c] : FD[c];
        for (let i = 0; i < N; i++) xp[i] = x[i];
        xp[c] = clampN(x[c] + h, LO[c], HI[c]);
        residuals(st, spec, env, altitude, heading, tas, xp, inp, dt, maxSettle, Fp);
        for (let r = 0; r < N; r++) J[r][c] = (Fp[r] - F[r]) / h;
      }

      const step = solveN(J, [-F[0], -F[1], -F[2], -F[3], -F[4], -F[5]]);
      if (!step) break;
      // Damping: cap how far one iteration may move, which keeps the solver
      // sane near throttle saturation and near the stall where the Jacobian
      // goes soft.
      let scale = 1;
      for (let i = 0; i < N; i++) scale = Math.min(scale, CAP[i] / Math.max(Math.abs(step[i]), 1e-12));
      for (let i = 0; i < N; i++) x[i] = clampN(x[i] + step[i] * scale, LO[i], HI[i]);
    }
    for (let i = 0; i < N; i++) x[i] = best[i];
  }

  // ---- settle the accepted solution --------------------------------------
  // The last thing the loop above did was solve against the current thermal
  // state, so that state is already the one the answer was trimmed for; do not
  // re-soak here or the radiator moves out from under the solution again. Just
  // converge the powerplant at the accepted point and report what was achieved.
  residuals(st, spec, env, altitude, heading, tas, best, inp, dt, maxSettle, F);
  pin(st, altitude, heading, best[0], best[1], tas);
  st.trimPitch = best[2];
  st.trimRoll = best[3];
  st.trimYaw = best[4];
  st.throttleCmd = best[5];
  st.throttle = best[5];
  st.gPeak = 1;
  st.gFatigue = 0;
  st.age = 0;

  const residualAccel = Math.max(Math.abs(F[0]), Math.abs(F[1]), Math.abs(F[2]));
  const residualAlpha = Math.max(Math.abs(F[3]), Math.abs(F[4]), Math.abs(F[5]));
  return {
    state: st,
    residualVs: F[0] * dt,
    residualIas: F[1] * dt,
    residualAccel,
    residualAlpha,
    iterations: iter,
    converged: residualAccel < 5e-3 && residualAlpha < 5e-4,
  };
}
