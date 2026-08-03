# Art director critique — round 4

**Verdict: NOT_SHIPPABLE** · reference captures available: false (no blind A/B performed)

## Status of round-3 items

### [PARTIAL] 1. Light the aircraft — sun-driven terminator, rim light, self-shadowing on the in-world cel material

sunset.png now has a genuine warm sun rim along the wing/fuselage top and reads as lit — that is a real win and it is the one frame that came alive. hero.png and damage.png show a warm top surface and a darker underside. BUT four of ten frames are still unlit: clouds.png the aircraft is a flat near-black silhouette with zero rim under full overhead sun and zero bounce from the enormous white deck below it; ground_attack.png the aircraft is a black lump against a dark treeline; low.png the aircraft is near-black; and water.png is a REGRESSION — the crop at scratchpad/water_ac.png shows the airframe blown out to a single uniform pale cream across upper wing, fuselage, underside and tailplane with no terminator anywhere. In round 3 I called water.png the best-lit aircraft in the set. It is now the worst.

### [NOT_ADDRESSED] 2. Make aircraft cast shadows on the ground

Zero of ten frames show an aircraft shadow. low.png is the proof: the aircraft is roughly 40m over an open field and the crop at scratchpad/low_under.png shows clean unbroken field directly beneath it. Meanwhile the crop at scratchpad/low_tree.png shows a TREE casting a hard, correctly-oriented cast shadow onto the same field. The shadow map is live and fitted; the aircraft is simply not in the caster set or is falling outside the fitted region. That is worse than round 3, when the whole rig was dark — now the rig demonstrably works and the subject is excluded from it. Same story in ground_attack.png, where the aircraft is ~150m over a lit airfield and casts nothing.

### [PARTIAL] 3. Rebuild the propeller disc — radial alpha ramp, hot tip arc, additive blending

The uniform grey oval is gone from some frames but has been replaced by a different defect, not a fix. In water.png, low.png and clouds.png the disc is now a thin hard-edged elliptical RING OUTLINE — a wireframe hoop with a visible geometric boundary, floating detached and offset to the right of the spinner (clearly visible in scratchpad/water_ac.png). In ground_attack.png (scratchpad/ga_ac.png) it is still the old dark translucent oval visibly darkening the terrain behind it. In hero.png there is no disc at all, just a pale nub on the nose. Still wrong in eight of ten frames.

### [FIXED] 4. Fix the terrain overlay corruption in ground_attack.png (scanline quads, glyph garbage)

Genuinely gone. No translucent striped quads, no glyph-atlas garbage, no residual streaking in damage.png or hud.png either. The frame now renders a coherent airfield. This was a real bug and it is closed.

### [PARTIAL] 5. Replace the damage VFX wholesale — smoke and fire

Fire is fixed and it is good: damage.png shows a streaming orange flame with a hot white core, sparks and embers shedding aft along the airflow instead of the static plastic blob. Smoke is NOT fixed. The crop at scratchpad/dmg_smoke.png shows each puff is still a flat two-tone grey lobe wrapped in a UNIFORM HARD DARK OUTLINE of constant weight, and the oldest puffs at the far end of the trail are exactly as opaque and as hard-edged as the newest at the tail — no density falloff, no dissipation, no fade with age. It reads as a chain of grey cauliflower stickers pasted over the landscape. And the fire still throws no light: the wing directly above the flame is the same brown as the wing four metres forward.

### [REGRESSED] 6. Depth-scale the world ink pass and fix vegetation (variants, scale jitter, LOD)

Not fixed, and made worse. Two new automatic failures: (a) the tree billboards along the horizon ridge in low.png and ground_attack.png shimmer into rainbow chromatic confetti — red, cyan and white speckle along the whole treeline, an explicit rubric automatic failure for shimmering edges/mip aliasing; (b) low.png has a single tree instance rendered at roughly 30x scale sitting in the foreground field, canopy ~50m across, a low-poly faceted blob on a flat cream trunk (scratchpad/low_tree.png). Trees are still one or two silhouettes at one scale with no perspective falloff. And the ink pass is still uniform weight — the smoke outlines in damage.png are the same dark constant-width stroke at every distance.

### [FIXED] 7. Build an actual cockpit, or cut the framing

The biggest win of the round. cockpit.png now has a real instrument panel with a full gauge cluster, an artificial horizon, a compass rose, canopy structure with a proper windscreen frame, a gunsight, and floor/pedal structure. It is a cockpit. Remaining issues are art-quality, not existence: the interior and panel are a flat dark blue-grey with no texture, no rivets, no wear and no interior-green; the gauge faces are too small and too low-contrast to read; there is still no canopy glass — no reflection, no scratches, no frame thickness; no sun shaft and no canopy-frame shadow falling on the panel; and two large untextured light-grey slabs sit at the bottom of the frame as raw geometry.

### [PARTIAL] 8. Clean the HUD to the standard its data panels set

Most of it landed. The 'SERVER UNAVAILABLE — FLYING OFFLINE' banner is gone, replaced by a small styled 'OFFLINE SOLO' chip. All the baked debug labels ('IAS 4??', 'MAP0 A 44', '0/2 ... 10') are gone. Digit-tape clipping is fixed — 495 and 1258 render clean. The compass in hud.png is now evenly stepped and correctly labelled (W 28 29 30 31 32 33 34 35 N 01) with the 321 bug aligned. The TACTICAL minimap is redrawn in the game's own flat/ink language. The G-meter now agrees with its readout (1.4 G, needle at ~1.4). AIRFRAME rows are legible with coloured bars and a damage silhouette. NOT fixed: the reticle is still a pile of concentric circles, arcs and tick rings with no findable pipper; target labels still collide — 'Bf 109 G-6 455m' is drawn over the reticle AND 'P-51 Mustang 2.9km' is drawn directly on top of the 495 speed chip; target labels in red over green terrain ('A6M5 Zero 3.7km') and over bright cloud ('Bf 109 G-6 2.2km') are near-illegible; V/S is still a bare cyan bar with no scale; the player aircraft is still dead centre directly behind the reticle cluster; and cockpit.png's compass still has a broken tick sequence (3, 34, 35, N, 01, 02, 3, 04, 05, 06, 07).

### [PARTIAL] 9. Give the framings something to photograph

Real content now in four frames: dogfight.png has a bandit, tracer streaks and a line of flak bursts; ground_attack.png has an actual airfield with a runway, revetments, hangars, a muzzle flash, gun impacts and burning targets; low.png is genuinely low now instead of mid-sky, which was the specific mislabelling I called out; sunset.png has a sun disc, bloom and a sun path. Still empty: clouds.png is one tiny black aircraft on a striped sky with nothing else in frame, and water.png is one aircraft over open sea with a single distant speck. Both still trip the empty-frame clause.

### [PARTIAL] 10. Fix the water and the horizon haze band

Water is much improved: water.png now has a real specular sun glitter path, whitecaps, sky reflection and a continuous depth ramp instead of the hard shallow/deep terminator, and sunset.png has a sun reflection on the sea. But the whitecap speckle is at a uniform on-screen scale from the bottom edge all the way to the horizon, so the sea still flattens into a painted plane. The blown cream haze band is narrower in water.png and damage.png but in hero.png it has become worse — a huge blown white wedge that eats the entire upper-right quadrant and kills the depth cue it should be creating.


## Summary

NO REFERENCE WAS AVAILABLE. refs/ still contains only its README.md — zero reference captures. I did NOT perform the blind A/B the rubric describes and I am not claiming one. All ten frames were captured fresh via `node tools/shoot.mjs --out shots/round4 --warmup 9000` into /Users/paulius/Dev/cel-thunder/shots/round4/, every PNG was opened and looked at, and six regions were cropped and magnified to verify specific claims (crops in the scratchpad: hero_ac, water_ac, low_tree, low_under, ga_ac, cl_cirrus, dmg_smoke). Verdict: NOT_SHIPPABLE. Zero of ten frames pass the rubric's bar that no axis may fall below 7. Two frames — sunset and damage — are now CLOSE, which is genuine progress from a round where nothing was above 5. Of my ten prioritised items, two are fully fixed (the ground_attack terrain corruption bug, and the cockpit, which went from a camera-moved-forward placeholder to a real instrument panel with a gauge cluster, gunsight and canopy structure), one is mostly fixed (the HUD — debug labels gone, server banner replaced by a styled OFFLINE chip, digit tapes unclipped, compass stepped correctly, minimap redrawn in the game's language, G-meter reconciled, AIRFRAME rows legible), five are partial, one is not addressed at all, and one has regressed. The item that has not moved is aircraft cast shadows: still zero of ten, and it is now inexcusable because the shadow rig demonstrably works — a tree in low.png casts a hard correct shadow onto the exact field the aircraft is flying twenty metres above, and the ground beneath the aircraft is clean. The item that regressed is vegetation, which has acquired two new automatic failures: tree billboards shimmering into red/cyan/white chromatic confetti along the horizon in low.png and ground_attack.png, and a single tree instance rendered at roughly 30x scale as a 50-metre blob in low.png's foreground. Beyond the prioritised list, this round introduced three regressions that are individually worse than anything they replaced. First, motion blur or TAA is now destroying the subject: in hero.png and sunset.png the aircraft is the blurriest object in a frame where terrain kilometres away is sharp, with the fin flash smeared into vertical streaks and ghosting on every leading edge. Second, the wing material has gone translucent — in hero.png and water.png you can see terrain, cloud and the aircraft's own internal structure through the wing panels, which reads as a glass toy. Third, water.png's airframe is blown out to a single uniform cream with no value difference between any two facings; in round 3 I called that the best-lit aircraft in the set, and it is now the worst. Fourth, the cirrus has become a mechanically parallel stripe tiling running edge to edge across the entire sky in four frames, and in clouds.png it is the dominant element of the image. What actually improved and should be protected: sunset.png finally has a real sun-driven rim light and is the one thing in this build at shippable quality; the damage fire is now a streaming flame with a hot core, sparks and embers instead of a plastic blob; ground_attack.png has a real airfield target with strafing runs, impacts and burning revetments; low.png is genuinely low instead of mid-sky; and the water has a sun glitter path, whitecaps and sky reflection. The pattern is clear and it is the same one as last round: this is a competent renderer where each fix is landing in isolation while the frame as a whole is not being looked at afterwards. Six engineers shipped six local fixes and nobody opened hero.png and asked why the aeroplane is out of focus and see-through. Until the subject of the photograph is sharp, opaque and casting a shadow, no amount of work on the environment behind it matters.

## Per-shot

### hero — NOT_SHIPPABLE (AAA 4/10)

- MATERIAL (4) — NEW REGRESSION: the wing is translucent. In the crop (scratchpad/hero_ac.png) you can see terrain green and cloud through the port wing panel and through the horizontal stabiliser. This is a depthWrite/alpha bug on the wing material and it makes the aircraft read as a glass toy. Fix: find whatever set transparent/depthWrite:false on the wing surface material and revert it.
- SILHOUETTE (4) — NEW REGRESSION: motion blur / TAA is destroying the subject. The aircraft is the blurriest object in the frame while the terrain 2km below it is sharp. The tail fin's fin-flash smears into vertical white and red streaks, the canopy is a white blob, and there is visible ghosting/double-imaging along every leading edge. Fix: exclude the player aircraft from the velocity buffer, or clamp per-object blur to a fraction of the current magnitude for the capture path.
- VFX (3): there is no propeller disc at all — the nose ends in a small pale nub. Whatever replaced the old grey oval renders nothing from this angle.
- VFX (3): a large soft diagonal light shaft sweeps across the whole upper sky from upper-left to right with no source geometry, no origin and no falloff logic. It reads as a smeared lens artifact, not a godray.
- ENVIRONMENT (5): the fields are confetti — thousands of small hard-edged colour patches in yellow, olive, brown and dark green scattered with no hedgerow logic, no roads feeding them, no relationship to terrain slope. It reads as camouflage-pattern wallpaper, not farmland.
- COLOUR (5): the blown cream haze wedge now consumes the entire upper-right quadrant. It is brighter and larger than in round 3 and it flattens the horizon rather than separating sky from land.
- LIGHTING (5): no cast shadow, and the blur makes it impossible to read whether there is a terminator on the fuselage.

### dogfight — NOT_SHIPPABLE (AAA 5/10)

- VFX (4): the muzzle flash is a flat 4-point yellow star — a default additive sprite, verbatim the rubric's VFX failure. It has no barrel geometry, no smoke, no light spill onto the wing.
- VFX (4): the flak bursts are a string of near-identical dark grey lobes spaced at mechanically even intervals along a perfectly straight line. It reads as a bead necklace, not as shellfire. Vary the burst size, opacity, age and off-axis scatter.
- VFX (4): the tracers are thin white scratch lines with no hot core, no length taper and no glow — they read as scratches on the lens.
- ENVIRONMENT (4): the fields are hard-edged flat Voronoi polygons in untextured colour — the rubric's first automatic failure. No crop direction, no within-field variation, no wear at boundaries.
- ENVIRONMENT (4): three perfectly straight parallel lines run across the terrain on the right side of the frame at constant width from foreground to horizon. Whatever generates roads is producing rulered parallels, not routes that respond to terrain.
- LIGHTING (5): the player aircraft is a dark near-uniform brown; the fuselage cylinder shows no gradient around its circumference. No cast shadow on the terrain below despite low altitude.
- COMPOSITION (6): the dutch angle is extreme enough that the horizon runs corner to corner, which is a choice, but the bandit, the flak line and the tracers are all crammed into the upper-left quadrant leaving the whole right half doing nothing.

### low — NOT_SHIPPABLE (AAA 3/10)

- ENVIRONMENT (2) — HARD BUG: a single tree instance is rendered at roughly 30x correct scale in the foreground field, canopy about 50m across, as a low-poly faceted dark-green blob on a flat cream trunk with a hard cast shadow (scratchpad/low_tree.png). It dominates the lower-right quadrant and instantly reads as a broken LOD or a bad instance-matrix scale.
- ENVIRONMENT (2) — AUTOMATIC FAILURE: the tree billboards along the entire left and centre horizon ridge shimmer into rainbow chromatic confetti — red, cyan and white speckle. This is mip/alpha aliasing on the vegetation cards and it is the rubric's explicit shimmering-edges failure.
- LIGHTING (3): no aircraft shadow. The crop directly beneath the aircraft (scratchpad/low_under.png) shows unbroken field. At this altitude the shadow is the single strongest depth cue a player reads, and a tree twenty metres away casts one perfectly.
- MATERIAL (3): the foreground brown field occupies 40% of the frame and is a flat tan with a repeating dash-stroke stipple applied at ONE uniform on-screen frequency from the bottom edge to the mid-ground. Zero perspective scaling. Rubric automatic failure for flat untextured surface plus a visible tiling tell.
- SILHOUETTE (4): the aircraft is near-black against a mid-value field, with no rim and no internal value. It reads as a dark cutout.
- VFX (3): the prop is a hard-edged elliptical ring outline plus a pale vertical flare streak running down onto the field below it.
- ENVIRONMENT (2): trees at the horizon are still the same on-screen size as trees in the mid-ground. No perspective scale falloff, unchanged from round 3.

### cockpit — NOT_SHIPPABLE (AAA 5/10)

- LIGHTING (3): no light enters the cockpit. No sun shaft across the panel, no shadow of the canopy framing falling on the coaming or the instruments, no bounce off the panel. The interior is lit by a single flat ambient.
- MATERIAL (5): the panel, coaming and canopy framing are a flat dark blue-grey with no texture, no rivets, no fastener rings, no wear on the switch surrounds, no interior green or black. Rubric automatic failure for flat unshaded colour, now at a smaller scale than round 3 but still present.
- MATERIAL (5): there is still no canopy glass. No reflection, no scratches, no frame thickness, no distortion at the curved sections — you look through open air between the tubing.
- MATERIAL (5): two large light-grey angular slabs at the bottom centre of the frame are untextured raw geometry with visible flat facets.
- UI (6): the gauge faces are too small and too low in contrast to read. Several are yellow-white blobs with no discernible markings — they read as generic clock faces rather than as an ASI, altimeter, boost gauge and RPM.
- UI (6): the compass ribbon tick sequence is broken — it reads 3, 34, 35, N, 01, 02, 3, 04, 05, 06, 07. Two entries are single-digit '3' where they should be '33' and '03'. The hud.png compass is correct, so this is a second code path.
- UI (6): the 'Bf 109 G-6 405m' target label is drawn directly on top of the gunsight reticle geometry, exactly as in round 3.
- COMPOSITION (6): the two orange target chevrons at the extreme right edge float unlabelled and unanchored with nothing else on that side of the frame.

### clouds — NOT_SHIPPABLE (AAA 3/10)

- ENVIRONMENT (3) — AUTOMATIC FAILURE: the cirrus is a mechanically parallel stripe tiling across the ENTIRE sky. The crop (scratchpad/cl_cirrus.png) shows perfectly straight, evenly spaced bands at one identical angle running edge to edge, dozens of repeats of the same wave form. This is directional noise tiled, not cirrus, and it is the rubric's visible-tiling automatic failure. It is the dominant element of the frame.
- LIGHTING (3): the aircraft is a flat near-black silhouette under full overhead sun. No rim, no terminator, and critically no bounce from the enormous white cloud deck directly below it, which should be throwing heavy fill onto the belly.
- COMPOSITION (4): empty frame. One tiny aircraft, no wingman, no contrail, no sun disc, no target, nothing else in 2 megapixels.
- ENVIRONMENT (3): the cloud deck's upper boundary on the right side is a straight hard diagonal cut across the frame — a geometry edge, not a cloud edge.
- SILHOUETTE (4): at this scale and value the aircraft could be a bird. No planform reads, no glint.
- VFX (3): the prop is a small hard-edged white ring detached ahead of the spinner.

### ground_attack — NOT_SHIPPABLE (AAA 4/10)

- LIGHTING (3): still no aircraft shadow on the ground, in the one framing where it matters most — a low strafing pass over a lit airfield. Round 3's number one complaint about this frame, unchanged.
- LIGHTING (3): the aircraft is a black lump silhouetted against a dark treeline. It has almost no value separation from the background it sits on, and no rim to lift it off.
- ENVIRONMENT (4) — AUTOMATIC FAILURE: the same rainbow chromatic shimmer on tree billboards along the entire left horizon — red, cyan and white confetti speckle.
- ENVIRONMENT (4): the runway apron and taxiways are flat light grey with the triangle mesh visible as diagonal shading facets across the concrete, plus aliased dark speckle garbage on the taxiway edges. Flat untextured surface with visible triangulation.
- VFX (5): the muzzle flash is a flat yellow star sprite and the gun impacts are blown white blobs with a soft additive glow — both are default-sprite look. The prop disc is still the old dark translucent oval visibly darkening the grass behind it (scratchpad/ga_ac.png).
- COLOUR (4): the entire frame is one muddy dark olive wash with heavy corner vignette. No dominant/accent relationship, blacks unlifted and untinted, mid-tones mush.
- COMPOSITION (6): the runway is a genuinely good leading line — the strongest compositional idea in the set. Undermined by the subject being small, dark and sitting on top of the dark treeline.

### sunset — CLOSE (AAA 6/10)

- ENVIRONMENT (4) — AUTOMATIC FAILURE: the same mechanically parallel cirrus stripe tiling covers the whole upper sky — identical herringbone form repeated in evenly spaced diagonal rows edge to edge.
- COLOUR (5): the entire frame is one lemon-yellow. Land, sea, sky, aircraft and cloud all sit in the same narrow hue band. There is no accent, no complementary, no colour in the shadows — a monochrome wash rather than a graded palette. A cool blue in the shadow side of the land and in the sea away from the sun path would rescue this instantly.
- MATERIAL (5): the aircraft is soft and mushy — the same motion-blur/DOF smearing as hero.png. Panel lines and markings dissolve; the wing surface has no readable detail.
- ENVIRONMENT (4): the mid-ground land is a featureless yellow smear with no fields, no vegetation, no roads. Only the extreme bottom-left corner has any structure, and there it is pixelated stair-stepped polygons.
- VFX (5): two hard hexagonal lens-flare ghosts sit to the right of the aircraft plus a white streak. They read as artifacts rather than as an art-directed flare.
- LIGHTING (7): genuinely fixed — a real warm sun rim along the wing and fuselage top. This is the one thing in the build that improved to shippable quality.
- COMPOSITION (7): subject upper right, sun left, coastline as a leading line. The best-composed frame in the set.

### water — NOT_SHIPPABLE (AAA 3/10)

- LIGHTING (2) — REGRESSION: the aircraft is blown out to a single uniform pale cream across every facing — upper wing, fuselage side, underside, tailplane all read at the same value (scratchpad/water_ac.png). Zero terminator, zero form. In round 3 this was the best-lit aircraft in the set. Something in the exposure/tonemap or the cel band offset is clipping the whole airframe to white.
- MATERIAL (2) — REGRESSION: the wings are translucent. You can see the fuselage, the wing-root structure and the tailplane THROUGH the port wing. Same alpha/depthWrite bug as hero.png. The aircraft reads as a soap model.
- VFX (3): the prop is a thin hard-edged elliptical ring outline, clearly geometric, floating detached and offset to the right of the spinner rather than centred on it.
- COMPOSITION (4): empty frame. One aircraft, one distant speck, nothing else happening.
- ENVIRONMENT (5): the water is genuinely improved — sun glitter path, whitecaps, sky reflection, continuous depth ramp. But the whitecap speckle is the same on-screen size at the bottom edge as at the horizon, so the sea still flattens into a painted plane. And there are several thin dark diagonal scratch marks on the water in the lower left with no source event.
- ENVIRONMENT (5): the land is a smooth featureless olive-tan ridge with no vegetation, no beach, no surf, no settlement — a flat untextured mass occupying the whole midline.
- LIGHTING (2): no cast shadow on the water.

### damage — CLOSE (AAA 5/10)

- VFX (5): the smoke is still the round 3 failure. Flat two-tone grey lobes each wrapped in a uniform hard dark outline at constant weight, no density falloff, no dissipation, and the oldest puffs at the far end of the trail are exactly as opaque as the newest (scratchpad/dmg_smoke.png). It reads as grey cauliflower stickers pasted over the landscape. The constant-weight ink on them is itself a rubric automatic failure.
- LIGHTING (5): a burning aircraft still throws no light. The wing directly above the flame is the identical brown as the wing four metres forward. No warm spill on the skin, none on the terrain below, none on the smoke itself.
- LIGHTING (5): no cast shadow on the ground.
- ENVIRONMENT (5): the fields below are flat hard-edged colour polygons with black tree specks and no texture — unchanged automatic failure.
- VFX (5): the fire is genuinely good now — streaming flame with a hot white core, sparks and embers shedding aft. Credit where due; this is the fix from item 5 that landed.
- MATERIAL (6): the best airframe in the set — panel lines, roundel, codes, camo demarcation, fin flash and prop blade all read correctly.

### hud — NOT_SHIPPABLE (AAA 5/10)

- UI (6): label collisions. 'P-51 Mustang 2.9km' is drawn directly on top of the 495 speed chip, obliterating both. 'Bf 109 G-6 455m' is drawn on top of the reticle geometry. This is the same class of defect I flagged in round 3 and it now affects the primary airspeed readout.
- UI (6): target label contrast is still not adapting. 'A6M5 Zero 3.7km' is dull red over green terrain and 'Bf 109 G-6 2.2km' is dull red over bright cloud — both are near-invisible.
- UI (6): the reticle is still a pile of overlapping concentric circles, arcs, brackets and tick rings with no hierarchy. You cannot locate the pipper at a glance.
- UI (6): V/S is still a bare cyan bar with a number and no scale, no zero marker, no units.
- COMPOSITION (4): the player aircraft is still dead centre and directly behind the reticle cluster, so airframe and instrument merge into noise. In a chase-cam HUD frame the aircraft belongs low and clear.
- LIGHTING (4): the player aircraft is a flat dark brown lump with no lighting differentiation against a bright terrain it does not belong to. No shadow.
- ENVIRONMENT (4): flat hard-edged polygon fields, black tree specks, and one ruler-straight road running to the horizon.
- UI (6): the compass, minimap, G-meter, digit tapes, AIRFRAME panel and ladder contours are all genuinely fixed. The data panels remain the best work in the build.


## Highest-leverage changes

1. SINGLE HIGHEST LEVERAGE — Get the motion blur / TAA off the player aircraft and fix the translucent wing material. This is a NEW regression and it is worse than what it replaced. In hero.png and sunset.png the aircraft is the blurriest object in a frame where terrain 2km away is razor sharp: the fin flash smears into vertical streaks, the canopy becomes a white blob, and every leading edge ghosts. Separately, in hero.png and water.png the wing surfaces are transparent — terrain, cloud and the aircraft's own internal structure show through the wing panels (see scratchpad/hero_ac.png and scratchpad/water_ac.png). Two fixes: exclude the player aircraft from the velocity buffer (or clamp per-object blur hard) for the capture path, and find whatever set transparent/depthWrite:false on the wing surface material and revert it. Right now the subject of eight frames is physically unreadable, which invalidates every other art fix underneath it.

2. Put the aircraft in the shadow caster set. Still zero of ten frames with an aircraft shadow — but the rig now demonstrably works, because a tree in low.png casts a hard, correctly-oriented shadow onto the same field the aircraft is flying twenty metres above (scratchpad/low_tree.png vs scratchpad/low_under.png). This is no longer a broken shadow system, it is an omitted caster or a fit that excludes the subject. Verify castShadow on the aircraft hull meshes and that the fitted sphere in ShadowRig actually contains the player.

3. Fix the exposure clipping on the aircraft. water.png's airframe is blown to a single uniform cream with no value difference between upper wing, fuselage side, underside and tailplane — a straight regression from round 3, where this was the best-lit aircraft in the set. Whatever changed in the tonemap or the cel band offset is clipping the whole hull to white against a bright sea. Clamp the top band so the lit surface never reaches full white, and keep at least three distinguishable values across the airframe at any exposure.

4. Replace the cirrus. It is now a mechanically parallel stripe tiling — perfectly straight, evenly spaced bands at one identical angle running edge to edge across the entire sky in clouds.png, sunset.png, water.png and dogfight.png (scratchpad/cl_cirrus.png). In clouds.png it is the dominant element of the frame. This is the rubric's visible-tiling automatic failure and it is a new defect this round. Break the directional noise with a second rotated octave, vary the band spacing and opacity across the dome, and curve the streaks toward the horizon.

5. Fix the vegetation, both new bugs. (a) Tree billboards along the horizon in low.png and ground_attack.png shimmer into rainbow chromatic confetti — red, cyan and white speckle across the whole ridge. That is mip/alpha aliasing on the cards and it is an explicit automatic failure. (b) low.png has one tree instance rendered at roughly 30x scale in the foreground, canopy ~50m across. Check the instance matrix scale and the LOD switch. Then do the round 3 work that was never done: at least four silhouette variants, real scale jitter, canopy clumping, and perspective-correct on-screen size falloff — horizon trees are still the same size as mid-ground trees.

6. Finish the smoke. Fire landed and is good; smoke is untouched. Each puff is a flat two-tone grey lobe with a uniform hard dark outline at constant weight, and the oldest puff in the trail is as opaque and as hard-edged as the newest. Kill the constant-weight ink on the particles (or modulate it by density and age), add an alpha and value falloff over lifetime so the trail dissolves, add per-particle rotation and silhouette break-up, and stop the puffs reading as a bead chain by varying their spawn size.

7. Rebuild the propeller disc properly this time. It went from a grey oval to a hard-edged elliptical wireframe ring — in water.png and low.png it is a geometric hoop, visibly detached and offset from the spinner; in ground_attack.png it is still the old dark oval darkening the terrain behind it; in hero.png it renders nothing at all. It needs a radial alpha ramp — near-zero at the hub, a bright hot arc near the tip — with additive blending and no visible boundary geometry, and it needs to be centred on the spinner.

8. Fix HUD label placement. The instruments are now good enough that the layout failures stand out. 'P-51 Mustang 2.9km' is drawn on top of the 495 airspeed chip, destroying the primary readout; 'Bf 109 G-6 455m' is drawn on the reticle in both hud.png and cockpit.png. Add collision avoidance that pushes target labels off protected regions (the chips, the reticle, the compass), give labels a dark contour or plate so red-on-green and red-on-cloud stay legible, and move the chase-cam player aircraft low and clear of the reticle cluster. Also fix cockpit.png's compass tick sequence — it reads 3, 34, 35, N, 01, 02, 3, 04 while hud.png's is correct, so there are two code paths.

9. Depth-scale the terrain surface textures. The foreground field in low.png applies its dash-stroke stipple at exactly the same on-screen frequency at the bottom edge as at the mid-ground, and water.png's whitecaps are the same size at the near shore as at the horizon. Both flatten the world into a painted plane. Drive the detail UV scale by view distance, or blend two octaves by depth.

10. Grade each frame individually. sunset.png is one lemon yellow across land, sea, sky and aircraft with no accent and no colour in the shadows; ground_attack.png is one muddy dark olive with unlifted untinted blacks; hero.png's blown cream haze wedge has grown to consume the upper-right quadrant. Each of these needs a chosen dominant plus a real complementary accent, lifted and tinted blacks, and a haze band that is narrow, tinted and varies with sun angle rather than a blown white wash.

