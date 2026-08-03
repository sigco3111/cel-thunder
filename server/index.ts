import { WebSocketServer, type WebSocket } from 'ws';
import { createServer } from 'node:http';
import { Room, type Env, type SpawnSite } from './Room';
import { C2S, S2C, TICK_HZ, PROTOCOL_VERSION } from '../src/shared/protocol';
import { type V3 } from '../src/shared/math';
import { airDensity, windAt, windField } from '../src/shared/environment';
import { getHeightfield, type Heightfield } from '../src/world/heightfield';

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

// ---------------------------------------------------------------------------
// Environment — the server's view of the world.
//
// Terrain MUST come from the same baked heightfield the client renders, and
// air/wind from the same shared module the client predicts with. This used to
// probe for free 'terrainHeight'/'terrainNormal' exports that the world module
// never had, silently leaving the server on flat ground while the client flew
// over 2 km mountains: the client's wheels then sat 800 m under its own
// terrain, the undercarriage resolved a ~1e8 N contact, and the aeroplane was
// destroyed on the first tick with the HUD reading five figures of km/h. There
// is no fallback any more — a server that cannot load the terrain is a server
// that cannot arbitrate, so it fails loudly instead.
// ---------------------------------------------------------------------------

/** One heightfield per seed, held for the room's lifetime. */
function makeEnv(seed: number): Env {
  const hf: Heightfield = getHeightfield(seed);
  const wind = windField(seed);
  const sites: SpawnSite[] = hf.airfields.map((a) => ({
    x: a.x, z: a.z, elevation: a.elevation, heading: a.heading, team: a.team,
  }));
  if (sites.length < 2) throw new Error(`heightfield seed ${seed} produced ${sites.length} airfields`);

  return {
    airDensity,
    windAt(p: V3, out: V3): V3 { return windAt(wind, p, out); },
    terrainHeight(x, z) { return hf.heightAt(x, z); },
    terrainNormal(x, z, out) { hf.normalAt(x, z, out); return out; },
    // Wheel friction: the runway rolls, grass drags, water is a ditching.
    surfaceType(x, z) {
      const t = hf.typeAt(x, z);
      return t === 'runway' ? 0 : t === 'water' ? 2 : 1;
    },
    airfield(team) { return sites.find((s) => s.team === team) ?? sites[0]; },
  };
}

// ---------------------------------------------------------------------------

const rooms = new Map<string, Room>();

function findRoom(): Room {
  for (const r of rooms.values()) {
    if (r.players.size < MAX_PER_ROOM) return r;
  }
  const id = `room-${rooms.size + 1}`;
  // Every room shares the map seed: the heightfield bake costs ~0.6 s and
  // ~17 MB, and one map is what the client is built to render anyway.
  const r = new Room(id, MAP_SEED, 'Normandy Coast', makeEnv(MAP_SEED));
  rooms.set(id, r);
  console.log(`[server] created ${id} (seed ${MAP_SEED})`);
  return r;
}

// Bake at boot rather than on the first join: 0.6 s of dead air while a player
// is already connected reads as a hang.
{
  const hf = getHeightfield(MAP_SEED);
  const fields = hf.airfields.map((a) => `${a.name} (${a.x.toFixed(0)}, ${a.z.toFixed(0)}) @ ${a.elevation.toFixed(0)} m`);
  console.log(`[server] terrain ready — ${fields.join(' | ')}`);
}

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      rooms: rooms.size,
      players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0),
      uptime: process.uptime(),
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
        });
        room.broadcastJson(room.matchState());
        return;
      }

      if (!room || !playerId) return;
      const p = room.players.get(playerId);
      if (!p) return;

      if (msg.t === 'spawn') {
        p.chosenAircraft = String(msg.aircraft ?? p.chosenAircraft);
        const e = room.spawnAircraft(p, p.chosenAircraft);
        if (e) {
          room.sendJson(p, { t: 'spawned', entityId: e.state.id, aircraft: p.chosenAircraft });
          room.broadcastJson(room.matchState());
        }
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
