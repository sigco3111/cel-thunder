import type { GameContext, Subsystem } from '../engine/context';
import {
  C2S, S2C, EntityKind, PROTOCOL_VERSION, SNAPSHOT_HEADER_BYTES,
  INPUT_FRAME_BYTES, ENTITY_BYTES, EventKind,
  newEntityState, readEntity, writeInputFrame,
  type EntityState, type InputFrame, type PlayerInfo,
} from '../shared/protocol';
import { lerp, qslerp, q, type Q } from '../shared/math';
import {
  clampTimeOfDay, isWeatherId, matchEnvironment, type WeatherId,
} from '../shared/environment';

/**
 * Client half of the netcode.
 *
 * Three mechanisms, each solving a different problem:
 *
 *  1. **Client-side prediction** — the local aircraft is simulated immediately
 *     from local input rather than waiting for the server, so controls feel
 *     instant. Every input frame is kept in a pending buffer.
 *  2. **Reconciliation** — each snapshot acks the last input the server
 *     consumed. We snap the local aircraft to the server's authoritative state
 *     and replay every input after that ack. If the replayed result is close
 *     to what we already had (the common case) the correction is smoothed out
 *     over a few frames instead of snapping, so a normal flight has no visible
 *     rubber-banding.
 *  3. **Entity interpolation** — remote aircraft are rendered ~100 ms in the
 *     past, between the two snapshots that bracket that time. This trades a
 *     small latency for perfectly smooth remote motion, and is what the
 *     server's lag compensation is calibrated against.
 */

const INTERP_DELAY = 0.10;      // seconds of buffer for remote entities
const SNAPSHOT_BUFFER = 32;
const MAX_PENDING_INPUTS = 180;

interface Snapshot {
  tick: number;
  serverTime: number;   // seconds
  ackSeq: number;
  /** Entity states by id at that instant. */
  states: Map<number, EntityState>;
  /** Local receive time, used to build the interpolation clock. */
  recvAt: number;
}

export class NetSystem implements Subsystem {
  readonly name = 'net';

  connected = false;
  /** True when running without a server (single-player / offline sandbox). */
  offline = false;

  playerId = 0;
  team = 0;
  mapSeed = 1337;
  mapName = 'Normandy Coast';
  players: PlayerInfo[] = [];
  scoreA = 0;
  scoreB = 0;
  timeLeft = 0;
  rttMs = 0;

  /**
   * The match's sky, as the server chose it.
   *
   * This is not decoration: 'shared/environment.ts' derives the wind field and
   * the turbulence the flight model integrates against from
   * (mapSeed, weather), so a client flying a different weather to the server
   * would predict a different trajectory and rubber-band. Everything else that
   * consumes it — the sky dome, the rain, the fog — is downstream of that.
   *
   * Seeded so it is already sane before 'welcome' lands and for the offline
   * sandbox, which has no server to ask.
   */
  weather: WeatherId = 'scattered';
  /** Local solar-clock hours for this match, [0,24). */
  matchTimeOfDay = 9.5;
  private envApplied = false;

  private ws: WebSocket | null = null;
  private ctx!: GameContext;
  private snapshots: Snapshot[] = [];
  private statePool: EntityState[] = [];

  /** Inputs sent but not yet acked by the server, oldest first. */
  private pending: InputFrame[] = [];
  private inputSeq = 1;

  /** Interpolation clock: our estimate of "server time now, minus delay". */
  private renderTime = 0;
  private clockInitialised = false;

  /** Outgoing input packet buffer (header + up to 4 redundant frames). */
  private outBuf = new ArrayBuffer(2 + INPUT_FRAME_BYTES * 4);
  private outView = new DataView(this.outBuf);

  private scratchA = q();
  private scratchB = q();

  async init(ctx: GameContext): Promise<void> {
    this.ctx = ctx;

    // Debug poses. Offline the sandbox owns the actors and handles this itself;
    // online the server does, and only when it has been started with
    // 'CT_DEBUG_PLACE' set — otherwise it ignores the message. Forwarding it
    // here rather than from the flight subsystem keeps the two paths symmetric:
    // the same 'debug:place' event sets up the same situation either way, which
    // is what lets the playability harness fly the same bombing run online as
    // it does offline.
    ctx.bus.on('debug:place', (p: {
      x: number; y: number; z: number;
      heading: number; pitch: number; bank: number; speed: number;
    }) => {
      if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.send(JSON.stringify({
          t: 'debugPlace',
          x: p.x, y: p.y, z: p.z,
          heading: p.heading, pitch: p.pitch, bank: p.bank, speed: p.speed,
        }));
      } catch { /* dropped */ }
    });

    const url = this.resolveUrl();

    // Never block boot on the network: if the server is not there we fall back
    // to an offline sandbox so the game is still playable and screenshottable.
    const ok = await this.connect(url, 2500).catch(() => false);
    if (!ok) {
      this.offline = true;
      ctx.mapSeed = this.mapSeed;
      // No server to ask, so derive the sky from the map seed. Deterministic on
      // purpose: the screenshot and playability harnesses both run this path and
      // a sandbox that rolled fresh weather every load would make every capture
      // and every threshold non-reproducible.
      this.applyMatchEnvironment(matchEnvironment(this.mapSeed), 'sandbox');
      console.warn('[net] no server — running offline sandbox');
      ctx.bus.emit('net:offline');
    }
  }

  /**
   * Latches the match sky and republishes it.
   *
   * 'sky:*' consumers can simply listen for 'net:environment'; the flight model
   * cannot, because it must be holding the right wind field before the very
   * first prediction step, so it reads these fields directly at init instead.
   */
  private applyMatchEnvironment(
    env: { weather: WeatherId; timeOfDay: number }, source: string,
  ): void {
    const params = new URLSearchParams(location.search);
    // Query overrides exist so a stormy match can be reproduced on demand
    // without restarting the server and hoping. Client-side only, which is
    // safe for the clock (presentation) but *not* for the weather in a real
    // match — see the guard below.
    const forced = params.get('weather');
    let weather = env.weather;
    if (isWeatherId(forced)) {
      if (this.offline) weather = forced;
      else console.warn(`[net] ignoring ?weather=${forced}: the server owns match weather`);
    }
    const timeOfDay = params.has('tod')
      ? clampTimeOfDay(Number(params.get('tod')))
      : clampTimeOfDay(env.timeOfDay);

    const changed = !this.envApplied
      || weather !== this.weather
      || Math.abs(timeOfDay - this.matchTimeOfDay) > 1e-4;
    this.envApplied = true;
    this.weather = weather;
    this.matchTimeOfDay = timeOfDay;
    // Only on an actual change. 'match' repeats the environment every two
    // seconds, and writing ctx.timeOfDay unconditionally would stamp on the
    // debug clock slider and on any camera framing that set its own hour.
    if (!changed) return;
    this.ctx.timeOfDay = timeOfDay;
    const hh = Math.floor(timeOfDay);
    const mm = Math.round((timeOfDay - hh) * 60);
    console.info(
      `[net] match sky: ${weather} at ${String(hh).padStart(2, '0')}:`
      + `${String(mm).padStart(2, '0')} (${source})`,
    );
    this.ctx.bus.emit('net:environment', { weather, timeOfDay, source });
  }

  private resolveUrl(): string {
    const override = new URLSearchParams(location.search).get('server');
    if (override) return override;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  private connect(url: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };

      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch { return done(false); }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      const timer = setTimeout(() => { if (!this.connected) { try { ws.close(); } catch {} done(false); } }, timeoutMs);

      ws.onopen = () => {
        this.connected = true;
        clearTimeout(timer);
        const name = localStorage.getItem('celthunder.name') || `Pilot${Math.floor(Math.random() * 900 + 100)}`;
        ws.send(JSON.stringify({ t: 'hello', name, version: PROTOCOL_VERSION }));
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          this.onJson(JSON.parse(ev.data));
          if (!settled) done(true);
        } else {
          this.onBinary(ev.data as ArrayBuffer);
        }
      };

      ws.onerror = () => { clearTimeout(timer); done(false); };
      ws.onclose = () => {
        clearTimeout(timer);
        if (this.connected) {
          this.connected = false;
          this.ctx?.bus.emit('net:disconnected');
          console.warn('[net] disconnected');
        }
        done(false);
      };
    });
  }

  // -------------------------------------------------------------------------

  private onJson(msg: any): void {
    switch (msg.t) {
      case 'welcome':
        this.playerId = msg.playerId;
        this.team = msg.team;
        this.mapSeed = msg.mapSeed;
        this.mapName = msg.mapName;
        this.players = msg.players ?? [];
        this.ctx.localPlayerId = msg.playerId;
        // The roster fact only. What the HUD colours against is the team on
        // the player's own replicated aircraft — see GameContext.localTeam.
        this.ctx.assignedTeam = msg.team;
        this.ctx.mapSeed = msg.mapSeed;
        // Before 'net:welcome': every consumer of that event is entitled to see
        // the match sky already in force, and the sky/flight subsystems have not
        // even been initialised yet at this point in the boot.
        this.applyMatchEnvironment(
          {
            weather: isWeatherId(msg.weather) ? msg.weather : 'scattered',
            timeOfDay: typeof msg.timeOfDay === 'number' ? msg.timeOfDay : 9.5,
          },
          'server',
        );
        this.ctx.bus.emit('net:welcome', msg);
        break;
      case 'spawned':
        this.ctx.localEntityId = msg.entityId;
        this.pending.length = 0;
        this.ctx.bus.emit('net:spawned', msg);
        break;
      case 'match':
        this.scoreA = msg.scoreA; this.scoreB = msg.scoreB;
        this.timeLeft = msg.timeLeft; this.players = msg.players ?? [];
        if (isWeatherId(msg.weather) && typeof msg.timeOfDay === 'number') {
          this.applyMatchEnvironment({ weather: msg.weather, timeOfDay: msg.timeOfDay }, 'server');
        }
        this.ctx.bus.emit('net:match', msg);
        break;
      case 'stores':
        // The racks are the server's. This is the only thing that moves the
        // client's stores readout online.
        this.ctx.bus.emit('net:stores', msg);
        break;
      case 'kill':
        this.ctx.bus.emit('net:kill', msg);
        break;
      case 'chat':
        this.ctx.bus.emit('net:chat', msg);
        break;
      case 'error':
        console.error('[net]', msg.message);
        this.ctx.bus.emit('net:error', msg);
        break;
    }
  }

  private onBinary(buf: ArrayBuffer): void {
    const dv = new DataView(buf);
    const id = dv.getUint8(0);
    if (id === S2C.Snapshot) this.onSnapshot(dv);
    else if (id === S2C.Event) this.onEvents(dv);
    else if (id === S2C.Ping) this.onPing(dv);
  }

  private onSnapshot(dv: DataView): void {
    let off = 1;
    const tick = dv.getUint32(off, true); off += 4;
    const serverTime = dv.getFloat32(off, true); off += 4;
    const ackSeq = dv.getUint16(off, true); off += 2;
    const count = dv.getUint16(off, true); off += 2;

    const states = new Map<number, EntityState>();
    for (let i = 0; i < count; i++) {
      const e = this.statePool.pop() ?? newEntityState();
      off = readEntity(dv, off, e);
      states.set(e.id, e);
    }

    const snap: Snapshot = { tick, serverTime, ackSeq, states, recvAt: performance.now() / 1000 };

    // Discard out-of-order snapshots — UDP-like reordering can happen over
    // some proxies even on a TCP-framed WebSocket if a reconnect intervenes.
    const newest = this.snapshots[this.snapshots.length - 1];
    if (newest && tick <= newest.tick) {
      this.recycle(snap);
      return;
    }

    this.snapshots.push(snap);
    while (this.snapshots.length > SNAPSHOT_BUFFER) this.recycle(this.snapshots.shift()!);

    // Drop pending inputs the server has now consumed.
    while (this.pending.length && seqLE(this.pending[0].seq, ackSeq)) this.pending.shift();

    if (!this.clockInitialised) {
      this.renderTime = serverTime - INTERP_DELAY;
      this.clockInitialised = true;
    }

    this.ctx.bus.emit('net:snapshot', snap);
  }

  private recycle(s: Snapshot): void {
    for (const e of s.states.values()) {
      if (this.statePool.length < 1024) this.statePool.push(e);
    }
    s.states.clear();
  }

  private onEvents(dv: DataView): void {
    let off = 1;
    const n = dv.getUint16(off, true); off += 2;
    for (let i = 0; i < n; i++) {
      const kind = dv.getUint8(off) as EventKind; off += 1;
      off += 1;
      const a = dv.getUint16(off, true); off += 2;
      const x = dv.getFloat32(off, true); off += 4;
      const y = dv.getFloat32(off, true); off += 4;
      const z = dv.getFloat32(off, true); off += 4;
      const nx = dv.getInt16(off, true) / 32767; off += 2;
      const ny = dv.getInt16(off, true) / 32767; off += 2;
      const nz = dv.getInt16(off, true) / 32767; off += 2;
      const scale = dv.getFloat32(off, true); off += 4;
      const b = dv.getUint16(off, true); off += 2;
      off += 4;
      this.ctx.bus.emit('game:event', { kind, x, y, z, nx, ny, nz, scale, a, b });
    }
  }

  private onPing(dv: DataView): void {
    const stamp = dv.getFloat64(1, true);
    const out = new ArrayBuffer(9);
    const odv = new DataView(out);
    odv.setUint8(0, C2S.Pong);
    odv.setFloat64(1, stamp, true);
    this.ws?.send(out);
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /**
   * Queues an input frame for the server and keeps it for reconciliation.
   * Called by the input subsystem once per rendered frame.
   */
  sendInput(f: Omit<InputFrame, 'seq'>): InputFrame {
    const frame: InputFrame = { ...f, seq: this.inputSeq++ & 0xffff };
    this.pending.push(frame);
    if (this.pending.length > MAX_PENDING_INPUTS) this.pending.shift();

    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      // Send the newest frame plus up to 3 previous ones. A dropped packet
      // then costs nothing because the next packet re-delivers it, which is
      // far cheaper than any retransmit scheme.
      const redundancy = Math.min(4, this.pending.length);
      let off = 0;
      this.outView.setUint8(off, C2S.Input); off += 1;
      this.outView.setUint8(off, redundancy); off += 1;
      for (let i = this.pending.length - redundancy; i < this.pending.length; i++) {
        off = writeInputFrame(this.outView, off, this.pending[i]);
      }
      try { this.ws.send(new Uint8Array(this.outBuf, 0, off)); } catch { /* dropped */ }
    }
    return frame;
  }

  /**
   * Asks for a spawn.
   *
   * Online the server is authoritative and answers with its own entity id.
   * Offline the sandbox owns the actor list, so we must ASK it rather than
   * invent an id: fabricating one (this used to emit 'entityId: 1') re-bound
   * the local flight state to an entity that did not exist, at the world
   * origin — which on this map is ~800 m below the terrain surface. The gear
   * then resolved a 6.5e8 N ground contact, the airframe was destroyed on the
   * first tick, and the aircraft could never exceed a 46 km/h ground scrape.
   * That is the difference between "the renderer works" and "the game is
   * playable", so the id must always come from whoever actually owns actors.
   */
  requestSpawn(aircraft: string, loadout = 'clean'): void {
    if (this.connected) {
      // The loadout goes with the request: the server arms the aeroplane, flies
      // it against the loaded variant spec and owns the racks from there.
      this.ws?.send(JSON.stringify({ t: 'spawn', aircraft, loadout }));
      return;
    }
    // The offline sandbox listens for this and replies with 'net:spawned'
    // carrying the real entity id once the actor exists.
    this.ctx.bus.emit('game:spawnRequest', { aircraft, loadout });
  }

  sendChat(text: string): void {
    if (this.connected) this.ws?.send(JSON.stringify({ t: 'chat', text }));
  }

  /** Inputs the local prediction must replay after a correction. */
  get pendingInputs(): readonly InputFrame[] { return this.pending; }

  /** The newest authoritative state for an entity, or undefined. */
  authoritative(entityId: number): EntityState | undefined {
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      const s = this.snapshots[i].states.get(entityId);
      if (s) return s;
    }
    return undefined;
  }

  get latestSnapshot(): Snapshot | undefined { return this.snapshots[this.snapshots.length - 1]; }

  // -------------------------------------------------------------------------
  // Per-frame: advance the interpolation clock and fill ctx.entities
  // -------------------------------------------------------------------------

  update(ctx: GameContext): void {
    if (this.offline || this.snapshots.length === 0) return;

    // Advance the render clock at real time, then gently pull it toward the
    // target (newest server time minus the interpolation delay). Pulling
    // rather than snapping keeps remote motion smooth when jitter changes.
    this.renderTime += ctx.dt;
    const newest = this.snapshots[this.snapshots.length - 1];
    const target = newest.serverTime - INTERP_DELAY;
    const err = target - this.renderTime;
    // Large error means we lost the thread (stall, tab restore) — resync hard.
    if (Math.abs(err) > 0.5) this.renderTime = target;
    else this.renderTime += err * Math.min(1, ctx.dt * 3.0);

    this.interpolateInto(ctx.entities);
  }

  /**
   * Fills 'out' with each entity's state at 'renderTime', interpolating
   * between the bracketing snapshots. The locally controlled aircraft is
   * skipped — the flight/prediction subsystem owns it.
   */
  private interpolateInto(out: Map<number, EntityState>): void {
    // Find the snapshot pair that brackets renderTime.
    let older: Snapshot | undefined;
    let newer: Snapshot | undefined;
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i].serverTime <= this.renderTime) {
        older = this.snapshots[i];
        newer = this.snapshots[i + 1];
        break;
      }
    }
    if (!older) { older = this.snapshots[0]; newer = this.snapshots[1]; }

    const span = newer ? newer.serverTime - older.serverTime : 0;
    const t = span > 1e-5 ? Math.min(1, Math.max(0, (this.renderTime - older.serverTime) / span)) : 0;

    const seen = new Set<number>();

    for (const [id, a] of older.states) {
      seen.add(id);
      if (id === this.ctx.localEntityId) continue;

      let e = out.get(id);
      if (!e) { e = newEntityState(); out.set(id, e); }

      const b = newer?.states.get(id);
      if (!b) {
        // No future sample: extrapolate briefly using the last known velocity
        // rather than freezing, capped so a lost player does not fly off.
        const extra = Math.min(0.25, this.renderTime - older.serverTime);
        copyState(a, e);
        e.px += a.vx * extra; e.py += a.vy * extra; e.pz += a.vz * extra;
        continue;
      }

      e.id = id; e.kind = a.kind; e.ownerId = a.ownerId; e.team = a.team;
      e.typeId = a.typeId; e.damage = b.damage;
      e.px = lerp(a.px, b.px, t);
      e.py = lerp(a.py, b.py, t);
      e.pz = lerp(a.pz, b.pz, t);
      e.vx = lerp(a.vx, b.vx, t);
      e.vy = lerp(a.vy, b.vy, t);
      e.vz = lerp(a.vz, b.vz, t);

      this.scratchA.x = a.qx; this.scratchA.y = a.qy; this.scratchA.z = a.qz; this.scratchA.w = a.qw;
      this.scratchB.x = b.qx; this.scratchB.y = b.qy; this.scratchB.z = b.qz; this.scratchB.w = b.qw;
      const r = qslerp(this.scratchA, this.scratchB, t, _qout);
      e.qx = r.x; e.qy = r.y; e.qz = r.z; e.qw = r.w;

      e.throttle = lerp(a.throttle, b.throttle, t);
      e.rpm = lerp(a.rpm, b.rpm, t);
      e.health = lerp(a.health, b.health, t);
      e.flaps = lerp(a.flaps, b.flaps, t);
      e.gear = lerp(a.gear, b.gear, t);
      e.ctlPitch = lerp(a.ctlPitch, b.ctlPitch, t);
      e.ctlRoll = lerp(a.ctlRoll, b.ctlRoll, t);
      e.ctlYaw = lerp(a.ctlYaw, b.ctlYaw, t);
    }

    // Remove entities that no longer exist server-side.
    for (const id of [...out.keys()]) {
      if (!seen.has(id) && id !== this.ctx.localEntityId) out.delete(id);
    }
  }

  dispose(): void {
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
  }
}

const _qout: Q = q();

function copyState(a: EntityState, e: EntityState): void {
  e.id = a.id; e.kind = a.kind; e.ownerId = a.ownerId; e.team = a.team; e.typeId = a.typeId;
  e.px = a.px; e.py = a.py; e.pz = a.pz;
  e.qx = a.qx; e.qy = a.qy; e.qz = a.qz; e.qw = a.qw;
  e.vx = a.vx; e.vy = a.vy; e.vz = a.vz;
  e.throttle = a.throttle; e.rpm = a.rpm; e.health = a.health; e.damage = a.damage;
  e.flaps = a.flaps; e.gear = a.gear;
  e.ctlPitch = a.ctlPitch; e.ctlRoll = a.ctlRoll; e.ctlYaw = a.ctlYaw;
}

/** Wrapped u16 sequence comparison: is 'a' <= 'b' accounting for wraparound? */
function seqLE(a: number, b: number): boolean {
  return ((b - a) & 0xffff) < 30000;
}
