/**
 * Radio callouts.
 *
 * There is no speech here — synthesised dialogue in 2 kB of code is a
 * guaranteed embarrassment. Instead the callout is *diegetic framing*: the
 * squelch opening, a short signalling tone, the squelch closing, all of it
 * squeezed through a 300 Hz–2.9 kHz band and a valve-set distortion. The player
 * reads the text on the HUD, but their ear has already been told "this came
 * over the R/T", and that is the entire job.
 *
 * The band limits are the real ones: WWII HF/VHF aircraft sets were voice-band
 * only, and the missing top and bottom octaves are most of what makes a signal
 * sound like it came down a wire.
 */

import type { AudioGraph } from './AudioGraph';
import { killNodes, stopSources } from './AudioGraph';
import { OneShot, envPercussive, noiseBurst, toneSweep } from './synth';
import { noiseBuffer, pGlide, radioCurve } from './dsp';

export type CalloutKind = 'friendly' | 'enemy' | 'warning' | 'command' | 'kill';

/** Two-tone signalling pairs. Rising = good news, falling = bad. */
const TONES: Record<CalloutKind, [number, number]> = {
  friendly: [740, 988],
  command: [622, 831],
  enemy: [880, 698],
  warning: [932, 622],
  kill: [988, 1319],
};

export class Radio {
  private readonly graph: AudioGraph;
  private readonly input: GainNode;
  private readonly staticGain: GainNode;
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private started = false;
  private dead = false;

  constructor(graph: AudioGraph) {
    this.graph = graph;
    const ac = graph.ac;

    const out = ac.createGain();
    out.gain.value = 0.9;
    out.connect(graph.bus.voice);

    const shaper = ac.createWaveShaper();
    shaper.curve = radioCurve();
    shaper.oversample = '2x';
    shaper.connect(out);

    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2900;
    lp.Q.value = 0.9;
    lp.connect(shaper);

    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 320;
    hp.Q.value = 0.9;
    hp.connect(lp);

    // A mid-band peak around 1.6 kHz is what gives a small speaker its nasal,
    // "cupped" character. Without it the band-limited signal just sounds muffled.
    const peak = ac.createBiquadFilter();
    peak.type = 'peaking';
    peak.frequency.value = 1650;
    peak.Q.value = 1.4;
    peak.gain.value = 7;
    peak.connect(hp);

    this.input = ac.createGain();
    this.input.gain.value = 1;
    this.input.connect(peak);

    // Carrier hiss, normally silent, opened by the squelch during a call.
    const noise = ac.createBufferSource();
    noise.buffer = noiseBuffer(ac, 'white', 2.2, 1);
    noise.loop = true;
    this.staticGain = ac.createGain();
    this.staticGain.gain.value = 0;
    noise.connect(this.staticGain);
    this.staticGain.connect(this.input);
    this.sources.push(noise);

    this.nodes.push(out, shaper, lp, hp, peak, this.input, this.staticGain, noise);
  }

  private ensureStarted(): void {
    if (this.started || this.graph.ac.state !== 'running') return;
    this.started = true;
    for (const s of this.sources) { try { s.start(this.graph.now); } catch { /* already */ } }
  }

  /** Squelch, two-tone signal, squelch. ~0.35 s total. */
  blip(kind: CalloutKind = 'friendly', volume = 1): void {
    if (this.dead) return;
    this.ensureStarted();
    if (!this.graph.pool.request(0.85, 1, this.graph.now)) return;

    const t = this.graph.now + 0.01;
    const [f0, f1] = TONES[kind];
    const os = new OneShot(this.graph, this.input, 0.85, 1);

    // Squelch opening: a burst of carrier noise as the receiver unmutes.
    let end = noiseBurst(os, {
      when: t, kind: 'white', f0: 1800, f1: 1100, type: 'bandpass', Q: 0.9,
      gain: 0.30 * volume, attack: 0.001, decay: 0.030,
    });

    const t1 = t + 0.035;
    const t2 = t1 + 0.062;
    end = Math.max(end, toneSweep(os, {
      when: t1, type: 'square', f0: f0, gain: 0.16 * volume, attack: 0.004, hold: 0.040, decay: 0.020,
    }));
    end = Math.max(end, toneSweep(os, {
      when: t2, type: 'square', f0: f1, gain: 0.16 * volume, attack: 0.004, hold: 0.048, decay: 0.030,
    }));

    // Squelch closing: the hiss swelling for a moment as the carrier drops.
    end = Math.max(end, noiseBurst(os, {
      when: t2 + 0.085, kind: 'white', f0: 2400, f1: 900, type: 'bandpass', Q: 0.8,
      gain: 0.22 * volume, attack: 0.006, decay: 0.070,
    }));
    os.commit(end);

    // Duck the standing hiss in behind the whole call.
    const g = this.staticGain.gain;
    envPercussive(g, t, 0.02 * volume, 0.02, 0.30);
  }

  /** A short burst of interference — used when a transmission is jammed/lost. */
  interference(volume = 1): void {
    if (this.dead) return;
    this.ensureStarted();
    if (!this.graph.pool.request(0.4, 1, this.graph.now)) return;
    const t = this.graph.now + 0.01;
    const os = new OneShot(this.graph, this.input, 0.4, 1);
    const end = noiseBurst(os, {
      when: t, kind: 'white', f0: 900, f1: 2600, type: 'bandpass', Q: 0.6,
      gain: 0.22 * volume, attack: 0.008, hold: 0.10, decay: 0.22,
    });
    os.commit(end);
  }

  setLevel(v: number): void {
    pGlide(this.input.gain, Math.max(0, v), this.graph.now, 0.05);
  }

  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    stopSources(this.sources, this.graph.now + 0.05);
    setTimeout(() => { killNodes(this.nodes); this.nodes.length = 0; this.sources.length = 0; }, 200);
  }
}
