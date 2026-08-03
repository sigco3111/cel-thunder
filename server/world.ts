import type { V3 } from '../src/shared/math';
import {
  airDensity, windAt, windField, type MatchEnvironment,
} from '../src/shared/environment';
import { getHeightfield, type Heightfield } from '../src/world/heightfield';
import { GroundWar } from './GroundWar';
import { GroundUnits } from './GroundUnits';
import type { Env, SpawnSite } from './Room';

/**
 * The server's view of the map.
 *
 * This used to live inline in 'index.ts'. It is a module of its own now because
 * the headless match harness ('tools/simroom.ts') has to build exactly the same
 * world the live server does — a diagnosis run against a differently-seeded or
 * flat-terrain world proves nothing about the match a player would join.
 *
 * Terrain comes from the same baked heightfield the client renders, and air and
 * wind from the same shared module the client predicts with. There is no
 * fallback: a server that cannot load the terrain cannot arbitrate.
 */
export function makeEnv(seed: number, match: MatchEnvironment): Env {
  const hf: Heightfield = getHeightfield(seed);
  // The wind field is a function of the map seed *and* the match weather, and
  // the client derives it from exactly the same two numbers. That is the whole
  // reason weather is replicated rather than picked locally for looks.
  const wind = windField(seed, match.weather);
  const sites: SpawnSite[] = hf.airfields.map((a) => ({
    x: a.x, z: a.z, elevation: a.elevation, heading: a.heading, team: a.team,
  }));
  if (sites.length < 2) throw new Error(`heightfield seed ${seed} produced ${sites.length} airfields`);

  return {
    airDensity,
    windAt(p: V3, out: V3): V3 { return windAt(wind, p, out); },
    terrainHeight(x, z) { return hf.heightAt(x, z); },
    terrainNormal(x, z, out) { hf.normalAt(x, z, out); return out; },
    // Wheel friction: the runway rolls, grass drags, water is a ditching.
    surfaceType(x, z) {
      const t = hf.typeAt(x, z);
      return t === 'runway' ? 0 : t === 'water' ? 2 : 1;
    },
    airfield(team) { return sites.find((s) => s.team === team) ?? sites[0]; },
  };
}

/**
 * Builds the flak network for a room. The gun positions come from the shared
 * siting pass in 'src/world/groundSites.ts' — the same one the client's visible
 * gun pits are placed by — so every gun the client draws is a gun the server
 * shoots with.
 */
export function makeGroundWar(seed: number, env: Env): GroundWar {
  const hf = getHeightfield(seed);
  const centres = hf.airfields.map((a) => ({ x: a.x, z: a.z }));
  return new GroundWar(hf, seed, centres, {
    terrainHeight: (x, z) => env.terrainHeight(x, z),
  });
}

/**
 * Builds the room's ordinary ground targets — the convoy, the rolling stock and
 * the three big installations — from the same shared siting pass the client's
 * visible ones come out of.
 */
export function makeGroundUnits(seed: number): GroundUnits {
  const hf = getHeightfield(seed);
  const centres = hf.airfields.map((a) => ({ x: a.x, z: a.z }));
  return new GroundUnits(hf, seed, centres);
}
