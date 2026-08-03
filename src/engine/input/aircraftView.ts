import * as THREE from 'three';
import type { GameContext } from '../context';
import { EntityKind, DamageBits, type EntityState } from '../../shared/protocol';
import { aircraftByIndex, type AircraftSpec } from '../../shared/aircraft';
import { airDensity, G0, speedOfSound } from '../../shared/combat/atmosphere';
import { clamp01, smoothstep } from './curves';

/**
 * A normalised, read-only view of "the aircraft the player is flying".
 *
 * Both the input layer and the camera rigs need the same handful of facts —
 * where it is, which way it points, how fast it is going, how hard it is
 * pulling — but the authoritative source moves around: before spawn there is
 * nothing, in flight the locally predicted state from the flight subsystem is
 * the freshest thing available, and if that subsystem is not present (or the
 * player is spectating) the replicated 'EntityState' is the fallback.
 *
 * Rather than scattering that arbitration through two subsystems, it lives
 * here, behind a duck-typed probe so this module never hard-depends on the
 * flight subsystem's internal shape.
 */
export interface AircraftView {
  /** False when there is nothing to follow (pre-spawn, spectating a gap). */
  valid: boolean;
  entityId: number;
  entity: EntityState | null;
  spec: AircraftSpec;

  readonly pos: THREE.Vector3;
  readonly quat: THREE.Quaternion;
  readonly vel: THREE.Vector3;
  /** Body axes in world space: right (+X), up (+Y), forward (+Z). */
  readonly right: THREE.Vector3;
  readonly up: THREE.Vector3;
  readonly forward: THREE.Vector3;
  /** Body-frame angular rate, rad/s: x = pitch, y = yaw, z = roll. */
  readonly omega: THREE.Vector3;
  /** Body-frame specific force (what an accelerometer reads), m/s². */
  readonly accelBody: THREE.Vector3;
  /** Body-frame velocity. */
  readonly velBody: THREE.Vector3;

  /** True airspeed, m/s. */
  speed: number;
  /** Indicated airspeed, m/s — what the pilot's ASI and the flight model use. */
  ias: number;
  mach: number;
  altitude: number;
  /** Height above the terrain/sea directly below, m. */
  agl: number;
  /** Load factor along the body up axis; 1 = level flight. */
  gLoad: number;
  /** Physiological g effect: +1 fully blacked out, -1 fully redded out. */
  gEffect: number;
  /** Angle of attack, rad. */
  alpha: number;
  /** Sideslip, rad. Positive = airflow from the right. */
  beta: number;
  /** 0…1 pre-stall buffet intensity. */
  buffet: number;
  /** 0…1 autorotation intensity — the aircraft is spinning. */
  spinning: number;
  stalled: boolean;
  /**
   * Per-axis control authority actually available, 0…1. Folds together heavy
   * controls at speed, Mach stiffening and battle damage. 'authValid' is false
   * when the flight model did not publish it and these are estimates.
   */
  authPitch: number;
  authRoll: number;
  authYaw: number;
  authValid: boolean;
  throttle: number;
  health: number;
  damage: number;
  destroyed: boolean;
  onGround: boolean;
  /** Air density at the aircraft, kg/m³ — handed to the ballistics solver. */
  rho: number;
}

/** A terrain sampler the world subsystem can install; defaults to sea level. */
let terrainSampler: ((x: number, z: number) => number) | null = null;

/**
 * Installs the terrain height function. Called by the integrator (or discovered
 * automatically from the world subsystem) so the camera can avoid clipping
 * through hills without this module importing the world at build time.
 */
export function setTerrainSampler(fn: ((x: number, z: number) => number) | null): void {
  terrainSampler = fn;
}

export function terrainHeightAt(x: number, z: number): number {
  if (!terrainSampler) return 0;
  const h = terrainSampler(x, z);
  return Number.isFinite(h) ? h : 0;
}

export function hasTerrainSampler(): boolean { return terrainSampler !== null; }

/**
 * Looks for a terrain height function, cheapest source first. Safe and cheap to
 * call repeatedly — the camera polls it until one turns up, because the world
 * subsystem may finish streaming long after the camera has initialised.
 *
 * Accepts any of the plausible method names, because a silent flat-world
 * collision test (the camera calmly flying through a mountain) is a far worse
 * outcome than a little adapter code.
 */
export function discoverTerrainSampler(ctx: GameContext): void {
  if (terrainSampler) return;

  // This used to be preceded by an 'import.meta.glob' over every module in
  // src/world, whose importers were all invoked at boot purely to look for a
  // 'terrainHeight' export. It pulled Vegetation, Water, TerrainTextures,
  // GroundTargets and TerrainRenderer into the boot path (rolldown flagged the
  // whole thing INEFFECTIVE_DYNAMIC_IMPORT), and it found nothing the duck-typed
  // subsystem probe below does not already find on the first try.
  const world = ctx.get('world') as unknown as Record<string, unknown> | undefined;
  if (world) {
    for (const key of ['terrainHeight', 'heightAt', 'height', 'sampleHeight', 'groundHeight']) {
      const fn = world[key];
      if (typeof fn !== 'function') continue;
      const bound = (fn as (x: number, z: number) => number).bind(world);
      // Validate once: a wrong-arity or NaN-returning candidate is worse than
      // no sampler at all, because the camera would slam to y = NaN.
      const probe = bound(0, 0);
      if (typeof probe === 'number' && Number.isFinite(probe)) { terrainSampler = bound; return; }
    }
  }

  const g = globalThis as unknown as Record<string, unknown>;
  const fromGlobal = g['__terrainHeight'];
  if (typeof fromGlobal === 'function') terrainSampler = fromGlobal as (x: number, z: number) => number;
}

// ---------------------------------------------------------------------------

const _q = new THREE.Quaternion();
const _qPrev = new THREE.Quaternion();
const _qDelta = new THREE.Quaternion();
const _v = new THREE.Vector3();

/** Body-frame +Z. Hoisted; never mutate. */
const AXIS_F = new THREE.Vector3(0, 0, 1);
const AXIS_U = new THREE.Vector3(0, 1, 0);
const AXIS_R = new THREE.Vector3(1, 0, 0);

/**
 * Maintains an 'AircraftView' across frames. Keeping the previous orientation
 * and velocity is what lets it synthesise body rates and load factor when the
 * flight model does not publish them.
 */
export class AircraftViewTracker {
  readonly view: AircraftView = {
    valid: false,
    entityId: 0,
    entity: null,
    spec: aircraftByIndex(0),
    pos: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    vel: new THREE.Vector3(),
    right: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    forward: new THREE.Vector3(0, 0, 1),
    omega: new THREE.Vector3(),
    accelBody: new THREE.Vector3(0, G0, 0),
    velBody: new THREE.Vector3(),
    speed: 0, ias: 0, mach: 0, altitude: 0, agl: 0,
    gLoad: 1, gEffect: 0, alpha: 0, beta: 0, buffet: 0,
    spinning: 0, stalled: false,
    authPitch: 1, authRoll: 1, authYaw: 1, authValid: false,
    throttle: 0, health: 1, damage: 0, destroyed: false, onGround: true,
    rho: 1.225,
  };

  private prevVel = new THREE.Vector3();
  private prevQuat = new THREE.Quaternion();
  private hasPrev = false;
  /** Integrated g-tolerance reservoir, used only when the flight model is silent. */
  private gPool = 0;

  update(ctx: GameContext, dt: number): AircraftView {
    const v = this.view;
    const id = ctx.localEntityId;
    v.entityId = id;

    const flight = readFlightState(ctx);
    const ent = id ? ctx.entities.get(id) ?? null : null;
    v.entity = ent;

    if (!flight && (!ent || ent.kind !== EntityKind.Aircraft)) {
      v.valid = false;
      return v;
    }
    v.valid = true;

    // --- pose ---------------------------------------------------------------
    if (flight) {
      readVec(flight, ['pos', 'position', 'p'], v.pos, ent ? [ent.px, ent.py, ent.pz] : null);
      readQuat(flight, ['rot', 'quat', 'q', 'orientation'], v.quat, ent ? [ent.qx, ent.qy, ent.qz, ent.qw] : null);
      readVec(flight, ['vel', 'velocity', 'v'], v.vel, ent ? [ent.vx, ent.vy, ent.vz] : null);
    } else if (ent) {
      v.pos.set(ent.px, ent.py, ent.pz);
      v.quat.set(ent.qx, ent.qy, ent.qz, ent.qw);
      v.vel.set(ent.vx, ent.vy, ent.vz);
    }
    if (v.quat.lengthSq() < 1e-6) v.quat.identity(); else v.quat.normalize();

    // --- spec ---------------------------------------------------------------
    const specFromFlight = (flight ? flight['spec'] : undefined) ?? readFlightSpec(ctx);
    v.spec = isSpec(specFromFlight) ? specFromFlight : aircraftByIndex(ent ? ent.typeId : 0);

    // --- body basis ---------------------------------------------------------
    v.right.copy(AXIS_R).applyQuaternion(v.quat);
    v.up.copy(AXIS_U).applyQuaternion(v.quat);
    v.forward.copy(AXIS_F).applyQuaternion(v.quat);

    v.speed = readNumber(flight, ['tas']) ?? v.vel.length();
    v.altitude = readNumber(flight, ['altitude']) ?? v.pos.y;
    v.rho = airDensity(Math.max(0, v.altitude));
    // The flight model already knows all of these exactly; recomputing them
    // here would only introduce a second, slightly different atmosphere.
    v.ias = readNumber(flight, ['ias']) ?? v.speed * Math.sqrt(v.rho / 1.225);
    v.mach = readNumber(flight, ['mach']) ?? v.speed / speedOfSound(Math.max(0, v.altitude));
    v.agl = readNumber(flight, ['agl']) ?? (v.pos.y - terrainHeightAt(v.pos.x, v.pos.z));

    // --- body-frame velocity, alpha, beta ------------------------------------
    _q.copy(v.quat).invert();
    v.velBody.copy(v.vel).applyQuaternion(_q);
    const vb = v.velBody;
    if (v.speed > 3) {
      // +Z is the nose, +Y the canopy: a positive alpha means the airflow comes
      // from below, i.e. body-frame vy is negative.
      v.alpha = Math.atan2(-vb.y, Math.max(1e-3, vb.z));
      v.beta = Math.asin(Math.max(-1, Math.min(1, vb.x / v.speed)));
    } else {
      v.alpha = 0; v.beta = 0;
    }
    const specAlpha = readNumber(flight, ['alpha', 'aoa']);
    if (specAlpha !== null) v.alpha = specAlpha;
    const specBeta = readNumber(flight, ['beta', 'slip', 'sideslip']);
    if (specBeta !== null) v.beta = specBeta;

    // --- angular rate -------------------------------------------------------
    const omegaFromFlight = flight
      ? readVecOptional(flight, ['omega', 'w', 'angVel', 'angularVelocity'], v.omega)
      : false;
    if (!omegaFromFlight) {
      if (this.hasPrev && dt > 1e-5) {
        // ω_body ≈ 2 · vec(q_prev⁻¹ · q_now) / dt for small rotations. Exact to
        // second order, which at 60 Hz is far below the noise floor.
        _qPrev.copy(this.prevQuat).invert();
        _qDelta.multiplyQuaternions(_qPrev, v.quat);
        if (_qDelta.w < 0) { _qDelta.x = -_qDelta.x; _qDelta.y = -_qDelta.y; _qDelta.z = -_qDelta.z; _qDelta.w = -_qDelta.w; }
        const k = 2 / dt;
        // Smooth a little: network-interpolated quaternions are quantised and
        // differentiating them raw produces a jittery rate.
        const a = 1 - Math.exp(-dt * 22);
        v.omega.x += (_qDelta.x * k - v.omega.x) * a;
        v.omega.y += (_qDelta.y * k - v.omega.y) * a;
        v.omega.z += (_qDelta.z * k - v.omega.z) * a;
      } else {
        v.omega.set(0, 0, 0);
      }
    }

    // --- load factor --------------------------------------------------------
    const gFromFlight = readNumber(flight, ['gLoad', 'nz', 'loadFactor', 'gForce']);
    // 'accBody' is the flight model's specific force — exactly what an
    // accelerometer at the pilot's station reads, which is what the head-under-g
    // rig wants. Prefer it over anything we can reconstruct.
    const accFromFlight = flight
      ? readVecOptional(flight, ['accBody', 'accelBody', 'specificForce'], v.accelBody)
      : false;
    if (gFromFlight !== null) {
      v.gLoad = gFromFlight;
      // No accelerometer vector available: synthesise a plausible one so the
      // cockpit head still sinks under load.
      if (!accFromFlight) v.accelBody.set(0, v.gLoad * G0, 0);
    } else if (accFromFlight) {
      v.gLoad = v.accelBody.y / G0;
    } else if (this.hasPrev && dt > 1e-5) {
      // Specific force f = a_inertial − g_vec. In world space g_vec = (0,−g,0),
      // so f = a + (0, g, 0); rotate into the body frame and read the up axis.
      _v.copy(v.vel).sub(this.prevVel).multiplyScalar(1 / dt);
      _v.y += G0;
      _v.applyQuaternion(_q);
      const a = 1 - Math.exp(-dt * 12);
      v.accelBody.lerp(_v, a);
      v.gLoad = v.accelBody.y / G0;
    }

    // --- g effect -----------------------------------------------------------
    // The flight model publishes the *magnitude* in 'gEffect' and the direction
    // in 'gEffectSign' (or as separate 'blackout' / 'redout' channels). The
    // renderer wants one signed number, and getting the sign wrong turns a
    // redout into a blackout — the two look nothing alike.
    const blackout = readNumber(flight, ['blackout']);
    const redout = readNumber(flight, ['redout']);
    const gMag = readNumber(flight, ['gEffect', 'gEffectAmount']);
    const gSign = readNumber(flight, ['gEffectSign']);
    if (blackout !== null || redout !== null) {
      v.gEffect = Math.max(-1, Math.min(1, (blackout ?? 0) - (redout ?? 0)));
    } else if (gMag !== null) {
      v.gEffect = Math.max(-1, Math.min(1, gMag * (gSign !== null && gSign < 0 ? -1 : 1)));
    } else {
      // Fallback physiology: the reservoir models the ~4 s of cerebral oxygen
      // reserve that lets a pilot pull 6 g briefly but not hold it. Positive g
      // above ~4.5 drains it; negative g below ~−1.5 fills it the other way.
      const n = v.gLoad;
      const drain = n > 4.2 ? (n - 4.2) * 0.42 : n < -1.4 ? (n + 1.4) * 0.85 : 0;
      const recover = drain === 0 ? -Math.sign(this.gPool) * 1.1 : 0;
      this.gPool = Math.max(-1.4, Math.min(1.4, this.gPool + (drain + recover) * dt));
      if (drain === 0 && Math.abs(this.gPool) < 0.05) this.gPool = 0;
      v.gEffect = Math.max(-1, Math.min(1, this.gPool));
    }

    // --- buffet / stall -----------------------------------------------------
    const buffetFromFlight = readNumber(flight, ['buffet', 'stallShake']);
    if (buffetFromFlight !== null) {
      v.buffet = clamp01(buffetFromFlight);
    } else {
      const sa = v.spec.aero.stallAlpha;
      v.buffet = smoothstep(sa * 0.82, sa * 1.12, Math.abs(v.alpha)) * clamp01(v.speed / 40);
    }
    v.spinning = clamp01(readNumber(flight, ['spinning']) ?? 0);
    v.stalled = readBool(flight, ['stalled']) ?? Math.abs(v.alpha) > v.spec.aero.stallAlpha;

    // --- control authority ---------------------------------------------------
    const ap = readNumber(flight, ['authPitch']);
    const ar = readNumber(flight, ['authRoll']);
    const ay = readNumber(flight, ['authYaw']);
    v.authValid = ap !== null && ar !== null;
    if (v.authValid) {
      v.authPitch = clamp01(ap!);
      v.authRoll = clamp01(ar!);
      v.authYaw = clamp01(ay ?? 1);
    } else {
      // Estimate: control power rises with dynamic pressure and saturates as the
      // surfaces go heavy. 111 m/s (~400 km/h) is the reference the aircraft
      // spec's published rates are quoted at.
      const t = clamp01(v.ias / 111);
      v.authPitch = v.authRoll = v.authYaw = 0.18 + 0.82 * Math.min(1.2, v.ias / 111) * (t > 0 ? 1 : 0);
    }

    // --- discrete state -----------------------------------------------------
    v.throttle = ent ? ent.throttle : (readNumber(flight, ['throttle']) ?? 0);
    v.health = ent ? ent.health : (readNumber(flight, ['health']) ?? 1);
    v.damage = ent ? ent.damage : (readNumber(flight, ['damage']) ?? 0);
    v.destroyed = (v.damage & DamageBits.Destroyed) !== 0 || v.health <= 0.001;
    const og = readBool(flight, ['onGround', 'grounded']);
    v.onGround = og !== null ? og : v.agl < v.spec.geom.gear.legLen + 0.6 && v.speed < 90;

    this.prevVel.copy(v.vel);
    this.prevQuat.copy(v.quat);
    this.hasPrev = true;
    return v;
  }

  /** Call after a respawn/teleport so the derived rates do not spike. */
  reset(): void { this.hasPrev = false; this.gPool = 0; this.view.omega.set(0, 0, 0); }
}

// ---------------------------------------------------------------------------
// Duck-typed probes into the flight subsystem
// ---------------------------------------------------------------------------

type Bag = Record<string, unknown>;

/**
 * Finds the locally predicted flight state. The flight subsystem is authored
 * separately; rather than couple to one field name, look through the likely
 * ones and validate that the object actually carries a position.
 */
export function readFlightState(ctx: GameContext): Bag | null {
  const sys = ctx.get('flight') as unknown as Bag | undefined;
  if (!sys) return null;
  for (const key of ['localFlight', 'state', 'local', 'localState', 'player', 'flightState', 'flight']) {
    const cand = sys[key];
    if (isFlightLike(cand)) return cand as Bag;
  }
  // Offline sandbox: the flight subsystem is not driving a networked entity, it
  // is running a local world, and the player's state lives on their actor.
  const sandbox = sys['sandbox'] as Bag | undefined;
  const actor = sandbox?.['playerActor'] as Bag | undefined;
  if (actor) {
    for (const key of ['flight', 'state']) {
      const cand = actor[key];
      if (isFlightLike(cand)) return cand as Bag;
    }
    if (isFlightLike(actor)) return actor;
  }
  return isFlightLike(sys) ? sys : null;
}

/** The aircraft spec the flight subsystem is actually flying, if it publishes one. */
function readFlightSpec(ctx: GameContext): unknown {
  const sys = ctx.get('flight') as unknown as Bag | undefined;
  if (!sys) return undefined;
  if (isSpec(sys['localSpec'])) return sys['localSpec'];
  const actor = (sys['sandbox'] as Bag | undefined)?.['playerActor'] as Bag | undefined;
  if (actor && isSpec(actor['spec'])) return actor['spec'];
  return undefined;
}

function isFlightLike(o: unknown): boolean {
  if (!o || typeof o !== 'object') return false;
  const b = o as Bag;
  for (const k of ['pos', 'position', 'p']) {
    const v = b[k];
    if (v && typeof v === 'object' && typeof (v as Bag)['x'] === 'number') return true;
  }
  return false;
}

function isSpec(o: unknown): o is AircraftSpec {
  return !!o && typeof o === 'object' && typeof (o as Bag)['id'] === 'string' && !!(o as Bag)['aero'];
}

function readVec(src: Bag | null, keys: string[], out: THREE.Vector3, fallback: [number, number, number] | null): void {
  if (src && readVecOptional(src, keys, out)) return;
  if (fallback) out.set(fallback[0], fallback[1], fallback[2]);
}

function readVecOptional(src: Bag, keys: string[], out: THREE.Vector3): boolean {
  for (const k of keys) {
    const v = src[k] as Bag | undefined;
    if (v && typeof v === 'object' && typeof v['x'] === 'number') {
      out.set(v['x'] as number, v['y'] as number, v['z'] as number);
      return true;
    }
  }
  return false;
}

function readQuat(src: Bag | null, keys: string[], out: THREE.Quaternion, fallback: [number, number, number, number] | null): void {
  if (src) {
    for (const k of keys) {
      const v = src[k] as Bag | undefined;
      if (v && typeof v === 'object' && typeof v['w'] === 'number') {
        out.set(v['x'] as number, v['y'] as number, v['z'] as number, v['w'] as number);
        return;
      }
    }
  }
  if (fallback) out.set(fallback[0], fallback[1], fallback[2], fallback[3]);
}

function readNumber(src: Bag | null, keys: string[]): number | null {
  if (!src) return null;
  for (const k of keys) {
    const v = src[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function readBool(src: Bag | null, keys: string[]): boolean | null {
  if (!src) return null;
  for (const k of keys) {
    const v = src[k];
    if (typeof v === 'boolean') return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Debug-only: placing the subject for a scripted framing
// ---------------------------------------------------------------------------

/**
 * The shared flight model's spawn helper, late-bound.
 *
 * Only 'spawnInFlight' is used, and only from 'CameraSystem.debugFraming'. The
 * screenshot framings are compositions *of a situation* — a deck pass, a shot
 * over water, a climb through a cloud deck — and a camera that can only point
 * at whatever altitude the aircraft happened to be at cannot produce them.
 *
 * Narrowed from 'import.meta.glob("../../shared/flight/*.ts")' to the barrel
 * alone, and deferred to first use. The wildcard fetched and *evaluated* every
 * module in that directory at boot, including 'selftest.ts', whose last
 * statement is a bare 'main()' that reads process.argv and calls process.exit():
 * a Node CLI harness was shipping as a production chunk, downloaded on every
 * page load, throwing a swallowed ReferenceError on 'process'.
 */
const FLIGHT_GLOB = import.meta.glob('../../shared/flight/index.ts') as Record<string, () => Promise<unknown>>;

type SpawnInFlight = (
  st: unknown, spec: AircraftSpec, env: unknown,
  altitude: number, speed: number, heading: number, throttle?: number,
) => void;

let spawnInFlightFn: SpawnInFlight | null = null;
let flightGlobProbed = false;

/**
 * Eager, because 'placeSubjectForShot' is synchronous and the harness applies a
 * framing within a frame or two of the game signalling ready — but now costing a
 * single already-bundled barrel rather than a directory.
 */
function probeFlightGlob(): void {
  if (flightGlobProbed) return;
  flightGlobProbed = true;
  for (const p of Object.keys(FLIGHT_GLOB)) {
    FLIGHT_GLOB[p]().then((mod) => {
      if (spawnInFlightFn) return;
      const fn = (mod as Record<string, unknown>)['spawnInFlight'];
      if (typeof fn === 'function') spawnInFlightFn = fn as SpawnInFlight;
    }).catch(() => { /* not importable */ });
  }
}
probeFlightGlob();

export interface SubjectPlacement {
  /** Altitude above sea level, metres. */
  altitude: number;
  /** World position; leave undefined to keep the aircraft where it is. */
  x?: number;
  z?: number;
  /** Compass heading, radians. */
  heading: number;
  /** Nose-up, radians. */
  pitch: number;
  /** Right wing down, radians. */
  bank: number;
  /** True airspeed, m/s. */
  speed: number;
  throttle?: number;
}

const _pq = new THREE.Quaternion();
const _pq2 = new THREE.Quaternion();
const _pv = new THREE.Vector3();
const _AX = new THREE.Vector3(1, 0, 0);
const _AY = new THREE.Vector3(0, 1, 0);
const _AZ = new THREE.Vector3(0, 0, 1);

/**
 * Places the locally simulated aircraft for a scripted shot. Returns false if
 * there is no flight state to place or the model is not available, in which
 * case the framing simply composes around wherever the aircraft already is.
 *
 * Debug path only — never called during play.
 */
export function placeSubjectForShot(ctx: GameContext, p: SubjectPlacement): boolean {
  probeFlightGlob();
  const st = readFlightState(ctx) as (Bag & { pos?: Bag; rot?: Bag; vel?: Bag }) | null;
  if (!st || !st.pos || !st.rot || !st.vel) return false;
  const spec = readFlightSpec(ctx);
  if (!isSpec(spec)) return false;

  const sys = ctx.get('flight') as unknown as Bag | undefined;
  const env = sys?.['env'] ?? {};

  if (spawnInFlightFn) {
    // Resets throttle, gear, flaps, fuel and damage as well as the trajectory —
    // exactly the clean slate a beauty shot wants.
    try { spawnInFlightFn(st, spec, env, p.altitude, p.speed, p.heading, p.throttle ?? 1); }
    catch { return false; }
  } else {
    (st.pos as Bag)['y'] = p.altitude;
  }

  if (p.x !== undefined) (st.pos as Bag)['x'] = p.x;
  if (p.z !== undefined) (st.pos as Bag)['z'] = p.z;

  // Attitude. Body signs (see src/shared/flight/types.ts): nose-up is a
  // negative rotation about +X and right-wing-down a negative rotation about
  // +Z, because the body frame is X-right / Y-up / Z-forward.
  _pq.setFromAxisAngle(_AY, p.heading);
  _pq2.setFromAxisAngle(_AX, -p.pitch);
  _pq.multiply(_pq2);
  _pq2.setFromAxisAngle(_AZ, -p.bank);
  _pq.multiply(_pq2);
  const r = st.rot as Bag;
  r['x'] = _pq.x; r['y'] = _pq.y; r['z'] = _pq.z; r['w'] = _pq.w;

  // Velocity along the new nose direction, so the aircraft is genuinely flying
  // rather than mushing sideways for the first second of the shot.
  _pv.set(0, 0, p.speed).applyQuaternion(_pq);
  const v = st.vel as Bag;
  v['x'] = _pv.x; v['y'] = _pv.y; v['z'] = _pv.z;
  const om = st['omega'] as Bag | undefined;
  if (om) { om['x'] = 0; om['y'] = 0; om['z'] = 0; }

  return true;
}

/** Builds a world matrix for an aircraft pose; used by the camera rigs. */
export function poseMatrix(pos: THREE.Vector3, quat: THREE.Quaternion, out: THREE.Matrix4): THREE.Matrix4 {
  return out.compose(pos, quat, _ONE);
}
const _ONE = new THREE.Vector3(1, 1, 1);
