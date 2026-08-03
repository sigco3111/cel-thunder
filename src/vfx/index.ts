/**
 * Public surface of the VFX subsystem.
 *
 * Other subsystems should import from here rather than reaching into
 * individual files, so the internal layout (pools, atlases, effect libraries)
 * stays free to change.
 *
 *   import { spawnExplosion, spawnImpact, attachDamageEffects } from '../vfx';
 *
 * Every free function is a no-op before VfxSystem.init has run, so callers
 * never need to guard on boot order.
 */
export {
  VfxSystem,
  spawnExplosion,
  spawnImpact,
  spawnMuzzle,
  spawnLaunch,
  attachDamageEffects,
  addSmokeSource,
  removeSmokeSource,
  vfx,
} from './VfxSystem';

export type { Vec3Like, ExplosionKind, SurfaceKind, VfxAircraftModel } from './VfxSystem';
export { RAMP, TILE } from './VfxTextures';
