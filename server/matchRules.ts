/**
 * Match rules and the knobs that tune them.
 *
 * The game mode is *ticket attrition over a ground war*. Both sides start with
 * a pool of tickets. Losing an aeroplane costs one; losing a flak emplacement
 * costs several, because the emplacements are what make the enemy's half of
 * the map expensive to fly over. A team that runs out of tickets has lost; if
 * the clock beats them to it, the side that inflicted more damage wins.
 *
 * Deliberately *not* pure kill-count deathmatch: with AI filling both rosters
 * a kill race never terminates, and the whole point of the ground units is to
 * give a solo player something to do that changes the outcome.
 *
 * Everything here is data or a pure function, so the rules can be reasoned
 * about (and unit-tested) without standing a room up.
 */

export type MatchPhase = 'active' | 'ended';

/** 0 = Allies, 1 = Axis, -1 = draw. */
export type Winner = 0 | 1 | -1;

export interface MatchConfig {
  /** Combatants per side, humans included. Bots backfill the remainder. */
  rosterPerTeam: number;
  /** Round length, seconds. */
  matchLength: number;
  /** Tickets each side starts with. */
  tickets: number;
  /** Tickets a side loses when one of its aircraft is destroyed. */
  aircraftCost: number;
  /** Tickets a side loses when one of its emplacements is destroyed. */
  groundCost: number;
  /** Seconds the end-of-match screen is held before the next round starts. */
  intermission: number;
  /** Seconds between a death and the replacement aeroplane. */
  respawnDelay: number;
  /** Whether AA batteries are placed and simulated at all. */
  groundWar: boolean;
}

/**
 * Defaults sized for a 20-minute round that is decided by play rather than by
 * the clock.
 *
 * Ten a side, twenty aircraft airborne. Four a side was a sky you could fly
 * across without meeting anybody: with one merge in progress the rest of the
 * map is empty, and after the first exchange there is nothing left to run
 * into. Twenty keeps two or three separate fights alive at once, so a pilot
 * who breaks off one engagement falls into another instead of into a transit.
 *
 * The ticket pool stays at 200, which was checked rather than assumed: a full
 * simulated 20-minute 10v10 loses 50 aircraft between the two sides — 25
 * tickets each against a pool of 200. Air attrition still cannot decide a
 * round on its own at this roster, so the ground war remains the thing that
 * actually wins one, which is the whole point of the mode. Raising the pool
 * with the roster would have quietly undone that.
 */
export const DEFAULT_MATCH: MatchConfig = {
  rosterPerTeam: 10,
  matchLength: 20 * 60,
  tickets: 200,
  aircraftCost: 1,
  groundCost: 6,
  intermission: 18,
  respawnDelay: 8,
  groundWar: true,
};

function num(raw: string | undefined, fallback: number, lo: number, hi: number): number {
  const v = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}

function bool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return !/^(0|false|off|no)$/i.test(raw);
}

/** Reads the operator's overrides out of the environment. */
export function matchConfigFromEnv(env: Record<string, string | undefined>): MatchConfig {
  return {
    ...DEFAULT_MATCH,
    // Raised from 8 so an operator can actually go past the new default.
    // 16 is where the wire stops scaling with the roster rather than where it
    // breaks: the room's live-round ceiling grows with the headcount up to a
    // hard 1000 (about eleven a side), and past that an extra shooter buys a
    // smaller share of the same pool rather than more bandwidth.
    rosterPerTeam: num(env.CT_ROSTER, DEFAULT_MATCH.rosterPerTeam, 0, 16),
    matchLength: num(env.CT_MATCH_MINUTES, DEFAULT_MATCH.matchLength / 60, 1, 240) * 60,
    tickets: num(env.CT_TICKETS, DEFAULT_MATCH.tickets, 5, 5000),
    intermission: num(env.CT_INTERMISSION, DEFAULT_MATCH.intermission, 3, 120),
    respawnDelay: num(env.CT_RESPAWN, DEFAULT_MATCH.respawnDelay, 1, 60),
    groundWar: bool(env.CT_GROUND_WAR, DEFAULT_MATCH.groundWar),
  };
}

/**
 * Decides the round. Ticket exhaustion is checked first — it is the primary
 * condition and can fire at any moment — and the clock only breaks the tie
 * between two sides that both still have tickets left.
 */
export function decideWinner(ticketsA: number, ticketsB: number): Winner {
  if (ticketsA <= 0 && ticketsB <= 0) return ticketsA === ticketsB ? -1 : (ticketsA > ticketsB ? 0 : 1);
  if (ticketsB <= 0) return 0;
  if (ticketsA <= 0) return 1;
  if (ticketsA === ticketsB) return -1;
  return ticketsA > ticketsB ? 0 : 1;
}

/** True once either side is out of tickets. */
export const ticketsExhausted = (a: number, b: number): boolean => a <= 0 || b <= 0;
