/**
 * Shared types for the combat subsystem — ballistics, penetration, modular
 * damage, ordnance and AA fire.
 *
 * This whole directory is deliberately free of three.js so the authoritative
 * server can run the exact same code as the client's prediction layer. Only
 * '../math' (V3/Q/Rng) is imported.
 *
 * Units are SI throughout: metres, seconds, kilograms, radians, Joules.
 * Armour and calibre are the two exceptions — they are quoted in millimetres
 * because that is how every real-world source quotes them, and mixing the two
 * causes fewer bugs than silently converting.
 *
 * Body frame (matches docs/AGENT_BRIEF.md): +X right wing, +Y up, +Z forward.
 */

import type { V3, Q } from '../math';
import { Rng } from '../math';

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Avalanche a seed before handing it to 'Rng'.
 *
 * 'Rng' is a bare xorshift32: two seeds that differ only in their low bits
 * produce near-identical *first* outputs, which matters here because a lot of
 * combat rolls (does this hit start a fire?) happen on a freshly constructed
 * generator. Running the seed through a finalising mix first, and burning a
 * few outputs after, decorrelates them completely.
 */
export function seedRng(seed: number): Rng {
  let x = seed | 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x = (x ^ (x >>> 16)) >>> 0;
  const rng = new Rng(x || 1);
  for (let i = 0; i < 6; i++) rng.next();
  return rng;
}

// ---------------------------------------------------------------------------
// Ammunition
// ---------------------------------------------------------------------------

/**
 * Projectile filler/construction. This drives penetration behaviour far more
 * than calibre does: a 20 mm minengeschoss has a thin drawn shell and huge
 * filler and will not defeat 5 mm of plate, while a 13 mm AP core will.
 */
export enum AmmoType {
  /** Soft-cored ball / FMJ. Deforms on impact, poor penetration, cheap. */
  Ball = 0,
  /** Hardened steel or tungsten core, no filler. Penetrates, damages by kinetic. */
  AP = 1,
  /** AP with a small base-fused HE charge — penetrates *then* detonates inside. */
  APHE = 2,
  /** Thin-walled high explosive, nose fused. Detonates on or just inside the skin. */
  HE = 3,
  /** HE + incendiary composition. Same blast, much higher ignition probability. */
  HEI = 4,
  /** Armour-piercing incendiary: penetrates, then ignites what it finds. */
  API = 5,
}

export const AMMO_NAMES: Record<AmmoType, string> = {
  [AmmoType.Ball]: 'Ball',
  [AmmoType.AP]: 'AP',
  [AmmoType.APHE]: 'AP-HE',
  [AmmoType.HE]: 'HE',
  [AmmoType.HEI]: 'HEI',
  [AmmoType.API]: 'API',
};

/** True for anything carrying a burster charge. */
export const isExplosiveAmmo = (a: AmmoType): boolean =>
  a === AmmoType.HE || a === AmmoType.HEI || a === AmmoType.APHE;

/** True for anything that will start a fire on contact with fuel. */
export const isIncendiaryAmmo = (a: AmmoType): boolean =>
  a === AmmoType.HEI || a === AmmoType.API;

/** True for the kinetic penetrators. */
export const isKineticAmmo = (a: AmmoType): boolean =>
  a === AmmoType.AP || a === AmmoType.APHE || a === AmmoType.API || a === AmmoType.Ball;

// ---------------------------------------------------------------------------
// Modules — the collision/damage decomposition of an aircraft
// ---------------------------------------------------------------------------

/**
 * Every module is both a collision proxy volume and a damage bucket. Keep the
 * order stable: it indexes the Float32Arrays in AircraftDamageState.
 */
export enum ModuleId {
  Fuselage = 0,
  Engine,
  PropHub,
  Radiator,
  OilTank,
  FuelFuselage,
  FuelLeft,
  FuelRight,
  Pilot,
  AmmoLeft,
  AmmoRight,
  WingLeft,
  WingRight,
  SparLeft,
  SparRight,
  AileronLeft,
  AileronRight,
  TailBoom,
  HStab,
  VStab,
  Elevator,
  Rudder,
  CablePitch,
  CableRoll,
  CableYaw,
  GearLeft,
  GearRight,
}

export const MODULE_COUNT = ModuleId.GearRight + 1;

export const MODULE_NAMES: string[] = [
  'fuselage', 'engine', 'prop hub', 'radiator', 'oil tank',
  'fuselage fuel tank', 'left fuel tank', 'right fuel tank',
  'pilot', 'left ammo', 'right ammo',
  'left wing', 'right wing', 'left spar', 'right spar',
  'left aileron', 'right aileron',
  'tail boom', 'horizontal stabiliser', 'vertical stabiliser',
  'elevator', 'rudder',
  'pitch control run', 'roll control run', 'yaw control run',
  'left gear', 'right gear',
];

/**
 * Fire propagation graph. A burning module can ignite anything adjacent to it.
 * These are physical adjacencies (shared bulkhead / plumbing / airflow), not
 * geometric neighbours — fire in a wing tank travels down the spar and along
 * the wing skin, not across the fuselage.
 */
export const MODULE_ADJACENCY: ModuleId[][] = (() => {
  const a: ModuleId[][] = [];
  for (let i = 0; i < MODULE_COUNT; i++) a.push([]);
  const link = (x: ModuleId, y: ModuleId) => { a[x].push(y); a[y].push(x); };
  link(ModuleId.Engine, ModuleId.OilTank);
  link(ModuleId.Engine, ModuleId.Radiator);
  link(ModuleId.Engine, ModuleId.PropHub);
  link(ModuleId.Engine, ModuleId.Fuselage);
  link(ModuleId.Engine, ModuleId.FuelFuselage);
  link(ModuleId.OilTank, ModuleId.Fuselage);
  link(ModuleId.FuelFuselage, ModuleId.Pilot);
  link(ModuleId.FuelFuselage, ModuleId.Fuselage);
  link(ModuleId.FuelLeft, ModuleId.WingLeft);
  link(ModuleId.FuelLeft, ModuleId.SparLeft);
  link(ModuleId.FuelLeft, ModuleId.AmmoLeft);
  link(ModuleId.FuelRight, ModuleId.WingRight);
  link(ModuleId.FuelRight, ModuleId.SparRight);
  link(ModuleId.FuelRight, ModuleId.AmmoRight);
  link(ModuleId.WingLeft, ModuleId.SparLeft);
  link(ModuleId.WingLeft, ModuleId.AileronLeft);
  link(ModuleId.WingLeft, ModuleId.Fuselage);
  link(ModuleId.WingRight, ModuleId.SparRight);
  link(ModuleId.WingRight, ModuleId.AileronRight);
  link(ModuleId.WingRight, ModuleId.Fuselage);
  link(ModuleId.Fuselage, ModuleId.Pilot);
  link(ModuleId.Fuselage, ModuleId.TailBoom);
  link(ModuleId.TailBoom, ModuleId.HStab);
  link(ModuleId.TailBoom, ModuleId.VStab);
  link(ModuleId.HStab, ModuleId.Elevator);
  link(ModuleId.VStab, ModuleId.Rudder);
  link(ModuleId.TailBoom, ModuleId.CablePitch);
  link(ModuleId.TailBoom, ModuleId.CableYaw);
  link(ModuleId.Fuselage, ModuleId.CableRoll);
  link(ModuleId.WingLeft, ModuleId.GearLeft);
  link(ModuleId.WingRight, ModuleId.GearRight);
  return a;
})();

// ---------------------------------------------------------------------------
// Collision proxy
// ---------------------------------------------------------------------------

export type ArmourMaterial = 'rha' | 'sthard' | 'dural' | 'glass' | 'wood';

/**
 * RHA-equivalence coefficients. A millimetre of aircraft-grade duralumin is
 * worth roughly a third of a millimetre of rolled homogeneous armour against
 * a rifle-calibre penetrator; laminated bulletproof glass about a quarter;
 * plywood essentially nothing. Face-hardened plate ("sthard") is worth more
 * than RHA against uncapped rounds, which is the case for every aircraft gun
 * in this era.
 */
export const RHA_EQUIV: Record<ArmourMaterial, number> = {
  rha: 1.0,
  sthard: 1.18,
  dural: 0.33,
  glass: 0.26,
  wood: 0.05,
};

export type ShapeKind = 'box' | 'capsule';

/**
 * One oriented collision volume in aircraft body space.
 *
 * Boxes are used where the module really is boxy (engine bay, pilot armour
 * box, ammo trays, wing panels). Capsules are used for long slender things
 * (spars, tail boom, control runs) where an AABB would grossly overstate the
 * hit area.
 */
export interface ProxyShape {
  module: ModuleId;
  kind: ShapeKind;

  /** Box: centre in body space. Capsule: unused (see a/b). */
  c: V3;
  /** Box: half extents along the shape's local axes. */
  h: V3;
  /** Box: local orientation relative to body space. Identity if omitted. */
  q?: Q;

  /** Capsule: segment endpoints in body space. */
  a?: V3;
  b?: V3;
  /** Capsule: radius. */
  r?: number;

  /**
   * Structural armour on the +Z (forward) / -Z (aft) / lateral faces, mm.
   * Real WWII fighters were armoured very directionally: a head-on pass meets
   * the engine block and the front glass, a six-o'clock pass meets the pilot's
   * back plate, and a deflection shot meets nothing at all.
   */
  armourFront: number;
  armourRear: number;
  armourSide: number;
  armourMaterial: ArmourMaterial;

  /**
   * Skin/structure the round must chew through to *reach* this module,
   * expressed as mm RHA equivalent. Aircraft skin is ~1 mm dural = 0.33 mm.
   */
  skinMm: number;

  /**
   * Internal resistance of the module itself, mm RHA equivalent. An engine
   * block will stop a rifle-calibre round dead; a fuel tank barely slows one.
   * Applied when the round tries to exit and continue to the next module.
   */
  internalMm: number;

  /** Bounding-sphere radius of the shape (for cheap culling and blast tests). */
  radius: number;
  /** Bounding-sphere centre in body space. */
  centre: V3;
  /**
   * Presented cross-sectional area in m² — used by the fragment model to work
   * out how many splinters from a nearby burst actually strike this module.
   */
  area: number;
}

export interface AircraftProxy {
  specId: string;
  shapes: ProxyShape[];
  /** Bounding sphere of the whole aircraft in body space. */
  boundRadius: number;
  boundCentre: V3;
  /**
   * Bounding radius measured from the body *origin* rather than the tight
   * bound centre. Slightly larger, but it lets the broad-phase reject a
   * segment in world space without rotating anything — which matters when
   * two thousand rounds are each tested against every nearby aircraft.
   */
  boundRadiusOrigin: number;
}

// ---------------------------------------------------------------------------
// Lag compensation
// ---------------------------------------------------------------------------

export interface TransformSample {
  t: number;
  px: number; py: number; pz: number;
  qx: number; qy: number; qz: number; qw: number;
}

/**
 * Fixed-capacity ring of past transforms. The server pushes one per tick and
 * hit detection rewinds into it so a client shooting at what it saw 90 ms ago
 * scores the hit it deserves.
 */
export interface HistoryBuffer {
  samples: TransformSample[];
  /** Index of the most recently written sample. */
  head: number;
  /** Number of valid samples (<= samples.length). */
  count: number;
}

// ---------------------------------------------------------------------------
// Targets and environment
// ---------------------------------------------------------------------------

export interface CombatTarget {
  /** Entity id (matches EntityState.id). */
  id: number;
  team: number;
  /** Player id of the owner, 0 for AI/world. */
  ownerId: number;
  alive: boolean;
  proxy: AircraftProxy;
  /** Current world transform. */
  p: V3;
  q: Q;
  /** Current world velocity, m/s — used for AA lead solutions. */
  v: V3;
  /** Optional history ring for lag compensation. */
  history?: HistoryBuffer;
  /** Optional damage state; combat code never mutates it, callers do. */
  damage?: AircraftDamageState;
}

/**
 * Everything the ballistics/blast code needs from the outside world. The
 * integrator supplies this; there is deliberately no global state in here.
 */
export interface CombatEnv {
  /** Server time in seconds. Advance this before calling stepProjectiles. */
  time: number;

  /**
   * Gather candidate targets whose bounding sphere could overlap the segment
   * p0->p1 (plus 'pad' metres). Push into 'out' (already emptied). A naive
   * implementation may simply push every live aircraft.
   */
  queryTargets(p0: V3, p1: V3, pad: number, out: CombatTarget[]): void;

  /** Terrain surface height at (x, z). Sea level is 0. */
  terrainHeight(x: number, z: number): number;

  /**
   * True if terrain blocks the straight line a->b. Used to shield blast.
   * Optional — omitted means "open air", which is right for air combat.
   */
  terrainOccludes?(a: V3, b: V3): boolean;

  /** Wind in world space, m/s. Optional. */
  wind?: V3;

  /** Gravity magnitude; defaults to 9.80665. */
  gravity?: number;

  /** Deterministic RNG shared by all stochastic combat outcomes. */
  rng: Rng;
}

// ---------------------------------------------------------------------------
// Projectiles
// ---------------------------------------------------------------------------

export enum ProjectileKind {
  Bullet = 0,
  Shell = 1,
  Bomb = 2,
  Rocket = 3,
  Flak = 4,
}

export enum FuseKind {
  /** Detonates on contact (after 'fuseDelayM' of travel past the surface). */
  Impact = 0,
  /** Detonates 'fuseTime' seconds after launch, wherever it is. */
  Timed = 1,
  /** Detonates within 'proxRadius' of any hostile aircraft. */
  Proximity = 2,
  /** Never detonates (pure kinetic). */
  Inert = 3,
}

export interface Projectile {
  id: number;
  alive: boolean;
  kind: ProjectileKind;
  ammo: AmmoType;

  /** Millimetres. */
  calibre: number;
  /** Current mass, kg. Reduced as the round sheds material through armour. */
  mass: number;
  /** Launch mass, kg. */
  mass0: number;
  /** Explosive filler, grams of TNT equivalent. */
  heGrams: number;
  /** G1 form factor — how much sleeker than the standard projectile it is. */
  formFactor: number;
  /** Reference frontal area, m². Cached from calibre. */
  area: number;

  p: V3;
  v: V3;
  /** Position at the start of the current substep — the swept segment tail. */
  pPrev: V3;

  /** Age since launch, s. */
  t: number;
  /** Despawn age, s. */
  maxTime: number;
  /** Tracer burn-out age, s. 0 = no tracer. */
  tracerTime: number;
  /** Packed 0xRRGGBB tracer colour, for the VFX layer. */
  tracerColor: number;

  ownerId: number;
  team: number;
  /** Entity id of the shooter — never hit while 'ignoreUntil' is in the future. */
  shooterEntity: number;
  ignoreUntil: number;

  /** Server time at which the trigger was pulled. */
  fireTime: number;
  /**
   * Lag-compensation rewind for this shot, seconds. Targets are tested against
   * where they were 'rewind' seconds before 'fireTime + t'.
   */
  rewind: number;

  fuse: FuseKind;
  /** Impact fuse: metres of penetration before the burster goes off. */
  fuseDelayM: number;
  /** Timed fuse: age at which it detonates. */
  fuseTime: number;
  /** Proximity fuse radius, m. */
  proxRadius: number;
  /** Seconds after launch before the fuse arms (bombs mostly). */
  armTime: number;
  /**
   * Delay-action fuse: seconds between striking the ground and detonating.
   * Non-zero makes the round rest on the surface until it functions, which is
   * what lets low-level attackers bomb without fragging themselves.
   */
  fuseDelayS: number;
  /** True once the round has come to rest and is only counting down its fuse. */
  stuck: boolean;

  /** Rocket motor: thrust in newtons while 't < burnTime'. */
  thrust: number;
  burnTime: number;
  /** Propellant mass burned off over 'burnTime', kg. */
  propellantMass: number;
  /**
   * Unit vector perpendicular to the launch direction along which a fraction
   * of the motor's thrust acts. This is *the* reason unguided rockets are
   * inaccurate: a fraction of a degree of nozzle misalignment integrates into
   * tens of metres of miss at 1 km.
   */
  misalign: V3;
  /** Fraction of thrust acting along 'misalign'. */
  misalignFrac: number;

  /** How many targets this round may pass through before it is spent. */
  penetrationsLeft: number;

  /** Free-form tag for the caller (weapon index, hardpoint, ...). */
  tag: number;
}

// ---------------------------------------------------------------------------
// Hit results
// ---------------------------------------------------------------------------

export type HitType =
  /** Round defeated the armour and continued into the module. */
  | 'penetrate'
  /** Round struck but failed to get through; energy dumped on the surface. */
  | 'stop'
  /** Round deflected off the plate. */
  | 'ricochet'
  /** Explosive filler detonated at this point. */
  | 'detonate'
  /** Overpressure damage from a nearby detonation. */
  | 'blast'
  /** Casing fragment strike from a nearby detonation. */
  | 'fragment'
  /** Struck terrain. */
  | 'terrain'
  /** Struck water. */
  | 'water'
  /** Timed out / fell out of the world. */
  | 'expire';

/**
 * One damage-relevant event produced by the ballistics layer. Feed it straight
 * into 'applyDamage'. Everything the VFX/audio layer needs is here too, so the
 * server can turn a HitResult into a 'GameEvent' without a second lookup.
 */
export interface HitResult {
  type: HitType;
  time: number;
  projectileId: number;
  kind: ProjectileKind;
  ammo: AmmoType;
  calibre: number;
  heGrams: number;

  ownerId: number;
  team: number;
  shooterEntity: number;

  /** Entity hit; 0 for terrain/water/expire. */
  targetId: number;
  /** Module hit; -1 when not applicable. */
  module: ModuleId | -1;

  /** World impact point. */
  px: number; py: number; pz: number;
  /** World surface normal at impact (unit). */
  nx: number; ny: number; nz: number;
  /** Unit travel direction at impact. */
  dx: number; dy: number; dz: number;

  /** Impact speed, m/s. */
  speed: number;
  /** Kinetic energy actually deposited into the target, J. */
  energy: number;
  /** Damage in module hit points. 'applyDamage' consumes this. */
  damage: number;
  /** Probability [0,1] that this hit starts a fire in the module. */
  ignite: number;

  /** Penetration capability at impact, mm RHA. */
  penetrationMm: number;
  /** Line-of-sight thickness actually presented, mm RHA. */
  effectiveArmourMm: number;
  /** Impact angle from the surface normal, degrees. 0 = perpendicular. */
  angleDeg: number;
}

export function newHitResult(): HitResult {
  return {
    type: 'stop', time: 0, projectileId: 0, kind: ProjectileKind.Bullet,
    ammo: AmmoType.Ball, calibre: 0, heGrams: 0,
    ownerId: 0, team: 0, shooterEntity: 0,
    targetId: 0, module: -1,
    px: 0, py: 0, pz: 0, nx: 0, ny: 1, nz: 0, dx: 0, dy: 0, dz: 1,
    speed: 0, energy: 0, damage: 0, ignite: 0,
    penetrationMm: 0, effectiveArmourMm: 0, angleDeg: 0,
  };
}

export type HitSink = (hit: HitResult) => void;

// ---------------------------------------------------------------------------
// Damage state
// ---------------------------------------------------------------------------

export interface FireState {
  module: ModuleId;
  /** 0..1 — how hot. Drives damage rate, spread rate and VFX size. */
  intensity: number;
  /** Seconds this fire has been burning. Extinguish chance decays with it. */
  burnT: number;
  /** Seconds since it last got a chance to spread. */
  spreadT: number;
}

export enum DamageEventKind {
  ModuleDamaged = 0,
  ModuleDestroyed,
  Ricochet,
  ArmourStopped,
  FireStarted,
  FireSpread,
  FireOut,
  FuelLeak,
  OilLeak,
  CoolantLeak,
  EngineSeized,
  EnginePowerLoss,
  PilotHit,
  PilotKnockedOut,
  PilotRecovered,
  PilotDead,
  WingRipped,
  ControlSevered,
  AmmoDetonation,
  StructuralFailure,
  Destroyed,
}

export interface DamageEvent {
  kind: DamageEventKind;
  entityId: number;
  module: ModuleId | -1;
  /** Player id credited with causing this. */
  by: number;
  /** Entity id of the shooter. */
  byEntity: number;
  /** Context-dependent magnitude (damage dealt, leak rate, intensity...). */
  severity: number;
  x: number; y: number; z: number;
  time: number;
}

export interface AircraftDamageState {
  entityId: number;
  specId: string;
  team: number;
  ownerId: number;

  /** Per-module hit points and their maxima. */
  hp: Float32Array;
  hpMax: Float32Array;
  /** 1 = module has been knocked out. */
  out: Uint8Array;

  /** Mirrors 'DamageBits' from ../protocol. */
  bits: number;

  // --- powerplant -----------------------------------------------------
  /** Multiplier on available shaft power, 0..1. */
  enginePower: number;
  /** Oil quantity remaining, 0..1. Zero oil seizes the engine. */
  oil: number;
  oilLeak: number;      // fraction per second
  coolant: number;      // 0..1
  coolantLeak: number;  // fraction per second
  /** 0 = normal, 1 = at the seizure threshold, >1 = seizing. */
  engineTemp: number;
  engineSeized: boolean;

  // --- fuel -----------------------------------------------------------
  fuelKg: number;
  fuelMaxKg: number;
  /** kg/s draining out of holed tanks. */
  fuelLeak: number;
  selfSealing: boolean;

  // --- structure ------------------------------------------------------
  /** 0..1 remaining strength of each wing spar (index 0 = left, 1 = right). */
  spar: Float32Array;
  wingOff: [boolean, boolean];
  tailOff: boolean;

  // --- flight controls ------------------------------------------------
  /** 0..1 remaining authority per axis. Severed cable => 0. */
  ctlPitch: number;
  ctlRoll: number;
  ctlYaw: number;
  /** Jammed surface deflection left behind by a severed/locked cable, -1..1. */
  biasPitch: number;
  biasRoll: number;
  biasYaw: number;

  // --- pilot ----------------------------------------------------------
  pilotHp: number;
  /** Seconds of remaining blackout/knockout. */
  pilotKo: number;
  pilotDead: boolean;
  pilotBailed: boolean;

  // --- ammunition -----------------------------------------------------
  /** Seconds until a hit ammo tray cooks off; <=0 means not cooking. */
  cookoff: Float32Array; // [left, right]

  fires: FireState[];

  destroyed: boolean;
  /** Player id credited with the kill. */
  killer: number;
  killerEntity: number;
  lastHitTime: number;
  totalDamage: number;

  /** Per-aircraft deterministic RNG so replays match. */
  rng: Rng;
}

/**
 * Everything the damage tick needs from the flight model. All optional inputs
 * have sane fallbacks so a caller can pass a partial object during bring-up.
 */
export interface DamageStepInput {
  time: number;
  /** Load factor along the body Y axis, g. */
  gLoad: number;
  /** Indicated airspeed, m/s. */
  ias: number;
  /** True airspeed, m/s. */
  tas: number;
  altitude: number;
  /** Sideslip angle, radians. Slipping blows flame away from the airframe. */
  sideslip: number;
  /** 0..1 — throttle setting, drives engine heat. */
  throttle: number;
  /** True if the radiator is open (cooling help). */
  radiatorOpen: boolean;
  /** Structural g limit from the aircraft spec. */
  gLimit: number;
  /** Fuel burn rate in kg/s requested by the engine model. */
  fuelBurn: number;
  /** World position, for event placement. */
  x: number; y: number; z: number;
}

/**
 * What the flight model multiplies its clean-aircraft coefficients by.
 * Everything is a modifier, never an absolute — so the flight model stays the
 * single source of truth for the aerodynamics.
 */
export interface DamageEffects {
  /** Multiplier on engine shaft power. */
  powerScale: number;
  /** Multiplier on max RPM (a windmilling prop still turns). */
  rpmScale: number;
  /** True when the crank has stopped: no power, huge prop drag. */
  engineSeized: boolean;

  /** Additive parasitic drag coefficient (holes, missing panels, hanging gear). */
  cd0Add: number;
  /** Multiplier on total lift (missing wing area). */
  clScale: number;
  /**
   * Rolling-moment coefficient from asymmetric lift loss. Positive rolls the
   * aircraft right (toward +X). The flight model adds this to its own Cl.
   */
  rollMomentAdd: number;
  /** Yawing-moment coefficient from asymmetric drag. Positive yaws right. */
  yawMomentAdd: number;
  /** Pitching-moment offset from a shot-away elevator / shifted CG. */
  pitchMomentAdd: number;

  /** 0..1 authority per axis, after cable and surface damage. */
  rollAuthority: number;
  pitchAuthority: number;
  yawAuthority: number;
  /** Jammed control offsets in the same units as pilot input, -1..1. */
  pitchBias: number;
  rollBias: number;
  yawBias: number;

  /** Multiplier on the structural g limit. */
  gLimitScale: number;
  /** Multiplier on roll inertia (a missing wing is dramatic). */
  rollInertiaScale: number;

  /** Mass change relative to the clean spec, kg (fuel burned/lost, wing gone). */
  massDelta: number;
  /** CG shift in body space, metres. */
  cgShiftX: number;
  cgShiftZ: number;

  /** 0 = the pilot cannot fly (dead or knocked out). */
  pilotControl: number;

  /** Presentation hints for VFX/audio. */
  smokeBlack: number;   // 0..1 — engine/oil smoke
  smokeWhite: number;   // 0..1 — coolant/fuel vapour
  fireIntensity: number; // 0..1 — largest active fire
}

export function newDamageEffects(): DamageEffects {
  return {
    powerScale: 1, rpmScale: 1, engineSeized: false,
    cd0Add: 0, clScale: 1, rollMomentAdd: 0, yawMomentAdd: 0, pitchMomentAdd: 0,
    rollAuthority: 1, pitchAuthority: 1, yawAuthority: 1,
    pitchBias: 0, rollBias: 0, yawBias: 0,
    gLimitScale: 1, rollInertiaScale: 1,
    massDelta: 0, cgShiftX: 0, cgShiftZ: 0,
    pilotControl: 1,
    smokeBlack: 0, smokeWhite: 0, fireIntensity: 0,
  };
}
