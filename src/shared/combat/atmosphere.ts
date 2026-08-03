/**
 * International Standard Atmosphere, 0 – 20 km.
 *
 * Ballistics cares about exactly three things from the atmosphere: density
 * (drag scales linearly with it), speed of sound (the drag *coefficient*
 * depends on Mach, and the transonic rise is violent), and — for the flight
 * model's benefit — pressure.
 *
 * A bullet fired at 6 km flies noticeably flatter and further than the same
 * bullet at sea level: density there is 0.66 kg/m³, barely half of the 1.225
 * at the surface. That is a real, felt gameplay difference in high-altitude
 * bomber interceptions, so it is worth getting right rather than assuming a
 * constant.
 */

export const G0 = 9.80665;          // m/s², standard gravity
export const RHO_SL = 1.225;        // kg/m³, ISA sea-level density
export const P_SL = 101325;         // Pa
export const T_SL = 288.15;         // K
export const R_AIR = 287.05287;     // J/(kg·K)
export const GAMMA = 1.4;
const LAPSE = 0.0065;               // K/m, troposphere
const T_TROPO = 216.65;             // K, isothermal above 11 km
const H_TROPO = 11000;

/** ISA temperature, kelvin. Clamped to the stratospheric plateau above 11 km. */
export function isaTemperature(h: number): number {
  if (h <= H_TROPO) return T_SL - LAPSE * (h < 0 ? 0 : h);
  return T_TROPO;
}

/** ISA static pressure, pascals. */
export function isaPressure(h: number): number {
  if (h <= H_TROPO) {
    const t = isaTemperature(h);
    // p = p0 (T/T0)^(g/(L·R)) — the exponent is 5.25588 for ISA constants.
    return P_SL * Math.pow(t / T_SL, G0 / (LAPSE * R_AIR));
  }
  const pTropo = P_SL * Math.pow(T_TROPO / T_SL, G0 / (LAPSE * R_AIR));
  // Isothermal layer: exponential decay with scale height R·T/g.
  return pTropo * Math.exp((-G0 * (h - H_TROPO)) / (R_AIR * T_TROPO));
}

// ---------------------------------------------------------------------------
// Lookup tables
// ---------------------------------------------------------------------------
//
// A projectile step evaluates density and sound speed once per substep, and
// there can be a few thousand rounds in the air in a big furball. 'Math.pow'
// in that loop is measurable, so precompute and lerp. 250 m spacing gives
// <0.02 % error, far below anything that matters ballistically.

const TABLE_STEP = 250;
const TABLE_MAX = 20000;
const TABLE_N = TABLE_MAX / TABLE_STEP + 1;

const RHO_TABLE = new Float64Array(TABLE_N);
const SND_TABLE = new Float64Array(TABLE_N);

for (let i = 0; i < TABLE_N; i++) {
  const h = i * TABLE_STEP;
  const t = isaTemperature(h);
  const p = isaPressure(h);
  RHO_TABLE[i] = p / (R_AIR * t);
  SND_TABLE[i] = Math.sqrt(GAMMA * R_AIR * t);
}

function sampleTable(table: Float64Array, h: number): number {
  if (h <= 0) return table[0];
  if (h >= TABLE_MAX) return table[TABLE_N - 1];
  const f = h / TABLE_STEP;
  const i = f | 0;
  const a = f - i;
  return table[i] + (table[i + 1] - table[i]) * a;
}

/** Air density, kg/m³, at geometric altitude 'h' metres above sea level. */
export function airDensity(h: number): number {
  return sampleTable(RHO_TABLE, h);
}

/** Speed of sound, m/s. */
export function speedOfSound(h: number): number {
  return sampleTable(SND_TABLE, h);
}

/** Density ratio to sea level — the number drag actually scales by. */
export function densityRatio(h: number): number {
  return sampleTable(RHO_TABLE, h) / RHO_SL;
}

/**
 * Equivalent airspeed from true airspeed. The gunsight and the flight model
 * both want this; putting it here keeps one atmosphere model in the codebase.
 */
export function tasToIas(tas: number, h: number): number {
  return tas * Math.sqrt(densityRatio(h));
}

export function iasToTas(ias: number, h: number): number {
  return ias / Math.sqrt(Math.max(1e-6, densityRatio(h)));
}
