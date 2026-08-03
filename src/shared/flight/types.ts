/**
 * Flight-model data types.
 *
 * Pure data + interfaces. No three.js, no DOM, no Node built-ins — this file
 * (and every other file in 'src/shared/flight/') loads identically in the
 * browser client (for prediction) and in the headless authoritative server.
 *
 * ## Conventions (these matter — read them)
 *
 * World: right-handed, **Y up**, metres / radians / seconds / kilograms.
 * Body:  **+X right wing, +Y up (canopy), +Z forward (nose)** — also right-handed.
 *
 * Because the body frame is X-right / Y-up / Z-forward, the right-hand rule
 * gives these (initially surprising) signs for body-frame angular velocity and
 * moments:
 *
 *   - rotation about **+X** pitches the nose **DOWN**  → nose-up  = −Mx
 *   - rotation about **+Y** yaws the nose **RIGHT**    → yaw-right = +My
 *   - rotation about **+Z** rolls the aircraft **LEFT** → roll-right = −Mz
 *
 * Almost nothing in the model hard-codes those signs: forces are computed at
 * discrete surface positions and the moments fall out of 'r × F'. The few
 * places that do (torque reaction, gyroscopic precession, residual damping)
 * are commented individually.
 *
 * Pilot-facing sign convention for 'InputFrame':
 *   - 'pitch' > 0 = stick **back**  = nose up
 *   - 'roll'  > 0 = stick **right** = roll right (right wing down)
 *   - 'yaw'   > 0 = **right** rudder = nose right
 *   - 'throttle' in [0,1]
 *
 * 'FlightState' mirrors those ('pitchRate' nose-up positive, 'rollRate'
 * right-roll positive, 'yawRate' nose-right positive) so consumers never have
 * to reason about the body-frame signs.
 */

import type { V3, Q } from '../math';
import type { AircraftSpec } from '../aircraft';

/** Standard gravity, m/s². */
export const G0 = 9.80665;
/** ISA sea-level density, kg/m³ — the reference for IAS/EAS. */
export const RHO0 = 1.225;
/** ISA sea-level pressure, Pa. */
export const P0 = 101325;
/** ISA sea-level temperature, K. */
export const T0 = 288.15;
/** Specific gas constant for dry air, J/(kg·K). */
export const R_AIR = 287.05287;
/** Ratio of specific heats. */
export const GAMMA = 1.4;

/**
 * The flight model never steps by more than this in one go. 'stepFlight'
 * subdivides its 'dt' deterministically so that the same 'dt' always produces
 * the same number of substeps on client and server.
 */
export const MAX_SUBSTEP = 1 / 180;

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** A sampled slice of the standard atmosphere. */
export interface AtmoSample {
  /** kg/m³ */
  density: number;
  /** Pa */
  pressure: number;
  /** K */
  temperature: number;
  /** m/s */
  soundSpeed: number;
}

/**
 * Everything the flight model needs to know about the world around it. The
 * world/terrain subsystem supplies the real implementation; 'flatEnvironment()'
 * is a self-contained fallback used by the self-test and by the server before
 * terrain is streamed in.
 *
 * All methods must be *pure* and deterministic — they are called from inside
 * the prediction loop and re-called during reconciliation.
 */
export interface Environment {
  /** Air density at world altitude 'y' (metres ASL), kg/m³. */
  airDensity(y: number): number;
  /** Wind velocity (world frame, m/s) at a world position. */
  windAt(pos: V3, out?: V3): V3;
  /** Ground height (metres ASL) under a world XZ position. */
  terrainHeight(x: number, z: number): number;
  /** Unit ground normal (world frame) under a world XZ position. */
  terrainNormal(x: number, z: number, out?: V3): V3;
  /**
   * Optional surface hint used for wheel friction: 0 = paved runway,
   * 1 = grass/dirt, 2 = water. Defaults to paved if absent.
   */
  surfaceType?(x: number, z: number): number;
}

export const SURFACE_PAVED = 0;
export const SURFACE_SOFT = 1;
export const SURFACE_WATER = 2;

// ---------------------------------------------------------------------------
// Discrete aerodynamic surfaces
// ---------------------------------------------------------------------------

export type SurfaceKind = 'wing' | 'hstab' | 'fin' | 'body';

/** Damage grouping so a hit wing kills exactly the panels it should. */
export const DG_NONE = 0;
export const DG_WING_L = 1;
export const DG_WING_R = 2;
export const DG_TAIL = 3;
export const DG_FIN = 4;
export const DG_BODY = 5;

/**
 * One strip of lifting (or bluff) surface. Forces are evaluated independently
 * per surface using the local flow — which is what buys correct behaviour for
 * roll damping, autorotation, asymmetric damage, propwash and sideslip without
 * a single hand-written coupling term.
 */
export interface Surface {
  id: string;
  kind: SurfaceKind;
  /** −1 left, 0 centreline, +1 right. */
  side: -1 | 0 | 1;
  /** Aerodynamic centre in body frame (relative to the reference origin). */
  pos: V3;
  /** Unit normal — the direction of positive lift at zero local alpha. */
  normal: V3;
  /** Unit chord direction, pointing forward along the chord line. */
  chord: V3;
  /** Unit spanwise direction (= normal × chord). Only used for projection. */
  spanDir: V3;
  /** Reference area, m². */
  area: number;
  /** Mean chord of this strip, m — sets the dynamic-stall time constant. */
  chordLen: number;
  /** Effective aspect ratio of the *parent* surface (whole wing, whole tail). */
  ar: number;
  /** Oswald efficiency of the parent surface. */
  oswald: number;
  /** 3-D lift-curve slope, per radian. */
  liftSlope: number;
  /** Zero-alpha lift coefficient from camber. */
  cl0: number;
  clMax: number;
  clMin: number;
  /** Local stall angle, rad (washout is baked into 'normal', not this). */
  stallAlpha: number;
  /** Profile drag coefficient on this surface's own area. */
  cd0: number;
  /** Δcl per unit elevator command (+1 = full nose-up command). */
  elevator: number;
  /** Δcl per unit roll command (+1 = full right-roll command), signed. */
  aileron: number;
  /** Δcl per unit rudder command (+1 = full right rudder). */
  rudder: number;
  /** Δcl at full flap deployment. */
  flap: number;
  /** Δcd at full flap deployment, on this surface's area. */
  flapCd: number;
  /** Fraction of the strip immersed in the propeller slipstream, 0..1. */
  wash: number;
  /** Fraction of the wing downwash felt here (1 for the tailplane). */
  downwash: number;
  /** DG_* constant. */
  damageGroup: number;
  /** Index into the per-surface state arrays. */
  index: number;
  /**
   * True for surfaces whose lift is meant to be reported as "wing lift" for
   * structural / stall bookkeeping.
   */
  isWing: boolean;
}

// ---------------------------------------------------------------------------
// Undercarriage & airframe contact
// ---------------------------------------------------------------------------

export type GearRole = 'main-left' | 'main-right' | 'tail' | 'nose';

export interface GearLeg {
  role: GearRole;
  /** Attachment point of the leg (top of the strut), body frame. */
  mount: V3;
  /** Suspension travel direction (body frame, unit, points *down* the strut). */
  axis: V3;
  /** Uncompressed strut length from the mount to the wheel centre, m. */
  restLength: number;
  /** Maximum compression, m. */
  travel: number;
  /** Wheel radius, m. */
  radius: number;
  /** Spring rate, N/m. */
  spring: number;
  /** Damper rate, N·s/m. */
  damper: number;
  /** Static rolling-resistance coefficient. */
  rollMu: number;
  /** Peak braking friction coefficient (0 = no brake on this leg). */
  brakeMu: number;
  /** Peak lateral (cornering) friction coefficient. */
  sideMu: number;
  /** Max steering angle from the rudder pedals, rad (tail/nose wheel). */
  steerMax: number;
  /** Vertical impact speed above which the leg collapses, m/s. */
  breakVs: number;
  index: number;
}

/** A non-suspended structural contact point (belly, wingtips, spinner, fin). */
export interface HardPoint {
  id: string;
  pos: V3;
  radius: number;
  /** Scales the damage taken when this point scrapes. */
  fragility: number;
  index: number;
}

// ---------------------------------------------------------------------------
// Derived, per-archetype constants
// ---------------------------------------------------------------------------

/**
 * Everything that can be precomputed once per 'AircraftSpec'. Built lazily by
 * 'getDerived()' and cached — never mutate it.
 */
export interface DerivedSpec {
  spec: AircraftSpec;
  surfaces: Surface[];
  nSurf: number;
  gearLegs: GearLeg[];
  nLegs: number;
  hardPoints: HardPoint[];
  nHard: number;

  /** Residual parasite drag area (Cd·S) not covered by surface profile drag, m². */
  parasiteArea: number;
  /** Δ(Cd·S) for gear down, flaps full, airbrake out, radiator full open. */
  gearArea: number;
  flapArea: number;
  brakeArea: number;
  radiatorArea: number;

  /** Wing reference geometry. */
  wingArea: number;
  span: number;
  chord: number;
  /** Mass with full internal fuel, kg. */
  massFull: number;
  /** Dry mass (fuel burnt off), kg. */
  massDry: number;
  /** Mass of one wing panel outboard of the root join, kg. */
  wingMass: number;
  /** Spanwise centroid of one wing's mass, m. */
  wingMassArm: number;
  /** Body-frame inertia (about X pitch, Y yaw, Z roll) at full mass. */
  inertia: V3;

  /** Propeller hub position, body frame. */
  propPos: V3;
  propRadius: number;
  propDiscArea: number;
  /** Reduction gearing: prop rpm = engine rpm × gearRatio. */
  gearRatio: number;
  /** Combined rotating inertia referred to the *engine* shaft, kg·m². */
  rotInertia: number;
  /** Propeller polar inertia (referred to the prop), kg·m² — gyroscopic term. */
  propInertia: number;
  /** Blade-element torque constant: Q = qTorque · ρ · W² · (β−φ). */
  qTorque: number;
  /** Blade-element profile-power constant: P = qProfile · ρ · W³. */
  qProfile: number;
  /** Slipstream tube radius behind the disc, m. */
  slipRadius: number;

  /** Manifold pressures, Pa. */
  mapRated: number;
  mapIdle: number;
  /** Supercharger pressure ratio needed to hold 'mapRated' at critAlt. */
  superPR: number;

  /** Reference IAS at which each axis' controls become "heavy", m/s. */
  vHeavyRoll: number;
  vHeavyPitch: number;
  vHeavyYaw: number;

  /** Speed limits, IAS m/s. */
  flapLimit: number;
  gearLimit: number;

  /** Residual damping derivatives topping up the natural surface damping. */
  cmqRes: number;
  cnrRes: number;
  clpRes: number;

  /** Wing quarter-chord AC station solved to honour spec.aero.cmAlpha. */
  wingAcZ: number;
  /** Effective-dihedral scale solved to honour spec.aero.clBeta. */
  dihedralScale: number;
  /** Fin lift-slope scale solved to honour spec.aero.cnBeta. */
  finScale: number;

  /** Pilot's head station, body frame — where the felt g-load is evaluated. */
  pilotY: number;
  pilotZ: number;

  /** Static ground attitude (nose-up, rad) with the gear down and unloaded. */
  groundPitch: number;
  /** Body-frame Y of the wheels' contact plane at rest. */
  groundOffsetY: number;

  /** Stall speed clean at sea level, m/s. */
  vStall: number;
  /** Corner speed (max instantaneous turn) at sea level, m/s. */
  vCorner: number;
}

// ---------------------------------------------------------------------------
// Damage-derived multipliers
// ---------------------------------------------------------------------------

/** Scratch struct recomputed from 'state.damage' at the top of every step. */
export interface DamageFactors {
  /** 0 = gone, 1 = intact. Lift/drag scaling per wing. */
  wingL: number;
  wingR: number;
  wingLGone: boolean;
  wingRGone: boolean;
  /** Extra parasite area from holes and torn skin, m². */
  extraDrag: number;
  tail: number;
  elevator: number;
  aileron: number;
  rudder: number;
  /** 0..1 engine output scale. */
  engine: number;
  /** True when the crank is dead and the prop is windmilling. */
  engineDead: boolean;
  /** 0..1 pilot control authority. */
  pilot: number;
  gearOk: boolean;
}

// ---------------------------------------------------------------------------
// Flight state
// ---------------------------------------------------------------------------

/**
 * The complete integrable state of one aircraft plus every readout the HUD,
 * audio, VFX, camera and AI need. Everything here is a plain number, plain
 * object or typed array, so it clones cheaply for client-side reconciliation
 * ('cloneFlightState').
 */
export interface FlightState {
  // --- rigid body -----------------------------------------------------------
  /** Centre-of-gravity position, world frame, m. */
  pos: V3;
  /** CG velocity, world frame, m/s. */
  vel: V3;
  /** Body → world orientation. */
  rot: Q;
  /** Angular velocity in the **body** frame, rad/s (see the sign notes above). */
  omega: V3;

  // --- derived kinematics ---------------------------------------------------
  /** Velocity of the airframe relative to the air mass, body frame, m/s. */
  velBody: V3;
  /** Specific force (what the airframe feels, gravity excluded), body frame. */
  accBody: V3;
  /** Angular acceleration, body frame, rad/s². */
  alphaDotBody: V3;
  tas: number;
  ias: number;
  mach: number;
  /** Angle of attack of the reference body axis, rad. */
  alpha: number;
  /** Sideslip, rad. Positive = slipping to the right. */
  beta: number;
  altitude: number;
  agl: number;
  /** Dynamic pressure, Pa. */
  qbar: number;
  vertSpeed: number;
  /** Ground speed, m/s. */
  groundSpeed: number;
  /** Nose-up positive, rad/s. */
  pitchRate: number;
  /** Right-roll positive, rad/s. */
  rollRate: number;
  /** Nose-right positive, rad/s. */
  yawRate: number;
  /** Euler readouts for the HUD, rad. */
  pitchAngle: number;
  rollAngle: number;
  /** Compass heading, rad, 0 = +Z, increasing clockwise from above. */
  heading: number;
  /** Flight-path angle, rad. */
  gamma: number;

  // --- powerplant -----------------------------------------------------------
  /** Commanded throttle after smoothing, 0..1. */
  throttle: number;
  /** Raw commanded throttle from the stick, 0..1. */
  throttleCmd: number;
  /** Engine crankshaft speed, rpm. */
  rpm: number;
  /** Propeller speed, rpm. */
  propRpm: number;
  /** Engine shaft speed, rad/s. */
  engOmega: number;
  /** Manifold absolute pressure, Pa. */
  manifold: number;
  /** Shaft power actually produced, W. */
  power: number;
  /** Net propeller thrust, N (negative when windmilling). */
  thrust: number;
  /** Torque delivered to the prop, N·m (at prop speed). */
  propTorque: number;
  /** Governor blade angle at 0.75 R, rad. */
  bladePitch: number;
  /** Slipstream induced velocity at the disc, m/s. */
  propWash: number;
  /** Slipstream swirl rate, rad/s (signed by prop direction). */
  propSwirl: number;
  wep: boolean;
  /** 0..1 — WEP is cut off at 1 and must cool back below 0.15 to re-arm. */
  wepHeat: number;
  wepLockout: boolean;
  /** °C */
  oilTemp: number;
  coolantTemp: number;
  /** 0..1 radiator flap opening. */
  radiator: number;
  radiatorAuto: boolean;
  /** Remaining fuel, kg. */
  fuel: number;
  engineRunning: boolean;
  /** 0..1 — falls with overheat, oil starvation and fire. */
  engineHealth: number;
  /** Accumulated overheat damage 0..1. */
  overheat: number;

  // --- controls -------------------------------------------------------------
  /** Actual surface command after damage, stick-force and Mach limiting, −1..1. */
  ctlPitch: number;
  ctlRoll: number;
  ctlYaw: number;
  /** Raw pilot demand after trim, before authority scaling, −1..1. */
  demandPitch: number;
  demandRoll: number;
  demandYaw: number;
  trimPitch: number;
  trimRoll: number;
  trimYaw: number;
  /** Per-axis control authority actually available, 0..1 (HUD/feel). */
  authPitch: number;
  authRoll: number;
  authYaw: number;
  flaps: number;
  flapsTarget: number;
  gear: number;
  gearTarget: number;
  airbrake: number;
  airbrakeTarget: number;
  wheelBrake: number;
  /** Tail/nose-wheel steering angle, rad. */
  steer: number;
  /** Edge-detection latch for the momentary input bits. */
  prevBits: number;

  // --- aerodynamic feedback -------------------------------------------------
  /** 0..1 airframe buffet for HUD shake / audio / camera. */
  buffet: number;
  /** Mean flow-separation fraction per wing, 0..1. */
  stallL: number;
  stallR: number;
  stalled: boolean;
  /** True while the aircraft is autorotating (spinning). */
  spinning: number;
  /** Lift produced by each wing this step, N — drives the structural model. */
  liftL: number;
  liftR: number;

  // --- structure & pilot ----------------------------------------------------
  /** Normal load factor at the pilot's station, g (+ = pushed into the seat). */
  gLoad: number;
  /** Peak |g| seen this life — for the debrief. */
  gPeak: number;
  /** 0..1 accumulated wing-spar fatigue; 1 = failure. */
  gFatigue: number;
  /** 0..1 current control-surface flutter intensity. */
  flutter: number;
  /** 0..1 accumulated flutter damage; 1 = a control surface departs. */
  flutterDamage: number;
  /** 0..1 grey-out → blackout. */
  blackout: number;
  /** 0..1 redout. */
  redout: number;
  /** Raw cerebral-reserve strain accumulators driving the two above. */
  gStrainPos: number;
  gStrainNeg: number;
  /** max(blackout, redout) — hand this straight to post-processing. */
  gEffect: number;
  /** +1 while blacking out, −1 while redding out. */
  gEffectSign: number;
  pilotConscious: boolean;
  /** Seconds of forced unconsciousness remaining. */
  koTimer: number;

  // --- ground ---------------------------------------------------------------
  onGround: boolean;
  /** Per-leg suspension compression, m (visual + audio). */
  gearCompress: Float64Array;
  /** Per-leg normal load, N. */
  gearLoad: Float64Array;
  /** Per-leg wheel spin speed, rad/s (visual). */
  wheelSpin: Float64Array;
  /** Vertical speed of the last touchdown, m/s (positive = descending). */
  touchdownVs: number;
  /** Scrape intensity 0..1 for VFX/audio when the airframe is on the ground. */
  scrape: number;
  /** True on the tick a propeller strike happens. */
  propStrike: boolean;

  // --- damage ---------------------------------------------------------------
  /** DamageBits — the authoritative wire representation. */
  damage: number;
  /** 0..1 airframe integrity. */
  health: number;
  /** Extra carried mass (ordnance, drop tank), kg — the loadout system owns it. */
  extraMass: number;

  // --- integrator internals -------------------------------------------------
  /** Per-surface separated-flow fraction (stall hysteresis state). */
  sep: Float64Array;
  /** Per-surface previous local alpha, rad (dynamic-stall rate term). */
  alphaPrev: Float64Array;
  /** Per-surface low-passed dα/dt, rad/s. */
  alphaRate: Float64Array;
  /** Lagged downwash velocity at the tailplane, m/s (wake transport delay). */
  downwashLag: number;
  /** Live mass, kg. */
  mass: number;
  /** Live body-frame inertia. */
  inertia: V3;
  /** Body-frame offset from the reference origin to the true CG, m. */
  cgOffset: V3;
  /** Seconds since spawn — used only for slow thermal/actuator dynamics. */
  age: number;
  /** Scratch damage factors, refreshed every step. */
  dmg: DamageFactors;
}

export type { AircraftSpec, V3, Q };
