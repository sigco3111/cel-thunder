/**
 * The atmosphere the client and the server must agree on.
 *
 * Client-side prediction only works if both halves integrate the aircraft
 * against the *same* air. When they do not, every reconciliation produces a
 * correction the client cannot hide and the aeroplane rubber-bands. This
 * module is therefore the single definition of density and wind; it is pure
 * maths with no DOM, no three.js and no Node built-ins, so both halves import
 * it directly rather than each keeping "close enough" copies.
 *
 * Terrain is *not* here: it is large, baked, and lives in
 * 'src/world/heightfield.ts', which is likewise three.js-free precisely so the
 * headless server can import it. Both sides must go through that same module —
 * a server that silently falls back to flat ground puts the client's wheels
 * 800 m underground on this map.
 */

import { hash2, type V3 } from './math';

const RHO_SL = 1.225;
const T_SL = 288.15;
const L = 0.0065;          // K/m, ISA tropospheric lapse rate
const G0 = 9.80665;
const R_AIR = 287.05287;
const TROPOPAUSE = 11000;  // m
const T_TROPO = T_SL - L * TROPOPAUSE;                                   // 216.65 K
const RHO_TROPO = RHO_SL * Math.pow(1 - L * TROPOPAUSE / T_SL, G0 / (R_AIR * L) - 1);

/** ISA density. Exponent (g/RL − 1) comes from ρ = p/RT with p from the lapse. */
export function airDensity(h: number): number {
  if (h <= 0) return RHO_SL;
  if (h < TROPOPAUSE) {
    return RHO_SL * Math.pow(1 - (L * h) / T_SL, G0 / (R_AIR * L) - 1);
  }
  // Isothermal layer above the tropopause: pure exponential decay.
  return RHO_TROPO * Math.exp(-G0 * (h - TROPOPAUSE) / (R_AIR * T_TROPO));
}

export function speedOfSound(h: number): number {
  const t = h < TROPOPAUSE ? T_SL - L * h : T_TROPO;
  return Math.sqrt(1.4 * R_AIR * t);
}

/** Per-map wind constants, derived once from the map seed. */
export interface WindField {
  /** Surface wind bearing, radians — the direction the wind blows *toward*. */
  dir: number;
  /** Surface wind speed, m/s. */
  speed: number;
}

export function windField(seed: number): WindField {
  return {
    dir: hash2(seed, 7, 11) * Math.PI * 2,
    speed: 2.5 + hash2(seed, 13, 17) * 5.0,
  };
}

/**
 * Wind at a world position: a prevailing gradient wind that veers and
 * strengthens with altitude (an Ekman spiral, roughly), plus slow large-scale
 * gusts. Deterministic in position only — no time term — so replaying an input
 * during reconciliation reproduces exactly the same trajectory.
 */
export function windAt(f: WindField, p: V3, out: V3): V3 {
  const h = Math.max(0, p.y);
  // Friction layer: speed ramps with the 1/7 power law up to ~600 m, then
  // grows slowly toward the jet.
  const shear = h < 600 ? Math.pow(h / 600, 1 / 7) : 1 + (h - 600) / 9000;
  const veer = f.dir + Math.min(0.6, h / 3500) * 0.55; // Ekman veering
  const speed = f.speed * shear;

  // Broad, slowly varying gust field (~3 km cells) — enough to make formation
  // flight feel alive without fighting the pilot.
  const gx = Math.floor(p.x / 3000), gz = Math.floor(p.z / 3000);
  const gust = (hash2(gx, gz, 91) - 0.5) * 2 * Math.min(1, speed * 0.35);
  const gustDir = hash2(gx, gz, 137) * Math.PI * 2;

  out.x = Math.sin(veer) * speed + Math.sin(gustDir) * gust;
  out.y = (hash2(gx, gz, 211) - 0.5) * 1.2;   // gentle vertical component
  out.z = Math.cos(veer) * speed + Math.cos(gustDir) * gust;
  return out;
}
