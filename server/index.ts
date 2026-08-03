import { WebSocketServer, type WebSocket } from 'ws';
import { createServer } from 'node:http';
import { Room } from './Room';
import { C2S, S2C, TICK_HZ, PROTOCOL_VERSION } from '../src/shared/protocol';
import {
  matchEnvironment, clampTimeOfDay, isWeatherId, type MatchEnvironment,
} from '../src/shared/environment';
import { getHeightfield } from '../src/world/heightfield';
import { makeEnv, makeGroundWar, makeGroundUnits } from './world';
import { matchConfigFromEnv } from './matchRules';

/**
 * Authoritative game server.
 *
 * One process hosts N rooms; each room runs its own fixed-step simulation. The
 * host loop uses a drift-corrected timer rather than setInterval, because
 * setInterval accumulates error and would slowly desync the tick clock from
 * wall time under load.
 */

const PORT = Number(process.env.PORT ?? 8791);
const MAX_PER_ROOM = 16;
const MAP_SEED = 1337;

/**
 * Game-mode configuration, from the environment. See './matchRules' for the
 * knobs — roster size, round length, ticket pool, whether the ground war runs
 * at all.
 */
const MATCH_CONFIG = matchConfigFromEnv(process.env);

/**
 * Whether clients may pose their own aeroplane ('debugPlace').
 *
 * Off unless asked for. The playability harness starts its own server with it
 * set so it can fly a repeatable bombing run without spending a minute of every
 * test in transit; a server anybody is actually playing on must not accept it,
 * because a client that can teleport is a client that can teleport behind you.
 */
const ALLOW_DEBUG_PLACE = /^(1|true|on|yes)$/i.test(process.env.CT_DEBUG_PLACE ?? '');

// The server's view of the world — terrain, air and the flak network — lives in
// './world.ts' so that the headless match harness builds the identical one.

const rooms = new Map<string, Room>();

/**
 * Monotonic counter folded into every match seed, so that two rooms created in
 * the same millisecond — and, more importantly, consecutive matches on a
 * long-lived server — never draw the same sky.
 */
let matchCounter = 0;

/**
 * The sky for a new match.
 *
 * 'CT_WEATHER' and 'CT_TIME_OF_DAY' pin it, which is what makes a stormy match
 * reproducible: without them there is no way to test the path that matters
 * except by restarting the server until the dice cooperate.
 */
function pickMatchEnvironment(): MatchEnvironment {
  const seed = (Date.now() ^ (++matchCounter * 0x9e3779b1)) >>> 0;
  const env = matchEnvironment(seed);
  const forcedWeather = process.env.CT_WEATHER;
  if (forcedWeather) {
    if (isWeatherId(forcedWeather)) env.weather = forcedWeather;
    else console.warn(`[server] ignoring CT_WEATHER="${forcedWeather}" — not a weather id`);
  }
  const forcedTod = process.env.CT_TIME_OF_DAY;
  if (forcedTod) {
    const h = Number(forcedTod);
    if (Number.isFinite(h)) env.timeOfDay = clampTimeOfDay(h);
    else console.warn(`[server] ignoring CT_TIME_OF_DAY="${forcedTod}" — not a number`);
  }
  return env;
}

function findRoom(): Room {
  for (const r of rooms.values()) {
    if (r.players.size < MAX_PER_ROOM) return r;
  }
  const id = `room-${rooms.size + 1}`;
  // Every room shares the map seed: the heightfield bake costs ~0.6 s and
  // ~17 MB, and one map is what the client is built to render anyway. The
  // *weather* is per room, which is what makes consecutive matches differ.
  const match = pickMatchEnvironment();
  const env = makeEnv(MAP_SEED, match);
  // The ground war is per room because the guns carry match state (ammunition,
  // tracking, damage), even though every room shares one heightfield.
  const ground = MATCH_CONFIG.groundWar ? makeGroundWar(MAP_SEED, env) : null;
  // The rest of the ground order of battle. Present regardless of CT_GROUND_WAR
  // — that switch is about whether the flak *shoots*, not about whether there
  // is anything on the ground to bomb.
  const units = makeGroundUnits(MAP_SEED);
  const r = new Room(id, MAP_SEED, 'Normandy Coast', env, match, {
    config: MATCH_CONFIG, ground, units,
  });
  rooms.set(id, r);
  const hh = Math.floor(match.timeOfDay);
  const mm = Math.round((match.timeOfDay - hh) * 60);
  console.log(
    `[server] created ${id} (seed ${MAP_SEED}, ${match.weather}, `
    + `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}, `
    + `${MATCH_CONFIG.rosterPerTeam} per side, ${ground ? ground.count : 0} AA, `
    + `${units.count} ground targets)`,
  );
  return r;
}

// Bake at boot rather than on the first join: 0.6 s of dead air while a player
// is already connected reads as a hang.
{
  const hf = getHeightfield(MAP_SEED);
  const fields = hf.airfields.map((a) => `${a.name} (${a.x.toFixed(0)}, ${a.z.toFixed(0)}) @ ${a.elevation.toFixed(0)} m`);
  console.log(`[server] terrain ready — ${fields.join(' | ')}`);
  console.log(
    `[server] mode: ground war — ${MATCH_CONFIG.rosterPerTeam} aircraft per side, `
    + `${MATCH_CONFIG.tickets} tickets, ${(MATCH_CONFIG.matchLength / 60).toFixed(0)} min rounds, `
    + `AA ${MATCH_CONFIG.groundWar ? 'on' : 'off'}`,
  );
}

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      rooms: rooms.size,
      players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0),
      uptime: process.uptime(),
      debugPlace: ALLOW_DEBUG_PLACE,
    }));
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server: http, path: '/ws' });

wss.on('connection', (ws: WebSocket) => {
  let room: Room | null = null;
  let playerId = 0;

  ws.binaryType = 'arraybuffer';

  const closeWith = (reason: string) => {
    console.log(`[server] closing connection: ${reason}`);
    try { ws.close(); } catch { /* already gone */ }
  };

  ws.on('message', (raw: ArrayBuffer | Buffer, isBinary: boolean) => {
    try {
      if (isBinary) {
        if (!room || !playerId) return;
        const buf = raw instanceof ArrayBuffer
          ? raw
          : (raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
        const dv = new DataView(buf);
        const msg = dv.getUint8(0);
        if (msg === C2S.Input) {
          const p = room.players.get(playerId);
          if (!p) return;
          const count = dv.getUint8(1);
          room.onInputPacket(p, buf, 2, count);
        } else if (msg === C2S.Pong) {
          const p = room.players.get(playerId);
          if (p) p.rttMs = Math.max(0, performance.now() - p.lastPingSent);
        }
        return;
      }

      const text = typeof raw === 'string' ? raw : raw.toString();
      const msg = JSON.parse(text);

      if (msg.t === 'hello') {
        if (msg.version !== PROTOCOL_VERSION) {
          ws.send(JSON.stringify({ t: 'error', message: `protocol mismatch: server ${PROTOCOL_VERSION}, client ${msg.version}` }));
          return closeWith('protocol mismatch');
        }
        room = findRoom();
        const p = room.addPlayer(String(msg.name ?? 'Pilot'), ws);
        playerId = p.id;
        console.log(`[server] ${p.name} (#${p.id}) joined ${room.id} on team ${p.team}`);
        room.sendJson(p, {
          t: 'welcome',
          playerId: p.id,
          team: p.team,
          mapSeed: room.mapSeed,
          mapName: room.mapName,
          serverTime: room.time,
          tickHz: TICK_HZ,
          players: [...room.players.values()].map((q) => q.info()),
          weather: room.weather,
          timeOfDay: room.timeOfDay,
        });
        room.broadcastJson(room.matchState());
        return;
      }

      if (!room || !playerId) return;
      const p = room.players.get(playerId);
      if (!p) return;

      if (msg.t === 'spawn') {
        p.chosenAircraft = String(msg.aircraft ?? p.chosenAircraft);
        // Validated inside 'spawnAircraft' against the airframe's own table, so
        // an invented id gets a clean aeroplane rather than a free bomb load.
        const wanted = msg.loadout === undefined ? undefined : String(msg.loadout);
        const e = room.spawnAircraft(p, p.chosenAircraft, wanted);
        if (e) {
          room.sendJson(p, {
            t: 'spawned', entityId: e.state.id, aircraft: p.chosenAircraft,
            loadout: p.chosenLoadout,
          });
          room.broadcastJson(room.matchState());
        }
      } else if (msg.t === 'debugPlace' && ALLOW_DEBUG_PLACE) {
        room.placeAircraft(p, {
          x: Number(msg.x) || 0, y: Number(msg.y) || 0, z: Number(msg.z) || 0,
          heading: Number(msg.heading) || 0, pitch: Number(msg.pitch) || 0,
          bank: Number(msg.bank) || 0, speed: Number(msg.speed) || 120,
        });
      } else if (msg.t === 'chat') {
        const text = String(msg.text ?? '').slice(0, 160);
        if (text) room.broadcastJson({ t: 'chat', from: p.name, text, team: p.team });
      }
    } catch (err) {
      console.error('[server] message handling failed', err);
    }
  });

  ws.on('close', () => {
    if (room && playerId) {
      const p = room.players.get(playerId);
      console.log(`[server] ${p?.name ?? playerId} left ${room.id}`);
      room.removePlayer(playerId);
      room.broadcastJson(room.matchState());
      if (room.isEmpty) {
        rooms.delete(room.id);
        console.log(`[server] destroyed empty ${room.id}`);
      }
    }
  });

  ws.on('error', (e) => console.warn('[server] socket error', e.message));
});

// ---------------------------------------------------------------------------
// Host loop — drift-corrected so the tick clock tracks wall time exactly.
// ---------------------------------------------------------------------------

let last = performance.now();
let matchStateTimer = 0;

function hostTick() {
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;

  for (const room of rooms.values()) room.advance(dt);

  matchStateTimer += dt;
  if (matchStateTimer >= 2) {
    matchStateTimer = 0;
    for (const room of rooms.values()) room.broadcastJson(room.matchState());
  }
}

// Run the host slightly faster than the tick rate; Room.advance's accumulator
// consumes exactly the right number of fixed steps regardless.
const timer = setInterval(hostTick, Math.floor(1000 / TICK_HZ / 2));
timer.unref?.();

http.listen(PORT, () => {
  console.log(`[server] cel-thunder listening on :${PORT} (ws://localhost:${PORT}/ws) @ ${TICK_HZ} Hz`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n[server] ${sig} — shutting down`);
    clearInterval(timer);
    wss.close();
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
