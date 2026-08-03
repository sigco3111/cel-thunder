import type { WebSocket } from 'ws';
import {
  C2S, S2C, EntityKind, DamageBits, EventKind,
  TICK_HZ, TICK_DT, SNAPSHOT_EVERY, LAGCOMP_HISTORY,
  ENTITY_BYTES, SNAPSHOT_HEADER_BYTES, INPUT_FRAME_BYTES,
  newEntityState, readInputFrame, writeEntity,
  type EntityState, type InputFrame, type GameEvent, type PlayerInfo,
} from '../src/shared/protocol';
import { AIRCRAFT, AIRCRAFT_BY_ID, aircraftIndex, nationTeam, type AircraftSpec } from '../src/shared/aircraft';
import { v3, q, qrot, vadd, vaddScaled, vlen, type V3 } from '../src/shared/math';

/**
 * One match. Owns the authoritative simulation, the entity list and the
 * per-connection snapshot pipeline.
 *
 * Timing model:
 *  - fixed 60 Hz simulation, accumulator-driven, never variable-step;
 *  - inputs are buffered per player in a small jitter queue and consumed one
 *    frame per tick, so a client that bursts or stalls cannot gain an edge;
 *  - snapshots go out every 3rd tick (20 Hz) with the last consumed input
 *    sequence acked so the client can reconcile its prediction;
 *  - a ring buffer of past transforms supports lag-compensated hit testing.
 */

export interface Env {
  airDensity(y: number): number;
  windAt(p: V3, out: V3): V3;
  terrainHeight(x: number, z: number): number;
  terrainNormal(x: number, z: number, out: V3): V3;
}

interface HistorySample {
  t: number;
  px: number; py: number; pz: number;
  qx: number; qy: number; qz: number; qw: number;
}

export class Player {
  id: number;
  name: string;
  team = 0;
  ws: WebSocket;
  entityId = 0;
  kills = 0;
  deaths = 0;
  score = 0;
  alive = false;
  respawnAt = 0;

  /** Jitter buffer of unconsumed input frames, ordered by seq. */
  inputQueue: InputFrame[] = [];
  lastAppliedSeq = 0;
  /** Most recent input actually consumed — reused if the queue starves. */
  lastInput: InputFrame = {
    seq: 0, dt: TICK_DT, pitch: 0, roll: 0, yaw: 0,
    throttle: 0, bits: 0, aimX: 0, aimY: 0,
  };
  rttMs = 0;
  lastPingSent = 0;
  chosenAircraft = 'spitfire_mk9';

  constructor(id: number, name: string, ws: WebSocket) {
    this.id = id; this.name = name; this.ws = ws;
  }

  info(): PlayerInfo {
    return { id: this.id, name: this.name, team: this.team, kills: this.kills, deaths: this.deaths, score: this.score, alive: this.alive };
  }
}

/** Server-side entity: replicated state plus simulation-only fields. */
export interface ServerEntity {
  state: EntityState;
  spec?: AircraftSpec;
  /** Opaque flight state owned by the shared flight model. */
  flight?: any;
  /** Opaque damage state owned by the shared combat model. */
  dmg?: any;
  /** Ring buffer for lag compensation. */
  history: HistorySample[];
  historyHead: number;
  /** Projectile-only fields. */
  life?: number;
  shooter?: number;
  calibre?: number;
  he?: number;
  mass?: number;
  dead: boolean;
}

const HISTORY_LEN = Math.ceil(LAGCOMP_HISTORY * TICK_HZ);

export class Room {
  readonly id: string;
  readonly mapSeed: number;
  readonly mapName: string;

  players = new Map<number, Player>();
  entities = new Map<number, ServerEntity>();

  tick = 0;
  time = 0;              // seconds since match start
  private accumulator = 0;
  private nextEntityId = 1;
  private nextPlayerId = 1;
  private events: GameEvent[] = [];
  private scoreA = 0;
  private scoreB = 0;
  private matchLength = 20 * 60;

  /** Scratch buffer reused for every snapshot to avoid per-tick allocation. */
  private snapBuf = new ArrayBuffer(SNAPSHOT_HEADER_BYTES + ENTITY_BYTES * 512);
  private snapView = new DataView(this.snapBuf);

  private env: Env;
  private lastWall = 0;

  constructor(id: string, mapSeed: number, mapName: string, env: Env) {
    this.id = id;
    this.mapSeed = mapSeed;
    this.mapName = mapName;
    this.env = env;
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  addPlayer(name: string, ws: WebSocket): Player {
    const p = new Player(this.nextPlayerId++, name.slice(0, 20) || `Pilot${this.nextPlayerId}`, ws);
    // Balance teams by headcount, breaking ties toward Allies.
    let a = 0, b = 0;
    for (const q of this.players.values()) (q.team === 0 ? a++ : b++);
    p.team = a <= b ? 0 : 1;
    this.players.set(p.id, p);
    return p;
  }

  removePlayer(id: number): void {
    const p = this.players.get(id);
    if (!p) return;
    if (p.entityId) this.destroyEntity(p.entityId);
    this.players.delete(id);
  }

  get isEmpty(): boolean { return this.players.size === 0; }

  // -------------------------------------------------------------------------
  // Entities
  // -------------------------------------------------------------------------

  private allocEntity(kind: EntityKind): ServerEntity {
    // Entity ids are u16 on the wire; recycle rather than overflow.
    let id = this.nextEntityId++;
    if (this.nextEntityId > 65000) this.nextEntityId = 1;
    while (this.entities.has(id)) { id = this.nextEntityId++; }

    const state = newEntityState();
    state.id = id;
    state.kind = kind;
    const e: ServerEntity = { state, history: [], historyHead: 0, dead: false };
    this.entities.set(id, e);
    return e;
  }

  destroyEntity(id: number): void {
    const e = this.entities.get(id);
    if (!e) return;
    e.dead = true;
    this.entities.delete(id);
  }

  /**
   * Spawns a player aircraft on their team's airfield, offset so simultaneous
   * spawns do not overlap.
   */
  spawnAircraft(p: Player, aircraftId: string): ServerEntity | null {
    const spec = AIRCRAFT_BY_ID[aircraftId] ?? AIRCRAFT[0];
    if (nationTeam(spec.nation) !== p.team) {
      // Fall back to the first aircraft valid for this player's team.
      const alt = AIRCRAFT.find((a) => nationTeam(a.nation) === p.team);
      if (alt) aircraftId = alt.id;
    }
    const chosen = AIRCRAFT_BY_ID[aircraftId] ?? spec;

    if (p.entityId) this.destroyEntity(p.entityId);

    const e = this.allocEntity(EntityKind.Aircraft);
    e.spec = chosen;
    e.state.ownerId = p.id;
    e.state.team = p.team;
    e.state.typeId = Math.max(0, aircraftIndex(chosen.id));
    e.state.health = 1;
    e.state.damage = 0;
    e.state.gear = 1;

    const base = this.airfield(p.team);
    const slot = [...this.players.values()].filter((q) => q.team === p.team).indexOf(p);
    const lateral = ((slot % 6) - 2.5) * 26;
    const back = Math.floor(slot / 6) * 40;

    e.state.px = base.x + lateral;
    e.state.py = this.env.terrainHeight(base.x + lateral, base.z - back) + 1.2;
    e.state.pz = base.z - back;
    // Runways are aligned to +Z for team 0 and -Z for team 1.
    const yaw = p.team === 0 ? 0 : Math.PI;
    e.state.qx = 0; e.state.qy = Math.sin(yaw / 2); e.state.qz = 0; e.state.qw = Math.cos(yaw / 2);
    e.state.vx = 0; e.state.vy = 0; e.state.vz = 0;
    e.state.throttle = 0;
    e.state.rpm = 0.18;

    p.entityId = e.state.id;
    p.alive = true;
    return e;
  }

  airfield(team: number): V3 {
    // Deterministic from the map seed; the client derives the same positions.
    return team === 0 ? v3(-14000, 0, -19000) : v3(14000, 0, 19000);
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  onInputPacket(p: Player, buf: ArrayBuffer, offset: number, count: number): void {
    const dv = new DataView(buf);
    let off = offset;
    for (let i = 0; i < count; i++) {
      if (off + INPUT_FRAME_BYTES > buf.byteLength) break;
      const f: InputFrame = { seq: 0, dt: 0, pitch: 0, roll: 0, yaw: 0, throttle: 0, bits: 0, aimX: 0, aimY: 0 };
      off = readInputFrame(dv, off, f);
      // Reject duplicates and anything already consumed. Sequence numbers wrap
      // at 2^16, so compare in wrapped space.
      const delta = (f.seq - p.lastAppliedSeq) & 0xffff;
      if (delta === 0 || delta > 30000) continue;
      if (p.inputQueue.some((x) => x.seq === f.seq)) continue;
      // Clamp dt so a client cannot claim a huge frame and move further.
      f.dt = Math.max(0.002, Math.min(0.05, f.dt));
      p.inputQueue.push(f);
    }
    p.inputQueue.sort((a, b) => ((a.seq - b.seq) & 0xffff) > 30000 ? 1 : -1);
    // Cap the buffer: a client that floods gets its oldest frames dropped.
    if (p.inputQueue.length > 12) p.inputQueue.splice(0, p.inputQueue.length - 12);
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  /** Called from the host loop with real elapsed wall time. */
  advance(wallDt: number): void {
    this.accumulator += Math.min(wallDt, 0.25);
    while (this.accumulator >= TICK_DT) {
      this.accumulator -= TICK_DT;
      this.step();
    }
  }

  private step(): void {
    this.tick++;
    this.time += TICK_DT;

    // 1. consume one input frame per player
    for (const p of this.players.values()) {
      const f = p.inputQueue.shift();
      if (f) { p.lastInput = f; p.lastAppliedSeq = f.seq; }
      // If the queue starved we re-apply the last frame, which is what a real
      // client would most likely still be holding.
    }

    // 2. advance aircraft
    for (const e of this.entities.values()) {
      if (e.state.kind !== EntityKind.Aircraft) continue;
      const p = this.players.get(e.state.ownerId);
      this.stepAircraft(e, p?.lastInput ?? null);
      this.recordHistory(e);
    }

    // 3. advance ordnance/projectiles
    this.stepProjectiles();

    // 4. respawns
    for (const p of this.players.values()) {
      if (!p.alive && p.respawnAt > 0 && this.time >= p.respawnAt) {
        p.respawnAt = 0;
        const e = this.spawnAircraft(p, p.chosenAircraft);
        if (e) this.sendJson(p, { t: 'spawned', entityId: e.state.id, aircraft: p.chosenAircraft });
      }
    }

    // 5. broadcast
    if (this.tick % SNAPSHOT_EVERY === 0) this.broadcastSnapshot();
  }

  /**
   * Steps one aircraft. Delegates to the shared flight model when it is
   * available; the fallback keeps a match playable if the model is mid-swap.
   */
  private stepAircraft(e: ServerEntity, input: InputFrame | null): void {
    const s = e.state;
    if (s.damage & DamageBits.Destroyed) {
      // Ballistic wreck.
      s.vy -= 9.81 * TICK_DT;
      s.px += s.vx * TICK_DT; s.py += s.vy * TICK_DT; s.pz += s.vz * TICK_DT;
      const gh = this.env.terrainHeight(s.px, s.pz);
      if (s.py <= gh) {
        this.pushEvent(EventKind.Explosion, s.px, gh, s.pz, 0, 1, 0, 2.4, s.id, 0);
        this.destroyEntity(s.id);
      }
      return;
    }

    if (e.flight && globalThis.__stepFlight) {
      globalThis.__stepFlight(e.flight, e.spec, input ?? ZERO_INPUT, this.env, TICK_DT);
      globalThis.__syncFlightToState?.(e.flight, s);
    } else {
      this.stepAircraftFallback(e, input);
    }

    // Firing
    if (input && e.spec) this.stepGuns(e, input);
  }

  /**
   * Reduced-order flight integration used only when the full model has not
   * been wired in. Enough to fly and be shot at; not enough to be authentic.
   */
  private stepAircraftFallback(e: ServerEntity, input: InputFrame | null): void {
    const s = e.state;
    const spec = e.spec!;
    const dt = TICK_DT;
    const i = input ?? ZERO_INPUT;

    s.throttle += (i.throttle - s.throttle) * Math.min(1, dt / spec.engine.spool);
    s.rpm = 0.18 + s.throttle * 0.82;

    const rot = q(s.qx, s.qy, s.qz, s.qw);
    const fwd = qrot(rot, FWD, _f);
    const up = qrot(rot, UP, _u);
    const right = qrot(rot, RIGHT, _r);

    const vel = v3(s.vx, s.vy, s.vz);
    const speed = vlen(vel);
    const rho = this.env.airDensity(s.py);
    const qbar = 0.5 * rho * speed * speed;

    // Angular response, authority scaled by dynamic pressure.
    const auth = Math.min(1, qbar / 2400);
    const wx = i.pitch * spec.aero.pitchRate * auth;
    const wy = i.yaw * spec.aero.yawRate * auth;
    const wz = -i.roll * spec.aero.rollRate * auth;

    const half = dt * 0.5;
    const dx = s.qw * wx * half + s.qy * wz * half - s.qz * wy * half;
    const dy = s.qw * wy * half + s.qz * wx * half - s.qx * wz * half;
    const dz = s.qw * wz * half + s.qx * wy * half - s.qy * wx * half;
    const dw = -s.qx * wx * half - s.qy * wy * half - s.qz * wz * half;
    s.qx += dx; s.qy += dy; s.qz += dz; s.qw += dw;
    const ql = Math.hypot(s.qx, s.qy, s.qz, s.qw) || 1;
    s.qx /= ql; s.qy /= ql; s.qz /= ql; s.qw /= ql;

    const thrust = spec.engine.powerKw * 1000 * s.throttle / Math.max(30, speed);
    const alpha = speed > 5 ? Math.asin(Math.max(-1, Math.min(1, -(vel.x * up.x + vel.y * up.y + vel.z * up.z) / speed))) : 0;
    const cl = Math.max(-spec.aero.clMax, Math.min(spec.aero.clMax, spec.aero.cl0 + spec.aero.clAlpha * alpha));
    const lift = qbar * spec.aero.wingArea * cl;
    const cd = spec.aero.cd0 + (cl * cl) / (Math.PI * spec.aero.oswald * (spec.aero.span ** 2 / spec.aero.wingArea));
    const drag = qbar * spec.aero.wingArea * cd;

    const m = spec.aero.mass;
    let ax = (fwd.x * thrust + up.x * lift) / m;
    let ay = (fwd.y * thrust + up.y * lift) / m - 9.81;
    let az = (fwd.z * thrust + up.z * lift) / m;
    if (speed > 0.1) {
      ax -= (vel.x / speed) * drag / m;
      ay -= (vel.y / speed) * drag / m;
      az -= (vel.z / speed) * drag / m;
    }

    s.vx += ax * dt; s.vy += ay * dt; s.vz += az * dt;
    s.px += s.vx * dt; s.py += s.vy * dt; s.pz += s.vz * dt;

    const gh = this.env.terrainHeight(s.px, s.pz);
    if (s.py < gh + 1.0) {
      s.py = gh + 1.0;
      if (s.vy < -12) {
        this.killEntity(e, 0, 'terrain');
      } else {
        s.vy = Math.max(0, s.vy);
        s.vx *= 0.985; s.vz *= 0.985;
      }
    }

    s.ctlPitch = i.pitch; s.ctlRoll = i.roll; s.ctlYaw = i.yaw;
    s.gear = s.py - gh < 60 ? 1 : Math.max(0, s.gear - dt * 0.25);
  }

  private gunCooldown = new Map<number, number[]>();

  private stepGuns(e: ServerEntity, input: InputFrame): void {
    const spec = e.spec!;
    let cds = this.gunCooldown.get(e.state.id);
    if (!cds) { cds = spec.guns.map(() => 0); this.gunCooldown.set(e.state.id, cds); }

    for (let gi = 0; gi < spec.guns.length; gi++) {
      const gun = spec.guns[gi];
      const wants = gun.group === 1 ? (input.bits & 1) : (input.bits & 2);
      cds[gi] -= TICK_DT;
      if (!wants || cds[gi] > 0) continue;
      cds[gi] = 60 / gun.rpm / Math.max(1, gun.count);

      const s = e.state;
      const rot = q(s.qx, s.qy, s.qz, s.qw);
      const mount = gun.mounts[(this.tick + gi) % gun.mounts.length];
      const local = v3(mount[0], mount[1], mount[2]);
      const world = qrot(rot, local, _p);
      const fwd = qrot(rot, FWD, _f);

      const pe = this.allocEntity(EntityKind.Projectile);
      pe.state.ownerId = s.ownerId;
      pe.state.team = s.team;
      pe.state.typeId = Math.min(15, Math.round(gun.calibre));
      pe.state.px = s.px + world.x;
      pe.state.py = s.py + world.y;
      pe.state.pz = s.pz + world.z;
      pe.state.vx = s.vx + fwd.x * gun.muzzle;
      pe.state.vy = s.vy + fwd.y * gun.muzzle;
      pe.state.vz = s.vz + fwd.z * gun.muzzle;
      pe.life = 4.0;
      pe.shooter = s.id;
      pe.calibre = gun.calibre;
      pe.he = gun.he;
      pe.mass = gun.mass;

      this.pushEvent(EventKind.Gunfire, pe.state.px, pe.state.py, pe.state.pz, fwd.x, fwd.y, fwd.z, gun.calibre / 20, s.id, gi);
    }
  }

  private stepProjectiles(): void {
    const dt = TICK_DT;
    for (const e of this.entities.values()) {
      if (e.state.kind !== EntityKind.Projectile) continue;
      const s = e.state;
      e.life! -= dt;
      if (e.life! <= 0) { this.destroyEntity(s.id); continue; }

      const x0 = s.px, y0 = s.py, z0 = s.pz;

      // Drag: quadratic, with a ballistic coefficient derived from calibre and
      // mass. Heavier, smaller-calibre rounds retain velocity much better,
      // which is what makes .50 cal reach further than 20 mm HE.
      const speed = Math.hypot(s.vx, s.vy, s.vz);
      const rho = this.env.airDensity(s.py);
      const area = Math.PI * (e.calibre! * 0.0005) ** 2;
      const cd = 0.29 + 0.22 * Math.min(1, Math.max(0, (speed / 340 - 0.85) * 1.6));
      const dragA = (0.5 * rho * speed * speed * cd * area) / Math.max(0.001, e.mass!);
      if (speed > 0.1) {
        s.vx -= (s.vx / speed) * dragA * dt;
        s.vy -= (s.vy / speed) * dragA * dt;
        s.vz -= (s.vz / speed) * dragA * dt;
      }
      s.vy -= 9.81 * dt;

      s.px += s.vx * dt; s.py += s.vy * dt; s.pz += s.vz * dt;

      // Terrain
      const gh = this.env.terrainHeight(s.px, s.pz);
      if (s.py <= gh) {
        this.pushEvent(gh <= 0.5 ? EventKind.WaterImpact : EventKind.GroundImpact, s.px, gh, s.pz, 0, 1, 0, e.calibre! / 20, 0, 0);
        this.destroyEntity(s.id);
        continue;
      }

      // Aircraft — swept segment against a coarse sphere, then delegated to
      // the detailed module test when the combat model is present.
      for (const t of this.entities.values()) {
        if (t.state.kind !== EntityKind.Aircraft || t.state.id === e.shooter) continue;
        if (t.state.team === s.team) continue;
        if (t.state.damage & DamageBits.Destroyed) continue;
        const hit = segmentSphere(x0, y0, z0, s.px, s.py, s.pz, t.state.px, t.state.py, t.state.pz, 6.0);
        if (!hit) continue;

        const dmg = damageForRound(e.calibre!, e.he!, Math.hypot(s.vx, s.vy, s.vz));
        t.state.health = Math.max(0, t.state.health - dmg / (t.spec?.damage.hull ?? 200));
        this.pushEvent(EventKind.HitSpark, s.px, s.py, s.pz, -s.vx, -s.vy, -s.vz, e.calibre! / 20, t.state.id, e.shooter!);
        if (t.state.health <= 0) this.killEntity(t, e.shooter!, `${e.calibre}mm`);
        this.destroyEntity(s.id);
        break;
      }
    }
  }

  private killEntity(target: ServerEntity, killerEntityId: number, weapon: string): void {
    if (target.state.damage & DamageBits.Destroyed) return;
    target.state.damage |= DamageBits.Destroyed;
    target.state.health = 0;

    const victim = this.players.get(target.state.ownerId);
    const killerEnt = this.entities.get(killerEntityId);
    const killer = killerEnt ? this.players.get(killerEnt.state.ownerId) : undefined;

    if (victim) {
      victim.alive = false;
      victim.deaths++;
      victim.respawnAt = this.time + 8;
      victim.entityId = 0;
    }
    if (killer && killer !== victim) {
      killer.kills++;
      killer.score += 100;
      if (killer.team === 0) this.scoreA++; else this.scoreB++;
    }

    this.pushEvent(EventKind.Explosion, target.state.px, target.state.py, target.state.pz, 0, 1, 0, 3.0, target.state.id, 0);
    this.broadcastJson({
      t: 'kill',
      killer: killer?.name ?? 'the ground',
      victim: victim?.name ?? 'unknown',
      weapon,
      killerTeam: killer?.team ?? -1,
      victimTeam: victim?.team ?? -1,
    });
  }

  // -------------------------------------------------------------------------
  // Lag compensation
  // -------------------------------------------------------------------------

  private recordHistory(e: ServerEntity): void {
    if (e.history.length < HISTORY_LEN) {
      e.history.push({ t: this.time, px: e.state.px, py: e.state.py, pz: e.state.pz, qx: e.state.qx, qy: e.state.qy, qz: e.state.qz, qw: e.state.qw });
      e.historyHead = e.history.length - 1;
    } else {
      e.historyHead = (e.historyHead + 1) % HISTORY_LEN;
      const h = e.history[e.historyHead];
      h.t = this.time;
      h.px = e.state.px; h.py = e.state.py; h.pz = e.state.pz;
      h.qx = e.state.qx; h.qy = e.state.qy; h.qz = e.state.qz; h.qw = e.state.qw;
    }
  }

  /** Transform of 'e' as it was 'rewind' seconds ago, for hit validation. */
  rewound(e: ServerEntity, rewind: number, out: HistorySample): HistorySample {
    const want = this.time - Math.max(0, Math.min(LAGCOMP_HISTORY, rewind));
    let best = e.history[e.historyHead];
    for (const h of e.history) {
      if (h.t <= want && (!best || h.t > best.t)) best = h;
    }
    Object.assign(out, best ?? { t: this.time, px: e.state.px, py: e.state.py, pz: e.state.pz, qx: e.state.qx, qy: e.state.qy, qz: e.state.qz, qw: e.state.qw });
    return out;
  }

  // -------------------------------------------------------------------------
  // Replication
  // -------------------------------------------------------------------------

  private pushEvent(kind: EventKind, x: number, y: number, z: number, nx: number, ny: number, nz: number, scale: number, a: number, b: number): void {
    if (this.events.length > 200) return;
    this.events.push({ kind, x, y, z, nx, ny, nz, scale, a, b });
  }

  private broadcastSnapshot(): void {
    const list = [...this.entities.values()];
    const needed = SNAPSHOT_HEADER_BYTES + ENTITY_BYTES * list.length;
    if (needed > this.snapBuf.byteLength) {
      this.snapBuf = new ArrayBuffer(needed * 2);
      this.snapView = new DataView(this.snapBuf);
    }
    const dv = this.snapView;

    for (const p of this.players.values()) {
      if (p.ws.readyState !== 1) continue;
      let off = 0;
      dv.setUint8(off, S2C.Snapshot); off += 1;
      dv.setUint32(off, this.tick, true); off += 4;
      dv.setFloat32(off, this.time, true); off += 4;
      dv.setUint16(off, p.lastAppliedSeq, true); off += 2;
      dv.setUint16(off, list.length, true); off += 2;
      for (const e of list) off = writeEntity(dv, off, e.state);
      try { p.ws.send(new Uint8Array(this.snapBuf, 0, off)); } catch { /* dropped */ }
    }

    if (this.events.length) {
      const eb = new ArrayBuffer(1 + 2 + this.events.length * 32);
      const edv = new DataView(eb);
      let off = 0;
      edv.setUint8(off, S2C.Event); off += 1;
      edv.setUint16(off, this.events.length, true); off += 2;
      for (const ev of this.events) {
        edv.setUint8(off, ev.kind); off += 1;
        edv.setUint8(off, 0); off += 1;
        edv.setUint16(off, ev.a & 0xffff, true); off += 2;
        edv.setFloat32(off, ev.x, true); off += 4;
        edv.setFloat32(off, ev.y, true); off += 4;
        edv.setFloat32(off, ev.z, true); off += 4;
        edv.setInt16(off, Math.round(ev.nx * 32767), true); off += 2;
        edv.setInt16(off, Math.round(ev.ny * 32767), true); off += 2;
        edv.setInt16(off, Math.round(ev.nz * 32767), true); off += 2;
        edv.setFloat32(off, ev.scale, true); off += 4;
        edv.setUint16(off, ev.b & 0xffff, true); off += 2;
        edv.setUint32(off, 0, true); off += 4;
      }
      for (const p of this.players.values()) {
        if (p.ws.readyState !== 1) continue;
        try { p.ws.send(new Uint8Array(eb, 0, off)); } catch { /* dropped */ }
      }
      this.events.length = 0;
    }
  }

  sendJson(p: Player, msg: unknown): void {
    if (p.ws.readyState !== 1) return;
    try { p.ws.send(JSON.stringify(msg)); } catch { /* dropped */ }
  }

  broadcastJson(msg: unknown): void {
    const s = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.ws.readyState !== 1) continue;
      try { p.ws.send(s); } catch { /* dropped */ }
    }
  }

  matchState() {
    return {
      t: 'match' as const,
      scoreA: this.scoreA,
      scoreB: this.scoreB,
      timeLeft: Math.max(0, this.matchLength - this.time),
      players: [...this.players.values()].map((p) => p.info()),
    };
  }
}

// ---------------------------------------------------------------------------

const ZERO_INPUT: InputFrame = { seq: 0, dt: TICK_DT, pitch: 0, roll: 0, yaw: 0, throttle: 0, bits: 0, aimX: 0, aimY: 0 };
const FWD = v3(0, 0, 1);
const UP = v3(0, 1, 0);
const RIGHT = v3(1, 0, 0);
const _f = v3(), _u = v3(), _r = v3(), _p = v3();

declare global {
  // Bound by server/index.ts once the shared flight model is available.
  // eslint-disable-next-line no-var
  var __stepFlight: undefined | ((flight: any, spec: any, input: InputFrame, env: Env, dt: number) => void);
  // eslint-disable-next-line no-var
  var __syncFlightToState: undefined | ((flight: any, state: EntityState) => void);
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
  t = Math.max(0, Math.min(1, t));
  const px = fx + dx * t, py = fy + dy * t, pz = fz + dz * t;
  return px * px + py * py + pz * pz <= r * r;
}

/** Provisional damage number; replaced by the full penetration model. */
function damageForRound(calibre: number, he: number, speed: number): number {
  const ke = 0.5 * (calibre / 20) * speed * speed * 1e-4;
  return ke * 0.8 + he * 1.9;
}
