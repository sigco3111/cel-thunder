import * as THREE from 'three';
import { resetSpawn } from './ParticleEngine';
import { RAMP, SMOKE_TILES, TILE } from './VfxTextures';
import { DEFAULT_TRAIL, NO_TRAIL, type TrailConfig } from './TrailSystem';
import { DamageBits } from '../shared/protocol';
import { DEBRIS_COLORS } from './DebrisSystem';
import type { VfxCore } from './VfxCore';
import type { AircraftFx } from './EntityFx';
import type { AirflowInput } from './Airflow';

/**
 * Battle damage, staged so a pilot can read an enemy's condition at a glance —
 * which is the actual gameplay function of these effects.
 *
 * The escalation is the real one, in order of how bad it is for you:
 *
 *   white   coolant/glycol boiling out of a holed radiator. Thin, bright,
 *           blows away fast. Engine will overheat, but it is still running.
 *   grey    engine oil burning on hot metal. Denser, hangs longer, greasy.
 *   black   fuel. Thick, rolling, opaque, and the aircraft is now a bomb.
 *   fire    streaming flame with stepped colour bands and a heat-haze wake.
 *           Roughly thirty seconds of life left.
 *
 * The stages are *cross-faded*, not simply summed. Emitting white, grey and
 * black at full rate at once averages out to an even mid-brown column and the
 * escalation stops being readable — which is the one thing these effects exist
 * for. So each stage is weighted by how far past it the aircraft has got:
 * coolant is drowned out once oil is burning, oil thins once the fuel goes, and
 * everything except the black column is suppressed once there is open flame,
 * exactly the way it works on the real thing.
 */

/** How bad it is, in stages. Used only to cross-fade the emission weights. */
const enum Stage { None = -1, Coolant = 0, Oil = 1, Fuel = 2, Fire = 3 }

/** Weight for a stage given the worst one currently active. */
function stageWeight(stage: Stage, worst: Stage): number {
  const behind = worst - stage;
  if (behind < 0) return 0;
  // One stage behind still contributes; two or more is gone. A cel plume wants
  // two colours in it at most or the bands stop reading as bands.
  return behind === 0 ? 1 : behind === 1 ? 0.35 : 0;
}

export interface DamageAnchors {
  /** World position of the engine / cowling. */
  ex: number; ey: number; ez: number;
  /** World position of the left and right wing roots or stumps. */
  lx: number; ly: number; lz: number;
  rx: number; ry: number; rz: number;
  /** World position of the tail. */
  tx: number; ty: number; tz: number;
}

const _v = new THREE.Vector3();

/**
 * Cycles the four smoke silhouettes.
 *
 * A plume built from one repeated stamp reads as a string of identical beads
 * however it is shaded — the eye locks onto the repetition long before it
 * notices the shading. Advancing a shared cursor (rather than using 'i % 4')
 * means consecutive *ticks* also differ, so no two adjacent puffs anywhere in
 * the column share an outline.
 */
let smokeTileCursor = 0;
function smokeTile(): number {
  smokeTileCursor = (smokeTileCursor + 1) % SMOKE_TILES.length;
  return SMOKE_TILES[smokeTileCursor];
}

/**
 * Where along the last emission interval this stamp should be born.
 *
 * Everything in a tick is otherwise born at the emitter's *current* position,
 * so at 110 m/s a 26 ms interval lays down clumps three metres apart with bare
 * sky between them — which is exactly the "detached, beaded" trail. Walking
 * each stamp back along the path the aircraft has just flown fills the gap for
 * one multiply per particle, and it anchors the head of the plume to the
 * airframe: the newest stamp is at u≈0, i.e. on the emitter itself.
 */
function pathBack(i: number, n: number, rnd: number): number {
  return (i + rnd) / n;
}

export function updateDamageFx(
  core: VfxCore,
  fx: AircraftFx,
  a: AirflowInput,
  bits: number,
  health: number,
  anch: DamageAnchors,
): void {
  const now = core.time;
  const dt = core.dt;
  const p = resetSpawn();

  const engineHit = (bits & DamageBits.Engine) !== 0;
  const oil = (bits & DamageBits.OilLeak) !== 0;
  const fuel = (bits & DamageBits.FuelLeak) !== 0;
  const fire = (bits & DamageBits.EngineFire) !== 0;
  const wingRipped = (bits & DamageBits.WingRipped) !== 0;
  const wingHit = (bits & (DamageBits.LeftWing | DamageBits.RightWing)) !== 0;
  const tailHit = (bits & (DamageBits.Tail | DamageBits.Rudder | DamageBits.Elevator)) !== 0;
  const dying = health < 0.28;

  if (!engineHit && !oil && !fuel && !fire && !wingRipped && !wingHit && !tailHit && !dying) {
    releaseDamageTrail(core, fx);
    return;
  }

  // Everything is emitted into the airstream: the trailing velocity is the
  // aircraft's own, heavily damped, which is what makes damage smoke lie along
  // the flight path instead of ballooning around the aircraft.
  const wake = 0.30;

  // Smallest stamp radius that still reads at this range — see VfxCore.
  // Damage smoke is a *signal*, and it has to survive out to the distance at
  // which one aircraft is deciding whether another one is worth chasing.
  const minR = core.minRadius(anch.ex, anch.ey, anch.ez);

  const oiling = oil || (engineHit && health < 0.6);
  const worst: Stage = fire ? Stage.Fire
    : fuel ? Stage.Fuel
      : oiling ? Stage.Oil
        : (engineHit || dying) ? Stage.Coolant : Stage.None;

  const wWhite = engineHit ? stageWeight(Stage.Coolant, worst) : 0;
  const wGrey = oiling ? stageWeight(Stage.Oil, worst) : 0;
  const wBlack = fuel ? stageWeight(Stage.Fuel, worst) : 0;

  // --- white: coolant / glycol ---------------------------------------------
  if (wWhite > 0.01) {
    fx.coolantTimer -= dt;
    if (fx.coolantTimer <= 0) {
      const period = 0.024 / wWhite;
      fx.coolantTimer = period;
      const n = core.count(3, anch.ex, anch.ey, anch.ez);
      for (let i = 0; i < n; i++) {
        const u = pathBack(i, n, core.rng.next()) * period;
        // Coolant is blown straight out of the radiator duct and shredded, so
        // it is staged along a short length of the path with the spread and the
        // wind authority both climbing aft — same construction as the fire
        // column, at a tenth of the scale.
        const s = core.rng.next();
        const back = s * 2.6;
        const spread = 0.28 + back * 0.22;
        p.x = anch.ex - a.vx * u - a.fwd.x * back + core.sym(spread);
        p.y = anch.ey - a.vy * u - a.fwd.y * back + core.sym(spread * 0.8);
        p.z = anch.ez - a.vz * u - a.fwd.z * back + core.sym(spread);
        p.vx = a.vx * wake + core.sym(2 + s * 4);
        p.vy = a.vy * wake + core.rand(0.5, 3.5);
        p.vz = a.vz * wake + core.sym(2 + s * 4);
        p.life = core.rand(0.7, 1.9);
        // Wide size spread. Uniform stamps read as a repeated motif; a plume
        // whose components differ by 2-3x in radius reads as a single volume
        // because the eye can no longer isolate one of them.
        p.size0 = Math.max(minR, core.rand(0.30, 0.75));
        p.size1 = Math.max(minR * 3, core.rand(2.2, 5.5));
        p.rot = core.rand(0, 6.283); p.spin = core.sym(1.9);
        p.drag = core.rand(1.4, 2.6);
        p.grav = -0.12;
        p.wind = 0.7 + s * 0.9; p.turb = 0.5 + s * 0.9;
        p.ramp = RAMP.SmokeWhite;
        p.tile = core.rng.next() < 0.30 + s * 0.35 ? TILE.Wisp : smokeTile();
        p.erode = core.rand(0.70, 0.95); p.band = 0.7;
        // Steam brightens as it expands and catches the sun from every side —
        // the opposite of soot, and the reason the two stages never get
        // confused even when both are backlit.
        p.r = p.g = p.b = 0.92 + s * 0.22;
        p.a = 0.85 * wWhite * (1 - s * 0.3);
        core.smoke.emit(now, p);
      }
    }
  }

  // --- grey: engine oil burning on hot metal -------------------------------
  if (wGrey > 0.01) {
    fx.oilTimer -= dt;
    if (fx.oilTimer <= 0) {
      const period = 0.026 / wGrey;
      fx.oilTimer = period;
      const n = core.count(3, anch.ex, anch.ey, anch.ez);
      for (let i = 0; i < n; i++) {
        const u = pathBack(i, n, core.rng.next()) * period;
        const s = core.rng.next();
        const back = 0.6 + s * s * 4.5;
        const spread = 0.32 + back * 0.24;
        p.x = anch.ex - a.vx * u - a.fwd.x * back + core.sym(spread);
        p.y = anch.ey - a.vy * u - a.fwd.y * back + core.sym(spread * 0.8);
        p.z = anch.ez - a.vz * u - a.fwd.z * back + core.sym(spread);
        p.vx = a.vx * (wake - s * 0.12) + core.sym(1.6 + s * 3.5);
        p.vy = a.vy * (wake - s * 0.12) + core.rand(0.4, 2.6);
        p.vz = a.vz * (wake - s * 0.12) + core.sym(1.6 + s * 3.5);
        p.life = core.rand(1.6, 4.2);
        p.size0 = Math.max(minR, core.rand(0.40, 1.05) * (0.8 + s * 0.7));
        p.size1 = Math.max(minR * 3, core.rand(3.2, 8.0) * (0.8 + s * 0.7));
        p.rot = core.rand(0, 6.283); p.spin = core.sym(1.2);
        p.drag = core.rand(0.9, 1.8);
        p.grav = -0.08;
        p.wind = 0.7 + s * 1.1; p.turb = 0.6 + s * 1.1;
        p.ramp = RAMP.SmokeOil;
        p.tile = core.rng.next() < 0.10 + s * 0.45 ? TILE.Torn : smokeTile();
        p.erode = core.rand(0.54, 0.78) + s * 0.20; p.band = 0.9;
        p.r = p.g = p.b = 0.72 + s * 0.55 + core.sym(0.06);
        p.a = 0.95 * (0.35 + wGrey * 0.65) * (1 - s * 0.3);
        core.smoke.emit(now, p);
      }
    }
  }

  // --- black: fuel ---------------------------------------------------------
  // Two separate reads. At the leak itself, atomised fuel is a near-transparent
  // shimmer; a few metres downstream it has picked up enough hot exhaust to
  // char, and *that* is the thick opaque black column that says this aircraft
  // is finished. Emitting only the mist (as this did) left the black stage of
  // the escalation with no visual at all until the aircraft actually caught.
  if (wBlack > 0.01) {
    fx.fuelTimer -= dt;
    if (fx.fuelTimer <= 0) {
      fx.fuelTimer = 0.028 / wBlack;
      // Which wing is leaking — pick the damaged one, or both.
      for (let side = 0; side < 2; side++) {
        const dmg = side === 0 ? (bits & DamageBits.LeftWing) : (bits & DamageBits.RightWing);
        if (!dmg && (bits & (DamageBits.LeftWing | DamageBits.RightWing))) continue;
        const ax = side === 0 ? anch.lx : anch.rx;
        const ay = side === 0 ? anch.ly : anch.ry;
        const az = side === 0 ? anch.lz : anch.rz;

        const n = core.count(3, ax, ay, az);
        for (let i = 0; i < n; i++) {
          p.x = ax + core.sym(0.25);
          p.y = ay + core.sym(0.2);
          p.z = az + core.sym(0.25);
          p.vx = a.vx * 0.55 + core.sym(2);
          p.vy = a.vy * 0.55 + core.sym(2);
          p.vz = a.vz * 0.55 + core.sym(2);
          // Atomised fuel is a *mist*: many tiny, short-lived, near-transparent
          // particles, not a smoke plume. It should read as a shimmer.
          p.life = core.rand(0.35, 0.9);
          p.size0 = core.rand(0.10, 0.3);
          p.size1 = core.rand(1.2, 2.6);
          p.rot = core.rand(0, 6.283); p.spin = core.sym(2);
          p.drag = core.rand(2.4, 4.5);
          p.grav = 0.05;
          p.wind = 0.7; p.turb = 0.4;
          p.ramp = RAMP.FuelMist; p.tile = TILE.Wisp;
          p.erode = 0.8; p.band = 0.4;
          p.a = 0.7 * wBlack;
          core.mist.emit(now, p);
        }

        // The charring column, a few metres aft of the leak.
        const bn = core.count(2.2, ax, ay, az);
        for (let i = 0; i < bn; i++) {
          const u = pathBack(i, bn, core.rng.next()) * 0.028;
          const s = core.rng.next();
          const back = 1.0 + s * 3.5;
          const spread = 0.4 + back * 0.26;
          p.x = ax - a.vx * u - a.fwd.x * back + core.sym(spread);
          p.y = ay - a.vy * u - a.fwd.y * back + core.sym(spread * 0.8);
          p.z = az - a.vz * u - a.fwd.z * back + core.sym(spread);
          p.vx = a.vx * (0.26 - s * 0.12) + core.sym(1.8 + s * 4);
          p.vy = a.vy * (0.26 - s * 0.12) + core.rand(0.5, 3.0);
          p.vz = a.vz * (0.26 - s * 0.12) + core.sym(1.8 + s * 4);
          p.life = core.rand(2.4, 6.0);
          p.size0 = core.rand(0.7, 1.8) * (0.8 + s * 0.6);
          p.size1 = core.rand(5.0, 13.0) * (0.8 + s * 0.6);
          p.rot = core.rand(0, 6.283); p.spin = core.sym(0.7);
          p.drag = core.rand(0.5, 1.0);
          p.grav = -0.10;
          p.wind = 0.8 + s * 1.2; p.turb = 0.7 + s * 1.4;
          p.ramp = RAMP.SmokeBlack;
          p.tile = core.rng.next() < 0.08 + s * 0.48 ? TILE.Torn : smokeTile();
          p.erode = core.rand(0.48, 0.74) + s * 0.22; p.band = 1.1;
          p.r = p.g = p.b = 0.62 + s * 0.62 + core.sym(0.06);
          p.a = wBlack * (1 - s * 0.3);
          core.smoke.emit(now, p);
        }
      }
    }
  }

  // --- fire ----------------------------------------------------------------
  if (fire) {
    // Claim a light. Reported unconditionally, before the emission gate, so the
    // spill is steady rather than pulsing with the particle tick — and reported
    // at the *root* of the flame, half a metre out on the side of the cowling,
    // because that is where the light physically comes from.
    core.fireLight.report(
      anch.ex - a.fwd.x * 0.6 - a.up.x * 0.15,
      anch.ey - a.fwd.y * 0.6 - a.up.y * 0.15,
      anch.ez - a.fwd.z * 0.6 - a.up.z * 0.15,
      dying ? 1.5 : 1.0,
    );

    fx.fireTimer -= dt;
    if (fx.fireTimer <= 0) {
      const firePeriod = 0.017;
      fx.fireTimer = firePeriod;
      // Flame licks, not a fireball and not a rod.
      //
      // What made the old version read as melted plastic was three things at
      // once: round sprites, stamps two to five metres across on a nine-metre
      // aeroplane, and a ramp that held saturated orange for half of each
      // particle's life. A dozen of those overlapping average into one opaque
      // mass with no internal structure and no silhouette.
      //
      // The rebuild inverts all three. The stamps are the Flame/FlameB tiles —
      // forked tongues, root at sprite +Y, torn tips at -Y — so each one has a
      // flame *outline* of its own. They are small (a third to a metre and a
      // half) and there are more of them, spread back along the path the
      // aircraft has just flown so they form a continuous streaming shape
      // rather than a pulsing clump. And they are velocity-stretched, which
      // aligns every tongue's root forward at the cowling with its tips
      // trailing aft — the licking direction is then a property of the
      // airflow, not of an authored rotation.
      // Deliberately modest. The count is the difference between "the engine is
      // burning" and "the aeroplane is inside a bonfire": at 5.5 per tick the
      // licks tiled solid over the whole forward fuselage and the aircraft
      // stopped being readable at all, which is a worse failure than the
      // original blob because it also destroys the silhouette.
      const n = core.count(2.2, anch.ex, anch.ey, anch.ez);
      for (let i = 0; i < n; i++) {
        const u = pathBack(i, n, core.rng.next()) * firePeriod;
        // How far aft of the cowling this lick starts. Flame does not all come
        // from one hole: it is drawn out of the exhaust stubs, the cowl
        // louvres and the wheel well over a couple of metres of fuselage.
        const back = core.rand(0, 1.4);
        // *Outside* the skin, not on the centreline.
        //
        // A cowling is about a metre wide, so emitting at ±0.25-0.65 m put the
        // billboard's centre inside the fuselage: the depth test threw away the
        // near half and the soft-depth erosion ate most of the rest, leaving
        // only the particles that had aged far enough aft to clear the airframe
        // — which is to say only the old, red, dying ones. Emitting clear of the
        // skin is what makes the *hot* end of the flame visible at all.
        // Alternating sides with a wide lateral and vertical spread. Emitting
        // every lick into the same narrow band makes them overlap into a single
        // continuous orange bar down the fuselage; fanning them across the
        // width of the cowling and half a metre of height lets consecutive
        // stamps sit beside one another and read as separate tongues.
        const side = (i & 1) === 0 ? -1 : 1;
        const lat = side * core.rand(0.55, 1.30);
        const drop = -core.rand(0.05, 0.60) + core.sym(0.18);
        p.x = anch.ex - a.vx * u - a.fwd.x * back + a.right.x * lat + a.up.x * drop;
        p.y = anch.ey - a.vy * u - a.fwd.y * back + a.right.y * lat + a.up.y * drop;
        p.z = anch.ez - a.vz * u - a.fwd.z * back + a.right.z * lat + a.up.z * drop;
        // Nearly the aircraft's own velocity, with very little drag.
        //
        // This is what actually anchors the fire. At 0.46 of the airspeed with
        // a drag coefficient of 3 the flame is decelerating to a standstill in
        // world space, so at 110 m/s it falls five to fifteen metres behind the
        // cowling inside its own lifetime and the whole fire ends up hanging
        // off the tail. Real flame is dragged along *with* the airframe by the
        // boundary layer; it lies back a couple of metres, no more. Keeping 88%
        // of the velocity and dropping the drag to near-ballistic puts the root
        // on the exhaust stubs, where it belongs, and the aft lean then comes
        // from the velocity stretch rather than from the particle falling
        // behind.
        // Spread per lick rather than fixed: identical cling makes every tongue
        // travel identically and the fire congeals into one solid band with a
        // hot core. A spread of a few per cent is enough for consecutive stamps
        // to separate into distinguishable tongues.
        const cling = core.rand(0.82, 0.97) - back * 0.05;
        p.vx = a.vx * cling + core.sym(2.4);
        p.vy = a.vy * cling + core.rand(0, 2.4);
        p.vz = a.vz * cling + core.sym(2.4);
        // Short. The flame is the *source*, not the plume: on a real burning
        // fighter it is a tongue a few metres long at the cowling and the smoke
        // does all the work behind it.
        p.life = core.rand(0.10, 0.26);
        p.size0 = core.rand(0.22, 0.46);
        p.size1 = core.rand(0.60, 1.30);
        p.rot = 0; p.spin = 0;
        p.drag = core.rand(0.35, 0.9);
        p.grav = -0.5;
        p.wind = 0.2; p.turb = 1.1;
        // 'stretch' is metres of extra length per m/s of screen-space velocity.
        // At 0.032 a lick is roughly two and a half times as long as it is wide
        // at 50 m/s of apparent motion and collapses to a round flare when the
        // aircraft is stationary on the ground, which is correct for both.
        p.stretch = 0.032;
        p.ramp = RAMP.FireStream;
        p.tile = i % 2 === 0 ? TILE.Flame : TILE.FlameB;
        // Flicker: modulating the erosion per particle is what gives stepped
        // fire its nervous, hand-drawn edge instead of a smooth taper.
        p.erode = core.rand(0.18, 0.72);
        p.band = core.rand(1.4, 2.2);
        // Tinted decisively warm. The FireStream ramp opens on near-white, and
        // a dozen overlapping opaque stamps sitting in that band fuse into a
        // single yellow-white bar that reads as a welding arc rather than as
        // fire. Pulling blue (and a little green) out of the tint keeps the
        // hottest band a cream-orange, so the ramp's own progression to red
        // stays visible across the licks.
        p.r = 1; p.g = core.rand(0.80, 0.94); p.b = core.rand(0.52, 0.74);
        p.a = 0.92;
        core.fire.emit(now, p);
      }

      // The white-hot root, right at the source: a couple of small, very short,
      // barely-eroded stamps that never get far enough down the ramp to go red.
      // Without these the fire has no anchor point and the tongues look like
      // they are floating alongside the aeroplane.
      const rn = core.count(0.7, anch.ex, anch.ey, anch.ez);
      for (let i = 0; i < rn; i++) {
        const side = core.rng.next() < 0.5 ? -1 : 1;
        p.x = anch.ex + a.right.x * side * 0.72 - a.up.x * 0.26;
        p.y = anch.ey + a.right.y * side * 0.72 - a.up.y * 0.26;
        p.z = anch.ez + a.right.z * side * 0.72 - a.up.z * 0.26;
        p.vx = a.vx * 0.96 + core.sym(1.2);
        p.vy = a.vy * 0.96 + core.rand(0, 1.2);
        p.vz = a.vz * 0.96 + core.sym(1.2);
        p.life = core.rand(0.05, 0.11);
        p.size0 = core.rand(0.14, 0.24); p.size1 = core.rand(0.26, 0.44);
        p.rot = core.rand(0, 6.283); p.spin = core.sym(6);
        p.drag = 0.4; p.grav = -0.3; p.wind = 0; p.turb = 0.4;
        p.stretch = 0.014;
        p.ramp = RAMP.FireCore; p.tile = TILE.Star;
        p.erode = 0.05; p.band = 2.2;
        p.r = 1; p.g = 0.95; p.b = 0.78; p.a = 1;
        core.fire.emit(now, p);
      }
      p.stretch = 0;

      // Embers torn off the flame. More of them, thrown further, because a
      // stream of hot specks tumbling aft is most of what sells a fire as
      // *burning* rather than as a painted-on shape.
      const en = core.count(4.5, anch.ex, anch.ey, anch.ez);
      for (let i = 0; i < en; i++) {
        const u = pathBack(i, en, core.rng.next()) * firePeriod;
        const back = core.rand(0, 2.0);
        p.x = anch.ex - a.vx * u - a.fwd.x * back + core.sym(0.45);
        p.y = anch.ey - a.vy * u - a.fwd.y * back + core.sym(0.45);
        p.z = anch.ez - a.vz * u - a.fwd.z * back + core.sym(0.45);
        p.vx = a.vx * 0.42 + core.sym(7);
        p.vy = a.vy * 0.42 + core.rand(-1.5, 5);
        p.vz = a.vz * 0.42 + core.sym(7);
        p.life = core.rand(0.35, 1.5);
        p.size0 = core.rand(0.05, 0.15); p.size1 = p.size0 * 0.35;
        p.drag = core.rand(1.1, 2.0); p.grav = 0.7; p.wind = 0.8;
        p.ramp = core.rng.next() < 0.3 ? RAMP.SparkHot : RAMP.Ember;
        p.tile = TILE.Streak;
        p.stretch = 0.030; p.erode = 0.1; p.band = 1;
        p.a = 1;
        core.spark.emit(now, p);
      }
      p.stretch = 0;

      // Heat haze. Additive, near-transparent, banded lens cards riding the
      // wake. When the renderer offers a scene-colour texture these become a
      // real refraction; until then they read as a shimmering warm distortion.
      //
      // Emitted sparsely and on a coin flip rather than every fire tick. These
      // are *additive*, so N overlapping cards sum: at two per 26 ms with a
      // half-second life there are ~40 of them stacked over the fuselage and
      // the "shimmer" saturates into a flat red wash with the aircraft's own
      // markings showing through it. Three or four alive at once is the effect;
      // forty is a filter.
      //
      // Held *on* the cowling, and kept small. At 0.35 of the airspeed with a
      // half-second life a card is forty metres astern by the time it dies, and
      // once the smoke behind it went properly dark those cards stopped being
      // an invisible shimmer and became a row of soft warm lozenges floating
      // down the plume — a plainly additive artifact sitting on top of the one
      // effect that is meant to be the darkest thing in the frame. Refraction
      // happens in the few metres of air the flame is actually heating, so the
      // card now travels with the airframe (0.88 of its velocity, as the flame
      // itself does) and is dead before it can be left behind.
      const hn = core.rng.next() < 0.25 ? core.count(1, anch.ex, anch.ey, anch.ez) : 0;
      for (let i = 0; i < hn; i++) {
        const back = core.rand(0.4, 2.6);
        p.x = anch.ex - a.fwd.x * back + core.sym(0.5);
        p.y = anch.ey - a.fwd.y * back + core.sym(0.5);
        p.z = anch.ez - a.fwd.z * back + core.sym(0.5);
        p.vx = a.vx * 0.88; p.vy = a.vy * 0.88 + 1.5; p.vz = a.vz * 0.88;
        p.life = core.rand(0.16, 0.34);
        p.size0 = core.rand(0.5, 0.9);
        p.size1 = core.rand(1.2, 2.1);
        p.rot = core.rand(0, 6.283); p.spin = core.sym(1.5);
        p.drag = 2.0; p.grav = -0.4; p.wind = 0.2; p.turb = 1.4;
        p.ramp = RAMP.Haze; p.tile = TILE.Lens;
        p.erode = 0.5; p.band = 2.5;
        p.a = 0.30;
        core.haze.emit(now, p);
      }
    }

    // Black smoke behind the fire — the plume that makes a burning aircraft
    // visible from ten kilometres.
    fx.fireSmokeTimer -= dt;
    if (fx.fireSmokeTimer <= 0) {
      // Fewer, larger stamps rather than more, smaller ones. Both give the same
      // covered area, but the fragment cost is proportional to how many *layers*
      // deep the overdraw goes, and a plume is the worst case in the frame for
      // that: at 250 stamps a second with a four-second life there are a
      // thousand alive, all of them near-coplanar with the camera.
      const period = 0.026;
      fx.fireSmokeTimer = period;
      const n = core.count(3.2, anch.ex, anch.ey, anch.ez);
      for (let i = 0; i < n; i++) {
        // Two things anchor this column to the aeroplane. 'u' walks the stamp
        // back along the path already flown, so the newest stamp is level with
        // the cowling and the tick's worth of them fills the three metres the
        // aircraft covered since the last one. 'back' then stages them along
        // the fuselage, so the column starts *at* the fire and thickens aft
        // instead of appearing as a detached cloud several lengths behind.
        const u = pathBack(i, n, core.rng.next()) * period;
        const t = core.rng.next();
        // Staged from just aft of the cowling to well past the tail. The near
        // end has to start *clear of the airframe*: soft-depth erosion dissolves
        // anything within a couple of metres of a surface, so smoke emitted on
        // the fuselage is simply deleted and the plume appears detached.
        const back = 2.2 + t * t * 8.0;
        // How far down the plume this stamp is born, 0…1. Everything else in
        // this emitter is a function of it, which is what turns a column of
        // interchangeable stamps into a plume with a *near end* and a *far
        // end*: dark, tight, dense and opaque where it leaves the cowling;
        // pale, wide, ragged and thin by the time it is past the tail.
        const s = (back - 2.2) / 8.0;
        // Dispersion. A plume does not travel as a rigid tube — the shear layer
        // at its edge tears it open, so the spread has to grow down its length
        // rather than being a constant jitter about the flight path.
        const spread = 0.5 + back * 0.28;
        p.x = anch.ex - a.vx * u - a.fwd.x * back + core.sym(spread);
        p.y = anch.ey - a.vy * u - a.fwd.y * back + core.sym(spread * 0.8);
        p.z = anch.ez - a.vz * u - a.fwd.z * back + core.sym(spread);
        // Advection: the emitter's own velocity, decaying with distance aft as
        // the puff is left behind and handed over to the wind. Plus a lateral
        // kick that also grows aft, so the column visibly opens out instead of
        // running as a parallel-sided rope.
        const carry = 0.30 - s * 0.16;
        const fan = 1.5 + s * 5.0;
        p.vx = a.vx * carry + core.sym(fan);
        p.vy = a.vy * carry + core.rand(0.8, 3.4);
        p.vz = a.vz * carry + core.sym(fan);
        p.life = core.rand(3.0, 7.5);
        // The size ramps with how far aft the stamp starts, so the column has a
        // taper: tight and dark at the fire, broad and breaking up downstream.
        // The floor matters as much as the slope — a half-metre stamp at the
        // head of the plume is a sub-pixel speck by the time the aircraft is
        // four hundred metres away, and a burning fighter has to be legible
        // from ten kilometres.
        const grow = 0.60 + back * 0.055;
        p.size0 = Math.max(minR, core.rand(1.1, 2.6) * grow);
        p.size1 = Math.max(minR * 3, core.rand(7.0, 16.5) * grow);
        p.rot = core.rand(0, 6.283); p.spin = core.sym(0.7);
        p.drag = core.rand(0.5, 1.0);
        p.grav = -0.1;
        // Wind authority and turbulence both climb down the plume: fresh soot
        // is still moving with the aeroplane, old soot belongs to the air mass.
        p.wind = 0.75 + s * 1.30; p.turb = 0.7 + s * 1.5;
        p.ramp = RAMP.SmokeBlack;
        // The far end is emitted as the Torn remnant much more often, so the
        // plume literally comes apart downstream rather than merely fading.
        p.tile = core.rng.next() < 0.08 + s * 0.52 ? TILE.Torn : smokeTile();
        p.erode = core.rand(0.46, 0.72) + s * 0.24; p.band = 1.0;
        // Value staging down the length: near-black at the fire, greying out as
        // it disperses. This is the gradient that makes a plume read as one
        // continuous body of gas — a column of stamps at one random value is
        // the "chain of identical stickers" read, and it is the tint, not the
        // shading, that was producing it.
        p.r = p.g = p.b = 0.62 + s * 0.66 + core.sym(0.07);
        p.a = 1 - s * 0.34;
        core.smoke.emit(now, p);
      }

      // The root of the column.
      //
      // The long-lived stamps above are what makes the plume readable from ten
      // kilometres, but they are emitted small and thin so they can grow over
      // four to seven seconds — which leaves the first thirty metres behind the
      // aircraft nearly empty and the whole plume reading as detached. These
      // are the opposite: big at birth, short-lived, and never seen more than a
      // few metres from the fire. They cost almost nothing (a one-second life
      // means only a handful are ever alive) and they are what welds the column
      // to the airframe.
      const rn = core.count(2.6, anch.ex, anch.ey, anch.ez);
      for (let i = 0; i < rn; i++) {
        const u = pathBack(i, rn, core.rng.next()) * period;
        const back = core.rand(1.2, 5.0);
        p.x = anch.ex - a.vx * u - a.fwd.x * back + core.sym(0.6);
        p.y = anch.ey - a.vy * u - a.fwd.y * back + core.sym(0.6);
        p.z = anch.ez - a.vz * u - a.fwd.z * back + core.sym(0.6);
        p.vx = a.vx * 0.42 + core.sym(2.5);
        p.vy = a.vy * 0.42 + core.rand(0.5, 3.0);
        p.vz = a.vz * 0.42 + core.sym(2.5);
        p.life = core.rand(0.9, 1.8);
        p.size0 = Math.max(minR, core.rand(1.8, 3.3));
        p.size1 = Math.max(minR * 2, core.rand(4.4, 8.0));
        p.rot = core.rand(0, 6.283); p.spin = core.sym(1.1);
        p.drag = core.rand(0.6, 1.2); p.grav = -0.1;
        p.wind = 0.7; p.turb = 0.8;
        p.ramp = RAMP.SmokeBlack;
        p.tile = smokeTile();
        p.erode = core.rand(0.40, 0.62); p.band = 1.1;
        // The root of the column is the darkest, densest smoke in the frame —
        // it is soot that has existed for a tenth of a second. Keeping it well
        // below the ramp's own value is what anchors the far end's grey to
        // something, so the length of the plume reads as a gradient.
        p.r = p.g = p.b = core.rand(0.56, 0.74); p.a = 1;
        core.smoke.emit(now, p);
      }
    }
  }

  // --- ripped structure ----------------------------------------------------
  if (wingRipped || (bits & DamageBits.ControlsSevered) !== 0) {
    ensureDamageTrail(core, fx, fire);
    if (fx.debrisTrail !== NO_TRAIL) {
      // Anchor the trail at whichever wing is gone, or the tail if it is not.
      const useLeft = (bits & DamageBits.LeftWing) !== 0;
      const ax = wingRipped ? (useLeft ? anch.lx : anch.rx) : anch.tx;
      const ay = wingRipped ? (useLeft ? anch.ly : anch.ry) : anch.ty;
      const az = wingRipped ? (useLeft ? anch.lz : anch.rz) : anch.tz;
      core.trailsBill.extend(fx.debrisTrail, now, ax, ay, az);
    }

    fx.debrisTimer -= dt;
    if (fx.debrisTimer <= 0) {
      fx.debrisTimer = core.rand(0.08, 0.25);
      const useLeft = (bits & DamageBits.LeftWing) !== 0;
      const ax = useLeft ? anch.lx : anch.rx;
      const ay = useLeft ? anch.ly : anch.ry;
      const az = useLeft ? anch.lz : anch.rz;
      core.debris.spawn({
        x: ax, y: ay, z: az,
        vx: a.vx * 0.75 + core.sym(6),
        vy: a.vy * 0.75 + core.sym(6),
        vz: a.vz * 0.75 + core.sym(6),
        kind: core.rng.next() < 0.6 ? 'panel' : 'chunk',
        size: core.rand(0.12, 0.42),
        life: core.rand(2.0, 4.5),
        color: DEBRIS_COLORS.aluminium,
        spin: core.rand(8, 26),
        burning: fire ? 1 : 0,
        drag: 0.5,
      });
    }
  } else {
    releaseDamageTrail(core, fx);
  }

  // --- terminal: a dying airframe sheds everything -------------------------
  if (dying && !fire) {
    // Its own accumulator: fx.oilTimer belongs to the grey stage above, and two
    // emitters sharing one countdown starve each other at random.
    fx.fireSmokeTimer -= dt;
    if (fx.fireSmokeTimer <= 0) {
      const period = 0.045;
      fx.fireSmokeTimer = period;
      const n = core.count(1.6, anch.ex, anch.ey, anch.ez);
      for (let i = 0; i < n; i++) {
        const u = pathBack(i, n, core.rng.next()) * period;
        const s = core.rng.next();
        const back = 1.0 + s * s * 6.0;
        _v.set(core.sym(0.6 + back * 0.22), core.sym(0.5 + back * 0.18), core.sym(0.6 + back * 0.22));
        p.x = anch.ex - a.vx * u - a.fwd.x * back + _v.x;
        p.y = anch.ey - a.vy * u - a.fwd.y * back + _v.y;
        p.z = anch.ez - a.vz * u - a.fwd.z * back + _v.z;
        p.vx = a.vx * (0.28 - s * 0.14) + core.sym(1.8 + s * 4);
        p.vy = a.vy * (0.28 - s * 0.14) + core.rand(0.5, 3);
        p.vz = a.vz * (0.28 - s * 0.14) + core.sym(1.8 + s * 4);
        p.life = core.rand(2.5, 5.5);
        p.size0 = Math.max(minR, core.rand(0.6, 1.6) * (0.8 + s * 0.7));
        p.size1 = Math.max(minR * 3, core.rand(4.5, 11.0) * (0.8 + s * 0.7));
        p.rot = core.rand(0, 6.283); p.spin = core.sym(0.8);
        p.drag = 0.8; p.grav = -0.09;
        p.wind = 0.75 + s * 1.15; p.turb = 0.7 + s * 1.3;
        p.ramp = RAMP.SmokeGrey;
        p.tile = core.rng.next() < 0.10 + s * 0.45 ? TILE.Torn : smokeTile();
        p.erode = core.rand(0.52, 0.76) + s * 0.22; p.band = 0.9;
        p.r = p.g = p.b = 0.78 + s * 0.40;
        p.a = 0.95 * (1 - s * 0.3);
        core.smoke.emit(now, p);
      }
    }
  }
}

/** Acquire template, mutated in place — acquire() copies, it does not keep. */
const _damageTrail: TrailConfig = {
  ...DEFAULT_TRAIL,
  ramp: RAMP.SmokeGrey, width0: 0.6, width1: 5.5, life: 2.6, alpha: 0.8,
  minStep: 4, bands: 3, ink: 0, additive: false,
};

function ensureDamageTrail(core: VfxCore, fx: AircraftFx, burning: boolean): void {
  if (fx.debrisTrail !== NO_TRAIL && core.trailsBill.isAlive(fx.debrisTrail)) {
    const c = core.trailsBill.config(fx.debrisTrail);
    if (c) { c.ramp = burning ? RAMP.SmokeBlack : RAMP.SmokeGrey; }
    return;
  }
  _damageTrail.ramp = burning ? RAMP.SmokeBlack : RAMP.SmokeGrey;
  fx.debrisTrail = core.trailsBill.acquire(_damageTrail);
}

export function releaseDamageTrail(core: VfxCore, fx: AircraftFx): void {
  if (fx.debrisTrail !== NO_TRAIL) {
    core.trailsBill.release(fx.debrisTrail);
    fx.debrisTrail = NO_TRAIL;
  }
}
