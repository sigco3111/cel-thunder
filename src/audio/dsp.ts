/**
 * Signal-generation primitives shared by every synthesised sound in the game.
 *
 * There are no audio files anywhere in Cel Thunder: every gunshot, every engine
 * harmonic and every explosion is built from noise buffers, oscillators and
 * filter curves generated here at load time. That constrains the design in two
 * useful ways:
 *
 *   1. Anything that loops must be *seamless*, because a discontinuity at the
 *      wrap point is a click, and a click repeated every two seconds is the
 *      single most obvious "this is a toy" tell. 'noiseBuffer' cross-fades its
 *      own tail into its head so the buffer joins to itself smoothly.
 *   2. Anything periodic must have a controlled crest factor, because the
 *      master limiter cannot fix a waveform that is 20 dB peakier than its RMS
 *      without pumping. 'harmonicWave' uses Schroeder phases for that reason.
 */

import { Rng, clamp } from '../shared/math';

/** Dry-air speed of sound at ~15 °C. Used for doppler and arrival delay. */
export const SPEED_OF_SOUND = 343;

export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (g: number): number => 20 * Math.log10(Math.max(1e-6, g));

const finite = (v: number): number => (Number.isFinite(v) ? v : 0);

// ---------------------------------------------------------------------------
// AudioParam helpers
//
// Every one of these guards against non-finite values. A single NaN reaching an
// AudioParam throws, and a throw inside the frame loop takes the whole game
// down — audio must never be able to do that.
// ---------------------------------------------------------------------------

export function pSet(p: AudioParam, v: number, t: number): void {
  try { p.setValueAtTime(finite(v), Math.max(0, t)); } catch { /* param busy */ }
}

export function pLin(p: AudioParam, v: number, t: number): void {
  try { p.linearRampToValueAtTime(finite(v), Math.max(0, t)); } catch { /* ignore */ }
}

/**
 * Exponential ramps are what ears actually hear as "a decay", but they cannot
 * touch zero. We floor at -80 dB and rely on the caller to follow with a linear
 * ramp to true zero if the node needs to be silent (see 'pFadeOut').
 */
export function pExp(p: AudioParam, v: number, t: number): void {
  try { p.exponentialRampToValueAtTime(Math.max(1e-4, finite(v)), Math.max(0, t)); } catch { /* ignore */ }
}

/** One-pole approach — the cheapest way to track a continuously varying value. */
export function pGlide(p: AudioParam, v: number, t: number, tau: number): void {
  try { p.setTargetAtTime(finite(v), Math.max(0, t), Math.max(0.001, tau)); } catch { /* ignore */ }
}

export function pCancel(p: AudioParam, t: number): void {
  try {
    // cancelAndHoldAtTime keeps the *current* value instead of snapping back to
    // the last scheduled one, which is the difference between a clean fade and
    // an audible step.
    const any = p as unknown as { cancelAndHoldAtTime?: (t: number) => void };
    if (any.cancelAndHoldAtTime) any.cancelAndHoldAtTime(Math.max(0, t));
    else p.cancelScheduledValues(Math.max(0, t));
  } catch { /* ignore */ }
}

/** Cancel, hold, then ramp to silence. The only sanctioned way to stop a gain. */
export function pFadeOut(p: AudioParam, t: number, dur: number): void {
  pCancel(p, t);
  pLin(p, 0, t + Math.max(0.004, dur));
}

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

export type NoiseKind = 'white' | 'pink' | 'brown';

function fillNoise(out: Float32Array, kind: NoiseKind, rng: Rng): void {
  const n = out.length;
  if (kind === 'white') {
    for (let i = 0; i < n; i++) out[i] = rng.next() * 2 - 1;
    return;
  }
  if (kind === 'pink') {
    // Paul Kellet's economical pink filter: a parallel bank of one-poles whose
    // corner frequencies are spaced by roughly a decade, summing to −3 dB/oct
    // to within 0.05 dB across the audio band. Pink is the correct spectrum for
    // airflow and distant rumble; white noise always sounds like a hiss.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = rng.next() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    return;
  }
  // Brown (−6 dB/oct). A pure integrator random-walks away from zero and ends
  // up as a slow DC ramp that eats limiter headroom, so the integrator leaks.
  let last = 0;
  for (let i = 0; i < n; i++) {
    last = last * 0.9965 + (rng.next() * 2 - 1) * 0.05;
    out[i] = last;
  }
  removeDc(out);
  normalize(out, 0.85);
}

function removeDc(a: Float32Array): void {
  let mean = 0;
  for (let i = 0; i < a.length; i++) mean += a[i];
  mean /= a.length || 1;
  for (let i = 0; i < a.length; i++) a[i] -= mean;
}

function normalize(a: Float32Array, peak: number): void {
  let m = 0;
  for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > m) m = v; }
  if (m < 1e-9) return;
  const s = peak / m;
  for (let i = 0; i < a.length; i++) a[i] *= s;
}

const bufferCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();

function cached(ac: BaseAudioContext, key: string, make: () => AudioBuffer): AudioBuffer {
  let m = bufferCache.get(ac);
  if (!m) { m = new Map(); bufferCache.set(ac, m); }
  const hit = m.get(key);
  if (hit) return hit;
  const b = make();
  m.set(key, b);
  return b;
}

/**
 * A loop-safe noise buffer. The last 'xfade' seconds are cross-faded (equal
 * power) into the first, so playing it with 'loop = true' produces no click and
 * no periodic "whoomph" at the seam.
 */
export function noiseBuffer(
  ac: BaseAudioContext, kind: NoiseKind, seconds = 2.2, seed = 1, channels = 2,
): AudioBuffer {
  return cached(ac, `noise|${kind}|${seconds}|${seed}|${channels}`, () => {
    const sr = ac.sampleRate;
    const n = Math.max(256, Math.floor(sr * seconds));
    const xf = Math.min(Math.floor(sr * 0.05), n >> 2);
    const buf = ac.createBuffer(channels, n, sr);
    const tmp = new Float32Array(n + xf);
    for (let ch = 0; ch < channels; ch++) {
      fillNoise(tmp, kind, new Rng(seed * 7919 + ch * 104729 + 13));
      const d = buf.getChannelData(ch);
      d.set(tmp.subarray(0, n));
      for (let i = 0; i < xf; i++) {
        const t = i / xf;
        const a = Math.cos(t * Math.PI * 0.5);   // outgoing tail material
        const b = Math.sin(t * Math.PI * 0.5);   // incoming head material
        d[i] = tmp[i] * b + tmp[n + i] * a;
      }
    }
    return buf;
  });
}

/**
 * Velvet noise: sparse ±1 impulses, one per period, at a random offset inside
 * that period. Perceptually smoother than white noise for the same density and
 * far better for rattles and debris, where you want discrete grains rather than
 * a wall of hiss.
 */
export function velvetBuffer(
  ac: BaseAudioContext, seconds: number, density: number, seed = 5,
): AudioBuffer {
  return cached(ac, `velvet|${seconds}|${density}|${seed}`, () => {
    const sr = ac.sampleRate;
    const n = Math.max(64, Math.floor(sr * seconds));
    const buf = ac.createBuffer(2, n, sr);
    const period = Math.max(2, Math.floor(sr / Math.max(1, density)));
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      const rng = new Rng(seed * 2654435761 + ch * 40503 + 7);
      for (let base = 0; base + period < n; base += period) {
        const i = base + rng.int(period);
        d[i] = rng.next() < 0.5 ? -1 : 1;
      }
    }
    return buf;
  });
}

/**
 * Band-limited smooth random, used as a control signal (an LFO with no
 * discernible period). Cosine-interpolated between control points, and the last
 * control point equals the first so the buffer loops without a step.
 */
export function smoothRandomBuffer(
  ac: BaseAudioContext, seconds: number, hz: number, seed = 9, channels = 1,
): AudioBuffer {
  return cached(ac, `srand|${seconds}|${hz}|${seed}|${channels}`, () => {
    const sr = ac.sampleRate;
    const n = Math.max(64, Math.floor(sr * seconds));
    const step = Math.max(2, Math.floor(sr / Math.max(0.05, hz)));
    const points = Math.max(2, Math.ceil(n / step) + 1);
    const buf = ac.createBuffer(channels, n, sr);
    for (let ch = 0; ch < channels; ch++) {
      const rng = new Rng(seed * 22695477 + ch * 8191 + 3);
      const cp = new Float32Array(points);
      for (let i = 0; i < points; i++) cp[i] = rng.next() * 2 - 1;
      cp[points - 1] = cp[0];
      const d = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) {
        const f = i / step;
        const i0 = Math.min(points - 2, Math.floor(f));
        const t = f - i0;
        const s = (1 - Math.cos(t * Math.PI)) * 0.5;
        d[i] = cp[i0] * (1 - s) + cp[i0 + 1] * s;
      }
    }
    return buf;
  });
}

// ---------------------------------------------------------------------------
// Reverb impulse responses
// ---------------------------------------------------------------------------

export interface IrOptions {
  seconds: number;
  /** Exponential decay rate: RT60 ≈ 6.9 / decay. */
  decay: number;
  /** 0 = bright tail, 1 = tail goes dark fast (absorption). */
  damping: number;
  predelay: number;
  /** Discrete early reflections in the first 80 ms — this is what tells the ear
   *  how big the space is. Without them a convolution reverb sounds like fog. */
  early: number;
  seed: number;
}

export function impulseResponse(ac: BaseAudioContext, o: IrOptions): AudioBuffer {
  return cached(ac, `ir|${o.seconds}|${o.decay}|${o.damping}|${o.predelay}|${o.early}|${o.seed}`, () => {
    const sr = ac.sampleRate;
    const n = Math.max(64, Math.floor(sr * o.seconds));
    const pre = Math.floor(sr * o.predelay);
    const buf = ac.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      const rng = new Rng(o.seed * 1103515245 + ch * 12345 + 1);
      let lp = 0;
      for (let i = pre; i < n; i++) {
        const t = (i - pre) / sr;
        const env = Math.exp(-o.decay * t);
        // The one-pole coefficient shrinks with time, so late energy is dull
        // and early energy is bright — exactly what air and soft furnishings do.
        const a = clamp(1 - o.damping * (1 - Math.exp(-t * 1.6)), 0.03, 1);
        lp += ((rng.next() * 2 - 1) - lp) * a;
        d[i] = lp * env;
      }
      for (let k = 0; k < o.early; k++) {
        const tap = pre + Math.floor(rng.range(0.004, 0.075) * sr);
        if (tap < n) d[tap] += (rng.next() < 0.5 ? -1 : 1) * rng.range(0.25, 0.8) * Math.exp(-k * 0.22);
      }
      removeDc(d);
      normalize(d, 0.7);
    }
    return buf;
  });
}

// ---------------------------------------------------------------------------
// WaveShaper curves
// ---------------------------------------------------------------------------

/**
 * Exactly the array flavour 'WaveShaperNode.curve' accepts. Derived from the
 * DOM type rather than written out, so it keeps working across TypeScript's
 * typed-array generic changes.
 */
export type ShaperCurve = NonNullable<WaveShaperNode['curve']>;

const curveCache = new Map<string, ShaperCurve>();

function curve(key: string, n: number, fn: (x: number) => number): ShaperCurve {
  const hit = curveCache.get(key);
  if (hit) return hit;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = fn((i / (n - 1)) * 2 - 1);
  curveCache.set(key, c);
  return c;
}

/**
 * Turns a sine into a narrow unipolar pulse, 'sharp' controlling the duty.
 *
 * This is the trick that makes engine crackle affordable: instead of scheduling
 * one node per cylinder firing (300 events per second per aircraft), a single
 * oscillator runs through this curve and the result modulates a noise gain at
 * audio rate. One steady graph, per-cylinder detail.
 */
export function pulseCurve(sharp: number, n = 2048): ShaperCurve {
  return curve(`pulse|${sharp}|${n}`, n, (x) => (x <= 0 ? 0 : Math.pow(x, sharp)));
}

/** Symmetric soft clip. Final safety net after the limiter. */
export function softClipCurve(drive = 1.6, n = 4096): ShaperCurve {
  return curve(`soft|${drive}|${n}`, n, (x) => Math.tanh(x * drive) / Math.tanh(drive));
}

/**
 * Radio-set distortion: asymmetric, with a hard knee. Asymmetry generates even
 * harmonics, which is what makes a valve set sound "warm and broken" instead of
 * merely clipped.
 */
export function radioCurve(n = 2048): ShaperCurve {
  return curve(`radio|${n}`, n, (x) => {
    const y = x >= 0 ? Math.tanh(x * 3.2) : Math.tanh(x * 2.1) * 0.86;
    return clamp(y * 0.9 + x * 0.1, -1, 1);
  });
}

// ---------------------------------------------------------------------------
// Periodic waves
// ---------------------------------------------------------------------------

const waveCache = new WeakMap<BaseAudioContext, Map<string, PeriodicWave>>();

/**
 * Builds a PeriodicWave from a harmonic amplitude table.
 *
 * Phases are Schroeder phases (φ_k = −π k² / K). Stacking harmonics all in sine
 * phase piles every peak on top of the others and produces a waveform with a
 * crest factor of ~K; Schroeder phases spread the energy across the period and
 * bring it back near √2, which means the engine can be 6 dB louder before the
 * limiter starts working. It also removes the "buzzy sawtooth" quality that
 * in-phase stacks always have.
 */
export function harmonicWave(ac: BaseAudioContext, name: string, amps: readonly number[]): PeriodicWave {
  let m = waveCache.get(ac);
  if (!m) { m = new Map(); waveCache.set(ac, m); }
  const hit = m.get(name);
  if (hit) return hit;
  const K = amps.length + 1;
  const real = new Float32Array(K);
  const imag = new Float32Array(K);
  for (let k = 1; k < K; k++) {
    const a = amps[k - 1];
    const phase = -Math.PI * k * k / (K - 1);
    real[k] = a * Math.cos(phase);
    imag[k] = a * Math.sin(phase);
  }
  const w = ac.createPeriodicWave(real, imag, { disableNormalization: false });
  m.set(name, w);
  return w;
}

// ---------------------------------------------------------------------------
// Atmosphere
// ---------------------------------------------------------------------------

/** ISA density, kg/m³. Drives indicated airspeed and hence every airflow layer. */
export function airDensity(alt: number): number {
  const h = Math.max(0, alt);
  if (h < 11000) return 1.225 * Math.pow(1 - 2.25577e-5 * h, 4.25588);
  return 0.36391 * Math.exp(-(h - 11000) / 6341.6);
}

/** Equivalent (indicated) airspeed from true airspeed at altitude. */
export function indicatedAirspeed(tas: number, alt: number): number {
  return tas * Math.sqrt(airDensity(alt) / 1.225);
}

/**
 * High-frequency loss over distance. Real atmospheric absorption is ~0.5 dB per
 * 100 m at 8 kHz and negligible at 200 Hz; a single tracking lowpass reproduces
 * the perceptual result convincingly and costs one biquad.
 */
export function airAbsorptionCutoff(distance: number): number {
  return clamp(19000 * Math.exp(-Math.max(0, distance) / 1500) + 420, 380, 20000);
}

/** Seconds for sound to travel 'distance' metres. */
export const arrivalDelay = (distance: number): number => Math.max(0, distance) / SPEED_OF_SOUND;

export { clamp };
