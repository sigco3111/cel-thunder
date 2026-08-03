import * as THREE from 'three';
import type { GameContext, QualityTier, Subsystem } from '../engine/context';
import {
  getHeightfield, MAP_HALF, MAP_SIZE, SEA_LEVEL,
  type AirfieldSite, type Heightfield, type TerrainType,
} from './heightfield';
import { getWorldTextures, type WorldTextures } from './TerrainTextures';
import { TerrainRenderer } from './TerrainRenderer';
import { Water } from './Water';
import { Vegetation } from './Vegetation';
import { buildAirfield, type AirfieldBuild } from './Airfield';
import { buildGroundTargets, type GroundTarget, type GroundTargetsBuild } from './GroundTargets';
import { celGlobals } from '../render/CelMaterial';
import { AERIAL_FAR_SCALE, AERIAL_STRENGTH_SCALE } from './terrainMaterial';
import { WATER_AERIAL_FAR_SCALE, WATER_AERIAL_STRENGTH_SCALE } from './Water';

/**
 * Owns the whole physical world: terrain, ocean, vegetation, airfields and
 * ground targets — and the query API that physics, the camera, the AI and the
 * headless server all go through.
 *
 * Draw-call budget: terrain 1, ocean 1, vegetation 4-6, airfields ~16,
 * ground targets ~12. Everything else is instanced or merged.
 */
export class WorldSystem implements Subsystem {
  readonly name = 'world';

  private hf!: Heightfield;
  private textures!: WorldTextures;
  private terrain!: TerrainRenderer;
  private water!: Water;
  private veg!: Vegetation;
  private fields: AirfieldBuild[] = [];
  private groundTargets: GroundTargetsBuild | null = null;
  private root!: THREE.Group;
  private quality: QualityTier = 'high';
  private windDir = 0.9;
  private windSpeed = 7;

  // ---- lifecycle ----------------------------------------------------------

  init(ctx: GameContext): void {
    this.hf = getHeightfield(ctx.mapSeed);
    this.quality = ctx.quality;

    const maxAniso = ctx.renderer.capabilities.getMaxAnisotropy();
    this.textures = getWorldTextures(Math.min(8, maxAniso));

    this.root = new THREE.Group();
    this.root.name = 'world';
    this.root.matrixAutoUpdate = false;
    ctx.scene.add(this.root);

    // Airfields and ground targets are built BEFORE the terrain renderer.
    // Both grade the baked heightfield under their footprints (the airfield
    // pads inside bake(), the factory and rail yard through flattenSite), and
    // the renderer uploads that array as a GPU texture and derives its culling
    // pyramid from it — so the grading has to be finished before either is
    // taken. Nothing here needs the renderer to exist.
    for (const site of this.hf.airfields) {
      const built = buildAirfield(site, ctx.mapSeed);
      this.fields.push(built);
      this.root.add(built.group);
    }

    this.groundTargets = buildGroundTargets(
      this.hf, ctx.mapSeed,
      this.hf.airfields.map((a) => ({ x: a.x, z: a.z })),
    );
    this.root.add(this.groundTargets.group);
    this.hf.commitSites();

    this.terrain = new TerrainRenderer(this.hf, this.textures, gridForQuality(ctx.quality));
    this.root.add(this.terrain.mesh);
    this.terrain.setPads(this.hf.airfields);
    if (this.hf.airfields.length >= 2) {
      const a = this.hf.airfields[0], b = this.hf.airfields[1];
      this.terrain.setRoad(a.x, a.z, b.x, b.z);
    }

    this.water = new Water(this.terrain.heightTex, this.textures);
    this.root.add(this.water.mesh);

    this.veg = new Vegetation(this.hf, ctx.quality);
    this.root.add(this.veg.group);

    // Wind is derived from the seed so the windsocks, the sea state and any
    // future ballistics all agree without another subsystem owning it.
    this.windDir = (ctx.mapSeed % 628) / 100;
    this.windSpeed = 4 + ((ctx.mapSeed >> 8) % 90) / 10;

    ctx.bus.on('quality', (q: QualityTier) => this.applyQuality(q));

    // Warm the vegetation scatter now rather than on the first rendered
    // frame: the initial fill touches every cell inside the impostor radius
    // and would otherwise show up as a ~60 ms hitch one frame after the
    // loading screen disappears.
    this.terrain.update(ctx);
    this.veg.update(ctx.camera, this.terrain.frustum);

    // Publish the map facts other subsystems need before they spawn anything.
    ctx.bus.emit('world:ready', {
      airfields: this.hf.airfields,
      seaLevel: SEA_LEVEL,
      mapSize: MAP_SIZE,
      maxHeight: this.hf.maxHeight,
      spawns: this.spawnPoints(),
      targets: this.groundTargets?.targets ?? [],
      windDir: this.windDir,
      windSpeed: this.windSpeed,
    });
  }

  update(ctx: GameContext): void {
    this.terrain.update(ctx);
    this.water.update(ctx.camera, ctx.time);
    this.veg.setWind(this.windDir, this.windSpeed, ctx.time);
    this.veg.update(ctx.camera, this.terrain.frustum);

    // Aerial perspective. The terrain and the ocean want their own falloff —
    // ground haze builds up far faster than haze on an aircraft 300 m away —
    // but they must keep it as a RATIO against the shared, weather-driven
    // value rather than as a hard-coded constant. Shadowing celGlobals with
    // 15000/34000 meant that flying into a squall thickened the aircraft, the
    // props, the structures and the clouds while the two largest surfaces in
    // the frame stayed at permanent, unweathered clarity.
    const far = celGlobals.uAerialFar.value as number;
    const str = celGlobals.uAerialStrength.value as number;
    const tu = this.terrain.material.terrainUniforms;
    tu.uAerialFar.value = far * AERIAL_FAR_SCALE;
    tu.uAerialStrength.value = str * AERIAL_STRENGTH_SCALE;
    const wu = this.water.material.waterUniforms;
    wu.uAerialFar.value = far * WATER_AERIAL_FAR_SCALE;
    wu.uAerialStrength.value = str * WATER_AERIAL_STRENGTH_SCALE;

    // Windsocks: yaw into the wind and lift with its strength, with a slow
    // flutter so they never look frozen. The Euler order is set to 'YXZ' at
    // build time (see Airfield.ts) so the lift is a pitch about the sock's own
    // lateral axis and works at every wind direction, not just along +/-Z.
    const flutter = Math.sin(ctx.time * 1.7) * 0.09 + Math.sin(ctx.time * 3.1 + 1.3) * 0.05;
    const lift = -Math.PI * 0.5 * Math.min(1, this.windSpeed / 12) + 0.35;
    for (const f of this.fields) {
      for (const s of f.socks) {
        s.rotation.set(lift + flutter * 0.6, this.windDir + flutter, 0);
      }
    }
  }

  private applyQuality(q: QualityTier): void {
    if (q === this.quality) return;
    this.quality = q;
    this.terrain.setGrid(gridForQuality(q));
    const tu = this.terrain.material.terrainUniforms;
    tu.uDetailFar.value = q === 'low' ? 3200 : q === 'medium' ? 5000 : 7000;
    tu.uFieldStrength.value = q === 'low' ? 0.55 : 1.0;
    // Ground metres per pixel past which hedgerow geometry is not evaluated.
    // A footprint budget, not a distance: see uHedgeMaxPx in terrainMaterial.
    tu.uHedgeMaxPx.value = q === 'low' ? 9.0 : q === 'medium' ? 17.0 : 30.0;
    this.veg.setQuality(q);
  }

  dispose(): void {
    this.terrain.dispose();
    this.water.dispose();
    this.veg.dispose();
    for (const f of this.fields) f.dispose();
    this.groundTargets?.dispose();
    this.textures.dispose();
    this.root.parent?.remove(this.root);
  }

  // ---- public query API ---------------------------------------------------
  //
  // Every accessor below tolerates being called before 'init'. Consumers probe
  // for a terrain sampler during their own initialisation, and subsystem order
  // is a property of main.ts rather than of this file — so the query API is
  // made total rather than depending on a registration order it cannot enforce.
  // Before init the world is a flat plane at sea level, which is exactly what
  // an un-generated map should look like.

  /**
   * Terrain elevation at a world XZ, in metres. Exactly the surface the GPU
   * renders (both are a bilinear tap of the same baked field), and cheap
   * enough to call per contact point per physics tick.
   */
  terrainHeight(x: number, z: number): number {
    return this.hf ? this.hf.heightAt(x, z) : SEA_LEVEL;
  }

  /** Unit surface normal. Allocates only if no output vector is supplied. */
  terrainNormal(x: number, z: number, out?: THREE.Vector3): THREE.Vector3 {
    const v = out ?? new THREE.Vector3();
    if (!this.hf) return v.set(0, 1, 0);
    this.hf.normalAt(x, z, _n3);
    return v.set(_n3.x, _n3.y, _n3.z);
  }

  /** Surface classification, used for friction, effects and AI. */
  terrainType(x: number, z: number): TerrainType {
    return this.hf ? this.hf.typeAt(x, z) : ('grass' as TerrainType);
  }

  /** sin of the terrain inclination, 0 flat .. 1 vertical. */
  terrainSlope(x: number, z: number): number {
    return this.hf ? this.hf.slopeAt(x, z) : 0;
  }

  /** Height of the ground *or* the water surface, whichever is higher. */
  surfaceHeight(x: number, z: number): number {
    const h = this.terrainHeight(x, z);
    return h > SEA_LEVEL ? h : SEA_LEVEL;
  }

  /** Airfields, ordered by team. */
  get airfields(): readonly AirfieldSite[] { return this.hf ? this.hf.airfields : EMPTY_AIRFIELDS; }

  /** The raw heightfield, for the rare consumer that needs the masks. */
  get heightfield(): Heightfield { return this.hf; }

  get seaLevel(): number { return SEA_LEVEL; }
  get mapSize(): number { return MAP_SIZE; }
  get mapHalf(): number { return MAP_HALF; }

  /**
   * Spawn slots: the hardstands of each airfield, ordered by team. Each slot
   * is already at the exact pad elevation and aligned with the runway.
   */
  spawnPoints(): { team: number; x: number; y: number; z: number; yaw: number }[] {
    const out: { team: number; x: number; y: number; z: number; yaw: number }[] = [];
    for (let i = 0; i < this.fields.length; i++) {
      const team = this.hf.airfields[i].team;
      for (const s of this.fields[i].spawns) out.push({ team, ...s });
    }
    return out;
  }

  /** Attackable ground installations. */
  get targets(): readonly GroundTarget[] {
    return this.groundTargets ? this.groundTargets.targets : EMPTY_TARGETS;
  }

  /** Called by the damage model when a ground target's hit points reach zero. */
  destroyTarget(t: GroundTarget): void {
    this.groundTargets?.kill(t);
  }

  /** Surface wind, shared by the windsocks, the sea state and ballistics. */
  get wind(): { dir: number; speed: number } {
    return { dir: this.windDir, speed: this.windSpeed };
  }

  /** Diagnostics for the perf overlay. */
  stats(): { nodes: number; tris: number; instances: number } {
    return {
      nodes: this.terrain.visibleNodes,
      tris: this.terrain.visibleTris,
      instances: this.veg ? this.veg.instanceCount : 0,
    };
  }
}

const _n3 = { x: 0, y: 1, z: 0 };
const EMPTY_AIRFIELDS: readonly AirfieldSite[] = [];
const EMPTY_TARGETS: readonly GroundTarget[] = [];

function gridForQuality(q: QualityTier): number {
  return q === 'low' ? 16 : q === 'medium' ? 24 : 32;
}
