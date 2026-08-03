import * as THREE from 'three';
import { hash2 } from '../shared/math';

/**
 * Every VFX texture in the game is generated here, at load time, on the CPU.
 * There are no image assets. Two atlases do all the work:
 *
 *  1. **The sprite atlas** — a 4x4 grid of 128 px shape tiles. The channels are
 *     *not* an RGBA picture; they are four separate masks that the particle
 *     shader combines:
 *
 *       A = coverage. Crosses 0.5 exactly on the silhouette, with a gradient of
 *           roughly one unit per ~2.5 texels. The shader hard-thresholds it
 *           (with an fwidth-based AA band) so particles get a crisp inked
 *           silhouette instead of a soft grey blob, and can *erode* the
 *           threshold over the particle's life so it dissolves in a graphic way
 *           rather than fading translucent.
 *       R = "core" — how deep inside the nearest billow lobe / flash spike a
 *           texel is. Drives internal highlights so smoke reads as volumes made
 *           of lobes rather than a flat stamp.
 *       G = "depth" — normalised distance in from the silhouette. Drives the
 *           interior value bands and the ink outline width.
 *       B = fbm noise, used as the erosion mask so the dissolve is ragged.
 *
 *  2. **The ramp atlas** — one row per colour ramp, sampled by normalised age.
 *     Ramps are baked *piecewise-constant* from a handful of art-directed
 *     stops, so every ramp is a hard-stepped band sequence by construction:
 *     that is where "orange -> red -> dark smoke in stepped bands" comes from.
 *     Values are baked in **linear** space into a float texture, because the
 *     scene renders linear and a ShaderMaterial gets no automatic sRGB decode.
 */

// ---------------------------------------------------------------------------
// Sprite atlas
// ---------------------------------------------------------------------------

export const ATLAS_GRID = 5;
export const ATLAS_TILE_PX = 128;
export const ATLAS_PX = ATLAS_GRID * ATLAS_TILE_PX;

export const TILE = {
  Puff: 0,        // billowy smoke puff, notched
  Billow: 1,      // taller, column-shaped billow
  Wisp: 2,        // ragged torn smoke wisp
  Streak: 3,      // tapered spark / tracer streak
  Star: 4,        // 7-point muzzle flash star
  Cone: 5,        // triangular muzzle cone
  Ring: 6,        // thin annulus
  Crescent: 7,    // annulus with a weighted leading arc
  Chunk: 8,       // faceted debris silhouette
  Shard: 9,       // thin angular paint / metal fragment
  Clod: 10,       // clumpy dirt
  Splash: 11,     // foamy water column
  Droplet: 12,    // teardrop
  Ember: 13,      // small hard disc
  Twinkle: 14,    // 4-point spark twinkle
  Lens: 15,       // squashed lens — condensation discs, haze cards
  PuffB: 16,      // second puff silhouette, leaning
  PuffC: 17,      // third puff silhouette, shredded on one flank
  Flame: 18,      // forked flame lick, root at +Y
  FlameB: 19,     // second flame lick, curled
  Torn: 20,       // late-life smoke remnant: mostly holes
  PuffD: 21,      // fourth puff silhouette: wide, low, with a torn crown
} as const;
export type TileId = (typeof TILE)[keyof typeof TILE];

/**
 * The smoke silhouettes, in the order an emitter should cycle them.
 *
 * A plume made of one repeated stamp reads as a string of identical beads no
 * matter how it is shaded — the eye locks onto the repetition instantly. Five
 * genuinely different outlines, mirrored on both axes and independently
 * squashed per particle by the vertex shader, is enough that a stamp never
 * visibly repeats inside one plume.
 */
export const SMOKE_TILES: readonly number[] = [
  TILE.Puff, TILE.PuffB, TILE.Billow, TILE.PuffC, TILE.PuffD,
];

// --- deterministic noise ----------------------------------------------------

function vnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x: number, y: number, seed: number, oct = 4): number {
  let f = 0, amp = 0.5, fr = 1;
  for (let i = 0; i < oct; i++) {
    f += amp * vnoise(x * fr, y * fr, seed + i * 977);
    fr *= 2; amp *= 0.5;
  }
  return f;
}

// --- sdf helpers ------------------------------------------------------------

const sdCircle = (x: number, y: number, cx: number, cy: number, r: number) =>
  Math.hypot(x - cx, y - cy) - r;

/** Distance to a segment with linearly tapering radius (a "cone capsule"). */
function sdTaperedCapsule(
  x: number, y: number,
  ax: number, ay: number, bx: number, by: number,
  ra: number, rb: number,
): number {
  const bax = bx - ax, bay = by - ay;
  const pax = x - ax, pay = y - ay;
  const len2 = bax * bax + bay * bay || 1e-6;
  const t = Math.max(0, Math.min(1, (pax * bax + pay * bay) / len2));
  const cx = ax + bax * t, cy = ay + bay * t;
  return Math.hypot(x - cx, y - cy) - (ra + (rb - ra) * t);
}

interface Sample { d: number; core: number }
type ShapeFn = (x: number, y: number) => Sample;

/** Union of circular lobes: crisp outer silhouette, lobe depth in 'core'. */
function lobes(list: readonly [number, number, number][]): ShapeFn {
  return (x, y) => {
    let d = 1e9, core = 0;
    for (let i = 0; i < list.length; i++) {
      const [cx, cy, r] = list[i];
      const di = sdCircle(x, y, cx, cy, r);
      if (di < d) d = di;
      const c = -di / r;
      if (c > core) core = c;
    }
    return { d, core: Math.max(0, Math.min(1, core)) };
  };
}

/**
 * A smoke billow: a union of lobes with concave notches cut back out of it.
 *
 * This is the fix for the single worst failure mode of sprite smoke. A pure
 * union of discs is convex almost everywhere, so however cleverly it is shaded
 * every stamp still reads as a ball — the "soap bubble" look. Real smoke
 * silhouettes are full of *re-entrant* notches, where one roll has folded into
 * the back of another, and no amount of surface noise will manufacture one at
 * lobe scale. So the notches are authored: 'cut' lobes are subtracted from the
 * union, which drives the distance field positive in the middle of the shape
 * and produces genuine bays and near-pinches in the outline.
 */
function billow(
  add: readonly [number, number, number][],
  cut: readonly [number, number, number][],
): ShapeFn {
  const union = lobes(add);
  return (x, y) => {
    const s = union(x, y);
    let d = s.d;
    let core = s.core;
    for (let i = 0; i < cut.length; i++) {
      const [cx, cy, r] = cut[i];
      const di = sdCircle(x, y, cx, cy, r);
      // Boolean subtraction on an SDF: max(d, -dCut).
      if (-di > d) d = -di;
      // The lobe-depth channel has to lose the bitten-out region too, or the
      // interior highlight sits proud in the middle of a hole.
      core *= Math.max(0, Math.min(1, di / r + 0.6));
    }
    return { d, core: Math.max(0, Math.min(1, core)) };
  };
}

/**
 * A flame lick: two or three tapering tongues sharing a root at +Y.
 *
 * Fire is drawn with velocity-stretched sprites, and the stretch runs along
 * sprite +Y, so the root (fat, hottest, attached to the aircraft) has to be at
 * +Y and the torn tip at -Y. A single smooth capsule gives the "melted plastic"
 * read; splitting it into tongues that separate toward the tip is what makes
 * consecutive stamps merge into a licking, forked flame instead of a rod.
 */
function flame(
  tongues: readonly [number, number, number, number][],
): ShapeFn {
  return (x, y) => {
    let d = 1e9, core = 0;
    for (let i = 0; i < tongues.length; i++) {
      const [tipX, tipY, rootR, lean] = tongues[i];
      // Root always at the same place; the tongue leans away as it goes aft, so
      // the tips fan out.
      const di = sdTaperedCapsule(x, y, lean * 0.10, 0.60, tipX, tipY, rootR, 0.012);
      if (di < d) d = di;
      const c = -di / rootR;
      if (c > core) core = c;
    }
    return { d, core: Math.max(0, Math.min(1, core)) };
  };
}

/** Radially-defined shape: 'radiusAt(theta)' in tile units. */
function radial(radiusAt: (theta: number) => number, coreBias = 1): ShapeFn {
  return (x, y) => {
    const r = Math.hypot(x, y);
    const th = Math.atan2(y, x);
    const R = radiusAt(th);
    return { d: r - R, core: Math.max(0, Math.min(1, 1 - (r / Math.max(R, 1e-4)) * coreBias)) };
  };
}

function ringLobes(count: number, ringR: number, lobeR: number, seed: number, yScale = 1): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < count; i++) {
    const th = (i / count) * Math.PI * 2 + hash2(i, seed, 3) * 0.7;
    const rr = ringR * (0.72 + hash2(i, seed, 11) * 0.5);
    out.push([Math.cos(th) * rr, Math.sin(th) * rr * yScale, lobeR * (0.7 + hash2(i, seed, 17) * 0.6)]);
  }
  return out;
}

/** Faceted polygon radius function — quantise theta into 'n' sectors. */
function polyRadius(n: number, seed: number, rMin: number, rMax: number): (t: number) => number {
  const rs: number[] = [];
  for (let i = 0; i < n; i++) rs.push(rMin + hash2(i, seed, 5) * (rMax - rMin));
  return (theta: number) => {
    const a = (theta + Math.PI) / (Math.PI * 2) * n;
    const i = Math.floor(a) % n;
    const f = a - Math.floor(a);
    return rs[i] * (1 - f) + rs[(i + 1) % n] * f;
  };
}

// --- tile definitions -------------------------------------------------------

interface TileDef {
  shape: ShapeFn;
  /** Amplitude of noise pushed into the silhouette (tile units). */
  rough: number;
  /** Frequency of that noise. */
  roughFreq: number;
  /**
   * Amplitude of a second, much lower-frequency displacement.
   *
   * High-frequency roughness only fuzzes an outline; it cannot change its
   * shape. Lobe-scale displacement is what turns a circle into a smoke
   * silhouette, so it is a separate, deliberately large term.
   */
  roughLow?: number;
  /** How fast the interior "depth" channel saturates. Smaller = wider bands. */
  depthScale: number;
  seed: number;
  /** Anisotropic pre-scale applied to the sample point. */
  sx?: number;
  sy?: number;
}

function buildTileDefs(): TileDef[] {
  const defs: TileDef[] = [];

  // --- smoke -------------------------------------------------------------
  // All four smoke silhouettes are built the same way and then deliberately
  // pulled apart from each other: different lobe counts, different notch
  // placement, different roughness seeds, and — most importantly — different
  // *overall* aspect and centre of mass, so a plume made by cycling them never
  // repeats a shape often enough for the eye to start counting stamps.
  //
  // 'roughLow' is doing most of the work. At 0.10–0.13 tile units it moves the
  // outline by a seventh of the sprite's radius over a wavelength of about a
  // third of the sprite, which is the scale at which a silhouette stops being a
  // circle and starts being smoke.

  // 0 Puff — asymmetric billow, one deep bay on the lower left.
  defs[TILE.Puff] = {
    shape: billow(
      [
        [-0.06, -0.02, 0.34], [0.24, 0.14, 0.28], [-0.28, 0.16, 0.24],
        [0.10, 0.36, 0.26], [-0.20, -0.26, 0.28], [0.28, -0.18, 0.22],
        [0.02, -0.40, 0.20], [-0.40, -0.02, 0.18],
      ],
      [[-0.34, -0.40, 0.28], [0.46, 0.40, 0.26]],
    ),
    rough: 0.048, roughFreq: 5.2, roughLow: 0.115, depthScale: 0.46, seed: 11,
  };

  // 1 Billow — taller, stacked; the column silhouette.
  defs[TILE.Billow] = {
    shape: billow(
      [
        [0, -0.42, 0.26], [0.14, -0.12, 0.32], [-0.16, 0.14, 0.32],
        [0.18, 0.38, 0.24], [-0.04, 0.60, 0.18], [-0.30, -0.16, 0.20],
        [0.30, 0.10, 0.20],
      ],
      [[0.44, -0.34, 0.28], [-0.44, 0.44, 0.26]],
    ),
    rough: 0.045, roughFreq: 4.6, roughLow: 0.105, depthScale: 0.44, seed: 23,
  };

  // 2 Wisp — torn and sparse; the noise does most of the shaping. Used for
  // the thin, fast-dissipating stuff: coolant, cordite, vapour.
  defs[TILE.Wisp] = {
    shape: billow(
      [[-0.26, 0.08, 0.38], [0.18, -0.12, 0.34], [0.04, 0.28, 0.26], [0.34, 0.20, 0.18]],
      [[0.06, -0.02, 0.20]],
    ),
    rough: 0.13, roughFreq: 5.4, roughLow: 0.13, depthScale: 0.58, seed: 41,
  };

  // 3 Streak — a tracer/spark: fat at the head (+Y), tapering to nothing.
  defs[TILE.Streak] = {
    shape: (x, y) => {
      const d = sdTaperedCapsule(x, y, 0, -0.86, 0, 0.62, 0.012, 0.17);
      return { d, core: Math.max(0, Math.min(1, -d / 0.17)) };
    },
    rough: 0.012, roughFreq: 6.0, depthScale: 0.10, seed: 7,
  };

  // 4 Star — muzzle flash. Irregular spike lengths keep it from looking like
  // a rendered gear icon; 7 points is odd so it never reads as symmetric.
  defs[TILE.Star] = {
    shape: radial((th) => {
      const n = 7;
      const spike = Math.max(0, Math.cos(n * th + 0.4));
      const jitter = 0.78 + 0.44 * hash2(Math.floor((th + Math.PI) / (Math.PI * 2) * n), 5, 2);
      return 0.20 + 0.64 * Math.pow(spike, 0.42) * jitter;
    }, 1.35),
    rough: 0.02, roughFreq: 5.0, depthScale: 0.22, seed: 3,
  };

  // 5 Cone — the flash seen from the side: a concave-sided triangle up +Y.
  defs[TILE.Cone] = {
    shape: (x, y) => {
      const h = Math.max(0, Math.min(1, (0.86 - y) / 1.58));  // 0 at apex
      const half = 0.50 * Math.pow(h, 1.5);
      const dSide = Math.abs(x) - half;
      const dEnd = Math.max(y - 0.86, -0.72 - y);
      const d = Math.max(dSide, dEnd);
      return { d, core: Math.max(0, Math.min(1, 1 - Math.abs(x) / Math.max(half, 1e-3))) };
    },
    rough: 0.03, roughFreq: 6.0, depthScale: 0.24, seed: 29,
  };

  // 6 Ring — shockwave annulus.
  defs[TILE.Ring] = {
    shape: (x, y) => {
      const r = Math.hypot(x, y);
      const d = Math.abs(r - 0.72) - 0.070;
      return { d, core: Math.max(0, Math.min(1, -d / 0.07)) };
    },
    rough: 0.018, roughFreq: 7.0, depthScale: 0.06, seed: 61,
  };

  // 7 Crescent — annulus whose thickness is weighted toward +Y, so an
  // expanding blast ring has a readable leading edge.
  defs[TILE.Crescent] = {
    shape: (x, y) => {
      const r = Math.hypot(x, y);
      const th = Math.atan2(y, x);
      const w = 0.030 + 0.075 * Math.max(0, Math.sin(th));
      const d = Math.abs(r - 0.74) - w;
      return { d, core: Math.max(0, Math.min(1, -d / w)) };
    },
    rough: 0.015, roughFreq: 6.0, depthScale: 0.06, seed: 67,
  };

  // 8 Chunk — faceted debris blob.
  defs[TILE.Chunk] = {
    shape: radial(polyRadius(7, 131, 0.50, 0.84), 1.0),
    rough: 0.012, roughFreq: 5.0, depthScale: 0.34, seed: 13,
  };

  // 9 Shard — a thin angular fragment (paint chips, skin panels).
  defs[TILE.Shard] = {
    shape: radial(polyRadius(5, 211, 0.55, 0.86), 1.0),
    rough: 0.010, roughFreq: 5.0, depthScale: 0.26, seed: 19, sx: 2.4, sy: 1.0,
  };

  // 10 Clod — several small dirt clumps in one stamp.
  defs[TILE.Clod] = {
    shape: lobes([
      [-0.30, -0.22, 0.26], [0.18, -0.30, 0.22], [0.30, 0.16, 0.28],
      [-0.14, 0.30, 0.24], [0.02, -0.02, 0.30], [-0.40, 0.24, 0.16],
    ]),
    rough: 0.10, roughFreq: 5.2, depthScale: 0.36, seed: 37,
  };

  // 11 Splash — a foaming vertical water column, ragged at the top.
  defs[TILE.Splash] = {
    shape: (x, y) => {
      const list: [number, number, number][] = [];
      for (let i = 0; i < 12; i++) {
        const t = i / 11;
        const cy = -0.82 + t * 1.55;
        const cx = (hash2(i, 71, 1) - 0.5) * 0.55 * (0.4 + t);
        const r = 0.30 * (1 - t * 0.55) * (0.7 + hash2(i, 71, 9) * 0.6);
        list.push([cx, cy, r]);
      }
      return lobes(list)(x, y);
    },
    rough: 0.11, roughFreq: 5.6, depthScale: 0.34, seed: 71,
  };

  // 12 Droplet — teardrop, heavy end at -Y.
  defs[TILE.Droplet] = {
    shape: (x, y) => {
      const d = sdTaperedCapsule(x, y, 0, -0.48, 0, 0.80, 0.30, 0.02);
      return { d, core: Math.max(0, Math.min(1, -d / 0.30)) };
    },
    rough: 0.01, roughFreq: 6.0, depthScale: 0.24, seed: 83,
  };

  // 13 Ember — a hard little disc. 'core' carries a halo the shader can use
  // to fake a hot centre without a second texture fetch.
  defs[TILE.Ember] = {
    shape: (x, y) => {
      const r = Math.hypot(x, y);
      return { d: r - 0.34, core: Math.max(0, Math.min(1, 1 - r / 0.16)) };
    },
    rough: 0.02, roughFreq: 6.0, depthScale: 0.30, seed: 97,
  };

  // 14 Twinkle — 4-point spark; the classic anime "hit" sparkle.
  defs[TILE.Twinkle] = {
    shape: radial((th) => 0.09 + 0.78 * Math.pow(Math.max(0, Math.cos(4 * th)), 1.6), 1.6),
    rough: 0.008, roughFreq: 6.0, depthScale: 0.16, seed: 103,
  };

  // 15 Lens — a squashed disc for condensation collars and heat-haze cards.
  defs[TILE.Lens] = {
    shape: (x, y) => {
      const r = Math.hypot(x, y * 2.3);
      return { d: r - 0.84, core: Math.max(0, Math.min(1, 1 - r / 0.84)) };
    },
    rough: 0.03, roughFreq: 3.2, depthScale: 0.60, seed: 109,
  };

  // 16 PuffB — leaning, with a pinched waist. Reads as two rolls that have not
  // quite merged, which is the shape a plume makes as it is shorn by airflow.
  defs[TILE.PuffB] = {
    shape: billow(
      [
        [-0.22, -0.24, 0.30], [-0.02, -0.04, 0.26], [0.16, 0.16, 0.30],
        [0.36, 0.34, 0.20], [-0.38, -0.06, 0.22], [0.02, 0.34, 0.18],
        [-0.14, -0.44, 0.20],
      ],
      [[0.40, -0.24, 0.30], [-0.36, 0.36, 0.28], [0.02, 0.08, 0.13]],
    ),
    rough: 0.055, roughFreq: 5.6, roughLow: 0.125, depthScale: 0.48, seed: 127,
  };

  // 17 PuffC — solid on one flank, shredded on the other. Emitted often enough
  // that some fraction of any plume always has a torn edge facing the wind.
  defs[TILE.PuffC] = {
    shape: billow(
      [
        [0.10, 0.02, 0.36], [0.22, -0.26, 0.26], [0.06, 0.34, 0.28],
        [-0.20, 0.10, 0.24], [-0.36, -0.14, 0.16], [-0.30, 0.34, 0.14],
        [0.34, 0.22, 0.18],
      ],
      [[-0.50, 0.02, 0.30], [0.24, 0.50, 0.24], [-0.24, -0.44, 0.26]],
    ),
    rough: 0.075, roughFreq: 6.2, roughLow: 0.12, depthScale: 0.50, seed: 149,
  };

  // 18 Flame — a three-tongue lick. Root at +Y (the stretch axis's leading
  // end, i.e. the end still attached to the cowling), tips torn off at -Y.
  defs[TILE.Flame] = {
    shape: flame([
      [0.00, -0.88, 0.26, 0],
      [-0.20, -0.52, 0.16, -0.6],
      [0.22, -0.34, 0.13, 0.7],
    ]),
    rough: 0.075, roughFreq: 6.5, roughLow: 0.055, depthScale: 0.26, seed: 157,
  };

  // 19 FlameB — a curled lick, tongues fanning the other way.
  defs[TILE.FlameB] = {
    shape: flame([
      [0.18, -0.84, 0.24, 0.5],
      [-0.26, -0.44, 0.15, -0.8],
      [0.02, -0.30, 0.12, 0.1],
    ]),
    rough: 0.085, roughFreq: 7.0, roughLow: 0.06, depthScale: 0.24, seed: 163,
  };

  // 20 Torn — a late-life remnant that is mostly holes. Emitted for the tail of
  // a plume so it visibly comes apart instead of just getting fainter.
  defs[TILE.Torn] = {
    shape: billow(
      [[-0.18, 0.10, 0.36], [0.22, -0.04, 0.32], [0.02, 0.34, 0.22], [-0.34, -0.24, 0.18]],
      [[0.02, 0.02, 0.19], [-0.34, 0.34, 0.22], [0.42, 0.28, 0.22], [0.10, -0.42, 0.20]],
    ),
    rough: 0.16, roughFreq: 6.8, roughLow: 0.135, depthScale: 0.62, seed: 173,
  };

  // 21 PuffD — wide and low, with a torn crown along the top and a flat,
  // sheared underside. The other four all have a roughly circular centre of
  // mass; this one is deliberately the odd shape out, so a plume that cycles
  // the set has a stamp in it that cannot be mistaken for any of the others
  // even after the vertex shader has mirrored and squashed them.
  defs[TILE.PuffD] = {
    shape: billow(
      [
        [-0.34, -0.08, 0.26], [-0.08, 0.02, 0.30], [0.20, -0.06, 0.28],
        [0.44, -0.14, 0.18], [0.04, 0.26, 0.22], [-0.24, 0.22, 0.18],
        [0.30, 0.18, 0.16],
      ],
      [[0.00, -0.52, 0.34], [-0.30, 0.46, 0.26], [0.34, 0.44, 0.24], [0.08, 0.06, 0.11]],
    ),
    rough: 0.065, roughFreq: 5.9, roughLow: 0.128, depthScale: 0.52, seed: 191,
  };

  return defs;
}

export function buildSpriteAtlas(): THREE.DataTexture {
  const defs = buildTileDefs();
  const data = new Uint8Array(ATLAS_PX * ATLAS_PX * 4);
  const T = ATLAS_TILE_PX;
  // Coverage gradient: ~2.6 texels from fully-out to fully-in. Steep enough
  // that the shader's fwidth AA is a genuine one-pixel edge, shallow enough
  // that age-driven erosion of the threshold reads as a shrink, not a pop.
  const K = (T / 2) / 2.6;

  for (let tile = 0; tile < ATLAS_GRID * ATLAS_GRID; tile++) {
    const def = defs[tile];
    const tx = (tile % ATLAS_GRID) * T;
    const ty = Math.floor(tile / ATLAS_GRID) * T;
    if (!def) continue;
    const sx = def.sx ?? 1, sy = def.sy ?? 1;

    for (let py = 0; py < T; py++) {
      // y increases with the texture's v axis so asymmetric tiles (cone,
      // droplet, splash) point the way the shader expects.
      const y = ((py + 0.5) / T) * 2 - 1;
      for (let px = 0; px < T; px++) {
        const x = ((px + 0.5) / T) * 2 - 1;
        const s = def.shape(x * sx, y * sy);

        const n = fbm(x * def.roughFreq + 13.7, y * def.roughFreq - 4.1, def.seed, 4);
        // Lobe-scale displacement at roughly a third of the sprite's
        // wavelength. This is what breaks the silhouette; the high-frequency
        // term above only decorates the edge it produces.
        const low = def.roughLow
          ? fbm(x * def.roughFreq * 0.30 + 3.1, y * def.roughFreq * 0.30 - 8.3, def.seed + 307, 2)
          : 0.5;
        const d = s.d + def.rough * (n - 0.5) * 2 + (def.roughLow ?? 0) * (low - 0.5) * 2;

        const cov = Math.max(0, Math.min(1, 0.5 - d * K));
        const depth = Math.max(0, Math.min(1, -d / def.depthScale));
        const detail = fbm(x * 6.5 + 100, y * 6.5 - 50, def.seed + 5, 4);

        const o = ((ty + py) * ATLAS_PX + (tx + px)) * 4;
        data[o] = Math.round(s.core * 255);
        data[o + 1] = Math.round(depth * 255);
        data[o + 2] = Math.round(Math.max(0, Math.min(1, detail)) * 255);
        data[o + 3] = Math.round(cov * 255);
      }
    }
  }

  const tex = new THREE.DataTexture(data, ATLAS_PX, ATLAS_PX, THREE.RGBAFormat);
  tex.name = 'vfx.spriteAtlas';
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;   // masks, not colour
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Colour ramps
// ---------------------------------------------------------------------------

export const RAMP = {
  FireCore: 0,
  Fireball: 1,
  FireStream: 2,
  Ember: 3,
  SparkHot: 4,
  MuzzleFlash: 5,
  FlashWhite: 6,
  SmokeBlack: 7,
  SmokeGrey: 8,
  SmokeWhite: 9,
  SmokeOil: 10,
  SmokeColumn: 11,
  DustBrown: 12,
  DustGrey: 13,
  DirtClod: 14,
  WaterFoam: 15,
  WaterBody: 16,
  Contrail: 17,
  Vortex: 18,
  FuelMist: 19,
  PaintChip: 20,
  Ricochet: 21,
  ShockRing: 22,
  DustRing: 23,
  SmokePot: 24,
  Rain: 25,
  Cordite: 26,
  Secondary: 27,
  Condensation: 28,
  Brass: 29,
  Haze: 30,
  Snow: 31,
} as const;
export type RampId = (typeof RAMP)[keyof typeof RAMP];

export const RAMP_COUNT = 32;
export const RAMP_STEPS = 128;

/** [t, 0xRRGGBB, alpha]. Sampled piecewise-constant → hard bands by design. */
type Stop = [number, number, number];

const RAMP_TABLE: Record<number, Stop[]> = {
  // Blast core: three value steps of white-hot, then it is simply gone.
  [RAMP.FireCore]: [
    [0.00, 0xffffff, 1.0], [0.18, 0xfff8dc, 1.0], [0.36, 0xffe08a, 0.98],
    [0.56, 0xffab35, 0.85], [0.78, 0xd6431a, 0.45], [0.94, 0x50170a, 0.0],
  ],
  // The rolling fireball: yellow -> orange -> red -> brown -> dark smoke.
  // The red band is deliberately short and quickly transparent. A fireball that
  // stays saturated red for half its life reads as a balloon: in reality the
  // luminous phase is brief and the smoke takes over almost immediately.
  [RAMP.Fireball]: [
    [0.00, 0xfff0b0, 0.95], [0.13, 0xffbc42, 1.0], [0.28, 0xf4711d, 0.96],
    [0.44, 0xb8481c, 0.62], [0.58, 0x6b3320, 0.34], [0.72, 0x3a2a22, 0.14],
    [0.84, 0x241d19, 0.0],
  ],
  // Streaming fire off a burning engine.
  //
  // Re-cut so the *red* band is short. A flame lick that spends half its life
  // saturated orange-red is what produced the "melted plastic" read: a dozen
  // overlapping stamps all sitting in the same red band average into one opaque
  // mass with no internal structure. In a real engine fire the luminous part is
  // white-yellow and brief, and it goes to dirty smoke almost immediately —
  // which is also what gives the flame its stepped, graphic silhouette, because
  // adjacent stamps of different age are in visibly different bands.
  [RAMP.FireStream]: [
    [0.00, 0xfffbe8, 0.95], [0.10, 0xffe07a, 1.0], [0.24, 0xffb02c, 1.0],
    [0.42, 0xf4661a, 0.85], [0.58, 0x9c3411, 0.48], [0.72, 0x4a2115, 0.20],
    [0.86, 0x241a15, 0.0],
  ],
  [RAMP.Ember]: [
    [0.00, 0xffd07a, 1.0], [0.28, 0xff8a2a, 1.0], [0.58, 0xe0480f, 0.9],
    [0.82, 0x74200a, 0.5], [0.96, 0x2a1008, 0.0],
  ],
  [RAMP.SparkHot]: [
    [0.00, 0xffffff, 1.0], [0.22, 0xfff0b8, 1.0], [0.48, 0xffb148, 1.0],
    [0.74, 0xe4581c, 0.75], [0.92, 0x6d1c08, 0.0],
  ],
  [RAMP.MuzzleFlash]: [
    [0.00, 0xffffff, 1.0], [0.25, 0xfff4c8, 1.0], [0.50, 0xffcd5e, 0.95],
    [0.72, 0xff8b25, 0.6], [0.90, 0xa63d10, 0.0],
  ],
  [RAMP.FlashWhite]: [
    [0.00, 0xffffff, 1.0], [0.42, 0xf2f7ff, 0.9], [0.72, 0xc9dcf0, 0.45],
    [0.92, 0x8fb0cc, 0.0],
  ],

  // Even "black" smoke on a bright day sits around 25-30% value, and it has to
  // hold three readable steps or the cel banding has nothing to bite on. Fully
  // black smoke reads as a hole cut in the frame.
  //
  // The alpha schedule is the *dissipation* curve, and it is deliberately
  // front-loaded: a puff holds full opacity for barely a fifth of its life and
  // is under half by the midpoint. A plume whose stamps stay opaque until they
  // vanish reads as a solid rope; one that thins from the moment it leaves the
  // aircraft reads as a gas entraining air, which is what it is.
  // Values pulled down about a stop from where they started. The shading model
  // multiplies the sunlit band by better than 2x, so a ramp authored at "what
  // smoke looks like" ends up as beige cauliflower; authored a stop dark, the
  // sunlit rim lands where smoke actually sits and the shadow side goes to the
  // near-black an oil fire really is.
  // Alpha holds near-opaque for the first third and only then falls away.
  //
  // Transparency is the wrong tool for dissipation here and it was being asked
  // to do the whole job: at 0.6 alpha a stamp lets the bright sky through, and
  // a plume only two or three layers deep — which is what it is anywhere near
  // the aircraft — washes out to pale lavender instead of reading as oily
  // black. The break-up is the *erosion* dissolve's job (it eats coverage, so
  // the silhouette stays hard while the shape comes apart); alpha only handles
  // the very end of a puff's life.
  // Neutral, very slightly cool. Burning oil and rubber make near-neutral
  // smoke; a warm-brown ramp lit by a warm sun comes out the colour of dust,
  // and a dust plume behind a fighter reads as a bug.
  /*
   * The three damage stages are one *value ladder*, and it has to be readable
   * at a glance from a kilometre away: white coolant, grey oil, black fuel.
   * That only works if the ladder survives the shading model, which multiplies
   * the sunlit band by nearly 2x and the shadow band by about 0.35x — so each
   * ramp is authored at the value its *shadow* side should sit at, roughly a
   * stop and a half below "what smoke looks like", and the sun does the rest.
   * Authored at face value, black fuel smoke came back as mid lavender-grey and
   * the whole escalation stopped carrying any information at all.
   *
   * The alpha column is the dissipation curve and it is the other half of the
   * fix. A stamp that holds 0.9 alpha until it disappears makes a plume read as
   * a solid rope of identical beads with no far end; entraining air is a
   * continuous process, so opacity has to be falling from the moment the puff
   * leaves the aircraft. Half gone by the midpoint of its life, a fifth left at
   * three-quarters. The vertex shader's expansion thinning multiplies this
   * again by how far the individual stamp has actually grown, so the small
   * tight ones at the head of a column stay dense while the ballooned ones
   * downstream go to haze.
   *
   * Value also *rises* with age on the two dark ramps. Fresh soot is the
   * densest and blackest thing in the plume; as it disperses it mixes with lit
   * air and greys out. Driving it the other way — darker as it thins — is what
   * made the tail of the column vanish instead of dissolving.
   */
  [RAMP.SmokeBlack]: [
    [0.00, 0x3d3e46, 1.00], [0.15, 0x42434c, 0.94], [0.31, 0x494a54, 0.78],
    [0.47, 0x52535e, 0.56], [0.63, 0x5c5e69, 0.34], [0.78, 0x666875, 0.16],
    [0.90, 0x6e7180, 0.05], [0.97, 0x757888, 0.0],
  ],
  [RAMP.SmokeGrey]: [
    [0.00, 0x706b64, 0.96], [0.18, 0x78736c, 0.90], [0.35, 0x827d76, 0.74],
    [0.52, 0x8c8780, 0.53], [0.68, 0x96918a, 0.32], [0.82, 0x9e9993, 0.15],
    [0.92, 0xa5a09a, 0.05], [0.97, 0xa9a49e, 0.0],
  ],
  // Coolant/steam: bright and cool, and it dies fast — a holed radiator throws
  // a thin white plume that is gone within a couple of fuselage lengths.
  // Authored well below white so the 2x sunlit band lands *at* white rather
  // than clipping through it, which is what turns steam into a paper cut-out.
  [RAMP.SmokeWhite]: [
    [0.00, 0xb8c2ce, 0.80], [0.16, 0xb2bdca, 0.66], [0.34, 0xabb7c5, 0.48],
    [0.52, 0xa3b0c0, 0.31], [0.70, 0x9aa8ba, 0.17], [0.86, 0x91a0b4, 0.06],
    [0.95, 0x8c9caf, 0.0],
  ],
  // Burning oil: greasy brown-black. Sits between coolant and fuel on the
  // ladder and carries the only warm hue in the set, which is how you tell oil
  // from fuel at range even when both are silhouetted.
  [RAMP.SmokeOil]: [
    [0.00, 0x585040, 0.98], [0.17, 0x5e5646, 0.92], [0.34, 0x67604f, 0.76],
    [0.50, 0x706959, 0.55], [0.66, 0x787263, 0.33], [0.80, 0x807a6c, 0.16],
    [0.91, 0x878174, 0.05], [0.97, 0x8b857a, 0.0],
  ],
  [RAMP.SmokeColumn]: [
    [0.00, 0x6f6a62, 0.95], [0.20, 0x565149, 0.93], [0.44, 0x413d37, 0.85],
    [0.68, 0x302d2a, 0.64], [0.86, 0x252321, 0.30], [0.96, 0x1d1c1b, 0.0],
  ],

  [RAMP.DustBrown]: [
    [0.00, 0xe6c894, 0.85], [0.22, 0xc8a878, 0.86], [0.48, 0xa98a5e, 0.70],
    [0.72, 0x8a7050, 0.42], [0.92, 0x6b573e, 0.0],
  ],
  [RAMP.DustGrey]: [
    [0.00, 0xe4dfd2, 0.82], [0.24, 0xc4bfb2, 0.82], [0.50, 0xa29d92, 0.64],
    [0.74, 0x817d74, 0.38], [0.92, 0x63605a, 0.0],
  ],
  [RAMP.DirtClod]: [
    [0.00, 0x7a6549, 1.0], [0.45, 0x5e4d38, 1.0], [0.80, 0x453828, 0.85],
    [0.96, 0x2f261b, 0.0],
  ],
  [RAMP.WaterFoam]: [
    [0.00, 0xffffff, 0.92], [0.20, 0xeaf5fa, 0.90], [0.44, 0xd0e6f0, 0.76],
    [0.68, 0xa9cbdd, 0.48], [0.88, 0x7fa9c0, 0.0],
  ],
  [RAMP.WaterBody]: [
    [0.00, 0xa8cfe0, 0.85], [0.28, 0x7ea9be, 0.85], [0.58, 0x5b8398, 0.62],
    [0.84, 0x3f6274, 0.0],
  ],

  // Contrails and vortices are almost pure value — colour comes from the sky.
  [RAMP.Contrail]: [
    [0.00, 0xffffff, 0.0], [0.06, 0xfdfeff, 0.72], [0.30, 0xf2f7fb, 0.80],
    [0.60, 0xe4eef6, 0.60], [0.84, 0xd2e0ec, 0.26], [0.97, 0xc3d4e4, 0.0],
  ],
  [RAMP.Vortex]: [
    [0.00, 0xffffff, 0.0], [0.10, 0xf6fbff, 0.52], [0.36, 0xe8f2fa, 0.46],
    [0.64, 0xd6e6f2, 0.28], [0.88, 0xc2d6e8, 0.0],
  ],
  [RAMP.FuelMist]: [
    [0.00, 0xe8ecdf, 0.34], [0.30, 0xd2d8c6, 0.30], [0.62, 0xb8c0ac, 0.18],
    [0.88, 0x9aa390, 0.0],
  ],
  [RAMP.PaintChip]: [
    [0.00, 0xd9dde0, 1.0], [0.50, 0xaeb3b7, 1.0], [0.84, 0x83888c, 0.8],
    [0.97, 0x5c6165, 0.0],
  ],
  [RAMP.Ricochet]: [
    [0.00, 0xffffff, 1.0], [0.20, 0xffe9b0, 1.0], [0.52, 0xffa63c, 0.9],
    [0.80, 0xc0450f, 0.4], [0.95, 0x4a1605, 0.0],
  ],
  [RAMP.ShockRing]: [
    [0.00, 0xffffff, 0.0], [0.08, 0xffffff, 0.95], [0.30, 0xeaf3fb, 0.75],
    [0.58, 0xc9dcec, 0.45], [0.82, 0xa6c1d8, 0.18], [0.96, 0x8fadc6, 0.0],
  ],
  [RAMP.DustRing]: [
    [0.00, 0xd8c49c, 0.0], [0.08, 0xd8c49c, 0.72], [0.36, 0xbda680, 0.60],
    [0.66, 0x9c8767, 0.34], [0.90, 0x7d6b52, 0.0],
  ],
  // Airfield marker pot — deliberately saturated so it reads as signal smoke.
  [RAMP.SmokePot]: [
    [0.00, 0xffb459, 0.85], [0.24, 0xe07a2a, 0.88], [0.52, 0xb4551f, 0.72],
    [0.78, 0x7a3a17, 0.40], [0.94, 0x4a2410, 0.0],
  ],
  [RAMP.Rain]: [
    [0.00, 0xdfeaf2, 0.55], [0.60, 0xc6d8e4, 0.45], [0.95, 0xaec4d4, 0.0],
  ],
  // Cordite: the pale grey-blue puff that hangs at a muzzle.
  [RAMP.Cordite]: [
    [0.00, 0xd8d4c8, 0.62], [0.26, 0xbcb8ac, 0.56], [0.54, 0x9c988e, 0.40],
    [0.80, 0x7c796f, 0.18], [0.94, 0x62605a, 0.0],
  ],
  // Fuel-dump secondary: deeper, redder, longer.
  [RAMP.Secondary]: [
    [0.00, 0xfff2c0, 0.9], [0.10, 0xffa22e, 1.0], [0.26, 0xe8611f, 0.96],
    [0.44, 0xa4441a, 0.66], [0.60, 0x5e3220, 0.38], [0.76, 0x2e2019, 0.15],
    [0.88, 0x1d1917, 0.0],
  ],
  [RAMP.Condensation]: [
    [0.00, 0xffffff, 0.0], [0.10, 0xf8fcff, 0.55], [0.42, 0xe9f2fa, 0.42],
    [0.74, 0xd4e4f0, 0.20], [0.94, 0xbcd2e4, 0.0],
  ],
  [RAMP.Brass]: [
    [0.00, 0xf5dc95, 1.0], [0.40, 0xd2b263, 1.0], [0.75, 0xa88a45, 1.0],
    [0.96, 0x7c6532, 0.0],
  ],
  [RAMP.Haze]: [
    [0.00, 0xffe8c8, 0.0], [0.12, 0xffe0b4, 0.30], [0.50, 0xffd0a0, 0.20],
    [0.86, 0xffc890, 0.0],
  ],
  [RAMP.Snow]: [
    [0.00, 0xffffff, 0.8], [0.70, 0xeaf2f8, 0.6], [0.96, 0xd4e2ee, 0.0],
  ],
};

const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

export function buildRampAtlas(): THREE.DataTexture {
  const W = RAMP_STEPS, H = RAMP_COUNT;
  const data = new Float32Array(W * H * 4);

  for (let row = 0; row < H; row++) {
    const stops = RAMP_TABLE[row];
    for (let i = 0; i < W; i++) {
      const t = i / (W - 1);
      const o = (row * W + i) * 4;
      if (!stops || stops.length === 0) {
        data[o] = 1; data[o + 1] = 0; data[o + 2] = 1; data[o + 3] = 0;
        continue;
      }
      // Piecewise-constant: hold the last stop whose t is <= x. That is what
      // makes every ramp a hard band sequence rather than a gradient.
      let s = stops[0];
      for (let k = 0; k < stops.length; k++) if (stops[k][0] <= t) s = stops[k];
      const hex = s[1];
      data[o] = srgbToLinear(((hex >> 16) & 0xff) / 255);
      data[o + 1] = srgbToLinear(((hex >> 8) & 0xff) / 255);
      data[o + 2] = srgbToLinear((hex & 0xff) / 255);
      data[o + 3] = s[2];
    }
  }

  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  tex.name = 'vfx.rampAtlas';
  tex.magFilter = THREE.NearestFilter;   // never smear the bands
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;   // already linear
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Tiling noise, used by the canopy rain overlay and the heat-haze cards
// ---------------------------------------------------------------------------

export function buildNoiseTexture(size = 256, seed = 1234): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // Periodic fbm: blend four shifted copies so the texture tiles cleanly.
      const f = (fx: number, fy: number) => fbm(fx * 8, fy * 8, seed, 4);
      const n =
        f(u, v) * (1 - u) * (1 - v) + f(u - 1, v) * u * (1 - v) +
        f(u, v - 1) * (1 - u) * v + f(u - 1, v - 1) * u * v;
      const o = (y * size + x) * 4;
      data[o] = Math.round(Math.max(0, Math.min(1, n)) * 255);
      data[o + 1] = Math.round(hash2(x, y, seed + 3) * 255);
      data[o + 2] = Math.round(Math.max(0, Math.min(1, fbm(u * 24, v * 24, seed + 9, 3))) * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.name = 'vfx.noise';
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
