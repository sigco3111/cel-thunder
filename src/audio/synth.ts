/**
 * One-shot voice construction.
 *
 * Every transient sound in the game — a gunshot, an impact, a debris rattle, a
 * UI click — is assembled from the same three primitives:
 *
 *   'noiseBurst'  filtered noise with an amplitude envelope (the *body*)
 *   'toneSweep'   a pitched element, usually swept (the *weight*)
 *   'modalRing'   parallel high-Q resonators struck by a short excitation
 *                 (the *material*: what the thing is made of)
 *
 * Any real-world impulsive sound decomposes into those three. A .303 round
 * striking an aluminium skin is a 3 ms noise transient, no pitched weight and a
 * violent modal ring at 1.1/2.7/4.3 kHz. A 20 mm cannon firing is a big noise
 * body, a 110 Hz pitch-swept weight and almost no ring. Getting the proportions
 * right is what separates these from beeps.
 *
 * The 'OneShot' wrapper exists so that all of them share exactly one lifetime
 * policy: register with the voice pool, fade rather than stop, and disconnect
 * every node the moment the last source ends so the graph never grows.
 */

import { AudioGraph, killNodes } from './AudioGraph';
import type { Voice } from './VoicePool';
import { noiseBuffer, velvetBuffer, pExp, pLin, pSet, pCancel, clamp, type NoiseKind } from './dsp';

/** A pooled, self-cleaning bundle of nodes with a single output gain. */
export class OneShot implements Voice {
  readonly id: number;
  readonly graph: AudioGraph;
  readonly out: GainNode;
  priority: number;
  loudness: number;
  endsAt = 0;
  readonly persistent = false;

  private readonly nodes: AudioNode[] = [];
  private readonly srcs: Array<{ s: AudioScheduledSourceNode; stopAt: number }> = [];
  private readonly extras: Array<{ dispose(): void }> = [];
  private dead = false;
  private registered = false;

  constructor(graph: AudioGraph, dest: AudioNode, priority: number, loudness: number) {
    this.graph = graph;
    this.id = graph.pool.allocId();
    this.priority = priority;
    this.loudness = loudness;
    this.out = graph.ac.createGain();
    this.out.connect(dest);
    this.nodes.push(this.out);
  }

  get ac(): AudioContext { return this.graph.ac; }

  node<T extends AudioNode>(n: T): T { this.nodes.push(n); return n; }

  /** Tie an owned helper (e.g. a SpatialSource) to this voice's lifetime. */
  attach(d: { dispose(): void }): void { this.extras.push(d); }

  source<T extends AudioScheduledSourceNode>(s: T, startAt: number, stopAt: number): T {
    this.nodes.push(s);
    this.srcs.push({ s, stopAt });
    try { s.start(Math.max(0, startAt)); } catch { /* already started */ }
    return s;
  }

  /** Buffer sources want a random read offset — free variation, zero cost. */
  bufferSource(
    buf: AudioBuffer, startAt: number, stopAt: number, rate = 1, loop = true, offset = -1,
  ): AudioBufferSourceNode {
    const s = this.ac.createBufferSource();
    s.buffer = buf;
    s.loop = loop;
    s.playbackRate.value = rate;
    const off = offset >= 0 ? offset : Math.random() * Math.max(0.001, buf.duration - 0.06);
    this.nodes.push(s);
    this.srcs.push({ s, stopAt });
    try { s.start(Math.max(0, startAt), off); } catch { /* already started */ }
    return s;
  }

  /** Call once the graph is built; arms cleanup and joins the voice pool. */
  commit(endsAt: number): void {
    this.endsAt = endsAt + 0.02;
    let remaining = this.srcs.length;
    const done = () => { if (--remaining <= 0) this.destroy(); };
    for (const e of this.srcs) {
      e.s.onended = done;
      try { e.s.stop(Math.max(0, e.stopAt)); } catch { /* already scheduled */ }
    }
    if (remaining === 0) { this.destroy(); return; }
    this.registered = true;
    this.graph.pool.add(this);
  }

  release(fade: number): void {
    if (this.dead) return;
    const t = this.graph.now;
    pCancel(this.out.gain, t);
    pLin(this.out.gain, 0, t + Math.max(0.005, fade));
    for (const e of this.srcs) {
      const at = t + fade + 0.01;
      if (at < e.stopAt) { e.stopAt = at; try { e.s.stop(at); } catch { /* ignore */ } }
    }
  }

  private destroy(): void {
    if (this.dead) return;
    this.dead = true;
    if (this.registered) this.graph.pool.remove(this);
    killNodes(this.nodes);
    for (const d of this.extras) { try { d.dispose(); } catch { /* already gone */ } }
    this.nodes.length = 0;
    this.srcs.length = 0;
    this.extras.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/**
 * Percussive envelope: linear attack (so it starts from true zero and cannot
 * click), exponential decay (so it *sounds* like a decay), then a short linear
 * run to true zero so nothing is left holding a −80 dB DC value.
 */
export function envPercussive(
  p: AudioParam, when: number, peak: number, attack: number, decay: number,
): number {
  const a = Math.max(0.0005, attack);
  const d = Math.max(0.004, decay);
  pSet(p, 0, when);
  pLin(p, Math.max(1e-4, peak), when + a);
  pExp(p, Math.max(1e-4, peak) * 1e-3, when + a + d);
  const end = when + a + d + 0.006;
  pLin(p, 0, end);
  return end;
}

/** Sustained envelope with an explicit hold — used for gun tails and rumbles. */
export function envAdsr(
  p: AudioParam, when: number, peak: number, attack: number, hold: number, decay: number,
): number {
  const a = Math.max(0.0005, attack);
  const h = Math.max(0, hold);
  const d = Math.max(0.005, decay);
  const pk = Math.max(1e-4, peak);
  pSet(p, 0, when);
  pLin(p, pk, when + a);
  pSet(p, pk, when + a + h);
  pExp(p, pk * 1e-3, when + a + h + d);
  const end = when + a + h + d + 0.006;
  pLin(p, 0, end);
  return end;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export interface NoiseBurstOpts {
  when: number;
  kind?: NoiseKind;
  /** Filter sweep. f1 defaults to f0 (static filter). */
  f0: number;
  f1?: number;
  type?: BiquadFilterType;
  Q?: number;
  gain: number;
  attack?: number;
  decay: number;
  hold?: number;
  /** Playback rate on the noise buffer — shifts the grain size subtly. */
  rate?: number;
  /** Optional highpass in series, for clearing mud out of the low end. */
  hp?: number;
}

export function noiseBurst(os: OneShot, o: NoiseBurstOpts): number {
  const ac = os.ac;
  const kind = o.kind ?? 'white';
  const buf = noiseBuffer(ac, kind, kind === 'brown' ? 3.1 : kind === 'pink' ? 2.6 : 2.2,
    kind === 'brown' ? 3 : kind === 'pink' ? 2 : 1);
  const g = os.node(ac.createGain());
  g.gain.value = 0;

  const f = os.node(ac.createBiquadFilter());
  f.type = o.type ?? 'lowpass';
  f.Q.value = o.Q ?? 0.8;
  const f0 = clamp(o.f0, 20, 21000);
  const f1 = clamp(o.f1 ?? o.f0, 20, 21000);
  pSet(f.frequency, f0, o.when);
  if (Math.abs(f1 - f0) > 1) pExp(f.frequency, f1, o.when + (o.hold ?? 0) + o.decay);

  let tail: AudioNode = f;
  if (o.hp && o.hp > 20) {
    const hp = os.node(ac.createBiquadFilter());
    hp.type = 'highpass';
    hp.frequency.value = clamp(o.hp, 20, 20000);
    hp.Q.value = 0.7;
    f.connect(hp);
    tail = hp;
  }
  tail.connect(g);
  g.connect(os.out);

  const end = o.hold
    ? envAdsr(g.gain, o.when, o.gain, o.attack ?? 0.002, o.hold, o.decay)
    : envPercussive(g.gain, o.when, o.gain, o.attack ?? 0.002, o.decay);

  const src = os.bufferSource(buf, o.when, end + 0.01, o.rate ?? 1);
  src.connect(f);
  return end;
}

export interface ToneSweepOpts {
  when: number;
  type?: OscillatorType;
  f0: number;
  f1?: number;
  gain: number;
  attack?: number;
  decay: number;
  hold?: number;
  /** Sweep completes in this fraction of the total length (0..1). */
  sweepFrac?: number;
  detune?: number;
}

export function toneSweep(os: OneShot, o: ToneSweepOpts): number {
  const ac = os.ac;
  const osc = ac.createOscillator();
  osc.type = o.type ?? 'sine';
  if (o.detune) osc.detune.value = o.detune;
  const g = os.node(ac.createGain());
  g.gain.value = 0;
  osc.connect(g);
  g.connect(os.out);

  const total = (o.attack ?? 0.003) + (o.hold ?? 0) + o.decay;
  pSet(osc.frequency, clamp(o.f0, 8, 20000), o.when);
  if (o.f1 !== undefined && Math.abs(o.f1 - o.f0) > 0.5) {
    pExp(osc.frequency, clamp(o.f1, 8, 20000), o.when + total * clamp(o.sweepFrac ?? 0.85, 0.05, 1));
  }

  const end = o.hold
    ? envAdsr(g.gain, o.when, o.gain, o.attack ?? 0.003, o.hold, o.decay)
    : envPercussive(g.gain, o.when, o.gain, o.attack ?? 0.003, o.decay);
  os.source(osc, o.when, end + 0.01);
  return end;
}

export interface ModalRingOpts {
  when: number;
  /** Resonant mode frequencies. Inharmonic ratios read as metal. */
  freqs: readonly number[];
  /** Per-mode relative amplitude; defaults to a 1/n falloff. */
  amps?: readonly number[];
  Q: number;
  decay: number;
  gain: number;
  /** Length of the noise excitation that strikes the resonators. */
  excite?: number;
  spread?: number;
}

/**
 * Modal synthesis: a very short noise impulse driving parallel high-Q
 * bandpasses. The mode *ratios* are what the ear reads as material — integer
 * ratios sound like a tuned bell, the irrational ratios used here sound like
 * stressed sheet metal, which is exactly what an aircraft skin is.
 */
export function modalRing(os: OneShot, o: ModalRingOpts): number {
  const ac = os.ac;
  const sum = os.node(ac.createGain());
  sum.gain.value = 0;
  sum.connect(os.out);

  const exciteDur = o.excite ?? 0.0035;
  const ex = os.node(ac.createGain());
  ex.gain.value = 0;
  envPercussive(ex.gain, o.when, 1, 0.0004, exciteDur);
  const src = os.bufferSource(noiseBuffer(ac, 'white', 2.2, 1), o.when, o.when + exciteDur + 0.03);
  src.connect(ex);

  const n = o.freqs.length;
  for (let i = 0; i < n; i++) {
    const bp = os.node(ac.createBiquadFilter());
    bp.type = 'bandpass';
    bp.frequency.value = clamp(o.freqs[i] * (1 + (Math.random() - 0.5) * (o.spread ?? 0.03)), 30, 18000);
    bp.Q.value = Math.max(2, o.Q * (1 - i * 0.08));
    const gi = os.node(ac.createGain());
    gi.gain.value = o.amps?.[i] ?? 1 / (1 + i * 0.8);
    ex.connect(bp);
    bp.connect(gi);
    gi.connect(sum);
  }

  return envPercussive(sum.gain, o.when, o.gain, 0.0008, o.decay);
}

/** Sparse grain cloud — debris, shell casings, gravel. */
export function debrisRattle(
  os: OneShot, when: number, dur: number, gain: number, centre = 1400, density = 90,
): number {
  const ac = os.ac;
  const buf = velvetBuffer(ac, 2.0, density, 5);
  const bp = os.node(ac.createBiquadFilter());
  bp.type = 'bandpass';
  bp.frequency.value = clamp(centre, 80, 12000);
  bp.Q.value = 0.9;
  const g = os.node(ac.createGain());
  g.gain.value = 0;
  bp.connect(g);
  g.connect(os.out);
  // Debris does not start at full tilt: it ramps in as the first pieces land.
  const end = envAdsr(g.gain, when, gain, dur * 0.14, dur * 0.12, dur * 0.74);
  const src = os.bufferSource(buf, when, end + 0.01, 0.85 + Math.random() * 0.4);
  src.connect(bp);
  return end;
}
