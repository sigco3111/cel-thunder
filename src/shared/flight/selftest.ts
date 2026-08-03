/**
 * Headless self-test for the flight model.
 *
 *     npx tsx src/shared/flight/selftest.ts            # all archetypes
 *     npx tsx src/shared/flight/selftest.ts bf109_g6   # one archetype
 *     npx tsx src/shared/flight/selftest.ts --verbose
 *
 * These are behavioural assertions, not unit tests: each scenario flies the
 * real integrator and checks that the aeroplane does what an aeroplane does.
 * If a change to the aerodynamics breaks stall recovery or makes the aircraft
 * untrimmable, this catches it in a couple of seconds.
 */

import { q, v3, type V3 } from '../math';
import { AIRCRAFT, AIRCRAFT_BY_ID, type AircraftSpec } from '../aircraft';
import { DamageBits, InputBits, type InputFrame } from '../protocol';
import { autopilotStep, newAutopilot, wrapPi } from './autopilot';
import { atmosphereAt, easToTas, flatEnvironment, isaDensity } from './atmosphere';
import { getDerived } from './derive';
import { createFlightState, placeOnGround, spawnInFlight, stepFlight } from './step';
import { trimFlight } from './trim';
import { G0, type Environment, type FlightState } from './types';

const DT = 1 / 60;
const VERBOSE = process.argv.includes('--verbose');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    if (VERBOSE) console.log(`    ok    ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? `  (${detail})` : ''}`);
    console.log(`    FAIL  ${name}${detail ? `  (${detail})` : ''}`);
  }
}

function note(msg: string): void {
  if (VERBOSE) console.log(`          ${msg}`);
}

const fmt = (v: number, n = 2) => (isFinite(v) ? v.toFixed(n) : String(v));
const DEGf = (r: number) => fmt((r * 180) / Math.PI, 1);

function makeInput(over: Partial<InputFrame> = {}): InputFrame {
  return {
    seq: 0, dt: DT, pitch: 0, roll: 0, yaw: 0, throttle: 0, bits: 0, aimX: 0, aimY: 0,
    ...over,
  };
}

/**
 * Walk *every* numeric field of a flight state — scalars, the vector and
 * quaternion sub-objects, and the per-surface / per-leg typed arrays — and
 * return the path of the first NaN or Infinity found, or '' if the state is
 * clean.
 *
 * Deliberately reflective rather than a hand-written list of fields: a
 * hand-written list silently stops covering whatever gets added to
 * 'FlightState' next, which is exactly when a new NaN source appears.
 */
function badField(v: unknown, path = ''): string {
  if (typeof v === 'number') return isFinite(v) ? '' : `${path}=${v}`;
  if (typeof v === 'boolean' || v == null || typeof v === 'string') return '';
  if (ArrayBuffer.isView(v)) {
    const a = v as unknown as ArrayLike<number>;
    for (let i = 0; i < a.length; i++) if (!isFinite(a[i])) return `${path}[${i}]=${a[i]}`;
    return '';
  }
  if (typeof v === 'object') {
    for (const k of Object.keys(v as object)) {
      const r = badField((v as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      if (r) return r;
    }
  }
  return '';
}

function stateFault(st: FlightState): string { return badField(st); }
function finite(st: FlightState): boolean { return badField(st) === ''; }

/**
 * Order-sensitive hash over every numeric field, used for the bit-identity
 * check. Numbers go in through their raw IEEE-754 bits, so -0 vs +0 and the
 * last mantissa bit both count — 'a.pos.x === b.pos.x' on a handful of fields
 * would pass while the rest of the state had quietly diverged.
 */
const _hashBuf = new DataView(new ArrayBuffer(8));
function hashState(st: FlightState): string {
  let h1 = 0x811c9dc5 | 0, h2 = 0x01000193 | 0;
  const mix = (n: number): void => {
    _hashBuf.setFloat64(0, n);
    for (let i = 0; i < 8; i++) {
      const b = _hashBuf.getUint8(i);
      h1 = Math.imul(h1 ^ b, 0x01000193);
      h2 = Math.imul(h2 + b + i, 0x85ebca6b) ^ (h1 >>> 13);
    }
  };
  const walk = (v: unknown): void => {
    if (typeof v === 'number') { mix(v); return; }
    if (typeof v === 'boolean') { mix(v ? 1 : 0); return; }
    if (v == null || typeof v === 'string') return;
    if (ArrayBuffer.isView(v)) {
      const a = v as unknown as ArrayLike<number>;
      for (let i = 0; i < a.length; i++) mix(a[i]);
      return;
    }
    if (typeof v === 'object') for (const k of Object.keys(v as object).sort()) {
      walk((v as Record<string, unknown>)[k]);
    }
  };
  walk(st);
  return ((h1 >>> 0).toString(16).padStart(8, '0')) + ((h2 >>> 0).toString(16).padStart(8, '0'));
}

/** Deterministic PRNG — mulberry32. Same seed, same stream, every platform. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function run(st: FlightState, spec: AircraftSpec, env: Environment, seconds: number, inp: InputFrame): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) stepFlight(st, spec, inp, env, DT);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/** 1. Geometry and calibration sanity — cheap, catches bad archetype data. */
function testDerived(spec: AircraftSpec): void {
  const d = getDerived(spec);
  check('derive: surfaces built', d.nSurf >= 8, `${d.nSurf} strips`);
  check('derive: positive parasite area', d.parasiteArea > 0, `${fmt(d.parasiteArea, 4)} m²`);
  check('derive: wing AC near the CG', Math.abs(d.wingAcZ) < d.chord * 1.6,
    `z=${fmt(d.wingAcZ)} m, c=${fmt(d.chord)} m`);
  check('derive: stall speed plausible', d.vStall > 25 && d.vStall < 65,
    `${fmt(d.vStall * 3.6, 0)} km/h`);
  check('derive: taildragger sits nose-up',
    !spec.geom.gear.tailWheel || (d.groundPitch > 0.10 && d.groundPitch < 0.35),
    `${DEGf(d.groundPitch)}°`);
  check('derive: inertias positive', d.inertia.x > 0 && d.inertia.y > 0 && d.inertia.z > 0);
  note(`vStall ${fmt(d.vStall * 3.6, 0)} km/h  vCorner ${fmt(d.vCorner * 3.6, 0)} km/h  `
    + `dihedralScale ${fmt(d.dihedralScale)}  finScale ${fmt(d.finScale)}  `
    + `vHeavyRoll ${fmt(d.vHeavyRoll * 3.6, 0)} km/h`);
}

/**
 * 2. REQUIRED: a trimmed aircraft holds altitude within a few metres over 60 s
 * of hands-off level flight.
 *
 * The stick is genuinely central for the whole minute — no autopilot, no
 * feedback of any kind — so this measures the trim solution and the model's
 * open-loop longitudinal behaviour together. The bar is deliberately in metres
 * rather than tens of metres: at hundreds of metres the test cannot tell a
 * trimmed aeroplane from one with an excited phugoid, which is precisely the
 * failure it exists to catch.
 */
function testLevelFlight(spec: AircraftSpec, env: Environment): void {
  const alt = 2000;
  const ias = 105;
  const t = trimFlight(spec, env, alt, ias);
  const st = t.state;

  // Assert on the equilibrium itself, not on a snapshot of vertical speed: a
  // feedback-held aircraft can show zero vertical speed while carrying a large
  // force imbalance.
  check('trim: solved the equilibrium', t.converged,
    `|a|=${t.residualAccel.toExponential(2)} m/s², |ω̇|=${t.residualAlpha.toExponential(2)} rad/s²`);
  check('trim: residual acceleration is negligible', t.residualAccel < 2e-3,
    `${t.residualAccel.toExponential(2)} m/s²`);
  check('trim: residual angular acceleration is negligible', t.residualAlpha < 5e-5,
    `${t.residualAlpha.toExponential(2)} rad/s²`);
  check('trim: trimmed at the requested speed', Math.abs(st.ias - ias) < 0.5,
    `${fmt(st.ias * 3.6, 1)} vs ${fmt(ias * 3.6, 1)} km/h`);

  const alt0 = st.altitude;
  const hdg0 = st.heading;
  const inp = makeInput({ throttle: st.throttleCmd });
  let worstAlt = 0;
  let worstVs = 0;
  let fault = '';
  for (let i = 0; i < Math.round(60 / DT); i++) {
    stepFlight(st, spec, inp, env, DT);
    worstAlt = Math.max(worstAlt, Math.abs(st.altitude - alt0));
    worstVs = Math.max(worstVs, Math.abs(st.vertSpeed));
    if (!fault) fault = stateFault(st);
  }

  check('level: state stayed finite', fault === '', fault);
  check('level: holds altitude within a few metres over 60 s', worstAlt < 6,
    `worst excursion ${fmt(worstAlt, 2)} m`);
  check('level: never develops a climb or sink rate', worstVs < 0.5,
    `worst |vs| ${fmt(worstVs, 3)} m/s`);
  check('level: holds heading over 60 s', Math.abs(wrapPi(st.heading - hdg0)) < 0.30,
    `${DEGf(wrapPi(st.heading - hdg0))}°`);
  check('level: holds the trim speed over 60 s', Math.abs(st.ias - ias) < 1.5,
    `${fmt((st.ias - ias) * 3.6, 2)} km/h drift`);
  check('level: not stalled', !st.stalled);
  check('level: sensible load factor', st.gLoad > 0.9 && st.gLoad < 1.1, `${fmt(st.gLoad, 3)} g`);
  note(`alt ${fmt(st.altitude, 0)} m  IAS ${fmt(st.ias * 3.6, 0)} km/h  alpha ${DEGf(st.alpha)}°  `
    + `trimPitch ${fmt(st.trimPitch)}  thr ${fmt(st.throttle)}  rpm ${fmt(st.rpm, 0)}  `
    + `worst excursion ${fmt(worstAlt, 2)} m`);
}

/** 3. Top speed and climb are in the historical ballpark. */
function testPerformance(spec: AircraftSpec, env: Environment): void {
  const st = createFlightState(spec, v3(0, 500, 0), q());
  spawnInFlight(st, spec, env, 500, 120, 0, 1);
  const ap = newAutopilot();
  for (let i = 0; i < Math.round(120 / DT); i++) {
    const inp = autopilotStep(ap, st, spec, { altitude: 500, throttle: 1 }, DT);
    stepFlight(st, spec, inp, env, DT);
  }
  const kmh = st.tas * 3.6;
  check('performance: sea-level top speed plausible', kmh > 380 && kmh < 640, `${fmt(kmh, 0)} km/h`);
  check('performance: engine did not cook itself', st.coolantTemp < 135,
    `${fmt(st.coolantTemp, 0)} °C`);
  note(`Vmax@500m ${fmt(kmh, 0)} km/h  thrust ${fmt(st.thrust, 0)} N  `
    + `power ${fmt(st.power / 1000, 0)} kW  MAP ${fmt(st.manifold / 1000, 0)} kPa  `
    + `oil ${fmt(st.oilTemp, 0)}°C coolant ${fmt(st.coolantTemp, 0)}°C`);

  // Climb rate from a trimmed cruise.
  const c = trimFlight(spec, env, 1000, 90).state;
  const ap2 = newAutopilot();
  const y0 = c.altitude;
  for (let i = 0; i < Math.round(30 / DT); i++) {
    const inp = autopilotStep(ap2, c, spec, { vs: 18, throttle: 1 }, DT);
    stepFlight(c, spec, inp, env, DT);
  }
  const climb = (c.altitude - y0) / 30;
  check('performance: can climb', climb > 4, `${fmt(climb)} m/s`);
  note(`climb ${fmt(climb)} m/s at ${fmt(c.ias * 3.6, 0)} km/h IAS`);
}

/** 4. A loop comes back to roughly the entry heading and attitude. */
function testLoop(spec: AircraftSpec, env: Environment): void {
  const d = getDerived(spec);
  const entryIas = Math.min(d.vCorner * 1.05, spec.aero.vne * 0.72);
  const t = trimFlight(spec, env, 3500, entryIas);
  const st = t.state;
  const hdg0 = st.heading;
  const alt0 = st.altitude;
  // Specific energy height at entry: the altitude the aircraft would reach if
  // it traded every scrap of speed for height.
  const he0 = st.altitude + (st.tas * st.tas) / (2 * G0);

  // Pull a steady g-limited loop. Wings are kept level by damping the roll
  // rate (bank angle is meaningless once inverted) and the ball is kept
  // centred with rudder, which is exactly how a loop is actually flown.
  let arc = 0;              // integrated pitch rotation, rad
  let bank = 0;             // integrated roll, rad — bank angle is useless inverted
  let maxAlt = st.altitude;
  let stick = st.demandPitch;
  let completed = false;
  const alphaTarget = spec.aero.stallAlpha * 0.88;
  const nSteps = Math.round(45 / DT);
  for (let i = 0; i < nSteps; i++) {
    // Fly it on alpha, the way a loop is actually flown: hard at the bottom
    // where there is speed to spend, gentle over the top where there is not.
    stick = clamp01s(st.trimPitch + (alphaTarget - st.alpha) * 5.0 - st.pitchRate * 0.45);
    const inp = makeInput({
      throttle: 1,
      pitch: clamp01s(stick - st.trimPitch),
      roll: clamp01s(-bank * 2.2 - st.rollRate * 1.1),
      yaw: clamp01s(st.beta * 4.0 - st.yawRate * 0.8),
    });
    stepFlight(st, spec, inp, env, DT);
    arc += st.pitchRate * DT;
    bank += st.rollRate * DT;
    maxAlt = Math.max(maxAlt, st.altitude);
    if (arc >= 2 * Math.PI) { completed = true; break; }
  }
  check('loop: finite state', finite(st));
  check('loop: came all the way round', completed, `${DEGf(arc)}° of arc`);
  check('loop: gained height over the top', maxAlt - alt0 > 150, `${fmt(maxAlt - alt0, 0)} m`);
  const dHdg = Math.abs(wrapPi(st.heading - hdg0));
  check('loop: heading preserved', dHdg < 0.45, `${DEGf(dHdg)}°`);
  check('loop: wings level on exit', Math.abs(wrapPi(bank)) < 0.55, `${DEGf(bank)}°`);

  // REQUIRED: the loop must not gain or lose absurd energy. Specific energy
  // height, he = h + V²/2g, is the right currency — it is what the aeroplane
  // can actually trade between altitude and speed, so a manoeuvre that merely
  // swaps one for the other leaves it unchanged. A real loop at full throttle
  // is a small net loser: induced drag at 3–4 g over the pull costs more than
  // the engine puts back in the ten seconds the manoeuvre takes. Gaining
  // energy round a loop, or losing half of it, both mean the force balance is
  // wrong.
  const heExit = st.altitude + (st.tas * st.tas) / (2 * G0);
  const dHe = heExit - he0;
  check('loop: does not gain energy round the loop', dHe < he0 * 0.02,
    `Δhe ${fmt(dHe, 0)} m of ${fmt(he0, 0)} m`);
  check('loop: does not bleed absurd energy round the loop', dHe > -he0 * 0.35,
    `Δhe ${fmt(dHe, 0)} m (${fmt((100 * dHe) / he0, 1)}%)`);
  note(`entry ${fmt(entryIas * 3.6, 0)} km/h  peak +${fmt(maxAlt - alt0, 0)} m  `
    + `gPeak ${fmt(st.gPeak)}  exit ${fmt(st.ias * 3.6, 0)} km/h  blackout ${fmt(st.blackout)}  `
    + `he ${fmt(he0, 0)} → ${fmt(heExit, 0)} m (${fmt((100 * dHe) / he0, 1)}%)`);
}

function clamp01s(v: number): number { return v < -1 ? -1 : v > 1 ? 1 : v; }

/** 5. Decelerate into a stall: buffet warns, the wing lets go, the nose drops. */
function testStall(spec: AircraftSpec, env: Environment): void {
  const dv = getDerived(spec);
  const t = trimFlight(spec, env, 3000, Math.max(dv.vStall * 1.7, 70));
  const st = t.state;
  const alt0 = st.altitude;
  let sawBuffet = false;
  let buffetIas = 0;
  let stallIas = 0;
  let stallG = 1;
  let pitchAtStall = 0;
  let minPitchAfter = 10;
  let stalled = false;
  let stepsSince = 0;
  let integ = st.trimPitch;

  const n = Math.round(80 / DT);
  for (let i = 0; i < n; i++) {
    // Power off, wings held level, altitude held with progressively more back
    // stick — the textbook 1 g power-off stall.
    const rateCmd = clamp01s((alt0 - st.altitude) * 0.02 - st.vertSpeed * 0.05) * 0.25;
    const err = rateCmd - st.pitchRate;
    integ = clamp01s(integ + err * 1.6 * DT);
    const stick = clamp01s(err * 2.2 + integ);
    stepFlight(st, spec, makeInput({
      throttle: 0.02,
      pitch: clamp01s(stick - st.trimPitch),
      roll: clamp01s(-st.rollAngle * 1.8 - st.rollRate * 0.8),
      yaw: clamp01s(st.beta * 3.0 - st.yawRate * 0.4),
    }), env, DT);
    if (!sawBuffet && st.buffet > 0.3 && !st.stalled) { sawBuffet = true; buffetIas = st.ias; }
    if (!stalled && st.stalled) {
      stalled = true;
      stallIas = st.ias;
      stallG = Math.max(st.gLoad, 0.3);
      pitchAtStall = st.pitchAngle;
    }
    if (stalled) {
      stepsSince++;
      if (stepsSince > 30) minPitchAfter = Math.min(minPitchAfter, st.pitchAngle);
      if (stepsSince > Math.round(4 / DT)) break;
    }
  }

  check('stall: finite state', finite(st));
  check('stall: buffet warns before the break', sawBuffet && buffetIas > 0);
  check('stall: the wing actually stalls', stalled, `${fmt(stallIas * 3.6, 0)} km/h`);
  check('stall: the nose drops', stalled && minPitchAfter < pitchAtStall - 0.06,
    `${DEGf(pitchAtStall)}° → ${DEGf(minPitchAfter)}°`);
  const d = dv;
  // Normalise out whatever load factor the aircraft happened to be pulling —
  // Vs scales with √n, and the physical claim is about the 1 g figure.
  const vs1g = stallIas / Math.sqrt(stallG);
  check('stall: speed near the predicted 1 g stall',
    stalled && vs1g > d.vStall * 0.75 && vs1g < d.vStall * 1.3,
    `${fmt(vs1g, 1)} (at ${fmt(stallG)} g) vs ${fmt(d.vStall, 1)} m/s`);
  note(`buffet at ${fmt(buffetIas * 3.6, 0)} km/h, break at ${fmt(stallIas * 3.6, 0)} km/h `
    + `(${fmt(stallG)} g), sink ${fmt(st.vertSpeed)} m/s`);

  // REQUIRED: the stall must be recoverable, and recoverable the way a pilot
  // actually does it — which is two distinct stages, not one held input:
  //
  //   1. Unload. Stick forward until the flow reattaches and power on. Wings
  //      are kept level with *rudder*; aileron at the stall only deepens the
  //      separation on the down-going wing.
  //   2. Once flying again, ease out of the resulting dive under a g limit.
  //
  // Holding stage 1 for the whole recovery is not a recovery, it is a
  // split-S: the aeroplane unstalls almost immediately and then accelerates
  // vertically downwards, and it will happily pass 700 km/h and lose two
  // kilometres while technically "not stalled".
  const recAlt = st.altitude;
  let recovered = false;
  let recTime = -1;
  let unstalled = false;
  const apRec = newAutopilot();
  const recSteps = Math.round(30 / DT);
  for (let i = 0; i < recSteps; i++) {
    if (!unstalled) {
      // Stage 1: unload and add power.
      stepFlight(st, spec, makeInput({
        throttle: 1,
        pitch: -0.6,
        yaw: clamp01s(-st.rollAngle * 0.9 - st.yawRate * 0.5),
      }), env, DT);
      if (!st.stalled && Math.max(st.stallL, st.stallR) < 0.12 && st.ias > d.vStall * 1.25) {
        unstalled = true;
      }
    } else {
      // Stage 2: wings level, then pull out to level flight under 3.5 g.
      stepFlight(st, spec, autopilotStep(apRec, st, spec, {
        vs: 0, maxG: 3.5, maxBank: 0.6, throttle: 0.85,
      }, DT), env, DT);
      if (!st.stalled && st.gLoad > 0.4 && st.vertSpeed > -3
        && Math.abs(st.rollAngle) < 0.35 && st.ias > d.vStall * 1.15) {
        recovered = true; recTime = i * DT; break;
      }
    }
  }
  const lost = recAlt - st.altitude;
  check('stall: unloads out of the stall', unstalled);
  check('stall: recovers to controlled level flight', recovered,
    `${recovered ? `${fmt(recTime)} s` : 'never recovered'}, IAS ${fmt(st.ias * 3.6, 0)} km/h`);
  check('stall: recovery costs a sane amount of height', recovered && lost > 0 && lost < 900,
    `${fmt(lost, 0)} m lost`);
  check('stall: flying again after recovery', recovered && !st.stalled && finite(st));
  note(`recovery in ${fmt(recTime)} s for ${fmt(lost, 0)} m, exit ${fmt(st.ias * 3.6, 0)} km/h`);
}

/**
 * 5b. REQUIRED: an asymmetric stall drops a wing — it does not mush
 * symmetrically.
 *
 * Two independent claims, tested separately because they can fail
 * independently:
 *
 *   (a) The *mechanism*. Held at a stalled angle of attack with sideslip on,
 *       the upwind wing must separate measurably more than the downwind one,
 *       and reversing the sideslip must reverse which wing it is. This is
 *       measured statically — attitude and rates pinned — so nothing but the
 *       aerodynamics can produce the asymmetry.
 *
 *   (b) The *consequence*. Stalled with rudder applied at the break, the
 *       aircraft must roll off hard and in the direction the rudder commands.
 *       Rudder left must drop the left wing and rudder right the right one on
 *       every archetype; an aeroplane that always falls the same way has a
 *       constant bias, not a wing drop, and one that barely rolls at all is
 *       mushing.
 *
 * The rudder goes in *at the break*, not from the trimmed condition. Holding
 * rudder from level flight does not produce an asymmetric stall at all — it
 * produces a slow spiral that accelerates, and the aircraft never reaches the
 * stall in the first place.
 */
function testWingDrop(spec: AircraftSpec, env: Environment): void {
  // ---- (a) the mechanism, measured statically ----------------------------
  const alt = 3000;
  const d = getDerived(spec);
  const V = easToTas(Math.max(d.vStall * 0.95, 55), isaDensity(alt));
  const stalledAlpha = spec.aero.stallAlpha + 0.07;

  /** Hold alpha/beta with the attitude and rates pinned; let separation settle. */
  const held = (alphaRad: number, betaRad: number): { l: number; r: number } => {
    const st = createFlightState(spec, v3(0, alt, 0), q());
    spawnInFlight(st, spec, env, alt, V, 0, 0);
    const inp = makeInput({ throttle: 0 });
    for (let i = 0; i < 200; i++) {
      st.vel.x = V * Math.sin(betaRad);
      st.vel.y = -V * Math.sin(alphaRad) * Math.cos(betaRad);
      st.vel.z = V * Math.cos(alphaRad) * Math.cos(betaRad);
      st.omega.x = 0; st.omega.y = 0; st.omega.z = 0;
      st.rot.x = 0; st.rot.y = 0; st.rot.z = 0; st.rot.w = 1;
      stepFlight(st, spec, inp, env, 1 / 240);
    }
    return { l: st.stallL, r: st.stallR };
  };

  const beta = 0.105;                     // 6° of sideslip
  const slipLeft = held(stalledAlpha, -beta);
  const level = held(stalledAlpha, 0);
  const slipRight = held(stalledAlpha, beta);

  check('wingdrop: both wings separate at a stalled alpha',
    level.l > 0.3 && level.r > 0.3, `L ${fmt(level.l, 3)} R ${fmt(level.r, 3)}`);
  check('wingdrop: wings separate evenly with no sideslip',
    Math.abs(level.l - level.r) < 0.02, `|L−R| ${fmt(Math.abs(level.l - level.r), 4)}`);
  check('wingdrop: sideslip separates one wing more than the other',
    slipLeft.l - slipLeft.r > 0.03 && slipRight.r - slipRight.l > 0.03,
    `slip-left L−R ${fmt(slipLeft.l - slipLeft.r, 3)}, `
    + `slip-right R−L ${fmt(slipRight.r - slipRight.l, 3)}`);
  check('wingdrop: reversing the sideslip reverses which wing lets go',
    Math.sign(slipLeft.l - slipLeft.r) === -Math.sign(slipRight.l - slipRight.r));

  // ---- (b) the consequence, flown --------------------------------------
  /** Decelerate to the break, then apply rudder and let go of the aileron. */
  const departure = (rudder: number) => {
    const st = trimFlight(spec, env, 3500, Math.max(d.vStall * 1.7, 70)).state;
    const alt0 = st.altitude;
    let integ = st.trimPitch;
    let kicked = false, broke = false, since = 0;
    let peakAsym = 0, peakRoll = 0, fault = '';
    for (let i = 0; i < Math.round(120 / DT); i++) {
      const rateCmd = clamp01s((alt0 - st.altitude) * 0.02 - st.vertSpeed * 0.05) * 0.25;
      const err = rateCmd - st.pitchRate;
      integ = clamp01s(integ + err * 1.6 * DT);
      const stick = clamp01s(err * 2.2 + integ);
      if (!kicked && st.buffet > 0.25) kicked = true;
      stepFlight(st, spec, makeInput({
        throttle: 0.02,
        pitch: clamp01s(stick - st.trimPitch),
        roll: kicked ? 0 : clamp01s(-st.rollAngle * 1.8 - st.rollRate * 0.8),
        yaw: kicked ? rudder : clamp01s(st.beta * 3.0 - st.yawRate * 0.4),
      }), env, DT);
      if (!fault) fault = stateFault(st);
      if (!broke && st.stalled) broke = true;
      if (broke) {
        since++;
        peakAsym = Math.max(peakAsym, Math.abs(st.stallL - st.stallR));
        if (Math.abs(st.rollRate) > Math.abs(peakRoll)) peakRoll = st.rollRate;
        if (since > Math.round(4 / DT)) break;
      }
    }
    return { broke, peakAsym, peakRoll, bank: st.rollAngle, fault };
  };

  const left = departure(-0.7);
  const right = departure(0.7);

  check('wingdrop: the aircraft stalls in both departure runs', left.broke && right.broke);
  check('wingdrop: rudder left drops the left wing', left.peakRoll < -1.0,
    `peak roll ${fmt(left.peakRoll)} rad/s`);
  check('wingdrop: rudder right drops the right wing', right.peakRoll > 1.0,
    `peak roll ${fmt(right.peakRoll)} rad/s`);
  check('wingdrop: it is a drop, not a mush',
    Math.abs(left.peakRoll) > 1.2 && Math.abs(right.peakRoll) > 1.2,
    `|roll| ${fmt(Math.abs(left.peakRoll))} / ${fmt(Math.abs(right.peakRoll))} rad/s`);
  check('wingdrop: the wings are strongly asymmetric through the drop',
    left.peakAsym > 0.3 && right.peakAsym > 0.3,
    `|L−R| ${fmt(left.peakAsym)} / ${fmt(right.peakAsym)}`);
  check('wingdrop: departures stay finite', left.fault === '' && right.fault === '',
    left.fault || right.fault);
  note(`static |L−R| at 6° slip ${fmt(slipRight.r - slipRight.l, 3)}; `
    + `departure roll ${fmt(left.peakRoll)} / ${fmt(right.peakRoll)} rad/s`);
}

/** 6. Stall with rudder in → autorotation; standard inputs recover it. */
function testSpin(spec: AircraftSpec, env: Environment): void {
  const t = trimFlight(spec, env, 4000, 95);
  const st = t.state;

  // Enter: power on (the slipstream helps stall the inner wing), stick fully
  // back, full rudder — a textbook spin entry.
  let peakRoll = 0;
  let peakYaw = 0;
  let peakSep = 0;
  let peakAsym = 0;
  let peakSpin = 0;
  let everStalled = false;
  const enter = Math.round(14 / DT);
  for (let i = 0; i < enter; i++) {
    const inp = makeInput({ throttle: 0.35, pitch: 1, yaw: 1 });
    stepFlight(st, spec, inp, env, DT);
    peakRoll = Math.max(peakRoll, Math.abs(st.rollRate));
    peakYaw = Math.max(peakYaw, Math.abs(st.yawRate));
    peakSep = Math.max(peakSep, Math.max(st.stallL, st.stallR));
    peakAsym = Math.max(peakAsym, Math.abs(st.stallL - st.stallR));
    peakSpin = Math.max(peakSpin, st.spinning);
    everStalled = everStalled || st.stalled;
  }
  check('spin: the wing lets go during the entry', everStalled && peakSep > 0.4,
    `peak separation ${fmt(peakSep)}`);
  check('spin: entry produces autorotation', peakRoll > 0.6 && peakYaw > 0.35 && peakSpin > 0.1,
    `roll ${fmt(peakRoll)} rad/s, yaw ${fmt(peakYaw)} rad/s, spin ${fmt(peakSpin)}`);
  check('spin: the two wings stall asymmetrically', peakAsym > 0.02,
    `max |L−R| ${fmt(peakAsym, 3)}`);

  // Recover: opposite rudder, stick forward, ailerons neutral.
  const yawSign = Math.sign(st.yawRate) || 1;
  let recovered = false;
  const rec = Math.round(16 / DT);
  for (let i = 0; i < rec; i++) {
    const inp = makeInput({ throttle: 0.1, pitch: -0.75, yaw: -yawSign });
    stepFlight(st, spec, inp, env, DT);
    if (!st.stalled && Math.abs(st.yawRate) < 0.25 && Math.abs(st.rollRate) < 0.6) { recovered = true; break; }
  }
  check('spin: recovers with rudder + forward stick', recovered,
    `yaw ${fmt(st.yawRate)} roll ${fmt(st.rollRate)} sep ${fmt(Math.max(st.stallL, st.stallR))}`);
  check('spin: finite state', finite(st));
}

/**
 * 7. REQUIRED: control authority falls with dynamic pressure — roll rate at
 * 200 km/h and at 600 km/h differ, and for the right reasons at each end.
 *
 * The two ends are limited by opposite things, which is why testing only one
 * of them proves nothing:
 *
 *   Slow (200 km/h): the pilot can hold full deflection, so authority is 1.0
 *   and the steady roll rate is set by the helix angle — p ≈ (Clδa·δ/−Clp)·2V/b,
 *   i.e. proportional to airspeed. Roll rate is therefore *low* because the
 *   aircraft is slow, not because the controls are heavy.
 *
 *   Fast (600 km/h): stick force scales with dynamic pressure and the pilot
 *   can no longer hold full aileron. Authority collapses and the roll rate
 *   falls again despite the extra airspeed.
 *
 * So the roll rate must peak somewhere in the middle, and the peak must be a
 * real peak — a model that simply scales roll rate with speed, or one that
 * clamps it to a constant, fails this.
 */
function testRollRate(spec: AircraftSpec, env: Environment): void {
  const d = getDerived(spec);
  const measure = (kmh: number): { peak: number; auth: number } => {
    const ias = kmh / 3.6;
    const rho = isaDensity(1500);
    const st = createFlightState(spec, v3(0, 1500, 0), q());
    spawnInFlight(st, spec, env, 1500, easToTas(ias, rho), 0, 0.9);
    let peak = 0;
    let auth = 1;
    for (let i = 0; i < Math.round(3.5 / DT); i++) {
      stepFlight(st, spec, makeInput({ throttle: 0.9, roll: 1 }), env, DT);
      peak = Math.max(peak, st.rollRate);
      auth = st.authRoll;
    }
    return { peak, auth };
  };

  const s200 = measure(200);
  const s300 = measure(300);
  const s400 = measure(400);
  const s600 = measure(600);
  const mid = Math.max(s300.peak, s400.peak);

  check('roll: matches the spec at 400 km/h IAS',
    s400.peak > spec.aero.rollRate * 0.65 && s400.peak < spec.aero.rollRate * 1.45,
    `${fmt(s400.peak)} vs spec ${fmt(spec.aero.rollRate)} rad/s`);
  check('roll: rolls to the right for positive stick', s400.peak > 0);

  // Authority: the direct statement of the requirement.
  check('roll: full aileron is available at 200 km/h', s200.auth > 0.98,
    `authRoll ${fmt(s200.auth, 3)}`);
  check('roll: authority collapses by 600 km/h', s600.auth < 0.6,
    `authRoll ${fmt(s200.auth, 2)} → ${fmt(s600.auth, 2)}`);
  check('roll: authority falls monotonically with dynamic pressure',
    s200.auth >= s300.auth && s300.auth >= s400.auth && s400.auth >= s600.auth,
    `${fmt(s200.auth, 2)} / ${fmt(s300.auth, 2)} / ${fmt(s400.auth, 2)} / ${fmt(s600.auth, 2)}`);

  // Roll rate: low at both ends, peaked in the middle, for opposite reasons.
  check('roll: slower than the peak at 200 km/h (helix-angle limited)',
    s200.peak < mid * 0.92, `${fmt(s200.peak)} vs peak ${fmt(mid)} rad/s`);
  check('roll: slower than the peak at 600 km/h (stick-force limited)',
    s600.peak < mid * 0.92, `${fmt(s600.peak)} vs peak ${fmt(mid)} rad/s`);
  check('roll: rate rises with speed while the controls are still light',
    s300.peak > s200.peak, `${fmt(s200.peak)} → ${fmt(s300.peak)} rad/s`);
  note(`roll 200/300/400/600 km/h: ${fmt(s200.peak)} / ${fmt(s300.peak)} / ${fmt(s400.peak)} / `
    + `${fmt(s600.peak)} rad/s   auth ${fmt(s200.auth, 2)} / ${fmt(s300.auth, 2)} / `
    + `${fmt(s400.auth, 2)} / ${fmt(s600.auth, 2)}  (vHeavy ${fmt(d.vHeavyRoll * 3.6, 0)} km/h)`);
}

/** 8. Take-off from the runway. */
function testTakeoff(spec: AircraftSpec, env: Environment): void {
  const d = getDerived(spec);
  const st = createFlightState(spec, v3(0, 0, 0), q());
  // Sit it on the runway at its static ground attitude, wheels just touching.
  placeOnGround(st, spec, env, 0, 0, 0);
  st.gear = 1; st.gearTarget = 1;
  st.flaps = 0.35; st.flapsTarget = 0.35;
  st.engineRunning = true;
  st.coolantTemp = 60; st.oilTemp = 45;

  // Settle on the suspension.
  run(st, spec, env, 2.5, makeInput({ throttle: 0, bits: InputBits.WheelBrake }));
  check('takeoff: sits on the gear', st.onGround && Math.abs(st.vertSpeed) < 0.6,
    `vs ${fmt(st.vertSpeed)} m/s, load ${fmt(st.gearLoad[0], 0)}+${fmt(st.gearLoad[1], 0)} N`);
  check('takeoff: no prop strike at rest', !st.propStrike);
  const restPitch = st.pitchAngle;
  check('takeoff: static attitude nose-up', !spec.geom.gear.tailWheel || restPitch > 0.07,
    `${DEGf(restPitch)}°`);

  const vr = d.vStall * 1.18;
  let airborneAt = -1;
  let liftoffZ = 0;
  let maxDrift = 0;
  const startZ = st.pos.z;
  const roll = Math.round(60 / DT);
  for (let i = 0; i < roll; i++) {
    const t = i * DT;
    // Full power; hold the centreline on the rudder; forward stick to raise
    // the tail, then rotate at Vr.
    const yaw = clampS(-st.pos.x * 0.05 - st.heading * 2.6 - st.yawRate * 0.6, 1);
    let pitch: number;
    if (st.ias < vr * 0.55) pitch = -0.15;
    else if (st.ias < vr) pitch = -0.05;
    else pitch = 0.42;
    if (airborneAt >= 0) {
      // After lift-off, fly a steady climb attitude.
      pitch = clampS((0.16 - st.pitchAngle) * 3.0 - st.pitchRate * 1.4, 1);
    }
    const inp = makeInput({ throttle: 1, pitch, yaw, roll: clampS(-st.rollAngle * 1.6 - st.rollRate * 0.6, 1) });
    stepFlight(st, spec, inp, env, DT);
    maxDrift = Math.max(maxDrift, Math.abs(st.pos.x));
    if (airborneAt < 0 && !st.onGround && st.agl > 3) { airborneAt = t; liftoffZ = st.pos.z; }
    if (airborneAt >= 0 && st.agl > 220) break;
  }

  check('takeoff: got airborne', airborneAt > 0 && airborneAt < 45, `${fmt(airborneAt)} s`);
  check('takeoff: climbed away', st.agl > 150, `${fmt(st.agl, 0)} m AGL`);
  check('takeoff: stayed on the runway', maxDrift < 90, `max drift ${fmt(maxDrift, 0)} m`);
  check('takeoff: airframe intact', st.health > 0.9 && !(st.damage & DamageBits.GearBroken),
    `health ${fmt(st.health)}`);
  check('takeoff: finite state', finite(st));
  check('takeoff: ground roll is plausible', liftoffZ - startZ > 120 && liftoffZ - startZ < 900,
    `${fmt(liftoffZ - startZ, 0)} m`);
  note(`Vr ${fmt(vr * 3.6, 0)} km/h  airborne at ${fmt(airborneAt)} s after `
    + `${fmt(liftoffZ - startZ, 0)} m of roll  drift ${fmt(maxDrift, 1)} m`);
}

/** 9. Approach, flare and roll out without breaking anything. */
function testLanding(spec: AircraftSpec, env: Environment): void {
  const d = getDerived(spec);
  const approachIas = d.vStall * 1.32;
  const st = createFlightState(spec, v3(0, 0, 0), q());
  spawnInFlight(st, spec, env, 260, easToTas(approachIas, isaDensity(260)), 0, 0.35);
  st.pos.x = 0;
  st.pos.z = -3400;
  st.gear = 1; st.gearTarget = 1;
  st.flaps = 1; st.flapsTarget = 1;
  st.coolantTemp = 80; st.oilTemp = 65;

  const ap = newAutopilot();
  let touched = false;
  let touchdownVs = 0;
  let touchdownIas = 0;
  let touchdownZ = 0;
  const n = Math.round(120 / DT);
  for (let i = 0; i < n; i++) {
    let inp: InputFrame;
    if (!st.onGround) {
      const agl = st.agl;
      // 3.5° glide slope, flaring below 8 m to about 0.7 m/s of sink.
      let vs = -Math.tan(0.061) * Math.max(st.tas, 20);
      let speed = approachIas;
      if (agl < 12) {
        vs = -0.35 - Math.max(0, agl - 1.0) * 0.13;
        speed = approachIas * 0.93;
      }
      inp = autopilotStep(ap, st, spec, {
        vs, speed: agl < 9 ? undefined : speed,
        throttle: agl < 12 ? 0.06 : undefined,
        heading: 0, maxBank: 0.35, maxG: 2.2,
      }, DT);
    } else {
      // Roll-out: hold the tail up while there is still enough speed to fly,
      // then progressively bring it down onto the tailwheel. Snatching the
      // stick fully back at touchdown speed just flies it off again.
      const slow = clampS(1 - st.groundSpeed / (d.vStall * 1.15), 1);
      const attTarget = d.groundPitch * Math.max(slow, 0);
      const yaw = clampS(-st.pos.x * 0.05 - st.heading * 2.8 - st.yawRate * 0.7, 1);
      inp = makeInput({
        throttle: 0,
        pitch: clampS((attTarget - st.pitchAngle) * 3.5 - st.pitchRate * 1.6, 1),
        yaw,
        bits: st.groundSpeed < d.vStall ? InputBits.WheelBrake : 0,
      });
    }
    stepFlight(st, spec, inp, env, DT);
    if (!touched && st.onGround) {
      touched = true;
      touchdownVs = st.touchdownVs;
      touchdownIas = st.ias;
      touchdownZ = st.pos.z;
    }
    if (touched && st.groundSpeed < 3) break;
  }

  check('landing: touched down', touched);
  check('landing: soft touchdown', touched && touchdownVs < 3.0, `${fmt(touchdownVs)} m/s`);
  check('landing: gear survived', !(st.damage & DamageBits.GearBroken));
  check('landing: airframe intact', st.health > 0.85, `health ${fmt(st.health)}`);
  check('landing: rolled to a stop on the runway', st.groundSpeed < 6 && Math.abs(st.pos.x) < 60,
    `${fmt(st.groundSpeed)} m/s, ${fmt(st.pos.x, 1)} m off centre`);
  check('landing: no prop strike', !st.propStrike);
  check('landing: finite state', finite(st));
  check('landing: rollout is plausible', st.pos.z - touchdownZ < 1400,
    `${fmt(st.pos.z - touchdownZ, 0)} m`);
  note(`touchdown ${fmt(touchdownIas * 3.6, 0)} km/h at ${fmt(touchdownVs)} m/s, `
    + `rolled out in ${fmt(st.pos.z - touchdownZ, 0)} m`);
}

/**
 * 9b. REQUIRED: one continuous sortie. Every archetype takes off from the
 * runway under full power, climbs away, comes back down and lands, and ends
 * stationary on the ground in one piece.
 *
 * This is deliberately a single unbroken integration rather than the separate
 * take-off and landing scenarios above. Those two both start from a
 * hand-placed state; chaining them means the aeroplane has to arrive at the
 * approach in a condition it flew itself into — with whatever trim, thermal
 * state, fuel burn and accumulated attitude the climb left it — which is the
 * case that actually breaks.
 */
function testSortie(spec: AircraftSpec, env: Environment): void {
  const d = getDerived(spec);
  const st = createFlightState(spec, v3(0, 0, 0), q());
  placeOnGround(st, spec, env, 0, 0, 0);
  st.gear = 1; st.gearTarget = 1;
  st.flaps = 0.35; st.flapsTarget = 0.35;
  st.engineRunning = true;
  st.coolantTemp = 60; st.oilTemp = 45;
  run(st, spec, env, 2.0, makeInput({ throttle: 0, bits: InputBits.WheelBrake }));

  const CRUISE = 450;                     // circuit height, m
  const vr = d.vStall * 1.18;
  const ap = newAutopilot();
  type Phase = 'roll' | 'climb' | 'cruise' | 'descend' | 'flare' | 'rollout';
  let phase: Phase = 'roll';
  let airborneAt = -1;
  let touchdownAt = -1;
  let touchdownVs = 0;
  let peakAlt = 0;
  let fault = '';
  let cruiseTimer = 0;
  let stoppedAt = -1;

  const total = Math.round(400 / DT);
  for (let i = 0; i < total; i++) {
    const t = i * DT;
    let inp: InputFrame;

    if (phase === 'roll' || phase === 'climb') {
      // Full power, centreline held on the rudder, rotate at Vr, then hold a
      // steady climb attitude.
      const yaw = clampS(-st.pos.x * 0.05 - st.heading * 2.6 - st.yawRate * 0.6, 1);
      let pitch: number;
      if (airborneAt < 0) {
        pitch = st.ias < vr * 0.55 ? -0.15 : st.ias < vr ? -0.05 : 0.42;
      } else {
        pitch = clampS((0.16 - st.pitchAngle) * 3.0 - st.pitchRate * 1.4, 1);
      }
      inp = makeInput({
        throttle: 1, pitch, yaw,
        roll: clampS(-st.rollAngle * 1.6 - st.rollRate * 0.6, 1),
        // Gear and flaps up once safely climbing.
        bits: (airborneAt > 0 && t > airborneAt + 4 && st.gearTarget > 0.5) ? InputBits.GearToggle
          : (airborneAt > 0 && t > airborneAt + 8 && st.flapsTarget > 0.01) ? InputBits.FlapsUp : 0,
      });
      if (airborneAt < 0 && !st.onGround && st.agl > 3) { airborneAt = t; phase = 'climb'; }
      if (phase === 'climb' && st.altitude > CRUISE) phase = 'cruise';
    } else if (phase === 'cruise') {
      // Settle at height for a few seconds so the approach starts from a
      // stable, self-flown condition rather than straight off the climb.
      inp = autopilotStep(ap, st, spec, {
        altitude: CRUISE, speed: d.vStall * 1.9, heading: 0, maxBank: 0.3,
      }, DT);
      cruiseTimer += DT;
      if (cruiseTimer > 12) phase = 'descend';
    } else if (phase === 'descend' || phase === 'flare') {
      const agl = st.agl;
      const approachIas = d.vStall * 1.32;
      let vs = -Math.tan(0.061) * Math.max(st.tas, 20);
      let speed: number | undefined = approachIas;
      let throttle: number | undefined;
      if (agl < 12) {
        phase = 'flare';
        vs = -0.35 - Math.max(0, agl - 1.0) * 0.13;
        speed = agl < 9 ? undefined : approachIas * 0.93;
        throttle = 0.06;
      }
      inp = autopilotStep(ap, st, spec, {
        vs, speed, throttle, heading: 0, maxBank: 0.35, maxG: 2.2,
        // Gear and landing flap out on the way down.
        bits: (st.gearTarget < 0.5 && agl < 400) ? InputBits.GearToggle
          : (st.flapsTarget < 0.99 && agl < 300) ? InputBits.FlapsDown : 0,
      }, DT);
      if (st.onGround && touchdownAt < 0) {
        touchdownAt = t; touchdownVs = st.touchdownVs; phase = 'rollout';
      }
    } else {
      // Roll-out, flown as a wheel landing: hold the tail *up* until the wing
      // has genuinely stopped flying, and only then let it down.
      //
      // The threshold matters, and 0.6·Vs is not a tuning knob picked to make
      // a number go green. Letting the tail down early puts the wing back near
      // CLmax while the aircraft is still doing 130 km/h on its wheels, and a
      // narrow-track taildragger will then drop a wing and dig the tip in. The
      // Spitfire — 1.7 m track, the narrowest of the five — ground-loops every
      // time if it is three-pointed at touchdown speed, and no amount of
      // aileron or rudder gain saves it, which is exactly the reputation the
      // real aeroplane had. The other four tolerate either technique.
      const slow = clampS(1 - st.groundSpeed / (d.vStall * 0.6), 1);
      const attTarget = d.groundPitch * Math.max(slow, 0);
      inp = makeInput({
        throttle: 0,
        pitch: clampS((attTarget - st.pitchAngle) * 3.5 - st.pitchRate * 1.6, 1),
        roll: clampS(-st.rollAngle * 2.5 - st.rollRate * 2.0, 1),
        yaw: clampS(-st.pos.x * 0.02 - st.heading * 2.2 - st.yawRate * 1.0, 1),
        bits: st.groundSpeed < d.vStall ? InputBits.WheelBrake : 0,
      });
    }

    stepFlight(st, spec, inp, env, DT);
    if (!fault) fault = stateFault(st);
    peakAlt = Math.max(peakAlt, st.altitude);
    if (touchdownAt >= 0 && st.groundSpeed < 0.4 && st.onGround) {
      if (stoppedAt < 0) stoppedAt = t;
      if (t > stoppedAt + 2) break;      // hold the stop for two seconds
    } else {
      stoppedAt = -1;
    }
  }

  check('sortie: state stayed finite for the whole flight', fault === '', fault);
  check('sortie: got airborne under full power', airborneAt > 0 && airborneAt < 45,
    `${fmt(airborneAt)} s`);
  check('sortie: climbed to circuit height', peakAlt > CRUISE * 0.95, `${fmt(peakAlt, 0)} m`);
  check('sortie: came back and touched down', touchdownAt > airborneAt,
    touchdownAt > 0 ? `${fmt(touchdownAt)} s` : 'never landed');
  check('sortie: touchdown was survivable', touchdownAt > 0 && touchdownVs < 4.0,
    `${fmt(touchdownVs)} m/s`);
  check('sortie: ended stationary on the ground',
    stoppedAt >= 0 && st.onGround && st.groundSpeed < 0.5,
    `${fmt(st.groundSpeed, 3)} m/s, onGround=${st.onGround}`);
  check('sortie: did not explode', !(st.damage & DamageBits.Destroyed) && st.health > 0.8,
    `health ${fmt(st.health, 3)}`);
  check('sortie: undercarriage survived', !(st.damage & DamageBits.GearBroken));
  check('sortie: no prop strike', !st.propStrike);
  note(`airborne ${fmt(airborneAt)} s, peak ${fmt(peakAlt, 0)} m, touchdown ${fmt(touchdownAt)} s `
    + `at ${fmt(touchdownVs)} m/s, stopped ${fmt(stoppedAt)} s, health ${fmt(st.health, 3)}`);
}

/** 10. Taxiing: it can be steered and stopped. */
function testTaxi(spec: AircraftSpec, env: Environment): void {
  const st = createFlightState(spec, v3(0, 0, 0), q());
  placeOnGround(st, spec, env, 0, 0, 0);
  run(st, spec, env, 2, makeInput({ throttle: 0, bits: InputBits.WheelBrake }));

  // Open up gently and steer right.
  run(st, spec, env, 9, makeInput({ throttle: 0.14, yaw: 0.5, pitch: 0.6 }));
  const turned = wrapPi(st.heading);
  check('taxi: moves under its own power', st.groundSpeed > 2, `${fmt(st.groundSpeed)} m/s`);
  check('taxi: steers towards the rudder input', turned > 0.05, `${DEGf(turned)}°`);
  check('taxi: stays on its wheels', st.health > 0.95 && !st.propStrike);

  run(st, spec, env, 14, makeInput({ throttle: 0, pitch: 0.6, bits: InputBits.WheelBrake }));
  check('taxi: brakes bring it to a stop', st.groundSpeed < 1.2, `${fmt(st.groundSpeed)} m/s`);
  check('taxi: finite state', finite(st));
}

/** 11. Structural: overspeed flutters, over-g rips a wing. */
function testStructure(spec: AircraftSpec, env: Environment): void {
  // Over-g: yank the stick at corner speed and hold it.
  const d = getDerived(spec);
  const st = createFlightState(spec, v3(0, 4000, 0), q());
  spawnInFlight(st, spec, env, 4000, easToTas(Math.min(d.vCorner * 1.9, spec.aero.vne * 0.95), isaDensity(4000)), 0, 1);
  let ripped = false;
  for (let i = 0; i < Math.round(20 / DT); i++) {
    stepFlight(st, spec, makeInput({ throttle: 1, pitch: 1 }), env, DT);
    if (st.damage & DamageBits.WingRipped) { ripped = true; break; }
  }
  check('structure: over-g eventually rips a wing', ripped, `gPeak ${fmt(st.gPeak)}`);
  check('structure: g-limit respected before failure', st.gPeak > spec.aero.gLimit * 0.85,
    `${fmt(st.gPeak)} vs limit ${fmt(spec.aero.gLimit)}`);
  if (ripped) {
    let peakRoll = 0;
    for (let i = 0; i < Math.round(3 / DT); i++) {
      stepFlight(st, spec, makeInput({ throttle: 1 }), env, DT);
      peakRoll = Math.max(peakRoll, Math.abs(st.rollRate));
    }
    check('damage: a missing wing produces a violent roll', peakRoll > 1.6,
      `peak ${fmt(peakRoll)} rad/s`);
  }
  check('structure: finite after failure', finite(st));

  // Overspeed: a genuine near-vertical dive from height must reach VNE and
  // start to flutter.
  const st2 = createFlightState(spec, v3(0, 8000, 0), q());
  spawnInFlight(st2, spec, env, 8000, easToTas(140, isaDensity(8000)), 0, 1);
  setDive(st2, -1.15);
  let sawFlutter = false;
  let peakIas = 0;
  for (let i = 0; i < Math.round(70 / DT); i++) {
    // Hold the dive angle rather than letting it pull out.
    const pitchCmd = clamp01s((-1.15 - st2.pitchAngle) * 2.0 - st2.pitchRate * 1.2);
    stepFlight(st2, spec, makeInput({ throttle: 1, pitch: pitchCmd }), env, DT);
    peakIas = Math.max(peakIas, st2.ias);
    if (st2.flutter > 0.2) { sawFlutter = true; break; }
    if (st2.agl < 400) break;
  }
  check('structure: flutter above VNE', sawFlutter,
    `peak IAS ${fmt(peakIas * 3.6, 0)} km/h vs VNE ${fmt(spec.aero.vne * 3.6, 0)} km/h`);
}

/** 12. Pilot g-limits: sustained g greys out, negative g reds out. */
function testGEffects(spec: AircraftSpec, env: Environment): void {
  const d = getDerived(spec);
  const st = trimFlight(spec, env, 5000, Math.min(d.vCorner * 1.15, spec.aero.vne * 0.78)).state;
  const alphaTarget = spec.aero.stallAlpha * 0.85;
  let peakBlack = 0;
  let peakG = 0;
  let bank = 0;
  for (let i = 0; i < Math.round(22 / DT); i++) {
    // Hold the wing near its lift limit: the load factor follows the speed,
    // which is exactly the sustained-g case the pilot has to survive.
    const pitch = clamp01s(st.trimPitch + (alphaTarget - st.alpha) * 5.0 - st.pitchRate * 0.45);
    stepFlight(st, spec, makeInput({
      throttle: 1,
      pitch: clamp01s(pitch - st.trimPitch),
      roll: clamp01s(-bank * 2.2 - st.rollRate * 1.1),
      yaw: clamp01s(st.beta * 4.0 - st.yawRate * 0.8),
    }), env, DT);
    bank += st.rollRate * DT;
    peakBlack = Math.max(peakBlack, st.blackout);
    peakG = Math.max(peakG, st.gLoad);
    if (st.damage & DamageBits.WingRipped) break;
  }
  check('pilot: sustained g greys the pilot out', peakBlack > 0.3,
    `blackout ${fmt(peakBlack)} at up to ${fmt(peakG)} g`);
  check('pilot: gEffect exposed in 0..1', st.gEffect >= 0 && st.gEffect <= 1);

  // Recovery.
  run(st, spec, env, 14, makeInput({ throttle: 0.6 }));
  check('pilot: vision recovers when unloaded', st.blackout < 0.25, `${fmt(st.blackout)}`);

  // Negative g.
  const st2 = createFlightState(spec, v3(0, 4000, 0), q());
  spawnInFlight(st2, spec, env, 4000, easToTas(120, isaDensity(4000)), 0, 0.7);
  let peakRed = 0;
  for (let i = 0; i < Math.round(12 / DT); i++) {
    stepFlight(st2, spec, makeInput({ throttle: 0.5, pitch: -0.85 }), env, DT);
    peakRed = Math.max(peakRed, st2.redout);
  }
  check('pilot: negative g produces redout', peakRed > 0.25, `redout ${fmt(peakRed)}`);
  check('pilot: unconsciousness cuts the controls',
    !st2.pilotConscious || peakRed < 0.99 || Math.abs(st2.ctlPitch) < 0.9);
}

/** 13. Damage responses. */
function testDamage(spec: AircraftSpec, env: Environment): void {
  // Dead engine: the prop windmills and produces drag; the aircraft glides.
  const st = trimFlight(spec, env, 3000, 110).state;
  const speed0 = st.tas;
  st.damage |= DamageBits.Engine;
  run(st, spec, env, 12, makeInput({ throttle: 1 }));
  check('damage: dead engine stops making power', st.power < 1, `${fmt(st.power)} W`);
  check('damage: prop windmills into drag', st.thrust < 0, `${fmt(st.thrust, 0)} N`);
  check('damage: aircraft descends after engine failure', st.vertSpeed < -1.5,
    `${fmt(st.vertSpeed)} m/s`);
  check('damage: still finite', finite(st));
  void speed0;

  // Severed controls: the stick does nothing.
  const st2 = trimFlight(spec, env, 3000, 110).state;
  st2.damage |= DamageBits.ControlsSevered;
  run(st2, spec, env, 1.0, makeInput({ throttle: 0.7, roll: 1, pitch: 1, yaw: 1 }));
  check('damage: severed controls are dead',
    Math.abs(st2.ctlRoll) < 0.02 && Math.abs(st2.ctlPitch) < 0.02, `${fmt(st2.ctlRoll, 3)}`);

  // Holed wing: asymmetric lift produces a roll with the stick central.
  const st3 = trimFlight(spec, env, 3000, 110).state;
  st3.damage |= DamageBits.LeftWing;
  run(st3, spec, env, 3.5, makeInput({ throttle: 0.7 }));
  check('damage: a holed wing rolls the aircraft towards it', st3.rollRate < -0.03,
    `${fmt(st3.rollRate, 3)} rad/s`);
}

/**
 * 14. REQUIRED: the integrator is deterministic — the same seed and the same
 * inputs give a bit-identical state after 10 000 steps.
 *
 * This is a hard networking requirement, not a nicety: the client predicts
 * with this code and the server arbitrates with it, and any divergence at all
 * — one mantissa bit in one of the per-surface separation states — grows into
 * a visible rubber-band correction. So the comparison is a hash over *every*
 * field rather than a spot-check of position: a spot-check passes happily
 * while the parts of the state it does not look at have already parted company.
 */
function testDeterminism(spec: AircraftSpec, env: Environment): void {
  const STEPS = 10000;
  const SEED = 0xc0ffee;

  const build = (): FlightState => {
    const st = createFlightState(spec, v3(120, 2500, -60), q());
    spawnInFlight(st, spec, env, 2500, 140, 0.7, 0.85);
    return st;
  };
  /** The input stream is a pure function of the seed and the step index. */
  const inputs: InputFrame[] = [];
  {
    const rand = rng(SEED);
    for (let i = 0; i < STEPS; i++) {
      const t = i * DT;
      inputs.push(makeInput({
        throttle: 0.5 + 0.5 * Math.sin(t * 0.7),
        pitch: 0.5 * Math.sin(t * 1.3) + 0.25 * (rand() - 0.5),
        roll: 0.7 * Math.sin(t * 0.9 + 1) + 0.25 * (rand() - 0.5),
        yaw: 0.3 * Math.sin(t * 0.5) + 0.2 * (rand() - 0.5),
        bits: i % 900 === 200 ? InputBits.GearToggle
          : i % 900 === 400 ? InputBits.FlapsDown
            : i % 900 === 650 ? InputBits.FlapsUp : 0,
      }));
    }
  }

  const a = build();
  const b = build();
  check('determinism: two fresh states start identical', hashState(a) === hashState(b));
  for (let i = 0; i < STEPS; i++) {
    stepFlight(a, spec, inputs[i], env, DT);
    stepFlight(b, spec, inputs[i], env, DT);
  }
  const ha = hashState(a), hb = hashState(b);
  check(`determinism: bit-identical over ${STEPS} steps`, ha === hb, `${ha} vs ${hb}`);
  check('determinism: 10 000 steps of aggressive input stays finite', stateFault(a) === '',
    stateFault(a));

  // Replaying the same stream from scratch must land on the same hash too —
  // this is the property replay and server reconciliation actually rely on,
  // and it is stronger than running two copies side by side (which would still
  // agree if the model read a hidden global that changed between runs).
  const c = build();
  for (let i = 0; i < STEPS; i++) stepFlight(c, spec, inputs[i], env, DT);
  check('determinism: a replay of the same stream reproduces the state exactly',
    hashState(c) === ha, `${hashState(c)} vs ${ha}`);

  // A negative control: the comparison must be capable of failing. Perturb the
  // initial condition by one part in 10^9 and the hash has to come out
  // different, otherwise "identical" is meaningless.
  //
  // The perturbation goes into the *state*, not into a control input. A tiny
  // change to stick position can be swallowed whole — 'demandPitch' is clamped
  // to ±1, so once the stick is against its stop, adding 1e-9 to it changes
  // literally nothing and the check fails for a reason that has nothing to do
  // with determinism.
  const dstate = build();
  dstate.vel.z += 1e-9;
  for (let i = 0; i < STEPS; i++) stepFlight(dstate, spec, inputs[i], env, DT);
  check('determinism: the comparison can detect a 1e-9 divergence',
    hashState(dstate) !== ha, `${hashState(dstate)} vs ${ha}`);

  // Variable frame rate will not be bit-identical — a different dt means a
  // different substep count — but it must not change the outcome qualitatively.
  const e = build();
  let t = 0;
  while (t < 20) {
    const dt = t % 0.4 < 0.2 ? 1 / 120 : 1 / 30;
    const inp = makeInput({
      throttle: 0.5 + 0.5 * Math.sin(t * 0.7),
      pitch: 0.5 * Math.sin(t * 1.3),
      roll: 0.7 * Math.sin(t * 0.9 + 1),
      yaw: 0.3 * Math.sin(t * 0.5),
    });
    stepFlight(e, spec, inp, env, dt);
    t += dt;
  }
  check('determinism: stable at mixed timesteps', stateFault(e) === '', stateFault(e));
}

/**
 * 14b. REQUIRED: no NaN or Infinity ever appears in any state field under five
 * minutes of random input.
 *
 * The input is deliberately hostile — full-scale stick reversals at random
 * intervals, the throttle slammed about, gear and flaps cycled at any speed,
 * WEP toggled — and the runs start from conditions chosen to provoke the
 * numerically nasty corners: on the deck, at the service ceiling, at the stall,
 * and beyond VNE in a dive. Every field of the state is scanned every step,
 * including the per-surface and per-undercarriage-leg typed arrays.
 */
function testNoNaN(spec: AircraftSpec, env: Environment): void {
  const MINUTES = 5;
  const STEPS = Math.round((MINUTES * 60) / DT);
  const d = getDerived(spec);

  const starts: [string, () => FlightState][] = [
    ['on the deck', () => {
      const st = createFlightState(spec, v3(0, 60, 0), q());
      spawnInFlight(st, spec, env, 60, easToTas(90, isaDensity(60)), 0.4, 1);
      return st;
    }],
    ['at the ceiling', () => {
      const st = createFlightState(spec, v3(0, 10500, 0), q());
      spawnInFlight(st, spec, env, 10500, easToTas(110, isaDensity(10500)), -2, 1);
      return st;
    }],
    ['on the stall', () => {
      const st = createFlightState(spec, v3(0, 3000, 0), q());
      spawnInFlight(st, spec, env, 3000, d.vStall * 1.02, 1.5, 0.2);
      return st;
    }],
    ['past VNE', () => {
      const st = createFlightState(spec, v3(0, 7000, 0), q());
      spawnInFlight(st, spec, env, 7000, easToTas(spec.aero.vne * 1.05, isaDensity(7000)), 3, 1);
      setDive(st, -1.0);
      return st;
    }],
    ['from a runway start', () => {
      const st = createFlightState(spec, v3(0, 0, 0), q());
      placeOnGround(st, spec, env, 0, 0, 0.6);
      return st;
    }],
  ];

  const ALL_BITS = InputBits.GearToggle | InputBits.FlapsDown | InputBits.FlapsUp
    | InputBits.Boost | InputBits.BrakeAir | InputBits.WheelBrake | InputBits.Radiator;

  let worstFault = '';
  let worstWhere = '';
  let totalSteps = 0;
  for (let s = 0; s < starts.length; s++) {
    const [label, make] = starts[s];
    const st = make();
    const rand = rng(0x5eed + s * 7919 + spec.id.length * 131);
    const inp = makeInput();
    let hold = 0;
    for (let i = 0; i < STEPS; i++) {
      // Hold each random control position for a short, random dwell so the
      // aircraft actually departs rather than being averaged into stillness by
      // per-step noise.
      if (hold <= 0) {
        hold = 1 + Math.floor(rand() * 40);
        inp.pitch = rand() * 2 - 1;
        inp.roll = rand() * 2 - 1;
        inp.yaw = rand() * 2 - 1;
        inp.throttle = rand();
        // Fire a random subset of the discrete bits.
        let bits = 0;
        for (let b = 1; b <= ALL_BITS; b <<= 1) if ((ALL_BITS & b) && rand() < 0.08) bits |= b;
        inp.bits = bits;
      }
      hold--;
      stepFlight(st, spec, inp, env, DT);
      totalSteps++;
      const f = stateFault(st);
      if (f) { worstFault = f; worstWhere = `${label} @ step ${i}`; break; }
    }
    if (worstFault) break;
  }

  check(`no NaN/Inf in any state field over ${MINUTES} min of random input × ${starts.length} starts`,
    worstFault === '', worstFault ? `${worstFault}  (${worstWhere})` : `${totalSteps} steps clean`);
}

/** 15. Compressibility: a high-Mach dive tucks and stiffens. */
function testCompressibility(spec: AircraftSpec, env: Environment): void {
  const st = createFlightState(spec, v3(0, 11000, 0), q());
  spawnInFlight(st, spec, env, 11000, easToTas(150, isaDensity(11000)), 0, 1);
  setDive(st, -1.2);
  let peakMach = 0;
  let minAuth = 1;
  let tucked = false;
  let sawTuckMoment = false;
  for (let i = 0; i < Math.round(60 / DT); i++) {
    // Hold the dive with a fixed, modest nose-down input so that any nose-down
    // divergence has to come from the aerodynamics, not the pilot.
    stepFlight(st, spec, makeInput({ throttle: 1, pitch: 0.15 }), env, DT);
    peakMach = Math.max(peakMach, st.mach);
    minAuth = Math.min(minAuth, st.authPitch);
    if (st.mach > spec.aero.machCrit) {
      sawTuckMoment = true;
      if (st.pitchRate < -0.02) tucked = true;
    }
    if (st.altitude < 2500 || (st.damage & DamageBits.WingRipped)) break;
  }
  check('mach: dive passes the critical Mach', peakMach > spec.aero.machCrit,
    `M ${fmt(peakMach, 3)} vs Mcrit ${fmt(spec.aero.machCrit, 2)}`);
  check('mach: control authority falls', minAuth < 0.85, `authPitch ${fmt(minAuth)}`);
  check('mach: finite state', finite(st));
  void tucked; void sawTuckMoment;

  // Mach tuck, measured directly rather than inferred: the same aircraft at
  // the same alpha and altitude, once below and once above its critical Mach.
  // Dividing the resulting angular acceleration by dynamic pressure removes
  // the trivial "faster means bigger moments" effect, so what is left is the
  // rearward migration of the centre of pressure.
  const mLow = pitchAccelPerQ(spec, env, 10000, spec.aero.machCrit - 0.20, 0.03);
  const mHigh = pitchAccelPerQ(spec, env, 10000, spec.aero.machCrit + 0.13, 0.03);
  // +X angular acceleration is nose-DOWN in this body frame.
  check('mach: the nose tucks under above Mcrit', mHigh > mLow * 1.05 + 1e-6,
    `nose-down moment/q ${fmt(mLow * 1e3, 3)} → ${fmt(mHigh * 1e3, 3)} (×1e-3)`);
  note(`peak M ${fmt(peakMach, 3)}  IAS ${fmt(st.ias * 3.6, 0)} km/h  authPitch ${fmt(minAuth)}  `
    + `flutter ${fmt(st.flutter)}  gFatigue ${fmt(st.gFatigue)}`);
}

/** 16. Engine systems: altitude power curve, WEP limit, overheat, fuel. */
function testEngineSystems(spec: AircraftSpec, env: Environment): void {
  const d = getDerived(spec);
  const powerAt = (alt: number): number => {
    const st = createFlightState(spec, v3(0, alt, 0), q());
    spawnInFlight(st, spec, env, alt, easToTas(110, isaDensity(alt)), 0, 1);
    const ap = newAutopilot();
    for (let i = 0; i < Math.round(20 / DT); i++) {
      const inp = autopilotStep(ap, st, spec, { altitude: alt, throttle: 1 }, DT);
      stepFlight(st, spec, inp, env, DT);
    }
    return st.power;
  };
  // REQUIRED: engine power falls off above the supercharger critical altitude.
  // Below it the supercharger holds manifold pressure, so power is flat or
  // rising with altitude as the air cools and gets thinner to push through;
  // above it the blower is on its stops, manifold pressure follows ambient
  // down, and power falls away. The falloff has to be monotone — a single
  // sample pair would pass on a curve that wobbles.
  const ca = spec.engine.critAlt;
  const pSl = powerAt(200);
  const pCrit = powerAt(ca);
  const above = [1000, 2000, 3000].map((dz) => powerAt(Math.min(ca + dz, 11000)));
  const pHigh = above[2];

  check('engine: supercharged — power at the critical altitude is not below sea level',
    pCrit >= pSl * 0.98, `${fmt(pSl / 1000, 0)} → ${fmt(pCrit / 1000, 0)} kW`);
  check('engine: falls off above the critical altitude', pHigh < pCrit * 0.88,
    `${fmt(pCrit / 1000, 0)} → ${fmt(pHigh / 1000, 0)} kW `
    + `(${fmt((100 * pHigh) / pCrit, 0)}% at +3 km)`);
  check('engine: the falloff is monotone', above[1] < above[0] && above[2] < above[1],
    `+1/2/3 km: ${above.map((p) => fmt(p / 1000, 0)).join(' / ')} kW`);
  check('engine: loses at least a fifth of its power 3 km above critical',
    pHigh < pCrit * 0.88 && pHigh > pCrit * 0.5,
    `${fmt(100 - (100 * pHigh) / pCrit, 0)}% lost`);
  check('engine: rated power in the right ballpark',
    pSl > spec.engine.powerKw * 600 && pSl < spec.engine.powerKw * 1300,
    `${fmt(pSl / 1000, 0)} kW vs rated ${spec.engine.powerKw} kW`);
  note(`power SL ${fmt(pSl / 1000, 0)} kW, crit ${fmt(pCrit / 1000, 0)} kW, `
    + `+1/2/3 km ${above.map((p) => fmt(p / 1000, 0)).join('/')} kW`);

  // WEP time limit.
  const st = createFlightState(spec, v3(0, 1000, 0), q());
  spawnInFlight(st, spec, env, 1000, easToTas(130, isaDensity(1000)), 0, 1);
  st.radiatorAuto = true;
  const ap = newAutopilot();
  let wepOn = false;
  let wepCut = -1;
  for (let i = 0; i < Math.round(260 / DT); i++) {
    const bits = i === 60 ? InputBits.Boost : 0;
    const g = autopilotStep(ap, st, spec, { altitude: 1000, throttle: 1, bits }, DT);
    stepFlight(st, spec, g, env, DT);
    if (st.wep) wepOn = true;
    if (wepOn && !st.wep && wepCut < 0) wepCut = i * DT;
  }
  check('engine: WEP engages', wepOn);
  check('engine: WEP times out', wepCut > 60 && wepCut < 260, `cut at ${fmt(wepCut, 0)} s`);
  check('engine: burns fuel', st.fuel < spec.damage.fuel, `${fmt(st.fuel, 0)} kg left`);

  // Radiator shut on full power must overheat.
  const st2 = createFlightState(spec, v3(0, 500, 0), q());
  spawnInFlight(st2, spec, env, 500, easToTas(110, isaDensity(500)), 0, 1);
  st2.radiatorAuto = false;
  st2.radiator = 0;
  const ap2 = newAutopilot();
  let peakCoolant = 0;
  let peakOverheat = 0;
  for (let i = 0; i < Math.round(120 / DT); i++) {
    st2.radiatorAuto = false;
    st2.radiator = 0;
    const g = autopilotStep(ap2, st2, spec, { altitude: 500, throttle: 1 }, DT);
    stepFlight(st2, spec, g, env, DT);
    peakCoolant = Math.max(peakCoolant, st2.coolantTemp);
    peakOverheat = Math.max(peakOverheat, st2.overheat);
  }
  check('engine: shut radiator overheats', peakCoolant > 118 && peakOverheat > 0.1,
    `${fmt(peakCoolant, 0)} °C, overheat ${fmt(peakOverheat)}`);
  check('engine: overheat wrecks the engine', st2.engineHealth < 0.9,
    `health ${fmt(st2.engineHealth)}`);
  void d;
}

/** 17. Propeller secondary effects at high power and low speed. */
function testPropEffects(spec: AircraftSpec, env: Environment): void {
  const st = createFlightState(spec, v3(0, 0, 0), q());
  placeOnGround(st, spec, env, 0, 0, 0);
  run(st, spec, env, 2, makeInput({ throttle: 0, bits: InputBits.WheelBrake }));
  // Full power, no rudder: it must swing, and always the same way for a given
  // rotation direction.
  const h0 = st.heading;
  for (let i = 0; i < Math.round(7 / DT); i++) {
    stepFlight(st, spec, makeInput({ throttle: 1, pitch: 0.2 }), env, DT);
  }
  const swing = wrapPi(st.heading - h0);
  const expected = -spec.engine.propDir;   // clockwise prop swings left
  check('prop: torque and slipstream swing the aircraft on take-off',
    Math.abs(swing) > 0.02 && Math.sign(swing) === expected,
    `${DEGf(swing)}° (propDir ${spec.engine.propDir})`);
  note(`swing ${DEGf(swing)}°  swirl ${fmt(st.propSwirl)} rad/s  torque ${fmt(st.propTorque, 0)} N·m`);

  // Airborne torque roll with the stick central: compare a full-power run with
  // an idle one from the identical state, so only the powerplant differs.
  const rollAfter = (throttle: number): number => {
    const s = createFlightState(spec, v3(0, 2000, 0), q());
    spawnInFlight(s, spec, env, 2000, easToTas(80, isaDensity(2000)), 0, throttle);
    let acc = 0;
    for (let i = 0; i < Math.round(5 / DT); i++) {
      stepFlight(s, spec, makeInput({ throttle }), env, DT);
      acc += s.rollRate * DT;
    }
    return acc;
  };
  const dRoll = rollAfter(1) - rollAfter(0.08);
  check('prop: torque reaction rolls against the propeller',
    Math.abs(dRoll) > 0.02 && Math.sign(dRoll) === -spec.engine.propDir,
    `Δroll ${fmt(dRoll, 3)} rad (propDir ${spec.engine.propDir})`);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function clampS(v: number, m: number): number { return v < -m ? -m : v > m ? m : v; }

/**
 * Instantaneous pitching angular acceleration per unit dynamic pressure, with
 * the aircraft frozen at a given Mach, altitude and alpha and the stick
 * central. Positive is nose-down.
 */
function pitchAccelPerQ(
  spec: AircraftSpec, env: Environment, alt: number, mach: number, alpha: number,
): number {
  const a = atmosphereAt(alt);
  const V = mach * a.soundSpeed;
  const st = createFlightState(spec, v3(0, alt, 0), q());
  spawnInFlight(st, spec, env, alt, V, 0, 0);
  st.vel.x = 0;
  st.vel.y = -V * Math.sin(alpha);
  st.vel.z = V * Math.cos(alpha);
  st.omega.x = 0; st.omega.y = 0; st.omega.z = 0;
  st.trimPitch = 0;
  stepFlight(st, spec, makeInput({ throttle: 0 }), env, 1 / 240);
  return st.alphaDotBody.x / Math.max(st.qbar, 1);
}

/** Point an already-flying aircraft down (or up) by 'pitch' radians. */
function setDive(st: FlightState, pitch: number): void {
  const h = pitch * 0.5;
  // Nose-up is a negative rotation about body +X, so a dive is positive.
  st.rot.x = Math.sin(-h); st.rot.y = 0; st.rot.z = 0; st.rot.w = Math.cos(-h);
  const sp = Math.hypot(st.vel.x, st.vel.y, st.vel.z) || 1;
  st.vel.x = 0;
  st.vel.y = sp * Math.sin(pitch);
  st.vel.z = sp * Math.cos(pitch);
  st.omega.x = 0; st.omega.y = 0; st.omega.z = 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function testAircraft(spec: AircraftSpec): void {
  const env = flatEnvironment();
  console.log(`\n=== ${spec.name} (${spec.id}) ===`);
  const groups: [string, () => void][] = [
    ['geometry', () => testDerived(spec)],
    ['level flight', () => testLevelFlight(spec, env)],
    ['performance', () => testPerformance(spec, env)],
    ['loop', () => testLoop(spec, env)],
    ['stall', () => testStall(spec, env)],
    ['wing drop', () => testWingDrop(spec, env)],
    ['spin', () => testSpin(spec, env)],
    ['roll rate', () => testRollRate(spec, env)],
    ['take-off', () => testTakeoff(spec, env)],
    ['landing', () => testLanding(spec, env)],
    ['sortie', () => testSortie(spec, env)],
    ['taxi', () => testTaxi(spec, env)],
    ['structure', () => testStructure(spec, env)],
    ['pilot g', () => testGEffects(spec, env)],
    ['damage', () => testDamage(spec, env)],
    ['determinism', () => testDeterminism(spec, env)],
    ['NaN soak', () => testNoNaN(spec, env)],
    ['compressibility', () => testCompressibility(spec, env)],
    ['engine systems', () => testEngineSystems(spec, env)],
    ['propeller effects', () => testPropEffects(spec, env)],
  ];
  for (const [label, fn] of groups) {
    const before = failed;
    console.log(`  -- ${label}`);
    try {
      fn();
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
      failures.push(`${spec.id}/${label} threw: ${msg}`);
      console.log(`    FAIL  threw: ${msg}`);
    }
    if (failed > before && !VERBOSE) console.log(`         (${failed - before} failure(s) in ${label})`);
  }
}

/**
 * Throughput check. The server has to run this for every aircraft in the match
 * at 60 Hz on one thread, and the client re-runs it for every unacknowledged
 * input during reconciliation, so the per-step cost is a design constraint.
 */
function benchmark(spec: AircraftSpec, env: Environment): void {
  const st = createFlightState(spec, v3(0, 3000, 0), q());
  spawnInFlight(st, spec, env, 3000, 150, 0, 0.9);
  const inp = makeInput({ throttle: 0.9, pitch: 0.2, roll: 0.3, yaw: 0.1 });
  for (let i = 0; i < 2000; i++) stepFlight(st, spec, inp, env, DT);   // warm up JIT
  const N = 60000;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) stepFlight(st, spec, inp, env, DT);
  const us = Number(process.hrtime.bigint() - t0) / 1000 / N;
  console.log(`\n  step cost: ${us.toFixed(2)} µs  `
    + `→ ${Math.round(1e6 / (us * 60))} aircraft at 60 Hz on one core`);
  check('performance: step cost under 40 µs', us < 40, `${us.toFixed(2)} µs`);
}

function main(): void {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const list = arg ? [AIRCRAFT_BY_ID[arg]].filter(Boolean) : AIRCRAFT;
  if (!list.length) {
    console.error(`unknown aircraft "${arg}". known: ${AIRCRAFT.map((a) => a.id).join(', ')}`);
    process.exit(2);
  }
  const t0 = Date.now();
  for (const spec of list) testAircraft(spec);
  benchmark(list[0], flatEnvironment());
  const ms = Date.now() - t0;

  console.log('\n' + '='.repeat(64));
  console.log(`  ${passed} passed, ${failed} failed   (${ms} ms)`);
  if (failed) {
    console.log('\n  failures:');
    for (const f of failures) console.log(`   - ${f}`);
  }
  console.log('='.repeat(64));
  process.exit(failed ? 1 : 0);
}

main();

export { };
