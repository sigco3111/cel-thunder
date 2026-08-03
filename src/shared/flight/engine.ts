/**
 * Piston engine, supercharger, constant-speed propeller and cooling system.
 *
 * The chain is modelled end to end rather than as a thrust curve:
 *
 *   throttle → manifold pressure (supercharger + ram, capped by the automatic
 *   boost control) → shaft power → crankshaft dynamics against the propeller's
 *   blade-element torque → governor blade pitch → slipstream by momentum
 *   theory → thrust, swirl, torque reaction and gyroscopic precession.
 *
 * That is what makes the secondary effects real instead of scripted: torque
 * roll and the left swing on take-off, P-factor at high alpha, the tail
 * becoming effective the instant the throttle opens, RPM sagging when the
 * governor runs out of coarse pitch, and a dead engine windmilling into a
 * substantial drag penalty.
 */

import { clamp, damp, type V3 } from '../math';
import { DamageBits } from '../protocol';
import { atmosphereAt } from './atmosphere';
import { T0, type AtmoSample, type DerivedSpec, type FlightState } from './types';

/** Manifold pressure at which the engine makes exactly zero net power, Pa. */
const MAP_ZERO = 22000;
/** Fraction of dynamic pressure recovered at the carburettor intake. */
const RAM_RECOVERY = 0.85;
/** Seconds of continuous WEP before the emergency rating is cut. */
const WEP_LIMIT = 180;
/** Seconds to cool back down from a full WEP heat load. */
const WEP_COOLDOWN = 260;

/** Coolant / oil thermal masses, J/K. Sized for realistic minute-scale drift. */
const C_COOLANT = 450000;
const C_OIL = 110000;
/** Radiator conductance at unity flow, W/K. */
const K_COOLANT = 9963;
const K_OIL = 2600;

/** Prandtl tip loss: the outer few per cent of the disc does no useful work. */
const TIP_LOSS = 0.94;

/** Brake specific fuel consumption, kg per kW·h — richer at high boost. */
const BSFC_LEAN = 0.30;
const BSFC_RICH = 0.42;

/**
 * Solve momentum theory for the induced velocity at the disc:
 *   P = 2·ρ·A·(V + w)²·w
 * Newton from a bracketing initial guess; six iterations is well past
 * convergence for every case the model produces, and it is branch-free enough
 * to stay deterministic.
 */
export function inducedVelocity(power: number, rho: number, area: number, V: number): number {
  const k = 2 * rho * area;
  if (power <= 1 || k <= 1e-6) return 0;
  const wStatic = Math.cbrt(power / k);
  const wFast = power / (k * Math.max(V * V, 1e-3));
  let w = Math.min(wStatic, wFast);
  if (!isFinite(w) || w <= 0) w = wStatic;
  for (let i = 0; i < 6; i++) {
    const s = V + w;
    const f = k * s * s * w - power;
    const df = k * (s * s + 2 * s * w);
    if (df < 1e-9) break;
    const step = f / df;
    w -= step;
    if (w < 1e-6) { w = 1e-6; break; }
  }
  return w;
}

/** Propeller torque and profile power for a given blade angle and shaft speed. */
function propLoads(
  d: DerivedSpec, rho: number, omegaProp: number, axial: number, bladePitch: number,
  out: { torque: number; profile: number; alphaBlade: number; tipMach: number },
  soundSpeed: number,
): void {
  const vt = 0.75 * d.propRadius * Math.abs(omegaProp);
  const W2 = vt * vt + axial * axial;
  const W = Math.sqrt(W2);
  const phi = Math.atan2(axial, Math.max(vt, 1e-3));
  let ab = bladePitch - phi;
  // Blade sections stall like any other aerofoil; past ~13° the lift (and so
  // the torque) stops rising. This is what limits static thrust and produces
  // the characteristic RPM behaviour of a badly coarse prop at low speed.
  const abStalled = clamp(ab, -0.34, 0.34);
  const softened = abStalled - 0.55 * Math.max(0, Math.abs(abStalled) - 0.19) * Math.sign(abStalled);
  ab = softened;

  // Compressibility: once the tips go transonic the blades lose lift and gain
  // a lot of drag, which is exactly why big props are geared down.
  const tipSpeed = Math.hypot(Math.abs(omegaProp) * d.propRadius, axial);
  const tipMach = tipSpeed / Math.max(soundSpeed, 1);
  const tipLoss = tipMach > 0.86 ? clamp(1 - 2.2 * (tipMach - 0.86), 0.35, 1) : 1;

  out.torque = d.qTorque * rho * W2 * ab * tipLoss;
  const cdBlade = 0.011 + 0.65 * ab * ab + (tipMach > 0.86 ? 0.28 * (tipMach - 0.86) ** 2 : 0);
  out.profile = d.qProfile * rho * W2 * W * cdBlade;
  out.alphaBlade = ab;
  out.tipMach = tipMach;
}

const _loads = { torque: 0, profile: 0, alphaBlade: 0, tipMach: 0 };
const _loads2 = { torque: 0, profile: 0, alphaBlade: 0, tipMach: 0 };
const _loadsW = { torque: 0, profile: 0, alphaBlade: 0, tipMach: 0 };

/**
 * Consistent disc operating point.
 *
 * 'w' (the induced velocity) and the blade angle of attack are mutually
 * dependent: more induced flow means a smaller blade alpha, which means less
 * torque, which means less induced flow. Substituting one into the other
 * oscillates violently at low airspeed, so this bisects the residual
 *
 *     f(w) = w_momentum(P_induced(w)) − w
 *
 * which is monotonically decreasing in 'w' — f(0) ≥ 0 means the prop is
 * pulling, f(0) < 0 means it is windmilling and 'w' is zero.
 */
function solveInducedVelocity(
  d: DerivedSpec, rho: number, omegaProp: number, V: number,
  bladePitch: number, soundSpeed: number,
): number {
  const A = d.propDiscArea;
  const residual = (w: number): number => {
    propLoads(d, rho, omegaProp, V + w, bladePitch, _loadsW, soundSpeed);
    const p = (_loadsW.torque * omegaProp - _loadsW.profile) * TIP_LOSS;
    return (p > 1 ? inducedVelocity(p, rho, A, V) : 0) - w;
  };
  if (residual(0) <= 0) return 0;
  let lo = 0, hi = 160;
  if (residual(hi) > 0) return hi;
  for (let i = 0; i < 22; i++) {
    const mid = 0.5 * (lo + hi);
    if (residual(mid) > 0) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Advance the whole powerplant one full frame. Runs at the outer 'dt' (the
 * crankshaft equation is integrated with a linearised backward-Euler step so
 * it stays stable at 60 Hz despite being an order of magnitude stiffer than
 * the airframe).
 *
 * @param axialInflow  air speed through the disc along the thrust axis, m/s
 */
export function updateEngine(
  st: FlightState, d: DerivedSpec, atmo: AtmoSample, axialInflow: number, dt: number,
): void {
  const eng = d.spec.engine;
  const dmg = st.dmg;
  const omegaRated = (eng.maxRpm * 2 * Math.PI) / 60;

  // ---- fuel --------------------------------------------------------------
  if (st.fuel <= 0) { st.fuel = 0; st.engineRunning = false; }
  if (dmg.engineDead) st.engineRunning = false;

  // ---- war emergency power ----------------------------------------------
  const wepWanted = st.wep && st.engineRunning && !st.wepLockout;
  if (wepWanted && st.throttle > 0.92) {
    st.wepHeat = Math.min(1, st.wepHeat + dt / WEP_LIMIT);
    if (st.wepHeat >= 1) { st.wepLockout = true; st.wep = false; }
  } else {
    st.wepHeat = Math.max(0, st.wepHeat - dt / WEP_COOLDOWN);
    if (st.wepLockout && st.wepHeat < 0.2) st.wepLockout = false;
  }
  const wepActive = wepWanted && st.throttle > 0.92 && st.wepHeat < 1;
  const wepMul = wepActive ? eng.wepMul : 1;

  // ---- manifold pressure -------------------------------------------------
  // Boost lag: opening the throttle does not fill the induction system
  // instantly, which is what the archetype's 'spool' figure describes.
  st.throttle = damp(st.throttle, st.throttleCmd, 1 / Math.max(eng.spool * 0.45, 0.15), dt);

  const pCrit = d.mapRated / d.superPR;
  const pTotal = atmo.pressure + 0.5 * atmo.density * axialInflow * axialInflow * RAM_RECOVERY;
  const ratio = pTotal / Math.max(pCrit, 1000);
  // Below the critical altitude the automatic boost control caps the blower;
  // above it, delivery falls with intake pressure at the archetype's rate.
  const mapCeiling = d.mapRated * wepMul * Math.min(1, Math.pow(Math.max(ratio, 1e-3), eng.altFalloff));
  const mapCmd = st.engineRunning
    ? d.mapIdle + clamp(st.throttle, 0, 1) * Math.max(0, mapCeiling - d.mapIdle)
    : 0;
  st.manifold = mapCmd;

  // ---- shaft power -------------------------------------------------------
  const rpmFrac = clamp(st.engOmega / omegaRated, 0, 1.2);
  const boostFrac = Math.max(0, (mapCmd - MAP_ZERO) / (d.mapRated - MAP_ZERO));
  // A colder, denser charge burns better — this is the small hump that makes
  // an engine peak *at* its critical altitude rather than at sea level.
  const charge = Math.sqrt(T0 / Math.max(atmo.temperature, 150));
  const derate = st.engineHealth * dmg.engine * (1 - 0.55 * clamp(st.overheat, 0, 1));
  let power = st.engineRunning
    ? eng.powerKw * 1000 * boostFrac * (0.22 + 0.78 * rpmFrac) * charge * derate
    : 0;
  if (!isFinite(power) || power < 0) power = 0;
  st.power = power;

  // ---- governor ----------------------------------------------------------
  const propOmega = st.engOmega * d.gearRatio;
  const propOmegaMax = omegaRated * d.gearRatio;
  if (st.engineRunning) {
    // Single-lever automatic prop control: RPM is scheduled with the throttle,
    // which is how these aircraft were flown in practice by 1943.
    const target = propOmegaMax * (0.62 + 0.38 * clamp(st.throttle, 0, 1));
    const err = propOmega - target;
    // Over-speed → coarsen the blade to load the engine down. Rate-limited,
    // like a real oil-pressure governor, so it overshoots on snap throttle.
    const rate = clamp(err * 0.08, -0.9, 0.9);
    st.bladePitch = clamp(st.bladePitch + rate * dt, 0.12, 1.0);
  } else {
    // Loss of oil pressure drives the blades to coarse, which limits the
    // windmilling RPM and costs a great deal of drag.
    st.bladePitch = clamp(st.bladePitch + 0.35 * dt, 0.12, 1.0);
  }

  // ---- disc operating point ---------------------------------------------
  // The blade angle of attack depends on the induced velocity, and the induced
  // velocity depends on the power the blades absorb — a genuinely implicit
  // pair. Solving it by simple substitution produces a two-frame limit cycle
  // (huge alternating thrust), so it is bisected instead: the residual is
  // monotonically decreasing in w, which makes bisection unconditionally safe.
  const V = Math.max(axialInflow, 0);
  const w = solveInducedVelocity(d, atmo.density, propOmega, V, st.bladePitch, atmo.soundSpeed);
  st.propWash = w;

  // ---- crankshaft --------------------------------------------------------
  const axial = V + w;
  propLoads(d, atmo.density, propOmega, axial, st.bladePitch, _loads, atmo.soundSpeed);
  // Numerical derivative of the prop load w.r.t. shaft speed — the stiff term.
  const bump = Math.max(propOmega * 0.03, 1);
  propLoads(d, atmo.density, propOmega + bump, axial, st.bladePitch, _loads2, atmo.soundSpeed);
  const dQdOmegaProp = (_loads2.torque - _loads.torque) / bump;

  const kFric = 0.08 * (eng.powerKw * 1000 / Math.max(omegaRated, 1)) / (omegaRated * omegaRated);
  const qFric = kFric * st.engOmega * st.engOmega + 12;
  const dFricDOmega = 2 * kFric * st.engOmega;

  const qEngine = st.engOmega > 5 ? power / st.engOmega : power / 5;
  const qLoad = _loads.torque * d.gearRatio + qFric;
  const rhs = qEngine - qLoad;
  // Backward-Euler linearisation: ω⁺ = ω + h·f(ω) / (1 + h·∂load/∂ω / I).
  const stiff = dQdOmegaProp * d.gearRatio * d.gearRatio + dFricDOmega;
  st.engOmega += (dt * rhs) / (d.rotInertia + dt * Math.max(stiff, 0));
  // Idle stop and mechanical over-speed limit.
  const idleOmega = st.engineRunning ? omegaRated * 0.18 : 0;
  st.engOmega = clamp(st.engOmega, idleOmega, omegaRated * 1.45);
  if (!isFinite(st.engOmega)) st.engOmega = idleOmega;

  const propOmega2 = st.engOmega * d.gearRatio;
  st.rpm = (st.engOmega * 60) / (2 * Math.PI);
  st.propRpm = (propOmega2 * 60) / (2 * Math.PI);
  st.propTorque = _loads.torque;

  // Over-speeding a piston engine wrecks it.
  if (st.engOmega > omegaRated * 1.15 && st.engineRunning) {
    st.engineHealth = Math.max(0, st.engineHealth - (st.engOmega / omegaRated - 1.15) * 0.9 * dt);
  }

  // ---- slipstream & thrust ----------------------------------------------
  const A = d.propDiscArea;
  const pShaft = _loads.torque * propOmega2;
  // Prandtl tip loss: the outboard few percent of the disc does no useful work.
  const pInduced = (pShaft - _loads.profile) * TIP_LOSS;
  if (w > 1e-4) {
    st.thrust = 2 * atmo.density * A * (V + w) * w;
  } else {
    // Windmilling: the disc extracts energy from the airstream. The energy
    // balance gives the drag, bounded by what a bluff disc of the same area
    // could possibly produce — without that bound the low-speed case diverges.
    const bound = 0.5 * atmo.density * Math.max(V, 3) ** 2 * A * 1.3;
    st.thrust = clamp(pInduced / Math.max(V, 6), -bound, 0)
      - 0.5 * atmo.density * V * V * A * 0.012;
  }
  if (!isFinite(st.thrust)) st.thrust = 0;

  // Slipstream rotation from the torque reacted into the air.
  const mdot = Math.max(atmo.density * A * (V + st.propWash), 1);
  const rEff = 0.7 * d.propRadius;
  st.propSwirl = clamp(
    -eng.propDir * _loads.torque / (mdot * rEff * rEff),
    -30, 30,
  );

  // ---- cooling -----------------------------------------------------------
  updateThermal(st, d, atmo, axialInflow, dt);

  // ---- fuel burn ---------------------------------------------------------
  if (st.engineRunning && power > 0) {
    const bsfc = BSFC_LEAN + (BSFC_RICH - BSFC_LEAN) * clamp(boostFrac, 0, 1);
    st.fuel -= (power / 1000) * (bsfc / 3600) * dt;
  }
  if (st.damage & DamageBits.FuelLeak) {
    st.fuel -= 0.55 * dt * (d.spec.damage.fuel / 300);
  }
  if (st.fuel <= 0) { st.fuel = 0; st.engineRunning = false; }
}

/** Oil and coolant temperatures, radiator scheduling and overheat damage. */
function updateThermal(
  st: FlightState, d: DerivedSpec, atmo: AtmoSample, tas: number, dt: number,
): void {
  const ambient = atmo.temperature - 273.15;

  if (st.radiatorAuto) {
    // Thermostatic: hold the coolant just under its limit with the least drag.
    const want = clamp((st.coolantTemp - 82) / 26, 0.08, 1);
    st.radiator = damp(st.radiator, want, 0.7, dt);
  } else {
    st.radiator = damp(st.radiator, 1, 1.4, dt);
  }

  // Mass flow through the matrix: ram air plus what the propeller pushes when
  // stationary, so a fighter cooks on the ground and cools in a dive.
  const ramFlow = 0.3 + (atmo.density * (tas + st.propWash * 0.45)) / 120;
  const flow = (0.15 + 0.85 * st.radiator) * ramFlow;

  const qIn = st.power * 0.85;
  let kCool = K_COOLANT * flow;
  let kOil = K_OIL * flow;
  if (st.damage & DamageBits.OilLeak) kOil *= 0.35;
  if (st.damage & DamageBits.EngineFire) kCool *= 0.4;

  const dCool = (qIn - kCool * (st.coolantTemp - ambient)) / C_COOLANT;
  st.coolantTemp = clamp(st.coolantTemp + dCool * dt, ambient - 5, 400);

  const qOil = st.power * 0.16 + 4000;
  const dOil = (qOil - kOil * (st.oilTemp - ambient)) / C_OIL;
  st.oilTemp = clamp(st.oilTemp + dOil * dt, ambient - 5, 400);

  // Overheat: a slow accumulator so brief excursions are survivable and a
  // sustained one is not.
  const over = Math.max(
    (st.coolantTemp - 118) / 40,
    (st.oilTemp - 104) / 40,
  );
  if (over > 0) {
    st.overheat = Math.min(1.6, st.overheat + over * 0.16 * dt);
    st.engineHealth = Math.max(0, st.engineHealth - Math.max(0, st.overheat - 0.7) * 0.05 * dt);
  } else {
    st.overheat = Math.max(0, st.overheat - 0.05 * dt);
  }

  if (st.damage & DamageBits.EngineFire) {
    st.engineHealth = Math.max(0, st.engineHealth - 0.05 * dt);
    st.coolantTemp = Math.min(400, st.coolantTemp + 22 * dt);
  }
  if (st.damage & DamageBits.OilLeak) {
    st.engineHealth = Math.max(0, st.engineHealth - 0.012 * dt);
  }
  if (st.engineHealth <= 0.02) st.engineRunning = false;
}

/**
 * Thrust line, torque reaction, P-factor and gyroscopic precession, applied at
 * the propeller hub.
 *
 * Signs follow the body frame described in 'types.ts': with the standard
 * X-right / Y-up / Z-forward triad a clockwise-from-the-cockpit propeller
 * ('propDir = +1') has its angular momentum along −Z, which makes the torque
 * reaction roll the aircraft *left*, puts the descending blade on the right so
 * P-factor yaws *left*, and makes raising the tail yaw *left* as well. All
 * three are the classic warbird handful, and all three fall out of the same
 * two cross products.
 */
export function applyPropForces(
  st: FlightState, d: DerivedSpec, velBody: V3, omega: V3, cgOff: V3,
  fOut: V3, mOut: V3,
): void {
  const eng = d.spec.engine;
  const px = d.propPos.x - cgOff.x;
  const py = d.propPos.y - cgOff.y;
  const pz = d.propPos.z - cgOff.z;

  // --- P-factor -----------------------------------------------------------
  // At an angle to the disc, the down-going blade meets the air at a higher
  // incidence than the up-going one, so the thrust centroid shifts towards it.
  const vz = Math.max(velBody.z, 1);
  const inflowV = Math.atan2(-velBody.y, vz);   // + = disc tilted nose-up
  const inflowH = Math.atan2(velBody.x, vz);    // + = slipping right
  const loading = clamp(st.propWash / (Math.abs(velBody.z) + st.propWash + 1), 0, 1);
  const kP = 0.55 * d.propRadius * loading;
  // Clockwise prop: descending blade to the right, so the offset is +X and the
  // yaw is to the left.
  const offX = eng.propDir * kP * Math.sin(inflowV);
  const offY = -eng.propDir * kP * Math.sin(inflowH);

  const T = st.thrust;
  fOut.z += T;
  // r × F with F = (0,0,T)
  const ax = px + offX, ay = py + offY;
  mOut.x += ay * T;
  mOut.y += -ax * T;

  // --- torque reaction ----------------------------------------------------
  // Whatever the engine puts into the propeller comes back into the airframe.
  mOut.z += eng.propDir * st.propTorque;

  // --- gyroscopic precession ---------------------------------------------
  // H = −propDir·I·ω along +Z; the airframe feels −(ω_body × H).
  const H = -eng.propDir * d.propInertia * (st.engOmega * d.gearRatio);
  // ω × (0,0,H) = (ω.y·H, −ω.x·H, 0)
  mOut.x -= omega.y * H;
  mOut.y -= -omega.x * H;
}

/**
 * Blade angle that puts the propeller near its governed operating point for a
 * given airspeed — used at spawn so the governor does not have to chase a
 * large error (and briefly over-speed the engine) on the first second of life.
 */
export function governorGuess(d: DerivedSpec, tas: number, throttle: number): number {
  const omegaProp = ((d.spec.engine.maxRpm * 2 * Math.PI) / 60) * d.gearRatio
    * (0.62 + 0.38 * clamp(throttle, 0, 1));
  const vt = Math.max(0.75 * d.propRadius * omegaProp, 1);
  return clamp(Math.atan2(Math.max(tas, 0) + 4, vt) + 0.06, 0.12, 1.0);
}

/** Convenience for spawn: a hot, running engine at the given throttle. */
export function primeEngine(st: FlightState, d: DerivedSpec, throttle: number, altitude: number): void {
  const eng = d.spec.engine;
  const atmo = atmosphereAt(altitude);
  st.throttleCmd = throttle;
  st.throttle = throttle;
  st.engineRunning = true;
  st.engOmega = ((eng.maxRpm * 2 * Math.PI) / 60) * (0.62 + 0.38 * throttle);
  st.bladePitch = governorGuess(d, 0, throttle);
  st.coolantTemp = 88;
  st.oilTemp = 72;
  st.radiator = 0.4;
  st.radiatorAuto = true;
  st.manifold = d.mapIdle + throttle * (d.mapRated - d.mapIdle);
  st.power = eng.powerKw * 1000 * throttle;
  st.propWash = inducedVelocity(st.power * 0.85, atmo.density, d.propDiscArea, 0);
}
