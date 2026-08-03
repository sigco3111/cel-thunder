# CEL THUNDER — implementation brief

You are building one subsystem of a browser-based, cel-shaded WWII air-combat
game (a stylised War Thunder). Target: AAA visual and simulation quality.

## Hard rules

1. **Only create/edit the files listed in your task.** Do NOT touch
   `src/main.ts`, `src/engine/Game.ts`, `src/engine/context.ts`,
   `src/shared/*`, `index.html`, `vite.config.ts`, `package.json`.
   Integration is done centrally. If you need a change there, say so in your
   report instead of making it.
2. **No new npm dependencies.** Available: `three` (r185), `ws`. Everything
   else must be written by hand. There is no network access at runtime and no
   binary art assets — all textures, meshes and audio are generated
   procedurally at load time.
3. **TypeScript strict mode.** `npx tsc --noEmit` must pass. Run it before you
   finish and fix everything you introduced.
4. **Implement your subsystem's `Subsystem` interface** from
   `src/engine/context.ts` (`name`, `init`, optional `update`/`lateUpdate`/
   `resize`/`dispose`). Read that file first.
5. **Performance is a correctness requirement.** 60 fps at 1080p on integrated
   graphics. Instance aggressively, pool allocations, never allocate
   `Vector3`/`Quaternion` inside a hot loop — hoist to module-level scratch
   objects. Respect `ctx.quality` and `ctx.settings`.
6. **Comment the non-obvious.** Explain the physics/optics/maths reasoning
   behind constants and shader tricks, not what the code literally does.

## Coordinate system & units

Right-handed, **Y up**, metres, radians, seconds, kilograms.
Aircraft body frame: **+X right wing, +Y up (canopy), +Z forward (nose)**.
World is roughly 64 km × 64 km; sea level is `y = 0`; aircraft operate
`y = 0 … 11000`.

## The art direction (read this carefully — it is the whole point)

This is **cel-shaded, not flat**. The reference is the readable, high-contrast
graphic look of modern stylised AAA (Guilty Gear Strive, Borderlands 3, Genshin,
Sable) applied to a *military sim* subject with War Thunder's framing and
information density. Specifically:

- **Quantised lighting, not quantised detail.** Diffuse is banded into 3–4
  steps with a soft, art-directed ramp; the underlying geometry, material
  variation, normal detail and ambient occlusion stay rich and continuous.
- **Ink outlines**: a screen-space depth+normal edge detect for interior
  creases plus inverted-hull silhouettes on hero objects. Width must be
  roughly constant in *screen* space and must not shimmer or crawl. Fade
  outlines with distance so distant aircraft don't turn into black blobs.
- **Warm key / cool fill.** Shadow colour is never grey — it is a saturated
  cool tint of the sky. Terminator gets a warm rim.
- **Rim light** on every aircraft, driven by the sun, so silhouettes read
  against both sky and ground.
- **Specular is stepped**, one or two hard highlight shapes, not a blurry lobe.
- **Panel lines, rivets, weathering, exhaust staining and paint chipping** are
  present and legible — this is a *military* look. Clean untextured surfaces
  read as "programmer art" and will be rejected.
- **Colour grade** is film-like: lifted, tinted blacks, gentle S-curve, subtle
  vignette, slight chromatic aberration at the frame edge only.
- Nothing should look like default three.js: no `MeshStandardMaterial` with a
  flat colour, no unshaded primitives, no untextured planes, no `0x00ff00`.

## Quality bar

Your work will be screenshotted and judged by a hostile art director doing
blind side-by-side comparisons against real War Thunder captures. "It renders
without errors" is not the bar. The bar is: **a stranger cannot tell whether
this frame came from a shipped AAA title.**

## Reporting

Finish with a short report: files created, public API other subsystems can
call, anything you need from the integrator, and known gaps. Do not paste
large code blocks into the report.
