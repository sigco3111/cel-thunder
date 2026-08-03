/**
 * Explosions and heavy impacts.
 *
 * The single most convincing trick in air-combat audio is not the explosion
 * itself, it is *when* and *how dull* it arrives. Sound travels 343 m/s, so a
 * bomber blowing up two kilometres away is silent for six full seconds and then
 * arrives as a soft, low, reverberant thud with no transient left in it. Games
 * that play the same bright bang at every distance, merely quieter, always feel
 * small; this one schedules the arrival at 'distance / c' and hands the whole
 * signal through a distance-tracking lowpass, so the world acquires a scale.
 *
 * The blast itself is four elements:
 *   - a **pitch-collapsing sub** (95 Hz falling to 25 Hz), which is the
 *     overpressure wave — this is the part you feel;
 *   - a **noise body** whose filter collapses from 5 kHz to 250 Hz, which is
 *     the fireball;
 *   - a **crack** that exists only close up, because it is the part atmospheric
 *     absorption removes first;
 *   - **debris**, starting ~90 ms late because it has to be thrown before it
 *     can land.
 */

import { clamp } from '../shared/math';
import type { AudioGraph } from './AudioGraph';
import { SpatialSource, wantHrtf, type ListenerState } from './SpatialSource';
import { OneShot, debrisRattle, noiseBurst, toneSweep } from './synth';
import { SPEED_OF_SOUND } from './dsp';

export type BlastKind = 'air' | 'ground' | 'water' | 'structure';

/** Beyond this the arrival delay is longer than anyone's attention span. */
const MAX_AUDIBLE = 5000;

export function explosion(
  graph: AudioGraph, l: ListenerState,
  x: number, y: number, z: number, scale: number, kind: BlastKind = 'air',
  vx = 0, vy = 0, vz = 0,
): void {
  const dist = Math.hypot(x - l.px, y - l.py, z - l.pz);
  if (dist > MAX_AUDIBLE) return;

  const s = clamp(scale <= 0 ? 1 : scale, 0.25, 6);
  const delay = dist / SPEED_OF_SOUND;
  const when = graph.now + delay + 0.012;

  // A near blast wins every arbitration; a distant one is background.
  const prox = clamp(1 - dist / MAX_AUDIBLE, 0, 1);
  // Squared so a blast at half the audible radius is worth a quarter as much:
  // far explosions must not hold voice slots for their long arrival delay.
  const priority = clamp(0.28 + prox * prox * 0.68, 0.15, 0.98);
  if (!graph.pool.request(priority, prox, graph.now)) return;

  const spatial = new SpatialSource(graph, graph.bus.weapon, x, y, z, {
    // Explosions are omnidirectional and enormous: unity out to 60 m and a
    // shallow rolloff, so they still carry across the map.
    refDistance: 60, rolloff: 0.55, maxDistance: 26000,
    hrtf: wantHrtf(graph, dist),
    // Distance is sold by reverberation as much as by filtering: the further
    // away it is, the more of what reaches you has bounced off something.
    send: graph.profile.reverb ? clamp(0.08 + dist / 2200, 0, 0.85) : 0,
    doppler: false,
  });
  spatial.place(x, y, z, vx, vy, vz, l);

  const os = new OneShot(graph, spatial.input, priority, prox);
  os.attach(spatial);

  // Distance also stretches the event: multipath through turbulent air smears
  // a sharp bang into a roll of thunder.
  const smear = 1 + dist / 1100;
  const sizeLo = Math.pow(s, 0.3);
  let end = when;

  // --- overpressure ------------------------------------------------------
  end = Math.max(end, toneSweep(os, {
    when, type: 'sine', f0: 96 / sizeLo, f1: 24 / sizeLo,
    gain: 1.0 * Math.min(1.4, s), attack: 0.006, decay: 0.55 * Math.pow(s, 0.45) * smear,
    sweepFrac: 0.75,
  }));
  end = Math.max(end, toneSweep(os, {
    when, type: 'triangle', f0: 190 / sizeLo, f1: 46 / sizeLo,
    gain: 0.35 * Math.min(1.4, s), attack: 0.003, decay: 0.20 * Math.pow(s, 0.4) * smear,
    sweepFrac: 0.6,
  }));

  // --- fireball ----------------------------------------------------------
  end = Math.max(end, noiseBurst(os, {
    when, kind: 'white', f0: 5200 / sizeLo, f1: 230, type: 'lowpass', Q: 0.75,
    gain: 0.9 * Math.min(1.3, s), attack: 0.004, decay: 0.42 * Math.pow(s, 0.5) * smear,
  }));
  end = Math.max(end, noiseBurst(os, {
    when: when + 0.02, kind: 'brown', f0: 320, f1: 110, type: 'lowpass', Q: 1.1,
    gain: 0.55 * Math.min(1.5, s), attack: 0.03, decay: 1.1 * Math.pow(s, 0.5) * smear,
  }));

  // --- crack (dies with distance, so we only build it when it survives) ---
  if (dist < 900) {
    end = Math.max(end, noiseBurst(os, {
      when, kind: 'white', f0: 14000, f1: 3600, type: 'lowpass', Q: 0.6, hp: 2200,
      gain: 0.55 * prox * Math.min(1.2, s), attack: 0.0006, decay: 0.022,
    }));
  }

  // --- material-specific tail --------------------------------------------
  if (kind === 'ground') {
    end = Math.max(end, noiseBurst(os, {
      when: when + 0.03, kind: 'brown', f0: 520, f1: 150, type: 'lowpass', Q: 0.9,
      gain: 0.45 * s, attack: 0.02, decay: 0.9 * smear,
    }));
    end = Math.max(end, debrisRattle(os, when + 0.11, 1.5 * Math.pow(s, 0.4), 0.24 * prox, 900, 70));
  } else if (kind === 'water') {
    // A column of water going up and then coming back down: the filter sweeps
    // up (the throw) and a second, softer burst follows (the collapse).
    end = Math.max(end, noiseBurst(os, {
      when: when + 0.01, kind: 'white', f0: 280, f1: 2400, type: 'bandpass', Q: 0.8,
      gain: 0.55 * s, attack: 0.012, decay: 0.5,
    }));
    end = Math.max(end, noiseBurst(os, {
      when: when + 0.55 * Math.pow(s, 0.4), kind: 'white', f0: 1800, f1: 320,
      type: 'bandpass', Q: 0.7, gain: 0.35 * s, attack: 0.03, decay: 0.75,
    }));
  } else if (kind === 'structure') {
    end = Math.max(end, debrisRattle(os, when + 0.06, 1.8, 0.3 * prox, 1900, 120));
  } else {
    end = Math.max(end, debrisRattle(os, when + 0.09, 1.2 * Math.pow(s, 0.4), 0.20 * prox, 1600, 85));
  }

  os.commit(end);

  // Close blasts physically deafen you for a moment. This is a mix decision as
  // much as a dramatic one: it clears space for the explosion to be enormous.
  if (dist < 160) graph.blast(clamp((1 - dist / 160) * Math.min(1, s), 0, 1));
}

/**
 * Thunder.
 *
 * Not an explosion with a different name. A stroke is a several-kilometre line
 * source, not a point, so every part of the channel arrives at a different time
 * and the "bang" is smeared into a roll whose length is set by the *geometry*,
 * not by reverberation: about 3 s per kilometre of path difference. Close
 * strikes keep the initial crack because the nearest part of the channel is
 * only a few hundred metres away; distant ones lose it entirely and are pure
 * low rumble, which is why far thunder sounds like furniture being moved.
 *
 * Delivered on the environment bus and never on the weapon bus, so a storm does
 * not fight the gunfire for the transient headroom the mix reserves for it.
 */
export function thunder(
  graph: AudioGraph, l: ListenerState,
  x: number, y: number, z: number, distance: number, intensity: number,
): void {
  const dist = Number.isFinite(distance) && distance > 0
    ? distance
    : Math.hypot(x - l.px, y - l.py, z - l.pz);
  if (dist > 22000) return;

  const near = clamp(1 - dist / 9000, 0, 1);
  const level = clamp(intensity, 0.2, 1.6) * clamp(0.25 + near, 0.25, 1.2);
  if (!graph.pool.request(0.42 + near * 0.3, near, graph.now)) return;

  const spatial = new SpatialSource(graph, graph.bus.env, x, y, z, {
    refDistance: 400, rolloff: 0.35, maxDistance: 30000,
    hrtf: false, send: graph.profile.reverb ? clamp(0.2 + dist / 4000, 0, 0.9) : 0,
    doppler: false,
  });
  spatial.place(x, y, z, 0, 0, 0, l);

  const when = graph.now + dist / SPEED_OF_SOUND + 0.01;
  const os = new OneShot(graph, spatial.input, 0.42 + near * 0.3, near);
  os.attach(spatial);

  // Roll length: the far end of a 4 km channel arrives ~12 s after the near
  // end. Clamped so the voice does not sit in the pool for half a minute.
  const roll = clamp(1.2 + dist / 900, 1.2, 9);
  let end = when;

  if (dist < 2500) {
    // The leader channel's own crack, only close in.
    end = Math.max(end, noiseBurst(os, {
      when, kind: 'white', f0: 9000, f1: 1400, type: 'lowpass', Q: 0.6, hp: 900,
      gain: 0.75 * level * near, attack: 0.0008, decay: 0.055,
    }));
  }
  // Body: three overlapping brown-noise swells at increasing delay are the
  // cheapest honest model of a line source. Each one is a different stretch of
  // the channel reporting in.
  for (let i = 0; i < 3; i++) {
    const t = when + roll * i * 0.22;
    end = Math.max(end, noiseBurst(os, {
      when: t, kind: 'brown',
      f0: 420 / (1 + i * 0.7) * (0.4 + near), f1: 55,
      type: 'lowpass', Q: 0.9,
      gain: level * (0.85 - i * 0.2), attack: 0.05 + i * 0.10, decay: roll * (0.45 + i * 0.22),
    }));
  }
  // Infrasonic pressure — this is what a close stroke does to your chest.
  end = Math.max(end, toneSweep(os, {
    when: when + 0.02, type: 'sine', f0: 52, f1: 22,
    gain: 0.55 * level * near, attack: 0.05, decay: roll * 0.5, sweepFrac: 0.8,
  }));
  os.commit(end);
}

/**
 * Airframe failure — a wing coming off. Structural, so it is a tearing rip and
 * a groan rather than a bang: a rising-then-collapsing noise band (rivets
 * unzipping) over a low sawtooth bending downward (the spar going).
 */
export function structureFail(
  graph: AudioGraph, l: ListenerState, x: number, y: number, z: number, scale: number,
): void {
  const dist = Math.hypot(x - l.px, y - l.py, z - l.pz);
  if (dist > 4000) return;
  const prox = clamp(1 - dist / 4000, 0, 1);
  if (!graph.pool.request(0.7, prox, graph.now)) return;

  const spatial = new SpatialSource(graph, graph.bus.weapon, x, y, z, {
    refDistance: 45, rolloff: 0.9, maxDistance: 12000,
    hrtf: wantHrtf(graph, dist), send: graph.profile.reverb ? 0.2 : 0, doppler: false,
  });
  spatial.place(x, y, z, 0, 0, 0, l);

  const when = graph.now + dist / SPEED_OF_SOUND + 0.01;
  const s = clamp(scale <= 0 ? 1 : scale, 0.4, 3);
  const os = new OneShot(graph, spatial.input, 0.7, prox);
  os.attach(spatial);

  let end = noiseBurst(os, {
    when, kind: 'white', f0: 900, f1: 3200, type: 'bandpass', Q: 3.4,
    gain: 0.6 * s, attack: 0.006, decay: 0.30,
  });
  end = Math.max(end, noiseBurst(os, {
    when: when + 0.12, kind: 'white', f0: 2600, f1: 420, type: 'bandpass', Q: 4.5,
    gain: 0.5 * s, attack: 0.01, decay: 0.55,
  }));
  end = Math.max(end, toneSweep(os, {
    when, type: 'sawtooth', f0: 148, f1: 41, gain: 0.30 * s, attack: 0.02, decay: 0.85, sweepFrac: 0.9,
  }));
  end = Math.max(end, debrisRattle(os, when + 0.18, 1.4, 0.22 * prox, 2200, 110));
  os.commit(end);
}
