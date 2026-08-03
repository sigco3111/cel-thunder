/**
 * Airflow over the airframe — the layer that tells the player how fast they are
 * going without looking at the instruments, and the one that warns them the
 * wing is about to stop flying.
 *
 * Everything here is driven by dynamic pressure q = ½ρV², not by true airspeed.
 * That is why the wind roar at 400 km/h on the deck is savage and the same
 * 400 km/h at 8000 m is a whisper: the air is thinner, so there is less of it
 * to make noise. Using indicated airspeed throughout gets this right for free.
 *
 * Five bands:
 *  - **roar**    brown noise under ~300 Hz: the fuselage pushing air aside.
 *  - **rush**    a resonant pink band that climbs from 220 Hz to 1.7 kHz — the
 *                slipstream over the canopy joint. The resonance is what makes
 *                it a *rush* rather than a hiss.
 *  - **whistle** a very narrow high band that only appears in a genuine dive.
 *                Aerodynamically it is flow separation at gun ports and gaps;
 *                dramatically it is the sound of exceeding your better
 *                judgement.
 *  - **buffet**  gear, flaps and airbrakes shedding turbulent wake, amplitude
 *                modulated at ~13 Hz.
 *  - **stall**   the wing root separating and beating the tailplane, a slower
 *                and much less regular ~9 Hz shudder. It starts several degrees
 *                of alpha *before* the break, which is the whole point: it is a
 *                warning, not a death rattle.
 */

import { clamp, smoothstep } from '../shared/math';
import { AudioGraph, killNodes, stopSources } from './AudioGraph';
import { noiseBuffer, pGlide, pLin, pSet, smoothRandomBuffer } from './dsp';

/**
 * Bus-relative trim for the whole airflow bed.
 *
 * The per-layer gains below are written as fractions of dynamic pressure so
 * they stay readable and physically meaningful; this single constant sets where
 * the whole bed sits in the mix. Airflow shares the cockpit bus with impacts,
 * servos and warnings, which must stay punchy, so the wind is trimmed here
 * rather than by pulling the bus down under all of them.
 *
 * Calibrated by measurement: at cruise the bed lands ~15 dB under the engine,
 * which is where it stops being noticed and starts being felt.
 */
const AIRFLOW_LEVEL = 2.6;

export interface AirflowInput {
  /** Indicated airspeed, m/s. */
  ias: number;
  /** Never-exceed IAS from the aircraft spec, m/s. */
  vne: number;
  /** Vertical speed, m/s (negative = descending). */
  vertical: number;
  /** Angle of attack and the wing's stall alpha, radians. */
  alpha: number;
  stallAlpha: number;
  gear: number;
  flaps: number;
  airbrake: number;
  interior: boolean;
  /** False when spectating or before spawn — everything fades out. */
  active: boolean;
  /**
   * Metres from the listener to the aircraft whose airstream this is.
   *
   * The bed is generated at the airframe and routed to the non-occluded cockpit
   * bus, which is right when your ears are in the cockpit and badly wrong the
   * moment they are not: flyby, orbit, kill-cam and the scripted screenshot
   * rigs all sit 20-200 m away, and without this the player hears full-level
   * canopy roar from outside the aeroplane.
   */
  listenerDistance?: number;
}

/**
 * Distance rolloff for the airstream bed.
 *
 * Unity inside about 4 m — head-in-the-cockpit and just outside the canopy are
 * acoustically the same place — then falling to nothing by ~45 m, which is
 * roughly where an aircraft's own boundary-layer noise stops being separable
 * from its engine. Squared rather than linear so the near band is generous and
 * the tail is quick.
 */
function airflowProximity(distance: number): number {
  if (!Number.isFinite(distance)) return 1;
  if (distance <= 4) return 1;
  if (distance >= 45) return 0;
  const t = 1 - (distance - 4) / 41;
  return t * t;
}

export class Airflow {
  private readonly graph: AudioGraph;
  private readonly ac: AudioContext;
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];

  private readonly master: GainNode;

  private roarLp!: BiquadFilterNode;
  private roarG!: GainNode;
  private rushBp!: BiquadFilterNode;
  private rushG!: GainNode;
  private whistleBp!: BiquadFilterNode;
  private whistleG!: GainNode;
  private buffetG!: GainNode;
  private buffetLp!: BiquadFilterNode;
  private stallG!: GainNode;
  private stallBp!: BiquadFilterNode;
  private stallLfo!: OscillatorNode;

  private started = false;
  private dead = false;

  /** 0..1 — exposed so the HUD can flash a stall warning in sync with the ear. */
  stallLevel = 0;

  constructor(graph: AudioGraph) {
    this.graph = graph;
    this.ac = graph.ac;
    const ac = this.ac;

    this.master = ac.createGain();
    this.master.gain.value = 0;
    // The airstream is modelled with its own interior/exterior EQ, so it goes on
    // the non-occluded cockpit bus rather than being filtered twice.
    this.master.connect(graph.bus.cockpit);
    this.nodes.push(this.master);

    this.build();
  }

  private g(v: number): GainNode {
    const n = this.ac.createGain();
    n.gain.value = v;
    this.nodes.push(n);
    return n;
  }

  private filter(type: BiquadFilterType, f: number, q: number): BiquadFilterNode {
    const n = this.ac.createBiquadFilter();
    n.type = type;
    n.frequency.value = f;
    n.Q.value = q;
    this.nodes.push(n);
    return n;
  }

  private noise(kind: 'white' | 'pink' | 'brown', rate = 1): AudioBufferSourceNode {
    const s = this.ac.createBufferSource();
    s.buffer = noiseBuffer(this.ac, kind, kind === 'brown' ? 3.1 : kind === 'pink' ? 2.6 : 2.2,
      kind === 'brown' ? 3 : kind === 'pink' ? 2 : 1);
    s.loop = true;
    s.playbackRate.value = rate;
    this.nodes.push(s);
    this.sources.push(s);
    return s;
  }

  private build(): void {
    const ac = this.ac;

    // --- fuselage roar -----------------------------------------------------
    const roar = this.noise('brown', 0.9);
    this.roarLp = this.filter('lowpass', 140, 0.8);
    this.roarG = this.g(0);
    roar.connect(this.roarLp); this.roarLp.connect(this.roarG); this.roarG.connect(this.master);

    // --- slipstream rush ---------------------------------------------------
    const rush = this.noise('pink', 1);
    this.rushBp = this.filter('bandpass', 400, 1.05);
    this.rushG = this.g(0);
    rush.connect(this.rushBp); this.rushBp.connect(this.rushG); this.rushG.connect(this.master);

    // --- dive whistle ------------------------------------------------------
    const wh = this.noise('white', 1);
    this.whistleBp = this.filter('bandpass', 2400, 14);
    this.whistleG = this.g(0);
    wh.connect(this.whistleBp); this.whistleBp.connect(this.whistleG); this.whistleG.connect(this.master);

    // --- gear / flap buffet ------------------------------------------------
    const bf = this.noise('brown', 1.1);
    this.buffetLp = this.filter('lowpass', 260, 1.4);
    const bfAm = this.g(0.55);
    const bfLfo = ac.createOscillator();
    bfLfo.type = 'sine';
    bfLfo.frequency.value = 13;
    const bfLfoG = this.g(0.42);
    bfLfo.connect(bfLfoG); bfLfoG.connect(bfAm.gain);
    this.nodes.push(bfLfo); this.sources.push(bfLfo);
    // Irregularity on top of the periodic component, otherwise it sounds like a
    // tremolo pedal rather than turbulent flow.
    const bfRand = ac.createBufferSource();
    bfRand.buffer = smoothRandomBuffer(ac, 3.3, 22, 41);
    bfRand.loop = true;
    const bfRandG = this.g(0.3);
    bfRand.connect(bfRandG); bfRandG.connect(bfAm.gain);
    this.nodes.push(bfRand); this.sources.push(bfRand);
    this.buffetG = this.g(0);
    bf.connect(this.buffetLp); this.buffetLp.connect(bfAm); bfAm.connect(this.buffetG);
    this.buffetG.connect(this.master);

    // --- stall shudder -----------------------------------------------------
    const st = this.noise('brown', 0.8);
    this.stallBp = this.filter('lowpass', 190, 2.2);
    const stAm = this.g(0.55);
    this.stallLfo = ac.createOscillator();
    this.stallLfo.type = 'triangle';
    this.stallLfo.frequency.value = 9;
    const stLfoG = this.g(0.42);
    this.stallLfo.connect(stLfoG); stLfoG.connect(stAm.gain);
    this.nodes.push(this.stallLfo); this.sources.push(this.stallLfo);
    const stRand = ac.createBufferSource();
    stRand.buffer = smoothRandomBuffer(ac, 4.7, 11, 59);
    stRand.loop = true;
    const stRandG = this.g(0.25);
    stRand.connect(stRandG); stRandG.connect(stAm.gain);
    this.nodes.push(stRand); this.sources.push(stRand);
    this.stallG = this.g(0);
    st.connect(this.stallBp); this.stallBp.connect(stAm); stAm.connect(this.stallG);
    this.stallG.connect(this.master);
  }

  /** Sources are only started once the context is actually running. */
  private ensureStarted(): void {
    if (this.started || this.graph.ac.state !== 'running') return;
    this.started = true;
    const t = this.graph.now;
    for (const s of this.sources) { try { s.start(t); } catch { /* already started */ } }
    pSet(this.master.gain, 0, t);
    pLin(this.master.gain, AIRFLOW_LEVEL, t + 0.3);
  }

  update(i: AirflowInput): void {
    if (this.dead) return;
    this.ensureStarted();
    if (!this.started) return;

    const t = this.graph.now;
    if (!i.active) {
      pGlide(this.master.gain, 0, t, 0.25);
      this.stallLevel = 0;
      return;
    }
    const prox = airflowProximity(i.listenerDistance ?? 0);
    if (prox <= 0.001) {
      pGlide(this.master.gain, 0, t, 0.25);
      this.stallLevel = 0;
      return;
    }
    pGlide(this.master.gain, AIRFLOW_LEVEL * prox, t, 0.25);

    const vne = Math.max(50, i.vne);
    const iasN = clamp(i.ias / vne, 0, 1.35);
    // Acoustic power of turbulent flow rises far faster than linearly; q (≈ V²)
    // with a little extra exponent matches how violent it feels in the cockpit.
    const q = Math.pow(iasN, 2.15);
    // A closed canopy is a good low-pass and a mediocre attenuator: you lose the
    // hiss but keep the roar.
    const inCockpit = i.interior ? 1 : 0;
    const tau = 0.09;

    pGlide(this.roarLp.frequency, clamp(70 + 250 * iasN, 40, 500), t, tau);
    pGlide(this.roarG.gain, q * (0.42 + 0.28 * inCockpit), t, tau);

    pGlide(this.rushBp.frequency, clamp(220 + 1500 * iasN, 150, 4000), t, tau);
    pGlide(this.rushBp.Q, 0.9 + 0.5 * iasN, t, tau);
    pGlide(this.rushG.gain, q * (i.interior ? 0.22 : 0.5), t, tau);

    // Dive whistle: needs both speed and a genuine descent. Rate of descent is
    // what separates "fast" from "committed".
    const dive = smoothstep(12, 70, -i.vertical);
    const fast = smoothstep(0.62, 1.0, iasN);
    pGlide(this.whistleBp.frequency, clamp(1750 + 2300 * iasN, 900, 6500), t, tau);
    pGlide(this.whistleG.gain, dive * fast * 0.16 * (i.interior ? 0.75 : 1), t, 0.12);

    const drag = clamp(i.gear * 0.55 + i.flaps * 0.45 + i.airbrake * 0.9, 0, 1.6);
    pGlide(this.buffetLp.frequency, clamp(180 + 220 * iasN, 90, 700), t, tau);
    pGlide(this.buffetG.gain, drag * q * 0.85, t, tau);

    // Stall: start warning at 78 % of stall alpha and reach full shudder just
    // past the break. Needs airflow — a stationary aeroplane does not buffet.
    const sa = Math.max(0.05, i.stallAlpha);
    const margin = (i.alpha - sa * 0.78) / (sa * 0.34);
    const flying = smoothstep(0.10, 0.28, iasN);
    const stall = clamp(margin, 0, 1.25) * flying;
    this.stallLevel = clamp(stall, 0, 1);
    pGlide(this.stallBp.frequency, clamp(150 + 90 * stall, 80, 400), t, 0.07);
    pGlide(this.stallG.gain, stall * 0.78, t, 0.07);
    // The shudder speeds up as it deepens — the separated region grows and the
    // shedding frequency rises with it.
    pGlide(this.stallLfo.frequency, 8 + 5.5 * stall, t, 0.12);
  }

  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    const t = this.graph.now;
    pLin(this.master.gain, 0, t + 0.15);
    stopSources(this.sources, t + 0.25);
    setTimeout(() => { killNodes(this.nodes); this.nodes.length = 0; this.sources.length = 0; }, 400);
  }
}
