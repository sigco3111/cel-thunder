/**
 * NACA 4-digit aerofoil generator — the real equations, computed from the
 * digits, not a hand-drawn spline that "looks like a wing".
 *
 * For NACA MPXX:
 *   m = M/100   maximum camber as a fraction of chord
 *   p = P/10    chordwise position of maximum camber
 *   t = XX/100  maximum thickness as a fraction of chord
 *
 * Camber line (Abbott & von Doenhoff, eq. 6.2):
 *   x < p :  yc = m/p²      · (2p·x − x²)
 *   x ≥ p :  yc = m/(1−p)²  · ((1−2p) + 2p·x − x²)
 *
 * Thickness distribution:
 *   yt = 5t·(0.2969√x − 0.1260x − 0.3516x² + 0.2843x³ − 0.1036x⁴)
 * The −0.1036 (rather than −0.1015) closes the trailing edge exactly; we then
 * re-open it by 'teThickness' so the loft has no zero-area triangles at the TE
 * and so the trailing edge catches a highlight the way a real sheet-metal edge
 * does.
 *
 * 'maxThickAt' warps the chordwise coordinate to move the thickness peak aft,
 * which is how the laminar-flow sections on the P-51 are approximated: the
 * remap x ↦ x^(ln 0.3 / ln q) is monotone, fixes both endpoints and moves the
 * 30 % peak of the 4-digit family to q.
 */

export interface Foil {
  m: number;
  p: number;
  t: number;
  /** Chordwise position of maximum thickness (0.30 for the 4-digit family). */
  maxThickAt: number;
  teThickness: number;
}

export function naca(code: string, maxThickAt = 0.30, teThickness = 0.0035): Foil {
  const d = code.replace(/\D/g, '').padStart(4, '0');
  const m = parseInt(d[0], 10) / 100;
  const p = parseInt(d[1], 10) / 10;
  const t = parseInt(d.slice(2, 4), 10) / 100;
  return { m, p: p > 0 ? p : 0.4, t, maxThickAt, teThickness };
}

/** Half-thickness at chordwise station x ∈ [0,1]. */
export function foilThickness(f: Foil, x: number): number {
  const k = Math.log(0.30) / Math.log(Math.max(0.05, Math.min(0.9, f.maxThickAt)));
  const xw = Math.pow(Math.max(0, Math.min(1, x)), k);
  const s = Math.sqrt(xw);
  const yt = 5 * f.t * (0.2969 * s - 0.1260 * xw - 0.3516 * xw * xw + 0.2843 * xw * xw * xw - 0.1036 * xw * xw * xw * xw);
  // Blend a finite trailing edge in over the last 20 % of chord.
  const teBlend = x <= 0.8 ? 0 : (x - 0.8) / 0.2;
  return Math.max(0, yt) + f.teThickness * 0.5 * teBlend;
}

/** Camber-line ordinate and slope at x. */
export function foilCamber(f: Foil, x: number): { yc: number; dy: number } {
  if (f.m <= 0) return { yc: 0, dy: 0 };
  const p = f.p;
  if (x < p) {
    const k = f.m / (p * p);
    return { yc: k * (2 * p * x - x * x), dy: k * (2 * p - 2 * x) };
  }
  const k = f.m / ((1 - p) * (1 - p));
  return { yc: k * ((1 - 2 * p) + 2 * p * x - x * x), dy: k * (2 * p - 2 * x) };
}

export interface FoilPoint { x: number; y: number; /** +1 upper, -1 lower */ side: number; /** 0 at LE, 1 at TE */ s: number }

/**
 * Closed contour of 'n' points. Index 0 is the trailing edge on the upper
 * surface; the loop runs forward along the upper surface to the leading edge at
 * n/2, then aft along the lower surface, wrapping shut at the TE.
 *
 * Cosine spacing clusters points where curvature is: the leading edge gets ~4×
 * the density of the mid-chord, which is what stops the nose of the aerofoil
 * from faceting when you are sitting on the wing in the chase camera.
 */
export function foilContour(f: Foil, n: number): FoilPoint[] {
  return foilContourRange(f, n, 0, 1);
}

/**
 * Contour restricted to a chordwise window — the mechanism behind real control
 * surfaces. The wing skin is generated over [0, hinge] and the aileron over
 * [hinge, 1] from the *same* aerofoil, so the two halves share a profile
 * exactly and the gap between them is a real gap rather than an overlap.
 * The ordinates are still evaluated at true chordwise stations, so a truncated
 * section is a truncated aerofoil and not a squashed one.
 */
export function foilContourRange(f: Foil, n: number, x0: number, x1: number): FoilPoint[] {
  const half = Math.max(4, n >> 1);
  const pts: FoilPoint[] = [];
  for (let i = 0; i < n; i++) {
    const upper = i <= half;
    // ξ runs 0→1 along each surface; cosine spacing in ξ gives LE/TE clustering.
    const xi = upper ? i / half : (i - half) / (n - half);
    const f01 = upper ? (1 + Math.cos(Math.PI * xi)) * 0.5 : (1 - Math.cos(Math.PI * xi)) * 0.5;
    const x = x0 + (x1 - x0) * f01;
    const yt = foilThickness(f, x);
    const { yc, dy } = foilCamber(f, x);
    const th = Math.atan(dy);
    const sgn = upper ? 1 : -1;
    pts.push({
      x: x - sgn * yt * Math.sin(th),
      y: yc + sgn * yt * Math.cos(th),
      side: sgn,
      s: x,
    });
  }
  return pts;
}

/** Interpolate between two foils (root → tip thickness taper). */
export function lerpFoil(a: Foil, b: Foil, t: number): Foil {
  return {
    m: a.m + (b.m - a.m) * t,
    p: a.p + (b.p - a.p) * t,
    t: a.t + (b.t - a.t) * t,
    maxThickAt: a.maxThickAt + (b.maxThickAt - a.maxThickAt) * t,
    teThickness: a.teThickness + (b.teThickness - a.teThickness) * t,
  };
}

/** Per-aircraft aerofoil selection. Real sections where they exist. */
export interface FoilSet { root: Foil; tip: Foil; tail: Foil; fin: Foil; prop: Foil }

export function foilsFor(id: string): FoilSet {
  const symTail = naca('0009');
  const symFin = naca('0010');
  const prop = naca('4412', 0.32, 0.004);
  switch (id) {
    case 'spitfire_mk9':
      // NACA 2213 at root thinning to 2209.4 at tip — the famously thin wing.
      return { root: naca('2213'), tip: naca('2209'), tail: symTail, fin: symFin, prop };
    case 'bf109_g6':
      // NACA 2R1 14.2 / 11.35 — approximated by the 4-digit equivalents.
      return { root: naca('2314'), tip: naca('2311'), tail: symTail, fin: symFin, prop };
    case 'p51d':
      // NAA/NACA 45-100 laminar section: thickness peak pushed back to ~42 %.
      return { root: naca('1416', 0.42), tip: naca('1411', 0.44), tail: naca('0010', 0.38), fin: naca('0010', 0.38), prop };
    case 'a6m5':
      return { root: naca('2315'), tip: naca('2309'), tail: symTail, fin: symFin, prop };
    case 'la5fn':
      // NACA 23016 / 23010 — 5-digit; the 4-digit stand-ins match the profile.
      return { root: naca('2316'), tip: naca('2310'), tail: symTail, fin: symFin, prop };
    default:
      return { root: naca('2412'), tip: naca('2409'), tail: symTail, fin: symFin, prop };
  }
}
