import * as THREE from 'three';
import type { GameContext, QualityTier, Subsystem } from '../engine/context';
import { EntityKind, EventKind } from '../shared/protocol';
import { aircraftByIndex } from '../shared/aircraft';
import { VfxCore, type SurfaceKind } from './VfxCore';
import { EntityFxRegistry, type VfxAircraftModel } from './EntityFx';
import {
  clearDeferred, spawnExplosionAt, spawnSecondaries, updateDeferred,
  type ExplosionKind,
} from './Explosions';
import { spawnImpactAt, spawnMuzzleFlash } from './Gunfire';
import { spawnRocketLaunch } from './Ordnance';
import { CanopyRain, SmokeSources } from './Environment';
import { CombatStaging, type SceneDirective } from './CombatStaging';
import { RAMP, TILE } from './VfxTextures';
import { resetSpawn } from './ParticleEngine';

export type { ExplosionKind } from './Explosions';
export type { VfxAircraftModel } from './EntityFx';
export type { SurfaceKind } from './VfxCore';

/**
 * The VFX subsystem.
 *
 * Responsibilities, in the order they happen each frame:
 *
 *   1. refresh the shared uniforms (sun in view space, fog, wind, resolution,
 *      and the scene depth buffer if the renderer offers one),
 *   2. walk 'ctx.entities' and drive every continuous effect — contrails,
 *      vortices, damage plumes, ordnance trails, ground wash,
 *   3. run the deferred queue (secondary explosions), persistent smoke sources
 *      and the debris rigid-body pass,
 *   4. upload only what changed and hand the camera its shake.
 *
 * One-shot effects arrive on the bus as 'game:event' and are dispatched to the
 * explosion / impact / gunfire libraries.
 *
 * Everything is pooled. After 'init' this system performs no allocation in
 * steady state — no vectors, no closures, no arrays.
 */

const QUALITY_BUDGET: Record<QualityTier, number> = {
  low: 0.5, medium: 0.75, high: 1.0, ultra: 1.25,
};

interface WorldLike {
  terrainHeight?(x: number, z: number): number;
  terrainNormal?(x: number, z: number, out?: THREE.Vector3): THREE.Vector3;
  terrainType?(x: number, z: number): string;
  airfields?: { x: number; y?: number; z: number }[];
}

interface RenderLike {
  depthTexture?: THREE.Texture | null;
  sceneDepthTexture?: THREE.Texture | null;
  depthTarget?: { depthTexture?: THREE.Texture | null } | null;
  /** Optional: the composer's real internal render size, in device pixels. */
  renderSize?: { x: number; y: number } | null;
}

/**
 * The legacy CPU billboard plumes owned by the entity subsystem
 * (src/game/visual/Particles.ts). They emit smoke and fire for exactly the same
 * DamageBits that DamageFx now drives, so both run at once and a burning
 * aircraft trails two plumes in two incompatible art styles. VFX owns the
 * damage plume, so it switches the older pair off; see the report — the proper
 * fix is to delete the emission in AircraftView.updateDamage.
 */
const LEGACY_PLUME_MESHES = ['smokeField', 'fireField'];

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _shakeQ = new THREE.Quaternion();
const _size = new THREE.Vector2();

/** Module singleton so the free-function API works without plumbing. */
let active: VfxSystem | null = null;

export class VfxSystem implements Subsystem {
  readonly name = 'vfx';

  readonly core = new VfxCore();
  readonly entities = new EntityFxRegistry();
  readonly rain = new CanopyRain();
  readonly sources = new SmokeSources(48);
  /**
   * Honours the 'scene' half of a screenshot framing — tracers, muzzle flash,
   * hits on the target, burning ground targets. Inert until a 'debug:scene'
   * directive arrives, so it never runs during a real match.
   */
  readonly staging = new CombatStaging();

  /**
   * When true the VFX system nudges the camera itself in lateUpdate.
   *
   * CameraSystem ships its own CameraShake fed from the same bus events, and it
   * commits into the camera in update(). Two uncorrelated shakes summing on top
   * of each other beat against one another and read as a stutter, so this is
   * auto-disabled in init() whenever a camera subsystem is present; it only
   * stays on for a bare harness with no rig. Rigs should read consumeShake().
   */
  ownCameraShake = true;

  /**
   * Set false to leave the entity subsystem's legacy billboard plumes alone
   * (see LEGACY_PLUME_MESHES). Only useful if DamageFx is disabled.
   */
  suppressLegacyPlumes = true;

  /** Global weather knobs. */
  rainIntensity = 0;
  humidity = 0.85;

  private ctx!: GameContext;
  private world: WorldLike | null = null;
  private render: RenderLike | null = null;
  private unsub: (() => void)[] = [];
  private appliedOffset = new THREE.Vector3();
  private appliedRoll = 0;
  private windPhase = 0;
  private depthWarned = false;
  private shakeOwnerResolved = false;

  // -------------------------------------------------------------------------

  init(ctx: GameContext): void {
    this.ctx = ctx;
    active = this;

    this.core.camera = ctx.camera;
    this.core.build(1);
    this.core.setBudgetScale(QUALITY_BUDGET[ctx.quality] ?? 1);
    this.core.engine.globals.uShadowTint.value.copy(ctx.ambientColor).multiplyScalar(1.15);

    ctx.scene.add(this.core.root);
    ctx.scene.add(this.rain.mesh);
    // Added once, at boot, and never removed: three recompiles every material
    // in the scene when the light counts change, so a rig that added a light
    // when something caught fire would stall the frame it was needed on.
    ctx.scene.add(this.core.fireLight.group);

    // The ink hull on debris is the same graphic device as the aircraft
    // outline, so it has to honour the same setting or the two disagree.
    this.core.debris.setOutlineWidth(0.011 * (ctx.settings.outlineWidth || 1));

    this.resolveWorld();
    this.disableLegacyPlumes();
    this.entities.humidity = this.humidity;

    // Deterministic per-map wind so contrails and columns lean consistently.
    const seed = (ctx.mapSeed >>> 0) || 1;
    const dir = ((seed % 360) / 360) * Math.PI * 2;
    const spd = 2.5 + ((seed >>> 9) % 60) / 10;
    this.core.wind.set(Math.cos(dir) * spd, 0, Math.sin(dir) * spd);

    this.subscribe();
    this.seedAirfieldSmoke();
  }

  private resolveWorld(): void {
    // The world subsystem is documented to expose terrainHeight/Normal/Type.
    // It may not exist yet during bring-up, so duck-type it and fall back to a
    // flat sea-level plane rather than crashing the boot.
    const w = this.ctx.get<any>('world') as WorldLike | undefined;
    this.world = w ?? null;
    const gw = (globalThis as any).__world as WorldLike | undefined;
    const src = (w && typeof w.terrainHeight === 'function') ? w
      : (gw && typeof gw.terrainHeight === 'function') ? gw : null;

    if (!src) {
      console.info('[vfx] no terrain query available — using sea level');
      return;
    }
    this.core.terrain = {
      height: (x, z) => src.terrainHeight!(x, z),
      normal: (x, z, out) => {
        if (src.terrainNormal) {
          const n = src.terrainNormal(x, z, out);
          // Tolerate an implementation that returns its own vector.
          if (n !== out) out.copy(n);
          return out.normalize();
        }
        return out.set(0, 1, 0);
      },
      type: (x, z) => (src.terrainType ? mapSurface(src.terrainType(x, z)) : 'grass'),
    };
  }

  /**
   * Takes sole ownership of the damage plume.
   *
   * EntitySystem.update calls AircraftView.updateDamage every frame, which
   * emits soft alpha billboards for Engine / OilLeak / FuelLeak / EngineFire /
   * Destroyed — exactly the bits DamageFx reacts to. Left alone, every burning
   * aircraft trails two plumes in two art styles, one cel-banded and inked and
   * one a soft grey puff. Those emitters are outside this subsystem's file set,
   * so the meshes are hidden here instead of the emission being deleted; that
   * costs a per-frame CPU simulation of invisible particles, which is why the
   * report asks the integrator to remove the emission properly.
   */
  private disableLegacyPlumes(): void {
    if (!this.suppressLegacyPlumes) return;
    let found = 0;
    for (const name of LEGACY_PLUME_MESHES) {
      const m = this.ctx.scene.getObjectByName(name);
      if (m) { m.visible = false; found++; }
    }
    if (found) {
      console.info(
        `[vfx] hid ${found} legacy damage billboard field(s) — VFX owns the damage plume`,
      );
    }
  }

  private seedAirfieldSmoke(): void {
    const fields = this.world?.airfields;
    if (!fields) return;
    for (const f of fields) {
      const y = f.y ?? this.core.terrain.height(f.x, f.z);
      // A pair of marker pots per field, offset so they read as a wind gauge.
      this.sources.add(f.x + 40, y + 0.5, f.z + 25, 1.6, 0, Infinity, RAMP.SmokePot);
      this.sources.add(f.x - 40, y + 0.5, f.z - 25, 1.6, 0, Infinity, RAMP.SmokePot);
    }
  }

  private subscribe(): void {
    const bus = this.ctx.bus;
    this.unsub.push(bus.on('game:event', (ev: any) => this.onGameEvent(ev)));
    this.unsub.push(bus.on('quality', (q: QualityTier) => {
      // Halve the emission budget at 'low'. Airflow stays on: contrails and
      // wingtip vortices are the effects that read as flight, and the ones
      // that cost the least per pixel. Debris outlines are the first thing to
      // go — they are a whole extra draw call for a 30 px silhouette.
      this.core.setBudgetScale(QUALITY_BUDGET[q] ?? 1);
      this.core.debris.setOutlineEnabled(q !== 'low');
    }));
    this.unsub.push(bus.on('weather', (w: any) => this.applyWeather(w)));
    // The screenshot framings publish everything the shot needs from the rest
    // of the game here. Camera composition alone cannot make 'ground_attack'
    // contain an attack; see CombatStaging.
    this.unsub.push(bus.on('debug:scene', (s: SceneDirective) => {
      this.staging.apply(s, this.sources, this.entities);
    }));
    // A fresh match: drop everything so old smoke does not survive a respawn.
    this.unsub.push(bus.on('net:welcome', () => this.reset()));
  }

  /**
   * The only producer on the 'weather' channel is CameraSystem, and it sends a
   * WeatherDirective (src/engine/camera/framings.ts): coverage, cloudBase,
   * cloudDepth, haze, turbidity, windSpeed. None of rain/humidity/windX exist,
   * so those are kept only as an explicit override for a caller that has them.
   *
   * Mapping, in physical terms:
   *  - **humidity** is what gates every condensation effect. Overcast air is
   *    near saturation and hazy air is holding water it has not condensed yet,
   *    so coverage and haze both push it up; high turbidity is dust rather than
   *    water, so it pushes it back down a little.
   *  - **rain** has no producer. A deck with coverage past ~0.72 *and* real
   *    vertical development is the only thing in the directive that can be read
   *    as a shower, so that is the trigger — a scattered fair-weather cumulus
   *    field never turns the canopy wet.
   *  - **windSpeed** rescales the map-seeded wind vector, keeping its direction
   *    so contrails and smoke columns still lean consistently across a match.
   */
  private applyWeather(w: any): void {
    if (!w || typeof w !== 'object') return;

    const coverage = num(w.coverage);
    const haze = num(w.haze);
    const turbidity = num(w.turbidity);

    if (coverage !== null || haze !== null) {
      const cov = coverage ?? 0.3;
      const hz = haze ?? 0.6;
      const dust = turbidity !== null ? clamp01((turbidity - 2.2) / 4) : 0;
      this.humidity = clamp(0.45 + cov * 0.55 + hz * 0.30 - dust * 0.25, 0.15, 1.35);
    }
    if (coverage !== null) {
      const depth = num(w.cloudDepth) ?? 1000;
      // Coverage alone is a stratus sheet; coverage plus 2 km of vertical
      // development is a shower. Both have to be there.
      this.rainIntensity = clamp01((coverage - 0.72) / 0.24) * clamp01((depth - 1200) / 1200);
    }
    const spd = num(w.windSpeed);
    if (spd !== null) {
      const cur = this.core.wind.lengthSq();
      if (cur > 1e-6) this.core.wind.multiplyScalar(spd / Math.sqrt(cur));
      else this.core.wind.set(spd, 0, 0);
    }

    // Explicit overrides, for any producer that speaks the richer contract.
    const rain = num(w.rain);
    if (rain !== null) this.rainIntensity = clamp01(rain);
    const hum = num(w.humidity);
    if (hum !== null) this.humidity = clamp(hum, 0, 1.5);
    if (typeof w.windX === 'number') this.core.wind.set(w.windX, w.windY ?? 0, w.windZ ?? 0);

    this.entities.humidity = this.humidity;
  }

  // -------------------------------------------------------------------------
  // Event dispatch
  // -------------------------------------------------------------------------

  private onGameEvent(ev: {
    kind: EventKind; x: number; y: number; z: number;
    nx: number; ny: number; nz: number; scale: number; a: number; b: number;
  }): void {
    if (!ev) return;
    const s = ev.scale > 0 ? ev.scale : 1;

    switch (ev.kind) {
      case EventKind.Explosion:
        this.spawnExplosion(ev.x, ev.y, ev.z, s, this.classify(ev.x, ev.y, ev.z));
        break;

      case EventKind.GroundImpact:
        this.spawnExplosion(ev.x, ev.y, ev.z, s, 'ground');
        break;

      case EventKind.WaterImpact:
        this.spawnExplosion(ev.x, ev.y, ev.z, s, 'water');
        break;

      case EventKind.HitSpark:
        spawnImpactAt(this.core, ev.x, ev.y, ev.z, ev.nx, ev.ny, ev.nz,
          this.surfaceFor(ev.a, ev.x, ev.y, ev.z, 'metal'), calibreOf(ev.b, 13));
        break;

      case EventKind.HitArmour:
        spawnImpactAt(this.core, ev.x, ev.y, ev.z, ev.nx, ev.ny, ev.nz, 'armour', calibreOf(ev.b, 20));
        break;

      case EventKind.Gunfire:
        this.onGunfire(ev);
        break;

      case EventKind.Critical:
        // An internal hit: a flash inside the airframe and a gout of smoke.
        spawnImpactAt(this.core, ev.x, ev.y, ev.z, ev.nx, ev.ny, ev.nz, 'armour', calibreOf(ev.b, 20));
        this.spawnExplosion(ev.x, ev.y, ev.z, Math.max(0.6, s * 0.5), 'small');
        break;

      case EventKind.StructureFail:
        this.onStructureFail(ev);
        break;

      case EventKind.Kill:
        this.spawnExplosion(ev.x, ev.y, ev.z, Math.max(2.5, s * 1.4), 'aircraft');
        spawnSecondaries(this.core, ev.x, ev.y, ev.z, Math.max(1.5, s), 2);
        break;

      case EventKind.Bailout:
        this.onBailout(ev);
        break;

      default:
        break;
    }
  }

  /** Air, ground or water, from the terrain under the event. */
  private classify(x: number, y: number, z: number): ExplosionKind {
    const gy = this.core.terrain.height(x, z);
    if (y < 1.5 && gy <= 0.05) return 'water';
    if (y - gy < 3) return this.core.terrain.type(x, z) === 'water' ? 'water' : 'ground';
    return 'air';
  }

  private surfaceFor(entityId: number, x: number, y: number, z: number, fallback: SurfaceKind): SurfaceKind {
    const e = this.ctx.entities.get(entityId);
    if (e && e.kind === EntityKind.Aircraft) return 'metal';
    if (e && e.kind === EntityKind.GroundUnit) return 'armour';
    const gy = this.core.terrain.height(x, z);
    if (y - gy < 2) {
      const t = this.core.terrain.type(x, z);
      return t === 'water' ? 'water' : t;
    }
    return fallback;
  }

  private onGunfire(ev: { x: number; y: number; z: number; nx: number; ny: number; nz: number; a: number; b: number }): void {
    const e = this.ctx.entities.get(ev.a);
    let cal = calibreOf(ev.b, 0);
    let tint = 0xfff0c0;
    let rx = 1, ry = 0, rz = 0;
    let vx = 0, vy = 0, vz = 0;

    if (e) {
      vx = e.vx; vy = e.vy; vz = e.vz;
      _q.set(e.qx, e.qy, e.qz, e.qw).normalize();
      _v.set(1, 0, 0).applyQuaternion(_q);
      rx = _v.x; ry = _v.y; rz = _v.z;
      if (cal === 0) {
        // No calibre on the wire: take the aircraft's heaviest gun, which is
        // what the player sees anyway when both groups fire.
        const spec = aircraftByIndex(e.typeId);
        let best = spec.guns[0];
        for (const g of spec.guns) if (g.calibre > best.calibre) best = g;
        cal = best.calibre;
        tint = best.tracer;
      }
    }
    if (cal === 0) cal = 12.7;

    const isLocal = ev.a === this.ctx.localEntityId;
    spawnMuzzleFlash(this.core, ev.x, ev.y, ev.z, ev.nx, ev.ny, ev.nz, {
      calibre: cal, tint, casings: true,
      vx, vy, vz, rx, ry, rz,
      shake: isLocal ? 1 : 0,
    });
  }

  private onStructureFail(ev: { x: number; y: number; z: number; nx: number; ny: number; nz: number; scale: number; a: number }): void {
    const core = this.core;
    const e = this.ctx.entities.get(ev.a);
    const vx = e?.vx ?? 0, vy = e?.vy ?? 0, vz = e?.vz ?? 0;
    const s = Math.max(0.8, ev.scale);

    // A wing coming off is a shower of panels and a burst of paint, not fire.
    const n = Math.round(14 * Math.min(1, core.budget));
    for (let i = 0; i < n; i++) {
      core.sphere(_v, 1);
      core.debris.spawn({
        x: ev.x + _v.x * s * 0.4, y: ev.y + _v.y * s * 0.4, z: ev.z + _v.z * s * 0.4,
        vx: vx * 0.85 + _v.x * core.rand(4, 16),
        vy: vy * 0.85 + _v.y * core.rand(4, 16),
        vz: vz * 0.85 + _v.z * core.rand(4, 16),
        kind: i % 3 === 0 ? 'chunk' : 'panel',
        size: core.rand(0.2, 0.8) * s,
        life: core.rand(3, 6.5),
        color: 0xb9bec4,
        spin: core.rand(6, 22),
        burning: 0,
        drag: 0.35,
      });
    }

    const p = resetSpawn();
    const now = core.time;
    const chips = core.count(22, ev.x, ev.y, ev.z);
    for (let i = 0; i < chips; i++) {
      core.sphere(_v, 1);
      p.x = ev.x; p.y = ev.y; p.z = ev.z;
      p.vx = vx * 0.7 + _v.x * core.rand(3, 18);
      p.vy = vy * 0.7 + _v.y * core.rand(3, 18);
      p.vz = vz * 0.7 + _v.z * core.rand(3, 18);
      p.life = core.rand(0.8, 2.4);
      p.size0 = core.rand(0.08, 0.22); p.size1 = p.size0;
      p.rot = core.rand(0, 6.283); p.spin = core.sym(16);
      p.drag = core.rand(1.2, 2.6); p.grav = 0.8; p.wind = 0.9;
      p.ramp = RAMP.PaintChip; p.tile = TILE.Shard;
      p.erode = 0.15; p.band = 1.3;
      core.dust.emit(now, p);
    }

    core.addShake(0.18, 22, 0.35, ev.x, ev.y, ev.z, 60, 0.5);
  }

  private onBailout(ev: { x: number; y: number; z: number; a: number }): void {
    const core = this.core;
    const e = this.ctx.entities.get(ev.a);
    const vx = e?.vx ?? 0, vy = e?.vy ?? 0, vz = e?.vz ?? 0;
    // The canopy going is a hard little pop of vapour plus one tumbling panel.
    const p = resetSpawn();
    const n = core.count(10, ev.x, ev.y, ev.z);
    for (let i = 0; i < n; i++) {
      core.sphere(_v, 1);
      p.x = ev.x; p.y = ev.y; p.z = ev.z;
      p.vx = vx * 0.5 + _v.x * core.rand(3, 12);
      p.vy = vy * 0.5 + _v.y * core.rand(3, 12);
      p.vz = vz * 0.5 + _v.z * core.rand(3, 12);
      p.life = core.rand(0.3, 0.9);
      p.size0 = 0.3; p.size1 = core.rand(1.4, 2.8);
      p.rot = core.rand(0, 6.283); p.spin = core.sym(2);
      p.drag = 2.6; p.grav = 0; p.wind = 0.8; p.turb = 0.5;
      p.ramp = RAMP.Condensation; p.tile = TILE.Wisp;
      p.erode = 0.6; p.band = 0.6; p.a = 0.8;
      core.mist.emit(core.time, p);
    }
    core.debris.spawn({
      x: ev.x, y: ev.y, z: ev.z,
      vx: vx * 0.9 + core.sym(5), vy: vy * 0.9 + core.rand(1, 6), vz: vz * 0.9 + core.sym(5),
      kind: 'panel', size: 0.9, life: 6, color: 0xc8d4dc,
      spin: core.rand(3, 9), burning: 0, drag: 0.9,
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  spawnExplosion(x: number, y: number, z: number, scale: number, kind: ExplosionKind = 'air'): void {
    spawnExplosionAt(this.core, x, y, z, scale, kind);
  }

  spawnImpact(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    surface: SurfaceKind, calibre: number,
  ): void {
    spawnImpactAt(this.core, x, y, z, nx, ny, nz, surface, calibre);
  }

  spawnMuzzle(
    x: number, y: number, z: number, dx: number, dy: number, dz: number,
    calibre: number, tracerColor: number, local: boolean,
    vx = 0, vy = 0, vz = 0, rx = 1, ry = 0, rz = 0,
  ): void {
    spawnMuzzleFlash(this.core, x, y, z, dx, dy, dz, {
      calibre, tint: tracerColor, casings: true,
      vx, vy, vz, rx, ry, rz, shake: local ? 1 : 0,
    });
  }

  spawnRocketLaunch(
    x: number, y: number, z: number, dx: number, dy: number, dz: number,
    vx = 0, vy = 0, vz = 0,
  ): void {
    spawnRocketLaunch(this.core, x, y, z, dx, dy, dz, vx, vy, vz);
  }

  attachDamageEffects(entityId: number, model: VfxAircraftModel | null, damageBits: number): void {
    this.entities.attach(entityId, model, damageBits);
  }

  detachEntity(entityId: number): void {
    this.entities.detach(entityId, this.core);
  }

  /** Persistent world smoke: burning wrecks, oil fires, airfield marker pots. */
  addSmokeSource(x: number, y: number, z: number, scale: number, heat: number, ttl = Infinity): number {
    return this.sources.add(x, y, z, scale, heat, ttl);
  }

  removeSmokeSource(id: number): void { this.sources.remove(id); }

  setWind(x: number, y: number, z: number): void { this.core.wind.set(x, y, z); }
  setRain(v: number): void { this.rainIntensity = Math.max(0, Math.min(1, v)); }
  setHumidity(v: number): void {
    this.humidity = Math.max(0, Math.min(1.5, v));
    this.entities.humidity = this.humidity;
  }

  /**
   * Camera rigs should call this instead of letting the VFX system move the
   * camera. 'outOffset' is in camera-local axes (metres), 'outRoll' radians.
   */
  consumeShake(outOffset: THREE.Vector3): number {
    outOffset.copy(this.core.shakeOffset);
    return this.core.shakeRoll;
  }

  /** Live particle estimate, for the debug overlay. */
  get stats(): { particles: number; debris: number; entities: number } {
    return {
      particles: this.core.engine.liveCount,
      debris: this.core.debris.liveCount,
      entities: this.entities.count,
    };
  }

  reset(): void {
    this.core.clear();
    this.entities.clear(this.core);
    this.staging.clear(this.sources);
    this.sources.clear();
    clearDeferred();
    this.seedAirfieldSmoke();
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(ctx: GameContext): void {
    // Resolved on the first frame rather than in init(): by now every
    // subsystem has finished initialising, so a camera rig that threw during
    // boot has already been unregistered and we correctly take the shake back.
    if (!this.shakeOwnerResolved) {
      this.shakeOwnerResolved = true;
      if (ctx.get('camera')) this.ownCameraShake = false;
    }

    // Undo last frame's shake before the camera rig runs, so the offset is
    // idempotent whether the rig sets the camera absolutely or integrates it.
    if (this.ownCameraShake && (this.appliedOffset.lengthSq() > 0 || this.appliedRoll !== 0)) {
      ctx.camera.position.sub(_v.copy(this.appliedOffset).applyQuaternion(ctx.camera.quaternion));
      if (this.appliedRoll !== 0) {
        _shakeQ.setFromAxisAngle(_v2.set(0, 0, 1), -this.appliedRoll);
        ctx.camera.quaternion.multiply(_shakeQ);
      }
      this.appliedOffset.set(0, 0, 0);
      this.appliedRoll = 0;
    }

    const core = this.core;
    core.time = ctx.time;
    core.dt = ctx.dt;
    core.camera = ctx.camera;

    // Wind wanders slowly; the columns and contrails are what reveal it.
    this.windPhase += ctx.dt * 0.037;
    const gust = 1 + Math.sin(this.windPhase * 2.3) * 0.16 + Math.sin(this.windPhase * 0.7) * 0.10;
    _v.copy(core.wind).multiplyScalar(gust);
    core.engine.setWind(_v.x, _v.y, _v.z);

    // Fires claim a light during their own update; the claims are dropped here
    // and re-gathered every frame so a fire that goes out releases its light on
    // the next one.
    core.fireLight.begin();

    // Before the entity sweep: staging may add damage bits, and they should
    // take effect on the same frame rather than one late.
    this.staging.update(core, ctx, this.entities, this.sources);
    this.entities.update(core, ctx.entities, ctx.frame);
    updateDeferred(core);
    this.sources.update(core);

    core.debris.update(ctx.dt, this.debrisEnv);
    core.updateShake(ctx.dt);
  }

  lateUpdate(ctx: GameContext): void {
    const core = this.core;

    if (this.ownCameraShake) {
      const off = core.shakeOffset;
      if (off.lengthSq() > 1e-10 || core.shakeRoll !== 0) {
        this.appliedOffset.copy(off);
        this.appliedRoll = core.shakeRoll;
        ctx.camera.position.add(_v.copy(off).applyQuaternion(ctx.camera.quaternion));
        if (core.shakeRoll !== 0) {
          _shakeQ.setFromAxisAngle(_v2.set(0, 0, 1), core.shakeRoll);
          ctx.camera.quaternion.multiply(_shakeQ);
        }
        ctx.camera.updateMatrixWorld();
      }
    }

    // Uniform sync happens here, not in update(), because the camera rig runs
    // *after* us in the update pass — the sun's view-space direction and the
    // canopy card would otherwise both be a frame stale.
    this.renderSize(ctx, _size);
    core.engine.sync(ctx.time, ctx.camera, ctx.sunDir, ctx.sunColor, ctx.scene.fog, _size.x, _size.y);
    core.engine.globals.uShadowTint.value.copy(ctx.ambientColor).multiplyScalar(1.15);
    core.debris.setResolution(_size.x, _size.y);
    this.bindDepth();

    // Canopy rain rides the local aircraft's airspeed, and must be pinned to
    // the camera *after* the shake has moved it.
    const local = ctx.entities.get(ctx.localEntityId);
    const speed = local ? Math.hypot(local.vx, local.vy, local.vz) : 0;
    this.rain.intensity = this.rainIntensity;
    this.rain.update(ctx.time, ctx.camera, speed);

    // After the camera rig has run, so the "which fire matters" scoring uses
    // the pose the frame is actually rendered from.
    core.fireLight.commit(ctx.time, ctx.dt, ctx.camera);

    core.flush();
  }

  resize(width: number, height: number): void {
    // Deliberately a no-op. 'width'/'height' are CSS pixels, and the buffer the
    // shaders index — the composer's depth texture — is device pixels times
    // settings.renderScale. lateUpdate recomputes the right number every frame
    // (renderSize below), so trusting these arguments could only make it wrong.
    void width; void height;
  }

  /**
   * The size of the buffer the particle shaders are actually rasterising into.
   *
   * 'gl_FragCoord.xy / uResolution' has to land on the same texel the composer's
   * depth prepass wrote, and RenderSystem.computeRenderSize sizes every one of
   * its targets to drawingBufferSize x clamp(settings.renderScale, 0.5, 1) —
   * the 'low' preset uses 0.75. Reading the drawing-buffer size alone therefore
   * samples the depth buffer at the wrong scale on exactly the tier the brief
   * targets, and the debris outline's pixelScale is off by 1/renderScale with
   * it. If the render subsystem ever publishes its internal size, prefer that.
   */
  private renderSize(ctx: GameContext, out: THREE.Vector2): THREE.Vector2 {
    if (!this.render) this.render = ctx.get<any>('render') ?? null;
    const rs = this.render?.renderSize;
    if (rs && rs.x > 0 && rs.y > 0) return out.set(rs.x, rs.y);
    ctx.renderer.getDrawingBufferSize(out);
    const s = clamp(ctx.settings.renderScale || 1, 0.5, 1);
    return out.set(Math.max(1, Math.round(out.x * s)), Math.max(1, Math.round(out.y * s)));
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.unsub.length = 0;
    this.ctx?.scene.remove(this.core.root);
    this.ctx?.scene.remove(this.rain.mesh);
    this.ctx?.scene.remove(this.core.fireLight.group);
    this.core.dispose();
    this.rain.dispose();
    if (active === this) active = null;
  }

  // -------------------------------------------------------------------------

  /**
   * Soft-depth fading needs the scene depth buffer. We do not own the
   * composer, so we look for one on the render subsystem every frame (it is a
   * property read) and stay in hard-edged mode until one appears.
   */
  private bindDepth(): void {
    if (!this.render) this.render = this.ctx.get<any>('render') ?? null;
    const r = this.render;
    const tex = r?.depthTexture ?? r?.sceneDepthTexture ?? r?.depthTarget?.depthTexture ?? null;
    this.core.engine.setDepthTexture(tex ?? null);
    if (!tex && !this.depthWarned) {
      this.depthWarned = true;
      console.info('[vfx] no scene depth texture — soft particle fading disabled');
    }
  }

  /** Bound once; the debris system calls back into the particle pools. */
  private debrisEnv = {
    terrainHeight: (x: number, z: number) => this.core.terrain.height(x, z),
    onTrail: (d: { x: number; y: number; z: number; vx: number; vy: number; vz: number; burning: number; scale: number }) => {
      const core = this.core;
      const p = resetSpawn();
      const now = core.time;
      // Burning debris leaves a corkscrewing ribbon of smoke and embers, which
      // is what makes a shot-down aircraft's wreckage readable at range.
      p.x = d.x; p.y = d.y; p.z = d.z;
      p.vx = d.vx * 0.10 + core.sym(1.2);
      p.vy = d.vy * 0.10 + core.rand(0.4, 2.0);
      p.vz = d.vz * 0.10 + core.sym(1.2);
      p.life = core.rand(0.8, 2.4);
      p.size0 = d.scale * core.rand(0.8, 1.6);
      p.size1 = d.scale * core.rand(5, 11);
      p.rot = core.rand(0, 6.283); p.spin = core.sym(0.8);
      p.drag = core.rand(1.0, 2.0); p.grav = -0.08;
      p.wind = 1.0; p.turb = 0.6;
      p.ramp = RAMP.SmokeGrey; p.tile = TILE.Wisp;
      p.erode = 0.66; p.band = 0.8; p.a = 0.85;
      core.smoke.emit(now, p);

      if (core.rng.next() < 0.45) {
        p.x = d.x; p.y = d.y; p.z = d.z;
        p.vx = d.vx * 0.2 + core.sym(2);
        p.vy = d.vy * 0.2 + core.rand(0, 3);
        p.vz = d.vz * 0.2 + core.sym(2);
        p.life = core.rand(0.14, 0.4);
        p.size0 = d.scale * 1.2; p.size1 = d.scale * 2.2;
        p.rot = core.rand(0, 6.283); p.spin = core.sym(4);
        p.drag = 3; p.grav = -0.4; p.wind = 0.3; p.turb = 0.6;
        p.ramp = RAMP.FireStream; p.tile = TILE.Wisp;
        p.erode = core.rand(0.3, 0.7); p.band = 1.6; p.a = 1;
        core.fire.emit(now, p);
      }
    },
    onImpact: (x: number, y: number, z: number, speed: number, kind: string) => {
      if (speed < 4) return;
      const core = this.core;
      const surf = core.terrain.type(x, z);
      if (surf === 'water') {
        spawnImpactAt(core, x, y, z, 0, 1, 0, 'water', Math.min(40, 8 + speed * 0.4));
        return;
      }
      spawnImpactAt(core, x, y, z, 0, 1, 0, surf, kind === 'casing' ? 6 : Math.min(30, 6 + speed * 0.3));
    },
  };
}

/**
 * The world's terrain classification and the VFX surface vocabulary overlap but
 * are not identical — the world cares about friction and AI, we care about what
 * a bullet throws up. Anything unrecognised falls through to soil, which is the
 * safe default.
 */
function mapSurface(t: string): SurfaceKind {
  switch (t) {
    case 'runway': return 'concrete';
    case 'water': return 'water';
    case 'sand': return 'sand';
    case 'rock': return 'rock';
    case 'snow': return 'snow';
    case 'grass': return 'grass';
    default: return 'ground';
  }
}

/** A finite number, or null — bus payloads are untyped and half-populated. */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp01(v: number): number { return clamp(v, 0, 1); }

function calibreOf(b: number, fallback: number): number {
  // The wire field is context-dependent; treat anything in a plausible gun
  // calibre range as millimetres and ignore the rest.
  return b >= 5 && b <= 152 ? b : fallback;
}

// ---------------------------------------------------------------------------
// Free-function API for the entity / combat systems
// ---------------------------------------------------------------------------

export interface Vec3Like { x: number; y: number; z: number }

/** Spawns a layered explosion. 'scale' is a metre-ish blast radius. */
export function spawnExplosion(pos: Vec3Like, scale: number, kind: ExplosionKind = 'air'): void {
  active?.spawnExplosion(pos.x, pos.y, pos.z, scale, kind);
}

/** Surface-aware projectile impact. 'calibre' in millimetres. */
export function spawnImpact(
  pos: Vec3Like, normal: Vec3Like, surface: SurfaceKind, calibre: number,
): void {
  active?.spawnImpact(pos.x, pos.y, pos.z, normal.x, normal.y, normal.z, surface, calibre);
}

/**
 * Registers (or refreshes) the continuous damage effects for an entity.
 * Pass the built aircraft model so plumes anchor to the real exhaust ports and
 * wingtips; pass null to fall back to body-frame estimates. Safe to call every
 * time the damage state changes — it is idempotent.
 */
export function attachDamageEffects(
  entityId: number, model: VfxAircraftModel | null, damageBits: number,
): void {
  active?.attachDamageEffects(entityId, model, damageBits);
}

/** Muzzle flash, barrel smoke, spent brass and recoil for one shot. */
export function spawnMuzzle(
  pos: Vec3Like, dir: Vec3Like, calibre: number, tracerColor: number, local = false,
  vel?: Vec3Like, right?: Vec3Like,
): void {
  active?.spawnMuzzle(
    pos.x, pos.y, pos.z, dir.x, dir.y, dir.z, calibre, tracerColor, local,
    vel?.x ?? 0, vel?.y ?? 0, vel?.z ?? 0,
    right?.x ?? 1, right?.y ?? 0, right?.z ?? 0,
  );
}

/** Rocket launch backblast. */
export function spawnLaunch(pos: Vec3Like, dir: Vec3Like, vel?: Vec3Like): void {
  active?.spawnRocketLaunch(
    pos.x, pos.y, pos.z, dir.x, dir.y, dir.z,
    vel?.x ?? 0, vel?.y ?? 0, vel?.z ?? 0,
  );
}

/** Persistent world smoke (burning wreck, oil fire, airfield pot). */
export function addSmokeSource(pos: Vec3Like, scale: number, heat: number, ttl = Infinity): number {
  return active?.addSmokeSource(pos.x, pos.y, pos.z, scale, heat, ttl) ?? 0;
}

export function removeSmokeSource(id: number): void { active?.removeSmokeSource(id); }

/** The live VFX system, or null before boot. */
export function vfx(): VfxSystem | null { return active; }

