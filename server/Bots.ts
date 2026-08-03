import type { EntityState, InputFrame, PlayerInfo } from '../src/shared/protocol';
import { InputBits, TICK_DT } from '../src/shared/protocol';
import { AIRCRAFT, type AircraftSpec, nationTeam } from '../src/shared/aircraft';
import { clamp, qrotInv, type Q, type V3 } from '../src/shared/math';
import { AiPilot, stallSpeed } from '../src/game/ai/AiPilot';
import type { ClientEnv } from '../src/game/env';

/**
 * AI opponents for the authoritative server.
 *
 * There is no separate "server AI". This runs the same {@link AiPilot} the
 * offline sandbox flies — the one with energy management, lead pursuit, break
 * turns and terrain avoidance — and feeds its output into the same
 * 'stepFlight' the players are arbitrated with. A bot is therefore
 * indistinguishable from a human on the wire: it owns an ordinary Aircraft
 * entity, it is recorded into the lag-compensation history, it can be shot at
 * with rewound hit validation and it appears on the scoreboard. Clients need
 * no code at all to see or fight one.
 */

/**
 * The pilot only ever samples 'airDensity()' and 'terrainHeight()' off its
 * environment, but it is typed against the *client's* 'ClientEnv' class, whose
 * private wind field makes it nominal. The server's 'Env' provides both
 * methods with identical semantics (they come from the same shared modules),
 * so this is the one place the two are reconciled.
 */
export type PilotEnv = Pick<ClientEnv, 'airDensity' | 'terrainHeight'>;

export function asPilotEnv(env: PilotEnv): ClientEnv {
  return env as unknown as ClientEnv;
}

/**
 * Departure backstop, applied to the pilot's command after it decides.
 *
 * 'AiPilot' has a stall guard — below 1.15 Vs it caps the pull — but its hard
 * deck rule runs *after* that guard and blends a 0.85 climb command back in as
 * the ground gets close. Low and slow, those two fight, the deck wins, and the
 * aeroplane departs and mushes into the ground at 40 km/h. Measured over eight
 * minutes of eight-ship on this map, adding the clamp below removed every
 * sub-100 km/h impact and cut total losses from 23 to 16.
 *
 * So: below about 1.25 Vs the wing cannot deliver a turn or a climb, only
 * drag. Unload, firewall the throttle, and let it fly again — which is what a
 * pilot does in a departure, and what buys back the energy the deck rule was
 * trying to spend.
 *
 * This lives on the server rather than in 'AiPilot' because the pilot is
 * shared with the client sandbox and belongs to another subsystem; the right
 * long-term fix is to reorder the two rules there and delete this.
 */
export function guardDeparture(
  self: EntityState, spec: AircraftSpec, env: PilotEnv, input: InputFrame,
): void {
  const speed = Math.hypot(self.vx, self.vy, self.vz);
  const vs = stallSpeed(spec, env.airDensity(self.py));
  if (speed >= vs * 1.25) return;
  input.pitch = Math.min(input.pitch, 0.12);
  input.throttle = 1;
  input.bits |= InputBits.Boost;
}

/**
 * Terrain backstop, applied after the pilot has decided.
 *
 * 'AiPilot' has terrain avoidance of its own and it is genuinely good, but it
 * runs on the pilot's reaction clock — up to 320 ms between decisions for a low
 * skill roll — and it competes with the deck rule, the stall guard and whatever
 * the pilot is trying to do to the aeroplane it is chasing. Measured over three
 * minutes of 4v4 on this map, aircraft spent 4.6 % of their airborne time below
 * 250 m AGL and the great majority of losses were arrivals: the wreck was
 * always at 1–5 m AGL, 'onGround' true, with 30–40 g of ground contact tearing
 * the wings off and nobody credited. A fight that ends in the dirt is a fight
 * that never produced a kill, so this is as much a lethality fix as a safety
 * one.
 *
 * So: every tick, not every decision, look down and one recovery-time along the
 * flight path. Inside the floor, roll upright and climb, hard, in proportion to
 * how close it is — and stop shooting, because nothing below is worth it.
 *
 * This lives on the server rather than in 'AiPilot' for the same reason
 * 'guardDeparture' does: the pilot is shared with the client sandbox and
 * belongs to another subsystem.
 */
export function guardTerrain(
  self: EntityState, spec: AircraftSpec, env: PilotEnv, input: InputFrame,
): void {
  const speed = Math.hypot(self.vx, self.vy, self.vz);
  const agl = self.py - env.terrainHeight(self.px, self.pz);
  // A 3 g pull-out from a 40 degree dive at 150 m/s takes about four seconds
  // and costs 400 m, so look that far along the present flight path as well as
  // straight down: a shallow descent toward rising ground has to be caught as
  // well as an imminent impact.
  const look = clamp(speed * 0.03, 1.5, 6);
  const ahead = self.py + self.vy * look
    - env.terrainHeight(self.px + self.vx * look, self.pz + self.vz * look);
  const clearance = Math.min(agl, ahead);

  // Distance alone is the wrong trigger: 400 m is comfortable in level flight
  // and already too late in a 150 m/s dive. Take whichever of height and time
  // is more alarming.
  const sink = Math.max(0.5, -self.vy);
  const tti = clearance / sink;
  const floor = HARD_FLOOR + speed * 0.6;
  if (clearance > floor && tti > RECOVERY_S) return;

  // Saturate well before the ground rather than at it. Blending the pilot's own
  // command in all the way down is how an aeroplane arrives half-recovered: at
  // 200 m of a 450 m floor the old linear ramp still let through 56 % of a
  // command that was pointing at the dirt.
  const urgency = clamp(
    Math.max(1 - clearance / floor, 1 - tti / RECOVERY_S) * 2.0, 0, 1);

  _q.x = self.qx; _q.y = self.qy; _q.z = self.qz; _q.w = self.qw;
  qrotInv(_q, WORLD_UP, _up);
  // Roll upright FIRST. Every loss measured in a 6-minute 4v4 was in pull-up
  // mode, and half of them arrived inverted or past 90 degrees of bank — where
  // a pull is the single worst input available. So the pitch command is held at
  // neutral until the lift vector is above the horizon, and only then does it
  // become a climb.
  const upright = _up.y > 0.35;
  const roll = clamp(_up.x * 4.0, -1, 1);
  const pitch = upright ? 0.85 : 0;
  input.roll = input.roll * (1 - urgency) + roll * urgency;
  input.pitch = input.pitch * (1 - urgency) + pitch * urgency;

  // ...and do not pull into a stall doing it. The other half of the losses were
  // mushing in at 20-28 degrees of alpha: the wing was stalled, so the pull was
  // buying drag and sink rather than the climb the pilot was asking for.
  const vs = stallSpeed(spec, env.airDensity(self.py));
  if (speed < vs * 1.6) input.pitch = Math.min(input.pitch, 0.40);

  input.throttle = 1;
  input.bits |= InputBits.Boost;
  if (urgency > 0.3) input.bits &= ~(InputBits.Fire1 | InputBits.Fire2);
}

/** Seconds of warning the recovery needs. A 3 g pull-out takes about four. */
const RECOVERY_S = 7;

/**
 * Angle-of-attack limiter, applied before the structural one.
 *
 * 'AiPilot' reads only replicated 'EntityState' — by design, so that its
 * situational awareness is exactly a human's — and 'EntityState' does not carry
 * alpha. So the pilot has no way to know it has pulled past the stall, and it
 * routinely does: of the losses measured in a 6-minute 4v4, every one was in
 * pull-up mode and half of them arrived at 20 to 28 degrees of alpha against a
 * 16 degree stall. The wing was stalled, so the pull was buying drag and sink
 * instead of the climb the pilot was asking for, and the aeroplane mushed into
 * the ground with the stick in its lap.
 *
 * The server *does* have alpha — it is integrating the flight model — so the
 * limiter belongs here. Backing the pull off as alpha approaches the stall is
 * not a nerf: it is what makes a sustained turn a sustained turn, because
 * maximum turn rate is at maximum lift, which is just below the stall and not
 * past it.
 */
export function guardAlpha(alpha: number, spec: AircraftSpec, input: InputFrame): void {
  if (input.pitch <= 0) return;
  const limit = spec.aero.stallAlpha * 0.94;
  const soft = limit * 0.75;
  if (alpha <= soft) return;
  // Linear washout from 'soft' to the limit, leaving a little authority at the
  // top so the aeroplane can still be flown rather than frozen.
  const over = clamp((alpha - soft) / Math.max(1e-3, limit - soft), 0, 1);
  input.pitch *= 1 - 0.9 * over;
}

/**
 * Structural backstop. Applied *last*, after the pilot and after both guards
 * above, because all three of them command hard pulls and none of them knows
 * what the wing can take.
 *
 * Above corner speed the wing delivers far more g than the airframe is rated
 * for: a Spitfire at 160 m/s has (V/Vs)^2 = 15 g of lift available against a
 * 9.6 g limit load, so full aft stick folds it. The flight model's spar-fatigue
 * rule takes about a second of 1.2x limit load to tear a wing off, and that is
 * exactly what was happening — measured over three minutes of 4v4, aircraft
 * were ripping wings at 11 to 14 g and 470 to 625 km/h IAS having never been
 * hit by anybody, and a pilot who leaves the fight in pieces halfway through
 * his own gun pass never converts it.
 *
 * Below corner speed this does nothing at all, which is where the turning fight
 * that matters actually happens.
 */
export function guardStructure(
  self: EntityState, spec: AircraftSpec, env: PilotEnv, input: InputFrame,
): void {
  const speed = Math.hypot(self.vx, self.vy, self.vz);
  const vs = stallSpeed(spec, env.airDensity(self.py));
  if (vs <= 1) return;
  const available = (speed / vs) ** 2;
  const rated = spec.aero.gLimit * RATED_LOAD_FRACTION;
  if (available <= rated) return;
  const k = clamp(rated / available, 0.28, 1);
  // Negative g is far harder on a WWII wing — the spar caps are sized for the
  // pull-up case — so the push limit is tighter than the pull limit.
  input.pitch *= input.pitch > 0 ? k : clamp(k * 0.65, 0.18, 1);
}

/**
 * Fraction of the limit load factor the AI will command. Below 0.85 the flight
 * model's spar fatigue does not accumulate at all, and the margin leaves room
 * for the overshoot between an elevator command and the g it produces.
 */
const RATED_LOAD_FRACTION = 0.82;

/** Clearance, in metres, below which the server takes the stick off the AI. */
const HARD_FLOOR = 450;

const WORLD_UP: V3 = { x: 0, y: 1, z: 0 };
const _q: Q = { x: 0, y: 0, z: 0, w: 1 };
const _up: V3 = { x: 0, y: 0, z: 0 };

/**
 * Anything that can own an aeroplane, score kills and appear on the
 * scoreboard. 'Player' and 'Bot' both satisfy it, which is what lets the
 * spawn, respawn, scoring and kill-feed paths stay single-implementation.
 */
export interface Combatant {
  readonly id: number;
  readonly name: string;
  team: number;
  entityId: number;
  kills: number;
  deaths: number;
  score: number;
  alive: boolean;
  /** Match time at which the replacement aeroplane is due; 0 = not queued. */
  respawnAt: number;
  chosenAircraft: string;
  /** Hangar loadout id to arm the next aeroplane with; 'clean' for guns only. */
  chosenLoadout: string;
  readonly isBot: boolean;
  info(): PlayerInfo;
}

/**
 * Bot ids live above every plausible human player id so the two can share the
 * u16 'ownerId' field on the wire without a discriminator.
 */
export const BOT_ID_BASE = 4096;

const ALLIED_CALLSIGNS = [
  'Hawkeye', 'Tallyho', 'Bandit', 'Lancer', 'Windsor', 'Rooster',
  'Comet', 'Dagger', 'Foxglove', 'Jackdaw', 'Kestrel', 'Marlow',
];
const AXIS_CALLSIGNS = [
  'Adler', 'Karo', 'Zwilling', 'Falke', 'Habicht', 'Wespe',
  'Nordstern', 'Eisen', 'Rabe', 'Sturm', 'Kranich', 'Wolf',
];

/** Aircraft a given side may field, in preference order. */
function rosterFor(team: number): AircraftSpec[] {
  const list = AIRCRAFT.filter((a) => nationTeam(a.nation) === team);
  return list.length ? list : AIRCRAFT.slice(0, 1);
}

export class Bot implements Combatant {
  readonly id: number;
  readonly name: string;
  team: number;
  entityId = 0;
  kills = 0;
  deaths = 0;
  score = 0;
  alive = false;
  respawnAt = 0;
  chosenAircraft: string;
  /**
   * AI fly clean. Giving a bot a bomb rack costs it a fifth of its climb rate
   * and buys nothing: nothing in 'AiPilot' knows what a ground target is, so
   * the stores would be carried to the merge and never released.
   */
  chosenLoadout = 'clean';
  readonly isBot = true;

  /**
   * Rebuilt on every spawn so a new airframe gets a pilot that knows its own
   * gun ballistics, but seeded from the *bot* id rather than the entity id so
   * a given callsign keeps its personality across the whole match.
   */
  pilot: AiPilot | null = null;

  /** Command frame the pilot writes into; reused, never reallocated. */
  readonly input: InputFrame = {
    seq: 0, dt: TICK_DT, pitch: 0, roll: 0, yaw: 0,
    throttle: 1, bits: 0, aimX: 0, aimY: 0,
  };

  constructor(id: number, team: number, index: number) {
    this.id = id;
    this.team = team;
    const pool = team === 0 ? ALLIED_CALLSIGNS : AXIS_CALLSIGNS;
    this.name = `${pool[index % pool.length]} ${1 + Math.floor(index / pool.length)}`;
    const specs = rosterFor(team);
    // Spread the flight across the available airframes rather than fielding
    // five identical machines; a mixed formation is both more readable in the
    // air and a better test of the flight model.
    this.chosenAircraft = specs[index % specs.length].id;
  }

  /** Fresh pilot for a fresh aeroplane. */
  takeOff(spec: AircraftSpec): AiPilot {
    this.pilot = new AiPilot(this.id, spec);
    return this.pilot;
  }

  info(): PlayerInfo {
    return {
      id: this.id, name: this.name, team: this.team,
      kills: this.kills, deaths: this.deaths, score: this.score, alive: this.alive,
    };
  }
}

/**
 * How many bots each side should be running, given who is actually connected.
 * Humans always count against the roster, so a match that fills up with real
 * pilots quietly sheds its AI rather than doubling the aircraft count.
 */
export function botDemand(
  humansA: number, humansB: number, rosterPerTeam: number,
): [number, number] {
  return [
    Math.max(0, rosterPerTeam - humansA),
    Math.max(0, rosterPerTeam - humansB),
  ];
}
