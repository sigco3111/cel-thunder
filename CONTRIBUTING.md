# Contributing to Cel Thunder

Contributions are welcome — bug fixes, new airframes, better netcode, sharper
art. This file describes how the project is put together so your change lands
cleanly.

## Getting set up

```bash
git clone https://github.com/PauliusOS/cel-thunder.git
cd cel-thunder
npm install
npm run dev      # vite on :5233 + authoritative game server on :8791
```

Open <http://localhost:5233>. If the game server is not running, the client
falls back to an offline sandbox against local AI, so the game is always
playable — `npm run web` alone is enough for most client-side work.

## Before you open a pull request

```bash
npm run check      # tsc --noEmit — must pass, no new errors
npm run selftest   # headless flight-model and ballistics assertions
npm run build      # typecheck + production bundle
```

All three must pass. `npm run selftest` is the one that catches physics
regressions; if you touch anything under `src/shared/flight/` or
`src/shared/combat/`, run it and say so in the PR.

## Architecture rules

These are the constraints that let the codebase be built in parallel. Please
keep to them.

- **`src/shared/` is pure TypeScript and imports no three.js.** It is loaded by
  both the browser client and the Node server. Reaching for a `THREE.*` type in
  there will break the server at runtime, not at compile time.
- **Everything is a `Subsystem`** (see `src/engine/context.ts`):
  `init` / `update` / `lateUpdate` / `resize` / `dispose`, registered in
  dependency order in `src/main.ts`.
- **Subsystems talk only through `GameContext` and the event bus.** No
  subsystem reaches into another's internals. If you need data from another
  system, put it on the context or emit an event.
- **The server is authoritative.** The client predicts, it does not decide.
  Anything that determines a hit, a kill, or a score belongs in `server/`.
- **The flight model must stay deterministic.** Client prediction and server
  simulation run the same code and must produce the same result from the same
  inputs. No `Math.random()` in the flight path — use the seeded RNG in
  `src/shared/math.ts`.

## Art direction

Visual changes are held to `docs/VISUAL_RUBRIC.md`, and `docs/AGENT_BRIEF.md`
has the full specification. The short version:

- Lighting is quantised, detail is not.
- Shadows are coloured, never grey.
- Ink outlines come from a depth+normal edge detect plus inverted hulls on hero
  objects.
- Panel lines, rivets and weathering are mandatory. A clean untextured surface
  is a bug, not a style.

Every asset — meshes, textures, sounds — is generated procedurally at load
time. **Please do not add binary art assets to the repository.** If you need a
new mesh or texture, generate it in `src/assets/`.

Screenshots for visual review are captured with `npm run shoot`, which writes
into `shots/`. That directory is gitignored on purpose; it used to be committed
and it cost the repository 1.6 GB of history. Do not add it back.

## Pull requests

- One logical change per PR.
- Write commit messages that say what changed and why, in the style of the
  existing history (`git log`).
- If the change is visual, attach a before/after screenshot.
- If the change touches netcode, say how you tested it with more than one
  client connected.

## Reporting bugs

Open an issue with your OS, browser, and GPU, plus the browser console output.
For flight-model or damage bugs, the aircraft you were flying and roughly what
you were doing matters — those are often airframe-specific.

## Licence

By contributing you agree that your contributions are licensed under the MIT
Licence, the same as the rest of the project.
