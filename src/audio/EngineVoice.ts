/**
 * The piston engine — the centrepiece of the mix and the thing a player hears
 * for the entire match, so it is built additively from the physical sources
 * rather than sampled.
 *
 * Five layers, each corresponding to a real acoustic mechanism:
 *
 *  1. **Blade-pass harmonic stack.** The propeller pushes a pressure pulse past
 *     any given point once per blade per revolution:
 *         f = (engineRPM × reductionGear / 60) × blades
 *     For a Merlin at 3000 rpm through a 0.477 gearbox on a four-blade prop
 *     that is 95 Hz, which is exactly where a Spitfire sits. Two PeriodicWaves
 *     (a mellow low-load spectrum and an aggressive high-load one) crossfade
 *     with throttle, and a tracking lowpass moves the spectral centroid — that
 *     combination is what "the engine leaning into it" sounds like.
 *  2. **Exhaust crackle.** A four-stroke fires each cylinder once per two
 *     revolutions: f = RPM/120 × cylinders. Rather than scheduling 300 node
 *     events a second, one oscillator at that rate is shaped into a narrow
 *     pulse train and used to gate a noise band at audio rate. Each pulse is a
 *     genuine, individually-shaped cylinder event.
 *  3. **Supercharger whine.** A pure tone geared off the crank (≈9:1 on a
 *     Merlin), whose level rises with the cube of rpm because centrifugal
 *     impeller noise scales with tip speed.
 *  4. **Propeller wash.** Broadband noise amplitude-modulated at blade-pass —
 *     the buzzsaw quality you hear when a fighter goes past.
 *  5. **Mechanical bed.** Brown noise under 150 Hz plus a sine at crank speed:
 *     the part you feel rather than hear, and the reason a real engine sounds
 *     heavy.
 *
 * Inline vs radial is not a preset swap, it is different physics: different
 * cylinder count and firing regularity, different reduction gearing, a lower
 * exhaust band, a strong half-crank "lope" from the uneven firing order of a
 * single-row radial, and much weaker supercharger whine.
 *
 * Damage removes the top of the harmonic stack, detunes what is left, and
 * introduces scheduled misfires — a dip in level plus a genuine backfire
 * transient — at a rate proportional to how badly the engine is hurt.
 */

import type { AircraftSpec } from '../shared/aircraft';
import { DamageBits } from '../shared/protocol';
import { Rng, clamp, smoothstep } from '../shared/math';
import { AudioGraph, killNodes, stopSources } from './AudioGraph';
import { SpatialSource, wantHrtf, type ListenerState } from './SpatialSource';
import { OneShot, noiseBurst, toneSweep } from './synth';
import {
  harmonicWave, noiseBuffer, pGlide, pLin, pSet, pCancel, pulseCurve, smoothRandomBuffer,
} from './dsp';
import type { Voice } from './VoicePool';

/** Harmonic amplitude tables. Index 0 is the fundamental. */
const WAVES = {
  inlineSoft: [1, 0.42, 0.22, 0.12, 0.07, 0.042, 0.026, 0.016],
  inlineHard: [1, 0.78, 0.62, 0.47, 0.36, 0.28, 0.21, 0.16, 0.12, 0.09, 0.07, 0.05],
  radialSoft: [1, 0.55, 0.36, 0.26, 0.15, 0.10, 0.065, 0.04],
  radialHard: [1, 0.88, 0.74, 0.62, 0.50, 0.41, 0.33, 0.27, 0.21, 0.17, 0.13, 0.10],
  // Deliberately non-monotonic: a holed cylinder leaves gaps in the series and
  // that "hollow" spectrum is instantly recognisable as a sick engine.
  damaged: [1, 0.30, 0.55, 0.14, 0.33, 0.10, 0.20, 0.06],
} as const;

export interface EngineInput {
  /** Normalised engine rpm from the wire, 0..1. */
  rpm: number;
  throttle: number;
  /** Indicated airspeed, m/s — drives windmilling and prop wash. */
  ias: number;
  damage: number;
  health: number;
}

/** 0 = minimal (2 layers), 1 = medium, 2 = full model. */
export type EngineDetail = 0 | 1 | 2;

export class EngineVoice implements Voice {
  readonly id: number;
  readonly persistent = true;
  priority = 0.7;
  loudness = 0.4;
  endsAt = Infinity;

  readonly entityId: number;
  readonly spec: AircraftSpec;
  readonly detail: EngineDetail;

  private readonly graph: AudioGraph;
  private readonly ac: AudioContext;
  private readonly rng: Rng;

  // routing
  private readonly mix: GainNode;        // layer sum
  private readonly stumble: GainNode;    // misfire / lope modulation
  private readonly master: GainNode;     // overall level & fades
  private readonly outSpatial: GainNode;
  private readonly outDirect: GainNode;
  private readonly interiorLp: BiquadFilterNode;
  private readonly interiorShelf: BiquadFilterNode;
  private readonly interiorSend: GainNode | null;
  private spatial: SpatialSource | null = null;

  // layers
  private harmSoft!: OscillatorNode;
  private harmHard!: OscillatorNode;
  private harmSoftG!: GainNode;
  private harmHardG!: GainNode;
  private harmLp!: BiquadFilterNode;
  private harmG!: GainNode;
  private harmDmg: OscillatorNode | null = null;
  private harmDmgG: GainNode | null = null;
  private wobbleSrc: AudioBufferSourceNode | null = null;
  private wobbleG: GainNode | null = null;

  private fireOsc: OscillatorNode | null = null;
  private exhAm: GainNode | null = null;
  private exhBp: BiquadFilterNode | null = null;
  private exhG: GainNode | null = null;
  private exhLow: BiquadFilterNode | null = null;
  private exhLowG: GainNode | null = null;
  private irrG: GainNode | null = null;

  private propOsc: OscillatorNode | null = null;
  private propAm: GainNode | null = null;
  private propBp: BiquadFilterNode | null = null;
  private propG: GainNode | null = null;

  private whine1: OscillatorNode | null = null;
  private whine2: OscillatorNode | null = null;
  private whineG: GainNode | null = null;

  private rumLp!: BiquadFilterNode;
  private rumG!: GainNode;
  private crank: OscillatorNode | null = null;
  private crankG: GainNode | null = null;
  private lope: OscillatorNode | null = null;
  private lopeG: GainNode | null = null;

  private fireNoise: AudioBufferSourceNode | null = null;
  private fireBp: BiquadFilterNode | null = null;
  private fireG: GainNode | null = null;

  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly nodes: AudioNode[] = [];

  // physical constants derived once
  private readonly gear: number;
  private readonly cylinders: number;
  private readonly superRatio: number;
  private readonly irregular: number;
  private readonly radial: boolean;

  private interior = false;
  private nextMisfire = 0;
  private dead = false;
  private level = 1;

  constructor(
    graph: AudioGraph, entityId: number, spec: AircraftSpec, detail: EngineDetail,
    x: number, y: number, z: number, spawnDistance = 0,
  ) {
    this.graph = graph;
    this.ac = graph.ac;
    this.id = graph.pool.allocId();
    this.entityId = entityId;
    this.spec = spec;
    this.detail = detail;
    this.rng = new Rng(entityId * 2654435761 + 17);

    const e = spec.engine;
    this.radial = e.kind === 'radial';
    // Reduction gearing: Merlin/Allison ≈ 0.477, most radials ≈ 0.5625.
    this.gear = this.radial ? 0.5625 : 0.477;
    // Cylinder count is not on the spec, so infer it: V-12 for every inline of
    // this era; 14-cylinder twin-row for the big radials, 9-cylinder single-row
    // for the small ones (which is what gives them their loping burble).
    this.cylinders = this.radial ? (e.powerKw > 900 ? 14 : 9) : 12;
    this.superRatio = this.radial ? 7.0 : 9.09;
    // Fractional cycle-to-cycle scatter in the firing rate.
    this.irregular = this.radial ? 0.055 : 0.014;

    const ac = this.ac;
    const g = (v: number) => { const n = ac.createGain(); n.gain.value = v; this.nodes.push(n); return n; };

    this.mix = g(1);
    this.stumble = g(1);
    this.master = g(0);
    this.outSpatial = g(1);
    this.outDirect = g(0);

    // Inside a cockpit the engine is louder, boomier and has lost its top end
    // to the firewall and the perspex — a low shelf into a lowpass, not a
    // simple volume change.
    this.interiorShelf = this.mkFilter('lowshelf', 190, 0.7);
    this.interiorShelf.gain.value = 5.5;
    this.interiorLp = this.mkFilter('lowpass', 4200, 0.6);

    this.mix.connect(this.stumble);
    this.stumble.connect(this.master);
    this.master.connect(this.outSpatial);
    this.master.connect(this.interiorShelf);
    this.interiorShelf.connect(this.interiorLp);
    this.interiorLp.connect(this.outDirect);
    // Structure-borne, so it goes to the non-occluded cockpit bus: the canopy
    // muffles the world, it does not muffle the engine bolted to your firewall.
    this.outDirect.connect(graph.bus.cockpit);

    if (graph.profile.reverb) {
      this.interiorSend = g(0.16);
      this.outDirect.connect(this.interiorSend);
      this.interiorSend.connect(graph.reverbIn);
    } else {
      this.interiorSend = null;
    }

    this.spatial = new SpatialSource(graph, graph.bus.engine, x, y, z, {
      // Unity out to ~22 m (about a wingspan and a half), then a rolloff steep
      // enough that a wingman 130 m away sits ~9 dB under your own engine and a
      // fight a kilometre away is a distant drone rather than a second cockpit.
      refDistance: 22, rolloff: 1.6, maxDistance: 24000,
      // Decided once, from the range at which this contact first earned a
      // voice: PannerNode.panningModel cannot be changed after construction
      // without rebuilding the whole chain, and rebuilding a sustained engine
      // mid-flight is an audible seam. Passing 0 here (as this used to) put an
      // FFT convolution on all ten engine voices at every range, which is
      // precisely what the hrtfDistance tier knob exists to avoid.
      hrtf: wantHrtf(graph, spawnDistance),
      send: graph.profile.reverb ? 0.05 : 0,
    });
    this.outSpatial.connect(this.spatial.input);

    this.build();
    graph.pool.add(this);
  }

  private mkFilter(type: BiquadFilterType, freq: number, q: number): BiquadFilterNode {
    const f = this.ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    this.nodes.push(f);
    return f;
  }

  // -------------------------------------------------------------------------

  private build(): void {
    const ac = this.ac;
    const t0 = ac.currentTime;
    const g = (v: number) => { const n = ac.createGain(); n.gain.value = v; this.nodes.push(n); return n; };
    const osc = (type: OscillatorType, f: number) => {
      const o = ac.createOscillator();
      o.type = type;
      o.frequency.value = f;
      this.sources.push(o);
      this.nodes.push(o);
      return o;
    };
    const buf = (b: AudioBuffer, rate = 1) => {
      const s = ac.createBufferSource();
      s.buffer = b;
      s.loop = true;
      s.playbackRate.value = rate;
      this.sources.push(s);
      this.nodes.push(s);
      return s;
    };

    // --- 1. blade-pass harmonic stack --------------------------------------
    const softTable = this.radial ? WAVES.radialSoft : WAVES.inlineSoft;
    const hardTable = this.radial ? WAVES.radialHard : WAVES.inlineHard;
    // NB: assigning 'type = 'custom'' throws; setPeriodicWave is what switches
    // an oscillator to a custom spectrum.
    this.harmSoft = osc('sine', 80);
    this.harmSoft.setPeriodicWave(harmonicWave(ac, this.radial ? 'radialSoft' : 'inlineSoft', softTable));
    this.harmHard = osc('sine', 80);
    this.harmHard.setPeriodicWave(harmonicWave(ac, this.radial ? 'radialHard' : 'inlineHard', hardTable));
    this.harmSoftG = g(0);
    this.harmHardG = g(0);
    this.harmLp = this.mkFilter('lowpass', 1200, 0.9);
    this.harmG = g(0);
    this.harmSoft.connect(this.harmSoftG); this.harmSoftG.connect(this.harmLp);
    this.harmHard.connect(this.harmHardG); this.harmHardG.connect(this.harmLp);
    this.harmLp.connect(this.harmG);
    this.harmG.connect(this.mix);

    // --- 5. mechanical bed (always present, it is the floor of the sound) ---
    const rum = buf(noiseBuffer(ac, 'brown', 3.1, 3), 0.7 + this.rng.next() * 0.5);
    this.rumLp = this.mkFilter('lowpass', 150, 1.1);
    this.rumG = g(0);
    rum.connect(this.rumLp); this.rumLp.connect(this.rumG); this.rumG.connect(this.mix);

    if (this.detail >= 1) {
      // --- 2. exhaust crackle ---------------------------------------------
      this.fireOsc = osc('sine', 200);
      const shaper = ac.createWaveShaper();
      shaper.curve = pulseCurve(this.radial ? 4 : 9);
      shaper.oversample = 'none';   // control signal, aliasing is inaudible here
      this.nodes.push(shaper);
      this.fireOsc.connect(shaper);

      // Cycle-to-cycle scatter: band-limited noise added straight onto the
      // oscillator's frequency in Hz. This is the whole difference between a
      // machine and a synthesiser.
      const irr = buf(smoothRandomBuffer(ac, 3.7, 26, 31), 1);
      this.irrG = g(0);
      irr.connect(this.irrG);
      this.irrG.connect(this.fireOsc.frequency);

      const depth = g(0.95);
      shaper.connect(depth);
      this.exhAm = g(0);           // gated by the pulse train at audio rate
      depth.connect(this.exhAm.gain);

      const exhNoise = buf(noiseBuffer(ac, 'white', 2.2, 1), 1);
      exhNoise.connect(this.exhAm);

      this.exhBp = this.mkFilter('bandpass', this.radial ? 780 : 1500, 1.35);
      this.exhG = g(0);
      this.exhAm.connect(this.exhBp); this.exhBp.connect(this.exhG); this.exhG.connect(this.mix);

      // The thud each cylinder makes, separate from its crack.
      this.exhLow = this.mkFilter('lowpass', 180, 3.2);
      this.exhLowG = g(0);
      this.exhAm.connect(this.exhLow); this.exhLow.connect(this.exhLowG); this.exhLowG.connect(this.mix);
    }

    if (this.detail >= 2 && this.graph.profile.layers) {
      // --- 4. propeller wash ----------------------------------------------
      this.propOsc = osc('sine', 90);
      const pshape = ac.createWaveShaper();
      pshape.curve = pulseCurve(2.2);
      pshape.oversample = 'none';
      this.nodes.push(pshape);
      this.propOsc.connect(pshape);
      const pdepth = g(0.8);
      pshape.connect(pdepth);
      this.propAm = g(0.12);       // partly open: prop wash is never fully gated
      pdepth.connect(this.propAm.gain);
      const pnoise = buf(noiseBuffer(ac, 'pink', 2.6, 2), 1);
      pnoise.connect(this.propAm);
      this.propBp = this.mkFilter('bandpass', 700, 0.85);
      this.propG = g(0);
      this.propAm.connect(this.propBp); this.propBp.connect(this.propG); this.propG.connect(this.mix);

      // --- 3. supercharger whine ------------------------------------------
      this.whine1 = osc('sine', 1200);
      this.whine2 = osc('sine', 2400);
      this.whine2.detune.value = 9;   // slow beating; a perfect tone sounds fake
      this.whineG = g(0);
      const w2g = g(0.38);
      this.whine1.connect(this.whineG);
      this.whine2.connect(w2g); w2g.connect(this.whineG);
      this.whineG.connect(this.mix);

      // crank-rate body and, for radials, the half-crank lope
      this.crank = osc('sine', 45);
      this.crankG = g(0);
      this.crank.connect(this.crankG); this.crankG.connect(this.mix);

      this.lope = osc('sine', 20);
      this.lopeG = g(this.radial ? 0.075 : 0.014);
      this.lope.connect(this.lopeG);
      this.lopeG.connect(this.stumble.gain);   // additive AM on the whole engine
    }

    for (const s of this.sources) { try { s.start(t0); } catch { /* already started */ } }

    // Fade in rather than appearing — an engine that snaps into existence at
    // full level when it crosses the culling radius is very obvious.
    pSet(this.master.gain, 0, t0);
    pLin(this.master.gain, 1, t0 + 0.35);
  }

  // -------------------------------------------------------------------------

  /** Route through the cockpit EQ instead of the 3D panner (and back). */
  setInterior(inside: boolean): void {
    if (this.interior === inside) return;
    this.interior = inside;
    const t = this.graph.now;
    pGlide(this.outSpatial.gain, inside ? 0 : 1, t, 0.05);
    pGlide(this.outDirect.gain, inside ? 0.42 : 0, t, 0.05);
  }

  /** Overall trim, used to duck remote engines below the player's own. */
  setLevel(v: number): void {
    this.level = clamp(v, 0, 2);
  }

  update(
    input: EngineInput, px: number, py: number, pz: number,
    vx: number, vy: number, vz: number, l: ListenerState,
  ): void {
    if (this.dead) return;
    const t = this.graph.now;
    const sp = this.spatial;
    if (sp) sp.update(px, py, pz, vx, vy, vz, l, 0.022);
    const dop = sp ? sp.doppler : 1;
    this.loudness = sp ? sp.estimateLoudness() : 1;

    const eng = this.spec.engine;
    const rpmN = clamp(input.rpm, 0, 1.05);
    const throttle = clamp(input.throttle, 0, 1);
    const iasN = clamp(input.ias / Math.max(40, this.spec.aero.vne), 0, 1.4);

    // A dead engine still has a prop turning in the airstream. Windmilling rpm
    // is roughly proportional to airspeed and produces prop noise but no
    // combustion, which is a very distinctive and very useful sound.
    const windmill = rpmN < 0.05 ? clamp(iasN * 0.42, 0, 0.4) : 0;
    const propRpmN = Math.max(rpmN, windmill);

    const engRpm = eng.maxRpm * rpmN;
    const propRpm = eng.maxRpm * propRpmN * this.gear;
    const bladePass = clamp((propRpm / 60) * eng.blades * dop, 4, 900);
    const fireHz = clamp((engRpm / 120) * this.cylinders * dop, 2, 1400);
    const crankHz = clamp((engRpm / 60) * dop, 1, 120);
    const whineHz = clamp((engRpm / 60) * this.superRatio * 3 * dop, 20, 6000);

    const running = smoothstep(0.05, 0.24, rpmN);
    const load = clamp(throttle * 0.75 + rpmN * 0.35, 0, 1);
    // Throttle closed at speed: the prop is driving the engine, not the reverse.
    const driven = clamp(propRpmN * 1.1 - throttle, 0, 1);

    const damaged = (input.damage & DamageBits.Engine) !== 0;
    const onFire = (input.damage & DamageBits.EngineFire) !== 0;
    const hurt = clamp(1 - input.health, 0, 1);
    const sick = clamp((damaged ? 0.60 : 0) + hurt * 0.50, 0, 1);

    const lv = this.level;
    const tau = 0.045;

    // --- harmonic stack ----------------------------------------------------
    pGlide(this.harmSoft.frequency, bladePass, t, tau);
    pGlide(this.harmHard.frequency, bladePass, t, tau);
    // Equal-power crossfade so the total energy does not dip mid-throttle.
    const soft = Math.cos(load * Math.PI * 0.5);
    const hard = Math.sin(load * Math.PI * 0.5);
    pGlide(this.harmSoftG.gain, soft * (1 - sick * 0.30), t, tau);
    pGlide(this.harmHardG.gain, hard * (1 - sick * 0.35), t, tau);
    // Moving the corner with load is the "per-harmonic envelope shift": at idle
    // only the first three harmonics survive, at full power the stack opens up.
    pGlide(this.harmLp.frequency, clamp(bladePass * (2.6 + 7.5 * load) + 180, 120, 9000), t, 0.07);
    // Damage changes the *spectrum*, not the loudness: the clean harmonics are
    // pulled down and the hollow damaged spectrum is pushed up to replace them.
    // A sick engine that merely gets quieter reads as a bug, not as damage.
    pGlide(this.harmG.gain, running * 0.5 * lv * (1 + sick * 0.08), t, tau);

    if (sick > 0.12) this.ensureDamageLayer(bladePass, sick, t, tau);
    else if (this.harmDmgG) pGlide(this.harmDmgG.gain, 0, t, 0.12);

    // --- exhaust -----------------------------------------------------------
    if (this.fireOsc && this.exhG && this.exhBp && this.exhLowG && this.exhLow && this.irrG) {
      pGlide(this.fireOsc.frequency, fireHz, t, tau);
      // Scatter scales with the firing rate so the *relative* jitter is constant.
      pGlide(this.irrG.gain, fireHz * (this.irregular + sick * 0.10), t, 0.08);
      const combust = running * (0.20 + 0.80 * throttle);
      pGlide(this.exhG.gain, combust * (this.radial ? 0.30 : 0.36) * lv * (1 - sick * 0.15), t, tau);
      pGlide(this.exhBp.frequency,
        clamp((this.radial ? 620 : 1050) + (this.radial ? 900 : 1600) * load, 200, 6000), t, 0.08);
      pGlide(this.exhLowG.gain, combust * 0.42 * lv, t, tau);
      pGlide(this.exhLow.frequency, clamp(120 + 110 * load, 60, 400), t, 0.08);
    }

    // --- prop wash ---------------------------------------------------------
    if (this.propOsc && this.propG && this.propBp) {
      pGlide(this.propOsc.frequency, bladePass, t, tau);
      pGlide(this.propBp.frequency, clamp(320 + 780 * propRpmN + input.ias * 2.2, 150, 5000), t, 0.07);
      const propLevel = (0.10 + 0.30 * propRpmN) * (0.75 + 0.75 * driven) * lv;
      pGlide(this.propG.gain, propLevel * smoothstep(0.02, 0.15, propRpmN), t, tau);
    }

    // --- supercharger ------------------------------------------------------
    if (this.whine1 && this.whine2 && this.whineG) {
      pGlide(this.whine1.frequency, whineHz, t, tau);
      pGlide(this.whine2.frequency, whineHz * 2, t, tau);
      // Impeller noise goes with tip speed; the cube is a good perceptual fit.
      const w = Math.pow(rpmN, 2.7) * (0.30 + 0.70 * throttle) * (this.radial ? 0.020 : 0.055);
      pGlide(this.whineG.gain, w * lv * (1 - sick * 0.9), t, 0.06);
    }

    // --- mechanical bed ----------------------------------------------------
    pGlide(this.rumLp.frequency, clamp(85 + 130 * rpmN, 50, 400), t, 0.08);
    pGlide(this.rumG.gain, (running * (0.20 + 0.28 * load) * (1 + sick * 0.35) + windmill * 0.20) * lv, t, tau);
    if (this.crank && this.crankG) {
      pGlide(this.crank.frequency, crankHz, t, tau);
      pGlide(this.crankG.gain, running * 0.16 * lv, t, tau);
    }
    if (this.lope) pGlide(this.lope.frequency, crankHz * 0.5, t, tau);
    if (this.lopeG) pGlide(this.lopeG.gain, running * (this.radial ? 0.085 : 0.016) * (1 + sick), t, 0.08);

    // --- fire --------------------------------------------------------------
    if (onFire) this.ensureFireLayer(t, lv);
    else if (this.fireG) pGlide(this.fireG.gain, 0, t, 0.4);

    // --- misfires ----------------------------------------------------------
    if (sick > 0.15 && rpmN > 0.08) {
      if (this.nextMisfire === 0) this.nextMisfire = t + this.rng.range(0.2, 1.2);
      if (t >= this.nextMisfire) {
        this.misfire(t, sick, running);
        // Floored well above the dip length: a misfire every 100 ms is not a
        // sick engine, it is a stutter effect.
        this.nextMisfire = t + (0.30 + (1 - sick) * 1.7) * (0.5 + this.rng.next() * 1.2);
      }
    } else {
      this.nextMisfire = 0;
    }
  }

  /** Adds the "hollow spectrum" oscillator and the detune wobble on demand. */
  private ensureDamageLayer(bladePass: number, sick: number, t: number, tau: number): void {
    if (!this.harmDmg) {
      const ac = this.ac;
      const o = ac.createOscillator();
      o.setPeriodicWave(harmonicWave(ac, 'engineDamaged', WAVES.damaged));
      const g = ac.createGain();
      g.gain.value = 0;
      o.connect(g); g.connect(this.harmLp);
      this.nodes.push(o, g);
      this.sources.push(o);
      try { o.start(t); } catch { /* ignore */ }
      this.harmDmg = o;
      this.harmDmgG = g;

      // Slow random detune: a damaged engine hunts, it does not hold a pitch.
      const w = ac.createBufferSource();
      w.buffer = smoothRandomBuffer(ac, 5.3, 3.5, 77);
      w.loop = true;
      const wg = ac.createGain();
      wg.gain.value = 0;
      w.connect(wg);
      wg.connect(this.harmDmg.detune);
      wg.connect(this.harmHard.detune);
      this.nodes.push(w, wg);
      this.sources.push(w);
      try { w.start(t); } catch { /* ignore */ }
      this.wobbleSrc = w;
      this.wobbleG = wg;
    }
    pGlide(this.harmDmg.frequency, bladePass, t, tau);
    pGlide(this.harmDmgG!.gain, sick * 0.70, t, 0.1);
    if (this.wobbleG) pGlide(this.wobbleG.gain, sick * 55, t, 0.1);
  }

  private ensureFireLayer(t: number, lv: number): void {
    if (!this.fireG) {
      const ac = this.ac;
      const s = ac.createBufferSource();
      s.buffer = noiseBuffer(ac, 'pink', 2.6, 2);
      s.loop = true;
      s.playbackRate.value = 0.75;
      const bp = ac.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 340;
      bp.Q.value = 0.5;
      const g = ac.createGain();
      g.gain.value = 0;
      // Flame flutter: slow band-limited noise on the gain.
      const fl = ac.createBufferSource();
      fl.buffer = smoothRandomBuffer(ac, 4.1, 7, 91);
      fl.loop = true;
      const flg = ac.createGain();
      flg.gain.value = 0.35;
      fl.connect(flg); flg.connect(g.gain);
      s.connect(bp); bp.connect(g); g.connect(this.mix);
      this.nodes.push(s, bp, g, fl, flg);
      this.sources.push(s, fl);
      try { s.start(t); fl.start(t); } catch { /* ignore */ }
      this.fireNoise = s;
      this.fireBp = bp;
      this.fireG = g;
    }
    pGlide(this.fireG.gain, 0.5 * lv, t, 0.3);
    if (this.fireBp) pGlide(this.fireBp.frequency, 340, t, 0.3);
  }

  /**
   * One combustion event fails: the level drops for a few tens of milliseconds
   * and unburnt mixture detonates in the exhaust on the way out.
   */
  private misfire(t: number, sick: number, running: number): void {
    const at = t + 0.005;
    const depth = clamp(1 - sick * this.rng.range(0.30, 0.72), 0.22, 0.95);
    pCancel(this.stumble.gain, at);
    pSet(this.stumble.gain, 1, at);
    pLin(this.stumble.gain, depth, at + 0.010);
    pLin(this.stumble.gain, 1 + (1 - depth) * 0.25, at + 0.045);
    pLin(this.stumble.gain, 1, at + 0.11);

    if (running < 0.2 || this.rng.next() > 0.55) return;
    if (!this.graph.pool.request(0.35, this.loudness, t)) return;
    // A real backfire: low crack out of the stacks, no high-frequency snap.
    const os = new OneShot(this.graph, this.mix, 0.35, this.loudness);
    let end = noiseBurst(os, {
      when: at, kind: 'white', f0: 1100, f1: 220, type: 'lowpass', Q: 2.6,
      gain: 0.55 * sick, attack: 0.0012, decay: 0.085,
    });
    end = Math.max(end, toneSweep(os, {
      when: at, type: 'triangle', f0: 165, f1: 52, gain: 0.4 * sick, decay: 0.13, sweepFrac: 0.7,
    }));
    os.commit(end);
  }

  // -------------------------------------------------------------------------

  release(fade: number): void { this.stop(fade); }

  stop(fade = 0.3): void {
    if (this.dead) return;
    this.dead = true;
    const t = this.graph.now;
    pCancel(this.master.gain, t);
    pLin(this.master.gain, 0, t + fade);
    stopSources(this.sources, t + fade + 0.05);
    this.graph.pool.remove(this);
    // Give the fade time to complete before tearing the graph down; ripping
    // nodes out mid-envelope is the classic source of end-of-life clicks.
    setTimeout(() => this.destroy(), (fade + 0.15) * 1000);
  }

  private destroy(): void {
    killNodes(this.nodes);
    this.spatial?.dispose();
    this.spatial = null;
    this.nodes.length = 0;
    this.sources.length = 0;
  }
}
