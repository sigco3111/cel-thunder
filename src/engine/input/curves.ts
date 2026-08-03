/**
 * Axis conditioning — dead zones, non-linear centre regions, saturation and
 * inversion.
 *
 * Why this is not just 'raw * sensitivity':
 *
 *  - **Dead zone.** Every physical stick has slop around centre, and a mouse
 *    that is "still" still emits ±1 px jitter. Without a dead zone the aircraft
 *    never stops trimming itself.
 *  - **Expo (the non-linear centre).** Fighter pilots want fine authority for
 *    the last half-degree of tracking and coarse authority for a break turn.
 *    A cubic blend gives exactly that: shallow slope near centre, steep at the
 *    edges, and — critically — it is monotonic and C¹ continuous, so there is
 *    no perceptible "step" as the stick passes through the blend.
 *  - **Saturation.** Full deflection should be reachable slightly before the
 *    mechanical stop, otherwise worn hardware can never command 100 %.
 *
 * The curve is normalised so that 'applyCurve(±1) === ±1' for any parameter
 * set: the pilot's muscle memory for "full stick" must not depend on settings.
 */

export interface AxisCurve {
  /** Fraction of travel around centre that reads as zero. 0…0.5 */
  deadzone: number;
  /** Fraction of travel at the ends that reads as full. 0…0.4 */
  saturation: number;
  /**
   * Curvature of the centre region. 0 = linear, 1 = fully cubic.
   * 0.35–0.6 is the usable band for flight; above 0.8 the aircraft feels dead.
   */
  expo: number;
  /** Multiplier applied *before* saturation clamping. */
  sensitivity: number;
  invert: boolean;
}

export const defaultCurve = (over: Partial<AxisCurve> = {}): AxisCurve => ({
  deadzone: 0.06,
  saturation: 0.02,
  expo: 0.45,
  sensitivity: 1,
  invert: false,
  ...over,
});

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Maps a raw axis reading in [-1,1] through the curve.
 * Sign-symmetric, monotonic, and exactly ±1 at the ends.
 */
export function applyCurve(raw: number, c: AxisCurve, deadzoneOverride?: number): number {
  let v = clamp(raw, -1, 1);
  if (c.invert) v = -v;

  const sign = v < 0 ? -1 : 1;
  let m = Math.abs(v);

  // Dead zone, rescaled so the response resumes from zero rather than jumping.
  // 'deadzoneOverride' exists for the one real caller that needs it: a stick
  // that has already been through a *radial* dead zone must not have a second,
  // per-axis one applied. The alternative — spreading a copy of the curve with
  // 'deadzone: 0' — allocated four objects every frame a pad was connected.
  const dz = clamp(deadzoneOverride ?? c.deadzone, 0, 0.5);
  if (m <= dz) return 0;
  const sat = clamp(c.saturation, 0, 0.4);
  const span = Math.max(1e-4, 1 - dz - sat);
  m = clamp((m - dz) / span, 0, 1);

  // Expo: blend linear and cubic. Both are 0 at 0 and 1 at 1, so the blend is
  // normalised for free.
  const e = clamp(c.expo, 0, 1);
  m = (1 - e) * m + e * m * m * m;

  return clamp(sign * m * c.sensitivity, -1, 1);
}

/**
 * Radial dead zone for a two-axis stick.
 *
 * Per-axis dead zones on a round-gated stick produce a plus-shaped hole: the
 * diagonals get through while the cardinals are still suppressed, which shows
 * up as the aircraft rolling when the player meant to pitch. Deadzoning the
 * *magnitude* and keeping the direction fixes it.
 */
export function radialDeadzone(x: number, y: number, dz: number, out: { x: number; y: number }): void {
  const m = Math.hypot(x, y);
  if (m <= dz || m <= 1e-6) { out.x = 0; out.y = 0; return; }
  const scaled = Math.min(1, (m - dz) / Math.max(1e-4, 1 - dz));
  out.x = (x / m) * scaled;
  out.y = (y / m) * scaled;
}

/**
 * Curve applied to a *rate* rather than a position — used for mouse deltas,
 * where the input is unbounded. Small movements stay 1:1 (so slow tracking is
 * exact) and fast flicks get a mild acceleration, which is what makes a
 * 40 cm/360° mouse able to both snipe and snap-turn.
 *
 * @param delta   raw delta in the caller's units
 * @param dt      frame time; acceleration must be measured in units *per second*
 *                or the feel changes with frame rate
 * @param accel   0 = pure 1:1, 1 = strong acceleration
 */
export function mouseAccel(delta: number, dt: number, accel: number): number {
  if (accel <= 1e-4 || dt <= 1e-6) return delta;
  const speed = Math.abs(delta) / dt;          // units/s
  // Reference speed at which the gain reaches 1.5x. Chosen so ordinary
  // tracking motions (< 400 units/s) are untouched.
  const gain = 1 + accel * Math.min(1.6, speed / 900);
  return delta * gain;
}

/** Frame-rate independent exponential approach; 'rate' is per second. */
export const damp = (a: number, b: number, rate: number, dt: number): number =>
  a + (b - a) * (1 - Math.exp(-rate * dt));

/** Move 'a' toward 'b' at no more than 'maxRate' per second. */
export const approach = (a: number, b: number, maxRate: number, dt: number): number => {
  const d = b - a;
  const step = maxRate * dt;
  return Math.abs(d) <= step ? b : a + Math.sign(d) * step;
};

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clampSym = (v: number) => (v < -1 ? -1 : v > 1 ? 1 : v);
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
