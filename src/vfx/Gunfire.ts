import { resetSpawn } from './ParticleEngine';
import { RAMP, TILE } from './VfxTextures';
import type { SurfaceKind, VfxCore } from './VfxCore';
import { DEBRIS_COLORS } from './DebrisSystem';

/**
 * Guns: what happens at the muzzle, at the breech and at the far end.
 *
 * The muzzle flash is deliberately *not* a blurry blob. It is three stacked
 * stamps with different lifetimes — a cone of burning propellant along the
 * bore, a short star of unburnt powder igniting at the muzzle, and a wash of
 * light — all quantised into two or three hard value steps and all gone inside
 * 45 ms. At 60 fps that means a flash occupies two or three frames, which is
 * why real gun camera footage strobes rather than glows.
 *
 * Everything scales with calibre: a 7.7 mm Browning gets a wisp, a 20 mm
 * Hispano gets a star with a smoke ring, a 37 mm gets a bloom you feel.
 */

export interface MuzzleOptions {
  /** Millimetres — drives every dimension below. */
  calibre: number;
  /** Tracer colour of the round; the flash borrows a little of it. */
  tint?: number;
  /** Eject spent brass (belt-fed aircraft guns mostly do). */
  casings?: boolean;
  /** Aircraft velocity, so smoke and brass are left behind correctly. */
  vx?: number; vy?: number; vz?: number;
  /** Body "right" axis, used to throw brass out sideways. */
  rx?: number; ry?: number; rz?: number;
  /** Shake this gun contributes; 0 for remote aircraft. */
  shake?: number;
}

export function spawnMuzzleFlash(
  core: VfxCore,
  x: number, y: number, z: number,
  dx: number, dy: number, dz: number,
  o: MuzzleOptions,
): void {
  if (core.tooFar(x, y, z, 4000)) return;

  const now = core.time;
  const p = resetSpawn();
  const cal = Math.max(5, o.calibre);
  // Flash size follows roughly the cube root of the propellant charge, which
  // itself scales with calibre cubed — so length is close to linear in calibre.
  //
  // Calibrated against the aircraft rather than in the abstract: the previous
  // 0.30 + 0.055·cal gave a 20 mm Hispano a 1.4 m base, and with the star tile
  // reaching 2.9× that, an eight-metre flash on a nine-metre aeroplane — a
  // white blowout that swallowed the wing every time the guns were held down.
  // A real 20 mm muzzle flash is under a metre.
  const s = 0.22 + cal * 0.030;
  const avx = o.vx ?? 0, avy = o.vy ?? 0, avz = o.vz ?? 0;

  const tint = o.tint ?? 0xfff0c0;
  const tg = ((tint >> 8) & 0xff) / 255;
  const tb = (tint & 0xff) / 255;

  // --- the cone along the bore ---------------------------------------------
  p.x = x + dx * s * 0.35; p.y = y + dy * s * 0.35; p.z = z + dz * s * 0.35;
  p.vx = avx + dx * 6; p.vy = avy + dy * 6; p.vz = avz + dz * 6;
  p.life = 0.030 + cal * 0.0012;
  p.size0 = s * 1.5; p.size1 = s * 2.4;
  // The cone tile points +Y in sprite space; the billboard rotation is chosen
  // per shot so the flare does not appear stapled to the screen axes.
  p.rot = core.rand(0, 6.283);
  p.spin = 0;
  p.drag = 8; p.grav = 0; p.wind = 0; p.turb = 0;
  p.ramp = RAMP.MuzzleFlash; p.tile = TILE.Cone;
  p.erode = 0.05; p.band = 1.8;
  p.r = 1; p.g = 0.5 + tg * 0.5; p.b = 0.4 + tb * 0.6; p.a = 1;
  core.flash.emit(now, p);

  // --- the star at the muzzle ----------------------------------------------
  p.x = x; p.y = y; p.z = z;
  p.vx = avx; p.vy = avy; p.vz = avz;
  p.life = 0.026 + cal * 0.0016;
  p.size0 = s * 0.6; p.size1 = s * 1.9;
  p.rot = core.rand(0, 6.283);
  p.spin = core.sym(3);
  p.ramp = RAMP.FireCore; p.tile = TILE.Star;
  p.erode = 0.05; p.band = 2.2;
  p.r = 1; p.g = 1; p.b = 1; p.a = 1;
  core.flash.emit(now, p);

  // --- the wash -------------------------------------------------------------
  if (cal >= 12) {
    p.life = 0.045;
    p.size0 = s * 0.8; p.size1 = s * 2.6;
    p.rot = core.rand(0, 6.283); p.spin = 0;
    p.ramp = RAMP.MuzzleFlash; p.tile = TILE.Puff;
    p.erode = 0.2; p.band = 1.2;
    // The wash is additive and lands on the bloom layer, so it saturates to a
    // flat white shape long before it reaches full opacity — which reads as a
    // rectangle stapled to the wing. Keep it as a lift under the star, not a
    // shape of its own.
    p.r = 1; p.g = 0.86; p.b = 0.62; p.a = 0.30;
    core.flash.emit(now, p);
  }

  // --- barrel smoke ---------------------------------------------------------
  // Cordite: pale, low-alpha, slow. It is the residue that makes a firing pass
  // look like it took place in air rather than in a vacuum.
  //
  // Emitted *sparsely on purpose*. This runs once per round, and a wing battery
  // at eight hundred rounds a minute fires roughly thirty times a second: at
  // three puffs a round the aircraft disappeared inside a cream-coloured cloud
  // the size of a cumulus within a second of holding the trigger. A fifth of a
  // puff per round accumulates into exactly the thin haze streaming off the
  // wing that gun-camera footage shows, and a single shot still leaves a wisp.
  // Faint, small and short. Isolated cordite puffs are the single easiest thing
  // in this subsystem to get wrong: at any size and opacity that reads on its
  // own, a sustained burst leaves a trail of pale blobs hanging in open sky
  // behind the aircraft with nothing visibly producing them, which is exactly
  // the "unexplained white specks" that mark a frame as unfinished. It has to
  // be a thin haze streaming off the wing or it should not be there at all.
  const smokeN = core.count(cal >= 20 ? 0.9 : 0.35, x, y, z);
  for (let i = 0; i < smokeN; i++) {
    core.cone(core.v1, dx, dy, dz, 0.45);
    const sp = core.rand(2, 7);
    p.x = x + dx * s * 0.2; p.y = y + dy * s * 0.2; p.z = z + dz * s * 0.2;
    p.vx = avx + core.v1.x * sp;
    p.vy = avy + core.v1.y * sp;
    p.vz = avz + core.v1.z * sp;
    p.life = core.rand(0.18, 0.42) * (1 + cal * 0.02);
    p.size0 = s * core.rand(0.22, 0.36);
    p.size1 = s * core.rand(0.9, 1.7);
    p.rot = core.rand(0, 6.283);
    p.spin = core.sym(1.6);
    p.drag = core.rand(2.2, 4.0);
    p.grav = -0.05;
    p.wind = 1.0; p.turb = 0.6;
    p.ramp = RAMP.Cordite; p.tile = i % 2 ? TILE.Wisp : TILE.Torn;
    p.erode = 0.62; p.band = 0.8;
    p.r = p.g = p.b = 1; p.a = 0.26;
    core.smoke.emit(now, p);
  }

  // --- a few grains of unburnt powder --------------------------------------
  const grainN = core.count(cal >= 20 ? 5 : 2, x, y, z);
  for (let i = 0; i < grainN; i++) {
    core.cone(core.v1, dx, dy, dz, 0.65);
    const sp = core.rand(12, 46);
    p.x = x; p.y = y; p.z = z;
    p.vx = avx + core.v1.x * sp;
    p.vy = avy + core.v1.y * sp;
    p.vz = avz + core.v1.z * sp;
    p.life = core.rand(0.08, 0.3);
    p.size0 = core.rand(0.04, 0.11);
    p.size1 = p.size0 * 0.4;
    p.rot = 0; p.spin = 0;
    p.drag = 5; p.grav = 0.5;
    p.wind = 0.3; p.turb = 0;
    p.ramp = RAMP.SparkHot; p.tile = TILE.Streak;
    p.stretch = 0.018; p.erode = 0.1; p.band = 1;
    p.r = 1; p.g = tg * 0.5 + 0.5; p.b = tb * 0.6 + 0.3; p.a = 1;
    core.spark.emit(now, p);
  }
  p.stretch = 0;

  // --- ejected brass --------------------------------------------------------
  // One case in five, not one in two: at thirty rounds a second the higher rate
  // laid a continuous chain of tumbling brass across the frame that read as
  // debris rather than as spent cases.
  if (o.casings !== false && core.rng.next() < 0.20 * Math.min(1, core.budget)) {
    const rx = o.rx ?? 1, rz = o.rz ?? 0;
    const side = core.rng.next() < 0.5 ? -1 : 1;
    const sp = core.rand(3.5, 7.5);
    core.debris.spawn({
      x, y: y - 0.12, z,
      vx: avx + rx * side * sp + core.sym(1.5),
      vy: avy + core.rand(-1.5, 1.0),
      vz: avz + rz * side * sp + core.sym(1.5),
      kind: 'casing',
      // A 20 mm case is about 110 mm long; a rifle-calibre case about 55 mm.
      size: 0.0045 * cal + 0.02,
      life: core.rand(1.6, 3.0),
      color: DEBRIS_COLORS.brass,
      spin: core.rand(18, 42),
      burning: 0,
      drag: 0.55,
    });
  }

  // --- recoil ---------------------------------------------------------------
  if (o.shake) {
    // High frequency, tiny amplitude, short life: a buzz, not a punch. Scaled
    // by calibre cubed / 8000 so a 20 mm is ~4x a 12.7 mm.
    const amp = o.shake * (0.0016 + (cal * cal * cal) / 8_000_000);
    core.addShake(amp, core.rand(26, 34), 0.10, x, y, z, 0, 0.12);
  }
}

// ---------------------------------------------------------------------------
// Impacts
// ---------------------------------------------------------------------------

export type ImpactSurface = SurfaceKind;

/**
 * Surface-specific impact. 'calibre' in millimetres scales the whole event; a
 * ricochet streak is thrown from a random fraction of the sparks so a burst
 * against a wing produces the characteristic scatter of glowing arcs.
 */
export function spawnImpactAt(
  core: VfxCore,
  x: number, y: number, z: number,
  nx: number, ny: number, nz: number,
  surface: ImpactSurface,
  calibre: number,
): void {
  if (core.tooFar(x, y, z, 6000)) return;

  const now = core.time;
  const p = resetSpawn();
  const cal = Math.max(5, calibre);
  const s = 0.20 + cal * 0.030;

  // Normalise the surface normal defensively — servers send quantised i16.
  let l = Math.hypot(nx, ny, nz);
  if (l < 1e-4) { nx = 0; ny = 1; nz = 0; l = 1; }
  nx /= l; ny /= l; nz /= l;

  switch (surface) {
    case 'metal':
    case 'armour':
      metalImpact(core, x, y, z, nx, ny, nz, cal, s, surface === 'armour');
      break;
    case 'water':
      waterImpact(core, x, y, z, cal, s);
      break;
    case 'wood':
    case 'canvas':
      woodImpact(core, x, y, z, nx, ny, nz, cal, s);
      break;
    case 'foliage':
      foliageImpact(core, x, y, z, nx, ny, nz, s);
      break;
    default:
      groundImpact(core, x, y, z, nx, ny, nz, cal, s, surface);
      break;
  }

  // A hard little flash at the point of contact for everything but water and
  // foliage — it is the first thing the eye catches and it anchors the hit.
  if (surface !== 'water' && surface !== 'foliage') {
    p.x = x + nx * 0.05; p.y = y + ny * 0.05; p.z = z + nz * 0.05;
    p.vx = p.vy = p.vz = 0;
    p.life = 0.05 + cal * 0.0008;
    p.size0 = s * 0.8; p.size1 = s * 2.2;
    p.rot = core.rand(0, 6.283); p.spin = core.sym(4);
    p.drag = 8; p.grav = 0; p.wind = 0;
    p.ramp = RAMP.FlashWhite; p.tile = TILE.Twinkle;
    p.erode = 0.05; p.band = 2;
    p.r = p.g = p.b = 1; p.a = 1;
    core.flash.emit(now, p);
  }
}

function metalImpact(
  core: VfxCore, x: number, y: number, z: number,
  nx: number, ny: number, nz: number,
  cal: number, s: number, armour: boolean,
): void {
  const now = core.time;
  const p = resetSpawn();

  // Sparks. Against armour the round breaks up and throws far more, hotter.
  const n = core.count(armour ? 26 : 15 + cal * 0.5, x, y, z);
  for (let i = 0; i < n; i++) {
    // Real spall leaves in a wide lobe about the surface normal, biased back
    // along the incoming path; a 1.1 rad cone about the normal is a good match.
    core.cone(core.v1, nx, ny, nz, 1.15);
    const sp = core.rand(8, armour ? 46 : 30);
    p.x = x + nx * 0.03; p.y = y + ny * 0.03; p.z = z + nz * 0.03;
    p.vx = core.v1.x * sp; p.vy = core.v1.y * sp; p.vz = core.v1.z * sp;
    p.life = core.rand(0.18, 0.75);
    p.size0 = core.rand(0.05, 0.16) * (0.7 + cal * 0.02);
    p.size1 = p.size0 * 0.3;
    p.drag = core.rand(1.5, 3.5);
    p.grav = 1.0; p.wind = 0.4; p.turb = 0;
    p.ramp = RAMP.SparkHot; p.tile = TILE.Streak;
    p.stretch = 0.024; p.erode = 0.08; p.band = 1.2;
    p.r = p.g = p.b = 1; p.a = 1;
    core.spark.emit(now, p);
  }
  p.stretch = 0;

  // Ricochet streaks: a handful of the sparks survive as long, curving,
  // slow-decaying arcs. They are trails, not particles, so they bend.
  const ricN = Math.min(2, core.count(armour ? 2.5 : 1.2, x, y, z));
  for (let i = 0; i < ricN; i++) {
    core.cone(core.v1, nx, ny, nz, 0.9);
    const h = core.trailsBill.acquire({
      ramp: RAMP.Ricochet, width0: 0.10, width1: 0.02, life: 0.42,
      alpha: 1, r: 1, g: 1, b: 1, minStep: 0.9, bands: 2, ink: 0, additive: true,
    });
    if (h < 0) break;
    // Walk a short ballistic arc immediately: the streak exists in one frame,
    // so its shape has to be authored rather than integrated.
    const sp = core.rand(28, 70);
    let px = x, py = y, pz = z;
    let vx = core.v1.x * sp, vy = core.v1.y * sp, vz = core.v1.z * sp;
    for (let k = 0; k < 8; k++) {
      core.trailsBill.extend(h, now, px, py, pz, 0, 1, 0, true);
      const dt = 0.012;
      px += vx * dt; py += vy * dt; pz += vz * dt;
      vy -= 9.81 * dt;
      vx *= 0.94; vy *= 0.94; vz *= 0.94;
    }
    core.trailsBill.release(h);
  }

  // Paint fragments and skin flakes blown off the panel.
  const chipN = core.count(6 + cal * 0.3, x, y, z);
  for (let i = 0; i < chipN; i++) {
    core.cone(core.v1, nx, ny, nz, 1.3);
    const sp = core.rand(2.5, 11);
    p.x = x; p.y = y; p.z = z;
    p.vx = core.v1.x * sp; p.vy = core.v1.y * sp; p.vz = core.v1.z * sp;
    p.life = core.rand(0.5, 1.5);
    p.size0 = core.rand(0.05, 0.16);
    p.size1 = p.size0;
    p.rot = core.rand(0, 6.283); p.spin = core.sym(14);
    p.drag = core.rand(1.6, 3.4); p.grav = 0.8;
    p.wind = 0.8; p.turb = 0;
    p.ramp = RAMP.PaintChip; p.tile = TILE.Shard;
    p.erode = 0.15; p.band = 1.4;
    p.r = p.g = p.b = 1; p.a = 1;
    core.dust.emit(now, p);
  }

  // A little grey puff of vapourised paint and aluminium oxide.
  const puffN = core.count(3, x, y, z);
  for (let i = 0; i < puffN; i++) {
    core.cone(core.v1, nx, ny, nz, 1.0);
    const sp = core.rand(1.5, 5);
    p.x = x; p.y = y; p.z = z;
    p.vx = core.v1.x * sp; p.vy = core.v1.y * sp; p.vz = core.v1.z * sp;
    p.life = core.rand(0.3, 0.8);
    p.size0 = s * 0.4; p.size1 = s * core.rand(1.6, 2.8);
    p.rot = core.rand(0, 6.283); p.spin = core.sym(1.5);
    p.drag = 3.2; p.grav = -0.05; p.wind = 1.0; p.turb = 0.4;
    p.ramp = RAMP.Cordite; p.tile = TILE.Wisp;
    p.erode = 0.7; p.band = 0.8;
    p.r = p.g = p.b = 1; p.a = 0.8;
    core.smoke.emit(now, p);
  }

  if (cal >= 20) {
    core.debris.spawn({
      x, y, z,
      vx: nx * core.rand(4, 12) + core.sym(3),
      vy: ny * core.rand(4, 12) + core.rand(1, 4),
      vz: nz * core.rand(4, 12) + core.sym(3),
      kind: 'panel', size: core.rand(0.12, 0.34),
      life: core.rand(1.6, 3.4), color: DEBRIS_COLORS.aluminium,
      spin: core.rand(10, 26), burning: 0, drag: 0.7,
    });
  }
}

function groundImpact(
  core: VfxCore, x: number, y: number, z: number,
  nx: number, ny: number, nz: number,
  cal: number, s: number, surface: ImpactSurface,
): void {
  const now = core.time;
  const p = resetSpawn();
  const hard = surface === 'concrete' || surface === 'rock';
  const ramp = surface === 'snow' ? RAMP.Snow : (hard ? RAMP.DustGrey : RAMP.DustBrown);

  const n = core.count(10 + cal * 0.6, x, y, z);
  for (let i = 0; i < n; i++) {
    core.cone(core.v1, nx, ny, nz, 0.75);
    const sp = core.rand(4, 16) * (0.6 + cal * 0.02);
    p.x = x; p.y = y + 0.05; p.z = z;
    p.vx = core.v1.x * sp; p.vy = core.v1.y * sp; p.vz = core.v1.z * sp;
    p.life = core.rand(0.7, 2.0);
    p.size0 = s * core.rand(0.4, 0.9);
    p.size1 = s * core.rand(2.2, 4.0);
    p.rot = core.rand(0, 6.283); p.spin = core.sym(0.9);
    p.drag = core.rand(1.4, 2.8);
    p.grav = 0.25;
    p.wind = 1.0; p.turb = 0.3;
    p.ramp = ramp; p.tile = i % 3 === 0 ? TILE.Clod : TILE.Puff;
    p.erode = 0.6; p.band = 1.0;
    p.r = p.g = p.b = core.rand(0.85, 1.12); p.a = 1;
    core.dust.emit(now, p);
  }

  // Concrete and rock spall in sparks; soil does not.
  if (hard) {
    const sn = core.count(10, x, y, z);
    for (let i = 0; i < sn; i++) {
      core.cone(core.v1, nx, ny, nz, 1.0);
      const sp = core.rand(8, 26);
      p.x = x; p.y = y; p.z = z;
      p.vx = core.v1.x * sp; p.vy = core.v1.y * sp; p.vz = core.v1.z * sp;
      p.life = core.rand(0.2, 0.6);
      p.size0 = core.rand(0.05, 0.12); p.size1 = p.size0 * 0.3;
      p.drag = 2.5; p.grav = 1; p.wind = 0.3;
      p.ramp = RAMP.SparkHot; p.tile = TILE.Streak;
      p.stretch = 0.02; p.erode = 0.1; p.band = 1;
      p.r = p.g = p.b = 1; p.a = 1;
      core.spark.emit(now, p);
    }
    p.stretch = 0;
  }

  if (cal >= 20 && core.rng.next() < 0.7) {
    core.debris.spawn({
      x, y: y + 0.1, z,
      vx: nx * core.rand(3, 9) + core.sym(2),
      vy: Math.abs(ny) * core.rand(5, 13),
      vz: nz * core.rand(3, 9) + core.sym(2),
      kind: 'clod', size: core.rand(0.10, 0.28),
      life: core.rand(1.2, 2.6),
      color: hard ? DEBRIS_COLORS.camoGrey : DEBRIS_COLORS.dirt,
      spin: core.rand(8, 22), burning: 0, drag: 0.4,
    });
  }
}

function waterImpact(core: VfxCore, x: number, y: number, z: number, cal: number, s: number): void {
  const now = core.time;
  const p = resetSpawn();

  // A bullet entering water throws a tall, narrow, very white column — much
  // taller relative to its width than a dirt plume, and it collapses fast.
  const n = core.count(9 + cal * 0.4, x, y, z);
  for (let i = 0; i < n; i++) {
    core.cone(core.v1, 0, 1, 0, 0.30);
    const sp = core.rand(7, 20) * (0.6 + cal * 0.022);
    p.x = x + core.sym(s * 0.3); p.y = y; p.z = z + core.sym(s * 0.3);
    p.vx = core.v1.x * sp; p.vy = core.v1.y * sp; p.vz = core.v1.z * sp;
    p.life = core.rand(0.5, 1.3);
    p.size0 = s * core.rand(0.3, 0.6);
    p.size1 = s * core.rand(1.2, 2.2);
    p.rot = core.rand(0, 6.283); p.spin = core.sym(0.6);
    p.drag = core.rand(0.5, 1.2);
    p.grav = 0.9;
    p.wind = 0.3; p.turb = 0;
    p.ramp = RAMP.WaterFoam;
    p.tile = i % 3 === 0 ? TILE.Splash : (i % 3 === 1 ? TILE.Droplet : TILE.Puff);
    p.erode = 0.4; p.band = 1.3;
    p.r = p.g = p.b = 1; p.a = 1;
    core.water.emit(now, p);
  }

  core.ringsDust.emit(now, {
    x, y: y + 0.1, z, nx: 0, ny: 1, nz: 0,
    life: 0.9 + cal * 0.01, r0: s * 0.3, r1: s * 3.4,
    thick0: s * 0.25, thick1: s * 0.7,
    ramp: RAMP.WaterFoam, wobble: 0.04,
    r: 1, g: 1, b: 1, a: 0.55,
  });
}

function woodImpact(
  core: VfxCore, x: number, y: number, z: number,
  nx: number, ny: number, nz: number, cal: number, s: number,
): void {
  const now = core.time;
  const p = resetSpawn();
  const n = core.count(8 + cal * 0.3, x, y, z);
  for (let i = 0; i < n; i++) {
    core.cone(core.v1, nx, ny, nz, 1.1);
    const sp = core.rand(3, 14);
    p.x = x; p.y = y; p.z = z;
    p.vx = core.v1.x * sp; p.vy = core.v1.y * sp; p.vz = core.v1.z * sp;
    p.life = core.rand(0.5, 1.6);
    p.size0 = core.rand(0.05, 0.14); p.size1 = p.size0;
    p.rot = core.rand(0, 6.283); p.spin = core.sym(12);
    p.drag = 2.2; p.grav = 0.9; p.wind = 0.7;
    p.ramp = RAMP.DirtClod; p.tile = TILE.Shard;
    p.erode = 0.2; p.band = 1.2;
    p.r = 1.15; p.g = 1.0; p.b = 0.8; p.a = 1;
    core.dust.emit(now, p);
  }
  const dn = core.count(4, x, y, z);
  for (let i = 0; i < dn; i++) {
    core.cone(core.v1, nx, ny, nz, 1.0);
    const sp = core.rand(1.5, 5);
    p.x = x; p.y = y; p.z = z;
    p.vx = core.v1.x * sp; p.vy = core.v1.y * sp; p.vz = core.v1.z * sp;
    p.life = core.rand(0.4, 1.0);
    p.size0 = s * 0.4; p.size1 = s * 2.2;
    p.rot = core.rand(0, 6.283); p.spin = core.sym(1);
    p.drag = 3; p.grav = -0.02; p.wind = 1; p.turb = 0.3;
    p.ramp = RAMP.DustBrown; p.tile = TILE.Wisp;
    p.erode = 0.7; p.band = 0.8;
    p.r = p.g = p.b = 1; p.a = 0.8;
    core.smoke.emit(now, p);
  }
}

function foliageImpact(
  core: VfxCore, x: number, y: number, z: number,
  nx: number, ny: number, nz: number, s: number,
): void {
  const now = core.time;
  const p = resetSpawn();
  const n = core.count(10, x, y, z);
  for (let i = 0; i < n; i++) {
    core.cone(core.v1, nx, ny, nz, 1.4);
    const sp = core.rand(1.5, 7);
    p.x = x; p.y = y; p.z = z;
    p.vx = core.v1.x * sp; p.vy = core.v1.y * sp; p.vz = core.v1.z * sp;
    p.life = core.rand(1.0, 2.6);
    p.size0 = core.rand(0.08, 0.20); p.size1 = p.size0;
    p.rot = core.rand(0, 6.283); p.spin = core.sym(8);
    p.drag = 2.6; p.grav = 0.35; p.wind = 1.2;
    p.ramp = RAMP.PaintChip; p.tile = TILE.Shard;
    p.erode = 0.2; p.band = 1;
    p.r = 0.55; p.g = 0.85; p.b = 0.45; p.a = 1;
    core.dust.emit(now, p);
  }
  void s;
}
