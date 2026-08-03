import * as THREE from 'three';
import { ParticleEngine, ParticleGroup } from './ParticleEngine';
import { RingSystem } from './RingSystem';
import { TrailPool } from './TrailSystem';
import { DebrisSystem, type DebrisKind } from './DebrisSystem';
import { FireLightRig } from './FireLight';
import { Rng } from '../shared/math';

/**
 * The shared spine every effect module writes through: all the pools, the
 * world queries, the RNG, the LOD helper and the camera-shake accumulator.
 *
 * Effect modules are plain functions over this object rather than classes so
 * there is exactly one place where budgets, pooling and level-of-detail are
 * enforced, and no module can quietly allocate.
 */

export type SurfaceKind = 'metal' | 'armour' | 'ground' | 'dirt' | 'grass' | 'sand'
  | 'rock' | 'concrete' | 'water' | 'wood' | 'canvas' | 'foliage' | 'snow';

export interface TerrainQuery {
  height(x: number, z: number): number;
  normal(x: number, z: number, out: THREE.Vector3): THREE.Vector3;
  type(x: number, z: number): SurfaceKind;
}

/** One decaying oscillator. Several are summed so shakes never look periodic. */
interface ShakeLayer {
  amp: number;
  freq: number;
  decay: number;
  phase: number;
  /** Fraction of the amplitude that goes into roll rather than translation. */
  roll: number;
  age: number;
  life: number;
}

const SHAKE_LAYERS = 8;

export class VfxCore {
  time = 0;
  dt = 1 / 60;
  /** Emission budget multiplier from the quality tier. */
  budget = 1;
  readonly rng = new Rng(0x5eed1234);

  readonly engine = new ParticleEngine();
  readonly root = new THREE.Group();

  smoke!: ParticleGroup;
  dust!: ParticleGroup;
  water!: ParticleGroup;
  mist!: ParticleGroup;
  fire!: ParticleGroup;
  flash!: ParticleGroup;
  spark!: ParticleGroup;
  haze!: ParticleGroup;

  ringsHot!: RingSystem;
  ringsDust!: RingSystem;
  trailsBill!: TrailPool;
  trailsRibbon!: TrailPool;
  debris!: DebrisSystem;

  /**
   * Real lights for fires, so a burning aircraft throws warm light onto its own
   * skin, the wing behind it and whatever it is flying over. Any emitter may
   * call 'fireLight.report(x, y, z, strength)' during its update; the rig picks
   * the two that matter to this shot and drives them.
   */
  readonly fireLight = new FireLightRig();

  camera!: THREE.PerspectiveCamera;
  readonly wind = new THREE.Vector3(3.2, 0, -1.6);
  terrain: TerrainQuery;

  /** Scratch — never allocate in an effect. */
  readonly v0 = new THREE.Vector3();
  readonly v1 = new THREE.Vector3();
  readonly v2 = new THREE.Vector3();
  readonly v3 = new THREE.Vector3();
  readonly q0 = new THREE.Quaternion();
  readonly c0 = new THREE.Color();

  private shakes: ShakeLayer[] = [];
  private shakeCursor = 0;
  readonly shakeOffset = new THREE.Vector3();
  shakeRoll = 0;

  constructor() {
    this.root.name = 'vfx';
    this.root.matrixAutoUpdate = false;
    this.terrain = {
      height: () => 0,
      normal: (_x, _z, out) => out.set(0, 1, 0),
      type: () => 'grass',
    };
    for (let i = 0; i < SHAKE_LAYERS; i++) {
      this.shakes.push({ amp: 0, freq: 20, decay: 8, phase: 0, roll: 0, age: 0, life: 0 });
    }
  }

  build(capacityScale = 1): void {
    const cap = (n: number) => Math.max(64, Math.round(n * capacityScale));

    // 'soft' is the depth band over which a particle dissolves against opaque
    // geometry. It has to be judged against what these things *touch*, not
    // against how big they are: damage smoke and flame are emitted a metre or
    // two off an airframe that is right there, so a generous band means the
    // aircraft eats its own plume and you see the roundel through the fire.
    // Two to three metres is enough to kill the razor-cut where a column meets
    // a hillside, and small enough that a plume still reads as attached.
    // 1.6 m rather than 3: the band that stops a column razor-cutting a
    // hillside also dissolves the head of a damage plume against the aircraft
    // it is pouring off, because that aircraft is one to two metres away. Any
    // band wide enough to be generous about terrain deletes the attachment
    // point, and a detached plume is a much more obvious defect than a slightly
    // hard edge where smoke meets a ridge.
    this.smoke = this.engine.add({
      name: 'smoke', capacity: cap(9000), lit: true, additive: false,
      ink: 1.6, steps: 3, soft: 1.6, renderOrder: 20, bloom: false,
    });
    this.dust = this.engine.add({
      name: 'dust', capacity: cap(6000), lit: true, additive: false,
      ink: 0.9, steps: 3, soft: 2.5, renderOrder: 19, bloom: false,
    });
    this.water = this.engine.add({
      name: 'water', capacity: cap(2600), lit: true, additive: false,
      ink: 1.1, steps: 3, soft: 2, renderOrder: 21, bloom: false,
    });
    this.mist = this.engine.add({
      name: 'mist', capacity: cap(2200), lit: true, additive: false,
      ink: 0, steps: 3, soft: 3, renderOrder: 18, bloom: false,
    });
    // The fireball is *not* additive. Additive fire blows out to a white ball
    // the moment a dozen sprites overlap, and — decisively — additive geometry
    // cannot carry an ink outline. Opaque, value-quantised, outlined shapes are
    // what the art direction asks for; the additive additive flash group layered on
    // top supplies the heat.
    // Flame gets the tightest band of all: an engine fire is *supposed* to be
    // wrapped around the cowling it is coming out of, and fading it against
    // that cowling dissolves the tongue into a translucent orange wash with
    // the aircraft's own markings legible through it.
    this.fire = this.engine.add({
      // ink 1.5 -> 0.9, soft 0.5 -> 1.3. A constant-weight dark contour drawn
      // round an un-eroded tile is what turned every lick into the "hard-edged
      // flat capsule painted on the wing" the critique found: the outline is
      // the strongest cue in the stamp, and a closed one round a rounded tile
      // reads as a pill whatever is inside it. Thinning it lets the eroded
      // silhouette (see ParticleEngine's emissive erosion) carry the shape, and
      // widening the soft-depth band gives the tongue the fade against the
      // airframe the note also asks for — without going so far that the flame
      // dissolves into a wash with the cowling's markings legible through it.
      name: 'fire', capacity: cap(6000), lit: false, additive: false,
      ink: 0.9, steps: 4, soft: 1.3, renderOrder: 24, bloom: true,
    });
    this.flash = this.engine.add({
      name: 'flash', capacity: cap(1600), lit: false, additive: true,
      ink: 0, steps: 3, soft: 0, renderOrder: 26, bloom: true,
    });
    this.spark = this.engine.add({
      name: 'spark', capacity: cap(5000), lit: false, additive: true,
      ink: 0, steps: 3, soft: 0, renderOrder: 25, bloom: true,
    });
    this.haze = this.engine.add({
      name: 'haze', capacity: cap(900), lit: false, additive: true,
      ink: 0, steps: 6, soft: 1.5, renderOrder: 23, bloom: false,
    });
    this.haze.setOpacity(0.32);

    this.ringsHot = new RingSystem('hot', 64, this.engine.globals, true, 27);
    this.ringsDust = new RingSystem('dust', 64, this.engine.globals, false, 17);

    this.trailsBill = new TrailPool('bill', 'billboard', 64, 72, this.engine.globals, 16, false, false);
    this.trailsRibbon = new TrailPool('ribbon', 'ribbon', 48, 48, this.engine.globals, 15, true, true);
    this.trailsRibbon.setInk(0.9);

    const debrisCaps: Record<DebrisKind, number> = {
      chunk: Math.round(220 * capacityScale),
      panel: Math.round(160 * capacityScale),
      casing: Math.round(300 * capacityScale),
      clod: Math.round(180 * capacityScale),
    };
    this.debris = new DebrisSystem(debrisCaps, 0.011);

    this.root.add(this.engine.root);
    this.root.add(this.ringsHot.mesh);
    this.root.add(this.ringsDust.mesh);
    this.root.add(this.trailsBill.mesh);
    this.root.add(this.trailsRibbon.mesh);
    this.root.add(this.debris.root);
  }

  // -------------------------------------------------------------------------
  // Level of detail
  // -------------------------------------------------------------------------

  /**
   * Emission multiplier for an effect at a world position. Far-away events
   * still need their *silhouette* — the fireball, the column — but not their
   * grit, so counts fall off while sizes do not.
   */
  lod(x: number, y: number, z: number): number {
    const cp = this.camera.position;
    const dx = x - cp.x, dy = y - cp.y, dz = z - cp.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > 9e6) return 0.18;        // > 3 km
    if (d2 > 1.44e6) return 0.34;     // > 1.2 km
    if (d2 > 250000) return 0.62;     // > 500 m
    return 1;
  }

  /** Metres from the camera to a world point. */
  distTo(x: number, y: number, z: number): number {
    const cp = this.camera.position;
    return Math.hypot(x - cp.x, y - cp.y, z - cp.z);
  }

  /**
   * A floor on a stamp's radius so it survives at range.
   *
   * The LOD thins emission with distance, which is right for cost but wrong for
   * legibility: a plume made of one-metre puffs four hundred metres away is a
   * chain of two-pixel beads with sky between them, and a burning aircraft has
   * to read as burning from much further out than that. Scaling the *minimum*
   * radius with distance keeps the column's angular width roughly constant, so
   * fewer, larger stamps still cover it. 0.007 rad is roughly eighteen pixels
   * of a 1080p frame on a normal lens — enough that consecutive stamps overlap
   * rather than beading, which is what a thinned plume does otherwise.
   */
  minRadius(x: number, y: number, z: number): number {
    return this.distTo(x, y, z) * 0.007;
  }

  /** True when an effect is too far away to be worth spawning at all. */
  tooFar(x: number, y: number, z: number, maxRange: number): boolean {
    const cp = this.camera.position;
    const dx = x - cp.x, dy = y - cp.y, dz = z - cp.z;
    return dx * dx + dy * dy + dz * dz > maxRange * maxRange;
  }

  /** Rounds an emission count through the quality budget and distance LOD. */
  count(base: number, x: number, y: number, z: number): number {
    const n = base * this.budget * this.lod(x, y, z);
    const f = Math.floor(n);
    return f + (this.rng.next() < n - f ? 1 : 0);
  }

  rand(a: number, b: number): number { return a + this.rng.next() * (b - a); }
  sym(a: number): number { return (this.rng.next() * 2 - 1) * a; }

  /** Uniform point on a sphere, into v (scratch chosen by the caller). */
  sphere(out: THREE.Vector3, r: number): THREE.Vector3 {
    const u = this.rng.next() * 2 - 1;
    const th = this.rng.next() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    return out.set(Math.cos(th) * s * r, u * r, Math.sin(th) * s * r);
  }

  /** Random unit vector inside a cone of half-angle 'spread' about 'dir'. */
  cone(out: THREE.Vector3, dx: number, dy: number, dz: number, spread: number): THREE.Vector3 {
    const cosMax = Math.cos(spread);
    const c = cosMax + (1 - cosMax) * this.rng.next();
    const s = Math.sqrt(Math.max(0, 1 - c * c));
    const ph = this.rng.next() * Math.PI * 2;
    // Build a basis around the axis.
    const ax = dx, ay = dy, az = dz;
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(ay) > 0.94) { ux = 1; uy = 0; uz = 0; }
    let rx = uy * az - uz * ay, ry = uz * ax - ux * az, rz = ux * ay - uy * ax;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    const bx = ay * rz - az * ry, by = az * rx - ax * rz, bz = ax * ry - ay * rx;
    const cp = Math.cos(ph) * s, sp = Math.sin(ph) * s;
    return out.set(ax * c + rx * cp + bx * sp, ay * c + ry * cp + by * sp, az * c + rz * cp + bz * sp);
  }

  // -------------------------------------------------------------------------
  // Camera shake
  // -------------------------------------------------------------------------

  /**
   * Adds a shake impulse. 'radius' is the distance at which it is inaudible —
   * amplitude falls off with the inverse square, like real overpressure, and
   * is delayed by nothing because a visual shake that lags the flash reads as
   * a stutter rather than as physics.
   */
  addShake(amp: number, freq: number, life: number, x: number, y: number, z: number, radius: number, roll = 0.35): void {
    const cp = this.camera.position;
    const d = Math.hypot(x - cp.x, y - cp.y, z - cp.z);
    const att = radius <= 0 ? 1 : 1 / (1 + (d / radius) * (d / radius) * 4);
    const a = amp * att;
    if (a < 0.0006) return;
    const s = this.shakes[this.shakeCursor];
    this.shakeCursor = (this.shakeCursor + 1) % this.shakes.length;
    // Only take the slot if the incoming impulse is stronger than what is
    // already decaying in it; otherwise a stream of small hits would cancel
    // out a big one.
    const remaining = s.amp * Math.exp(-s.decay * s.age);
    if (remaining > a * 1.2) return;
    s.amp = a;
    s.freq = freq;
    s.decay = 3.2 / Math.max(0.05, life);
    s.phase = this.rng.next() * Math.PI * 2;
    s.roll = roll;
    s.age = 0;
    s.life = life;
  }

  /** Local-space (camera axes) shake offset plus a roll in radians. */
  updateShake(dt: number): void {
    let ox = 0, oy = 0, roll = 0;
    for (const s of this.shakes) {
      if (s.amp <= 0) continue;
      s.age += dt;
      if (s.age > s.life) { s.amp = 0; continue; }
      const env = Math.exp(-s.decay * s.age);
      const w = s.freq * s.age * Math.PI * 2;
      const a = s.amp * env;
      // Two incommensurate frequencies per layer so the motion never repeats.
      ox += Math.sin(w + s.phase) * a * (1 - s.roll);
      oy += Math.sin(w * 1.37 + s.phase * 2.1) * a * (1 - s.roll) * 0.8;
      roll += Math.sin(w * 0.81 + s.phase * 0.7) * a * s.roll * 0.09;
    }
    this.shakeOffset.set(ox, oy, 0);
    this.shakeRoll = roll;
  }

  clearShake(): void {
    for (const s of this.shakes) s.amp = 0;
    this.shakeOffset.set(0, 0, 0);
    this.shakeRoll = 0;
  }

  // -------------------------------------------------------------------------

  flush(): void {
    this.engine.flush(this.time);
    this.ringsHot.flush(this.time);
    this.ringsDust.flush(this.time);
    this.trailsBill.flush(this.time);
    this.trailsRibbon.flush(this.time);
  }

  setBudgetScale(f: number): void {
    this.budget = f;
    this.engine.setBudgetScale(Math.min(1, f));
    this.debris.setBudgetScale(Math.min(1, f));
  }

  clear(): void {
    this.fireLight.clear();
    this.engine.clear();
    this.ringsHot.clear();
    this.ringsDust.clear();
    this.trailsBill.clear();
    this.trailsRibbon.clear();
    this.debris.clear();
    this.clearShake();
  }

  dispose(): void {
    this.fireLight.dispose();
    this.engine.dispose();
    this.ringsHot.dispose();
    this.ringsDust.dispose();
    this.trailsBill.dispose();
    this.trailsRibbon.dispose();
    this.debris.dispose();
  }
}
