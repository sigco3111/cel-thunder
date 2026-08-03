import { DamageBits, type EntityState } from '../shared/protocol';
import type { AircraftSpec } from '../shared/aircraft';
import { clamp, damp } from './dom';

/**
 * Everything the HUD needs to draw one frame, and the model that produces it.
 *
 * The flight simulation is authoritative for the state it replicates
 * (attitude, velocity, throttle, RPM, flaps, gear, damage bits). It does *not*
 * replicate cockpit instrumentation — oil and coolant temperature, manifold
 * pressure, fuel burn, per-gun ammunition — because none of that affects the
 * shared world enough to justify the bandwidth. So this class derives them
 * from replicated state with a small, physically-motivated presentation model.
 *
 * Any field can be overridden by another subsystem through
 * 'UiSystem.setTelemetry({...})'; once a key is pushed from outside, the
 * derived model stops writing it for good. That is the seam that lets the real
 * flight model take over instrumentation later without touching the HUD.
 */
export interface HudTelemetry {
  alive: boolean;
  /** Indicated airspeed, m/s (what the pitot tube would read). */
  ias: number;
  /** True airspeed, m/s. */
  tas: number;
  mach: number;
  /** Barometric altitude above sea level, m. */
  altBaro: number;
  /** Radar altitude above the terrain directly below, m. */
  altRadar: number;
  /** Vertical speed, m/s (positive = climbing). */
  vspeed: number;
  /** Magnetic-ish heading, degrees 0..360 (0 = +Z world = north). */
  heading: number;
  pitch: number;
  roll: number;
  /** Angle of attack and sideslip, degrees. */
  aoa: number;
  beta: number;
  /** Lateral specific force in g — drives the slip/skid ball. */
  slip: number;
  gLoad: number;
  gPeak: number;
  gMin: number;

  throttle: number;
  wep: boolean;
  rpm: number;
  rpmFrac: number;
  /** Manifold pressure in ata (converted for display per nation). */
  manifold: number;
  oilTemp: number;
  coolantTemp: number;
  /** 0..1 "badness" for the gauge ramp. */
  oilFrac: number;
  coolantFrac: number;
  radiator: number;

  fuel: number;
  fuelMax: number;
  /** Seconds of fuel left at the current burn rate. */
  fuelTime: number;

  flaps: number;
  gear: number;
  airbrake: number;

  damage: number;
  health: number;
  stall: boolean;
  overspeed: boolean;
  gWarn: boolean;

  ammo: AmmoState[];
  spec: AircraftSpec | null;
}

export interface AmmoState {
  name: string;
  short: string;
  calibre: number;
  group: 1 | 2;
  rounds: number;
  max: number;
  tracer: number;
}

export function newTelemetry(): HudTelemetry {
  return {
    alive: false,
    ias: 0, tas: 0, mach: 0, altBaro: 0, altRadar: 0, vspeed: 0,
    heading: 0, pitch: 0, roll: 0, aoa: 0, beta: 0, slip: 0,
    gLoad: 1, gPeak: 1, gMin: 1,
    throttle: 0, wep: false, rpm: 0, rpmFrac: 0, manifold: 1,
    oilTemp: 20, coolantTemp: 20, oilFrac: 0, coolantFrac: 0, radiator: 0.5,
    fuel: 0, fuelMax: 1, fuelTime: 0,
    flaps: 0, gear: 0, airbrake: 0,
    damage: 0, health: 1, stall: false, overspeed: false, gWarn: false,
    ammo: [], spec: null,
  };
}

// --- International Standard Atmosphere, troposphere only (0–11 km) ---------
const RHO0 = 1.225;
export function airDensity(altM: number): number {
  const h = clamp(altM, -500, 11000);
  return RHO0 * Math.pow(1 - 2.25577e-5 * h, 4.25588);
}
export function speedOfSound(altM: number): number {
  const t = 288.15 - 0.0065 * clamp(altM, -500, 11000);
  return 20.046 * Math.sqrt(t);
}
export function ambientTemp(altM: number): number {
  return 15 - 0.0065 * clamp(altM, -500, 11000);
}

/** Manifold-pressure display unit by nation — a small but telling detail. */
export function manifoldUnit(nation: string): { unit: string; scale: number; digits: number } {
  switch (nation) {
    case 'usa':
    case 'britain':
      return { unit: 'inHg', scale: 29.53, digits: 1 };   // 1 ata = 29.53 inHg
    case 'ussr':
      return { unit: 'mmHg', scale: 750.06, digits: 0 };
    default:
      return { unit: 'ata', scale: 1, digits: 2 };        // Germany, Japan
  }
}

// Module-scope scratch so the per-frame path allocates nothing.
const bodyFwd = { x: 0, y: 0, z: 1 };
const bodyUp = { x: 0, y: 1, z: 0 };
const bodyRight = { x: 1, y: 0, z: 0 };
const accel = { x: 0, y: 0, z: 0 };

function rotate(qx: number, qy: number, qz: number, qw: number, vx: number, vy: number, vz: number,
                out: { x: number; y: number; z: number }): void {
  // v' = q * v * q⁻¹, expanded (identical to shared/math qrot, inlined to keep
  // this file dependency-free and allocation-free).
  const ix = qw * vx + qy * vz - qz * vy;
  const iy = qw * vy + qz * vx - qx * vz;
  const iz = qw * vz + qx * vy - qy * vx;
  const iw = -qx * vx - qy * vy - qz * vz;
  out.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
  out.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
  out.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
}

export class TelemetryModel {
  readonly data: HudTelemetry = newTelemetry();
  /** Keys another subsystem has taken ownership of. */
  private owned = new Set<keyof HudTelemetry>();

  private prevVx = 0;
  private prevVy = 0;
  private prevVz = 0;
  private hasPrev = false;
  private peakDecay = 0;
  private spec: AircraftSpec | null = null;
  private ammoByGun: AmmoState[] = [];
  /** Round-robin cursor so a burst spreads across a group's barrels. */
  private fireCursor = 0;

  /** Terrain sampler, injected once the world subsystem exposes one. */
  terrain: ((x: number, z: number) => number) | null = null;

  setOwned(keys: (keyof HudTelemetry)[]): void {
    for (const k of keys) this.owned.add(k);
  }
  isOwned(k: keyof HudTelemetry): boolean { return this.owned.has(k); }

  /** Called when the local aircraft changes (spawn / aircraft select). */
  setAircraft(spec: AircraftSpec | null): void {
    if (this.spec === spec) return;
    this.spec = spec;
    this.data.spec = spec;
    this.ammoByGun = [];
    if (spec) {
      for (const g of spec.guns) {
        this.ammoByGun.push({
          name: g.name,
          short: shortGunName(g.name),
          calibre: g.calibre,
          group: g.group,
          rounds: g.ammo * g.count,
          max: g.ammo * g.count,
          tracer: g.tracer,
        });
      }
      this.data.fuel = spec.damage.fuel;
      this.data.fuelMax = spec.damage.fuel;
      this.data.oilTemp = 30;
      this.data.coolantTemp = 40;
    }
    this.data.ammo = this.ammoByGun;
    this.resetPeaks();
  }

  resetPeaks(): void {
    this.data.gPeak = 1;
    this.data.gMin = 1;
    this.hasPrev = false;
  }

  refill(): void {
    for (const a of this.ammoByGun) a.rounds = a.max;
    if (this.spec) this.data.fuel = this.spec.damage.fuel;
  }

  /** One gun in 'group' fired 'n' rounds. */
  consumeAmmo(group: number, n = 1): void {
    if (this.owned.has('ammo')) return;
    if (!this.ammoByGun.length) return;
    // Guns in a group fire together; deduct from each so the counters fall in
    // step the way a real ammo counter bank does. Iterated by index rather than
    // filtered into a new array: this runs once per Gunfire event, which for a
    // six-gun battery at 1200 rpm is over a hundred times a second.
    let hit = false;
    for (const a of this.ammoByGun) {
      if (a.group !== group) continue;
      hit = true;
      a.rounds = Math.max(0, a.rounds - n);
    }
    // No gun in that group: fall back to the whole battery rather than silently
    // failing to count the burst.
    if (!hit) for (const a of this.ammoByGun) a.rounds = Math.max(0, a.rounds - n);
    this.fireCursor++;
  }

  setAmmoAbsolute(counts: number[]): void {
    for (let i = 0; i < counts.length && i < this.ammoByGun.length; i++) {
      this.ammoByGun[i].rounds = clamp(counts[i], 0, this.ammoByGun[i].max);
    }
    this.owned.add('ammo');
  }

  /**
   * Derives the full instrument set for this frame.
   * 'e' is the local aircraft state; pass null when dead/spectating.
   */
  update(e: EntityState | null, dt: number, inputBits: number): void {
    const d = this.data;
    const own = this.owned;

    if (!e) {
      d.alive = false;
      this.hasPrev = false;
      return;
    }
    d.alive = true;

    // --- axes -------------------------------------------------------------
    rotate(e.qx, e.qy, e.qz, e.qw, 0, 0, 1, bodyFwd);
    rotate(e.qx, e.qy, e.qz, e.qw, 0, 1, 0, bodyUp);
    rotate(e.qx, e.qy, e.qz, e.qw, 1, 0, 0, bodyRight);

    const vx = e.vx, vy = e.vy, vz = e.vz;
    const speed = Math.hypot(vx, vy, vz);

    // --- attitude ---------------------------------------------------------
    if (!own.has('heading')) {
      let hdg = Math.atan2(bodyFwd.x, bodyFwd.z) * 57.29577951;
      if (hdg < 0) hdg += 360;
      d.heading = hdg;
    }
    if (!own.has('pitch')) d.pitch = Math.asin(clamp(bodyFwd.y, -1, 1)) * 57.29577951;
    if (!own.has('roll')) {
      // Roll = angle of the body-right vector out of the horizontal plane,
      // signed against the world-up projection so it stays continuous inverted.
      //
      // Body +X is the aeroplane's *screen-left* wing — X-right/Y-up/Z-forward
      // is a left-handed labelling and the world is right-handed, so the axis
      // the model calls "right" renders on the left (measured: body +X · camera
      // screen-right = −0.999). Negating here makes a positive roll mean "the
      // wing the pilot can see on their right is down", which is what the bank
      // scale and the horizon are drawn against.
      const rightY = -bodyRight.y;
      const upY = bodyUp.y;
      d.roll = Math.atan2(-rightY, upY < 0 ? -Math.abs(upY) : Math.abs(upY)) * 57.29577951;
      if (upY < 0) d.roll = d.roll > 0 ? 180 - d.roll : -180 - d.roll;
    }

    // --- speeds -----------------------------------------------------------
    const alt = e.py;
    const rho = airDensity(alt);
    if (!own.has('tas')) d.tas = speed;
    if (!own.has('ias')) d.ias = speed * Math.sqrt(rho / RHO0);
    if (!own.has('mach')) d.mach = speed / speedOfSound(alt);
    if (!own.has('altBaro')) d.altBaro = alt;
    if (!own.has('altRadar')) {
      const ground = this.terrain ? this.terrain(e.px, e.pz) : 0;
      d.altRadar = Math.max(0, alt - Math.max(0, ground));
    }
    if (!own.has('vspeed')) d.vspeed = damp(d.vspeed, vy, 6, dt);

    // --- aerodynamic angles ----------------------------------------------
    if (speed > 4) {
      const u = vx * bodyFwd.x + vy * bodyFwd.y + vz * bodyFwd.z;
      const w = vx * bodyUp.x + vy * bodyUp.y + vz * bodyUp.z;
      // Negated with the roll, and for the same reason: body +X is the wing on
      // the pilot's left, so an unnegated sideslip reads backwards on the ball.
      const s = -(vx * bodyRight.x + vy * bodyRight.y + vz * bodyRight.z);
      if (!own.has('aoa')) d.aoa = Math.atan2(-w, Math.max(1, u)) * 57.29577951;
      if (!own.has('beta')) d.beta = Math.asin(clamp(s / speed, -1, 1)) * 57.29577951;
    } else if (!own.has('aoa')) {
      d.aoa = 0; d.beta = 0;
    }

    // --- load factor ------------------------------------------------------
    // Specific force f = a − g. In level flight a = 0, so f points straight up
    // at 1 g, which is exactly what an accelerometer (and a g-meter) reads.
    if (dt > 1e-4) {
      if (this.hasPrev) {
        accel.x = (vx - this.prevVx) / dt;
        accel.y = (vy - this.prevVy) / dt + 9.80665;
        accel.z = (vz - this.prevVz) / dt;
      } else {
        accel.x = 0; accel.y = 9.80665; accel.z = 0;
      }
      this.prevVx = vx; this.prevVy = vy; this.prevVz = vz;
      this.hasPrev = true;

      const gRaw = (accel.x * bodyUp.x + accel.y * bodyUp.y + accel.z * bodyUp.z) / 9.80665;
      const slipRaw = -(accel.x * bodyRight.x + accel.y * bodyRight.y + accel.z * bodyRight.z) / 9.80665;
      if (!own.has('gLoad')) {
        // The raw differentiated value is noisy at 20 Hz snapshot rate; a short
        // filter matches the mechanical lag of a real g-meter anyway.
        d.gLoad = damp(d.gLoad, clamp(gRaw, -12, 20), 10, dt);
      }
      if (!own.has('slip')) d.slip = damp(d.slip, clamp(slipRaw, -1.2, 1.2), 6, dt);
    }
    if (d.gLoad > d.gPeak) d.gPeak = d.gLoad;
    if (d.gLoad < d.gMin) d.gMin = d.gLoad;
    // Peaks bleed back slowly so the marker stays meaningful across a fight
    // instead of freezing at the first hard pull of the sortie.
    this.peakDecay += dt;
    if (this.peakDecay > 8) {
      this.peakDecay = 0;
      d.gPeak = Math.max(d.gLoad, d.gPeak - 0.35);
      d.gMin = Math.min(d.gLoad, d.gMin + 0.25);
    }

    // --- powerplant -------------------------------------------------------
    const spec = this.spec;
    if (!own.has('throttle')) d.throttle = e.throttle;
    if (!own.has('wep')) d.wep = (inputBits & 512) !== 0 && e.throttle > 0.95;
    if (!own.has('rpmFrac')) d.rpmFrac = e.rpm;
    if (!own.has('flaps')) d.flaps = e.flaps;
    if (!own.has('gear')) d.gear = e.gear;
    if (!own.has('airbrake')) d.airbrake = (inputBits & 128) ? 1 : 0;
    if (!own.has('damage')) d.damage = e.damage;
    if (!own.has('health')) d.health = e.health;

    const engineDead = (d.damage & DamageBits.Engine) !== 0;
    const fire = (d.damage & DamageBits.EngineFire) !== 0;

    if (spec) {
      if (!own.has('rpm')) d.rpm = d.rpmFrac * spec.engine.maxRpm;

      // Manifold pressure: throttle-scheduled, with the supercharger holding
      // boost up to the critical altitude and falling off above it.
      if (!own.has('manifold')) {
        const critFall = Math.max(0, alt - spec.engine.critAlt) / 6000 * spec.engine.altFalloff;
        const boost = clamp(1 - critFall, 0.42, 1);
        const maxAta = 1.30 * (d.wep ? spec.engine.wepMul : 1);
        const target = (0.42 + 0.58 * d.throttle) * maxAta * boost * (engineDead ? 0.25 : 1);
        d.manifold = damp(d.manifold, target, 3, dt);
      }

      // Cooling: heat in from power, heat out from radiator opening and ram
      // air. Radial engines dump heat far better than a liquid-cooled inline,
      // which is why they run cooler here for the same power setting.
      if (!own.has('radiator')) d.radiator = (inputBits & 1024) ? 1 : 0.55;
      const amb = ambientTemp(alt);
      const load = 0.22 + 0.78 * d.throttle + (d.wep ? 0.42 : 0) + (engineDead ? 0.55 : 0) + (fire ? 1.4 : 0);
      const ram = 0.35 + Math.min(1, d.ias / 110) * 0.65;
      const cool = (0.30 + 0.70 * d.radiator) * ram * (spec.engine.kind === 'radial' ? 1.28 : 1);
      if (!own.has('oilTemp')) {
        const t = clamp(amb + 62 * load / Math.max(0.3, cool), 15, 190);
        d.oilTemp = damp(d.oilTemp, t, 0.055, dt);   // ~18 s time constant
      }
      if (!own.has('coolantTemp')) {
        const t = clamp(amb + 74 * load / Math.max(0.3, cool), 15, 200);
        d.coolantTemp = damp(d.coolantTemp, t, 0.11, dt); // ~9 s
      }
      d.oilFrac = clamp((d.oilTemp - 55) / 60, 0, 1);
      d.coolantFrac = clamp((d.coolantTemp - 62) / 62, 0, 1);

      // Fuel: specific consumption of a WWII piston fighter is ~0.30 kg/kWh at
      // cruise, worse at emergency power.
      if (!own.has('fuel')) {
        const kw = spec.engine.powerKw * (0.12 + 0.88 * d.throttle) * (d.wep ? spec.engine.wepMul : 1);
        let burn = (kw * 0.31) / 3600;
        if (d.damage & DamageBits.FuelLeak) burn += 0.75;
        if (engineDead) burn *= 0.2;
        d.fuel = Math.max(0, d.fuel - burn * dt);
        d.fuelTime = burn > 1e-4 ? d.fuel / burn : 0;
      }

      // Envelope warnings.
      const clMax = spec.aero.clMax + spec.aero.flapCl * d.flaps;
      const vStall = Math.sqrt((2 * spec.aero.mass * 9.80665 * Math.max(1, Math.abs(d.gLoad)))
        / (RHO0 * spec.aero.wingArea * clMax));
      d.stall = d.ias < vStall * 1.06 && d.altRadar > 3;
      d.overspeed = d.ias > spec.aero.vne * 0.94;
      d.gWarn = Math.abs(d.gLoad) > spec.aero.gLimit * 0.85;
    }
  }
}

/** "20 mm Hispano Mk II" → "HISPANO II"; keeps the ammo list scannable. */
function shortGunName(name: string): string {
  const s = name.replace(/^\s*[\d.]+\s*mm\s*/i, '').trim();
  return (s || name).toUpperCase();
}
