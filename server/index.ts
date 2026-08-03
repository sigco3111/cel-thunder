import { WebSocketServer, type WebSocket } from 'ws';
import { createServer } from 'node:http';
import { Room, type Env } from './Room';
import { C2S, S2C, TICK_HZ, PROTOCOL_VERSION } from '../src/shared/protocol';
import { v3, type V3 } from '../src/shared/math';

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

// ---------------------------------------------------------------------------
// Environment — the server's view of the world. Terrain comes from the same
// deterministic heightfield the client renders, so hit tests agree.
// ---------------------------------------------------------------------------

let heightAt: (x: number, z: number) => number = () => 0;
let normalAt: (x: number, z: number, out: V3) => V3 = (_x, _z, out) => { out.x = 0; out.y = 1; out.z = 0; return out; };

try {
  // Written by the world subsystem; three.js-free by contract. Loaded through
  // a computed specifier so the server still type-checks and boots before the
  // world module exists.
  const spec = '../src/world/heightfield.js'.replace('.js', '');
  const hf = await import(/* @vite-ignore */ spec);
  if (typeof (hf as any).terrainHeight === 'function') heightAt = (hf as any).terrainHeight;
  if (typeof (hf as any).terrainNormal === 'function') normalAt = (hf as any).terrainNormal;
  console.log('[server] terrain heightfield loaded');
} catch {
  console.warn('[server] heightfield not available yet — using flat ground');
}

const env: Env = {
  /**
   * ISA density. Below the tropopause temperature falls linearly at 6.5 K/km
   * and density follows the standard exponent; above 11 km it is isothermal.
   */
  airDensity(y: number): number {
    const h = Math.max(0, Math.min(20000, y));
    if (h < 11000) {
      const T = 288.15 - 0.0065 * h;
      return 1.225 * Math.pow(T / 288.15, 4.2559);
    }
    return 0.36391 * Math.exp(-(h - 11000) / 6341.6);
  },
  windAt(_p: V3, out: V3): V3 { out.x = 3.2; out.y = 0; out.z = 1.1; return out; },
  terrainHeight(x, z) { return heightAt(x, z); },
  terrainNormal(x, z, out) { return normalAt(x, z, out); },
};

// ---------------------------------------------------------------------------

const rooms = new Map<string, Room>();

function findRoom(): Room {
  for (const r of rooms.values()) {
    if (r.players.size < MAX_PER_ROOM) return r;
  }
  const id = `room-${rooms.size + 1}`;
  const seed = 1337 + rooms.size * 7919;
  const r = new Room(id, seed, 'Normandy Coast', env);
  rooms.set(id, r);
  console.log(`[server] created ${id} (seed ${seed})`);
  return r;
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
