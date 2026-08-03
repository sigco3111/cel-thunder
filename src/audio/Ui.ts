/**
 * Interface, mechanical and warning sounds.
 *
 * Two rules govern everything in here.
 *
 * First, UI sound in a military sim is not "menu bleeps" — it is *equipment*.
 * A click is a toggle switch closing: a tiny mechanical transient with a wooden
 * body and no pitch. A confirmation is a relay. Getting this wrong is the
 * fastest way to make an otherwise convincing mix feel like a mobile game.
 *
 * Second, mechanical sounds have three parts and are worthless without all
 * three: the *start* (a solenoid or motor engaging), the *travel* (a sustained
 * motor under changing load), and the *end stop* (a hard, damped clunk). Gear
 * that whirrs and then simply stops sounds broken.
 */

import { clamp } from '../shared/math';
import type { AudioGraph } from './AudioGraph';
import { OneShot, envAdsr, envPercussive, modalRing, noiseBurst, toneSweep } from './synth';
import { noiseBuffer, pExp, pSet } from './dsp';

function ui(graph: AudioGraph, priority = 0.6): OneShot | null {
  if (!graph.pool.request(priority, 1, graph.now)) return null;
  return new OneShot(graph, graph.bus.ui, priority, 1);
}

function cockpit(graph: AudioGraph, priority = 0.75): OneShot | null {
  if (!graph.pool.request(priority, 1, graph.now)) return null;
  return new OneShot(graph, graph.bus.cockpit, priority, 1);
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** A toggle switch closing: 4 ms transient, small wooden body, no pitch. */
export function uiClick(graph: AudioGraph, volume = 1): void {
  const os = ui(graph, 0.55);
  if (!os) return;
  const t = graph.now + 0.005;
  let end = noiseBurst(os, {
    when: t, kind: 'white', f0: 5200, f1: 2200, type: 'bandpass', Q: 1.1,
    gain: 0.42 * volume, attack: 0.0004, decay: 0.012,
  });
  end = Math.max(end, modalRing(os, {
    when: t, freqs: [720, 1580, 2340], Q: 7, decay: 0.035, gain: 0.22 * volume, excite: 0.0015,
  }));
  os.commit(end);
}

/** Barely there — a fingertip on a switch guard. */
export function uiHover(graph: AudioGraph, volume = 1): void {
  const os = ui(graph, 0.3);
  if (!os) return;
  const t = graph.now + 0.004;
  os.commit(noiseBurst(os, {
    when: t, kind: 'white', f0: 6800, f1: 4200, type: 'bandpass', Q: 1.6,
    gain: 0.12 * volume, attack: 0.0006, decay: 0.020,
  }));
}

/** A relay pulling in, then a short confirming tone a fifth above. */
export function uiConfirm(graph: AudioGraph, volume = 1): void {
  const os = ui(graph, 0.7);
  if (!os) return;
  const t = graph.now + 0.005;
  let end = noiseBurst(os, {
    when: t, kind: 'white', f0: 3800, f1: 1400, type: 'bandpass', Q: 1.0,
    gain: 0.34 * volume, attack: 0.0005, decay: 0.018,
  });
  end = Math.max(end, toneSweep(os, {
    when: t + 0.012, type: 'triangle', f0: 587, gain: 0.16 * volume,
    attack: 0.004, hold: 0.045, decay: 0.10,
  }));
  end = Math.max(end, toneSweep(os, {
    when: t + 0.075, type: 'triangle', f0: 880, gain: 0.14 * volume,
    attack: 0.004, hold: 0.05, decay: 0.16,
  }));
  os.commit(end);
}

/** The same relay dropping out. */
export function uiBack(graph: AudioGraph, volume = 1): void {
  const os = ui(graph, 0.6);
  if (!os) return;
  const t = graph.now + 0.005;
  let end = noiseBurst(os, {
    when: t, kind: 'white', f0: 2600, f1: 900, type: 'bandpass', Q: 1.0,
    gain: 0.30 * volume, attack: 0.0006, decay: 0.022,
  });
  end = Math.max(end, toneSweep(os, {
    when: t + 0.01, type: 'triangle', f0: 494, f1: 330, gain: 0.13 * volume,
    attack: 0.005, decay: 0.14, sweepFrac: 0.6,
  }));
  os.commit(end);
}

/** Refused input: a low, buzzy, unmistakably negative double-thud. */
export function uiError(graph: AudioGraph, volume = 1): void {
  const os = ui(graph, 0.7);
  if (!os) return;
  const t = graph.now + 0.005;
  let end = 0;
  for (let i = 0; i < 2; i++) {
    const w = t + i * 0.10;
    end = Math.max(end, toneSweep(os, {
      when: w, type: 'square', f0: 138, f1: 116, gain: 0.13 * volume,
      attack: 0.004, hold: 0.045, decay: 0.06, sweepFrac: 0.8,
    }));
    end = Math.max(end, noiseBurst(os, {
      when: w, kind: 'white', f0: 1200, f1: 400, type: 'lowpass', Q: 1.4,
      gain: 0.16 * volume, attack: 0.002, decay: 0.055,
    }));
  }
  os.commit(end);
}

/**
 * Hit marker. Deliberately the sharpest, shortest thing in the whole mix: it
 * has to cut through gunfire at full level and be unmistakable, which means
 * high, brief and modal rather than loud.
 */
export function hitMarker(graph: AudioGraph, armour: boolean, volume = 1): void {
  const os = cockpit(graph, 0.92);
  if (!os) return;
  const t = graph.now + 0.004;
  let end = noiseBurst(os, {
    when: t, kind: 'white', f0: 9000, f1: 5000, type: 'bandpass', Q: 1.4,
    gain: 0.3 * volume, attack: 0.0004, decay: 0.010,
  });
  end = Math.max(end, modalRing(os, {
    when: t,
    // Armour bounce is lower and duller — you can hear that you failed to
    // penetrate without looking at anything.
    freqs: armour ? [1180, 2050, 3120] : [2640, 3960, 5280],
    Q: armour ? 14 : 24, decay: armour ? 0.09 : 0.055,
    gain: 0.34 * volume, excite: 0.0015,
  }));
  os.commit(end);
}

/** Kill confirmation: a two-note perfect fifth with a long tail. */
export function killConfirm(graph: AudioGraph, volume = 1): void {
  const os = ui(graph, 0.95);
  if (!os) return;
  const t = graph.now + 0.01;
  let end = toneSweep(os, {
    when: t, type: 'triangle', f0: 784, gain: 0.20 * volume, attack: 0.004, hold: 0.05, decay: 0.35,
  });
  end = Math.max(end, toneSweep(os, {
    when: t + 0.085, type: 'triangle', f0: 1175, gain: 0.18 * volume, attack: 0.004, hold: 0.06, decay: 0.6,
  }));
  end = Math.max(end, noiseBurst(os, {
    when: t, kind: 'white', f0: 6000, f1: 2400, type: 'bandpass', Q: 1.2,
    gain: 0.14 * volume, attack: 0.001, decay: 0.05,
  }));
  os.commit(end);
}

// ---------------------------------------------------------------------------
// Mechanical
// ---------------------------------------------------------------------------

/**
 * Undercarriage or flap actuator. Start solenoid, motor under load for the
 * travel, hard end stop. The motor pitch *rises* on retraction (the load falls
 * away as the leg comes up) and *falls* on extension (gravity and airload fight
 * it), which is a small thing that reads as completely correct.
 */
export function servo(graph: AudioGraph, deploying: boolean, duration = 2.4, volume = 1, heavy = true): void {
  const os = cockpit(graph, 0.8);
  if (!os) return;
  const ac = graph.ac;
  const t = graph.now + 0.01;
  const f0 = heavy ? 78 : 120;
  const f1 = heavy ? 112 : 165;
  const start = deploying ? f1 : f0;
  const stop = deploying ? f0 : f1;

  // Motor: a sawtooth through a resonant lowpass reads as a wound armature.
  const osc = ac.createOscillator();
  osc.type = 'sawtooth';
  const lp = os.node(ac.createBiquadFilter());
  lp.type = 'lowpass';
  lp.Q.value = 6;
  const g = os.node(ac.createGain());
  g.gain.value = 0;
  osc.connect(lp); lp.connect(g); g.connect(os.out);
  pSet(osc.frequency, start, t);
  pExp(osc.frequency, stop, t + duration);
  pSet(lp.frequency, start * 5, t);
  pExp(lp.frequency, stop * 5, t + duration);
  envAdsr(g.gain, t, 0.22 * volume, 0.08, duration - 0.2, 0.10);

  // Hydraulic hiss riding along with it.
  const nz = os.bufferSource(noiseBuffer(ac, 'pink', 2.6, 2), t, t + duration + 0.3);
  const nbp = os.node(ac.createBiquadFilter());
  nbp.type = 'bandpass';
  nbp.frequency.value = 900;
  nbp.Q.value = 0.8;
  const ng = os.node(ac.createGain());
  ng.gain.value = 0;
  nz.connect(nbp); nbp.connect(ng); ng.connect(os.out);
  envAdsr(ng.gain, t, 0.10 * volume, 0.10, duration - 0.25, 0.12);

  os.source(osc, t, t + duration + 0.3);

  // End stop: a damped clunk with a real thud under it.
  const st = t + duration;
  let end = modalRing(os, {
    when: st, freqs: heavy ? [128, 296, 640, 1090] : [220, 480, 910],
    Q: 11, decay: heavy ? 0.16 : 0.09, gain: 0.5 * volume, excite: 0.004,
  });
  end = Math.max(end, toneSweep(os, {
    when: st, type: 'sine', f0: heavy ? 84 : 130, f1: heavy ? 46 : 74,
    gain: 0.36 * volume, decay: 0.16,
  }));
  os.commit(Math.max(end, t + duration + 0.35));
}

/** Canopy sliding, or being jettisoned (which is violent and lets the wind in). */
export function canopy(graph: AudioGraph, jettison: boolean, volume = 1): void {
  const os = cockpit(graph, 0.85);
  if (!os) return;
  const t = graph.now + 0.01;
  if (jettison) {
    let end = noiseBurst(os, {
      when: t, kind: 'white', f0: 4200, f1: 700, type: 'lowpass', Q: 1.2,
      gain: 0.7 * volume, attack: 0.001, decay: 0.16,
    });
    end = Math.max(end, toneSweep(os, {
      when: t, type: 'sine', f0: 150, f1: 52, gain: 0.5 * volume, decay: 0.28,
    }));
    // The airstream arriving: a hard swell of broadband noise.
    end = Math.max(end, noiseBurst(os, {
      when: t + 0.02, kind: 'pink', f0: 600, f1: 2400, type: 'bandpass', Q: 0.6,
      gain: 0.55 * volume, attack: 0.05, hold: 0.25, decay: 0.9,
    }));
    os.commit(end);
  } else {
    let end = noiseBurst(os, {
      when: t, kind: 'pink', f0: 1600, f1: 900, type: 'bandpass', Q: 1.1,
      gain: 0.18 * volume, attack: 0.03, hold: 0.35, decay: 0.12,
    });
    end = Math.max(end, modalRing(os, {
      when: t + 0.42, freqs: [310, 690, 1240], Q: 9, decay: 0.10, gain: 0.34 * volume,
    }));
    os.commit(end);
  }
}

/**
 * Inertia starter: the flywheel winding up, the clutch engaging, a few
 * reluctant compression strokes and then the catch. The engine voice itself
 * fades in behind this, so the two overlap.
 */
export function engineStart(graph: AudioGraph, dest: AudioNode, volume = 1): void {
  if (!graph.pool.request(0.85, 1, graph.now)) return;
  const os = new OneShot(graph, dest, 0.85, 1);
  const ac = graph.ac;
  const t = graph.now + 0.01;
  const wind = 2.1;

  const osc = ac.createOscillator();
  osc.type = 'sawtooth';
  const bp = os.node(ac.createBiquadFilter());
  bp.type = 'bandpass';
  bp.Q.value = 4;
  const g = os.node(ac.createGain());
  g.gain.value = 0;
  osc.connect(bp); bp.connect(g); g.connect(os.out);
  // Flywheel spinning up, then dropping as the clutch takes the load.
  pSet(osc.frequency, 42, t);
  pExp(osc.frequency, 460, t + wind);
  pExp(osc.frequency, 180, t + wind + 0.5);
  pSet(bp.frequency, 300, t);
  pExp(bp.frequency, 2400, t + wind);
  pExp(bp.frequency, 900, t + wind + 0.5);
  envAdsr(g.gain, t, 0.20 * volume, 0.25, wind, 0.5);
  os.source(osc, t, t + wind + 1.0);

  // Compression strokes: irregular, getting faster, then catching.
  let end = t + wind + 0.6;
  let when = t + wind * 0.75;
  let gap = 0.20;
  for (let i = 0; i < 7 && gap > 0.055; i++) {
    end = Math.max(end, noiseBurst(os, {
      when, kind: 'white', f0: 1400, f1: 260, type: 'lowpass', Q: 2.4,
      gain: (0.28 + i * 0.05) * volume, attack: 0.0015, decay: 0.09,
    }));
    end = Math.max(end, toneSweep(os, {
      when, type: 'triangle', f0: 170, f1: 62, gain: 0.25 * volume, decay: 0.13, sweepFrac: 0.7,
    }));
    when += gap;
    gap *= 0.78;
  }
  os.commit(end);
}

/** Cutting the mixture: the engine winds down and the prop clatters to a stop. */
export function engineStop(graph: AudioGraph, dest: AudioNode, volume = 1): void {
  if (!graph.pool.request(0.7, 1, graph.now)) return;
  const os = new OneShot(graph, dest, 0.7, 1);
  const t = graph.now + 0.01;
  let end = 0;
  let when = t;
  let gap = 0.085;
  for (let i = 0; i < 9 && gap < 0.6; i++) {
    end = Math.max(end, noiseBurst(os, {
      when, kind: 'white', f0: 900 - i * 60, f1: 180, type: 'lowpass', Q: 2.0,
      gain: (0.3 - i * 0.028) * volume, attack: 0.002, decay: 0.10,
    }));
    when += gap;
    gap *= 1.34;
  }
  os.commit(Math.max(end, when));
}

/**
 * Warning annunciator. Not a modern digital chirp: a small electric buzzer,
 * which is a square wave through a tight bandpass with a slight wobble.
 */
export function warningTone(graph: AudioGraph, urgency: 'low' | 'high', volume = 1): void {
  const os = cockpit(graph, 0.9);
  if (!os) return;
  const t = graph.now + 0.01;
  const f = urgency === 'high' ? 720 : 480;
  const pulses = urgency === 'high' ? 3 : 2;
  let end = 0;
  for (let i = 0; i < pulses; i++) {
    const w = t + i * (urgency === 'high' ? 0.13 : 0.22);
    end = Math.max(end, toneSweep(os, {
      when: w, type: 'square', f0: f, f1: f * 0.985, gain: 0.11 * volume,
      attack: 0.006, hold: urgency === 'high' ? 0.07 : 0.13, decay: 0.05,
    }));
  }
  os.commit(end);
}

/** Bailing out: canopy gone, then the airstream taking the pilot. */
export function bailout(graph: AudioGraph, volume = 1): void {
  canopy(graph, true, volume);
  const os = cockpit(graph, 0.9);
  if (!os) return;
  const ac = graph.ac;
  const t = graph.now + 0.12;
  const src = os.bufferSource(noiseBuffer(ac, 'pink', 2.6, 2), t, t + 2.2);
  const bp = os.node(ac.createBiquadFilter());
  bp.type = 'bandpass';
  bp.Q.value = 0.7;
  pSet(bp.frequency, 2200, t);
  pExp(bp.frequency, 420, t + 1.6);
  const g = os.node(ac.createGain());
  g.gain.value = 0;
  src.connect(bp); bp.connect(g); g.connect(os.out);
  const end = envAdsr(g.gain, t, 0.6 * volume, 0.06, 0.5, 1.3);
  os.commit(end);
}

/** Airframe overstress — the wing complaining before it lets go. */
export function airframeStress(graph: AudioGraph, severity: number, volume = 1): void {
  const os = cockpit(graph, 0.7);
  if (!os) return;
  const t = graph.now + 0.01;
  const s = clamp(severity, 0, 1);
  let end = noiseBurst(os, {
    when: t, kind: 'white', f0: 1500 + 900 * s, f1: 500, type: 'bandpass', Q: 5.5,
    gain: 0.22 * s * volume, attack: 0.02, hold: 0.1, decay: 0.4,
  });
  end = Math.max(end, modalRing(os, {
    when: t + 0.05, freqs: [196, 452, 903], Q: 13, decay: 0.28, gain: 0.24 * s * volume, excite: 0.006,
  }));
  os.commit(end);
}

/** Utility used by the dispatcher for anonymous "make a noise here" requests. */
export function genericBlip(graph: AudioGraph, f: number, volume = 1): void {
  const os = ui(graph, 0.4);
  if (!os) return;
  const t = graph.now + 0.005;
  const g = os.node(graph.ac.createGain());
  g.gain.value = 0;
  const osc = graph.ac.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = clamp(f, 40, 8000);
  osc.connect(g); g.connect(os.out);
  const end = envPercussive(g.gain, t, 0.15 * volume, 0.004, 0.14);
  os.source(osc, t, end + 0.01);
  os.commit(end);
}
