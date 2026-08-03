import { v3, type V3 } from '../src/shared/math';
import {
  AA_HEAVY, AA_LIGHT, AA_MEDIUM, createAaGun, resetAaGun, stepAaGuns,
  type AaGun, type AaGunSpec, type CombatEnv, type CombatTarget, type Projectile,
  ProjectilePool, seedRng,
} from '../src/shared/combat';
import { type Heightfield } from '../src/world/heightfield';
import { groundSiting, type SiteCentre } from '../src/world/groundSites';

/**
 * The ground war: flak emplacements that defend both aerodromes and the
 * contested belt between them.
 *
 * The gunnery itself is not implemented here — it is 'src/shared/combat/aa.ts',
 * which models reaction delay, finite traverse, a drag-aware lead solution,
 * correlated crew error and time-fused airbursts. This module's whole job is to
 * hand that model a world to shoot in and keep the emplacements' health.
 *
 * ## Siting
 *
 * The positions come from 'src/world/groundSites.ts', which the client's
 * visible gun pits are placed from as well. This file used to carry a
 * hand-copied reproduction of that scatterer — same seed, same generator, same
 * draw order — with a comment warning that the two would silently drift apart
 * if either changed. They now cannot: there is one siting pass and both halves
 * read its output.
 */

/** One replicated, destroyable gun position. */
export interface Emplacement {
  /** Stable index, used to seed the gun's own RNG. */
  index: number;
  team: number;
  x: number; y: number; z: number;
  /** Hit radius for gunfire and bomb blast, metres. */
  radius: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  /** Replicated entity id; 0 while the position is destroyed. */
  entityId: number;
  /** Wire archetype: 0 = light, 1 = medium, 2 = heavy. */
  typeId: number;
  gun: AaGun;
}

const SPEC: Record<number, AaGunSpec> = { 0: AA_LIGHT, 1: AA_MEDIUM, 2: AA_HEAVY };

/** Terrain the guns stand on and shoot over. */
export interface GroundEnv {
  terrainHeight(x: number, z: number): number;
}

export class GroundWar {
  readonly emplacements: Emplacement[] = [];

  private env: CombatEnv;
  private terrain: GroundEnv;
  private pool = new ProjectilePool(96);
  /** Scratch list handed to the shared AA model each step. */
  private fired: Projectile[] = [];

  constructor(hf: Heightfield, seed: number, centres: SiteCentre[], terrain: GroundEnv) {
    this.terrain = terrain;

    // Only the flak positions out of the shared siting; the lorries, wagons and
    // installations are ordinary ground units and belong to 'GroundUnits.ts'.
    const placed = groundSiting(hf, seed, centres).units.filter((u) => u.kind === 'aa');
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i];
      const typeId = p.aaClass;
      const gun = createAaGun(
        i + 1, p.owner, v3(p.x, p.y + 1.4, p.z), SPEC[typeId], (seed ^ 0x9e3779b9) + i * 7919);
      this.emplacements.push({
        index: i, team: p.owner, x: p.x, y: p.y, z: p.z,
        radius: p.radius, hp: p.hp, maxHp: p.hp,
        alive: true, entityId: 0, typeId, gun,
      });
      this._guns.push(gun);
      this._ceiling = Math.max(this._ceiling, p.y + 60);
    }

    this.env = {
      time: 0,
      queryTargets: () => { /* AA rounds are arbitrated by the room, not here */ },
      terrainHeight: (x, z) => terrain.terrainHeight(x, z),
      terrainOccludes: (a, b) => this.occluded(a, b),
      rng: seedRng(seed ^ 0x51ed2701),
    };
  }

  get count(): number { return this.emplacements.length; }

  /**
   * Altitude above which no round can possibly be striking an emplacement.
   * The projectile pass checks it before looping over the gun positions, which
   * keeps the ground-target test off the critical path for the ninety per cent
   * of rounds fired in a dogfight two kilometres up.
   */
  get ceiling(): number { return this._ceiling; }

  aliveCount(team: number): number {
    let n = 0;
    for (const e of this.emplacements) if (e.alive && e.team === team) n++;
    return n;
  }

  /**
   * Advances every battery and returns the rounds that left a barrel this
   * step. Ownership of the returned projectiles passes to the caller, which
   * must hand each one back through {@link release} once it has copied what it
   * needs — they come out of a pool.
   */
  step(dt: number, time: number, targets: CombatTarget[]): Projectile[] {
    this.env.time = time;
    this.fired.length = 0;
    // The shared model skips dead guns itself, so the full array goes in every
    // step and destroyed positions cost one branch each.
    stepAaGuns(this._guns, targets, dt, { env: this.env, pool: this.pool, out: this.fired });
    return this.fired;
  }

  release(p: Projectile): void { this.pool.release(p); }

  /** Applies gunfire/blast damage. Returns true when the position is knocked out. */
  damage(e: Emplacement, amount: number): boolean {
    if (!e.alive) return false;
    e.hp -= amount;
    if (e.hp > 0) return false;
    e.hp = 0;
    e.alive = false;
    e.gun.alive = false;
    return true;
  }

  /** Rebuilds every position for a fresh round. */
  reset(): void {
    for (const e of this.emplacements) {
      e.hp = e.maxHp;
      e.alive = true;
      e.entityId = 0;
      resetAaGun(e.gun);
    }
  }

  // -------------------------------------------------------------------------

  private readonly _guns: AaGun[] = [];
  private _ceiling = 0;

  /**
   * Coarse line-of-sight test against the terrain. Sixteen samples over a
   * multi-kilometre slant is far too few to catch a fence post and exactly
   * enough to catch a ridge, which is the only thing that matters: a battery
   * must not track an aeroplane through a mountain.
   *
   * The ends are trimmed because the gun itself stands 1.4 m above ground and
   * a sample taken at the muzzle would report the gun as buried in its own
   * hillside.
   */
  private occluded(a: V3, b: V3): boolean {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    for (let i = 1; i < 16; i++) {
      const t = i / 16;
      const y = a.y + dy * t;
      if (y - this.terrain.terrainHeight(a.x + dx * t, a.z + dz * t) < 0) return true;
    }
    return false;
  }
}
