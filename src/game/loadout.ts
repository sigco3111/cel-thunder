import {
  loadoutById, loadoutDrag, type AircraftSpec, type Loadout,
} from '../shared/aircraft';
import { bombSpecFromKg, defaultRocketSpec } from '../shared/combat/ordnance';
import type { BombSpec, RocketSpec } from '../shared/combat/ordnance';

/**
 * Turns the declarative loadout table in 'shared/aircraft.ts' into the two
 * things the rest of the game actually needs: the ballistic specs
 * 'shared/combat/ordnance.ts' consumes, and the mass and drag the flight model
 * has to fly with.
 *
 * The drag hand-off is the interesting part. The flight model derives its
 * parasite area from 'spec.aero.cd0' inside 'getDerived', which is memoised per
 * *spec object*, and it recomputes 'dmg.extraDrag' from the damage bits at the
 * top of every step — so there is no field on the flight state an external
 * system can hold a carriage penalty in. What there is, is the spec argument
 * to 'stepFlight', which is passed in fresh every call. So a loaded aeroplane
 * flies against a variant spec whose cd0 includes its stores, and the moment
 * they are released it goes back to flying against the clean one. The variants
 * are interned here so 'getDerived' sees a stable object identity and builds
 * each one exactly once.
 */

export interface RuntimeLoadout {
  loadout: Loadout;
  /** Ballistics for one bomb, or null if this loadout carries none. */
  bomb: BombSpec | null;
  bombMounts: [number, number, number][];
  /** Ballistics for one rocket, or null. */
  rocket: RocketSpec | null;
  rocketMounts: [number, number, number][];
  /** Mass of every store, kg. */
  storeMass: number;
  /** Per-store mass, kg — subtracted as each one leaves. */
  bombMass: number;
  rocketMass: number;
  /** Cd·A that goes away with the stores, and the part the racks keep. */
  storeDrag: number;
  rackDrag: number;
}

const cache = new Map<string, RuntimeLoadout>();

/** Resolve (and memoise) the runtime form of one aircraft/loadout pairing. */
export function resolveLoadout(spec: AircraftSpec, id: string | undefined): RuntimeLoadout {
  const l = loadoutById(spec, id);
  const key = `${spec.id}|${l.id}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const drag = loadoutDrag(l);
  const b = l.bombs;
  const r = l.rockets;

  const out: RuntimeLoadout = {
    loadout: l,
    // 'bombSpecFromKg' derives a plausible body and fuse from the weight alone;
    // the table knows the real diameter and filling, so both are overridden.
    bomb: b ? { ...bombSpecFromKg(b.kg, b.name), fillFraction: b.fill, diameter: b.diameter } : null,
    bombMounts: b ? b.mounts : [],
    // Likewise the rocket: the default is an RP-3 stand-in, and every aircraft
    // rocket of the period had a very different motor.
    rocket: r
      ? {
        ...defaultRocketSpec(r.kg, r.he, r.name),
        diameter: r.diameter,
        thrust: r.thrust,
        burnTime: r.burnTime,
        propellantMass: r.propellant,
      }
      : null,
    rocketMounts: r ? r.mounts : [],
    storeMass: (b ? b.kg * b.count : 0) + (r ? r.kg * r.count : 0),
    bombMass: b ? b.kg : 0,
    rocketMass: r ? r.kg : 0,
    storeDrag: drag.store,
    rackDrag: drag.rack,
  };
  cache.set(key, out);
  return out;
}

/** How many bombs and rockets a loadout starts with. */
export function loadoutCounts(rl: RuntimeLoadout): { bombs: number; rockets: number } {
  return {
    bombs: rl.loadout.bombs?.count ?? 0,
    rockets: rl.loadout.rockets?.count ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Spec variants
// ---------------------------------------------------------------------------

/**
 * Drag-area quantum for the interned variants, m².
 *
 * Every distinct value costs one 'getDerived' build — roughly thirty
 * aerodynamic strips, a gear solve and three stability solves — so the number
 * of them has to be bounded. 4 mm² of drag area is far below the threshold of
 * a perceptible speed change (it is 0.8 % of a Spitfire's parasite area) and
 * collapses a six-rocket ripple into a handful of variants instead of seven.
 */
const DRAG_QUANTUM = 0.004;

const variants = new Map<string, AircraftSpec>();

/**
 * The spec to hand 'stepFlight' for an aeroplane carrying 'cdArea' m² of
 * external drag. Returns the original object when there is nothing hung on it,
 * so an unarmed fighter never pays for any of this.
 */
export function flightSpecFor(spec: AircraftSpec, cdArea: number): AircraftSpec {
  const q = Math.round(cdArea / DRAG_QUANTUM);
  if (q <= 0) return spec;
  const key = `${spec.id}|${q}`;
  let v = variants.get(key);
  if (!v) {
    v = { ...spec, aero: { ...spec.aero, cd0: spec.aero.cd0 + (q * DRAG_QUANTUM) / spec.aero.wingArea } };
    variants.set(key, v);
  }
  return v;
}
