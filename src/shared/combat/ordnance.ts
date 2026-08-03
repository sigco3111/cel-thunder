/**
 * Air-to-ground ordnance: bombs and unguided rockets.
 *
 * Both are just projectiles with different mass, drag and fusing, which is the
 * whole point of building the ballistics layer generically — a 250 kg bomb and
 * a 7.7 mm bullet go through the same integrator, so a bomb released in a 60°
 * dive at 500 km/h follows the trajectory it should, retaining forward throw
 * and reaching terminal velocity if you drop it from high enough.
 *
 * The two things that make ordnance *feel* right are the ones games usually
 * skip: a fuse delay, so low-level attackers are not killed by their own
 * bombs; and honest dispersion on rockets, because unguided rockets were
 * genuinely inaccurate and pretending otherwise makes them a sniper rifle.
 */

import { type V3, v3, vset, vlen, clamp, Rng } from '../math';
import type { AircraftSpec } from '../aircraft';
import {
  type CombatEnv, type HitSink, type Projectile,
  AmmoType, FuseKind, ProjectileKind,
} from './types';
import {
  createProjectile, advanceBallistic,
  type ProjectileInit, type ProjectilePool,
} from './ballistics';
import { applyExplosion, warheadCasing } from './explosion';

// ---------------------------------------------------------------------------
// Bombs
// ---------------------------------------------------------------------------

export interface BombSpec {
  name: string;
  /** All-up weight, kg. */
  kg: number;
  /**
   * Explosive fraction. General-purpose bombs of the period ran 45–55 % for
   * US/British types and nearer 50–60 % for the German SC series; armour
   * piercing and semi-AP types much less.
   */
  fillFraction: number;
  /** Body diameter, m. Drives drag. */
  diameter: number;
  /** Seconds between impact and detonation. */
  fuseDelay: number;
  /** Seconds after release before the fuse arms. */
  armTime: number;
}

/**
 * Derive a plausible bomb from just its weight, so the aircraft table only has
 * to declare 'kg'. Diameter follows the usual slenderness of WWII GP bombs
 * (length/diameter ≈ 6, density ≈ 1500 kg/m³ of enclosed volume).
 */
export function bombSpecFromKg(kg: number, name = `${Math.round(kg)} kg bomb`): BombSpec {
  const volume = kg / 1500;
  // v = π/4 · d² · L with L = 6d  ->  d = (2v/(3π))^(1/3)
  const diameter = Math.cbrt((2 * volume) / (3 * Math.PI));
  return {
    name, kg,
    fillFraction: kg >= 400 ? 0.52 : kg >= 100 ? 0.50 : 0.45,
    diameter: clamp(diameter, 0.09, 0.75),
    fuseDelay: 0.045,
    armTime: 0.6,
  };
}

export interface DropParams {
  spec: BombSpec;
  /** Release point, world space. */
  origin: V3;
  /** Aircraft velocity at release — the bomb inherits all of it. */
  velocity: V3;
  ownerId: number;
  team: number;
  shooterEntity: number;
  time: number;
  /** Ejector-rack push-off, m/s, applied along the aircraft's -Y. */
  ejectSpeed?: number;
  /** Aircraft "down" direction in world space, for the ejector push. */
  down?: V3;
  rng?: Rng;
  pool?: ProjectilePool;
  tag?: number;
}

const _dir = v3(), _inherit = v3();

/** Release one bomb. */
export function dropBomb(prm: DropParams): Projectile {
  const s = prm.spec;
  vset(_inherit, prm.velocity.x, prm.velocity.y, prm.velocity.z);
  if (prm.ejectSpeed && prm.down) {
    _inherit.x += prm.down.x * prm.ejectSpeed;
    _inherit.y += prm.down.y * prm.ejectSpeed;
    _inherit.z += prm.down.z * prm.ejectSpeed;
  }
  const speed = vlen(_inherit);
  if (speed > 1e-4) vset(_dir, _inherit.x / speed, _inherit.y / speed, _inherit.z / speed);
  else vset(_dir, 0, -1, 0);

  const init: ProjectileInit = {
    origin: prm.origin,
    direction: _dir,
    speed,
    ammo: AmmoType.HE,
    // Calibre is used only for the reference area; feed it the body diameter.
    calibre: s.diameter * 1000,
    mass: s.kg,
    heGrams: s.kg * s.fillFraction * 1000,
    kind: ProjectileKind.Bomb,
    ownerId: prm.ownerId, team: prm.team, shooterEntity: prm.shooterEntity,
    time: prm.time,
    fuse: FuseKind.Impact,
    fuseDelayS: s.fuseDelay,
    armTime: s.armTime,
    lifetime: 120,
    tracerTime: 0,
    // Nothing but the drag model applies to a bomb's Cd; formFactor is unused
    // for ProjectileKind.Bomb but keep it sane for any generic code path.
    formFactor: 1,
    rng: prm.rng,
    pool: prm.pool,
    tag: prm.tag ?? 0,
  };
  return createProjectile(init);
}

/** Bomb loadout declared on an aircraft archetype, as a usable BombSpec. */
export function bombSpecFor(spec: AircraftSpec): BombSpec | null {
  if (!spec.bombs) return null;
  return bombSpecFromKg(spec.bombs.kg, spec.bombs.name);
}

/**
 * Impact-point prediction for the bombsight: where a bomb released *now*
 * lands. Runs the real integrator at a coarse step, so the sight can never
 * disagree with the bombs.
 */
export function predictBombImpact(
  spec: BombSpec, origin: V3, velocity: V3, env: CombatEnv, out: V3, maxTime = 60,
): number {
  const p = dropBomb({
    spec, origin, velocity,
    ownerId: 0, team: 0, shooterEntity: 0, time: env.time,
  });
  // 20 ms is fine here: a bomb never exceeds ~300 m/s, so the sub-step error
  // is centimetres over a 30 s fall.
  const h = 0.02;
  let t = 0;
  let px = p.p.x, py = p.p.y, pz = p.p.z;
  while (t < maxTime) {
    const prevY = py, prevX = px, prevZ = pz;
    advanceBallistic(p, env, h);
    px = p.p.x; py = p.p.y; pz = p.p.z;
    t += h;
    const ground = env.terrainHeight(px, pz);
    if (py <= ground) {
      const prevG = env.terrainHeight(prevX, prevZ);
      const num = prevY - prevG;
      const den = num - (py - ground);
      const a = clamp(den !== 0 ? num / den : 0, 0, 1);
      vset(out, prevX + (px - prevX) * a, prevY + (py - prevY) * a, prevZ + (pz - prevZ) * a);
      return t;
    }
  }
  vset(out, px, py, pz);
  return t;
}

// ---------------------------------------------------------------------------
// Rockets
// ---------------------------------------------------------------------------

export interface RocketSpec {
  name: string;
  /** All-up launch weight, kg. */
  kg: number;
  /** Warhead explosive, grams TNT-equivalent. */
  heGrams: number;
  /** Body diameter, m. */
  diameter: number;
  /** Motor total impulse expressed as thrust (N) and burn time (s). */
  thrust: number;
  burnTime: number;
  /** Propellant mass, kg — burned off during the boost. */
  propellantMass: number;
  /** Launch-rail exit velocity, m/s. */
  railSpeed: number;
  /** 1σ launch angular dispersion, radians. */
  dispersion: number;
  /** 1σ thrust misalignment as a fraction of thrust. */
  misalignSigma: number;
  /** Proximity/impact fusing. */
  proxRadius: number;
}

/**
 * A reasonable stand-in for the RP-3 / M8 / RS-82 class of 1943 aircraft
 * rocket: 25–30 kg, a couple of seconds of boost to around 400 m/s over the
 * launch aircraft's speed, and roughly 10 mrad of dispersion. That dispersion
 * is not a nerf — RAF trials put the 50 % zone of an eight-rocket salvo at
 * well over 20 m at 900 m range.
 */
export function defaultRocketSpec(kg = 27, heGrams = 4500, name = 'RP-3'): RocketSpec {
  const diameter = clamp(Math.cbrt(kg / 1500 * 2 / (3 * Math.PI)) , 0.05, 0.30);
  return {
    name, kg, heGrams, diameter,
    thrust: 5200, burnTime: 1.6, propellantMass: kg * 0.42,
    railSpeed: 22,
    dispersion: 0.0075,
    misalignSigma: 0.010,
    proxRadius: 0,
  };
}

export interface LaunchParams {
  spec: RocketSpec;
  origin: V3;
  /** Unit launch direction (usually the aircraft's nose, allowing for droop). */
  direction: V3;
  velocity: V3;
  ownerId: number;
  team: number;
  shooterEntity: number;
  time: number;
  rng: Rng;
  pool?: ProjectilePool;
  tag?: number;
}

export function launchRocket(prm: LaunchParams): Projectile {
  const s = prm.spec;
  return createProjectile({
    origin: prm.origin,
    direction: prm.direction,
    speed: s.railSpeed,
    inherit: prm.velocity,
    ammo: AmmoType.HE,
    calibre: s.diameter * 1000,
    mass: s.kg,
    heGrams: s.heGrams,
    kind: ProjectileKind.Rocket,
    ownerId: prm.ownerId, team: prm.team, shooterEntity: prm.shooterEntity,
    time: prm.time,
    fuse: s.proxRadius > 0 ? FuseKind.Proximity : FuseKind.Impact,
    proxRadius: s.proxRadius,
    fuseDelayM: 0.25,
    armTime: 0.35,
    lifetime: 22,
    tracerTime: s.burnTime,
    tracerColor: 0xfff0c0,
    thrust: s.thrust,
    burnTime: s.burnTime,
    propellantMass: s.propellantMass,
    dispersion: s.dispersion,
    misalignSigma: s.misalignSigma,
    formFactor: 1,
    rng: prm.rng,
    pool: prm.pool,
    tag: prm.tag ?? 0,
  });
}

/** Rocket loadout declared on an aircraft archetype, as a usable RocketSpec. */
export function rocketSpecFor(spec: AircraftSpec): RocketSpec | null {
  if (!spec.rockets) return null;
  return defaultRocketSpec(spec.rockets.kg, spec.rockets.he, spec.rockets.name);
}

/**
 * Salvo helper: fires 'count' rockets from the given hardpoints with a small
 * ripple interval baked into the dispersion (successive rockets disturb the
 * airflow for the ones behind them).
 */
export function launchSalvo(
  prm: LaunchParams, mounts: V3[], out: Projectile[],
): void {
  const base = prm.spec;
  for (let i = 0; i < mounts.length; i++) {
    const s: RocketSpec = { ...base, dispersion: base.dispersion * (1 + i * 0.06) };
    out.push(launchRocket({ ...prm, spec: s, origin: mounts[i], tag: i }));
  }
}

// ---------------------------------------------------------------------------
// Manual detonation (scripted charges, wreck explosions, ammo cook-off)
// ---------------------------------------------------------------------------

/**
 * Detonate a warhead at an arbitrary point. Used for aircraft breaking up,
 * ground-target secondary explosions and ammunition cook-off.
 */
export function detonateAt(
  env: CombatEnv, x: number, y: number, z: number,
  kg: number, fillFraction: number, ownerId: number, team: number,
  shooterEntity: number, onHit: HitSink,
): void {
  const heGrams = kg * fillFraction * 1000;
  const casing = warheadCasing(kg, heGrams);
  applyExplosion(env, {
    x, y, z,
    heGrams,
    casingKg: casing.casingKg,
    fragMass: casing.fragMass,
    fragVelocity: casing.fragVelocity,
    ownerId, team, shooterEntity,
    ammo: AmmoType.HE,
    kind: ProjectileKind.Bomb,
    projectileId: 0,
    time: env.time,
  }, onHit);
}

/**
 * Terminal velocity of a bomb at sea level — useful for sanity-checking a
 * loadout and for the bombsight's maximum-drop-height warning.
 */
export function bombTerminalVelocity(spec: BombSpec): number {
  const area = Math.PI * (spec.diameter * 0.5) ** 2;
  // Cd ≈ 0.115 subsonic on frontal area (see drag.ts).
  return Math.sqrt((2 * spec.kg * 9.80665) / (1.225 * 0.115 * area));
}
