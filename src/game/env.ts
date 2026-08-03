import type { V3 } from '../shared/math';
import {
  airDensity, speedOfSound, windAt as sharedWindAt, windField, type WindField,
} from '../shared/environment';
import { externals, type FlightEnv } from './externals';

/**
 * The atmosphere/terrain sampler the flight model integrates against.
 *
 * The client must reproduce the server's environment *exactly* or prediction
 * diverges every frame and the reconciliation blend never settles, so density
 * and wind are not reimplemented here — both halves import them from
 * 'src/shared/environment.ts'. Terrain likewise comes from the one baked
 * heightfield the server also queries.
 */

export { airDensity, speedOfSound };

export class ClientEnv implements FlightEnv {
  readonly seed: number;
  private wind: WindField;

  constructor(seed: number) {
    this.seed = seed;
    // Same seed the server uses, so both derive the same wind field.
    this.wind = windField(seed);
  }

  airDensity(y: number): number { return airDensity(y); }

  windAt(p: V3, out: V3): V3 { return sharedWindAt(this.wind, p, out); }

  terrainHeight(x: number, z: number): number {
    const t = externals().terrain;
    return t ? t.height(x, z) : 0;
  }

  terrainNormal(x: number, z: number, out: V3): V3 {
    const t = externals().terrain;
    if (t) return t.normal(x, z, out);
    out.x = 0; out.y = 1; out.z = 0;
    return out;
  }

  terrainType(x: number, z: number): string {
    const t = externals().terrain;
    return t ? t.type(x, z) : 'grass';
  }

  /**
   * Surface hint for wheel friction, in the shared flight model's encoding:
   * 0 = paved, 1 = soft ground, 2 = water. Landing on grass must cost more
   * rollout than landing on the runway, and ditching must not behave like a
   * taxiway.
   */
  surfaceType(x: number, z: number): number {
    const t = this.terrainType(x, z);
    if (t === 'runway') return 0;
    if (t === 'water') return 2;
    return 1;
  }
}

/**
 * Shared instance. Prediction and presentation must integrate against exactly
 * the same environment or the two disagree about where the ground is, so both
 * subsystems take it from here rather than each building their own.
 */
let shared: ClientEnv | null = null;
export function getClientEnv(seed: number): ClientEnv {
  if (!shared || shared.seed !== seed) shared = new ClientEnv(seed);
  return shared;
}
