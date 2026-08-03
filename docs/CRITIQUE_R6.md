# Art director critique — round 6

**Verdict: NOT_SHIPPABLE** · best frame: sunset

- see-through airframe: **FIXED**
- aircraft shadow: **FIXED**
- reference captures available: false (no blind A/B performed)

## Summary

NO REFERENCE WAS AVAILABLE. I checked refs/ again: it contains exactly one file, README.md, and zero reference captures — empty for the sixth consecutive round. I did NOT perform the blind A/B the rubric describes and I am not claiming one. All ten frames were captured fresh via `node tools/shoot.mjs --out shots/round6 --warmup 9000` into /Users/paulius/Dev/cel-thunder/shots/round6/ (all ten rendered clean at ~119 fps ultra, zero GL errors; the only console message is an unrelated dev-server WebSocket handshake failure). Every PNG was opened and looked at, and twenty-two regions were cropped and magnified at 2x to 13x, with coordinate-grid overlays and vertical pixel profiles where the eye was not sufficient. Crops are in the scratchpad at c6/.

BOTH STANDING BLOCKERS ARE FIXED. This is the first round in this loop where I can say that.

1. THE TRANSLUCENT AIRFRAME IS FIXED — in all ten frames, not some of them. Evidence: hero's horizontal stabiliser and fin, which showed a whole cloud through them last round, now measure (44,60,83) over white cloud and (43,58,82) over green terrain — a 1.5-level difference, i.e. fully opaque. damage's wing reads (62,77,86) over a dark treeline and (64,79,86) over a bright field. A vertical pixel profile through dogfight's port wing at x=610 shows a fully saturated roundel (blue B=130, red R=163/G=0) with the tan field parcel stopping dead at the trailing-edge ink line. water.png — last round's worst case, where the port wing's leading edge ran through the fuselage and out the far side — at 7.5x now shows the wing cleanly occluding the sky with rivet stitching along the leading edge and no far-side geometry reading through anywhere. I want to be straight about my own process here: on first pass I called dogfight still translucent and I was wrong. Sample boxes that straddled the wing edge, and a wing whose paint sits within five levels of the terrain behind it, produced a false positive. Column profiles across the chord settled it. The bug is gone.

2. THE AIRCRAFT SHADOW IS FIXED. low.png, which has been the proof shot against this team for three rounds, now has a clean, correctly-oriented, correctly-shaped planform shadow — wings, fuselage, fin and tailplane all individually legible — soft-edged and colour-tinted blue-green rather than flat grey, sitting on the same field as the tree shadows that shamed it. ground_attack.png, the other named frame, has the player's shadow on the runway with the radiator scoop readable. Two caveats, neither of which reverses the verdict: the caster set is still incomplete (a parked aircraft on the ga apron casts nothing on lit concrete), and there is a cyan fringe artifact on the ga shadow's wingtip.

Beyond the two blockers, four more genuine fixes landed. The hud reticle is solved: R5's five stacked elements and three candidate aiming points are now one white pipper in one containment ring with one lead line to one lead marker — and the chase-cam aircraft has finally been moved down and clear of it, asked for twice. The damage fire now emits light: a real warm orange spill across the fuselage underside and wing root, against R5's measured two-level difference. The ground_attack propeller is now a correct hub-to-tip radial ramp centred on the spinner with no boundary — the first correct prop in the build. And the chromatic fringing is gone from the horizon trees and gone from the smoke.

VERDICT: NOT_SHIPPABLE. Zero of ten frames clear the bar that no axis may fall below 7. sunset is CLOSE at 7 and is the best frame; damage and cockpit are next at 6.

What is now holding the build back is different in character from previous rounds, and worth naming. Three of this round's four best fixes exist in exactly one file. The correct propeller is in ground_attack and nine frames still ship a wireframe ellipse, a rimmed hoop offset from the spinner, concentric hairlines, or nothing at all. The correct reticle is in hud and cockpit still stacks seven overlapping elements with two offset pippers. The correct field generation — real parcels, hedgerow boundaries, crop-direction striping — is in damage and dogfight, hud and hero still ship the same hard-edged flat Voronoi polygons flagged in round 3. You are no longer failing to fix things. You are failing to propagate the fixes you have already made. That is a cheaper problem than the one you had, and it is the whole of item 1 on the next list.

Two things regressed and both come from over-correcting a previous note. low.png's foreground field was criticised for a stipple that did not perspective-scale; the texture has now been deleted entirely, so half the frame is flat untextured colour — a worse automatic failure than the one it replaced. And water.png's exposure, which R5 credited as fixed, has swung past neutral into a flat grey-mauve wash where the camouflage is barely distinguishable and the roundel is a speckled dither. Meanwhile water's specular chromatic fringing is worse than last round, not better, while the same artifact was successfully killed on trees and smoke in the same pass.

Still unmoved after three or four rounds and still costing frames: the flat yellow star-sprite muzzle flash (rounds 3, 4, 5, 6), the cream haze band that eats hero's entire upper-right quadrant (rounds 4, 5, 6), the unlit cockpit interior and its untextured pale slabs (rounds 3, 4, 5, 6), the single-silhouette tree asset (rounds 3, 4, 5, 6), and ground_attack's muddy olive grade with unlifted untinted blacks (rounds 4, 5, 6).

## Per-shot

### hero — NOT_SHIPPABLE (AAA 5/10)

- ENVIRONMENT (3) AUTOMATIC FAILURE: the fields are confetti — thousands of small hard-edged yellow/olive/brown patches with no hedgerow logic, no roads feeding them, no relationship to slope. Unchanged from R3/R4/R5. Fix: generate parcels from a road+hedgerow graph, give each a crop direction and within-field value variation.
- COLOUR (4): the blown cream haze wedge is UNCHANGED for a third round. Crop c6/hero_haze.png (2.4x) shows a structureless near-white wash from the top edge down to y~350 that swallows the entire horizon across the right half — you cannot tell where sky ends and sea begins. Fix: narrow the band, tint it, drive its height off sun elevation instead of a fixed screen-space wash.
- VFX (4): the source-less diagonal light shaft still sweeps the upper sky with no origin geometry and no falloff. Fix: anchor godrays to the sun's screen position and gate on the sun being in frame.
- VFX (4): no propeller disc from this angle — the nose ends in a pale nub with a thin vertical white streak. Fix: camera-facing radial-ramp quad that exists at all view angles.
- COMPOSITION (6): the right half of the frame is empty and hazed to nothing.
- CREDIT — MATERIAL (7)/SILHOUETTE (7): the airframe is now fully opaque. Crop c6/hero_fin.png (5.5x) shows the cloud terminating cleanly at the fin edge; measured, the fin reads (44,60,83) over white cloud and (43,58,82) over green terrain — a 1.5-level difference. Rivet stitching, panel lines, fin flash and the 'F o DS' codes are all legible.

### dogfight — NOT_SHIPPABLE (AAA 4/10)

- SILHOUETTE (4): the aircraft nearly disappears into the ground. A vertical pixel profile at x=760 across the starboard wing chord gives wing surface (67,85,85) against terrain immediately behind it at (72,88,87) — a 5-level separation. Only the ink strokes and the roundel hold the planform. Fix: a sun-driven rim on the upper surfaces and a darker AO band under the wing so the subject separates from a same-value background.
- ENVIRONMENT (3) AUTOMATIC FAILURE: crop c6/dog_below.png (2.5x) — the fields are still hard-edged flat Voronoi polygons with uniform dark-navy boundary strokes, no crop direction, no within-field variation, no wear at the boundaries, and the whole field system terminates on a hard curved extent boundary against untextured dark green. Verbatim unchanged from R3/R4/R5.
- VFX (3): the flak is still a bead necklace — near-identical brown/grey lobes at near-even spacing on a near-straight line from crop (380,160) to (1600,520) in c6/dog_vfx.png, all the same size, opacity and age. Fix: vary burst size, opacity, age and off-axis scatter; add a dark core and a lighter shock ring.
- VFX (3): tracers are thin white scratch lines with no hot core, no length taper and no glow.
- LIGHTING (4): no cast shadow in this frame despite moderate altitude, and no gradient around the fuselage circumference.
- COLOUR (5): a broad structureless cream haze band runs the width of the frame and swallows the coastline entirely.
- COMPOSITION (5): bandit, flak line and tracers are all crammed into the upper-left quadrant under an extreme dutch angle; the right half is doing nothing.
- CREDIT — MATERIAL (6): the wing is opaque. A column at x=610 through the port wing shows a fully saturated roundel (blue B=130, red R=163/G=0) and the tan field parcel stopping dead at the trailing-edge ink line. I initially mis-read this frame as still translucent; it is not — it is a value-separation failure, not a transparency one.

### low — NOT_SHIPPABLE (AAA 5/10)

- MATERIAL (3) AUTOMATIC FAILURE: the foreground field is now a completely FLAT, untextured, unshaded green gradient across roughly half the frame. R5's complaint was that the stipple did not perspective-scale; the answer appears to have been to delete the texture entirely. That trades one automatic failure for a worse one. Fix: restore a ground texture and scale its on-screen frequency with depth.
- VFX (3): the propeller is still a hard-edged elliptical HOOP with a bright rim line, clearly offset up-and-right of the spinner, plus a pale flare streak running down onto the field (crop c6/low_ac.png, 3x). The hoop that was fixed in ground_attack was not fixed here. Fix: parent the disc to the spinner transform and use the ground_attack implementation everywhere.
- ENVIRONMENT (4): the tree asset is unchanged for a fourth round — crop c6/low_horizon.png (4x) shows faceted low-poly canopy slabs made of floating polygon shards with visible gaps, on perfectly straight untapered cylinder trunks with no branches, no bark, no root flare. Every tree in the frame is the same lollipop family.
- COLOUR (4): the whole frame is washed out under a heavy grey-green haze veil — no dominant/accent relationship, no filmic contrast, blacks faded rather than lifted and tinted.
- SILHOUETTE (5): the aircraft is a dark low-contrast mass against a mid-value field with no sun rim to lift it off.
- CREDIT — LIGHTING (7): THE AIRCRAFT SHADOW IS HERE. Crop c6/low_shadow.png (4x) shows a clean, correctly-oriented, correctly-shaped planform shadow — wings, fuselage, fin and tailplane all legible, soft-edged, and colour-tinted blue-green rather than flat grey — sitting on the same field as the tree shadows that shamed it for three rounds. This is the round's best work.
- CREDIT — ENVIRONMENT: the red/cyan chromatic fringing on the horizon tree cards and the red hairline along the field/sky boundary are both GONE.

### cockpit — NOT_SHIPPABLE (AAA 6/10)

- UI (4) REGRESSION NOT FIXED: crop c6/ck_ret.png (4.5x) shows SEVEN overlapping elements stacked at one point — a grey ticked arc, a grey dashed circle, a second ORANGE dashed circle that is not concentric with the first, an orange ring-and-cross pipper, a separate white ring-and-cross pipper offset below it, an orange corner-bracket square, and a small grey ring. Two candidate aiming points, bisected by the opaque canopy centre post. hud.png fixed this exact defect; cockpit.png did not. Fix: ship one pipper and one containment ring, delete the rest.
- LIGHTING (3): no light enters the cockpit. No sun shaft across the panel, no shadow of the canopy framing on the coaming or instruments, no bounce off the panel. Single flat ambient, unchanged from R4 and R5.
- MATERIAL (4): crop c6/ck_panel.png (2.2x) — the pale-grey untextured slabs at the bottom of the frame are in their FOURTH round unchanged, and there are now three of them. Flat, near-untextured, hard specular sheen, visible flat facets. Fix: texture them or crop them out of the framing.
- MATERIAL (5): still no canopy glass — no reflection, no scratches, no frame thickness, no distortion at the curved sections.
- UI (5): the pitch-ladder rungs '10' and '20' are STILL painted on the instrument panel face below the canopy sill, over the gauges. Flagged in R5, unchanged. Fix: depth-test or occlude the ladder against the sill.
- ENVIRONMENT (6): chromatic fringing survives here — a red/orange hairline along the canopy sill against the sky and a rainbow fringe on the port-side ring fitting.
- CREDIT — UI (7): the switch row is now labelled (MAG 1 / MAG 2 / NAV / PITOT / GUNS / CAM) with rivet dots, a red FIRE button and a 'SPITFIRE MK IX' plate. Compass ribbon, gauge cluster, V/S scale and target-label plates all hold up.

### clouds — NOT_SHIPPABLE (AAA 5/10)

- COMPOSITION (4) AUTOMATIC FAILURE: empty frame. One small aircraft, no wingman, no contrail, no sun disc, no target — nothing else in two megapixels. Unchanged from R5.
- LIGHTING (3): crop c6/cl_ac.png (6.5x) — the aircraft is one flat navy value across every facing. No terminator, no sun rim, and critically no bounce fill from the enormous white cloud deck directly below, which should be throwing heavy light onto the belly.
- VFX (3): the propeller is a thin, hard-edged WIREFRAME ELLIPSE ARC floating detached and offset up-right of the spinner, with clear sky between the arc and the nose. Worst prop in the set this round.
- ENVIRONMENT (6): the deck boundary is much improved — the upper edge is now noise-eroded and organic — but a razor-straight diagonal mesh termination with visible stair-stepping survives in the lower right of the deck. The deck also still reads as a painted plane with flat blue holes rather than volume with dark cores.
- SILHOUETTE (4): at this scale and value the aircraft could be a bird — no planform reads, no glint.
- CREDIT — COLOUR (8)/ENVIRONMENT: the cirrus is the best sky in the build. Curved, wind-sheared, varied in spacing and opacity, with real swirl structure. Protect it exactly as it is.

### ground_attack — NOT_SHIPPABLE (AAA 5/10)

- VFX (3) AUTOMATIC FAILURE: the muzzle flashes are STILL flat yellow 5-point star sprites (crop c6/ga_ac.png, 3.5x, two visible) and the gun impacts are white star blobs with a soft additive glow. Called out verbatim in R3, R4 and R5. Fix: a short cone of stepped orange bands anchored to the barrels, plus a grey smoke puff and a brief warm spill on the wing.
- MATERIAL (3) AUTOMATIC FAILURE: crop c6/ga_apron.png (4x) — the apron and taxiway are flat light grey with the quad mesh visible as a regular diagonal grid across the entire concrete. Unchanged from R5.
- VFX (4): the smoke plumes are lavender-violet cauliflower clusters with hard faceted lobes, no relation to the scene's light, and no opacity or density falloff with age.
- ENVIRONMENT (4): the revetment objects on the apron are flat untextured brown hexagons with a yellow smear; the parked aircraft is a crude pale cruciform placeholder and casts NO shadow at all on a lit apron — the shadow caster set is still incomplete.
- COLOUR (4): still one muddy dark-olive wash with unlifted untinted blacks, mid-tone mush and a heavy corner vignette. Listed in R4 and R5, untouched.
- LIGHTING (6): a cyan fringe artifact sits on the shadow's starboard wingtip where it crosses the runway edge line.
- CREDIT — LIGHTING: the player's cast shadow is on the runway (crop c6/ga_shadow.png, 6x) with a correct planform including the radiator scoop.
- CREDIT — VFX: the propeller here is now a proper hub-to-tip radial ramp with visible blade-blur streaks, centred on the spinner. Best prop in the set. Ship this implementation to the other nine frames.
- CREDIT — COMPOSITION (7): the runway as a leading line remains the strongest compositional idea in the set.

### sunset — NOT_SHIPPABLE (AAA 7/10)

- ENVIRONMENT (4): the mid-ground land is a featureless yellow smear with no fields, no vegetation, no roads and no settlement. Only the extreme bottom-left corner has structure, and there it is stair-stepped pixelated polygons. Unchanged from R5.
- VFX (5): the prop is much improved — soft, radially ramped, no wireframe, no spokes — but it is still an ARC with a visible bright rim line, and it does not encircle the spinner: crop c6/sun_prop.png (5.5x) shows the visible disc sitting up-and-left of the hub with clear sky between the arc and the nose along its whole length. Fix: parent to the spinner transform and kill the rim.
- VFX (5): strong red/magenta chromatic fringing along the nose's lower ink stroke against the sky.
- COLOUR (6): land, sky and aircraft are still in one narrow lemon-yellow band. The violet in the sea away from the sun path is real progress and the right instinct — extend it into the shadow side of the land and into the aircraft's shadowed facings.
- CREDIT — LIGHTING (8): still the best-lit surface in the build. A real warm gold rim along the wing leading edge and canopy frame, a genuine terminator down the fuselage, sharp enough to read rivet stitching. Protect this exactly.
- CREDIT — COMPOSITION (8): sun left, subject upper right, coastline as a leading line, surf and beach as foreground interest. Best-composed frame in the set.

### water — NOT_SHIPPABLE (AAA 4/10)

- VFX (3) AUTOMATIC FAILURE: the chromatic fringing on the water specular is WORSE than R5, not better. Crop c6/wat_sea.png (3x) shows orange and cyan fringes on virtually every sparkle across the sun path, plus scattered rainbow (red/green/blue) speckles in the lower left. This is the rubric's shimmering-edges failure, third round running. Fix: disable CA on the specular pass entirely.
- COMPOSITION (4) AUTOMATIC FAILURE: empty frame. One aircraft, one distant speck, nothing else happening.
- MATERIAL (4): the R5 exposure fix has overshot. The airframe is now desaturated to a narrow grey-mauve band with almost no local contrast — the camouflage is barely distinguishable and the upper-wing roundel is a mottled, speckled dither rather than a decal (crop c6/wat_grid.png, 7.5x). Full-strength aerial perspective is being applied to an object ~30m from camera.
- ENVIRONMENT (5): the dark diagonal scratch marks on the sea with no source event are still there — I count five in c6/wat_sea.png. Unchanged from R5.
- ENVIRONMENT (4): the land is a smooth featureless olive-tan ridge across the whole midline with no vegetation, no beach, no surf, no settlement.
- LIGHTING (5): no warm sun rim on the airframe despite a visible sun disc; no cast shadow on the water.
- CREDIT — MATERIAL: the R5 'whole airframe is clear glass' failure is GONE. At 7.5x the wing cleanly occludes the sky, rivet stitching runs the leading edge, and no far-side geometry reads through the hull.
- CREDIT — ENVIRONMENT (7): whitecap depth scaling still holds — foam shrinks continuously from large patches at the bottom edge to fine speckle at the horizon.

### damage — NOT_SHIPPABLE (AAA 6/10)

- VFX (3): the smoke is one uniform ~45% translucency across the entire trail. Crop c6/dmg_smoke.png (3x) — every puff is a flat grey-lavender wash with the terrain fully readable through it, no core-to-edge density variation anywhere, and only weak age falloff. The puffs are flat cut-paper silhouettes with straight facet edges and angular corners, in a bead chain of similar-sized lobes, in a cool hue with no relationship to the scene's warm low sun.
- VFX (4): a hard, perfectly straight diagonal clipping edge cuts the fire glow across the wing from crop (520,375) to (1250,660) in c6/dmg_fire.png (5x) — the flame volume is intersecting the wing plane and terminating on a razor line. Fix: soft-depth-fade the fire particles against scene depth.
- VFX (4): the flame itself reads as flat orange/yellow gradient blobs and a white-hot capsule painted onto the surface — no tongue, no turbulence, no stepped banding.
- VFX (4): the gun/engine flash at the wing root is a small flat yellow star sprite, same asset as ground_attack and hud.
- LIGHTING (5): no cast shadow on the fields below, in a frame where the aircraft is low enough that it should read.
- MATERIAL (6): the battle damage is flat red decals with hard edges and no charring, no torn metal, no soot.
- CREDIT — LIGHTING (7): THE FIRE NOW EMITS LIGHT. There is a genuine warm orange spill washing the fuselage underside and wing root, and a red glow on the fuselage side. R5 measured a 2-level difference; this is a real, visible fix.
- CREDIT — ENVIRONMENT (6): the best field work in the build — real parcels with hedgerow boundaries and visible crop-direction striping. Still geometric and unnaturally straight-edged, but this is the method the other four frames need.
- CREDIT — COLOUR (7): still the best grade in the build — teal sea and blue sky against orange flame, blacks lifted and tinted.

### hud — NOT_SHIPPABLE (AAA 5/10)

- VFX (3) AUTOMATIC FAILURE: the wing muzzle flashes are flat yellow star sprites on both wings, and the propeller renders as a set of thin concentric elliptical hairlines rather than a disc. Same default sprite flagged in R3, R4 and R5.
- ENVIRONMENT (4) AUTOMATIC FAILURE: hard-edged flat Voronoi field polygons across the bottom third, plus a ruler-straight road running to the horizon at constant width.
- SILHOUETTE (5): the player aircraft is a flat dark brown/navy lump with no lighting differentiation against bright terrain and no visible shadow.
- LIGHTING (5): no value separation on the player aircraft — no rim, no terminator, no AO.
- UI (7) but a residual collision: the '10' pitch-ladder label overlaps the orange lead-marker bracket at the upper right of the reticle.
- CREDIT — UI: THE RETICLE IS FIXED. Crop c6/hud_ret.png (4.2x) shows exactly one white ring-and-cross pipper inside one dashed containment ring, one ticked pitch/roll arc, one dashed lead line to one orange lead marker, and one target bracket. R5's five stacked elements and three candidate aiming points are gone. The player can answer 'where do I aim'.
- CREDIT — COMPOSITION (7): the chase-cam player aircraft has been moved down and left, clear of the reticle stack. Asked for twice, delivered.
- CREDIT — UI: POWERPLANT/AIRFRAME panels, digit tapes, G-meter, compass ribbon and TACTICAL minimap remain the best-executed work in the build.

## Highest leverage

1. SINGLE HIGHEST LEVERAGE — SHIP THE GROUND_ATTACK PROPELLER TO ALL TEN FRAMES AND DELETE THE STAR-SPRITE MUZZLE FLASH. You already built a correct prop: ga_ac.png has a hub-to-tip radial ramp with blade-blur streaks, centred on the spinner, no boundary. Meanwhile clouds.png renders a bare wireframe ellipse floating detached in front of the nose, low.png a hard hoop with a bright rim offset up-right of the spinner, hud.png concentric hairlines, hero.png nothing at all, and sunset.png a rimmed arc that never touches the hub. One implementation exists and nine frames do not use it. Same story for the flat yellow star sprite on the guns — it is the same asset in ground_attack, hud and damage and it has been the rubric's default-additive-sprite automatic failure since round 3.

2. GIVE THE AIRFRAME VALUE SEPARATION FROM THE TERRAIN. This is what the translucency fix exposed. In dogfight.png the wing surface measures (67,85,85) against terrain immediately behind it at (72,88,87) — five levels. The aeroplane is no longer see-through; it is now camouflaged into the ground, which costs the player the same read. Same in low.png, hud.png and ground_attack.png. Fix: a sun-driven rim light on upper surfaces and a darker AO band under the wing and tailplane, so the planform holds against a same-value background.

3. FIX THE HAZE BAND. hero.png, dogfight.png, low.png and water.png all ship a broad, structureless, near-white cream wash that eats the horizon — in hero.png it consumes the entire upper-right quadrant and you cannot tell sky from sea. This was listed in rounds 4 and 5 and has not moved. Narrow it, tint it, and drive its height off sun elevation instead of applying a fixed screen-space wash.

4. DO THE FIELD GENERATION PROPERLY — YOU HAVE ALREADY PROVED YOU CAN. damage.png now has real parcels with hedgerow boundaries and crop-direction striping. dogfight.png, hud.png and hero.png still ship hard-edged flat Voronoi polygons and confetti patches, the identical automatic failure called out in rounds 3, 4 and 5. Port the damage.png method across; it is the largest surface area in five of ten frames.

5. KILL THE CHROMATIC FRINGING ON THE SPECULAR AND THE INK STROKES. Credit where due: it is gone from the horizon trees and gone from the smoke. It got WORSE on water — c6/wat_sea.png shows orange and cyan fringes on nearly every sparkle in the sun path plus rainbow speckles — and it survives on the sunset nose outline and the cockpit canopy sill. Disable CA on the specular pass and clamp it to zero on ink strokes.

6. LIGHT THE COCKPIT AND COLLAPSE ITS GUNSIGHT TO ONE PIPPER. hud.png solved the reticle this round — one pipper, one ring, one lead marker. cockpit.png still stacks SEVEN elements with two offset ring-and-cross pippers. Copy the hud fix into the cockpit file. Then add one sun shaft with a canopy-frame shadow across the panel, texture the three pale-grey slabs at the bottom of the frame (fourth round unchanged), and depth-test the pitch ladder against the canopy sill.

7. MAKE THE SMOKE DIE AND GIVE IT A CORE. Every puff in damage.png and ground_attack.png is the same flat ~45% translucency with the terrain fully readable through it, no core-to-edge density, only weak age falloff, and flat cut-paper silhouettes with straight facet edges. Drive alpha and value off normalised particle age, add a denser core, add per-particle rotation and an eroded alpha, and vary spawn size so the trail stops being a bead chain. While you are in that file, soft-depth-fade the fire particles — there is a razor-straight diagonal clipping edge where the flame volume intersects the wing.

8. RESTORE A GROUND TEXTURE IN low.png. R5 said the tan field's stipple did not perspective-scale. The response appears to have been to delete the texture: the foreground field is now a completely flat untextured green gradient across half the frame, which is a worse automatic failure than the one it replaced. Put the texture back and scale its on-screen frequency with depth. Then retexture the ground_attack apron, where the quad mesh is still visible as a regular diagonal grid across the whole concrete.

9. FINISH THE SHADOW CASTER SET. The player is in it now and it looks good. Parked aircraft on the ground_attack apron still cast nothing on lit concrete, and there is a cyan fringe artifact on the player's shadow where it crosses the runway edge line. Add static scene props to the caster set and clamp the shadow's colour.

10. REPLACE THE TREE ASSET. Fourth round unchanged: faceted low-poly canopy slabs made of floating polygon shards with visible gaps, on perfectly straight untapered cylinder trunks with no branches, no bark, no root flare, one silhouette family for every tree in the build. Four silhouette variants minimum, canopy clumping, a real trunk with taper and a branch fork.

