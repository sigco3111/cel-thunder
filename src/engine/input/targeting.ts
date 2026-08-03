import * as THREE from 'three';
import type { GameContext } from '../context';
import { DamageBits, EntityKind, type EntityState } from '../../shared/protocol';
import type { AircraftView } from './aircraftView';

/**
 * Target tracking for the gunnery solution.
 *
 * The lead pipper needs *one* target, and picking it badly is worse than not
 * having one: a pipper that flicks between two aircraft mid-burst destroys the
 * player's ability to trust it. So selection is deliberately sticky:
 *
 *  - Acquisition needs the target inside a tight cone (the player is clearly
 *    pointing at it) and within useful gun range.
 *  - Retention uses a much wider cone and a longer range, plus an explicit
 *    score bonus, so a target that breaks hard stays locked through the turn.
 *  - A short grace period survives the target passing behind our own nose or
 *    an interpolation gap, instead of dropping and re-acquiring.
 *
 * Tab cycles manually through everything in the forward hemisphere; the manual
 * choice then holds until it dies or leaves the retention envelope.
 */

const ACQUIRE_CONE = Math.cos(14 * Math.PI / 180);
const RETAIN_CONE = Math.cos(42 * Math.PI / 180);
const ACQUIRE_RANGE = 2400;
const RETAIN_RANGE = 4000;
const GRACE = 0.8;

export interface TrackedTarget {
  id: number;
  readonly pos: THREE.Vector3;
  readonly vel: THREE.Vector3;
  /** Angle between our nose and the line of sight, radians. */
  offAxis: number;
  range: number;
  /** Closing speed, m/s. Positive = closing. */
  closure: number;
  team: number;
  typeId: number;
  health: number;
  /** True while the entity is actually present this frame. */
  live: boolean;
}

const _los = new THREE.Vector3();
const _tp = new THREE.Vector3();
const _tv = new THREE.Vector3();

export class TargetTracker {
  readonly target: TrackedTarget = {
    id: 0,
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    offAxis: Math.PI, range: 0, closure: 0, team: -1, typeId: 0, health: 1, live: false,
  };

  /** True when the player picked this target explicitly rather than the auto-lock. */
  manual = false;
  private missing = 0;
  private cycleOrder: number[] = [];
  private cycleAt = 0;
  private cycleTimer = 0;

  /** Ids of every hostile in the forward hemisphere, nearest first. */
  readonly candidates: number[] = [];
  /** Parallel range array, kept sorted with 'candidates'. Never read outside. */
  private readonly candRange: number[] = [];

  update(ctx: GameContext, view: AircraftView, dt: number): TrackedTarget {
    const t = this.target;
    this.cycleTimer = Math.max(0, this.cycleTimer - dt);

    if (!view.valid) { this.clear(); return t; }

    // ---- gather candidates -------------------------------------------------
    this.candidates.length = 0;
    let best = 0;
    let bestScore = -Infinity;

    for (const e of ctx.entities.values()) {
      if (!isHostileAircraft(e, ctx.localEntityId, ctx.localTeam)) continue;

      _los.set(e.px - view.pos.x, e.py - view.pos.y, e.pz - view.pos.z);
      const range = _los.length();
      if (range < 8 || range > RETAIN_RANGE) continue;
      _los.multiplyScalar(1 / range);
      const cos = _los.dot(view.forward);
      if (cos <= 0) continue;               // behind us
      // Insertion sort by range as we go. Cheaper than the sort it replaces —
      // which allocated a comparator closure every frame and did two Map lookups
      // per comparison — and the list is single-digit long in practice.
      const n = this.candidates.length;
      let ins = n;
      while (ins > 0 && this.candRange[ins - 1] > range) {
        this.candidates[ins] = this.candidates[ins - 1];
        this.candRange[ins] = this.candRange[ins - 1];
        ins--;
      }
      this.candidates[ins] = e.id;
      this.candRange[ins] = range;
      this.candidates.length = n + 1;

      const isCurrent = e.id === t.id;
      const coneOk = isCurrent ? cos >= RETAIN_CONE : cos >= ACQUIRE_CONE;
      const rangeOk = range <= (isCurrent ? RETAIN_RANGE : ACQUIRE_RANGE);
      if (!coneOk || !rangeOk) continue;
      if (this.manual && !isCurrent) continue;

      // Score: mostly angular proximity (the player aims with the nose), with
      // range as a tiebreak, and a strong bonus for whatever we already track.
      const angScore = (cos - RETAIN_CONE) / (1 - RETAIN_CONE);
      const rangeScore = 1 - Math.min(1, range / RETAIN_RANGE);
      let score = angScore * 2.4 + rangeScore * 0.8;
      if (isCurrent) score += 1.1;
      if (score > bestScore) { bestScore = score; best = e.id; }
    }

    // ---- commit ------------------------------------------------------------
    const chosen = best || (this.manual ? t.id : 0);
    const ent = chosen ? ctx.entities.get(chosen) : undefined;

    if (ent && !isDead(ent)) {
      this.missing = 0;
      t.id = ent.id;
      _tp.set(ent.px, ent.py, ent.pz);
      _tv.set(ent.vx, ent.vy, ent.vz);
      // Remote entities arrive at 20 Hz and are interpolated; a light filter on
      // the velocity keeps the pipper from twitching between snapshots without
      // adding meaningful lag to the solution.
      const a = 1 - Math.exp(-dt * 14);
      if (t.live) { t.pos.lerp(_tp, 1 - Math.exp(-dt * 40)); t.vel.lerp(_tv, a); }
      else { t.pos.copy(_tp); t.vel.copy(_tv); }
      t.team = ent.team; t.typeId = ent.typeId; t.health = ent.health;
      _los.subVectors(t.pos, view.pos);
      t.range = _los.length();
      if (t.range > 1e-3) {
        _los.multiplyScalar(1 / t.range);
        t.offAxis = Math.acos(Math.max(-1, Math.min(1, _los.dot(view.forward))));
        _tv.subVectors(view.vel, t.vel);
        t.closure = _tv.dot(_los);
      }
      t.live = true;
    } else if (t.id) {
      // Lost sight: coast on the last known velocity briefly rather than
      // dropping the lock the instant an aircraft clips a cloud.
      this.missing += dt;
      if (this.missing > GRACE) { this.clear(); return t; }
      t.pos.addScaledVector(t.vel, dt);
      t.range = t.pos.distanceTo(view.pos);
      t.live = false;
    }

    return t;
  }

  /** Advance the manual selection. Call on the Tab edge. */
  cycle(ctx: GameContext, view: AircraftView): void {
    if (this.cycleTimer > 0 || this.candidates.length === 0) return;
    this.cycleTimer = 0.12;
    this.cycleOrder = this.candidates.slice();
    const cur = this.cycleOrder.indexOf(this.target.id);
    this.cycleAt = (cur + 1) % this.cycleOrder.length;
    const id = this.cycleOrder[this.cycleAt];
    const ent = ctx.entities.get(id);
    if (!ent) return;
    this.manual = true;
    this.missing = 0;
    this.target.id = id;
    this.target.pos.set(ent.px, ent.py, ent.pz);
    this.target.vel.set(ent.vx, ent.vy, ent.vz);
    this.target.live = true;
    this.target.range = this.target.pos.distanceTo(view.pos);
  }

  clear(): void {
    const t = this.target;
    t.id = 0; t.live = false; t.range = 0; t.offAxis = Math.PI; t.closure = 0;
    this.manual = false;
    this.missing = 0;
  }

  /** Drop the manual lock but keep auto-acquisition running. */
  releaseManual(): void { this.manual = false; }
}

function isHostileAircraft(e: EntityState, localId: number, localTeam: number): boolean {
  if (e.kind !== EntityKind.Aircraft) return false;
  if (e.id === localId) return false;
  if (e.team === localTeam) return false;
  return !isDead(e);
}

const isDead = (e: EntityState): boolean =>
  e.health <= 0.001 || (e.damage & DamageBits.Destroyed) !== 0;

