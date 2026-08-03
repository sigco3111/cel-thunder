/**
 * Projectile simulation: integration, sub-stepping, swept hit detection and
 * the penetration walk through an aircraft's modules.
 *
 * Every round in the air is a real rigid body with mass, calibre, a velocity
 * dependent drag coefficient and gravity. Nothing is hit-scan. A 20 mm shell
 * fired at a target 600 m away takes 0.8 s to arrive and falls 3 m on the way,
 * which means leading is a skill and the tracer stream tells the truth.
 *
 * Sub-stepping: at 900 m/s and a 60 Hz tick a round advances 15 m per frame.
 * An aileron is 90 mm thick. Point sampling would miss it 99 % of the time, so
 * every substep is resolved as a *swept segment* against the target proxies,
 * and the substep length itself is capped so that fast-rotating targets do not
 * teleport past the segment either.
 */

import {
  type V3, type Q, v3, vset, vsub, vadd, vaddScaled, vlen,
  vnorm, vcross, clamp, qrotInv, q as mkq, Rng,
} from '../math';
import type { GunSpec } from '../aircraft';
import { airDensity, speedOfSound, G0 } from './atmosphere';
import { cdG1, cdBomb, cdRocket, defaultFormFactor, calibreArea } from './drag';
import {
  type CombatEnv, type CombatTarget, type HitResult, type HitSink,
  type Projectile, AmmoType, FuseKind, ModuleId, ProjectileKind,
  newHitResult, isExplosiveAmmo, RHA_EQUIV,
} from './types';
import {
  beginSweepBatch, sweepTarget, resolveTargetTransform, armourForNormal,
  type ShapeHit,
} from './proxy';
import {
  computePenetration, newPenetrationResult, kineticDamage, ignitionChance,
} from './penetration';
import { applyExplosion, shellCasing } from './explosion';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Longest distance a projectile may advance in one integration substep, m. */
const MAX_SUBSTEP_M = 3.0;
/**
 * Substep length used when no aircraft is anywhere near the round's path.
 * Only integration accuracy matters then, not collision resolution, and RK2
 * at 6 m intervals is already sub-centimetre over a bullet's whole flight.
 */
const COARSE_SUBSTEP_M = 6.0;
/**
 * Padding on the once-per-frame broad-phase query, metres. Must cover the
 * largest aircraft bounding radius plus the (tiny) deviation between the
 * straight predictor segment and the true curved path over one tick.
 */
const FRAME_QUERY_PAD = 14;
/** Hard cap on substeps per frame per projectile (protects the tick budget). */
const MAX_SUBSTEPS = 16;
/** Below this speed a round is spent and stops doing damage. */
const MIN_LETHAL_SPEED = 55;
/** Rounds are ignored by their own shooter's proxy for this long after firing. */
const SELF_HIT_GRACE = 0.035;

let _nextProjectileId = 1;

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

function blankProjectile(): Projectile {
  return {
    id: 0, alive: false, kind: ProjectileKind.Bullet, ammo: AmmoType.Ball,
    calibre: 7.7, mass: 0.01, mass0: 0.01, heGrams: 0, formFactor: 0.7,
    area: calibreArea(7.7),
    p: v3(), v: v3(), pPrev: v3(),
    t: 0, maxTime: 6, tracerTime: 0, tracerColor: 0xffffff,
    ownerId: 0, team: 0, shooterEntity: 0, ignoreUntil: 0,
    fireTime: 0, rewind: 0,
    fuse: FuseKind.Inert, fuseDelayM: 0, fuseTime: 0, proxRadius: 0, armTime: 0,
    fuseDelayS: 0, stuck: false,
    thrust: 0, burnTime: 0, propellantMass: 0,
    misalign: v3(), misalignFrac: 0,
    penetrationsLeft: 2, tag: 0,
  };
}

/**
 * Free-list of projectile bodies. In a 32-player match with eight aircraft
 * holding down the trigger there can be 2000 rounds in flight; allocating
 * those every frame is a guaranteed GC hitch.
 */
export class ProjectilePool {
  private free: Projectile[] = [];
  constructor(prealloc = 512) {
    for (let i = 0; i < prealloc; i++) this.free.push(blankProjectile());
  }
  acquire(): Projectile {
    return this.free.pop() ?? blankProjectile();
  }
  release(p: Projectile): void {
    p.alive = false;
    if (this.free.length < 4096) this.free.push(p);
  }
  get size(): number { return this.free.length; }
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export interface ProjectileInit {
  /** Muzzle position, world space. */
  origin: V3;
  /** Unit aim direction, world space. */
  direction: V3;
  /** Muzzle velocity, m/s. */
  speed: number;
  /** Shooter's own velocity, added to the muzzle velocity. */
  inherit?: V3;

  ammo: AmmoType;
  /** Millimetres. */
  calibre: number;
  /** Kilograms. */
  mass: number;
  /** TNT-equivalent filler, grams. */
  heGrams?: number;
  formFactor?: number;

  ownerId: number;
  team: number;
  shooterEntity: number;

  /** Server time the shot was taken. */
  time: number;
  /** Lag-compensation rewind for this shooter, seconds. */
  rewind?: number;

  kind?: ProjectileKind;
  /** Seconds before despawn. Defaults from calibre. */
  lifetime?: number;
  /** Tracer burn time; 0 for a non-tracer round. */
  tracerTime?: number;
  tracerColor?: number;

  fuse?: FuseKind;
  fuseDelayM?: number;
  fuseTime?: number;
  proxRadius?: number;
  armTime?: number;

  /** Delay-action fuse: seconds between hitting the ground and detonating. */
  fuseDelayS?: number;

  thrust?: number;
  burnTime?: number;
  propellantMass?: number;
  /** 1σ of the rocket motor's thrust misalignment, as a fraction of thrust. */
  misalignSigma?: number;

  /** Angular dispersion to apply, radians (1σ of a 2D Gaussian). */
  dispersion?: number;
  rng?: Rng;

  tag?: number;
  pool?: ProjectilePool;
}

const _dir = v3(), _sc0 = v3(), _sc1 = v3(), _sc2 = v3(), _sc3 = v3();
const _up = v3(0, 1, 0);
const _fwdAlt = v3(1, 0, 0);

/** Box–Muller pair, cached. */
let _gaussSpare = 0;
let _hasSpare = false;
function gauss(rng: Rng): number {
  if (_hasSpare) { _hasSpare = false; return _gaussSpare; }
  let u = 0, v = 0, s = 0;
  do {
    u = rng.next() * 2 - 1;
    v = rng.next() * 2 - 1;
    s = u * u + v * v;
  } while (s >= 1 || s === 0);
  const m = Math.sqrt(-2 * Math.log(s) / s);
  _gaussSpare = v * m; _hasSpare = true;
  return u * m;
}

/**
 * Scatter a unit direction by a Gaussian cone of 1σ = 'sigma' radians.
 * Real gun dispersion is a 2D Gaussian in the sight picture, not a uniform
 * disc — most rounds go close to the aim point and a few go wide, which is
 * what produces the characteristic "shotgun core plus flyers" cone.
 */
export function scatterDirection(dir: V3, sigma: number, rng: Rng, out: V3): V3 {
  if (sigma <= 0) return vset(out, dir.x, dir.y, dir.z);
  // Build any orthonormal basis around dir.
  const ref = Math.abs(dir.y) > 0.95 ? _fwdAlt : _up;
  vcross(ref, dir, _sc0); vnorm(_sc0, _sc0);
  vcross(dir, _sc0, _sc1);
  const a = gauss(rng) * sigma;
  const b = gauss(rng) * sigma;
  vset(out,
    dir.x + _sc0.x * a + _sc1.x * b,
    dir.y + _sc0.y * a + _sc1.y * b,
    dir.z + _sc0.z * a + _sc1.z * b);
  return vnorm(out, out);
}

/** Default despawn time: a round is irrelevant long before it stops flying. */
function defaultLifetime(kind: ProjectileKind, calibre: number): number {
  if (kind === ProjectileKind.Bomb) return 90;
  if (kind === ProjectileKind.Rocket) return 20;
  if (kind === ProjectileKind.Flak) return 30;
  return calibre >= 20 ? 6.5 : 4.5;
}

export function createProjectile(init: ProjectileInit): Projectile {
  const p = init.pool ? init.pool.acquire() : blankProjectile();
  const kind = init.kind ?? (init.calibre >= 20 ? ProjectileKind.Shell : ProjectileKind.Bullet);

  p.id = _nextProjectileId++;
  if (_nextProjectileId > 0x7ffffff0) _nextProjectileId = 1;
  p.alive = true;
  p.kind = kind;
  p.ammo = init.ammo;
  p.calibre = init.calibre;
  p.mass = init.mass;
  p.mass0 = init.mass;
  p.heGrams = init.heGrams ?? 0;
  p.formFactor = init.formFactor ?? defaultFormFactor(init.ammo, init.calibre);
  p.area = calibreArea(init.calibre);

  vnorm(init.direction, _dir);
  if (init.dispersion && init.dispersion > 0 && init.rng) {
    scatterDirection(_dir, init.dispersion, init.rng, _dir);
  }

  vset(p.p, init.origin.x, init.origin.y, init.origin.z);
  vset(p.pPrev, init.origin.x, init.origin.y, init.origin.z);
  vset(p.v, _dir.x * init.speed, _dir.y * init.speed, _dir.z * init.speed);
  if (init.inherit) vadd(p.v, init.inherit, p.v);

  p.t = 0;
  p.maxTime = init.lifetime ?? defaultLifetime(kind, init.calibre);
  p.tracerTime = init.tracerTime ?? 0;
  p.tracerColor = init.tracerColor ?? 0xffe0a0;

  p.ownerId = init.ownerId;
  p.team = init.team;
  p.shooterEntity = init.shooterEntity;
  p.ignoreUntil = SELF_HIT_GRACE;

  p.fireTime = init.time;
  p.rewind = init.rewind ?? 0;

  p.fuse = init.fuse ?? (isExplosiveAmmo(init.ammo) ? FuseKind.Impact : FuseKind.Inert);
  // Nose-fused HE functions essentially at the skin; base-fused AP-HE needs to
  // get well inside before the delay element burns through.
  p.fuseDelayM = init.fuseDelayM ?? (init.ammo === AmmoType.APHE ? 0.75 : 0.10);
  p.fuseTime = init.fuseTime ?? 0;
  p.proxRadius = init.proxRadius ?? 0;
  p.armTime = init.armTime ?? 0;

  p.fuseDelayS = init.fuseDelayS ?? 0;
  p.stuck = false;

  p.thrust = init.thrust ?? 0;
  p.burnTime = init.burnTime ?? 0;
  p.propellantMass = init.propellantMass ?? 0;
  p.misalignFrac = 0;
  vset(p.misalign, 0, 0, 0);
  if (init.misalignSigma && init.misalignSigma > 0 && init.rng) {
    // Pick a random direction perpendicular to the launch axis, then a
    // Gaussian magnitude. The result is a rocket that curves consistently,
    // not one that jitters — which is exactly how a bent nozzle behaves.
    const ref = Math.abs(_dir.y) > 0.95 ? _fwdAlt : _up;
    vcross(ref, _dir, _sc0); vnorm(_sc0, _sc0);
    vcross(_dir, _sc0, _sc1);
    const ang = init.rng.next() * Math.PI * 2;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    vset(p.misalign,
      _sc0.x * ca + _sc1.x * sa,
      _sc0.y * ca + _sc1.y * sa,
      _sc0.z * ca + _sc1.z * sa);
    p.misalignFrac = Math.abs(gauss(init.rng)) * init.misalignSigma;
  }

  p.penetrationsLeft = init.calibre >= 20 ? 2 : 1;
  p.tag = init.tag ?? 0;

  return p;
}

// ---------------------------------------------------------------------------
// Belts
// ---------------------------------------------------------------------------

/**
 * Ammunition belt composition for a gun, as a repeating pattern.
 *
 * Real belts alternate: the Luftwaffe's standard fighter belt was HEI / AP /
 * HEI / API, the RAF's Hispano belt ball / AP / HE / HEI. Cycling the belt
 * means a burst does mixed damage — some rounds punch through the armour, some
 * blow holes in the skin, some set fires — which is far more interesting than
 * every round being identical.
 */
export function beltFor(gun: GunSpec): AmmoType[] {
  if (gun.calibre >= 20) {
    return gun.he > 12
      ? [AmmoType.HE, AmmoType.HEI, AmmoType.AP, AmmoType.HE]        // mine-shell heavy
      : [AmmoType.HE, AmmoType.AP, AmmoType.HEI, AmmoType.API];
  }
  if (gun.calibre >= 12) {
    return gun.he > 0
      ? [AmmoType.HEI, AmmoType.AP, AmmoType.API, AmmoType.AP]
      : [AmmoType.API, AmmoType.AP, AmmoType.Ball, AmmoType.AP];
  }
  return [AmmoType.Ball, AmmoType.AP, AmmoType.Ball, AmmoType.API];
}

/**
 * Per-round mass for a belt entry. HE shells are a touch lighter than the
 * solid AP of the same calibre; incendiary loads lighter still.
 */
export function roundMass(gun: GunSpec, ammo: AmmoType): number {
  switch (ammo) {
    case AmmoType.AP: return gun.mass * 1.06;
    case AmmoType.APHE: return gun.mass * 1.04;
    case AmmoType.API: return gun.mass * 0.99;
    case AmmoType.HE: return gun.mass * 0.96;
    case AmmoType.HEI: return gun.mass * 0.94;
    default: return gun.mass;
  }
}

/** Filler mass for a belt entry, grams of TNT equivalent. */
export function roundHe(gun: GunSpec, ammo: AmmoType): number {
  switch (ammo) {
    case AmmoType.HE: return gun.he;
    case AmmoType.HEI: return gun.he * 0.85;
    case AmmoType.APHE: return gun.he * 0.35;
    case AmmoType.API: return gun.he * 0.12;
    default: return 0;
  }
}

/**
 * Muzzle dispersion for an aircraft gun, radians (1σ).
 * Wing guns are mounted in a flexing structure and shoot noticeably wider than
 * a rigidly mounted engine cannon.
 */
export function gunDispersion(gun: GunSpec, wingMounted: boolean): number {
  // ~1.5 mrad is a well-harmonised fixed gun; wing flex roughly doubles it.
  const base = gun.calibre >= 20 ? 0.0016 : 0.0013;
  return wingMounted ? base * 1.9 : base;
}

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

const _acc = v3(), _vmid = v3(), _pmid = v3(), _vrel = v3(), _v0 = v3();

/** Drag coefficient by projectile family. */
function dragCoefficient(p: Projectile, mach: number): number {
  switch (p.kind) {
    case ProjectileKind.Bomb: return cdBomb(mach);
    case ProjectileKind.Rocket: return cdRocket(mach, p.t < p.burnTime);
    default: return cdG1(mach) * p.formFactor;
  }
}

/**
 * Acceleration at a given position/velocity. 'out' receives m/s².
 * Bombs and rockets carry their own reference area (calibre is set to the
 * body diameter when they are created), so this one function covers all three.
 */
function accelAt(p: Projectile, pos: V3, vel: V3, env: CombatEnv, g: number, out: V3): void {
  if (env.wind) vsub(vel, env.wind, _vrel);
  else vset(_vrel, vel.x, vel.y, vel.z);

  const speed = vlen(_vrel);
  vset(out, 0, -g, 0);

  if (speed > 0.5) {
    const alt = pos.y;
    const rho = airDensity(alt);
    const mach = speed / speedOfSound(alt);
    const cd = dragCoefficient(p, mach);
    // a = ½ ρ v² Cd A / m, directed against the relative wind.
    const k = 0.5 * rho * speed * cd * p.area / Math.max(p.mass, 1e-6);
    out.x -= _vrel.x * k;
    out.y -= _vrel.y * k;
    out.z -= _vrel.z * k;
  }

  if (p.thrust > 0 && p.t < p.burnTime && speed > 1) {
    // Fin-stabilised rocket: thrust acts along the velocity vector (the body
    // weathercocks into the airflow within a few metres of the rail).
    const inv = 1 / speed;
    const a = p.thrust / Math.max(p.mass, 1e-6);
    out.x += _vrel.x * inv * a;
    out.y += _vrel.y * inv * a;
    out.z += _vrel.z * inv * a;
    if (p.misalignFrac > 0) {
      const am = a * p.misalignFrac;
      out.x += p.misalign.x * am;
      out.y += p.misalign.y * am;
      out.z += p.misalign.z * am;
    }
  }
}

/** One RK2 (midpoint) integration substep. */
function integrate(p: Projectile, env: CombatEnv, h: number, g: number): void {
  if (p.propellantMass > 0 && p.burnTime > 0) {
    const burned = clamp(p.t / p.burnTime, 0, 1) * p.propellantMass;
    p.mass = Math.max(p.mass0 - burned, p.mass0 - p.propellantMass);
  }

  vset(_v0, p.v.x, p.v.y, p.v.z);
  accelAt(p, p.p, p.v, env, g, _acc);
  vaddScaled(p.v, _acc, h * 0.5, _vmid);
  vaddScaled(p.p, p.v, h * 0.5, _pmid);
  accelAt(p, _pmid, _vmid, env, g, _acc);

  vaddScaled(p.v, _acc, h, p.v);
  // Trapezoidal position update using the average of old and new velocity —
  // second-order accurate, and critically it keeps the *drop* right, which is
  // the number the player judges the gunnery model by.
  p.p.x += (_v0.x + p.v.x) * 0.5 * h;
  p.p.y += (_v0.y + p.v.y) * 0.5 * h;
  p.p.z += (_v0.z + p.v.z) * 0.5 * h;
}

// ---------------------------------------------------------------------------
// Hit resolution
// ---------------------------------------------------------------------------

const _hits: ShapeHit[] = [];
const _tgts: CombatTarget[] = [];
const _hit: HitResult = newHitResult();
const _tp = v3(), _tq = mkq();
const _impact = v3(), _nBody = v3(), _travel = v3();
// Reusable penetration results: resolveSegment runs two tests per module hit
// and there can be thousands of impacts a second in a big furball.
const _penEntry = newPenetrationResult();
const _penInner = newPenetrationResult();

function emitHit(onHit: HitSink): void { onHit(_hit); }

function fillCommon(p: Projectile, env: CombatEnv): void {
  _hit.time = env.time;
  _hit.projectileId = p.id;
  _hit.kind = p.kind;
  _hit.ammo = p.ammo;
  _hit.calibre = p.calibre;
  _hit.heGrams = p.heGrams;
  _hit.ownerId = p.ownerId;
  _hit.team = p.team;
  _hit.shooterEntity = p.shooterEntity;
}

/** Terrain crossing distance along p0->p1, or -1. Bisection refined. */
function terrainCrossing(env: CombatEnv, p0: V3, dir: V3, len: number): number {
  const SAMPLES = 4;
  let prevT = 0;
  let prevD = p0.y - env.terrainHeight(p0.x, p0.z);
  if (prevD < 0) return 0;
  for (let i = 1; i <= SAMPLES; i++) {
    const t = (len * i) / SAMPLES;
    const x = p0.x + dir.x * t, y = p0.y + dir.y * t, z = p0.z + dir.z * t;
    const d = y - env.terrainHeight(x, z);
    if (d < 0) {
      // Refine with a few bisections; terrain is locally smooth so this
      // converges to well under a centimetre in 6 iterations.
      let lo = prevT, hi = t;
      for (let k = 0; k < 6; k++) {
        const mid = (lo + hi) * 0.5;
        const mx = p0.x + dir.x * mid, my = p0.y + dir.y * mid, mz = p0.z + dir.z * mid;
        if (my - env.terrainHeight(mx, mz) < 0) hi = mid; else lo = mid;
      }
      return (lo + hi) * 0.5;
    }
    prevT = t; prevD = d;
  }
  return -1;
}

/** Detonate an explosive projectile at its current position. */
function detonate(
  p: Projectile, env: CombatEnv, onHit: HitSink,
  insideTarget: number, insideModule: ModuleId | -1,
): void {
  fillCommon(p, env);
  _hit.type = 'detonate';
  _hit.targetId = insideTarget;
  _hit.module = insideModule;
  _hit.px = p.p.x; _hit.py = p.p.y; _hit.pz = p.p.z;
  const sp = vlen(p.v);
  if (sp > 1e-4) {
    _hit.dx = p.v.x / sp; _hit.dy = p.v.y / sp; _hit.dz = p.v.z / sp;
  }
  _hit.nx = -_hit.dx; _hit.ny = -_hit.dy; _hit.nz = -_hit.dz;
  _hit.speed = sp;
  _hit.energy = p.heGrams * 4184;
  _hit.damage = 0;      // the blast pass below produces the module damage
  _hit.ignite = 0;
  _hit.penetrationMm = 0;
  _hit.effectiveArmourMm = 0;
  _hit.angleDeg = 0;
  emitHit(onHit);

  const casing = shellCasing(p.calibre, p.heGrams, p.mass0);
  applyExplosion(env, {
    x: p.p.x, y: p.p.y, z: p.p.z,
    heGrams: p.heGrams,
    casingKg: casing.casingKg,
    fragMass: casing.fragMass,
    fragVelocity: casing.fragVelocity,
    ownerId: p.ownerId, team: p.team, shooterEntity: p.shooterEntity,
    ammo: p.ammo, kind: p.kind, projectileId: p.id, time: env.time,
    insideTarget: insideTarget || undefined,
    insideModule,
  }, onHit);

  p.alive = false;
}

/**
 * Resolve one swept segment. Returns false when the projectile is spent.
 *
 * This is the heart of the whole subsystem: the ordered walk through every
 * module the round's path intersects, spending energy at each armour plate and
 * each piece of structure until it either runs out or comes out the far side.
 */
function resolveSegment(
  p: Projectile, env: CombatEnv, onHit: HitSink, testTargets: boolean,
): boolean {
  vsub(p.p, p.pPrev, _travel);
  const len = vlen(_travel);
  if (len < 1e-6) return true;
  vset(_travel, _travel.x / len, _travel.y / len, _travel.z / len);

  const tTerrain = terrainCrossing(env, p.pPrev, _travel, len);

  // --- targets --------------------------------------------------------
  _tgts.length = 0;
  if (testTargets) env.queryTargets(p.pPrev, p.p, 2, _tgts);

  beginSweepBatch();
  _hits.length = 0;

  // Build a parallel array of the target each hit belongs to. The sweep
  // helper appends in order per target, so record the boundaries.
  const hitTarget: CombatTarget[] = _hitTargetScratch;
  hitTarget.length = 0;

  const atTime = p.fireTime + p.t;
  let touchedTargets = 0;

  for (let i = 0; i < _tgts.length; i++) {
    const tgt = _tgts[i];
    if (!tgt.alive) continue;
    if (tgt.id === p.shooterEntity && p.t < p.ignoreUntil) continue;
    const before = _hits.length;
    const n = sweepTarget(tgt, atTime, p.rewind, p.pPrev, p.p, _hits);
    if (n > 0) {
      touchedTargets++;
      for (let k = before; k < _hits.length; k++) hitTarget.push(tgt);
    }
  }

  // Merge-sort the combined list by entry distance so multi-aircraft
  // overlaps (a round passing through a wingman) resolve in physical order.
  if (_hits.length > 1) {
    const order = _orderScratch;
    order.length = _hits.length;
    for (let i = 0; i < _hits.length; i++) order[i] = i;
    order.sort((a, b) => _hits[a].tEnter - _hits[b].tEnter);
    _sortedHits.length = 0; _sortedTargets.length = 0;
    for (let i = 0; i < order.length; i++) {
      _sortedHits.push(_hits[order[i]]);
      _sortedTargets.push(hitTarget[order[i]]);
    }
  } else {
    _sortedHits.length = 0; _sortedTargets.length = 0;
    for (let i = 0; i < _hits.length; i++) { _sortedHits.push(_hits[i]); _sortedTargets.push(hitTarget[i]); }
  }

  // --- proximity fuse -------------------------------------------------
  if (p.fuse === FuseKind.Proximity && p.t >= p.armTime && _sortedHits.length === 0) {
    for (let i = 0; i < _tgts.length; i++) {
      const tgt = _tgts[i];
      if (!tgt.alive || tgt.team === p.team) continue;
      resolveTargetTransform(tgt, atTime, p.rewind, _tp, _tq);
      // Closest approach of the segment to the target centre.
      const ax = _tp.x - p.pPrev.x, ay = _tp.y - p.pPrev.y, az = _tp.z - p.pPrev.z;
      const s = clamp(ax * _travel.x + ay * _travel.y + az * _travel.z, 0, len);
      const cx = ax - _travel.x * s, cy = ay - _travel.y * s, cz = az - _travel.z * s;
      const d = Math.sqrt(cx * cx + cy * cy + cz * cz);
      if (d <= p.proxRadius + tgt.proxy.boundRadius * 0.5) {
        vset(p.p, p.pPrev.x + _travel.x * s, p.pPrev.y + _travel.y * s, p.pPrev.z + _travel.z * s);
        detonate(p, env, onHit, 0, -1);
        return false;
      }
    }
  }

  // --- ordered penetration walk ---------------------------------------
  let lastTargetId = 0;
  for (let i = 0; i < _sortedHits.length; i++) {
    const sh = _sortedHits[i];
    const tgt = _sortedTargets[i];
    if (tTerrain >= 0 && sh.tEnter > tTerrain) break;

    let speed = vlen(p.v);
    if (speed < MIN_LETHAL_SPEED) { p.alive = false; return false; }

    if (tgt.id !== lastTargetId) {
      if (lastTargetId !== 0) {
        p.penetrationsLeft--;
        if (p.penetrationsLeft <= 0) { p.alive = false; return false; }
      }
      lastTargetId = tgt.id;
    }

    // Impact point and geometry.
    vset(_impact,
      p.pPrev.x + _travel.x * sh.tEnter,
      p.pPrev.y + _travel.y * sh.tEnter,
      p.pPrev.z + _travel.z * sh.tEnter);
    let cosT = -(sh.nx * _travel.x + sh.ny * _travel.y + sh.nz * _travel.z);
    if (cosT < 0) cosT = -cosT;      // grazing / interior faces
    cosT = clamp(cosT, 0.05, 1);

    // Which armour face did we meet? Needs the normal back in body space.
    resolveTargetTransform(tgt, atTime, p.rewind, _tp, _tq);
    vset(_nBody, sh.nx, sh.ny, sh.nz);
    qrotInv(_tq, _nBody, _nBody);
    const shape = sh.shape;
    const plateMm = armourForNormal(shape, _nBody);
    const plateRha = plateMm * RHA_EQUIV[shape.armourMaterial] + shape.skinMm;

    fillCommon(p, env);
    _hit.targetId = tgt.id;
    _hit.module = shape.module;
    _hit.px = _impact.x; _hit.py = _impact.y; _hit.pz = _impact.z;
    _hit.nx = sh.nx; _hit.ny = sh.ny; _hit.nz = sh.nz;
    _hit.dx = _travel.x; _hit.dy = _travel.y; _hit.dz = _travel.z;
    _hit.speed = speed;

    // ---- explosive rounds: the fuse acts here -----------------------
    if (isExplosiveAmmo(p.ammo) && p.fuse === FuseKind.Impact && p.heGrams > 0) {
      if (p.ammo === AmmoType.APHE) {
        // Base-fused: must defeat the plate first, then burn its delay.
        const res = computePenetration({
          ammo: p.ammo, calibre: p.calibre, mass: p.mass, velocity: speed,
          armourMm: plateRha, armourMaterial: 'rha', cosTheta: cosT,
          roll: env.rng.next(),
        }, _penEntry);
        if (res.outcome === 'ricochet') {
          reportRicochet(p, res.energyDeposited, res.penetrationMm, res.effectiveMm, res.angleDeg, onHit);
          deflect(p, sh, res.residualVelocity, env);
          return p.alive;
        }
        if (res.outcome === 'stop') {
          // Shattered on the plate: the filler still functions, outside.
          vset(p.p, _impact.x, _impact.y, _impact.z);
          detonate(p, env, onHit, tgt.id, shape.module);
          return false;
        }
        const travel = Math.min(p.fuseDelayM, Math.max(0.05, sh.tExit - sh.tEnter + 0.4));
        vset(p.p,
          _impact.x + _travel.x * travel,
          _impact.y + _travel.y * travel,
          _impact.z + _travel.z * travel);
        detonate(p, env, onHit, tgt.id, shape.module);
        return false;
      }
      // Nose-fused HE/HEI: functions on the skin, a few centimetres in.
      const travel = Math.min(p.fuseDelayM, Math.max(0.02, sh.tExit - sh.tEnter));
      vset(p.p,
        _impact.x + _travel.x * travel,
        _impact.y + _travel.y * travel,
        _impact.z + _travel.z * travel);
      // Direct kinetic contribution of the shell body striking the skin.
      _hit.type = 'penetrate';
      _hit.energy = 0.5 * p.mass * speed * speed * 0.25;
      _hit.damage = kineticDamage(_hit.energy, p.calibre) * 0.5;
      _hit.penetrationMm = 0;
      _hit.effectiveArmourMm = plateRha;
      _hit.angleDeg = Math.acos(cosT) * 180 / Math.PI;
      _hit.ignite = 0;
      emitHit(onHit);
      detonate(p, env, onHit, tgt.id, shape.module);
      return false;
    }

    // ---- kinetic rounds --------------------------------------------
    const entry = computePenetration({
      ammo: p.ammo, calibre: p.calibre, mass: p.mass, velocity: speed,
      armourMm: plateRha, armourMaterial: 'rha', cosTheta: cosT,
      roll: env.rng.next(),
    }, _penEntry);

    if (entry.outcome === 'ricochet') {
      reportRicochet(p, entry.energyDeposited, entry.penetrationMm, entry.effectiveMm, entry.angleDeg, onHit);
      deflect(p, sh, entry.residualVelocity, env);
      return p.alive;
    }

    let energyDep = entry.energyDeposited;
    let outSpeed = entry.residualVelocity;
    let outMass = entry.residualMass;
    let stopped = entry.outcome !== 'penetrate';

    // Interior structure of the module. An engine block is 40 mm of RHA
    // equivalent — this is why cannon shells die in the nose and why a P-47
    // could come home with a bent crankcase instead of a dead pilot.
    if (!stopped && shape.internalMm > 0.05 && outSpeed > MIN_LETHAL_SPEED) {
      const inner = computePenetration({
        ammo: p.ammo, calibre: p.calibre, mass: outMass, velocity: outSpeed,
        armourMm: shape.internalMm, armourMaterial: 'rha', cosTheta: 1,
        roll: 1,  // no ricochet once you are inside the structure
      }, _penInner);
      energyDep += inner.energyDeposited;
      if (inner.outcome === 'penetrate') {
        outSpeed = inner.residualVelocity;
        outMass = inner.residualMass;
      } else {
        stopped = true;
        outSpeed = 0; outMass = 0;
      }
    }

    _hit.type = stopped ? 'stop' : 'penetrate';
    _hit.energy = energyDep;
    _hit.damage = kineticDamage(energyDep, p.calibre);
    _hit.penetrationMm = entry.penetrationMm;
    _hit.effectiveArmourMm = entry.effectiveMm;
    _hit.angleDeg = entry.angleDeg;
    _hit.ignite = ignitionChance(p.ammo, energyDep, p.heGrams);
    emitHit(onHit);

    if (stopped || outSpeed < MIN_LETHAL_SPEED) {
      p.alive = false;
      vset(p.p, _impact.x, _impact.y, _impact.z);
      return false;
    }

    p.mass = outMass;
    vset(p.v, _travel.x * outSpeed, _travel.y * outSpeed, _travel.z * outSpeed);
  }

  // --- terrain --------------------------------------------------------
  if (tTerrain >= 0) {
    vset(p.p,
      p.pPrev.x + _travel.x * tTerrain,
      p.pPrev.y + _travel.y * tTerrain,
      p.pPrev.z + _travel.z * tTerrain);
    const ground = env.terrainHeight(p.p.x, p.p.z);
    const water = ground <= 0.01 && p.p.y <= 0.5;

    fillCommon(p, env);
    _hit.type = water ? 'water' : 'terrain';
    _hit.targetId = 0;
    _hit.module = -1;
    _hit.px = p.p.x; _hit.py = p.p.y; _hit.pz = p.p.z;
    _hit.nx = 0; _hit.ny = 1; _hit.nz = 0;
    _hit.dx = _travel.x; _hit.dy = _travel.y; _hit.dz = _travel.z;
    const sp = vlen(p.v);
    _hit.speed = sp;
    _hit.energy = 0.5 * p.mass * sp * sp;
    _hit.damage = 0;
    _hit.ignite = 0;
    _hit.penetrationMm = 0; _hit.effectiveArmourMm = 0; _hit.angleDeg = 0;
    emitHit(onHit);

    if (p.heGrams > 0 && p.fuse !== FuseKind.Inert && p.t >= p.armTime) {
      if (p.fuseDelayS > 0) {
        // Delay-action fuse: the bomb skips/buries itself and lies there for a
        // second or two. This is what lets a low-level attacker bomb from 50 m
        // without being caught in his own blast.
        p.stuck = true;
        vset(p.v, 0, 0, 0);
        p.p.y = ground + 0.15;
        p.fuse = FuseKind.Timed;
        p.fuseTime = p.t + p.fuseDelayS;
        p.maxTime = Math.max(p.maxTime, p.fuseTime + 0.5);
        return false;   // no further motion this frame
      }
      detonate(p, env, onHit, 0, -1);
    } else {
      p.alive = false;
    }
    return false;
  }

  return true;
}

const _hitTargetScratch: CombatTarget[] = [];
const _frameTgts: CombatTarget[] = [];
const _frameEnd = v3();
const _orderScratch: number[] = [];
const _sortedHits: ShapeHit[] = [];
const _sortedTargets: CombatTarget[] = [];

function reportRicochet(
  p: Projectile, energy: number, pen: number, eff: number, angle: number, onHit: HitSink,
): void {
  _hit.type = 'ricochet';
  _hit.energy = energy;
  // A skipping round still gouges the skin and can wreck a control surface.
  _hit.damage = kineticDamage(energy, p.calibre) * 0.35;
  _hit.penetrationMm = pen;
  _hit.effectiveArmourMm = eff;
  _hit.angleDeg = angle;
  _hit.ignite = 0;
  onHit(_hit);
}

const _refl = v3();

/** Reflect a round off a plate, with scatter — ricochets tumble. */
function deflect(p: Projectile, sh: ShapeHit, newSpeed: number, env: CombatEnv): void {
  if (newSpeed < MIN_LETHAL_SPEED) { p.alive = false; return; }
  const sp = vlen(p.v);
  if (sp < 1e-6) { p.alive = false; return; }
  const dx = p.v.x / sp, dy = p.v.y / sp, dz = p.v.z / sp;
  const d = dx * sh.nx + dy * sh.ny + dz * sh.nz;
  vset(_refl, dx - 2 * d * sh.nx, dy - 2 * d * sh.ny, dz - 2 * d * sh.nz);
  vnorm(_refl, _refl);
  // Deflected rounds are tumbling and unstable: 4° of scatter, and they lose
  // their remaining penetration budget.
  scatterDirection(_refl, 0.07, env.rng, _refl);
  vset(p.v, _refl.x * newSpeed, _refl.y * newSpeed, _refl.z * newSpeed);
  vset(p.p, _hit.px + _refl.x * 0.05, _hit.py + _refl.y * 0.05, _hit.pz + _refl.z * 0.05);
  p.ammo = AmmoType.Ball;      // deformed slug from here on
  p.heGrams = 0;
  p.penetrationsLeft = Math.min(p.penetrationsLeft, 1);
}

// ---------------------------------------------------------------------------
// Public step
// ---------------------------------------------------------------------------

/**
 * Advance every projectile in 'list' by 'dt', resolving hits and detonations.
 * Dead rounds are removed from 'list' (swap-remove) and, if a pool is given,
 * recycled.
 *
 * 'onHit' is called synchronously, possibly several times per round (a shell
 * that detonates produces one 'detonate' plus one 'blast'/'fragment' per
 * module affected). The HitResult passed in is *reused* — copy anything you
 * need to keep.
 */
export function stepProjectiles(
  list: Projectile[], env: CombatEnv, dt: number, onHit: HitSink, pool?: ProjectilePool,
): void {
  const g = env.gravity ?? G0;

  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p.alive) { removeAt(list, i, pool); i--; continue; }

    // A round resting on the ground with a delay fuse: just count down.
    if (p.stuck) {
      p.t += dt;
      if (p.t >= p.fuseTime) detonate(p, env, onHit, 0, -1);
      else if (p.t >= p.maxTime) p.alive = false;
      if (!p.alive) { removeAt(list, i, pool); i--; }
      continue;
    }

    const speed = vlen(p.v);

    // One cheap broad-phase query for the whole frame decides whether this
    // round needs the fine, collision-grade substepping at all. The vast
    // majority of rounds in a match are flying through empty sky, and they
    // should not pay for hit detection they cannot possibly need.
    vset(_frameEnd, p.p.x + p.v.x * dt, p.p.y + p.v.y * dt, p.p.z + p.v.z * dt);
    _frameTgts.length = 0;
    env.queryTargets(p.p, _frameEnd, FRAME_QUERY_PAD, _frameTgts);
    const near = _frameTgts.length > 0;

    // One substep per MAX_SUBSTEP_M of travel keeps both the integration error
    // and the swept-segment length bounded.
    const step = near ? MAX_SUBSTEP_M : COARSE_SUBSTEP_M;
    const want = Math.ceil((speed * dt) / step);
    const n = clamp(want < 1 ? 1 : want, 1, MAX_SUBSTEPS);
    const h = dt / n;

    for (let s = 0; s < n; s++) {
      vset(p.pPrev, p.p.x, p.p.y, p.p.z);
      integrate(p, env, h, g);
      p.t += h;

      // Timed fuse (flak): function mid-air.
      if (p.fuse === FuseKind.Timed && p.t >= p.fuseTime && p.heGrams > 0) {
        detonate(p, env, onHit, 0, -1);
        break;
      }

      if (!resolveSegment(p, env, onHit, near)) break;

      if (p.t >= p.maxTime) {
        fillCommon(p, env);
        _hit.type = 'expire';
        _hit.targetId = 0; _hit.module = -1;
        _hit.px = p.p.x; _hit.py = p.p.y; _hit.pz = p.p.z;
        _hit.damage = 0; _hit.energy = 0; _hit.ignite = 0;
        _hit.penetrationMm = 0; _hit.effectiveArmourMm = 0; _hit.angleDeg = 0;
        _hit.speed = vlen(p.v);
        onHit(_hit);
        p.alive = false;
        break;
      }
    }

    if (!p.alive) { removeAt(list, i, pool); i--; }
  }
}

function removeAt(list: Projectile[], i: number, pool?: ProjectilePool): void {
  const p = list[i];
  const last = list.length - 1;
  if (i !== last) list[i] = list[last];
  list.pop();
  if (pool) pool.release(p);
}

// ---------------------------------------------------------------------------
// Firing-solution helpers
// ---------------------------------------------------------------------------

/**
 * Advance a projectile through pure free flight — drag, gravity and rocket
 * thrust — with no collision detection at all. This is what the bombsight and
 * the lead computer use to predict, so prediction and reality share one
 * integrator by construction.
 */
export function advanceBallistic(p: Projectile, env: CombatEnv, dt: number): void {
  const g = env.gravity ?? G0;
  vset(p.pPrev, p.p.x, p.p.y, p.p.z);
  integrate(p, env, dt, g);
  p.t += dt;
}

/**
 * Time of flight and drop for a round fired horizontally, computed by running
 * the actual integrator. Used by the gunsight lead computer and by the
 * self-test — deliberately the same code path as live fire, so the sight can
 * never disagree with the bullets.
 */
export function ballisticSolution(
  ammo: AmmoType, calibre: number, mass: number, muzzle: number,
  rangeM: number, altitude = 0, formFactor?: number,
): { tof: number; drop: number; impactSpeed: number } {
  const p = blankProjectile();
  p.alive = true;
  p.kind = calibre >= 20 ? ProjectileKind.Shell : ProjectileKind.Bullet;
  p.ammo = ammo;
  p.calibre = calibre;
  p.mass = mass; p.mass0 = mass;
  p.area = calibreArea(calibre);
  p.formFactor = formFactor ?? defaultFormFactor(ammo, calibre);
  vset(p.p, 0, altitude, 0);
  vset(p.v, 0, 0, muzzle);

  const env: CombatEnv = {
    time: 0,
    queryTargets: () => {},
    terrainHeight: () => -1e9,
    rng: new Rng(1),
  };

  const h = 1 / 2000;   // fine fixed step: this is an offline query
  let t = 0;
  let prevZ = 0, prevY = altitude, prevT = 0, prevSpeed = muzzle;
  for (let i = 0; i < 200000; i++) {
    prevZ = p.p.z; prevY = p.p.y; prevT = t; prevSpeed = vlen(p.v);
    integrate(p, env, h, G0);
    p.t += h;
    t += h;
    if (p.p.z >= rangeM) {
      const a = (rangeM - prevZ) / Math.max(1e-9, p.p.z - prevZ);
      const y = prevY + (p.p.y - prevY) * a;
      const speed = prevSpeed + (vlen(p.v) - prevSpeed) * a;
      return { tof: prevT + (t - prevT) * a, drop: altitude - y, impactSpeed: speed };
    }
    if (t > 20) break;
  }
  return { tof: t, drop: altitude - p.p.y, impactSpeed: vlen(p.v) };
}

/**
 * Iterative lead solution: where to aim to hit a target moving at constant
 * velocity, accounting for time of flight and gravity drop.
 * Returns the aim direction in 'out'.
 */
export function solveLead(
  gunPos: V3, targetPos: V3, targetVel: V3, muzzle: number,
  gravity: number, out: V3, iterations = 4,
): number {
  vsub(targetPos, gunPos, _sc2);
  let tof = vlen(_sc2) / Math.max(muzzle, 1);
  for (let i = 0; i < iterations; i++) {
    // Predicted intercept point, plus the drop the round will accumulate.
    vset(_sc3,
      targetPos.x + targetVel.x * tof - gunPos.x,
      targetPos.y + targetVel.y * tof - gunPos.y + 0.5 * gravity * tof * tof,
      targetPos.z + targetVel.z * tof - gunPos.z);
    const d = vlen(_sc3);
    tof = d / Math.max(muzzle, 1);
  }
  vset(out,
    targetPos.x + targetVel.x * tof - gunPos.x,
    targetPos.y + targetVel.y * tof - gunPos.y + 0.5 * gravity * tof * tof,
    targetPos.z + targetVel.z * tof - gunPos.z);
  vnorm(out, out);
  return tof;
}

// ---------------------------------------------------------------------------
// Drag-aware firing solution
// ---------------------------------------------------------------------------

const _solveShell = blankProjectile();
const _horiz = v3(), _aimPt = v3(), _predict = v3();

/**
 * Simulate a shell launched in 'dir' and report the height it has at
 * horizontal range 'R' from the launch point, plus the time it took.
 * Returns NaN height if the shell never gets that far.
 */
function shellHeightAtRange(
  p: Projectile, gunPos: V3, dirX: number, dirY: number, dirZ: number,
  speed: number, R: number, env: CombatEnv, maxTof: number,
  out: { y: number; t: number },
): void {
  vset(p.p, gunPos.x, gunPos.y, gunPos.z);
  vset(p.pPrev, gunPos.x, gunPos.y, gunPos.z);
  vset(p.v, dirX * speed, dirY * speed, dirZ * speed);
  p.t = 0;
  p.mass = p.mass0;

  const dt = clamp(maxTof / 400, 0.008, 0.06);
  let prevR = 0, prevY = gunPos.y, prevT = 0;
  for (let i = 0; i < 4000; i++) {
    prevR = Math.hypot(p.p.x - gunPos.x, p.p.z - gunPos.z);
    prevY = p.p.y; prevT = p.t;
    advanceBallistic(p, env, dt);
    const r = Math.hypot(p.p.x - gunPos.x, p.p.z - gunPos.z);
    if (r >= R) {
      const a = r > prevR ? (R - prevR) / (r - prevR) : 0;
      out.y = prevY + (p.p.y - prevY) * a;
      out.t = prevT + (p.t - prevT) * a;
      return;
    }
    if (p.t > maxTof || p.p.y < gunPos.y - 12000) break;
    // The shell has gone over the top and is falling short.
    if (r < prevR) break;
  }
  out.y = NaN;
  out.t = p.t;
}

const _shOut = { y: 0, t: 0 };

/**
 * Full drag-aware lead solution.
 *
 * The naive 'solveLead' assumes the round holds its muzzle velocity, which is
 * fine inside 800 m and catastrophically wrong for heavy flak: an 88 mm shell
 * takes about 18 seconds to reach 8 km, not the 10 the naive maths predicts,
 * and it drops well over a kilometre on the way. Getting that wrong makes flak
 * burst a mile short of the bomber stream.
 *
 * So this solves properly: iterate the intercept point against a simulated
 * time of flight, then find the launch elevation by a secant search on the
 * real integrator. Six or so short simulations per shot — trivial next to how
 * rarely a heavy gun fires, and it shares the integrator with the shells
 * themselves so the prediction cannot drift from reality.
 *
 * Writes the unit aim direction into 'out'; returns the time of flight, or -1
 * if the target is simply out of reach.
 */
export function solveBallisticLead(
  gunPos: V3, targetPos: V3, targetVel: V3,
  ammo: AmmoType, calibre: number, mass: number, muzzle: number,
  env: CombatEnv, out: V3, kind: ProjectileKind = ProjectileKind.Shell,
): number {
  const p = _solveShell;
  p.kind = kind === ProjectileKind.Flak ? ProjectileKind.Shell : kind;
  p.ammo = ammo;
  p.calibre = calibre;
  p.mass = p.mass0 = mass;
  p.area = calibreArea(calibre);
  p.formFactor = defaultFormFactor(ammo, calibre);
  p.thrust = 0; p.burnTime = 0; p.propellantMass = 0; p.misalignFrac = 0;

  const maxTof = 40;
  // Start from the straight-line flight time and refine the intercept point.
  vsub(targetPos, gunPos, _predict);
  let tof = vlen(_predict) / Math.max(muzzle, 1);
  let elev = 0;
  let ok = false;

  for (let pass = 0; pass < 3; pass++) {
    vset(_aimPt,
      targetPos.x + targetVel.x * tof,
      targetPos.y + targetVel.y * tof,
      targetPos.z + targetVel.z * tof);
    const hx = _aimPt.x - gunPos.x, hz = _aimPt.z - gunPos.z;
    const R = Math.hypot(hx, hz);
    const dh = _aimPt.y - gunPos.y;
    if (R < 1e-3) {
      // Directly overhead: fire straight up.
      vset(out, 0, dh >= 0 ? 1 : -1, 0);
      return Math.abs(dh) / Math.max(muzzle, 1);
    }
    vset(_horiz, hx / R, 0, hz / R);

    // Secant search on launch elevation. Seed with the line-of-sight angle and
    // a small positive bump, which brackets every realistic AA engagement.
    let a = Math.atan2(dh, R);
    let b = a + 0.03 + clamp(R / 24000, 0, 0.55);
    shellHeightAtRange(p, gunPos, _horiz.x * Math.cos(a), Math.sin(a), _horiz.z * Math.cos(a),
      muzzle, R, env, maxTof, _shOut);
    let fa = isNaN(_shOut.y) ? -1e6 : _shOut.y - _aimPt.y;
    let tb = _shOut.t;
    for (let i = 0; i < 7; i++) {
      shellHeightAtRange(p, gunPos, _horiz.x * Math.cos(b), Math.sin(b), _horiz.z * Math.cos(b),
        muzzle, R, env, maxTof, _shOut);
      const fb = isNaN(_shOut.y) ? -1e6 : _shOut.y - _aimPt.y;
      tb = _shOut.t;
      if (Math.abs(fb) < 1.5) { a = b; fa = fb; ok = true; break; }
      const denom = fb - fa;
      let next = Math.abs(denom) > 1e-6 ? b - fb * (b - a) / denom : b + 0.05;
      next = clamp(next, -0.6, 1.45);
      a = b; fa = fb; b = next;
      ok = true;
    }
    elev = b;
    if (!isFinite(elev)) return -1;
    tof = tb > 0.05 ? tb : tof;
  }

  if (!ok) return -1;
  const ce = Math.cos(elev);
  vset(out, _horiz.x * ce, Math.sin(elev), _horiz.z * ce);
  vnorm(out, out);
  return tof;
}

export { MIN_LETHAL_SPEED, MAX_SUBSTEP_M };
