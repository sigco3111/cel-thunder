/**
 * Procedural menu score.
 *
 * Brief: short, moody, loopable, and gone the moment the player is flying.
 *
 * The material is deliberately thin — a D natural-minor chord bed, a low drone,
 * a sparse motif and a very quiet air bed — because anything busier fights the
 * engine when the two overlap during the spawn transition, and because a
 * four-chord loop that a player hears fifty times must not be memorable in the
 * wrong way.
 *
 * Two details do most of the work:
 *  - Every pad note is three detuned oscillators at ±7 cents. That much detune
 *    beats slowly enough to sound like an ensemble rather than a chorus effect,
 *    and it is the difference between "synth pad" and "strings".
 *  - The motif is played into a feedback delay tuned to a dotted eighth of the
 *    chord length, so single notes turn into a receding pattern and the texture
 *    stays sparse while sounding full.
 *
 * Nodes are created per chord and destroyed when the chord releases, so the
 * whole score idles at about twenty nodes and costs nothing when ducked out.
 */

import { Rng } from '../shared/math';
import { AudioGraph, killNodes, stopSources } from './AudioGraph';
import { noiseBuffer, pExp, pLin, pSet, pGlide } from './dsp';

/** i – VI – III – v in D natural minor. Semitones above D. */
const PROGRESSION: ReadonlyArray<readonly number[]> = [
  [0, 3, 7, 14],    // Dm(add9)
  [-4, 3, 7, 12],   // B♭maj7 over D
  [-7, 0, 5, 12],   // F
  [-5, 2, 7, 10],   // Am7
];

/** D natural minor, one octave, used by the motif. */
const SCALE = [0, 2, 3, 5, 7, 8, 10, 12];

const D3 = 146.83;
const midi = (semis: number, base = D3) => base * Math.pow(2, semis / 12);

const CHORD_SECONDS = 6.4;

export class Music {
  private readonly graph: AudioGraph;
  private readonly ac: AudioContext;
  private readonly rng = new Rng(20260803);

  private readonly out: GainNode;
  private readonly padBus: GainNode;
  private readonly padFilter: BiquadFilterNode;
  private readonly motifBus: GainNode;
  private readonly delay: DelayNode;
  private readonly feedback: GainNode;
  private readonly airGain: GainNode;
  private readonly nodes: AudioNode[] = [];
  private readonly persistentSources: AudioScheduledSourceNode[] = [];

  private droneA: OscillatorNode | null = null;
  private droneB: OscillatorNode | null = null;

  private playing = false;
  private started = false;
  private nextChordAt = 0;
  private chordIndex = 0;
  private nextMotifAt = 0;
  private dead = false;

  constructor(graph: AudioGraph) {
    this.graph = graph;
    this.ac = graph.ac;
    const ac = this.ac;

    this.out = ac.createGain();
    this.out.gain.value = 0;
    this.out.connect(graph.bus.music);

    this.padFilter = ac.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 900;
    this.padFilter.Q.value = 0.8;
    this.padFilter.connect(this.out);

    this.padBus = ac.createGain();
    this.padBus.gain.value = 0.32;
    this.padBus.connect(this.padFilter);

    // Motif delay: 3/8 of a chord. Long enough to be a space, short enough to
    // still be rhythmically related to the harmony underneath.
    this.delay = ac.createDelay(4);
    this.delay.delayTime.value = CHORD_SECONDS * 0.375;
    this.feedback = ac.createGain();
    this.feedback.gain.value = 0.34;
    const damp = ac.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2200;
    this.delay.connect(damp);
    damp.connect(this.feedback);
    this.feedback.connect(this.delay);

    this.motifBus = ac.createGain();
    this.motifBus.gain.value = 0.22;
    this.motifBus.connect(this.out);
    this.motifBus.connect(this.delay);
    this.delay.connect(this.out);

    // Air bed: barely perceptible, but its absence makes the mix feel like a
    // dead studio rather than a room.
    const air = ac.createBufferSource();
    air.buffer = noiseBuffer(ac, 'pink', 2.6, 2);
    air.loop = true;
    air.playbackRate.value = 0.6;
    const airLp = ac.createBiquadFilter();
    airLp.type = 'lowpass';
    airLp.frequency.value = 480;
    this.airGain = ac.createGain();
    this.airGain.gain.value = 0.035;
    air.connect(airLp); airLp.connect(this.airGain); this.airGain.connect(this.out);
    this.persistentSources.push(air);

    this.nodes.push(this.out, this.padFilter, this.padBus, this.delay, damp,
      this.feedback, this.motifBus, air, airLp, this.airGain);
  }

  private ensureStarted(): void {
    if (this.started || this.ac.state !== 'running') return;
    this.started = true;
    const t = this.graph.now;
    for (const s of this.persistentSources) { try { s.start(t); } catch { /* already */ } }

    // Tonic drone, two octaves apart with a slow beat between them.
    const a = this.ac.createOscillator();
    a.type = 'sine';
    a.frequency.value = midi(0, D3 / 2);
    const b = this.ac.createOscillator();
    b.type = 'triangle';
    b.frequency.value = midi(0, D3 / 4);
    b.detune.value = 4;
    const g = this.ac.createGain();
    g.gain.value = 0.13;
    a.connect(g); b.connect(g); g.connect(this.out);
    this.nodes.push(a, b, g);
    this.persistentSources.push(a, b);
    try { a.start(t); b.start(t); } catch { /* ignore */ }
    this.droneA = a; this.droneB = b;

    this.nextChordAt = t + 0.05;
    this.nextMotifAt = t + 2.0;
  }

  /** Fade in (menu) or out (in flight). Idempotent. */
  setPlaying(on: boolean): void {
    if (this.dead || this.playing === on) return;
    this.playing = on;
    const t = this.graph.now;
    pLin(this.out.gain, on ? 1 : 0, t + (on ? 1.6 : 1.1));
  }

  update(): void {
    if (this.dead) return;
    this.ensureStarted();
    if (!this.started || !this.playing) return;

    const t = this.graph.now;
    // Schedule a little ahead of the clock so nothing depends on frame timing.
    if (t + 0.25 >= this.nextChordAt) {
      this.chord(this.nextChordAt);
      this.nextChordAt += CHORD_SECONDS;
      if (this.nextChordAt < t) this.nextChordAt = t + CHORD_SECONDS;
    }
    if (t + 0.25 >= this.nextMotifAt) {
      this.motif(this.nextMotifAt);
      // Sparse and irregular: between one and three bars of silence.
      this.nextMotifAt += CHORD_SECONDS * this.rng.range(0.45, 1.6);
      if (this.nextMotifAt < t) this.nextMotifAt = t + 1.5;
    }
  }

  private chord(when: number): void {
    const ac = this.ac;
    const notes = PROGRESSION[this.chordIndex % PROGRESSION.length];
    this.chordIndex++;

    const local: AudioNode[] = [];
    const srcs: OscillatorNode[] = [];
    const g = ac.createGain();
    g.gain.value = 0;
    g.connect(this.padBus);
    local.push(g);

    for (let i = 0; i < notes.length; i++) {
      const f = midi(notes[i]);
      // The top voice is quieter: keeps the chord from sounding top-heavy as
      // the lowpass opens.
      const amp = 0.28 / (1 + i * 0.35);
      for (let d = -1; d <= 1; d++) {
        const o = ac.createOscillator();
        o.type = d === 0 ? 'triangle' : 'sawtooth';
        o.frequency.value = f;
        o.detune.value = d * 7;
        const og = ac.createGain();
        og.gain.value = d === 0 ? amp : amp * 0.36;
        o.connect(og); og.connect(g);
        local.push(o, og);
        srcs.push(o);
      }
    }

    // Long attack and release with a generous overlap, so chords bleed into one
    // another rather than stepping.
    const atk = 1.9, rel = 2.3;
    pSet(g.gain, 0, when);
    pLin(g.gain, 1, when + atk);
    pSet(g.gain, 1, when + CHORD_SECONDS - rel * 0.4);
    pExp(g.gain, 0.0008, when + CHORD_SECONDS + rel);
    const end = when + CHORD_SECONDS + rel + 0.05;
    pLin(g.gain, 0, end);

    // The filter breathes with the chord — a slow swell, not a wobble.
    //
    // The swell has to *close inside the chord period*. Ramping the return out
    // to (when + CHORD_SECONDS + rel) overruns the next chord by rel seconds,
    // and the next chord's setValueAtTime(620) then lands in the middle of a
    // ramp that is still passing through ~1030 Hz — an instantaneous 1030 → 620
    // step, every 6.4 s, for as long as the menu is open. Peak at 0.42 of the
    // period and be back at the floor exactly on the boundary.
    pSet(this.padFilter.frequency, 620, when);
    pLin(this.padFilter.frequency, 1450, when + CHORD_SECONDS * 0.42);
    pLin(this.padFilter.frequency, 620, when + CHORD_SECONDS);

    let remaining = srcs.length;
    const done = () => { if (--remaining <= 0) killNodes(local); };
    for (const o of srcs) {
      o.onended = done;
      try { o.start(when); o.stop(end + 0.02); } catch { /* ignore */ }
    }
  }

  private motif(when: number): void {
    const ac = this.ac;
    // Sit the motif above the pad so it reads as a separate voice.
    const deg = SCALE[this.rng.int(SCALE.length)];
    const f = midi(deg + 12);

    const o = ac.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f * 2;
    bp.Q.value = 1.6;
    const g = ac.createGain();
    g.gain.value = 0;
    o.connect(bp); bp.connect(g); g.connect(this.motifBus);

    const decay = this.rng.range(1.1, 2.2);
    pSet(g.gain, 0, when);
    pLin(g.gain, 0.5, when + 0.012);
    pExp(g.gain, 0.0006, when + decay);
    const end = when + decay + 0.03;
    pLin(g.gain, 0, end);

    o.onended = () => killNodes([o, bp, g]);
    try { o.start(when); o.stop(end + 0.02); } catch { /* ignore */ }
  }

  setLevel(v: number): void {
    pGlide(this.out.gain, this.playing ? v : 0, this.graph.now, 0.2);
  }

  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    const t = this.graph.now;
    pLin(this.out.gain, 0, t + 0.2);
    stopSources(this.persistentSources, t + 0.3);
    setTimeout(() => {
      killNodes(this.nodes);
      this.nodes.length = 0;
      this.persistentSources.length = 0;
      this.droneA = null; this.droneB = null;
    }, 500);
  }
}
