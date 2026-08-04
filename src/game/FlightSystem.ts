import type { GameContext, Subsystem } from '../engine/context';
import {
  EntityKind, newEntityState, type EntityState, type InputFrame,
} from '../shared/protocol';
import { aircraftByIndex, AIRCRAFT_BY_ID, type AircraftSpec } from '../shared/aircraft';
import { clamp, q, qslerp, qconj, qmul, v3, type Q } from '../shared/math';
import type { NetSystem } from '../net/NetSystem';
import { getClientEnv, type ClientEnv } from './env';
import {
  loadExternals, externals, readFlightTransform, writeFlightTransform,
  readFlightScalar, newFlightTransform,
  type FlightModule, type FlightState, type FlightTransform,
} from './externals';
import { isWeatherId, type WeatherId } from '../shared/environment';
import { InputBridge } from './inputBridge';
import { OfflineSandbox, type DebugPlacement } from './OfflineSandbox';
import { OrdnanceRuntime } from './OrdnanceRuntime';
import { flightSpecFor } from './loadout';

/**
 * Client-side prediction, reconciliation and the offline sandbox.
 *
 * ## Why predict at all
 *
 * The server is authoritative and 20 Hz. Waiting for it would put 60–120 ms
 * between the stick moving and the nose moving, which in an air-combat game is
 * the difference between "responsive" and "unplayable". So the local aircraft
 * is stepped immediately, every frame, through the *same deterministic model*
 * the server runs, from the same input frame that was just sent.
 *
 * ## Reconciliation
 *
 * Each snapshot acks the last input the server consumed. We take the server's
 * authoritative state for that instant, write it into the flight state, and
 * replay every input the server has not yet seen. That produces a corrected
 * "now" which is what the physics continues from.
 *
 * The corrected position almost never exactly matches what we had predicted —
 * floating-point divergence, a dropped input, a hit we did not know about. If
 * the discrepancy is small we do **not** move the aeroplane: we keep the
 * difference as a *visual* offset and decay it to zero over ~150 ms, so the
 * player sees a continuous trajectory while the simulation is already correct.
 * If it is large (>8 m or >12°) there is nothing to hide — the correction is
 * applied instantly, because smearing a big error over time looks far worse
 * than a single honest snap.
 *
 * ## Offline
 *
 * With no server, 'OfflineSandbox' runs a real six-ship match locally and this
 * subsystem simply forwards the player's input to it.
 */

/** Error thresholds above which we stop smoothing and snap. */
const HARD_POS = 8.0;                       // metres
const HARD_ROT = 12 * (Math.PI / 180);      // radians

/** Time constant of the smoothing blend. Three of these ≈ 150 ms to invisible. */
const BLEND_TAU = 0.05;

const MAX_HISTORY = 240;

interface PredSample {
  seq: number;
  t: FlightTransform;
}

/** Everything the flight model publishes that the presentation layer reads. */
export interface AirData {
  /** Indicated airspeed, m/s. */
  ias: number;
  /** True airspeed, m/s. */
  tas: number;
  alpha: number;
  gLoad: number;
  mach: number;
  stall: number;
  /** Altitude ASL, m. */
  altitude: number;
  /** Height above the terrain directly below, m. */
  agl: number;
  vertSpeed: number;
  pitchAngle: number;
  rollAngle: number;
  heading: number;
  throttle: number;
  health: number;
  damage: number;
  onGround: boolean;
}

export interface PredictionStats {
  /** Snapshots reconciled since boot. */
  corrections: number;
  /** How many of those exceeded the smoothing thresholds and had to snap. */
  hard: number;
  /** Largest positional discrepancy seen, metres. */
  maxErr: number;
  /** Inputs replayed on the most recent reconcile. */
  replayed: number;
}

const _pred: FlightTransform = newFlightTransform();
const _auth: FlightTransform = newFlightTransform();
const _before: FlightTransform = newFlightTransform();
const _qa: Q = q();
const _qb: Q = q();
const _qc: Q = q();
const _qIdent: Q = q();

export class FlightSystem implements Subsystem {
  readonly name = 'flight';

  /**
   * The shared flight model. There is no client-side stand-in any more: the
   * model in 'src/shared/flight' is the one the server integrates, and a client
   * predicting with anything else is not predicting, it is guessing. If it
   * cannot be resolved this subsystem fails its init loudly and 'Game' boots
   * without it.
   */
  private model!: FlightModule;
  private usingShared = false;

  private ctx!: GameContext;
  private env!: ClientEnv;
  private net: NetSystem | undefined;
  private bridge = new InputBridge();

  private sandbox: OfflineSandbox | null = null;

  /**
   * Air-to-ground stores. Owned here because this is the one subsystem that
   * has the local aircraft's state in both modes — the sandbox's actor offline,
   * the predicted flight state online — and because carrying ordnance changes
   * the mass and the drag the model integrates with.
   */
  private ordnance = new OrdnanceRuntime();
  /** Loadout chosen in the hangar, applied on the next spawn. */
  private pendingLoadout = 'clean';
  /**
   * The spec handed to 'stepFlight'. Identical to 'localSpec' when clean, and a
   * higher-cd0 variant while stores are aboard — see 'loadout.ts' for why the
   * penalty has to travel on the spec rather than on the state.
   */
  private localFlightSpec: AircraftSpec | null = null;

  // --- local prediction ------------------------------------------------------
  private localFlight: FlightState | null = null;
  private localSpec: AircraftSpec | null = null;
  private localEntity: EntityState = newEntityState();
  private boundEntityId = 0;

  private history: PredSample[] = [];
  private lastSnapshotTick = -1;

  /** Smoothed-out prediction error, applied at render time only. */
  private errX = 0; private errY = 0; private errZ = 0;
  private errQ: Q = q();

  // --- diagnostics -----------------------------------------------------------
  private debug = false;
  private stats: PredictionStats = { corrections: 0, hard: 0, maxErr: 0, replayed: 0 };

  async init(ctx: GameContext): Promise<void> {
    this.ctx = ctx;
    this.debug = resolveDebugFlag();

    this.net = ctx.get<NetSystem>('net');
    // The air has to be built for the match weather *before* the first
    // prediction step: the wind field and the turbulence amplitude are both
    // functions of it, and the server integrates against exactly the same pair
    // of numbers. Getting this wrong does not look like weather, it looks like
    // a permanent rubber-band.
    this.env = getClientEnv(ctx.mapSeed, this.matchWeather());

    const ext = await loadExternals(ctx.mapSeed);
    if (!ext.flight) {
      throw new Error(
        'shared flight model (src/shared/flight) did not resolve — refusing to fly a stand-in',
      );
    }
    this.model = ext.flight;
    this.usingShared = true;

    // A new match can bring new weather, and the air the model integrates
    // against has to follow it or client and server diverge.
    ctx.bus.on('net:environment', (p: { weather?: string }) => {
      if (isWeatherId(p?.weather)) this.env.setWeather(p.weather);
    });
    this.bridge.attach(ctx.get('input'));

    ctx.bus.on('net:spawned', (m: { entityId: number; aircraft?: string }) => {
      this.onSpawned(m.entityId, m.aircraft);
    });
    ctx.bus.on('net:offline', () => this.startSandbox());

    // --- ordnance ----------------------------------------------------------
    this.ordnance.init(ctx, this.env);
    // The hangar announces the chosen loadout before the spawn lands; the
    // spawn is what arms it, so that the stores are always in step with an
    // aeroplane that actually exists.
    ctx.bus.on('ui:spawn', (m: { loadout?: string }) => {
      this.pendingLoadout = m?.loadout ?? 'clean';
    });
    ctx.bus.on('net:spawned', (m: { aircraft?: string }) => {
      const spec = (m?.aircraft && AIRCRAFT_BY_ID[m.aircraft])
        || this.localSpec || this.sandbox?.playerSpec || null;
      this.ordnance.setLoadout(spec, this.pendingLoadout);
      this.localFlightSpec = null;
    });

    // Screenshot framings ask for a posed situation (see CameraSystem.
    // debugFraming). Only the sandbox can honour it — online the server owns
    // every actor — so it is a no-op in a real match rather than a desync.
    ctx.bus.on('debug:place', (p: DebugPlacement) => {
      if (!this.sandbox) return;
      this.sandbox.placeSubject(p);
      // The teleport invalidates every predicted sample and the smoothed
      // correction offset; keeping either would drag the aircraft back toward
      // where it used to be for the next 150 ms, right through the capture.
      this.history.length = 0;
      this.errX = this.errY = this.errZ = 0;
      this.errQ.x = this.errQ.y = this.errQ.z = 0; this.errQ.w = 1;
    });

    // NetSystem decides offline during its own init, which has already run by
    // the time we get here, so check directly as well as via the event.
    if (this.net?.offline) this.startSandbox();

    if (this.debug) {
      (window as unknown as Record<string, unknown>).__flight = this;
      console.info('[flight] prediction debug enabled (?flightdebug=1)');
    }
  }

  /** Match weather from the netcode, defaulting to the fair-weather sky. */
  private matchWeather(): WeatherId {
    const w = (this.net as unknown as { weather?: unknown } | undefined)?.weather;
    return isWeatherId(w) ? w : 'scattered';
  }

  private startSandbox(): void {
    if (this.sandbox) return;
    this.sandbox = new OfflineSandbox(this.ctx, this.env, this.model);
    this.sandbox.start();
    console.info('[flight] offline sandbox running');
  }

  private onSpawned(entityId: number, aircraftId?: string): void {
    if (this.sandbox) return;         // the sandbox owns its own actors
    this.boundEntityId = entityId;
    this.ctx.localEntityId = entityId;
    this.localFlight = null;
    this.history.length = 0;
    this.errX = this.errY = this.errZ = 0;
    this.errQ.x = this.errQ.y = this.errQ.z = 0; this.errQ.w = 1;
    if (aircraftId && AIRCRAFT_BY_ID[aircraftId]) this.localSpec = AIRCRAFT_BY_ID[aircraftId];
  }

  // -------------------------------------------------------------------------

  update(ctx: GameContext): void {
    const dt = ctx.dt;
    if (dt <= 0) return;

    this.bridge.refresh();
    const frame = this.bridge.sample(dt, ctx.settings);

    // The netcode wants every frame regardless of mode: offline it costs one
    // push into a bounded ring, and it keeps the sequence numbering continuous
    // if a server appears mid-session.
    const sent = this.net ? this.net.sendInput(frame) : { ...frame, seq: 0 };

    // Stores first: mass and drag have to be on the aeroplane before it is
    // integrated, not a frame behind it.
    this.applyStores();

    if (this.sandbox) {
      this.sandbox.step(dt, sent);
      this.ordnance.update(dt, sent.bits);
      this.publishOrdnance();
      return;
    }

    this.ensureLocalState(ctx);
    if (!this.localFlight || !this.localSpec) return;

    this.reconcile();

    // --- predict ------------------------------------------------------------
    (this.localFlight as Record<string, unknown>).damage = this.localEntity.damage;
    this.model.stepFlight(this.localFlight, this.flightSpec(), sent, this.env, dt);
    this.pushHistory(sent.seq);

    // --- decay the visual correction ---------------------------------------
    const k = Math.exp(-dt / BLEND_TAU);
    this.errX *= k; this.errY *= k; this.errZ *= k;
    qslerp(this.errQ, _qIdent, 1 - k, _qc);
    this.errQ.x = _qc.x; this.errQ.y = _qc.y; this.errQ.z = _qc.z; this.errQ.w = _qc.w;

    this.publish(ctx, sent);

    // After 'publish', so the runtime reads this frame's transform rather than
    // the previous one when it works out where a bomb released now would land.
    this.ordnance.update(dt, sent.bits);
    this.publishOrdnance();
  }

  // -------------------------------------------------------------------------
  // Stores
  // -------------------------------------------------------------------------

  /**
   * Hands the carried mass to the flight state and the carriage drag to the
   * spec the model integrates against.
   *
   * 'extraMass' is a field the shared model already honours in 'updateMass'.
   * Drag has no equivalent — 'dmg.extraDrag' is rebuilt from the damage bits
   * at the top of every step — so it travels on a variant spec instead. See
   * 'loadout.ts'.
   */
  private applyStores(): void {
    const mass = this.ordnance.extraMass;
    const cdArea = this.ordnance.extraDragArea;
    if (this.sandbox) {
      this.sandbox.setPlayerStores(mass, cdArea);
      return;
    }
    const f = this.localFlight as Record<string, unknown> | null;
    if (f && typeof f.extraMass === 'number') f.extraMass = mass;
    this.localFlightSpec = this.localSpec ? flightSpecFor(this.localSpec, cdArea) : null;
  }

  /** The spec to integrate against this frame — loaded variant or the clean one. */
  private flightSpec(): AircraftSpec {
    return this.localFlightSpec ?? this.localSpec!;
  }

  private publishOrdnance(): void {
    this.ctx.bus.emit('hud:ordnance', this.ordnance.hudState);
  }

  /** Creates the local flight state the first time the server tells us where we are. */
  private ensureLocalState(ctx: GameContext): void {
    const id = ctx.localEntityId;
    if (!id) return;
    if (this.localFlight && this.boundEntityId === id) return;

    const auth = this.net?.authoritative(id);
    if (!auth) return;

    this.boundEntityId = id;
    this.localSpec = aircraftByIndex(auth.typeId);
    this.localFlight = this.model.createFlightState(
      this.localSpec,
      v3(auth.px, auth.py, auth.pz),
      q(auth.qx, auth.qy, auth.qz, auth.qw),
    );

    // Match the powerplant, gear and fuel state the server spawned with.
    // 'createFlightState' hands back a cold engine at idle with the gear down;
    // stepping that against a server that air-started with a warm engine
    // produces a metre of divergence per tick and a permanent rubber-band.
    // The transform written immediately below overrides the pose this sets.
    if (this.model.spawnInFlight) {
      const speed = Math.hypot(auth.vx, auth.vy, auth.vz);
      const heading = headingOf(auth.qx, auth.qy, auth.qz, auth.qw);
      this.model.spawnInFlight(
        this.localFlight, this.localSpec, this.env,
        auth.py, speed, heading, auth.throttle,
      );
      const f = this.localFlight as Record<string, unknown>;
      f.gear = auth.gear; f.gearTarget = auth.gear;
      f.flaps = auth.flaps; f.flapsTarget = auth.flaps;
      f.damage = auth.damage; f.health = auth.health;
    }

    _auth.px = auth.px; _auth.py = auth.py; _auth.pz = auth.pz;
    _auth.vx = auth.vx; _auth.vy = auth.vy; _auth.vz = auth.vz;
    _auth.qx = auth.qx; _auth.qy = auth.qy; _auth.qz = auth.qz; _auth.qw = auth.qw;
    _auth.wx = 0; _auth.wy = 0; _auth.wz = 0;
    writeFlightTransform(this.localFlight, _auth);
    this.history.length = 0;
    this.errX = this.errY = this.errZ = 0;
    this.errQ.x = this.errQ.y = this.errQ.z = 0; this.errQ.w = 1;
    copyEntity(auth, this.localEntity);
  }

  /**
   * Applies the newest authoritative state and replays everything the server
   * has not acknowledged yet.
   */
  private reconcile(): void {
    const net = this.net;
    if (!net || !this.localFlight || !this.localSpec) return;
    const snap = net.latestSnapshot;
    if (!snap || snap.tick === this.lastSnapshotTick) return;
    this.lastSnapshotTick = snap.tick;

    const auth = snap.states.get(this.boundEntityId);
    if (!auth) return;

    // What we were about to show, before the correction.
    readFlightTransform(this.localFlight, _before);

    // Authoritative state at the acked input.
    _auth.px = auth.px; _auth.py = auth.py; _auth.pz = auth.pz;
    _auth.vx = auth.vx; _auth.vy = auth.vy; _auth.vz = auth.vz;
    _auth.qx = auth.qx; _auth.qy = auth.qy; _auth.qz = auth.qz; _auth.qw = auth.qw;
    _auth.wx = _before.wx; _auth.wy = _before.wy; _auth.wz = _before.wz;
    writeFlightTransform(this.localFlight, _auth);
    this.applyAuthoritativeScalars(auth);

    // Replay every input the server has not consumed. This is the whole point:
    // the correction is applied at the *acked* instant, not at "now", so the
    // player's most recent stick movements are not thrown away.
    const pending = net.pendingInputs;
    for (let i = 0; i < pending.length; i++) {
      const f = pending[i];
      const fdt = clamp(f.dt, 0.002, 0.05);
      // Same spec the live prediction uses, stores and all: replaying against
      // the clean airframe would re-introduce the divergence on every reconcile.
      this.model.stepFlight(this.localFlight, this.flightSpec(), f, this.env, fdt);
    }
    this.stats.replayed = pending.length;

    readFlightTransform(this.localFlight, _pred);

    // Residual error = (what we showed) − (what is actually true now).
    const dx = _before.px - _pred.px;
    const dy = _before.py - _pred.py;
    const dz = _before.pz - _pred.pz;
    const dist = Math.hypot(dx, dy, dz);

    _qa.x = _before.qx; _qa.y = _before.qy; _qa.z = _before.qz; _qa.w = _before.qw;
    _qb.x = _pred.qx; _qb.y = _pred.qy; _qb.z = _pred.qz; _qb.w = _pred.qw;
    qmul(_qa, qconj(_qb, _qc), _qc);
    if (_qc.w < 0) { _qc.x = -_qc.x; _qc.y = -_qc.y; _qc.z = -_qc.z; _qc.w = -_qc.w; }
    const angle = 2 * Math.acos(clamp(_qc.w, -1, 1));

    this.stats.corrections++;
    this.stats.maxErr = Math.max(this.stats.maxErr, dist);

    if (dist > HARD_POS || angle > HARD_ROT) {
      // Too big to hide. Snap, and say so.
      this.stats.hard++;
      this.errX = this.errY = this.errZ = 0;
      this.errQ.x = this.errQ.y = this.errQ.z = 0; this.errQ.w = 1;
      if (this.debug) {
        console.warn(
          `[flight] hard correction: ${dist.toFixed(2)} m / ${(angle * 180 / Math.PI).toFixed(1)}° `
          + `(replayed ${pending.length} inputs, tick ${snap.tick})`,
        );
      }
    } else {
      // Small: carry it as a visual offset that melts away.
      this.errX = dx; this.errY = dy; this.errZ = dz;
      this.errQ.x = _qc.x; this.errQ.y = _qc.y; this.errQ.z = _qc.z; this.errQ.w = _qc.w;
      if (this.debug && dist > 0.35) {
        console.debug(`[flight] soft correction ${dist.toFixed(2)} m, blending out`);
      }
    }

    // History before the ack is now worthless.
    const ack = snap.ackSeq;
    while (this.history.length && seqLE(this.history[0].seq, ack)) this.history.shift();
  }

  /**
   * Copies the authoritative non-transform state (throttle, gear, damage) into
   * the flight state where the model exposes it. Damage in particular must come
   * from the server or the replay diverges the moment we take a hit.
   */
  private applyAuthoritativeScalars(auth: EntityState): void {
    const f = this.localFlight as Record<string, unknown> | null;
    if (!f) return;
    if (typeof f.throttle === 'number') f.throttle = auth.throttle;
    if (typeof f.gear === 'number') f.gear = auth.gear;
    if (typeof f.flaps === 'number') f.flaps = auth.flaps;
    f.damage = auth.damage;
    copyEntity(auth, this.localEntity);
  }

  private pushHistory(seq: number): void {
    if (!this.localFlight) return;
    const sample = this.history.length >= MAX_HISTORY
      ? this.history.shift()!
      : { seq: 0, t: newFlightTransform() };
    sample.seq = seq;
    readFlightTransform(this.localFlight, sample.t);
    this.history.push(sample);
  }

  /** Writes the predicted (plus smoothed) state into the shared entity table. */
  private publish(ctx: GameContext, input: InputFrame): void {
    if (!this.localFlight || !this.localSpec) return;
    readFlightTransform(this.localFlight, _pred);

    const s = this.localEntity;
    s.id = this.boundEntityId;
    s.kind = EntityKind.Aircraft;
    // 'team' and 'typeId' are NOT written here. Both are copied wholesale from
    // the authoritative record in 'ensureLocalState' and refreshed on every
    // reconcile, so the aeroplane the player is flying reports the side and the
    // airframe the *server* put them in. Re-deriving the team from a
    // client-tracked field is precisely how the HUD came to paint Axis
    // contacts as friendlies: the server had substituted the airframe and
    // moved the pilot, and nothing downstream ever heard about it.
    s.ownerId = ctx.localPlayerId;

    s.px = _pred.px + this.errX;
    s.py = _pred.py + this.errY;
    s.pz = _pred.pz + this.errZ;
    s.vx = _pred.vx; s.vy = _pred.vy; s.vz = _pred.vz;

    _qb.x = _pred.qx; _qb.y = _pred.qy; _qb.z = _pred.qz; _qb.w = _pred.qw;
    qmul(this.errQ, _qb, _qa);
    s.qx = _qa.x; s.qy = _qa.y; s.qz = _qa.z; s.qw = _qa.w;

    s.throttle = clamp(readFlightScalar(this.localFlight, ['throttle'], input.throttle), 0, 1);
    const rawRpm = readFlightScalar(this.localFlight, ['rpm', 'propRpm'], 0.18 + s.throttle * 0.82);
    s.rpm = clamp(rawRpm > 2 ? rawRpm / this.localSpec.engine.maxRpm : rawRpm, 0, 1);
    s.gear = clamp(readFlightScalar(this.localFlight, ['gear', 'gearPos'], s.gear), 0, 1);
    s.flaps = clamp(readFlightScalar(this.localFlight, ['flaps', 'flapPos'], s.flaps), 0, 1);
    s.ctlPitch = clamp(readFlightScalar(this.localFlight, ['ctlPitch'], input.pitch), -1, 1);
    s.ctlRoll = clamp(readFlightScalar(this.localFlight, ['ctlRoll'], input.roll), -1, 1);
    s.ctlYaw = clamp(readFlightScalar(this.localFlight, ['ctlYaw'], input.yaw), -1, 1);

    ctx.entities.set(s.id, s);
  }

  // -------------------------------------------------------------------------
  // Introspection for the HUD and debug overlay
  // -------------------------------------------------------------------------

  /**
   * Air data straight from the flight model, for the HUD and for the
   * playability harness. Undefined until an aircraft is bound.
   *
   * This is deliberately the *model's* own numbers rather than anything
   * re-derived from the replicated entity: it is what lets a test assert that
   * the two agree instead of assuming they do.
   */
  get airData(): AirData | undefined {
    const f = this.localFlight ?? this.sandbox?.playerFlight;
    if (!f) return undefined;
    return {
      ias: readFlightScalar(f, ['ias'], 0),
      tas: readFlightScalar(f, ['tas', 'speed'], 0),
      alpha: readFlightScalar(f, ['alpha'], 0),
      gLoad: readFlightScalar(f, ['gLoad', 'g'], 1),
      mach: readFlightScalar(f, ['mach'], 0),
      stall: readFlightScalar(f, ['stall'], 0),
      altitude: readFlightScalar(f, ['altitude'], 0),
      agl: readFlightScalar(f, ['agl'], 0),
      vertSpeed: readFlightScalar(f, ['vertSpeed'], 0),
      pitchAngle: readFlightScalar(f, ['pitchAngle'], 0),
      rollAngle: readFlightScalar(f, ['rollAngle'], 0),
      heading: readFlightScalar(f, ['heading'], 0),
      throttle: readFlightScalar(f, ['throttle'], 0),
      health: readFlightScalar(f, ['health'], 1),
      damage: readFlightScalar(f, ['damage'], 0),
      onGround: (f as { onGround?: boolean }).onGround === true,
    };
  }

  get predictionStats(): Readonly<PredictionStats> { return this.stats; }
  get offline(): boolean { return this.sandbox !== null; }
  get usingSharedModel(): boolean { return this.usingShared; }
  get sandboxRoster() { return this.sandbox?.roster ?? []; }
  get sandboxShots(): number { return this.sandbox?.shotsFired ?? 0; }

  /**
   * The stores state, for the HUD and for the playability harness — which
   * needs the bombsight solution to know when a release would actually hit
   * what it is aiming at.
   */
  get ordnanceState(): {
    loadout: string; bombs: number; rockets: number; inFlight: number;
    extraMass: number; extraDrag: number;
    solution: { x: number; y: number; z: number; time: number } | null;
    targets: { id: number; kind: string; x: number; y: number; z: number; hp: number; maxHp: number; alive: boolean }[];
  } {
    const h = this.ordnance.hudState;
    return {
      loadout: this.ordnance.loadoutId,
      bombs: this.ordnance.bombsRemaining,
      rockets: this.ordnance.rocketsRemaining,
      inFlight: this.ordnance.storesInFlight,
      extraMass: this.ordnance.extraMass,
      extraDrag: this.ordnance.extraDragArea,
      solution: h.hasSolution ? { x: h.ix, y: h.iy, z: h.iz, time: h.fallTime } : null,
      targets: this.ordnance.groundTargets.map((t) => ({
        id: t.id, kind: t.kind, x: t.x, y: t.y, z: t.z,
        hp: t.hp, maxHp: t.maxHp, alive: t.alive,
      })),
    };
  }

  dispose(): void {
    this.ordnance.dispose();
    this.localFlight = null;
    this.history.length = 0;
    this.sandbox = null;
  }
}

// ---------------------------------------------------------------------------

function resolveDebugFlag(): boolean {
  try {
    if (new URLSearchParams(location.search).has('flightdebug')) return true;
    return localStorage.getItem('celthunder.debug.flight') === '1';
  } catch {
    return false;
  }
}

/** Compass heading of a body +Z axis rotated by this quaternion, radians. */
function headingOf(x: number, y: number, z: number, w: number): number {
  // Forward = q · (0,0,1) · q⁻¹, expanded for just the x and z components.
  const fx = 2 * (x * z + w * y);
  const fz = 1 - 2 * (x * x + y * y);
  return Math.atan2(fx, fz);
}

function copyEntity(a: EntityState, b: EntityState): void {
  b.damage = a.damage;
  b.health = a.health;
  b.team = a.team;
  b.ownerId = a.ownerId;
  b.typeId = a.typeId;
}

/** Wrapped u16 sequence comparison, matching 'NetSystem'. */
function seqLE(a: number, b: number): boolean {
  return ((b - a) & 0xffff) < 30000;
}
