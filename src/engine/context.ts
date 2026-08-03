import type * as THREE from 'three';
import type { EntityState } from '../shared/protocol';

/**
 * The seam every subsystem plugs into. Subsystems are owned by 'Game' and are
 * updated in a fixed order each frame (see Game.SUBSYSTEM_ORDER). They must not
 * reach into each other directly — everything goes through this context, so
 * modules stay independently replaceable.
 */
export interface GameContext {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  /** Seconds since the game started. */
  time: number;
  /** Last frame delta, clamped. */
  dt: number;
  /** Frame counter. */
  frame: number;
  /** Deterministic map seed from the server. */
  mapSeed: number;

  /** Sun direction (normalised, pointing *from* the sun toward the scene). */
  readonly sunDir: THREE.Vector3;
  /** Current sun colour and intensity, driven by the sky system. */
  readonly sunColor: THREE.Color;
  sunIntensity: number;
  /** Ambient/sky colour used by toon materials for the shadow ramp. */
  readonly ambientColor: THREE.Color;

  /** Time of day in hours [0,24) — the sky system owns this. */
  timeOfDay: number;

  /** All replicated entities, keyed by entity id. */
  readonly entities: Map<number, EntityState>;
  /** Entity id of the aircraft this client controls (0 = spectating). */
  localEntityId: number;
  /** Local player id assigned by the server. */
  localPlayerId: number;
  localTeam: number;

  /** Registry so subsystems can find each other by name when they must. */
  get<T extends Subsystem>(name: string): T | undefined;

  /** Central event bus for one-shot cross-subsystem signals. */
  readonly bus: EventBus;

  /** Quality tier, driven by the adaptive performance governor. */
  quality: QualityTier;
  readonly settings: Settings;
}

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface Settings {
  shadows: boolean;
  shadowMapSize: number;
  volumetricClouds: boolean;
  cloudSteps: number;
  outlineWidth: number;
  bloom: number;
  ssao: boolean;
  motionBlur: boolean;
  dof: boolean;
  renderScale: number;
  fov: number;
  masterVolume: number;
  mouseSensitivity: number;
  invertY: boolean;
  showHud: boolean;
}

export interface Subsystem {
  readonly name: string;
  /** Called once, in dependency order. May be async for asset generation. */
  init(ctx: GameContext): void | Promise<void>;
  /** Called every frame after input and network are applied. */
  update?(ctx: GameContext): void;
  /** Called after all updates, immediately before the render pass. */
  lateUpdate?(ctx: GameContext): void;
  /** Called on canvas resize. */
  resize?(width: number, height: number): void;
  dispose?(): void;
}

type Handler = (payload: any) => void;

/** Tiny synchronous pub/sub. Handlers must not throw. */
export class EventBus {
  private map = new Map<string, Set<Handler>>();
  on(evt: string, fn: Handler): () => void {
    let s = this.map.get(evt);
    if (!s) { s = new Set(); this.map.set(evt, s); }
    s.add(fn);
    return () => s!.delete(fn);
  }
  emit(evt: string, payload?: any): void {
    const s = this.map.get(evt);
    if (!s) return;
    for (const fn of s) {
      try { fn(payload); } catch (err) { console.error(`[bus] handler for "${evt}" threw`, err); }
    }
  }
  clear() { this.map.clear(); }
}

export const DEFAULT_SETTINGS: Settings = {
  shadows: true,
  shadowMapSize: 2048,
  volumetricClouds: true,
  cloudSteps: 48,
  outlineWidth: 1.0,
  bloom: 0.55,
  ssao: true,
  motionBlur: true,
  dof: true,
  renderScale: 1,
  fov: 68,
  masterVolume: 0.8,
  mouseSensitivity: 1,
  invertY: false,
  showHud: true,
};
