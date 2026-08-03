import type { AircraftSpec } from '../../shared/aircraft';
import { DamageBits, InputBits, type EntityState, type InputFrame } from '../../shared/protocol';
import {
  clamp, hash2, qrot, qrotInv, v3, vlen, vnorm, type Q, type V3,
} from '../../shared/math';
import type { ClientEnv } from '../env';

/**
 * A competent WWII fighter pilot.
 *
 * The behaviours that separate a convincing AI from a target drone are, in
 * order of importance:
 *
 *  1. **It never flies into the ground.** Terrain avoidance pre-empts every
 *     other decision, and it looks far enough ahead to actually recover.
 *  2. **Energy management.** Speed and altitude are one currency. When it is
 *     down on energy it disengages, dives to convert altitude into speed, and
 *     comes back — instead of turning until it stalls and mushes into the sea.
 *  3. **Lead pursuit.** It shoots where the target will be, solved iteratively
 *     against the actual muzzle velocity and with gravity drop compensated,
 *     rather than pointing at where the target is.
 *  4. **Break turns.** When someone's guns are tracking it, it breaks — hard,
 *     out of plane, toward the attacker — rather than continuing serenely.
 *  5. **It is not perfect.** Reaction delay, aim jitter and a personality
 *     seeded from the entity id keep a flight of five from moving as one.
 *
 * The pilot only ever reads 'EntityState', never the flight model's internals,
 * so it works identically against the shared model and the fallback.
 */

const FWD: V3 = { x: 0, y: 0, z: 1 };
const UP: V3 = { x: 0, y: 1, z: 0 };
const WORLD_UP: V3 = { x: 0, y: 1, z: 0 };

type Mode = 'engage' | 'break' | 'extend' | 'pullup' | 'patrol';

const _fwd = v3(), _up = v3(), _rel = v3(), _relV = v3(), _aim = v3();
const _des = v3(), _db = v3(), _upB = v3(), _tmp = v3(), _tmp2 = v3();
const _q: Q = { x: 0, y: 0, z: 0, w: 1 };

export interface AiTarget {
  state: EntityState;
  spec: AircraftSpec;
  alive: boolean;
}

export class AiPilot {
  readonly id: number;
  private spec: AircraftSpec;

  // --- personality, seeded so a squadron is not five clones ------------------
  /** 0.55 (cautious) … 1.0 (reckless). */
  private aggression: number;
  /** 0.6 … 1.0. Scales gun range, tracking gain and how hard it can be fooled. */
  private skill: number;
  /** Seconds between decisions — a human's OODA loop, not a frame. */
  private reaction: number;
  /** Aim error in radians, applied as a slowly wandering bias. */
  private aimBias: number;
  private phase: number;

  private mode: Mode = 'patrol';
  private modeTime = 0;
  private thinkTimer = 0;
  private targetId = 0;

  /** Held command, output between decisions. */
  private cmdPitch = 0;
  private cmdRoll = 0;
  private cmdYaw = 0;
  private cmdThrottle = 1;
  private cmdBits = 0;
  private fireHold = 0;
  /** Absolute times governing burst discipline. */
  private burstUntil = 0;
  private nextBurstAt = 0;

  /** AI's belief about the flap lever position, in detents. */
  private flapDetent = 0;

  /** Patrol waypoint. */
  private wpX = 0;
  private wpZ = 0;
  private wpAlt = 2400;

  constructor(id: number, spec: AircraftSpec) {
    this.id = id;
    this.spec = spec;
    const r1 = hash2(id, 1, 7717);
    const r2 = hash2(id, 2, 7717);
    const r3 = hash2(id, 3, 7717);
    const r4 = hash2(id, 4, 7717);
    this.aggression = 0.55 + r1 * 0.45;
    this.skill = 0.6 + r2 * 0.4;
    this.reaction = 0.10 + (1 - this.skill) * 0.22;
    this.aimBias = (r3 - 0.5) * 0.028 * (1.4 - this.skill);
    this.phase = r4 * Math.PI * 2;
    this.wpAlt = 1800 + r1 * 2600;
  }

  private lastRange = 0;
  private lastOff = 0;

  get currentMode(): Mode { return this.mode; }

  /** Snapshot for the debug overlay: what this pilot thinks it is doing. */
  get debugInfo(): { mode: Mode; target: number; range: number; offDeg: number; skill: number } {
    return {
      mode: this.mode,
      target: this.targetId,
      range: Math.round(this.lastRange),
      offDeg: +(this.lastOff * 180 / Math.PI).toFixed(1),
      skill: +this.skill.toFixed(2),
    };
  }

  /**
   * Produces the next input frame. Decisions are re-evaluated on the pilot's
   * own reaction clock; between decisions the previous command is held, which
   * is both cheaper and much more human than re-solving every frame.
   */
  think(
    self: EntityState, others: readonly AiTarget[], env: ClientEnv, dt: number, time: number,
    out: InputFrame,
  ): InputFrame {
    this.modeTime += dt;
    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      this.thinkTimer = this.reaction;
      this.decide(self, others, env, time);
    }

    // Trigger discipline: fire in bursts, never a continuous stream. Real
    // pilots did this to keep the guns cool and the sight steady.
    if (this.fireHold > 0) {
      this.fireHold -= dt;
      if (this.fireHold <= 0) this.cmdBits &= ~(InputBits.Fire1 | InputBits.Fire2);
    }

    out.seq = 0;
    out.dt = dt;
    out.pitch = this.cmdPitch;
    out.roll = this.cmdRoll;
    out.yaw = this.cmdYaw;
    out.throttle = this.cmdThrottle;
    out.bits = this.cmdBits;
    out.aimX = 0; out.aimY = 0;
    return out;
  }

  // -------------------------------------------------------------------------

  private decide(self: EntityState, others: readonly AiTarget[], env: ClientEnv, time: number): void {
    _q.x = self.qx; _q.y = self.qy; _q.z = self.qz; _q.w = self.qw;
    qrot(_q, FWD, _fwd);
    qrot(_q, UP, _up);

    const speed = Math.hypot(self.vx, self.vy, self.vz);
    const rho = env.airDensity(self.py);
    const vs = stallSpeed(this.spec, rho);
    const ground = env.terrainHeight(self.px, self.pz);
    const agl = self.py - ground;

    // A dead stick still points somewhere; stop flying it.
    if (self.damage & DamageBits.Destroyed) {
      this.cmdThrottle = 0;
      this.cmdPitch = this.cmdRoll = this.cmdYaw = 0;
      this.cmdBits = 0;
      return;
    }

    // -- 1. terrain, above all else -----------------------------------------
    if (this.avoidTerrain(self, env, speed, agl)) return;

    // -- 2. pick a target ---------------------------------------------------
    const target = this.selectTarget(self, others);
    const threat = this.findThreat(self, others);

    // -- 3. energy ----------------------------------------------------------
    // Specific energy in metres: the altitude this aircraft could trade its
    // speed for. This is the currency of every WWII engagement.
    const myEs = self.py + (speed * speed) / (2 * 9.80665);
    let deficit = 0;
    if (target) {
      const tSpeed = Math.hypot(target.state.vx, target.state.vy, target.state.vz);
      const tEs = target.state.py + (tSpeed * tSpeed) / (2 * 9.80665);
      deficit = tEs - myEs;
    }

    // -- 4. mode ------------------------------------------------------------
    const slow = speed < vs * 1.35;
    const threatened = threat !== null;

    let next: Mode = this.mode;
    if (!target) {
      next = 'patrol';
    } else if (threatened && (this.mode !== 'break' || this.modeTime < 3.5)) {
      next = 'break';
    } else if (this.mode === 'extend') {
      // Stay in the extend until the energy is back or we are clear.
      const dist = dist3(self, target.state);
      next = (deficit < -180 || dist > 3400 || this.modeTime > 14) ? 'engage' : 'extend';
    } else if ((deficit > 420 && !threatened) || (slow && deficit > 60)) {
      next = 'extend';
    } else {
      next = 'engage';
    }
    if (next !== this.mode) { this.mode = next; this.modeTime = 0; }

    this.targetId = target ? target.state.id : 0;

    switch (this.mode) {
      case 'break': this.doBreak(self, threat!, speed, vs); break;
      case 'extend': this.doExtend(self, target!, speed); break;
      case 'engage': this.doEngage(self, target!, speed, vs, time, agl); break;
      default: this.doPatrol(self, env, time, agl); break;
    }

    // Never command a stall: below 1.15 Vs the wing simply cannot deliver, and
    // pulling anyway is the classic AI death spiral.
    if (speed < vs * 1.15) {
      this.cmdPitch = Math.min(this.cmdPitch, 0.28);
      this.cmdThrottle = 1;
      this.cmdBits |= InputBits.Boost;
    }

    // Hard deck. Terrain avoidance above is reactive — it fires when the ground
    // is already on the flight path. This is the standing rule that keeps the
    // fight off the deck in the first place: below a speed-scaled floor the
    // pilot rolls upright and climbs, blended in by urgency so it nudges at the
    // top of the band and overrides completely at the bottom. Between the two,
    // an AI cannot lawn-dart itself out of the match.
    const deck = 380 + speed * 0.9;
    if (agl < deck) {
      const urgency = clamp((deck - agl) / deck, 0, 1);
      qrotInv(_q, WORLD_UP, _upB);
      const upright = _upB.y > 0.25;
      this.cmdRoll = this.cmdRoll * (1 - urgency) + clamp(_upB.x * 2.4, -1, 1) * urgency;
      // Only pull once the lift vector is above the horizon; while inverted a
      // pull is exactly the wrong input.
      const climb = upright ? 0.85 : -0.25;
      this.cmdPitch = this.cmdPitch * (1 - urgency) + climb * urgency;
      this.cmdThrottle = 1;
      if (urgency > 0.4) this.cmdBits &= ~(InputBits.Fire1 | InputBits.Fire2);
    }

    // Flap lever. FlapsUp/FlapsDown are *edge*-triggered, so holding the bit
    // and re-asserting it every decision would ratchet the flaps to full and
    // leave the aircraft mushing around at approach speed. Track the lever
    // position and pulse one detent at a time instead.
    this.cmdBits &= ~(InputBits.FlapsDown | InputBits.FlapsUp);
    // Combat flap is worth one detent in a slow turning fight and nothing else:
    // the extra lift buys turn radius, the drag costs energy.
    const wantDetent = (this.mode === 'break' || this.mode === 'engage')
      && speed < vs * 1.7 && speed > vs * 1.05 ? 1 : 0;
    if (wantDetent > this.flapDetent) { this.cmdBits |= InputBits.FlapsDown; this.flapDetent++; }
    else if (wantDetent < this.flapDetent) { this.cmdBits |= InputBits.FlapsUp; this.flapDetent--; }
  }

  // -------------------------------------------------------------------------
  // Behaviours
  // -------------------------------------------------------------------------

  /**
   * Looks along the flight path and pulls up if the ground is going to be in
   * the way. The horizon is checked at several times-of-flight so a shallow
   * dive toward a distant ridge is caught as well as an imminent impact.
   */
  private avoidTerrain(self: EntityState, env: ClientEnv, speed: number, agl: number): boolean {
    // Pull-up distance scales with speed: a 3 g recovery from 150 m/s needs
    // ~250 m of vertical and a couple of seconds.
    const horizon = clamp(speed * 0.11, 2.0, 7.0);
    let worst = Infinity;
    for (let i = 1; i <= 4; i++) {
      const t = (horizon * i) / 4;
      const x = self.px + self.vx * t;
      const y = self.py + self.vy * t - 0.5 * 3.0 * t * t * 0.15;
      const z = self.pz + self.vz * t;
      worst = Math.min(worst, y - env.terrainHeight(x, z));
    }
    const margin = 140 + speed * 1.8;
    if (worst > margin && agl > 55) {
      if (this.mode === 'pullup') { this.mode = 'patrol'; this.modeTime = 0; }
      return false;
    }

    if (this.mode !== 'pullup') { this.mode = 'pullup'; this.modeTime = 0; }
    // Roll upright first — pulling while inverted drives you into the deck.
    qrotInv(_q, WORLD_UP, _upB);
    const invert = _upB.y < 0.2;
    this.cmdRoll = clamp(_upB.x * 2.4, -1, 1);
    // Only start pulling once the lift vector is pointing at least somewhat up.
    // While still inverted a gentle *push* raises the nose in world terms;
    // pulling would drive us straight into the deck.
    this.cmdPitch = invert ? -0.2 : clamp(0.55 + (margin - worst) / margin, 0, 1);
    this.cmdYaw = 0;
    this.cmdThrottle = 1;
    this.cmdBits = InputBits.Boost;
    this.cmdBits &= ~(InputBits.Fire1 | InputBits.Fire2);
    return true;
  }

  private doEngage(
    self: EntityState, target: AiTarget, speed: number, vs: number, time: number, agl: number,
  ): void {
    const dist = this.leadSolution(self, target, speed);
    _des.x = _aim.x - self.px; _des.y = _aim.y - self.py; _des.z = _aim.z - self.pz;
    vnorm(_des, _des);

    // A little wander so a formation does not fly as a rigid lattice.
    const wob = Math.sin(time * 0.7 + this.phase) * 0.012 * (1.3 - this.skill);
    _des.x += wob; _des.y += this.aimBias + wob * 0.5;
    vnorm(_des, _des);

    this.steer(self, _des, speed, vs, agl);

    // Throttle: back off when closing far too fast, or we fly through the shot
    // and end up in front of the target's guns.
    const closing = this.closureRate(self, target.state);
    if (dist < 320 && closing > 55) this.cmdThrottle = 0.35;
    else if (dist < 180) this.cmdThrottle = 0.2;
    else this.cmdThrottle = 1;
    if (dist > 900 || closing < 0) this.cmdBits |= InputBits.Boost;
    else this.cmdBits &= ~InputBits.Boost;

    // Guns: converged solution, inside the belt's effective range, nose on.
    const cosOff = (_fwd.x * _des.x + _fwd.y * _des.y + _fwd.z * _des.z);
    const maxRange = 340 + 560 * this.skill;
    // Firing cone. A harmonised battery covers a couple of degrees, and a
    // pilot squeezes the trigger a little before the pipper is perfect —
    // demanding a sub-degree solution means the AI simply never shoots. It
    // opens up inside 250 m, where the target fills the sight.
    const coneDeg = (dist < 250 ? 5.5 : 2.6) + 2.6 * (1.2 - this.skill);
    const cone = Math.cos(coneDeg * Math.PI / 180);
    const solution = cosOff > cone && dist < maxRange && dist > 60;
    if (solution && time >= this.nextBurstAt) {
      // Open fire, and keep firing while the pipper stays on: a WWII burst ran
      // one to two seconds. Firing single frames produces a stream of isolated
      // rounds that neither hits anything nor reads as gunfire.
      if (time > this.burstUntil) this.burstUntil = time + 0.7 + this.aggression * 1.0;
    }
    if (solution && time < this.burstUntil) {
      this.cmdBits |= InputBits.Fire1;
      // Cannon only when the shot is genuinely good: ammunition is finite and a
      // pilot who sprays 20 mm at 800 m is not a good pilot.
      if (dist < maxRange * 0.7 && cosOff > Math.cos((coneDeg * 0.6) * Math.PI / 180)) {
        this.cmdBits |= InputBits.Fire2;
      }
    } else {
      if (this.cmdBits & (InputBits.Fire1 | InputBits.Fire2)) {
        // Burst over — let the guns and the pilot's aim settle.
        this.nextBurstAt = time + 0.55 + (1 - this.aggression) * 0.9;
      }
      this.cmdBits &= ~(InputBits.Fire1 | InputBits.Fire2);
    }
    this.fireHold = 0;
    this.lastRange = dist;
    this.lastOff = Math.acos(clamp(cosOff, -1, 1));
  }

  /**
   * Break turn: roll hard toward the attacker and pull maximum sustainable g,
   * out of the attacker's plane. Descending slightly keeps the speed up so the
   * turn does not decay into a stall.
   */
  private doBreak(self: EntityState, threat: AiTarget, speed: number, vs: number): void {
    _rel.x = threat.state.px - self.px;
    _rel.y = threat.state.py - self.py;
    _rel.z = threat.state.pz - self.pz;
    vnorm(_rel, _rel);

    // Perpendicular to the threat bearing, in the horizontal plane, chosen so
    // the turn is *into* the attacker — that is what forces an overshoot.
    _tmp.x = _rel.z; _tmp.y = 0; _tmp.z = -_rel.x;
    vnorm(_tmp, _tmp);
    // Pick the side the aircraft is already banked toward, so the break starts
    // immediately instead of reversing first.
    const side = (_up.x * _tmp.x + _up.y * _tmp.y + _up.z * _tmp.z) >= 0 ? 1 : -1;
    _des.x = _tmp.x * side - _rel.x * 0.25;
    _des.y = -0.30;                      // unload downhill to hold energy
    _des.z = _tmp.z * side - _rel.z * 0.25;
    vnorm(_des, _des);

    this.steer(self, _des, speed, vs, 9999);
    this.cmdPitch = clamp(this.cmdPitch + 0.5, -1, 1);   // ride the buffet
    this.cmdThrottle = 1;
    this.cmdBits |= InputBits.Boost;
    this.cmdBits &= ~(InputBits.Fire1 | InputBits.Fire2);
  }

  /** Disengage: nose down 20°, away from the threat, everything forward. */
  private doExtend(self: EntityState, target: AiTarget, speed: number): void {
    _des.x = self.px - target.state.px;
    _des.y = 0;
    _des.z = self.pz - target.state.pz;
    vnorm(_des, _des);
    // Shallow dive; steeper if we are also low on speed.
    _des.y = speed < 120 ? -0.42 : -0.18;
    vnorm(_des, _des);
    this.steer(self, _des, speed, 0, 9999);
    this.cmdThrottle = 1;
    this.cmdBits |= InputBits.Boost;
    this.cmdBits &= ~(InputBits.Fire1 | InputBits.Fire2 | InputBits.FlapsDown);
  }

  /** No contact: cruise a racetrack at a sensible altitude. */
  private doPatrol(self: EntityState, env: ClientEnv, time: number, agl: number): void {
    const d = Math.hypot(self.px - this.wpX, self.pz - this.wpZ);
    if (d < 900 || (this.wpX === 0 && this.wpZ === 0)) {
      const a = hash2(this.id, Math.floor(time / 40), 31) * Math.PI * 2;
      const r = 6000 + hash2(this.id, Math.floor(time / 40), 47) * 9000;
      this.wpX = Math.cos(a) * r;
      this.wpZ = Math.sin(a) * r;
    }
    const groundAtWp = env.terrainHeight(this.wpX, this.wpZ);
    _des.x = this.wpX - self.px;
    _des.y = (groundAtWp + this.wpAlt) - self.py;
    _des.z = this.wpZ - self.pz;
    // Limit the commanded climb/dive angle so patrol legs stay level-ish.
    const horiz = Math.hypot(_des.x, _des.z) || 1;
    _des.y = clamp(_des.y, -horiz * 0.35, horiz * 0.35);
    vnorm(_des, _des);
    this.steer(self, _des, Math.hypot(self.vx, self.vy, self.vz), 0, agl);
    this.cmdThrottle = 0.82;
    this.cmdBits &= ~(InputBits.Fire1 | InputBits.Fire2 | InputBits.Boost | InputBits.FlapsDown);
  }

  // -------------------------------------------------------------------------
  // Steering
  // -------------------------------------------------------------------------

  /**
   * Turns a desired world direction into stick and rudder.
   *
   * The aeroplane turns by *rolling* its lift vector onto the target and then
   * pulling — it does not yaw its way around. So: bank to put the target in the
   * vertical plane, then pull as hard as the wing and the airframe allow, with
   * rudder used only for the last degree of tracking.
   *
   * Sign conventions match the flight model: positive 'pitch' is nose-down,
   * positive 'roll' rolls right, positive 'yaw' yaws right.
   */
  private steer(self: EntityState, desiredWorld: V3, speed: number, vs: number, agl: number): void {
    qrotInv(_q, desiredWorld, _db);

    const lateral = Math.hypot(_db.x, _db.y);
    // Bank angle that puts body-up on the target. atan2(x, y) is 0 when the
    // target is straight above and ±π/2 when it is abeam.
    let bank = lateral > 0.015 ? Math.atan2(_db.x, _db.y) : 0;
    if (lateral <= 0.015) {
      // Essentially on the nose: hold wings level instead of chasing noise.
      qrotInv(_q, WORLD_UP, _upB);
      bank = Math.atan2(_upB.x, Math.max(0.05, _upB.y));
    }
    // Do not roll fully inverted to chase something barely off the nose.
    this.cmdRoll = clamp(bank * (1.05 + 0.5 * this.skill), -1, 1);

    // Pull: proportional to how far off the nose the target is, saturating to
    // full deflection once it is more than ~35° out.
    let pull = lateral;
    if (_db.z < 0) pull = 1;                         // behind us: pull to the limit
    pull = clamp(pull * (2.3 + 1.4 * this.skill), 0, 1);
    // Only pull once the roll is roughly there; pulling early just carves a
    // barrel roll and bleeds energy for nothing.
    const rollDone = 1 - clamp(Math.abs(this.cmdRoll) * 0.7, 0, 0.75);
    // Positive pitch is stick back: this is the pull.
    this.cmdPitch = pull * rollDone * this.aggression;

    // Flight-path hold. Pointing the nose at something is not the same as
    // *going* there: a stable aeroplane with neutral elevator trims nose-down
    // and mushes toward the ground. So close the loop on the velocity vector
    // as well as the nose, and hold whatever climb angle the desired direction
    // implies. Without this the AI slowly flies itself into the sea while its
    // gunsight stays perfectly on target.
    if (speed > 12) {
      const gammaWant = clamp(desiredWorld.y, -0.9, 0.9);
      const gammaNow = clamp(self.vy / speed, -0.99, 0.99);
      // Only meaningful when the wings are near level; in a hard bank the pull
      // term is already commanding everything the wing can give.
      const wings = 1 - clamp(lateral * 2.2, 0, 1);
      this.cmdPitch += clamp((gammaWant - gammaNow) * 2.4, -0.45, 0.75) * wings;
    }
    this.cmdPitch = clamp(this.cmdPitch, -1, 1);

    // Rudder trims out the last of the lateral error when nearly aligned.
    this.cmdYaw = lateral < 0.10 ? clamp(_db.x * 3.2, -0.45, 0.45) : 0;

    // Low and slow: never command a hard pull near the deck.
    if (agl < 260) this.cmdPitch = Math.min(this.cmdPitch, 0.55);
    // Below roughly corner speed the wing cannot convert stick into turn rate,
    // it only converts it into drag. Taper the pull so the AI keeps its energy
    // instead of grinding the fight down to a mushing scissors on the deck.
    if (vs > 0 && this.cmdPitch > 0) {
      this.cmdPitch *= clamp(speed / (vs * 2.3), 0.35, 1);
    }
  }

  // -------------------------------------------------------------------------
  // Situational awareness
  // -------------------------------------------------------------------------

  private selectTarget(self: EntityState, others: readonly AiTarget[]): AiTarget | null {
    let best: AiTarget | null = null;
    let bestScore = -Infinity;
    for (const o of others) {
      if (!o.alive || o.state.team === self.team || o.state.id === self.id) continue;
      if (o.state.damage & DamageBits.Destroyed) continue;
      _rel.x = o.state.px - self.px; _rel.y = o.state.py - self.py; _rel.z = o.state.pz - self.pz;
      const d = vlen(_rel);
      if (d > 7000 || d < 1e-3) continue;
      const cos = (_fwd.x * _rel.x + _fwd.y * _rel.y + _fwd.z * _rel.z) / d;
      // Prefer close targets already near the nose; heavily penalise anything
      // behind, because turning 180° for a distant bandit wastes the fight.
      let score = -d * 0.0012 + cos * 2.4;
      if (o.state.id === this.targetId) score += 0.9;    // target persistence
      if (o.state.health < 0.5) score += 0.7;            // finish the cripple
      if (score > bestScore) { bestScore = score; best = o; }
    }
    return best;
  }

  /** Anyone behind us, in range, with their nose on us. */
  private findThreat(self: EntityState, others: readonly AiTarget[]): AiTarget | null {
    let best: AiTarget | null = null;
    let bestD = Infinity;
    for (const o of others) {
      if (!o.alive || o.state.team === self.team || o.state.id === self.id) continue;
      if (o.state.damage & DamageBits.Destroyed) continue;
      _rel.x = self.px - o.state.px; _rel.y = self.py - o.state.py; _rel.z = self.pz - o.state.pz;
      const d = vlen(_rel);
      if (d > 1100 || d < 1e-3) continue;
      _q2.x = o.state.qx; _q2.y = o.state.qy; _q2.z = o.state.qz; _q2.w = o.state.qw;
      qrot(_q2, FWD, _tmp2);
      const cos = (_tmp2.x * _rel.x + _tmp2.y * _rel.y + _tmp2.z * _rel.z) / d;
      // Their guns track us if we are inside ~14° of their nose. A better pilot
      // notices sooner and from further out.
      const cone = Math.cos((10 + 8 * (1.2 - this.skill)) * Math.PI / 180);
      if (cos > cone && d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  /**
   * Iterative lead solution. Writes the aim point into '_aim' and returns the
   * present range.
   *
   * Three fixed-point iterations converge to well under a metre at fighter
   * speeds, which is far tighter than the gun's own dispersion.
   */
  private leadSolution(self: EntityState, target: AiTarget, speed: number): number {
    const gun = bestGun(this.spec);
    const muzzle = gun ? gun.muzzle : 800;

    _rel.x = target.state.px - self.px;
    _rel.y = target.state.py - self.py;
    _rel.z = target.state.pz - self.pz;
    _relV.x = target.state.vx - self.vx;
    _relV.y = target.state.vy - self.vy;
    _relV.z = target.state.vz - self.vz;

    const range = vlen(_rel);
    let t = range / Math.max(80, muzzle);
    for (let i = 0; i < 3; i++) {
      const x = _rel.x + _relV.x * t;
      const y = _rel.y + _relV.y * t;
      const z = _rel.z + _relV.z * t;
      t = Math.hypot(x, y, z) / Math.max(80, muzzle);
    }
    // Rounds also lose speed to drag, so the real time of flight is longer than
    // the vacuum solution — roughly 12 % over typical gunnery ranges.
    t *= 1.12;

    // The round leaves with the shooter's velocity added, so the intercept is
    // solved in the *relative* frame: aim where the target will be relative to
    // us, then translate that offset back out from our present position. The
    // barrel is raised by the ballistic drop over the same time of flight.
    _aim.x = self.px + _rel.x + _relV.x * t;
    _aim.y = self.py + _rel.y + _relV.y * t + 0.5 * 9.80665 * t * t;
    _aim.z = self.pz + _rel.z + _relV.z * t;
    void speed;
    return range;
  }

  private closureRate(self: EntityState, t: EntityState): number {
    _rel.x = t.px - self.px; _rel.y = t.py - self.py; _rel.z = t.pz - self.pz;
    const d = vlen(_rel) || 1;
    const rvx = self.vx - t.vx, rvy = self.vy - t.vy, rvz = self.vz - t.vz;
    return (rvx * _rel.x + rvy * _rel.y + rvz * _rel.z) / d;
  }
}

const _q2: Q = { x: 0, y: 0, z: 0, w: 1 };

function dist3(a: EntityState, b: EntityState): number {
  return Math.hypot(a.px - b.px, a.py - b.py, a.pz - b.pz);
}

/** Level-flight stall speed at the given density. */
export function stallSpeed(spec: AircraftSpec, rho: number, n = 1): number {
  return Math.sqrt((2 * spec.aero.mass * 9.80665 * n) / (rho * spec.aero.wingArea * spec.aero.clMax));
}

/** The gun the pilot aims with: the one with the most barrels, ties to bigger. */
function bestGun(spec: AircraftSpec) {
  let best = spec.guns[0];
  for (const g of spec.guns) {
    if (!best) { best = g; continue; }
    if (g.count > best.count || (g.count === best.count && g.calibre > best.calibre)) best = g;
  }
  return best;
}
