/**
 * Velocity-dependent drag for projectiles.
 *
 * The single biggest mistake a game can make with gun ballistics is a constant
 * drag coefficient. Cd for a bullet is roughly flat and low up to about Mach
 * 0.8, then more than *triples* through the transonic region, peaks around
 * Mach 1.3, and slowly falls again. A constant-Cd round either flies like a
 * laser at short range or like a brick at long range; it cannot do both, and
 * the whole feel of leading a target comes from the fact that it does both.
 *
 * So: the real G1 drag function, tabulated, with a per-round *form factor*
 * scaling it. Form factor 'i' expresses how much sleeker a round is than the
 * blunt flat-base standard projectile the G1 curve was measured on. It is the
 * bridge between the published ballistic coefficient BC = m / (i · d²) and the
 * physical simulation:
 *
 *     a_drag = ½ · ρ · v² · (i · Cd_G1(M)) · A / m
 */

import { speedOfSound } from './atmosphere';
import { AmmoType } from './types';

// ---------------------------------------------------------------------------
// G1 standard drag function
// ---------------------------------------------------------------------------
//
// Mach / Cd pairs from the Ingalls/G1 tables. Between the listed points the
// curve is smooth enough that linear interpolation is well inside measurement
// error.

const G1_M: number[] = [
  0.00, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45,
  0.50, 0.55, 0.60, 0.70, 0.725, 0.75, 0.775, 0.80, 0.825, 0.85,
  0.875, 0.90, 0.925, 0.95, 0.975, 1.00, 1.025, 1.05, 1.075, 1.10,
  1.125, 1.15, 1.20, 1.25, 1.30, 1.35, 1.40, 1.50, 1.60, 1.80,
  2.00, 2.20, 2.50, 3.00, 3.50, 4.00, 5.00,
];
const G1_CD: number[] = [
  0.2629, 0.2558, 0.2487, 0.2413, 0.2344, 0.2278, 0.2214, 0.2155, 0.2104, 0.2061,
  0.2032, 0.2020, 0.2034, 0.2165, 0.2230, 0.2313, 0.2417, 0.2546, 0.2706, 0.2901,
  0.3136, 0.3415, 0.3734, 0.4084, 0.4448, 0.4805, 0.5136, 0.5427, 0.5677, 0.5883,
  0.6053, 0.6191, 0.6393, 0.6518, 0.6589, 0.6621, 0.6625, 0.6573, 0.6461, 0.6187,
  0.5901, 0.5626, 0.5266, 0.4784, 0.4441, 0.4182, 0.3820,
];

// Resample to a uniform grid so the hot path is an array index, not a search.
const CD_STEP = 0.02;
const CD_MAX_MACH = 6.0;
const CD_N = Math.round(CD_MAX_MACH / CD_STEP) + 1;
const G1_TABLE = new Float64Array(CD_N);

(() => {
  let seg = 0;
  for (let i = 0; i < CD_N; i++) {
    const m = i * CD_STEP;
    while (seg < G1_M.length - 2 && m > G1_M[seg + 1]) seg++;
    if (m <= G1_M[0]) { G1_TABLE[i] = G1_CD[0]; continue; }
    if (m >= G1_M[G1_M.length - 1]) {
      // Beyond Mach 5 the curve keeps falling slowly; extrapolate gently
      // rather than clamping, so hypervelocity test cases stay sane.
      const last = G1_CD[G1_CD.length - 1];
      G1_TABLE[i] = last * Math.pow(G1_M[G1_M.length - 1] / m, 0.18);
      continue;
    }
    const t = (m - G1_M[seg]) / (G1_M[seg + 1] - G1_M[seg]);
    G1_TABLE[i] = G1_CD[seg] + (G1_CD[seg + 1] - G1_CD[seg]) * t;
  }
})();

/** G1 standard-projectile drag coefficient at Mach 'm'. */
export function cdG1(m: number): number {
  if (m <= 0) return G1_TABLE[0];
  const f = m / CD_STEP;
  if (f >= CD_N - 1) return G1_TABLE[CD_N - 1];
  const i = f | 0;
  const a = f - i;
  return G1_TABLE[i] + (G1_TABLE[i + 1] - G1_TABLE[i]) * a;
}

// ---------------------------------------------------------------------------
// Bomb / rocket drag
// ---------------------------------------------------------------------------
//
// Bombs are blunt bodies with fins, not spitzer bullets: Cd on frontal area is
// ~0.10–0.14 subsonic, rising to ~0.45 transonic. A 500 lb bomb dropped from
// 4 km actually approaches its terminal velocity, so this matters for the
// bombsight lead.

export function cdBomb(m: number): number {
  if (m < 0.75) return 0.115;
  if (m < 1.05) return 0.115 + (m - 0.75) * (0.42 - 0.115) / 0.3;
  if (m < 1.4) return 0.42 - (m - 1.05) * 0.10 / 0.35;
  return 0.32;
}

/** Fin-stabilised rocket: slimmer than a bomb, with a big base-drag term. */
export function cdRocket(m: number, boosting: boolean): number {
  const base = m < 0.8 ? 0.20
    : m < 1.1 ? 0.20 + (m - 0.8) * (0.58 - 0.20) / 0.3
      : m < 1.6 ? 0.58 - (m - 1.1) * 0.13 / 0.5
        : 0.45;
  // While the motor burns, the exhaust plume fills the base and kills base
  // drag — worth ~25 %, and it is why unguided rockets accelerate so hard.
  return boosting ? base * 0.75 : base;
}

// ---------------------------------------------------------------------------
// Form factors
// ---------------------------------------------------------------------------

/**
 * Default G1 form factor by ammunition type and calibre.
 *
 * Sanity check against published data: the .50 BMG M2 AP is 46 g in 12.7 mm,
 * so m/d² = 0.39 lb/in²; with i = 0.63 that is BC ≈ 0.62, which is what the
 * ordnance tables say. The 20 mm HE shells are stubbier and blunter, hence a
 * worse (higher) form factor.
 */
export function defaultFormFactor(ammo: AmmoType, calibre: number): number {
  let i: number;
  switch (ammo) {
    case AmmoType.AP:
    case AmmoType.APHE:
      i = 0.63; break;
    case AmmoType.API:
      i = 0.68; break;
    case AmmoType.Ball:
      i = 0.72; break;
    case AmmoType.HE:
    case AmmoType.HEI:
      // Thin-walled HE shells are short and blunt-nosed for filler volume.
      i = 0.88; break;
    default:
      i = 0.75; break;
  }
  // Small-calibre rounds are proportionally longer and sleeker; big cannon
  // shells lose a little to their driving bands.
  if (calibre <= 8) i *= 0.94;
  else if (calibre >= 30) i *= 1.06;
  return i;
}

/** Frontal reference area of a round, m², from calibre in mm. */
export function calibreArea(calibreMm: number): number {
  const r = calibreMm * 0.0005; // mm -> m, then radius
  return Math.PI * r * r;
}

/**
 * Drag deceleration magnitude for a projectile.
 * @param speed  airspeed relative to the air mass, m/s
 * @param alt    altitude, m
 * @param cdArea (i · A) — form factor times reference area, m²
 * @param mass   kg
 * @param rho    density; pass it in if the caller already has it
 */
export function dragAccel(
  speed: number, alt: number, cdArea: number, mass: number, rho: number,
): number {
  const mach = speed / speedOfSound(alt);
  return 0.5 * rho * speed * speed * cdG1(mach) * cdArea / mass;
}
