/**
 * Guns, impacts and near-misses.
 *
 * A burst of automatic fire is the hardest thing in a game mix to get right,
 * because the naive approach — one sample per round — turns into an obvious
 * loop within half a second, and the brute-force fix (dozens of unique samples)
 * is not available to us because there are no samples at all.
 *
 * The structure used here is the one film and game sound designers converge on:
 *
 *   **A sustained body layer** running at the true cyclic rate, made by gating
 *   noise with a pulse train at exactly rounds-per-second. This carries the
 *   rhythm, and because it is a continuous signal rather than retriggered
 *   voices it can run at 76 rounds/second (four Brownings) for nothing.
 *
 *   **Discrete transients** on top, at a capped rate, each one round-robined
 *   through a systematic variation table — pitch, filter, decay and level all
 *   walk together in a four-step cycle plus jitter. Systematic rotation is what
 *   reads as *different barrels*; pure randomness just reads as noise.
 *
 *   **A mechanical action layer** at a very slightly different rate, so the
 *   clatter of the breech drifts against the report exactly the way
 *   unsynchronised guns do.
 *
 * Calibre is not a preset: every acoustic parameter is derived from it, so a
 * 7.7 mm Browning and a 20 mm Hispano are the same synthesiser at different
 * settings, and they relate to each other correctly. Cannon are slower, lower,
 * longer and heavier because the formulas make them so.
 */

import type { GunSpec } from '../shared/aircraft';
import { Rng, clamp } from '../shared/math';
import { AudioGraph, killNodes, stopSources } from './AudioGraph';
import { SpatialSource, wantHrtf, type ListenerState } from './SpatialSource';
import { OneShot, modalRing, noiseBurst, toneSweep } from './synth';
import { noiseBuffer, pGlide, pLin, pSet, pulseCurve } from './dsp';

/** Everything the synthesiser needs, derived from calibre and rate of fire. */
interface GunAcoustics {
  /** Pitched "weight" of the report. */
  thumpHz: number;
  /** Centre of the noise body. */
  bodyHz: number;
  /** Body decay, seconds. */
  decay: number;
  /** Reflected tail, seconds. */
  tail: number;
  /** Peak level. */
  level: number;
  /** Rounds per second for the whole battery. */
  rate: number;
  cannon: boolean;
}

export function gunAcoustics(gun: GunSpec): GunAcoustics {
  const cal = clamp(gun.calibre, 5, 45);
  const ref = 7.7 / cal;
  return {
    // Bore volume scales as calibre³, and the resonant frequency of the muzzle
    // blast scales roughly as its inverse cube root — hence the fractional
    // exponents rather than a lookup table.
    thumpHz: 260 * Math.pow(ref, 0.85),
    bodyHz: 1500 * Math.pow(ref, 0.45),
    decay: 0.042 + cal * 0.0078,
    tail: 0.085 + cal * 0.020,
    level: clamp(0.34 + cal * 0.030, 0.3, 1.05),
    rate: Math.max(0.5, (gun.rpm * Math.max(1, gun.count)) / 60),
    cannon: cal >= 19 || gun.he > 4,
  };
}

/** Pitch / filter / gain / decay multipliers for one round-robin slot. */
export interface ShotVariation { p: number; f: number; g: number; d: number }

/** Four-step timbre rotation. Consecutive shots never share a slot. */
const ROBIN: ReadonlyArray<ShotVariation> = [
  { p: 1.000, f: 1.00, g: 1.00, d: 1.00 },
  { p: 1.045, f: 1.13, g: 0.93, d: 0.90 },
  { p: 0.962, f: 0.89, g: 1.06, d: 1.12 },
  { p: 1.021, f: 1.05, g: 0.97, d: 0.96 },
];

const NEUTRAL: ShotVariation = { p: 1, f: 1, g: 1, d: 1 };

export interface ShotRender {
  interior: boolean;
  doppler: number;
  /** Multiplier on the calibre-derived level. */
  level: number;
  loudness: number;
  priority: number;
}

/**
 * Renders a single report. Shared by the burst scheduler and by one-off
 * 'playSound('gun:shot')' calls so both sound identical.
 */
export function renderShot(
  graph: AudioGraph, dest: AudioNode, when: number, a: GunAcoustics,
  r: ShotVariation, o: ShotRender,
): boolean {
  if (!graph.pool.request(o.priority, o.loudness, graph.now)) return false;
  const lvl = a.level * o.level;
  const dop = o.doppler;
  const os = new OneShot(graph, dest, o.priority, o.loudness);
  let end = when;

  if (o.interior) {
    // From inside: the muzzle blast is outside and forward, so you lose the
    // crack and gain the structure. Guns bolted to a wing spar hammer the whole
    // airframe, and that is most of what the pilot actually hears.
    end = Math.max(end, noiseBurst(os, {
      when, kind: 'white', f0: a.bodyHz * 0.9 * r.f, f1: a.bodyHz * 0.22,
      type: 'lowpass', Q: 1.3, gain: lvl * 0.75, attack: 0.0016, decay: a.decay * r.d * 1.15,
    }));
    end = Math.max(end, toneSweep(os, {
      when, type: 'sine', f0: a.thumpHz * 1.35 * r.p * dop, f1: a.thumpHz * 0.5 * dop,
      gain: lvl * 0.9, decay: a.decay * 2.0, sweepFrac: 0.6,
    }));
    end = Math.max(end, modalRing(os, {
      when, freqs: [173, 402, 887, 1553], Q: 9, decay: 0.075, gain: lvl * 0.34, excite: 0.0022,
    }));
  } else {
    // Muzzle crack: broadband, brutally short. This is the transient the ear
    // localises on, and it must not be smeared by a slow attack.
    end = Math.max(end, noiseBurst(os, {
      when, kind: 'white', f0: 11000 * r.f, f1: 3200, type: 'lowpass', Q: 0.6,
      hp: a.cannon ? 900 : 1700,
      gain: lvl * (a.cannon ? 0.65 : 0.9), attack: 0.0006, decay: 0.011 * r.d,
    }));
    end = Math.max(end, noiseBurst(os, {
      when, kind: 'white', f0: a.bodyHz * 1.55 * r.f, f1: a.bodyHz * 0.30,
      type: 'lowpass', Q: 1.7, gain: lvl, attack: 0.0014, decay: a.decay * r.d,
    }));
    end = Math.max(end, toneSweep(os, {
      when, type: 'sine', f0: a.thumpHz * 1.5 * r.p * dop, f1: a.thumpHz * 0.55 * dop,
      gain: lvl * 0.55, decay: a.decay * 1.6, sweepFrac: 0.7,
    }));
    // The tail is the report coming back off the ground and off the air itself;
    // it is what makes a gun sound big rather than merely loud.
    end = Math.max(end, noiseBurst(os, {
      when: when + 0.008, kind: 'pink', f0: 950 * r.f, f1: 200, type: 'lowpass', Q: 0.9,
      gain: lvl * (a.cannon ? 0.34 : 0.20), attack: 0.010, decay: a.tail * r.d,
    }));
  }

  os.commit(end);
  return true;
}

/** Ad-hoc single report from a bare calibre, for scripted or UI use. */
export function singleShot(
  graph: AudioGraph, dest: AudioNode, calibre: number, o: Partial<ShotRender> = {},
): boolean {
  const a = gunAcoustics({
    name: '', calibre, rpm: 600, count: 1, muzzle: 800, ammo: 0, mounts: [],
    he: calibre >= 20 ? 8 : 0, mass: 0.05, group: 1, tracer: 0,
  });
  return renderShot(graph, dest, graph.now + 0.006, a, NEUTRAL, {
    interior: o.interior ?? false,
    doppler: o.doppler ?? 1,
    level: o.level ?? 1,
    loudness: o.loudness ?? 1,
    priority: o.priority ?? 0.6,
  });
}

/** Discrete transients above this rate merge into the sustained layer. */
const MAX_TRANSIENT_RATE = 26;
/** Level of the mechanical-action layer while the trigger is held. */
const ACTION_LEVEL = 0.16;
/** Keep firing this long after the last replicated gunfire event. */
const HOLD = 0.13;
const LOOKAHEAD = 0.13;

export class GunEmitter {
  readonly key: string;
  readonly entityId: number;
  readonly gun: GunSpec;
  readonly acoustics: GunAcoustics;
  readonly isLocal: boolean;

  private readonly graph: AudioGraph;
  private readonly ac: AudioContext;
  private readonly rng: Rng;

  private readonly master: GainNode;
  private readonly outSpatial: GainNode;
  private readonly outDirect: GainNode;
  private spatial: SpatialSource | null;

  // sustained layer
  private loopBuilt = false;
  private loopGain: GainNode | null = null;
  private loopBp: BiquadFilterNode | null = null;
  private loopOsc: OscillatorNode | null = null;
  private actionOsc: OscillatorNode | null = null;
  private actionGain: GainNode | null = null;
  private readonly loopNodes: AudioNode[] = [];
  private readonly loopSources: AudioScheduledSourceNode[] = [];

  private activeUntil = -1;
  private nextShot = 0;
  private robin = 0;
  private interior = false;
  private dead = false;
  private lastSeen = 0;

  constructor(graph: AudioGraph, key: string, entityId: number, gun: GunSpec, isLocal: boolean,
              x: number, y: number, z: number, spawnDistance = 0) {
    this.graph = graph;
    this.ac = graph.ac;
    this.key = key;
    this.entityId = entityId;
    this.gun = gun;
    this.isLocal = isLocal;
    this.acoustics = gunAcoustics(gun);
    this.rng = new Rng(entityId * 40503 + gun.calibre * 977 + 5);

    this.master = this.ac.createGain();
    this.master.gain.value = 1;

    this.outSpatial = this.ac.createGain();
    this.outSpatial.gain.value = 1;
    this.outDirect = this.ac.createGain();
    this.outDirect.gain.value = 0;

    this.master.connect(this.outSpatial);
    this.master.connect(this.outDirect);
    this.outDirect.connect(graph.bus.cockpit);

    this.spatial = new SpatialSource(graph, graph.bus.weapon, x, y, z, {
      refDistance: 30, rolloff: 1.1, maxDistance: 12000,
      // A panner's model cannot be changed after construction, so the decision
      // is made once from the range at which the emitter first appeared.
      // Passing 0 here (as this used to) made every gun in the fight an FFT
      // convolution regardless of range, which is exactly what the distance
      // heuristic exists to prevent.
      hrtf: isLocal || wantHrtf(graph, spawnDistance),
      send: graph.profile.reverb ? 0.18 : 0,
    });
    this.outSpatial.connect(this.spatial.input);
  }

  /** Destination for shot transients — interior or exterior path. */
  private get dest(): AudioNode { return this.master; }

  setInterior(inside: boolean): void {
    if (this.interior === inside) return;
    this.interior = inside;
    const t = this.graph.now;
    pGlide(this.outSpatial.gain, inside ? 0 : 1, t, 0.03);
    pGlide(this.outDirect.gain, inside ? 1 : 0, t, 0.03);
  }

  get expired(): boolean {
    return this.graph.now - this.lastSeen > 1.5 && this.graph.now > this.activeUntil + 0.5;
  }

  /** Called for every replicated gunfire event; refreshes the hold window. */
  trigger(t: number): void {
    if (this.dead) return;
    this.lastSeen = t;
    this.activeUntil = t + HOLD;
    // Fire immediately on the first event of a burst so the muzzle flash and
    // the report are frame-locked; after that the scheduler owns the cadence.
    if (this.nextShot < t) this.nextShot = t + 0.001;
    this.buildLoop(t);
    if (this.loopGain) pGlide(this.loopGain.gain, 1, t, 0.012);
    // The breech clatter comes up with the report and, below, goes down with
    // it. Slightly slower than the body on the way in: the bolt is already
    // moving before the first round fires.
    if (this.actionGain) pGlide(this.actionGain.gain, ACTION_LEVEL, t, 0.02);
  }

  update(px: number, py: number, pz: number, vx: number, vy: number, vz: number, l: ListenerState): void {
    if (this.dead) return;
    const t = this.graph.now;
    this.spatial?.update(px, py, pz, vx, vy, vz, l, 0.03);

    if (t < this.activeUntil) {
      this.scheduleShots(t + LOOKAHEAD);
    } else {
      if (this.loopGain) pGlide(this.loopGain.gain, 0, t, 0.03);
      // The action layer has to come down too. Its AM oscillator runs
      // continuously at the cyclic rate, so leaving the gain up means the
      // breech keeps clattering through every gap in a burst and for the whole
      // 1.5 s the emitter takes to expire — a phantom gun firing on its own.
      // A slightly longer release than the body: the bolt runs down after the
      // last round, it does not stop dead with it.
      if (this.actionGain) pGlide(this.actionGain.gain, 0, t, 0.06);
    }
  }

  // -------------------------------------------------------------------------

  private buildLoop(t: number): void {
    if (this.loopBuilt) return;
    this.loopBuilt = true;
    const ac = this.ac;
    const a = this.acoustics;
    const keep = <T extends AudioNode>(n: T): T => { this.loopNodes.push(n); return n; };

    // report body, gated at the true cyclic rate
    const noise = keep(ac.createBufferSource());
    noise.buffer = noiseBuffer(ac, 'white', 2.2, 1);
    noise.loop = true;
    this.loopSources.push(noise);

    this.loopOsc = keep(ac.createOscillator());
    this.loopOsc.type = 'sine';
    this.loopOsc.frequency.value = a.rate;
    this.loopSources.push(this.loopOsc);

    const shaper = keep(ac.createWaveShaper());
    // Slow guns get a tighter pulse (you hear the gaps); fast guns a broader
    // one, which is what turns a rattle into a saw.
    shaper.curve = pulseCurve(a.rate > 22 ? 3.2 : 7);
    shaper.oversample = 'none';
    this.loopOsc.connect(shaper);

    const depth = keep(ac.createGain());
    depth.gain.value = 1;
    shaper.connect(depth);

    const am = keep(ac.createGain());
    am.gain.value = 0;
    depth.connect(am.gain);
    noise.connect(am);

    this.loopBp = keep(ac.createBiquadFilter());
    this.loopBp.type = 'bandpass';
    this.loopBp.frequency.value = a.bodyHz * 0.85;
    this.loopBp.Q.value = 0.85;
    am.connect(this.loopBp);

    this.loopGain = keep(ac.createGain());
    this.loopGain.gain.value = 0;
    this.loopBp.connect(this.loopGain);
    this.loopGain.connect(this.dest);

    // mechanical action, deliberately not in lock-step with the report
    const aNoise = keep(ac.createBufferSource());
    aNoise.buffer = noiseBuffer(ac, 'white', 2.2, 1);
    aNoise.loop = true;
    this.loopSources.push(aNoise);

    this.actionOsc = keep(ac.createOscillator());
    this.actionOsc.type = 'sine';
    this.actionOsc.frequency.value = a.rate * 1.004;
    this.loopSources.push(this.actionOsc);

    const aShaper = keep(ac.createWaveShaper());
    aShaper.curve = pulseCurve(14);
    aShaper.oversample = 'none';
    this.actionOsc.connect(aShaper);
    const aDepth = keep(ac.createGain());
    aDepth.gain.value = 1;
    aShaper.connect(aDepth);
    const aAm = keep(ac.createGain());
    aAm.gain.value = 0;
    aDepth.connect(aAm.gain);
    aNoise.connect(aAm);
    const aBp = keep(ac.createBiquadFilter());
    aBp.type = 'bandpass';
    aBp.frequency.value = a.cannon ? 1250 : 2100;
    aBp.Q.value = 2.4;
    aAm.connect(aBp);
    this.actionGain = keep(ac.createGain());
    // Loud in the cockpit, almost inaudible from outside — the breech is
    // bolted to the airframe you are sitting in.
    this.actionGain.gain.value = 0;
    aBp.connect(this.actionGain);
    this.actionGain.connect(this.dest);

    const start = Math.max(t, this.graph.now);
    for (const s of this.loopSources) { try { s.start(start); } catch { /* already */ } }
    pSet(this.loopGain.gain, 0, start);
    pSet(this.actionGain.gain, 0, start);
  }

  private scheduleShots(until: number): void {
    const a = this.acoustics;
    const discreteRate = Math.min(a.rate, MAX_TRANSIENT_RATE);
    const interval = 1 / discreteRate;
    // Rounds represented by each transient once the cyclic rate outruns the
    // transient budget; used to thicken the surviving shots.
    const stack = Math.max(1, a.rate / discreteRate);

    let guard = 0;
    while (this.nextShot < until && guard++ < 16) {
      const when = Math.max(this.nextShot, this.graph.now + 0.004);
      if (when > this.activeUntil + interval) break;
      this.shot(when, stack);
      // ±3.5 % dispersion: real guns do not run to a metronome, and the tiny
      // wander is what stops the ear from locking on to a period.
      this.nextShot += interval * this.rng.range(0.965, 1.035);
    }
    if (this.nextShot < this.graph.now) this.nextShot = this.graph.now;
  }

  private shot(when: number, stack: number): void {
    const a = this.acoustics;
    const loud = this.spatial ? this.spatial.estimateLoudness() : 1;
    const priority = this.isLocal ? 0.95 : (a.cannon ? 0.65 : 0.5);
    const inside = this.interior && this.isLocal;

    const r = ROBIN[this.robin++ & 3];
    const jitter = 1 + (this.rng.next() - 0.5) * 0.06;
    // Louder per transient when it stands in for several rounds, but √n rather
    // than n — that is how uncorrelated sources actually sum.
    const thick = Math.min(1.6, Math.sqrt(stack));
    renderShot(this.graph, this.dest, when, a, r, {
      interior: inside,
      doppler: this.spatial ? this.spatial.doppler : 1,
      level: r.g * jitter * thick * (inside ? 0.85 : 1),
      loudness: inside ? 1 : loud,
      priority,
    });
  }

  stop(fade = 0.05): void {
    if (this.dead) return;
    this.dead = true;
    const t = this.graph.now;
    pLin(this.master.gain, 0, t + fade);
    stopSources(this.loopSources, t + fade + 0.02);
    setTimeout(() => {
      killNodes(this.loopNodes);
      killNodes([this.master, this.outSpatial, this.outDirect]);
      this.spatial?.dispose();
      this.spatial = null;
      this.loopNodes.length = 0;
      this.loopSources.length = 0;
    }, (fade + 0.1) * 1000);
  }
}

// ---------------------------------------------------------------------------
// Impacts
// ---------------------------------------------------------------------------

/**
 * A round striking your own aircraft. Structure-borne, so it arrives with no
 * distance delay, no air absorption and no panning smear — it is *inside* the
 * cockpit with you. The modal ratios are deliberately inharmonic: thin stressed
 * aluminium panel, not a bell.
 */
export function impactOwn(graph: AudioGraph, calibre: number, armour: boolean): void {
  const t = graph.now + 0.004;
  const heavy = clamp(calibre / 20, 0.3, 1.6);
  if (!graph.pool.request(0.98, 1, graph.now)) return;
  const os = new OneShot(graph, graph.bus.cockpit, 0.98, 1);

  let end = noiseBurst(os, {
    when: t, kind: 'white', f0: 9000, f1: 2600, type: 'lowpass', Q: 0.7, hp: 1200,
    gain: 0.62 * heavy, attack: 0.0004, decay: 0.010,
  });

  if (armour) {
    // Armour plate: lower modes, much longer ring, and a real thud behind it.
    end = Math.max(end, modalRing(os, {
      when: t, freqs: [420, 968, 1730, 2510], Q: 26, decay: 0.34 * heavy,
      gain: 0.5 * heavy, excite: 0.004,
    }));
    end = Math.max(end, toneSweep(os, {
      when: t, type: 'sine', f0: 128, f1: 62, gain: 0.45 * heavy, decay: 0.20,
    }));
  } else {
    end = Math.max(end, modalRing(os, {
      when: t, freqs: [1105, 2673, 4290, 6110], Q: 22, decay: 0.16 * heavy,
      gain: 0.55 * heavy, excite: 0.0022,
    }));
    end = Math.max(end, toneSweep(os, {
      when: t, type: 'sine', f0: 210, f1: 96, gain: 0.28 * heavy, decay: 0.11,
    }));
  }
  os.commit(end);
}

/** Somebody else being hit — spatial, duller, no ring detail at distance. */
export function impactRemote(
  graph: AudioGraph, l: ListenerState, x: number, y: number, z: number,
  calibre: number, armour: boolean,
): void {
  const dist = Math.hypot(x - l.px, y - l.py, z - l.pz);
  if (dist > 1600) return;                 // pistol-calibre events do not carry
  const loudness = clamp(1 - dist / 1600, 0, 1);
  const heavy = clamp(calibre / 20, 0.3, 1.6);
  if (!graph.pool.request(0.4, loudness, graph.now)) return;

  const spatial = new SpatialSource(graph, graph.bus.weapon, x, y, z, {
    refDistance: 25, rolloff: 1.4, maxDistance: 4000,
    hrtf: wantHrtf(graph, dist), send: 0, doppler: false,
  });
  spatial.place(x, y, z, 0, 0, 0, l);
  const when = graph.now + dist / 343 + 0.006;

  const os = new OneShot(graph, spatial.input, 0.4, loudness);
  os.attach(spatial);
  let end = noiseBurst(os, {
    when, kind: 'white', f0: 5200, f1: 900, type: 'lowpass', Q: 0.8, hp: 500,
    gain: 0.5 * heavy, attack: 0.0006, decay: 0.035,
  });
  end = Math.max(end, modalRing(os, {
    when, freqs: armour ? [520, 1180, 2020] : [1320, 2980, 4600], Q: armour ? 16 : 12,
    decay: armour ? 0.16 : 0.08, gain: 0.3 * heavy, excite: 0.003,
  }));
  os.commit(end);
}

/**
 * A bullet striking dirt, rock or water.
 *
 * This is emphatically *not* an explosion. Every round that misses reaches the
 * ground and emits GroundImpact/WaterImpact, so a single strafing pass is dozens
 * of these a second; routing them into the full blast synthesiser gives a wall
 * of pitch-collapsing sub and eats the entire voice budget at a priority that
 * outranks the guns that made them. What it actually sounds like is a slap:
 * a few tens of milliseconds of filtered noise, a low thud with no sweep, and —
 * on stone — a short inharmonic ring off the chips.
 *
 * 'thick' is how many rounds this one stands in for after coalescing; it raises
 * the level by √n (uncorrelated sources) and widens the burst rather than
 * spawning n voices.
 */
export function terrainImpact(
  graph: AudioGraph, l: ListenerState, x: number, y: number, z: number,
  calibre: number, water: boolean, thick = 1,
): void {
  const dist = Math.hypot(x - l.px, y - l.py, z - l.pz);
  if (dist > 900) return;
  const loudness = clamp(1 - dist / 900, 0, 1);
  // Deliberately below gunfire (0.5-0.95) and impacts (0.4): if the pool is
  // busy, the sound of your own rounds arriving is the first thing to go.
  if (!graph.pool.request(0.28, loudness, graph.now)) return;

  const heavy = clamp(calibre / 20, 0.25, 1.4);
  const n = clamp(Math.sqrt(thick), 1, 2.4);
  const spatial = new SpatialSource(graph, graph.bus.env, x, y, z, {
    refDistance: 20, rolloff: 1.5, maxDistance: 2000,
    hrtf: wantHrtf(graph, dist), send: 0, doppler: false,
  });
  spatial.place(x, y, z, 0, 0, 0, l);
  const when = graph.now + dist / 343 + 0.006;

  const os = new OneShot(graph, spatial.input, 0.28, loudness);
  os.attach(spatial);

  let end: number;
  if (water) {
    // A slap on the surface and the cavity closing behind it. No sub: a rifle
    // round makes a splash, not a depth charge.
    end = noiseBurst(os, {
      when, kind: 'white', f0: 4200, f1: 700, type: 'lowpass', Q: 0.8, hp: 260,
      gain: 0.34 * heavy * n, attack: 0.0012, decay: 0.045 * n,
    });
    end = Math.max(end, toneSweep(os, {
      when: when + 0.010, type: 'sine', f0: 340 * heavy, f1: 620 * heavy,
      gain: 0.12 * heavy, decay: 0.055, sweepFrac: 0.9,
    }));
  } else {
    end = noiseBurst(os, {
      when, kind: 'white', f0: 2600, f1: 380, type: 'lowpass', Q: 0.7, hp: 120,
      gain: 0.40 * heavy * n, attack: 0.0008, decay: 0.038 * n,
    });
    // The thud. Fixed pitch on purpose — a swept sub is what makes a bullet
    // strike read as a bomb, and that is the exact mistake being fixed here.
    end = Math.max(end, toneSweep(os, {
      when, type: 'sine', f0: 96, f1: 78, gain: 0.20 * heavy, decay: 0.055,
    }));
    if (calibre >= 15) {
      end = Math.max(end, modalRing(os, {
        when, freqs: [880, 1930, 3120], Q: 8, decay: 0.05,
        gain: 0.14 * heavy, excite: 0.003,
      }));
    }
  }
  os.commit(end);
}

/**
 * A round going past your head.
 *
 * A supersonic bullet drags a Mach cone behind it, and what you hear as it
 * passes is that cone sweeping across your ear: a click whose spectral centre
 * collapses from ultrasonic to a few hundred hertz in about 40 ms. Reproducing
 * that downward sweep — rather than just playing a "whizz" — is what makes a
 * near miss frightening. The pitch of the tail also drops, which is the true
 * doppler of an object that was closing and is now receding.
 */
export function nearMiss(
  graph: AudioGraph, l: ListenerState,
  x: number, y: number, z: number, vx: number, vy: number, vz: number,
  miss: number, speed: number,
): void {
  // Closer misses are louder, sharper, and sweep faster.
  const prox = clamp(1 - miss / 30, 0.05, 1);
  if (!graph.pool.request(0.9, prox, graph.now)) return;

  // Placed at the point of closest approach with the round's real velocity, so
  // the panner sweeps and the doppler tail falls exactly as it should.
  const spatial = new SpatialSource(graph, graph.bus.weapon, x, y, z, {
    refDistance: 8, rolloff: 1.6, maxDistance: 300,
    hrtf: wantHrtf(graph, miss), send: 0, doppler: true,
  });
  spatial.place(x, y, z, vx, vy, vz, l);

  const when = graph.now + 0.004;
  const os = new OneShot(graph, spatial.input, 0.9, prox);
  os.attach(spatial);
  const sweep = clamp(0.055 - prox * 0.028, 0.015, 0.06);
  const v = clamp(speed / 800, 0.5, 1.3) * clamp(spatial.doppler, 0.7, 1.4);

  let end = noiseBurst(os, {
    when, kind: 'white', f0: 12000 * v, f1: 700, type: 'bandpass', Q: 1.6,
    gain: 0.85 * prox, attack: 0.0004, decay: sweep,
  });
  // The tail: the cone spreading out behind the round.
  end = Math.max(end, noiseBurst(os, {
    when: when + sweep * 0.5, kind: 'pink', f0: 2600 * v, f1: 380, type: 'bandpass', Q: 2.6,
    gain: 0.34 * prox, attack: 0.004, decay: sweep * 3.2,
  }));
  os.commit(end);
}
