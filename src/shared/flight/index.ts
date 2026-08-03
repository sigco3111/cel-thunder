/**
 * CEL THUNDER — flight model.
 *
 * A discrete-surface (strip theory) flight dynamics model with a full piston
 * powerplant, undercarriage, structural limits and pilot physiology. Pure
 * TypeScript, no three.js, no clocks, no randomness: the browser client
 * predicts with exactly the same code the headless server arbitrates with.
 *
 * ## Minimal use
 *
 *   '''ts
 * import { createFlightState, stepFlight, flatEnvironment } from '../shared/flight';
 *
 * const env  = flatEnvironment();                 // or the world subsystem's
 * const st   = createFlightState(spec, pos, rot);
 * spawnInFlight(st, spec, env, 2000, 120, 0);
 *
 * // every tick, with the tick's dt (do not use input.dt):
 * stepFlight(st, spec, inputFrame, env, TICK_DT);
 *   '''
 *
 * ## What the rest of the game reads
 *
 * 'FlightState' carries every derived quantity the HUD, camera, audio, VFX and
 * AI need — airspeeds, Mach, alpha/beta, attitude, rates, engine readouts,
 * 'buffet', 'gEffect', 'stalled', 'spinning', 'onGround', per-leg suspension
 * compression, 'propStrike', 'scrape'. None of it needs recomputing outside.
 *
 * ## Coordinate and sign conventions
 *
 * See the header of 'types.ts'. In short: world Y-up right-handed, body
 * X-right / Y-up / Z-forward; 'input.pitch > 0' is nose-up, 'input.roll > 0'
 * is right roll, 'input.yaw > 0' is right rudder; and the state's 'pitchRate'
 * / 'rollRate' / 'yawRate' follow the same pilot-facing signs.
 */

// --- core -------------------------------------------------------------------
export {
  createFlightState,
  stepFlight,
  cloneFlightState,
  copyFlightState,
  spawnInFlight,
  placeOnGround,
  writeEntityState,
  readEntityState,
} from './step';

// --- environment ------------------------------------------------------------
export {
  flatEnvironment,
  atmosphereAt,
  isaDensity,
  isaPressure,
  isaTemperature,
  soundSpeed,
  pressureAltitude,
  tasToEas,
  easToTas,
  safeDensity,
  ISA,
} from './atmosphere';
export type { FlatEnvOptions } from './atmosphere';

// --- archetype geometry -----------------------------------------------------
export { getDerived } from './derive';

// --- controls, systems and damage ------------------------------------------
export { updateControls, updateDamageFactors, adjustTrim, autoTrim, axisAuthority } from './controls';

// --- powerplant -------------------------------------------------------------
export { updateEngine, applyPropForces, primeEngine, inducedVelocity } from './engine';

// --- limits -----------------------------------------------------------------
export { updatePilot, updateStructure } from './pilot';

// --- helpers ----------------------------------------------------------------
export { autopilotStep, newAutopilot, idleInput, wrapPi } from './autopilot';
export type { Autopilot, AutopilotGoal } from './autopilot';
export { trimFlight } from './trim';
export type { TrimOptions, TrimResult } from './trim';

// --- types ------------------------------------------------------------------
export type {
  FlightState,
  Environment,
  AtmoSample,
  Surface,
  SurfaceKind,
  GearLeg,
  GearRole,
  HardPoint,
  DerivedSpec,
  DamageFactors,
} from './types';
export {
  G0,
  RHO0,
  P0,
  T0,
  R_AIR,
  GAMMA,
  MAX_SUBSTEP,
  SURFACE_PAVED,
  SURFACE_SOFT,
  SURFACE_WATER,
  DG_NONE,
  DG_WING_L,
  DG_WING_R,
  DG_TAIL,
  DG_FIN,
  DG_BODY,
} from './types';
