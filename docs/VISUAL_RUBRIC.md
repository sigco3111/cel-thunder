# Visual critique rubric

Used by the art-director critic agents in the screenshot loop. Every round,
`node tools/shoot.mjs --out shots/roundN` produces the framings below, and a
critic scores each one.

## Procedure

1. If `refs/` contains reference captures (real War Thunder screenshots the
   user has supplied), pair each of our shots with the reference of the same
   name and perform a **blind A/B**: describe both images without knowing
   which is which, then state which is the stronger frame and why. Only after
   committing to a verdict may you reveal which was which.
2. If `refs/` is empty, judge against the rubric below plus your own knowledge
   of how shipped AAA air-combat titles look. State explicitly that no
   reference was available — do not pretend you did an A/B.

## Scoring — 1 to 10 per axis, and the frame fails if ANY axis is below 7

| Axis | What a 10 looks like |
|---|---|
| **Silhouette & readability** | The subject reads instantly at a glance. Outlines are clean, constant-weight, and neither crawl nor blob. Nothing merges into the background by accident. |
| **Lighting & form** | Banding is deliberate and art-directed. Shadows are coloured, not grey. A warm terminator and a sun-driven rim separate the subject from the background. Forms read as three-dimensional, not as flat vector shapes. |
| **Material & surface detail** | Panel lines, rivets, weathering, exhaust staining, paint wear are visible and correctly placed. Nothing is a flat untextured colour. Surfaces at different angles read as different materials. |
| **Environment** | Terrain has real geographic structure and biome variation, not noise. Clouds are volumetric and shaped, with silver linings and dark cores. The horizon has atmospheric depth. Water reads as water. |
| **Composition** | Framed like a screenshot artist made it: thirds, foreground depth, a leading line, the sun doing something interesting. Not a centred object on an empty backdrop. |
| **Colour & grade** | A coherent palette with a clear dominant and accent. Filmic contrast. Blacks lifted and tinted. No muddy mid-tones, no oversaturated primaries, no washed-out grey. |
| **VFX** | Tracers read as streaks with a hot core. Smoke and fire have stepped, graphic shading and a silhouette. Nothing is a soft grey puff or a default additive sprite. |
| **UI (HUD frames only)** | Dense, confident, legible over both bright sky and dark ground. Typography is deliberate. Reads as a shipped game's HUD, not a debug overlay. |
| **"Is this AAA?"** | A stranger shown this frame with no context could not tell it was not from a shipped commercial title. |

## Automatic failures

Call these out immediately and score the frame ≤ 4:

- Any surface that is a flat, untextured, unshaded colour.
- Default three.js look: `MeshStandardMaterial` grey, unlit primitives, the
  default background colour.
- Outlines that are uniformly thick, pure black, and equally strong at all
  distances.
- Terrain that is visibly a noise function — repeating, uniform, no strata,
  no drainage, no biome logic.
- Clouds that are billboards, or grey shapeless blobs.
- Z-fighting, LOD popping, shimmering edges, visible tiling seams.
- A HUD that looks like unstyled HTML.
- An empty frame: subject on a plain sky with nothing else happening.

## Output

Return JSON: per-shot axis scores, the specific defects (with the axis and a
concrete, actionable fix), an overall verdict of `AAA` / `CLOSE` /
`NOT_SHIPPABLE`, and the single highest-leverage change for the next round.

Be harsh. A generous review here produces a mediocre game. The loop only stops
when you are genuinely unable to name a defect that would matter to a player.
