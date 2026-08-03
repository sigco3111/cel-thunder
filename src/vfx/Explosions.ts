import { resetSpawn } from './ParticleEngine';
import { RAMP, TILE } from './VfxTextures';
import type { VfxCore } from './VfxCore';
import { DEBRIS_COLORS } from './DebrisSystem';

/**
 * Explosions, art-directed in layers. Nothing here is a "particle burst"; each
 * explosion is a short piece of choreography with a fixed reading order:
 *
 *   t+0 ms    a hard white-hot flash core, quantised to 2-3 value steps. It is
 *             gone in under 90 ms — long enough to read, short enough that the
 *             eye never resolves it as a sphere.
 *   t+0 ms    a thin, fast annulus: the shock front. Decelerates cubically.
 *   t+10 ms   a rolling fireball, orange -> red -> dark smoke in stepped bands,
 *             with an ink-dark silhouette so it stays graphic against sky.
 *   t+20 ms   debris chunks with their own smoke trails, thrown on a cosine
 *             lobe biased away from the surface.
 *   t+60 ms   a lingering smoke column that keeps rising and takes the wind.
 *
 * Everything scales off 'scale', which is a metre-ish blast radius: a 20 mm
 * HE round is ~1, a 250 kg bomb is ~9, an ammunition detonation is ~14.
 */

export type ExplosionKind =
  | 'air'        // ordnance detonating in free air / flak burst
  | 'aircraft'   // an airframe coming apart: fuel, structure, fire
  | 'ground'     // contact burst on soil
  | 'water'      // contact burst on water
  | 'fuel'       // a fuel dump / tank going up: slow, greasy, red
  | 'ammo'       // ammunition cook-off: white core, lots of sparks
  | 'small'      // cannon shell hit, grenade-scale
  | 'flak';      // AA burst: dirty black puff with a hard core

interface Recipe {
  flashSize: number;
  flashLife: number;
  fireCount: number;
  fireSize: number;
  fireLife: number;
  fireRamp: number;
  smokeCount: number;
  smokeSize: number;
  smokeLife: number;
  smokeRamp: number;
  columnCount: number;
  columnLife: number;
  sparkCount: number;
  debrisCount: number;
  debrisColor: number;
  ringLife: number;
  ringRadius: number;
  /** Vertical bias applied to the whole burst, 0 = spherical, 1 = straight up. */
  updraft: number;
  shake: number;
}

const RECIPES: Record<ExplosionKind, Recipe> = {
  air: {
    flashSize: 3.0, flashLife: 0.085, fireCount: 26, fireSize: 2.2, fireLife: 0.75,
    fireRamp: RAMP.Fireball, smokeCount: 22, smokeSize: 3.0, smokeLife: 4.5,
    smokeRamp: RAMP.SmokeBlack, columnCount: 0, columnLife: 0, sparkCount: 34,
    debrisCount: 6, debrisColor: DEBRIS_COLORS.scorched,
    ringLife: 0.42, ringRadius: 3.2, updraft: 0.15, shake: 0.30,
  },
  aircraft: {
    flashSize: 4.2, flashLife: 0.10, fireCount: 40, fireSize: 2.4, fireLife: 1.15,
    fireRamp: RAMP.Fireball, smokeCount: 40, smokeSize: 4.2, smokeLife: 7.0,
    smokeRamp: RAMP.SmokeBlack, columnCount: 16, columnLife: 11, sparkCount: 44,
    debrisCount: 18, debrisColor: DEBRIS_COLORS.camoGrey,
    ringLife: 0.5, ringRadius: 4.0, updraft: 0.25, shake: 0.55,
  },
  ground: {
    flashSize: 3.4, flashLife: 0.09, fireCount: 30, fireSize: 2.2, fireLife: 0.9,
    fireRamp: RAMP.Fireball, smokeCount: 34, smokeSize: 4.0, smokeLife: 6.5,
    smokeRamp: RAMP.SmokeColumn, columnCount: 20, columnLife: 13, sparkCount: 26,
    debrisCount: 22, debrisColor: DEBRIS_COLORS.dirt,
    ringLife: 0.55, ringRadius: 4.6, updraft: 0.72, shake: 0.75,
  },
  water: {
    flashSize: 2.0, flashLife: 0.06, fireCount: 8, fireSize: 1.6, fireLife: 0.4,
    fireRamp: RAMP.Fireball, smokeCount: 12, smokeSize: 3.0, smokeLife: 3.0,
    smokeRamp: RAMP.SmokeGrey, columnCount: 0, columnLife: 0, sparkCount: 6,
    debrisCount: 0, debrisColor: DEBRIS_COLORS.dirt,
    ringLife: 1.3, ringRadius: 7.0, updraft: 0.95, shake: 0.45,
  },
  fuel: {
    flashSize: 3.6, flashLife: 0.12, fireCount: 58, fireSize: 3.2, fireLife: 2.1,
    fireRamp: RAMP.Secondary, smokeCount: 54, smokeSize: 6.0, smokeLife: 10,
    smokeRamp: RAMP.SmokeOil, columnCount: 30, columnLife: 20, sparkCount: 30,
    debrisCount: 12, debrisColor: DEBRIS_COLORS.scorched,
    ringLife: 0.6, ringRadius: 4.4, updraft: 0.85, shake: 0.9,
  },
  ammo: {
    flashSize: 5.2, flashLife: 0.13, fireCount: 34, fireSize: 2.6, fireLife: 0.85,
    fireRamp: RAMP.FireCore, smokeCount: 30, smokeSize: 3.6, smokeLife: 6.0,
    smokeRamp: RAMP.SmokeGrey, columnCount: 10, columnLife: 9, sparkCount: 110,
    debrisCount: 20, debrisColor: DEBRIS_COLORS.brass,
    ringLife: 0.45, ringRadius: 5.4, updraft: 0.35, shake: 1.0,
  },
  small: {
    flashSize: 1.5, flashLife: 0.055, fireCount: 10, fireSize: 1.0, fireLife: 0.34,
    fireRamp: RAMP.FireStream, smokeCount: 8, smokeSize: 1.3, smokeLife: 1.9,
    smokeRamp: RAMP.SmokeGrey, columnCount: 0, columnLife: 0, sparkCount: 18,
    debrisCount: 3, debrisColor: DEBRIS_COLORS.aluminium,
    ringLife: 0.22, ringRadius: 1.7, updraft: 0.1, shake: 0.12,
  },
  flak: {
    flashSize: 3.2, flashLife: 0.07, fireCount: 14, fireSize: 1.8, fireLife: 0.42,
    fireRamp: RAMP.FireCore, smokeCount: 30, smokeSize: 4.2, smokeLife: 9.0,
    smokeRamp: RAMP.SmokeBlack, columnCount: 0, columnLife: 0, sparkCount: 22,
    debrisCount: 0, debrisColor: DEBRIS_COLORS.scorched,
    ringLife: 0.30, ringRadius: 2.8, updraft: 0.1, shake: 0.35,
  },
};

export function spawnExplosionAt(
  core: VfxCore,
  x: number, y: number, z: number,
  scale: number,
  kind: ExplosionKind,
): void {
  if (core.tooFar(x, y, z, 26000)) return;
  const R = RECIPES[kind];
  const s = Math.max(0.3, scale);
  const now = core.time;
  const p = resetSpawn();
  const lodN = (n: number) => core.count(n, x, y, z);

  const groundY = core.terrain.height(x, z);
  const nearGround = y - groundY < s * 1.6;

  // ---- 1. flash core -------------------------------------------------------
  // Three overlapping cards at different scales and lifetimes give the core a
  // hard, faceted read instead of one expanding disc.
  for (let i = 0; i < 3; i++) {
    p.x = x + core.sym(s * 0.12);
    p.y = y + core.sym(s * 0.12);
    p.z = z + core.sym(s * 0.12);
    p.vx = p.vy = p.vz = 0;
    p.life = R.flashLife * (1 - i * 0.22);
    p.size0 = R.flashSize * s * (0.55 + i * 0.34);
    p.size1 = R.flashSize * s * (1.15 + i * 0.55);
    p.rot = core.rand(0, 6.283);
    p.spin = core.sym(1.2);
    p.drag = 6; p.grav = 0; p.wind = 0; p.turb = 0;
    p.ramp = i === 0 ? RAMP.FlashWhite : RAMP.FireCore;
    p.tile = i === 1 ? TILE.Star : TILE.Puff;
    p.erode = 0.15; p.band = 1.6;
    p.r = p.g = p.b = 1; p.a = 1;
    p.stretch = 0;
    core.flash.emit(now, p);
  }
  // A single spiky star sells the first frame; it dies before it can be read
  // as a shape, which is exactly what a real flash does to a camera.
  p.x = x; p.y = y; p.z = z;
  p.life = R.flashLife * 1.3;
  p.size0 = R.flashSize * s * 0.4;
  p.size1 = R.flashSize * s * 2.6;
  p.tile = TILE.Star;
  p.ramp = RAMP.FlashWhite;
  p.rot = core.rand(0, 6.283);
  p.spin = core.sym(2.4);
  p.erode = 0.1; p.band = 2.0; p.a = 0.9;
  core.flash.emit(now, p);

  // ---- 2. shock ring -------------------------------------------------------
  // On the ground the ring lies flat, because that is where the reflected front
  // actually goes. In free air a torus about a random axis reads as a random
  // hoop from most angles, so the ring is turned to face the camera instead:
  // the audience always sees the circle, which is the whole reason the effect
  // exists. This is the one place where the art direction beats the physics.
  const rn = core.v0;
  if (nearGround) {
    core.terrain.normal(x, z, rn);
  } else {
    rn.set(core.camera.position.x - x, core.camera.position.y - y, core.camera.position.z - z);
    if (rn.lengthSq() < 1e-6) rn.set(0, 1, 0);
    rn.normalize();
  }
  core.ringsHot.emit(now, {
    x, y: nearGround ? groundY + s * 0.12 : y,
    z, nx: rn.x, ny: rn.y, nz: rn.z,
    life: R.ringLife * 0.45,
    r0: s * 0.5, r1: R.ringRadius * s,
    thick0: s * 0.14, thick1: s * 0.30,
    ramp: RAMP.ShockRing, wobble: 0.030,
    r: 1, g: 1, b: 1, a: 0.42,
  });
  if (s > 3) {
    // A second, slower ring reads as the rarefaction behind the front. It has
    // to stay a *thread*: at thick1 = s the annulus is wider than the gap
    // between its own inner and outer edge by the time it stops growing, so it
    // fills in and the fireball ends up inside a glass bubble. Thin and quick.
    core.ringsHot.emit(now, {
      x, y: nearGround ? groundY + s * 0.2 : y, z,
      nx: rn.x, ny: rn.y, nz: rn.z,
      life: R.ringLife * 0.95, r0: s * 0.25, r1: R.ringRadius * s * 0.64,
      thick0: s * 0.12, thick1: s * 0.38,
      ramp: RAMP.ShockRing, wobble: 0.055,
      r: 0.85, g: 0.92, b: 1, a: 0.24,
    });
  }

  // ---- 2b. the heat that the opaque fireball cannot carry -----------------
  // Three big, soft, additive cards under the fireball. They are what makes it
  // read as *hot*, and being additive they blow the bloom threshold without
  // washing the fireball's banding out.
  for (let i = 0; i < 3; i++) {
    p.x = x + core.sym(s * 0.3);
    p.y = y + core.sym(s * 0.3);
    p.z = z + core.sym(s * 0.3);
    p.vx = p.vy = p.vz = 0;
    p.life = R.fireLife * (0.35 + i * 0.15);
    p.size0 = R.fireSize * s * (0.5 + i * 0.22);
    p.size1 = R.fireSize * s * (1.0 + i * 0.35);
    p.rot = core.rand(0, 6.283); p.spin = core.sym(0.7);
    p.drag = 4; p.grav = -0.3; p.wind = 0.1; p.turb = 0;
    p.ramp = RAMP.FireCore; p.tile = TILE.Puff;
    p.erode = 0.35; p.band = 1.1;
    p.r = 1; p.g = 0.86; p.b = 0.66; p.a = 0.16;
    p.stretch = 0;
    core.flash.emit(now, p);
  }

  // ---- 3. rolling fireball -------------------------------------------------
  const fireN = lodN(R.fireCount);
  for (let i = 0; i < fireN; i++) {
    core.sphere(core.v1, 1);
    const speed = core.rand(0.35, 1.0) * s * 4.2;
    p.x = x + core.v1.x * s * 0.35;
    p.y = y + core.v1.y * s * 0.35;
    p.z = z + core.v1.z * s * 0.35;
    p.vx = core.v1.x * speed;
    p.vy = core.v1.y * speed * (1 - R.updraft) + R.updraft * speed * 1.4;
    p.vz = core.v1.z * speed;
    p.life = R.fireLife * core.rand(0.7, 1.35);
    p.size0 = R.fireSize * s * core.rand(0.35, 0.6);
    p.size1 = R.fireSize * s * core.rand(1.05, 1.75);
    p.rot = core.rand(0, 6.283);
    p.spin = core.sym(1.6);
    p.drag = core.rand(1.6, 2.8);
    p.grav = -0.55;                  // hot gas is buoyant
    p.wind = 0.25; p.turb = s * 0.10;
    p.ramp = R.fireRamp;
    p.tile = (i % 5 < 2) ? TILE.Wisp : (i % 5 === 2 ? TILE.Billow : TILE.Puff);
    p.erode = 0.45; p.band = 1.5;
    p.stretch = 0;
    p.r = 1; p.g = core.rand(0.92, 1.0); p.b = core.rand(0.86, 1.0); p.a = 1;
    core.fire.emit(now, p);
  }

  // ---- 4. the dark side of the fireball ------------------------------------
  // Alpha-blended smoke puffs launched *with* the fireball, slightly slower and
  // much longer-lived. Because they are lit and inked they hold the silhouette
  // once the additive fire has burned out, which is the moment most explosions
  // in games fall apart.
  const smokeN = lodN(R.smokeCount);
  for (let i = 0; i < smokeN; i++) {
    core.sphere(core.v1, 1);
    const speed = core.rand(0.25, 0.8) * s * 3.0;
    p.x = x + core.v1.x * s * 0.5;
    p.y = y + core.v1.y * s * 0.5;
    p.z = z + core.v1.z * s * 0.5;
    p.vx = core.v1.x * speed;
    p.vy = core.v1.y * speed * (1 - R.updraft) + R.updraft * speed * 1.15 + s * 0.5;
    p.vz = core.v1.z * speed;
    p.life = R.smokeLife * core.rand(0.65, 1.4);
    p.size0 = R.smokeSize * s * core.rand(0.4, 0.75);
    p.size1 = R.smokeSize * s * core.rand(1.8, 3.4);
    p.rot = core.rand(0, 6.283);
    p.spin = core.sym(0.55);
    p.drag = core.rand(0.55, 1.1);
    p.grav = -0.14;
    p.wind = 0.85; p.turb = s * 0.16;
    p.ramp = R.smokeRamp;
    p.tile = i % 4 === 0 ? TILE.Wisp : (i % 4 === 1 ? TILE.Billow : TILE.Puff);
    p.erode = 0.55; p.band = 1.0;
    p.stretch = 0;
    const v = core.rand(0.82, 1.12);
    p.r = v; p.g = v * core.rand(0.96, 1.0); p.b = v * core.rand(0.93, 1.0); p.a = 1;
    p.delay = core.rand(0, 0.09);
    core.smoke.emit(now, p);
  }
  p.delay = 0;

  // ---- 5. sparks and embers ------------------------------------------------
  const sparkN = lodN(R.sparkCount);
  for (let i = 0; i < sparkN; i++) {
    core.sphere(core.v1, 1);
    const speed = core.rand(6, 34) * (0.5 + s * 0.10);
    p.x = x + core.v1.x * s * 0.2;
    p.y = y + core.v1.y * s * 0.2;
    p.z = z + core.v1.z * s * 0.2;
    p.vx = core.v1.x * speed;
    p.vy = core.v1.y * speed + s * 1.2;
    p.vz = core.v1.z * speed;
    p.life = core.rand(0.28, 1.5);
    p.size0 = core.rand(0.10, 0.30) * (0.6 + s * 0.08);
    p.size1 = p.size0 * 0.35;
    p.rot = 0; p.spin = 0;
    p.drag = core.rand(1.2, 3.0);
    p.grav = 1.0;
    p.wind = 0.4; p.turb = 0;
    p.ramp = i % 4 === 0 ? RAMP.Ember : RAMP.SparkHot;
    p.tile = TILE.Streak;
    p.stretch = 0.020;               // metres of streak per m/s
    p.erode = 0.1; p.band = 1.2;
    p.r = p.g = p.b = 1; p.a = 1;
    core.spark.emit(now, p);
  }
  p.stretch = 0;

  // ---- 6. debris chunks ----------------------------------------------------
  const debN = Math.round(R.debrisCount * core.budget * (core.lod(x, y, z) > 0.5 ? 1 : 0.35));
  for (let i = 0; i < debN; i++) {
    core.sphere(core.v1, 1);
    const up = R.updraft;
    const speed = core.rand(9, 30) * (0.6 + s * 0.09);
    core.debris.spawn({
      x: x + core.v1.x * s * 0.3,
      y: y + core.v1.y * s * 0.3,
      z: z + core.v1.z * s * 0.3,
      vx: core.v1.x * speed,
      vy: Math.abs(core.v1.y) * speed * up + core.v1.y * speed * (1 - up) + s * 1.4,
      vz: core.v1.z * speed,
      kind: kind === 'ground' ? 'clod' : (i % 3 === 0 ? 'panel' : 'chunk'),
      size: core.rand(0.18, 0.75) * (0.7 + s * 0.10),
      life: core.rand(2.4, 6.5),
      color: R.debrisColor,
      spin: core.rand(4, 16),
      burning: i % 2 === 0 && kind !== 'water' && kind !== 'ground' ? 1 : 0,
      drag: core.rand(0.1, 0.35),
    });
  }

  // ---- 7. lingering column -------------------------------------------------
  if (R.columnCount > 0) {
    spawnSmokeColumn(core, x, nearGround ? groundY : y, z, s, R.columnCount, R.columnLife, R.smokeRamp);
  }

  // ---- 8. surface interaction ---------------------------------------------
  if (kind === 'ground' || (nearGround && kind !== 'water')) {
    spawnGroundBlast(core, x, groundY, z, s);
  }
  if (kind === 'water') {
    spawnWaterGeyser(core, x, y, z, s);
  }

  core.addShake(R.shake * Math.min(2.2, 0.5 + s * 0.14), core.rand(16, 24), 0.55 + s * 0.03, x, y, z, 90 + s * 26, 0.3);
}

// ---------------------------------------------------------------------------

/** The tall, slowly-drifting column that says "something died here". */
export function spawnSmokeColumn(
  core: VfxCore,
  x: number, y: number, z: number,
  s: number, count: number, life: number, ramp: number,
): void {
  const now = core.time;
  const p = resetSpawn();
  const n = core.count(count, x, y, z);
  for (let i = 0; i < n; i++) {
    const t = i / Math.max(1, n - 1);
    p.x = x + core.sym(s * 0.5);
    p.y = y + s * 0.4 + t * s * 1.2;
    p.z = z + core.sym(s * 0.5);
    p.vx = core.sym(s * 0.35);
    // Buoyant plumes accelerate as they rise; a spread of initial speeds plus
    // negative gravity produces the classic widening column for free.
    p.vy = core.rand(1.6, 4.6) * (0.6 + s * 0.08);
    p.vz = core.sym(s * 0.35);
    p.life = life * core.rand(0.6, 1.25);
    p.size0 = s * core.rand(0.9, 1.5);
    p.size1 = s * core.rand(3.4, 6.5);
    p.rot = core.rand(0, 6.283);
    p.spin = core.sym(0.28);
    p.drag = core.rand(0.28, 0.55);
    p.grav = -0.10;
    p.wind = 1.25;                     // the column is what shows the wind
    p.turb = s * 0.22;
    p.ramp = ramp;
    p.tile = i % 3 === 0 ? TILE.Billow : (i % 3 === 1 ? TILE.Puff : TILE.Wisp);
    p.erode = 0.62; p.band = 0.9;
    const v = core.rand(0.8, 1.1);
    p.r = v; p.g = v; p.b = v * 1.03;
    p.a = 1;
    p.delay = t * life * 0.28;
    core.smoke.emit(now, p);
  }
}

/** Dirt cone plus the dust ring that rolls out from a ground contact burst. */
export function spawnGroundBlast(core: VfxCore, x: number, gy: number, z: number, s: number): void {
  const now = core.time;
  const p = resetSpawn();
  const surf = core.terrain.type(x, z);
  const dustRamp = surf === 'snow' ? RAMP.Snow
    : (surf === 'concrete' || surf === 'rock') ? RAMP.DustGrey
    : RAMP.DustBrown;
  const n = core.terrain.normal(x, z, core.v0);

  // The cone: a narrow, near-vertical spray of heavy material. Real ejecta
  // leaves at 60-75 degrees from horizontal, so the cone is tight.
  const coneN = core.count(30, x, gy, z);
  for (let i = 0; i < coneN; i++) {
    core.cone(core.v1, n.x, n.y, n.z, 0.42);
    const speed = core.rand(10, 34) * (0.5 + s * 0.10);
    p.x = x + core.sym(s * 0.35);
    p.y = gy + 0.4;
    p.z = z + core.sym(s * 0.35);
    p.vx = core.v1.x * speed;
    p.vy = core.v1.y * speed;
    p.vz = core.v1.z * speed;
    p.life = core.rand(1.4, 3.2);
    p.size0 = s * core.rand(0.25, 0.6);
    p.size1 = s * core.rand(1.4, 2.6);
    p.rot = core.rand(0, 6.283);
    p.spin = core.sym(1.1);
    p.drag = core.rand(0.6, 1.4);
    p.grav = 0.55;                    // dirt falls back; smoke does not
    p.wind = 0.5; p.turb = s * 0.10;
    p.ramp = dustRamp;
    p.tile = i % 3 === 0 ? TILE.Clod : TILE.Puff;
    p.erode = 0.5; p.band = 1.2;
    p.r = p.g = p.b = core.rand(0.85, 1.12); p.a = 1;
    core.dust.emit(now, p);
  }

  // The ring: a low, wide skirt of dust that expands fast and settles. Emitted
  // as particles *and* as a geometric ring, because the ring alone reads as a
  // decal and the particles alone never form a clean circle.
  // Deliberately fat and ragged: a thin, clean dust ring reads as a drawn
  // ellipse on the ground. It has to blend into the skirt particles below.
  core.ringsDust.emit(now, {
    x, y: gy + s * 0.10, z, nx: n.x, ny: n.y, nz: n.z,
    life: 1.9 + s * 0.10,
    r0: s * 0.7, r1: s * 6.0,
    thick0: s * 1.8, thick1: s * 5.5,
    ramp: RAMP.DustRing, wobble: 0.17,
    r: 1, g: 1, b: 1, a: 0.34,
  });

  const skirtN = core.count(26, x, gy, z);
  for (let i = 0; i < skirtN; i++) {
    const a = core.rand(0, Math.PI * 2);
    const dx = Math.cos(a), dz = Math.sin(a);
    const speed = core.rand(7, 20) * (0.5 + s * 0.09);
    p.x = x + dx * s * 0.8;
    p.y = gy + core.rand(0.2, 1.0);
    p.z = z + dz * s * 0.8;
    p.vx = dx * speed;
    p.vy = core.rand(0.6, 2.6);
    p.vz = dz * speed;
    p.life = core.rand(2.6, 5.0);
    p.size0 = s * core.rand(0.5, 1.0);
    p.size1 = s * core.rand(2.6, 4.6);
    p.rot = core.rand(0, 6.283);
    p.spin = core.sym(0.4);
    p.drag = core.rand(1.1, 2.2);      // the skirt stops quickly and settles
    p.grav = 0.10;
    p.wind = 0.9; p.turb = s * 0.14;
    p.ramp = dustRamp;
    p.tile = TILE.Puff;
    p.erode = 0.6; p.band = 0.9;
    p.r = p.g = p.b = core.rand(0.88, 1.10); p.a = 0.9;
    core.dust.emit(now, p);
  }
}

/** Water column, spray sheet and the ring of ripples left behind. */
export function spawnWaterGeyser(core: VfxCore, x: number, y: number, z: number, s: number): void {
  const now = core.time;
  const p = resetSpawn();
  const wy = 0;   // sea level

  const colN = core.count(34, x, wy, z);
  for (let i = 0; i < colN; i++) {
    const t = i / Math.max(1, colN - 1);
    core.cone(core.v1, 0, 1, 0, 0.22 + t * 0.35);
    const speed = core.rand(14, 30) * (0.55 + s * 0.11);
    p.x = x + core.sym(s * 0.5);
    p.y = wy + 0.3;
    p.z = z + core.sym(s * 0.5);
    p.vx = core.v1.x * speed;
    p.vy = core.v1.y * speed;
    p.vz = core.v1.z * speed;
    p.life = core.rand(1.6, 3.4);
    p.size0 = s * core.rand(0.5, 1.1);
    p.size1 = s * core.rand(1.6, 3.0);
    p.rot = core.rand(0, 6.283);
    p.spin = core.sym(0.5);
    p.drag = core.rand(0.35, 0.8);
    p.grav = 0.85;                    // water is heavy: it comes back down
    p.wind = 0.35; p.turb = s * 0.08;
    p.ramp = RAMP.WaterFoam;
    p.tile = i % 3 === 0 ? TILE.Splash : TILE.Puff;
    p.erode = 0.42; p.band = 1.3;
    p.r = p.g = p.b = 1; p.a = 1;
    core.water.emit(now, p);
  }

  // Fine spray hanging over the column, and the low sheet thrown outward.
  const sprayN = core.count(20, x, wy, z);
  for (let i = 0; i < sprayN; i++) {
    const a = core.rand(0, Math.PI * 2);
    const speed = core.rand(9, 22) * (0.5 + s * 0.08);
    p.x = x + Math.cos(a) * s * 0.6;
    p.y = wy + 0.2;
    p.z = z + Math.sin(a) * s * 0.6;
    p.vx = Math.cos(a) * speed;
    p.vy = core.rand(2, 7);
    p.vz = Math.sin(a) * speed;
    p.life = core.rand(1.2, 2.6);
    p.size0 = s * core.rand(0.2, 0.5);
    p.size1 = s * core.rand(1.0, 2.0);
    p.rot = core.rand(0, 6.283);
    p.spin = core.sym(0.8);
    p.drag = 1.2; p.grav = 0.9;
    p.wind = 0.6; p.turb = 0;
    p.ramp = RAMP.WaterFoam;
    p.tile = TILE.Droplet;
    p.erode = 0.35; p.band = 1.0;
    p.r = p.g = p.b = 1; p.a = 0.9;
    core.water.emit(now, p);
  }

  // Expanding ripple, and a second one behind it.
  core.ringsDust.emit(now, {
    x, y: wy + 0.25, z, nx: 0, ny: 1, nz: 0,
    life: 2.6 + s * 0.1, r0: s * 0.8, r1: s * 9,
    thick0: s * 0.5, thick1: s * 1.6,
    ramp: RAMP.WaterFoam, wobble: 0.05,
    r: 1, g: 1, b: 1, a: 0.8,
  });
  core.ringsDust.emit(now, {
    x, y: wy + 0.2, z, nx: 0, ny: 1, nz: 0,
    life: 4.0, r0: s * 0.4, r1: s * 5.5,
    thick0: s * 0.3, thick1: s * 0.9,
    ramp: RAMP.WaterBody, wobble: 0.02,
    r: 1, g: 1, b: 1, a: 0.45,
  });
}

/**
 * Secondary detonations — a fuel dump or an ammunition store cooking off after
 * the main blast. Each one is a full explosion, staggered, and each is smaller
 * and redder than the last.
 */
export function spawnSecondaries(
  core: VfxCore, x: number, y: number, z: number, s: number, count: number,
): void {
  const n = Math.min(6, Math.round(count * Math.min(1, core.budget)));
  for (let i = 0; i < n; i++) {
    const dx = core.sym(s * 2.2), dz = core.sym(s * 2.2);
    const gy = core.terrain.height(x + dx, z + dz);
    // Queued through the deferred list so the stagger costs no timers.
    pushDeferred(
      core.time + core.rand(0.25, 2.4) + i * 0.35,
      x + dx, gy + core.rand(0.5, 2.5), z + dz,
      s * core.rand(0.45, 0.85), 'fuel',
    );
  }
}

// ---------------------------------------------------------------------------
// Deferred explosions: a tiny fixed-size schedule so secondaries, cook-offs
// and chained blasts need no allocation and no setTimeout.
// ---------------------------------------------------------------------------

interface Deferred { at: number; x: number; y: number; z: number; s: number; kind: ExplosionKind; used: boolean }
const deferred: Deferred[] = [];
for (let i = 0; i < 32; i++) deferred.push({ at: 0, x: 0, y: 0, z: 0, s: 1, kind: 'air', used: false });

export function pushDeferred(at: number, x: number, y: number, z: number, s: number, kind: ExplosionKind): void {
  for (const d of deferred) {
    if (d.used) continue;
    d.used = true; d.at = at; d.x = x; d.y = y; d.z = z; d.s = s; d.kind = kind;
    return;
  }
}

export function updateDeferred(core: VfxCore): void {
  for (const d of deferred) {
    if (!d.used || core.time < d.at) continue;
    d.used = false;
    spawnExplosionAt(core, d.x, d.y, d.z, d.s, d.kind);
  }
}

export function clearDeferred(): void {
  for (const d of deferred) d.used = false;
}
