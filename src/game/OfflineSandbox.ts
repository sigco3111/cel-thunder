import type { GameContext } from '../engine/context';
import {
  DamageBits, EntityKind, EventKind, InputBits,
  newEntityState, type EntityState, type InputFrame,
} from '../shared/protocol';
import {
  AIRCRAFT_BY_ID, aircraftIndex, nationTeam, type AircraftSpec,
} from '../shared/aircraft';
import { clamp, q, qFromEuler, qrot, v3, type Q, type V3 } from '../shared/math';
import type { ClientEnv } from './env';
import {
  readFlightTransform, writeFlightTransform, readFlightScalar, newFlightTransform,
  type FlightModule, type FlightState, type FlightTransform,
} from './externals';
import { AiPilot } from './ai/AiPilot';

/**
 * A complete single-player match, run entirely on the client.
 *
 * This exists so the game is playable, demoable and screenshottable with no
 * server at all — but it is not a mock. It runs the same flight model, the
 * same ballistics and the same damage bits the server does, and it drives real
 * 'EntityState' records through 'ctx.entities', so every downstream subsystem
 * (rendering, tracers, damage visuals, audio, HUD) behaves exactly as it does
 * online. If it looks right here, it looks right in a match.
 */

const FWD: V3 = { x: 0, y: 0, z: 1 };

/** Sandbox roster: a balanced six-ship, one of which is the player. */
const ROSTER: Array<{ id: string; ai: boolean }> = [
  { id: 'spitfire_mk9', ai: false },
  { id: 'p51d', ai: true },
  { id: 'la5fn', ai: true },
  { id: 'bf109_g6', ai: true },
  { id: 'bf109_g6', ai: true },
  { id: 'a6m5', ai: true },
];

const RESPAWN_DELAY = 7;
const PROJECTILE_LIFE = 4.0;
const HIT_RADIUS = 5.5;

interface Actor {
  entityId: number;
  spec: AircraftSpec;
  typeId: number;
  team: number;
  flight: FlightState;
  state: EntityState;
  ai: AiPilot | null;
  /** Per-gun cooldown, seconds. */
  gunCd: number[];
  /** Remaining rounds per gun, per barrel. */
  ammo: number[];
  alive: boolean;
  respawnAt: number;
  input: InputFrame;
  /** Set once, so the bailout only fires a single time per death. */
  bailed: boolean;
}

interface Projectile {
  id: number;
  live: boolean;
  shooter: number;
  team: number;
  calibre: number;
  he: number;
  mass: number;
  life: number;
  state: EntityState;
}

const _t: FlightTransform = newFlightTransform();
const _rot: Q = q();
const _mount: V3 = v3();
const _fwd: V3 = v3();

export class OfflineSandbox {
  private ctx: GameContext;
  private env: ClientEnv;
  private flightMod: FlightModule;

  private actors: Actor[] = [];
  private projectiles: Projectile[] = [];
  private nextEntityId = 1;
  private nextProjectileId = 20000;
  private time = 0;

  /** The player's actor, which the local prediction path also owns. */
  playerActor!: Actor;

  constructor(ctx: GameContext, env: ClientEnv, flightMod: FlightModule) {
    this.ctx = ctx;
    this.env = env;
    this.flightMod = flightMod;
  }

  /**
   * Builds the roster. Everyone starts airborne and already merged — a sandbox
   * that begins with six aircraft taxiing is useless for judging how the game
   * looks.
   */
  start(): void {
    const cx = 0, cz = 0;
    const alt = 2300;

    for (let i = 0; i < ROSTER.length; i++) {
      const entry = ROSTER[i];
      const spec = AIRCRAFT_BY_ID[entry.id];
      const team = nationTeam(spec.nation);

      // Two loose four-ship-style lines converging head-on, offset laterally
      // and vertically so the merge immediately produces a real fight.
      const side = team === 0 ? -1 : 1;
      const slot = this.actors.filter((a) => a.team === team).length;
      const px = cx + side * 1500 + slot * 120 * side;
      const pz = cz + side * -900 + slot * 260;
      const py = alt + (team === 0 ? 0 : 260) + slot * 90;

      // Nose the two formations at each other along ±X.
      const heading = team === 0 ? Math.PI * 0.5 : -Math.PI * 0.5;

      const actor = this.spawnActor(spec, team, entry.ai, px, py, pz, heading);
      // Trim into level cruise at a realistic speed instead of dropping out of
      // the sky at zero airspeed.
      this.setCruise(actor, 128 + i * 4);
      this.actors.push(actor);
      if (!entry.ai) this.playerActor = actor;
    }

    this.ctx.localEntityId = this.playerActor.entityId;
    this.ctx.localTeam = this.playerActor.team;
    this.ctx.bus.emit('net:spawned', {
      t: 'spawned', entityId: this.playerActor.entityId, aircraft: this.playerActor.spec.id,
    });
  }

  private spawnActor(
    spec: AircraftSpec, team: number, ai: boolean,
    px: number, py: number, pz: number, heading: number,
  ): Actor {
    const id = this.nextEntityId++;
    const rot = q(0, Math.sin(heading / 2), 0, Math.cos(heading / 2));
    const flight = this.flightMod.createFlightState(spec, v3(px, py, pz), rot);
    (flight as Record<string, unknown>).gear = 0;
    (flight as Record<string, unknown>).gearTarget = 0;

    const state = newEntityState();
    state.id = id;
    state.kind = EntityKind.Aircraft;
    state.ownerId = ai ? 1000 + id : this.ctx.localPlayerId || 1;
    state.team = team;
    state.typeId = Math.max(0, aircraftIndex(spec.id));
    state.health = 1;
    state.gear = 0;
    state.px = px; state.py = py; state.pz = pz;
    state.qx = rot.x; state.qy = rot.y; state.qz = rot.z; state.qw = rot.w;

    return {
      entityId: id, spec, typeId: state.typeId, team, flight, state,
      ai: ai ? new AiPilot(id, spec) : null,
      gunCd: spec.guns.map(() => 0),
      ammo: spec.guns.map((g) => g.ammo * g.count),
      alive: true, respawnAt: 0, bailed: false,
      input: { seq: 0, dt: 1 / 60, pitch: 0, roll: 0, yaw: 0, throttle: 1, bits: 0, aimX: 0, aimY: 0 },
    };
  }

  /** Puts an actor into trimmed level flight at 'speed'. */
  private setCruise(actor: Actor, speed: number): void {
    const f = actor.flight as Record<string, unknown>;
    const rot = f.rot as Q | undefined;
    const vel = f.vel as V3 | undefined;
    if (rot && vel) {
      qrot(rot, FWD, _fwd);
      vel.x = _fwd.x * speed; vel.y = _fwd.y * speed; vel.z = _fwd.z * speed;
    }
    if (typeof f.throttle === 'number') f.throttle = 0.85;
    if (typeof f.rpm === 'number') f.rpm = 0.88;
    actor.state.vx = _fwd.x * speed;
    actor.state.vy = 0;
    actor.state.vz = _fwd.z * speed;
    actor.state.throttle = 0.85;
    actor.state.rpm = 0.88;
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /** Advances the whole sandbox. 'playerInput' drives the non-AI actor. */
  step(dt: number, playerInput: InputFrame): void {
    this.time += dt;
    const ctx = this.ctx;

    // --- pilots -------------------------------------------------------------
    const targets = this.actors.map((a) => ({ state: a.state, spec: a.spec, alive: a.alive }));
    for (const a of this.actors) {
      if (a.ai) {
        a.ai.think(a.state, targets, this.env, dt, this.time, a.input);
      } else {
        copyInput(playerInput, a.input);
      }
      // A dead pilot's aeroplane flies itself into the ground.
      if (a.state.damage & DamageBits.PilotDead) {
        a.input.pitch = -0.12; a.input.roll = 0.25; a.input.yaw = 0;
        a.input.bits &= ~(InputBits.Fire1 | InputBits.Fire2);
      }
    }

    // --- flight -------------------------------------------------------------
    for (const a of this.actors) {
      (a.flight as Record<string, unknown>).damage = a.state.damage;
      this.flightMod.stepFlight(a.flight, a.spec, a.input, this.env, dt);
      this.syncActor(a, dt);
      this.checkTerrain(a);
    }

    // --- guns ---------------------------------------------------------------
    for (const a of this.actors) {
      if (!a.alive || (a.state.damage & DamageBits.Destroyed)) continue;
      this.stepGuns(a, dt);
    }

    this.stepProjectiles(dt);
    this.stepRespawns();

    // --- publish ------------------------------------------------------------
    for (const a of this.actors) ctx.entities.set(a.entityId, a.state);
    for (const p of this.projectiles) {
      if (p.live) ctx.entities.set(p.id, p.state);
      else ctx.entities.delete(p.id);
    }
  }

  /** Mirrors the opaque flight state into the replicated entity record. */
  private syncActor(a: Actor, dt: number): void {
    readFlightTransform(a.flight, _t);
    const s = a.state;
    s.px = _t.px; s.py = _t.py; s.pz = _t.pz;
    s.qx = _t.qx; s.qy = _t.qy; s.qz = _t.qz; s.qw = _t.qw;
    s.vx = _t.vx; s.vy = _t.vy; s.vz = _t.vz;

    s.throttle = readFlightScalar(a.flight, ['throttle'], a.input.throttle);
    const rawRpm = readFlightScalar(a.flight, ['rpm', 'propRpm'], 0.18 + s.throttle * 0.82);
    // Some models publish absolute rpm; normalise if so.
    s.rpm = clamp(rawRpm > 2 ? rawRpm / a.spec.engine.maxRpm : rawRpm, 0, 1);
    s.gear = clamp(readFlightScalar(a.flight, ['gear', 'gearPos'], s.gear), 0, 1);
    s.flaps = clamp(readFlightScalar(a.flight, ['flaps', 'flapPos'], s.flaps), 0, 1);
    s.ctlPitch = clamp(readFlightScalar(a.flight, ['ctlPitch'], a.input.pitch), -1, 1);
    s.ctlRoll = clamp(readFlightScalar(a.flight, ['ctlRoll'], a.input.roll), -1, 1);
    s.ctlYaw = clamp(readFlightScalar(a.flight, ['ctlYaw'], a.input.yaw), -1, 1);
    void dt;
  }

  private checkTerrain(a: Actor): void {
    const s = a.state;
    const gh = this.env.terrainHeight(s.px, s.pz);
    if (s.py > gh + 1.2) return;
    const impact = Math.hypot(s.vx, s.vy, s.vz);
    if (s.damage & DamageBits.Destroyed) {
      // Wreck arriving: stop it dead and let it burn where it lies.
      s.py = gh + 0.6;
      s.vx *= 0.05; s.vy = 0; s.vz *= 0.05;
      return;
    }
    // A controlled arrival on the gear is a landing, not a crash.
    const sink = -s.vy;
    if (s.gear > 0.7 && sink < 6 && impact < 75) return;
    if (sink > 5 || impact > 60) {
      this.kill(a, 0, 'terrain');
      this.event(EventKind.Explosion, s.px, gh, s.pz, 0, 1, 0, 3.2, a.entityId, 0);
    }
  }

  // -------------------------------------------------------------------------
  // Gunnery
  // -------------------------------------------------------------------------

  private stepGuns(a: Actor, dt: number): void {
    const s = a.state;
    _rot.x = s.qx; _rot.y = s.qy; _rot.z = s.qz; _rot.w = s.qw;
    qrot(_rot, FWD, _fwd);

    for (let gi = 0; gi < a.spec.guns.length; gi++) {
      const gun = a.spec.guns[gi];
      a.gunCd[gi] -= dt;
      const want = gun.group === 1
        ? (a.input.bits & InputBits.Fire1)
        : (a.input.bits & InputBits.Fire2);
      if (!want || a.gunCd[gi] > 0 || a.ammo[gi] <= 0) continue;
      // Interval between rounds across the whole battery of this type.
      a.gunCd[gi] = 60 / (gun.rpm * Math.max(1, gun.count));
      a.ammo[gi] -= 1;
      this.shots++;

      const mount = gun.mounts[(this.frameCounter + gi) % gun.mounts.length];
      this.frameCounter++;
      qrot(_rot, v3(mount[0], mount[1], mount[2]), _mount);

      const p = this.acquireProjectile();
      if (!p) continue;
      p.shooter = a.entityId;
      p.team = a.team;
      p.calibre = gun.calibre;
      p.he = gun.he;
      p.mass = gun.mass;
      p.life = PROJECTILE_LIFE;

      const ps = p.state;
      ps.kind = EntityKind.Projectile;
      ps.ownerId = s.ownerId;
      ps.team = a.team;
      ps.typeId = Math.min(15, Math.round(gun.calibre));
      ps.px = s.px + _mount.x;
      ps.py = s.py + _mount.y;
      ps.pz = s.pz + _mount.z;

      // Convergence: wing guns are harmonised on a point ahead of the nose, so
      // the streams cross rather than running parallel forever. Cowl guns are
      // already on the centreline and need none.
      const conv = 400;
      let dx = _fwd.x, dy = _fwd.y, dz = _fwd.z;
      if (Math.abs(mount[0]) > 0.6) {
        const cx = _fwd.x * conv - _mount.x;
        const cy = _fwd.y * conv - _mount.y;
        const cz = _fwd.z * conv - _mount.z;
        const l = Math.hypot(cx, cy, cz) || 1;
        dx = cx / l; dy = cy / l; dz = cz / l;
      }
      // Dispersion: a few milliradians, which is what an actual harmonised
      // battery produced. Without it every burst is a laser.
      const disp = 0.0022;
      dx += (Math.random() - 0.5) * disp;
      dy += (Math.random() - 0.5) * disp;
      dz += (Math.random() - 0.5) * disp;

      ps.vx = s.vx + dx * gun.muzzle;
      ps.vy = s.vy + dy * gun.muzzle;
      ps.vz = s.vz + dz * gun.muzzle;

      this.event(EventKind.Gunfire, ps.px, ps.py, ps.pz, _fwd.x, _fwd.y, _fwd.z,
        gun.calibre / 20, a.entityId, gi);
    }
  }

  private frameCounter = 0;
  private shots = 0;

  private acquireProjectile(): Projectile | null {
    for (const p of this.projectiles) {
      if (!p.live) { p.live = true; p.state.id = p.id; return p; }
    }
    if (this.projectiles.length >= 900) return null;
    const state = newEntityState();
    const id = this.nextProjectileId++;
    state.id = id;
    const p: Projectile = {
      id, live: true, shooter: 0, team: 0, calibre: 20, he: 0, mass: 0.1,
      life: PROJECTILE_LIFE, state,
    };
    this.projectiles.push(p);
    return p;
  }

  private stepProjectiles(dt: number): void {
    for (const p of this.projectiles) {
      if (!p.live) continue;
      const s = p.state;
      p.life -= dt;
      if (p.life <= 0) { this.retire(p); continue; }

      const x0 = s.px, y0 = s.py, z0 = s.pz;

      // Quadratic drag with a transonic bump — this is what makes a .50 reach
      // further than a 20 mm shell despite the smaller punch.
      const speed = Math.hypot(s.vx, s.vy, s.vz);
      const rho = this.env.airDensity(s.py);
      const area = Math.PI * (p.calibre * 0.0005) ** 2;
      const cd = 0.29 + 0.22 * clamp((speed / 340 - 0.85) * 1.6, 0, 1);
      const decel = (0.5 * rho * speed * speed * cd * area) / Math.max(0.001, p.mass);
      if (speed > 0.1) {
        s.vx -= (s.vx / speed) * decel * dt;
        s.vy -= (s.vy / speed) * decel * dt;
        s.vz -= (s.vz / speed) * decel * dt;
      }
      s.vy -= 9.80665 * dt;
      s.px += s.vx * dt; s.py += s.vy * dt; s.pz += s.vz * dt;

      const gh = this.env.terrainHeight(s.px, s.pz);
      if (s.py <= gh) {
        this.event(gh <= 0.6 ? EventKind.WaterImpact : EventKind.GroundImpact,
          s.px, gh, s.pz, 0, 1, 0, p.calibre / 20, 0, 0);
        this.retire(p);
        continue;
      }

      for (const a of this.actors) {
        if (!a.alive || a.entityId === p.shooter || a.team === p.team) continue;
        if (a.state.damage & DamageBits.Destroyed) continue;
        // Swept segment against a coarse sphere: at 850 m/s a point test would
        // tunnel straight through a 10 m aircraft most frames.
        if (!segmentSphere(x0, y0, z0, s.px, s.py, s.pz,
          a.state.px, a.state.py, a.state.pz, HIT_RADIUS)) continue;

        this.applyHit(a, p, s.px, s.py, s.pz);
        this.retire(p);
        break;
      }
    }
  }

  private retire(p: Projectile): void {
    p.live = false;
    this.ctx.entities.delete(p.id);
  }

  // -------------------------------------------------------------------------
  // Damage
  // -------------------------------------------------------------------------

  private applyHit(target: Actor, p: Projectile, hx: number, hy: number, hz: number): void {
    const speed = Math.hypot(p.state.vx, p.state.vy, p.state.vz);
    // Kinetic term plus explosive filler, in the same hit-point currency the
    // spec uses.
    const ke = 0.5 * p.mass * speed * speed * 1e-3;
    const dmg = ke * 0.55 + p.he * 1.9;

    const s = target.state;
    s.health = clamp(s.health - dmg / target.spec.damage.hull, 0, 1);

    this.event(
      p.he > 0 ? EventKind.HitSpark : EventKind.HitSpark,
      hx, hy, hz, -p.state.vx, -p.state.vy, -p.state.vz,
      p.calibre / 20, target.entityId, p.shooter,
    );

    // Component damage. Probabilities scale with the round's severity relative
    // to the airframe's structure, so a Zero comes apart much faster than a
    // Mustang under the same fire.
    const sev = clamp(dmg / (target.spec.damage.hull * 0.16), 0, 1);
    const roll = Math.random();
    if (roll < sev * 0.22) s.damage |= Math.random() < 0.5 ? DamageBits.LeftWing : DamageBits.RightWing;
    if (roll > 0.72 && Math.random() < sev * 0.30) s.damage |= DamageBits.Engine;
    if (Math.random() < sev * 0.14) s.damage |= DamageBits.OilLeak;
    if (Math.random() < sev * 0.10) s.damage |= DamageBits.FuelLeak;
    if (Math.random() < sev * 0.10) s.damage |= DamageBits.Rudder;
    if (Math.random() < sev * 0.10) s.damage |= DamageBits.Elevator;
    if (Math.random() < sev * 0.08) s.damage |= DamageBits.Aileron;
    // Self-sealing tanks and armour massively reduce the fire and pilot risk.
    const fireChance = target.spec.damage.selfSealing ? 0.05 : 0.16;
    if ((s.damage & DamageBits.Engine) && Math.random() < sev * fireChance) {
      s.damage |= DamageBits.EngineFire;
    }
    const armour = target.spec.damage.armour.pilotBack;
    if (Math.random() < sev * 0.07 * (armour > 6 ? 0.35 : 1)) {
      s.damage |= Math.random() < 0.4 ? DamageBits.PilotDead : DamageBits.PilotHit;
    }

    // Structural failure once a wing has taken enough.
    if ((s.damage & (DamageBits.LeftWing | DamageBits.RightWing)) && s.health < 0.35
      && Math.random() < sev * 0.25) {
      s.damage |= DamageBits.WingRipped;
      this.event(EventKind.StructureFail, hx, hy, hz, 0, 1, 0, 2, target.entityId, 0);
    }

    if (s.health <= 0) this.kill(target, p.shooter, `${p.calibre}mm`);
  }

  private kill(target: Actor, killerId: number, weapon: string): void {
    if (target.state.damage & DamageBits.Destroyed) return;
    target.state.damage |= DamageBits.Destroyed;
    target.state.health = 0;
    target.alive = false;
    target.respawnAt = this.time + RESPAWN_DELAY;

    const s = target.state;
    this.event(EventKind.Explosion, s.px, s.py, s.pz, 0, 1, 0, 3.0, target.entityId, killerId);

    // A pilot who is still alive gets out.
    if (!target.bailed && !(s.damage & DamageBits.PilotDead)
      && s.py - this.env.terrainHeight(s.px, s.pz) > 220) {
      target.bailed = true;
      const sp = Math.hypot(s.vx, s.vy, s.vz) || 1;
      this.event(EventKind.Bailout, s.px, s.py + 1.2, s.pz,
        s.vx / sp, s.vy / sp, s.vz / sp, sp, target.entityId, 0);
    }

    const killer = this.actors.find((a) => a.entityId === killerId);
    this.ctx.bus.emit('net:kill', {
      t: 'kill',
      killer: killer ? nameFor(killer) : 'the ground',
      victim: nameFor(target),
      weapon,
      killerTeam: killer ? killer.team : -1,
      victimTeam: target.team,
    });
  }

  private stepRespawns(): void {
    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i];
      if (a.alive || this.time < a.respawnAt) continue;

      // A new entity id, so the presentation layer recycles the rig cleanly and
      // the replacement aircraft is whole again.
      this.ctx.entities.delete(a.entityId);
      const wasPlayer = a === this.playerActor;

      const side = a.team === 0 ? -1 : 1;
      const px = side * (5200 + Math.random() * 1600);
      const pz = (Math.random() - 0.5) * 4200;
      const py = 2300 + Math.random() * 900;
      const heading = a.team === 0 ? Math.PI * 0.5 : -Math.PI * 0.5;

      const fresh = this.spawnActor(a.spec, a.team, a.ai !== null, px, py, pz, heading);
      this.setCruise(fresh, 140);
      this.actors[i] = fresh;
      if (wasPlayer) {
        this.playerActor = fresh;
        this.ctx.localEntityId = fresh.entityId;
        this.ctx.bus.emit('net:spawned', {
          t: 'spawned', entityId: fresh.entityId, aircraft: fresh.spec.id,
        });
      }
    }
  }

  // -------------------------------------------------------------------------

  private event(
    kind: EventKind, x: number, y: number, z: number,
    nx: number, ny: number, nz: number, scale: number, a: number, b: number,
  ): void {
    this.ctx.bus.emit('game:event', { kind, x, y, z, nx, ny, nz, scale, a, b });
  }

  /** Roster snapshot for the HUD/scoreboard and the debug overlay. */
  get roster(): ReadonlyArray<{
    id: number; team: number; name: string; alive: boolean; ai: unknown;
  }> {
    return this.actors.map((a) => ({
      id: a.entityId, team: a.team, name: nameFor(a), alive: a.alive,
      ai: a.ai ? a.ai.debugInfo : null,
    }));
  }

  /** Rounds fired since the sandbox started — a liveness check for the AI. */
  get shotsFired(): number { return this.shots; }

  /** The player's own flight state, so the prediction path can share it. */
  get playerFlight(): FlightState { return this.playerActor.flight; }
  get playerSpec(): AircraftSpec { return this.playerActor.spec; }

  // -------------------------------------------------------------------------
  // Screenshot support
  // -------------------------------------------------------------------------

  /**
   * Teleports the player — and optionally one opponent — into a posed setup.
   *
   * Used exclusively by the named camera framings: those are composed for a
   * particular altitude, attitude and biome, and re-flying the aircraft into
   * position is neither repeatable nor quick. Everything downstream (models,
   * trails, exhaust, HUD, audio) reads the same 'EntityState' it always does,
   * so the frame is a real frame of the game, not a diorama.
   */
  placeSubject(p: DebugPlacement): void {
    const player = this.playerActor;
    if (!player) return;
    if (!player.alive) { player.alive = true; player.state.health = 1; player.bailed = false; }

    // The camera may already have posed the subject through the shared flight
    // model, which knows the model's own sign conventions better than we do.
    // Only fall back to posing it ourselves when it could not.
    if (!p.placed) poseActor(player, p.x, p.y, p.z, p.heading, p.pitch, p.bank, p.speed);

    if (typeof p.damage === 'number') {
      player.state.damage = p.damage;
      (player.flight as Record<string, unknown>).damage = p.damage;
      // A holed aeroplane that still reads 100 % health looks like a bug in the
      // damage model rather than like battle damage.
      if (p.damage) player.state.health = 0.42;
    }
    if (p.gear !== undefined) {
      const g = p.gear ? 1 : 0;
      player.state.gear = g;
      (player.flight as Record<string, unknown>).gear = g;
      (player.flight as Record<string, unknown>).gearTarget = g;
    }
    if (p.flaps !== undefined) {
      player.state.flaps = p.flaps;
      (player.flight as Record<string, unknown>).flaps = p.flaps;
      (player.flight as Record<string, unknown>).flapTarget = p.flaps;
    }

    // --- the opponent -------------------------------------------------------
    // Bearing is measured from the subject's nose, positive to its right, which
    // is the same convention the framing spec documents.
    if (p.opponent) {
      const foe = this.actors.find((a) => a !== player && a.team !== player.team)
        ?? this.actors.find((a) => a !== player);
      if (foe) {
        const az = p.heading + p.opponent.bearing;
        const r = p.opponent.range;
        const ox = p.x + Math.sin(az) * r;
        const oz = p.z + Math.cos(az) * r;
        // Slightly above the subject so it reads against sky rather than being
        // lost in the ground clutter behind it.
        const oy = p.y + r * 0.06;
        if (!foe.alive) { foe.alive = true; foe.state.health = 1; foe.bailed = false; }
        // Nose it back toward the subject: two aircraft pointing the same way
        // is a formation photo, not a dogfight.
        poseActor(foe, ox, oy, oz, az + Math.PI, 0, p.opponent.bank, p.speed * 0.95);
      }
    }

    // Push the new transforms into the shared table immediately so the camera,
    // which runs after us this frame, composes against the posed aircraft
    // instead of one frame of the old position.
    for (const a of this.actors) this.ctx.entities.set(a.entityId, a.state);
  }
}

/** A posed setup requested by a named camera framing. */
export interface DebugPlacement {
  x: number; y: number; z: number;
  /** Radians, 0 = +Z. */
  heading: number;
  pitch: number;
  bank: number;
  /** True airspeed to trim to, m/s. */
  speed: number;
  /** True when the caller has already posed the subject itself. */
  placed?: boolean;
  opponent?: { bearing: number; range: number; bank: number } | null;
  damage?: number;
  gear?: boolean;
  flaps?: number;
}

/**
 * Writes a pose straight into an actor's flight state and entity record.
 *
 * Angular rate is zeroed deliberately: the framing wants a held attitude, and
 * a residual body rate makes the aeroplane roll out of the composition during
 * the second the harness waits before it captures.
 */
function poseActor(
  a: Actor, x: number, y: number, z: number,
  heading: number, pitch: number, bank: number, speed: number,
): void {
  // 'qFromEuler(pitch, yaw, roll)' with roll negated: positive bank is right
  // wing down, which is a negative rotation about the nose axis.
  qFromEuler(pitch, heading, -bank, _rot);
  qrot(_rot, FWD, _fwd);

  readFlightTransform(a.flight, _t);
  _t.px = x; _t.py = y; _t.pz = z;
  _t.qx = _rot.x; _t.qy = _rot.y; _t.qz = _rot.z; _t.qw = _rot.w;
  _t.vx = _fwd.x * speed; _t.vy = _fwd.y * speed; _t.vz = _fwd.z * speed;
  _t.wx = 0; _t.wy = 0; _t.wz = 0;
  writeFlightTransform(a.flight, _t);

  const f = a.flight as Record<string, unknown>;
  if (typeof f.throttle === 'number') f.throttle = 0.92;
  if (typeof f.rpm === 'number') f.rpm = 0.94;

  const s = a.state;
  s.px = x; s.py = y; s.pz = z;
  s.qx = _rot.x; s.qy = _rot.y; s.qz = _rot.z; s.qw = _rot.w;
  s.vx = _t.vx; s.vy = _t.vy; s.vz = _t.vz;
  s.throttle = 0.92; s.rpm = 0.94;
}

// ---------------------------------------------------------------------------

const CALLSIGNS = ['Red 1', 'Red 2', 'Red 3', 'Blue 1', 'Blue 2', 'Blue 3', 'Yellow 1', 'Yellow 2'];
function nameFor(a: Actor): string {
  return a.ai ? CALLSIGNS[a.entityId % CALLSIGNS.length] : 'You';
}

function copyInput(from: InputFrame, to: InputFrame): void {
  to.seq = from.seq; to.dt = from.dt;
  to.pitch = from.pitch; to.roll = from.roll; to.yaw = from.yaw;
  to.throttle = from.throttle; to.bits = from.bits;
  to.aimX = from.aimX; to.aimY = from.aimY;
}

/** Closest approach of segment AB to a sphere at C with radius r. */
function segmentSphere(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number, r: number,
): boolean {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const fx = ax - cx, fy = ay - cy, fz = az - cz;
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-9) return fx * fx + fy * fy + fz * fz <= r * r;
  let t = -(fx * dx + fy * dy + fz * dz) / a;
  t = clamp(t, 0, 1);
  const px = fx + dx * t, py = fy + dy * t, pz = fz + dz * t;
  return px * px + py * py + pz * pz <= r * r;
}
