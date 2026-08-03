import * as THREE from 'three';
import { resetSpawn } from './ParticleEngine';
import { RAMP, TILE } from './VfxTextures';
import { DEFAULT_TRAIL, NO_TRAIL, type TrailConfig } from './TrailSystem';
import type { VfxCore } from './VfxCore';
import type { AircraftFx } from './EntityFx';

/**
 * Airflow effects — the part of the VFX budget that actually sells *flight*.
 *
 * All four effects here are condensation: the air around a wing, a propeller
 * tip or a shock front drops below its dew point and the water in it becomes
 * visible for as long as the pressure stays low. So they share one gate —
 * "how much water is available, and how hard is the air being pulled" — and
 * differ only in where the low pressure is and how long the vapour survives.
 *
 *   - **wingtip vortices** appear under high load factor. The trailing vortex
 *     core pressure falls roughly with the square of the lift coefficient, so
 *     the visible threshold is a g-load one, and it drops sharply in humid air.
 *   - **contrails** come from the engine, not the wing: exhaust water vapour
 *     freezing in air below about -40 C, which in the standard atmosphere is
 *     around 8 km. Games (and War Thunder) cheat this down to ~6 km because
 *     that is where the fighting is, and so do we.
 *   - **propeller tip vortices** are the same wingtip mechanism at a tip speed
 *     of Mach 0.8, which is why they show up at full power, low airspeed and
 *     high humidity — the take-off roll on a damp morning.
 *   - **the transonic collar** is the Prandtl-Glauert singularity: a local
 *     region of expansion behind the shock where pressure and temperature
 *     collapse together.
 */

const T0 = 288.15;          // ISA sea-level temperature, K
const LAPSE = 0.0065;       // K/m in the troposphere
const T_TROP = 216.65;      // isothermal above 11 km

/** ISA speed of sound at altitude, m/s. */
export function speedOfSound(alt: number): number {
  const T = Math.max(T_TROP, T0 - LAPSE * Math.min(alt, 11000));
  return 20.0468 * Math.sqrt(T);
}

/**
 * A stand-in for relative humidity by altitude. Real air is wettest in the
 * boundary layer and again near the tropopause; the trough in between is why
 * mid-altitude vortices are so rarely visible.
 */
export function humidityAt(alt: number, global: number): number {
  const low = Math.exp(-alt / 2400);            // moist boundary layer
  const high = Math.exp(-Math.abs(alt - 9000) / 3000) * 0.85;
  return Math.max(0, Math.min(1.2, (Math.max(low, high) * 0.9 + 0.12) * global));
}

/** Module-level scratch. Nothing in this file may allocate per frame. */
const _p = new THREE.Vector3();

/**
 * Trail configs are mutated in place and handed to TrailPool.acquire, which
 * copies them into the slot (Object.assign over the slot's own cfg). Building a
 * fresh literal here instead would put ~2900 short-lived objects a second into
 * the nursery at sixteen aircraft, which the brief counts as a correctness
 * failure, not a tidiness one. One record per effect is enough because acquire
 * never keeps the reference.
 */
const _vortexCfg: TrailConfig = { ...DEFAULT_TRAIL };
const _contrailCfg: TrailConfig = { ...DEFAULT_TRAIL };
const _propCfg: TrailConfig = { ...DEFAULT_TRAIL };

export interface AirflowInput {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  right: THREE.Vector3;
  up: THREE.Vector3;
  fwd: THREE.Vector3;
  /** Load factor in body-up, in g. */
  gLoad: number;
  speed: number;
  throttle: number;
  rpm: number;
  /** Wing span, metres. */
  span: number;
  /** Propeller diameter, metres. */
  propDia: number;
  /** Critical Mach of the airframe. */
  machCrit: number;
  /** Body-frame wingtip offsets, metres. */
  tipY: number;
  tipZ: number;
}

// ---------------------------------------------------------------------------
// Wingtip vortices
// ---------------------------------------------------------------------------

export function updateWingVortices(
  core: VfxCore, fx: AircraftFx, a: AirflowInput, humidityGlobal: number,
): void {
  const hum = humidityAt(a.y, humidityGlobal);
  // Visible threshold: about 3 g in soupy low-level air, 6 g in dry air. Below
  // 90 m/s the wing is not moving enough air to make a coherent core.
  const gThresh = 2.6 + (1 - hum) * 3.4;
  const strength = a.speed < 75 ? 0
    : Math.max(0, Math.min(1, (Math.abs(a.gLoad) - gThresh) / 2.6)) * Math.min(1, hum * 1.3);

  if (strength <= 0.02 || core.budget < 0.45) {
    releaseVortices(core, fx);
    return;
  }

  const half = a.span * 0.5;
  const cfgBase = _vortexCfg;
  cfgBase.ramp = a.y > 7000 ? RAMP.Contrail : RAMP.Vortex;
  // A real vortex core is a thread a fraction of a metre across. Anything
  // wider stops being vapour and becomes a party streamer.
  cfgBase.width0 = 0.16 + strength * 0.22;
  cfgBase.width1 = 0.55 + strength * 0.85;
  cfgBase.life = 0.9 + strength * 1.4;
  cfgBase.alpha = 0.30 + strength * 0.32;
  cfgBase.r = cfgBase.g = cfgBase.b = 1;
  cfgBase.minStep = 2.2;
  // The helix lives in the *centreline* (below), not in the ribbon's plane —
  // twisting a flat band about a straight axis just fills in to a solid
  // streamer once consecutive quads overlap.
  cfgBase.twistRate = 0;
  cfgBase.bands = 3;
  cfgBase.ink = 0;
  cfgBase.additive = true;

  for (let side = 0; side < 2; side++) {
    const sgn = side === 0 ? -1 : 1;
    let h = side === 0 ? fx.vortexL : fx.vortexR;
    if (h === NO_TRAIL || !core.trailsRibbon.isAlive(h)) {
      h = core.trailsRibbon.acquire(cfgBase);
      if (h === NO_TRAIL) continue;
      if (side === 0) fx.vortexL = h; else fx.vortexR = h;
    } else {
      const cfg = core.trailsRibbon.config(h);
      if (cfg) {
        cfg.width0 = cfgBase.width0; cfg.width1 = cfgBase.width1;
        cfg.alpha = cfgBase.alpha; cfg.life = cfgBase.life; cfg.ramp = cfgBase.ramp;
      }
    }

    // The two cores counter-rotate — that is what a trailing vortex pair does,
    // and it is why the left and right ribbons mirror each other rather than
    // running parallel. The centreline itself spirals; the ribbon is then
    // oriented radially so its face is always turned out of the helix.
    const ph = fx.vortexPhase * (side === 0 ? 1 : -1);
    const rad = 0.22 + strength * 0.40;
    const ox = a.right.x * Math.cos(ph) * rad + a.up.x * Math.sin(ph) * rad;
    const oy = a.right.y * Math.cos(ph) * rad + a.up.y * Math.sin(ph) * rad;
    const oz = a.right.z * Math.cos(ph) * rad + a.up.z * Math.sin(ph) * rad;

    _p.copy(a.right).multiplyScalar(sgn * half)
      .addScaledVector(a.up, a.tipY)
      .addScaledVector(a.fwd, a.tipZ);
    const added = core.trailsRibbon.extend(
      h, core.time,
      a.x + _p.x + ox, a.y + _p.y + oy, a.z + _p.z + oz,
      ox / rad, oy / rad, oz / rad,
    );
    // Advance the phase once per *emitted point*, not once per frame: the trail
    // only takes a point every minStep metres, so a per-frame advance would
    // make the pitch depend on frame rate.
    if (added && side === 1) fx.vortexPhase += 0.62;
  }

  // A little loose mist shed from the core, so the ribbon is not the only cue.
  fx.vortexMist -= core.dt;
  if (fx.vortexMist <= 0 && strength > 0.45) {
    fx.vortexMist = 0.06;
    const p = resetSpawn();
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? -1 : 1;
      _p.copy(a.right).multiplyScalar(sgn * half)
        .addScaledVector(a.up, a.tipY).addScaledVector(a.fwd, a.tipZ);
      p.x = a.x + _p.x; p.y = a.y + _p.y; p.z = a.z + _p.z;
      p.vx = a.vx * 0.12 + core.sym(1.5);
      p.vy = a.vy * 0.12 + core.sym(1.5);
      p.vz = a.vz * 0.12 + core.sym(1.5);
      p.life = core.rand(0.5, 1.2) * (0.6 + strength);
      p.size0 = 0.4; p.size1 = core.rand(2.0, 4.0);
      p.rot = core.rand(0, 6.283); p.spin = core.sym(1.2);
      p.drag = 1.4; p.grav = 0; p.wind = 0.5; p.turb = 0.6;
      p.ramp = RAMP.Condensation; p.tile = TILE.Wisp;
      p.erode = 0.7; p.band = 0.6;
      p.a = strength * 0.8;
      core.mist.emit(core.time, p);
    }
  }
}

export function releaseVortices(core: VfxCore, fx: AircraftFx): void {
  if (fx.vortexL !== NO_TRAIL) { core.trailsRibbon.release(fx.vortexL); fx.vortexL = NO_TRAIL; }
  if (fx.vortexR !== NO_TRAIL) { core.trailsRibbon.release(fx.vortexR); fx.vortexR = NO_TRAIL; }
}

// ---------------------------------------------------------------------------
// Engine contrails
// ---------------------------------------------------------------------------

const CONTRAIL_FLOOR = 5800;
const CONTRAIL_FULL = 6800;

export function updateContrails(
  core: VfxCore, fx: AircraftFx, a: AirflowInput,
  portL: THREE.Vector3 | null, portR: THREE.Vector3 | null,
): void {
  const altF = Math.max(0, Math.min(1, (a.y - CONTRAIL_FLOOR) / (CONTRAIL_FULL - CONTRAIL_FLOOR)));
  // Exhaust water only condenses if there is exhaust: an idling engine at
  // altitude leaves nothing, which is a genuine tactical detail.
  const power = Math.max(0, Math.min(1, (a.throttle - 0.18) / 0.55));
  const strength = altF * power;

  if (strength <= 0.03) {
    if (fx.contrailL !== NO_TRAIL) { core.trailsBill.release(fx.contrailL); fx.contrailL = NO_TRAIL; }
    if (fx.contrailR !== NO_TRAIL) { core.trailsBill.release(fx.contrailR); fx.contrailR = NO_TRAIL; }
    return;
  }

  const cfg = _contrailCfg;
  cfg.ramp = RAMP.Contrail;
  cfg.width0 = 1.0 + strength * 1.6;
  cfg.width1 = 9 + strength * 16;
  // Persistence is the whole point of a contrail: it must outlive the pass
  // that made it, so a fight at altitude writes its own history on the sky.
  cfg.life = 16 + strength * 22;
  cfg.alpha = 0.55 + strength * 0.4;
  cfg.r = cfg.g = cfg.b = 1;
  cfg.minStep = 26;
  cfg.twistRate = 0;
  cfg.bands = 0;
  cfg.ink = 0;
  cfg.additive = false;

  for (let side = 0; side < 2; side++) {
    const port = side === 0 ? portL : portR;
    let h = side === 0 ? fx.contrailL : fx.contrailR;
    if (h === NO_TRAIL || !core.trailsBill.isAlive(h)) {
      h = core.trailsBill.acquire(cfg);
      if (h === NO_TRAIL) continue;
      if (side === 0) fx.contrailL = h; else fx.contrailR = h;
    } else {
      const c = core.trailsBill.config(h);
      if (c) { c.width0 = cfg.width0; c.width1 = cfg.width1; c.alpha = cfg.alpha; }
    }

    if (port) {
      _p.copy(port);
    } else {
      const sgn = side === 0 ? -1 : 1;
      _p.copy(a.right).multiplyScalar(sgn * 0.55)
        .addScaledVector(a.up, -0.10)
        .addScaledVector(a.fwd, 0.6)
        .add(_tmpOrigin.set(a.x, a.y, a.z));
    }
    core.trailsBill.extend(h, core.time, _p.x, _p.y, _p.z);
  }
}

const _tmpOrigin = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Propeller tip vortices
// ---------------------------------------------------------------------------

export function updatePropVortices(
  core: VfxCore, fx: AircraftFx, a: AirflowInput,
  hubX: number, hubY: number, hubZ: number,
  humidityGlobal: number,
): void {
  const hum = humidityAt(a.y, humidityGlobal);
  // Full power, low forward speed: the blade tips are doing the most work per
  // unit of mass flow they can, which is when the tip cores go visible.
  const power = Math.max(0, Math.min(1, (a.throttle - 0.62) / 0.30));
  const slow = Math.max(0, Math.min(1, (85 - a.speed) / 55));
  const strength = power * slow * Math.max(0, (hum - 0.45) / 0.55);

  if (strength <= 0.04 || core.budget < 0.75) {
    if (fx.propL !== NO_TRAIL) { core.trailsRibbon.release(fx.propL); fx.propL = NO_TRAIL; }
    if (fx.propR !== NO_TRAIL) { core.trailsRibbon.release(fx.propR); fx.propR = NO_TRAIL; }
    return;
  }

  const R = a.propDia * 0.47;
  // The tip traces a helix in the world; we sample the blade angle at render
  // rate rather than at blade-passing rate, which aliases into a slow spiral —
  // and that spiral is exactly what the eye reads as a prop vortex anyway.
  fx.propPhase += core.dt * (18 + a.rpm * 26);
  const cfg = _propCfg;
  cfg.ramp = RAMP.Condensation;
  cfg.width0 = 0.12; cfg.width1 = 0.5;
  cfg.life = 0.45 + strength * 0.35;
  cfg.alpha = 0.22 + strength * 0.30;
  cfg.r = cfg.g = cfg.b = 1;
  cfg.minStep = 0.35;
  cfg.twistRate = 0.6;
  cfg.bands = 2; cfg.ink = 0; cfg.additive = true;

  for (let side = 0; side < 2; side++) {
    let h = side === 0 ? fx.propL : fx.propR;
    if (h === NO_TRAIL || !core.trailsRibbon.isAlive(h)) {
      h = core.trailsRibbon.acquire(cfg);
      if (h === NO_TRAIL) continue;
      if (side === 0) fx.propL = h; else fx.propR = h;
    } else {
      const c = core.trailsRibbon.config(h);
      if (c) c.alpha = cfg.alpha;
    }
    const ang = fx.propPhase + (side === 0 ? 0 : Math.PI);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    _p.copy(a.right).multiplyScalar(ca * R).addScaledVector(a.up, sa * R);
    core.trailsRibbon.extend(
      h, core.time,
      hubX + _p.x, hubY + _p.y, hubZ + _p.z,
      a.fwd.x, a.fwd.y, a.fwd.z,
    );
  }
}

// ---------------------------------------------------------------------------
// Transonic condensation collar
// ---------------------------------------------------------------------------

export function updateTransonic(
  core: VfxCore, fx: AircraftFx, a: AirflowInput, humidityGlobal: number,
): void {
  const mach = a.speed / speedOfSound(a.y);
  const onset = a.machCrit * 0.94;
  const t = Math.max(0, Math.min(1, (mach - onset) / Math.max(0.04, a.machCrit - onset + 0.06)));
  if (t <= 0.02) return;

  const hum = humidityAt(a.y, humidityGlobal);
  const strength = t * Math.min(1, 0.4 + hum);

  fx.machTimer -= core.dt;
  if (fx.machTimer > 0) return;
  fx.machTimer = 0.075;

  const span = a.span;
  // The collar sits just aft of the aircraft, normal to the flight path, and
  // its radius grows as the shock strengthens.
  const back = 0.35 + t * 0.5;
  const cx = a.x - a.fwd.x * span * back;
  const cy = a.y - a.fwd.y * span * back;
  const cz = a.z - a.fwd.z * span * back;

  core.ringsHot.emit(core.time, {
    x: cx, y: cy, z: cz,
    nx: a.fwd.x, ny: a.fwd.y, nz: a.fwd.z,
    life: 0.16,
    r0: span * (0.22 + t * 0.14),
    r1: span * (0.34 + t * 0.30),
    thick0: span * 0.16, thick1: span * 0.28,
    ramp: RAMP.Condensation, wobble: 0.05,
    r: 1, g: 1, b: 1, a: strength * 0.85,
  });

  // Plus a puff of vapour torn off the collar, which is what makes it flicker
  // rather than sit there like a decal.
  const p = resetSpawn();
  const n = core.count(3, a.x, a.y, a.z);
  for (let i = 0; i < n; i++) {
    const ang = core.rand(0, Math.PI * 2);
    const rr = span * core.rand(0.24, 0.36);
    _p.copy(a.right).multiplyScalar(Math.cos(ang) * rr)
      .addScaledVector(a.up, Math.sin(ang) * rr);
    p.x = cx + _p.x; p.y = cy + _p.y; p.z = cz + _p.z;
    p.vx = a.vx * 0.55 + core.sym(6);
    p.vy = a.vy * 0.55 + core.sym(6);
    p.vz = a.vz * 0.55 + core.sym(6);
    p.life = core.rand(0.14, 0.34);
    p.size0 = span * 0.10; p.size1 = span * core.rand(0.20, 0.34);
    p.rot = core.rand(0, 6.283); p.spin = core.sym(3);
    p.drag = 3.5; p.grav = 0; p.wind = 0.2; p.turb = 0;
    p.ramp = RAMP.Condensation; p.tile = TILE.Lens;
    p.erode = 0.5; p.band = 0.8;
    p.a = strength;
    core.mist.emit(core.time, p);
  }
}

// ---------------------------------------------------------------------------
// Ground effect: dust kicked up by the propwash on a take-off or landing roll
// ---------------------------------------------------------------------------

export function updateGroundWash(
  core: VfxCore, fx: AircraftFx, a: AirflowInput, groundY: number,
): void {
  const agl = a.y - groundY;
  // Propwash only reaches the ground within about one propeller diameter.
  if (agl > a.propDia * 1.15 || agl < -2) return;
  const prox = Math.max(0, Math.min(1, 1 - agl / (a.propDia * 1.15)));
  const blast = Math.max(0, Math.min(1, a.throttle * 1.3)) * prox;
  const roll = Math.max(0, Math.min(1, a.speed / 45));
  const amount = Math.max(blast * 0.8, roll * prox);
  if (amount < 0.06) return;

  fx.dustTimer -= core.dt;
  if (fx.dustTimer > 0) return;
  fx.dustTimer = 0.035;

  const surf = core.terrain.type(a.x, a.z);
  if (surf === 'water') return;
  const ramp = surf === 'snow' ? RAMP.Snow : surf === 'concrete' ? RAMP.DustGrey : RAMP.DustBrown;
  // A swept concrete runway has very little loose material to lift.
  const rich = surf === 'concrete' ? 0.45 : 1;

  const now = core.time;
  const p = resetSpawn();
  const n = core.count(4 * amount * rich, a.x, groundY, a.z);
  for (let i = 0; i < n; i++) {
    // Dust leaves from behind and to the sides — the propwash rolls up into
    // two counter-rotating sheets that fan outward behind the aircraft.
    const side = core.rng.next() < 0.5 ? -1 : 1;
    const back = core.rand(0.4, 3.2);
    _p.copy(a.fwd).multiplyScalar(-back * 2)
      .addScaledVector(a.right, side * core.rand(0.4, 2.6));
    p.x = a.x + _p.x; p.y = groundY + core.rand(0.05, 0.6); p.z = a.z + _p.z;
    p.vx = -a.fwd.x * core.rand(2, 12) * amount + a.right.x * side * core.rand(1, 6) + core.sym(1);
    p.vy = core.rand(0.6, 3.4) * amount;
    p.vz = -a.fwd.z * core.rand(2, 12) * amount + a.right.z * side * core.rand(1, 6) + core.sym(1);
    p.life = core.rand(1.2, 3.2);
    p.size0 = core.rand(0.5, 1.4);
    p.size1 = core.rand(3.0, 7.0);
    p.rot = core.rand(0, 6.283); p.spin = core.sym(0.5);
    p.drag = core.rand(0.9, 1.9);
    p.grav = 0.08;
    p.wind = 1.1; p.turb = 0.5;
    p.ramp = ramp;
    p.tile = i % 3 === 0 ? TILE.Wisp : TILE.Puff;
    p.erode = 0.62; p.band = 0.9;
    p.r = p.g = p.b = core.rand(0.88, 1.10);
    p.a = 0.55 + amount * 0.45;
    core.dust.emit(now, p);
  }
}
