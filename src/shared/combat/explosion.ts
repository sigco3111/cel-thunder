/**
 * Detonations: blast overpressure and casing fragments.
 *
 * Two distinct mechanisms, and conflating them is what makes explosions in
 * games feel wrong. Blast is a short-range pressure effect that scales with
 * the cube root of charge mass — a 20 mm shell's blast radius is under a
 * metre, a 250 kg bomb's is over twenty. Fragments are the long-range killer:
 * a flak shell bursting 15 m away does nothing at all with blast but sprays a
 * few hundred steel splinters through the airframe at 1000+ m/s.
 *
 * So both are modelled, and both are line-of-sight tested against terrain so
 * a hillside actually shields you from a bomb on the other side of it.
 */

import {
  type V3, v3, vset, vsub, vlen, qrotInv, qrot, clamp, q as mkq,
} from '../math';
import {
  type CombatEnv, type CombatTarget, type HitResult, type HitSink,
  type ProxyShape, AmmoType, ModuleId, ProjectileKind, newHitResult,
} from './types';
import { shapeDistance, shapeClosestPoint, resolveTargetTransform } from './proxy';
import {
  blastDamage, blastRadius, peakBlastDamage, penetrationCapability, kineticDamage, ignitionChance,
} from './penetration';

export interface ExplosionParams {
  x: number; y: number; z: number;
  /** TNT-equivalent filler, grams. */
  heGrams: number;
  /** Casing mass converted to fragments, kg. 0 disables the fragment model. */
  casingKg: number;
  /** Initial fragment velocity, m/s. Gurney velocities are 1000–2000 m/s. */
  fragVelocity: number;
  /** Mean fragment mass, kg. Small shells throw ~0.5 g splinters. */
  fragMass: number;

  ownerId: number;
  team: number;
  shooterEntity: number;
  ammo: AmmoType;
  kind: ProjectileKind;
  projectileId: number;
  time: number;

  /** If the charge went off inside a target, that target's id. */
  insideTarget?: number;
  /** ...and the module it was sitting in when it functioned. */
  insideModule?: ModuleId | -1;
  /** Skip this entity entirely (e.g. the launcher for a proximity dud). */
  ignoreEntity?: number;
  /** True for friendly-fire-disabled servers. */
  noFriendlyFire?: boolean;

  /** Maximum number of targets to affect; keeps a 40-bomb salvo bounded. */
  maxTargets?: number;
}

const _targets: CombatTarget[] = [];
const _p0 = v3(), _p1 = v3();
const _tp = v3(), _tq = mkq();
const _bodyPt = v3(), _closest = v3(), _world = v3(), _dir = v3();
const _hit: HitResult = newHitResult();

/** Per-target scratch for the two-pass fragment budget. */
const MAX_SHAPES = 64;
const _idx = new Int32Array(MAX_SHAPES);
const _dist = new Float64Array(MAX_SHAPES);
const _frac = new Float64Array(MAX_SHAPES);

/**
 * Gurney-style fragment velocity for a cased charge.
 * v = √(2E) · √(C/M / (1 + C/(2M))) — the cylindrical form. √(2E) for TNT is
 * about 2440 m/s.
 */
export function gurneyVelocity(chargeKg: number, casingKg: number, sqrt2E = 2440): number {
  if (casingKg <= 1e-6) return sqrt2E;
  const cm = chargeKg / casingKg;
  return sqrt2E * Math.sqrt(cm / (1 + cm * 0.5));
}

/**
 * Fragment velocity remaining after flying 'd' metres.
 * Small irregular splinters have terrible ballistic coefficients — a 0.5 g
 * fragment is down to half speed inside 30 m, which is exactly why flak has to
 * burst close to hurt.
 */
function fragVelocityAt(v0: number, d: number, fragMass: number, rho: number): number {
  // Quadratic drag integrated over distance gives a pure exponential:
  // dv/dt = -k v²  and  dx = v dt  =>  dv/dx = -k v  =>  v(x) = v0·e^(-kx).
  // Cd ≈ 1.2 for a tumbling chunk; presented area from the mass assuming a
  // roughly cubic steel fragment at 7850 kg/m³.
  const vol = fragMass / 7850;
  const side = Math.cbrt(Math.max(vol, 1e-12));
  const area = side * side * 1.35;
  const k = 0.5 * rho * 1.2 * area / Math.max(fragMass, 1e-6);
  return v0 * Math.exp(-k * d);
}

/**
 * Apply a detonation to the world. Emits one HitResult per affected module.
 */
export function applyExplosion(env: CombatEnv, prm: ExplosionParams, onHit: HitSink): void {
  const rBlast = blastRadius(prm.heGrams);
  // Fragments reach much further than blast. Cap so we do not query the whole
  // map for a 500 kg bomb.
  const fragCount = prm.casingKg > 0 && prm.fragMass > 0
    ? Math.min(4000, Math.round(prm.casingKg / prm.fragMass)) : 0;
  const rFrag = fragCount > 0
    ? clamp(6 + 26 * Math.cbrt(Math.max(prm.casingKg, 1e-3)), 6, 220) : 0;
  const reach = Math.max(rBlast, rFrag);

  vset(_p0, prm.x, prm.y, prm.z);
  vset(_p1, prm.x, prm.y, prm.z);

  _targets.length = 0;
  env.queryTargets(_p0, _p1, reach, _targets);

  const maxT = prm.maxTargets ?? 24;
  let touched = 0;

  for (let ti = 0; ti < _targets.length && touched < maxT; ti++) {
    const tgt = _targets[ti];
    if (!tgt.alive) continue;
    if (prm.ignoreEntity !== undefined && tgt.id === prm.ignoreEntity) continue;
    if (prm.noFriendlyFire && tgt.team === prm.team && tgt.id !== prm.insideTarget) continue;

    resolveTargetTransform(tgt, prm.time, 0, _tp, _tq);

    // Cheap sphere reject on the whole aircraft.
    const dxc = prm.x - _tp.x, dyc = prm.y - _tp.y, dzc = prm.z - _tp.z;
    const dc = Math.sqrt(dxc * dxc + dyc * dyc + dzc * dzc);
    if (dc > reach + tgt.proxy.boundRadius + 2) continue;

    // Terrain shielding: one LOS test per target, not per module.
    let shield = 1;
    if (env.terrainOccludes && env.terrainOccludes(_p0, _tp)) shield = 0.15;

    // Burst centre in this aircraft's body frame.
    vsub(_p0, _tp, _bodyPt);
    qrotInv(_tq, _bodyPt, _bodyPt);

    let anyHit = false;

    // --- pass 1: geometry and fragment budget --------------------------
    // Solid angles are computed for every shape first, then normalised. A
    // fragment can only strike one thing: without this the naive per-module
    // sum happily "hits" a close target with several times more fragments
    // than the shell actually contained.
    let nShapes = 0;
    let sumFrac = 0;
    const shapes = tgt.proxy.shapes;
    for (let si = 0; si < shapes.length && nShapes < MAX_SHAPES; si++) {
      const shape = shapes[si];
      const d = Math.max(0, shapeDistance(shape, _bodyPt));
      if (d > reach) continue;
      _idx[nShapes] = si;
      _dist[nShapes] = d;
      const dd = Math.max(d, 0.5);
      const frac = fragCount > 0 && d < rFrag ? shape.area / (4 * Math.PI * dd * dd) : 0;
      _frac[nShapes] = frac;
      sumFrac += frac;
      nShapes++;
    }
    // Cap the total intercepted fraction: even at point-blank range a fair
    // share of the sphere misses the airframe entirely.
    const norm = sumFrac > 0.8 ? 0.8 / sumFrac : 1;

    // --- pass 2: damage -------------------------------------------------
    for (let k = 0; k < nShapes; k++) {
      const shape = shapes[_idx[k]];
      const d = _dist[k];

      // World-space impact point and direction for the VFX layer.
      shapeClosestPoint(shape, _bodyPt, _closest);
      qrot(_tq, _closest, _world);
      _world.x += _tp.x; _world.y += _tp.y; _world.z += _tp.z;
      vsub(_world, _p0, _dir);
      const dl = vlen(_dir);
      if (dl > 1e-6) vset(_dir, _dir.x / dl, _dir.y / dl, _dir.z / dl);
      else vset(_dir, 0, 1, 0);

      // --- blast ------------------------------------------------------
      let dmg = 0;
      let energy = 0;
      let effArmour = 0;
      if (d < rBlast) {
        dmg += blastDamage(prm.heGrams, d, rBlast) * shield;
        // Armour genuinely helps against blast, unlike against fragments.
        const armour = Math.max(shape.armourFront, shape.armourRear, shape.armourSide);
        if (armour > 0) dmg *= clamp(1 - armour / 24, 0.25, 1);
        effArmour = armour;
        energy += prm.heGrams * 4184 * 0.05 * (1 - d / rBlast);
      }

      // --- fragments ---------------------------------------------------
      let fragDamage = 0;
      let nFrag = 0;
      if (_frac[k] > 0) {
        const dd = Math.max(d, 0.5);
        const expected = fragCount * _frac[k] * norm * shield;
        nFrag = Math.floor(expected);
        if (env.rng.next() < expected - nFrag) nFrag++;
        nFrag = Math.min(nFrag, 120);
        if (nFrag > 0) {
          const rho = 1.225;
          const v = fragVelocityAt(prm.fragVelocity, dd, prm.fragMass, rho);
          // Treat every fragment as a tiny AP round of equivalent calibre.
          const calMm = Math.cbrt(prm.fragMass / 7850) * 1000 * 1.1;
          const pen = penetrationCapability(AmmoType.AP, calMm, prm.fragMass, v);
          const armour = Math.max(shape.armourFront, shape.armourRear, shape.armourSide)
            + shape.skinMm;
          effArmour = Math.max(effArmour, armour);
          if (pen > armour) {
            const ke = 0.5 * prm.fragMass * v * v * (1 - armour / Math.max(pen, 0.01));
            // Fragment damage aggregates sub-linearly. A hundred splinter
            // holes in a wing panel are not ten times worse than ten: the
            // structure has already lost its skin and the extra holes land in
            // metal that was doing nothing anyway.
            fragDamage = kineticDamage(ke, calMm) * Math.pow(nFrag, 0.72);
            energy += ke * nFrag;
          }
        }
      }

      dmg += fragDamage;
      if (dmg <= 0.02) continue;

      // Direct-contact bonus: a shell that functioned *inside* this module
      // dumps its whole charge there rather than losing it to the air.
      if (prm.insideTarget === tgt.id && prm.insideModule === shape.module) {
        dmg *= 1.6;
      }

      const h = _hit;
      h.type = nFrag > 0 && fragDamage > dmg * 0.5 ? 'fragment' : 'blast';
      h.time = prm.time;
      h.projectileId = prm.projectileId;
      h.kind = prm.kind;
      h.ammo = prm.ammo;
      h.calibre = 0;
      h.heGrams = prm.heGrams;
      h.ownerId = prm.ownerId;
      h.team = prm.team;
      h.shooterEntity = prm.shooterEntity;
      h.targetId = tgt.id;
      h.module = shape.module;
      h.px = _world.x; h.py = _world.y; h.pz = _world.z;
      h.nx = -_dir.x; h.ny = -_dir.y; h.nz = -_dir.z;
      h.dx = _dir.x; h.dy = _dir.y; h.dz = _dir.z;
      h.speed = prm.fragVelocity;
      h.energy = energy;
      h.damage = dmg;
      h.penetrationMm = 0;
      h.effectiveArmourMm = effArmour;
      h.angleDeg = 0;
      h.ignite = ignitionChance(prm.ammo, energy, prm.heGrams) * shield;
      onHit(h);
      anyHit = true;
    }

    if (anyHit) touched++;
  }
}

/**
 * Fragment/casing characteristics for a gun-calibre shell, derived from the
 * calibre and the declared filler mass in 'GunSpec.he'.
 */
export function shellCasing(calibre: number, heGrams: number, shellMass: number): {
  casingKg: number; fragMass: number; fragVelocity: number;
} {
  const chargeKg = heGrams * 0.001;
  const casingKg = Math.max(0, shellMass - chargeKg) * 0.82;
  // Natural fragmentation of a thin-walled shell produces splinters averaging
  // roughly (calibre/20)³ × 0.4 g. Bigger shells throw bigger, longer-ranged
  // pieces.
  const fragMass = Math.max(2e-5, 0.0004 * Math.pow(calibre / 20, 2.4));
  const fragVelocity = gurneyVelocity(chargeKg, casingKg);
  return { casingKg, fragMass, fragVelocity };
}

/** Same, for a bomb or rocket warhead where we know the total weight. */
export function warheadCasing(totalKg: number, heGrams: number): {
  casingKg: number; fragMass: number; fragVelocity: number;
} {
  const chargeKg = heGrams * 0.001;
  const casingKg = Math.max(0.1, totalKg - chargeKg) * 0.85;
  const fragMass = clamp(0.004 * Math.cbrt(totalKg), 0.002, 0.05);
  const fragVelocity = gurneyVelocity(chargeKg, casingKg);
  return { casingKg, fragMass, fragVelocity };
}

/**
 * Ground-burst crater/blast radius for the VFX layer — larger than the
 * damage radius because dust and debris are thrown much further than the
 * lethal overpressure reaches.
 */
export function visualBlastRadius(heGrams: number): number {
  return blastRadius(heGrams) * 2.4;
}

/**
 * Blast and fragment damage to something standing on the ground, at 'distance'
 * metres from a surface burst of 'heGrams'.
 *
 * This deliberately does *not* reuse 'blastDamage'. That curve is tuned for
 * aircraft: it falls as (1 − d/R)^1.6 inside a radius of 3.6·W^⅓, which is the
 * distance at which overpressure alone will wreck a stressed-skin airframe —
 * about 11 m for a 250 lb bomb. Ground targets are killed by a completely
 * different mechanism and over a completely different scale. A lorry, a gun
 * crew or a stack of ammunition is destroyed by fragments and ground shock, and
 * the RAF's own effectiveness tables put the radius at which a 250 lb GP will
 * disable soft-skinned transport at around 25–30 m and a 250 kg SC at nearer 45
 * — roughly 9·W^⅓, three times the aircraft figure. Applying the aeroplane
 * curve to a truck makes bombing an exercise in landing a direct hit, which is
 * not what bombing was.
 *
 * So: an inverse-square-ish falloff over 9·W^⅓, with the same peak the shared
 * model derives from the filling, scaled up by the 1.6× that ground shock and a
 * reflecting surface add to a surface burst.
 *
 * It lives here rather than in either caller because the authoritative server
 * and the offline sandbox both have to reach exactly the same verdict about
 * whether a bomb destroyed a convoy.
 */
export function groundBlastDamage(heGrams: number, distance: number): number {
  const kgTnt = Math.max(1e-3, heGrams * 0.001);
  const rF = 9 * Math.cbrt(kgTnt);
  if (distance >= rF) return 0;
  return peakBlastDamage(heGrams) * 1.6 * (1 - distance / rF) ** 2;
}

/** Radius inside which {@link groundBlastDamage} is non-zero, metres. */
export function groundBlastRadius(heGrams: number): number {
  return 9 * Math.cbrt(Math.max(1e-3, heGrams * 0.001));
}
