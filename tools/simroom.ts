/**
 * Headless match harness.
 *
 * Runs a real {@link Room} — the same class the live server hosts, with the
 * same bots, the same flight model, the same ground war — as fast as the CPU
 * allows, and reports what actually happened. It exists because the question
 * "does a 4v4 of AI ever convert a gun pass into a kill?" cannot be answered by
 * reading code, and answering it by watching a browser for three minutes costs
 * three minutes per experiment.
 *
 * Usage:  npx tsx tools/simroom.ts [--minutes 3] [--roster 4] [--seed 1337]
 *                                  [--diag] [--no-ground] [--json]
 *
 * '--diag' additionally samples every pilot once a second and histograms what
 * it believes it is doing — mode, range to its target and how far off the nose
 * that target is. That is what separates "the bots cannot shoot" from "the bots
 * never get close enough to shoot", and the two want completely different
 * fixes.
 */
import { Room } from '../server/Room';
import { makeEnv, makeGroundWar, makeGroundUnits } from '../server/world';
import { matchEnvironment } from '../src/shared/environment';
import { DEFAULT_MATCH } from '../server/matchRules';
import { TICK_DT } from '../src/shared/protocol';

const argv = process.argv.slice(2);
const arg = (name: string, dflt: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : dflt;
};
const flag = (name: string): boolean => argv.includes(`--${name}`);

const MINUTES = arg('minutes', 3);
const ROSTER = arg('roster', 4);
const SEED = arg('seed', 1337);
const JSON_OUT = flag('json');

const match = matchEnvironment(SEED);
match.weather = 'scattered';
const env = makeEnv(SEED, match);
const ground = flag('no-ground') ? null : makeGroundWar(SEED, env);
const units = makeGroundUnits(SEED);

const room = new Room('sim', SEED, 'Normandy Coast', env, match, {
  config: { ...DEFAULT_MATCH, rosterPerTeam: ROSTER, matchLength: MINUTES * 60 + 120 },
  ground,
  units,
});

// Bots are created by the roster tick, which only runs from inside step().
room.ensureRoster();

const kills: string[] = [];
// The room reports kills through the JSON control plane; there are no sockets
// here, so intercept the broadcast instead of inventing a second hook.
const origBroadcast = room.broadcastJson.bind(room);
room.broadcastJson = (msg: unknown) => {
  const m = msg as { t?: string; killer?: string; victim?: string; weapon?: string };
  if (m && m.t === 'kill') kills.push(`${m.killer} -> ${m.victim} (${m.weapon})`);
  origBroadcast(msg);
};

const total = Math.round((MINUTES * 60) / TICK_DT);
const t0 = Date.now();

// --diag samples what every pilot believes it is doing, once a second. A
// histogram of mode and range is the difference between "the bots cannot shoot"
// and "the bots never get close enough to shoot".
const DIAG = flag('diag');
const modes = new Map<string, number>();
const rangeBuckets = new Array(12).fill(0);
let diagSamples = 0;
let noTarget = 0;
let inRange = 0;
const offBuckets = new Array(12).fill(0);

for (let i = 0; i < total; i++) {
  room.advance(TICK_DT);
  if (DIAG && i % 60 === 0) {
    for (const b of room.bots.values()) {
      if (!b.pilot || !b.alive) continue;
      const d = b.pilot.debugInfo;
      diagSamples++;
      modes.set(d.mode, (modes.get(d.mode) ?? 0) + 1);
      if (!d.target) { noTarget++; continue; }
      rangeBuckets[Math.min(11, Math.floor(d.range / 250))]++;
      if (d.range < 900 && d.mode === 'engage') {
        inRange++;
        offBuckets[Math.min(11, Math.floor(d.offDeg / 2))]++;
      }
    }
  }
}
const wall = (Date.now() - t0) / 1000;

if (DIAG) {
  console.log(`\n  pilot samples: ${diagSamples} (${noTarget} with no target)`);
  console.log('  modes:', [...modes].map(([k, v]) => `${k} ${(100 * v / diagSamples).toFixed(0)}%`).join('  '));
  console.log(`  off-boresight while inside 900 m (${inRange} samples):`);
  for (let i = 0; i < 12; i++) {
    if (!offBuckets[i]) continue;
    console.log(`    ${String(i * 2).padStart(3)}–${String(i * 2 + 2).padStart(3)} deg  ${'#'.repeat(Math.ceil(offBuckets[i] / 2))} ${offBuckets[i]}`);
  }
  console.log('  range to target (m):');
  for (let i = 0; i < 12; i++) {
    if (!rangeBuckets[i]) continue;
    console.log(`    ${String(i * 250).padStart(4)}–${String(i * 250 + 250).padStart(4)}  ${'#'.repeat(Math.ceil(rangeBuckets[i] / 4))} ${rangeBuckets[i]}`);
  }
}

const stats = room.combatStats;
const roster = [...room.bots.values()].map((b) => ({
  name: b.name, team: b.team, kills: b.kills, deaths: b.deaths,
}));

if (JSON_OUT) {
  console.log(JSON.stringify({ minutes: MINUTES, roster: ROSTER, wall, stats, kills, pilots: roster }, null, 2));
} else {
  console.log(`\n${MINUTES} min of ${ROSTER}v${ROSTER} AI, simulated in ${wall.toFixed(1)} s wall`);
  console.log('  rounds fired     ', stats.shotsFired);
  console.log('  rounds that hit  ', stats.roundsHit, `(${(100 * stats.roundsHit / Math.max(1, stats.shotsFired)).toFixed(2)} %)`);
  console.log('  damage dealt     ', stats.damageDealt.toFixed(0), 'module hp');
  console.log('  firing solutions ', stats.solutionTicks, 'bot-ticks with the trigger down');
  console.log('  aircraft lost    ', stats.aircraftLost, `(${stats.gunKills} to guns, ${stats.flakKills} to flak, ${stats.terrainKills} into the ground, ${stats.overstressKills} overstressed)`);
  console.log('  credited kills   ', stats.creditedKills);
  console.log('  ground units lost', stats.groundKills);
  console.log('\n  killfeed:');
  for (const k of kills) console.log('   ', k);
  console.log('\n  scoreboard:');
  for (const p of roster.sort((a, b) => b.kills - a.kills)) {
    console.log(`    [${p.team}] ${p.name.padEnd(12)} ${p.kills} kills / ${p.deaths} deaths`);
  }
  console.log('');
}
