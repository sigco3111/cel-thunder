/**
 * Ground-based anti-aircraft fire: light automatic guns and heavy flak.
 *
 * The design goal is that AA should feel like *aimed* fire from a crew, not a
 * hitscan tax on flying low. Every real behaviour that makes AA readable is
 * modelled:
 *
 *  - a reaction delay before a newly spotted aircraft is engaged (a crew has
 *    to traverse, range and open fire), so a fast pass through a battery can
 *    beat it,
 *  - a *tracking* solution that slews at a finite rate, so hard manoeuvring
 *    genuinely spoils the aim,
 *  - correlated aim error that persists across a burst (a mis-laid gun misses
 *    consistently, it does not scatter randomly around the truth), plus small
 *    per-round dispersion on top,
 *  - a lead solution computed with the real time of flight and gravity drop,
 *    so the tracer stream visibly leads you and you can see it doing so,
 *  - for heavy flak, a time fuse set from the predicted time of flight with a
 *    fuse-setting error, giving the characteristic bursts that bracket the
 *    formation rather than tracking it.
 */

import {
  type V3, v3, vset, vsub, vlen, vnorm, vcross, clamp, lerp, damp, Rng,
} from '../math';
import {
  type CombatEnv, type CombatTarget, type Projectile,
  AmmoType, FuseKind, ProjectileKind, seedRng,
} from './types';
import {
  createProjectile, scatterDirection, solveBallisticLead, type ProjectilePool,
} from './ballistics';
import { G0 } from './atmosphere';

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

export interface AaGunSpec {
  name: string;
  /** Millimetres. */
  calibre: number;
  /** Projectile mass, kg. */
  mass: number;
  /** Muzzle velocity, m/s. */
  muzzle: number;
  /** Explosive filler, grams TNT-equivalent. 0 for solid AP. */
  heGrams: number;
  /** Rounds per minute (per barrel) and number of barrels. */
  rpm: number;
  barrels: number;
  /** Rounds in a burst before the gun pauses. */
  burst: number;
  /** Pause between bursts, seconds. */
  burstPause: number;
  /** Effective slant range, m. Beyond this the crew holds fire. */
  maxRange: number;
  /** Minimum range — heavy flak cannot depress or fuse this close. */
  minRange: number;
  /** Seconds between spotting a target and opening fire. */
  reaction: number;
  /** Turret traverse rate, rad/s. */
  trackRate: number;
  /** 1σ per-round dispersion, radians. */
  dispersion: number;
  /** 1σ persistent aim bias per engagement, radians. */
  aimError: number;
  /** How fast the crew's aim bias wanders, per second. */
  aimDrift: number;
  /** Time-fused airburst (heavy flak) rather than impact. */
  flak: boolean;
  /** 1σ fuse setting error, seconds. */
  fuseError: number;
  /** Proximity fuse radius; > 0 models late-war VT ammunition. */
  proxRadius: number;
  /** Tracer colour. */
  tracer: number;
  /** Fraction of rounds that are tracer. */
  tracerFrac: number;
}

/** 20 mm Flakvierling / Oerlikon class: fast, short-ranged, brutal down low. */
export const AA_LIGHT: AaGunSpec = {
  name: '20 mm light AA', calibre: 20, mass: 0.120, muzzle: 830, heGrams: 6.5,
  rpm: 480, barrels: 4, burst: 20, burstPause: 1.4,
  maxRange: 2000, minRange: 0, reaction: 1.1, trackRate: 1.5,
  dispersion: 0.0045, aimError: 0.0055, aimDrift: 0.5,
  flak: false, fuseError: 0, proxRadius: 0,
  tracer: 0xffd070, tracerFrac: 0.5,
};

/** 37–40 mm Bofors class: the dangerous middle band. */
export const AA_MEDIUM: AaGunSpec = {
  name: '40 mm medium AA', calibre: 40, mass: 0.90, muzzle: 875, heGrams: 65,
  rpm: 120, barrels: 1, burst: 4, burstPause: 2.0,
  maxRange: 4200, minRange: 0, reaction: 1.6, trackRate: 0.9,
  dispersion: 0.0030, aimError: 0.0042, aimDrift: 0.35,
  flak: false, fuseError: 0, proxRadius: 0,
  tracer: 0xffb050, tracerFrac: 1.0,
};

/** 88 mm class heavy flak: time-fused airbursts at altitude. */
export const AA_HEAVY: AaGunSpec = {
  name: '88 mm heavy flak', calibre: 88, mass: 9.4, muzzle: 820, heGrams: 900,
  rpm: 15, barrels: 1, burst: 1, burstPause: 4.2,
  maxRange: 9000, minRange: 900, reaction: 3.4, trackRate: 0.35,
  dispersion: 0.0020, aimError: 0.0075, aimDrift: 0.2,
  flak: true, fuseError: 0.14, proxRadius: 0,
  tracer: 0x000000, tracerFrac: 0,
};

// ---------------------------------------------------------------------------
// Gun state
// ---------------------------------------------------------------------------

export interface AaGun {
  id: number;
  team: number;
  /** Muzzle position, world space. */
  p: V3;
  spec: AaGunSpec;

  /** Current barrel direction (unit). Slews toward the firing solution. */
  aim: V3;
  /** Persistent aim bias for this engagement (radians, 2 components). */
  biasA: number;
  biasB: number;

  targetId: number;
  /** Counts down before the crew opens fire on a newly acquired target. */
  reactionLeft: number;
  /** Seconds until the next round leaves the barrel. */
  cooldown: number;
  /** Rounds fired in the current burst. */
  burstFired: number;
  /** Seconds of pause remaining between bursts. */
  pauseLeft: number;
  /** Ammunition remaining; -1 for unlimited. */
  ammo: number;
  alive: boolean;
  /** Deterministic per-gun RNG. */
  rng: Rng;
  /** Seconds since the gun last had line of sight (for LOS hysteresis). */
  losT: number;
}

export function createAaGun(
  id: number, team: number, pos: V3, spec: AaGunSpec, seed = 1, ammo = -1,
): AaGun {
  return {
    id, team, p: v3(pos.x, pos.y, pos.z), spec,
    aim: v3(0, 1, 0), biasA: 0, biasB: 0,
    targetId: 0, reactionLeft: 0, cooldown: 0, burstFired: 0, pauseLeft: 0,
    ammo, alive: true,
    rng: seedRng(seed ^ Math.imul(id, 2246822519)),
    losT: 0,
  };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

const _toTgt = v3(), _aimDir = v3(), _fireDir = v3();
const _tmp = v3();

/**
 * Score a target for a battery: closest and most threatening wins, but a
 * target that has flown behind terrain is dropped.
 */
function acquire(gun: AaGun, targets: CombatTarget[], env: CombatEnv): CombatTarget | null {
  let best: CombatTarget | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (!t.alive || t.team === gun.team) continue;
    vsub(t.p, gun.p, _toTgt);
    const d = vlen(_toTgt);
    if (d > gun.spec.maxRange || d < gun.spec.minRange) continue;
    // Guns cannot shoot through the ground.
    if (_toTgt.y < -20) continue;
    if (env.terrainOccludes && env.terrainOccludes(gun.p, t.p)) continue;
    // Prefer close, and prefer targets flying toward the battery.
    const closing = -(_toTgt.x * t.v.x + _toTgt.y * t.v.y + _toTgt.z * t.v.z) / Math.max(d, 1);
    const score = -d / gun.spec.maxRange + clamp(closing / 200, -0.5, 0.5);
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best;
}

export interface AaFireContext {
  env: CombatEnv;
  /** Called for every round that leaves a barrel. */
  onFire?: (gun: AaGun, projectile: Projectile) => void;
  pool?: ProjectilePool;
  /** Projectile list to push new rounds into. */
  out: Projectile[];
}

/**
 * Advance a battery of AA guns.
 *
 * 'targets' should be all live aircraft (the function does its own range and
 * team filtering). Rounds are appended to 'ctx.out'.
 */
export function stepAaGuns(
  guns: AaGun[], targets: CombatTarget[], dt: number, ctx: AaFireContext,
): void {
  const env = ctx.env;

  for (let gi = 0; gi < guns.length; gi++) {
    const gun = guns[gi];
    if (!gun.alive) continue;
    const spec = gun.spec;

    // --- target selection -------------------------------------------
    let target: CombatTarget | null = null;
    if (gun.targetId !== 0) {
      for (let i = 0; i < targets.length; i++) {
        if (targets[i].id === gun.targetId) { target = targets[i]; break; }
      }
      if (target) {
        vsub(target.p, gun.p, _toTgt);
        const d = vlen(_toTgt);
        const blocked = env.terrainOccludes ? env.terrainOccludes(gun.p, target.p) : false;
        if (blocked) gun.losT += dt; else gun.losT = 0;
        // Hold the track through a brief LOS break — real crews do.
        if (!target.alive || d > spec.maxRange * 1.1 || d < spec.minRange * 0.8 || gun.losT > 1.2) {
          target = null;
        }
      }
    }
    if (!target) {
      target = acquire(gun, targets, env);
      if (target) {
        if (gun.targetId !== target.id) {
          // New target: the crew has to lay the gun, and their systematic
          // error is re-rolled for this engagement.
          gun.reactionLeft = spec.reaction * (0.7 + 0.6 * gun.rng.next());
          gun.biasA = gaussian(gun.rng) * spec.aimError;
          gun.biasB = gaussian(gun.rng) * spec.aimError;
          gun.burstFired = 0;
          gun.pauseLeft = 0;
        }
        gun.targetId = target.id;
      } else {
        gun.targetId = 0;
        gun.reactionLeft = spec.reaction;
        continue;
      }
    }

    // --- firing solution ---------------------------------------------
    // Drag-aware: at heavy-flak ranges the naive muzzle-velocity estimate is
    // off by a factor of two in time of flight and more than a kilometre in
    // drop, so it is solved against the real integrator.
    const tof = solveBallisticLead(
      gun.p, target.p, target.v,
      spec.heGrams > 0 ? AmmoType.HE : AmmoType.AP,
      spec.calibre, spec.mass, spec.muzzle, env, _aimDir,
      spec.flak ? ProjectileKind.Flak : ProjectileKind.Shell);
    if (tof < 0) continue;

    // Slew toward the solution at the turret's finite rate. 'damp' gives a
    // frame-rate independent exponential approach; the rate is scaled so a
    // 90° slew takes roughly (π/2)/trackRate seconds.
    const cosErr = clamp(gun.aim.x * _aimDir.x + gun.aim.y * _aimDir.y + gun.aim.z * _aimDir.z, -1, 1);
    const errAngle = Math.acos(cosErr);
    if (errAngle > 1e-4) {
      const maxStep = spec.trackRate * dt;
      const a = errAngle <= maxStep ? 1 : maxStep / errAngle;
      vset(gun.aim,
        lerp(gun.aim.x, _aimDir.x, a),
        lerp(gun.aim.y, _aimDir.y, a),
        lerp(gun.aim.z, _aimDir.z, a));
      vnorm(gun.aim, gun.aim);
    }

    // The crew's systematic error drifts slowly, so a burst walks rather than
    // jitters — that is what makes AA readable and dodgeable.
    gun.biasA = damp(gun.biasA, gaussian(gun.rng) * spec.aimError, spec.aimDrift, dt);
    gun.biasB = damp(gun.biasB, gaussian(gun.rng) * spec.aimError, spec.aimDrift, dt);

    // --- fire control -------------------------------------------------
    if (gun.reactionLeft > 0) { gun.reactionLeft -= dt; continue; }
    if (gun.pauseLeft > 0) { gun.pauseLeft -= dt; continue; }
    if (gun.ammo === 0) { gun.alive = false; continue; }
    // Do not fire until the barrels are within about a degree of the solution.
    if (errAngle > 0.02) { gun.cooldown = Math.max(gun.cooldown, 0); continue; }

    const interval = 60 / Math.max(1, spec.rpm * spec.barrels);
    gun.cooldown -= dt;
    let guard = 0;
    while (gun.cooldown <= 0 && guard++ < 12) {
      gun.cooldown += interval;
      fireOneRound(gun, tof, ctx);
      gun.burstFired++;
      if (gun.ammo > 0) gun.ammo--;
      if (gun.burstFired >= spec.burst) {
        gun.burstFired = 0;
        gun.pauseLeft = spec.burstPause * (0.75 + 0.5 * gun.rng.next());
        break;
      }
      if (gun.ammo === 0) { gun.alive = false; break; }
    }
  }
}

let _spare = 0, _hasSpare = false;
function gaussian(rng: Rng): number {
  if (_hasSpare) { _hasSpare = false; return _spare; }
  let u = 0, v = 0, s = 0;
  do { u = rng.next() * 2 - 1; v = rng.next() * 2 - 1; s = u * u + v * v; }
  while (s >= 1 || s === 0);
  const m = Math.sqrt(-2 * Math.log(s) / s);
  _spare = v * m; _hasSpare = true;
  return u * m;
}

const _basisA = v3(), _basisB = v3();
const _worldUp = v3(0, 1, 0);
const _altAxis = v3(1, 0, 0);

function fireOneRound(gun: AaGun, tof: number, ctx: AaFireContext): void {
  const spec = gun.spec;
  const env = ctx.env;

  // Apply the crew's persistent bias in the gun's own aiming plane, then the
  // per-round mechanical dispersion.
  const ref = Math.abs(gun.aim.y) > 0.95 ? _altAxis : _worldUp;
  vcross(ref, gun.aim, _basisA); vnorm(_basisA, _basisA);
  vcross(gun.aim, _basisA, _basisB);
  vset(_fireDir,
    gun.aim.x + _basisA.x * gun.biasA + _basisB.x * gun.biasB,
    gun.aim.y + _basisA.y * gun.biasA + _basisB.y * gun.biasB,
    gun.aim.z + _basisA.z * gun.biasA + _basisB.z * gun.biasB);
  vnorm(_fireDir, _fireDir);
  scatterDirection(_fireDir, spec.dispersion, gun.rng, _fireDir);

  const isTracer = spec.tracerFrac >= 1 || gun.rng.next() < spec.tracerFrac;

  // Flak: set the time fuse from the predicted time of flight. The fuse
  // setting error is what makes bursts bracket a formation instead of
  // tracking one aeroplane.
  let fuse = FuseKind.Impact;
  let fuseTime = 0;
  if (spec.flak) {
    fuse = FuseKind.Timed;
    fuseTime = Math.max(0.2, tof * (1 + gaussian(gun.rng) * 0.02) + gaussian(gun.rng) * spec.fuseError);
  } else if (spec.proxRadius > 0) {
    fuse = FuseKind.Proximity;
  }

  const p = createProjectile({
    origin: gun.p,
    direction: _fireDir,
    speed: spec.muzzle,
    ammo: spec.heGrams > 0 ? AmmoType.HE : AmmoType.AP,
    calibre: spec.calibre,
    mass: spec.mass,
    heGrams: spec.heGrams,
    kind: spec.flak ? ProjectileKind.Flak : (spec.calibre >= 20 ? ProjectileKind.Shell : ProjectileKind.Bullet),
    ownerId: 0,
    team: gun.team,
    shooterEntity: 0,
    time: env.time,
    rewind: 0,                       // the world does not need lag compensation
    fuse,
    fuseTime,
    proxRadius: spec.proxRadius,
    armTime: spec.flak ? 0.35 : 0.05,
    lifetime: spec.flak ? 40 : 12,
    tracerTime: isTracer ? (spec.calibre >= 37 ? 4 : 2.4) : 0,
    tracerColor: spec.tracer,
    rng: gun.rng,
    pool: ctx.pool,
  });

  ctx.out.push(p);
  if (ctx.onFire) ctx.onFire(gun, p);
}

// ---------------------------------------------------------------------------
// Battery helpers
// ---------------------------------------------------------------------------

/**
 * Lay out a ring of guns around a point — the standard way a battery defends
 * an airfield or a bridge. Returns the created guns.
 */
export function createBattery(
  firstId: number, team: number, centre: V3, radius: number, count: number,
  spec: AaGunSpec, groundHeight: (x: number, z: number) => number, seed = 1,
): AaGun[] {
  const guns: AaGun[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const x = centre.x + Math.cos(a) * radius;
    const z = centre.z + Math.sin(a) * radius;
    const y = groundHeight(x, z) + 1.4;
    guns.push(createAaGun(firstId + i, team, v3(x, y, z), spec, seed + i));
  }
  return guns;
}

/**
 * Threat level at a world position, 0..1 — how much AA can currently reach it.
 * Used by the HUD to shade a danger overlay and by AI to route around flak.
 */
export function aaThreatAt(guns: AaGun[], p: V3, team: number): number {
  let threat = 0;
  for (let i = 0; i < guns.length; i++) {
    const g = guns[i];
    if (!g.alive || g.team === team) continue;
    vsub(p, g.p, _tmp);
    const d = vlen(_tmp);
    if (d > g.spec.maxRange) continue;
    // Danger peaks well inside maximum range, where time of flight is short.
    const t = 1 - d / g.spec.maxRange;
    threat += t * t * (g.spec.calibre >= 37 ? 0.5 : 0.9);
  }
  return clamp(threat, 0, 1);
}

/** Reset a gun for a new match without reallocating. */
export function resetAaGun(gun: AaGun, ammo = -1): void {
  gun.targetId = 0;
  gun.reactionLeft = gun.spec.reaction;
  gun.cooldown = 0; gun.burstFired = 0; gun.pauseLeft = 0;
  gun.ammo = ammo; gun.alive = true; gun.losT = 0;
  vset(gun.aim, 0, 1, 0);
  gun.biasA = 0; gun.biasB = 0;
}
