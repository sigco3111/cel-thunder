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

// ---------------------------------------------------------------------------
// Weather
//
// The *visual* weather presets live in 'src/render/sky/weather.ts'; this is the
// half of a weather state the simulation can feel. It is here, next to density
// and wind, for exactly the reason the module docstring gives: the server picks
// the weather for a match and the client predicts against it, so both halves
// must derive the same air from the same name or every reconciliation produces
// a correction.
// ---------------------------------------------------------------------------

export type WeatherId = 'clear' | 'scattered' | 'overcast' | 'storm' | 'fog';

export const WEATHER_IDS: readonly WeatherId[] =
  ['clear', 'scattered', 'overcast', 'storm', 'fog'];

export function isWeatherId(v: unknown): v is WeatherId {
  return typeof v === 'string' && (WEATHER_IDS as readonly string[]).indexOf(v) >= 0;
}

export interface WeatherAir {
  /** Multiplier on the map-seeded surface wind speed. */
  windScale: number;
  /**
   * Peak amplitude of the small-scale turbulence field, m/s.
   *
   * Read this as a gust *velocity*, because that is how the wing sees it: at a
   * 120 m/s cruise a 4 m/s vertical gust is an instantaneous 1.9 deg of alpha,
   * which is a third of a g. That is the number that decides whether a storm
   * feels different from a clear morning — not the steady wind, which an
   * aeroplane cannot feel at all because it is simply the air mass it lives in.
   */
  turbulence: number;
}

export const WEATHER_AIR: Record<WeatherId, WeatherAir> = {
  // High pressure, stable, barely a ripple.
  clear: { windScale: 0.75, turbulence: 0.30 },
  // Fair-weather cumulus: the thermals that build them are the bumps.
  scattered: { windScale: 1.00, turbulence: 1.00 },
  // A frontal deck brings the gradient wind down with it.
  overcast: { windScale: 1.45, turbulence: 1.80 },
  // Cumulonimbus outflow. Real, but still flyable — this is a fighter, not a
  // light aircraft, and an unflyable match is not a feature.
  storm: { windScale: 2.30, turbulence: 4.20 },
  // Radiation fog forms precisely because the air is dead calm.
  fog: { windScale: 0.40, turbulence: 0.12 },
};

/** Per-map wind constants, derived once from the map seed and the weather. */
export interface WindField {
  /** Surface wind bearing, radians — the direction the wind blows *toward*. */
  dir: number;
  /** Surface wind speed, m/s. */
  speed: number;
  /** Turbulence amplitude, m/s. See {@link WeatherAir.turbulence}. */
  turbulence: number;
  /** Spatial phase offsets, so two maps do not share the same gust pattern. */
  phaseA: number;
  phaseB: number;
}

export function windField(seed: number, weather: WeatherId = 'scattered'): WindField {
  const air = WEATHER_AIR[weather] ?? WEATHER_AIR.scattered;
  return {
    dir: hash2(seed, 7, 11) * Math.PI * 2,
    // Direction is a property of the *map*, not the weather: contrails, smoke
    // columns and the cloud field all lean the same way for a whole match, and
    // rotating that when the weather changes reads as the world spinning.
    speed: (2.5 + hash2(seed, 13, 17) * 5.0) * air.windScale,
    turbulence: air.turbulence,
    phaseA: hash2(seed, 23, 29) * Math.PI * 2,
    phaseB: hash2(seed, 31, 37) * Math.PI * 2,
  };
}

// ---------------------------------------------------------------------------
// Per-match environment
// ---------------------------------------------------------------------------

/** Everything about a match that is not the map: replicated in 'welcome'. */
export interface MatchEnvironment {
  weather: WeatherId;
  /** Local solar-clock hours, [0,24). */
  timeOfDay: number;
}

/**
 * Relative frequency of each weather state in the match rotation.
 *
 * Weighted rather than uniform because the point of varying the weather is
 * *contrast*: a storm that turns up one match in three stops being weather and
 * becomes the setting. Scattered cumulus is the canonical air-combat sky and
 * stays the most likely one.
 */
const WEATHER_WEIGHTS: Record<WeatherId, number> = {
  clear: 24, scattered: 38, overcast: 18, storm: 12, fog: 8,
};

/** Daylight window the match clock is drawn from, local solar hours. */
const TOD_MIN = 6.4;
const TOD_MAX = 19.6;

/**
 * Picks the weather and clock for a match from a seed.
 *
 * Deterministic in the seed on purpose: the offline sandbox derives its
 * environment from the map seed and therefore never changes under the
 * screenshot and playability harnesses, while the server passes a seed that
 * moves with the room so consecutive matches genuinely differ.
 */
export function matchEnvironment(seed: number): MatchEnvironment {
  let total = 0;
  for (const id of WEATHER_IDS) total += WEATHER_WEIGHTS[id];
  let r = hash2(seed, 101, 103) * total;
  let weather: WeatherId = 'scattered';
  for (const id of WEATHER_IDS) {
    r -= WEATHER_WEIGHTS[id];
    if (r <= 0) { weather = id; break; }
  }
  // Bias the clock toward the ends of the window: low sun is what makes a
  // stylised sky worth looking at, and a uniform draw spends most matches in
  // the flat, shadowless middle of the day. Raised-cosine warping does that in
  // one line — its derivative vanishes at both ends, so the sampling density is
  // highest exactly where the light is most interesting.
  const u = hash2(seed, 107, 109);
  const shaped = 0.5 - 0.5 * Math.cos(Math.PI * u);
  return { weather, timeOfDay: TOD_MIN + (TOD_MAX - TOD_MIN) * shaped };
}

/** Clamps an arbitrary number into the match clock's daylight window. */
export function clampTimeOfDay(h: number): number {
  if (!Number.isFinite(h)) return 9.5;
  return Math.min(TOD_MAX, Math.max(TOD_MIN, h));
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

  // --- weather turbulence --------------------------------------------------
  //
  // The gust field above is one value per 3 km cell: it is a slow, broad
  // meander, and at a 120 m/s cruise the aeroplane crosses a cell every 25 s.
  // Nothing about that reads as *weather*. Turbulence is the small scale the
  // airframe actually feels, so it gets its own field at ~200-450 m — one to
  // four seconds between bumps.
  //
  // It is a sum of incommensurate sinusoids rather than hashed cells for two
  // reasons: hashed cells produce a step change in wind at every cell wall,
  // which the flight model integrates into a visible jolt; and a continuous
  // field has a continuous *gradient*, which is what puts the aeroplane into a
  // slow wallow instead of a rattle. Position-only, with no time term, exactly
  // like the rest of this function — reconciliation replays inputs from an old
  // position and must reproduce the same trajectory to the bit.
  const a = f.turbulence;
  if (a > 0.001) {
    const pa = f.phaseA, pb = f.phaseB;
    // Damped near the deck: surface friction breaks the large eddies up, and a
    // 4 m/s vertical gust ten metres above the runway is a crash on landing.
    const lowLevel = h < 220 ? 0.25 + 0.75 * (h / 220) : 1;
    const amp = a * lowLevel;
    // Wavenumbers chosen to be mutually irrational-ish so the pattern does not
    // repeat over the 64 km map: periods of roughly 430 m, 250 m and 165 m.
    out.x += amp * (
      0.62 * Math.sin(p.x * 0.01461 + p.z * 0.00907 + pa)
      + 0.28 * Math.sin(p.z * 0.02513 - h * 0.01109 + pb)
      + 0.18 * Math.sin(p.x * 0.03803 - p.z * 0.02207 + pa * 1.7));
    out.z += amp * (
      0.62 * Math.cos(p.z * 0.01327 - p.x * 0.00811 + pb)
      + 0.28 * Math.cos(p.x * 0.02309 + h * 0.01013 + pa)
      + 0.18 * Math.cos(p.z * 0.03607 + p.x * 0.02411 + pb * 1.7));
    // Vertical gusts are what the wing notices; give them the same weight.
    out.y += amp * (
      0.70 * Math.sin(p.x * 0.01193 - p.z * 0.01571 + pb * 1.3)
      + 0.30 * Math.sin(p.z * 0.03019 + h * 0.00743 + pa * 0.6));
  }
  return out;
}
