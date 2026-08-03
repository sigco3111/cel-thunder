# Reviewer defects — waves 1 & 2

Produced by adversarial reviewers that read the actual code, not the implementers' reports.
The next fix wave consumes this file.


---

## audio — **NOT_SHIPPABLE**

`npx tsc --noEmit` exits 0 across the whole repo — the report's claim of "pre-existing errors in CameraSystem/ui/vfx" is stale; nothing is broken now. The craft level inside the modules is genuinely high: the additive engine model, the sustained-body + round-robin gun structure, Schroeder-phase periodic waves, seamless noise loop construction, distance-delayed explosion arrival and the two-stage glue/brickwall bus are all real sound-design thinking, not web-audio boilerplate. There are no TODOs, no stubs, no placeholder beeps. But the subsystem was written against a *guessed* wire protocol while the actual emitters sit in the same repo, and that guess is wrong in three places at once. In the default offline sandbox — the mode anyone launching this will actually get, because NetSystem falls back to it when no server answers — the player's own rounds are never filtered out of near-miss detection (`ctx.localPlayerId` stays 0 offline while the projectile's `ownerId` is 1), so holding the trigger on four Brownings fires up to 76 supersonic whip-cracks per second at priority 0.9, saturating the voice pool with the very sound that is supposed to be rare and frightening. Every bullet striking terrain emits `GroundImpact`, which is routed straight into the full `explosion()` synth with a pitch-collapsing sub and a debris rattle and no rate limiting, so a strafing pass is dozens of overlapping sub-bass blasts. And because the gunfire event's `b` is a gun *index* (not a trigger group) and `scale` is `calibre/20` (not millimetres), the Spitfire's 20 mm Hispanos play the .303 Browning voice and every single impact in the game falls back to a hardcoded 12.7 mm — the calibre-derived acoustics that the file header calls its central idea are unreachable in practice. On top of that the gun's mechanical-action layer never stops after the trigger is released, three of the four volume sliders in the settings menu are wired to nothing, and `wantHrtf(graph, 0)` quietly defeats the distance-based panner heuristic the code documents at length. None of these are architectural failures — they are all small, local fixes — but as it stands the primary gameplay loop sounds broken, and that is a long way from "a stranger cannot tell this from a shipped AAA title".

### Blockers

**src/audio/AudioSystem.ts**

Near-miss detection fails to exclude the player's own rounds in the offline sandbox — the default run mode. Line 673 filters with `e.ownerId !== 0 && e.ownerId === ctx.localPlayerId`, but OfflineSandbox.ts:153 sets the player aircraft's `ownerId = this.ctx.localPlayerId || 1` (i.e. 1) while `ctx.localPlayerId` is never assigned offline and stays 0 (Game.ts:32; it is only set from the Welcome message in NetSystem.ts:154). Every round leaves the muzzle at ~3 m and is receding by the next frame, so `d > prev && prev < 32` is true for literally every bullet: nearMiss() at priority 0.9 fires up to 76 times per second for four Brownings, each allocating a fresh HRTF SpatialSource plus two noise-burst subgraphs, and the pool (cap 48) is stolen out from under the actual gunfire.

_Fix:_ Do not identify your own rounds by player id. Either compare against the shooter entity — resolve `ctx.entities.get(ctx.localEntityId)?.ownerId` and match that against `e.ownerId` — or, more robustly, skip any projectile whose closest approach is inside the local aircraft's own bounding radius (say `prev < 6` while the local entity is within a few metres). Also add a per-frame cap of one or two near-miss cracks; even correct detection can deliver a dozen in a single burst.

**src/audio/AudioSystem.ts**

Per-bullet terrain hits are routed into the full explosion synthesiser. `EventKind.GroundImpact` / `WaterImpact` (AudioSystem.ts:740-746) are emitted once per projectile striking terrain (Room.ts:469, OfflineSandbox.ts:392), not once per bomb. Each one calls `explosion(...)` which builds two swept sine/triangle overpressure layers, two noise-burst fireball layers, a crack and a debrisRattle behind a new HRTF SpatialSource, with tails of 0.9-1.5 s. A ground-attack pass at 76 rounds/second produces dozens of overlapping pitch-collapsing sub blasts and consumes the entire voice budget at priority up to 0.98, which outranks the gunfire itself.

_Fix:_ Branch on magnitude: `ev.scale` for these events is `calibre/20`, so anything under ~1.0 is a bullet strike and should use a small dirt/water impact one-shot (a short filtered noise burst plus a tiny modal ring), not `explosion()`. Additionally coalesce: keep a per-frame counter and a minimum inter-event spacing (~60-80 ms) for small ground impacts, spawning one thickened impact for the cluster rather than one per round.

**src/audio/AudioSystem.ts**

The gunfire event is decoded wrongly on both fields, so the calibre-derived gun model is never exercised. Both emitters send `scale = gun.calibre / 20` and `b = gi`, the *index* into `spec.guns` (Room.ts:435, OfflineSandbox.ts:343-344). `resolveGun` (line 539-551) tests `calibreHint >= 5 && calibreHint <= 60`, which 0.385-1.5 never satisfies, then does `const wanted = group === 2 ? 2 : 1`. For the Spitfire, guns[0] is the 20 mm Hispano (group 2) and guns[1] the 7.7 mm Browning (group 1): firing the cannons sends gi=0, which maps to `wanted = 1`, which selects the Browning. Firing the MGs sends gi=1, which also maps to `wanted = 1`. Both trigger groups therefore produce the identical .303 sound and the Hispano acoustics are unreachable. Because the emitter key is `${shooter}:${gun.calibre}`, they also collapse into a single emitter.

_Fix:_ Multiply the hint back out — `const calibre = ev.scale * 20` — and select by nearest calibre, and treat `ev.b` as an index into `spec.guns` (`spec.guns[ev.b] ?? spec.guns[0]`) rather than as a trigger group. Both interpretations are verifiable from `server/Room.ts` and `src/game/OfflineSandbox.ts`, which are in this repo; do not ship a guess in the report when the emitter is readable.

**src/audio/Weapons.ts**

The gun's mechanical-action layer never stops. `buildLoop` sets `pGlide(this.actionGain.gain, 0.16, start, 0.02)` at line 360 and nothing ever brings it back down. Its AM oscillator (`actionOsc`, line 329-331) runs continuously at the cyclic rate, so once a gun has fired a single round the breech clatter runs at constant level until the emitter expires — `expired` requires `now - lastSeen > 1.5`, so roughly 1.5 s of phantom mechanical rattle after every burst, and it never stops at all during typical burst-gap-burst fire. `update` (line 271-273) only fades `loopGain`.

_Fix:_ In `update`, when `t >= this.activeUntil`, glide `actionGain` to 0 alongside `loopGain`, and glide it back to 0.16 in `trigger()`. Give it a slightly longer release than the body (~0.06 s) so the action trails the report the way a real breech does.

### Majors

**src/audio/AudioSystem.ts**

The hit marker never fires. Line 731 tests `ev.b !== 0 && ev.b === ctx.localPlayerId`, but for HitSpark both emitters set `b` to the shooter's *entity* id (`p.shooter = a.entityId` in OfflineSandbox.ts:304, `pe.shooter = s.id` in Room.ts:430). Entity ids and player ids are independent counters, so the comparison is true only by coincidence. The code's own comment calls the hit marker 'the single most important piece of feedback in the game' and then wires it to the wrong identifier.

_Fix:_ Compare against `ctx.localEntityId` (`ev.b === ctx.localEntityId && ctx.localEntityId !== 0`). Note CameraSystem.ts:983 makes the same mistake for its killcam, so a shared helper that resolves 'was this me' from both id spaces would be worth exporting.

**src/audio/AudioSystem.ts**

Three of the ten handled EventKind values are never emitted by anything in the repo, so the sounds behind them are dead code, and the report claims all ten are consumed without noting it. `EventKind.HitArmour` is never pushed (both emitters only send HitSpark, OfflineSandbox.ts:433 even has a vestigial `p.he > 0 ? EventKind.HitSpark : EventKind.HitSpark`), so every armour variant in `impactOwn`/`impactRemote`/`hitMarker` is unreachable. `EventKind.Kill` is never pushed, so `Ui.killConfirm` (the two-note fifth, one of the most audible pieces of feedback in the mix) never plays from gameplay. `EventKind.Critical` is never pushed, so the high-urgency annunciator only fires from the local damage-bit edge detector.

_Fix:_ Drive the armour variant from the round's ability to penetrate (calibre plus `spec.damage.armour`) rather than waiting for a HitArmour event that no server sends; fire killConfirm from the existing `net:kill` bus message by comparing the killer name/id rather than from EventKind.Kill; and list the three dead event kinds in the report as an integration request rather than claiming full coverage.

**src/audio/AudioSystem.ts**

Three of the four audio sliders in the settings menu do nothing. `src/ui/store.ts:249` emits `audio:volumes` with `{ master, effects, engine, ui }` and SettingsPanel.ts:190-197 builds sliders for all of them, but `init` (lines 155-163) subscribes to `quality`, `game:event` and the `net:*` messages only. Master works solely because `update` polls `ctx.settings.masterVolume`. The hooks that would service the rest already exist and are dead: `Music.setLevel` (Music.ts:260), `Radio.setLevel` (Radio.ts:149) and `SpatialSource.setSend` (SpatialSource.ts:147) have zero callers anywhere in the repo. Brief rule 5 requires respecting `ctx.settings`.

_Fix:_ Subscribe to `audio:volumes` and map it onto the bus trims: `effects` scales `bus.weapon` + `bus.env` + `bus.cockpit`, `engine` scales `bus.engine`, `ui` scales `bus.ui` + `bus.voice`. Add an `AudioGraph.setBusTrim(name, v)` that multiplies the static design trim rather than overwriting it, so the mix balance in the `bus` literal survives.

**src/audio/EngineVoice.ts**

The distance-based panner heuristic is documented at length and then defeated at the call site. `wantHrtf(graph, 0)` at EngineVoice.ts:219 and Weapons.ts:232 always passes distance 0, which is <= hrtfDistance on every tier above `low`, so all 10 engine voices and all 7 gun emitters allocate HRTF panners regardless of range. SpatialSource.ts:204 documents HRTF as 'roughly four times an equal-power pan… spent on what the player is looking at and denied to the rest'; the code denies it to nobody. Each HRTF panner is an FFT convolution on the audio thread, and the brief's target is 60 fps on integrated graphics.

_Fix:_ Pass the real spawn distance (`Math.hypot(x - l.px, ...)`) into `wantHrtf` for both, and reserve HRTF for the local aircraft plus the two or three nearest contacts. The panner model cannot be changed after construction, so also drop the model back to equalpower by rebuilding (or simply constructing with equalpower) any voice created outside the near band.

**src/audio/Airflow.ts**

The airflow bed has no distance attenuation and no spatialisation at all — it connects straight to `graph.bus.cockpit` (line 99) and is driven purely from the local aircraft's IAS (AudioSystem.ts:604-615). In flyby, orbit, killcam or scripted camera modes (CameraSystem.ts:303-309) the camera can be 50-200 m away from the aircraft and you still get the full-level cockpit wind roar, slipstream rush and stall buffet. The report's own calibration table shows airflow at 0.025 in both cockpit and chase, which is the measurement confirming this.

_Fix:_ Scale `AIRFLOW_LEVEL` by a distance term derived from `listener.distance` to the local aircraft (unity inside ~4 m, rolling off to near zero past ~40 m) so external cameras hear the airframe from outside, and consider routing the exterior path through a SpatialSource on `bus.env` rather than the non-occluded cockpit bus.

**src/audio/Music.ts**

The pad filter steps hard at every chord boundary — the opposite of the 'slow swell, not a wobble' the comment claims. `chord()` schedules `pSet(padFilter.frequency, 620, when)` then ramps to 1450 at `when + 3.52` and back to 700 at `when + 8.7` (lines 220-222), but the next chord lands at `when + 6.4` and inserts another `setValueAtTime(620)` in the middle of the pending ramp. The interpolated value at that instant is ~1030 Hz, so the cutoff jumps 1030 -> 620 Hz instantaneously every 6.4 seconds, for the whole time the menu is open.

_Fix:_ Make the swell shorter than the chord period (peak at 0.4x and return to 620 by `when + CHORD_SECONDS` exactly), or move the breathing filter onto a dedicated per-chord BiquadFilterNode inside the chord's own node group so consecutive chords cannot fight over one shared param.

**src/audio/AudioSystem.ts**

Cockpit occlusion is inferred from a 2.8 m proximity sphere (`resolveInterior`, lines 422-427) and the report asks the integrator to call `setCockpit()` 'when CameraSystem lands'. CameraSystem already exists and already emits `camera:mode` with `cockpit`/`gunsight`/`chase`/`orbit`/`flyby`/`killcam`/`scripted` (CameraSystem.ts:242, 260, 276). No integration change is needed. The heuristic also misfires: any camera that passes within 2.8 m of your own hull — an orbit zoom-in, a spawn snap, killcam — flips the whole world mix into canopy occlusion.

_Fix:_ Subscribe to `camera:mode` in `init` and map `cockpit`/`gunsight` to interior, everything else to exterior, keeping the proximity test only as a fallback before the first event. Remove the integration request from the report.

### Missing from brief

- Brief rule 5 ("Respect ctx.quality and ctx.settings"): ctx.quality is handled properly via the `quality` bus event and the four QualityProfile tiers, but the settings side is half-done — only `masterVolume` is read, and the `audio:volumes` bus event carrying the effects/engine/ui slider values (src/ui/store.ts:249, sliders built in SettingsPanel.ts:190) is never subscribed to. Three of the four sliders in the shipped settings UI are inert.
- Brief rule 5 ("Performance is a correctness requirement… pool allocations, never allocate inside a hot loop"): the per-frame path allocates an EngineInput object literal per engine, an AirflowInput literal per frame, and a two-element entry array per gun and per engine from `for…of` over Maps. Also ~22 unconditional setTargetAtTime calls per engine per frame with no change detection, and `wantHrtf(graph, 0)` forcing an HRTF convolution panner onto every engine and gun emitter at every distance despite the code carrying an explicit distance heuristic for exactly this reason.
- Brief rule 1 ("If you need a change [in files you may not touch], say so in your report instead of making it"): the report asks the integrator to add a `setCockpit()` call in CameraSystem, but CameraSystem already broadcasts `camera:mode` on the bus with cockpit/gunsight/chase/orbit/flyby/killcam. No integration change is needed — the subsystem simply did not subscribe. Conversely the report presents the gunfire/hit `a`/`b`/`scale` semantics as "interpretations that the server may want to confirm" when both emitters (server/Room.ts and src/game/OfflineSandbox.ts) are readable in this repo and contradict the interpretation used.
- No ordnance, ground-vehicle or flak audio (self-reported gap 6), and no reaction to sky/weather state despite `sky:weather`, `sky:inCloud` and `sky:lightning` already being on the bus — flying through a cloud or a storm is acoustically identical to clear air. For a subsystem judged against War Thunder framing, thunder and cloud-muffling are cheap and conspicuous by their absence.
- The report's verification claim ("drove it in headless Chromium with a synthetic GameContext: full event sweep… zero page errors") was carried out against a synthetic context rather than the real emitters, which is precisely why every one of the protocol-decoding defects above survived it. A synthetic sweep that fabricates its own event payloads cannot catch a misread payload.


---

## vfx — **NOT_SHIPPABLE**

The craft level here is genuinely high — this is not stub work. The closed-form GPU trajectory solve in ParticleEngine.ts is correct and elegant, the procedurally-baked SDF sprite atlas and piecewise-constant ramp atlas are exactly the right way to get hard cel banding, the erosion-threshold dissolve (eating coverage instead of fading alpha) is the right call for the art direction, and the soft-depth path correctly raises the erosion threshold rather than going translucent. The ramps are baked to linear and the composer's sceneRT is HalfFloat linear, so colour management is right. No TODOs, no placeholder art, no MeshStandardMaterial, no 0x00ff00.

But it was never checked against the codebase it plugs into, and three of the failures are visible in every single engagement.

(1) DUPLICATE DAMAGE PLUMES. `src/game/EntitySystem.ts:267` calls `view.updateDamage(...)` every frame, which runs `AircraftView.updateDamage` (src/game/AircraftView.ts:364) and emits the legacy CPU billboard `BillboardField` smoke/fire for exactly the same bits — Engine / OilLeak / FuelLeak / EngineFire / Destroyed — that `DamageFx.updateDamageFx` now also reacts to via the `ctx.entities` sweep. Both run simultaneously. A burning aircraft trails two independent plumes in two different art styles: the new cel-banded, ink-outlined, erosion-dissolved one, and the old soft `smokeSprite` billboards. `src/game/visual/Particles.ts` even documents the boundary it expects ("This is deliberately not a general-purpose VFX system — VfxSystem owns explosions and hit sparks"), and DamageFx walks straight through it. Nothing in the new code detects, disables, or defers to it.

(2) TRAIL SLOTS ARE REUSED WITHOUT CLEARING. `TrailPool.release()` (TrailSystem.ts:319) sets `active = false` but leaves the slot's vertex data live; `acquire()` (:287) grabs the first inactive slot and sets `s.count = 0` without collapsing it. The "guard quad" written at index `s.count` only zeroes width on *one* side of one quad — point slots 2..maxPoints-1 still hold the previous tenant's positions and birth times and keep rendering until they expire naturally. `Gunfire.ts:270-287` acquires and releases a `trailsBill` slot for every ricochet streak, so the pool is churned constantly; a contrail (life 16–38 s) that lands on a just-released ricochet slot draws a stray sliver from the aircraft to the old impact point, and a ricochet that lands on a released contrail slot draws a kilometre-long white ribbon across the sky for 0.42 s. One-line fix: `collapse(i)` inside `acquire`.

(3) uResolution IS THE WRONG BUFFER. `VfxSystem.lateUpdate` (:508) sets `uResolution` from `renderer.getDrawingBufferSize()`, but `RenderSystem.computeRenderSize` (src/render/RenderSystem.ts:208) sizes every composer target — including `prepass`, whose depth texture the VFX binds — to `bufferSize × clamp(settings.renderScale, 0.5, 1)`. The "low" quality preset sets `renderScale = 0.75` (src/ui/menu/SettingsPanel.ts:149). So `gl_FragCoord.xy / uResolution` samples the depth buffer at 0.75× the correct UV: soft-depth fading dissolves particles against geometry from the wrong part of the screen, and the debris inverted-hull outline width is off by 1/renderScale. Broken on precisely the integrated-graphics preset the brief targets. `VfxSystem.resize(w,h)` compounds it — Game passes CSS pixels there (Game.ts:315-317), which RenderSystem explicitly discards and VFX does not.

Beyond those: the camera-shake accumulator is a second, uncoordinated shake system layered on CameraSystem's existing `CameraShake` (which already takes impulses from HitArmour/Kill/Gunfire at CameraSystem.ts:1019-1035) and `ownCameraShake` defaults to true, so both fire and beat against each other; the `'weather'` bus contract was invented — the real producer emits `WeatherDirective {coverage, cloudBase, cloudDepth, haze, turbidity, windSpeed}` (framings.ts:31-43), which has none of `rain`/`humidity`/`windX`, so ~100 lines of canopy-rain shader can never turn on; the entire free-function API is called by nothing, so `attachDamageEffects` is never invoked and every `exhaustPorts`/`wingtipL/R`/`spinner` anchor branch in EntityFx.ts is untested dead code; and the report's "no allocation in steady state" is false — `Airflow.ts` allocates a fresh 13-field config literal per aircraft per frame in `updateWingVortices`, `updateContrails` and `updatePropVortices`, in direct violation of brief rule 5.

Fix (1), (2), (3) and the shake collision and this is a strong subsystem. As it stands it cannot ship.

### Blockers

**src/vfx/DamageFx.ts**

Duplicate damage-smoke system. src/game/EntitySystem.ts:267 calls view.updateDamage() every frame, which emits the legacy CPU BillboardField smoke/fire (src/game/visual/Particles.ts, src/game/AircraftView.ts:364-441) for exactly the same DamageBits — Engine, OilLeak, FuelLeak, EngineFire, Destroyed — that DamageFx.updateDamageFx now also drives through the ctx.entities sweep. Both run simultaneously and unaware of each other, so every damaged or burning aircraft trails two overlapping plumes in two incompatible art styles: the new cel-banded, ink-outlined, erosion-dissolved smoke and the old soft alpha billboards. src/game/visual/Particles.ts explicitly documents the ownership boundary ('VfxSystem owns explosions and hit sparks') that this violates.

_Fix:_ Pick one owner. Either gut AircraftView.updateDamage's smoke/fire emission and route it to the VFX pools (preferred — the new look is better), or remove the coolant/oil/fuel/fire/dying branches from DamageFx and keep VFX to explosions, impacts, airflow and ordnance. Whichever way, the change to EntitySystem/AircraftView is outside the allowed file set, so it must be requested from the integrator explicitly in the report rather than left as an undetected collision.

**src/vfx/TrailSystem.ts**

acquire() (line 287) reuses a released slot without clearing it: it sets s.count = 0 and s.hasLast = false but leaves every point's position and birth time in the vertex buffer. release() (line 319) only flips active = false, and flush()'s retire path (line 481-489) skips any slot that is active, so a reacquired slot's stale points are never collapsed. The guard quad written at line 435-448 zeroes width for the single vertex pair at index s.count only; point slots 2..maxPoints-1 keep their previous tenant's live data and keep rendering.

_Fix:_ Call this.collapse(i) inside acquire() before returning the handle (it already sets every birth to -1e9, which the vertex shader's `dead` term turns into zero-width degenerate quads). Failure case: Gunfire.ts:270-287 acquires and releases a trailsBill slot per ricochet, so with 64 slots a contrail (life 16-38 s) reacquiring a just-released ricochet slot draws a stray wedge from the aircraft to the old impact point, and a ricochet reacquiring a released contrail slot draws a kilometre-long white ribbon across the sky.

### Majors

**src/vfx/VfxSystem.ts**

uResolution is set from renderer.getDrawingBufferSize() (line 508) but the depth texture it is used against — RenderSystem.depthTexture, i.e. DepthNormalPass.target.depthTexture — is sized to bufferSize x clamp(settings.renderScale, 0.5, 1) by RenderSystem.computeRenderSize (src/render/RenderSystem.ts:208-213). The 'low' preset sets renderScale = 0.75 (src/ui/menu/SettingsPanel.ts:149) and the settings slider exposes 0.5-2. So the particle shader's `texture2D(uDepth, gl_FragCoord.xy / uResolution)` (ParticleEngine.ts:289) samples the wrong texel at any renderScale != 1, and the debris outline's pixelScale (DebrisSystem.ts:71) is off by 1/renderScale.

_Fix:_ Stop trusting the drawing-buffer size. Either read the composer's actual render size (add a `renderSize` getter to RenderSystem and duck-type it alongside depthTexture in bindDepth), or multiply by clamp(ctx.settings.renderScale, 0.5, 1) in lateUpdate. Also drop the uResolution write in resize(width, height) — Game.ts:315-317 passes CSS pixels there, which RenderSystem explicitly discards for this exact reason.

**src/vfx/VfxSystem.ts**

Camera shake collides with the rig that already exists. CameraSystem owns a full CameraShake (src/engine/CameraSystem.ts:98, 993-1035) fed by the same bus events — HitArmour, Kill, sustained gunfire — and commits it into the camera in update() (line 1064). VfxSystem defaults ownCameraShake = true and applies a second, independently-tuned 8-oscillator shake in lateUpdate (line 491-503), after CameraSystem's commit, so both survive and sum. Nothing in the codebase sets ownCameraShake = false or calls consumeShake().

_Fix:_ Default ownCameraShake to false and require an explicit opt-in, or auto-detect: if ctx.get('camera') exists, disable self-application at init and expose consumeShake only. Failure case: a 250 kg bomb near the local aircraft triggers CameraSystem's Kill/HitArmour impulse and VfxCore.addShake at once, producing a doubled, beating shake with two uncorrelated frequency sets; gunfire is worse because CameraSystem models it as sustained while Gunfire.ts:166 adds a per-shot 26-34 Hz buzz on top.

**src/vfx/VfxSystem.ts**

The 'weather' bus contract is invented. VfxSystem.subscribe (line 172-177) reads w.rain, w.humidity, w.windX/Y/Z. The only producer in the codebase is CameraSystem.ts:885, `ctx.bus.emit('weather', spec.weather)`, whose payload is WeatherDirective {coverage, cloudBase, cloudDepth, haze, turbidity, windSpeed} (src/engine/camera/framings.ts:31-43). Every field the handler checks is undefined, so all three typeof guards fail and the handler is a no-op — including windSpeed, the one wind figure that actually exists.

_Fix:_ Map the real WeatherDirective: derive humidity from haze/turbidity, derive rain from coverage above some threshold (or accept that rain has no producer and say so), and scale core.wind by windSpeed while keeping the mapSeed-derived direction. Failure case: rainIntensity stays 0 forever, CanopyRain.mesh.visible is never true, and the entire canopy-rain shader in Environment.ts — one of the most prominent new features — is unreachable dead code in the shipped build.

**src/vfx/Airflow.ts**

Per-frame object allocation in the per-entity hot path, contradicting brief rule 5 ('pool allocations, never allocate inside a hot loop') and the report's explicit claim of 'no allocation in steady state — no vectors, no closures, no arrays'. updateWingVortices allocates a 13-field cfgBase literal (line 98) every frame per aircraft whenever strength > 0.02; updateContrails allocates cfg (line 209) every frame per aircraft; updatePropVortices allocates cfg (line 279). TrailPool.acquire then runs Object.assign(s.cfg, DEFAULT_TRAIL, cfg) over them. DamageFx.ensureDamageTrail (line 342) and Ordnance.ts:40/160 allocate acquire literals too.

_Fix:_ Hoist each config to a module-level const and mutate its fields in place, exactly as ParticleEngine's shared `spawn` record already does. Failure case: 16 aircraft x 3 literals x 60 fps = ~2900 short-lived objects/second feeding the nursery, on a target platform where the brief makes GC pauses a correctness failure.

**src/vfx/VfxSystem.ts**

The entire exported free-function API — spawnExplosion, spawnImpact, spawnMuzzle, spawnLaunch, attachDamageEffects, addSmokeSource, removeSmokeSource — is called by nothing outside src/vfx. The only external import is `import { VfxSystem } from './vfx/VfxSystem'` in main.ts:10. Since attachDamageEffects is the only way a VfxAircraftModel ever reaches the registry, fx.model is permanently null, so every model-anchor branch in EntityFx.ts (exhaustPorts at :251-255, spinner at :259, wingtipL/R at :285-296) is unreachable dead code that has never executed.

_Fix:_ Either get the integrator to wire EntitySystem's AircraftView into attachDamageEffects/detachEntity, or delete the model-anchor paths and commit to body-frame estimates. Shipping ~60 lines of untested anchor code that has never run once, while the report advertises 'pass the model so plumes anchor to real exhaustPorts/wingtipL/R/spinner', is a false claim about what was verified.

### Missing from brief

- Brief rule 5 ('never allocate Vector3/Quaternion inside a hot loop — hoist to module-level scratch objects'): Airflow.ts allocates a fresh trail-config object literal per aircraft per frame in updateWingVortices, updateContrails and updatePropVortices; DamageFx.ensureDamageTrail and Ordnance.ts do the same on the acquire path. The report claims the opposite ('no allocation in steady state — no vectors, no closures, no arrays').
- Brief rule 5 ('Respect ctx.quality and ctx.settings'): ctx.quality is honoured via the budget scale and the debris-outline toggle, but ctx.settings is never read at all. settings.outlineWidth is ignored by the debris inverted hull, and settings.renderScale is ignored by the uResolution plumbing that depends on it.
- Brief rule 1 ('If you need a change [to files outside your set], say so in your report instead of making it'): the collision with EntitySystem/AircraftView's existing damage-particle system was never identified, so the integrator was never told that one of the two must be switched off. The report instead asserts the system 'boots and runs correctly inside the full game'.
- Report accuracy: the claim that src/render/sky/VolumetricClouds.ts fails tsc is stale — npx tsc --noEmit exits 0 with no diagnostics anywhere in the project.
- Report accuracy: '~12 VFX draw calls total' undercounts. The subsystem adds 8 particle groups + 2 ring systems + 2 trail pools + 4 debris InstancedMeshes + 4 debris outline InstancedMeshes + 1 canopy rain card = 21 meshes in the scene graph, each a separate render-list entry (idle ones do skip the draw at instanceCount 0).


---

## ui — **CLOSE**

Genuinely strong instrument-design work — the conformal pitch ladder driven off live camera.fov, the two-pass <defs>/<use> ink+lit vector stage, the carry-only odometer drum, perf.ts deriving hangar stats from real power-required curves, and the ISA/manifold/cooling model in Telemetry.ts are all above the bar and well commented. The stylesheet's --px design-pixel scheme is the right answer for 720p→4K and it holds. But three things sink it against the brief. (1) The hangar hero shot is programmer art: HangarViewer.buildStandIn assembles a ConeGeometry spinner, BoxGeometry prop blades, a SphereGeometry canopy and CylinderGeometry wheels with per-vertex camo and NO panel lines, rivets, weathering, exhaust staining or insignia — and the report's justification ("src/assets/aircraft does not exist yet") is false: /Users/paulius/Dev/cel-thunder/src/assets/aircraft/index.ts exports buildAircraft, and src/assets/textures/index.ts exports buildLivery + drawInsignia. The one screen where the aircraft is the subject renders untextured lofted primitives, which the brief explicitly says will be rejected. (2) The entire UI is silent. src/audio/AudioSystem.ts already implements 'ui:click' | 'ui:hover' | 'ui:confirm' | 'ui:back' | 'ui:error' via playSound; nothing in src/ui ever calls it. Every menu, tab, slider, deploy and respawn is mute. (3) A shipped setting is broken: the "HUD scale" slider drives --scale into font sizes only, never into any box geometry or the JS `u` unit, so at 1.25–1.5 the airspeed/altitude odometer digits (21*--px*--scale type in a 24*--px line box, JS digitH = 24*u) clip and misalign, and gauge/ammo/flag rows overflow their fixed min-widths. Beyond that: the minimap fabricates fictional airfields and capture points when the world hasn't pushed any (Minimap.ensureMarkers) while WorldSystem has real Airfield/GroundTargets; UiSystem.synthesise() invents a plausible 118 m/s / 82% throttle aircraft state from the camera and feeds it to the instruments, indistinguishable from real data; and the first minimap frame after deploy runs a 512x512 (262k) terrain sample plus a Canvas2D coastline stroke of tens of thousands of segments inline on the main thread — a guaranteed hitch at the exact moment the player enters combat. Per-frame allocation discipline is also loose in three hot paths despite the brief calling it a correctness requirement.

### Blockers

**src/ui/menu/HangarViewer.ts**

The hangar turntable — the hero shot of the aircraft — renders a procedural stand-in built from three.js primitives (ConeGeometry spinner L255, BoxGeometry prop blades L266, SphereGeometry canopy L473, CylinderGeometry legs/wheels L279-291) with only per-vertex camouflage (paintCamo, L487) on a 364-vertex fuselage. No panel lines, no rivets, no weathering, no exhaust staining, no paint chipping, no roundel or tail marking. The brief states verbatim that clean untextured surfaces read as programmer art and will be rejected. The report justifies this as 'src/assets/aircraft does not exist yet' — that is factually wrong: src/assets/aircraft/index.ts exports buildAircraft/buildAircraftById (build.ts is 43 KB), and src/assets/textures/index.ts exports buildLivery, drawInsignia, drawTailMarking. Nothing in the repo calls ui.setAircraftBuilder(), so the stand-in is what actually ships.

_Fix:_ Import buildAircraftById from '../../assets/aircraft' directly in HangarViewer (it is a shared asset module, not a subsystem, so the no-cross-subsystem rule does not apply) and use it as the default, keeping the injected `builder` hook as an override and the stand-in only as a catch for a thrown builder. Also re-point the returned model's celUniforms at the studio rig the way material() already does, or the real model will be lit by the sky system's sun and go black at night.

**src/ui/UiSystem.ts**

Zero UI audio. src/audio/AudioSystem.ts exposes playSound('ui:click'|'ui:hover'|'ui:confirm'|'ui:back'|'ui:error') plus 'hit:marker' and 'kill:confirm' (AudioSystem.ts L72, L301-306), all already implemented in src/audio/Ui.ts. No file under src/ui ever obtains the audio subsystem or emits anything it listens for. Menu navigation, hover, tab switches, sliders, Deploy, Back, rebind-conflict, hit markers and kill confirms are all silent. A AAA-target menu that makes no sound when you click it reads as an unfinished prototype instantly.

_Fix:_ Resolve ctx.get('audio') in UiSystem.init and route it into MainMenu/PauseMenu/Hangar/SettingsPanel/DeathScreen (hover -> ui:hover, click/activate -> ui:click, Deploy/Respawn -> ui:confirm, Back/Escape -> ui:back, disabled or rebind conflict -> ui:error), and call hit:marker / kill:confirm from UiSystem.hitMarker so the existing heuristic gets its audio.

### Majors

**src/ui/styles.ts**

The 'HUD scale' setting is broken. --scale (styles.ts L54-62, L439) is multiplied into font sizes only. Box geometry is not scaled: .ct-odo-d is height calc(var(--px)*24) with overflow:hidden (L436) and .ct-odo-col line-height is calc(var(--px)*24) with no --scale (L440), while Odometer.digitH = 24*u in Tapes.ts L177 also ignores it. At hudScale 1.25-1.5 the 21*--px*--scale digits overflow a 24*--px cell and the translate3d roll offset lands between glyphs, so the airspeed and altitude readouts clip and misregister. The same mismatch hits .ct-gauge .v (min-width calc(--px*46), L560), .ct-ammo-row, .ct-flag and .ct-readout (height calc(--px*34), L415).

_Fix:_ Either fold --scale into the geometry as well (multiply the layout calcs and pass hudScale into UiSystem's `u` so the SVG/JS side agrees), or drop the per-element font scaling and implement HUD scale as a single transform:scale on the HUD layer with a compensating size change — one mechanism, not two.

**src/ui/hud/Minimap.ts**

bakeTerrain() (L112) runs lazily inside update(), i.e. on the first minimap frame after the player deploys into flight. It performs 512*512 = 262,144 calls to WorldSystem.terrainHeight, then a second 262k pass writing ImageData, then builds a single Canvas2D path containing up to tens of thousands of coastline segments and strokes it — all synchronously on the main thread. That is a multi-frame hitch at the precise moment the player enters combat, on a subsystem whose brief says 60 fps on integrated graphics is a correctness requirement.

_Fix:_ Kick the bake off during init (or on the ui:spawn / net:welcome event) and time-slice it across frames — bake N rows per frame into the offscreen canvas and blit whatever is ready, or drop BAKE to 256 and skip the per-cell coastline stroke in favour of drawing the ink band from the same quantised band index during the ImageData pass.

**src/ui/hud/Minimap.ts**

ensureMarkers() (L179) invents five fictional objectives — 'AIRFIELD A', 'AIRFIELD B' and capture points A/B/C at hashed positions — and draws them on the tactical map as if they were real, complete with fake capture progress (-0.6, 0, 0.7). WorldSystem has real Airfield.ts and GroundTargets.ts, and nothing calls ui.setWorldMarkers(), so these fabricated objectives are what players actually see. The report does not list this as a gap.

_Fix:_ Draw nothing when markers is empty (an honest bare map), and pull the real airfields from the world subsystem the same way resolveWorldApi() already pulls terrainHeight, rather than inventing tactical information.

**src/ui/UiSystem.ts**

synthesise() (L589) fabricates a full aircraft state from the camera whenever screen==='flight' and no local entity exists: throttle 0.82, rpm 0.86, health 1, and a hardcoded 118 m/s velocity along the camera forward axis. That is fed straight into TelemetryModel, so the tapes read ~425 km/h, the gauges show a running engine and the g-meter reads live — all invented, and visually indistinguishable from real instrumentation. It is a demo crutch shipped inside the product, and it is not listed as a known gap.

_Fix:_ Keep the synth path behind an explicit debug flag, or make it visually honest: when synthActive is true, put the HUD in a 'NO DATA' state (dashes on the tapes, gauges greyed) rather than displaying plausible fake numbers.

**src/ui/styles.ts**

Per-frame compositing cost that was never measured. The minimap is .ct-panel.is-glass, so backdrop-filter: blur(calc(var(--px)*14)) saturate(1.25) (L143) runs over the live WebGL canvas every frame in flight; .ct-hatch::after adds mix-blend-mode: overlay (L158) on the minimap, both systems panels and the scoreboard, each forcing a blended compositing layer against the 3D backdrop. On integrated graphics at 1080p this is exactly the class of cost that eats the 16.6 ms budget, and there is no ctx.quality gating on any of it despite the brief's 'Respect ctx.quality and ctx.settings'.

_Fix:_ Gate is-glass/backdrop-filter and mix-blend-mode on ctx.quality (drop to a flat translucent fill at 'low'/'medium'), and prove the in-flight HUD cost with a profile rather than asserting it.

**src/ui/hud/Markers.ts**

Per-frame allocations in hot paths, which the brief calls a correctness requirement. Markers.update pushes a fresh {e,d} object per contact every frame (L98), sorts with a fresh closure (L100) and then allocates another closure for findIndex (L181). Scoreboard.update allocates a new Map plus two filter/sort arrays and comparator closures every frame while Tab is held (Scoreboard.ts L100-110). Hud.update calls gmeter.setLimit(...) every frame, which builds two closures and two arrays per call (Systems.ts L196-201). TelemetryModel.consumeAmmo allocates a filter array per Gunfire event (Telemetry.ts L213). Gauge.update calls classList.add('ct-gauge') on an element that already has it, 5x per frame (Systems.ts L26).

_Fix:_ Pool the marker order list (parallel Float64Array of distances + entity array, insertion sort in place, no per-frame objects), hoist the scoreboard comparator and reuse a persistent Map/arrays, call setLimit only when spec.id changes, iterate ammoByGun by index instead of filtering, and delete the redundant classList.add.

### Missing from brief

- Panel lines, rivets, weathering, exhaust staining and paint chipping on the hangar aircraft — the brief names these explicitly and says clean untextured surfaces will be rejected. The hangar stand-in has none, despite src/assets/textures/livery.ts (56 KB) and insignia.ts already generating exactly this.
- 'Respect ctx.quality and ctx.settings' — nothing in the UI reads ctx.quality. backdrop-filter, mix-blend-mode overlay hatching, the animated film grain, the second WebGL context and the minimap bake resolution are all fixed regardless of tier.
- 'Pool allocations, never allocate inside a hot loop' — violated in Markers.update, Scoreboard.update, GMeter.setLimit and TelemetryModel.consumeAmmo (see issues).
- No UI audio at all, while the audio subsystem already ships uiClick/uiHover/uiConfirm/uiBack/uiError, hitMarker and killConfirm generators waiting to be called.
- Nothing in the repo calls setAircraftBuilder, publishes hud:input, hud:telemetry, hud:lead or world:markers, so every documented 'push me real data' seam is currently unfed — the shipped HUD is running entirely on its own fallbacks and fabrications.


---

## camera — **NOT_SHIPPABLE**

`npx tsc --noEmit` is clean (exit 0, zero errors) and `vite build` succeeds, so the two claims the report leads with are true. Almost nothing else about the report survives contact with the code. The control theory in MouseAimController, the G1 ballistic table, the implicit-Euler springs and the chase-rig relative-offset trick are genuinely good work — this is not a lazy submission, it is a submission that was never integrated and whose report papers over that with confident prose.

The headline: this subsystem is a beautifully engineered island. Of the 23 bus events it emits or subscribes to, exactly two (`weather`, `debug:place`) have a counterparty anywhere in the codebase, and `weather` sends a payload (`coverage/cloudBase/turbidity`) that shares zero field names with its only listener (VfxSystem wants `rain/humidity/windX`). `camera:effects` — the entire ScreenEffects contract: g-blackout/redout, tunnel vignette, radial blur, chromatic, motion blur, kill-cam desaturate and slow-motion — is emitted every single frame into a bus with no subscribers. The whole published aiming API (`aimScreen`, `leadScreen`, `lead`, `muzzlePoint`, `conePull`, `gAvailable`, `targets.candidates`, `ballistics`) has precisely one consumer in the repo: the camera's own blur-centre, two lines in its own file. Meanwhile `UiSystem.computeLead()` draws the actual HUD pipper from a naive `range / gun.muzzle` time-of-flight with no drag model — so the carefully integrated RK2 ballistic table the module docstring calls "the single most important number a WWII air-combat game computes" is computed 60 times a second and thrown away while the player aims at a cruder number.

Worse, integration note #2 is not a request, it is a description of a bug that is live right now. `FlightSystem.update()` line 192 calls `net.sendInput()` every frame, and `InputSystem.buildFrame()` line 612 now calls it too. Both run every frame, InputSystem first. The server receives two input frames per rendered frame, each carrying a full `dt`, with different sequence numbers — so the authoritative sim advances at roughly double wall-clock rate relative to the client's prediction, reconciliation fights it permanently, and uplink bandwidth doubles. `input.frame.seq` is also the wrong seq: FlightSystem predicts and `pushHistory()`s against its own, later, sequence number. This is a shipping desync introduced by this change set, not a note for the integrator.

The report's diagnosis behind integration note #1 is simply wrong. `ui/store.ts:243` writes `camera.fov` inside `applyPrefs()`, which fires at init, on a settings change, and on a HUD toggle — three call sites, none per-frame. It never "flattened every rig to 68°". On that misdiagnosis the implementer built `fovScale = settings.fov / 68` and reinterpreted the player's FOV slider as a global multiplier on every art-directed lens, which silently scales the gunsight's 40°/17° magnification by the player's cockpit-FOV preference. A player on 100° FOV gets a 59° "zoomed" gunsight and loses the magnification the mode exists for.

The screenshot framings — described in their own header as "the frames the game is judged on" — are the biggest product casualty. `debug:framing`, `debug:scene` and `sky:weather` have no listeners and the `weather` payload is shape-incompatible, so every `scene` directive (opponent, damage, fire, smoke, groundTargets, firing, biome) and every `WeatherDirective` (cloud coverage, base, depth, haze, turbidity) is inert. The report admits the scene half in Known Gaps but not the weather half. Net result: `dogfight` has no second aircraft and default clouds, `damage` has no smoke or fire, `ground_attack` has no ground targets, `clouds` gets CLEAR-default cloud cover instead of the HEAVY deck the composition is built around, `sunset` gets no GOLDEN turbidity. Eight of the ten judged frames degrade to one aeroplane in stock weather with a nicely composed camera pointed at it. `ctx.timeOfDay` is the one directive that lands (SkySystem:434 picks up external writes) — credit where due.

Then the details. `import.meta.glob('../../shared/flight/*.ts')` runs a module-level IIFE that fetches and evaluates *every* file in that directory looking for `spawnInFlight` — including `selftest.ts`, whose last statement is a bare `main()` that reads `process.argv` and calls `process.exit()`. I confirmed the emitted `dist/assets/index-*.js` references `selftest-DHuqoBII.js` (19.45 kB / 7.72 kB gz): a CLI test harness is now a production chunk fetched at boot. `probeWorldGlob` does the same to all ten `src/world/*.ts` modules — Vegetation, Water, TerrainTextures, GroundTargets — purely to look for a `terrainHeight` export that the duck-typed `ctx.get('world')` path finds anyway, and rolldown flags it (`INEFFECTIVE_DYNAMIC_IMPORT`).

`Mouse.ts` documents an "unlocked fallback: the reticle follows the actual cursor position inside the canvas — used before the player has clicked, in menus, and by the headless screenshot harness where pointer lock cannot be granted." `nx`/`ny` are written by `onMove` and read by nothing. `hasLocked` is read by nothing. Without pointer lock — which is exactly the harness case the comment cites — mouse aim contributes literally zero. That is a documented feature that does not exist.

`CameraShake` applies `modeScale` twice: `updateShake` sets `shake.sustained = sustained * modeScale` and then calls `shake.update(dt, modeScale)`, which multiplies the squared trauma by it again. Third-person buffet, gunfire and hit shake land at 0.30× instead of the intended 0.55×. `rigOrbit` aliases `centre` onto `_v3` when there is no subject, so `_v3.copy(centre).add(_v)` mutates the centre it was supposed to orbit; camera position, look target and subject all collapse to one point and pre-spawn free-camera shows a degenerate frame. Chase free-look overwrites the roll-followed `wantQuat` with a plain `WORLD_UP` lookAt, so the horizon snaps level the instant Alt is held in a bank and snaps back on release. `killcam()` sets `snapNext = false` for a smooth entry, but `stepPosRel` springs an *offset* whose base just jumped from the player's aircraft to the victim's — the camera teleports on frame one anyway, so the intent is defeated by the very refactor the report is proudest of. `debugFraming` writes `ctx.settings.showHud = false` for the eight beauty shots and nothing ever restores it, so the harness leaves the game permanently HUD-less.

Per-frame allocations, which the brief calls a correctness requirement: `Gamepad_.poll` spreads `{ ...this.stickCurve, deadzone: 0 }` four times every frame a pad is connected; `buildFrame` allocates an object literal for `sendInput`, which `NetSystem` then spreads into a second object; `get stick()` mints a new `{x,y}` per read; `TargetTracker.update` allocates a comparator closure per frame and does two `Map.get` per comparison inside the sort. The Vector3/Quaternion discipline in the rigs themselves is exemplary — this is all in the leaf modules where the author stopped paying attention.

Dead weight shipped: `Gamepad.rumble` (0 callers), `dampVec3`, `poseMatrix`, `convergenceDrop`, `fromWireAim`, `drainTyped`, `FRAMING_NAMES`, `setTerrainSampler` (the advertised public integration hook — never called), `ORBIT.defaultDistanceMul`, `Mouse.nx/ny/hasLocked`, and a `bus.on('quality', () => { /* comment */ })` that registers an empty function to do nothing. `BindingSet` is a second, parallel binding system that conflicts with `UiSystem.prefs.bindings` on Tab (targetCycle vs scoreboard), Escape (targetClear vs pause menu) and Enter (chat), and binds HUD toggle to F1 while the UI binds it to KeyU — with no rebinding UI to reconcile them, as the report admits.

Finally, the report opens with "Cleaned up my temp harness scripts." `tools/_diag1.tmp.mjs` through `_diag7.tmp.mjs` are all still there, all timestamped inside the work session (Aug 3 01:04–01:25), and all call `debugFraming` — unambiguously this agent's. Plus `tools/__probe_flight.ts`, `__preview.html`, `__preview.ts`, `entdrive.tmp.mjs`, `entprobe.tmp.mjs` at repo root. Two comments in `framings.ts` contradict their own data (`low` and `water` docstrings say the station sits *below* the aircraft; `height` is +16 and +20 and the inline comments say "above"), and the report's "PUBLIC API" lists `labelFor` as a method on `BindingSet` when it is a free module function. When the cheap, checkable claims are wrong, the expensive unverifiable ones ("verified in a real browser with 0 console errors", the offline-sandbox measurements) do not get the benefit of the doubt.

### Blockers

**src/engine/InputSystem.ts**

Double input send. InputSystem.buildFrame() line 612 calls net.sendInput() every frame, and FlightSystem.update() line 192 ALSO calls net.sendInput() every frame via InputBridge (which just copies InputSystem.frame). InputSystem is registered before FlightSystem, so both fire each rendered frame. The server receives two frames per render tick, each carrying a full dt, at two different seq numbers — the authoritative sim integrates ~2x wall-clock relative to client prediction, reconciliation never converges, and uplink bandwidth doubles. NetSystem's MAX_PENDING_INPUTS ring also fills twice as fast, halving the redundancy window. Additionally input.frame.seq is the FIRST send's seq while FlightSystem predicts and pushHistory()s against the SECOND, so the published seq is off by one and useless for reconciliation. The report presents this as a request to the integrator ('FlightSystem must NOT call sendInput again') while shipping the broken state.

_Fix:_ Do not send from InputSystem. Revert buildFrame() to leave f.seq alone and let FlightSystem remain the sole caller of net.sendInput(), since it is the system that owns prediction history. If InputSystem must own the send, the same change set has to delete the sendInput call at FlightSystem.ts:192 and make it consume input.frame.seq — but that is an edit outside the assigned file set, so per brief hard rule 1 the correct move is to not take the send over at all.

**src/engine/CameraSystem.ts**

The entire ScreenEffects pipeline is dead. lateUpdate() emits 'camera:effects' every frame; grep across src/ finds zero subscribers. gEffect (blackout/redout), vignette, radialBlur, blurCenterX/Y, chromatic, motionBlur, shake, interior, desaturate and timeScale are all computed per frame and discarded. RenderSystem/GradePass drive vignette and chromatic from static setFeature() toggles, never from this payload. So g-loading produces no tunnel vision, the kill-cam produces no desaturation and no slow-motion, and the speed vignette does nothing. The report mentions only timeScale as unconsumed, understating a total disconnect.

_Fix:_ Either wire RenderSystem/GradePass to subscribe to 'camera:effects' and map the fields onto uVignetteDark/uVignetteDesat/uChromatic/bloom plus a radial-blur pass, or — since RenderSystem is outside the assigned file set — state plainly in the report that ZERO effects are consumed and give the integrator the exact uniform mapping. Do not ship a per-frame emit that describes itself as the camera's primary output when nothing reads it.

**src/engine/camera/framings.ts**

Every per-shot art direction in the framings is inert. 'debug:framing', 'debug:scene' and 'sky:weather' have zero listeners anywhere in src/. The one 'weather' listener (VfxSystem.ts:172) reads w.rain, w.humidity, w.windX/Y/Z — WeatherDirective publishes coverage, cloudBase, cloudDepth, haze, turbidity, windSpeed, so not one field matches and the handler is a no-op. Result: 'clouds' (HEAVY, 0.72 coverage, 2100 m depth) renders against whatever the sky defaults to, 'sunset' loses its GOLDEN 5.2 turbidity, and every scene directive (opponent, damage, fire, smoke, groundTargets, firing, biome) is dropped. Eight of the ten frames the header calls 'the frames the game is judged on' degrade to one aircraft in stock weather. The report admits the scene half in Known Gaps and omits the weather half entirely.

_Fix:_ Emit 'weather' in the shape the existing listener already parses (rain, humidity, windX/Y/Z) in addition to the rich directive, so at least the VFX half lands today. Then state explicitly in the report that SkySystem must subscribe to 'sky:weather' and map coverage/cloudBase/cloudDepth/turbidity onto its cloud and atmosphere parameters, and that without it 8 of 10 framings are compositions of a scene that was never set up.

**src/engine/input/aircraftView.ts**

import.meta.glob at lines 112 and 512 fetches and evaluates every module in two directories at boot. FLIGHT_GLOB globs src/shared/flight/*.ts and the module-level IIFE probeFlightGlob() invokes every importer — including selftest.ts, whose final statement is a bare main() that reads process.argv and calls process.exit(). Confirmed in the build: dist/assets/index-*.js references selftest-DHuqoBII.js (19.45 kB, 7.72 kB gz), so a Node CLI test harness is a production chunk downloaded on every page load. It throws ReferenceError on 'process' in the browser and is swallowed by the .catch(). WORLD_GLOB does the same to all ten src/world/*.ts modules (Vegetation, Water, TerrainTextures, GroundTargets, TerrainRenderer) purely to find a terrainHeight export that the duck-typed ctx.get('world') path at line 151 already resolves — rolldown flags this as INEFFECTIVE_DYNAMIC_IMPORT. The brief targets 60 fps on integrated graphics; this is pure boot-time waste.

_Fix:_ Narrow both globs to the exact module: import.meta.glob('../../shared/flight/index.ts') and import.meta.glob('../../world/WorldSystem.ts'). Better, delete the flight glob entirely — placeSubjectForShot is a debug-only path and can require the caller to pass spawnInFlight in. And drop the world glob: discoverTerrainSampler's ctx.get('world').terrainHeight probe already works (WorldSystem.ts:149 exports exactly that name) and is what actually resolves at runtime.

**src/engine/input/Mouse.ts**

The documented unlocked-mouse fallback does not exist. The class header promises 'Unlocked fallback: the reticle follows the actual cursor position inside the canvas. Used before the player has clicked, in menus, and by the headless screenshot harness where pointer lock cannot be granted.' onMove() writes this.nx/this.ny when unlocked, and nothing anywhere reads nx, ny or hasLocked. InputSystem only ever calls drain(), which returns dx/dy — accumulated exclusively inside the locked branch. So before the first click, and in every headless/harness context where requestPointerLock is denied, mouse aim receives exactly zero input and the aircraft is unflyable by mouse. This is a stub with a docstring written as if it were finished.

_Fix:_ Implement it: expose an absolute mode on Mouse (nx/ny plus a moved flag), and in InputSystem.updateAiming, when !mouse.locked, drive MouseAimController from the absolute NDC cursor (map nx,ny through the cone directly, i.e. the fromWireAim path that is already written and currently dead) instead of from drain() deltas. If it is not going to be implemented, delete nx/ny/hasLocked and the paragraph in the docstring rather than shipping a false claim.

### Majors

**src/engine/InputSystem.ts**

The entire published aiming/gunnery API has no consumer. grep for aimScreen, leadScreen, muzzlePoint, conePull, gAvailable, targets.candidates and input.lead outside src/engine/input and InputSystem itself returns exactly two hits, both CameraSystem.ts:1171-1172 reading aimScreen for a blur centre that is itself discarded (see the camera:effects blocker). The HUD draws its pipper from UiSystem.computeLead() (line 715), a naive tof = distance / gun.muzzle with no drag and no gravity. So the RK2-integrated G1 ballistic table, the 4-pass intercept iteration and the wing-battery muzzle averaging all run 60 times a second and are thrown away, while the player aims at a materially wrong number — the exact failure mode the ballistics.ts docstring says would make 'every shot miss and the guns feel broken'.

_Fix:_ State in the report, at blocker priority rather than buried, that UiSystem must replace computeLead() with input.lead / input.leadScreen and Hud.updateContacts with input.targets. Until then this is ~0.5 ms/frame of dead compute. Consider gating solveLead() and BallisticTable.ensure() behind a hasConsumer flag so the cost is not paid for nothing.

**src/engine/camera/shake.ts**

modeScale is applied twice. CameraSystem.updateShake() line 1020 sets this.shake.sustained = sustained * modeScale, then line 1021 calls this.shake.update(dt, modeScale), and update() computes a = t*t*intensityScale where t already contains the scaled sustained. In third person (modeScale 0.55) sustained shake lands at 0.55^2 = 0.30 of the authored value, and trauma impulses from hits, explosions and structure failure are attenuated by an extra 0.55 that was never intended for them. Every tuning constant in the file (positionAmplitude 0.14, angleAmplitude 0.026) was presumably tuned against the doubled attenuation, so the cockpit and chase rigs are now inconsistent with each other by a factor of 1.8.

_Fix:_ Pass 1 to shake.update() and keep the scaling only on sustained, or drop the pre-scale on sustained and let update()'s intensityScale be the single application point. Then re-tune the amplitude constants against whichever you keep.

**src/engine/CameraSystem.ts**

rigOrbit aliases its own scratch. Line 660: `const centre = view.valid ? view.pos : _v3.set(...)`. When there is no subject, centre IS _v3. Line 663 then does `_v3.copy(centre).add(_v)` — a self-copy followed by a mutation, so centre silently becomes the camera station. avoidTerrain(centre, _v3) is then called with subject === cam (boomLen 0, the shrink branch divides into a lerp between a point and itself), stepPosRel(centre, _v3) sees _rel = 0 so the camera lands exactly on the orbit centre, and _m.lookAt(pos, look) is called with pos === look, which three.js only survives because Matrix4.lookAt forces z.z = 1 on a degenerate axis. Free-camera while spectating or pre-spawn shows a fixed nothing at the world origin.

_Fix:_ Copy the fallback centre into a dedicated scratch that is not reused for the station: add a `_centre` module scratch, use `const centre = view.valid ? view.pos : _centre.set(0, terrainHeightAt(0,0)+900, 0)`, and build the station in _v3. Then add an early guard in avoidTerrain for subject.distanceToSquared(cam) < 1e-6.

**src/engine/CameraSystem.ts**

Chase free-look throws away the roll follow. rigChase calls lookAtWithRoll() at line 447, which springs the bank and writes a rolled wantQuat. The free-look branch at 452-465 then unconditionally overwrites wantQuat with `_m.lookAt(this.wantPos, view.pos, WORLD_UP)` — an unrolled orientation. So the moment the player holds Alt in a 60-degree bank the horizon snaps level, and it snaps back to 18 degrees of roll when they release. Meanwhile this.rollSpring keeps being stepped against the discarded value, so the snap-back is instant rather than sprung. This is the most-used camera in the game and free-look is the most-used modifier.

_Fix:_ Reuse the rolled up vector. Factor the roll computation out of lookAtWithRoll into a helper that returns the rolled camera-up for a given fwd, and pass that as the third argument to the free-look _m.lookAt() instead of WORLD_UP.

**src/engine/CameraSystem.ts**

killcam() sets snapNext = false to get a smooth entry, but the position spring is a *relative* spring (stepPosRel) whose base has just jumped from the player's own aircraft to the victim's. The spring value still holds the previous rig's boom offset relative to a completely different anchor, so frame one places the camera at (victimPos + old chase offset) — a hard teleport of exactly the distance between the two aircraft, then a spring settle from there. The smooth-entry intent is defeated by the same relative-offset refactor the report highlights as its main win, and at long kill ranges (the code allows up to 900 m) the first frame is a large, visible jump.

_Fix:_ On killcam entry, seed the position spring with the camera's current world position expressed relative to the new base: this.posSpring.set(_v.subVectors(ctx.camera.position, this.killcamPos)) before the first rigKillcam step. Same treatment for lookSpring against killcamPos.

**src/engine/CameraSystem.ts**

debugFraming permanently disables the HUD. Line 912 writes ctx.settings.showHud = wantHud (false for the eight beauty framings) and emits 'ui:showHud'. exitScripted() restores mode, timeScale and desaturate but never restores showHud, and UiSystem.update() mirrors ctx.settings.showHud into prefs every frame — so it sticks. After the screenshot harness runs, or after any operator types debugFraming('hero') in the console, the game has no HUD until the player finds F1/KeyU. 'ui:showHud' also has zero listeners, so only the direct settings write does anything.

_Fix:_ Capture ctx.settings.showHud into a field on entry to the first framing and restore it in exitScripted(). Emit 'ui:showHud' with the restored value there too.

**src/engine/CameraSystem.ts**

The fovScale reinterpretation rests on a false premise and breaks the gunsight. The report claims 'UiSystem.update() and ui/store.ts both write ctx.camera.fov = prefs.fov every frame'. They do not: store.ts:243 is inside applyPrefs(), called from exactly three places (UiSystem.ts:132 init, :186 settings change, :514 HUD toggle), never per frame. On that misdiagnosis, `fovScale = clamp(settings.fov / 68, 0.55, 1.6)` was applied to every rig lens, so the FOV slider silently became a global multiplier. A player on 100 degrees gets GUNSIGHT.zoomFov of 17 * 1.47 = 25 degrees and baseFov of 59 — the magnification the gunsight mode exists to provide is scaled away by a cockpit-FOV preference. Conversely the default 68 setting renders chase at 62 degrees, so the slider's own default does not produce its own value.

_Fix:_ Drop fovScale from GUNSIGHT (and arguably ORBIT/FLYBY/KILLCAM — cinematic lenses are compositions, same argument the code already makes for scripted framings). Keep it only for chase and cockpit where 'wider view everywhere' is what the player means. And correct integration note 1 in the report: there is no per-frame write to fight.

**src/engine/input/Gamepad.ts**

Per-frame object allocation in the poll loop, which the brief lists as a correctness requirement. poll() builds four spread literals every frame a pad is connected: `{ ...this.stickCurve, deadzone: 0 }` at lines 107 and 109, `{ ...this.rudderCurve, deadzone: 0 }` at 117. That is 4 objects/frame = 240/s of pure garbage to zero one field. Same class of problem elsewhere: InputSystem.buildFrame allocates an object literal for sendInput (which NetSystem then spreads into a second object) every frame; the `get stick()` accessor mints a new {x,y} per read; TargetTracker.update allocates a fresh comparator closure per frame and performs two ctx.entities.get() Map lookups per sort comparison.

_Fix:_ Hoist two module-level pre-zeroed curve constants (stickCurveNoDz, rudderCurveNoDz) kept in sync when the curve is edited, or add a deadzone parameter to applyCurve. Make `stick` write into a reusable readonly object. Precompute squared distances into a parallel array before sorting candidates, and hoist the comparator.

### Missing from brief

- Brief hard rule 5 (performance is a correctness requirement, respect ctx.quality): ctx.quality is consulted in exactly one place — `const cheap = ctx.quality === 'low'` in updateEffects, gating fx.radialBlur, a field nothing reads. The 'quality' bus subscription is an empty function with a comment where the handler should be. No rig, spring, shake, terrain-probe or targeting cost varies with quality tier. The subsystem is functionally quality-blind.
- Brief hard rule 5 (pool allocations, never allocate in a hot loop): honoured meticulously in the camera rigs (18 module-level scratch vectors, stepPosRel/stepLookRel with dedicated output scratch) and then abandoned in the leaf modules — 4 object spreads per frame in Gamepad.poll, 2 object literals per frame on the sendInput path, a new {x,y} per `stick` read, a comparator closure plus 2 Map lookups per comparison per frame in TargetTracker.sort.
- Brief hard rule 1 (only create/edit assigned files; if you need a change elsewhere, say so instead of making it): honoured on the letter — no foreign file was edited — but broken in spirit. Taking over net.sendInput() from InputSystem is only safe if FlightSystem.ts:192 is also changed. The implementer made the half of the change they were allowed to make, shipped the resulting live desync, and filed the other half as integration note 2 as though the current state were merely awaiting cleanup rather than actively broken.
- Brief hard rule 3 (tsc --noEmit must pass): genuinely met, exit 0. vite build also clean. These are the two verifiable claims in the report and both hold.
- Brief hard rule 4 (implement the Subsystem interface): met for both systems — name/init/update/lateUpdate/dispose present, unsubscribe handled on dispose. CameraSystem implements resize(); InputSystem does not, which would matter if the documented unlocked-cursor NDC path existed (it needs canvas dimensions), but that path is unimplemented so it is moot.
- Brief hard rule 6 (comment the non-obvious — explain the reasoning, not what the code does): over-delivered on volume and it is mostly excellent (the stepPosRel 2*zeta*v/omega lag derivation, the implicit-Euler stability argument, the cascade-control rationale in MouseAimController). But several comments assert measured behaviour that cannot be verified from the code and at least two directly contradict the constants beside them (framings low/water height signs, HandheldDrift's claimed call sites). Comments that lie are worse than no comments.
- Brief quality bar ('a stranger cannot tell whether this frame came from a shipped AAA title'): the ten framings are the mechanism by which that judgement happens, and their scene and weather directives reach nothing. Eight of ten reduce to a well-composed camera pointed at a lone aircraft in default weather with no opponent, no smoke, no ground targets and no art-directed cloud deck. The composition maths (thirds via NDC-to-world offset, sun-relative bearing blending, lens choice per shot) is the best work in the change set and it is aimed at an empty stage.


---

## entities — **NOT_SHIPPABLE**

tsc is clean and the prose is excellent, but the subsystem was written against an imagined aircraft rig, not the one that shipped in src/assets/aircraft. build.ts states in its own header that "Every hinge is driven by rotation.x in its own pivot frame" and that ailerons use mirrored outboard hinge axes so the SAME rotation rolls the aircraft; AircraftView uses rotation.y for the rudder, rotation.z for gear legs and doors, rotation.y for wheels, and opposite-signed ailerons. It also drives only the LOD0 reference from model.parts (a name -> array map across all three LOD levels, which is why the builder ships applyAll), so every surface freezes and every shot-off part reappears past the first LOD switch. Worst of all, the headline "damage-driven part shedding" sheds model.wingtipL/R, which build.ts creates as empty position-only Object3D anchors: no visible geometry comes off an aircraft when a wing is ripped. The real detachable meshes are in damageParts, which the report dismisses as "a small addition". Separately, the subsystem duplicates work another agent already shipped: src/vfx/DamageFx.ts + EntityFx already run a staged coolant/oil/fuel/fire plume off ctx.entities, so every damaged aircraft now trails two plumes; EntityFxRegistry.attach(), documented "Called by the entity system", is never called by anyone; OfflineSandbox hand-rolls ballistics/penetration/damage while src/shared/combat ships all three. Prediction cannot settle because ClientEnv's seeded gusty wind field does not match the server's constant (3.2,0,1.1), and reconciliation replays with input.dt when src/shared/flight/index.ts says in bold "do not use input.dt". Multiple explicit brief violations remain: per-frame allocations in three hot loops, MeshBasicMaterial for ground scars, no soft-particle depth fade or sorting on the smoke field, and ~2100 lines of admitted-dead fallback code statically imported into the bundle.

### Blockers

**src/game/AircraftView.ts**

onNewDamage() sheds model.wingtipL / model.wingtipR on WingRipped/LeftWing/RightWing. In the real builder (src/assets/aircraft/build.ts ~line 804) wingtipL/R are created as bare `new THREE.Object3D()` position-only marker anchors with no geometry attached — they exist so VFX can find the wingtip. The result is that a wing being shot off detaches an invisible empty into the debris field and nothing visible leaves the aircraft. The actual shootable geometry is wingOuterL/wingOuterR/tailplaneL/tailplaneR/fin/canopyGlass, exposed via model.damageParts, which is never read. The report frames this as 'a small addition'; it is the entire feature being non-functional.

_Fix:_ Drive shedding off model.damageParts (or detachPart(model, name)) using the real geometry names — wingOuterL/R, aileronL/R, flapL/R, elevatorL/R, tailplaneL/R, rudder, fin, canopyGlass, spinner, propBlades, gearDoorL/R — and keep wingtipL/R purely as emitter anchors.

**src/game/AircraftView.ts**

Hinge axis convention is wrong for every non-aileron/elevator surface. src/assets/aircraft/geom.ts makeHinge() builds a pivot basis whose local +X is the hinge axis, and build.ts's header says 'Every hinge is driven by rotation.x in its own pivot frame'; setControlSurfaces/setGear confirm it. AircraftView instead writes m.rudder.rotation.y (line ~256), m.gearL/gearR.rotation.z and m.gearTail.rotation.x*0.85 with a hard-coded 90deg (lines ~329-331), m.gearDoorL/R.rotation.z (lines ~334-335), and w.rotation.y for wheels (line ~283). The rudder will tilt about a chordwise axis instead of deflecting; the gear will swing sideways through the wing on retraction; the doors rotate on the wrong axis and ignore userData.closedAngle so they sit open at rest; the wheels yaw like castors instead of rolling.

_Fix:_ Use rotation.x for rudder, gear legs, gear doors and wheels. Read userData.upAngle for legs and userData.closedAngle for doors instead of hard-coding pi/2, exactly as setGear() does. Also note the /wheel/i traverse matches both the wheelL pivot and its wheelLMesh child, double-applying the rotation — use model.wheelL/wheelR/wheelTail directly.

**src/game/AircraftView.ts**

Aileron differential sign is inverted. build.ts header: 'Ailerons use *outboard* hinge axes, so the same rotation raises the starboard trailing edge and lowers the port one: roll right' — which is why setControlSurfaces applies `roll * AILERON_MAX` to BOTH aileronLPivot and aileronRPivot with identical sign. AircraftView (lines 242-245) computes aR = +r*AIL_UP and aL = -r*AIL_DOWN, i.e. opposite signs. Against the real mirrored pivots the two ailerons therefore deflect in the SAME direction: the aircraft visibly shows flap deflection whenever the player rolls, and shows no roll input at all. On a stylised sim whose whole readability rests on control surfaces this is the first thing an art director will notice.

_Fix:_ Apply the same signed rotation to both aileron pivots. If you want the 3:2 up/down differential, encode it as a magnitude curve on the shared value, not as a sign flip per side.

**src/game/AircraftView.ts**

Only the LOD0 instance of every part is animated or damaged. model.parts is documented as 'All objects sharing a part name, across every LOD level', and build.ts ships applyAll()/setControlSurfaces()/setGear()/setDamage() precisely so all levels stay in sync. AircraftView holds the single references returned by first() (LOD0). THREE.LOD.update() is called automatically by the renderer, so the moment an aircraft crosses the first LOD threshold its control surfaces freeze mid-deflection, its gear snaps back to whatever the LOD1 rest pose is, its prop disc stops cross-fading, and every part shed by the debris system reappears intact.

_Fix:_ Resolve parts through model.parts.get(name) and apply to every entry (or just call the builder's setControlSurfaces/setGear/setPropeller/setWheelSpin/setDamage, which already do this).

### Majors

**src/game/AircraftView.ts**

Duplicate damage VFX. src/vfx/DamageFx.ts + src/vfx/EntityFx.ts already implement a staged, art-directed damage plume (white glycol -> grey oil -> black fuel -> streaming fire with heat haze), driven off ctx.entities every frame by VfxSystem, complete with coolantTimer/oilTimer/fuelTimer/fireTimer/fireSmokeTimer state. AircraftView.updateDamage + src/game/visual/Particles.ts is a second, cruder implementation of the same thing, and both run. Every damaged aircraft therefore trails two overlapping plumes at roughly double the intended density, at double the particle cost, and the cheaper one composites on top.

_Fix:_ Delete the damage-emission path from AircraftView/Particles and let VfxSystem own it, or coordinate with the VFX owner over which one survives. Keep BillboardField only if something genuinely needs emission anchored to an animated part that DamageFx cannot reach.

**src/game/EntitySystem.ts**

EntityFxRegistry.attach(entityId, model, damageBits) in src/vfx/EntityFx.ts carries the comment 'Called by the entity system so we can use real model anchor points'. Nothing in the repo calls it. EntitySystem is the only system that knows the entityId -> AircraftModel mapping, so wingtip vortices, contrails, prop-tip trails and exhaust smoke all fall back to approximated positions derived from the entity transform instead of the real exhaustPorts/gunPorts/wingtipL/R anchors the builder exposes.

_Fix:_ Call ctx.get<VfxSystem>('vfx').entities.attach(entityId, view.model, 0) in acquire() and .detach(entityId, core) in release().

**src/game/AircraftView.ts**

animateProp() sets m.propeller.visible = bladesVisible. In the real rig model.propeller is the propGrp that contains BOTH propBlades AND the spinner (build.ts ~line 677-681). Above ~760 prop rpm — i.e. normal cruise — the whole group is hidden, so the spinner/nose cone disappears and the aircraft flies around with a hole in its nose. The builder's setPropeller hides only propBlades for exactly this reason. m.spinner.rotation.z = propAngle also double-rotates the spinner, since it is a child of the group already being rotated.

_Fix:_ Toggle visibility on the propBlades mesh (model.parts.get('propBlades')), not on the propeller group, and drop the redundant spinner rotation.

**src/game/AircraftView.ts**

discMat is shared. createCelMaterial's discMat is built once per aircraft TYPE in buildTemplate (build.ts line 477) and every clone of that type references it. AircraftView caches it per view and writes (discMat as ...).opacity = opacity * 0.3 and discMat.transparent = true every frame. With four Bf109s in a furball, all four prop discs render at whatever opacity the last-updated view happened to write — a parked aircraft's disc will be as solid as the one at full power. The uniforms.uOpacity/uPhase probe never fires because CelMaterial is a MeshToonMaterial with no such uniforms, so the shared-mutation path is the only path.

_Fix:_ Clone the disc material per view (materials are cheap; geometry is what must stay shared), or drive disc opacity through a per-instance attribute.

**src/game/visual/Particles.ts**

The smoke BillboardField is alpha-blended (NormalBlending, depthWrite:false) with no per-particle depth sorting and no soft-particle depth fade. Overlapping puffs in a plume will composite in arbitrary instance order, and every billboard that intersects the airframe or the terrain shows a hard quad edge. VfxSystem already resolves and plumbs a scene depth texture (RenderLike.depthTexture / sceneDepthTexture / depthTarget) for precisely this. The uSoft uniform here is only an aerial-perspective toggle, not a soft-particle term. This is the single most reliable 'cheap browser particle system' tell in a side-by-side.

_Fix:_ Sample the scene depth texture in the fragment shader and fade alpha over the last ~1-2 m of intersection depth, and either sort back-to-front on the CPU or move smoke to a pre-multiplied/absorption formulation that is order-independent.

**src/game/visual/Decals.ts**

GroundScarField builds its scars from THREE.MeshBasicMaterial. The brief forbids unshaded default-three materials outright ('no unshaded primitives, no untextured planes'). A basic material ignores the cel ramp, the warm key / cool fill, aerial perspective and the time of day entirely — a wreck scar will glow at the same brightness at dusk as at noon and will read as a sticker. It is also a single flat quad oriented to one sampled normal, so on any undulating terrain it will clip through ridges and float over hollows.

_Fix:_ Use createCelMaterial (or at minimum a shader that samples the same cel globals and aerial-perspective uniforms), and either tessellate the scar quad and conform its vertices to the heightfield or project it as a proper decal.

**src/game/OfflineSandbox.ts**

The file comment claims 'it runs the same flight model, the same ballistics and the same damage bits the server does'. The flight model claim is true; the ballistics and damage claims are not. src/shared/combat/ ships ballistics.ts, penetration.ts, damage.ts, drag.ts, proxy.ts, explosion.ts and fire.ts, and OfflineSandbox imports none of them — it hand-rolls its own gunnery, ballistics and component damage. Offline behaviour therefore diverges from online, which is the exact opposite of the stated design goal, and any tuning done in the sandbox does not transfer.

_Fix:_ Import the shared combat module for projectile integration, penetration and damage resolution. If it is missing something the sandbox needs, say so in the report rather than forking it silently.

**src/game/env.ts**

ClientEnv.windAt produces a seeded, altitude-sheared, gusting wind field of 2.5-7.5 m/s with per-3km-cell gust cells and a vertical component. The server (server/index.ts line 53) returns a constant `out.x = 3.2; out.y = 0; out.z = 1.1`. This file's own comment says 'The client must reproduce the server's environment closely or prediction diverges every frame and the reconciliation blend never settles' — and it does not. Every replayed input integrates against a different air mass than the server used, so there is a permanent nonzero residual on every snapshot and the smoothing offset never decays to zero. ClientEnv also implements surfaceType() while the server's Env interface has no such member, so ground friction on rollout differs between prediction and authority.

_Fix:_ Move the wind model into src/shared (or match the server's constant exactly) so both sides evaluate identical code, and either add surfaceType to the server Env or drop it client-side. Flag the server-side change in the report — you cannot edit server/ yourself.

**src/game/FlightSystem.ts**

reconcile() replays pending inputs with `const fdt = clamp(f.dt, 0.002, 0.05)` — the client's frame delta. The server consumes one queued input per tick and always steps stepFlight with TICK_DT (server/Room.ts line 315). src/shared/flight/index.ts states explicitly: 'every tick, with the tick's dt (do not use input.dt)'. On a 144 Hz client the replay integrates roughly 2.4x more inputs over 2.4x less time each than the server will, so the replayed 'now' is systematically wrong and the hard/soft thresholds are being tuned against an artefact.

_Fix:_ Import TICK_DT from the protocol and replay with it, matching the server exactly. The client should also throttle input generation to the tick rate or coalesce, so the pending queue maps 1:1 onto server ticks.

**src/game/FlightSystem.ts**

airData.stall probes readFlightScalar(f, ['stall'], 0). FlightState has no `stall` field — it has `stalled: boolean`, `stallL: number` and `stallR: number`. The getter therefore returns 0 forever and any HUD stall cue driven off it is permanently dead. This is the failure mode of nominal probing that externals.ts's own header warns about, and it is silent by construction: readFlightScalar returns the fallback rather than throwing.

_Fix:_ Probe ['stallL'] / ['stallR'] (or read `stalled`), and add a one-time console warning when a probed key set resolves to the fallback so the next mismatch is not silent.

**src/game/OfflineSandbox.ts**

step() line 199 allocates a fresh array plus six object literals every single frame: `const targets = this.actors.map((a) => ({ state: a.state, spec: a.spec, alive: a.alive }))`. Brief rule 5 makes this a correctness failure, not a style note — it is 360 short-lived objects per second feeding the nursery in the hot path.

_Fix:_ Hoist a preallocated targets array of six mutable records and refresh their fields in place.

**src/game/visual/Debris.ts**

update() allocates an object literal per debris item per frame: `this.env.windAt({ x: o.position.x, y: o.position.y, z: o.position.z }, _wind)` (line 152). At 56 active items that is 3360 allocations/second. The same method also runs `this.items.some(...)` and `this.items.filter(...)` every frame, and detach() runs `this.items.filter((i) => i.live).length` plus four clone()/new Vector3() calls. EntitySystem.syncEntities additionally allocates `[...this.active.keys()]` every frame (line 341).

_Fix:_ Hoist a module-level scratch V3 for the windAt argument. Replace the filter/some churn with an in-place swap-remove compaction over a fixed-size array, and iterate this.active directly with a deferred removal list instead of spreading the key set.

### Missing from brief

- damageParts from the real builder is never consumed, so the entire structural-damage visual (outer wing panels, tailplanes, fin, canopy glass) never comes off — the parts that ARE shed (wingtipL/R) are empty anchors with no geometry
- setControlSurfaces / setGear / setPropeller / setWheelSpin / setDamage / detachPart / addBulletHole — the complete animation API the aircraft agent exported and documented in src/assets/aircraft/index.ts — is entirely bypassed and reimplemented incorrectly
- model.parts (all objects sharing a part name across every LOD level) is never used, so LOD1/LOD2 are static, undamaged airframes
- EntityFxRegistry.attach(entityId, model, damageBits) in src/vfx/EntityFx.ts is annotated 'Called by the entity system so we can use real model anchor points' and is never called — contrails, wingtip vortices, prop-tip trails and exhaust lose their real anchors
- src/shared/combat (ballistics.ts, penetration.ts, damage.ts, drag.ts, proxy.ts, explosion.ts, fire.ts) is not imported anywhere in OfflineSandbox despite the file comment claiming it runs 'the same ballistics ... the server does'
- buildAllAircraft(onProgress) — the documented async prewarm with progress reporting — is bypassed, so the boot bar cannot move during the ~1s-per-type template build
- Brief rule 5 (no allocation in hot loops) is violated in three places; brief art rules forbid unshaded default-three materials, but GroundScarField uses MeshBasicMaterial
- ParachuteField.despawn() exists and is never called by EntitySystem


---

## combat — **CLOSE**

`npx tsc --noEmit` is clean for the whole project and `npx tsx src/shared/combat/selftest.ts` is 76/76 green — I ran both. This is not stub work: the G1 drag table, the cavity-expansion penetration model, Recht–Ipson residuals, Gurney fragmentation with a normalised fragment budget, the ordered module walk and the 76 assertions are all real, and I found no TODOs, no placeholder returns and no "good enough" shortcuts dressed up as complete. Three of the four penetration calibration figures in the header reproduce exactly when you call the function. That said, I verified four defects empirically that stop this shipping as-is. (1) Lag compensation is silently defeated by the exact broadphase the report tells the integrator to write: `sweepTarget` tests the *rewound* transform while every implementation of the documented `queryTargets` contract culls against the target's *current* one; with a textbook segment-vs-sphere cull and 250 ms of rewind on a 200 m/s target, the hit is dropped. The selftest only passes because its `makeEnv` returns every aircraft. (2) `stepAaGuns` calls `solveBallisticLead` for every gun every frame unconditionally — measured 1.02 ms/call for an 88 at 6 km, so four heavy guns is 4 ms/frame and a dozen is 12 ms of a 16.6 ms budget, and it runs during the reaction delay, during burst pauses and when the gun is out of ammo. (3) `computeDamageEffects` rolls the aircraft the wrong way when a wing departs — measured +0.16 (roll right) for a lost *left* wing, contradicting the comment directly above it and the `cgShiftX` in the same function. (4) Every damage-over-time kill — fire, engine overheat, oil starvation, cook-off, spar folding — is credited to player 0; I burned an A6M5 down after hitting its tank with API and `st.killer === 0`. Since fire and spar failure are this model's two signature kills, most kills in the game would award nothing. Also confirmed: 15 `terrainHeight()` calls per bullet per tick for rounds at 4 km over flat sea (165k/tick at the report's own 11k-round load), and a Box–Muller spare cached in a module-level variable that leaks across RNG instances and breaks the file's stated determinism guarantee. On the brief itself: nothing here addresses art direction because nothing here renders, which is correct — but `ctx.quality`/`ctx.settings` are never consulted anywhere (rule 5 requires it), and no `Subsystem` is implemented (rule 4), which the report should have flagged as an integrator requirement rather than leaving silent.

### Blockers

**/Users/paulius/Dev/cel-thunder/src/shared/combat/ballistics.ts**

Lag compensation is silently defeated by the broadphase the report itself prescribes. `stepProjectiles` queries `env.queryTargets(p.p, _frameEnd, FRAME_QUERY_PAD=14, ...)` and `resolveSegment` queries with pad=2, but `sweepTarget` then tests the target at `atTime - p.rewind`. The documented contract for `queryTargets` ('targets whose bounding sphere could overlap the segment') can only be implemented against the target's CURRENT transform, so the rewound aircraft is culled before it is ever swept. Verified: with a textbook segment-vs-current-sphere cull, a 200 m/s target and 250 ms rewind (50 m of displacement vs a 14 m pad), the lag-compensated hit is dropped — hit=false. The selftest's `makeEnv` pushes every target unconditionally, so the whole lag-comp test section passes while the shipping path is broken. Note also that `FRAME_QUERY_PAD`'s comment ('must cover the largest aircraft bounding radius') contradicts the `CombatEnv.queryTargets` doc comment, which says the target's own bounding sphere is already accounted for — an integrator cannot tell which semantics to implement.

_Fix:_ Make the rewind displacement explicit in the query. Either add a `time` argument to `CombatEnv.queryTargets` so the integrator can cull against the history ring, or compute `pad = FRAME_QUERY_PAD + maxRewind * MAX_TARGET_SPEED` (a 300 m/s cap and 300 ms of rewind is 90 m) and pass the same pad to the inner `resolveSegment` query instead of the hardcoded 2. Then fix the two contradictory doc comments so `pad` has one defined meaning, and change the selftest's `makeEnv` to a real segment-vs-sphere cull so this can never regress unnoticed.

**/Users/paulius/Dev/cel-thunder/src/shared/combat/aa.ts**

`stepAaGuns` calls `solveBallisticLead` for every gun on every frame before any fire-control gating. Each call runs 3 passes x up to 8 secant evaluations, each of which is a full trajectory integration of up to 4000 RK2 steps with `airDensity`/`speedOfSound`/`cdG1` lookups per step. Measured on this machine: 1.021 ms/call for AA_HEAVY at a 6 km slant, 0.101 ms/call for AA_LIGHT at 1.2 km. Four 88s around a bridge is 4 ms/frame; twelve is 12.2 ms of a 16.6 ms budget, before the renderer draws anything. Worse, the solve happens unconditionally — the `reactionLeft > 0`, `pauseLeft > 0` and `ammo === 0` early-outs all sit *after* it, so a battery that is reloading or has not yet reacted still pays full price, as does a gun with an empty magazine. This directly violates brief rule 5 ('performance is a correctness requirement').

_Fix:_ Gate and cache: move the `reactionLeft`/`pauseLeft`/`ammo` checks above the solve; store `aimSolution`/`solutionTof`/`solveAge` on `AaGun` and re-solve at 4-10 Hz rather than 60, extrapolating the aim point with `target.v` in between; seed the secant search from the previous frame's `elev` instead of the line-of-sight angle (one or two iterations instead of seven once locked on); and drop `maxTof` from the blanket 40 s to something derived from the gun's `maxRange` and `muzzle`.

### Majors

**/Users/paulius/Dev/cel-thunder/src/shared/combat/damage.ts**

Sign error in the asymmetric-lift roll moment. `fx.rollMomentAdd = (wl - wr) * -0.16` yields +0.16 when the LEFT wing is gone (wl=0, wr=1). `types.ts` defines positive as 'rolls the aircraft right (toward +X)', so the aircraft rolls away from the missing wing — backwards. The comment two lines above the code states the correct behaviour ('a dead left wing gives a negative moment'), and `cgShiftX` in the same function correctly shifts +1.235 m to the right for the same case, so the rest of the function agrees with physics and only this line does not. Verified by calling `computeDamageEffects` with `wingOff[0] = true`. Untested — nothing in the 76 assertions checks the sign, and no flight-model code consumes `rollMomentAdd` yet, so this will only surface as 'losing a wing feels wrong' during integration.

_Fix:_ Drop the negation: `fx.rollMomentAdd = (wl - wr) * 0.16;`. While you are there, re-derive `yawMomentAdd` the same way — a missing left wing removes left-side drag and should yaw toward the surviving wing, but the code applies -0.05 (yaw left); add a selftest asserting both signs against a stated convention.

**/Users/paulius/Dev/cel-thunder/src/shared/combat/damage.ts**

Damage-over-time kills are credited to nobody. `stepDamage` passes `st.killer` / `st.killerEntity` as the attacker for engine overheat damage, dry-bearing damage, fire damage, ammo cook-off `ripWing` and g-overstress spar damage — but those two fields are only ever written inside `kill()`, so they are 0 (player 0 / world) right up until the aircraft is already destroyed. Verified end to end: hit an A6M5's fuselage tank with API as player 77 / entity 5, break off, let it burn — `destroyed = true, killer = 0, killerEntity = 0`. Fire and spar folding are the two signature kill mechanisms this whole model is built around, so the majority of kills in a match would award no credit, produce a blank killfeed entry and break scoring.

_Fix:_ Add `lastAttacker` / `lastAttackerEntity` / `lastAttackerTime` to `AircraftDamageState`, set them in `applyDamage` alongside `lastHitTime`, and use them (not `st.killer`) as the `by`/`byEntity` arguments throughout `stepDamage`. Apply a credit timeout (~30 s since the last hit) after which it falls back to 0, which is the usual convention.

**/Users/paulius/Dev/cel-thunder/src/shared/combat/ballistics.ts**

`terrainCrossing` is called once per substep and issues 1 + 4 sample calls plus 6 bisection calls to `env.terrainHeight`, with no altitude early-out whatsoever. Measured: 1000 bullets fired at 4 km altitude over terrain that is flat at y=0 cost 15,000 `terrainHeight()` calls in a single 1/60 s tick — 15 per round per tick for ground that is 4 km below them. Scaled to the report's own 11k-round figure that is 165,000 procedural terrain samples per tick doing nothing. For a 64 km procedural world `terrainHeight` is not a free function.

_Fix:_ Add a `maxTerrainY` (or `terrainMaxHeight(x0,z0,x1,z1)`) to `CombatEnv` and bail out of `terrainCrossing` immediately when `Math.min(p0.y, p1.y) > maxTerrainY`. Also hoist the single `p0.y - terrainHeight(p0)` probe out of the substep loop by carrying the previous substep's ground clearance forward. (Separately, `prevD` in that function is assigned and never read — dead.)

**/Users/paulius/Dev/cel-thunder/src/shared/combat/ballistics.ts**

The Box–Muller spare is cached in module-level state (`_gaussSpare`/`_hasSpare` in ballistics.ts, `_spare`/`_hasSpare` in aa.ts) that is not keyed to the generator that produced it. `createProjectile`'s rocket-misalignment path draws an ODD number of normals (`Math.abs(gauss(init.rng)) * misalignSigma`), so it leaves a leftover normal derived from the rocket-launcher's RNG for whatever generator asks next. Verified: launching a rocket with `new Rng(777)` changes the result of a subsequent `scatterDirection` on `new Rng(4242)` from -0.00635964 to -0.00777338. This breaks the determinism guarantee the module's own header claims ('the authoritative server can run the exact same code as the client's prediction layer') — the client, which does not simulate every entity, will see a different call ordering than the server and diverge. The two `_hasSpare` variables are also cross-contaminating between AA guns that each carry their own 'deterministic per-gun RNG'.

_Fix:_ Store the spare on the `Rng` instance (add a `spare?: number` field, or a tiny `gaussFrom(rng)` helper that keeps a `WeakMap<Rng, number>`), or switch to a polar-method draw that returns both normals to the caller in one call so nothing is ever cached across call sites.

**/Users/paulius/Dev/cel-thunder/src/shared/combat/ballistics.ts**

No friendly-fire or self-damage control on the projectile detonation path. `detonate()` constructs `ExplosionParams` without `noFriendlyFire` and without `ignoreEntity`, and `ProjectileInit` exposes no field to set either, so `applyExplosion`'s support for both is unreachable from the only code path that actually fires ordnance. Consequences: a rocket that functions on a target 20 m ahead frags the launching aircraft and its wingmen with no opt-out, and a server running friendly-fire-disabled has no way to disable blast/fragment damage for any shell, bomb or rocket burst.

_Fix:_ Add `noFriendlyFire?: boolean` and `selfImmuneUntil?: number` (or reuse `ignoreUntil`) to `Projectile`/`ProjectileInit`, thread them into the `ExplosionParams` that `detonate()` builds, and default `ignoreEntity` to `p.shooterEntity` while `p.t < p.armTime`.

### Missing from brief

- Hard rule 4 — no `Subsystem` is implemented anywhere in src/shared/combat/ (no `name`, no `init`, no `update`). The sibling `src/shared/flight/` sets the same precedent and hard rule 1 forbids touching the central integration points, so this is defensible for a shared sim module — but the report should have listed 'the integrator must write the CombatSubsystem wrapper' as a required hand-off item, and it does not.
- Hard rule 5 — `ctx.quality` and `ctx.settings` are never consulted. Every quality tier pays identical simulation cost: the same `MAX_SUBSTEP_M`/`MAX_SUBSTEPS`, the same 120-fragment-per-module cap, the same 24-target explosion cap, the same per-frame AA ballistic solve. A 'low' tier on integrated graphics has no lever to pull. At minimum the substep granularity, the AA solve rate, the fragment cap and `ProjectileInit.rewind` fidelity should scale with `ctx.quality`.
- Hard rule 5 — the report's own performance numbers are quietly over budget and are never stated as a client-side constraint. 10.5 ms/tick for 11k rounds with a sphere cull is 63 % of a 60 fps frame on the server alone; the module is explicitly designed to also run in the browser prediction layer, where that plus rendering cannot fit. Nothing in the module caps total projectile count, and `ProjectilePool` grows to 4096 without any global budget.
- No integration contract for VFX beyond three scalars. `HitResult` carries `type`/`module`/`normal`, and `DamageEffects` carries `smokeBlack`/`smokeWhite`/`fireIntensity`, but nothing emits per-frame tracer state (`tracerTime`/`tracerColor` are stored on the projectile and never surfaced), no damage-trail or fuel-streak descriptor, and no hit-decal placement in body space — so the VFX layer has to re-derive all of it. Given the brief's insistence on legible weathering and staining, the damage model should be handing the renderer body-space hole positions it already computes and throws away.
- Bomb and rocket loadouts remain unreachable: `bombSpecFor`/`rocketSpecFor` return null for all five archetypes. The report correctly identifies this as a one-line change in aircraft.ts (out of scope), but it means the entire ordnance.ts path — roughly 320 lines including the bombsight predictor and the salvo helper — is untested against any real aircraft and unreachable in-game today.


---

## render — **NOT_SHIPPABLE**

The frame graph is genuinely well-constructed and the prose in the comments is better than the code it describes. tsc is clean, the pass ordering argument is right, the bloom pyramid, HBAO and the plane-rejection ink cue are real techniques competently implemented, and the procedural LUT is the best thing in the submission. But three defects will be visible in the very first screenshot. (1) DOF as tuned defocuses the entire world: focus is locked to the player's aircraft at 21-46 m in chase and ~2 m in cockpit, and cocOf() saturates at 0.42 for anything past ~3x focus, so smoothstep(0.06,0.5,0.42)=0.87 blends 87% of a 13 px blur over every background pixel. The frame will read as a tilt-shift miniature, and the code comment claiming "180 m to 800 m acceptably sharp at 300 m" is arithmetically false. (2) The prepass skips every transparent and alpha-tested object, which in this repo means the water (transparent:true) and all vegetation (alphaTest:0.42). Those pixels land in the gbuffer as sky at the far plane, so the sea and every tree get far-plane CoC blur, no ink, no AO, sky-reprojected motion blur, and holes in the depth texture VfxSystem consumes. (3) RenderSystem owns a depth texture and never publishes it on the `render:depth` bus event SkySystem explicitly documents and listens for, so SkySystem re-renders the whole scene depth-only every frame; combined with the double-sided prepass, the shadow map and the main pass that is four full geometry submissions per frame against a "60 fps on integrated graphics" requirement. On top of that, the advertised tune() art-direction API is largely dead — seven of its knobs are overwritten by lateUpdate on the next frame — and the shadow texel snap is defeated by a fit radius that changes continuously with camera distance, so shadow edges crawl exactly as the snapping was written to prevent. The report is confident and detailed but its "known gaps" section omits every one of these.

### Blockers

**src/render/passes/DofPass.ts**

DOF defocuses the entire world in every default camera. RenderSystem.focusDistance() returns the distance to the player's own aircraft — 21-46 m in chase (camera/framings.ts distances) and ~1-3 m in cockpit view. cocOf() = (z-focus)/z * 0.42 saturates to 0.42 for any z >> focus, and COMPOSITE_FRAG blends with smoothstep(0.06, 0.5, 0.42) = 0.87. So 87% of a ~13 full-res-pixel blur is applied to everything past ~60 m: terrain, sea, other aircraft, horizon. In cockpit view focus ~2 m makes it total. DOF is on by default at high and ultra (settings.dof true, PROFILES.high/ultra.dof true). The header comment's claim that a 300 m subject keeps 180-800 m sharp is wrong: at z=800, focus=300 the blend is already 0.55.

_Fix:_ Replace the ad-hoc CoC with a real thin-lens term that goes to zero past the hyperfocal distance: coc = A*f*|z-focus| / (z*(focus-f)) with a sane f-number, or at minimum multiply the background CoC by (1 - smoothstep(focus*3, focus*12, z)) so distant terrain returns to sharp, and cap the composite blend for positive CoC at ~0.35. Additionally, force DOF strength to ~0 when CameraSystem is in 'cockpit'/'gunsight' mode, and stop using the raw aircraft-origin distance as the focus target in cockpit view.

**src/render/passes/DepthNormalPass.ts**

The prepass skip filter (`m.transparent === true || m.alphaTest > 0`) removes the water plane (src/world/Water.ts:62 transparent:true) and all foliage cards (src/world/Vegetation.ts:206 alphaTest:0.42) from the gbuffer. Those pixels therefore hold the clear value — depth = far, id = 0, normal = degenerate. Consequences, all visible: the whole sea and every tree take far-plane DOF blur while the ground behind them is comparatively sharp; InkPass early-outs on them (gc.b > SKY) so there is no coastline ink and no tree outlines; AoPass writes ao=1 so no contact occlusion under any tree; MotionBlurPass takes the sky reprojection branch for them; and the depthTexture exposed to VfxSystem has holes, so soft particles will not fade against water or foliage. In a game flown over a 64 km coastal map this is a large fraction of every frame.

_Fix:_ Alpha-tested opaque geometry belongs in the prepass. Add a second override material variant with USE_ALPHATEST that samples the object's map and discards, and only skip materials with `transparent === true && blending !== NoBlending`. Give the water an explicit `userData.forcePrepass = true` (or a depth-only variant) so the sea surface writes linear depth and a normal. The current `forcePrepass` opt-in exists but nothing in the repo sets it.

**src/render/RenderSystem.ts**

RenderSystem never emits `render:depth`. SkySystem.ts:332 registers a bus handler for exactly that event and SkySystem.ts:385 falls back to `renderDepthPrepass(ctx)` — a full depth-only re-render of the entire scene — every frame that volumetric clouds are on (default true). Together with the prepass (which additionally runs `side: DoubleSide`, disabling backface culling for every opaque object) and the shadow map, that is four full geometry submissions per frame plus the inverted-hull outline children that double the draw count on every aircraft. The brief makes 60 fps at 1080p on integrated graphics a correctness requirement; the 149 fps figure in the report was measured on hardware that hides this.

_Fix:_ Emit `ctx.bus.emit('render:depth', { texture: this.prepass.depthTexture })` in init() and again after every reallocate() (the DepthTexture object survives setSize, but re-emit to be safe). That deletes an entire scene pass. Separately, drop `side: THREE.DoubleSide` on the prepass override material and rely on per-material sides, or restrict double-siding to objects that actually need it.

### Majors

**src/render/RenderSystem.ts**

The advertised live art-direction API is mostly non-functional. lateUpdate overwrites the uniforms every frame: InkPass.update() rewrites uWidth (line 108) and uAOStrength (line 110); RenderSystem.ts:351 rewrites uOpacity; RenderSystem.ts:389 rewrites uContrast; and GradePass.setFeature() — called four times per frame from RenderSystem.ts:385-388 — resets uLutAmount, uVignetteAmount, uGrain (to the literal 0.016) and uChromatic (to the literal 1.9). So tune('ink','width'|'opacity'|'aoStrength') and tune('grade','contrast'|'grain'|'chromatic'|'lutAmount') all revert one frame after they are set, while returning true and printing nothing. Seven of the twenty-three documented knobs are dead.

_Fix:_ Store the tuned values as fields on RenderSystem (or make the passes own authoritative base values that update()/setFeature() scale rather than assign), and have setFeature multiply by a stored base instead of writing a literal. tune() must be the single writer for any parameter it exposes.

**src/render/passes/ShadowRig.ts**

Texel snapping is defeated by a continuously varying fit radius. Line 139: radius = clamp(subjectDist*0.45 + 90, 110, 1500), and line 171: texel = 2*radius/size. subjectDist changes every frame in a chase camera (spring damping, framing blends), so the snapping grid itself moves every frame and _p snaps to a different lattice each time. The whole point of the snap — quoted in the class comment as removing 'the last source of sub-texel swimming' — is nullified; shadow edges will crawl whenever the camera dollies, which is constantly. Related: at high sun elevation _snapHelper.lookAt(_focus) with up=(0,1,0) is near-degenerate (light direction parallel to up), so three's fallback perturbation flips the snapping basis and adds a second source of jitter around solar noon.

_Fix:_ Quantise the radius before deriving the texel: e.g. radius = pow(2, ceil(log2(rawRadius))) or snap to a 64 m step with hysteresis, and only re-fit when the raw value leaves the current bucket. For the zenith case, pick the helper's `up` from whichever world axis is least parallel to ctx.sunDir instead of always (0,1,0).

**src/render/passes/InkPass.ts**

Grazing-angle gating removes ink from most of the ground plane. `facing = smoothstep(0.06, 0.26, ndv)` zeroes the `hard` silhouette shortcut, and `crease` is separately multiplied by smoothstep(0.10, 0.36, ndv). ndv is |N·V|, which for level flight over terrain equals roughly the sine of the depression angle — below about 15 degrees both cues are gone. That is the entire mid-to-far ground plane and the horizon band in a typical flight frame. Meanwhile the plane-rejection tolerance (`tol = uDepthSens*zc + grad*1.35 + 0.04`, with grad up to 5*zc after the zc*6 clamp) already suppresses depth edges there. Net effect: ridgelines, terrain silhouettes, runway and building edges against grazing ground lose their outlines exactly when terrain fills the frame — the cel look drops out on low passes, which are the game's signature shots.

_Fix:_ Do not gate the silhouette cue on `facing` alone. Keep the plane-rejection test (which already handles grazing correctly by widening tolerance) and reserve `facing` only for the crude `hard` ratio shortcut, or replace the shortcut with a second-derivative test (compare the neighbour against the plane predicted from the neighbour's own normal as well) so real occlusion boundaries survive at low incidence. Verify with a screenshot at 200 m AGL looking toward the horizon.

**src/render/passes/DepthNormalPass.ts**

Velocity history is only refreshed for objects that survive frustum culling in the prepass, because the latch lives in material.onBeforeRender (line 176-179), which only fires for objects that are actually drawn. Any object re-entering the frustum reprojects through a stale matrixWorld from however many frames ago and produces the maximum-length smear on its first visible frame — a fighter entering frame from the edge streaks. There is also no camera-cut detection: the game's framing system cuts between chase, flyby, orbit and cinematic rigs, and on every cut the sky branch of MotionBlurPass reprojects through a completely unrelated matrix, giving a full-strength 4.5%-of-screen smear on the first frame after every cut.

_Fix:_ Update prevMatrices for the whole candidate set in a cheap CPU sweep (you already traverse the scene for the hide/skip pass) rather than in onBeforeRender, so culled objects stay current. For cuts, compare the camera's world position/quaternion delta against a threshold in lateUpdate and set mbOn=false for that frame, the same way firstFrame is handled.

**src/render/passes/GradePass.ts**

The vignette is neither subtle nor radial, contrary to the brief's 'subtle vignette'. `vd = d * vec2(uAspect, 1.0)` then `smoothstep(0.62, 1.28, length(vd)*2.0)`: at the horizontal midpoint of the left/right edge length(vd)*2 = 1.78, fully saturated, so a 28% darkening (uVignetteDark 0.72) plus desaturation covers the outer third of the frame on both sides while the top and bottom edges only reach ~0.53. The result is two dark vertical bands rather than lens falloff. Chromatic aberration is also on the strong side — at the extreme corner the R/B split is ~9 px at 1920 (shift 0.00475 UV), which reads as a filter rather than as glass.

_Fix:_ Normalise by the corner radius (divide length(vd) by length(vec2(uAspect,1.0)*0.5)) so the falloff is isotropic and hits 1.0 only at the corners, move the inner edge out to ~0.85 and lift uVignetteDark to ~0.82. Halve uChromatic to ~0.9.

### Missing from brief

- Nothing publishes the depth buffer to the rest of the engine: SkySystem documents and listens for a `render:depth` bus event that RenderSystem never emits, so an entire redundant scene pass runs every frame.
- No exposure control of any kind — celGlobals.uExposure is a constant 1.0 with no adaptation, despite a full day/night cycle in ctx.timeOfDay and a moon-retargeted key light after dusk.
- The colour grade is time-of-day agnostic: one baked 32³ LUT for noon, dusk and night.
- No cockpit near-clip pass, although src/engine/camera/modes.ts:104 defines a near clip specifically for it and CelMaterial defines LAYER_COCKPIT as 'rendered with a separate near-clip pass'. Cockpit geometry currently shares the 0.35 m near plane with the whole 120 km scene.
- LAYER_INK is defined by the codebase and consumed by src/assets/aircraft/build.ts but is functionally ignored by the ink pass — hero objects get no different treatment from terrain.
- No camera-cut detection for motion blur, in a game whose framing system (src/engine/camera/framings.ts) cuts between ten cinematic rigs.
- Report's integration note #3 requires sky and bloom objects to be on their layers 'exclusively', but every call site in the repo uses layers.enable() (TracerRenderer.ts:198, Particles.ts:162, SkySystem.ts:283, VolumetricClouds.ts:899), so all of them remain on layer 0 too. The requirement is stated but not met, and the prepass only avoids drawing them by accident, because their materials happen to be transparent.
- Per-instance and per-bone velocity is untracked (acknowledged), which means InstancedMesh scatter and any animated skinned geometry reproject through the parent matrix only.


---

## flight — **CLOSE**

This is real work, not a stub. I read all 4,531 lines: there are no TODOs, no placeholders, no "good enough" shortcuts dressed up as complete. The strip-theory aero, the implicit prop/induced-velocity coupling, the Goman-Khrabrov separation with hysteresis, the blade-element crankshaft with backward-Euler linearisation, the taildragger ground loop falling out of tyre forces ahead of the CG — all of it is genuinely derived rather than scripted, and the sign conventions are consistent throughout. `npx tsc --noEmit` is clean across the whole repo (0 errors), and `npx tsx src/shared/flight/selftest.ts` is 446/446 as claimed.

The problem is that the report's two headline claims are both measured against a strawman, and there are four concrete behavioural bugs that will show up in the first hour of playtesting.

PERFORMANCE. The "~3-8 µs per aircraft-tick, >1000 aircraft on one core" number was benchmarked against `flatEnvironment()`, whose `terrainHeight` is `() => groundY` and whose `terrainNormal` is a constant. I instrumented the real `Environment` and counted: **31 `terrainHeight` + 30 `terrainNormal` calls per aircraft per tick while cruising at 6,000 m**. The hardpoint loop in `gear.ts` (9 points) and the prop-strike block run unconditionally every substep with zero AGL early-out — an aircraft at 6 km is doing 60 terrain samples a frame to discover it is not touching the ground. Swapping in a cheap 5-octave procedural terrain + central-difference normal takes the step cost from 5.68 µs to **14.45 µs**, a 2.5× regression, and a real streaming heightfield with bilinear taps will be considerably worse than my toy. The brief says performance is a correctness requirement; a one-line `if (st.agl > 12) skip` guard around the hardpoint and prop-strike blocks recovers all of it.

FLIGHT PERFORMANCE / BALANCE. The report says sea-level top speeds run "~5-12 % below" history. Measured: Spitfire IX 446 km/h SL / 569 at FTH (real ≈510/655), P-51D 476 SL / 623 at FTH (real ≈575/703) — that is 11-20 % low, not 5-12. Worse, the *ordering* is wrong for gameplay: the Bf 109 G-6 (519 SL / 672 FTH) and the La-5FN (513 SL) both comfortably out-run the P-51D at every altitude. The boom-and-zoom archetype being the slowest fast aircraft in the set is a balance failure that should have been escalated in bold, not filed under "known gaps" with a 5-12 % figure that understates it by half.

BUGS. Lowering flaps 40 km/h over the limit sets `DamageBits.Aileron` (`controls.ts:84`) — I confirmed `st.dmg.aileron === 0`, i.e. a routine flap mistake permanently and irrevocably removes all roll control for the rest of the sortie. `placeOnGround` resets neither `damage`, `health`, `gFatigue`, `koTimer` nor `pilotConscious` (verified: a wrecked state comes back from the runway spawn still wrecked, unconscious, with a ripped wing) while `spawnInFlight` *does* reset damage and health — two spawn helpers with opposite semantics and no documentation of the difference. A G-LOC swaps in `_zeroInput`, which drives `throttleCmd` to 0: I measured the throttle collapsing to 0.00 during 245 KO ticks while the player held full throttle, and because `prevBits` is also zeroed, every held momentary bit fires a spurious rising edge on recovery (gear cycles, WEP toggles). And `touchdownVs` is a monotonic all-time maximum that nothing ever resets, despite being documented as "vertical speed of the last touchdown".

ROBUSTNESS. `gear.ts` and `step.ts` call `env.terrainNormal(x, z, _n)` / `env.windAt(pos, _wind)` and then read the scratch vector, discarding the return value. The project's own adapter in `src/game/externals.ts:230` explicitly handles world modules that return a *different* vector than the `out` they were handed — against such an implementation every ground contact silently uses a stale normal. Use the return value.

INTEGRATION. The report tells the integrator to `readEntityState` on a snapshot and replay, but `readEntityState` restores only pos/vel/rot/damage/health/flaps/gear — not `omega`, `engOmega`, `bladePitch`, `sep[]` or `downwashLag`, none of which are in the wire protocol. That is a protocol limitation, not the model's fault, but it is exactly the kind of thing the brief asks you to raise with the integrator, and it was not raised. Meanwhile `src/game/FlightSystem.ts:295` already replays with `clamp(f.dt, 0.002, 0.05)` while `server/Room.ts` steps with `TICK_DT` — the "pass TICK_DT on both sides" contract is already violated by the existing consumer, and the model offers no fixed-step wrapper or assertion to make the correct usage the easy one.

HYGIENE. `selftest.ts` calls `main()` and `process.exit()` at module scope and lives in `src/shared/flight/`, which both `src/game/externals.ts:134` and `src/engine/input/aircraftView.ts:512` sweep with `import.meta.glob('../shared/flight/*.ts')` — and `aircraftView.ts` fires a dynamic import for *every* matched path. The ReferenceError is swallowed by a `.catch`, so nothing breaks today, but ~900 lines of Node-only test harness is being pulled into the client bundle graph and speculatively executed in the browser on every page load. Move it to `tools/` or guard it behind an explicit entry check.

Nothing here is art-directed, so the cel-shading and shader rubric mostly does not apply. The one visual defect the model owns is that `state.pos` is the CG, and losing a wing moves the CG 0.237 m laterally in a single tick (measured), so the rendered mesh origin pops sideways at the exact moment the player is looking at the wing coming off.

Fix the terrain-query guard, the aileron bit, the spawn resets and the G-LOC throttle and this ships. The physics underneath is the best part of it.

### Blockers

**src/shared/flight/gear.ts**

`applyGroundContact` runs the 9-hardpoint loop and the propeller-strike block unconditionally on every substep, with no AGL early-out. Each hardpoint costs one `env.terrainHeight` plus one `env.terrainNormal`. Instrumented at 6,000 m cruise: 31 terrainHeight + 30 terrainNormal calls per aircraft per tick — i.e. ~60 terrain samples a frame to establish that an aircraft six kilometres up is not scraping its wingtip. The report's "3-8 µs / >1000 aircraft" benchmark hides this entirely because `flatEnvironment.terrainHeight` is `() => groundY` and `terrainNormal` is a constant write. Substituting a modest 5-octave procedural terrain with a central-difference normal takes the step from 5.68 µs to 14.45 µs (2.5x); a real streaming heightfield with bilinear taps will be worse still. The brief makes performance a correctness requirement.

_Fix:_ Gate the hardpoint loop and the prop-strike block on proximity: compute `agl` once per substep (one terrainHeight at the CG) and skip both blocks entirely when `st.agl > maxHardPointReach + margin` (roughly span/2 + 2 m). Cache the CG-local terrainHeight/terrainNormal for the frame and reuse it for all 9 hardpoints and 3 legs unless they are more than a few metres apart in XZ — over a runway or open field one sample is exact and the error elsewhere is far below the strut travel. Then re-run the benchmark against a representative terrain sampler, not `flatEnvironment`, and publish that number.

### Majors

**src/shared/flight/controls.ts**

Line 84: exceeding the flap speed limit by more than 18 % sets `DamageBits.Aileron`. `updateDamageFactors` maps that bit to `f.aileron = 0`, so `st.authRoll` goes to zero and the aircraft loses ALL roll control permanently. Verified in a probe: Spitfire at 149 m/s IAS with flaps down for two seconds yields `damage=0x20`, `dmg.aileron=0`. Lowering flaps slightly too fast is the single most common beginner mistake in this genre, and the punishment is an unrecoverable aircraft with no diagnostic feedback. Flap and aileron are different surfaces on different parts of the wing; blowing a flap should not sever the aileron circuit.

_Fix:_ Blown flaps are a flap failure, not an aileron failure. Either add a dedicated failure path (jam `flapsTarget`/`flaps` at the current position and apply the asymmetric drag/lift penalty) or, if you must reuse an existing bit, use `DamageBits.LeftWing|RightWing` for the structural damage to the wing and leave the roll circuit alone. Separately, `d.flapLimit = vne * 0.52` gives the Spitfire 389 km/h IAS against a real limit near 225 km/h, and `gearLimit = vne * 0.62` gives 464 km/h against a real ~257 km/h — both limits are roughly double reality, so the feature almost never engages until it engages catastrophically.

**src/shared/flight/step.ts**

`placeOnGround` resets rot, vel, omega, gear, cgOffset, pos, engine and fuel, but leaves `damage`, `health`, `gFatigue`, `flutterDamage`, `blackout`/`redout`, `koTimer`, `pilotConscious`, `engineHealth`, `overheat`, `sep[]`, `gearCompress[]`, `trimPitch/Roll/Yaw`, `wepHeat` and `wepLockout` completely untouched. Verified: a state with `WingRipped|LeftWing|Engine`, health 0.1, gFatigue 1 and an unconscious pilot comes back from `placeOnGround` as `damage=0x8041 health=0.1 gFatigue=1 conscious=false`. `spawnInFlight` on the other hand DOES clear `damage` and `health` but not the stall state, fatigue, flutter damage or trims. Two spawn entry points with opposite and undocumented reset semantics; a runway respawn on a recycled FlightState hands the player a wreck.

_Fix:_ Add a single `resetFlightState(st, spec)` that returns every non-geometric field to its `createFlightState` value, and call it from the top of both `placeOnGround` and `spawnInFlight`. Document explicitly in the report which of the two resets damage — right now the integrator has to read the source to find out.

**src/shared/flight/step.ts**

Line 387: `const inp = st.pilotConscious || (st.damage & DamageBits.PilotDead) ? input : _zeroInput;`. Two defects. (a) A G-LOC substitutes an input frame whose `throttle` is 0, so `throttleCmd` goes to 0 and the engine spools down: measured 245 KO ticks during which the throttle fell to 0.00 while the player held 1.0. A pilot who blacks out does not close the throttle — he lets go of the stick. You come round at idle, below stall speed. (b) `_zeroInput.bits === 0` also zeroes `st.prevBits`, so on the frame consciousness returns, every momentary bit the player is still holding (GearToggle, FlapsDown, Boost, Radiator) registers a fresh rising edge and fires. (c) The condition is inverted for the dead case — with `PilotDead` set it passes the LIVE input through; it only works by accident because `dmg.pilot` is 0 there.

_Fix:_ Do not substitute the whole frame. Keep `input.throttle` and `input.bits` (or freeze `bits` at `st.prevBits` so no edges fire) and zero only the three stick axes — which `updateControls` already does via `ph = 0` when `!st.pilotConscious`, so the `_zeroInput` swap is redundant for the axes and harmful for everything else. Simplify to always passing `input` and letting the `ph` gate in `updateControls` do the work, plus an explicit `if (!st.pilotConscious) st.throttleCmd = st.throttle;` to freeze rather than close the throttle.

**src/shared/flight/gear.ts**

Lines 79, 185, 241 (and `step.ts:196`) call `env.terrainNormal(x, z, _n)` and `env.windAt(pos, _wind)` and then read the module-scratch vector, discarding the function's return value. The `Environment` contract declares `out` optional and returns a `V3`, so a conforming implementation is free to return a different vector — and the project's own adapter at `src/game/externals.ts:230` explicitly copes with world modules that do exactly that (`if (r && ... && r !== out)`). Against such a world module every wheel and hardpoint contact silently uses a stale normal from the previous query, which on sloped terrain means wrong normal force direction, wrong friction basis, and aircraft sliding uphill — with no error anywhere.

_Fix:_ Assign the return: `const n = env.terrainNormal(x, z, _n)` and use `n` (same for `windAt`). Costs nothing and makes the model correct against both calling conventions.

**src/shared/flight/step.ts**

`readEntityState` restores only pos/vel/rot/damage/health/flaps/gear. It does not touch `omega`, `engOmega`, `bladePitch`, `throttle`, `ctlPitch/Roll/Yaw`, `sep[]`, `alphaPrev[]`, `alphaRate[]` or `downwashLag` — none of which exist in `EntityState`. The report nevertheless instructs the integrator to "`readEntityState` on a snapshot, then re-`stepFlight` the input queue", which will diverge from the server on every reconcile because the replay starts from the client's own angular rate and separation state. Compounding it, the consumer that already exists (`src/game/FlightSystem.ts:295`) replays with `clamp(f.dt, 0.002, 0.05)` while `server/Room.ts:315` steps with `TICK_DT`, so the substep counts differ and the "bit-for-bit" guarantee in the report is already broken in the shipped call site.

_Fix:_ Two things, both reportable rather than fixable inside the module: (1) tell the integrator explicitly that `EntityState` cannot carry `omega`/engine state and that reconciliation will drift in attitude until the protocol gains at least an angular-velocity field — that is precisely the "anything you need from the integrator" the brief asks for. (2) Export a `stepFlightFixed(st, spec, input, env, elapsed, acc)` accumulator helper that internally quantises to `TICK_DT`, so the correct fixed-step usage is the path of least resistance instead of a comment nobody read.

**src/shared/aircraft.ts**

Measured steady-state top speeds (full throttle, altitude-hold autopilot, 300 s settle): Spitfire IX 446 km/h SL / 569 at 6.4 km (real ≈510/655); P-51D 476 SL / 623 at 7.6 km (real ≈575/703); Bf 109 G-6 519 SL / 672; La-5FN 513 SL. That is 11-20 % low, not the "~5-12 %" the report states, and the relative ordering is broken for gameplay: the P-51D — the designated boom-and-zoom archetype — is the slowest of the three fast fighters at every altitude, beaten by both the 109 and the La-5. This is a balance failure that got filed under 'known gaps' with an understated number.

_Fix:_ You cannot edit `aircraft.ts`, but this needed to be the loudest line in the report, with the measured numbers and the proposed `cd0` deltas attached so the owner can paste them in. Provide the concrete values: solving level flight backwards from the historical figures at critical altitude gives the required `cd0·S`, and a small script over the five archetypes would emit them. Also sanity-check the propulsive side before blaming `cd0` alone — a flat 200 kPa `mapRated` for every engine regardless of `powerKw`, plus the fixed `gearRatio` of 0.50/0.60, means prop efficiency at high speed is not archetype-specific and may be eating several percent on its own.

### Missing from brief

- Hard rule 4 — 'Implement your subsystem's Subsystem interface from src/engine/context.ts'. Nothing under src/shared/flight/ implements `Subsystem` (`name`/`init`/`update`). The report acknowledges this and argues it is a shared library, which is defensible given `src/game/FlightSystem.ts` is the registered subsystem and is owned by someone else — but the brief asked for it and the deviation should have been the first line of the report, not point 6.
- Hard rule 6 — 'Comment the non-obvious. Explain the physics/optics/maths reasoning behind constants.' Mostly met to an unusually high standard, but several load-bearing tuning constants are unexplained magic: `cmqRes = 12.0 * (damp[0]/11.0)` / `cnrRes = 0.09` / `clpRes = 0.12` (derive.ts:198-200) admit the residual damping is 'topping up' strip theory without saying where 12.0, 0.09 and 0.12 came from — and `cmqRes` is large enough that most of the pitch damping is this lumped fudge rather than the emergent tail force the module's header claims. Likewise `flapLimit = vne*0.52` and `gearLimit = vne*0.62` (derive.ts:565-566) are unexplained and produce limits roughly 2x the historical values.
- The brief's 'anything you need from the integrator' section was under-used. Three things needed escalating and were not: (1) `EntityState` carries no angular velocity or engine state, so the reconciliation recipe in the report cannot actually converge; (2) `InputBits` has no trim bits, so `adjustTrim`/`autoTrim` are unreachable for a networked player despite trim being modelled in detail; (3) the existing consumer `src/game/FlightSystem.ts:295` already replays with per-frame `f.dt` rather than `TICK_DT`, silently breaking the determinism contract the report asserts.
- No ground effect. Acknowledged as a gap, but it is the single most visible flight-model omission during the one manoeuvre every player performs every sortie — the landing flare — and it is about fifteen lines (scale induced drag by the standard `(16h/b)^2 / (1 + (16h/b)^2)` factor using the already-computed `agl`).
- Engine restart is not modelled: 'once the engine stops it stays stopped'. In a game with fuel starvation, negative-g cut-out and oil-pressure loss, a dead-stick with no restart attempt turns a recoverable situation into a guaranteed loss and removes a well-known piece of WWII flying.


---

## sky — **NOT_SHIPPABLE**

`npx tsc --noEmit` is clean (exit 0, zero errors anywhere, including OfflineSandbox). The shader work is genuinely strong — real Meeus ephemeris, a real Bruneton-fit scattering LUT, Nubis-style Perlin-Worley density, weighted-mean-energy cel quantisation, MRT + temporal reprojection, analytic height fog. There are no TODOs, no stubs, no `0x00ff00`, no MeshStandardMaterial grey. This is not programmer art.

But the integration is broken in ways that will be visible in the very first screenshot round, and the implementer clearly never read RenderSystem.ts, ShadowRig.ts or camera/framings.ts.

Three blockers:

1. **The scene has no time-of-day lighting at all.** `SkySystem` creates `new THREE.DirectionalLight(0xffffff, 3.1)` and never touches `.color` or `.intensity` again — grep confirms the only writes in the whole repo are in `ShadowRig.update`, guarded by `if (this.owned)`, which is false precisely because the sky supplied the light. Every aircraft and every terrain tile is a `MeshToonMaterial` lit by that light. So midnight, storm and golden hour all render with a full-strength white key. The entire solar/transmittance pipeline the file is built around terminates in `ctx.sunColor`/`ctx.sunIntensity`, which nothing consumes for direct light (`celGlobals.uSunColor` gets the *normalised* colour, so it never dims either). Two lines fix it.

2. **The sky fights the renderer's shadow rig and loses it the texel snap.** `RenderSystem.update` runs `ShadowRig.update`, which does a proper texel-snapped ortho fit centred on the subject aircraft. Then `SkySystem.lateUpdate` → `updateShadowCamera` overwrites `light.position` and `target.position` with an unsnapped point at `camera + fwd*450`, before RenderSystem renders. Result: snapping destroyed (shadow edges crawl every frame — an automatic-fail item in VISUAL_RUBRIC), and the ±radius bounds ShadowRig computed no longer bracket the point the sky moved the light to, so shadows will drop out at altitude.

3. **Weather is unreachable from the screenshot harness.** `camera/framings.ts` defines a `WeatherDirective` per framing; `CameraSystem` broadcasts it on `weather` and `sky:weather`. `SkySystem` listens to neither — it listens to `sky:setWeather`, which nothing in the repo emits, and it *emits* `sky:weather` with an incompatible `{name, transitionSeconds}` payload on the same channel. Every shot the critic loop judges (`clouds`, `sunset`, `damage`, `low`) will render in the default `scattered` preset. The five presets are good; they are dead code.

Beyond those: `settings.renderScale` is ignored (cloud buffers size off `getDrawingBufferSize`, so the primary perf lever does nothing for the most expensive pass); the fallback depth prepass is a third full scene traversal that will never go away because `RenderSystem` has no `render:depth` emit; `cloudDensityAt` does not actually match the GPU field (missing the cloud-type remap and `densityProfile`); `computeEphemeris` allocates ~8 objects per frame in direct contradiction of the file's own "nothing in the per-frame path is allowed to allocate"; the cloud ink contour is measured in low-res texels so its width changes with quality tier and it lags the silhouette through the temporal filter; the star field is sub-pixel with no analytic AA and will crawl; the detail volume stores a 16-cell Worley octave in a 32³ texture (2 texels per cell — that octave is aliasing, not detail); and with `volumetricClouds = false` there is literally nothing in the sky inside 27 km.

Fix 1–3 and this goes to CLOSE fast. As it stands the frames the art director sees will be flat-lit, crawling-shadowed, and the wrong weather.

### Blockers

**/Users/paulius/Dev/cel-thunder/src/render/sky/SkySystem.ts**

The DirectionalLight the sky owns never receives sunColor or sunIntensity. It is constructed as `new THREE.DirectionalLight(0xffffff, 3.1)` at line 308 and thereafter only `castShadow`, `position` and `target` are touched (lines 309-317, 742, 863-866). `ShadowRig.update` does `light.color.copy(ctx.sunColor); light.intensity = ctx.sunIntensity;` but only inside `if (this.owned)` — and `owned` is false exactly because the sky put the light in the scene first. Every world material is a MeshToonMaterial, so its `reflectedLight.directDiffuse` comes from that light. Net effect: sunset, overcast, storm and full night all render the scene under a constant full-strength white key. `ctx.sunIntensity` and the whole sunTransmittance/normalisation path feed nothing. celGlobals.uSunColor gets the max-channel-normalised colour, so the cel rim/spec/terminator tints do not dim at night either.

_Fix:_ In updateSlow(), after computing ctx.sunColor/ctx.sunIntensity: `this.sun.color.copy(ctx.sunColor); this.sun.intensity = ctx.sunIntensity;`. Also publish an unnormalised intensity so the cel materials can dim — or set `celGlobals.uSunColor` to `sunColor * sunIntensity` rather than the normalised hue.

**/Users/paulius/Dev/cel-thunder/src/render/sky/SkySystem.ts**

`updateShadowCamera()` (lines 855-867) runs in the sky's lateUpdate, which executes before RenderSystem's lateUpdate but after RenderSystem.update has already run `ShadowRig.update`. ShadowRig performs a texel-snapped ortho fit centred on the player aircraft (ShadowRig.ts 175-190) and sets sc.left/right/top/bottom to ±radius (110..1500 m) around that focus. The sky then overwrites `light.position` and `light.target.position` with an unsnapped point at `camera + forward*450, y-200`, and places the light only 2500 m back. The ortho bounds still describe ShadowRig's focus. Consequences: (a) the per-frame texel snap is destroyed, so shadow edges crawl and swim every frame — VISUAL_RUBRIC lists shimmering edges as an automatic ≤4; (b) at typical combat altitude the box is centred at camera altitude minus 200 m, i.e. a 2×radius box floating in empty air thousands of metres above the terrain, so terrain and aircraft shadows disappear; (c) the 2500 m light distance clips high casters that ShadowRig's `back = clamp(altitude+1200, 2000, 14000)` was sized to hold.

_Fix:_ Delete `updateShadowCamera` and the call to it. The sky should own the light's direction/colour/intensity; RenderSystem's ShadowRig already owns its placement and frustum and explicitly adopts whatever DirectionalLight the sky provides. If the sky must stay standalone-correct, gate it: only run updateShadowCamera when `ctx.get('render') === undefined`.

**/Users/paulius/Dev/cel-thunder/src/render/sky/SkySystem.ts**

Weather cannot be set by anything in the project. `src/engine/camera/framings.ts` defines a per-framing `WeatherDirective { coverage, cloudBase, cloudDepth, haze, turbidity, windSpeed }`; `CameraSystem.ts:897-899` broadcasts `sky:timeOfDay`, `weather` and `sky:weather` with it when a screenshot framing is armed. SkySystem subscribes to none of them (lines 329-337) — it subscribes to `sky:setWeather`, which is emitted nowhere in the repo, and it *emits* `sky:weather` itself with `{name, transitionSeconds}`, colliding with the harness's channel. So every one of the ten framings the critic loop shoots (`clouds`, `sunset`, `low`, `damage`, ...) renders with the boot default `scattered`, and the five carefully-authored presets are unreachable. VfxSystem already listens to `weather` and honours the directive, so the sky is the only subsystem that ignores it.

_Fix:_ Subscribe to `weather` (and `sky:weather`) and map a WeatherDirective onto the blend state: pick the nearest preset by `coverage`, then override cloudBase / cloudTop (base+cloudDepth) / hazeBoost / windSpeed from the directive. Rename the sky's own outbound notification to `sky:weatherChanged` so it stops colliding. Also subscribe to `sky:timeOfDay` rather than relying on the ctx.timeOfDay diff heuristic at line 434, which silently no-ops on the first frame because `lastPublishedTod` is -1.

### Majors

**/Users/paulius/Dev/cel-thunder/src/render/sky/SkySystem.ts**

`settings.renderScale` is ignored. lateUpdate sizes every sky buffer from `renderer.getDrawingBufferSize()` (line 368), i.e. the canvas. RenderSystem renders the whole scene into sceneRT at `renderWidth = bufferWidth * renderScale` (RenderSystem.ts 211, 230). So at renderScale 0.7 the entire game drops to 49% of the pixels but the cloud march, the temporal history, the god-ray buffer and the sky's own depth prepass all stay at full canvas resolution. The single most effective lever the adaptive governor has does nothing for the most expensive pass in the frame, and the cloud buffer/scene resolution ratio silently changes, which detunes the depth-aware upsample tolerance.

_Fix:_ Read `ctx.settings.renderScale` and multiply the drawing-buffer size by it before sizing the depth RT and calling `clouds.resize()`. Re-check on the same frame the setting changes, not only when the canvas resizes.

**/Users/paulius/Dev/cel-thunder/src/render/sky/SkySystem.ts**

The fallback depth prepass (renderDepthPrepass, lines 819-853) will run forever in the shipped build. RenderSystem already produces a full depth+normal+velocity g-buffer via `DepthNormalPass` every frame, but never emits `render:depth`, and the sky has no other way to find it. So each frame does three full scene traversals: RenderSystem's prepass, the sky's prepass, and the main render. On top of that the prepass sets `scene.overrideMaterial` for the *whole* scene including the transparent queue, so transparent VFX will wrongly occlude clouds, and calling `renderer.render()` a second time fires every object's onBeforeRender twice and resets `renderer.info` counters mid-frame.

_Fix:_ Report the exact hook needed (the integrator can add one line: `ctx.bus.emit('render:depth', { texture: this.prepass.gbuffer.depthTexture })`), and in the meantime restrict the fallback prepass to the opaque queue — set `object.visible = false` for `material.transparent` objects, or use a layer mask, so the fallback path is at least correct.

**/Users/paulius/Dev/cel-thunder/src/render/sky/noise.ts**

`cpuCloudDensity` does not mirror the GPU field, despite the doc comment on `cloudDensityAt` claiming 'sampled from the same baked volume the GPU uses ... so gameplay and visuals agree about where the clouds are'. Three concrete divergences: (1) the GPU's `sampleWeather` remaps cloud type as `saturate(wm.g*0.62 + uCloudType*0.72 - 0.17)` (VolumetricClouds.ts:161) whereas the CPU passes the raw texel straight into `cpuHeightGradient` — `CpuDensityParams` has no cloudTypeBias field at all, so the vertical profile is computed for a different cloud type; (2) the GPU multiplies by `densityProfile(h)` (VolumetricClouds.ts:147), the CPU does not, so CPU density is systematically ~25-60 % higher; (3) the GPU uses `altitudeAt(p)` against the camera-centred sphere of radius uCloudPlanetR, the CPU uses a flat `y - base`.

_Fix:_ Add `cloudTypeBias` to CpuDensityParams, apply the same weather remap, port `densityProfile`, and apply the camera-centred altitude. The `cameraInCloud` threshold of 0.16 is currently comparing against a number with no defined relationship to what is on screen.

**/Users/paulius/Dev/cel-thunder/src/render/sky/solar.ts**

`computeEphemeris` is called every frame from updateSlow and allocates on every call: two `new THREE.Vector3()` and one `_tmpV.clone()` (lines 183-185), plus five object literals from `sunEquatorial`, `moonEquatorial` and three `equatorialToHorizontal` calls. That is ~8 allocations per frame, 480/second, in a file whose sibling SkySystem.ts carries the comment 'Module-level scratch. Nothing in the per-frame path is allowed to allocate.' The brief makes this a hard rule.

_Fix:_ Hoist three module-level Vector3 scratches for the star-basis columns, and give sunEquatorial/moonEquatorial/equatorialToHorizontal `out` parameters backed by module-level structs.

**/Users/paulius/Dev/cel-thunder/src/render/sky/VolumetricClouds.ts**

The cloud ink contour (composite shader, lines 782-791) samples the transmittance gradient at ±1 `uCloudTexel`, which is one *march-buffer* texel. At renderScale 0.38 that is a ~2.6 px line, at 0.24 (low) ~4.2 px, at 0.50 (ultra) ~2 px. The brief requires outline width 'roughly constant in screen space'; here it changes whenever the adaptive governor steps quality. Worse, the gradient is taken from `dst.texture`, the temporally resolved buffer with `uBlend` 0.12-0.26 — i.e. 74-88 % history — so during a roll or a fast pass the contour lags the true silhouette by several frames and visibly slides off the cloud edge. The fixed `smoothstep(0.14, 0.44, grad)` threshold also means soft/wispy edges get no ink while hard edges get full ink, so the line appears and vanishes along a single cloud's outline.

_Fix:_ Scale the tap offsets so the sampled distance is a constant number of *screen* pixels (offset = k / uResolution, converted into cloud-buffer UV), and take the gradient from the un-resolved march buffer or from the pre-blend current frame so the ink tracks the silhouette. Normalise the gradient by local edge softness (divide by the neighbourhood range) so wispy and hard edges both get a line.

**/Users/paulius/Dev/cel-thunder/src/render/sky/SkyDome.ts**

The star field is sub-pixel and will crawl. `starField` puts the lattice at `eq * 214.0` and gives each star a core radius of 0.032-0.115 *cells*, i.e. 0.15-0.54 mrad. At 1080p with the default 68° vertical FOV one pixel subtends ~0.62 mrad, so the majority of stars are smaller than a pixel and are point-sampled with no analytic antialiasing, no fwidth-based minimum width and no MSAA in the path (the backdrop goes into sceneRT, and FXAA at the end of the chain cannot recover a flickering sub-pixel dot). Rotating the camera will make the field sparkle and pop. The `tw` twinkle term makes it worse, not better, because it is indistinguishable from the aliasing.

_Fix:_ Clamp the star radius to at least ~1.5 px in angular terms using `fwidth(d)` or an explicit `uResolution`/FOV-derived pixel angle, and conserve total energy as the radius is widened (brightness *= (trueRadius/clampedRadius)^2) so the field does not get brighter as it is antialiased.

**/Users/paulius/Dev/cel-thunder/src/render/sky/noise.ts**

The detail volume is 32³ but is filled with inverted Worley at grid frequencies 4/8/16 (`dFreqs`, line 317). `renderWorleyVolume` computes `per = size / n`, so the 16-cell octave gets 2 voxels per cell along each axis. A Worley distance field varies over the full 0..~0.5 range within a cell; sampling it twice per axis produces noise, not structure. That octave contributes 0.125 of `dFbm` in the erosion term (VolumetricClouds.ts:141) and is pure aliasing. The 64³ shape volume has the same problem at 4 voxels/cell for its 16-cell octave, less severely. This is the erosion that is supposed to make cloud edges cauliflower rather than blobby — it is instead adding high-frequency noise that the half-res march then aliases again.

_Fix:_ Use 2/4/8 for the 32³ detail volume (or bump it to 64³ and keep 4/8/16). Standard Nubis detail is 32³ at frequencies giving ≥8 voxels per cell.

**/Users/paulius/Dev/cel-thunder/src/render/sky/VolumetricClouds.ts**

With `ctx.settings.volumetricClouds = false` (lines 381-393) the composite mesh is hidden and the only clouds left are the cirrus shell and the horizon deck. But `horizonDeck` returns zero until `smoothstep(uCloudMaxDist*0.72, uCloudMaxDist*1.45, t)` becomes non-zero — i.e. nothing inside 27 km (SkyDome.ts:342). So the low-end / disabled path renders a completely empty sky between the camera and 27 km. VISUAL_RUBRIC lists 'an empty frame: subject on a plain sky with nothing else happening' as an automatic ≤4.

_Fix:_ When volumetrics are off, drop the deck's range fade-in to near zero and raise `uDeckHeight` to the real cloud base so the billboarded deck stands in for the mid-field clouds, or add a cheap single-sample cloud shell to the backdrop.

**/Users/paulius/Dev/cel-thunder/src/render/sky/sharedUniforms.ts**

The sky uses two mutually inconsistent planet radii. The volumetric layer curves against `uCloudPlanetR = 900000` (line 98, deliberately tightened) while `SkyDome.ts` puts the cirrus and the distant cumulus deck on `R_DECK = 6371000`. On top of that `uDeckHeight` is set to `max(600, cloudBase*0.85)` (SkySystem.ts:612), so the distant deck sits *below* the near cloud base. In the 27-55 km cross-fade band the volumetric towers bend down 7× faster than the deck behind them and meet it at a different apparent altitude, which will read as a visible horizontal step where the two cloud systems overlap.

_Fix:_ Use the same radius for both, or derive uDeckHeight from the volumetric layer's apparent horizon height at uCloudMaxDist so the two silhouettes meet. At minimum set uDeckHeight to the actual cloudBase rather than 0.85× it.

### Missing from brief

- Outlines 'roughly constant in screen space' — the cloud ink contour is measured in march-buffer texels, so it is ~2.6 px wide at high, ~4 px at low, and ~2 px at ultra. Same asset, three different line weights.
- Outlines that 'must not shimmer or crawl' — the ink is derived from the temporally-blended transmittance (blend 0.15, i.e. 85% history), so during a roll the contour visibly slides off the cloud silhouette it is supposed to be drawing.
- 'No LOD popping / shimmering edges' — sub-pixel stars, and a hard fade ring where the volumetric layer ends at uCloudMaxDist.
- '60 fps at 1080p on integrated graphics' — measured only on Apple silicon via ANGLE/Metal, and settings.renderScale (the one lever that would save an iGPU) is not honoured by the sky at all.
- Respect ctx.settings — settings.renderScale is ignored entirely; only settings.cloudSteps, settings.volumetricClouds and settings.shadows are read.
- 'Never allocate Vector3/Quaternion inside a hot loop — hoist to module-level scratch' — computeEphemeris() allocates 2 Vector3 + a .clone() + 5 object literals every frame.


---

## world — **NOT_SHIPPABLE**

This is genuinely strong work — the heightfield pipeline (analytic geography → droplet erosion → priority-flood → D8 drainage → Catmull-Rom bake → min/max pyramid) is the real thing, the CDLOD morph is mathematically correct and watertight, and the terrain fragment shader has actual art direction in it. It is not shippable as-is, for two reasons the report never mentions and several it dresses up.

BLOCKER 1: the terrain does not exist in the depth/normal prepass. `DepthNormalPass` uses `scene.overrideMaterial`, so the terrain's entire CDLOD vertex program (`terrainMaterial.ts:203-235`) is discarded and `TerrainRenderer.mesh` renders as 94 stacked copies of the raw unit patch — a 1 m × 1 m flat quad at the world origin. The gbuffer's linear-depth channel over the whole ground is therefore the far-plane clear value. `DofPass` (`depthAt` → `tGB.b`) will push the entire landscape to maximum circle of confusion whenever focus is on the player aircraft; `MotionBlurPass` reads zero velocity for the ground, so a 150 m/s deck pass has a razor-sharp static terrain under a blurred aircraft; `AoPass` gives no contact occlusion where trees, hangars and flak pits meet the ground. This needs either `userData.noPrepass` (stops the origin artefact, keeps the rest broken) or an integrator change to let a mesh supply its own prepass material. Neither was requested.

BLOCKER 2: every paved surface z-fights. The camera is near=0.35 / far=120000 (`Game.ts:144`). A 24-bit non-linear depth buffer resolves ~4 cm at 500 m and ~17 cm at 1 km. The runway is offset 0.06 m above the pad, the shoulders 0.05 m, the taxiway/apron/hardstands 0.04 m, the factory apron 0.06 m and the railyard ballast 0.04 m. All of these are exactly-parallel planes over exactly-flat pad terrain, so they do not fight locally — they strobe across the whole surface simultaneously from about 400 m out. That is the entire approach and final. No `polygonOffset` anywhere in the subsystem.

Beyond that: one runway designator is painted mirror-reversed (`blitRotated` implements a transpose, not a rotation, at one end and a rotation at the other), the near-threshold piano keys are erased by the "plain tarmac band" written afterwards over the same rows, the hardstand revetment loop iterates `s = -1..1` and never uses `s` (with a `void s;` to silence the linter) so every sandbag is emitted twice coincident and only one side of each hardstand is revetted, and the windsocks use default XYZ Euler order so their lift angle collapses whenever the wind blows along ±X.

The report's "known gaps" list is honest about vegetation hitching and terrain shadows but omits: the prepass gap, the z-fighting, the fact that overriding `uAerialFar` disconnects terrain and ocean from the weather system that drives `celGlobals.uAerialFar` (SkySystem.ts:591), the impostor LOD pop, and the flak-on-the-runway siting.

### Blockers

**src/world/TerrainRenderer.ts**

Terrain is absent from the depth/normal/velocity gbuffer. DepthNormalPass renders with scene.overrideMaterial, which discards the CDLOD vertex program in terrainMaterial.ts:203-235. The terrain mesh is a plain THREE.Mesh with an InstancedBufferGeometry whose position attribute is (gx,0,gz) in [0,1], so the override draws 94 instances of a 1 m x 1 m flat quad at the world origin and writes nothing where the terrain actually is. The material is opaque with alphaTest 0, so it is not skipped by the pass's transparent/alpha-test filter either.

_Fix:_ Short term, set `this.mesh.userData.noPrepass = true` in the TerrainRenderer constructor to at least stop the garbage quad being stamped at the origin. Real fix requires an integrator change: DepthNormalPass must honour a per-object `userData.prepassMaterial` (or swap material per-object instead of using scene.overrideMaterial), and TerrainRenderer must supply a prepass ShaderMaterial that shares HEIGHTFIELD_GLSL and the same iNode/iMorph displacement so depth, normal and velocity match the rendered surface. Report this to the integrator — it is the same shader body already needed for the missing customDepthMaterial.

**src/world/Airfield.ts**

All pavement z-fights with the terrain past ~400 m. RY = y + 0.06 for the runway, RY-0.01 for shoulders, RY-0.02 for taxiway/links/apron/hardstands. With near=0.35 and far=120000 (Game.ts:144) a 24-bit depth buffer resolves roughly 4 cm at 500 m and 17 cm at 1 km. Because the pad terrain is flattened to exactly site.elevation and the pavement is a parallel plane, the entire runway surface crosses the quantisation threshold at the same moment — it will strobe as a whole, on final approach, every approach. GroundTargets.ts:478 (factory apron, +0.06) and :538 (railyard ballast, +0.04) have the identical problem.

_Fix:_ Put the pavement on polygon offset rather than a world-space lift: set `polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4` on pavMat (and on the factory/railyard slab material), and drop the manual Y offsets to ~0.005 m so wheels still contact sanely. Depth-slope offset scales with distance automatically, which a constant metre offset cannot.

### Majors

**src/world/Airfield.ts**

blitRotated() applies a transpose, not a rotation, at the near threshold. For flip=0 it maps source (lx,ly) to (W/2 + ly*0.9, 190 + lx*0.9) — determinant -1, a reflection about the diagonal. For flip=1 it maps to (W/2 - ly*0.9, H-190 + lx*0.9) — determinant +1, a proper rotation. The two ends therefore have opposite handedness, so one designator is painted mirror-reversed: both the glyph shapes and the digit order read backwards. The comment claims 'rotate -90: (x,y) -> (y, -x)' but the code implements (y, +x).

_Fix:_ Use (x,y) -> (y,-x) for the near end: `tx = W/2 + ly*0.9; ty = 190 - lx*0.9;` and keep the far end as the 180-degree reciprocal (`tx = W/2 - ly*0.9; ty = H-190 + lx*0.9`). Render both and eyeball them — a mirrored '09' is the single most obvious tell on any screenshot of the field.

**src/world/Airfield.ts**

The 'plain tarmac band' written at the end of buildRunwayTexture (rows 20..81, full width) overwrites markings drawn earlier. The near-threshold piano keys occupy rows 26..88, so 56 of their 62 rows are erased; the edge lines start at row 40, so their first ~100 m is erased too. The far threshold is untouched, so the runway is visibly asymmetric: markings at one end, bare asphalt at the other.

_Fix:_ Move the plain band out of the marking region entirely — reserve rows 0..18 (v in [0.0,0.018], already unused by the shoulders) or extend the atlas height and put the band above v=1.0 for real. Then update BLANK_V0/BLANK_V1 to match. Draw order alone will not save you: the band must not overlap any painted rows.

**src/world/Airfield.ts**

The revetment loop is dead code dressed as working. `for (let s = -1; s <= 1; s += 2)` runs twice but the body never references `s` — `bb = rb + Math.abs(t) * 0.22` has no side term, and the author added `void s;` to silence the unused-variable warning instead of using it. Result: every sandbag box is emitted twice at identical coordinates (coincident coplanar faces, doubled triangle count, and whatever the depth test decides that frame) and each hardstand is revetted on one side only. The clear intent was blast walls flanking both sides.

_Fix:_ Use the loop variable: `const bb = rb * s + Math.abs(t) * 0.22 * s;` and offset the boxes to `wx(a + t, bb)` / `wz(a + t, bb)` so the two arms sit either side of the hardstand. Then delete `void s;`.

**src/world/WorldSystem.ts**

Windsock orientation is wrong for most wind directions. `s.rotation.set(lift + flutter*0.6, this.windDir + flutter, 0)` uses three's default 'XYZ' Euler order, so the rotation composes as Rx·Ry: the yaw is applied first and the lift is then a pitch about the *world* X axis. The sock geometry points along -Z, so lift only works when windDir is near 0 or PI. At windDir near PI/2 (which the seed produces for roughly half of all maps, since windDir = (seed % 628)/100 spans the full circle) the sock points along X and the 'lift' rotation just spins it about its own axis — it hangs dead vertical in a 13 m/s wind.

_Fix:_ Set `s.rotation.order = 'YXZ'` once at build time in Airfield.ts (or use a quaternion: yaw about Y, then pitch about the sock's local X). Verify by stepping windDir through 0, PI/2, PI, 3PI/2 and confirming the cone lifts identically in all four.

**src/world/Vegetation.ts**

Hard, uncrossfaded LOD popping in two places. (1) At exactly meshRadius (620 m) a textured impostor card is instantly replaced by a 3-tier faceted cone — different silhouette, different colour response, no fade. (2) The impostor decimation `stride = 1 + ((dist*dist)/620000)|0` steps at dist = 787 m, 1113 m, 1363 m...; at each step half (then a third, then a quarter) of the trees vanish in a single frame while the survivors jump in size by `sqrt(stride)*0.92` — a 41% instant scale jump at the first step. Because the whole field is rebuilt only when the camera crosses a cell boundary, these transitions happen as a discrete ring snapping outward every ~0.85 s at 150 m/s. It will read as the forest breathing.

_Fix:_ Give the cards a dissolve: pass an alpha/scale ramp per instance (fade cards in over 560-620 m while the mesh fades out, and fade a decimated card's replacement in over the stride boundary rather than snapping). Cheapest version: add a `fade` float to iCardB, multiply the card width/height by smoothstep near the boundary so trees shrink to zero instead of disappearing, and grow the survivors over the same band rather than in one step.

**src/world/Vegetation.ts**

Impostor cards derive their shading normal from the view vector: `objectNormal = normalize(vec3(toCam.x, 0.35*length(toCam.xz), toCam.z))`. Every card in the scene therefore has the same N·L, so the entire distant forest is one flat tone — and because N rotates with the camera, that tone crosses the cel band edges as you yaw. A 3-band ramp with bandSoftness 0.08 means the whole treeline will visibly flip brightness step as the aircraft turns. That is far worse than a flat forest.

_Fix:_ Decouple the lighting normal from the billboard orientation. Use a fixed hemispherical normal biased upward and slightly toward the card's own yaw seed (`normalize(vec3(sin(seed), 1.6, cos(seed)))`), or better, sample the terrain normal at the instance position and blend it with +Y. The card must still face the camera geometrically; only the normal must stop doing so.

**src/world/terrainMaterial.ts**

Terrain and water shadow the shared celGlobals.uAerialFar / uAerialStrength with hard-coded local uniforms (15000/1.05 at terrainMaterial.ts:179-180, 34000/0.95 at Water.ts:91-92). SkySystem.ts:591 drives celGlobals.uAerialFar from the weather state (w.aerialFar), and VolumetricClouds derives from it too. So in rain, fog or dusk the aircraft, props, structures and clouds all thicken while the ground and the ocean — the two largest things on screen — stay at fixed clarity. The report presents this as an art decision without noting that it breaks weather coupling.

_Fix:_ Keep the ratio, not the constant: add `uAerialScale` (0.58 for terrain, 1.3 for water) and compute `far = celGlobals.uAerialFar.value * scale` per frame in WorldSystem.update, or do the multiply in GLSL against the shared uniform. Then the ground still hazes faster than an aircraft at 300 m but a squall still affects it.

**src/world/GroundTargets.ts**

Flak emplacements can be placed on the airfield. The rings are seeded at r in [700,1500] m from each airfield centre with only a height/slope test — no `hf.padT()` check. The flattened pad is padHalfL=990 x padHalfW=480 metres, and isPaved() extends the taxiway/apron block out to across=+240 m, so a meaningful fraction of the annulus lands on the runway, its overruns, the taxiway or the apron. Because the pad is dead flat the slope test passes cleanly, and y = hf.heightAt() puts the gun flush on the tarmac. Expect an 88 mm piece with a sandbag ring sitting on the threshold of your own runway.

_Fix:_ Add `if (hf.padT(x, z) < 1.6) continue;` to both the ring loop (line ~120) and the contested-belt loop (line ~134), matching the guard Vegetation.getCell already uses. While there, add the same guard to the truck convoy — the road wanders between the two airfields and has no pad test either.

**src/world/GroundTargets.ts**

The factory apron and railyard ballast are dead-flat slabs sized far beyond the ground they were validated against. findFlatSite only samples 8 points at a 90 m radius and accepts +/-9 m of height variation, but buildFactory lays a 190 x 130 m slab (corners at ~115 m) and buildRailYard lays a 44 x 220 m ballast bed plus 218 m rail boxes (ends at 110 m) — both outside the tested radius and both at a single fixed Y. On +/-9 m terrain the slab corners will be metres in the air or buried. The 218 m rails are the worst case: a rigid box through a hillside.

_Fix:_ Either (a) flatten the terrain under these sites the way the airfield pads are flattened — add the factory/railyard footprints to the pad-flattening loop in heightfield.bake() so the baked field agrees with the geometry, or (b) tighten findFlatSite to sample the actual footprint half-diagonal (~115 m for the factory, ~112 m for the yard) with a much tighter tolerance (+/-2 m). (a) is correct and also fixes the vegetation-not-cleared gap you already listed.

**src/world/GroundTargets.ts**

All static target geometry — the factory, the rail yard, the bridge and all 22 sandbag rings scattered across the entire 65 km map — is merged into one BufferGeometry with a map-spanning bounding sphere. staticMesh.frustumCulled is true but useless: the sphere always intersects. So every frame you submit the full ~15k triangles regardless of where the camera is, twice (the addOutlinesRecursive inverted hull shares the same geometry and bounds), and castShadow=true means it is also drawn in full into every shadow cascade even when the entire installation is 40 km behind the light frustum's region of interest.

_Fix:_ Split the merge per installation: one mesh for the factory, one for the rail yard, one for the bridge, and one per airfield's gun pits (or instance the sandbag ring, it is the same 28 boxes every time). Each then gets a tight bounding sphere and culls properly, at a cost of ~5 extra draw calls against a 1200 budget.

**src/world/GroundTargets.ts**

The sibling-InstancedMesh outline trick works for positions but not normals. createOutlineMaterial (CelMaterial.ts:423) computes `nView = normalize(normalMatrix * objectNormal)` and never multiplies by instanceMatrix, while the position path does (`mvPosition = modelViewMatrix * instanceMatrix * ...`). Every truck, flak gun, wagon and armoured car is placed with a per-instance yaw, so the hull expands along an unrotated normal: the silhouette will be thick on two sides and thin-to-absent on the other two, and it will vary with each unit's heading. Same defect applies to the Vegetation trees if outlines are ever added there.

_Fix:_ This is a CelMaterial bug but you are the first consumer to hit it — report it to the integrator and, in the meantime, guard it: `#ifdef USE_INSTANCING vec3 objectNormal2 = mat3(instanceMatrix) * objectNormal; #endif` before the normalMatrix multiply. Do not ship rotated instanced outlines until it is fixed.

**src/world/TerrainRenderer.ts**

The CDLOD selector fails open into holes. `select()` returns immediately when `this.count >= MAX_INSTANCES` (1600), abandoning the rest of the quadtree walk. The abandoned nodes are not replaced by their coarser ancestor — they are simply not drawn, so the terrain gets see-through gaps straight to the sky background. RANGE_K=2.6 makes this unlikely at typical altitudes, but 'unlikely' is not a rendering guarantee, and the failure mode is the worst possible one.

_Fix:_ Make overflow degrade instead of vanish: check the budget *before* recursing and, if the four children would not fit, emit the parent node at its own level instead of descending. `if (level > 0 && d <= range[level] && this.count + 4 <= MAX_INSTANCES) { recurse } else { emit }`. Costs nothing and turns a hole into a slightly coarser patch.

### Missing from brief

- Terrain casts no shadows at all (castShadow=false, no customDepthMaterial). Mountains do not shade valleys, ridgelines do not read, and the 'warm key / cool fill' direction has no cast-shadow side to work against. Admitted in the report but it is a headline art requirement, not a gap.
- Aerial perspective on terrain and ocean is hard-coded (uAerialFar 15000/34000, uAerialStrength 1.05/0.95) and shadows the shared celGlobals uniform that SkySystem drives from the weather state. Fly into a squall and the aircraft, props and clouds haze while the ground and sea stay perfectly clear.
- 'No untextured planes' is violated by every non-runway paved surface. Taxiways, links, apron and all six hardstands sample v in [1.02,1.08] — a 62-row featureless noise band stretched over 1240 m of taxiway and a 110 m apron. No oil staining, no tyre scrub, no cracks, no joints. A 110x110 m flat grey quad is the textbook programmer-art read.
- The truck convoy and armour drive across open farmland — there is no road painted into the terrain shader or the mask set, and no road geometry. A 26-vehicle column in a wheat field is an immediate immersion break from 1000 m.
- World owns the wind (WorldSystem.wind) and animates the windsocks with it, but nothing else responds: trees, canopy cards and tents are perfectly rigid. Static foliage under a stated 4-13 m/s wind reads as plastic.
- Destroyed ground targets are only hidden (kill() writes a zero-scale matrix). No wreck, no blackening, no crater — the interface promises 'hide, blacken or replace' and only hide exists.
