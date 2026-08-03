/**
 * The audio subsystem: everything you hear, synthesised at runtime.
 *
 * This file is the integration layer. It owns the mixer graph, decides which of
 * the dozens of possible sound sources are worth spending voices on this frame,
 * derives the listener from the camera, and translates replicated game events
 * into synthesis calls. The synthesis itself lives in the modules beside it.
 *
 * Design notes that matter to whoever integrates this:
 *
 *  - **Nothing here can throw.** Every public entry point checks for a null
 *    graph first, and the graph is null on any platform without WebAudio. A
 *    machine with no sound card renders the game silently and identically.
 *  - **The context starts suspended** and resumes on the first user gesture,
 *    per the autoplay policy. Sounds requested before that are simply dropped;
 *    persistent layers start themselves once the context is running.
 *  - **The listener follows the camera**, not the aircraft, because the camera
 *    is where the player's viewpoint actually is. Cockpit occlusion is inferred
 *    from the camera being inside the local aircraft, and can be overridden by
 *    the camera subsystem with 'setCockpit'.
 *  - **Voices are budgeted, not unlimited.** See VoicePool. Engines beyond the
 *    per-tier budget are culled by distance with hysteresis, so a dogfight
 *    sounds like six aeroplanes rather than a swarm.
 */

import type { GameContext, QualityTier, Subsystem } from '../engine/context';
import { DamageBits, EntityKind, EventKind, type EntityState } from '../shared/protocol';
import { aircraftByIndex, type AircraftSpec, type GunSpec } from '../shared/aircraft';
import { clamp, q, qrotInv, qrot, v3, type Q, type V3 } from '../shared/math';

import { AudioGraph } from './AudioGraph';
import { applyListener, newListenerState, type ListenerState } from './SpatialSource';
import { EngineVoice, type EngineDetail, type EngineInput } from './EngineVoice';
import { Airflow, type AirflowInput } from './Airflow';
import { GunEmitter, impactOwn, impactRemote, nearMiss, singleShot, terrainImpact } from './Weapons';
import { explosion, structureFail, thunder, type BlastKind } from './Explosions';
import { Music } from './Music';
import { Radio, type CalloutKind } from './Radio';
import * as Ui from './Ui';
import { indicatedAirspeed } from './dsp';

// Module-level scratch — nothing in the per-frame path allocates.
const _q: Q = q();
const _v: V3 = v3();
const _out: V3 = v3();
const _fwd: V3 = v3();
const _up: V3 = v3();
const FORWARD: V3 = { x: 0, y: 0, z: -1 };
const UP: V3 = { x: 0, y: 1, z: 0 };

/** Per-frame input records, mutated in place — see brief rule 5. */
const _engineIn: EngineInput = { rpm: 0, throttle: 0, ias: 0, damage: 0, health: 1 };
const _airIn: AirflowInput = {
  ias: 0, vne: 200, vertical: 0, alpha: 0, stallAlpha: 0.3,
  gear: 0, flaps: 0, airbrake: 0, interior: false, active: false,
  listenerDistance: 0,
};

export interface PlayOptions {
  x?: number; y?: number; z?: number;
  vx?: number; vy?: number; vz?: number;
  /** Linear level multiplier. */
  volume?: number;
  /** Event magnitude (explosions), 1 = a fighter blowing up. */
  scale?: number;
  /** Projectile calibre in mm, for gun and impact sounds. */
  calibre?: number;
  /** True for armour hits (lower, longer, no penetration). */
  armour?: boolean;
  /** Override the automatic interior/exterior variant. */
  interior?: boolean;
  /** Radio callout text, forwarded to the HUD on the 'radio:callout' bus event. */
  text?: string;
  kind?: CalloutKind;
  /** Servo travel time, seconds. */
  duration?: number;
}

export type SoundName =
  | 'ui:click' | 'ui:hover' | 'ui:confirm' | 'ui:back' | 'ui:error'
  | 'hit:marker' | 'kill:confirm'
  | 'impact:own' | 'impact:remote'
  | 'nearmiss'
  | 'explosion' | 'explosion:ground' | 'explosion:water' | 'structure:fail'
  | 'gear:down' | 'gear:up' | 'flaps:down' | 'flaps:up'
  | 'canopy:open' | 'canopy:jettison'
  | 'engine:start' | 'engine:stop'
  | 'warn:low' | 'warn:high'
  | 'bailout' | 'stress'
  | 'radio:blip' | 'radio:static'
  | 'gun:shot' | 'blip';

/** How long an explicit 'setListener' call suppresses camera tracking. */
const EXTERNAL_LISTENER_HOLD = 0.4;

/**
 * Minimum spacing between coalesced bullet-on-terrain slaps, seconds. Below
 * about 60 ms consecutive impacts fuse perceptually anyway, so spending a voice
 * on each one buys nothing but voice-pool pressure.
 */
const TERRAIN_IMPACT_GAP = 0.070;

/**
 * Minimum spacing between supersonic near-miss cracks, seconds. Even with
 * correct ownership filtering a burst from an enemy at convergence delivers a
 * dozen rounds through the same 30 m sphere; the crack is only frightening
 * while it is rare.
 */
const NEAR_MISS_GAP = 0.11;

export class AudioSystem implements Subsystem {
  readonly name = 'audio';

  private graph: AudioGraph | null = null;
  private ctx!: GameContext;

  private readonly listener: ListenerState = newListenerState();
  private airflow: Airflow | null = null;
  private music: Music | null = null;
  private radio: Radio | null = null;

  private readonly engines = new Map<number, EngineVoice>();
  private readonly pinned = new Set<number>();
  private readonly guns = new Map<string, GunEmitter>();

  /** Closest-approach tracking for near-miss cracks. */
  private readonly projDist = new Map<number, number>();
  private readonly projFired = new Set<number>();

  private readonly unsub: Array<() => void> = [];

  // engine ranking scratch (reused every frame)
  private readonly candId: number[] = [];
  private readonly candDist: number[] = [];
  private candN = 0;

  private cockpitOverride: boolean | null = null;
  private externalListenerUntil = -1;
  private lastVolume = -1;
  private havePrevPos = false;
  private prevPx = 0; private prevPy = 0; private prevPz = 0;
  private prevGear = -1;
  private prevFlaps = -1;
  private prevDamage = 0;
  private spawned = false;
  private pruneCounter = 0;

  /** Coalescing state for bullets striking terrain (see onTerrainImpact). */
  private terrainAt = -1;
  private terrainPending = 0;
  private terrainX = 0; private terrainY = 0; private terrainZ = 0;
  private terrainCal = 12.7;
  private terrainWater = false;

  /** Near-miss rate limiting (see updateProjectiles). */
  private nearMissAt = -1;
  private nearMissThisFrame = 0;

  /** Local pilot's killfeed name; the offline sandbox always calls them 'You'. */
  private localName = 'You';

  // -------------------------------------------------------------------------
  // Subsystem
  // -------------------------------------------------------------------------

  init(ctx: GameContext): void {
    this.ctx = ctx;
    const g = AudioGraph.create();
    this.graph = g;
    if (!g) {
      console.warn('[audio] WebAudio unavailable — running silent');
      return;
    }

    try {
      g.prewarm();
      g.setQuality(ctx.quality);
      g.setMasterVolume(ctx.settings.masterVolume);
      this.lastVolume = ctx.settings.masterVolume;

      this.airflow = new Airflow(g);
      this.music = new Music(g);
      this.radio = new Radio(g);
      // Menu music plays until the player is in an aeroplane.
      this.music.setPlaying(true);
    } catch (err) {
      console.warn('[audio] init failed, continuing silent:', err);
      this.graph = null;
      return;
    }

    const on = (evt: string, fn: (p: unknown) => void) => this.unsub.push(ctx.bus.on(evt, fn));
    on('quality', (p) => this.graph?.setQuality(p as QualityTier));
    on('game:event', (p) => this.onGameEvent(p as GameEventPayload));
    on('net:spawned', () => this.onSpawned());
    on('net:welcome', () => this.radio?.blip('command', 0.9));
    on('net:kill', (p) => this.onNetKill(p));
    // The killfeed identifies players by *name* (KillfeedMsg), so learn ours
    // from the roster. Offline the sandbox calls the local pilot 'You'
    // (OfflineSandbox.nameFor), which is the default below.
    on('net:match', (p) => {
      const list = (p as { players?: { id: number; name: string }[] } | null)?.players;
      if (!list) return;
      for (const pl of list) if (pl.id === ctx.localPlayerId) { this.localName = pl.name; return; }
    });
    on('net:chat', () => this.radio?.blip('friendly', 0.7));
    on('net:offline', () => this.radio?.interference(0.7));
    on('net:disconnected', () => this.radio?.interference(1));
    // src/ui/store.ts:249 publishes all four sliders here. Only masterVolume
    // was being read (through ctx.settings), so effects/engine/ui were inert.
    on('audio:volumes', (p) => this.onVolumes(p as Partial<VolumeSettings>));
    // CameraSystem already broadcasts this (CameraSystem.ts:242/260/276); the
    // 2.8 m proximity sphere below is only a pre-first-event fallback now.
    on('camera:mode', (p) => this.onCameraMode(p));
    // Weather. Both channels already have a producer in SkySystem, and flying
    // through a storm being acoustically identical to clear air is the kind of
    // gap a player notices in the first minute.
    on('sky:inCloud', (p) => {
      const c = p as { inside?: boolean; density?: number } | null;
      this.graph?.setInCloud(!!c?.inside, c?.density ?? 1);
    });
    on('sky:lightning', (p) => this.onLightning(p));
  }

  private onLightning(p: unknown): void {
    const g = this.graph;
    if (!g) return;
    const b = p as { x?: number; y?: number; z?: number; distance?: number; intensity?: number } | null;
    if (!b) return;
    thunder(
      g, this.listener,
      b.x ?? this.listener.px, b.y ?? this.listener.py, b.z ?? this.listener.pz,
      b.distance ?? 5000, b.intensity ?? 1,
    );
  }

  /**
   * Interior/exterior from the camera rig rather than from proximity. The
   * proximity heuristic misfires on anything that flies close to your own hull
   * — an orbit zoom-in, a spawn snap, a kill-cam pass — by flipping the whole
   * world mix into canopy occlusion for a few frames.
   */
  private onCameraMode(p: unknown): void {
    const mode = typeof p === 'string' ? p : (p as { mode?: string } | null)?.mode;
    if (!mode) return;
    this.cockpitOverride = mode === 'cockpit' || mode === 'gunsight';
  }

  private onVolumes(v: Partial<VolumeSettings> | null): void {
    const g = this.graph;
    if (!g || !v) return;
    const clamp01 = (x: unknown, d: number) =>
      typeof x === 'number' && Number.isFinite(x) ? clamp(x, 0, 1) : d;
    // 'effects' is everything that happens in the world and is not an engine;
    // 'ui' covers the interface *and* the radio, because both are things the
    // player hears at the ear rather than in the world.
    const fx = clamp01(v.effects, 1);
    g.setBusTrim('weapon', fx);
    g.setBusTrim('env', fx);
    g.setBusTrim('cockpit', fx);
    g.setBusTrim('engine', clamp01(v.engine, 1));
    const ui = clamp01(v.ui, 1);
    g.setBusTrim('ui', ui);
    g.setBusTrim('voice', ui);
    if (typeof v.master === 'number' && Number.isFinite(v.master)) {
      this.lastVolume = clamp(v.master, 0, 1);
      g.setMasterVolume(this.lastVolume);
    }
  }

  /**
   * Kill confirmation. EventKind.Kill is never pushed by any emitter in the
   * repo, so the two-note fifth — one of the most audible pieces of feedback in
   * the mix — could only ever have played from an event that does not exist.
   * The 'net:kill' bus message is what actually fires.
   */
  private onNetKill(p: unknown): void {
    const g = this.graph;
    if (!g) return;
    const k = p as { killer?: string; victim?: string } | null;
    if (k && k.killer && k.killer === this.localName) {
      Ui.killConfirm(g);
      this.radio?.blip('kill', 0.9);
    } else if (k && k.victim && k.victim === this.localName) {
      this.radio?.blip('warning', 0.9);
    } else {
      this.radio?.blip('enemy', 0.8);
    }
  }

  update(ctx: GameContext): void {
    const g = this.graph;
    if (!g) return;
    try {
      if (ctx.settings.masterVolume !== this.lastVolume) {
        this.lastVolume = ctx.settings.masterVolume;
        g.setMasterVolume(this.lastVolume);
      }

      g.pool.enabled = g.running;
      this.updateListener(ctx);
      g.setInterior(this.listener.interior);

      this.updateEngines(ctx);
      this.updateGuns(ctx);
      this.updateLocalAircraft(ctx);
      this.updateProjectiles(ctx);
      // Being in an aeroplane is the condition that kills the score, not the
      // spawn message: reconnects and spectator handoffs skip that event.
      const flying = ctx.localEntityId !== 0 && ctx.entities.has(ctx.localEntityId);
      if (flying !== this.spawned) {
        this.spawned = flying;
        this.music?.setPlaying(!flying);
        g.setMusicDuck(flying ? 0 : 1, flying ? 1.2 : 2.5);
      }
      this.music?.update();
      g.pool.reap(g.now);
    } catch (err) {
      // Audio must never take a frame down. Log once per second at most.
      if ((ctx.frame & 63) === 0) console.warn('[audio] update error', err);
    }
  }

  dispose(): void {
    for (const u of this.unsub) { try { u(); } catch { /* ignore */ } }
    this.unsub.length = 0;
    for (const e of this.engines.values()) e.stop(0.05);
    this.engines.clear();
    for (const gun of this.guns.values()) gun.stop(0.03);
    this.guns.clear();
    this.airflow?.dispose();
    this.music?.dispose();
    this.radio?.dispose();
    this.graph?.dispose();
    this.graph = null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Resolves once the AudioContext is actually running (or immediately). */
  resume(): Promise<boolean> {
    return this.graph ? this.graph.resume() : Promise.resolve(false);
  }

  get available(): boolean { return this.graph !== null; }
  get running(): boolean { return this.graph?.running ?? false; }
  /** 0..1 — how hard the wing is buffeting. Useful for a synced HUD warning. */
  get stallLevel(): number { return this.airflow?.stallLevel ?? 0; }
  /** True between spawn and death — the state that ducks the menu score out. */
  get inFlight(): boolean { return this.spawned; }

  /**
   * Place the listener explicitly. Overrides camera tracking for the next
   * ~0.4 s, so a camera subsystem can call it every frame and own the listener
   * outright, or call it once for a cutscene without getting stuck.
   *
   * 'quat' follows the three.js camera convention: −Z is forward, +Y is up.
   */
  setListener(
    pos: { x: number; y: number; z: number },
    quat: { x: number; y: number; z: number; w: number },
    vel?: { x: number; y: number; z: number },
  ): void {
    const g = this.graph;
    if (!g) return;
    const l = this.listener;
    l.px = pos.x; l.py = pos.y; l.pz = pos.z;
    _q.x = quat.x; _q.y = quat.y; _q.z = quat.z; _q.w = quat.w;
    qrot(_q, FORWARD, _fwd);
    qrot(_q, UP, _up);
    l.fx = _fwd.x; l.fy = _fwd.y; l.fz = _fwd.z;
    l.ux = _up.x; l.uy = _up.y; l.uz = _up.z;
    if (vel) { l.vx = vel.x; l.vy = vel.y; l.vz = vel.z; }
    this.externalListenerUntil = this.ctx ? this.ctx.time + EXTERNAL_LISTENER_HOLD : 0;
    applyListener(g.ac, l, 0.02);
  }

  /**
   * Force an engine voice for this entity regardless of the distance budget.
   * Used for cinematic cameras and for the aircraft the player is spectating.
   */
  attachEngine(entityId: number): void {
    if (!this.graph || entityId <= 0) return;
    this.pinned.add(entityId);
  }

  /** Release a pinned engine; it reverts to normal distance culling. */
  detachEngine(entityId: number): void {
    if (!this.graph) return;
    this.pinned.delete(entityId);
    const v = this.engines.get(entityId);
    if (v) { v.stop(0.25); this.engines.delete(entityId); }
  }

  /** Override cockpit occlusion. Pass null to return to automatic detection. */
  setCockpit(inside: boolean | null): void {
    this.cockpitOverride = inside;
  }

  /**
   * Fire a radio callout: the diegetic blip plus a 'radio:callout' bus event
   * carrying the text for the HUD to display.
   */
  radioCallout(text: string, kind: CalloutKind = 'friendly'): void {
    this.radio?.blip(kind, 1);
    this.ctx?.bus.emit('radio:callout', { text, kind });
  }

  /**
   * Play a named sound. Positional options place it in the world; omit them and
   * it plays at the listener. Returns false if audio is unavailable or the
   * voice budget refused it.
   */
  playSound(name: SoundName | string, opts: PlayOptions = {}): boolean {
    const g = this.graph;
    if (!g) return false;
    const vol = opts.volume ?? 1;
    const l = this.listener;
    const x = opts.x ?? l.px, y = opts.y ?? l.py, z = opts.z ?? l.pz;
    const interior = opts.interior ?? l.interior;

    try {
      switch (name) {
        case 'ui:click': Ui.uiClick(g, vol); return true;
        case 'ui:hover': Ui.uiHover(g, vol); return true;
        case 'ui:confirm': Ui.uiConfirm(g, vol); return true;
        case 'ui:back': Ui.uiBack(g, vol); return true;
        case 'ui:error': Ui.uiError(g, vol); return true;

        case 'hit:marker': Ui.hitMarker(g, opts.armour ?? false, vol); return true;
        case 'kill:confirm': Ui.killConfirm(g, vol); return true;

        case 'impact:own': impactOwn(g, opts.calibre ?? 12.7, opts.armour ?? false); return true;
        case 'impact:remote': impactRemote(g, l, x, y, z, opts.calibre ?? 12.7, opts.armour ?? false); return true;

        case 'nearmiss':
          nearMiss(g, l, x, y, z, opts.vx ?? 0, opts.vy ?? 0, opts.vz ?? 0,
            Math.hypot(x - l.px, y - l.py, z - l.pz), 800);
          return true;

        case 'explosion':
        case 'explosion:ground':
        case 'explosion:water': {
          const kind: BlastKind = name === 'explosion:ground' ? 'ground'
            : name === 'explosion:water' ? 'water' : 'air';
          explosion(g, l, x, y, z, opts.scale ?? 1, kind, opts.vx ?? 0, opts.vy ?? 0, opts.vz ?? 0);
          return true;
        }
        case 'structure:fail': structureFail(g, l, x, y, z, opts.scale ?? 1); return true;

        case 'gear:down': Ui.servo(g, true, opts.duration ?? 2.6, vol, true); return true;
        case 'gear:up': Ui.servo(g, false, opts.duration ?? 2.6, vol, true); return true;
        case 'flaps:down': Ui.servo(g, true, opts.duration ?? 1.4, vol * 0.8, false); return true;
        case 'flaps:up': Ui.servo(g, false, opts.duration ?? 1.4, vol * 0.8, false); return true;

        case 'canopy:open': Ui.canopy(g, false, vol); return true;
        case 'canopy:jettison': Ui.canopy(g, true, vol); return true;

        case 'engine:start': Ui.engineStart(g, g.bus.cockpit, vol); return true;
        case 'engine:stop': Ui.engineStop(g, g.bus.cockpit, vol); return true;

        case 'warn:low': Ui.warningTone(g, 'low', vol); return true;
        case 'warn:high': Ui.warningTone(g, 'high', vol); return true;

        case 'bailout': Ui.bailout(g, vol); return true;
        case 'stress': Ui.airframeStress(g, opts.scale ?? 0.6, vol); return true;

        case 'radio:blip':
          this.radio?.blip(opts.kind ?? 'friendly', vol);
          if (opts.text) this.ctx?.bus.emit('radio:callout', { text: opts.text, kind: opts.kind ?? 'friendly' });
          return true;
        case 'radio:static': this.radio?.interference(vol); return true;

        case 'gun:shot':
          return singleShot(g, interior ? g.bus.cockpit : g.bus.weapon, opts.calibre ?? 12.7, {
            interior, level: vol, priority: 0.6,
          });

        case 'blip': Ui.genericBlip(g, opts.scale ?? 880, vol); return true;
        default:
          return false;
      }
    } catch (err) {
      console.warn(`[audio] playSound("${name}") failed`, err);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Listener
  // -------------------------------------------------------------------------

  private updateListener(ctx: GameContext): void {
    const g = this.graph!;
    const l = this.listener;

    const local = ctx.localEntityId ? ctx.entities.get(ctx.localEntityId) : undefined;

    if (ctx.time < this.externalListenerUntil) {
      // Someone is driving the listener explicitly; only refresh the interior
      // flag, which is a game-state question rather than a transform one.
      l.interior = this.resolveInterior(l, local);
      return;
    }

    const cam = ctx.camera;
    cam.updateMatrixWorld();
    const m = cam.matrixWorld.elements;
    const px = m[12], py = m[13], pz = m[14];

    // Columns of the world matrix are the camera basis; three's cameras look
    // down −Z, so forward is the negated third column.
    normInto(-m[8], -m[9], -m[10], 0, 0, -1, _fwd);
    normInto(m[4], m[5], m[6], 0, 1, 0, _up);

    // Listener velocity drives doppler. The aircraft's own velocity is far more
    // stable than differentiating a spring-damped chase camera, so prefer it.
    if (local) {
      l.vx = local.vx; l.vy = local.vy; l.vz = local.vz;
    } else if (this.havePrevPos && ctx.dt > 1e-4) {
      const inv = 1 / ctx.dt;
      const dx = (px - this.prevPx) * inv, dy = (py - this.prevPy) * inv, dz = (pz - this.prevPz) * inv;
      // A camera cut is not motion. Anything implying > 600 m/s is a teleport.
      const sp = Math.hypot(dx, dy, dz);
      if (sp > 600) { l.vx = 0; l.vy = 0; l.vz = 0; }
      else {
        // Light smoothing: raw per-frame differences jitter enough to warble
        // the doppler on sustained sources.
        const k = 0.35;
        l.vx += (dx - l.vx) * k; l.vy += (dy - l.vy) * k; l.vz += (dz - l.vz) * k;
      }
    }
    this.prevPx = px; this.prevPy = py; this.prevPz = pz;
    this.havePrevPos = true;

    l.px = px; l.py = py; l.pz = pz;
    l.fx = _fwd.x; l.fy = _fwd.y; l.fz = _fwd.z;
    l.ux = _up.x; l.uy = _up.y; l.uz = _up.z;
    l.interior = this.resolveInterior(l, local);

    applyListener(g.ac, l, Math.min(0.05, Math.max(0.008, ctx.dt)));
  }

  /** Inside the canopy if the camera is within a couple of metres of the hull. */
  private resolveInterior(l: ListenerState, local: EntityState | undefined): boolean {
    if (this.cockpitOverride !== null) return this.cockpitOverride;
    if (!local) return false;
    const d2 = (l.px - local.px) ** 2 + (l.py - local.py) ** 2 + (l.pz - local.pz) ** 2;
    return d2 < 2.8 * 2.8;
  }

  // -------------------------------------------------------------------------
  // Engines
  // -------------------------------------------------------------------------

  private updateEngines(ctx: GameContext): void {
    const g = this.graph!;
    const l = this.listener;
    const prof = g.profile;

    // Rank every aircraft by distance; the local one always wins.
    this.candN = 0;
    for (const e of ctx.entities.values()) {
      if (e.kind !== EntityKind.Aircraft) continue;
      const d = e.id === ctx.localEntityId
        ? -1
        : Math.hypot(e.px - l.px, e.py - l.py, e.pz - l.pz);
      if (d > 4600 && !this.pinned.has(e.id)) continue;
      this.insertCandidate(e.id, this.pinned.has(e.id) ? Math.min(d, 0) : d);
    }

    const budget = Math.min(this.candN, prof.maxEngines);

    // Spawn and refresh the winners.
    for (let i = 0; i < budget; i++) {
      const id = this.candId[i];
      const e = ctx.entities.get(id);
      if (!e) continue;
      let voice = this.engines.get(id);
      if (!voice) {
        const spec = aircraftByIndex(e.typeId);
        const detail: EngineDetail = id === ctx.localEntityId ? 2
          : i < prof.richEngines + 1 ? (prof.layers ? 2 : 1)
          : prof.layers ? 1 : 0;
        // The local aircraft is always at range 0; everyone else pays the
        // measured distance, so only the nearest few contacts get HRTF.
        const spawnDist = id === ctx.localEntityId
          ? 0
          : Math.hypot(e.px - l.px, e.py - l.py, e.pz - l.pz);
        voice = new EngineVoice(g, id, spec, detail, e.px, e.py, e.pz, spawnDist);
        this.engines.set(id, voice);
      }
      const isLocal = id === ctx.localEntityId;
      voice.priority = isLocal ? 1 : 0.7;
      // Remote engines sit under the player's own so the mix stays readable.
      voice.setLevel(isLocal ? 1 : 0.7);
      voice.setInterior(isLocal && l.interior);

      const tas = Math.hypot(e.vx, e.vy, e.vz);
      // Mutated in place: one object literal per engine per frame is ~600
      // short-lived objects a second at ten voices, and the brief counts GC
      // pressure on the target platform as a correctness failure.
      _engineIn.rpm = e.rpm;
      _engineIn.throttle = e.throttle;
      _engineIn.ias = indicatedAirspeed(tas, e.py);
      _engineIn.damage = e.damage;
      _engineIn.health = e.health;
      voice.update(_engineIn, e.px, e.py, e.pz, e.vx, e.vy, e.vz, l);
    }

    // Cull. Hysteresis of two ranks keeps aircraft near the budget boundary
    // from flickering their engines on and off as they trade places.
    if (this.engines.size > 0) {
      // values(), not entries(): the default Map iterator mints a fresh
      // two-element array per entry, and this runs every frame per voice.
      for (const voice of this.engines.values()) {
        const id = voice.entityId;
        if (this.pinned.has(id)) continue;
        const rank = this.rankOf(id);
        const gone = !ctx.entities.has(id);
        if (gone || rank < 0 || rank >= prof.maxEngines + 2) {
          voice.stop(gone ? 0.12 : 0.35);
          this.engines.delete(id);
        }
      }
    }
  }

  /** Insertion sort into the candidate arrays — n is at most a few dozen. */
  private insertCandidate(id: number, dist: number): void {
    let i = this.candN;
    while (i > 0 && this.candDist[i - 1] > dist) {
      this.candDist[i] = this.candDist[i - 1];
      this.candId[i] = this.candId[i - 1];
      i--;
    }
    this.candDist[i] = dist;
    this.candId[i] = id;
    this.candN++;
  }

  private rankOf(id: number): number {
    for (let i = 0; i < this.candN; i++) if (this.candId[i] === id) return i;
    return -1;
  }

  // -------------------------------------------------------------------------
  // Guns
  // -------------------------------------------------------------------------

  private updateGuns(ctx: GameContext): void {
    const l = this.listener;
    for (const emitter of this.guns.values()) {
      const key = emitter.key;
      const e = ctx.entities.get(emitter.entityId);
      if (e) {
        emitter.setInterior(emitter.entityId === ctx.localEntityId && l.interior);
        emitter.update(e.px, e.py, e.pz, e.vx, e.vy, e.vz, l);
      }
      if (emitter.expired || (!e && emitter.expired)) {
        emitter.stop(0.06);
        this.guns.delete(key);
      }
    }
  }

  /**
   * Chooses which weapon fired from the replicated event.
   *
   * Both emitters agree on the wire format (server/Room.ts:435 and
   * src/game/OfflineSandbox.ts:343): 'a' is the shooter's *entity* id, 'b' is
   * the index into 'spec.guns', and 'scale' is 'gun.calibre / 20'. So the index
   * is authoritative and the calibre is only a cross-check for the case where a
   * client and a server disagree about the aircraft table.
   */
  private resolveGun(spec: AircraftSpec, index: number, calibreHint: number): GunSpec | undefined {
    if (spec.guns.length === 0) return undefined;
    const byIndex = (index >= 0 && index < spec.guns.length) ? spec.guns[index] : undefined;
    const calibre = decodeCalibre(calibreHint, 0);
    if (byIndex && (calibre === 0 || Math.abs(byIndex.calibre - calibre) < 3)) return byIndex;

    // Index disagreed with the calibre on the wire (or was out of range):
    // believe the calibre, since that is what the acoustics are derived from.
    if (calibre > 0) {
      let best = spec.guns[0], bestErr = Infinity;
      for (const gun of spec.guns) {
        const err = Math.abs(gun.calibre - calibre);
        if (err < bestErr) { bestErr = err; best = gun; }
      }
      return best;
    }
    return byIndex ?? spec.guns[0];
  }

  private onGunfire(ctx: GameContext, ev: GameEventPayload): void {
    const g = this.graph!;
    const shooter = ev.a;
    const e = ctx.entities.get(shooter);
    const spec = aircraftByIndex(e ? e.typeId : 0);
    const gun = this.resolveGun(spec, ev.b, ev.scale);
    if (!gun) return;

    // Keyed on the *group*, not the calibre, so a Spitfire's two Hispanos and
    // four Brownings are two emitters and the belt-fed cadence of each battery
    // is modelled once rather than per barrel.
    const key = `${shooter}:${gun.group}:${gun.calibre}`;
    let emitter = this.guns.get(key);
    if (!emitter) {
      // Hard cap: a twelve-plane furball would otherwise build twelve sustained
      // layers, and past about six the extra ones only raise the noise floor.
      if (this.guns.size >= 7) return;
      const px = e ? e.px : ev.x, py = e ? e.py : ev.y, pz = e ? e.pz : ev.z;
      const l = this.listener;
      const dist = Math.hypot(px - l.px, py - l.py, pz - l.pz);
      emitter = new GunEmitter(
        g, key, shooter, gun, shooter === ctx.localEntityId, px, py, pz, dist,
      );
      emitter.setInterior(shooter === ctx.localEntityId && this.listener.interior);
      this.guns.set(key, emitter);
    }
    emitter.trigger(g.now);
  }

  // -------------------------------------------------------------------------
  // Local aircraft: airflow, servos, damage transitions
  // -------------------------------------------------------------------------

  private updateLocalAircraft(ctx: GameContext): void {
    const af = this.airflow;
    if (!af) return;
    const e = ctx.localEntityId ? ctx.entities.get(ctx.localEntityId) : undefined;

    if (!e) {
      _airIn.ias = 0; _airIn.vne = 200; _airIn.vertical = 0;
      _airIn.alpha = 0; _airIn.stallAlpha = 0.3;
      _airIn.gear = 0; _airIn.flaps = 0; _airIn.airbrake = 0;
      _airIn.interior = false; _airIn.active = false;
      _airIn.listenerDistance = Infinity;
      af.update(_airIn);
      this.prevGear = -1; this.prevFlaps = -1; this.prevDamage = 0;
      return;
    }

    const spec = aircraftByIndex(e.typeId);
    const tas = Math.hypot(e.vx, e.vy, e.vz);
    const ias = indicatedAirspeed(tas, e.py);

    // Angle of attack from the body-frame velocity. Body axes are +X right,
    // +Y up, +Z forward, so alpha = atan2(−v_y, v_z).
    _q.x = e.qx; _q.y = e.qy; _q.z = e.qz; _q.w = e.qw;
    _v.x = e.vx; _v.y = e.vy; _v.z = e.vz;
    qrotInv(_q, _v, _out);
    const alpha = tas > 8 ? Math.atan2(-_out.y, Math.max(1, _out.z)) : 0;

    _airIn.ias = ias;
    _airIn.vne = spec.aero.vne;
    _airIn.vertical = e.vy;
    _airIn.alpha = alpha;
    _airIn.stallAlpha = spec.aero.stallAlpha;
    _airIn.gear = e.gear;
    _airIn.flaps = e.flaps;
    _airIn.airbrake = 0;
    _airIn.interior = this.listener.interior;
    _airIn.active = true;
    _airIn.listenerDistance = Math.hypot(
      e.px - this.listener.px, e.py - this.listener.py, e.pz - this.listener.pz,
    );
    af.update(_airIn);

    this.detectTransitions(e, spec, ias);
  }

  /** Servo and warning sounds triggered by state changes, not by events. */
  private detectTransitions(e: EntityState, spec: AircraftSpec, ias: number): void {
    const g = this.graph!;

    if (this.prevGear >= 0) {
      const moving = Math.abs(e.gear - this.prevGear) > 1e-3;
      const wasStill = Math.abs(this.prevGear - Math.round(this.prevGear)) < 1e-3;
      if (moving && wasStill) Ui.servo(g, e.gear > this.prevGear, 2.6, 1, true);

      const fMoving = Math.abs(e.flaps - this.prevFlaps) > 1e-3;
      const fWasStill = Math.abs(this.prevFlaps - Math.round(this.prevFlaps)) < 1e-3;
      if (fMoving && fWasStill) Ui.servo(g, e.flaps > this.prevFlaps, 1.4, 0.8, false);
    }
    this.prevGear = e.gear;
    this.prevFlaps = e.flaps;

    const newBits = e.damage & ~this.prevDamage;
    if (newBits) {
      if (newBits & (DamageBits.EngineFire | DamageBits.FuelLeak)) {
        Ui.warningTone(g, 'high');
        this.radio?.blip('warning', 0.8);
      } else if (newBits & (DamageBits.Engine | DamageBits.OilLeak | DamageBits.PilotHit)) {
        Ui.warningTone(g, 'low');
      }
      if (newBits & (DamageBits.WingRipped | DamageBits.Tail)) {
        structureFail(g, this.listener, e.px, e.py, e.pz, 1.2);
      }
    }
    this.prevDamage = e.damage;

    // Overspeed groan: the airframe complaining above Vne.
    if (ias > spec.aero.vne * 1.02 && (this.ctx.frame % 37) === 0) {
      Ui.airframeStress(g, clamp((ias / spec.aero.vne - 1) * 6, 0.2, 1));
    }
  }

  /**
   * GroundImpact / WaterImpact are emitted once per *projectile* reaching the
   * terrain, not once per bomb (server/Room.ts:469, OfflineSandbox.ts:392), so
   * a strafing pass produces them at the cyclic rate of the whole battery.
   *
   * Two things follow. They must not use the blast synthesiser — see
   * terrainImpact — and they must be coalesced, because sixty individually
   * scheduled slaps in a second is a buzz, while one thickened slap every
   * ~70 ms is a burst walking across a field, which is what it sounds like.
   */
  private onTerrainImpact(ev: GameEventPayload): void {
    const g = this.graph!;
    const water = ev.kind === EventKind.WaterImpact;
    const calibre = decodeCalibre(ev.scale, 12.7);

    // Anything genuinely ordnance-sized keeps the full blast. Nothing in the
    // repo currently sends one, but a bomb fused for impact would.
    if (calibre >= 57) {
      explosion(g, this.listener, ev.x, ev.y, ev.z, calibre / 20, water ? 'water' : 'ground');
      return;
    }

    const now = g.now;
    if (this.terrainAt >= 0 && now - this.terrainAt < TERRAIN_IMPACT_GAP) {
      // Inside the window: remember it and let the next one carry the weight.
      this.terrainPending++;
      this.terrainX = ev.x; this.terrainY = ev.y; this.terrainZ = ev.z;
      this.terrainCal = Math.max(this.terrainCal, calibre);
      this.terrainWater = water;
      return;
    }
    const thick = 1 + this.terrainPending;
    this.terrainPending = 0;
    this.terrainAt = now;
    this.terrainCal = 12.7;
    terrainImpact(g, this.listener, ev.x, ev.y, ev.z, calibre, water, thick);
  }

  // -------------------------------------------------------------------------
  // Near misses
  // -------------------------------------------------------------------------

  /**
   * Rounds are replicated as entities, so a near miss can be detected properly:
   * track each round's distance to the listener and fire the crack on the frame
   * the distance starts increasing again — the true point of closest approach.
   * Anything simpler either fires early (wrong direction) or fires late (no
   * doppler), and both are immediately obvious.
   */
  private updateProjectiles(ctx: GameContext): void {
    const g = this.graph!;
    const l = this.listener;

    // Whose rounds are ours?
    //
    // A projectile inherits its shooter aircraft's 'ownerId', so the test has
    // to be against the *local aircraft's* ownerId, not against
    // ctx.localPlayerId. Offline those two differ: OfflineSandbox.ts:153 sets
    // the player's ownerId to 'localPlayerId || 1' — i.e. 1 — while
    // ctx.localPlayerId is only ever assigned from the server's Welcome message
    // (NetSystem.ts:154) and stays 0. Comparing against it therefore matched
    // nothing in the default offline sandbox, and every round the player fired
    // registered as a near miss on the frame after it left the muzzle.
    const localEnt = ctx.localEntityId ? ctx.entities.get(ctx.localEntityId) : undefined;
    const ownOwner = localEnt ? localEnt.ownerId : ctx.localPlayerId;

    this.nearMissThisFrame = 0;
    for (const e of ctx.entities.values()) {
      if (e.kind !== EntityKind.Projectile) continue;
      if (ownOwner !== 0 && e.ownerId === ownOwner) continue;   // your own rounds
      const d = Math.hypot(e.px - l.px, e.py - l.py, e.pz - l.pz);
      const prev = this.projDist.get(e.id);
      this.projDist.set(e.id, d);
      if (prev === undefined) continue;
      if (d <= prev || prev >= 32 || this.projFired.has(e.id)) continue;
      this.projFired.add(e.id);
      // Belt and braces for the case where the ownership test cannot resolve
      // (spectating, a snapshot that has not carried the local aircraft yet):
      // a round whose closest approach is inside our own hull radius came off
      // our own wing, and a whip-crack from a round that never got near us is
      // not a near miss either.
      if (prev < 6) continue;
      if (this.nearMissThisFrame >= 2) continue;
      if (g.now - this.nearMissAt < NEAR_MISS_GAP) continue;
      this.nearMissThisFrame++;
      this.nearMissAt = g.now;
      nearMiss(g, l, e.px, e.py, e.pz, e.vx, e.vy, e.vz, prev, Math.hypot(e.vx, e.vy, e.vz));
    }

    // Cheap amortised cleanup: rounds live under a second, so a sweep every
    // half second is plenty and never costs a visible spike.
    if (++this.pruneCounter >= 30) {
      this.pruneCounter = 0;
      for (const id of this.projDist.keys()) {
        if (!ctx.entities.has(id)) { this.projDist.delete(id); this.projFired.delete(id); }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Replicated events
  // -------------------------------------------------------------------------

  private onSpawned(): void {
    // The music/duck transition is driven by the update loop from actual game
    // state; this only resets the per-life edge detectors and nudges the
    // context in case the player got here without touching anything yet.
    this.radio?.blip('command', 0.9);
    this.prevGear = -1; this.prevFlaps = -1; this.prevDamage = 0;
    void this.graph?.resume();
  }

  private onGameEvent(ev: GameEventPayload): void {
    const g = this.graph;
    if (!g || !ev) return;
    const ctx = this.ctx;
    const l = this.listener;
    const local = ctx.localEntityId;

    try {
      switch (ev.kind) {
        case EventKind.Gunfire:
          this.onGunfire(ctx, ev);
          break;

        case EventKind.HitSpark:
        case EventKind.HitArmour: {
          const calibre = decodeCalibre(ev.scale, 12.7);
          // Nothing in the repo ever sends HitArmour — both emitters only push
          // HitSpark — so the armour variant has to be *derived* or it is dead
          // code. A round defeats structure but rings off plate when it has the
          // mass and velocity to matter: cannon and heavy MG do, rifle-calibre
          // does not. That is the same threshold the penetration model uses.
          const armour = ev.kind === EventKind.HitArmour || calibre >= 12;
          // 'a' is the *target* entity, 'b' the shooter entity (Room.ts:485,
          // OfflineSandbox.ts:434) — both entity ids, not player ids.
          if (ev.a === local && local !== 0) {
            impactOwn(g, calibre, armour);
          } else {
            impactRemote(g, l, ev.x, ev.y, ev.z, calibre, armour);
            if (ev.b !== 0 && ev.b === local && local !== 0) Ui.hitMarker(g, armour);
          }
          break;
        }

        case EventKind.Explosion:
          explosion(g, l, ev.x, ev.y, ev.z, ev.scale || 1, 'air');
          break;

        case EventKind.GroundImpact:
        case EventKind.WaterImpact:
          this.onTerrainImpact(ev);
          break;

        case EventKind.StructureFail:
          structureFail(g, l, ev.x, ev.y, ev.z, ev.scale || 1);
          break;

        case EventKind.Kill:
          if (ev.b === ctx.localPlayerId && ctx.localPlayerId !== 0) {
            Ui.killConfirm(g);
            this.radio?.blip('kill', 0.9);
          }
          break;

        case EventKind.Bailout:
          if (ev.a === local && local !== 0) Ui.bailout(g);
          else explosion(g, l, ev.x, ev.y, ev.z, 0.3, 'structure');
          break;

        case EventKind.Critical:
          if (ev.a === local && local !== 0) {
            Ui.warningTone(g, 'high');
            this.radio?.blip('warning', 0.85);
          }
          break;
      }
    } catch (err) {
      console.warn('[audio] event handling failed', err);
    }
  }
}

/** Shape of the 'audio:volumes' bus payload (src/ui/store.ts:252). */
interface VolumeSettings { master: number; effects: number; engine: number; ui: number }

/** Shape of the 'game:event' bus payload (see NetSystem.onEvents). */
interface GameEventPayload {
  kind: EventKind;
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  scale: number;
  a: number;
  b: number;
}

/**
 * Recovers a millimetre calibre from a replicated event's 'scale' field.
 *
 * Every emitter in the repo sends 'gun.calibre / 20' (server/Room.ts:435, 469,
 * 485 and the same three sites in OfflineSandbox), so the field runs 0.385 for
 * a 7.7 mm to 1.85 for a 37 mm. A previous reading treated it as millimetres
 * directly, which meant nothing ever fell in the 5-60 mm window and every gun
 * and every impact in the game silently used the 12.7 mm fallback.
 */
function decodeCalibre(scale: number, fallback: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return fallback;
  const mm = scale * 20;
  return mm >= 4 && mm <= 152 ? mm : fallback;
}

/** Normalise into 'out', falling back to a supplied default if degenerate. */
function normInto(
  x: number, y: number, z: number, dx: number, dy: number, dz: number, out: V3,
): void {
  const len = Math.hypot(x, y, z);
  if (len > 1e-6) { out.x = x / len; out.y = y / len; out.z = z / len; }
  else { out.x = dx; out.y = dy; out.z = dz; }
}
