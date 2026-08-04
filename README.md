# CEL THUNDER

A cel-shaded WWII air-combat game in the browser. Three.js on the client, an
authoritative Node simulation on the server, realtime multiplayer, and every
single asset — meshes, textures, sounds — generated procedurally at load time.
There are no binary art assets in this repository.

The whole thing was built from a single prompt — see [ORIGIN.md](ORIGIN.md).

**Play it: <https://cel-thunder.vercel.app>**

The hosted build is the offline sandbox — you fly against AI. Vercel serves
static files only and cannot host the authoritative WebSocket server, so
realtime multiplayer needs `npm run dev` locally, or the server deployed
somewhere that keeps a socket open.

## Running it

```bash
npm install
npm run dev      # vite on :5233 + game server on :8791
```

Open <http://localhost:5233>. If the game server is not running the client
falls back to an offline sandbox against local AI, so it is always playable.

| script | what it does |
|---|---|
| `npm run dev` | client + server together |
| `npm run web` | client only (offline sandbox) |
| `npm run server` | authoritative server only |
| `npm run check` | `tsc --noEmit` |
| `npm run build` | typecheck + production bundle |
| `npm run selftest` | headless flight-model and ballistics assertions |
| `npm run shoot` | capture the visual-critique screenshot set into `shots/` |

## Architecture

```
src/
  shared/      pure TypeScript, no three.js — imported by BOTH client and server
    math.ts      vectors, quaternions, deterministic RNG
    protocol.ts  binary wire format, entity/input packing, message ids
    aircraft.ts  the five airframes: aero, engine, guns, geometry, livery
    flight/      per-surface aerodynamics, engine, ground handling
    combat/      ballistics, penetration, modular damage
  engine/      Game loop, GameContext, subsystem registry, input, camera
  render/      cel material, composer passes, sky + volumetric clouds
  world/       streaming terrain, water, airfields, props
  assets/      procedural aircraft meshes and livery textures
  game/        entity representation, client prediction + reconciliation
  net/         snapshot client, interpolation, reconciliation
  vfx/  ui/  audio/
server/
  index.ts     websocket host, rooms, health endpoint
  Room.ts      fixed 60 Hz authoritative simulation, 20 Hz snapshots
tools/
  shoot.mjs    Playwright screenshot harness for the critique loop
```

Everything is a `Subsystem` (see `src/engine/context.ts`): `init` / `update` /
`lateUpdate` / `resize` / `dispose`, registered in dependency order in
`src/main.ts`, communicating only through `GameContext` and the event bus. No
subsystem reaches into another's internals, which is what let the whole thing
be built in parallel.

## Netcode

- Fixed **60 Hz** authoritative server tick; **20 Hz** binary snapshots.
- **Client prediction**: local input is simulated immediately with the same
  deterministic flight model the server runs.
- **Reconciliation**: every snapshot acks the last consumed input sequence.
  Small divergences are blended out over ~150 ms; large ones hard-correct and
  replay the pending input buffer.
- **Entity interpolation**: remote aircraft render ~100 ms in the past between
  bracketing snapshots, with capped extrapolation when a snapshot is lost.
- **Lag compensation**: the server keeps 1 s of transform history per entity
  and rewinds it for hit validation.
- Input packets carry the newest frame plus three previous ones, so a dropped
  packet costs nothing and needs no retransmit.
- Orientation is sent as a 4-byte smallest-three compressed quaternion;
  a full entity is 44 bytes.

## Art direction

See `docs/AGENT_BRIEF.md` for the full specification and
`docs/VISUAL_RUBRIC.md` for the standard each frame is held to.

The short version: lighting is quantised, detail is not. Shadows are coloured,
never grey. Ink outlines come from a depth+normal edge detect plus inverted
hulls on hero objects. Panel lines, rivets and weathering are mandatory — a
clean untextured surface is a bug.

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the
setup, the checks a pull request has to pass (`npm run check`,
`npm run selftest`, `npm run build`) and the architecture rules that keep the
client and server in step — chiefly that `src/shared/` stays free of three.js,
that subsystems talk only through the event bus, and that the flight model
stays deterministic.

## Licence

MIT — see [LICENSE](LICENSE).
