import * as THREE from 'three';
import { resetSpawn } from './ParticleEngine';
import { RAMP, TILE } from './VfxTextures';
import { DEFAULT_TRAIL, NO_TRAIL, type TrailConfig } from './TrailSystem';
import type { VfxCore } from './VfxCore';
import type { AircraftFx } from './EntityFx';

/**
 * Bombs and rockets in flight.
 *
 * A WWII air-to-ground rocket burns for well under a second and then coasts,
 * so the effect has two completely different phases and the transition is the
 * whole read: a fat, brilliant motor plume for ~0.7 s, then nothing but a
 * thinning white smoke trail for the rest of the flight. Getting that timing
 * right is what makes a salvo of RP-3s look like a salvo of RP-3s.
 *
 * A falling bomb has no motor. What it does have is fins, a spin, and — once
 * it is going fast enough — thin vapour off the fin tips. The trail here is
 * deliberately faint; a bomb you can follow like a firework is a game bug.
 */

const _p = new THREE.Vector3();

/** Rocket motors burn out fast; after this the trail thins and greys. */
const MOTOR_BURN = 0.75;

/** Acquire templates, mutated in place — acquire() copies, it does not keep. */
const _rocketTrail: TrailConfig = {
  ...DEFAULT_TRAIL,
  ramp: RAMP.Cordite, width0: 0.5, width1: 5.0, life: 5.0, alpha: 0.9,
  minStep: 5, bands: 3, ink: 0, additive: false,
};
const _bombTrail: TrailConfig = {
  ...DEFAULT_TRAIL,
  ramp: RAMP.Condensation, width0: 0.10, width1: 0.9, life: 1.4,
  alpha: 0.5, minStep: 6, bands: 2, ink: 0, additive: true,
};

export function updateRocketFx(
  core: VfxCore, fx: AircraftFx,
  x: number, y: number, z: number,
  vx: number, vy: number, vz: number,
  fwd: THREE.Vector3,
): void {
  const now = core.time;
  const p = resetSpawn();
  const burning = fx.age < MOTOR_BURN;
  const burn = burning ? 1 - fx.age / MOTOR_BURN : 0;

  // Smoke trail — always present, wide and white during the burn, thin after.
  if (fx.debrisTrail === NO_TRAIL || !core.trailsBill.isAlive(fx.debrisTrail)) {
    fx.debrisTrail = core.trailsBill.acquire(_rocketTrail);
  }
  if (fx.debrisTrail !== NO_TRAIL) {
    const c = core.trailsBill.config(fx.debrisTrail);
    if (c) {
      c.width0 = 0.35 + burn * 0.9;
      c.width1 = 3.0 + burn * 5.0;
      c.alpha = 0.35 + burn * 0.6;
    }
    core.trailsBill.extend(fx.debrisTrail, now, x, y, z);
  }

  if (!burning) {
    // Coasting: a thin wisp every so often keeps the trail from looking like a
    // ruled line, and nothing else.
    fx.fireTimer -= core.dt;
    if (fx.fireTimer <= 0) {
      fx.fireTimer = 0.06;
      const n = core.count(1, x, y, z);
      for (let i = 0; i < n; i++) {
        p.x = x + core.sym(0.3); p.y = y + core.sym(0.3); p.z = z + core.sym(0.3);
        p.vx = vx * 0.15 + core.sym(1.5);
        p.vy = vy * 0.15 + core.sym(1.5);
        p.vz = vz * 0.15 + core.sym(1.5);
        p.life = core.rand(1.2, 3.0);
        p.size0 = core.rand(0.3, 0.7); p.size1 = core.rand(2.5, 5.0);
        p.rot = core.rand(0, 6.283); p.spin = core.sym(0.7);
        p.drag = 1.1; p.grav = -0.05; p.wind = 1.0; p.turb = 0.5;
        p.ramp = RAMP.Cordite; p.tile = TILE.Wisp;
        p.erode = 0.7; p.band = 0.7; p.a = 0.55;
        core.smoke.emit(now, p);
      }
    }
    return;
  }

  // --- motor plume ---------------------------------------------------------
  fx.fireTimer -= core.dt;
  if (fx.fireTimer > 0) return;
  fx.fireTimer = 0.016;

  // Flame: a short, bright, hard cone directly behind the nozzle.
  const fn = core.count(3, x, y, z);
  for (let i = 0; i < fn; i++) {
    const back = core.rand(0.2, 2.4);
    p.x = x - fwd.x * back; p.y = y - fwd.y * back; p.z = z - fwd.z * back;
    p.vx = vx * 0.25 - fwd.x * core.rand(10, 30) + core.sym(2);
    p.vy = vy * 0.25 - fwd.y * core.rand(10, 30) + core.sym(2);
    p.vz = vz * 0.25 - fwd.z * core.rand(10, 30) + core.sym(2);
    p.life = core.rand(0.06, 0.18);
    p.size0 = core.rand(0.35, 0.7) * (0.5 + burn);
    p.size1 = core.rand(0.8, 1.6) * (0.5 + burn);
    p.rot = core.rand(0, 6.283); p.spin = core.sym(4);
    p.drag = 5; p.grav = 0; p.wind = 0; p.turb = 0;
    p.ramp = RAMP.FireCore; p.tile = i % 2 ? TILE.Cone : TILE.Puff;
    p.erode = 0.2; p.band = 2.0;
    p.a = 1;
    core.fire.emit(now, p);
  }

  // Sparks and thick exhaust smoke rolling out of the plume.
  const sn = core.count(2, x, y, z);
  for (let i = 0; i < sn; i++) {
    p.x = x - fwd.x * 1.2; p.y = y - fwd.y * 1.2; p.z = z - fwd.z * 1.2;
    p.vx = vx * 0.2 - fwd.x * core.rand(20, 55) + core.sym(6);
    p.vy = vy * 0.2 - fwd.y * core.rand(20, 55) + core.sym(6);
    p.vz = vz * 0.2 - fwd.z * core.rand(20, 55) + core.sym(6);
    p.life = core.rand(0.1, 0.4);
    p.size0 = core.rand(0.06, 0.14); p.size1 = p.size0 * 0.4;
    p.drag = 2.2; p.grav = 0.4; p.wind = 0.3;
    p.ramp = RAMP.SparkHot; p.tile = TILE.Streak;
    p.stretch = 0.016; p.erode = 0.1; p.band = 1; p.a = 1;
    core.spark.emit(now, p);
  }
  p.stretch = 0;

  const mn = core.count(2, x, y, z);
  for (let i = 0; i < mn; i++) {
    const back = core.rand(1.0, 4.0);
    p.x = x - fwd.x * back + core.sym(0.4);
    p.y = y - fwd.y * back + core.sym(0.4);
    p.z = z - fwd.z * back + core.sym(0.4);
    p.vx = vx * 0.12 - fwd.x * core.rand(3, 12) + core.sym(2);
    p.vy = vy * 0.12 - fwd.y * core.rand(3, 12) + core.sym(2);
    p.vz = vz * 0.12 - fwd.z * core.rand(3, 12) + core.sym(2);
    p.life = core.rand(1.0, 2.6);
    p.size0 = core.rand(0.4, 0.9);
    p.size1 = core.rand(2.8, 6.0);
    p.rot = core.rand(0, 6.283); p.spin = core.sym(1.0);
    p.drag = core.rand(1.0, 2.0); p.grav = -0.05;
    p.wind = 1.0; p.turb = 0.8;
    p.ramp = RAMP.Cordite; p.tile = i % 2 ? TILE.Billow : TILE.Puff;
    p.erode = 0.6; p.band = 0.9; p.a = 0.9;
    core.smoke.emit(now, p);
  }
}

/**
 * A falling bomb. Vapour comes off the fin tips only once the local flow is
 * fast enough to matter, so at release there is nothing and by the time it is
 * doing 200 m/s there are four thin ribbons behind it.
 */
export function updateBombFx(
  core: VfxCore, fx: AircraftFx,
  x: number, y: number, z: number,
  vx: number, vy: number, vz: number,
  fwd: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3,
  humidity: number,
): void {
  const speed = Math.hypot(vx, vy, vz);
  const vis = Math.max(0, Math.min(1, (speed - 130) / 110)) * Math.min(1, humidity * 1.4);
  if (vis <= 0.05) {
    if (fx.debrisTrail !== NO_TRAIL) { core.trailsBill.release(fx.debrisTrail); fx.debrisTrail = NO_TRAIL; }
    return;
  }

  if (fx.debrisTrail === NO_TRAIL || !core.trailsBill.isAlive(fx.debrisTrail)) {
    fx.debrisTrail = core.trailsBill.acquire(_bombTrail);
  }
  if (fx.debrisTrail !== NO_TRAIL) {
    const c = core.trailsBill.config(fx.debrisTrail);
    if (c) c.alpha = 0.25 + vis * 0.5;
    core.trailsBill.extend(fx.debrisTrail, core.time, x, y, z);
  }

  // Fin-tip vapour: four short streamers, phased to the body roll so the fins
  // read as fins rather than as a fuzz around the tail.
  fx.fireTimer -= core.dt;
  if (fx.fireTimer > 0) return;
  fx.fireTimer = 0.05;
  const p = resetSpawn();
  for (let i = 0; i < 4; i++) {
    const ang = i * Math.PI * 0.5 + fx.propPhase;
    _p.copy(right).multiplyScalar(Math.cos(ang) * 0.28)
      .addScaledVector(up, Math.sin(ang) * 0.28)
      .addScaledVector(fwd, -0.6);
    p.x = x + _p.x; p.y = y + _p.y; p.z = z + _p.z;
    p.vx = vx * 0.35; p.vy = vy * 0.35; p.vz = vz * 0.35;
    p.life = core.rand(0.10, 0.26);
    p.size0 = 0.10; p.size1 = core.rand(0.4, 0.9);
    p.rot = core.rand(0, 6.283); p.spin = 0;
    p.drag = 4; p.grav = 0; p.wind = 0.2; p.turb = 0;
    p.ramp = RAMP.Condensation; p.tile = TILE.Wisp;
    p.erode = 0.6; p.band = 0.5; p.a = vis * 0.7;
    core.mist.emit(core.time, p);
  }
}

/** Backblast and launch smoke when a rocket leaves the rail. */
export function spawnRocketLaunch(
  core: VfxCore,
  x: number, y: number, z: number,
  dx: number, dy: number, dz: number,
  avx: number, avy: number, avz: number,
): void {
  if (core.tooFar(x, y, z, 6000)) return;
  const now = core.time;
  const p = resetSpawn();

  p.x = x; p.y = y; p.z = z;
  p.life = 0.06;
  p.size0 = 0.8; p.size1 = 2.6;
  p.rot = core.rand(0, 6.283); p.spin = core.sym(2);
  p.drag = 7; p.grav = 0; p.wind = 0;
  p.ramp = RAMP.MuzzleFlash; p.tile = TILE.Star;
  p.erode = 0.1; p.band = 2; p.a = 1;
  core.flash.emit(now, p);

  const n = core.count(14, x, y, z);
  for (let i = 0; i < n; i++) {
    core.cone(core.v1, -dx, -dy, -dz, 0.65);
    const sp = core.rand(8, 34);
    p.x = x - dx * 0.4; p.y = y - dy * 0.4; p.z = z - dz * 0.4;
    p.vx = avx + core.v1.x * sp;
    p.vy = avy + core.v1.y * sp;
    p.vz = avz + core.v1.z * sp;
    p.life = core.rand(0.8, 2.4);
    p.size0 = core.rand(0.4, 0.9); p.size1 = core.rand(2.5, 5.5);
    p.rot = core.rand(0, 6.283); p.spin = core.sym(1.2);
    p.drag = core.rand(1.4, 2.6); p.grav = -0.05;
    p.wind = 1.0; p.turb = 0.8;
    p.ramp = RAMP.Cordite; p.tile = i % 3 === 0 ? TILE.Billow : TILE.Puff;
    p.erode = 0.65; p.band = 0.9; p.a = 0.9;
    core.smoke.emit(now, p);
  }
}
