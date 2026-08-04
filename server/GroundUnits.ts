import { type Heightfield } from '../src/world/heightfield';
import {
  groundSiting, type GroundUnitSite, type SiteCentre, type TargetKind,
} from '../src/world/groundSites';
import { GroundType } from '../src/shared/ground';

/**
 * Everything on the ground that is not a flak battery: the lorry column and its
 * escorting armour, the rolling stock in the rail yard, the factory, the yard
 * itself and the river bridge.
 *
 * The flak lives in 'GroundWar.ts' because a gun has state a target does not —
 * it tracks, it reloads, it has a crew with a reaction delay. Everything here
 * only has a position, a size and a hit-point pool, which is why one class can
 * hold all of it.
 *
 * These used to exist only on the client. 'WorldSystem' built 76 targets from
 * the heightfield, the client's ordnance runtime blew them up locally, and the
 * server knew about none of it — so a bombing run that a player watched destroy
 * a convoy changed nothing about the match, and nobody else in the room saw it
 * happen. The positions now come out of the shared siting pass, so the lorry the
 * server is holding the health of is the lorry the client drew.
 *
 * ## Ticket value
 *
 * A ground unit is worth tickets to whichever side's field it is nearer, the
 * same way an emplacement is. The values are relative to 'config.groundCost'
 * (an AA battery): a lorry is a nuisance, a factory is a campaign objective.
 */

/**
 * Wire archetype ids. 0..2 are the AA classes, which 'GroundWar' owns.
 *
 * Re-exported from the shared module rather than declared twice: the HUD has
 * to name these, and the last time the numbering lived only here the marker
 * layer fell back to the aircraft table and labelled flak pits "Bf 109 G-6".
 */
export { GroundType };

export interface GroundUnit {
  index: number;
  kind: TargetKind;
  /** The side that loses tickets when this is destroyed. */
  team: number;
  x: number; y: number; z: number;
  /** Hit radius for gunfire and bomb blast, metres. */
  radius: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  /** Replicated entity id; 0 while destroyed. */
  entityId: number;
  typeId: GroundType;
  /** Ticket cost of losing this, as a multiple of 'config.groundCost'. */
  value: number;
  /** Display name for the kill feed. */
  label: string;
}

const KIND_INFO: Record<string, { type: GroundType; value: number; label: string }> = {
  trucks: { type: GroundType.Truck, value: 0.25, label: 'transport lorry' },
  lightArmour: { type: GroundType.Armour, value: 0.5, label: 'armoured car' },
  wagons: { type: GroundType.Wagon, value: 0.35, label: 'goods wagon' },
};

export class GroundUnits {
  readonly units: GroundUnit[] = [];

  /**
   * Altitude above which nothing on this list can be struck. The projectile
   * pass tests it before looping, which keeps the ground-target test off the
   * critical path for the rounds fired in a dogfight two kilometres up.
   */
  readonly ceiling: number;

  constructor(hf: Heightfield, seed: number, centres: SiteCentre[]) {
    const siting = groundSiting(hf, seed, centres);
    let ceiling = 0;
    let index = 0;

    const add = (
      kind: TargetKind, team: number, x: number, y: number, z: number,
      radius: number, hp: number, type: GroundType, value: number, label: string,
    ): void => {
      this.units.push({
        index: index++, kind, team, x, y, z, radius, hp, maxHp: hp,
        alive: true, entityId: 0, typeId: type, value, label,
      });
      ceiling = Math.max(ceiling, y + radius + 40);
    };

    const addInstanced = (u: GroundUnitSite): void => {
      const info = KIND_INFO[u.batch];
      if (!info) return;               // 'aaGuns' — the ground war owns those
      add(u.kind, u.owner, u.x, u.y, u.z, u.radius, u.hp, info.type, info.value, info.label);
    };

    for (const u of siting.units) addInstanced(u);
    if (siting.factory) {
      const f = siting.factory;
      add('factory', nearest(centres, f.x, f.z), f.x, f.y, f.z, f.radius, f.hp,
        GroundType.Factory, 4, 'aircraft factory');
    }
    for (const w of siting.wagons) addInstanced(w);
    if (siting.railyard) {
      const r = siting.railyard;
      add('railyard', nearest(centres, r.x, r.z), r.x, r.y, r.z, r.radius, r.hp,
        GroundType.Railyard, 3, 'marshalling yard');
    }
    if (siting.bridge) {
      const b = siting.bridge;
      add('bridge', nearest(centres, b.x, b.z), b.x, b.y, b.z, b.radius, b.hp,
        GroundType.Bridge, 3, 'river bridge');
    }

    this.ceiling = ceiling;
  }

  get count(): number { return this.units.length; }

  aliveCount(team: number): number {
    let n = 0;
    for (const u of this.units) if (u.alive && u.team === team) n++;
    return n;
  }

  /** Applies damage. Returns true when the unit is knocked out by this hit. */
  damage(u: GroundUnit, amount: number): boolean {
    if (!u.alive || amount <= 0) return false;
    u.hp -= amount;
    if (u.hp > 0) return false;
    u.hp = 0;
    u.alive = false;
    return true;
  }

  /** Rebuilds every unit for a fresh round. */
  reset(): void {
    for (const u of this.units) {
      u.hp = u.maxHp;
      u.alive = true;
      u.entityId = 0;
    }
  }
}

function nearest(centres: SiteCentre[], x: number, z: number): number {
  let team = 0, best = Infinity;
  for (let t = 0; t < centres.length; t++) {
    const d = Math.hypot(x - centres[t].x, z - centres[t].z);
    if (d < best) { best = d; team = t; }
  }
  return team;
}
