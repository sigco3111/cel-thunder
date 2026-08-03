/**
 * Armour penetration.
 *
 * The model is a kinetic-energy-density formulation rather than a fitted
 * polynomial, because it then extrapolates sensibly to calibres and velocities
 * nobody bothered to publish tables for:
 *
 *     P = (½ · m_core · v²) / (A · S) · f(v)
 *
 * 'm_core' is the *penetrating* mass — the hardened core of an AP round, not
 * the whole cartridge; 'A' is the presented area; 'S' is the target's dynamic
 * resistance to cavity expansion (~3.4 GPa for WWII rolled homogeneous
 * armour). 'f(v)' is a mild correction that softens the pure v² dependence to
 * about v^1.7, which is what measured data actually shows once the penetrator
 * starts to deform at high impact velocity.
 *
 * Calibration checks (all at 0° obliquity):
 *   .50 BMG M2 AP  @ 810 m/s  ->  ~19 mm  (published: 20 mm at 100 m)
 *   .50 BMG M2 AP  @ 660 m/s  ->  ~14 mm  (published: 12 mm at 500 m)
 *   7.92 SmK       @ 785 m/s  ->  ~10 mm  (published: 10–12 mm at 100 m)
 *   20 mm MG151 AP @ 705 m/s  ->  ~27 mm  (published: ~25 mm at 100 m)
 *
 * Angle handling is the classic effective-thickness rule, t_eff = t / cos θ,
 * with two refinements that matter a lot in practice: *normalisation* (a shaped
 * AP nose bites and rotates toward the plate normal, worth a few degrees) and
 * *ricochet* above a critical angle that depends on the round's construction.
 */

import { clamp, smoothstep, type Rng } from '../math';
import { AmmoType, type ArmourMaterial, RHA_EQUIV } from './types';

/**
 * Dynamic cavity-expansion resistance of rolled homogeneous armour, Pa.
 * Everything else is expressed as an RHA equivalent thickness before it gets
 * here, so this is the only material constant the penetration maths needs.
 */
export const RHA_RESISTANCE = 3.37e9;

/** Reference velocity for the velocity-exponent correction. */
const V_REF = 800;
/** Softens v² toward v^1.7 — deforming penetrators waste energy. */
const V_EXP = -0.30;

/**
 * Fraction of projectile mass that actually acts as a penetrator.
 *
 * A .50 AP round is 46 g of which ~26 g is the hardened steel core; the jacket
 * strips off on impact and contributes nothing. A thin-walled HE shell is
 * almost all filler and cavity — it cannot defeat armour at all, it can only
 * detonate against it.
 */
export function coreMassFraction(ammo: AmmoType, calibre = 12.7): number {
  let f: number;
  switch (ammo) {
    case AmmoType.AP: f = 0.56; break;
    case AmmoType.APHE: f = 0.74; break;   // solid shell body, small base charge
    case AmmoType.API: f = 0.46; break;    // core plus incendiary compartment
    case AmmoType.Ball: f = 0.28; break;   // soft core, upsets badly
    case AmmoType.HEI: f = 0.10; break;
    case AmmoType.HE: f = 0.11; break;
    default: f = 0.4; break;
  }
  // Rifle-calibre AP is a small hard core inside a gilding-metal jacket that
  // strips on impact. Cannon-calibre AP is a monolithic hardened steel body
  // with at most a tiny incendiary cavity, so almost all of its mass works.
  if (ammo === AmmoType.AP || ammo === AmmoType.APHE || ammo === AmmoType.API) {
    f += 0.30 * clamp((calibre - 13) / 12, 0, 1);
  }
  return f;
}

/**
 * Critical ricochet angle from the plate normal, degrees, before overmatch.
 * Blunt or soft rounds skate off much earlier than a sharp hardened core.
 */
function baseRicochetAngle(ammo: AmmoType): number {
  switch (ammo) {
    case AmmoType.AP: return 65;
    case AmmoType.APHE: return 63;
    case AmmoType.API: return 62;
    case AmmoType.Ball: return 55;
    case AmmoType.HE:
    case AmmoType.HEI: return 72;  // the fuse usually acts before it can skip
    default: return 62;
  }
}

/**
 * Normalisation: the angle credit an AP nose earns by biting into the plate
 * and rotating toward the normal. Scales with overmatch — a round much wider
 * than the plate is thick effectively punches a hole straight through.
 */
function normalisationDeg(ammo: AmmoType, calibre: number, thickness: number): number {
  if (ammo === AmmoType.HE || ammo === AmmoType.HEI) return 0;
  const overmatch = thickness > 0.05 ? calibre / thickness : 4;
  return 3.5 + 4.5 * clamp(overmatch - 1, 0, 2) * 0.5;
}

export interface PenetrationQuery {
  ammo: AmmoType;
  /** Millimetres. */
  calibre: number;
  /** Kilograms — the whole projectile; the core fraction is applied here. */
  mass: number;
  /** Impact velocity, m/s. */
  velocity: number;
  /** Nominal plate thickness, mm (line-of-sight correction applied here). */
  armourMm: number;
  armourMaterial?: ArmourMaterial;
  /**
   * Cosine of the angle between the velocity vector and the *inward* surface
   * normal. 1 = perpendicular strike. Clamped to a floor so grazing shots do
   * not produce infinite thickness.
   */
  cosTheta: number;
  /**
   * Uniform random draw in [0,1) used to resolve the probabilistic ricochet.
   * Deterministic by default (0.5) so unit tests are reproducible.
   */
  roll?: number;
}

export interface PenetrationResult {
  outcome: 'penetrate' | 'stop' | 'ricochet';
  /** Penetration capability against RHA at this velocity, mm. */
  penetrationMm: number;
  /** Line-of-sight RHA-equivalent thickness actually presented, mm. */
  effectiveMm: number;
  /** Impact angle from the plate normal, degrees. */
  angleDeg: number;
  /** Probability the round would have skipped off. */
  ricochetChance: number;
  /** Velocity remaining after the plate, m/s (0 if stopped). */
  residualVelocity: number;
  /** Kinetic energy given up to the plate/structure, J. */
  energyDeposited: number;
  /** Mass remaining after the plate (rounds shed jacket and nose), kg. */
  residualMass: number;
}

/** Allocate a blank result. Hot callers should reuse one of these. */
export function newPenetrationResult(): PenetrationResult {
  return {
    outcome: 'stop', penetrationMm: 0, effectiveMm: 0, angleDeg: 0,
    ricochetChance: 0, residualVelocity: 0, energyDeposited: 0, residualMass: 0,
  };
}

/**
 * Raw penetration capability, mm RHA, ignoring the plate.
 * Exposed separately because the AA/flak fragment model wants it.
 */
export function penetrationCapability(ammo: AmmoType, calibre: number, mass: number, velocity: number): number {
  if (velocity <= 1) return 0;
  const mCore = mass * coreMassFraction(ammo, calibre);
  const r = calibre * 0.0005;
  const area = Math.PI * r * r;
  const ke = 0.5 * mCore * velocity * velocity;
  const fv = Math.pow(Math.max(velocity, 50) / V_REF, V_EXP);
  return 1000 * (ke / (area * RHA_RESISTANCE)) * fv;
}

/**
 * Resolve one projectile-versus-plate interaction.
 *
 * The residual velocity uses the Recht–Ipson form v_r = √(v² − v_bl²), where
 * the ballistic limit v_bl is recovered from the penetration curve. That is
 * what makes "just barely got through" feel different from "sailed through" —
 * a round that only just defeats the plate arrives on the far side with almost
 * nothing left and does trivial damage to whatever is behind it.
 */
export function computePenetration(
  qry: PenetrationQuery, out: PenetrationResult = newPenetrationResult(),
): PenetrationResult {
  const material = qry.armourMaterial ?? 'rha';
  const cos = clamp(qry.cosTheta, 0.05, 1);
  const angleDeg = Math.acos(cos) * 180 / Math.PI;

  const nominal = Math.max(0, qry.armourMm) * RHA_EQUIV[material];

  // Normalisation reduces the *effective* obliquity for the thickness maths,
  // but the ricochet test uses the true impact angle: a round can normalise
  // through a plate it would otherwise have skipped, or skip off one it could
  // have holed. Both happen in reality.
  const normDeg = normalisationDeg(qry.ammo, qry.calibre, nominal);
  const effAngle = Math.max(0, angleDeg - normDeg);
  const effCos = Math.max(0.05, Math.cos(effAngle * Math.PI / 180));
  const effectiveMm = nominal / effCos;

  const pen = penetrationCapability(qry.ammo, qry.calibre, qry.mass, qry.velocity);

  // --- ricochet -------------------------------------------------------
  const overmatch = nominal > 0.05 ? qry.calibre / nominal : 99;
  let crit = baseRicochetAngle(qry.ammo);
  // A round far wider than the plate is thick cannot skip: it simply removes
  // that piece of plate.
  crit += 12 * clamp(overmatch - 1, 0, 1);
  // Massive excess penetration also suppresses skipping.
  const excess = effectiveMm > 0.05 ? pen / effectiveMm : 99;
  crit += 8 * clamp(excess - 1.5, 0, 1);
  crit = Math.min(crit, 88);

  let ricochetChance = nominal <= 0.05
    ? 0                                   // nothing to skip off
    : smoothstep(crit - 3, crit + 7, angleDeg);
  if (qry.ammo === AmmoType.HE || qry.ammo === AmmoType.HEI) {
    // An impact-fused HE shell that skips still usually functions; treat the
    // skip as far less likely and let the caller detonate it anyway.
    ricochetChance *= 0.35;
  }

  out.penetrationMm = pen;
  out.effectiveMm = effectiveMm;
  out.angleDeg = angleDeg;
  out.ricochetChance = ricochetChance;

  const roll = qry.roll ?? 0.5;
  if (ricochetChance > 0 && roll < ricochetChance) {
    out.outcome = 'ricochet';
    // A deflected round keeps most of its speed but loses the energy that went
    // into gouging the plate.
    const keep = 0.62 + 0.28 * cos;
    out.residualVelocity = qry.velocity * keep;
    out.residualMass = qry.mass * 0.85;
    out.energyDeposited = 0.5 * qry.mass * (qry.velocity * qry.velocity - out.residualVelocity * out.residualVelocity);
    return out;
  }

  if (pen <= effectiveMm || pen <= 0) {
    out.outcome = 'stop';
    out.residualVelocity = 0;
    out.residualMass = 0;
    out.energyDeposited = 0.5 * qry.mass * qry.velocity * qry.velocity;
    return out;
  }

  // Ballistic limit: the velocity at which this round would exactly perforate
  // this thickness. Invert P ∝ v^(2 + V_EXP).
  const expo = 2 + V_EXP;
  const vbl = qry.velocity * Math.pow(effectiveMm / pen, 1 / expo);
  const vr = Math.sqrt(Math.max(0, qry.velocity * qry.velocity - vbl * vbl));

  // Mass loss through the plate: jacket stripping plus nose erosion, worse at
  // high obliquity.
  const massKeep = clamp(0.94 - 0.25 * (1 - effCos) - 0.10 * (effectiveMm / pen), 0.35, 0.96);

  out.outcome = 'penetrate';
  out.residualVelocity = vr;
  out.residualMass = qry.mass * massKeep;
  out.energyDeposited = Math.max(0,
    0.5 * qry.mass * qry.velocity * qry.velocity - 0.5 * out.residualMass * vr * vr);
  return out;
}

/** Convenience wrapper that draws its ricochet roll from an Rng. */
export function computePenetrationRng(qry: PenetrationQuery, rng: Rng, out?: PenetrationResult): PenetrationResult {
  qry.roll = rng.next();
  return computePenetration(qry, out);
}

// ---------------------------------------------------------------------------
// Damage conversion
// ---------------------------------------------------------------------------

/**
 * Convert deposited kinetic energy into module hit points.
 *
 * Scaled so that the reference case — a .50 AP round (≈15 kJ) dumping all of
 * its energy into a wing — takes off roughly 12 hp of a 130 hp wing, i.e. it
 * takes about a ten-round burst on target to wreck a wing with rifle-calibre
 * fire. That matches both the historical gun-camera record and the pacing we
 * want: machine guns nibble, cannon amputate.
 *
 * The square root is important. Damage that scales linearly with energy makes
 * big cannon absurd and small guns useless; real terminal effects scale much
 * closer to the square root of energy because the damaged volume grows with
 * the cube root of energy while the *area* of structure severed grows slower.
 */
export function kineticDamage(energyJ: number, calibre: number): number {
  if (energyJ <= 0) return 0;
  // Calibre bonus: a wider hole is structurally worse than a narrow one of the
  // same energy — it cuts more stringers and sheds more skin.
  const calFactor = Math.pow(calibre / 12.7, 0.45);
  return 0.098 * Math.sqrt(energyJ) * calFactor;
}

/**
 * Blast damage from explosive filler detonating *at* a module.
 * 'grams' is TNT-equivalent; 'distance' metres from the burst.
 */
/**
 * Peak structural damage a charge does to whatever it is touching.
 *
 * NOT linear in charge mass. The energy released scales linearly, but the
 * damage a given piece of structure can absorb saturates — once a wing panel
 * has been blown off, a bigger charge cannot blow it off harder. What a bigger
 * charge buys you is *radius*, which 'blastRadius' handles. Calibrated so a
 * 20 mm shell's 10 g filler does about 25 hp at contact (three hits take a
 * fighter's wing off) and a 250 kg bomb's 130 kg does about 650 (anything
 * within the fireball is simply gone).
 */
export function peakBlastDamage(grams: number): number {
  if (grams <= 0) return 0;
  return 11.0 * Math.pow(grams, 0.35);
}

/**
 * Blast damage at 'distance' metres from a burst of 'grams' TNT-equivalent.
 * The ^1.6 falloff matches the shape of the Kingery-Bulmash overpressure curve
 * closely enough over the normalised 0..1 range.
 */
export function blastDamage(grams: number, distance: number, radius: number): number {
  if (grams <= 0 || radius <= 0 || distance >= radius) return 0;
  const f = 1 - distance / radius;
  return peakBlastDamage(grams) * Math.pow(f, 1.6);
}

export function blastRadius(grams: number): number {
  const kg = Math.max(1e-4, grams * 0.001);
  return 3.6 * Math.cbrt(kg);
}

/** Probability that a hit ignites fuel/oil vapour in the module it lands in. */
export function ignitionChance(ammo: AmmoType, energyJ: number, heGrams: number): number {
  let p = 0;
  switch (ammo) {
    case AmmoType.API: p = 0.42; break;
    case AmmoType.HEI: p = 0.55; break;
    case AmmoType.HE: p = 0.22; break;
    case AmmoType.APHE: p = 0.18; break;
    case AmmoType.AP: p = 0.09; break;
    case AmmoType.Ball: p = 0.05; break;
  }
  // Bigger bangs and hotter impacts ignite more reliably.
  p *= 0.55 + 0.45 * clamp(Math.sqrt(energyJ) / 160, 0, 1);
  p += clamp(heGrams / 60, 0, 0.25);
  return clamp(p, 0, 0.92);
}
