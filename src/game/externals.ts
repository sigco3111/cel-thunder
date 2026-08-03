import type * as THREE from 'three';
import type { AircraftSpec } from '../shared/aircraft';
import type { InputFrame } from '../shared/protocol';
import type { Q, V3 } from '../shared/math';

/**
 * Late-binding seam for the three subsystems this module depends on but does
 * not own: the procedural aircraft mesh builder ('src/assets/aircraft'), the
 * shared flight model ('src/shared/flight') and the terrain sampler
 * ('src/world').
 *
 * They are developed in parallel and may not be on disk yet. A static
 * 'import' of a missing module is a hard boot failure — a blank screen — so we
 * resolve them through 'import.meta.glob', which Vite evaluates at build time
 * and which simply yields an empty map when nothing matches. Every dependency
 * has a self-contained fallback, so the game boots, flies and renders whether
 * or not the real modules exist.
 *
 * The probing is deliberately structural rather than nominal: sibling agents
 * own those files and may name their state fields slightly differently, and a
 * silent visual failure is far worse than a small amount of adapter code.
 */

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * The rig 'buildAircraft(spec)' returns. Every named part is optional here even
 * though the real builder always provides it — a missing part must degrade to
 * "that bit does not animate", never to a crash inside the animation loop.
 */
export interface AircraftModel {
  root: THREE.Object3D;
  propeller?: THREE.Object3D;
  propDisc?: THREE.Object3D;
  spinner?: THREE.Object3D;
  aileronL?: THREE.Object3D;
  aileronR?: THREE.Object3D;
  elevatorL?: THREE.Object3D;
  elevatorR?: THREE.Object3D;
  rudder?: THREE.Object3D;
  flapL?: THREE.Object3D;
  flapR?: THREE.Object3D;
  gearL?: THREE.Object3D;
  gearR?: THREE.Object3D;
  gearTail?: THREE.Object3D;
  gearDoorL?: THREE.Object3D;
  gearDoorR?: THREE.Object3D;
  canopy?: THREE.Object3D;
  pilot?: THREE.Object3D;
  wingtipL?: THREE.Object3D;
  wingtipR?: THREE.Object3D;
  exhaustPorts?: THREE.Object3D[];
  gunPorts?: THREE.Object3D[];
  damageParts?: Record<string, THREE.Object3D> | THREE.Object3D[];
  [key: string]: unknown;
}

/** Environment sampler handed to the flight model (mirrors 'server/Room.ts'). */
export interface FlightEnv {
  airDensity(y: number): number;
  windAt(p: V3, out: V3): V3;
  terrainHeight(x: number, z: number): number;
  terrainNormal(x: number, z: number, out: V3): V3;
}

/**
 * Opaque flight state. We only ever read the transform out of it through
 * {@link readFlightTransform}, which probes for the field names rather than
 * assuming them.
 */
export type FlightState = Record<string, unknown>;

export interface FlightModule {
  createFlightState(spec: AircraftSpec, pos: V3, rot: Q): FlightState;
  stepFlight(state: FlightState, spec: AircraftSpec, input: InputFrame, env: FlightEnv, dt: number): void;
  /**
   * Primes a fresh state for an air start — engine warm and turning, gear up,
   * blade angle governed for the speed. Optional because the fallback model
   * has no powerplant to prime, but when the shared model is in use the client
   * MUST call it: 'createFlightState' leaves the engine cold and idling with
   * the gear down, and predicting from that against a server that air-started
   * properly diverges immediately.
   */
  spawnInFlight?(
    state: FlightState, spec: AircraftSpec, env: FlightEnv,
    altitude: number, speed: number, heading: number, throttle?: number,
  ): void;
}

export interface TerrainSampler {
  height(x: number, z: number): number;
  normal(x: number, z: number, out: V3): V3;
  type(x: number, z: number): string;
}

// ---------------------------------------------------------------------------
// Glob-based resolution
// ---------------------------------------------------------------------------

type ModuleRecord = Record<string, unknown>;
type Loader = () => Promise<unknown>;

/**
 * Prefer 'index.ts' (the documented entry point), then shorter paths, so a
 * package that re-exports from several files resolves to its barrel rather
 * than to whichever internal file happens to sort first.
 */
function orderedPaths(glob: Record<string, Loader>): string[] {
  return Object.keys(glob).sort((a, b) => {
    const ai = /\/index\.tsx?$/.test(a) ? 0 : 1;
    const bi = /\/index\.tsx?$/.test(b) ? 0 : 1;
    if (ai !== bi) return ai - bi;
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : 1;
  });
}

async function findModule(
  glob: Record<string, Loader>,
  accept: (m: ModuleRecord) => boolean,
  label: string,
): Promise<ModuleRecord | null> {
  for (const path of orderedPaths(glob)) {
    let mod: ModuleRecord;
    try {
      mod = (await glob[path]()) as ModuleRecord;
    } catch (err) {
      // A sibling module that throws at import time must not take us with it.
      console.warn(`[externals] ${label}: "${path}" failed to import`, err);
      continue;
    }
    try {
      if (accept(mod)) return mod;
    } catch { /* shape probe threw — treat as a non-match */ }
  }
  return null;
}

const isFn = (v: unknown): v is (...a: never[]) => unknown => typeof v === 'function';

// 'import.meta.glob' is erased by Vite into a static map. When the target
// directory is empty the map is empty and every lookup below no-ops.
const AIRCRAFT_GLOB = import.meta.glob('../assets/aircraft/*.ts') as Record<string, Loader>;
const FLIGHT_GLOB = import.meta.glob('../shared/flight/*.ts') as Record<string, Loader>;
const WORLD_GLOB = import.meta.glob('../world/*.ts') as Record<string, Loader>;

// ---------------------------------------------------------------------------
// Resolved singletons
// ---------------------------------------------------------------------------

export interface Externals {
  /** Real builder, or null when we must use the stand-in. */
  buildAircraft: ((spec: AircraftSpec) => AircraftModel) | null;
  disposeAircraft: ((model: AircraftModel) => void) | null;
  flight: FlightModule | null;
  terrain: TerrainSampler | null;
  /** Human-readable summary for the boot log. */
  report: string;
}

let cached: Externals | null = null;
let loading: Promise<Externals> | null = null;

export function externals(): Externals {
  return cached ?? EMPTY;
}

const EMPTY: Externals = {
  buildAircraft: null, disposeAircraft: null, flight: null, terrain: null,
  report: 'externals not loaded',
};

/** Resolve every optional dependency once. Safe to call concurrently. */
export function loadExternals(mapSeed: number): Promise<Externals> {
  if (cached) return Promise.resolve(cached);
  if (loading) return loading;
  loading = resolveAll(mapSeed).then((e) => {
    cached = e;
    console.info(`[externals] ${e.report}`);
    return e;
  });
  return loading;
}

async function resolveAll(mapSeed: number): Promise<Externals> {
  const notes: string[] = [];

  const acMod = await findModule(
    AIRCRAFT_GLOB,
    (m) => isFn(m.buildAircraft),
    'aircraft',
  );
  const buildAircraft = acMod ? (acMod.buildAircraft as Externals['buildAircraft']) : null;
  const disposeAircraft = acMod && isFn(acMod.disposeAircraft)
    ? (acMod.disposeAircraft as (m: AircraftModel) => void)
    : null;
  notes.push(buildAircraft ? 'aircraft=real' : 'aircraft=fallback');

  const flMod = await findModule(
    FLIGHT_GLOB,
    (m) => isFn(m.createFlightState) && isFn(m.stepFlight),
    'flight',
  );
  const flight = flMod
    ? ({
      createFlightState: flMod.createFlightState as FlightModule['createFlightState'],
      stepFlight: flMod.stepFlight as FlightModule['stepFlight'],
      spawnInFlight: isFn(flMod.spawnInFlight)
        ? (flMod.spawnInFlight as FlightModule['spawnInFlight'])
        : undefined,
    })
    : null;
  notes.push(flight ? 'flight=shared' : 'flight=fallback');

  const terrain = await resolveTerrain(mapSeed);
  notes.push(terrain ? 'terrain=world' : 'terrain=flat');

  return { buildAircraft, disposeAircraft, flight, terrain, report: notes.join(' ') };
}

/**
 * The world subsystem has published two different shapes over its life: free
 * functions ('terrainHeight'/'terrainNormal'/'terrainType') and a heightfield
 * object behind 'getHeightfield(seed)'. Accept either.
 */
async function resolveTerrain(mapSeed: number): Promise<TerrainSampler | null> {
  const fnMod = await findModule(
    WORLD_GLOB,
    (m) => isFn(m.terrainHeight),
    'world',
  );
  if (fnMod) {
    const h = fnMod.terrainHeight as (x: number, z: number) => number;
    const n = isFn(fnMod.terrainNormal)
      ? (fnMod.terrainNormal as (x: number, z: number, out?: V3) => V3 | void)
      : null;
    const t = isFn(fnMod.terrainType) ? (fnMod.terrainType as (x: number, z: number) => string) : null;
    return {
      height: h,
      normal: (x, z, out) => {
        if (n) {
          const r = n(x, z, out);
          if (r && typeof (r as V3).x === 'number' && r !== out) {
            out.x = (r as V3).x; out.y = (r as V3).y; out.z = (r as V3).z;
          }
          return out;
        }
        return finiteDifferenceNormal(h, x, z, out);
      },
      type: t ?? (() => 'grass'),
    };
  }

  const hfMod = await findModule(
    WORLD_GLOB,
    (m) => isFn(m.getHeightfield),
    'world/heightfield',
  );
  if (hfMod) {
    try {
      const hf = (hfMod.getHeightfield as (seed: number) => ModuleRecord)(mapSeed);
      const heightAt = hf.heightAt as ((x: number, z: number) => number) | undefined;
      if (isFn(heightAt)) {
        const normalAt = hf.normalAt as ((x: number, z: number, out: V3) => void) | undefined;
        const typeAt = hf.typeAt as ((x: number, z: number) => string) | undefined;
        const H = (x: number, z: number) => heightAt.call(hf, x, z);
        return {
          height: H,
          normal: (x, z, out) => {
            if (isFn(normalAt)) { normalAt.call(hf, x, z, out); return out; }
            return finiteDifferenceNormal(H, x, z, out);
          },
          type: isFn(typeAt) ? (x, z) => typeAt.call(hf, x, z) : () => 'grass',
        };
      }
    } catch (err) {
      console.warn('[externals] getHeightfield threw', err);
    }
  }

  return null;
}

/** Central-difference surface normal, used when the sampler offers only height. */
function finiteDifferenceNormal(
  h: (x: number, z: number) => number, x: number, z: number, out: V3,
): V3 {
  const d = 4;
  const hx = h(x + d, z) - h(x - d, z);
  const hz = h(x, z + d) - h(x, z - d);
  // Gradient (dh/dx, dh/dz) -> normal (-dh/dx, 1, -dh/dz), normalised.
  const nx = -hx / (2 * d), nz = -hz / (2 * d);
  const inv = 1 / Math.hypot(nx, 1, nz);
  out.x = nx * inv; out.y = inv; out.z = nz * inv;
  return out;
}

// ---------------------------------------------------------------------------
// Flight-state transform adapter
// ---------------------------------------------------------------------------

const POS_KEYS = ['pos', 'position', 'p', 'xyz'];
const VEL_KEYS = ['vel', 'velocity', 'v'];
const ROT_KEYS = ['rot', 'orientation', 'quat', 'q', 'attitude'];
const OMEGA_KEYS = ['omega', 'angVel', 'angularVelocity', 'w', 'rates', 'pqr'];

export interface FlightTransform {
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  qx: number; qy: number; qz: number; qw: number;
  wx: number; wy: number; wz: number;
}

const keyCache = new WeakMap<object, { p?: string; v?: string; r?: string; o?: string }>();

function pickKey(state: FlightState, candidates: string[], needW: boolean): string | undefined {
  for (const k of candidates) {
    const val = state[k] as Record<string, unknown> | undefined;
    if (val && typeof val === 'object'
      && typeof val.x === 'number' && typeof val.y === 'number' && typeof val.z === 'number'
      && (!needW || typeof val.w === 'number')) return k;
  }
  return undefined;
}

/** Reads position/velocity/orientation out of an opaque flight state. */
export function readFlightTransform(state: FlightState, out: FlightTransform): FlightTransform {
  let keys = keyCache.get(state as object);
  if (!keys) {
    keys = {
      p: pickKey(state, POS_KEYS, false),
      v: pickKey(state, VEL_KEYS, false),
      r: pickKey(state, ROT_KEYS, true),
      o: pickKey(state, OMEGA_KEYS, false),
    };
    keyCache.set(state as object, keys);
  }
  const p = keys.p ? (state[keys.p] as V3) : undefined;
  const v = keys.v ? (state[keys.v] as V3) : undefined;
  const r = keys.r ? (state[keys.r] as Q) : undefined;
  const o = keys.o ? (state[keys.o] as V3) : undefined;

  out.px = p?.x ?? 0; out.py = p?.y ?? 0; out.pz = p?.z ?? 0;
  out.vx = v?.x ?? 0; out.vy = v?.y ?? 0; out.vz = v?.z ?? 0;
  out.qx = r?.x ?? 0; out.qy = r?.y ?? 0; out.qz = r?.z ?? 0; out.qw = r?.w ?? 1;
  out.wx = o?.x ?? 0; out.wy = o?.y ?? 0; out.wz = o?.z ?? 0;
  return out;
}

/** Writes an authoritative transform back into an opaque flight state. */
export function writeFlightTransform(state: FlightState, t: FlightTransform): void {
  readFlightTransform(state, _probe); // populates the key cache
  const keys = keyCache.get(state as object)!;
  if (keys.p) { const p = state[keys.p] as V3; p.x = t.px; p.y = t.py; p.z = t.pz; }
  if (keys.v) { const v = state[keys.v] as V3; v.x = t.vx; v.y = t.vy; v.z = t.vz; }
  if (keys.r) { const r = state[keys.r] as Q; r.x = t.qx; r.y = t.qy; r.z = t.qz; r.w = t.qw; }
  if (keys.o) { const o = state[keys.o] as V3; o.x = t.wx; o.y = t.wy; o.z = t.wz; }
}

const _probe: FlightTransform = {
  px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, qx: 0, qy: 0, qz: 0, qw: 1, wx: 0, wy: 0, wz: 0,
};

export function newFlightTransform(): FlightTransform {
  return { px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, qx: 0, qy: 0, qz: 0, qw: 1, wx: 0, wy: 0, wz: 0 };
}

/**
 * Numbers the flight model may or may not expose. Missing entries fall back to
 * values derived by the caller, so presentation never depends on them.
 */
export function readFlightScalar(state: FlightState, keys: string[], fallback: number): number {
  for (const k of keys) {
    const v = state[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return fallback;
}
