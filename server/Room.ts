import type { WebSocket } from 'ws';
import {
  S2C, EntityKind, DamageBits, EventKind, InputBits,
  TICK_HZ, TICK_DT, SNAPSHOT_EVERY, LAGCOMP_HISTORY,
  ENTITY_BYTES, SNAPSHOT_HEADER_BYTES, INPUT_FRAME_BYTES,
  newEntityState, readInputFrame, writeEntity,
  type EntityState, type InputFrame, type GameEvent, type PlayerInfo,
} from '../src/shared/protocol';
import { AIRCRAFT, AIRCRAFT_BY_ID, aircraftIndex, nationTeam, type AircraftSpec } from '../src/shared/aircraft';
import { clamp, v3, q, qrot, qFromEuler, vnorm, Rng, type V3 } from '../src/shared/math';
import type { MatchEnvironment, WeatherId } from '../src/shared/environment';
import {
  createFlightState, spawnInFlight, stepFlight, writeEntityState,
  type FlightState,
} from '../src/shared/flight';
import {
  buildAircraftProxy, createHistoryBuffer, pushHistory,
  ProjectilePool, createProjectile, stepProjectiles,
  createDamageState, applyDamage, stepDamage, computeDamageEffects,
  syncBits, healthFraction, killReason,
  beltFor, roundMass, roundHe, gunDispersion,
  kineticDamage, groundBlastDamage, groundBlastRadius, visualBlastRadius,
  dropBomb, launchRocket, seedRng,
  AmmoType, DamageEventKind, FuseKind, ModuleId, ProjectileKind,
  type AircraftDamageState, type CombatEnv, type CombatTarget,
  type HistoryBuffer, type HitResult, type Projectile,
} from '../src/shared/combat';
import type { AiTarget } from '../src/game/ai/AiPilot';
import { resolveLoadout, flightSpecFor, type RuntimeLoadout } from '../src/game/loadout';
import {
  Bot, BOT_ID_BASE, asPilotEnv, botDemand, guardAlpha, guardDeparture, guardStructure, guardTerrain, type Combatant,
} from './Bots';
import type { ClientEnv } from '../src/game/env';
import type { Emplacement, GroundWar } from './GroundWar';
import type { GroundUnit, GroundUnits } from './GroundUnits';
import {
  DEFAULT_MATCH, decideWinner, ticketsExhausted,
  type MatchConfig, type MatchPhase, type Winner,
} from './matchRules';

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
 *  - a ring buffer of past transforms supports lag-compensated hit testing,
 *    and projectile-vs-aircraft validation actually goes through it.
 *
 * What is in the world:
 *  - human players;
 *  - AI pilots (see './Bots'), flown by the same 'AiPilot' the offline sandbox
 *    uses and integrated by the same 'stepFlight', so they are ordinary
 *    aircraft entities on the wire and clients need no code to see them;
 *  - flak emplacements (see './GroundWar'), replicated as GroundUnit entities,
 *    firing through the shared AA model and destroyable by gunfire;
 *  - a ticket-attrition game mode with a time limit, a win condition and an
 *    automatic reset into a fresh round (see './matchRules').
 */

/** A team's home field, as the terrain bake sited it. */
export interface SpawnSite {
  x: number;
  z: number;
  /** Runway elevation, m ASL. */
  elevation: number;
  /** Runway bearing, radians (0 = +Z). */
  heading: number;
  team: number;
}

/**
 * Everything the simulation needs to know about the world. This is exactly the
 * shared flight model's 'Environment' plus the spawn sites, so the same object
 * can be handed straight to 'stepFlight'.
 */
export interface Env {
  airDensity(y: number): number;
  windAt(p: V3, out: V3): V3;
  terrainHeight(x: number, z: number): number;
  terrainNormal(x: number, z: number, out: V3): V3;
  /** 0 = paved, 1 = soft ground, 2 = water. */
  surfaceType?(x: number, z: number): number;
  airfield(team: number): SpawnSite;
}

export interface RoomOptions {
  /** Game-mode knobs. Defaults to {@link DEFAULT_MATCH}. */
  config?: MatchConfig;
  /**
   * The ground war for this room. Built by the host — it needs the heightfield,
   * which lives in the world module — but owned by the room, because the guns
   * carry per-match state.
   */
  ground?: GroundWar | null;
  /**
   * Everything on the ground that is not a flak battery: the convoy, the rail
   * yard's rolling stock and the three big installations. Same reasoning — the
   * siting needs the heightfield, the health is per match.
   */
  units?: GroundUnits | null;
}

export class Player implements Combatant {
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
  readonly isBot = false;

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
  chosenLoadout = 'clean';

  constructor(id: number, name: string, ws: WebSocket) {
    this.id = id; this.name = name; this.ws = ws;
  }

  info(): PlayerInfo {
    return { id: this.id, name: this.name, team: this.team, kills: this.kills, deaths: this.deaths, score: this.score, alive: this.alive };
  }
}

/**
 * Air-to-ground stores still hanging on one aeroplane.
 *
 * The counts are authoritative here and nowhere else. The client keeps its own
 * copy for the HUD, refreshed from the 'stores' control message, but a release
 * only ever happens because the server saw the input bit.
 */
export interface Stores {
  rl: RuntimeLoadout;
  bombs: number;
  rockets: number;
  /** Hardpoint indices still occupied, highest station first. */
  bombSlots: number[];
  rocketSlots: number[];
  /** Seconds before the next store may leave the rack. */
  cooldown: number;
  /** Previous frame's input bits, for edge triggering. */
  prevBits: number;
}

/** Server-side entity: replicated state plus simulation-only fields. */
export interface ServerEntity {
  state: EntityState;
  spec?: AircraftSpec;
  /** Flight state owned by the shared flight model. */
  flight?: FlightState;
  /** Modular damage state owned by the shared combat model. */
  dmg?: AircraftDamageState;
  /** Transform ring the shared lag-compensated sweep rewinds into. */
  hist?: HistoryBuffer;
  /**
   * Bits the *flight* model raised for itself — control flutter, a broken
   * undercarriage, a wingtip dragged through a hedge. 'syncBits' rebuilds the
   * replicated mask from the modular damage state alone and would erase them,
   * so they are accumulated separately and OR-ed back in.
   */
  flightBits?: number;
  /** Aircraft-only: air-to-ground stores, if any were loaded. */
  stores?: Stores;
  /** Aircraft-only: the AI in the cockpit, if any. */
  bot?: Bot;
  /** GroundUnit-only: the emplacement this entity stands for. */
  emplacement?: Emplacement;
  /** GroundUnit-only: the ordinary ground target this entity stands for. */
  unit?: GroundUnit;
  /** Projectile/Bomb/Rocket-only: the shared-combat round being replicated. */
  round?: Projectile;
  dead: boolean;
  /** Latched once the death has been scored, so it is only scored once. */
  killed?: boolean;
}

const HISTORY_LEN = Math.ceil(LAGCOMP_HISTORY * TICK_HZ);

/**
 * Must match 'INTERP_DELAY' in src/net/NetSystem.ts. Remote entities are drawn
 * that far in the past, so a shot fired at what the player could actually see
 * was aimed at the world as it was one interpolation buffer plus half a round
 * trip ago.
 */
const CLIENT_INTERP_DELAY = 0.10;

/**
 * How long a gun round lives. Short on purpose: at 800 m/s this is still well
 * over a kilometre of reach — further than any gunnery solution in the game —
 * and every extra second is another few hundred replicated entities in the
 * snapshot when a flight of AI opens up at once.
 */
const GUN_ROUND_LIFE = 1.8;
/**
 * Ceilings on live rounds, so a mass engagement cannot flood the wire.
 *
 * Two of them, and the split matters: a single global cap means a furball
 * between eight AI and a couple of flak batteries can silently take a human
 * player's guns away — they pull the trigger, the server refuses the round,
 * and nothing at all happens. AI and AA therefore stop firing well below the
 * hard limit, which permanently reserves headroom for whoever is actually
 * holding a mouse.
 */
const MAX_PROJECTILES = 360;
const AI_PROJECTILE_BUDGET = 200;

/**
 * Harmonisation range, metres.
 *
 * Wing guns are not parallel. They are toed in so that their cones cross at a
 * set range — the RAF settled on 250 yd for the Spitfire's eight-gun battery
 * and moved out to about 250 m for cannon. Firing them parallel, which is what
 * this server used to do, puts every round from a 3.7 m wing station 3.7 m to
 * the side of whatever the pilot has the nose on, at every range. That is
 * survivable against a 6 m hit sphere and fatal against a real collision
 * proxy: the sight is on the fuselage and the rounds go past the wingtips.
 */
const HARMONISE_M = 300;

export class Room {
  readonly id: string;
  readonly mapSeed: number;
  readonly mapName: string;

  /**
   * The match's sky, chosen once when the room is created and replicated in
   * 'welcome'. The server owns it because the client predicts against the wind
   * and turbulence it implies: if the two halves disagreed about the weather
   * they would disagree about the air, and every reconciliation would produce a
   * correction the client cannot hide. It is immutable for the life of the room
   * for the same reason — 'env' was built for this weather.
   */
  readonly weather: WeatherId;
  /** Local solar-clock hours for this match, [0,24). Purely presentational. */
  readonly timeOfDay: number;

  players = new Map<number, Player>();
  bots = new Map<number, Bot>();
  entities = new Map<number, ServerEntity>();

  tick = 0;
  time = 0;              // seconds since the room was created
  private accumulator = 0;
  private nextEntityId = 1;
  private nextPlayerId = 1;
  private nextBotSerial = 0;
  private events: GameEvent[] = [];

  // --- match state ---------------------------------------------------------
  readonly config: MatchConfig;
  private phase: MatchPhase = 'active';
  private matchStart = 0;
  private endedAt = 0;
  private winner: Winner = -1;
  private ticketsA = 0;
  private ticketsB = 0;

  /** Scratch buffer reused for every snapshot to avoid per-tick allocation. */
  private snapBuf = new ArrayBuffer(SNAPSHOT_HEADER_BYTES + ENTITY_BYTES * 512);
  private snapView = new DataView(this.snapBuf);

  private env: Env;
  private ground: GroundWar | null;
  private units: GroundUnits | null;
  /** The environment the AI samples. Identical to 'env', differently typed. */
  private pilotEnv: ClientEnv;

  // --- shared combat -------------------------------------------------------
  /**
   * Every round in the air, of every kind: rifle-calibre, cannon, flak, bombs
   * and rockets. One list, one integrator, one hit resolver — the shared
   * 'stepProjectiles', which does the drag, the swept-segment sweep against the
   * real collision proxy, the ordered penetration walk through the modules it
   * passes, the fusing and the blast. The room's own hand-rolled integrator and
   * its "provisional damage number" are gone: they were the reason an online
   * hit could only ever produce a single 'Destroyed' bit.
   */
  private rounds: Projectile[] = [];
  private roundPool = new ProjectilePool(384);
  /** Replicated record per live round, keyed by the shared projectile id. */
  private roundEnt = new Map<number, ServerEntity>();
  private roundRng: Rng;
  private combatEnv: CombatEnv;
  /** Scratch used to reap replicated records for rounds that died this tick. */
  private liveRoundIds = new Set<number>();

  // --- per-tick scratch ----------------------------------------------------
  /** Live aircraft entities this tick; rebuilt in place, never reallocated. */
  private aircraft: ServerEntity[] = [];
  /** Views of 'aircraft' in the shapes the AI and the combat model want. */
  private aiTargets: AiTarget[] = [];
  private combatTargets: CombatTarget[] = [];
  private combatPool: CombatTarget[] = [];
  private liveProjectiles = 0;
  private spawnSlot = [0, 0];
  private rosterTimer = 0;

  /**
   * Match-long combat counters.
   *
   * These are not telemetry for its own sake: "bots never kill anything" is a
   * symptom with at least four possible causes (they never get a firing
   * solution, the rounds miss, the rounds hit for nothing, or nothing converts
   * damage into a death) and there is no way to tell them apart from the
   * outside. 'tools/simroom.ts' reads these.
   */
  readonly combatStats = {
    shotsFired: 0,
    roundsHit: 0,
    damageDealt: 0,
    solutionTicks: 0,
    aircraftLost: 0,
    /** Losses with a live combatant credited — the only kills that have stakes. */
    creditedKills: 0,
    gunKills: 0,
    flakKills: 0,
    terrainKills: 0,
    overstressKills: 0,
    groundKills: 0,
    bombsDropped: 0,
    rocketsFired: 0,
  };

  constructor(
    id: string, mapSeed: number, mapName: string, env: Env,
    match: MatchEnvironment, opts: RoomOptions = {},
  ) {
    this.id = id;
    this.mapSeed = mapSeed;
    this.mapName = mapName;
    this.env = env;
    this.weather = match.weather;
    this.timeOfDay = match.timeOfDay;
    this.config = opts.config ?? DEFAULT_MATCH;
    this.ground = opts.ground ?? null;
    this.units = opts.units ?? null;
    this.pilotEnv = asPilotEnv(env);
    this.ticketsA = this.ticketsB = this.config.tickets;

    // Seeded from the map, not the clock: two servers on the same map running
    // the same inputs must reach the same verdict about every ricochet.
    this.roundRng = seedRng(mapSeed ^ 0x5bf03635);
    this.combatEnv = {
      time: 0,
      rng: this.roundRng,
      terrainHeight: (x, z) => this.env.terrainHeight(x, z),
      queryTargets: (p0, p1, pad, out) => this.queryTargets(p0, p1, pad, out),
    };

    this.publishGroundEntities();
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  addPlayer(name: string, ws: WebSocket): Player {
    const p = new Player(this.nextPlayerId++, name.slice(0, 20) || `Pilot${this.nextPlayerId}`, ws);
    // Balance by human headcount only — bots backfill whatever is left, so
    // counting them here would push every real pilot onto the same side.
    let a = 0, b = 0;
    for (const o of this.players.values()) (o.team === 0 ? a++ : b++);
    p.team = a <= b ? 0 : 1;
    this.players.set(p.id, p);
    // Stand an AI down immediately rather than at the next roster tick, so a
    // join never briefly overfills the side.
    this.ensureRoster();
    return p;
  }

  removePlayer(id: number): void {
    const p = this.players.get(id);
    if (!p) return;
    if (p.entityId) this.destroyEntity(p.entityId);
    this.players.delete(id);
    this.ensureRoster();
  }

  get isEmpty(): boolean { return this.players.size === 0; }

  /** Everyone with a line on the scoreboard, humans first. */
  private *combatants(): Generator<Combatant> {
    for (const p of this.players.values()) yield p;
    for (const b of this.bots.values()) yield b;
  }

  private combatant(id: number): Combatant | undefined {
    return this.players.get(id) ?? this.bots.get(id);
  }

  // -------------------------------------------------------------------------
  // Roster
  // -------------------------------------------------------------------------

  /**
   * Tops each side up to the configured roster size with AI, and stands bots
   * down again as humans arrive. Called on join/leave and once a second, which
   * is far more often than the roster can actually change.
   */
  ensureRoster(): void {
    let humansA = 0, humansB = 0;
    for (const p of this.players.values()) (p.team === 0 ? humansA++ : humansB++);
    const want = botDemand(humansA, humansB, this.config.rosterPerTeam);

    for (let team = 0; team < 2; team++) {
      const mine: Bot[] = [];
      for (const b of this.bots.values()) if (b.team === team) mine.push(b);
      let have = mine.length;

      while (have < want[team]) {
        const bot = new Bot(BOT_ID_BASE + this.nextBotSerial++, team, have);
        // Stagger the arrivals so a fresh room does not put eight aeroplanes
        // into the same cubic kilometre on the same tick.
        bot.respawnAt = this.time + 0.5 + have * 1.1;
        this.bots.set(bot.id, bot);
        have++;
      }

      while (have > want[team]) {
        // Retire a dead one first: pulling a bot out of a live dogfight makes
        // an aeroplane vanish in front of whoever was shooting at it.
        const idx = mine.findIndex((b) => !b.alive);
        const victim = mine[idx >= 0 ? idx : mine.length - 1];
        if (!victim) break;
        if (victim.entityId) this.destroyEntity(victim.entityId);
        this.bots.delete(victim.id);
        mine.splice(mine.indexOf(victim), 1);
        have--;
      }
    }
  }

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
    const e: ServerEntity = { state, dead: false };
    this.entities.set(id, e);
    return e;
  }

  destroyEntity(id: number): void {
    const e = this.entities.get(id);
    if (!e) return;
    e.dead = true;
    this.entities.delete(id);
    // Per-entity gun timers are keyed by id and would otherwise accumulate one
    // dead entry per aircraft destroyed, for the lifetime of the process.
    this.gunCooldown.delete(id);
    this.beltPos.delete(id);
  }

  /**
   * Spawns an aircraft for a player or a bot over their team's airfield,
   * offset so simultaneous spawns do not overlap.
   *
   * The spawn is *airborne and trimmed*, not parked on the runway: a match
   * that begins with a cold-start taxi is unplayable as a deathmatch, and a
   * ground spawn is also where every collision bug hides. The aircraft still
   * has a runway to come home to — the field below is real, and the
   * undercarriage model lands on it.
   */
  spawnFor(c: Combatant, aircraftId: string, loadoutId?: string): ServerEntity | null {
    const spec = AIRCRAFT_BY_ID[aircraftId] ?? AIRCRAFT[0];
    if (nationTeam(spec.nation) !== c.team) {
      // Fall back to the first aircraft valid for this combatant's team.
      const alt = AIRCRAFT.find((a) => nationTeam(a.nation) === c.team);
      if (alt) aircraftId = alt.id;
    }
    const chosen = AIRCRAFT_BY_ID[aircraftId] ?? spec;

    if (c.entityId) this.destroyEntity(c.entityId);

    const e = this.allocEntity(EntityKind.Aircraft);
    e.spec = chosen;
    e.state.ownerId = c.id;
    e.state.team = c.team;
    e.state.typeId = Math.max(0, aircraftIndex(chosen.id));
    e.state.health = 1;
    e.state.damage = 0;
    e.state.gear = 1;

    const base = this.airfield(c.team);
    const foe = this.env.airfield(c.team === 0 ? 1 : 0);

    // Line up abreast, pointed at the other side's field, so the merge happens
    // without anyone having to navigate.
    const heading = Math.atan2(foe.x - base.x, foe.z - base.z);
    const slot = this.spawnSlot[c.team]++;
    const lateral = ((slot % 6) - 2.5) * 90;
    const back = Math.floor((slot % 24) / 6) * 220;
    /**
     * AI enters on a standing patrol part-way to the front, higher than a
     * player does. Two flights launched 33 km apart spend the first two
     * minutes of every round flying in a straight line and reach the merge
     * slower and lower than they left, which is neither a fight to watch nor
     * one a late-joining player can find. Humans still start over their own
     * runway, because that is where the hangar, the field and the way home
     * are.
     */
    const separation = Math.hypot(foe.x - base.x, foe.z - base.z);
    const forward = c.isBot ? separation * BOT_PUSH : 0;
    // Offset across the flight path, i.e. 90° from the heading.
    const px = base.x + Math.sin(heading) * (forward - back) + Math.cos(heading) * lateral;
    const pz = base.z + Math.cos(heading) * (forward - back) - Math.sin(heading) * lateral;
    const agl = c.isBot ? BOT_SPAWN_AGL : SPAWN_AGL;
    const alt = Math.max(this.env.terrainHeight(px, pz), base.elevation) + agl + (slot % 6) * 60;
    const speed = cruiseSpeed(chosen);

    const flight = createFlightState(chosen, v3(px, alt, pz), q());
    // Full throttle: the input system hands the player a wide-open throttle on
    // spawn, so priming the engine anywhere else just means the first two
    // seconds of every sortie are a spool-up transient the client has to
    // predict and the server has to correct.
    spawnInFlight(flight, chosen, this.env, alt, speed, heading, 1);
    flight.pos.x = px; flight.pos.z = pz;
    e.flight = flight;

    // The modular damage state. Everything the model can express — an engine
    // fire, a severed elevator run, a holed self-sealing tank, a spar that will
    // fold the next time this pilot pulls — hangs off this one object, and the
    // replicated 'damage' word is derived from it rather than being the truth.
    e.dmg = createDamageState(chosen, e.state.id, c.team, c.id, this.mapSeed ^ (this.tick * 2654435761));
    e.hist = createHistoryBuffer(HISTORY_LEN);
    e.flightBits = 0;
    e.stores = this.makeStores(chosen, loadoutId ?? c.chosenLoadout);
    // Stores are mass before they are anything else, and the flight model has
    // to be holding it before the first integration step.
    flight.extraMass = storesMass(e.stores);

    writeEntityState(flight, chosen, e.state);

    c.entityId = e.state.id;
    c.alive = true;
    c.respawnAt = 0;
    c.chosenAircraft = chosen.id;
    c.chosenLoadout = e.stores ? e.stores.rl.loadout.id : 'clean';

    if (c.isBot) {
      const bot = c as Bot;
      bot.takeOff(chosen);
      e.bot = bot;
    }
    if (!c.isBot) this.sendStores(c as Player, e);
    return e;
  }

  /** Players spawn through exactly the same path the AI does. */
  spawnAircraft(p: Player, aircraftId: string, loadoutId?: string): ServerEntity | null {
    return this.spawnFor(p, aircraftId, loadoutId);
  }

  /**
   * Resolves a hangar loadout id into the stores the aeroplane actually carries.
   *
   * 'resolveLoadout' is the same helper the client's hangar and its ordnance
   * runtime use, so the bomb the server drops has the same weight, filling,
   * diameter and fuse as the one the client drew on the rack. An unknown or
   * absent id resolves to clean, which is what a hostile client asking for
   * '12 x Tallboy' gets.
   */
  private makeStores(spec: AircraftSpec, loadoutId: string | undefined): Stores | undefined {
    const rl = resolveLoadout(spec, loadoutId);
    if (rl.loadout.id === 'clean') return undefined;
    const bombs = rl.loadout.bombs?.count ?? 0;
    const rockets = rl.loadout.rockets?.count ?? 0;
    const bombSlots: number[] = [];
    const rocketSlots: number[] = [];
    for (let i = 0; i < bombs; i++) bombSlots.push(i);
    for (let i = 0; i < rockets; i++) rocketSlots.push(i);
    return { rl, bombs, rockets, bombSlots, rocketSlots, cooldown: 0, prevBits: 0 };
  }

  /** Tells one player what is still on their racks. */
  private sendStores(p: Player, e: ServerEntity): void {
    const s = e.stores;
    this.sendJson(p, {
      t: 'stores',
      entityId: e.state.id,
      loadout: s ? s.rl.loadout.id : 'clean',
      bombs: s ? s.bombs : 0,
      rockets: s ? s.rockets : 0,
    });
  }

  /**
   * Teleports a player's aeroplane to a posed situation.
   *
   * This exists for the playability harness, which sets up a dive-bombing run
   * from a known geometry rather than spending a minute of every test flying to
   * a convoy. It is the online counterpart of the sandbox's 'debug:place' and
   * uses the same Euler convention (positive pitch is nose down), so a harness
   * can pose an aircraft identically on both paths.
   *
   * The host only routes a request here when 'CT_DEBUG_PLACE' is set, which is
   * emphatically not the case on a server anybody is playing on: a client that
   * can put its own aeroplane anywhere is a client that can put it behind you.
   */
  placeAircraft(
    p: Player,
    pose: { x: number; y: number; z: number; heading: number; pitch: number; bank: number; speed: number },
  ): boolean {
    const e = p.entityId ? this.entities.get(p.entityId) : undefined;
    if (!e || !e.flight || !e.spec) return false;
    // 'qFromEuler(pitch, yaw, roll)' with roll negated: positive bank is right
    // wing down, which is a negative rotation about the nose axis.
    qFromEuler(pose.pitch, pose.heading, -pose.bank, _poseQ);
    qrot(_poseQ, FWD, _f);
    const f = e.flight;
    f.pos.x = pose.x; f.pos.y = pose.y; f.pos.z = pose.z;
    f.rot.x = _poseQ.x; f.rot.y = _poseQ.y; f.rot.z = _poseQ.z; f.rot.w = _poseQ.w;
    f.vel.x = _f.x * pose.speed; f.vel.y = _f.y * pose.speed; f.vel.z = _f.z * pose.speed;
    f.omega.x = f.omega.y = f.omega.z = 0;
    f.throttle = 0.92;
    writeEntityState(f, e.spec, e.state);
    // The rewind ring now holds a trajectory that never happened; clearing it
    // stops a lag-compensated shot resolving against the old position.
    if (e.hist) { e.hist.count = 0; e.hist.head = -1; }
    return true;
  }

  /** The team's home field, as sited by the terrain bake. */
  airfield(team: number): SpawnSite {
    return this.env.airfield(team);
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

    // 2. index the world once, so nothing below is O(entities) per projectile
    this.reindex();

    // 3. advance aircraft — players from their input queue, AI from the pilot
    for (let i = 0; i < this.aircraft.length; i++) {
      const e = this.aircraft[i];
      const input = e.bot
        ? this.thinkFor(e, e.bot)
        : (this.players.get(e.state.ownerId)?.lastInput ?? null);
      this.stepAircraft(e, input);
      this.recordHistory(e);
    }

    // 4. the ground war
    this.stepGroundWar();

    // 5. advance ordnance/projectiles
    this.stepProjectiles();

    // 6. respawns and roster upkeep
    this.stepRespawns();
    this.rosterTimer += TICK_DT;
    if (this.rosterTimer >= 1) { this.rosterTimer = 0; this.ensureRoster(); }

    // 7. the match itself
    this.stepMatch();

    // 8. broadcast
    if (this.tick % SNAPSHOT_EVERY === 0) this.broadcastSnapshot();
  }

  /**
   * Rebuilds the per-tick views of the entity table. Everything downstream
   * iterates these arrays rather than the map, which turns the projectile pass
   * from O(rounds x entities) into O(rounds x aircraft).
   */
  private reindex(): void {
    this.aircraft.length = 0;
    this.aiTargets.length = 0;
    this.combatTargets.length = 0;
    for (const e of this.entities.values()) {
      if (e.state.kind !== EntityKind.Aircraft) continue;
      this.aircraft.push(e);
      const s = e.state;
      const alive = !(s.damage & DamageBits.Destroyed);
      this.aiTargets.push({ state: s, spec: e.spec ?? AIRCRAFT[0], alive });

      // The combat model's view of the same aeroplane. Records are pooled: this
      // runs sixty times a second for the lifetime of the room, and the AA
      // model, the projectile sweep and every blast all read the same list.
      let t = this.combatPool[this.combatTargets.length];
      if (!t) {
        t = {
          id: 0, team: 0, ownerId: 0, alive: true,
          proxy: buildAircraftProxy(e.spec ?? AIRCRAFT[0]),
          p: v3(), q: q(), v: v3(),
        };
        this.combatPool.push(t);
      }
      t.id = s.id; t.team = s.team; t.ownerId = s.ownerId; t.alive = alive;
      t.proxy = buildAircraftProxy(e.spec ?? AIRCRAFT[0]);
      t.p.x = s.px; t.p.y = s.py; t.p.z = s.pz;
      t.q.x = s.qx; t.q.y = s.qy; t.q.z = s.qz; t.q.w = s.qw;
      t.v.x = s.vx; t.v.y = s.vy; t.v.z = s.vz;
      t.history = e.hist;
      t.damage = e.dmg;
      this.combatTargets.push(t);
    }
    this.liveProjectiles = this.rounds.length;
  }

  /**
   * Broad phase for the shared combat model: every live aeroplane whose bound
   * could overlap the segment. Called for every round, every substep, and by
   * every blast, so it stays a plain loop over the per-tick array rather than
   * touching the entity map.
   */
  private queryTargets(p0: V3, p1: V3, pad: number, out: CombatTarget[]): void {
    for (let i = 0; i < this.combatTargets.length; i++) {
      const t = this.combatTargets[i];
      if (!t.alive) continue;
      const r = t.proxy.boundRadiusOrigin + pad;
      if (!segmentSphere(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, t.p.x, t.p.y, t.p.z, r)) continue;
      out.push(t);
    }
  }

  /**
   * Runs one AI pilot. This is the same class the offline sandbox flies, and
   * it only ever reads replicated 'EntityState', so a bot's situational
   * awareness is exactly the information a human client also has.
   */
  private thinkFor(e: ServerEntity, bot: Bot): InputFrame {
    const pilot = bot.pilot ?? bot.takeOff(e.spec ?? AIRCRAFT[0]);
    pilot.think(e.state, this.aiTargets, this.pilotEnv, TICK_DT, this.time, bot.input);
    guardDeparture(e.state, e.spec ?? AIRCRAFT[0], this.env, bot.input);
    guardTerrain(e.state, e.spec ?? AIRCRAFT[0], this.env, bot.input);
    guardStructure(e.state, e.spec ?? AIRCRAFT[0], this.env, bot.input);
    if (e.flight) guardAlpha(e.flight.alpha, e.spec ?? AIRCRAFT[0], bot.input);
    // A dead pilot's aeroplane flies itself into the ground, and stops
    // shooting on the way down.
    if (e.state.damage & DamageBits.PilotDead) {
      bot.input.pitch = -0.12; bot.input.roll = 0.25; bot.input.yaw = 0;
      bot.input.bits &= ~(InputBits.Fire1 | InputBits.Fire2);
    }
    if (bot.input.bits & (InputBits.Fire1 | InputBits.Fire2)) this.combatStats.solutionTicks++;
    return bot.input;
  }

  /**
   * Steps one aircraft through the shared flight model — the same code, the
   * same environment and the same timestep the client predicts with. There is
   * deliberately no reduced-order fallback: one existed, nothing ever bound
   * the model that was supposed to replace it, and so every online match was
   * silently arbitrated by a toy integrator that the client's prediction
   * disagreed with on every single tick.
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

    if (!e.flight || !e.spec) return;

    // Damage is arbitrated by the projectile pass, which owns the modular
    // state; the flight model reads the replicated mask back so a shot-off
    // wing, a severed control run or a dead engine actually change how the
    // aeroplane flies.
    e.flight.damage = s.damage;
    e.flight.health = s.health;

    // Everything the bit mask cannot say. 'computeDamageEffects' is the shared
    // model's own translation of module hit points into flyable consequences;
    // the two the flight model has a field for are the engine's remaining
    // output and the fuel that is left in the tanks, and both matter — a hole
    // in a wing tank is meant to end the sortie somewhere short of home.
    if (e.dmg) {
      const fx = computeDamageEffects(e.dmg);
      e.flight.engineHealth = fx.engineSeized ? 0 : clamp(fx.powerScale, 0, 1);
      e.flight.fuel = e.dmg.fuelKg;
    }

    // A loaded aeroplane flies against a variant spec whose cd0 includes its
    // stores — the same interned variant the client predicts with, so the two
    // halves agree about how slow a bomb-carrying fighter is.
    const spec = e.stores ? flightSpecFor(e.spec, storesDrag(e.stores)) : e.spec;
    e.flight.extraMass = storesMass(e.stores);

    stepFlight(e.flight, spec, input ?? ZERO_INPUT, this.env, TICK_DT);
    const flightHealth = e.flight.health;
    writeEntityState(e.flight, e.spec, s);

    // The flight model raises a few bits of its own — flutter, a collapsed
    // undercarriage, a wingtip through a hedge. Latch them: the mask published
    // below is rebuilt from the modular state and would otherwise drop them.
    e.flightBits = (e.flightBits ?? 0) | (s.damage & FLIGHT_OWNED_BITS);

    // The flight model has a spar-fatigue model of its own and can decide the
    // wing is gone before the modular one does. Take that spar to zero so the
    // next 'checkStructure' agrees, rather than leaving the two halves
    // disagreeing about whether the aeroplane still has a wing.
    if (e.dmg && (s.damage & DamageBits.WingRipped) && !e.dmg.wingOff[0] && !e.dmg.wingOff[1]) {
      const left = (s.damage & DamageBits.LeftWing) !== 0;
      e.dmg.hp[left ? ModuleId.SparLeft : ModuleId.SparRight] = 0;
    }

    // Per-tick evolution of the modular state: leaks drain, fires burn and
    // spread, an overheating engine cooks itself, cook-off timers run down,
    // a wounded pilot bleeds, and a spar with holes in it folds under g.
    if (e.dmg) {
      const st = e.dmg;
      const f = e.flight;
      _dmgStep.time = this.time;
      _dmgStep.gLoad = f.gLoad;
      _dmgStep.ias = f.ias;
      _dmgStep.tas = f.tas;
      _dmgStep.altitude = f.altitude;
      _dmgStep.sideslip = f.beta;
      _dmgStep.throttle = f.throttle;
      _dmgStep.radiatorOpen = f.radiator > 0.4;
      // The *ultimate* load factor, not the limit load. 'aero.gLimit' is the
      // limit load — the g beyond which the structure deforms — and the flight
      // model already owns that regime: 'updateStructure' accumulates spar
      // fatigue above 0.85 of it and folds the wing on its own. Handing the
      // same number to the modular model made the two rules fight, and the
      // modular one is far the harsher: measured over three minutes of 4v4 it
      // tore the wings off four of the seven aircraft lost, with zero damage
      // ever inflicted on them. Airframes are designed to an ultimate load 1.5x
      // the limit load, and that — reduced as the spar takes holes, which is the
      // whole point of the rule — is the correct failure threshold here.
      _dmgStep.gLimit = e.spec.aero.gLimit * ULTIMATE_LOAD_FACTOR;
      // The flight model already burns the tank it was handed; the damage model
      // only takes what leaks out, or the two would double-count.
      _dmgStep.fuelBurn = 0;
      _dmgStep.x = s.px; _dmgStep.y = s.py; _dmgStep.z = s.pz;
      const evs = stepDamage(st, _dmgStep, TICK_DT);
      for (let i = 0; i < evs.length; i++) this.reportDamageEvent(e, evs[i]);

      s.damage = syncBits(st) | (e.flightBits ?? 0);
      s.health = Math.min(healthFraction(st), clamp(flightHealth, 0, 1));
      if (st.destroyed && !e.killed) {
        this.killEntity(e, st.killerEntity, killReason(st) || 'destroyed',
          undefined, undefined, st.killer);
        return;
      }
    }

    // Flying it into the ground counts: the model itself zeroes health on a
    // structural failure or a hard arrival.
    if (s.health <= 0) {
      this.killEntity(e, 0, 'terrain');
      return;
    }

    // Firing
    if (input) {
      this.stepGuns(e, input);
      this.stepStores(e, input);
    }
  }

  /**
   * Turns one modular-damage event into something the clients can see or hear.
   *
   * Only the events with a visible consequence are replicated. A "module
   * damaged" event fires several times a second in a sustained burst and
   * carries nothing the hit spark has not already said.
   */
  private reportDamageEvent(e: ServerEntity, ev: { kind: DamageEventKind; x: number; y: number; z: number; module: number }): void {
    const s = e.state;
    switch (ev.kind) {
      case DamageEventKind.FireStarted:
      case DamageEventKind.FireSpread:
        this.pushEvent(EventKind.Critical, ev.x, ev.y, ev.z, 0, 1, 0, 1.2, s.id, ev.module);
        break;
      case DamageEventKind.WingRipped:
      case DamageEventKind.StructuralFailure:
        this.pushEvent(EventKind.StructureFail, s.px, s.py, s.pz, 0, 1, 0, 2.0, s.id, ev.module);
        break;
      case DamageEventKind.AmmoDetonation:
        this.pushEvent(EventKind.Explosion, ev.x, ev.y, ev.z, 0, 1, 0, 2.2, s.id, 0);
        break;
      case DamageEventKind.EngineSeized:
      case DamageEventKind.ControlSevered:
      case DamageEventKind.PilotDead:
        this.pushEvent(EventKind.Critical, s.px, s.py, s.pz, 0, 1, 0, 1.0, s.id, ev.module);
        break;
      default: break;
    }
  }

  private gunCooldown = new Map<number, number[]>();
  private beltPos = new Map<number, number[]>();

  /**
   * Fires whatever the trigger bits ask for.
   *
   * Three things this does that the previous version did not, all of which
   * decide whether a burst ever connects:
   *
   *  - **harmonisation.** Each barrel is toed in at {@link HARMONISE_M} rather
   *    than pointed down the boresight, so the battery converges where the
   *    pilot is looking instead of straddling the target by the wing's
   *    half-span.
   *  - **a belt.** 'beltFor' gives the archetype's real mixed belt, so a burst
   *    alternates AP, HE and incendiary and the damage model gets something to
   *    work with — armour defeated by one round, a fire started by the next.
   *  - **dispersion.** A wing-mounted gun in a flexing wing does not put every
   *    round through the same hole; without a cone the gunnery is a laser and
   *    the modular damage model resolves every round into the same module.
   */
  private stepGuns(e: ServerEntity, input: InputFrame): void {
    const spec = e.spec!;
    const s = e.state;
    let cds = this.gunCooldown.get(s.id);
    if (!cds) { cds = spec.guns.map(() => 0); this.gunCooldown.set(s.id, cds); }
    let belts = this.beltPos.get(s.id);
    if (!belts) { belts = spec.guns.map(() => 0); this.beltPos.set(s.id, belts); }

    // Only a human shoots through a network delay, so only a human's rounds
    // are judged against a rewound world.
    const shooter = this.players.get(s.ownerId);
    const rewind = shooter
      ? clamp(shooter.rttMs * 0.0005 + CLIENT_INTERP_DELAY, 0, LAGCOMP_HISTORY)
      : 0;
    const budget = shooter ? MAX_PROJECTILES : AI_PROJECTILE_BUDGET;

    for (let gi = 0; gi < spec.guns.length; gi++) {
      const gun = spec.guns[gi];
      const wants = gun.group === 1 ? (input.bits & InputBits.Fire1) : (input.bits & InputBits.Fire2);
      cds[gi] -= TICK_DT;
      if (!wants || cds[gi] > 0) continue;
      cds[gi] = 60 / gun.rpm / Math.max(1, gun.count);
      if (this.rounds.length >= budget) continue;

      const rot = q(s.qx, s.qy, s.qz, s.qw);
      const mount = gun.mounts[(this.tick + gi) % gun.mounts.length];
      const world = qrot(rot, v3(mount[0], mount[1], mount[2]), _p);
      const fwd = qrot(rot, FWD, _f);

      _muzzle.x = s.px + world.x;
      _muzzle.y = s.py + world.y;
      _muzzle.z = s.pz + world.z;

      // Toe the barrel in on the convergence point: aim at a spot
      // HARMONISE_M ahead on the aircraft's own boresight, not parallel to it.
      _aimPt.x = s.px + fwd.x * HARMONISE_M - _muzzle.x;
      _aimPt.y = s.py + fwd.y * HARMONISE_M - _muzzle.y;
      _aimPt.z = s.pz + fwd.z * HARMONISE_M - _muzzle.z;
      vnorm(_aimPt, _aimPt);

      const belt = beltFor(gun);
      const ammo = belt[belts[gi] % belt.length];
      belts[gi] = (belts[gi] + 1) % 1024;

      // Wing guns sit in a structure that flexes; nose guns are bolted to the
      // engine bearers and are appreciably tighter.
      const wingMounted = Math.abs(mount[0]) > 0.6;

      _inherit.x = s.vx; _inherit.y = s.vy; _inherit.z = s.vz;
      const p = createProjectile({
        origin: _muzzle,
        direction: _aimPt,
        speed: gun.muzzle,
        inherit: _inherit,
        ammo,
        calibre: gun.calibre,
        mass: roundMass(gun, ammo),
        heGrams: roundHe(gun, ammo),
        ownerId: s.ownerId,
        team: s.team,
        shooterEntity: s.id,
        time: this.time,
        rewind,
        lifetime: GUN_ROUND_LIFE,
        // Every fifth round is a tracer, which is roughly what a fighter belt
        // carried and is what makes a burst readable from the cockpit.
        tracerTime: belts[gi] % 5 === 0 ? GUN_ROUND_LIFE : 0,
        tracerColor: gun.tracer,
        dispersion: gunDispersion(gun, wingMounted),
        rng: this.roundRng,
        pool: this.roundPool,
        tag: gi,
      });
      this.adoptRound(p, EntityKind.Projectile, Math.min(15, Math.round(gun.calibre)));
      this.combatStats.shotsFired++;

      this.pushEvent(EventKind.Gunfire, _muzzle.x, _muzzle.y, _muzzle.z, fwd.x, fwd.y, fwd.z, gun.calibre / 20, s.id, gi);
    }
  }

  // -------------------------------------------------------------------------
  // Air-to-ground stores
  // -------------------------------------------------------------------------

  /**
   * Releases bombs and rockets on the input bits.
   *
   * This is the half of ordnance that never existed online. The stores were
   * simulated, detonated and scored entirely inside the client, against ground
   * targets the server had never heard of, so a bombing run changed nothing
   * about the match and nobody else in the room saw the bomb fall. Every store
   * now leaves the rack here, flies as an ordinary replicated entity through
   * the same integrator a bullet uses, and functions through the same
   * 'applyExplosion' the flak does.
   */
  private stepStores(e: ServerEntity, input: InputFrame): void {
    const st = e.stores;
    if (!st) return;
    if (st.cooldown > 0) st.cooldown -= TICK_DT;

    // Edge-triggered: the input layer pulses these for one frame, but a
    // re-applied frame from a starved jitter buffer must not double-release.
    const down = input.bits & ~st.prevBits;
    st.prevBits = input.bits;
    if (st.cooldown > 0) return;

    if ((down & InputBits.DropBomb) && st.bombs > 0) this.releaseBomb(e, st);
    else if ((down & InputBits.FireRocket) && st.rockets > 0) this.fireRockets(e, st);
  }

  private releaseBomb(e: ServerEntity, st: Stores): void {
    const spec = st.rl.bomb;
    if (!spec) return;
    const slot = st.bombSlots.pop();
    if (slot === undefined) return;
    st.bombs--;
    st.cooldown = STICK_INTERVAL;

    const s = e.state;
    const rot = q(s.qx, s.qy, s.qz, s.qw);
    const mount = st.rl.bombMounts[slot % st.rl.bombMounts.length];
    const off = qrot(rot, v3(mount[0], mount[1], mount[2]), _p);
    _muzzle.x = s.px + off.x; _muzzle.y = s.py + off.y; _muzzle.z = s.pz + off.z;
    _inherit.x = s.vx; _inherit.y = s.vy; _inherit.z = s.vz;
    const down = qrot(rot, DOWN_BODY, _f);

    const p = dropBomb({
      spec,
      origin: _muzzle,
      velocity: _inherit,
      ownerId: s.ownerId,
      team: s.team,
      shooterEntity: s.id,
      time: this.time,
      // The ejector rack pushes the bomb clear along the aircraft's own down
      // axis, which keeps it out of the propeller in a steep dive and off the
      // belly in an inverted release.
      ejectSpeed: EJECT_SPEED,
      down,
      rng: this.roundRng,
      pool: this.roundPool,
      tag: slot,
    });
    this.adoptRound(p, EntityKind.Bomb, clamp(Math.round(p.calibre / 50), 1, 15));
    this.combatStats.bombsDropped++;
    const player = this.players.get(s.ownerId);
    if (player) this.sendStores(player, e);
  }

  /**
   * Rockets go off in a ripple, not a volley: firing six motors at once from
   * one wing station is how you lose the wing, and the staggered launch is also
   * what gives the salvo its spread.
   */
  private fireRockets(e: ServerEntity, st: Stores): void {
    const spec = st.rl.rocket;
    if (!spec) return;
    const s = e.state;
    const rot = q(s.qx, s.qy, s.qz, s.qw);
    const fwd = qrot(rot, FWD, _f);
    _inherit.x = s.vx; _inherit.y = s.vy; _inherit.z = s.vz;

    // Fire a symmetric pair where there is one, so the asymmetric moment of a
    // single rail never has to be trimmed out.
    const pairs = st.rl.rocketMounts.length >= 2 && st.rockets >= 2 ? 2 : 1;
    for (let n = 0; n < pairs; n++) {
      const slot = st.rocketSlots.pop();
      if (slot === undefined) break;
      st.rockets--;
      const mount = st.rl.rocketMounts[slot % st.rl.rocketMounts.length];
      const off = qrot(rot, v3(mount[0], mount[1], mount[2]), _p);
      _muzzle.x = s.px + off.x; _muzzle.y = s.py + off.y; _muzzle.z = s.pz + off.z;

      const p = launchRocket({
        spec,
        origin: _muzzle,
        // Straight off the rail along the nose: the rocket's own dispersion and
        // gravity drop are modelled by the shared launcher.
        direction: fwd,
        velocity: _inherit,
        ownerId: s.ownerId,
        team: s.team,
        shooterEntity: s.id,
        time: this.time,
        rng: this.roundRng,
        pool: this.roundPool,
        tag: slot,
      });
      this.adoptRound(p, EntityKind.Rocket, clamp(Math.round(p.calibre / 50), 1, 15));
      this.combatStats.rocketsFired++;
    }
    st.cooldown = RIPPLE;
    const player = this.players.get(s.ownerId);
    if (player) this.sendStores(player, e);
  }

  /**
   * Takes ownership of a freshly created round: adds it to the live list and
   * gives it a replicated record so every client can see it.
   *
   * A gun round, a flak shell, a bomb and a rocket all come through here, which
   * is what makes them one code path from here on.
   */
  private adoptRound(p: Projectile, kind: EntityKind, typeId: number): ServerEntity {
    this.rounds.push(p);
    this.liveProjectiles = this.rounds.length;
    const pe = this.allocEntity(kind);
    pe.round = p;
    const s = pe.state;
    s.ownerId = p.ownerId;
    s.team = p.team;
    s.typeId = typeId;
    s.health = 1;
    this.writeRoundState(p, s);
    this.roundEnt.set(p.id, pe);
    return pe;
  }

  /**
   * Replicated pose of one store or round. Stores weathercock into the airflow,
   * so the attitude is simply the velocity direction — which is what makes a
   * bomb's nose-down rotation through the fall read correctly without
   * simulating its pitch dynamics.
   */
  private writeRoundState(p: Projectile, s: EntityState): void {
    s.px = p.p.x; s.py = p.p.y; s.pz = p.p.z;
    s.vx = p.v.x; s.vy = p.v.y; s.vz = p.v.z;
    const sp = Math.hypot(p.v.x, p.v.y, p.v.z);
    if (sp > 1) quatFromForward(p.v.x / sp, p.v.y / sp, p.v.z / sp, s);
    // Presentation channel: how much motor is left, for the flame and smoke.
    s.throttle = p.kind === ProjectileKind.Rocket && p.t < p.tracerTime
      ? 1 - p.t / Math.max(0.01, p.tracerTime)
      : 0;
  }

  // -------------------------------------------------------------------------
  // Ground war
  // -------------------------------------------------------------------------

  /**
   * Advances every battery, at 30 Hz.
   *
   * The drag-aware lead solver is by far the most expensive thing a gun does,
   * and a battery is indistinguishable at half the simulation rate: its own
   * traverse rate, reaction delay and burst discipline are all an order of
   * magnitude slower than a tick.
   */
  private stepGroundWar(): void {
    const gw = this.ground;
    if (!gw || this.tick % 2 !== 0) return;
    const dt = TICK_DT * 2;

    // 'combatTargets' is rebuilt once per tick in 'reindex' and is exactly the
    // list the AA model wants, so the battery step and the projectile sweep now
    // read the same aircraft records rather than each building their own.
    const fired = gw.step(dt, this.time, this.combatTargets);
    for (let i = 0; i < fired.length; i++) {
      const r = fired[i];
      // The shell comes out of the ground war's pool; adopting it hands it to
      // the room's list, which releases it into the room's pool when it dies.
      // Both pools are free-lists of the same plain object, so the transfer is
      // free and it keeps flak on the one integrator everything else uses.
      if (this.rounds.length < AI_PROJECTILE_BUDGET) {
        this.adoptRound(r, EntityKind.Projectile, Math.min(15, Math.round(r.calibre)));
        const sp = Math.hypot(r.v.x, r.v.y, r.v.z) || 1;
        this.pushEvent(EventKind.Gunfire, r.p.x, r.p.y, r.p.z,
          r.v.x / sp, r.v.y / sp, r.v.z / sp, r.calibre / 20, 0, 0);
      } else {
        gw.release(r);
      }
    }
  }

  /** Publishes one GroundUnit entity per surviving emplacement and ground unit. */
  private publishGroundEntities(): void {
    const gw = this.ground;
    if (gw) {
      for (const g of gw.emplacements) {
        if (!g.alive || g.entityId) continue;
        const e = this.allocEntity(EntityKind.GroundUnit);
        e.emplacement = g;
        g.entityId = e.state.id;
        const s = e.state;
        s.ownerId = 0;
        s.team = g.team;
        s.typeId = g.typeId;
        s.px = g.x; s.py = g.y + 1.2; s.pz = g.z;
        s.qw = 1;
        s.health = g.hp / g.maxHp;
      }
    }
    const gu = this.units;
    if (gu) {
      for (const u of gu.units) {
        if (!u.alive || u.entityId) continue;
        const e = this.allocEntity(EntityKind.GroundUnit);
        e.unit = u;
        u.entityId = e.state.id;
        const s = e.state;
        s.ownerId = 0;
        s.team = u.team;
        s.typeId = u.typeId;
        s.px = u.x; s.py = u.y + 1.0; s.pz = u.z;
        s.qw = 1;
        s.health = u.hp / u.maxHp;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Projectiles
  // -------------------------------------------------------------------------

  /**
   * Advances every round in the world through the shared combat model.
   *
   * There is deliberately nothing left here but plumbing. The drag law, the
   * substepping, the fuse logic, the swept-segment sweep against the real
   * collision proxy, the ordered penetration walk through the modules the round
   * passes and the blast are all 'src/shared/combat', which is covered by the
   * combat self-test and which the offline sandbox already used. The room's job
   * is to say what the world contains and what a hit means for the match.
   */
  private stepProjectiles(): void {
    // Ground units and emplacements are not part of the shared model's target
    // set — it only knows aircraft — so gunfire against them is resolved here,
    // against the segment each round is about to fly. Explosive stores are left
    // alone: they detonate on the terrain a metre away and the blast does the
    // work, which is what a bomb actually does.
    this.strafeGround();

    this.combatEnv.time = this.time;
    stepProjectiles(this.rounds, this.combatEnv, TICK_DT, this.onHit, this.roundPool);

    // Reconcile the replicated records with the live list.
    this.liveRoundIds.clear();
    for (let i = 0; i < this.rounds.length; i++) {
      const p = this.rounds[i];
      this.liveRoundIds.add(p.id);
      const pe = this.roundEnt.get(p.id);
      if (pe) this.writeRoundState(p, pe.state);
    }
    if (this.roundEnt.size !== this.liveRoundIds.size) {
      for (const [id, pe] of this.roundEnt) {
        if (this.liveRoundIds.has(id)) continue;
        this.roundEnt.delete(id);
        this.destroyEntity(pe.state.id);
      }
    }
    this.liveProjectiles = this.rounds.length;
  }

  /**
   * Kinetic rounds against things standing on the ground.
   *
   * Tested against the segment the round is about to fly rather than the one it
   * just flew, so a round that would otherwise be consumed by the terrain a
   * metre behind a lorry still counts as a strafing hit.
   */
  private strafeGround(): void {
    const gw = this.ground;
    const gu = this.units;
    if (!gw && !gu) return;
    const ceiling = Math.max(gw ? gw.ceiling : 0, gu ? gu.ceiling : 0);

    for (let i = 0; i < this.rounds.length; i++) {
      const p = this.rounds[i];
      if (!p.alive || p.p.y > ceiling) continue;
      // A bomb or a rocket is left to its fuse.
      if (p.kind === ProjectileKind.Bomb || p.kind === ProjectileKind.Rocket) continue;
      const x1 = p.p.x + p.v.x * TICK_DT;
      const y1 = p.p.y + p.v.y * TICK_DT;
      const z1 = p.p.z + p.v.z * TICK_DT;
      const speed = Math.hypot(p.v.x, p.v.y, p.v.z);
      const dmg = kineticDamage(0.5 * p.mass * speed * speed, p.calibre)
        + p.heGrams * 1.9;

      if (gw) {
        let done = false;
        for (let k = 0; k < gw.emplacements.length && !done; k++) {
          const g = gw.emplacements[k];
          if (!g.alive || g.team === p.team) continue;
          if (!segmentSphere(p.p.x, p.p.y, p.p.z, x1, y1, z1, g.x, g.y + 2, g.z, g.radius)) continue;
          this.hitEmplacement(g, p.shooterEntity, p.ownerId, dmg, 'strafe');
          p.alive = false;
          done = true;
        }
        if (done) continue;
      }
      if (gu) {
        for (let k = 0; k < gu.units.length; k++) {
          const u = gu.units[k];
          if (!u.alive || u.team === p.team) continue;
          if (!segmentSphere(p.p.x, p.p.y, p.p.z, x1, y1, z1, u.x, u.y + 1.5, u.z, u.radius)) continue;
          this.hitGroundUnit(u, p.shooterEntity, p.ownerId, dmg, 'strafe');
          p.alive = false;
          break;
        }
      }
    }
  }

  /**
   * Everything the shared combat model produces, turned into match state.
   *
   * One sink for every kind of round, because the model does not distinguish
   * between them: a rifle-calibre round stopping in a wing spar, a 20 mm shell
   * functioning inside a fuel tank, an 88 mm airburst throwing fragments through
   * a formation and a 250 kg bomb going off in a convoy all arrive here as
   * 'HitResult's and all end up in the same modular damage state.
   */
  private onHit = (h: HitResult): void => {
    switch (h.type) {
      case 'terrain':
      case 'water': {
        // An explosive round also emits a 'detonate' at the same point; letting
        // both through would double the crater.
        if (h.heGrams > 0) return;
        this.pushEvent(h.type === 'water' ? EventKind.WaterImpact : EventKind.GroundImpact,
          h.px, h.py, h.pz, 0, 1, 0, Math.max(0.35, h.calibre / 20), 0, 0);
        return;
      }
      case 'expire':
        return;
      case 'detonate': {
        const r = visualBlastRadius(h.heGrams);
        this.pushEvent(EventKind.Explosion, h.px, h.py, h.pz, 0, 1, 0,
          clamp(r / 9, 1.4, 9), h.targetId, h.shooterEntity);
        this.blastGround(h);
        return;
      }
      default: break;
    }

    if (!h.targetId) return;
    const t = this.entities.get(h.targetId);
    if (!t || !t.dmg || t.killed) return;

    if (h.damage > 0) {
      this.combatStats.roundsHit++;
      this.combatStats.damageDealt += h.damage;
    }

    const wasDestroyed = t.dmg.destroyed;
    const evs = applyDamage(t.dmg, h);
    for (let i = 0; i < evs.length; i++) this.reportDamageEvent(t, evs[i]);

    // Feedback the shooter can actually read: sparks off skin, a flat clang off
    // armour. The client already draws both.
    this.pushEvent(
      h.type === 'ricochet' || (h.type === 'stop' && h.effectiveArmourMm > 4)
        ? EventKind.HitArmour : EventKind.HitSpark,
      h.px, h.py, h.pz, h.nx, h.ny, h.nz,
      clamp(h.calibre / 20, 0.3, 3), h.targetId, h.shooterEntity,
    );

    // The replicated word follows the modular state immediately rather than
    // waiting for the next flight step, so a client sees the wing come off on
    // the same snapshot as the hit that took it.
    t.state.damage = syncBits(t.dmg) | (t.flightBits ?? 0);
    t.state.health = healthFraction(t.dmg);
    if (t.flight) { t.flight.damage = t.state.damage; t.flight.health = t.state.health; }

    if (!wasDestroyed && t.dmg.destroyed) {
      const flak = h.kind === ProjectileKind.Flak || (h.ownerId === 0 && h.shooterEntity === 0);
      const reason = killReason(t.dmg) || `${Math.round(h.calibre)}mm`;
      if (flak) this.killEntity(t, 0, reason, 'AA battery', h.team);
      else this.killEntity(t, h.shooterEntity, reason, undefined, undefined, h.ownerId);
    }
  };

  /** A detonation against everything standing on the ground under it. */
  private blastGround(h: HitResult): void {
    if (h.heGrams <= 0) return;
    const reach = groundBlastRadius(h.heGrams);
    const gw = this.ground;
    if (gw) {
      for (let i = 0; i < gw.emplacements.length; i++) {
        const g = gw.emplacements[i];
        if (!g.alive) continue;
        // Bounding radius counts: a bomb 12 m from the centre of a 20 m gun pit
        // is a hit on the gun pit.
        const d = Math.max(0, Math.hypot(g.x - h.px, g.y + 1.5 - h.py, g.z - h.pz) - g.radius * 0.6);
        if (d >= reach) continue;
        this.hitEmplacement(g, h.shooterEntity, h.ownerId, groundBlastDamage(h.heGrams, d), 'ordnance');
      }
    }
    const gu = this.units;
    if (gu) {
      for (let i = 0; i < gu.units.length; i++) {
        const u = gu.units[i];
        if (!u.alive) continue;
        const d = Math.max(0, Math.hypot(u.x - h.px, u.y + 1.5 - h.py, u.z - h.pz) - u.radius * 0.6);
        if (d >= reach) continue;
        this.hitGroundUnit(u, h.shooterEntity, h.ownerId, groundBlastDamage(h.heGrams, d), 'ordnance');
      }
    }
  }

  private hitEmplacement(
    g: Emplacement, byEntity: number, byOwner: number, amount: number, weapon: string,
  ): void {
    const gw = this.ground!;
    if (amount <= 0) return;
    this.pushEvent(EventKind.HitSpark, g.x, g.y + 2, g.z, 0, 1, 0, 1.2, g.entityId, byEntity);
    const ent = g.entityId ? this.entities.get(g.entityId) : undefined;
    const destroyed = gw.damage(g, amount);
    if (ent) ent.state.health = g.hp / g.maxHp;
    if (!destroyed) return;

    this.combatStats.groundKills++;
    this.pushEvent(EventKind.Explosion, g.x, g.y + 2, g.z, 0, 1, 0, 3.4, g.entityId, 0);
    if (g.entityId) this.destroyEntity(g.entityId);
    g.entityId = 0;

    // Emplacements are the ground war's currency: they cost the owning side
    // several tickets each, which is what makes ground attack worth flying.
    this.loseTickets(g.team, this.config.groundCost);
    this.creditGroundKill(byEntity, byOwner, g.team,
      EMPLACEMENT_NAME[g.typeId] ?? 'AA position', weapon, 75);
  }

  private hitGroundUnit(
    u: GroundUnit, byEntity: number, byOwner: number, amount: number, weapon: string,
  ): void {
    const gu = this.units!;
    if (amount <= 0) return;
    const ent = u.entityId ? this.entities.get(u.entityId) : undefined;
    const destroyed = gu.damage(u, amount);
    if (ent) ent.state.health = u.hp / u.maxHp;
    if (!destroyed) {
      this.pushEvent(EventKind.GroundImpact, u.x, u.y + 1, u.z, 0, 1, 0, 1.4, u.entityId, byEntity);
      return;
    }

    this.combatStats.groundKills++;
    // A secondary: fuel, ammunition or whatever the thing was carrying. Bigger
    // installations go up correspondingly harder.
    this.pushEvent(EventKind.Explosion, u.x, u.y + 1.5, u.z, 0, 1, 0,
      clamp(2 + u.radius * 0.35, 2, 7), u.entityId, byEntity);
    if (u.entityId) this.destroyEntity(u.entityId);
    u.entityId = 0;

    this.loseTickets(u.team, Math.max(1, Math.round(this.config.groundCost * u.value)));
    this.creditGroundKill(byEntity, byOwner, u.team, u.label, weapon,
      Math.round(60 * u.value * 2));
  }

  /** Scores a ground kill and puts it on the kill feed. */
  private creditGroundKill(
    byEntity: number, byOwner: number, victimTeam: number,
    victimLabel: string, weapon: string, score: number,
  ): void {
    const killerEnt = this.entities.get(byEntity);
    const killer = this.combatant(killerEnt ? killerEnt.state.ownerId : byOwner);
    if (!killer || killer.team === victimTeam) return;
    killer.score += score;
    this.broadcastJson({
      t: 'kill', killer: killer.name, victim: victimLabel,
      weapon, killerTeam: killer.team, victimTeam,
    });
  }

  // -------------------------------------------------------------------------
  // Scoring and death
  // -------------------------------------------------------------------------

  private killEntity(
    target: ServerEntity, killerEntityId: number, weapon: string,
    killerLabel?: string, killerTeam?: number, killerOwnerId = 0,
  ): void {
    // Guarded by an explicit latch rather than by the Destroyed bit: the
    // flight model sets that bit itself the moment health reaches zero, so
    // testing it here would swallow the death that bit represents.
    if (target.killed) return;
    target.killed = true;

    // An aeroplane that was never hit did not lose to anybody: it flew into a
    // hill, or folded a wing pulling too hard. Saying so matters — the kill feed
    // reporting "wing torn off" with no killer for an aircraft that had taken
    // zero damage is how three minutes of AI flying into the ground managed to
    // look like three minutes of combat.
    const untouched = !target.dmg || target.dmg.totalDamage < 1;
    const onDeck = !!target.flight
      && target.flight.agl < 25 && Math.hypot(target.state.vx, target.state.vy, target.state.vz) > 20;
    if (untouched) {
      weapon = onDeck ? 'terrain' : (weapon === 'terrain' ? weapon : 'overstressed the airframe');
      killerEntityId = 0;
      killerLabel = undefined;
    }

    this.combatStats.aircraftLost++;
    if (untouched) {
      if (weapon === 'terrain') this.combatStats.terrainKills++;
      else this.combatStats.overstressKills++;
    }
    else if (killerLabel === 'AA battery') this.combatStats.flakKills++;
    else this.combatStats.gunKills++;
    target.state.damage |= DamageBits.Destroyed;
    target.state.health = 0;
    // Latch the modular state too, so a wreck stops taking module damage and
    // 'stepDamage' switches to the wreck's "keep the fires burning" path.
    if (target.dmg) { target.dmg.destroyed = true; target.dmg.bits |= DamageBits.Destroyed; }

    const victim = this.combatant(target.state.ownerId);
    const killerEnt = this.entities.get(killerEntityId);
    // Fall back to the owner id when the shooter's aeroplane is already gone.
    // Half of what this damage model produces kills seconds after the burst
    // that caused it, by which time the pilot who fired it may well have been
    // shot down himself — and crediting that to "the ground" is how a kill feed
    // ends up looking like a series of accidents.
    const killer = killerEnt
      ? this.combatant(killerEnt.state.ownerId)
      : this.combatant(killerOwnerId);

    if (victim) {
      victim.alive = false;
      victim.deaths++;
      victim.respawnAt = this.time + this.config.respawnDelay;
      victim.entityId = 0;
      if (victim.isBot) (victim as Bot).pilot = null;
    }
    if (killer && killer !== victim) {
      killer.kills++;
      killer.score += 100;
      this.combatStats.creditedKills++;
    }

    // Attrition. The side that lost the aeroplane pays, whoever shot it down —
    // including itself, which is what makes flying into a hill matter.
    this.loseTickets(target.state.team, this.config.aircraftCost);

    this.pushEvent(EventKind.Explosion, target.state.px, target.state.py, target.state.pz, 0, 1, 0, 3.0, target.state.id, 0);
    this.broadcastJson({
      t: 'kill',
      killer: killer?.name ?? killerLabel ?? 'the ground',
      victim: victim?.name ?? 'unknown',
      weapon,
      killerTeam: killer?.team ?? killerTeam ?? -1,
      victimTeam: victim?.team ?? target.state.team,
    });
  }

  private loseTickets(team: number, n: number): void {
    if (this.phase !== 'active') return;
    if (team === 0) this.ticketsA = Math.max(0, this.ticketsA - n);
    else this.ticketsB = Math.max(0, this.ticketsB - n);
  }

  private stepRespawns(): void {
    // A finished round does not put anyone back in the air; the intermission
    // is meant to be spent looking at the scoreboard.
    if (this.phase !== 'active') return;
    for (const c of this.combatants()) {
      if (c.alive || c.respawnAt <= 0 || this.time < c.respawnAt) continue;
      c.respawnAt = 0;
      const e = this.spawnFor(c, c.chosenAircraft);
      if (e && !c.isBot) {
        this.sendJson(c as Player, {
          t: 'spawned', entityId: e.state.id,
          aircraft: c.chosenAircraft, loadout: c.chosenLoadout,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Match flow
  // -------------------------------------------------------------------------

  get elapsed(): number { return this.time - this.matchStart; }

  get timeLeft(): number {
    return this.phase === 'ended' ? 0 : Math.max(0, this.config.matchLength - this.elapsed);
  }

  private stepMatch(): void {
    if (this.phase === 'active') {
      if (ticketsExhausted(this.ticketsA, this.ticketsB) || this.elapsed >= this.config.matchLength) {
        this.endMatch();
      }
      return;
    }
    if (this.time >= this.endedAt + this.config.intermission) this.resetMatch();
  }

  private endMatch(): void {
    this.phase = 'ended';
    this.endedAt = this.time;
    this.winner = decideWinner(this.ticketsA, this.ticketsB);
    // 'timeLeft: 0' is the signal the client's MatchEnd screen waits for.
    this.broadcastJson(this.matchState());
    console.log(`[room ${this.id}] match over — ${
      this.winner === -1 ? 'draw' : `team ${this.winner} wins`
    } (${this.ticketsA} v ${this.ticketsB} tickets)`);
  }

  /** Tears the round down and starts a fresh one without dropping anybody. */
  resetMatch(): void {
    for (const e of [...this.entities.values()]) {
      const k = e.state.kind;
      if (k === EntityKind.Aircraft || k === EntityKind.Projectile || k === EntityKind.GroundUnit
        || k === EntityKind.Bomb || k === EntityKind.Rocket) {
        this.destroyEntity(e.state.id);
      }
    }
    for (const p of this.rounds) this.roundPool.release(p);
    this.rounds.length = 0;
    this.roundEnt.clear();
    this.liveProjectiles = 0;
    this.aircraft.length = 0;
    this.aiTargets.length = 0;
    this.combatTargets.length = 0;
    this.gunCooldown.clear();
    this.beltPos.clear();

    // The loop above dropped the ground records, so their entity ids are
    // stale; reset() clears them and everything is republished.
    this.ground?.reset();
    this.units?.reset();
    this.publishGroundEntities();

    this.ticketsA = this.ticketsB = this.config.tickets;
    this.matchStart = this.time;
    this.endedAt = 0;
    this.winner = -1;
    this.phase = 'active';
    this.spawnSlot[0] = this.spawnSlot[1] = 0;

    let n = 0;
    for (const c of this.combatants()) {
      c.kills = 0; c.deaths = 0; c.score = 0;
      c.alive = false;
      c.entityId = 0;
      if (c.isBot) (c as Bot).pilot = null;
      c.respawnAt = this.time + 1.5 + (n++ % 8) * 0.4;
    }

    this.broadcastJson(this.matchState());
    console.log(`[room ${this.id}] new round`);
  }

  // -------------------------------------------------------------------------
  // Lag compensation
  // -------------------------------------------------------------------------

  /**
   * One transform sample per aircraft per tick, into the ring the shared
   * 'sweepTarget' rewinds through.
   *
   * The room used to keep its own ring and its own interpolating rewind, used
   * by its own hand-rolled hit test. There is one ring now, it is the shared
   * model's, and it is what the ordered penetration walk resolves every shot
   * against — so a human's rounds are judged against the aeroplane's *pose* one
   * interpolation buffer ago, not merely its position.
   */
  private recordHistory(e: ServerEntity): void {
    if (!e.hist) return;
    const s = e.state;
    _histP.x = s.px; _histP.y = s.py; _histP.z = s.pz;
    _histQ.x = s.qx; _histQ.y = s.qy; _histQ.z = s.qz; _histQ.w = s.qw;
    pushHistory(e.hist, this.time, _histP, _histQ);
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

  /**
   * The control-plane view of the match.
   *
   * 'scoreA'/'scoreB' are damage *inflicted* — the tickets the other side has
   * lost — so the HUD's tug-of-war bar and the end-of-match comparison both
   * agree with the win condition by construction, instead of being a separate
   * number that can disagree with it.
   */
  matchState() {
    const roster: PlayerInfo[] = [];
    for (const c of this.combatants()) roster.push(c.info());
    return {
      t: 'match' as const,
      mode: 'Ground War',
      phase: this.phase,
      scoreA: this.config.tickets - this.ticketsB,
      scoreB: this.config.tickets - this.ticketsA,
      ticketsA: this.ticketsA,
      ticketsB: this.ticketsB,
      groundA: (this.ground ? this.ground.aliveCount(0) : 0)
        + (this.units ? this.units.aliveCount(0) : 0),
      groundB: (this.ground ? this.ground.aliveCount(1) : 0)
        + (this.units ? this.units.aliveCount(1) : 0),
      winner: this.phase === 'ended' ? this.winner : undefined,
      timeLeft: this.timeLeft,
      players: roster,
      // Repeated on every broadcast so a client that reconnected, or joined
      // before the sky finished booting, resyncs without a special message.
      weather: this.weather,
      timeOfDay: this.timeOfDay,
    };
  }
}

// ---------------------------------------------------------------------------

const ZERO_INPUT: InputFrame = { seq: 0, dt: TICK_DT, pitch: 0, roll: 0, yaw: 0, throttle: 0, bits: 0, aimX: 0, aimY: 0 };
const FWD = v3(0, 0, 1);
const DOWN_BODY = v3(0, -1, 0);
const _f = v3(), _p = v3();
const _muzzle = v3(), _aimPt = v3(), _inherit = v3();
const _histP = v3(), _histQ = q();
const _poseQ = q();

/**
 * Damage bits the *flight* model raises and the modular damage model has no
 * notion of. 'syncBits' rebuilds the replicated word from module hit points
 * alone, so these are latched per entity and OR-ed back in afterwards.
 */
const FLIGHT_OWNED_BITS = DamageBits.GearBroken | DamageBits.Aileron;

/** Reused input record for the per-tick damage evolution. */
const _dmgStep = {
  time: 0, gLoad: 1, ias: 100, tas: 100, altitude: 0, sideslip: 0,
  throttle: 0.8, radiatorOpen: true, gLimit: 9, fuelBurn: 0, x: 0, y: 0, z: 0,
};

/**
 * Ratio of ultimate load factor to limit load factor. The universal design
 * figure for the period, and for aircraft structures generally.
 */
const ULTIMATE_LOAD_FACTOR = 1.5;

/** Ejector-rack push-off, m/s. Enough to clear the propeller arc in a dive. */
const EJECT_SPEED = 2.4;
/** Minimum interval between rockets in a ripple, s. */
const RIPPLE = 0.09;
/** Bomb release interval when more than one is on the rack, s. */
const STICK_INTERVAL = 0.12;

/** Mass still hanging on an aeroplane, kg. */
function storesMass(st: Stores | undefined): number {
  if (!st) return 0;
  return st.bombs * st.rl.bombMass + st.rockets * st.rl.rocketMass;
}

/**
 * External drag area, m². The racks stay behind after release, so this never
 * returns to zero once something has been hung on the aeroplane — which is
 * exactly the small permanent penalty a strike fighter pays.
 */
function storesDrag(st: Stores | undefined): number {
  if (!st) return 0;
  const total = (st.rl.loadout.bombs?.count ?? 0) + (st.rl.loadout.rockets?.count ?? 0);
  if (total <= 0) return 0;
  return st.rl.rackDrag + st.rl.storeDrag * ((st.bombs + st.rockets) / total);
}

/**
 * Minimal-rotation quaternion taking body +Z onto a unit direction, written
 * straight into an entity record. Roll is arbitrary for a body of revolution.
 */
function quatFromForward(
  dx: number, dy: number, dz: number,
  out: { qx: number; qy: number; qz: number; qw: number },
): void {
  // q = (axis = z x d, w = 1 + z . d), normalised.
  if (dz < -0.999999) { out.qx = 1; out.qy = 0; out.qz = 0; out.qw = 0; return; }
  const ax = -dy, ay = dx;
  const w = 1 + dz;
  const inv = 1 / Math.sqrt(ax * ax + ay * ay + w * w);
  out.qx = ax * inv; out.qy = ay * inv; out.qz = 0; out.qw = w * inv;
}

/** Metres above the home field that a player spawn is dropped in at. */
const SPAWN_AGL = 1800;
/** AI enters higher: altitude is the only energy a patrol has to spend. */
const BOT_SPAWN_AGL = 2900;
/**
 * Fraction of the way to the enemy field that an AI flight starts from.
 *
 * 0.42 puts the two flights about 5 km apart on a converging heading, inside
 * the pilot's 7 km acquisition radius, so a merge happens within twenty seconds
 * of every spawn instead of after a two-minute transit. Measured over six
 * minutes of 4v4, moving it out from 0.30 took the AI from 329 to 1845 ticks
 * with the trigger down — the single largest reason a match of bots produced no
 * kills was that they were rarely in the same piece of sky.
 */
const BOT_PUSH = 0.42;

const EMPLACEMENT_NAME: Record<number, string> = {
  0: '20 mm flak pit', 1: '40 mm flak pit', 2: '88 mm flak battery',
};

/**
 * A trimmed cruise for this airframe, m/s TAS. Roughly 60 % of never-exceed,
 * which for every archetype in the roster lands between 110 and 145 m/s — fast
 * enough to manoeuvre immediately, slow enough not to overshoot the merge.
 */
function cruiseSpeed(spec: AircraftSpec): number {
  return Math.max(95, Math.min(160, spec.aero.vne * 0.62));
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
