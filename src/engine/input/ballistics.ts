import * as THREE from 'three';
import type { GunSpec } from '../../shared/aircraft';
import { airDensity, speedOfSound, G0 } from '../../shared/combat/atmosphere';
import { cdG1, calibreArea, defaultFormFactor } from '../../shared/combat/drag';
import { AmmoType } from '../../shared/combat/types';

/**
 * Gunnery solution for the HUD's lead indicator.
 *
 * The lead pipper is the single most important number a WWII air-combat game
 * computes, because the player aims *at the pipper*, not at the target. If it
 * lies, every shot misses and the guns feel broken. So it is solved properly:
 *
 *  1. A **ballistic table** is integrated for the actual round, using the
 *     shared G1 drag function and ISA density at the firing altitude. A 12.7 mm
 *     M2 leaves the muzzle at 887 m/s and is down to roughly 640 m/s at 600 m;
 *     assuming a constant velocity would put the pipper about 20 % short at
 *     that range, which at a 400 m lead is two fuselage lengths of error.
 *  2. The **intercept** is then solved by fixed-point iteration on time of
 *     flight: guess t, project the target forward by t, look up how long the
 *     bullet needs to cover that new distance, repeat. It converges in three
 *     iterations for any closing geometry a fighter can produce.
 *  3. **Gravity drop** is added last, as an upward offset of the aim point —
 *     the bullet falls ½gt² during flight, so the sight must point that much
 *     high. At 800 m the drop is around 3.5 m: not decisive, but visible, and
 *     it is what makes long-range deflection shooting feel earned.
 *
 * Everything is computed in the shooter's inertial frame (target velocity is
 * taken relative to own velocity), which is why the muzzle velocity is used
 * directly rather than being vector-summed with the aircraft's own speed.
 */

const TABLE_DT = 0.004;
const TABLE_MAX_T = 4.0;
const TABLE_N = Math.round(TABLE_MAX_T / TABLE_DT) + 1;

export class BallisticTable {
  /** Cumulative down-range distance at index i, i.e. at time i·TABLE_DT. */
  private dist = new Float32Array(TABLE_N);
  /** Remaining speed at index i, m/s. */
  private speed = new Float32Array(TABLE_N);
  /** Number of valid samples (integration stops once the round is subsonicked out). */
  private n = 0;

  /** The configuration this table was built for. */
  private builtV0 = -1;
  private builtAlt = -1e9;
  private builtK = -1;

  muzzle = 0;
  /** Practical maximum range for the pipper, m — beyond this the solution is noise. */
  maxRange = 1400;

  /**
   * (Re)builds the table if the firing conditions have moved enough to matter.
   * Density changes slowly with altitude, so a 400 m bucket is plenty and keeps
   * this off the per-frame budget.
   */
  ensure(gun: GunSpec, altitude: number, ownSpeedAlongBore: number): void {
    // Rounds inherit the launch aircraft's velocity along the bore.
    const v0 = gun.muzzle + Math.max(-120, Math.min(260, ownSpeedAlongBore));
    const alt = Math.max(0, altitude);
    const rho = airDensity(alt);
    const ammo = ammoTypeFor(gun);
    const k = 0.5 * rho * defaultFormFactor(ammo, gun.calibre) * calibreArea(gun.calibre) / Math.max(1e-4, gun.mass);

    if (Math.abs(v0 - this.builtV0) < 12 && Math.abs(alt - this.builtAlt) < 400 && Math.abs(k - this.builtK) < this.builtK * 0.05) {
      return;
    }
    this.builtV0 = v0; this.builtAlt = alt; this.builtK = k;
    this.muzzle = v0;

    const a = speedOfSound(alt);
    let v = v0;
    let s = 0;
    this.dist[0] = 0;
    this.speed[0] = v;
    let i = 1;
    for (; i < TABLE_N; i++) {
      // Midpoint (RK2) on dv/dt = −k·Cd(M)·v². Explicit Euler at 4 ms is
      // already accurate to <0.2 % here, but RK2 costs one extra table lookup
      // and removes the systematic under-drag bias entirely.
      const acc1 = -k * cdG1(v / a) * v * v;
      const vm = v + acc1 * TABLE_DT * 0.5;
      const acc2 = -k * cdG1(vm / a) * vm * vm;
      const vNext = Math.max(60, v + acc2 * TABLE_DT);
      s += (v + vNext) * 0.5 * TABLE_DT;
      v = vNext;
      this.dist[i] = s;
      this.speed[i] = v;
      if (s > 3000 || v <= 61) { i++; break; }
    }
    this.n = i;
    this.maxRange = Math.min(this.dist[this.n - 1], 1600);
  }

  /** Time of flight to a slant range, seconds. Clamped to the table. */
  timeToRange(range: number): number {
    if (range <= 0 || this.n < 2) return 0;
    if (range >= this.dist[this.n - 1]) return (this.n - 1) * TABLE_DT;
    let lo = 0, hi = this.n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.dist[mid] <= range) lo = mid; else hi = mid;
    }
    const d0 = this.dist[lo], d1 = this.dist[hi];
    const f = d1 > d0 ? (range - d0) / (d1 - d0) : 0;
    return (lo + f) * TABLE_DT;
  }

  /** Down-range distance covered after 't' seconds. */
  rangeAtTime(t: number): number {
    if (t <= 0 || this.n < 2) return 0;
    const f = t / TABLE_DT;
    if (f >= this.n - 1) return this.dist[this.n - 1];
    const i = f | 0;
    return this.dist[i] + (this.dist[i + 1] - this.dist[i]) * (f - i);
  }

  /** Remaining projectile speed at a given range — drives damage falloff text. */
  speedAtRange(range: number): number {
    const t = this.timeToRange(range);
    const f = Math.min(this.n - 1, t / TABLE_DT);
    const i = f | 0;
    if (i >= this.n - 1) return this.speed[this.n - 1];
    return this.speed[i] + (this.speed[i + 1] - this.speed[i]) * (f - i);
  }

  /** Gravity drop over a given range, metres. */
  dropAtRange(range: number): number {
    const t = this.timeToRange(range);
    return 0.5 * G0 * t * t;
  }
}

/** Best-guess ammunition class from the gun spec's explosive filler. */
export function ammoTypeFor(gun: GunSpec): AmmoType {
  if (gun.he > 4) return AmmoType.HE;
  if (gun.he > 0) return AmmoType.HEI;
  if (gun.calibre <= 8) return AmmoType.Ball;
  return AmmoType.AP;
}

/** Picks the gun that the lead pipper should be solved for. */
export function primaryGun(guns: readonly GunSpec[]): GunSpec | null {
  if (guns.length === 0) return null;
  // Prefer the group-1 battery: it is what the player fires while tracking, and
  // it usually has the most barrels, so its trajectory is the one that matters.
  let best = guns[0];
  let bestScore = -1;
  for (const g of guns) {
    const score = g.count * (g.group === 1 ? 1.4 : 1.0) + g.muzzle * 0.001;
    if (score > bestScore) { bestScore = score; best = g; }
  }
  return best;
}

// ---------------------------------------------------------------------------

export interface LeadSolution {
  valid: boolean;
  /** World-space point the guns must be pointed at. */
  readonly point: THREE.Vector3;
  /** Where the target will be at impact (no gravity compensation). */
  readonly impact: THREE.Vector3;
  /** Slant range to the target now, m. */
  range: number;
  /** Time of flight, s. */
  tof: number;
  /** Gravity drop compensated for, m. */
  drop: number;
  /** Angular lead from the current line of sight, radians. */
  leadAngle: number;
  /** Projectile speed at impact, m/s. */
  impactSpeed: number;
  /** True when the target is inside the round's useful envelope. */
  inRange: boolean;
}

export function newLeadSolution(): LeadSolution {
  return {
    valid: false,
    point: new THREE.Vector3(),
    impact: new THREE.Vector3(),
    range: 0, tof: 0, drop: 0, leadAngle: 0, impactSpeed: 0, inRange: false,
  };
}

const _rel = new THREE.Vector3();
const _relV = new THREE.Vector3();
const _fut = new THREE.Vector3();
const _los = new THREE.Vector3();
const _dir = new THREE.Vector3();

/**
 * Solves the intercept. Returns 'out' for chaining.
 *
 * @param muzzlePos  where the rounds actually leave the aircraft (gun port,
 *                   not the camera — at 3 m of wing offset and 600 m of range
 *                   that is a quarter of a degree, which is a whole fuselage)
 */
export function solveLead(
  out: LeadSolution,
  table: BallisticTable,
  muzzlePos: THREE.Vector3,
  ownVel: THREE.Vector3,
  targetPos: THREE.Vector3,
  targetVel: THREE.Vector3,
): LeadSolution {
  _rel.subVectors(targetPos, muzzlePos);
  _relV.subVectors(targetVel, ownVel);

  const r0 = _rel.length();
  out.range = r0;
  if (r0 < 1 || r0 > 6000) {
    out.valid = false;
    out.point.copy(targetPos);
    out.impact.copy(targetPos);
    out.tof = 0; out.drop = 0; out.leadAngle = 0; out.inRange = false;
    return out;
  }

  // Fixed-point iteration on time of flight. Three passes puts the residual
  // below a metre for any fighter-versus-fighter geometry; a fourth is free
  // insurance for head-on passes where the closure rate is 300 m/s.
  let t = table.timeToRange(r0);
  for (let i = 0; i < 4; i++) {
    _fut.copy(_relV).multiplyScalar(t).add(_rel);
    const d = _fut.length();
    const tNew = table.timeToRange(d);
    if (Math.abs(tNew - t) < 1e-4) { t = tNew; break; }
    t = tNew;
  }

  _fut.copy(_relV).multiplyScalar(t).add(_rel);
  out.impact.copy(muzzlePos).add(_fut);

  // The bullet falls ½gt² relative to the shooter's inertial frame, so the aim
  // point sits that far *above* the intercept.
  out.drop = 0.5 * G0 * t * t;
  out.point.copy(out.impact);
  out.point.y += out.drop;

  out.tof = t;
  _los.copy(_rel).normalize();
  _dir.copy(out.point).sub(muzzlePos).normalize();
  out.leadAngle = Math.acos(Math.max(-1, Math.min(1, _los.dot(_dir))));
  out.impactSpeed = table.speedAtRange(_fut.length());
  out.inRange = _fut.length() <= table.maxRange;
  out.valid = true;
  return out;
}

/**
 * Static gunsight ranging: where the rounds cross the boresight line at the
 * convergence distance. Used to draw the fixed reticle and the range ladder.
 */
export function convergenceDrop(table: BallisticTable, convergence: number): number {
  return table.dropAtRange(convergence);
}
