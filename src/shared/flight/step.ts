/**
 * The integrator.
 *
 * 'stepFlight' is the only entry point the rest of the game needs. It is a
 * pure function of (state, spec, input, environment, dt) — no clocks, no
 * randomness, no allocation in the hot path — so the browser client can
 * predict with it, the headless server can arbitrate with it, and replaying
 * the same input stream reproduces the same flight exactly.
 *
 * Ordering inside one call:
 *
 *   1. Damage bits → run-time multipliers, mass, inertia and CG.
 *   2. Air-relative kinematics and the atmosphere (once per frame).
 *   3. Controls and systems (flaps, gear, brakes, trim, stick force).
 *   4. Powerplant (stiff, integrated with a linearised implicit step).
 *   5. N rigid-body substeps of the airframe at ≤ 1/180 s each.
 *   6. Structural and physiological limits, then the readouts.
 *
 * The substep count is a deterministic function of 'dt' alone, so client and
 * server take exactly the same path through the code for the same frame.
 */

import {
  clamp, q, qIntegrate, qcopy, qmul, qnorm, qrot, qrotInv, smoothstep, v3, vcopy, vlen, vset,
  type Q, type V3,
} from '../math';
import type { AircraftSpec } from '../aircraft';
import { DamageBits, type EntityState, type InputFrame } from '../protocol';
import { atmosphereAt, tasToEas } from './atmosphere';
import { evalSurface, makeAeroContext, resetAeroOutputs, waveDrag, type AeroContext } from './aero';
import { updateControls, updateDamageFactors } from './controls';
import { getDerived } from './derive';
import { applyPropForces, governorGuess, updateEngine } from './engine';
import { applyGroundContact } from './gear';
import { updatePilot, updateStructure } from './pilot';
import {
  G0, MAX_SUBSTEP, type AtmoSample, type DamageFactors, type DerivedSpec,
  type Environment, type FlightState,
} from './types';

// --- module-level scratch: nothing below allocates during a step ------------
const _wind = v3();
const _relWorld = v3();
const _velBody = v3();
const _fBody = v3();
const _mBody = v3();
const _fWorld = v3();
const _omegaDot = v3();
const _tmp = v3();
const _fwd = v3();
const _right = v3();
const _up = v3();
const _ctx: AeroContext = makeAeroContext();

function newDamageFactors(): DamageFactors {
  return {
    wingL: 1, wingR: 1, wingLGone: false, wingRGone: false, extraDrag: 0,
    tail: 1, elevator: 1, aileron: 1, rudder: 1,
    engine: 1, engineDead: false, pilot: 1, gearOk: true,
  };
}

/**
 * Build a fresh airborne-capable state. The engine is left idling and cold —
 * call 'primeEngine' (or 'spawnInFlight') for an air start.
 */
export function createFlightState(spec: AircraftSpec, pos: V3, rot: Q): FlightState {
  const d = getDerived(spec);
  const n = d.nSurf;
  const st: FlightState = {
    pos: vcopy(pos),
    vel: v3(),
    rot: qcopy(rot),
    omega: v3(),

    velBody: v3(),
    accBody: v3(),
    alphaDotBody: v3(),
    tas: 0, ias: 0, mach: 0, alpha: 0, beta: 0,
    altitude: pos.y, agl: 0, qbar: 0, vertSpeed: 0, groundSpeed: 0,
    pitchRate: 0, rollRate: 0, yawRate: 0,
    pitchAngle: 0, rollAngle: 0, heading: 0, gamma: 0,

    throttle: 0, throttleCmd: 0,
    rpm: 0, propRpm: 0, engOmega: (spec.engine.maxRpm * 2 * Math.PI / 60) * 0.2,
    manifold: d.mapIdle, power: 0, thrust: 0, propTorque: 0,
    bladePitch: 0.25, propWash: 0, propSwirl: 0,
    wep: false, wepHeat: 0, wepLockout: false,
    oilTemp: 20, coolantTemp: 20, radiator: 0.3, radiatorAuto: true,
    fuel: spec.damage.fuel, engineRunning: true, engineHealth: 1, overheat: 0,

    ctlPitch: 0, ctlRoll: 0, ctlYaw: 0,
    demandPitch: 0, demandRoll: 0, demandYaw: 0,
    trimPitch: 0, trimRoll: 0, trimYaw: 0,
    authPitch: 1, authRoll: 1, authYaw: 1,
    flaps: 0, flapsTarget: 0, gear: 1, gearTarget: 1,
    airbrake: 0, airbrakeTarget: 0, wheelBrake: 0, steer: 0, prevBits: 0,

    buffet: 0, stallL: 0, stallR: 0, stalled: false, spinning: 0,
    liftL: 0, liftR: 0,

    gLoad: 1, gPeak: 1, gFatigue: 0, flutter: 0, flutterDamage: 0,
    blackout: 0, redout: 0, gStrainPos: 0, gStrainNeg: 0,
    gEffect: 0, gEffectSign: 1, pilotConscious: true, koTimer: 0,

    onGround: false,
    gearCompress: new Float64Array(d.nLegs),
    gearLoad: new Float64Array(d.nLegs),
    wheelSpin: new Float64Array(d.nLegs),
    touchdownVs: 0, scrape: 0, propStrike: false,

    damage: 0, health: 1, extraMass: 0,

    sep: new Float64Array(n),
    alphaPrev: new Float64Array(n),
    alphaRate: new Float64Array(n),
    downwashLag: 0,
    mass: d.massFull,
    inertia: vcopy(d.inertia),
    cgOffset: v3(),
    age: 0,
    dmg: newDamageFactors(),
  };
  return st;
}

/** Deep copy — the client needs one per prediction snapshot. */
export function cloneFlightState(s: FlightState): FlightState {
  return {
    ...s,
    pos: vcopy(s.pos), vel: vcopy(s.vel), rot: qcopy(s.rot), omega: vcopy(s.omega),
    velBody: vcopy(s.velBody), accBody: vcopy(s.accBody), alphaDotBody: vcopy(s.alphaDotBody),
    inertia: vcopy(s.inertia), cgOffset: vcopy(s.cgOffset),
    gearCompress: s.gearCompress.slice(),
    gearLoad: s.gearLoad.slice(),
    wheelSpin: s.wheelSpin.slice(),
    sep: s.sep.slice(), alphaPrev: s.alphaPrev.slice(), alphaRate: s.alphaRate.slice(),
    dmg: { ...s.dmg },
  };
}

/** In-place copy — allocation-free reconciliation. */
export function copyFlightState(dst: FlightState, src: FlightState): void {
  const keep = {
    pos: dst.pos, vel: dst.vel, rot: dst.rot, omega: dst.omega,
    velBody: dst.velBody, accBody: dst.accBody, alphaDotBody: dst.alphaDotBody,
    inertia: dst.inertia, cgOffset: dst.cgOffset,
    gearCompress: dst.gearCompress, gearLoad: dst.gearLoad, wheelSpin: dst.wheelSpin,
    sep: dst.sep, alphaPrev: dst.alphaPrev, alphaRate: dst.alphaRate, dmg: dst.dmg,
  };
  Object.assign(dst, src, keep);
  vset(keep.pos, src.pos.x, src.pos.y, src.pos.z);
  vset(keep.vel, src.vel.x, src.vel.y, src.vel.z);
  keep.rot.x = src.rot.x; keep.rot.y = src.rot.y; keep.rot.z = src.rot.z; keep.rot.w = src.rot.w;
  vset(keep.omega, src.omega.x, src.omega.y, src.omega.z);
  vset(keep.velBody, src.velBody.x, src.velBody.y, src.velBody.z);
  vset(keep.accBody, src.accBody.x, src.accBody.y, src.accBody.z);
  vset(keep.alphaDotBody, src.alphaDotBody.x, src.alphaDotBody.y, src.alphaDotBody.z);
  vset(keep.inertia, src.inertia.x, src.inertia.y, src.inertia.z);
  vset(keep.cgOffset, src.cgOffset.x, src.cgOffset.y, src.cgOffset.z);
  keep.gearCompress.set(src.gearCompress);
  keep.gearLoad.set(src.gearLoad);
  keep.wheelSpin.set(src.wheelSpin);
  keep.sep.set(src.sep);
  keep.alphaPrev.set(src.alphaPrev);
  keep.alphaRate.set(src.alphaRate);
  Object.assign(keep.dmg, src.dmg);
}

// ---------------------------------------------------------------------------

/** Mass, inertia and CG offset for the current fuel load and damage state. */
function updateMass(st: FlightState, d: DerivedSpec): void {
  const f = st.dmg;
  const lostL = f.wingLGone ? d.wingMass : 0;
  const lostR = f.wingRGone ? d.wingMass : 0;
  const m = Math.max(200, d.massDry + st.fuel + st.extraMass - lostL - lostR);
  st.mass = m;
  // Losing a wing moves the centre of gravity towards the one that is left,
  // which is why the survivor's lift then produces an unrecoverable roll.
  st.cgOffset.x = (lostL * d.wingMassArm - lostR * d.wingMassArm) / m;
  st.cgOffset.y = 0;
  st.cgOffset.z = 0;

  const armSq = d.wingMassArm * d.wingMassArm;
  const massScale = m / d.massFull;
  st.inertia.x = Math.max(200, d.inertia.x * massScale - (lostL + lostR) * d.wingMass * 0.3);
  st.inertia.y = Math.max(200, d.inertia.y * massScale
    - (f.wingLGone ? d.wingMass * armSq * 0.9 : 0) - (f.wingRGone ? d.wingMass * armSq * 0.9 : 0));
  st.inertia.z = Math.max(120, d.inertia.z * massScale
    - (f.wingLGone ? d.wingMass * armSq : 0) - (f.wingRGone ? d.wingMass * armSq : 0));
}

/** Air-relative kinematics for the current pose. */
function updateKinematics(st: FlightState, env: Environment, atmo: AtmoSample): void {
  env.windAt(st.pos, _wind);
  _relWorld.x = st.vel.x - _wind.x;
  _relWorld.y = st.vel.y - _wind.y;
  _relWorld.z = st.vel.z - _wind.z;
  qrotInv(st.rot, _relWorld, _velBody);
  st.velBody.x = _velBody.x; st.velBody.y = _velBody.y; st.velBody.z = _velBody.z;
  const tas = vlen(_velBody);
  st.tas = tas;
  st.ias = tasToEas(tas, atmo.density);
  st.mach = tas / Math.max(atmo.soundSpeed, 1);
  st.qbar = 0.5 * atmo.density * tas * tas;
  st.alpha = Math.atan2(-_velBody.y, Math.abs(_velBody.z) < 1e-3 ? 1e-3 : _velBody.z);
  st.beta = tas > 0.5 ? Math.asin(clamp(_velBody.x / tas, -1, 1)) : 0;
}

/**
 * One rigid-body substep: build the total body-frame force and moment from
 * every source, then advance with a semi-implicit (symplectic) Euler step.
 */
function integrate(
  st: FlightState, d: DerivedSpec, env: Environment, atmo: AtmoSample, h: number,
): void {
  updateKinematics(st, env, atmo);

  _fBody.x = 0; _fBody.y = 0; _fBody.z = 0;
  _mBody.x = 0; _mBody.y = 0; _mBody.z = 0;

  const c = _ctx;
  const aero = d.spec.aero;
  resetAeroOutputs(c);
  c.rho = atmo.density;
  c.mach = st.mach;
  c.machCrit = aero.machCrit;
  c.elev = st.ctlPitch;
  c.ail = st.ctlRoll;
  c.rud = st.ctlYaw;
  c.flap = st.flaps;
  c.washAxial = 2 * st.propWash;
  c.swirl = st.propSwirl;
  c.swirlCore = d.slipRadius * 0.6;
  c.propAxisY = d.propPos.y - st.cgOffset.y;
  c.downwashV = 0;
  c.scaleWingL = st.dmg.wingL;
  c.scaleWingR = st.dmg.wingR;
  c.scaleTail = st.dmg.tail;
  c.scaleFin = st.dmg.tail;
  c.goneWingL = st.dmg.wingLGone;
  c.goneWingR = st.dmg.wingRGone;
  // Mach tuck: the centre of pressure migrates aft through the transonic rise,
  // producing a nose-down moment that grows faster than the elevator can fight.
  c.wingAcShift = -0.28 * d.chord * smoothstep(aero.machCrit, aero.machCrit + 0.13, st.mach);

  // ---- lifting surfaces --------------------------------------------------
  let downwashDone = false;
  for (let i = 0; i < d.nSurf; i++) {
    const s = d.surfaces[i];
    if (!s.isWing && !downwashDone) { finishDownwash(c, d, st, h); downwashDone = true; }
    evalSurface(s, d, c, st.velBody, st.omega, st.cgOffset, st.sep, st.alphaRate, st.alphaPrev, h, _fBody, _mBody);
  }
  if (!downwashDone) finishDownwash(c, d, st, h);

  // ---- residual parasite drag -------------------------------------------
  // Everything the strips do not represent: cooling, radiators, gaps,
  // interference, the gear, the flaps and the holes shot in the airframe.
  let cdArea = d.parasiteArea
    + d.gearArea * st.gear
    + d.flapArea * st.flaps
    + d.brakeArea * st.airbrake
    + d.radiatorArea * st.radiator
    + st.dmg.extraDrag * d.wingArea;
  cdArea += waveDrag(st.mach, aero.machCrit) * d.wingArea * 0.35;
  if (st.tas > 0.2) {
    const kD = 0.5 * atmo.density * st.tas * cdArea;
    _fBody.x -= kD * st.velBody.x;
    _fBody.y -= kD * st.velBody.y;
    _fBody.z -= kD * st.velBody.z;
  }

  // ---- propulsion --------------------------------------------------------
  applyPropForces(st, d, st.velBody, st.omega, st.cgOffset, _fBody, _mBody);

  // ---- residual rate damping --------------------------------------------
  // Pure damping about each body axis, so it is sign-convention agnostic.
  {
    const V = Math.max(st.tas, 22);
    const qS = st.qbar * d.wingArea;
    // Roll damping is a *wing* derivative: it exists because a rolling wing
    // changes its own local alpha. Once the flow separates that mechanism
    // inverts, so the residual term has to fade out with it — otherwise an
    // artificial damper keeps suppressing the autorotation that ought to be
    // the whole point of a stalled wing. Pitch and yaw damping come from the
    // tail, which is still flying, so they stay.
    const sepMax = Math.max(
      c.sepLW > 0 ? c.sepL / c.sepLW : 0,
      c.sepRW > 0 ? c.sepR / c.sepRW : 0,
    );
    const clp = d.clpRes * (1 - 0.9 * sepMax);
    _mBody.x -= (d.cmqRes * qS * d.chord * d.chord) / (2 * V) * st.omega.x;
    _mBody.y -= (d.cnrRes * qS * d.span * d.span) / (2 * V) * st.omega.y;
    _mBody.z -= (clp * qS * d.span * d.span) / (2 * V) * st.omega.z;
  }

  // ---- ground ------------------------------------------------------------
  applyGroundContact(st, d, env, st.rot, st.pos, st.vel, st.omega, st.cgOffset, _fBody, _mBody, h);

  // ---- integrate ---------------------------------------------------------
  const invM = 1 / st.mass;
  st.accBody.x = _fBody.x * invM;
  st.accBody.y = _fBody.y * invM;
  st.accBody.z = _fBody.z * invM;

  qrot(st.rot, _fBody, _fWorld);
  st.vel.x += (_fWorld.x * invM) * h;
  st.vel.y += (_fWorld.y * invM - G0) * h;
  st.vel.z += (_fWorld.z * invM) * h;

  // ω̇ = I⁻¹ (M − ω × Iω)
  const Ix = st.inertia.x, Iy = st.inertia.y, Iz = st.inertia.z;
  const hx = Ix * st.omega.x, hy = Iy * st.omega.y, hz = Iz * st.omega.z;
  _omegaDot.x = (_mBody.x - (st.omega.y * hz - st.omega.z * hy)) / Ix;
  _omegaDot.y = (_mBody.y - (st.omega.z * hx - st.omega.x * hz)) / Iy;
  _omegaDot.z = (_mBody.z - (st.omega.x * hy - st.omega.y * hx)) / Iz;
  st.alphaDotBody.x = _omegaDot.x;
  st.alphaDotBody.y = _omegaDot.y;
  st.alphaDotBody.z = _omegaDot.z;

  st.omega.x += _omegaDot.x * h;
  st.omega.y += _omegaDot.y * h;
  st.omega.z += _omegaDot.z * h;
  // Nothing in this envelope legitimately exceeds ~10 rad/s; clamping keeps a
  // pathological contact impulse from destroying the quaternion.
  st.omega.x = clamp(st.omega.x, -14, 14);
  st.omega.y = clamp(st.omega.y, -14, 14);
  st.omega.z = clamp(st.omega.z, -14, 14);

  st.pos.x += st.vel.x * h;
  st.pos.y += st.vel.y * h;
  st.pos.z += st.vel.z * h;
  qIntegrate(st.rot, st.omega, h);

  // ---- telemetry from this substep --------------------------------------
  st.liftL = c.liftL; st.liftR = c.liftR;
  st.stallL = c.sepLW > 0 ? c.sepL / c.sepLW : 0;
  st.stallR = c.sepRW > 0 ? c.sepR / c.sepRW : 0;
  st.buffet = c.buffet;
}

function finishDownwash(c: AeroContext, d: DerivedSpec, st: FlightState, h: number): void {
  if (c.wingArea <= 0) { c.downwashV = 0; return; }
  const cl = c.wingClArea / c.wingArea;
  const v = c.wingVWeight > 0 ? c.wingV / c.wingVWeight : st.tas;
  const arWing = (d.span * d.span) / d.wingArea;
  // ε = 2·CL / (π·AR·e). Driving it off the wing's *actual* CL rather than its
  // geometric alpha is what makes the nose drop at the stall: the moment the
  // wing lets go the downwash collapses and the tailplane's alpha jumps.
  const target = clamp((2 * cl) / (Math.PI * arWing * d.spec.aero.oswald), -0.45, 0.45) * v;
  // The wake has to physically travel from the wing to the tail, so the
  // tailplane sees the wing's state one transport time ago. Without that lag
  // the stall break and the tail's reaction to it form a tight loop and the
  // aircraft porpoises instead of simply dropping its nose.
  const tau = Math.max(Math.abs(d.surfaces[4].pos.z) / Math.max(v, 15), 0.02);
  st.downwashLag += (target - st.downwashLag) * (1 - Math.exp(-h / tau));
  c.downwashV = st.downwashLag;
}

// ---------------------------------------------------------------------------

const _zeroInput: InputFrame = {
  seq: 0, dt: 0, pitch: 0, roll: 0, yaw: 0, throttle: 0, bits: 0, aimX: 0, aimY: 0,
};

/**
 * Advance one aircraft by 'dt' seconds.
 *
 * 'input.dt' is ignored — the caller owns the timestep so that prediction,
 * server ticks and replay all use exactly the same value.
 */
export function stepFlight(
  st: FlightState, spec: AircraftSpec, input: InputFrame, env: Environment, dt: number,
): void {
  if (!(dt > 0) || !isFinite(dt)) return;
  if (dt > 0.1) dt = 0.1;
  const d = getDerived(spec);

  st.age += dt;
  updateDamageFactors(st);
  updateMass(st, d);

  const atmo = atmosphereAt(st.pos.y);
  updateKinematics(st, env, atmo);

  const inp = st.pilotConscious || (st.damage & DamageBits.PilotDead) ? input : _zeroInput;
  updateControls(st, d, inp, dt);
  updateEngine(st, d, atmo, Math.max(st.velBody.z, 0), dt);

  const n = Math.max(1, Math.min(8, Math.ceil(dt / MAX_SUBSTEP - 1e-6)));
  const h = dt / n;
  for (let i = 0; i < n; i++) integrate(st, d, env, atmo, h);

  // ---- load factor at the pilot's station -------------------------------
  {
    const px = -st.cgOffset.x, py = d.pilotY - st.cgOffset.y, pz = d.pilotZ - st.cgOffset.z;
    const w = st.omega, a = st.alphaDotBody;
    // (ω̇ × r).y + (ω × (ω × r)).y
    const tangY = a.z * px - a.x * pz;
    const cx = w.y * pz - w.z * py, cy = w.z * px - w.x * pz, cz = w.x * py - w.y * px;
    const centY = w.z * cx - w.x * cz;
    st.gLoad = (st.accBody.y + tangY + centY) / G0;
    if (!isFinite(st.gLoad)) st.gLoad = 1;
  }

  updateStructure(st, d, dt);
  updatePilot(st, dt);
  updateReadouts(st, env);
}

/** Everything the HUD, camera, audio and AI read but the physics does not. */
function updateReadouts(st: FlightState, env: Environment): void {
  st.altitude = st.pos.y;
  st.agl = st.pos.y - env.terrainHeight(st.pos.x, st.pos.z);
  st.vertSpeed = st.vel.y;
  st.groundSpeed = Math.hypot(st.vel.x, st.vel.z);

  vset(_tmp, 0, 0, 1); qrot(st.rot, _tmp, _fwd);
  vset(_tmp, 1, 0, 0); qrot(st.rot, _tmp, _right);
  vset(_tmp, 0, 1, 0); qrot(st.rot, _tmp, _up);
  st.pitchAngle = Math.asin(clamp(_fwd.y, -1, 1));
  st.rollAngle = Math.atan2(-_right.y, _up.y);
  st.heading = Math.atan2(_fwd.x, _fwd.z);
  const sp = vlen(st.vel);
  st.gamma = sp > 0.5 ? Math.asin(clamp(st.vel.y / sp, -1, 1)) : 0;

  // Body-rate readouts in pilot terms (see the sign notes in types.ts).
  st.pitchRate = -st.omega.x;
  st.rollRate = -st.omega.z;
  st.yawRate = st.omega.y;

  st.stalled = st.stallL > 0.35 || st.stallR > 0.35;
  // A spin is autorotation: stalled *and* yawing. Both are needed, which is why
  // recovery is "stop the yaw, then unstall".
  const sepMax = Math.max(st.stallL, st.stallR);
  st.spinning = clamp(Math.abs(st.yawRate) / 1.4, 0, 1) * sepMax;

  if (st.health <= 0) st.damage |= DamageBits.Destroyed;
}

// ---------------------------------------------------------------------------
// Interop helpers
// ---------------------------------------------------------------------------

/** Fill a replicated 'EntityState' from a flight state. */
export function writeEntityState(st: FlightState, spec: AircraftSpec, e: EntityState): void {
  e.px = st.pos.x; e.py = st.pos.y; e.pz = st.pos.z;
  e.qx = st.rot.x; e.qy = st.rot.y; e.qz = st.rot.z; e.qw = st.rot.w;
  e.vx = st.vel.x; e.vy = st.vel.y; e.vz = st.vel.z;
  e.throttle = clamp(st.throttle, 0, 1);
  e.rpm = clamp(st.rpm / Math.max(spec.engine.maxRpm, 1), 0, 1);
  e.health = clamp(st.health, 0, 1);
  e.damage = st.damage & 0xffff;
  e.flaps = st.flaps;
  e.gear = st.gear;
  e.ctlPitch = clamp(st.ctlPitch, -1, 1);
  e.ctlRoll = clamp(st.ctlRoll, -1, 1);
  e.ctlYaw = clamp(st.ctlYaw, -1, 1);
}

/** Hard-set a flight state from an authoritative snapshot (reconciliation). */
export function readEntityState(st: FlightState, e: EntityState): void {
  vset(st.pos, e.px, e.py, e.pz);
  vset(st.vel, e.vx, e.vy, e.vz);
  st.rot.x = e.qx; st.rot.y = e.qy; st.rot.z = e.qz; st.rot.w = e.qw;
  st.damage = e.damage;
  st.health = e.health;
  st.flaps = e.flaps;
  st.gear = e.gear;
}

/**
 * Park an aircraft on the ground at its static attitude, wheels just touching.
 * Used for runway spawns and by the self-test.
 */
export function placeOnGround(
  st: FlightState, spec: AircraftSpec, env: Environment,
  x: number, z: number, heading: number,
): void {
  const d = getDerived(spec);
  // Nose-up is a NEGATIVE rotation about body +X (see types.ts), so compose
  // yaw(+Y) · pitch(−X) and let the quaternion helpers do the rest.
  const hy = heading * 0.5, hp = -d.groundPitch * 0.5;
  const qy = q(0, Math.sin(hy), 0, Math.cos(hy));
  const qp = q(Math.sin(hp), 0, 0, Math.cos(hp));
  qmul(qy, qp, st.rot);
  qnorm(st.rot);

  vset(st.vel, 0, 0, 0);
  vset(st.omega, 0, 0, 0);
  st.gear = 1; st.gearTarget = 1;
  st.cgOffset.x = 0; st.cgOffset.y = 0; st.cgOffset.z = 0;

  // Lowest wheel contact in world coordinates for this attitude.
  let lowest = Infinity;
  for (const leg of d.gearLegs) {
    vset(_tmp, leg.mount.x, leg.mount.y - leg.restLength - leg.radius, leg.mount.z);
    qrot(st.rot, _tmp, _fwd);
    lowest = Math.min(lowest, _fwd.y);
  }
  st.pos.x = x; st.pos.z = z;
  st.pos.y = env.terrainHeight(x, z) - lowest + 0.01;

  st.engineRunning = true;
  st.engOmega = (spec.engine.maxRpm * 2 * Math.PI / 60) * 0.2;
  st.bladePitch = 0.2;
  st.propWash = 0;
  st.throttle = 0; st.throttleCmd = 0;
  st.fuel = spec.damage.fuel;
}

/** Put an aircraft in the air, trimmed-ish, at a given speed and heading. */
export function spawnInFlight(
  st: FlightState, spec: AircraftSpec, env: Environment,
  altitude: number, speed: number, heading: number, throttle = 0.85,
): void {
  const d = getDerived(spec);
  st.pos.y = altitude;
  const rot = q();
  // Yaw about +Y turns the nose to the right — see types.ts.
  rot.x = 0; rot.y = Math.sin(heading * 0.5); rot.z = 0; rot.w = Math.cos(heading * 0.5);
  st.rot.x = rot.x; st.rot.y = rot.y; st.rot.z = rot.z; st.rot.w = rot.w;
  vset(_tmp, 0, 0, speed);
  qrot(st.rot, _tmp, st.vel);
  vset(st.omega, 0, 0, 0);
  st.gearTarget = 0; st.gear = 0;
  st.flaps = 0; st.flapsTarget = 0;
  st.fuel = spec.damage.fuel;
  st.health = 1; st.damage = 0;
  st.throttleCmd = throttle; st.throttle = throttle;
  st.engineRunning = true;
  st.engOmega = (spec.engine.maxRpm * 2 * Math.PI / 60) * (0.62 + 0.38 * throttle);
  st.bladePitch = governorGuess(d, speed, throttle);
  st.coolantTemp = 88; st.oilTemp = 72;
  st.propWash = 0;
  st.engineHealth = 1; st.overheat = 0;
}
