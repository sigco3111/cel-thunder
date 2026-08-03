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

  // --- frame pacing ----------------------------------------------------------
  private prevRawMs = 16.7;
  /**
   * Fraction of recent frames paced differently from their predecessor — the
   * actual signal behind "micro-stutter", and the one thing the old governor
   * could not see.
   *
   * It compared a *smoothed* frame time against fixed millisecond thresholds
   * (down above 22 ms, up below 12.5). That cannot detect a frame graph
   * alternating between one and two refresh intervals, which is what a GPU
   * sitting just over budget actually produces: at 120 Hz a 10 ms frame
   * renders as 8.3, 16.6, 8.3, 16.6 — an 89 fps average that reads as
   * constant judder, whose 12.5 ms mean sits in the old dead band forever, so
   * the governor parked on 'ultra' and never moved again. At 60 Hz the
   * identical failure lands on 16.7/33.3 for a "53 fps" average.
   *
   * The test is deliberately **scale-free** — a proportional difference, not
   * an absolute one — so it needs no estimate of the display's refresh rate
   * (which the browser will not report, and which cannot be recovered from a
   * running minimum: one freak short frame after a stall drags a minimum to
   * the floor and never lets go). It reads zero for a frame rate locked to
   * *any* rate, which is correct, because a locked 60 feels perfect.
   */
  private pacingMiss = 0;
  /** Index into PERF_LADDER — the single monotonic cost knob. */
  private rung = 1;
  /** Render on every Nth refresh. 1 = every one. See PERF_LADDER. */
  private presentEvery = 1;
  private presentPhase = 0;
  /**
   * Measured display refresh, Hz. Taken from the median of the first second of
   * frame intervals rather than assumed, because the half-rate rungs are only
   * safe above ~100 Hz and guessing wrong halves a 60 Hz display to 30.
   */
  private refreshHz = 60;
  private refreshSamples: number[] = [];
  /** Seconds of clean pacing required before trying the next rung up. */
  private stepUpDelay = INITIAL_STEP_UP_DELAY;
  /** Seconds of clean pacing accumulated so far. */
  private cleanFor = 0;
  /** Seconds of unstable pacing accumulated so far. */
  private unstableFor = 0;
  /** ctx.time of the last step *up*, so an undone climb can be told from a descent. */
  private lastClimbAt = -1e9;
  /**
   * When each rung last proved itself unable to hold cadence.
   *
   * Without this the governor hunts: scene cost swings by tens of per cent as
   * the aeroplane crosses a cloud bank or the furball, so a rung looks clean,
   * gets climbed into, immediately fails, and gets dropped again — measured,
   * seven changes in twenty-eight seconds. Every one of those reallocates the
   * composer's render targets, so the hunting *is* the stutter. Remembering
   * that a rung has already been tried and failed makes the search converge
   * instead of cycling.
   */
  private rungFailedAt: number[] = [];

  /**
   * Opt-in per-subsystem CPU profiler (?profile=1).
   *
   * Off by default and costing one boolean test per frame when off, because
   * 'performance.now()' twice per subsystem per hook is 22 calls a frame and
   * that is not free. On, it fills a ring the smoothness harness reads to
   * attribute a slow frame to the system that actually caused it — guessing
   * which of eleven subsystems spiked is exactly how frame-pacing bugs survive
   * for months.
   */
  profiling = false;
  readonly profile: {
    names: string[];
    /** Ring of [frameMs, ...perSubsystemMs] rows, newest last. */
    rows: number[][];
    cap: number;
  } = { names: [], rows: [], cap: 1200 };
  private profRow: number[] = [];

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

    try {
      this.profiling = new URLSearchParams(location.search).has('profile');
    } catch { /* no location (worker/test) — stay off */ }
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
    // Make the live state agree with the starting rung. Without this the
    // governor believes it is on rung 1 while the renderer is configured for
    // whatever the field initialisers happened to say, and the first thing the
    // player sees is a configuration nothing chose.
    this.applyRung();
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

    // Half-rate presentation: skip the callback entirely rather than doing the
    // work and discarding it. Simulation is not skipped — dt simply covers two
    // refreshes, which the fixed-step accumulator and the interpolating netcode
    // both already handle. Skipping before the clock is read keeps 'dt' honest.
    if (this.presentEvery > 1) {
      this.presentPhase = (this.presentPhase + 1) % this.presentEvery;
      if (this.presentPhase !== 0) return;
    }

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
    this.trackPacing(rawMs);

    // Establish the display's refresh rate before the governor is allowed to
    // consider a half-rate rung. Sampled while presentEvery is still 1, and the
    // median rejects the compile stalls that pollute the first second.
    if (this.presentEvery === 1 && this.refreshSamples.length < 90 && this.frame > 10) {
      this.refreshSamples.push(rawMs);
      if (this.refreshSamples.length === 90) {
        const sorted = this.refreshSamples.slice().sort((a, b) => a - b);
        const median = sorted[45];
        if (median > 1) this.refreshHz = Math.round(1000 / median);
        // The rung was chosen before the refresh rate was known, so a half-rate
        // rung could not take effect. Re-apply it now that it can.
        this.applyRung();
      }
    }

    // Counters accumulate across every pass of this frame (see the constructor).
    this.renderer.info.reset();

    if (this.profiling) {
      this.profileFrame(rawMs);
    } else {
      for (const s of this.subsystems) this.safeCall(s, 'update');
      for (const s of this.subsystems) this.safeCall(s, 'lateUpdate');
    }

    this.sampleStats();
    this.governor();
  };

  /** Timed variant of the update sweep. See 'profiling'. */
  private profileFrame(rawMs: number): void {
    const p = this.profile;
    if (p.names.length !== this.subsystems.length * 2) {
      p.names = [
        ...this.subsystems.map((s) => `${s.name}.u`),
        ...this.subsystems.map((s) => `${s.name}.l`),
      ];
      p.rows.length = 0;
    }
    const row = this.profRow.length === p.names.length + 1
      ? this.profRow : (this.profRow = new Array(p.names.length + 1).fill(0));
    row[0] = rawMs;
    const n = this.subsystems.length;
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      this.safeCall(this.subsystems[i], 'update');
      row[1 + i] = performance.now() - t;
    }
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      this.safeCall(this.subsystems[i], 'lateUpdate');
      row[1 + n + i] = performance.now() - t;
    }
    if (p.rows.length >= p.cap) p.rows.shift();
    p.rows.push(row.slice());
  }

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

  /** Maintains the pacing-instability signal. See 'pacingMiss'. */
  private trackPacing(rawMs: number): void {
    const a = rawMs;
    const b = this.prevRawMs;
    this.prevRawMs = a;
    // Proportional, so it means the same thing on a 60 and a 144 Hz panel:
    // a step of 40 % between neighbouring frames is a dropped vsync, whereas
    // ordinary frame-to-frame noise on a locked cadence is a few per cent.
    const off = Math.abs(a - b) > 0.4 * Math.min(a, b) ? 1 : 0;
    // ~30-frame memory: long enough not to fire on one hiccup, short enough
    // that the governor can react inside a second.
    this.pacingMiss += (off - this.pacingMiss) * 0.035;
  }

  /**
   * Adaptive quality, tuned for *consistency* rather than for an average.
   *
   * Cost is a single monotonic ladder (PERF_LADDER) rather than two
   * independent knobs, so "one step cheaper" is always well defined and the
   * governor cannot walk sideways into a more expensive configuration — which
   * is exactly what a tier drop that also restored the render scale used to do.
   *
   * Direction is decided by pacing, not by frame rate:
   *
   *  - unstable -> the frame straddles a vsync boundary and the player is
   *    seeing judder. Step down. This is urgent; converge quickly.
   *  - clean for a sustained stretch -> try one step up.
   *  - anything else -> hold.
   *
   * The required clean stretch **doubles every time a step up is undone**, so
   * a machine that sits right on a boundary settles instead of yo-yoing
   * between two tiers forever. Yo-yoing is worse than either endpoint: each
   * change reallocates render targets and re-specialises shader programs, so
   * an indecisive governor manufactures the very hitches it exists to prevent.
   */
  private governor(): void {
    this.governorCooldown -= this.dt;
    // Let boot and the first shader compiles clear before believing anything.
    if (this.frame < 150) { this.cleanFor = 0; this.unstableFor = 0; return; }

    const bad = this.pacingMiss > 0.16 || this.frameMs > 40;
    const clean = this.pacingMiss < 0.05;
    this.cleanFor = clean ? this.cleanFor + this.dt : 0;
    this.unstableFor = bad ? this.unstableFor + this.dt : 0;
    // Spend quality only on a problem that has persisted. Scene cost swings by
    // tens of per cent as the aeroplane flies past a cloud bank or into the
    // middle of the furball, and a governor that reacts to a 30-frame average
    // chases those transients all the way to the bottom of the ladder and is
    // still there long after the view has cleared. Something genuinely broken
    // (half the frames off-cadence) still gets an immediate response.
    const unstable = this.unstableFor > 1.5 || this.pacingMiss > 0.5;

    if (this.governorCooldown > 0) return;

    if (unstable && this.rung < PERF_LADDER.length - 1) {
      this.rungFailedAt[this.rung] = this.time;
      this.rung++;
      // Only a step down that *undoes a recent climb* is evidence of
      // indecision. Penalising the initial descent as well — which an earlier
      // version did — drove the backoff to its ceiling before the governor had
      // found its level even once, and it then never climbed back.
      if (this.time - this.lastClimbAt < UNDO_WINDOW) {
        this.stepUpDelay = Math.min(MAX_STEP_UP_DELAY, this.stepUpDelay * 2);
      }
      this.applyRung();
      this.governorCooldown = this.pacingMiss > 0.4 ? 1.2 : 2.0;
      return;
    }

    if (this.rung > 0 && this.cleanFor >= this.stepUpDelay) {
      // Do not climb back into something already known not to work. The
      // quarantine expires so a genuinely transient load (one long furball, a
      // storm cell) does not cost image quality for the rest of the match.
      const failedAt = this.rungFailedAt[this.rung - 1];
      if (failedAt !== undefined && this.time - failedAt < RUNG_QUARANTINE) {
        this.governorCooldown = 2;
        this.cleanFor = 0;
        return;
      }
      this.rung--;
      this.lastClimbAt = this.time;
      this.applyRung();
      this.governorCooldown = 1.5;
      return;
    }

    this.governorCooldown = 0.5;
  }

  private applyRung(): void {
    const r = PERF_LADDER[this.rung];
    this.presentEvery = r.present > 1 && this.refreshHz >= MIN_HZ_FOR_HALF_RATE ? r.present : 1;
    this.presentPhase = 0;
    this.settings.renderScale = r.scale;
    if (this.quality !== r.tier) {
      this.quality = r.tier;
      this.bus.emit('quality', this.quality);
    }
    // Judge the new configuration on its own evidence. Carrying the old EMA
    // across a change made every step down look as bad as the one before it
    // for another half second, which is how the governor used to overshoot
    // several rungs past the one that had already fixed the problem.
    this.pacingMiss = 0;
    this.cleanFor = 0;
    this.unstableFor = 0;
  }

  /**
   * Live pacing numbers, for the HUD overlay and the smoothness harness.
   * 'missRate' near zero is the goal; the average frame rate is not.
   */
  get pacing(): {
    missRate: number; rung: number; renderScale: number; stepUpDelay: number;
    presentEvery: number; refreshHz: number; quality: QualityTier;
  } {
    return {
      missRate: this.pacingMiss,
      rung: this.rung,
      renderScale: this.settings.renderScale,
      stepUpDelay: this.stepUpDelay,
      presentEvery: this.presentEvery,
      refreshHz: this.refreshHz,
      quality: this.quality,
    };
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

/**
 * The single cost ladder, most expensive first. The governor only ever moves
 * one step along it, so cost is monotonic by construction.
 *
 * **Tier first, resolution only at the bottom.** Changing the internal
 * resolution reallocates a dozen half-float render targets, which measures at
 * about 50 ms — a worse hitch than the judder being corrected, and it lands
 * during the first seconds of play when the governor is still searching. A tier
 * change costs nothing by comparison, because 'RenderSystem' compiles every
 * tier's shader variants at boot, so the change is a program-cache hit.
 *
 * So the tiers are walked first and cover most of the range on their own
 * (measured at 1080p: ultra 14.6 ms, high 13.7, medium 10.8, low 8.3). Only a
 * machine that still cannot hold cadence at 'low' — where there is no tier left
 * to give up — pays for a reallocation, and then at most twice.
 */
/**
 * The cost ladder, most expensive first.
 *
 * 'present' is a vsync divisor: 2 means render on every second refresh, which
 * halves the per-second GPU cost while leaving every frame landing exactly on a
 * vsync boundary — so it is *perfectly* paced, not merely fast.
 *
 * The half-rate rungs sit ABOVE the tier drops deliberately. On a 120 Hz panel
 * the governor used to hold cadence by walking ultra -> high -> medium -> low,
 * which buys 120 fps at the cost of SSAO, depth of field and motion blur. For
 * this game that is the wrong trade: it is a stylised renderer whose whole
 * point is the image, and a locked 60 with the full composer looks far better
 * than an unlocked 120 without it. Both are equally smooth — a locked 60 has
 * zero pacing error by construction.
 *
 * The divisor is only offered when the display can actually take it (see
 * 'refreshHz'): halving 60 Hz gives 30, which is worse than any tier drop.
 */
const PERF_LADDER: ReadonlyArray<{ tier: QualityTier; scale: number; present: number }> = [
  { tier: 'ultra', scale: 1.00, present: 1 },
  { tier: 'ultra', scale: 1.00, present: 2 },
  { tier: 'high', scale: 1.00, present: 2 },
  { tier: 'high', scale: 1.00, present: 1 },
  { tier: 'medium', scale: 1.00, present: 1 },
  { tier: 'low', scale: 1.00, present: 1 },
  { tier: 'low', scale: 0.85, present: 1 },
  { tier: 'low', scale: 0.72, present: 1 },
];

/** Below this refresh rate, halving the presentation rate is not an option. */
const MIN_HZ_FOR_HALF_RATE = 100;

/** Clean seconds required before the first attempt to climb the ladder. */
const INITIAL_STEP_UP_DELAY = 6;
/** Ceiling on the backoff, so a machine can still recover after a long fight. */
const MAX_STEP_UP_DELAY = 60;
/** A step down within this long of a step up counts as undoing it. */
const UNDO_WINDOW = 30;
/** How long a rung stays quarantined after it failed to hold cadence. */
const RUNG_QUARANTINE = 75;

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}
