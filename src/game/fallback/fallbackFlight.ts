import type { AircraftSpec } from '../../shared/aircraft';
import { DamageBits, InputBits, type InputFrame } from '../../shared/protocol';
import {
  clamp, hash2, qIntegrate, qrot, qrotInv, smoothstep,
  v3, vlen, type Q, type V3,
} from '../../shared/math';
import type { FlightEnv, FlightState } from '../externals';
import { speedOfSound } from '../env';

/**
 * Reduced-order but genuinely aerodynamic flight model.
 *
 * This is the *fallback*: 'src/shared/flight' owns the authoritative model and
 * is used whenever it is present. This one exists so the client still flies,
 * predicts and runs its offline sandbox when that module is missing, and so
 * the offline AI has something honest to fly against.
 *
 * ## Conventions (must match 'src/shared/flight')
 *
 * Body frame is +X right wing, +Y up, +Z forward. Angular velocity is body
 * frame and right-handed, so **positive ω.x is nose DOWN** (R_x takes +Z to −Y),
 * positive ω.y yaws right and positive ω.z rolls **left**.
 *
 * The pilot-facing input signs are the shared model's, and for pitch and roll
 * they are the opposite of the raw body signs:
 *   - 'input.pitch' > 0 = stick **back**  = nose **up**   ⇒ ω.x = −pitch·rate
 *   - 'input.roll'  > 0 = stick **right** = roll right    ⇒ ω.z = −roll·rate
 *   - 'input.yaw'   > 0 = right rudder    = nose right    ⇒ ω.y = +yaw·rate
 *
 * ## Why a rate command rather than a pure moment balance
 *
 * 'AeroSpec' publishes 'rollRate'/'pitchRate'/'yawRate' as *achievable rates*,
 * not as control-surface effectiveness coefficients. Driving a rate loop from
 * them reproduces the published handling exactly, and the stability and damping
 * derivatives are then layered on at reduced gain so the aeroplane still
 * weathercocks, drops a wing at the stall and tucks past its critical Mach —
 * the things a pilot actually feels — without fighting the published numbers.
 * The physically important limiter is not the moment balance but *available
 * lift*: the commanded pitch rate is capped by what the wing can generate at
 * the current dynamic pressure, which is what produces corner-speed behaviour.
 */

export interface FbFlightState extends FlightState {
  pos: V3;
  vel: V3;
  rot: Q;
  omega: V3;

  /** Actuator states, 0..1. */
  throttle: number;
  wep: number;
  gear: number;
  gearTarget: number;
  flaps: number;
  flapsTarget: number;
  airbrake: number;
  wheelBrake: number;

  /** Normalised propeller speed 0..1 (× engine.maxRpm for real rpm). */
  rpm: number;

  /** Lagged surface commands mirrored into EntityState for the visuals. */
  ctlPitch: number;
  ctlRoll: number;
  ctlYaw: number;

  /** Air data, exposed for the HUD and the AI. */
  alpha: number;
  beta: number;
  ias: number;
  tas: number;
  mach: number;
  gLoad: number;
  stall: number;      // 0 = attached, 1 = fully separated
  onGround: boolean;
  wheelSpin: number;  // rad/s, for wheel animation

  /** DamageBits mirror — degrades the model when the sandbox sets it. */
  damage: number;
  /** Remaining fuel, kg. Burns off and lightens the aircraft. */
  fuel: number;
  /** Accumulated sim time, used for deterministic buffet noise. */
  t: number;
  /** Previous input bits, for edge-triggered gear/flap toggles. */
  lastBits: number;
}

// Scratch — never allocate inside the integrator.
const _vb = v3(), _wind = v3(), _rel = v3(), _fb = v3(), _fw = v3();
const _tb = v3(), _n = v3(), _tmp = v3(), _tmp2 = v3();
const FWD: V3 = { x: 0, y: 0, z: 1 };
const RHO_SL = 1.225;

/** Dynamic pressure at ~400 km/h at sea level — where the spec rates are quoted. */
const Q_REF = 0.5 * RHO_SL * 111 * 111;

export function createFlightState(spec: AircraftSpec, pos: V3, rot: Q): FbFlightState {
  return {
    pos: { x: pos.x, y: pos.y, z: pos.z },
    vel: { x: 0, y: 0, z: 0 },
    rot: { x: rot.x, y: rot.y, z: rot.z, w: rot.w },
    omega: { x: 0, y: 0, z: 0 },
    throttle: 0, wep: 0, gear: 1, gearTarget: 1, flaps: 0, flapsTarget: 0,
    airbrake: 0, wheelBrake: 0,
    rpm: 0.18,
    ctlPitch: 0, ctlRoll: 0, ctlYaw: 0,
    alpha: 0, beta: 0, ias: 0, tas: 0, mach: 0, gLoad: 1, stall: 0,
    onGround: true, wheelSpin: 0,
    damage: 0, fuel: spec.damage.fuel, t: 0, lastBits: 0,
  };
}

export function stepFlight(
  state: FlightState, spec: AircraftSpec, input: InputFrame, env: FlightEnv, dt: number,
): void {
  const s = state as FbFlightState;
  if (!(dt > 0)) return;
  dt = Math.min(dt, 0.05);
  s.t += dt;

  const aero = spec.aero;
  const dmg = s.damage;
  const destroyed = (dmg & DamageBits.Destroyed) !== 0;

  // -------------------------------------------------------------------------
  // 1. Actuators
  // -------------------------------------------------------------------------
  const bits = input.bits;
  const rising = bits & ~s.lastBits;
  if (rising & InputBits.GearToggle) s.gearTarget = s.gearTarget > 0.5 ? 0 : 1;
  if (rising & InputBits.FlapsDown) s.flapsTarget = Math.min(1, s.flapsTarget + 0.5);
  if (rising & InputBits.FlapsUp) s.flapsTarget = Math.max(0, s.flapsTarget - 0.5);
  s.lastBits = bits;

  // Real deployment times: gear ~8 s of hydraulic travel, flaps ~3.5 s.
  const gearBroken = (dmg & DamageBits.GearBroken) !== 0;
  const gearRate = gearBroken ? 0.02 : 1 / 8;
  s.gear += clamp(s.gearTarget - s.gear, -gearRate * dt, gearRate * dt);
  s.flaps += clamp(s.flapsTarget - s.flaps, -dt / 3.5, dt / 3.5);
  const wantBrake = (bits & InputBits.BrakeAir) !== 0 && aero.brakeCd > 0;
  s.airbrake += clamp((wantBrake ? 1 : 0) - s.airbrake, -dt * 1.5, dt * 1.5);
  s.wheelBrake = (bits & InputBits.WheelBrake) ? 1 : 0;

  const wantWep = (bits & InputBits.Boost) !== 0;
  s.wep += clamp((wantWep ? 1 : 0) - s.wep, -dt * 0.8, dt * 0.5);

  // Throttle lags through the engine's published spool time.
  const thrCmd = destroyed ? 0 : clamp(input.throttle, 0, 1);
  s.throttle += clamp(thrCmd - s.throttle, -dt / spec.engine.spool, dt / spec.engine.spool);

  // -------------------------------------------------------------------------
  // 2. Air data
  // -------------------------------------------------------------------------
  env.windAt(s.pos, _wind);
  _rel.x = s.vel.x - _wind.x; _rel.y = s.vel.y - _wind.y; _rel.z = s.vel.z - _wind.z;
  qrotInv(s.rot, _rel, _vb);

  const V = vlen(_vb);
  const rho = env.airDensity(s.pos.y);
  const qbar = 0.5 * rho * V * V;
  s.tas = V;
  s.ias = V * Math.sqrt(rho / RHO_SL);
  s.mach = V / speedOfSound(s.pos.y);

  // α = atan2(−w, u) in body axes. Reversed flow yields |α| near π, which the
  // separation blend below routes straight into the flat-plate branch.
  const alpha = V > 3 ? Math.atan2(-_vb.y, _vb.z) : 0;
  const beta = V > 3 ? Math.asin(clamp(_vb.x / V, -1, 1)) : 0;
  s.alpha = alpha; s.beta = beta;

  // -------------------------------------------------------------------------
  // 3. Lift, drag, side force
  // -------------------------------------------------------------------------
  const aStall = aero.stallAlpha;
  const aa = Math.abs(alpha);
  // Separation ramps over ~9° past the published stall angle.
  const sep = smoothstep(aStall, aStall + 0.16, aa);
  s.stall = sep;

  let cl = aero.cl0 + aero.clAlpha * alpha + aero.flapCl * s.flaps;
  // Past the stall the wing behaves like a flat plate: CL ≈ sin(2α).
  const clPlate = Math.sin(2 * alpha) * aero.clMax * 0.85;
  cl = cl * (1 - sep) + clPlate * sep;
  cl = clamp(cl, -aero.clMax * 1.15, aero.clMax * 1.15);

  // Wing loss: a ripped wing halves the area and dumps its share of lift.
  const wingLoss =
    ((dmg & DamageBits.WingRipped) ? 0.45 : 0) +
    ((dmg & DamageBits.LeftWing) ? 0.12 : 0) +
    ((dmg & DamageBits.RightWing) ? 0.12 : 0);
  cl *= (1 - Math.min(0.7, wingLoss));

  const ar = (aero.span * aero.span) / aero.wingArea;
  let cd = aero.cd0
    + (cl * cl) / (Math.PI * aero.oswald * ar)
    + aero.flapCd * s.flaps
    + aero.gearCd * s.gear
    + aero.brakeCd * s.airbrake
    + sep * 0.9 * Math.sin(alpha) * Math.sin(alpha)
    + wingLoss * 0.05;

  // Compressibility: drag rise past the critical Mach, quadratic in the excess.
  if (s.mach > aero.machCrit) {
    const ex = (s.mach - aero.machCrit) / 0.12;
    cd += 0.055 * ex * ex;
  }

  const S = aero.wingArea;
  const lift = qbar * S * cl;
  const drag = qbar * S * cd;
  // Side force from sideslip: mostly the fin and fuselage side area.
  const side = -qbar * S * 0.85 * beta;

  // Lift acts perpendicular to the relative wind in the plane of symmetry.
  // At α = 0 this reduces to body +Y, as it must.
  const ca = Math.cos(alpha), sa = Math.sin(alpha);
  _fb.x = side;
  _fb.y = lift * ca;
  _fb.z = lift * sa;
  if (V > 0.5) {
    const inv = 1 / V;
    _fb.x -= drag * _vb.x * inv;
    _fb.y -= drag * _vb.y * inv;
    _fb.z -= drag * _vb.z * inv;
  }

  // -------------------------------------------------------------------------
  // 4. Thrust
  // -------------------------------------------------------------------------
  const eng = spec.engine;
  let powFrac: number;
  if (s.pos.y <= eng.critAlt) {
    // Below critical altitude the supercharger holds manifold pressure, so
    // power rises only gently with the falling exhaust back-pressure.
    powFrac = 0.86 + 0.14 * (s.pos.y / Math.max(1, eng.critAlt));
  } else {
    powFrac = Math.pow(env.airDensity(s.pos.y) / env.airDensity(eng.critAlt), eng.altFalloff);
  }
  let engineHealth = 1;
  if (dmg & DamageBits.Engine) engineHealth *= 0.35;
  if (dmg & DamageBits.EngineFire) engineHealth *= 0.55;
  if (s.fuel <= 0 || destroyed) engineHealth = 0;

  const wepMul = 1 + (eng.wepMul - 1) * s.wep;
  const powerW = eng.powerKw * 1000 * powFrac * s.throttle * wepMul * engineHealth;

  // Propeller: η ≈ 0.85 in the cruise. Below ~45 m/s the thrust/velocity
  // relation is singular, so clamp the effective velocity — this reproduces a
  // realistic static thrust of roughly 0.55 × weight.
  const thrust = 0.85 * powerW / Math.max(45, V);
  _fb.z += thrust;

  s.fuel = Math.max(0, s.fuel - (powerW / 1e6) * 0.09 * dt * (dmg & DamageBits.FuelLeak ? 4 : 1));

  // Prop rpm tracks throttle plus a windmilling term from airspeed.
  const rpmTarget = engineHealth > 0
    ? 0.18 + 0.82 * s.throttle * (0.85 + 0.15 * wepMul)
    : Math.min(0.35, V / 260);
  s.rpm += (rpmTarget - s.rpm) * Math.min(1, dt * 2.2);

  // -------------------------------------------------------------------------
  // 5. Moments
  // -------------------------------------------------------------------------
  const I = aero.inertia;
  const q01 = clamp(qbar / Q_REF, 0, 1);
  // Stick forces rise with q: past the reference speed a pilot simply cannot
  // hold full deflection, which is why WWII fighters stiffen in a dive.
  const heavy = 1 / (1 + Math.max(0, qbar / Q_REF - 1) * 0.55);
  const machFac = 1 - 0.5 * smoothstep(aero.machCrit * 0.92, aero.machCrit * 1.1, s.mach);
  let ctlEff = q01 * heavy * machFac * (1 - 0.65 * sep);
  if (dmg & DamageBits.ControlsSevered) ctlEff *= 0.05;
  if (destroyed) ctlEff = 0;

  const pitchEff = ctlEff * ((dmg & DamageBits.Elevator) ? 0.25 : 1);
  const rollEff = ctlEff * ((dmg & DamageBits.Aileron) ? 0.3 : 1);
  const yawEff = ctlEff * ((dmg & DamageBits.Rudder) ? 0.2 : 1);

  // Available-lift limit: you cannot pull more g than the wing can make, and
  // never more than the airframe's structural limit. ω ≈ n·g/V in a hard turn.
  const nAero = (qbar * S * aero.clMax * (1 - Math.min(0.7, wingLoss))) / (mass(spec, s) * 9.81);
  const nCap = Math.min(aero.gLimit * 1.05, Math.max(1.05, nAero));
  const wCap = V > 25 ? (nCap * 9.81) / V : 2.2;

  // Stick back (pitch > 0) is nose up, which is a *negative* body-X rate.
  const wxDes = clamp(-input.pitch * aero.pitchRate * pitchEff, -wCap, wCap);
  const wyDes = input.yaw * aero.yawRate * yawEff;
  const wzDes = -input.roll * aero.rollRate * rollEff;

  // Rate loop. K sets how quickly the aeroplane reaches the commanded rate;
  // ~5 s⁻¹ gives the 200 ms control response of a light fighter.
  const K = 5.0;
  let tx = I[0] * (wxDes - s.omega.x) * K;
  let ty = I[1] * (wyDes - s.omega.y) * K;
  let tz = I[2] * (wzDes - s.omega.z) * K;

  // Aerodynamic damping (reduced: the rate loop already supplies most of it).
  const dampScale = 0.35 * q01;
  tx -= I[0] * aero.damp[0] * s.omega.x * dampScale;
  ty -= I[1] * aero.damp[1] * s.omega.y * dampScale;
  tz -= I[2] * aero.damp[2] * s.omega.z * dampScale;

  // Static stability, at reduced authority so it flavours rather than fights.
  const STAB = 0.4;
  const qSc = qbar * S * aero.chord * STAB;
  const qSb = qbar * S * aero.span * STAB;
  // Trim: subtract the α that holds 1 g, so hands-off flight is roughly level.
  const alphaTrim = qbar > 200
    ? clamp((mass(spec, s) * 9.81 / (qbar * S) - aero.cl0) / aero.clAlpha, -0.1, aero.stallAlpha)
    : 0;
  tx += qSc * -aero.cmAlpha * (alpha - alphaTrim);   // cmAlpha<0 ⇒ +α gives nose-down (+ω.x)
  ty += qSb * aero.cnBeta * beta;                    // weathercock into the slip
  tz += qSb * -aero.clBeta * beta;                   // dihedral rolls away from the slip

  // Adverse yaw: the down-going aileron drags, yawing away from the roll.
  ty -= input.roll * qSb * 0.035 * rollEff;

  // Engine torque and slipstream: the airframe rolls against the propeller and
  // the corkscrewing slipstream pushes the fin. Both scale with power/speed.
  const torqueTerm = (powerW / 1e6) * eng.propDir;
  tz += torqueTerm * I[2] * 0.055 / Math.max(1, V / 60);
  ty -= torqueTerm * I[1] * 0.02 / Math.max(1, V / 60);

  // Asymmetric damage: a lost wingtip rolls and yaws hard toward the stump.
  if (wingLoss > 0) {
    const sgn = (dmg & DamageBits.RightWing) ? 1 : (dmg & DamageBits.LeftWing) ? -1 : 0;
    tz += sgn * qbar * S * aero.span * 0.06;
  }

  // Stall buffet — deterministic in sim time so a replayed input reproduces it.
  if (sep > 0.02) {
    const n1 = hash2(Math.floor(s.t * 37), 3, 17) - 0.5;
    const n2 = hash2(Math.floor(s.t * 41), 5, 23) - 0.5;
    tz += n1 * sep * qbar * S * aero.span * 0.05;
    tx += n2 * sep * qbar * S * aero.chord * 0.05;
  }

  // Gyroscopic precession from the propeller: pitching a spinning disc yaws it.
  const propJ = 0.012 * eng.propDia * eng.propDia * eng.blades;
  const propW = s.rpm * eng.maxRpm * (Math.PI / 30) * eng.propDir;
  ty += propJ * propW * s.omega.x;
  tx -= propJ * propW * s.omega.y;

  // Rigid-body coupling ω × (Iω) — free precession, cheap and physically right.
  tx -= s.omega.y * (I[2] * s.omega.z) - s.omega.z * (I[1] * s.omega.y);
  ty -= s.omega.z * (I[0] * s.omega.x) - s.omega.x * (I[2] * s.omega.z);
  tz -= s.omega.x * (I[1] * s.omega.y) - s.omega.y * (I[0] * s.omega.x);

  if (destroyed) {
    // A dead airframe tumbles: no control, weak damping only.
    tx = -s.omega.x * I[0] * 0.4 + qbar * S * 0.9;
    ty = -s.omega.y * I[1] * 0.4;
    tz = -s.omega.z * I[2] * 0.4 + qbar * S * 0.6;
  }

  s.omega.x += (tx / I[0]) * dt;
  s.omega.y += (ty / I[1]) * dt;
  s.omega.z += (tz / I[2]) * dt;
  const wLim = 8;
  s.omega.x = clamp(s.omega.x, -wLim, wLim);
  s.omega.y = clamp(s.omega.y, -wLim, wLim);
  s.omega.z = clamp(s.omega.z, -wLim, wLim);

  // -------------------------------------------------------------------------
  // 6. Integrate
  // -------------------------------------------------------------------------
  const m = mass(spec, s);
  qrot(s.rot, _fb, _fw);
  const ax = _fw.x / m;
  const ay = _fw.y / m - 9.80665;
  const az = _fw.z / m;

  // Load factor along the body normal, what the g-meter and the pilot feel.
  s.gLoad = _fb.y / (m * 9.80665);

  s.vel.x += ax * dt; s.vel.y += ay * dt; s.vel.z += az * dt;
  qIntegrate(s.rot, s.omega, dt);
  s.pos.x += s.vel.x * dt; s.pos.y += s.vel.y * dt; s.pos.z += s.vel.z * dt;

  // -------------------------------------------------------------------------
  // 7. Ground contact
  // -------------------------------------------------------------------------
  groundContact(s, spec, env, dt);

  // -------------------------------------------------------------------------
  // 8. Visual control positions (lagged; the surfaces have mass)
  // -------------------------------------------------------------------------
  const surfLag = Math.min(1, dt * 12);
  s.ctlPitch += (input.pitch * (pitchEff > 0.02 ? 1 : 0) - s.ctlPitch) * surfLag;
  s.ctlRoll += (input.roll * (rollEff > 0.02 ? 1 : 0) - s.ctlRoll) * surfLag;
  s.ctlYaw += (input.yaw * (yawEff > 0.02 ? 1 : 0) - s.ctlYaw) * surfLag;
}

/** Current mass: airframe + remaining fuel. */
function mass(spec: AircraftSpec, s: FbFlightState): number {
  return spec.aero.mass - spec.damage.fuel + s.fuel;
}

/**
 * Wheel/belly contact. A spring-damper along the terrain normal rather than a
 * position clamp, so touchdowns compress and bounce instead of snapping, and
 * so a three-point attitude settles naturally.
 */
function groundContact(s: FbFlightState, spec: AircraftSpec, env: FlightEnv, dt: number): void {
  const gh = env.terrainHeight(s.pos.x, s.pos.z);
  const legs = spec.geom.gear.legLen;
  const standH = (s.gear > 0.05 ? legs * s.gear : 0) + spec.geom.fuseRadius * 0.55;
  const pen = (gh + standH) - s.pos.y;

  if (pen <= 0) {
    s.onGround = false;
    // Wheels spin down in the air.
    s.wheelSpin *= Math.exp(-dt * 0.6);
    return;
  }
  s.onGround = true;
  env.terrainNormal(s.pos.x, s.pos.z, _n);

  const m = mass(spec, s);
  const vDotN = s.vel.x * _n.x + s.vel.y * _n.y + s.vel.z * _n.z;

  // Oleo strut: stiff enough to hold the aircraft, damped near-critically.
  const k = m * 22;
  const c = 2 * Math.sqrt(k * m) * 0.75;
  const fN = Math.max(0, k * pen - c * vDotN);

  // Hard arrivals break the gear or the airframe.
  if (vDotN < -9 && s.gear > 0.5) s.damage |= DamageBits.GearBroken;
  if (vDotN < -16) s.damage |= DamageBits.Destroyed;

  const a = fN / m;
  s.vel.x += _n.x * a * dt;
  s.vel.y += _n.y * a * dt;
  s.vel.z += _n.z * a * dt;

  // Tangential velocity: rolling resistance on wheels, heavy scrape on a belly.
  _tmp.x = s.vel.x - _n.x * vDotN;
  _tmp.y = s.vel.y - _n.y * vDotN;
  _tmp.z = s.vel.z - _n.z * vDotN;
  const tanSpeed = vlen(_tmp);
  const rolling = s.gear > 0.5 && !(s.damage & DamageBits.GearBroken);
  // Rolling resistance for wheels; a belly landing scrapes at µ ≈ 0.55.
  const mu = rolling ? (s.wheelBrake > 0.5 ? 0.42 : 0.035) : 0.55;
  if (tanSpeed > 0.05) {
    const dv = Math.min(tanSpeed, mu * 9.80665 * dt * (1 + fN / (m * 9.80665)));
    const f = dv / tanSpeed;
    s.vel.x -= _tmp.x * f; s.vel.y -= _tmp.y * f; s.vel.z -= _tmp.z * f;
  }

  // Wheel spin from the contact-patch speed (0.32 m wheel radius).
  s.wheelSpin = rolling ? tanSpeed / 0.32 : 0;

  // Levelling torque: the undercarriage geometry pulls the aircraft toward the
  // ground plane rather than letting it sit at whatever attitude it landed in.
  qrot(s.rot, UP_BODY, _tmp2);
  const tilt = _tmp2.x * _n.x + _tmp2.y * _n.y + _tmp2.z * _n.z;
  if (tilt > 0.2) {
    // Rotation that would align body-up with the terrain normal.
    const cx = _tmp2.y * _n.z - _tmp2.z * _n.y;
    const cy = _tmp2.z * _n.x - _tmp2.x * _n.z;
    const cz = _tmp2.x * _n.y - _tmp2.y * _n.x;
    qrotInv(s.rot, { x: cx, y: cy, z: cz }, _tb);
    const g = Math.min(1, dt * 4) * Math.min(1, pen / 0.4);
    s.omega.x += _tb.x * g * 2.5;
    s.omega.y += _tb.y * g * 0.4;
    s.omega.z += _tb.z * g * 2.5;
    s.omega.x *= 1 - g * 0.5;
    s.omega.z *= 1 - g * 0.5;
  }
  s.pos.y += pen * Math.min(1, dt * 10);
}

const UP_BODY: V3 = { x: 0, y: 1, z: 0 };

/** Speed at which the wing stalls in level flight — used by the AI. */
export function stallSpeed(spec: AircraftSpec, rho: number, loadFactor = 1): number {
  const w = spec.aero.mass * 9.80665 * loadFactor;
  return Math.sqrt((2 * w) / (rho * spec.aero.wingArea * spec.aero.clMax));
}

export { FWD as FLIGHT_FORWARD };
