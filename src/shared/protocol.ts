/**
 * Wire protocol shared by client and authoritative server.
 *
 * Everything hot-path is binary (DataView over ArrayBuffer). Control-plane
 * messages (join, chat, spawn requests) are JSON for readability — they are
 * infrequent and not bandwidth-critical.
 *
 * Coordinate system: right-handed, Y = up, metres, radians, seconds.
 */

import type { WeatherId } from './environment';

export const PROTOCOL_VERSION = 1;

/** Server simulation rate. Clients predict at render rate and reconcile. */
export const TICK_HZ = 60;
export const TICK_DT = 1 / TICK_HZ;
/** Rate at which the server broadcasts snapshots (every Nth tick). */
export const SNAPSHOT_HZ = 20;
export const SNAPSHOT_EVERY = TICK_HZ / SNAPSHOT_HZ;
/** How long the server keeps historical states for lag compensation (seconds). */
export const LAGCOMP_HISTORY = 1.0;

// ---------------------------------------------------------------------------
// Message ids
// ---------------------------------------------------------------------------

export enum C2S {
  Hello = 1,
  Input = 2,
  SpawnRequest = 3,
  Chat = 4,
  Pong = 5,
  SwitchCamera = 6,
  Leave = 7,
}

export enum S2C {
  Welcome = 1,
  Snapshot = 2,
  Event = 3,
  Ping = 4,
  Chat = 5,
  SpawnAccepted = 6,
  Killfeed = 7,
  MatchState = 8,
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Bit flags packed into a single u16 in the input frame. */
export enum InputBits {
  Fire1 = 1 << 0,   // primary (MGs)
  Fire2 = 1 << 1,   // secondary (cannons)
  DropBomb = 1 << 2,
  FireRocket = 1 << 3,
  GearToggle = 1 << 4,
  FlapsUp = 1 << 5,
  FlapsDown = 1 << 6,
  BrakeAir = 1 << 7,
  WheelBrake = 1 << 8,
  Boost = 1 << 9,   // WEP
  Radiator = 1 << 10,
  Bail = 1 << 11,
  LookBack = 1 << 12,
}

/**
 * One client input frame. Sent unreliably at input rate; the server buffers a
 * small jitter window and applies frames in sequence order.
 * Axes are normalised [-1,1] except throttle [0,1].
 */
export interface InputFrame {
  seq: number;       // monotonic, wraps at 2^16
  dt: number;        // seconds this frame represents (clamped server-side)
  pitch: number;
  roll: number;
  yaw: number;
  throttle: number;
  bits: number;      // InputBits
  aimX: number;      // mouse-aim target in normalised screen space
  aimY: number;
}

export const INPUT_FRAME_BYTES = 20;

export function writeInputFrame(dv: DataView, off: number, f: InputFrame): number {
  dv.setUint16(off, f.seq & 0xffff, true); off += 2;
  dv.setUint16(off, Math.min(65535, Math.round(f.dt * 100000)), true); off += 2;
  dv.setInt16(off, q16(f.pitch), true); off += 2;
  dv.setInt16(off, q16(f.roll), true); off += 2;
  dv.setInt16(off, q16(f.yaw), true); off += 2;
  dv.setUint16(off, Math.round(clamp01(f.throttle) * 65535), true); off += 2;
  dv.setUint16(off, f.bits & 0xffff, true); off += 2;
  dv.setInt16(off, q16(f.aimX), true); off += 2;
  dv.setInt16(off, q16(f.aimY), true); off += 2;
  dv.setUint16(off, 0, true); off += 2; // reserved / alignment
  return off;
}

export function readInputFrame(dv: DataView, off: number, out: InputFrame): number {
  out.seq = dv.getUint16(off, true); off += 2;
  out.dt = dv.getUint16(off, true) / 100000; off += 2;
  out.pitch = dq16(dv.getInt16(off, true)); off += 2;
  out.roll = dq16(dv.getInt16(off, true)); off += 2;
  out.yaw = dq16(dv.getInt16(off, true)); off += 2;
  out.throttle = dv.getUint16(off, true) / 65535; off += 2;
  out.bits = dv.getUint16(off, true); off += 2;
  out.aimX = dq16(dv.getInt16(off, true)); off += 2;
  out.aimY = dq16(dv.getInt16(off, true)); off += 2;
  off += 2;
  return off;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Quantise [-1,1] to int16. */
const q16 = (v: number) => Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
const dq16 = (v: number) => v / 32767;

// ---------------------------------------------------------------------------
// Entity snapshot
// ---------------------------------------------------------------------------

export enum EntityKind {
  Aircraft = 1,
  Projectile = 2,
  Bomb = 3,
  Rocket = 4,
  GroundUnit = 5,
  Wreck = 6,
  Parachute = 7,
}

/** Damage state bit flags mirrored to clients for visual/physics response. */
export enum DamageBits {
  LeftWing = 1 << 0,
  RightWing = 1 << 1,
  Tail = 1 << 2,
  Rudder = 1 << 3,
  Elevator = 1 << 4,
  Aileron = 1 << 5,
  Engine = 1 << 6,
  EngineFire = 1 << 7,
  FuelLeak = 1 << 8,
  OilLeak = 1 << 9,
  PilotHit = 1 << 10,
  PilotDead = 1 << 11,
  GearBroken = 1 << 12,
  Destroyed = 1 << 13,
  ControlsSevered = 1 << 14,
  WingRipped = 1 << 15,
}

/**
 * Per-entity state as broadcast. Positions are float32 (world is ~65 km, f32
 * gives ~4 mm precision there — plenty). Orientation is a smallest-three
 * compressed quaternion in 4 bytes.
 */
export interface EntityState {
  id: number;
  kind: EntityKind;
  ownerId: number;      // player id, 0 = world
  team: number;
  typeId: number;       // aircraft/ordnance archetype index
  px: number; py: number; pz: number;
  qx: number; qy: number; qz: number; qw: number;
  vx: number; vy: number; vz: number;
  // presentation-only extras
  throttle: number;     // 0..1
  rpm: number;          // normalised 0..1 for prop/audio
  health: number;       // 0..1
  damage: number;       // DamageBits
  flaps: number;        // 0..1
  gear: number;         // 0..1 deployment
  ctlPitch: number;     // -1..1 surface deflection (visual)
  ctlRoll: number;
  ctlYaw: number;
}

export function newEntityState(): EntityState {
  return {
    id: 0, kind: EntityKind.Aircraft, ownerId: 0, team: 0, typeId: 0,
    px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0,
    throttle: 0, rpm: 0, health: 1, damage: 0, flaps: 0, gear: 0,
    ctlPitch: 0, ctlRoll: 0, ctlYaw: 0,
  };
}

/** Bytes per entity in a snapshot (see write/readEntity). */
export const ENTITY_BYTES = 44;

export function writeEntity(dv: DataView, off: number, e: EntityState): number {
  dv.setUint16(off, e.id, true); off += 2;
  dv.setUint8(off, e.kind); off += 1;
  dv.setUint8(off, (e.team & 0x0f) | ((e.typeId & 0x0f) << 4)); off += 1;
  dv.setUint16(off, e.ownerId, true); off += 2;
  dv.setUint16(off, e.damage, true); off += 2;
  dv.setFloat32(off, e.px, true); off += 4;
  dv.setFloat32(off, e.py, true); off += 4;
  dv.setFloat32(off, e.pz, true); off += 4;
  off = writeQuat(dv, off, e.qx, e.qy, e.qz, e.qw);      // 4 bytes
  // velocity: 3 x int16 in units of 0.25 m/s (±8 km/s)
  dv.setInt16(off, clampI16(e.vx * 4), true); off += 2;
  dv.setInt16(off, clampI16(e.vy * 4), true); off += 2;
  dv.setInt16(off, clampI16(e.vz * 4), true); off += 2;
  dv.setUint8(off, Math.round(clamp01(e.throttle) * 255)); off += 1;
  dv.setUint8(off, Math.round(clamp01(e.rpm) * 255)); off += 1;
  dv.setUint8(off, Math.round(clamp01(e.health) * 255)); off += 1;
  dv.setUint8(off, Math.round(clamp01(e.flaps) * 255)); off += 1;
  dv.setUint8(off, Math.round(clamp01(e.gear) * 255)); off += 1;
  dv.setInt8(off, Math.round(e.ctlPitch * 127)); off += 1;
  dv.setInt8(off, Math.round(e.ctlRoll * 127)); off += 1;
  dv.setInt8(off, Math.round(e.ctlYaw * 127)); off += 1;
  return off; // 44
}

export function readEntity(dv: DataView, off: number, e: EntityState): number {
  e.id = dv.getUint16(off, true); off += 2;
  e.kind = dv.getUint8(off); off += 1;
  const packed = dv.getUint8(off); off += 1;
  e.team = packed & 0x0f; e.typeId = (packed >> 4) & 0x0f;
  e.ownerId = dv.getUint16(off, true); off += 2;
  e.damage = dv.getUint16(off, true); off += 2;
  e.px = dv.getFloat32(off, true); off += 4;
  e.py = dv.getFloat32(off, true); off += 4;
  e.pz = dv.getFloat32(off, true); off += 4;
  off = readQuat(dv, off, e);
  e.vx = dv.getInt16(off, true) / 4; off += 2;
  e.vy = dv.getInt16(off, true) / 4; off += 2;
  e.vz = dv.getInt16(off, true) / 4; off += 2;
  e.throttle = dv.getUint8(off) / 255; off += 1;
  e.rpm = dv.getUint8(off) / 255; off += 1;
  e.health = dv.getUint8(off) / 255; off += 1;
  e.flaps = dv.getUint8(off) / 255; off += 1;
  e.gear = dv.getUint8(off) / 255; off += 1;
  e.ctlPitch = dv.getInt8(off) / 127; off += 1;
  e.ctlRoll = dv.getInt8(off) / 127; off += 1;
  e.ctlYaw = dv.getInt8(off) / 127; off += 1;
  return off;
}

const clampI16 = (v: number) => Math.max(-32767, Math.min(32767, Math.round(v)));

/**
 * Smallest-three quaternion compression into 32 bits:
 * 2 bits = index of largest component, 3 x 10 bits = the others in
 * [-1/√2, 1/√2]. Max error ~0.1°, which is invisible after interpolation.
 */
export function writeQuat(dv: DataView, off: number, x: number, y: number, z: number, w: number): number {
  const a = [x, y, z, w];
  let li = 0, lv = Math.abs(a[0]);
  for (let i = 1; i < 4; i++) { const v = Math.abs(a[i]); if (v > lv) { lv = v; li = i; } }
  const sign = a[li] < 0 ? -1 : 1;
  const S = Math.SQRT1_2;
  let out = li & 3;
  let shift = 2;
  for (let i = 0; i < 4; i++) {
    if (i === li) continue;
    const v = a[i] * sign;
    const qv = Math.max(0, Math.min(1023, Math.round((v / S * 0.5 + 0.5) * 1023)));
    out |= qv << shift;
    shift += 10;
  }
  dv.setUint32(off, out >>> 0, true);
  return off + 4;
}

export function readQuat(dv: DataView, off: number, e: { qx: number; qy: number; qz: number; qw: number }): number {
  const bits = dv.getUint32(off, true);
  const li = bits & 3;
  const S = Math.SQRT1_2;
  const out = [0, 0, 0, 0];
  let shift = 2, sum = 0;
  for (let i = 0; i < 4; i++) {
    if (i === li) continue;
    const qv = (bits >>> shift) & 1023;
    const v = ((qv / 1023) * 2 - 1) * S;
    out[i] = v; sum += v * v;
    shift += 10;
  }
  out[li] = Math.sqrt(Math.max(0, 1 - sum));
  e.qx = out[0]; e.qy = out[1]; e.qz = out[2]; e.qw = out[3];
  return off + 4;
}

// ---------------------------------------------------------------------------
// Snapshot framing
// ---------------------------------------------------------------------------

export interface SnapshotHeader {
  tick: number;        // server tick this snapshot represents
  serverTime: number;  // ms since match start
  ackSeq: number;      // last input seq the server consumed from this client
  count: number;       // entity count
}

export const SNAPSHOT_HEADER_BYTES = 13; // msgId(1) + tick(4) + time(4) + ack(2) + count(2)

// ---------------------------------------------------------------------------
// One-shot events (explosions, hits, gunfire) — replicated for VFX/audio
// ---------------------------------------------------------------------------

export enum EventKind {
  Explosion = 1,
  HitSpark = 2,
  HitArmour = 3,
  Gunfire = 4,
  Kill = 5,
  Bailout = 6,
  GroundImpact = 7,
  WaterImpact = 8,
  StructureFail = 9,
  Critical = 10,
}

export interface GameEvent {
  kind: EventKind;
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number; // normal / direction
  scale: number;
  a: number; // context-dependent (entity id, ammo type, ...)
  b: number;
}

// ---------------------------------------------------------------------------
// JSON control-plane messages
// ---------------------------------------------------------------------------

export interface HelloMsg { t: 'hello'; name: string; version: number }
export interface WelcomeMsg {
  t: 'welcome';
  playerId: number;
  team: number;
  mapSeed: number;
  mapName: string;
  serverTime: number;
  tickHz: number;
  players: PlayerInfo[];
  /**
   * Per-match sky. The server owns it because the client predicts against the
   * wind it implies (see 'shared/environment.ts'), so the two halves cannot be
   * allowed to disagree about which one is in force.
   */
  weather: WeatherId;
  /** Local solar-clock hours, [0,24). */
  timeOfDay: number;
}
export interface PlayerInfo { id: number; name: string; team: number; kills: number; deaths: number; score: number; alive: boolean }
export interface SpawnRequestMsg {
  t: 'spawn';
  aircraft: string;
  /**
   * Hangar loadout id, or omitted/'clean' for guns only.
   *
   * Without this the server had no way to know what the player had hung on the
   * aeroplane, so an online pilot always flew clean however carefully they
   * armed themselves in the hangar — and, because the mass and drag penalty is
   * part of the flight model the client predicts with, the two halves also
   * disagreed about how fast the aeroplane was. The server validates it against
   * the airframe's own loadout table and falls back to clean.
   */
  loadout?: string;
}
export interface SpawnAcceptedMsg {
  t: 'spawned'; entityId: number; aircraft: string;
  /** The loadout actually granted, which may not be the one asked for. */
  loadout: string;
}
/**
 * Stores remaining on the addressed player's aeroplane. Sent on spawn and on
 * every release, because the server owns the racks: the client's readout is a
 * display of this, not a count of its own.
 */
export interface StoresMsg {
  t: 'stores'; entityId: number; loadout: string; bombs: number; rockets: number;
}
export interface ChatMsg { t: 'chat'; from: string; text: string; team: number }
export interface KillfeedMsg { t: 'kill'; killer: string; victim: string; weapon: string; killerTeam: number; victimTeam: number }
export interface MatchStateMsg {
  t: 'match'; scoreA: number; scoreB: number; timeLeft: number; players: PlayerInfo[];
  /** Repeated on every match tick so a mid-match weather change replicates. */
  weather: WeatherId;
  timeOfDay: number;
}

export type ControlMsg =
  | HelloMsg | WelcomeMsg | SpawnRequestMsg | SpawnAcceptedMsg | StoresMsg
  | ChatMsg | KillfeedMsg | MatchStateMsg;
