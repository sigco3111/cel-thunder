import * as THREE from 'three';

/**
 * The light a fire throws.
 *
 * Everything else in this subsystem is emissive geometry: it adds light to the
 * frame but nothing in the scene knows it is there, so a burning aircraft has
 * always been a bright shape pasted in front of an airframe still lit purely by
 * the sun. That is the single largest piece of free drama in a combat frame,
 * and it is entirely missing without real lights.
 *
 * The rig is deliberately tiny — two point lights, allocated once at boot and
 * never added to or removed from the scene. That matters more than it looks:
 * three recompiles *every* material in the scene when the light counts change,
 * so a rig that spawned a light per fire would produce a multi-hundred
 * millisecond stall at the exact moment something explodes. Instead the two
 * lights are permanent, sit at intensity zero when nothing is burning, and are
 * re-aimed each frame at whichever two fires matter most to the current shot.
 *
 * "Matter most" is scored by apparent brightness — strength over distance
 * squared — rather than by strength alone, so a small engine fire ten metres
 * off the camera outranks a burning airfield two kilometres away, which is the
 * right answer for a light whose entire job is to spill onto what is on screen.
 *
 * Every surface in the game is a MeshToonMaterial (see render/CelMaterial), so
 * this light is quantised through the same ramp as the sun: the spill lands as
 * banded, warm, art-directed shapes on the skin rather than as a soft
 * photographic falloff. That is exactly what is wanted.
 */

/** One reported fire, scored and then either promoted to a light or dropped. */
interface FireClaim {
  x: number; y: number; z: number;
  /** Roughly "metres of flame" — an engine fire is ~1, a fuel explosion ~4. */
  strength: number;
  score: number;
}

const MAX_LIGHTS = 2;
const MAX_CLAIMS = 24;

/** Warm, slightly rich: burning fuel and oil, not a tungsten bulb. */
const FIRE_COLOR = 0xff8a2e;

export class FireLightRig {
  readonly group = new THREE.Group();

  private lights: THREE.PointLight[] = [];
  /** Current (smoothed) intensity per light, so a fire fades in and out. */
  private level: number[] = [];
  private phase: number[] = [];

  private claims: FireClaim[] = [];
  private claimCount = 0;

  /**
   * Master scale.
   *
   * Point-light intensity in three r155+ is candela and the falloff is
   * 1/d^decay, so this number only means anything alongside the decay below.
   * Calibrated against the sun, which the sky rig runs at 3.1: at decay 1.5,
   * 9 candela puts about 3 units of irradiance on fuselage skin two metres from
   * an engine fire — comparable to full sunlight, so it lands as a distinct
   * warm band on the shadow side — and about 0.3 at the wingtip eight metres
   * away, which is a hint rather than a wash. The first attempt at 46 put 16
   * units on the cowling and turned the whole nose into a flat orange blob.
   */
  intensity = 7;

  constructor() {
    this.group.name = 'vfx.fireLights';
    this.group.matrixAutoUpdate = false;
    for (let i = 0; i < MAX_LIGHTS; i++) {
      // decay 1.5 rather than the physical 2: a real inverse-square fire is
      // invisible on the wing by the time it is legible on the cowling, and
      // this is a stylised renderer with a banded ramp that needs a broader
      // pool of light to land more than one band on a surface.
      const l = new THREE.PointLight(FIRE_COLOR, 0, 240, 1.5);
      l.name = `vfx.fireLight${i}`;
      l.castShadow = false;
      l.visible = false;
      this.lights.push(l);
      this.level.push(0);
      this.phase.push(i * 2.4);
      this.group.add(l);
    }
    for (let i = 0; i < MAX_CLAIMS; i++) {
      this.claims.push({ x: 0, y: 0, z: 0, strength: 0, score: 0 });
    }
  }

  /** Drop every claim. Called at the top of the frame. */
  begin(): void { this.claimCount = 0; }

  /**
   * Registers a fire at a world position. Cheap enough to call from any
   * emitter's per-frame path — it is a few stores into a fixed array.
   */
  report(x: number, y: number, z: number, strength: number): void {
    if (strength <= 0.02 || this.claimCount >= MAX_CLAIMS) return;
    const c = this.claims[this.claimCount++];
    c.x = x; c.y = y; c.z = z; c.strength = strength; c.score = 0;
  }

  /**
   * Picks the winners and drives the lights. 'camera' only supplies the
   * viewpoint used for scoring; the lights themselves are world-space.
   */
  commit(time: number, dt: number, camera: THREE.Object3D): void {
    const cp = camera.position;
    for (let i = 0; i < this.claimCount; i++) {
      const c = this.claims[i];
      const dx = c.x - cp.x, dy = c.y - cp.y, dz = c.z - cp.z;
      // Apparent brightness, floored so a fire the camera is sitting inside
      // does not score infinity and starve everything else.
      c.score = c.strength / Math.max(36, dx * dx + dy * dy + dz * dz);
    }

    // Selection sort over at most 24 entries, two passes — cheaper and far
    // less allocating than Array.sort with a comparator closure.
    for (let slot = 0; slot < MAX_LIGHTS; slot++) {
      let best = -1, bestScore = 0;
      for (let i = slot; i < this.claimCount; i++) {
        if (this.claims[i].score > bestScore) { bestScore = this.claims[i].score; best = i; }
      }
      if (best >= 0 && best !== slot) {
        const t = this.claims[slot];
        this.claims[slot] = this.claims[best];
        this.claims[best] = t;
      }
    }

    // Fires within a few metres of each other are one fire as far as the light
    // is concerned; letting the second light land on the same aircraft doubles
    // the spill and wastes the only other light in the rig.
    if (this.claimCount > 1) {
      const a = this.claims[0], b = this.claims[1];
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      if (dx * dx + dy * dy + dz * dz < 100) b.strength = 0;
    }

    const k = 1 - Math.exp(-9 * dt);
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const claim = i < this.claimCount ? this.claims[i] : null;
      const want = claim ? claim.strength : 0;
      this.level[i] += (want - this.level[i]) * k;

      const l = this.lights[i];
      if (this.level[i] < 0.01) {
        if (l.visible) { l.visible = false; l.intensity = 0; }
        continue;
      }
      if (claim) l.position.set(claim.x, claim.y, claim.z);

      // Flicker. Two incommensurate rates plus a slow one: fast enough to read
      // as combustion at 60 fps, deep enough (±22%) to be visible through a
      // three-band toon ramp, and never periodic.
      const ph = this.phase[i];
      const f = 0.78
        + 0.13 * Math.sin(time * 21.7 + ph)
        + 0.09 * Math.sin(time * 13.1 + ph * 1.9)
        + 0.06 * Math.sin(time * 3.3 + ph * 0.6);
      l.intensity = this.intensity * this.level[i] * f;
      l.visible = true;
      l.updateMatrix();
      l.matrixWorldNeedsUpdate = true;
    }
    this.group.updateMatrixWorld(true);
  }

  clear(): void {
    this.claimCount = 0;
    for (let i = 0; i < MAX_LIGHTS; i++) {
      this.level[i] = 0;
      this.lights[i].intensity = 0;
      this.lights[i].visible = false;
    }
  }

  dispose(): void {
    for (const l of this.lights) l.dispose();
    this.group.clear();
  }
}
