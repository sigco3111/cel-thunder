# Art director critique — round 5

**Verdict: NOT_SHIPPABLE** · best frame: sunset · reference available: false

## Round-4 item status

### [PARTIAL] 1. Get motion blur / TAA off the player aircraft AND fix the translucent wing material

BLUR: FIXED. In hero.png and sunset.png the aircraft is now razor sharp — crop scratchpad/c5/hero_ac.png shows crisp panel lines, individual rivet rows, a legible 'F.DS' code and an un-smeared fin flash; scratchpad/c5/sun_ac.png shows readable rivet stitching along the wing walkway. No ghosting on any leading edge. TRANSLUCENCY: NOT FIXED, AND WORSE. It has spread from 2 frames to at least 5. scratchpad/c5/dog_wing.png (5x) shows the field-polygon boundaries and pale-green crop patches running UNINTERRUPTED through the entire starboard wing and aft fuselage — only the ink strokes and the roundel decal are opaque. scratchpad/c5/wat_ac.png (3.2x) is worse still: the port wing's dark leading-edge line is visible THROUGH the fuselage and continues out the far side, so you are looking at the far-side geometry through the hull. scratchpad/c5/ga_ac.png shows terrain tonal variation continuing through the port wing. scratchpad/c5/hero_fin.png (6x) shows a whole white cloud and the green horizon visible through the horizontal stabiliser.

### [NOT_ADDRESSED] 2. Put the aircraft in the shadow caster set

Zero of ten frames show an aircraft shadow. Third consecutive round unmoved. scratchpad/c5/low_under.png (3x) is the proof shot: the aircraft is ~40m over the field and the ground directly beneath it is unbroken yellow crop, while a small tree in the SAME crop, ~20m away, casts a clean hard correctly-oriented shadow. scratchpad/c5/low_tree.png shows a second tree throwing a long hard shadow across the same field. Same in ground_attack.png (low strafing pass over a lit airfield, nothing on the ground), dogfight.png and damage.png. The rig demonstrably works and the subject is still excluded from it.

### [FIXED] 3. Fix the exposure clipping on the aircraft (water.png blown to one uniform cream)

Sampled luminance across four facings of water.png's airframe: upper wing (900,410) lum 84, underside (800,455) lum 69, fuselage side (1010,415) lum 101, tailplane (560,450) lum 110. That is a ~40-level spread with a readable terminator and a warm gold rim line along the wing leading edge, versus round 4's single uniform cream. The clipping is gone. (The frame still fails, but on translucency, not on exposure.)

### [FIXED] 4. Replace the cirrus — kill the mechanically parallel stripe tiling

Best-executed item of the round. clouds.png now has genuinely curved, wind-sheared cirrus with organic swirls, varied band spacing and varied opacity across the dome — no repeating waveform, no single angle. sunset.png's upper sky has soft curving streaks that bend toward the horizon. hud.png and water.png likewise. The visible-tiling automatic failure is closed. Only residue: the upper-right quadrant of clouds.png (see scratchpad/c5/cl_ac.png) is still noticeably more parallel and evenly spaced than the rest of the dome.

### [PARTIAL] 5. Fix the vegetation — the 30x instance and the rainbow chromatic shimmer

30x INSTANCE: FIXED. scratchpad/c5/low_tree.png (3x) shows the foreground tree is now at a plausible scale relative to its own cast shadow. Tree density, placement and distance falloff across low.png are all much improved. CHROMATIC CONFETTI: NOT FIXED. scratchpad/c5/low_horizon.png (4x) shows every tree card along the horizon ridge wrapped in a red halo on one side and a cyan halo on the other, plus a continuous red hairline running along the whole field/sky boundary. TREE ASSET: unchanged — still exactly one silhouette, a flat faceted low-poly canopy slab with internal triangle edges inked at constant weight, on a perfectly straight untapered cylinder trunk with no branches, bark or root flare. In ground_attack.png (scratchpad/c5/ga_trees.png, 3.5x) the entire treeline is dark navy amoebas and bright-green lozenges in hard constant-weight outlines — it reads as pond scum, not woodland.

### [PARTIAL] 6. Finish the smoke — kill the constant-weight ink, add density and age falloff

INK: FIXED. scratchpad/c5/dmg_smoke.png (2.8x) confirms the uniform hard dark outline around every puff is gone; puffs now have internal faceted shading with darker cores. FALLOFF: NOT FIXED. The oldest puffs at the far top-left end of the trail are as opaque, as saturated and as hard-silhouetted as the newest at the aircraft — several of the oldest are the DARKEST in the trail. Zero dissipation. The lobes now read as faceted grey boulders with straight facet edges and sharp silhouette corners rather than smoke. NEW: the same red/cyan chromatic fringing has appeared on the puff edges, plus stray single red and green pixels inside the puffs at (95,260), (140,380) and (145,570) in that crop.

### [NOT_ADDRESSED] 7. Rebuild the propeller disc — radial alpha ramp, hot tip arc, additive, centred on the spinner

Still a hard-edged elliptical wireframe hoop in the majority of frames, and still not centred. scratchpad/c5/sun_ac.png shows the worst case: a crisp elliptical ring outline floating up-and-LEFT of the spinner with a clear gap between hoop and nose. scratchpad/c5/cl_ac.png (6x) shows the same detached hard hoop offset up-right of the spinner. water.png and dogfight.png the same. Only ground_attack.png (scratchpad/c5/ga_ac.png) has any radial ramp, and even there the fan is bounded by a crisp ellipse arc. hud.png renders the disc as a set of concentric elliptical hairlines. No frame has a hub-to-tip alpha ramp with a hot tip arc and no visible boundary.

### [PARTIAL] 8. Fix HUD label placement, contrast and the reticle; move the chase-cam aircraft off centre

LABELS: FIXED. In hud.png 'P-51D Mustang 4.0km', 'A6M5 Zero 3.6km' and 'Bf 109 G-6 455m' all now sit on dark contour plates, clear of the 495 airspeed chip and clear of the reticle. In cockpit.png 'Bf 109 G-6 410m' has moved off the gunsight. V/S now has a stepped scale with 20/10/10/20 ticks and an 'm/s' unit. cockpit.png's compass reads 34 35 N 01 02 03 04 05 06 07 — the broken single-digit '3' entries are gone. RETICLE: REGRESSED. scratchpad/c5/hud_ret.png (4x) shows FIVE overlapping elements stacked at one point — a large ticked grey ring, an orange corner-bracket square offset up-left, and THREE separate ring-and-cross pippers stacked vertically (grey, orange, orange-with-dot). Round 4 had one unreadable cluster; there are now three candidate aiming points. COMPOSITION: NOT ADDRESSED — the player aircraft is still dead centre directly beneath the reticle stack.

### [PARTIAL] 9. Depth-scale the terrain surface textures

WATER: improved. In water.png the foam patches at the bottom edge are ~80px blobs and shrink continuously to fine speckle near the horizon — real perspective scaling, plus a legible depth ramp. TERRAIN: NOT FIXED. scratchpad/c5/low_under.png shows the tan foreground field applying its dash-stroke stipple at the same on-screen frequency at the bottom edge as at the mid-ground 300m away. The yellow crop field above it does the same.

### [PARTIAL] 10. Grade each frame individually — dominant plus complementary, lifted tinted blacks, narrow haze band

damage.png now has a genuine complementary grade — deep teal sea and blue sky against orange flame, and it is the best-graded frame in the set. sunset.png has picked up a real violet/mauve in the sea away from the sun path, breaking the round-4 lemon monochrome, though land, sky and aircraft are all still in one narrow yellow band. NOT ADDRESSED: ground_attack.png is still one muddy dark-olive wash with unlifted untinted blacks and a heavy corner vignette. hero.png's blown cream haze wedge is unchanged — it still consumes the entire upper-right quadrant from x≈1000 to the frame edge, along with a phantom soft diagonal light shaft across the upper sky that has no source geometry.

## Summary

NO REFERENCE WAS AVAILABLE. I checked refs/ again this round: it contains exactly one file, README.md, and zero reference captures. I did NOT perform the blind A/B the rubric describes and I am not claiming one. All ten frames were captured fresh via `node tools/shoot.mjs --out shots/round5 --warmup 9000` into /Users/paulius/Dev/cel-thunder/shots/round5/ (all ten rendered clean at ~120fps ultra with zero GL errors), every PNG was opened and looked at, and fourteen regions were cropped and magnified at 1.9x to 6x to verify specific claims. Crops are in the scratchpad at c5/: hero_ac, hero_fin, dog_ac, dog_wing, low_under, low_horizon, low_tree, ga_trees, ga_ac, cl_ac, cl_deck, sun_ac, wat_ac, wat_sea, dmg_smoke, dmg_fire, hud_ret, ck_panel. I also sampled airframe luminance numerically in three frames to test the lighting and fire-spill claims rather than eyeballing them. VERDICT: NOT_SHIPPABLE. Zero of ten frames clear the rubric's bar that no axis may fall below 7. Two frames, sunset and cockpit, are CLOSE. Of the ten prioritised round-4 items: one is fully fixed (the cirrus — completely and convincingly, and clouds.png now has the best sky in the build), one more is fixed (the water exposure blow-out, measured at a 41-level spread across four facings versus round 4's single cream), six are partial, and two are not addressed at all. The two untouched items are the two that were ranked second and seventh last round: the aircraft still casts no shadow in any of ten frames, and the propeller is still a detached hard-edged hoop floating off the spinner. The single worst outcome of this round is item one. It was written at the top of the round-4 list as the highest-leverage change, it had two halves, and exactly one half was done. The motion blur is genuinely gone — hero.png and sunset.png are now sharp enough to read individual rivet stitching, which is a real and visible win. The translucent airframe is not merely unfixed, it has spread from two frames to five and become qualitatively worse: in water.png you can now see the port wing's leading edge running through the fuselage and out the far side, and in dogfight.png the field-polygon boundaries of the terrain below run unbroken through the entire starboard wing. The subject of half this game's marketing frames is a piece of tinted glass. Three files were named by filename in the round-4 critique and all three still ship it. Beyond the list, two things regressed. The HUD reticle went from one overloaded cluster to five overlapping elements including three separate stacked ring-and-cross pippers, so the player now has three candidate aiming points instead of zero findable ones. And the chromatic red/cyan fringing that was confined to horizon trees has spread to smoke puffs and to water specular glitter — the shimmering-edges automatic failure now fails three frames instead of two. What genuinely improved and must be protected: the cirrus rebuild across the whole sky dome; the cumulus in hud.png with real silver linings and dark cores; sunset.png's warm sun rim and terminator, which is still the best-lit surface in the build; damage.png's colour grade, which is the only frame with a true complementary relationship and lifted tinted blacks; the water's whitecap depth scaling and depth ramp; the cockpit gauge cluster, compass fix and target-label plates; hud.png's label collision fix, which cleanly solved a defect flagged in two consecutive rounds; and the vegetation scatter in low.png, where the 30x instance bug is gone and distance falloff finally works. The pattern is now three rounds old and it is not a skill problem. This team can fix hard things — the cirrus rebuild is genuinely accomplished work. What it does not do is reshoot the frame afterwards and look at it. Fixes land in isolation, the named regression files are never reopened, and the same defect survives a third review with the same crop as evidence.

## Per-shot

### hero — NOT_SHIPPABLE (AAA 5/10)

- MATERIAL (4) — AUTOMATIC FAILURE, UNFIXED FROM R4: the airframe is translucent. scratchpad/c5/hero_fin.png (6x) shows a complete white cloud and the green horizon line visible THROUGH the horizontal stabiliser, and sky through the fin's inner panel. Fix: find the transparent/depthWrite:false that is still set on the hull surface material and revert it — this is the same line of code that was flagged as the number-one item last round.
- VFX (4): still no propeller disc from this angle — the nose ends in a pale nub with a thin vertical white streak. Fix: the disc needs to be a camera-facing radial-ramp quad that exists at all view angles, not geometry that vanishes edge-on.
- VFX (4): the broad soft diagonal light shaft still sweeps across the whole upper sky with no source geometry, no origin and no falloff. It reads as a smeared lens artifact. Fix: anchor godrays to the sun's screen position and gate them on the sun being in frame.
- ENVIRONMENT (4) — AUTOMATIC FAILURE: the fields are confetti — thousands of small hard-edged yellow/olive/brown/green patches with no hedgerow logic, no roads feeding them, no relationship to terrain slope. Fix: generate fields from a road/hedgerow graph and give each parcel a crop direction and within-field value variation.
- COLOUR (5): the blown cream haze wedge is unchanged and still consumes the entire upper-right quadrant plus a blown white hotspot at (1800,400). It flattens the horizon instead of separating sky from land. Fix: narrow the band, tint it, and drive its height off sun elevation rather than a fixed screen-space wash.
- LIGHTING (6): genuine progress — a warm sunlit fuselage spine and upper wing against a darker underside, with a real terminator. This is the second-best-lit airframe in the set and should be protected.
- SILHOUETTE (6): sharp now, blur regression closed — but the see-through wing panels break the outline so the planform does not read as a solid object.

### dogfight — NOT_SHIPPABLE (AAA 4/10)

- MATERIAL (3) — WORST TRANSLUCENCY IN THE SET: scratchpad/c5/dog_wing.png (5x) shows field-polygon boundaries and pale crop patches running unbroken through the entire starboard wing and aft fuselage. The aircraft is a tinted-glass overlay on the terrain; only the ink strokes and the roundel are opaque. Fix: same material revert as hero.
- ENVIRONMENT (3) — AUTOMATIC FAILURE: the fields in the lower-left third are hard-edged flat Voronoi polygons in untextured colour. No crop direction, no within-field variation, no wear at boundaries. Unchanged from R4.
- ENVIRONMENT (4): the ruler-straight parallel lines still run across the terrain at constant width from foreground to horizon. Whatever generates roads is producing rulered parallels, not routes that respond to terrain.
- VFX (4): the muzzle flash is still a flat yellow triangle/star sprite with no barrel geometry, no smoke and no light spill on the wing — verbatim the rubric's default-additive-sprite failure.
- VFX (4): the flak bursts are still a string of near-identical grey lobes on a near-straight line at even spacing — a bead necklace. Fix: vary burst size, opacity, age and off-axis scatter, and add a dark core with a lighter shock ring.
- VFX (4): tracers are thin white scratch lines with no hot core, no length taper and no glow.
- VFX (4): the prop is a hard-edged elliptical hoop with radial spokes, offset right of the spinner.
- LIGHTING (4): no cast shadow despite low altitude, and the airframe has no gradient around the fuselage circumference.
- COMPOSITION (5): the bandit, flak line and tracers are all crammed into the upper-left quadrant; the entire right half is doing nothing under an extreme dutch angle.

### low — NOT_SHIPPABLE (AAA 4/10)

- ENVIRONMENT (3) — AUTOMATIC FAILURE, UNFIXED: scratchpad/c5/low_horizon.png (4x) shows every horizon tree card wrapped in a red halo on one edge and a cyan halo on the other, plus a continuous red hairline along the whole field/sky boundary. This is the rubric's shimmering-edges/aliasing failure and it is now in its second round. Fix: this is a sub-pixel offset in the ink or CA pass — clamp the chromatic offset to zero beyond a distance threshold, and mip the vegetation alpha properly.
- LIGHTING (3): still no aircraft shadow. scratchpad/c5/low_under.png (3x) shows unbroken crop directly beneath an aircraft at ~40m, while a tree in the same crop casts a clean hard shadow. At this altitude the shadow is the single strongest depth cue a player reads.
- ENVIRONMENT (4): the tree asset is still one silhouette — scratchpad/c5/low_tree.png (3x) shows a flat faceted low-poly canopy slab with internal triangle edges inked at constant weight, sitting on a perfectly straight untapered cylinder trunk with no branches, no bark, no root flare. Every tree in the frame is this same lollipop. Fix: four silhouette variants minimum, canopy clumping, and a real trunk with taper and a branch fork. (Credit: the 30x-scale instance bug is genuinely gone and distance falloff is much improved.)
- MATERIAL (4) — AUTOMATIC FAILURE: the tan foreground field occupies ~40% of the frame with a dash-stroke stipple at ONE uniform on-screen frequency from the bottom edge to the mid-ground. Zero perspective scaling.
- SILHOUETTE (5): the aircraft is a dark low-contrast mass against a mid-value field with no sun rim to lift it off.
- VFX (5): the prop is a soft elliptical arc still bounded by a visible hard ring edge, plus a pale flare streak running down onto the field.

### cockpit — CLOSE (AAA 6/10)

- MATERIAL (4) — UNFIXED FROM R4 AND R3: two large pale-grey angular slabs still sit at the bottom of the frame as raw untextured geometry with visible flat facets (scratchpad/c5/ck_panel.png, 2.6x). Third round unchanged. Fix: texture them or cut them out of the framing.
- MATERIAL (5): still no canopy glass — no reflection, no scratches, no frame thickness, no distortion at the curved sections. You look through open air between the tubing.
- MATERIAL (5): the panel and coaming are still a flat dark navy. Rivet dot rows have been added along the edges, which is real progress, but there is no wear on the switch surrounds, no scuffing at the stick, no interior green or black, no variation anywhere across the surface.
- LIGHTING (3): no light enters the cockpit. No sun shaft across the panel, no shadow of the canopy framing on the coaming or the instruments, no bounce off the panel — the interior is lit by a single flat ambient. Unchanged from R4.
- UI (5) — NEW DEFECT: the pitch ladder rungs ('10', '20') are drawn ON the instrument panel face, below the canopy sill. A head-up ladder is being painted onto cockpit interior geometry. Fix: depth-test or occlude the ladder against the canopy sill.
- UI (6): the outer left and right gauge columns are still illegible — blurry yellow tick blobs with no discernible markings. Fix: cull them or raise their texel density.
- UI (6): the gunsight is still three stacked ring-and-cross pippers plus an orange bracket square, same defect as hud.png.
- UI (7): genuinely fixed this round — compass ribbon now reads 34 35 N 01 02 03 04 05 06 07 correctly, the Bf 109 label has moved off the reticle, V/S has a stepped scale with units, and the right-edge target chevrons are now labelled with ranges. The gauge cluster (ASI, artificial horizon, altimeter, compass rose, RPM, boost, turn-and-slip) is a real instrument panel.

### clouds — NOT_SHIPPABLE (AAA 4/10)

- ENVIRONMENT (3) — AUTOMATIC FAILURE: the cloud deck's boundary is a hard straight geometric cut with visible stair-step aliasing. scratchpad/c5/cl_deck.png (1.9x) shows a razor-straight lower edge and a straight diagonal on the right that are plane intersections, not cloud edges. Fix: displace and erode the deck boundary with noise, or fade it out with a depth-based alpha rather than terminating it at a mesh edge.
- LIGHTING (3): the aircraft is a flat near-black silhouette under full overhead sun. I sampled four facings — upper wing lum 59, fuselage lum 57, underside lum 53, tail lum 57. A six-level spread out of 255 is one value. There is no terminator, no rim, and critically no bounce from the enormous white cloud deck directly below, which should be throwing heavy fill onto the belly.
- VFX (4): the prop is a hard-edged elliptical hoop clearly detached and offset up-right of the spinner (scratchpad/c5/cl_ac.png, 6x).
- COMPOSITION (4) — AUTOMATIC FAILURE: empty frame. One small aircraft, no wingman, no contrail, no sun disc, no target, nothing else in two megapixels.
- SILHOUETTE (4): at this scale and value the aircraft could be a bird — no planform reads, no glint.
- ENVIRONMENT (7): the cirrus is genuinely fixed and is now the best sky in the build — curved, wind-sheared, varied in spacing and opacity, with real swirl structure. Protect this. Only the upper-right quadrant still reads as evenly-spaced parallel bands.

### ground_attack — NOT_SHIPPABLE (AAA 4/10)

- LIGHTING (3): still no aircraft shadow, in the one framing where it matters most — a low strafing pass over a lit airfield. This has been the number-one complaint on this frame for three consecutive rounds.
- LIGHTING (3): the aircraft is a dark navy lump with no rim and almost no value separation from the terrain it sits on.
- MATERIAL (3): translucent — scratchpad/c5/ga_ac.png (3.4x) shows the field's tonal variation continuing uninterrupted through the port wing and fuselage.
- VFX (4) — AUTOMATIC FAILURE: the muzzle flashes are still flat yellow 4- and 5-point star sprites, three of them visible in the crop, unchanged from R4 and R3. The gun impacts are white star blobs with a soft additive glow. Fix: replace with a short cone of stepped orange bands anchored to the barrels, plus a puff of grey smoke and a brief warm spill on the wing.
- ENVIRONMENT (4) — AUTOMATIC FAILURE: the runway apron and taxiways are flat light grey with the triangle mesh visible as diagonal shading facets across the concrete. Unchanged.
- ENVIRONMENT (4): the entire left treeline is dark navy amoebas and bright-green lozenges in hard constant-weight ink outlines (scratchpad/c5/ga_trees.png, 3.5x), sitting on ground that shows a regular diagonal cross-hatch tiling weave. Plus residual red/cyan speckle at the far-left horizon.
- COLOUR (4): still one muddy dark-olive wash with a heavy corner vignette, unlifted untinted blacks and mid-tone mush. No dominant/accent relationship.
- VFX (5): the smoke plumes are lavender-violet cauliflower clusters with no relation to the scene's light and no opacity falloff.
- COMPOSITION (6): the runway remains the strongest compositional idea in the set — undermined by a small, dark, see-through subject.

### sunset — CLOSE (AAA 6/10)

- VFX (3) — WORST PROP IN THE SET: scratchpad/c5/sun_ac.png (2.6x) shows a large crisp elliptical wireframe hoop floating up-and-left of the spinner with a visible gap between the hoop and the nose. It reads as a hula hoop suspended in front of the aircraft. Fix: parent the disc to the spinner transform, kill the boundary geometry, and drive alpha off a hub-to-tip radial ramp with a hot tip arc.
- COLOUR (5): land, sky, aircraft and the sun path are all still in one narrow lemon-yellow band. The new violet in the sea away from the sun path is real progress and the right instinct — extend it into the shadow side of the land and into the aircraft's shadowed facings.
- ENVIRONMENT (4): the mid-ground land is a featureless yellow smear with no fields, no vegetation, no roads and no settlement. Only the extreme bottom-left corner has structure, and there it is stair-stepped pixelated polygons.
- VFX (5): the hexagonal lens-flare ghost to the upper right of the aircraft plus a second pale blob below it read as artifacts, not as an art-directed flare.
- MATERIAL (6): mild translucency — cloud is faintly visible through the wing root and through the fin's inner panel.
- LIGHTING (8): the strongest thing in the build. A real warm gold sun rim along the wing leading edge and canopy frame, a genuine terminator down the fuselage, and now sharp enough to read rivet stitching and panel demarcation. Protect this exactly as it is.
- COMPOSITION (7): subject upper right, sun left, coastline as a leading line, surf and beach as foreground interest. Best-composed frame in the set.

### water — NOT_SHIPPABLE (AAA 4/10)

- MATERIAL (2) — AUTOMATIC FAILURE, WORST INSTANCE IN THE SET: scratchpad/c5/wat_ac.png (3.2x) shows the port wing's dark leading-edge line running THROUGH the fuselage and out the far side, plus the far-side wing root, the tailplane and the opposite roundel all visible through the hull. This is no longer 'translucent wings' — the whole airframe is clear glass. Fix: the hull material revert, then verify against this exact framing.
- VFX (3): the prop is a hard-edged elliptical arc detached and offset forward-right of the spinner.
- COMPOSITION (4) — AUTOMATIC FAILURE: empty frame. One aircraft, one distant speck at (175,410), nothing else happening.
- ENVIRONMENT (4): the land is a smooth featureless olive-tan ridge across the whole midline with no vegetation, no beach, no surf, no settlement — a flat untextured mass.
- ENVIRONMENT (5): thin dark diagonal scratch marks are still on the water with no source event (three visible in scratchpad/c5/wat_sea.png at 2.6x), and the specular glitter now carries orange and cyan chromatic fringes.
- LIGHTING (4): no cast shadow on the water.
- LIGHTING (6): the round-4 exposure blow-out is genuinely fixed — measured luminance across the four facings is 69/84/101/110, a readable terminator with a warm rim line.
- ENVIRONMENT (7): whitecap depth scaling is fixed — foam patches shrink continuously from ~80px at the bottom edge to fine speckle at the horizon. The sea no longer flattens into a painted plane.

### damage — NOT_SHIPPABLE (AAA 5/10)

- VFX (4): the smoke has zero density or opacity falloff with age. scratchpad/c5/dmg_smoke.png (2.8x) shows the oldest puffs at the far end of the trail are as opaque, as saturated and as hard-silhouetted as the newest — several of the oldest are the darkest in the trail. Fix: drive alpha and value off normalised particle age so the trail dissolves.
- VFX (4): the puffs read as faceted grey boulders — hard low-poly masses with straight facet edges and sharp silhouette corners. Fix: soften the silhouette with per-particle rotation and an eroded alpha, and vary spawn size so they stop forming a bead chain.
- VFX (4): the smoke puffs carry red/cyan chromatic fringing on their edges plus stray single red and green pixels inside them at (95,260), (140,380) and (145,570) in that crop.
- LIGHTING (4): the fire still throws no light. I measured the fuselage skin directly above the flame at lum 93 and the skin several metres aft at lum 95 — a 2-level difference. No warm spill on the skin, none on the terrain below, none on the smoke. Fix: a cheap point light or a screen-space warm gradient keyed to the flame's screen position.
- VFX (5): the flame itself is four nested elongated capsules laid parallel along the fuselage — graphically stepped, which suits the cel look, but they read as extruded pill shapes with no turbulence, no break-up and no tapering tongue.
- LIGHTING (4): no cast shadow on the ground.
- ENVIRONMENT (4) — AUTOMATIC FAILURE: the fields below are flat hard-edged colour polygons with black tree specks and no texture.
- MATERIAL (5): mild translucency — the far wing's leading edge reads through the upper-left wing surface.
- COLOUR (7): the best grade in the build — deep teal sea and blue sky as dominant, orange flame as a true complementary accent, blacks lifted and tinted. Protect this.
- VFX (6): the sparks and embers shedding aft along the airflow are correct and convincing.
- ENVIRONMENT (7): the coastline, beach and surf line are the best terrain work in the set.

### hud — NOT_SHIPPABLE (AAA 5/10)

- UI (4) — REGRESSION: the reticle got worse, not better. scratchpad/c5/hud_ret.png (4x) shows FIVE overlapping elements at one point — a large ticked grey ring, an orange corner-bracket square offset up-left, and THREE separate ring-and-cross pippers stacked vertically. Round 4 had one unreadable cluster; the player now has three candidate aiming points. Fix: one pipper, one containment ring, and delete everything else.
- COMPOSITION (4) — NOT ADDRESSED: the player aircraft is still dead centre directly beneath the reticle stack, so airframe and instrument merge into noise. In a chase-cam HUD frame the aircraft belongs low and clear.
- VFX (4) — AUTOMATIC FAILURE: the wing muzzle flashes are flat yellow 4-point star sprites, clearly visible on both wings in that crop.
- VFX (4): the prop renders as a set of thin concentric elliptical hairlines rather than a disc.
- ENVIRONMENT (4) — AUTOMATIC FAILURE: the fields across the bottom third are hard-edged flat Voronoi polygons, plus a ruler-straight road running to the horizon and the same faceted grey cauliflower smoke puffs on the terrain.
- LIGHTING (4): the player aircraft is a flat dark brown/navy lump with no lighting differentiation against bright terrain, and no shadow.
- UI (7): the label work genuinely landed — 'P-51D Mustang 4.0km', 'A6M5 Zero 3.6km' and 'Bf 109 G-6 455m' all now sit on dark contour plates, clear of the 495 airspeed chip and clear of the reticle. V/S has a stepped scale with units. The compass reads 28 29 30 31 32 33 34 35 N 01 correctly. The POWERPLANT and AIRFRAME panels, the digit tapes, the G-meter and the TACTICAL minimap remain the best-executed work in the build.
- ENVIRONMENT (7): the cumulus now have real shape, silver linings and dark cores, and the cirrus is fixed. Best cloud work so far.

## Highest leverage

1. SINGLE HIGHEST LEVERAGE — FIX THE TRANSLUCENT AIRFRAME. This was item 1 last round, it was called the single highest leverage change, and it has not only gone unfixed, it has SPREAD from two frames to five. Evidence: scratchpad/c5/wat_ac.png shows the port wing's leading edge and the far-side roundel visible THROUGH the fuselage; scratchpad/c5/dog_wing.png shows field-polygon boundaries running unbroken through the entire starboard wing; scratchpad/c5/ga_ac.png shows terrain tone continuing through the port wing; scratchpad/c5/hero_fin.png shows a whole cloud through the horizontal stabiliser. The blur half of the item was fixed, which proves someone read the note — and then shipped without opening the frames that the note named by filename. Find the transparent/depthWrite:false still set on the hull surface material, revert it, and verify by reshooting water.png and dogfight.png specifically. Until the subject is an opaque solid, every other art fix underneath it is invisible.

2. PUT THE AIRCRAFT IN THE SHADOW CASTER SET. Zero of ten frames, three rounds running, on an item that has been listed at position two both previous rounds. scratchpad/c5/low_under.png and scratchpad/c5/low_tree.png are the same crop 700px apart: a tree throws a hard correctly-oriented shadow onto the field, and the aircraft flying forty metres above that identical field throws nothing. This is not a broken shadow system — it is one missing castShadow flag or a fitted region that excludes the player. It should take one engineer twenty minutes and it has now consumed three rounds of critique.

3. REBUILD THE PROPELLER DISC AND PARENT IT TO THE SPINNER. Item 7 last round, unmoved. scratchpad/c5/sun_ac.png and scratchpad/c5/cl_ac.png both show a crisp elliptical wireframe hoop floating detached from and offset relative to the nose — it reads as a hula hoop suspended in front of the aircraft. Requirements: parented to the spinner transform so it is always concentric with the hub; a camera-facing quad so it exists at every view angle (hero.png currently renders nothing); alpha near zero at the hub ramping to a bright hot arc near the tip; additive blend; and absolutely no visible boundary geometry.

4. COLLAPSE THE RETICLE TO ONE PIPPER. This regressed. scratchpad/c5/hud_ret.png shows three stacked ring-and-cross pippers plus a bracket square plus a ticked containment ring at a single screen point. The player cannot answer 'where do I aim'. Ship one pipper and one containment ring and delete the rest — and while you are in that file, move the chase-cam player aircraft down and clear of the reticle, which has been asked for twice.

5. MAKE THE FIRE AND THE MUZZLE FLASHES EMIT LIGHT, AND MAKE THE SMOKE DIE. Measured: the damage.png fuselage directly above the flame is lum 93 and the same skin several metres aft is lum 95 — a burning aircraft casting a two-level difference. Add a warm point light or a screen-space warm gradient keyed to the flame. Then give the smoke an age-driven alpha and value falloff so the trail dissolves instead of the oldest puffs being the most opaque, and soften the boulder-like faceted silhouettes. Separately, the flat yellow star sprites on the guns in ground_attack.png and hud.png are the same default additive sprite flagged in rounds 3 and 4 — replace them with a stepped orange cone anchored to the barrel with a smoke puff and a spill on the wing.

6. KILL THE CHROMATIC FRINGING GLOBALLY. It was on horizon trees last round; this round it is on horizon trees (scratchpad/c5/low_horizon.png), on smoke puffs (scratchpad/c5/dmg_smoke.png) and on water specular glitter (scratchpad/c5/wat_sea.png). Whatever CA or sub-pixel ink offset is producing the red/cyan halos needs to be clamped to zero past a distance threshold and disabled entirely on particles. This is the rubric's shimmering-edges automatic failure and it is now failing three frames instead of two.

7. DO THE FIELD GENERATION PROPERLY. Hard-edged flat Voronoi polygons in dogfight.png, hud.png and damage.png; confetti patches in hero.png; the identical automatic failure called out in rounds 3 and 4 and never touched. Generate parcels from a road and hedgerow graph, give each a crop direction and within-field value variation, and wear the boundaries. This is the largest surface area in five of ten frames.

8. FINISH THE COCKPIT'S TWO OPEN ITEMS. The two large untextured pale-grey slabs at the bottom of the frame are now in their third round unchanged — texture them or crop them out. Then add canopy glass (a faint reflection, a few scratches, real frame thickness) and one sun shaft with a canopy-frame shadow falling across the panel. The gauge cluster is now good enough that these three absences are what stops the frame reading as a shipped cockpit. Also depth-test the pitch ladder against the canopy sill — it is currently painted onto the instrument panel face.

9. GRADE GROUND_ATTACK AND FIX HERO'S HAZE. ground_attack.png is still one muddy dark-olive wash with unlifted untinted blacks and a heavy corner vignette; hero.png's blown cream haze wedge still eats the upper-right quadrant and is joined by a source-less diagonal light shaft. Both were listed last round. damage.png proves the team can grade — teal and blue against orange, blacks lifted and tinted. Apply that method to the two frames that need it.

10. OPEN THE FRAMES AFTER YOU FIX THEM. Five engineers this round fixed the cirrus (genuinely, completely, and it is the best thing in the build), fixed the water exposure, fixed the whitecap depth scaling, fixed the HUD labels, fixed the cockpit compass, fixed the 30x tree, removed the smoke ink and removed the motion blur. That is a lot of real work. And yet water.png, dogfight.png and ground_attack.png — three files named explicitly by filename in the round-4 list — still ship an aeroplane you can see the far side of through. The failure mode is unchanged from rounds 3 and 4: fixes land in isolation, nobody reshoots and looks at the frame afterwards, and the same defect survives a third review.

