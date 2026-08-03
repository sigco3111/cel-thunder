/**
 * Public surface of the combat subsystem.
 *
 * Typical server-side wiring:
 *
 *   const pool  = new ProjectilePool();
 *   const proxy = buildAircraftProxy(spec);              // once per archetype
 *   const dmg   = createDamageState(spec, entityId, team, ownerId);
 *   const hist  = createHistoryBuffer();                 // per aircraft
 *
 *   // every tick, before anything else:
 *   pushHistory(hist, now, aircraft.p, aircraft.q);
 *
 *   // firing:
 *   rounds.push(createProjectile({ ... }));
 *
 *   // physics:
 *   stepProjectiles(rounds, env, dt, (hit) => {
 *     const st = damageStates.get(hit.targetId);
 *     if (st) for (const e of applyDamage(st, hit)) emitEvent(e);
 *   }, pool);
 *
 *   // per-aircraft evolution and the flight-model hand-off:
 *   stepDamage(dmg, stepInput, dt);
 *   const fx = computeDamageEffects(dmg);
 *
 * Nothing in here touches three.js, the DOM or global state, so the same code
 * runs unchanged in the browser prediction layer and in the headless server.
 */

// --- types -----------------------------------------------------------------
export {
  AmmoType, ModuleId, MODULE_COUNT, MODULE_NAMES, MODULE_ADJACENCY,
  ProjectileKind, FuseKind, DamageEventKind, RHA_EQUIV,
  AMMO_NAMES, isExplosiveAmmo, isIncendiaryAmmo, isKineticAmmo,
  newHitResult, newDamageEffects, seedRng,
} from './types';
export type {
  ArmourMaterial, ShapeKind, ProxyShape, AircraftProxy,
  TransformSample, HistoryBuffer, CombatTarget, CombatEnv,
  Projectile, HitType, HitResult, HitSink,
  FireState, DamageEvent, AircraftDamageState, DamageStepInput, DamageEffects,
} from './types';

// --- atmosphere & drag -----------------------------------------------------
export {
  G0, RHO_SL, airDensity, speedOfSound, densityRatio,
  isaTemperature, isaPressure, tasToIas, iasToTas,
} from './atmosphere';
export { cdG1, cdBomb, cdRocket, defaultFormFactor, calibreArea, dragAccel } from './drag';

// --- collision proxy & lag compensation ------------------------------------
export {
  buildAircraftProxy, clearProxyCache, sweepProxy, sweepTarget, beginSweepBatch,
  shapeDistance, shapeClosestPoint, armourForNormal, rhaEquivalent,
  createHistoryBuffer, pushHistory, sampleHistory, resolveTargetTransform,
} from './proxy';
export type { ShapeHit } from './proxy';

// --- penetration -----------------------------------------------------------
export {
  computePenetration, computePenetrationRng, newPenetrationResult,
  penetrationCapability, coreMassFraction, kineticDamage,
  blastDamage, peakBlastDamage, blastRadius, ignitionChance,
  RHA_RESISTANCE,
} from './penetration';
export type { PenetrationQuery, PenetrationResult } from './penetration';

// --- explosions ------------------------------------------------------------
export {
  applyExplosion, gurneyVelocity, shellCasing, warheadCasing, visualBlastRadius,
  groundBlastDamage, groundBlastRadius,
} from './explosion';
export type { ExplosionParams } from './explosion';

// --- ballistics ------------------------------------------------------------
export {
  ProjectilePool, createProjectile, stepProjectiles, advanceBallistic,
  ballisticSolution, solveLead, solveBallisticLead, scatterDirection,
  beltFor, roundMass, roundHe, gunDispersion,
  MIN_LETHAL_SPEED, MAX_SUBSTEP_M,
} from './ballistics';
export type { ProjectileInit } from './ballistics';

// --- fire ------------------------------------------------------------------
export {
  isFlammable, fuelLoad, igniteModule, findFire, stepFires, extinguishRate,
  maxFireIntensity, longestBurn, FIRE_DPS, FIRE_SPILL_DPS, FIRE_SPREAD_PERIOD,
} from './fire';
export type { FireTickResult } from './fire';

// --- damage ----------------------------------------------------------------
export {
  createDamageState, resetDamageState, applyDamage, stepDamage,
  computeDamageEffects, syncBits, healthFraction, killReason, isFlyable,
  fireBurnTime, wingSideOf,
} from './damage';

// --- ordnance --------------------------------------------------------------
export {
  bombSpecFromKg, bombSpecFor, dropBomb, predictBombImpact, bombTerminalVelocity,
  defaultRocketSpec, rocketSpecFor, launchRocket, launchSalvo, detonateAt,
} from './ordnance';
export type { BombSpec, RocketSpec, DropParams, LaunchParams } from './ordnance';

// --- anti-aircraft ---------------------------------------------------------
export {
  AA_LIGHT, AA_MEDIUM, AA_HEAVY, createAaGun, stepAaGuns, createBattery,
  aaThreatAt, resetAaGun,
} from './aa';
export type { AaGun, AaGunSpec, AaFireContext } from './aa';
