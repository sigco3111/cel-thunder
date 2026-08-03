import * as THREE from 'three';
import { EntityKind, type EntityState } from '../shared/protocol';
import { aircraftByIndex } from '../shared/aircraft';
import { resetSpawn } from './ParticleEngine';
import { RAMP, TILE } from './VfxTextures';
import { spawnImpactAt, spawnMuzzleFlash } from './Gunfire';
import { spawnExplosionAt } from './Explosions';
import type { VfxCore } from './VfxCore';
import type { EntityFxRegistry } from './EntityFx';
import type { SmokeSources } from './Environment';
import type { GameContext } from '../engine/context';

/**
 * Combat staging for the screenshot framings.
 *
 * The named framings (src/engine/camera/framings.ts) each broadcast a 'scene'
 * directive on the bus — "there is an opponent at this bearing", "the subject
 * is firing", "there are ground targets below", "the subject is on fire". Every
 * one of those was inert: the camera was composed around a fight that nobody
 * ever staged, so 'dogfight' was one aeroplane and a speck, and 'ground_attack'
 * was an aeroplane over empty farmland. A framing called ground_attack that
 * contains no attack is not a composition problem, it is an empty frame.
 *
 * This module is the VFX half of honouring that directive. It cannot spawn
 * entities or fire the real weapon systems — those live in subsystems this one
 * must not touch — but every *visible* consequence of a gun firing is a VFX
 * concern, and all of it can be driven from the replicated entity set that is
 * already on the context:
 *
 *   - muzzle flashes at the real gun mounts from the aircraft spec,
 *   - tracers in flight along the actual aiming solution, at real muzzle
 *     velocity, thinned to the right tracer-to-ball ratio,
 *   - strikes on the target: sparks, paint, and a smoking engine once it has
 *     been hit enough,
 *   - a strafing line walking across the ground, and burning ground targets
 *     with real smoke columns and real light.
 *
 * It is armed only by a 'debug:scene' directive, so nothing here runs in a
 * normal match — the live combat systems own that, and two of us emitting
 * muzzle flashes for the same trigger pull would double every effect.
 */

export interface SceneDirective {
  opponent?: { bearing: number; range: number; bank: number } | null;
  damage?: number;
  fire?: number;
  smoke?: number;
  firing?: boolean;
  groundTargets?: boolean;
  biome?: string;
  hud?: boolean;
  gear?: boolean;
  flaps?: number;
}

const _q = new THREE.Quaternion();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();

/** Gun groups we will drive. Two is what an aircraft actually has. */
const MAX_GROUPS = 2;

/** Ground targets staged for a 'groundTargets' directive. */
const MAX_TARGETS = 6;

export class CombatStaging {
  /** False until a framing asks for something. Nothing runs before that. */
  private armed = false;

  private firing = false;
  private wantGroundTargets = false;
  private subjectDamage = 0;

  /** Per-gun-group time until the next round leaves the barrel. */
  private gunTimer = [0, 0];
  /** Rounds fired per group, for the tracer-every-Nth rule. */
  private gunCount = [0, 0];

  /** Burst rhythm: a pilot fires in bursts, not one continuous stream. */
  private burstTimer = 0;
  private bursting = true;

  private strafeTimer = 0;
  private hitTimer = 0;

  private targetIds: number[] = [];
  private targetsPlacedFor = -1;

  /** Entities the staged damage has been applied to, so it can be undone. */
  private markedTarget = 0;
  private markedSubject = 0;
  /** Seconds of sustained hits on it, which is what escalates the damage. */
  private hitSeconds = 0;

  /**
   * Applies a framing's scene directive. Idempotent — the harness re-applies
   * framings freely and this must not accumulate.
   */
  apply(
    d: SceneDirective | null | undefined,
    sources: SmokeSources,
    entities: EntityFxRegistry,
  ): void {
    // Damage staged for the *previous* shot has to be taken back off, or the
    // harness's shot order leaks: 'damage' sets an engine fire, and every
    // framing captured after it inherits a burning hero aircraft. extraBits is
    // sticky by design (it is how a caller pins damage on), so clearing it is
    // this module's job, not the registry's.
    if (this.markedSubject) entities.attach(this.markedSubject, null, 0);
    if (this.markedTarget) entities.attach(this.markedTarget, null, 0);
    this.markedSubject = 0;
    this.markedTarget = 0;
    this.hitSeconds = 0;

    this.armed = true;
    this.firing = d?.firing === true;
    this.wantGroundTargets = d?.groundTargets === true;
    this.subjectDamage = d?.damage ?? 0;

    // Ground targets are placed relative to the subject, which has just been
    // teleported by the framing; drop the previous shot's and re-place on the
    // next update once the new subject pose has replicated.
    for (const id of this.targetIds) sources.remove(id);
    this.targetIds.length = 0;
    this.targetsPlacedFor = -1;

    this.gunTimer[0] = 0; this.gunTimer[1] = 0.03;
    this.burstTimer = 0;
    this.bursting = true;
    this.strafeTimer = 0;
    this.hitTimer = 0;
  }

  clear(sources: SmokeSources): void {
    for (const id of this.targetIds) sources.remove(id);
    this.targetIds.length = 0;
    this.targetsPlacedFor = -1;
    this.armed = false;
    this.firing = false;
    this.wantGroundTargets = false;
    this.markedTarget = 0;
    this.markedSubject = 0;
  }

  // -------------------------------------------------------------------------

  update(core: VfxCore, ctx: GameContext, entities: EntityFxRegistry, sources: SmokeSources): void {
    if (!this.armed) return;

    const subject = this.resolveSubject(ctx);
    if (!subject) return;

    basisOf(subject);

    // The subject's own damage, in case the entity layer did not apply the
    // framing's bits. extraBits is OR-ed with the replicated damage word, so
    // this can only ever add to what the sim already says.
    if (this.subjectDamage) {
      this.markedSubject = subject.id;
      entities.attach(subject.id, null, this.subjectDamage);
    }

    if (this.wantGroundTargets) this.stageGroundTargets(core, ctx, subject, sources);

    if (!this.firing) return;

    const target = this.resolveTarget(ctx, subject);
    this.aimAt(subject, target);

    // Burst discipline. A continuous stream from a fighter's guns is both wrong
    // and visually worse — the frame fills with an even hail and there is no
    // rhythm to it. The duty cycle is heavily biased toward firing, though,
    // because the screenshot harness opens the shutter at an arbitrary moment:
    // at a one-second burst and a half-second pause, a third of the captures
    // caught the gap and 'dogfight' came out with nothing happening in it.
    this.burstTimer -= core.dt;
    if (this.burstTimer <= 0) {
      this.bursting = !this.bursting;
      this.burstTimer = this.bursting ? core.rand(1.8, 3.0) : core.rand(0.20, 0.40);
    }

    if (this.bursting) this.fireGuns(core, ctx, subject);
    if (target) this.strikeTarget(core, subject, target, entities);
    else this.strafeGround(core, subject);
  }

  // -------------------------------------------------------------------------

  /**
   * The aircraft the framing is about.
   *
   * The local entity when there is one, but offline 'ctx.localEntityId' is
   * often still 0, and picking "the first aircraft in the map" then hands the
   * subject role to the *opponent* — at which point the staging shoots at, and
   * sets fire to, the very aeroplane the shot is composed around. Falling back
   * to the aircraft nearest the camera is correct for every framing in the set,
   * because all of them put the subject on a short boom and the opponent
   * hundreds of metres away.
   */
  private resolveSubject(ctx: GameContext): EntityState | null {
    const local = ctx.entities.get(ctx.localEntityId);
    if (local && local.kind === EntityKind.Aircraft) return local;
    const cp = ctx.camera.position;
    let best: EntityState | null = null;
    let bestD2 = Infinity;
    for (const e of ctx.entities.values()) {
      if (e.kind !== EntityKind.Aircraft) continue;
      const dx = e.px - cp.x, dy = e.py - cp.y, dz = e.pz - cp.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = e; }
    }
    return best;
  }

  /** The nearest other aircraft roughly ahead of the subject, if any. */
  private resolveTarget(ctx: GameContext, subject: EntityState): EntityState | null {
    let best: EntityState | null = null;
    let bestD2 = 2.5e6;   // 1.6 km — beyond that it is not a gunnery target
    for (const e of ctx.entities.values()) {
      if (e === subject || e.kind !== EntityKind.Aircraft) continue;
      const dx = e.px - subject.px, dy = e.py - subject.py, dz = e.pz - subject.pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > bestD2) continue;
      // Forward hemisphere only; you cannot shoot at something behind you.
      if (dx * _fwd.x + dy * _fwd.y + dz * _fwd.z < 0) continue;
      best = e; bestD2 = d2;
    }
    return best;
  }

  /**
   * The direction the guns point, into '_aim'.
   *
   * With a target this is a first-order lead solution: aim where the target
   * will be after the rounds' time of flight. Without one it is the body
   * forward axis, which is what a strafing pass looks like anyway.
   */
  private aimAt(subject: EntityState, target: EntityState | null): void {
    if (!target) { _aim.copy(_fwd); return; }
    _aim.set(target.px - subject.px, target.py - subject.py, target.pz - subject.pz);
    const range = _aim.length();
    // ~870 m/s at the muzzle, and drag costs roughly a fifth of that over the
    // first half-kilometre; 700 is a fair effective average for a lead solve.
    const tof = range / 700;
    _aim.set(
      target.px + (target.vx - subject.vx) * tof - subject.px,
      target.py + (target.vy - subject.vy) * tof - subject.py,
      target.pz + (target.vz - subject.vz) * tof - subject.pz,
    ).normalize();
  }

  // -------------------------------------------------------------------------

  private fireGuns(core: VfxCore, ctx: GameContext, subject: EntityState): void {
    const spec = aircraftByIndex(subject.typeId);
    const now = core.time;
    const p = resetSpawn();
    const groups = Math.min(MAX_GROUPS, spec.guns.length);

    for (let g = 0; g < groups; g++) {
      const gun = spec.guns[g];
      // Cyclic rate is per barrel; the whole battery's rate is that times the
      // number of barrels, and that is what sets the visible tracer spacing.
      const period = 60 / Math.max(120, gun.rpm * gun.count);
      this.gunTimer[g] -= core.dt;
      if (this.gunTimer[g] > 0) continue;
      this.gunTimer[g] = period;

      const mounts = gun.mounts;
      const mi = this.gunCount[g] % Math.max(1, mounts.length);
      const m = mounts[mi] ?? [0, 0, 1];
      this.gunCount[g]++;

      _muzzle.set(subject.px, subject.py, subject.pz)
        .addScaledVector(_right, m[0])
        .addScaledVector(_up, m[1])
        .addScaledVector(_fwd, m[2]);

      spawnMuzzleFlash(core, _muzzle.x, _muzzle.y, _muzzle.z, _aim.x, _aim.y, _aim.z, {
        calibre: gun.calibre,
        tint: gun.tracer,
        casings: true,
        vx: subject.vx, vy: subject.vy, vz: subject.vz,
        rx: _right.x, ry: _right.y, rz: _right.z,
        // No shake: this is a staged frame and a camera that is buzzing while
        // the shutter is open smears the whole shot.
        shake: 0,
      });

      const tr = ((gun.tracer >> 16) & 0xff) / 255;
      const tg = ((gun.tracer >> 8) & 0xff) / 255;
      const tb = (gun.tracer & 0xff) / 255;

      // Dispersion: a real battery is harmonised to converge, so the cone is
      // tight — about 2 mrad, which is a metre and a half at 700 m.
      core.cone(_tmp, _aim.x, _aim.y, _aim.z, 0.004);
      const speed = gun.muzzle;
      p.x = _muzzle.x + _tmp.x * 1.2;
      p.y = _muzzle.y + _tmp.y * 1.2;
      p.z = _muzzle.z + _tmp.z * 1.2;
      p.vx = subject.vx + _tmp.x * speed;
      p.vy = subject.vy + _tmp.y * speed;
      p.vz = subject.vz + _tmp.z * speed;
      // 1.5 s is about 900 m of travel — past the point where the round has
      // dropped out of the sight picture anyway.
      p.life = 1.5;
      // Fat, on purpose. A tracer is a burning pellet a couple of centimetres
      // across, and rendering it at true scale gives a sub-pixel sprite that
      // the coverage threshold erases entirely past about 200 m — which is
      // exactly the range at which tracers matter. Half a metre puts a 20 mm
      // round at seven or eight pixels across the frame at gunnery range and
      // one or two at the far end, which is what gun-camera footage shows, and
      // the bloom layer does the rest.
      p.size0 = 0.17 + gun.calibre * 0.011;
      p.size1 = p.size0 * 0.6;
      p.rot = 0; p.spin = 0;
      // Barely any drag and a light gravity bias: over 900 m a real round drops
      // several metres and the trail visibly sags, which is a large part of why
      // tracer fire reads as *ballistic* rather than as a laser.
      p.drag = 0.09; p.grav = 0.55; p.wind = 0.05; p.turb = 0;
      // 'stretch' is extra length per m/s of apparent motion. A round crossing
      // the frame at 800 m/s draws a streak around ten metres long, and one
      // flying straight away from the camera correctly collapses to a dot —
      // which is exactly how gun-camera footage looks. 0.11 gave a *forty*
      // metre streak: at thirty rounds a second that is longer than the gap
      // between them, so the burst fused into an unbroken white line across the
      // frame. Tracer fire has to read as a comb of dashes.
      p.stretch = 0.028;
      p.ramp = RAMP.Ricochet; p.tile = TILE.Streak;
      p.erode = 0; p.band = 1.6;
      // Carry the round's own tracer colour, weighted so it survives the bloom
      // pass: a pure-white streak reads as a scratch on the lens, a warm one as
      // burning phosphorus.
      p.r = 0.75 + tr * 0.25; p.g = 0.35 + tg * 0.55; p.b = 0.12 + tb * 0.55;
      p.a = 1;
      core.spark.emit(now, p);
      p.stretch = 0;
    }
    void ctx;
  }

  /**
   * Rounds arriving on the target: sparks, paint and — once the target has
   * taken enough — a smoking, then burning, engine.
   */
  private strikeTarget(
    core: VfxCore, subject: EntityState, target: EntityState, entities: EntityFxRegistry,
  ): void {
    this.hitTimer -= core.dt;
    if (this.hitTimer > 0) return;
    // Not every round connects. A hit every ~200 ms is a plausible strike rate
    // for a fighter holding a firing solution, and it reads as a stream of
    // sparks walking over the target rather than as a single event.
    this.hitTimer = core.rand(0.13, 0.30);
    if (!this.bursting) return;

    basisOfTarget(target);
    const spec = aircraftByIndex(target.typeId);
    const half = spec.geom.length * 0.35;
    _tmp.set(target.px, target.py, target.pz)
      .addScaledVector(_bFwd, core.sym(half))
      .addScaledVector(_bRight, core.sym(spec.aero.span * 0.28))
      .addScaledVector(_bUp, core.sym(0.5));

    // The normal faces back toward the shooter — that is where the spall goes.
    _muzzle.set(subject.px - _tmp.x, subject.py - _tmp.y, subject.pz - _tmp.z).normalize();
    spawnImpactAt(core, _tmp.x, _tmp.y, _tmp.z, _muzzle.x, _muzzle.y, _muzzle.z, 'metal', 20);

    // Damage accumulates on the thing being shot at — the whole point of a
    // dogfight frame is a target that is visibly losing. It escalates on a
    // clock rather than a coin flip so the shot is reproducible: a smoking
    // engine straight away (Engine | OilLeak), a fire only after several
    // seconds of sustained hits, which is also how long it really takes.
    if (this.markedTarget !== target.id) {
      this.markedTarget = target.id;
      this.hitSeconds = 0;
      entities.attach(target.id, null, (1 << 6) | (1 << 9));
    }
    this.hitSeconds += 0.2;
    entities.attach(
      target.id, null,
      this.hitSeconds > 4 ? (1 << 6) | (1 << 9) | (1 << 7) : (1 << 6) | (1 << 9),
    );
  }

  /** A strafing line walking across the ground ahead of the aircraft. */
  private strafeGround(core: VfxCore, subject: EntityState): void {
    this.strafeTimer -= core.dt;
    if (this.strafeTimer > 0 || !this.bursting) return;
    this.strafeTimer = core.rand(0.05, 0.12);

    // Where the aim line meets the ground. Solved iteratively because the
    // terrain is not a plane: three steps converge on anything but a cliff.
    let t = 200;
    for (let i = 0; i < 4; i++) {
      const x = subject.px + _aim.x * t;
      const z = subject.pz + _aim.z * t;
      const gy = core.terrain.height(x, z);
      const y = subject.py + _aim.y * t;
      if (_aim.y >= -0.02) return;        // not pointed at the ground
      t += (y - gy) / -_aim.y;
      if (t < 0 || t > 3000) return;
    }
    // Walk the burst along the ground the way a moving gun platform does.
    const x = subject.px + _aim.x * t + core.sym(4);
    const z = subject.pz + _aim.z * t + core.sym(4);
    const y = core.terrain.height(x, z);
    core.terrain.normal(x, z, _tmp);
    spawnImpactAt(core, x, y + 0.15, z, _tmp.x, _tmp.y, _tmp.z, core.terrain.type(x, z), 20);
  }

  // -------------------------------------------------------------------------

  /**
   * Burning ground targets under the flight path.
   *
   * Placed once, on the first frame after a framing lands, along the aircraft's
   * own ground track so they are inside the frustum of a shot composed around
   * that aircraft — scattering them at map coordinates would put them off
   * camera about four times in five.
   */
  private stageGroundTargets(
    core: VfxCore, ctx: GameContext, subject: EntityState, sources: SmokeSources,
  ): void {
    if (this.targetsPlacedFor === ctx.frame) return;
    if (this.targetIds.length > 0) return;
    // Wait for the subject to have a real pose — immediately after a framing
    // teleport the replicated state can still be the pre-jump one.
    if (!Number.isFinite(subject.px) || (subject.px === 0 && subject.pz === 0)) return;
    this.targetsPlacedFor = ctx.frame;

    // Ground track, flattened. The targets march away down it so the frame gets
    // depth: one close and large, several receding.
    _tmp.set(_fwd.x, 0, _fwd.z);
    if (_tmp.lengthSq() < 1e-5) _tmp.set(0, 0, 1);
    _tmp.normalize();
    const sx = -_tmp.z, sz = _tmp.x;    // ground-plane right

    let placed = 0;
    for (let i = 0; i < MAX_TARGETS; i++) {
      // Staggered down the track from just ahead of the nose to the far side of
      // the field, so the frame gets depth: one close and large, several
      // receding toward the horizon.
      const along = 130 + i * core.rand(120, 220);
      const across = core.sym(90);
      const x = subject.px + _tmp.x * along + sx * across;
      const z = subject.pz + _tmp.z * along + sz * across;
      const y = core.terrain.height(x, z);
      if (y <= 0.5) continue;            // do not set the sea on fire
      // Scale is the column's girth in metres: a burning lorry is 2, a fuel
      // dump 6. Mixed sizes make the line read as a target *area*.
      const scale = i === 0 ? core.rand(7.0, 10.0) : core.rand(3.0, 6.0);
      const id = sources.add(x, y + 0.4, z, scale, 1, Infinity, RAMP.SmokeBlack);
      if (!id) continue;
      this.targetIds.push(id);
      placed++;

      // Back-date the column so the target has visibly been burning rather than
      // having caught fire the instant the shutter opened. Staggered ages give
      // the line a history: the far end has been alight for half a minute, the
      // near one has just been hit.
      sources.prime(core, id, 8 + i * 3.5);

      // ...and a fresh explosion on the nearest one, so the shot also contains
      // the moment of impact.
      if (i < 2) spawnExplosionAt(core, x, y + scale * 0.3, z, scale * 0.55, 'ground');
      const crater = core.count(4, x, y, z);
      for (let k = 0; k < crater; k++) {
        const cx = x + core.sym(scale * 3);
        const cz = z + core.sym(scale * 3);
        const cy = core.terrain.height(cx, cz);
        core.terrain.normal(cx, cz, _tmp2);
        spawnImpactAt(core, cx, cy + 0.1, cz, _tmp2.x, _tmp2.y, _tmp2.z,
          core.terrain.type(cx, cz), 24);
      }
    }
    // Nothing took (all sea, or the pool was full): retry next frame rather
    // than latching an empty result for the rest of the shot.
    if (placed === 0) this.targetsPlacedFor = -1;
  }
}

// ---------------------------------------------------------------------------

const _bRight = new THREE.Vector3();
const _bUp = new THREE.Vector3();
const _bFwd = new THREE.Vector3();

function basisOf(e: EntityState): void {
  _q.set(e.qx, e.qy, e.qz, e.qw).normalize();
  _right.set(1, 0, 0).applyQuaternion(_q);
  _up.set(0, 1, 0).applyQuaternion(_q);
  _fwd.set(0, 0, 1).applyQuaternion(_q);
}

function basisOfTarget(e: EntityState): void {
  _q.set(e.qx, e.qy, e.qz, e.qw).normalize();
  _bRight.set(1, 0, 0).applyQuaternion(_q);
  _bUp.set(0, 1, 0).applyQuaternion(_q);
  _bFwd.set(0, 0, 1).applyQuaternion(_q);
}
