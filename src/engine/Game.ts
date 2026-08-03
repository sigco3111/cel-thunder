import * as THREE from 'three';
import {
  DEFAULT_SETTINGS, EventBus,
  type GameContext, type QualityTier, type Settings, type Subsystem,
} from './context';
import type { EntityState } from '../shared/protocol';

/**
 * Live frame statistics, refreshed every frame.
 *
 * This is a *contract* with the screenshot/critique harness, which reads
 * 'window.__game.stats' and reports the numbers alongside each capture. It has
 * to be honest: 'drawCalls' and 'triangles' are the renderer's own counters
 * accumulated across every pass of the composer (see 'renderer.info.autoReset'
 * below), and 'fps' is measured from real frame-to-frame wall time rather than
 * derived from the clamped 'dt' the simulation uses.
 */
export interface FrameStats {
  /** Smoothed frames per second, measured from wall time. */
  fps: number;
  /** Unsmoothed milliseconds between the last two frames. */
  frameMs: number;
  /** Current adaptive quality tier. */
  quality: QualityTier;
  /** Draw calls issued during the whole previous frame, all passes. */
  drawCalls: number;
  /** Triangles submitted during the whole previous frame, all passes. */
  triangles: number;
  /** Render-target/program/texture counts, useful when hunting leaks. */
  programs: number;
  geometries: number;
  textures: number;
  /** Frames rendered since boot. */
  frame: number;
}

/** A subsystem that could not be initialised and has been dropped. */
export interface SubsystemFailure {
  name: string;
  error: string;
}

/**
 * Hard ceiling on how long any one subsystem may spend in 'init'. The slowest
 * legitimate subsystem (world: bakes a 64 km heightfield) takes well under a
 * second on a laptop; twenty-five seconds means "this will never resolve", and
 * a boot screen that sits there forever is strictly worse than a game missing
 * one subsystem.
 */
const INIT_TIMEOUT_MS = 25000;

/** How many consecutive throwing frames before a subsystem's update is dropped. */
const UPDATE_STRIKES = 12;

/**
 * Owns the frame loop, the THREE core objects and the subsystem registry.
 *
 * Subsystems are updated in registration order, so register them in dependency
 * order: net -> input -> physics/entities -> world -> vfx -> camera -> render.
 *
 * **Nothing a subsystem does may wedge the engine.** A subsystem whose 'init'
 * throws or never settles is logged loudly and skipped; one whose 'update'
 * throws is logged and, if it keeps throwing, disabled. The alternative — a
 * loading bar frozen at "flight", or a black canvas because the exception
 * unwound past the renderer — is the failure mode this class exists to prevent.
 */
export class Game implements GameContext {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;

  time = 0;
  dt = 0;
  frame = 0;
  mapSeed = 1337;

  readonly sunDir = new THREE.Vector3(-0.45, -0.62, -0.64).normalize();
  readonly sunColor = new THREE.Color(1.0, 0.94, 0.82);
  sunIntensity = 3.1;
  readonly ambientColor = new THREE.Color(0.42, 0.55, 0.72);
  timeOfDay = 9.5;

  readonly entities = new Map<number, EntityState>();
  localEntityId = 0;
  localPlayerId = 0;
  localTeam = 0;

  readonly bus = new EventBus();
  quality: QualityTier = 'high';
  readonly settings: Settings = { ...DEFAULT_SETTINGS };

  readonly stats: FrameStats = {
    fps: 0, frameMs: 0, quality: 'high',
    drawCalls: 0, triangles: 0, programs: 0, geometries: 0, textures: 0, frame: 0,
  };

  /** Subsystems dropped during boot. Surfaced to the harness and the console. */
  readonly failedSubsystems: SubsystemFailure[] = [];

  private subsystems: Subsystem[] = [];
  private byName = new Map<string, Subsystem>();
  private running = false;
  private lastTime = 0;
  private rafId = 0;
  private readonly container: HTMLElement;

  /** Consecutive throws per subsystem name, used to retire a broken update. */
  private strikes = new Map<string, number>();
  private disabled = new Set<string>();

  /** Rolling frame-time average used by the adaptive quality governor. */
  private frameMs = 16.7;
  private governorCooldown = 0;

  constructor(container: HTMLElement) {
    this.container = container;

    const canvas = document.createElement('canvas');
    container.appendChild(canvas);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,          // we resolve edges ourselves in the composer
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping; // cel grading handles this
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = false;

    // three resets 'info.render' at the top of every 'render()' call, so with a
    // multi-pass composer the counters only ever describe the final fullscreen
    // quad — reading them gives "1 draw call, 1 triangle", which is what the
    // harness used to report. Take ownership of the reset instead and clear it
    // once per frame, so the numbers cover the entire frame graph.
    this.renderer.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(
      this.settings.fov,
      container.clientWidth / Math.max(1, container.clientHeight),
      0.35,
      120000,
    );
    this.camera.position.set(0, 1200, 0);

    this.scene.background = new THREE.Color(0x8fc4e8);

    addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  register(sys: Subsystem): this {
    if (this.byName.has(sys.name)) throw new Error(`duplicate subsystem "${sys.name}"`);
    this.subsystems.push(sys);
    this.byName.set(sys.name, sys);
    return this;
  }

  get<T extends Subsystem>(name: string): T | undefined {
    return this.byName.get(name) as T | undefined;
  }

  /**
   * Initialises every subsystem in registration order.
   *
   * Failures are contained: a subsystem that throws, rejects, or simply never
   * settles is unregistered and the boot continues without it. That is the
   * difference between "the game is missing its audio" and "the loading screen
   * hangs forever", and only one of those is shippable.
   */
  async init(onProgress?: (frac: number, msg: string) => void): Promise<void> {
    const survivors: Subsystem[] = [];
    const total = this.subsystems.length;

    for (let i = 0; i < total; i++) {
      const s = this.subsystems[i];
      onProgress?.(i / total, s.name);
      try {
        await withTimeout(() => s.init(this), INIT_TIMEOUT_MS);
        survivors.push(s);
      } catch (err) {
        const msg = errorText(err);
        // Loud on purpose: a silently missing subsystem is a bug that gets
        // diagnosed as "the art looks wrong" three hours later.
        console.error(
          `%c[game] subsystem "${s.name}" failed to initialise — SKIPPING IT.`,
          'color:#ff6b6b;font-weight:bold', err,
        );
        this.failedSubsystems.push({ name: s.name, error: msg });
        this.byName.delete(s.name);
        // Give it a chance to release whatever it did manage to allocate.
        try { s.dispose?.(); } catch { /* already broken; nothing to do */ }
      }
    }

    this.subsystems = survivors;
    onProgress?.(1, this.failedSubsystems.length ? 'ready (degraded)' : 'ready');
    this.onResize();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private loop = (): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    const now = performance.now();
    // Clamp to avoid physics explosions after a tab stall.
    const rawDt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    this.dt = Math.min(rawDt, 0.1);
    this.time += this.dt;
    this.frame++;

    // Exponential moving average over ~30 frames. Measured from wall time, so
    // it reflects what the display actually did, including vsync.
    const rawMs = Math.min(1000, rawDt * 1000);
    if (this.frame < 3) this.frameMs = rawMs || 16.7;
    else this.frameMs += (rawMs - this.frameMs) * 0.07;

    // Counters accumulate across every pass of this frame (see the constructor).
    this.renderer.info.reset();

    for (const s of this.subsystems) this.safeCall(s, 'update');
    for (const s of this.subsystems) this.safeCall(s, 'lateUpdate');

    this.sampleStats();
    this.governor();
  };

  private safeCall(s: Subsystem, hook: 'update' | 'lateUpdate'): void {
    const fn = s[hook];
    if (!fn || this.disabled.has(s.name)) return;
    try {
      fn.call(s, this);
      if (this.strikes.get(s.name)) this.strikes.set(s.name, 0);
    } catch (err) {
      // An exception here used to unwind the whole loop, which meant one bad
      // subsystem took the renderer down with it and the canvas froze. Contain
      // it, and retire a subsystem that is throwing every single frame rather
      // than spamming the console at 60 Hz forever.
      const n = (this.strikes.get(s.name) ?? 0) + 1;
      this.strikes.set(s.name, n);
      if (n <= 3 || n === UPDATE_STRIKES) {
        console.error(`[game] "${s.name}".${hook} threw (${n}/${UPDATE_STRIKES})`, err);
      }
      if (n >= UPDATE_STRIKES) {
        console.error(`%c[game] disabling subsystem "${s.name}" — it throws every frame.`,
          'color:#ff6b6b;font-weight:bold');
        this.disabled.add(s.name);
        this.failedSubsystems.push({ name: s.name, error: `${hook}: ${errorText(err)}` });
      }
    }
  }

  private sampleStats(): void {
    const r = this.renderer.info;
    const st = this.stats;
    st.frameMs = this.frameMs;
    st.fps = this.frameMs > 0 ? 1000 / this.frameMs : 0;
    st.quality = this.quality;
    st.drawCalls = r.render.calls;
    st.triangles = r.render.triangles;
    st.programs = r.programs?.length ?? 0;
    st.geometries = r.memory.geometries;
    st.textures = r.memory.textures;
    st.frame = this.frame;
  }

  /**
   * Adaptive quality: if we sit under budget for a while, step up; if we blow
   * the budget, step down immediately. Keeps 60 fps on mid-range hardware
   * without the player touching settings.
   */
  private governor(): void {
    this.governorCooldown -= this.dt;
    if (this.governorCooldown > 0) return;

    const tiers: QualityTier[] = ['low', 'medium', 'high', 'ultra'];
    const i = tiers.indexOf(this.quality);
    if (this.frameMs > 22 && i > 0) {
      this.quality = tiers[i - 1];
      this.bus.emit('quality', this.quality);
      this.governorCooldown = 3;
    } else if (this.frameMs < 12.5 && i < tiers.length - 1) {
      this.quality = tiers[i + 1];
      this.bus.emit('quality', this.quality);
      this.governorCooldown = 6;
    } else {
      this.governorCooldown = 1;
    }
  }

  private onResize = (): void => {
    const w = this.container.clientWidth || innerWidth;
    const h = this.container.clientHeight || innerHeight;
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    for (const s of this.subsystems) {
      try { s.resize?.(w, h); } catch (err) { console.error(`[game] "${s.name}".resize threw`, err); }
    }
  };

  private onVisibility = (): void => {
    // Reset the clock so returning to the tab doesn't produce a giant dt.
    if (!document.hidden) this.lastTime = performance.now();
  };

  dispose(): void {
    this.stop();
    removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const s of this.subsystems) {
      try { s.dispose?.(); } catch (err) { console.error(`[game] "${s.name}".dispose threw`, err); }
    }
    this.renderer.dispose();
    this.bus.clear();
  }
}

/**
 * Runs 'fn' and rejects if it has not settled within 'ms'.
 *
 * A synchronous throw is converted to a rejection so both failure shapes take
 * the same path. Note that a timed-out subsystem is *abandoned*, not cancelled —
 * there is no way to cancel a promise — but it has been unregistered by then,
 * so it can no longer be updated or found by another subsystem.
 */
function withTimeout(fn: () => void | Promise<void>, ms: number): Promise<void> {
  let result: void | Promise<void>;
  try {
    result = fn();
  } catch (err) {
    return Promise.reject(err);
  }
  if (!result || typeof (result as Promise<void>).then !== 'function') return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`init timed out after ${ms} ms`)),
      ms,
    );
    (result as Promise<void>).then(
      () => { clearTimeout(timer); resolve(); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}
