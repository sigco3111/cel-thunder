/**
 * 3D placement for a single sound source.
 *
 * WebAudio gives us HRTF panning and distance rolloff; everything else that
 * matters for air combat we have to do ourselves:
 *
 *  - **Doppler.** The spec removed 'dopplerFactor' in 2014, so the shift is
 *    computed here from the relative radial velocity and handed back to the
 *    caller as a frequency multiplier. Aircraft close at 250 m/s, which is a
 *    ratio of ~2.1 — the single most recognisable sound in the genre.
 *  - **Air absorption.** A tracking lowpass per source. Distance without it
 *    just sounds quiet; distance with it sounds *far*.
 *  - **Panner model selection.** HRTF is worth its cost on the four things you
 *    are actually tracking and wasted on the twelfth engine three kilometres
 *    away, so the model is picked from distance and quality tier at build time.
 */

import { AudioGraph, killNodes } from './AudioGraph';
import { airAbsorptionCutoff, clamp, pGlide, pLin, pSet, SPEED_OF_SOUND } from './dsp';

export interface ListenerState {
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  /** Forward and up unit vectors of the head. */
  fx: number; fy: number; fz: number;
  ux: number; uy: number; uz: number;
  /** True when the ears are inside a canopy. */
  interior: boolean;
}

export function newListenerState(): ListenerState {
  return {
    px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0,
    fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0,
    interior: false,
  };
}

/** Modern browsers expose AudioParams; Safari < 14 only has the setters. */
type LegacyPanner = PannerNode & {
  setPosition?(x: number, y: number, z: number): void;
};
type LegacyListener = AudioListener & {
  setPosition?(x: number, y: number, z: number): void;
  setOrientation?(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
};

export function applyListener(ac: AudioContext, l: ListenerState, smooth: number): void {
  const L = ac.listener as LegacyListener;
  const t = ac.currentTime + clamp(smooth, 0.005, 0.06);
  if (L.positionX) {
    pLin(L.positionX, l.px, t); pLin(L.positionY, l.py, t); pLin(L.positionZ, l.pz, t);
    pLin(L.forwardX, l.fx, t); pLin(L.forwardY, l.fy, t); pLin(L.forwardZ, l.fz, t);
    pLin(L.upX, l.ux, t); pLin(L.upY, l.uy, t); pLin(L.upZ, l.uz, t);
  } else {
    L.setPosition?.(l.px, l.py, l.pz);
    L.setOrientation?.(l.fx, l.fy, l.fz, l.ux, l.uy, l.uz);
  }
}

function setPannerPosition(p: PannerNode, x: number, y: number, z: number, t: number, smooth: number): void {
  const lp = p as LegacyPanner;
  if (lp.positionX) {
    const tt = t + smooth;
    pLin(lp.positionX, x, tt); pLin(lp.positionY, y, tt); pLin(lp.positionZ, z, tt);
  } else {
    lp.setPosition?.(x, y, z);
  }
}

export interface SpatialOptions {
  /** Distance at which the source is at unity gain. Big for aircraft. */
  refDistance?: number;
  rolloff?: number;
  maxDistance?: number;
  /** Force HRTF on or off; defaults to a distance/quality decision. */
  hrtf?: boolean;
  /** Reverb send, 0..1. Distance sends make far explosions rumble. */
  send?: number;
  /** Doppler is disabled for stationary sources (ground fires, flak). */
  doppler?: boolean;
}

/**
 * A source chain: 'input' -> gain -> [air absorption] -> panner -> bus,
 * with an optional post-gain reverb send.
 */
export class SpatialSource {
  readonly input: GainNode;
  readonly panner: PannerNode;
  private readonly air: BiquadFilterNode;
  private readonly send: GainNode | null;
  private readonly graph: AudioGraph;
  private readonly useDoppler: boolean;

  /** Last computed distance to the listener, metres. */
  distance = 0;
  /** Last computed doppler ratio (multiply source frequencies by this). */
  doppler = 1;

  constructor(graph: AudioGraph, dest: AudioNode, x: number, y: number, z: number, o: SpatialOptions = {}) {
    const ac = graph.ac;
    this.graph = graph;
    this.useDoppler = o.doppler !== false;

    this.input = ac.createGain();

    this.air = ac.createBiquadFilter();
    this.air.type = 'lowpass';
    this.air.frequency.value = 20000;
    this.air.Q.value = 0.35;

    this.panner = ac.createPanner();
    const hrtf = o.hrtf ?? true;
    this.panner.panningModel = hrtf ? 'HRTF' : 'equalpower';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = o.refDistance ?? 24;
    this.panner.rolloffFactor = o.rolloff ?? 0.85;
    this.panner.maxDistance = o.maxDistance ?? 30000;
    // No cone: an aeroplane radiates in every direction and directional cones on
    // fast-moving sources produce audible zipper artefacts as they swing past.
    this.panner.coneInnerAngle = 360;

    this.input.connect(this.air);
    this.air.connect(this.panner);
    this.panner.connect(dest);

    if (o.send && o.send > 0) {
      this.send = ac.createGain();
      this.send.gain.value = o.send;
      this.panner.connect(this.send);
      this.send.connect(graph.reverbIn);
    } else {
      this.send = null;
    }

    setPannerPosition(this.panner, x, y, z, ac.currentTime, 0);
  }

  /** Distance-model gain, replicated so the voice pool can score loudness. */
  estimateLoudness(): number {
    const ref = this.panner.refDistance;
    const roll = this.panner.rolloffFactor;
    return clamp(ref / Math.max(ref, ref + roll * (this.distance - ref)), 0, 1);
  }

  setSend(v: number, smooth = 0.08): void {
    if (this.send) pGlide(this.send.gain, clamp(v, 0, 4), this.graph.now, smooth);
  }

  /**
   * Per-frame update. 'smooth' should be about one frame so the panner
   * interpolates instead of stepping — stepping a panner position at 60 Hz on a
   * source moving at 150 m/s produces a very audible 60 Hz buzz.
   */
  update(
    px: number, py: number, pz: number,
    vx: number, vy: number, vz: number,
    l: ListenerState, smooth = 0.02,
  ): void {
    const t = this.graph.now;
    setPannerPosition(this.panner, px, py, pz, t, smooth);

    let dx = px - l.px, dy = py - l.py, dz = pz - l.pz;
    const d = Math.hypot(dx, dy, dz);
    this.distance = d;

    if (this.useDoppler && d > 0.5) {
      const inv = 1 / d;
      dx *= inv; dy *= inv; dz *= inv;
      // d points listener -> source.
      //   closing speed of the listener  = +dot(vListener, d)
      //   receding speed of the source   = +dot(vSource,   d)
      //   f' = f * (c + vL·d) / (c + vS·d)
      const vl = l.vx * dx + l.vy * dy + l.vz * dz;
      const vs = vx * dx + vy * dy + vz * dz;
      // Clamp well short of the c singularity: a bullet or a diving fighter can
      // approach Mach 1 and the untamed ratio would scream to infinity.
      const num = SPEED_OF_SOUND + clamp(vl, -300, 300);
      const den = SPEED_OF_SOUND + clamp(vs, -300, 300);
      this.doppler = clamp(num / Math.max(40, den), 0.55, 1.9);
    } else {
      this.doppler = 1;
    }

    pGlide(this.air.frequency, airAbsorptionCutoff(d), t, 0.05);
  }

  /** One-shot placement: no tracking, just set everything once. */
  place(px: number, py: number, pz: number, vx: number, vy: number, vz: number, l: ListenerState): void {
    this.update(px, py, pz, vx, vy, vz, l, 0);
    pSet(this.air.frequency, airAbsorptionCutoff(this.distance), this.graph.now);
  }

  dispose(): void {
    killNodes([this.input, this.air, this.panner, this.send]);
  }
}

/**
 * Chooses the panning model. HRTF costs roughly four times an equal-power pan,
 * so it is spent on what the player is looking at and denied to the rest.
 */
export function wantHrtf(graph: AudioGraph, distance: number): boolean {
  return distance <= graph.profile.hrtfDistance;
}
