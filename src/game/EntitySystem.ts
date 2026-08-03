import * as THREE from 'three';
import type { GameContext, QualityTier, Subsystem } from '../engine/context';
import { EntityKind, EventKind, DamageBits } from '../shared/protocol';
import { AIRCRAFT, aircraftByIndex, type AircraftSpec } from '../shared/aircraft';
import { loadExternals, externals, type AircraftModel } from './externals';
import { getClientEnv, type ClientEnv } from './env';
import { buildFallbackAircraft, disposeFallbackAircraft } from './fallback/fallbackAircraft';
import { AircraftView, DetailTier, type ViewFx } from './AircraftView';
import { TracerRenderer } from './visual/TracerRenderer';
import { BulletHoleField, GroundScarField } from './visual/Decals';
import { makeSmokeField, makeFireField, SMOKE_PRESETS, FIRE_PRESETS, type BillboardField } from './visual/Particles';
import { DebrisField } from './visual/Debris';
import { ParachuteField } from './visual/Parachutes';
import { updateCelGlobals } from '../render/CelMaterial';
import type { VfxSystem } from '../vfx/VfxSystem';

/**
 * Turns the replicated entity table into a scene.
 *
 * Everything here is pooled. Building a procedural airframe costs tens of
 * milliseconds; doing it when a player spawns would produce a visible hitch at
 * exactly the moment the player is looking for their aeroplane. So every
 * aircraft type is pre-warmed during boot and models are recycled between
 * entities for the lifetime of the process — nothing is built, and nothing is
 * disposed, after 'init' returns.
 *
 * Draw-call budget for a full 16-aircraft furball plus hundreds of rounds:
 * one per visible airframe (plus its outline hull), one for every tracer in
 * the sky, one for every bullet hole, one for smoke, one for fire. Everything
 * that can be instanced, is.
 */

/** How many spare airframes of each type to pre-build, by quality tier. */
const POOL_BY_QUALITY: Record<QualityTier, number> = {
  low: 2, medium: 3, high: 4, ultra: 4,
};

const SMOKE_BY_QUALITY: Record<QualityTier, number> = {
  low: 220, medium: 420, high: 700, ultra: 950,
};

const FIRE_BY_QUALITY: Record<QualityTier, number> = {
  low: 90, medium: 160, high: 260, ultra: 340,
};

/** Distance thresholds for the animation tiers, metres. */
const TIER_FULL = 420;
const TIER_MEDIUM = 1500;
const TIER_COARSE = 3600;

const _sphere = new THREE.Sphere();
const _frustum = new THREE.Frustum();
const _projView = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _wind = new THREE.Vector3();
const _windV = { x: 0, y: 0, z: 0 };
/** Reused removal list — see 'syncEntities'. */
const _dead: number[] = [];

export class EntitySystem implements Subsystem {
  readonly name = 'entities';

  /** Parent of every aircraft holder. Named so debris can find rig roots. */
  readonly group = new THREE.Group();

  private ctx!: GameContext;
  private env!: ClientEnv;

  /** Free views per aircraft type index. */
  private pools: AircraftView[][] = [];
  private active = new Map<number, AircraftView>();
  private allViews: AircraftView[] = [];

  private tracers!: TracerRenderer;
  private holes!: BulletHoleField;
  private scars!: GroundScarField;
  private smoke!: BillboardField;
  private fire!: BillboardField;
  private debris!: DebrisField;
  private chutes!: ParachuteField;
  private fx!: ViewFx;

  private quality: QualityTier = 'high';
  private qualityScale = 1;
  private unsubs: Array<() => void> = [];

  /** Entities whose wreck has already burned a scar into the ground. */
  private scarred = new Set<number>();

  /**
   * The VFX subsystem, resolved lazily.
   *
   * We are the only system that knows the entityId → AircraftModel mapping, so
   * we are the only one that can hand 'EntityFxRegistry' the rig's real anchor
   * points — exhaust stubs, gun ports and wingtip markers. Without that call
   * contrails, wingtip vortices, prop-tip trails and exhaust smoke all fall
   * back to positions guessed from the entity transform.
   */
  private vfx: VfxSystem | null = null;
  private vfxResolved = false;

  async init(ctx: GameContext): Promise<void> {
    this.ctx = ctx;
    this.quality = ctx.quality;
    this.qualityScale = qualityScale(ctx.quality);
    this.env = getClientEnv(ctx.mapSeed);

    await loadExternals(ctx.mapSeed);

    this.group.name = 'entities';
    ctx.scene.add(this.group);

    this.tracers = new TracerRenderer(this.qualityScale);
    ctx.scene.add(this.tracers.mesh);

    this.holes = new BulletHoleField(this.quality === 'low' ? 192 : 512);
    ctx.scene.add(this.holes.mesh);

    this.scars = new GroundScarField(24);
    ctx.scene.add(this.scars.group);

    this.smoke = makeSmokeField(SMOKE_BY_QUALITY[this.quality]);
    this.fire = makeFireField(FIRE_BY_QUALITY[this.quality]);
    ctx.scene.add(this.smoke.mesh, this.fire.mesh);

    this.debris = new DebrisField(this.env, this.quality === 'low' ? 24 : 56);
    ctx.scene.add(this.debris.group);

    this.chutes = new ParachuteField(this.env, 8);
    ctx.scene.add(this.chutes.group);

    this.fx = { smoke: this.smoke, fire: this.fire, debris: this.debris, holes: this.holes };

    await this.prewarm();

    this.unsubs.push(ctx.bus.on('game:event', (e) => this.onGameEvent(e)));
    this.unsubs.push(ctx.bus.on('quality', (q: QualityTier) => {
      this.quality = q;
      this.qualityScale = qualityScale(q);
      this.tracers.setQuality(this.qualityScale);
    }));
  }

  // -------------------------------------------------------------------------
  // Pooling
  // -------------------------------------------------------------------------

  /**
   * Builds every aircraft type up front. Yields to the event loop between
   * airframes so the boot progress bar keeps painting instead of freezing.
   */
  private async prewarm(): Promise<void> {
    const per = POOL_BY_QUALITY[this.quality];
    for (let t = 0; t < AIRCRAFT.length; t++) {
      this.pools[t] = [];
      for (let i = 0; i < per; i++) {
        this.pools[t].push(this.build(t));
        await yieldFrame();
      }
    }
  }

  private build(typeId: number): AircraftView {
    const spec: AircraftSpec = aircraftByIndex(typeId);
    const ext = externals();
    let model: AircraftModel;
    if (ext.buildAircraft) {
      try {
        model = ext.buildAircraft(spec);
      } catch (err) {
        console.error(`[entities] buildAircraft("${spec.id}") threw; using the stand-in`, err);
        model = buildFallbackAircraft(spec);
      }
    } else {
      model = buildFallbackAircraft(spec);
    }
    const view = new AircraftView(spec, typeId, model);
    this.allViews.push(view);
    return view;
  }

  /**
   * The VFX subsystem, or null if it failed to boot. Resolved once, lazily,
   * because subsystem 'init' order is not guaranteed and 'ctx.get' returns
   * undefined for anything registered after us.
   */
  private vfxSystem(): VfxSystem | null {
    if (!this.vfxResolved) {
      this.vfxResolved = true;
      this.vfx = this.ctx.get<VfxSystem>('vfx') ?? null;
    }
    return this.vfx;
  }

  private acquire(typeId: number, entityId: number, team: number): AircraftView {
    const t = Math.min(Math.max(0, typeId), AIRCRAFT.length - 1);
    let pool = this.pools[t];
    if (!pool) { pool = this.pools[t] = []; }
    let view = pool.pop();
    if (!view) {
      // Pool exhausted — build one more rather than dropping the aircraft, and
      // keep it in the pool afterwards so the hitch happens at most once.
      console.warn(`[entities] pool for type ${t} exhausted; building an extra airframe`);
      view = this.build(t);
    }
    view.reset(entityId, team);
    this.group.add(view.holder);
    this.active.set(entityId, view);

    // Hand VFX the real rig so its contrails, vortices and damage plume anchor
    // to the actual exhaust stubs, gun ports and wingtips.
    const vfx = this.vfxSystem();
    if (vfx) {
      vfx.entities.attach(entityId, view.model as Parameters<typeof vfx.entities.attach>[1], 0);
      view.damagePlumeOwnedByVfx = true;
    }
    return view;
  }

  private release(entityId: number): void {
    const view = this.active.get(entityId);
    if (!view) return;
    this.active.delete(entityId);
    const vfx = this.vfxSystem();
    if (vfx) vfx.entities.detach(entityId, vfx.core);
    // Any part of this rig still tumbling has to come home before the model is
    // handed to another entity, or the next spawn is missing a wing.
    this.debris.recallOwner(view.viewId);
    this.holes.releaseOwner(view.viewId);
    this.group.remove(view.holder);
    view.holder.visible = false;
    this.pools[view.typeId].push(view);
    this.scarred.delete(entityId);
    // The chute the bailout spawned is keyed off the aircraft id; without this
    // a canopy left the scene only when its lifetime ran out.
    this.chutes.despawn(entityId + 40000);
  }

  // -------------------------------------------------------------------------
  // Public lookup — used by camera, audio and HUD
  // -------------------------------------------------------------------------

  /** The rig for a live entity, or undefined. */
  modelFor(entityId: number): AircraftModel | undefined {
    return this.active.get(entityId)?.model;
  }

  /** The full view (transform, kinematics, damage state) for a live entity. */
  viewFor(entityId: number): AircraftView | undefined {
    return this.active.get(entityId);
  }

  /** Scene node an aircraft is parented to — safe to attach a camera rig to. */
  holderFor(entityId: number): THREE.Object3D | undefined {
    return this.active.get(entityId)?.holder;
  }

  get activeAircraft(): ReadonlyMap<number, AircraftView> { return this.active; }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(ctx: GameContext): void {
    const dt = ctx.dt;
    const cam = ctx.camera;

    // Frustum for culling, from the camera matrices the camera subsystem has
    // already written this frame.
    cam.updateMatrixWorld();
    _projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projView);

    this.syncEntities(ctx);

    for (const [id, view] of this.active) {
      const s = ctx.entities.get(id);
      if (!s) continue;

      view.applyTransform(s, dt);

      const dist = cam.position.distanceTo(view.holder.position);
      view.distance = dist;

      // A Group has no bounding volume, so derive one from the airframe's own
      // dimensions rather than paying for a per-frame world-space box.
      const radius = Math.max(view.spec.aero.span, view.spec.geom.length) * 0.62;
      _sphere.center.copy(view.holder.position);
      _sphere.radius = radius;
      const isLocal = id === ctx.localEntityId;
      const onScreen = isLocal || _frustum.intersectsSphere(_sphere);

      const gh = this.env.terrainHeight(s.px, s.pz);
      const clearance = s.py - gh;

      // 'holder.visible' is not a *rendering* flag, it is a scene-graph flag,
      // and three's shadow pass walks the same graph: an invisible subtree is
      // dropped from the shadow map as well as from the colour pass. So culling
      // on the camera frustum alone deletes the cast shadow of every aircraft
      // that is merely off the edge of the picture — a wingman one wingspan
      // above the top of frame stops laying a shadow across the field the
      // player is looking straight at, and it pops back the instant it drifts
      // into view. The shadow is the depth cue that survives longest; it has no
      // business being tied to whether the caster itself is in shot.
      //
      // The shadow of an aircraft lands where the sun ray through it meets the
      // ground, which is (height above ground / sin elevation) further along
      // that ray. Testing a sphere there against the camera frustum costs one
      // terrain sample and one plane test, and it is the same test the shadow
      // rig's own fit is built on, so the two agree by construction. Skipped
      // once the aircraft is high enough that its shadow is a smear the size of
      // a shadow-map texel — there is nothing left to preserve.
      let castsIntoView = false;
      if (!onScreen && clearance > 0 && clearance < 900) {
        const sinElev = Math.max(0.08, Math.abs(ctx.sunDir.y));
        const t = clearance / sinElev;
        _sphere.center.set(
          s.px + ctx.sunDir.x * t,
          gh,
          s.pz + ctx.sunDir.z * t,
        );
        // The shadow of a banking aircraft is wider than the aircraft, and the
        // penumbra widens it again, so the probe is generous.
        _sphere.radius = radius * 1.6;
        castsIntoView = _frustum.intersectsSphere(_sphere);
      }
      view.holder.visible = onScreen || castsIntoView;

      // Detail tier still follows what is *in shot*: a caster kept alive purely
      // for its shadow is a few texels of silhouette, and animating its
      // ailerons and spinning its wheels for that is pure cost.
      view.tier = !onScreen ? DetailTier.None
        : dist < TIER_FULL ? DetailTier.Full
          : dist < TIER_MEDIUM ? DetailTier.Medium
            : dist < TIER_COARSE ? DetailTier.Coarse
              : DetailTier.None;

      if (onScreen) view.animate(s, dt, ctx.time, clearance);

      // Damage effects run even when culled: a burning aircraft behind you is
      // still making smoke, and the plume must already exist when you turn.
      view.updateDamage(s, dt, this.fx, this.qualityScale);

      // A destroyed airframe that has reached the ground scorches the terrain.
      if ((s.damage & DamageBits.Destroyed) && clearance < 3 && !this.scarred.has(id)) {
        this.scarred.add(id);
        this.env.terrainNormal(s.px, s.pz, _windV);
        _n.set(_windV.x, _windV.y, _windV.z);
        this.scars.add(s.px, gh, s.pz, _n, view.spec.aero.span * 0.55, ctx.time);
      }
    }

    // --- projectiles --------------------------------------------------------
    this.tracers.collect(ctx.entities);

    // --- shared fx ----------------------------------------------------------
    this.env.windAt({ x: cam.position.x, y: cam.position.y, z: cam.position.z }, _windV);
    _wind.set(_windV.x, _windV.y, _windV.z);
    this.smoke.update(dt, _wind);
    this.fire.update(dt, _wind);
    this.debris.update(dt, this.debrisEmit);
    this.chutes.update(dt, ctx.time);
    this.scars.update(ctx.time);

    // Decals are re-composed after every transform is final.
    this.holes.setSunDir(ctx.sunDir);
    this.holes.update(this.resolveOwner, ctx.time);

    // Keep the cel materials' sun/sky uniforms fresh even if the render system
    // has not landed yet, so aircraft are never lit by the built-in defaults.
    updateCelGlobals(ctx);
    this.smoke.setFog(ctx.ambientColor, 26000);
    this.fire.setFog(ctx.ambientColor, 26000);
  }

  /** Bound once — 'BulletHoleField' calls it per decal. */
  private resolveOwner = (owner: number): THREE.Matrix4 | null => {
    const v = this.active.get(owner);
    if (!v || !v.holder.visible) return null;
    return v.holder.matrixWorld;
  };

  private debrisEmit = (
    x: number, y: number, z: number, vx: number, vy: number, vz: number, burning: boolean,
  ): void => {
    if (burning) {
      this.fire.emit(x, y, z, vx, vy, vz, FIRE_PRESETS.engine);
      this.smoke.emit(x, y, z, vx, vy, vz, SMOKE_PRESETS.fire);
    } else if (Math.random() < 0.35) {
      this.smoke.emit(x, y, z, vx, vy, vz, SMOKE_PRESETS.debris);
    }
  };

  /** Spawns and despawns views to match the replicated entity table. */
  private syncEntities(ctx: GameContext): void {
    const maxType = AIRCRAFT.length - 1;
    for (const [id, s] of ctx.entities) {
      if (s.kind === EntityKind.Aircraft || s.kind === EntityKind.Wreck) {
        const existing = this.active.get(id);
        if (!existing) {
          this.acquire(s.typeId, id, s.team);
        } else if (existing.typeId !== Math.min(Math.max(0, s.typeId), maxType)) {
          // The server reused an entity id for a different airframe.
          this.release(id);
          this.acquire(s.typeId, id, s.team);
        }
      } else if (s.kind === EntityKind.Parachute) {
        if (!this.chutes.has(id)) {
          this.chutes.spawn(id, s.px, s.py, s.pz, _v.set(s.vx, s.vy, s.vz));
        } else {
          this.chutes.track(id, s.px, s.py, s.pz);
        }
      }
    }

    // Deferred removal into a reused array: spreading 'this.active.keys()'
    // allocated a fresh array of every live entity every single frame.
    _dead.length = 0;
    for (const id of this.active.keys()) {
      const s = ctx.entities.get(id);
      if (!s || (s.kind !== EntityKind.Aircraft && s.kind !== EntityKind.Wreck)) _dead.push(id);
    }
    for (let i = 0; i < _dead.length; i++) this.release(_dead[i]);
    _dead.length = 0;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private onGameEvent(e: {
    kind: EventKind; x: number; y: number; z: number;
    nx: number; ny: number; nz: number; scale: number; a: number; b: number;
  }): void {
    switch (e.kind) {
      case EventKind.HitSpark:
      case EventKind.HitArmour: {
        const view = this.active.get(e.a);
        if (!view) return;
        // 'n' from the server is the reversed round velocity: a good stand-in
        // for the surface normal at the impact and, more usefully, always
        // pointing back toward the shooter, so the hole faces the camera that
        // is most likely to be looking at it.
        _n.set(e.nx, e.ny, e.nz);
        if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0);
        _v.set(e.x, e.y, e.z);
        const calibre = Math.max(7, e.scale * 20);
        this.holes.add(view.viewId, view.holder.matrixWorld, _v, _n.normalize(), calibre, this.ctx.time);
        break;
      }
      case EventKind.Bailout: {
        const view = this.active.get(e.a);
        if (view) {
          view.jettisonCanopy(this.fx);
          view.removePilot();
        }
        // The server may or may not replicate a Parachute entity; spawning a
        // local one keyed off the aircraft id guarantees the bailout reads
        // either way, and the 'has' check stops us doubling up if it does.
        const key = e.a + 40000;
        if (!this.chutes.has(key)) {
          this.chutes.spawn(key, e.x, e.y, e.z, _v.set(e.nx, e.ny, e.nz).multiplyScalar(e.scale || 1));
        }
        break;
      }
      case EventKind.StructureFail: {
        for (let i = 0; i < 6; i++) {
          this.smoke.emit(
            e.x, e.y, e.z,
            (Math.random() - 0.5) * 22, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 22,
            SMOKE_PRESETS.debris,
          );
        }
        break;
      }
      case EventKind.GroundImpact:
      case EventKind.Explosion: {
        // Only large explosions on the deck leave a mark.
        const gh = this.env.terrainHeight(e.x, e.z);
        if (e.scale >= 2 && e.y - gh < 12) {
          this.env.terrainNormal(e.x, e.z, _windV);
          _n.set(_windV.x, _windV.y, _windV.z);
          this.scars.add(e.x, gh, e.z, _n, 5 + e.scale * 3, this.ctx.time);
        }
        break;
      }
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.debris.dispose();
    this.chutes.dispose();
    this.tracers.dispose();
    this.holes.dispose();
    this.scars.dispose();
    this.smoke.dispose();
    this.fire.dispose();
    const ext = externals();
    for (const v of this.allViews) {
      v.dispose();
      if ((v.model as Record<string, unknown>).__fallback) disposeFallbackAircraft(v.model);
      else ext.disposeAircraft?.(v.model);
    }
    this.allViews.length = 0;
    this.active.clear();
    this.pools.length = 0;
  }
}

// ---------------------------------------------------------------------------

function qualityScale(q: QualityTier): number {
  return q === 'low' ? 0.4 : q === 'medium' ? 0.7 : q === 'high' ? 1 : 1.25;
}

/** Yields to the browser so the boot bar can repaint between airframes. */
function yieldFrame(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
