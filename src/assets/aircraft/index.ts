/**
 * Procedural aircraft assets — public surface.
 *
 * Typical use from the entity system:
 *
 *   await buildAllAircraft(onProgress);              // once, during loading
 *   const model = buildAircraftById('spitfire_mk9'); // per spawned aircraft
 *   scene.add(model.root);
 *   ...
 *   setControlSurfaces(model, e.ctlPitch, e.ctlRoll, e.ctlYaw, e.flaps);
 *   setGear(model, e.gear);
 *   setPropeller(model, e.rpm, dt);
 *   setDamage(model, e.damage);
 *   ...
 *   disposeAircraft(model);
 */

export {
  buildAircraft,
  buildAircraftById,
  buildAllAircraft,
  aircraftTriangleCounts,
  setControlSurfaces,
  setGear,
  setPropeller,
  setWheelSpin,
  setDamage,
  detachPart,
  addBulletHole,
  disposeAircraft,
  disposeAircraftAssets,
} from './build';

export type { AircraftModel, DamageParts, BuildOptions } from './build';

export { FuselageProfile } from './fuselage';
export { WingPlan } from './wing';
export { naca, foilContour, foilsFor } from './naca';
export type { Foil } from './naca';
