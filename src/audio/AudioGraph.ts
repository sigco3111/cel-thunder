/**
 * The mixing console.
 *
 *   sources ─┬─► engine ─┐
 *            ├─► weapon ─┼─► worldSum ─► occlusion(LP) ─► worldGain ─┐
 *            └─► env    ─┘        └─► worldSend ─┐                   │
 *                                                ▼                   │
 *   one-shot per-voice sends ───────────────► reverbIn ─► conv ─► reverbOut ─┤
 *                                                                    │
 *            ┌─► ui   ────────────────────────────────────────────────┤
 *            ├─► voice ───────────────────────────────────────────────┤
 *            └─► music ─► musicDuck ──────────────────────────────────┤
 *                                                                     ▼
 *                                    masterSum ─► bodyComp ─► limiter ─► clip ─► trim ─► out
 *
 * Why two dynamics stages: 'bodyComp' is a slow, gentle 3:1 glue compressor that
 * keeps the overall balance stable when twelve aircraft join a fight, and
 * 'limiter' is a fast 20:1 brickwall that catches individual explosion
 * transients. One compressor cannot do both — set it fast enough to catch a
 * transient and it pumps on the engine drone. The final waveshaper is a soft
 * clip that only ever sees material the limiter already tamed; it exists so a
 * pathological sum can never produce a full-scale square edge.
 *
 * Everything about this class is failure-tolerant. If the browser has no
 * AudioContext, or the user's OS has no output device, 'create' returns null and
 * the whole audio subsystem degrades to silence without a single throw.
 */

import {
  impulseResponse, noiseBuffer, pGlide, pLin, pSet, softClipCurve, clamp,
} from './dsp';
import { VoicePool } from './VoicePool';
import type { QualityTier } from '../engine/context';

/**
 * 'engine', 'weapon' and 'env' live in the world and are occluded by the
 * canopy. 'cockpit' is everything conducted through the airframe — your own
 * hits, servos, warning tones, the airstream over your own canopy — which is
 * *not* muffled by the canopy because it is already inside it.
 */
export type BusName = 'engine' | 'weapon' | 'env' | 'cockpit' | 'ui' | 'voice' | 'music';

export interface QualityProfile {
  maxVoices: number;
  /** HRTF panning is ~4× the cost of equal-power; reserve it for near sources. */
  hrtfDistance: number;
  /** How many remote aircraft get a full-detail engine model. */
  richEngines: number;
  /** Total simultaneous engine voices. */
  maxEngines: number;
  reverb: boolean;
  /** Extra synthesis layers (prop buzz, supercharger, debris) on/off. */
  layers: boolean;
}

const PROFILES: Record<QualityTier, QualityProfile> = {
  low:    { maxVoices: 20, hrtfDistance: -1,   richEngines: 0, maxEngines: 3, reverb: false, layers: false },
  medium: { maxVoices: 32, hrtfDistance: 250,  richEngines: 1, maxEngines: 5, reverb: true,  layers: true },
  high:   { maxVoices: 48, hrtfDistance: 900,  richEngines: 3, maxEngines: 8, reverb: true,  layers: true },
  ultra:  { maxVoices: 64, hrtfDistance: 2400, richEngines: 5, maxEngines: 10, reverb: true, layers: true },
};

/** The mix. Sliders scale these; they never replace them. */
const DESIGN_TRIM: Record<BusName, number> = {
  engine: 0.60, weapon: 0.55, env: 0.38,
  cockpit: 0.45, ui: 0.50, voice: 0.65, music: 0.55,
};

export class AudioGraph {
  readonly ac: AudioContext;
  readonly pool = new VoicePool();

  /** Per-bus trims, exposed so a mixer UI can move them. */
  readonly bus: Record<BusName, GainNode>;
  /** Current applied trim per bus (design trim x slider). */
  private readonly busTrim: Record<BusName, number>;

  /** Sum of everything that lives in the world and is therefore occludable. */
  readonly worldSum: GainNode;
  /** Canopy / cockpit muffle. Wide open outside, ~1.2 kHz inside. */
  readonly occlusion: BiquadFilterNode;
  readonly worldGain: GainNode;
  /** In-cloud muffle, in series after the canopy filter. */
  private readonly cloudLp: BiquadFilterNode;
  private readonly cloudGain: GainNode;
  private inCloud = false;
  private cloudDensity = 0;

  readonly reverbIn: GainNode;
  readonly reverbOut: GainNode;
  private readonly convolver: ConvolverNode | null;
  private readonly worldSend: GainNode;

  readonly musicDuck: GainNode;

  private readonly masterSum: GainNode;
  private readonly bodyComp: DynamicsCompressorNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly clip: WaveShaperNode;
  private readonly trim: GainNode;

  /** Duck applied to the whole world bus by a nearby blast (temporary deafness). */
  private readonly blastDuck: GainNode;

  quality: QualityTier = 'high';
  profile: QualityProfile = PROFILES.high;

  private masterVolume = 0.8;
  private interior = false;
  private gestureHandlers: Array<[string, EventListener]> = [];
  private disposed = false;

  static create(): AudioGraph | null {
    try {
      const Ctor: typeof AudioContext | undefined =
        (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
        (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      // 'interactive' asks for the smallest buffer the platform will give us:
      // gunfire that lags the muzzle flash by 40 ms reads as broken.
      const ac = new Ctor({ latencyHint: 'interactive' });
      return new AudioGraph(ac);
    } catch (err) {
      console.warn('[audio] no AudioContext:', err);
      return null;
    }
  }

  private constructor(ac: AudioContext) {
    this.ac = ac;
    const g = () => ac.createGain();

    this.trim = g();
    this.trim.gain.value = this.masterVolume;
    this.trim.connect(ac.destination);

    this.clip = ac.createWaveShaper();
    this.clip.curve = softClipCurve(1.35);
    this.clip.oversample = '2x';
    this.clip.connect(this.trim);

    this.limiter = ac.createDynamicsCompressor();
    this.limiter.threshold.value = -3.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.18;
    this.limiter.connect(this.clip);

    this.bodyComp = ac.createDynamicsCompressor();
    this.bodyComp.threshold.value = -20;
    this.bodyComp.knee.value = 14;
    this.bodyComp.ratio.value = 3;
    this.bodyComp.attack.value = 0.012;
    this.bodyComp.release.value = 0.30;
    this.bodyComp.connect(this.limiter);

    this.masterSum = g();
    this.masterSum.connect(this.bodyComp);

    // --- reverb ------------------------------------------------------------
    // Two roles: the close, dark canopy reflection you hear inside a cockpit,
    // and the long low rumble that tells you an explosion was far away. One IR
    // with a dark, medium-length tail serves both once the sends are weighted
    // correctly (interior sends broadband, distant sends only lows).
    let conv: ConvolverNode | null = null;
    try {
      conv = ac.createConvolver();
      conv.normalize = true;
      conv.buffer = impulseResponse(ac, {
        seconds: 1.9, decay: 3.6, damping: 0.72, predelay: 0.008, early: 9, seed: 17,
      });
    } catch { conv = null; }
    this.convolver = conv;

    this.reverbOut = g();
    this.reverbOut.gain.value = 0.9;
    this.reverbOut.connect(this.masterSum);

    this.reverbIn = g();
    this.reverbIn.gain.value = 1;
    if (conv) { this.reverbIn.connect(conv); conv.connect(this.reverbOut); }

    // --- world chain -------------------------------------------------------
    this.blastDuck = g();
    this.blastDuck.gain.value = 1;
    this.blastDuck.connect(this.masterSum);

    this.worldGain = g();
    this.worldGain.gain.value = 1;
    this.worldGain.connect(this.blastDuck);

    // Cloud sits between the canopy filter and the world sum so the two are in
    // series and the more closed of the pair dominates.
    this.cloudGain = g();
    this.cloudGain.gain.value = 1;
    this.cloudGain.connect(this.worldGain);

    this.cloudLp = ac.createBiquadFilter();
    this.cloudLp.type = 'lowpass';
    this.cloudLp.frequency.value = 20000;
    this.cloudLp.Q.value = 0.4;
    this.cloudLp.connect(this.cloudGain);

    this.occlusion = ac.createBiquadFilter();
    this.occlusion.type = 'lowpass';
    this.occlusion.frequency.value = 20000;
    this.occlusion.Q.value = 0.5;
    this.occlusion.connect(this.cloudLp);

    this.worldSum = g();
    this.worldSum.connect(this.occlusion);

    this.worldSend = g();
    this.worldSend.gain.value = 0.0;      // raised when the listener is inside
    this.worldSum.connect(this.worldSend);
    this.worldSend.connect(this.reverbIn);

    // --- buses -------------------------------------------------------------
    const mk = (dest: AudioNode, v: number) => { const n = g(); n.gain.value = v; n.connect(dest); return n; };

    this.musicDuck = g();
    this.musicDuck.gain.value = 1;
    this.musicDuck.connect(this.masterSum);

    // Static bus trims live in DESIGN_TRIM — this is the mix, and it is built
    // around headroom.
    //
    // The engine is a continuous, dense signal; if it sits near 0 dBFS the glue
    // compressor rides it permanently and every gunshot and explosion pumps the
    // drone. Measured, the engine stack peaks around 1.8 before trim, so it is
    // parked near −22 dBFS RMS and everything transient gets the top 20 dB to
    // itself. That gap is the entire reason gunfire reads as violent rather
    // than merely present.
    this.bus = {
      engine:  mk(this.worldSum, DESIGN_TRIM.engine),
      weapon:  mk(this.worldSum, DESIGN_TRIM.weapon),
      env:     mk(this.worldSum, DESIGN_TRIM.env),
      cockpit: mk(this.masterSum, DESIGN_TRIM.cockpit),
      ui:      mk(this.masterSum, DESIGN_TRIM.ui),
      voice:   mk(this.masterSum, DESIGN_TRIM.voice),
      music:   mk(this.musicDuck, DESIGN_TRIM.music),
    };
    this.busTrim = { ...DESIGN_TRIM };

    this.setQuality('high');
    this.pool.enabled = this.isRunning();
    this.armAutoplayGestures();
    ac.addEventListener?.('statechange', this.onStateChange);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  // -------------------------------------------------------------------------
  // Autoplay policy
  // -------------------------------------------------------------------------

  /**
   * Browsers create the context suspended until a real user gesture. We listen
   * on every plausible first-interaction event, resume, and unhook ourselves.
   * 'resume()' rejects if called at the wrong moment, so it is always caught.
   */
  private armAutoplayGestures(): void {
    const resume = () => { void this.resume(); };
    for (const evt of ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'click', 'wheel'] as const) {
      const h = resume as EventListener;
      this.gestureHandlers.push([evt, h]);
      window.addEventListener(evt, h, { passive: true, capture: true });
    }
  }

  private disarmGestures(): void {
    for (const [evt, h] of this.gestureHandlers) {
      window.removeEventListener(evt, h, { capture: true } as EventListenerOptions);
    }
    this.gestureHandlers.length = 0;
  }

  async resume(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.isRunning()) { this.disarmGestures(); return true; }
    try {
      await this.ac.resume();
    } catch { return false; }
    const ok = this.isRunning();
    this.pool.enabled = ok;
    if (ok) this.disarmGestures();
    return ok;
  }

  /** Indirection defeats control-flow narrowing on the mutable 'state' field. */
  private isRunning(): boolean {
    return (this.ac.state as string) === 'running';
  }

  get running(): boolean { return !this.disposed && this.ac.state === 'running'; }
  get now(): number { return this.ac.currentTime; }

  private onStateChange = (): void => {
    this.pool.enabled = this.isRunning();
    if (this.pool.enabled) this.disarmGestures();
  };

  /**
   * A backgrounded tab still burns CPU on a running graph, and a game that
   * keeps roaring while the player reads their email is obnoxious. Duck rather
   * than suspend: suspending freezes the timeline and every scheduled tail
   * resumes mid-envelope, which is audibly wrong.
   */
  private onVisibility = (): void => {
    if (this.disposed) return;
    const t = this.now;
    pLin(this.trim.gain, document.hidden ? 0 : this.masterVolume, t + 0.12);
  };

  // -------------------------------------------------------------------------
  // Mixer state
  // -------------------------------------------------------------------------

  setMasterVolume(v: number): void {
    const nv = clamp(v, 0, 1);
    if (Math.abs(nv - this.masterVolume) < 1e-4) return;
    this.masterVolume = nv;
    if (!document.hidden) pLin(this.trim.gain, nv, this.now + 0.05);
  }

  /**
   * Player-facing bus trim, 0..1.
   *
   * Multiplies the static design trim in the 'bus' literal rather than
   * replacing it: those numbers *are* the mix (see the comment there), and a
   * slider that overwrites them destroys the headroom budget that keeps the
   * glue compressor off the engine drone. So the slider scales, it does not set.
   */
  setBusTrim(name: BusName, v: number, smooth = 0.08): void {
    const node = this.bus[name];
    if (!node) return;
    const target = DESIGN_TRIM[name] * clamp(v, 0, 1);
    if (Math.abs(target - this.busTrim[name]) < 1e-4) return;
    this.busTrim[name] = target;
    pGlide(node.gain, target, this.now, smooth);
  }

  setQuality(q: QualityTier): void {
    this.quality = q;
    this.profile = PROFILES[q];
    this.pool.setMax(this.profile.maxVoices, this.now);
    pLin(this.reverbOut.gain, this.profile.reverb ? 0.9 : 0, this.now + 0.25);
  }

  /**
   * Cockpit occlusion. Inside a closed canopy you lose most of the top two
   * octaves of everything outside, gain a strong short reflection off the
   * perspex, and the whole world drops ~4 dB relative to the airframe. Modelled
   * as a global lowpass plus a reverb send, which is cheap and reads instantly.
   */
  setInterior(inside: boolean, blend = 0.06): void {
    if (this.interior === inside) return;
    this.interior = inside;
    const t = this.now;
    pGlide(this.occlusion.frequency, inside ? 1250 : 20000, t, blend);
    if (this.inCloud) this.setInCloudNow(t);
    pGlide(this.occlusion.Q, inside ? 0.9 : 0.5, t, blend);
    pGlide(this.worldGain.gain, inside ? 0.72 : 1.0, t, blend);
    pGlide(this.worldSend.gain, inside && this.profile.reverb ? 0.20 : 0.0, t, blend);
  }

  get isInterior(): boolean { return this.interior; }

  /**
   * Flying through cloud.
   *
   * Water droplets are a poor acoustic medium for the top end and a listener
   * inside one has no line of sight to anything, so distant sources lose their
   * definition: a mild extra lowpass on the world sum plus a touch more send,
   * which is the same cue a real pilot gets. Deliberately gentle — this must be
   * a change you notice at the moment of entry, not a mute.
   */
  setInCloud(inside: boolean, density = 1): void {
    if (this.inCloud === inside && Math.abs(density - this.cloudDensity) < 0.05) return;
    this.inCloud = inside;
    this.cloudDensity = clamp(density, 0, 1);
    this.setInCloudNow(this.now);
  }

  private setInCloudNow(t: number): void {
    const d = this.cloudDensity;
    // Compose with the canopy occlusion rather than fighting it: whichever is
    // more closed wins, so being in cloud *and* in the cockpit is not additive
    // to the point of silence.
    const base = this.interior ? 1250 : 20000;
    pGlide(this.cloudLp.frequency, this.inCloud ? Math.min(base, 3400 - 1200 * d) : 20000, t, 0.35);
    pGlide(this.cloudGain.gain, this.inCloud ? 1 - 0.18 * d : 1, t, 0.35);
  }

  /**
   * Temporary hearing loss from a close blast: duck the world hard, then let it
   * recover over ~1.5 s. Cheap, but it is the difference between an explosion
   * that is loud and an explosion that hurt.
   */
  blast(intensity: number): void {
    const t = this.now;
    const depth = clamp(1 - intensity * 0.72, 0.18, 1);
    pSet(this.blastDuck.gain, Math.min(this.blastDuck.gain.value, 1), t);
    pLin(this.blastDuck.gain, depth, t + 0.045);
    pGlide(this.blastDuck.gain, 1, t + 0.09, 0.55);
  }

  /** Music is a menu affordance; in the air it must be gone, not quiet. */
  setMusicDuck(level: number, seconds = 1.0): void {
    pLin(this.musicDuck.gain, clamp(level, 0, 1), this.now + seconds);
  }

  /** Shared noise sources warm the buffer cache before the first frame. */
  prewarm(): void {
    noiseBuffer(this.ac, 'white', 2.2, 1);
    noiseBuffer(this.ac, 'pink', 2.6, 2);
    noiseBuffer(this.ac, 'brown', 3.1, 3);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pool.releaseAll(0.03);
    this.disarmGestures();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.ac.removeEventListener?.('statechange', this.onStateChange);
    try { pLin(this.trim.gain, 0, this.now + 0.06); } catch { /* ignore */ }
    setTimeout(() => { this.ac.close().catch(() => { /* already closed */ }); }, 120);
  }
}

/** Disconnect a whole node list without caring which are already detached. */
export function killNodes(nodes: readonly (AudioNode | null | undefined)[]): void {
  for (const n of nodes) {
    if (!n) continue;
    try { n.disconnect(); } catch { /* already disconnected */ }
  }
}

/** Stop scheduled sources safely — a double stop() throws in some engines. */
export function stopSources(
  srcs: readonly (AudioScheduledSourceNode | null | undefined)[], when: number,
): void {
  for (const s of srcs) {
    if (!s) continue;
    try { s.stop(Math.max(0, when)); } catch { /* already stopped */ }
  }
}
