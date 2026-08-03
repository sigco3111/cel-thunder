# Art director critique — round 7

**Verdict: NOT_SHIPPABLE** · best: ?

## Round-6 item status

### [FIXED] 1a. Delete the flat yellow star-sprite muzzle flash (flagged R3/R4/R5/R6)

ground_attack at 3.6x (c7/ga_ac.png): the two gun flashes at (860,390) and (890,395) and the impacts at (805,450)/(1050,390) are now orange-to-yellow blobs with a lighter core. No 5-point star anywhere. hud.png shows no wing star sprites at all. damage.png's wing-root flash is gone. The specific asset called out for four rounds is dead. It is replaced by flat hard-edged orange splats with no cone, no stepped banding, no smoke puff and no warm spill on the wing, so the VFX axis is still 4 — but the named automatic failure is gone.

### [PARTIAL] 1b. Ship the ground_attack propeller to all ten frames

3 of 10 correct. sunset (c7/sun_prop.png, 4x) is now a genuine full disc centred on the spinner with radial blade-blur streaks and a warm rim — best prop in the build. water (c7/wat_ac.png, 3x) same, correct radial ramp on the hub. clouds (c7/cl_ac.png, 4.5x) is now hub-centred but is an opaque featureless pale plate with no radial ramp. hud is a faint brown ghost disc. STILL WRONG: hero (c7/hero_prop.png, 4x) is a formless brown smudge centred ~(985,340) with the spinner at ~(1018,430) — offset up-and-left with clear sky between smudge and nose, no hub, no radial structure. low (c7/low_prop.png, 3.4x) is a pale grey-lavender vertical fog COLUMN running from y=290 to y=510 — 220px tall against a 90px-deep fuselage — offset left of the spinner at (980,395) and spilling down onto the field; it reads as a render artifact, and is worse than R6's hoop. dogfight (c7/dog_nose.png, 3x) is a barely-visible whitish arc at (795-860, 455-505) that does not touch the nose at (855,530).

### [FIXED] 2. Give the airframe value separation from the terrain (sun rim + AO band)

dogfight column x=790: terrain (78,98,88) → one-pixel dark ink line (63,69,89) at y=500 → warm sun rim (165,148,114) at y=502 → fuselage (109,95,84). That is a 58-level rim against the background where R6 measured 5 levels of total separation. Wing underside now reads (52,73,84) against terrain (77,90,91), a 16-level dark AO separation. hud player aircraft (123,108,92) vs terrain immediately behind (75,91,87) — warm-lit upper surface against cool terrain, plus saturated roundels. low fuselage (105,87,75) vs field behind (42,58,85). Not fixed on clouds only: airframe facings span luma 55–67 across every structural surface.

### [PARTIAL] 3. Fix the haze band — narrow it, tint it, drive height off sun elevation

hero vertical profile at x=1500: the top of frame is now blue (151,186,201) instead of a full wash, and the peak is (227,216,193) at y=280 rather than near-white. But the band still runs y≈120–460 — 32% of frame height — as a structureless cream wash, and the sea below it reads (184,190,185) versus the band at (184,191,187): a 1-level difference. At 2x (c7/hero_haze.png) you still cannot tell where sky ends and sea begins across the whole right half. low: haze at (960,150) = (190,195,187), sea at (960,230) = (203,199,169) — same failure. dogfight's coastline is still swallowed.

### [PARTIAL] 4. Do the field generation properly — port the damage.png method across

hero FIXED: c7/hero_fields.png at 2.6x shows real parcels with soft boundaries, a road running (1050,910)→(1250,935), crop-direction striping and within-field value variation. The confetti flagged in R3/R4/R5/R6 is gone. dogfight NOT ADDRESSED: c7/dog_fields.png at 2x is verbatim the same hard-edged convex Voronoi cells with uniform dark-navy boundary strokes, and everything left of x=300 is flat untextured dark green with no field system at all. hud NOT ADDRESSED: c7/hud_fields.png at 2x — same Voronoi polygons across the lower right from x=950, flat mottled green with zero structure across the left half.

### [PARTIAL] 5. Kill chromatic fringing on the specular and the ink strokes

water FIXED — c7/wat_sea.png at 3x across the full sun path shows zero orange/cyan fringes on the sparkles and zero rainbow speckles in the lower left. This was R6's worst automatic failure and it is genuinely gone. sunset FIXED — column x=1300 across the lower fuselage ink stroke: (57,62,85) at y=464 → (187,185,136) at y=466, a clean 2px transition with no red or magenta channel excursion. STILL PRESENT: ground_attack shadow wingtip at (1209,787) reads (29,78,110) against the shadow body (45,64,91) — G +18, B +19, a cyan spike, exactly the artifact named in R6. Also survives on dogfight's flak bursts and the bandit outline.

### [PARTIAL] 6. Light the cockpit and collapse its gunsight to one pipper

GUNSIGHT FIXED: c7/ck_ret.png at 4x now shows one white ring-and-cross pipper at (960,540), one dashed containment ring, one ticked pitch/roll arc, and one orange lead marker at (935,470) joined by a chained lead line. R6's seven stacked elements and two candidate aiming points are gone; it is now the same language as hud. LIGHTING NOT ADDRESSED, fifth round: port cockpit wall sampled 180x140px at (420,820) = mean luma 53.5, sd 5.97, range 50–56 for the body of the region — a flat, untextured, unshaded slab, which is a rubric automatic failure. No sun shaft, no canopy-frame shadow on the coaming, no bounce off the panel. SLABS PARTIAL: the bottom slabs are now warm tan with specular streaks (mean 106.7 sd 19.3) rather than pale grey, but still carry no texture. LADDER PARTIAL: the rungs are off the gauge faces but the -10/-20 rungs at (855,655) and (1010,655) still draw over the opaque cowling. CANOPY GLASS still absent — no pane, no reflection, no frame thickness.

### [REGRESSED] 7. Make the smoke die and give it a core; soft-depth-fade the fire

SMOKE NOT ADDRESSED: damage plume core (120,320)=(62,70,94) and (200,300)=(64,72,95) versus plume edge (60,500)=(59,68,92) — a 3-level core-to-edge difference. Against clear field (700,300)=(43,58,84) the smoke lifts the terrain by only ~15 levels, i.e. it is still one uniform thin translucency with the ground fully readable through the densest part. ground_attack smoke (c7/ga_smoke.png, 3.6x) is still lavender-violet cauliflower with hard faceted lobes. FIRE REGRESSED: the R6 razor diagonal clip edge is gone, but c7/dmg_fire.png at 4x now shows the flame as hard-edged flat CAPSULES and RECTANGLES painted on the surface — a red pill at (935,485), yellow bars at (955,510), a yellow bar with a square end at (1030,530), a white capsule at (985,540). Flat unshaded primitives are a worse read than R6's gradient blobs.

### [PARTIAL] 8. Restore a ground texture in low.png; retexture the ground_attack apron

low FIXED: c7/low_prop.png and c7/low_shadow.png at 3.4x/5x show a restored stipple across the foreground tan field whose on-screen frequency visibly coarsens toward camera; the flat untextured green gradient that occupied half the frame is gone. ga APRON NOT ADDRESSED: c7/ga_apron.png at 2.8x shows the quad mesh still legible as a regular diagonal grid across the entire concrete from x=1350 to x=1620, y=400–560. Third round unchanged.

### [NOT_ADDRESSED] 9. Finish the shadow caster set; clamp the shadow colour

The parked aircraft at (1500,600) on the ground_attack apron is still a white cruciform placeholder and casts nothing on lit concrete, while the revetment hexagons beside it do shade. The cyan fringe is still on the player's shadow where it crosses the runway edge line: (1209,787)=(29,78,110) against the shadow body (45,64,91).

### [PARTIAL] 10. Replace the tree asset — four silhouette variants, taper, branch fork

c7/low_trees.png at 3x: the foreground and mid-ground canopies are still faceted low-poly slabs built from floating polygon shards with visible gaps between them, sitting on perfectly straight untapered cylinder trunks with no branches, no bark and no root flare. Two extra distant silhouettes have appeared (a narrow column at x=1355, small round blobs along the horizon) but every hero-scale tree is the same crumpled-paper family. Fifth round substantially unchanged.

### [FIXED] BONUS — cast shadow on damage.png (R6: no cast shadow in a frame low enough that it should read)

c7/dmg_shadow.png at 5x shows a correctly oriented planform shadow at (490–520, 820–845) with wings, fuselage and tail legible, on the field below. The smoke plume also now casts a large soft shadow across the fields at (0–800, 280–680).

## Summary

NO REFERENCE WAS AVAILABLE. I checked refs/ again: it contains exactly one file, README.md, and zero reference captures — empty for the seventh consecutive round. I did NOT perform the blind A/B the rubric describes and I am not claiming one. All ten frames were captured fresh via `node tools/shoot.mjs --out shots/round7 --warmup 9000` into /Users/paulius/Dev/cel-thunder/shots/round7/ (all ten rendered clean at 65–122 fps ultra, zero GL errors; the only console message is the unrelated dev-server WebSocket handshake failure). Every PNG was opened and looked at, and twenty-four regions were cropped and magnified at 2x to 5x with coordinate-grid overlays, with column profiles and region statistics wherever I make a numeric claim. Crops are in the scratchpad at c7/.

VERDICT: NOT_SHIPPABLE. Zero of ten frames clear the bar that no axis may fall below 7. sunset is CLOSE at 7 and is again the best frame. Mean score is 5.1 against last round's 5.2 — the build did not move.

That flat number hides real work and real damage in roughly equal measure. Genuine fixes this round, all verified: the four-round-old star-sprite muzzle flash is DEAD, replaced by orange blobs with cores. The value-separation failure I named as item 2 is FIXED — dogfight now shows a warm sun rim (165,148,114) on the fuselage top against terrain at luma 90 where R6 measured five levels of total separation, and hud, low and hero all read correctly against their backgrounds now. The water specular chromatic fringing, R6's worst automatic failure, is GONE — I went over the entire sun path at 3x and found no orange, cyan or rainbow artifacts. The sunset nose ink stroke is clean too. hero's confetti fields, called out in four consecutive rounds, have been replaced by real parcels with hedgerows, a road and crop striping. low's deleted ground texture is restored and perspective-scales correctly. The cockpit gunsight collapsed from seven stacked elements and two candidate pippers to one pipper, one ring and one lead marker. damage now casts a correct planform shadow on the fields, and its smoke casts one too. Three frames now carry a correct propeller where R6 had one.

Against that: you broke things you had already fixed. hud has grown a SECOND grey ring-and-cross 24px above the orange lead marker — the identical stacked-aim-point ambiguity the R6 reticle fix removed. damage's flame has regressed from gradient blobs into hard-edged flat capsules and rectangles painted on the wing, and damage's grade, which I credited last round as the best in the build, has desaturated to chroma 26.0 under a blue-grey veil. hero and low both now render propellers where they had none or a bad one, and both are worse: low's is a 220-pixel pale fog column offset from the spinner that spills down onto the field, hero's is a formless brown smudge floating clear of the nose. That is four regressions traded against seven fixes.

The pattern I named last round has not changed, it has only become more expensive. You have a correct propeller in sunset and water and four broken ones elsewhere. You have a correct reticle in hud and cockpit copied it — then hud broke its own. You have a correct field generator in damage, ported it successfully to hero, and left dogfight and hud on the round-3 Voronoi polygons. The work is being done once and distributed at random.

Items that have now survived five rounds untouched and are costing whole frames: the unlit cockpit interior and its flat untextured walls (port wall measures sd 5.97 over 180x140 — a flat slab, an automatic failure), the absent canopy glass, the single-silhouette tree asset, the ground_attack apron quad grid, the parked-aircraft shadow caster, sunset's featureless yellow mid-ground, and the empty-frame composition of clouds and water.

## Per-shot

### sunset — CLOSE (AAA 7/10)

- ENVIRONMENT (4): the mid-ground land is STILL a featureless yellow smear. c7/sun_land.png at 2x across x=300–1200 shows soft dune-like shading and nothing else — no fields, no hedgerows, no vegetation, no roads, no settlement, no rivers across roughly 40% of the frame. Only the extreme bottom-left corner (x<250, y>950) carries a few red parcels. Unchanged R5/R6/R7. Fix: run the damage.png parcel generator over this terrain tile and add a village, a road and treelines on the ridge.
- COLOUR (6): land, sky and airframe still sit inside one narrow lemon-yellow band. The mauve wash now laid over the mid-ground land and the violet in the sea to the right are the correct instinct and real progress — push it further into the aircraft's shadowed facings, which are currently grey rather than violet.
- VFX (6, but credited): the prop disc is now correct — hub-centred, radial blade streaks, warm rim. It is however noticeably larger than the wing chord and too opaque in the centre; it occludes cloud that should read through a spinning disc.
- CREDIT — LIGHTING (8): still the best-lit surface in the build. Gold rim along the wing leading edge at (1200–1350, y390–410), a genuine terminator down the fuselage, rivet stitching legible at 3x.
- CREDIT — COMPOSITION (8): sun left, subject upper right, coastline as leading line, surf as foreground interest. Best-composed frame in the set.
- CREDIT — VFX: the red/magenta fringing on the nose ink stroke is GONE. Measured clean at x=1300, y=464→466.

### hero — NOT_SHIPPABLE (AAA 5/10)

- VFX (3): the propeller is a formless translucent brown SMUDGE centred ~(985,340) while the spinner is at ~(1018,430) — offset up-and-left with clear sky between smudge and nose tip, no hub, no radial ramp, no blade streaks (c7/hero_prop.png, 4x). R6 said hero had nothing at all; a misplaced structureless stain is not an improvement. Fix: use the sunset implementation verbatim and parent it to the spinner transform.
- COLOUR (4): the cream haze band still eats the horizon. At x=1500 the band runs y≈120–460 and the sea below it reads (184,190,185) against the band at (184,191,187) — a 1-level difference. You cannot tell sky from sea across the entire right half. Fix: narrow the band to ~80px, tint it toward the sky's own hue, and give the sea an independent value floor so the coastline survives.
- ENVIRONMENT (5): the new parcel system is real progress, but it is punctuated by large flat pale grey-blue amorphous blobs (x1300–1500 y930–1050, x1050–1150 y990–1060) that carry no texture and no boundary logic — they read as holes in the terrain, not lakes.
- COMPOSITION (6): the right half of the frame is still empty and hazed to nothing. No wingman, no contrail, no ground event.
- CREDIT — ENVIRONMENT: the confetti fields flagged in R3/R4/R5/R6 are GONE. c7/hero_fields.png at 2.6x shows real parcels, a road at (1050,910)→(1250,935), crop-direction striping and within-field variation.
- CREDIT — MATERIAL/SILHOUETTE (7): airframe fully opaque, rivet stitching, panel lines, fin flash and 'F o DS' codes all legible; a bright sunlit upper wing at (880,458)=(208,192,144) lifts it off the terrain.

### dogfight — NOT_SHIPPABLE (AAA 5/10)

- ENVIRONMENT (3) AUTOMATIC FAILURE: c7/dog_fields.png at 2x — hard-edged flat Voronoi polygons with uniform dark-navy boundary strokes, verbatim unchanged from R3/R4/R5/R6. Everything left of x=300 is flat untextured dark green with no field system at all. A few parcels now carry crop striping (x600 y830, x1180 y950), which proves the generator can do it and was simply not run here.
- VFX (4): the propeller is a barely-visible whitish arc at (795–860, 455–505) that never reaches the nose at (855,530) (c7/dog_nose.png, 3x). Tracers are still single hairlines with a faint hot end and no glow — I count one visible in the whole frame.
- VFX (4): the flak now has genuine size variation and dark cores (credit), but it is still a bead necklace on a ruler-straight line from (480,170) to (1180,400) with near-even spacing, no bright shock ring and no orange flash at the youngest burst.
- COMPOSITION (5): bandit, flak line and tracers are all crammed into the upper-left under an extreme dutch angle; the right half is doing nothing.
- COLOUR (5): a structureless cream haze band still runs the width of the frame and swallows the coastline entirely.
- CREDIT — SILHOUETTE/LIGHTING (6): the value-separation fix landed. Column x=790: terrain (78,98,88) → ink line (63,69,89) → warm sun rim (165,148,114) → fuselage (109,95,84). The 5-level camouflage failure of R6 is gone.

### low — NOT_SHIPPABLE (AAA 5/10)

- VFX (2): the worst artifact in the build. c7/low_prop.png at 3.4x — the propeller is a pale grey-lavender vertical FOG COLUMN spanning y=290 to y=510, 220px tall against a fuselage only 90px deep, centred at x≈935 while the spinner sits at (980,395). It is offset left of the hub and spills down past the wing onto the field. There is also a hot pale flare wash smeared across the fuselage nose at (890–950, 350–430). This reads as a rendering bug, not a propeller. Fix: delete it and instance the sunset disc.
- COLOUR (4): chroma (mean per-pixel max−min) is 23.9, the lowest in the set, and the 2nd percentile luma is 60 — there are no blacks anywhere in the frame. The whole image sits under a grey-green veil with no dominant/accent relationship and no filmic contrast.
- ENVIRONMENT (4): trees unchanged for a fifth round. c7/low_trees.png at 3x — faceted canopy slabs made of floating polygon shards with visible gaps, on straight untapered cylinder trunks, no branches, no bark, no root flare. Two new distant silhouettes appeared; every hero-scale tree is still the same asset.
- MATERIAL/CREDIT: the deleted ground texture is RESTORED and its on-screen frequency now coarsens correctly toward camera. R6's half-frame flat gradient is gone.
- CREDIT — LIGHTING (7): the aircraft shadow at (380–560, 745–800) still reads correctly — wings, fuselage, fin and tailplane individually legible, soft-edged, blue-tinted. Silhouette also fixed: fuselage (105,87,75) against field (42,58,85).

### cockpit — NOT_SHIPPABLE (AAA 5/10)

- MATERIAL (3) AUTOMATIC FAILURE: the port cockpit wall, sampled 180x140px at (420,820), is mean luma 53.5 with sd 5.97 and a body range of 50–56 — a flat, untextured, unshaded slab occupying a large share of the lower-left frame (c7/ck_left.png, 2x). No rivets, no panel lines, no stringers, no wear.
- LIGHTING (3): no light enters the cockpit, fifth round running. No sun shaft across the panel, no canopy-frame shadow on the coaming, no bounce off the instrument faces. Single flat ambient.
- MATERIAL (5): still no canopy glass. c7/ck_canopy.png at 2x shows framing bars against raw sky with no pane, no reflection, no scratches, no frame thickness and no refraction at the curved sections.
- UI (6): the reticle collapse is real, but the opaque canopy centre post at x≈944–972 runs straight through the aiming point at (960,540), and the -10/-20 ladder rungs at (855,655) and (1010,655) still draw over the opaque cowling.
- CREDIT — UI: R6's seven stacked elements and two candidate pippers are gone. One white pipper, one containment ring, one ticked arc, one orange lead marker on a chained lead line. The player can answer 'where do I aim'.
- CREDIT — UI: switch row, gauge cluster, compass ribbon, POWERPLANT/AIRFRAME panels and TACTICAL minimap remain the best-executed work in the build.

### clouds — NOT_SHIPPABLE (AAA 4/10)

- ENVIRONMENT (3) AUTOMATIC FAILURE: the cloud deck is flat paint. A 120x60px sample at (1250,640) measures mean 192.8, sd 1.32, range 190–199 across 7,200 pixels. That is a flat untextured unshaded surface covering the lower third of the frame — no volume, no dark cores, no self-shadowing.
- COMPOSITION (3) AUTOMATIC FAILURE: empty frame, third round running. One small aircraft in two megapixels — no wingman, no contrail, no sun disc, no target, no ground event.
- LIGHTING (3): the airframe is one flat navy value. Structural facings measure luma 67 (wing upper), 59 (fuselage side), 55 (lower wing), 59 (rear fuselage) — a 12-level spread across the entire aeroplane. No terminator, no sun rim, and critically no bounce fill from the enormous white deck directly below.
- VFX (6): the prop is now hub-centred and encircles the spinner (real fix from R6's detached wireframe ellipse), but it renders as an opaque pale plate with no radial ramp and no blade streaks — it reads as a dinner plate bolted to the nose.
- CREDIT — ENVIRONMENT: the deck's upper boundary is now noise-eroded and organic and the razor-straight stair-stepped mesh termination of R6 is gone.
- CREDIT — COLOUR (8): the cirrus is still the best sky in the build. Curved, wind-sheared, varied in spacing and opacity. Protect it exactly as it is.

### ground_attack — NOT_SHIPPABLE (AAA 5/10)

- MATERIAL (3) AUTOMATIC FAILURE: the apron and taxiway quad mesh is still legible as a regular diagonal grid across the entire concrete (c7/ga_apron.png, 2.8x, x=1350–1620, y=400–560). Third round unchanged.
- COLOUR (4): blacks are now lifted and tinted — darkest pixels measure (39,55,81), which is the fix asked for. But the frame is a 60-level mush: p5 luma 58.5, p50 70.8, p95 117.9, chroma 26.4. Ninety percent of the image lies inside a 60-level band. There is no filmic contrast, no dominant/accent, and a heavy corner vignette.
- ENVIRONMENT (4): revetments are still flat untextured brown hexagons; the parked aircraft at (1500,600) is still a crude white cruciform placeholder and still casts NO shadow on lit concrete.
- VFX (4): smoke is still lavender-violet cauliflower with hard faceted lobes and no age-driven density falloff (c7/ga_smoke.png, 3.6x). A few darker cores have appeared, which is the right direction.
- LIGHTING (6): the cyan fringe on the shadow's starboard wingtip survives — (1209,787)=(29,78,110) against shadow body (45,64,91).
- CREDIT — VFX: the star-sprite muzzle flash is GONE. Flashes at (860,390)/(890,395) are now orange blobs with lighter cores. They are still flat hard-edged splats with no cone, no smoke puff and no warm spill on the wing, but the four-round automatic failure is closed.
- CREDIT — COMPOSITION (7): the runway as leading line is still the strongest compositional idea in the set.

### water — NOT_SHIPPABLE (AAA 5/10)

- MATERIAL (4): the exposure overshoot is NOT fixed. The upper-wing roundel centre reads (90,97,103) — a neutral grey where a red decal should be — and the wing's mean per-pixel chroma spread is 13.1 across a 200x40 sample. The airframe is a near-monochrome pale tan object with the camouflage indistinguishable, at roughly 30m from camera. Fix: gate aerial perspective on distance so a subject inside 100m keeps its albedo.
- COMPOSITION (4) AUTOMATIC FAILURE: empty frame. One aircraft, one distant speck at (180,410), nothing else happening in the whole image.
- COLOUR (4): the 2nd-percentile luma is 85.9 — there is not a single dark value anywhere in the frame. The result is a milky wash with no blacks to lift or tint.
- ENVIRONMENT (4): the sun path from (0,700) to (600,1080) is a blown cream/khaki wash that reads as wet sand, not water, and the dark diagonal scratch marks with no source event are still there — I count five in c7/wat_sea.png at 3x. The land is still a smooth featureless olive-tan ridge with no beach, no surf, no vegetation, no settlement.
- LIGHTING (5): no warm sun rim on the airframe despite a visible sun disc top-left, and no cast shadow on the water.
- CREDIT — VFX: the specular chromatic fringing is GONE. At 3x across the full sun path there are no orange or cyan fringes on the sparkles and no rainbow speckles. This was the frame's worst automatic failure for three rounds.
- CREDIT — VFX: the prop is now a correct hub-centred radial disc with blade streaks.

### damage — NOT_SHIPPABLE (AAA 5/10)

- VFX (3): the flame has REGRESSED into hard-edged flat geometric primitives. c7/dmg_fire.png at 4x shows a red capsule at (935,485), yellow rectangular bars at (955,510), a yellow bar with a square terminated end at (1030,530) and a white capsule at (985,540) — flat unshaded pills painted onto the wing surface. No tongue, no turbulence, no stepped banding, no silhouette erosion.
- VFX (3): the smoke still has no core. Plume core (120,320)=(62,70,94) and (200,300)=(64,72,95) against plume edge (60,500)=(59,68,92) — 3 levels. Against clear field (43,58,84) the plume lifts the terrain by only ~15 levels, so the ground is fully readable through the densest part. Still cool grey-lavender with no relationship to the warm fire beside it.
- COLOUR (5) REGRESSION: R6 called this the best grade in the build. Mean chroma has fallen to 26.0 and the whole frame now sits under a blue-grey haze veil — the teal sea versus orange flame contrast that earned the credit has been washed out.
- VFX (4): the tracers scattered through the plume region at (10,610), (95,625), (520,730) are flat yellow capsules with no hot core, no length taper and no glow.
- MATERIAL (6): battle damage is still flat red decals with hard edges, no charring, no torn metal, no soot streaking aft.
- CREDIT — LIGHTING (7): the fire still emits real light onto the fuselage underside, AND the aircraft now casts a correct planform shadow on the fields at (490–520, 820–845), plus the smoke plume casts a large soft shadow across the terrain.
- CREDIT — ENVIRONMENT (6): still the best field work in the build — real parcels, hedgerow boundaries, crop-direction striping. This is the method the other frames need.

### hud — NOT_SHIPPABLE (AAA 5/10)

- UI (6) REGRESSION: a second GREY ring-and-cross has appeared at (730,521), 24px above the orange lead-marker ring-and-cross at (722,545) (c7/hud_ret.png, 3x). With the white pipper at (960,540) that is three ring-and-cross glyphs in one frame and two of them stacked at the lead position. This is precisely the ambiguity the R6 fix removed. Fix: delete the grey glyph or change its form entirely so it cannot be mistaken for an aiming point.
- ENVIRONMENT (4) AUTOMATIC FAILURE: c7/hud_fields.png at 2x — hard-edged flat Voronoi polygons with uniform dark strokes across the lower right from x=950, and flat mottled green with zero field structure across the entire left half. Unchanged from R3 onward.
- VFX (5): the propeller is a faint brownish ghost disc around (690–990, 590–720) with no blades, no radial ramp and no core. Better than R6's concentric hairlines, but not the ground_attack/sunset implementation.
- MATERIAL (6): the ruler-straight constant-width road is gone (credit), but the terrain still carries no roads, no settlement and no watercourses at all.
- CREDIT — SILHOUETTE (7): the player aircraft is fixed. It reads (123,108,92) against terrain (75,91,87), with a warm sunlit upper surface, a dark cool shadowed underside, a rim along the spine and fully saturated roundels. R6's flat dark lump is gone.
- CREDIT — VFX: the wing muzzle-flash star sprites are gone.
- CREDIT — UI: POWERPLANT/AIRFRAME panels, digit tapes, G-meter, compass ribbon and TACTICAL minimap remain the best-executed work in the build.

## Highest leverage

1. 1. SINGLE HIGHEST LEVERAGE — FINISH THE PROPELLER JOB. You now have a correct implementation in TWO files: sunset (hub-centred, radial blade-blur, warm rim) and water. You shipped it to two frames and left four broken, and two of those are now WORSE than when they had nothing. low.png renders a 220px-tall pale fog column offset left of the spinner that spills down onto the field; hero.png renders a formless brown smudge floating up-and-left of the nose with sky between it and the spinner; dogfight renders a ghost arc that never touches the nose; clouds renders an opaque featureless plate; hud a faint brown ghost. Delete every non-sunset prop path. Instance the sunset mesh, parent it to the spinner transform, and verify at 4x in all ten frames. This is the third consecutive round where the fix exists and is not propagated, and it is now costing you two frames it did not cost you before.

2. 2. STOP THE REGRESSIONS YOU ARE CAUSING IN FRAMES THAT WERE WORKING. Three separate over-corrections landed this round. hud gained a second grey ring-and-cross 24px above the orange lead marker — the exact stacked-aim-point ambiguity you removed last round. damage's flame became hard-edged flat capsules and rectangles painted on the wing, and damage's grade — which I credited as the best in the build — desaturated to chroma 26.0 under a blue-grey veil. hero and low gained propellers that read as render artifacts. You are now losing roughly as much per round as you gain. Before you touch a frame, screenshot it, make the change, and diff the two at 3x.

3. 3. FIELD GENERATION: RUN THE GENERATOR ON dogfight AND hud. You proved the method in damage, and this round you successfully ported it to hero — the confetti is gone and hero now has parcels, hedgerows and a road. dogfight and hud still ship the identical hard-edged flat Voronoi polygons with uniform dark-navy strokes that have been the same automatic failure since round 3, and both frames additionally have large regions (dogfight x<300, hud x<950) of completely flat untextured green with no field system at all. This is the largest surface area in both frames.

4. 4. LIGHT THE COCKPIT AND TEXTURE ITS INTERIOR. Fifth round unchanged and now quantified: the port cockpit wall measures mean luma 53.5, sd 5.97, body range 50–56 over a 180x140 region — a flat untextured unshaded slab, a rubric automatic failure, occupying a large share of the frame. There is still no canopy glass at all (no pane, no reflection, no frame thickness). One sun shaft with a canopy-frame shadow across the coaming and panel, plus rivets and panel lines on the interior walls, would move cockpit from 5 to a candidate 7. The gunsight is already solved; this is now the only thing holding the frame down.

5. 5. GIVE THE SMOKE A CORE, AND MAKE THE FIRE A FLAME AGAIN. damage plume core (62,70,94) vs edge (59,68,92) is a 3-level difference after a round of work — the smoke is still one uniform thin translucency. Drive alpha AND value off normalised particle age, add a genuinely opaque core, add per-particle rotation and eroded alpha, and vary spawn size. Then rebuild the fire: it is currently flat orange/yellow/red capsules and rectangles with hard silhouettes sitting on the wing surface. Stepped banding, a white-hot base, an eroded tongue silhouette, and a soft depth fade against the airframe.

6. 6. FIX THE HAZE BAND PROPERLY — THIS IS THE FOURTH ROUND. It narrowed slightly and the top of the sky is blue again, which is progress, but at hero x=1500 the band still spans y≈120–460 and the sea reads (184,190,185) against the band at (184,191,187). One level. You still cannot locate the horizon in the right half of hero, low or dogfight. Give the sea an independent value floor that the haze cannot lift past, cap the band at ~80px, and tint it toward the sky hue instead of neutral cream.

7. 7. RETEXTURE THE ground_attack APRON AND FINISH THE SHADOW CASTER SET. The quad mesh is still a visible diagonal grid across the whole concrete (third round). The parked aircraft is still a white cruciform placeholder casting nothing on lit ground. The cyan fringe on the player's shadow wingtip is still measurable at (1209,787)=(29,78,110). All three were on last round's list and none moved.

8. 8. FIX water's EXPOSURE ON THE SUBJECT AND clouds' CLOUD DECK. water's roundel centre measures (90,97,103) — neutral grey — and the wing's mean chroma spread is 13.1: you are applying full aerial perspective to an object 30m from camera. Gate it on distance. clouds' deck measures sd 1.32 over a 120x60 region: flat paint across a third of the frame. Both are automatic failures with a single-line cause.

9. 9. PUT SOMETHING IN THE EMPTY FRAMES. clouds and water are both still one aircraft alone in two megapixels, third round running, and hero's right half is empty and hazed. A wingman in the mid-ground, a contrail, a ship wake, a distant flak line — any of these costs almost nothing and closes a composition score of 3–4.

10. 10. REPLACE THE TREE ASSET. Fifth round. Faceted canopy slabs of floating polygon shards with visible gaps between them, on straight untapered cylinder trunks with no branches, bark or root flare. Two new distant silhouettes appeared; every hero-scale tree in low.png is still the identical asset.

