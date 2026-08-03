/**
 * The authoritative terrain heightfield.
 *
 * DELIBERATELY FREE OF three.js — the headless authoritative server imports
 * this module to answer ground-collision, spawn and AI queries, and it must
 * stay identical to what the client renders.
 *
 * Strategy
 * --------
 * The field is *baked* once at load time into a single Float32 array of
 * 2049x2049 posts over the 65.536 km map (32 m post spacing). The GPU samples
 * exactly the same array as an R32F texture with hand-written bilinear
 * interpolation ('texelFetch' x4), so the rendered surface and 'heightAt()'
 * agree to float32 precision. That is the only way to guarantee "the wheels
 * touch where the grass is drawn" without duplicating a noise function in GLSL
 * and praying the two stay in sync.
 *
 * Bake pipeline:
 *   1. Analytic macro geography on a 513x513 coarse grid (128 m posts):
 *      continent/coast field, a mountain spine, foothill skirt, plains,
 *      offshore islands, sea floor.
 *   2. Droplet hydraulic erosion on that coarse grid — this is what turns
 *      "noise" into *geography*: v-shaped valleys, alluvial fans, ridgelines
 *      that actually branch, and a flow-accumulation map we reuse for rivers,
 *      moisture and vegetation density.
 *   3. Airfield site selection (flattest suitable land per team) and runway
 *      heading choice.
 *   4. Separable Catmull-Rom upsample of the coarse grid to 2049x2049, plus
 *      three octaves of detail noise amplitude-modulated by local ruggedness,
 *      river carving from the flow map, and exact airfield pad flattening.
 *   5. A 513x513 RGBA mask (moisture / river / rock / macro-variation) used by
 *      the terrain shader for biome blending and by vegetation scattering.
 *   6. A min/max quadtree pyramid for GPU-free frustum + vertical culling.
 */

import { clamp, lerp, smoothstep, Rng } from '../shared/math';

// ---------------------------------------------------------------------------
// Map constants — shared with the renderer and the server
// ---------------------------------------------------------------------------

/** Playable extent, metres. Power of two so LOD maths stays exact. */
export const MAP_SIZE = 65536;
export const MAP_HALF = MAP_SIZE / 2;
export const SEA_LEVEL = 0;

/** Baked heightfield: cells across the map. 2048 cells -> 32 m posts. */
export const BAKE_RES = 2048;
export const BAKE_N = BAKE_RES + 1;
export const BAKE_STEP = MAP_SIZE / BAKE_RES;

/** Coarse geography / erosion grid: 128 m posts. */
export const COARSE_RES = 512;
export const COARSE_N = COARSE_RES + 1;
export const COARSE_STEP = MAP_SIZE / COARSE_RES;

/** Biome mask grid — same lattice as the coarse grid. */
export const MASK_N = COARSE_N;
export const MASK_STEP = COARSE_STEP;

/** Quadtree: leaf node covers 512 m (16 baked cells). 8 levels to the root. */
export const LEAF_SIZE = 512;
export const LOD_LEVELS = 8; // 512, 1024, ... 65536

export type TerrainType = 'water' | 'sand' | 'grass' | 'rock' | 'snow' | 'runway';

// Biome thresholds — the terrain shader mirrors these exactly (see
// terrainMaterial.ts, 'TERRAIN_BIOME_GLSL'). Change both or neither.
export const BIOME = {
  /** Sand reaches this high above the waterline on gentle ground. */
  beachTop: 9,
  beachFade: 6,
  /** Snow line, modulated by a noise band of +/- snowJitter metres. */
  snowLine: 1480,
  snowFade: 320,
  /** Above this slope (|dh/dx| as sin of the angle) rock takes over. */
  rockSlope: 0.50,
  rockFade: 0.18,
} as const;

// ---------------------------------------------------------------------------
// Noise — integer-lattice value noise. Kept simple and allocation-free.
// ---------------------------------------------------------------------------

/**
 * 32-bit integer hash. All intermediate products stay below 2^53 for the
 * coordinate ranges we use, so float64 evaluates them exactly and the '|0'
 * wrap is well defined and portable.
 */
function hashi(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** Value noise in [0,1] with quintic (C2) interpolation. */
export function vnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const a = hashi(xi, yi, seed);
  const b = hashi(xi + 1, yi, seed);
  const c = hashi(xi, yi + 1, seed);
  const d = hashi(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

// Fixed irrational rotation applied between octaves. Without it every octave
// shares the same lattice axes and the result shows obvious grid streaking.
const R_C = Math.cos(0.7853981), R_S = Math.sin(0.7853981);

/** Fractal Brownian motion in [0,1]. */
export function fbm(x: number, y: number, seed: number, octaves: number, gain = 0.5, lac = 2.017): number {
  let amp = 1, sum = 0, norm = 0, px = x, py = y;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(px, py, seed + o * 131) * amp;
    norm += amp;
    amp *= gain;
    const rx = px * R_C - py * R_S;
    const ry = px * R_S + py * R_C;
    px = rx * lac; py = ry * lac;
  }
  return sum / norm;
}

/**
 * Ridged multifractal in [0,1]. '1 - |2n-1|' folds the noise about its mean,
 * which produces creases; squaring sharpens them into ridgelines. Each octave
 * is weighted by the previous one so ridges only spawn detail on ridges, which
 * is what makes real mountain ranges look hierarchical rather than uniformly
 * crumpled.
 */
export function ridgedFbm(x: number, y: number, seed: number, octaves: number, gain = 0.52, lac = 2.031): number {
  let amp = 1, sum = 0, norm = 0, px = x, py = y, prev = 1;
  for (let o = 0; o < octaves; o++) {
    let n = vnoise(px, py, seed + o * 977);
    n = 1 - Math.abs(n * 2 - 1);
    n *= n;
    n *= prev;
    prev = clamp(n * 1.4, 0, 1);
    sum += n * amp;
    norm += amp;
    amp *= gain;
    const rx = px * R_C - py * R_S;
    const ry = px * R_S + py * R_C;
    px = rx * lac; py = ry * lac;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
// Airfields
// ---------------------------------------------------------------------------

export interface AirfieldSite {
  team: number;
  /** Pad centre in world XZ. */
  x: number;
  z: number;
  /** Exact (flat) elevation of every paved surface. */
  elevation: number;
  /** Runway axis heading: world direction (sin, cos) of "along the strip". */
  heading: number;
  runwayLength: number;
  runwayWidth: number;
  /** Flattened pad half-extents: along the strip / across it. */
  padHalfL: number;
  padHalfW: number;
  /** Magnetic-ish runway designator pair, e.g. 9 and 27 (tens of degrees). */
  designator: number;
  name: string;
}

const _cos = (a: number) => Math.cos(a);
const _sin = (a: number) => Math.sin(a);

/** World XZ -> airfield-local (along, across). */
export function airfieldLocal(site: AirfieldSite, x: number, z: number, out: { a: number; b: number }): void {
  const dx = x - site.x, dz = z - site.z;
  const c = _cos(site.heading), s = _sin(site.heading);
  // heading is the direction of the runway centreline: (sin, cos) in (x, z).
  out.a = dx * s + dz * c;
  out.b = dx * c - dz * s;
}

// ---------------------------------------------------------------------------
// Heightfield
// ---------------------------------------------------------------------------

const _loc = { a: 0, b: 0 };

export class Heightfield {
  readonly seed: number;

  /** Baked posts, row-major, BAKE_N x BAKE_N, metres. */
  readonly height: Float32Array;
  /** Biome masks at MASK_N x MASK_N, RGBA8: moisture, river, rock, macro. */
  readonly masks: Uint8Array;
  /** Flow accumulation (0..1) on the coarse grid — drives rivers + moisture. */
  readonly flow: Float32Array;

  /** Per-LOD min/max pyramid; index 0 = leaf (512 m nodes). */
  readonly nodeMinMax: Float32Array[] = [];
  readonly nodeCounts: number[] = [];

  readonly airfields: AirfieldSite[] = [];

  /** Highest point on the map — used to size the shadow/atmosphere volumes. */
  maxHeight = 0;
  minHeight = 0;

  constructor(seed: number) {
    this.seed = seed >>> 0 || 1;
    const t0 = now();

    const coarse = this.buildCoarse();
    this.flow = new Float32Array(COARSE_N * COARSE_N);
    this.erode(coarse);
    this.computeDrainage(coarse, this.flow);

    this.placeAirfields(coarse);

    this.height = new Float32Array(BAKE_N * BAKE_N);
    this.bake(coarse);

    this.masks = new Uint8Array(MASK_N * MASK_N * 4);
    this.buildMasks(coarse);

    this.buildPyramid();

    if (typeof console !== 'undefined' && typeof performance !== 'undefined') {
      // eslint-disable-next-line no-console
      console.info(`[world] heightfield seed=${this.seed} baked in ${(now() - t0).toFixed(0)} ms ` +
        `(${this.minHeight.toFixed(0)}..${this.maxHeight.toFixed(0)} m)`);
    }
  }

  // -- stage 1: analytic macro geography ------------------------------------

  /**
   * The pre-erosion landscape. Everything here is smooth, large-scale and
   * *intentional*: a coastline running roughly NE-SW, a mountain spine inland
   * from it with a foothill skirt, plains between foothills and beach, a
   * shelving sea floor, and a handful of offshore islands.
   */
  private buildCoarse(): Float32Array {
    const rng = new Rng(this.seed ^ 0x9e3779b9);
    const s = this.seed;

    // Seeded orientation so two maps do not look like the same island rotated.
    const coastAng = rng.range(0, Math.PI * 2);
    const cCos = Math.cos(coastAng), cSin = Math.sin(coastAng);
    const spineAng = coastAng + rng.range(-0.30, 0.30);
    const sCos = Math.cos(spineAng), sSin = Math.sin(spineAng);
    /** Where the mean waterline sits along the seaward axis, metres. */
    const coastPos = rng.range(-5000, 5000);
    /** How far inland the alpine spine runs, metres. */
    const spineInland = rng.range(17000, 21000);
    /** Secondary range beyond the main one — gives the horizon layered depth. */
    const backInland = spineInland + rng.range(8000, 11000);
    const peakH = rng.range(2450, 3050);
    this._coastAng = coastAng;
    this._coastPos = coastPos;
    /** c units per metre of inland distance: c = 1 at ~13 km inland. */
    const C_PER_M = 1 / 13000;

    // Offshore island cluster, laid out in coast-aligned coordinates so they
    // sit in open water rather than being buried in the headland.
    const islands: { x: number; z: number; r: number; h: number }[] = [];
    const nIsl = 5 + rng.int(4);
    for (let i = 0; i < nIsl; i++) {
      const along = rng.range(-27000, 27000);
      const off = coastPos + rng.range(3500, 16000);
      islands.push({
        x: cCos * along + cSin * off,
        z: -cSin * along + cCos * off,
        r: rng.range(600, 2400),
        h: rng.range(55, 260),
      });
    }
    this._islands = islands;

    const g = new Float32Array(COARSE_N * COARSE_N);
    for (let j = 0; j < COARSE_N; j++) {
      const z = -MAP_HALF + j * COARSE_STEP;
      for (let i = 0; i < COARSE_N; i++) {
        const x = -MAP_HALF + i * COARSE_STEP;

        // --- continent field -------------------------------------------------
        // 'axis' runs seaward. c is a dimensionless "inlandness": 0 at the mean
        // waterline, 1 about 13 km inland. Three noise octaves push the
        // waterline back and forth by ~7 km / ~2 km / ~0.6 km, which is what
        // gives bays, headlands and a fractal shore instead of a smooth arc.
        const axis = x * cSin + z * cCos;
        let c = (coastPos - axis) * C_PER_M;
        c += (fbm(x * 0.0000205, z * 0.0000205, s + 11, 5) * 2 - 1) * 0.54;
        c += (fbm(x * 0.000088, z * 0.000088, s + 23, 4) * 2 - 1) * 0.17;
        c += (fbm(x * 0.00033, z * 0.00033, s + 37, 3) * 2 - 1) * 0.05;

        // Force open ocean around the border so the playable island is framed
        // by sea on every side and the map edge never shows a cliff.
        const e = Math.max(Math.abs(x), Math.abs(z)) / MAP_HALF;
        c -= 3.0 * smoothstep(0.80, 0.995, e);

        // --- land profile ----------------------------------------------------
        // Distance from the mountain spine, with a low-frequency wobble so the
        // range meanders instead of being a ruler-straight wall.
        const along = x * sCos - z * sSin;
        const across = x * sSin + z * sCos;
        const wobble = (fbm(along * 0.000048, 0.0, s + 71, 3) * 2 - 1) * 4200
          + (fbm(along * 0.00017, 11.5, s + 73, 2) * 2 - 1) * 1250;
        const spineAcross = coastPos - spineInland;
        const d = Math.abs(across - spineAcross - wobble);
        const dBack = Math.abs(across - (coastPos - backInland) - wobble * 0.6);

        // Tight alpine core (~2.5 km either side) with a foothill skirt out to
        // ~11 km. Anything wider and the range stops reading as a range: from
        // the air you want to see plain -> foothills -> peaks -> back slope in
        // a single glance.
        const alpine = Math.pow(smoothstep(5200, 1100, d), 1.20);
        const backRidge = Math.pow(smoothstep(4200, 1100, dBack), 1.2);
        const foot = smoothstep(11500, 2600, d) * (1 - alpine * 0.62);

        // Seven octaves of ridged noise on the alpine term: the finest lands
        // at ~220 m, which is what puts actual aretes and couloirs on the
        // peaks instead of the smooth meringue a 4-octave field produces.
        const ridge = ridgedFbm(x * 0.000072, z * 0.000072, s + 101, 7);
        const ridge2 = ridgedFbm(x * 0.00023, z * 0.00023, s + 103, 5);
        const rolling = fbm(x * 0.00013, z * 0.00013, s + 131, 5);
        // Four plains scales. Countryside seen from 500 m has to have relief at
        // every scale from 10 km down to 200 m or it reads as painted lino.
        const swell = fbm(x * 0.000034, z * 0.000034, s + 151, 3);   // ~29 km
        const hills = fbm(x * 0.00019, z * 0.00019, s + 157, 3);     // ~5 km
        const downs = fbm(x * 0.00075, z * 0.00075, s + 163, 3);     // ~1.3 km
        const knolls = fbm(x * 0.0022, z * 0.0022, s + 167, 2);      // ~450 m

        let land =
          alpine * peakH * (0.20 + 0.94 * ridge) * (0.62 + 0.52 * ridge2) +
          backRidge * peakH * 0.34 * (0.28 + 0.84 * ridge) +
          foot * 600 * (0.16 + 1.05 * rolling) +
          (8 + 108 * swell + 96 * hills + 58 * downs + 26 * knolls) * (1 - alpine * 0.85);

        // Coastal plain: flatten and drop toward the waterline so beaches are
        // gentle and the shoreline reads as a beach, not a cliff everywhere.
        const shore = smoothstep(0.0, 0.26, c);
        land *= 0.06 + 0.94 * shore;

        // --- sea floor --------------------------------------------------------
        // Shelf then a drop-off. Keeps shallow turquoise water hugging the coast.
        const deep = smoothstep(0.0, -0.55, c);
        const floor = -14 - 90 * deep - 330 * deep * deep + (fbm(x * 0.00013, z * 0.00013, s + 191, 3) * 2 - 1) * 20;

        // Single continuous blend between sea floor and land profile. 'land'
        // already tapers to ~0 as c -> 0 (the 'shore' factor), so the join is
        // smooth and the waterline lands wherever the two curves cross.
        const landness = smoothstep(-0.05, 0.09, c);
        let h = lerp(floor, land, landness);

        // --- offshore islands --------------------------------------------------
        for (let k = 0; k < islands.length; k++) {
          const isl = islands[k];
          const dx = x - isl.x, dz = z - isl.z;
          const r = Math.sqrt(dx * dx + dz * dz) / isl.r;
          if (r < 2.4) {
            const bump = Math.exp(-r * r * 1.15);
            const wob = 0.7 + 0.6 * fbm(x * 0.0009, z * 0.0009, s + 211 + k, 3);
            h += bump * isl.h * wob;
          }
        }

        g[j * COARSE_N + i] = h;
      }
    }
    return g;
  }

  private _islands: { x: number; z: number; r: number; h: number }[] = [];
  private _coastAng = 0;
  private _coastPos = 0;

  /** Offshore island centres — used to scatter rocks and a lighthouse prop. */
  get islands(): readonly { x: number; z: number; r: number; h: number }[] { return this._islands; }

  // -- stage 2: droplet hydraulic erosion -----------------------------------

  /**
   * Cheap particle-based hydraulic erosion (Musgrave-style droplets). Each
   * droplet carries 'water' and 'sediment', accelerates downhill, picks up
   * material where it is steep and fast, and drops it where it flattens out.
   * ~70k droplets over the coarse grid is enough to cut believable dendritic
   * valleys and build alluvial fans at range mouths in well under a second.
   *
   * The droplets shape the land; the *river network* is derived afterwards by
   * a proper flow accumulation (see computeDrainage) — random-walk visit
   * counts are far too diffuse to read as rivers.
   */
  private erode(g: Float32Array): void {
    const n = COARSE_N;
    const rng = new Rng(this.seed ^ 0x51ed270b);

    // Deposition brush (radius 2, gaussian-ish) so droplets do not carve
    // single-cell spikes.
    const R = 2;
    const bOff: number[] = [];
    const bW: number[] = [];
    let wSum = 0;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > R * R + 0.5) continue;
        const w = 1 - Math.sqrt(d2) / (R + 1);
        bOff.push(dy * n + dx); bW.push(w); wSum += w;
      }
    }
    for (let k = 0; k < bW.length; k++) bW[k] /= wSum;

    const DROPS = 72000;
    const STEPS = 52;
    const INERTIA = 0.06;
    const CAPACITY = 3.6;
    const MIN_SLOPE = 0.012;
    const ERODE = 0.32;
    const DEPOSIT = 0.30;
    const EVAP = 0.022;
    const GRAVITY = 5.0;

    for (let d = 0; d < DROPS; d++) {
      let px = rng.range(R + 1, n - R - 2);
      let pz = rng.range(R + 1, n - R - 2);
      let dirX = 0, dirZ = 0;
      let speed = 1, water = 1, sediment = 0;

      for (let step = 0; step < STEPS; step++) {
        const ix = px | 0, iz = pz | 0;
        const fx = px - ix, fz = pz - iz;
        const i00 = iz * n + ix;
        const h00 = g[i00], h10 = g[i00 + 1], h01 = g[i00 + n], h11 = g[i00 + n + 1];
        const gx = (h10 - h00) * (1 - fz) + (h11 - h01) * fz;
        const gz = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;
        const h = (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;

        dirX = dirX * INERTIA - gx * (1 - INERTIA);
        dirZ = dirZ * INERTIA - gz * (1 - INERTIA);
        const dl = Math.hypot(dirX, dirZ);
        if (dl < 1e-6) break;
        dirX /= dl; dirZ /= dl;

        const nx = px + dirX, nz = pz + dirZ;
        if (nx < R + 1 || nx >= n - R - 2 || nz < R + 1 || nz >= n - R - 2) break;

        const jx = nx | 0, jz = nz | 0;
        const gfx = nx - jx, gfz = nz - jz;
        const j00 = jz * n + jx;
        const nh =
          (g[j00] * (1 - gfx) + g[j00 + 1] * gfx) * (1 - gfz) +
          (g[j00 + n] * (1 - gfx) + g[j00 + n + 1] * gfx) * gfz;

        const dh = nh - h;
        const capacity = Math.max(-dh, MIN_SLOPE) * speed * water * CAPACITY;

        if (sediment > capacity || dh > 0) {
          // Uphill: fill the pit we just walked into (this is what removes
          // most local minima and lets rivers keep going). Otherwise settle
          // the excess load.
          const drop = dh > 0 ? Math.min(dh, sediment) : (sediment - capacity) * DEPOSIT;
          sediment -= drop;
          // Bilinear deposit at the *current* cell keeps deposition smooth.
          g[i00] += drop * (1 - fx) * (1 - fz);
          g[i00 + 1] += drop * fx * (1 - fz);
          g[i00 + n] += drop * (1 - fx) * fz;
          g[i00 + n + 1] += drop * fx * fz;
        } else {
          const take = Math.min((capacity - sediment) * ERODE, -dh);
          sediment += take;
          for (let k = 0; k < bOff.length; k++) g[i00 + bOff[k]] -= take * bW[k];
        }

        speed = Math.sqrt(Math.max(0, speed * speed + -dh * GRAVITY));
        water *= 1 - EVAP;

        px = nx; pz = nz;
      }
    }
  }

  /**
   * Priority-flood depression fill. Returns a copy of 'src' in which every
   * closed basin has been raised to its spill elevation plus a monotone
   * epsilon gradient, so a downhill path exists from every land cell to the
   * sea. O(n log n) with a binary heap.
   */
  private fillDepressions(src: Float32Array): Float32Array {
    const n = COARSE_N;
    const total = n * n;
    const out = new Float32Array(src);
    const seen = new Uint8Array(total);

    // Binary min-heap over (key, cell).
    const hKey = new Float32Array(total + 1);
    const hIdx = new Uint32Array(total + 1);
    let hn = 0;
    const push = (key: number, idx: number): void => {
      let i = ++hn;
      hKey[i] = key; hIdx[i] = idx;
      while (i > 1) {
        const p = i >> 1;
        if (hKey[p] <= hKey[i]) break;
        const tk = hKey[p], ti = hIdx[p];
        hKey[p] = hKey[i]; hIdx[p] = hIdx[i];
        hKey[i] = tk; hIdx[i] = ti;
        i = p;
      }
    };
    const pop = (): number => {
      const top = hIdx[1];
      hKey[1] = hKey[hn]; hIdx[1] = hIdx[hn]; hn--;
      let i = 1;
      for (;;) {
        const l = i << 1, r = l + 1;
        let m = i;
        if (l <= hn && hKey[l] < hKey[m]) m = l;
        if (r <= hn && hKey[r] < hKey[m]) m = r;
        if (m === i) break;
        const tk = hKey[m], ti = hIdx[m];
        hKey[m] = hKey[i]; hIdx[m] = hIdx[i];
        hKey[i] = tk; hIdx[i] = ti;
        i = m;
      }
      return top;
    };

    // Seeds: the map border and everything already at or below sea level —
    // the ocean is the ultimate outlet.
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const c = j * n + i;
        if (i === 0 || j === 0 || i === n - 1 || j === n - 1 || src[c] <= SEA_LEVEL) {
          if (!seen[c]) { seen[c] = 1; push(out[c], c); }
        }
      }
    }

    const EPS = 0.004; // metres of forced gradient per cell across a filled lake
    while (hn > 0) {
      const c = hIdx[1];
      const k = hKey[1];
      pop();
      const i = c % n, j = (c / n) | 0;
      for (let d = 0; d < 4; d++) {
        const ni = i + (d === 0 ? 1 : d === 1 ? -1 : 0);
        const nj = j + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (ni < 0 || ni >= n || nj < 0 || nj >= n) continue;
        const nc = nj * n + ni;
        if (seen[nc]) continue;
        seen[nc] = 1;
        const h = Math.max(out[nc], k + EPS);
        out[nc] = h;
        push(h, nc);
      }
    }
    return out;
  }

  /**
   * D8 flow accumulation — the actual river network.
   *
   * Every cell starts with one unit of rainfall. Processing cells from the
   * highest down, each pushes its whole accumulated catchment into its
   * steepest downhill neighbour. Because the traversal is height-ordered, a
   * cell is always fully charged before it drains, so one pass is exact.
   * The resulting field is heavy-tailed (a trunk river carries 10^5 units
   * while a hillside carries 1), so it is log-compressed before use.
   *
   * This is what gives dendritic, tree-shaped drainage instead of the smeared
   * blob a random-walk visit count produces.
   */
  private computeDrainage(gRaw: Float32Array, flow: Float32Array): void {
    const n = COARSE_N;
    const total = n * n;

    // Droplet erosion leaves the field peppered with one-cell pits. D8 routing
    // terminates in every one of them, which shatters the catchment tree, so
    // route on a *depression-filled* copy (priority flood, Barnes 2014): grow
    // inward from the ocean and the map border, raising each newly reached
    // cell to at least the spill height it was reached at. The rendered
    // terrain keeps its pits — only the routing sees the filled field.
    const g = this.fillDepressions(gRaw);

    // Exact height ordering. This has to be *exact*: a bucketed approximation
    // lets a lowland channel cell drain before its upstream neighbour has
    // donated, which silently truncates every catchment. Two-pass 16-bit LSD
    // radix sort over a monotone integer re-encoding of the float32 bits —
    // O(n), no comparator, and exact.
    const bits = new Uint32Array(g.buffer, g.byteOffset, total);
    const key = new Uint32Array(total);
    for (let i = 0; i < total; i++) {
      const b = bits[i];
      // Flip: negatives reverse, positives get the sign bit set. Result orders
      // identically to the float value as an unsigned integer.
      key[i] = (b & 0x80000000) !== 0 ? (~b >>> 0) : ((b | 0x80000000) >>> 0);
    }
    const asc = radixSortIndices(key, total);
    const order = new Uint32Array(total);
    for (let i = 0; i < total; i++) order[i] = asc[total - 1 - i];

    const acc = new Float32Array(total);
    acc.fill(1);

    const OX = [1, -1, 0, 0, 1, 1, -1, -1];
    const OZ = [0, 0, 1, -1, 1, -1, 1, -1];
    const INV_D = [1, 1, 1, 1, Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2];

    for (let k = 0; k < total; k++) {
      const c = order[k];
      const h = g[c];
      if (h <= SEA_LEVEL) continue; // reached the sea, stop routing
      const i = c % n, j = (c / n) | 0;
      let bestSlope = 0, bestIdx = -1;
      for (let d = 0; d < 8; d++) {
        const ni = i + OX[d], nj = j + OZ[d];
        if (ni < 0 || ni >= n || nj < 0 || nj >= n) continue;
        const nIdx = nj * n + ni;
        const s = (h - g[nIdx]) * INV_D[d];
        if (s > bestSlope) { bestSlope = s; bestIdx = nIdx; }
      }
      if (bestIdx >= 0) acc[bestIdx] += acc[c];
    }

    // Log-compress and normalise so the trunk river is exactly 1.0. Drainage
    // is heavy-tailed; a linear normalisation would leave everything but the
    // main stem at zero.
    let maxAcc = 1;
    for (let i = 0; i < total; i++) if (acc[i] > maxAcc) maxAcc = acc[i];
    const invLog = 1 / Math.log(maxAcc);
    for (let i = 0; i < total; i++) flow[i] = Math.min(1, Math.log(acc[i]) * invLog);

    // One light 3x3 blur: the D8 network is exactly one cell wide, which
    // aliases badly once it is bilinearly sampled at 32 m. A single blur turns
    // it into a channel with banks without dissolving the tree structure.
    const tmp = new Float32Array(total);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const i0 = j * n + i;
        let sum = flow[i0] * 4, w = 4;
        if (i > 0) { sum += flow[i0 - 1] * 2; w += 2; }
        if (i < n - 1) { sum += flow[i0 + 1] * 2; w += 2; }
        if (j > 0) { sum += flow[i0 - n] * 2; w += 2; }
        if (j < n - 1) { sum += flow[i0 + n] * 2; w += 2; }
        // Diagonals at low weight keep 45-degree reaches from thinning out.
        if (i > 0 && j > 0) { sum += flow[i0 - n - 1]; w += 1; }
        if (i < n - 1 && j > 0) { sum += flow[i0 - n + 1]; w += 1; }
        if (i > 0 && j < n - 1) { sum += flow[i0 + n - 1]; w += 1; }
        if (i < n - 1 && j < n - 1) { sum += flow[i0 + n + 1]; w += 1; }
        tmp[i0] = sum / w;
      }
    }
    flow.set(tmp);
  }

  // -- stage 3: airfield siting ---------------------------------------------

  private coarseAt(g: Float32Array, i: number, j: number): number {
    const ci = i < 0 ? 0 : i > COARSE_RES ? COARSE_RES : i;
    const cj = j < 0 ? 0 : j > COARSE_RES ? COARSE_RES : j;
    return g[cj * COARSE_N + ci];
  }

  /**
   * Picks the two team airfields. Requirements, in priority order: it must be
   * land well clear of the waterline, as flat as possible over the whole pad,
   * low altitude (fields were not built at 1500 m), and the two must end up on
   * opposite sides of the map roughly 24-34 km apart so the match has a
   * meaningful transit.
   */
  private placeAirfields(g: Float32Array): void {
    const rng = new Rng(this.seed ^ 0x2545f491);
    const PAD_L = 1500, PAD_W = 480;

    // Both fields belong on the coastal plain, at opposite ends of it: the
    // match then runs *along* the coast with the sea on one flank and the
    // range on the other, which is the classic WWII map read. The anchors are
    // therefore offset along the coast tangent, not along a random axis.
    const ca = this._coastAng + rng.range(-0.28, 0.28);
    const tanX = Math.cos(ca), tanZ = -Math.sin(ca);   // along the coastline
    const inX = -Math.sin(ca), inZ = -Math.cos(ca);    // inland (away from sea)
    const inlandOff = this._coastPos * -1 + 7500;
    const armLen = 19000;
    const anchors = [
      { x: tanX * armLen + inX * inlandOff, z: tanZ * armLen + inZ * inlandOff },
      { x: -tanX * armLen + inX * inlandOff, z: -tanZ * armLen + inZ * inlandOff },
    ];

    for (let team = 0; team < 2; team++) {
      const anchor = anchors[team];
      const other = this.airfields[0];
      let best: { x: number; z: number; score: number; h: number; heading: number } | null = null;

      // Spiral search over candidate centres.
      for (let ring = 0; ring < 14; ring++) {
        const radius = ring * 1700;
        const steps = ring === 0 ? 1 : 8 + ring * 3;
        for (let a = 0; a < steps; a++) {
          const ang = (a / steps) * Math.PI * 2 + ring * 0.61;
          const cx = anchor.x + Math.cos(ang) * radius;
          const cz = anchor.z + Math.sin(ang) * radius;
          if (Math.abs(cx) > MAP_HALF - 6000 || Math.abs(cz) > MAP_HALF - 6000) continue;
          // Keep the two fields a real transit apart.
          if (other && Math.hypot(cx - other.x, cz - other.z) < 20000) continue;

          // Sample the pad footprint on the coarse grid.
          const ci = Math.round((cx + MAP_HALF) / COARSE_STEP);
          const cj = Math.round((cz + MAP_HALF) / COARSE_STEP);
          const rad = Math.ceil(PAD_L / COARSE_STEP);
          let sum = 0, cnt = 0, mn = 1e9, mx = -1e9, wet = 0;
          for (let j = -rad; j <= rad; j++) {
            for (let i = -rad; i <= rad; i++) {
              const h = this.coarseAt(g, ci + i, cj + j);
              sum += h; cnt++;
              if (h < mn) mn = h;
              if (h > mx) mx = h;
              if (h < 6) wet++;
            }
          }
          const mean = sum / cnt;
          if (wet > 0) continue;                      // no shorelines under the pad
          if (mean < 18 || mean > 320) continue;      // sensible altitude band
          const relief = mx - mn;
          if (relief > 190) continue;

          // Prefer flat, prefer low, prefer close to the anchor.
          const score = relief * 1.0 + mean * 0.22 + radius * 0.004;
          if (!best || score < best.score) {
            best = { x: cx, z: cz, score, h: mean, heading: 0 };
          }
        }
        if (best && ring > 5) break; // good enough — stop widening
      }

      // Fallback: if the terrain refuses to cooperate, plant it at the anchor
      // and let the pad flattening do the work.
      if (!best) {
        const h = Math.max(24, this.sampleCoarse(g, anchor.x, anchor.z));
        best = { x: anchor.x, z: anchor.z, score: 0, h, heading: 0 };
      }

      // Choose the heading that minimises the height change *along* the strip,
      // which is what a real siting survey optimises for.
      let bestHead = 0, bestVar = Infinity;
      for (let k = 0; k < 12; k++) {
        const head = (k / 12) * Math.PI;
        const sh = Math.sin(head), ch = Math.cos(head);
        let v = 0;
        for (let t = -1; t <= 1; t += 0.1) {
          const px = best.x + sh * t * PAD_L;
          const pz = best.z + ch * t * PAD_L;
          const h = this.sampleCoarse(g, px, pz);
          v += Math.abs(h - best.h);
        }
        if (v < bestVar) { bestVar = v; bestHead = head; }
      }

      // Runway designator: heading in degrees / 10, rounded, 01..36.
      const degs = ((bestHead * 180) / Math.PI + 360) % 360;
      let desig = Math.round(degs / 10);
      if (desig === 0) desig = 36;

      this.airfields.push({
        team,
        x: best.x,
        z: best.z,
        elevation: Math.round(best.h),
        heading: bestHead,
        runwayLength: 1300,
        runwayWidth: 46,
        padHalfL: PAD_L * 0.5 + 240,
        padHalfW: PAD_W,
        designator: desig,
        name: team === 0 ? 'RAF Hartwell' : 'Feldflugplatz Norden',
      });
    }
  }

  private sampleCoarse(g: Float32Array, x: number, z: number): number {
    const t = (x + MAP_HALF) / COARSE_STEP;
    const u = (z + MAP_HALF) / COARSE_STEP;
    const i = clamp(Math.floor(t), 0, COARSE_RES - 1);
    const j = clamp(Math.floor(u), 0, COARSE_RES - 1);
    const fx = clamp(t - i, 0, 1), fz = clamp(u - j, 0, 1);
    const i0 = j * COARSE_N + i;
    return (g[i0] * (1 - fx) + g[i0 + 1] * fx) * (1 - fz) +
      (g[i0 + COARSE_N] * (1 - fx) + g[i0 + COARSE_N + 1] * fx) * fz;
  }

  // -- stage 4: bake --------------------------------------------------------

  /** Catmull-Rom weights for a fractional position. */
  private static crWeights(f: number, out: Float32Array): void {
    const f2 = f * f, f3 = f2 * f;
    out[0] = -0.5 * f3 + f2 - 0.5 * f;
    out[1] = 1.5 * f3 - 2.5 * f2 + 1;
    out[2] = -1.5 * f3 + 2 * f2 + 0.5 * f;
    out[3] = 0.5 * f3 - 0.5 * f2;
  }

  /**
   * Upsample the eroded coarse grid to the 32 m bake grid and add detail.
   *
   * The upsample is separable Catmull-Rom (C1, and it passes *through* the
   * coarse samples, unlike a B-spline) so no interpolation creases survive
   * into the shading normals. Since the bake grid is exactly 4x the coarse
   * grid, only four distinct fractional offsets exist and their weights are
   * precomputed — the whole 4.2 M-post upsample is then 8 multiplies per post.
   */
  private bake(g: Float32Array): void {
    const RATIO = BAKE_RES / COARSE_RES; // 4
    // RATIO+1 weight sets: fractions 0, 1/4, 1/2, 3/4 and the exact endpoint,
    // so the very last post of a row/column lands on the coarse sample itself.
    const w = new Float32Array(4 * (RATIO + 1));
    const tmpW = new Float32Array(4);
    for (let f = 0; f <= RATIO; f++) {
      Heightfield.crWeights(f / RATIO, tmpW);
      w[f * 4] = tmpW[0]; w[f * 4 + 1] = tmpW[1]; w[f * 4 + 2] = tmpW[2]; w[f * 4 + 3] = tmpW[3];
    }

    // Pass 1: horizontal upsample into rows of BAKE_N at coarse row spacing.
    const rows = new Float32Array(COARSE_N * BAKE_N);
    for (let j = 0; j < COARSE_N; j++) {
      const src = j * COARSE_N;
      const dst = j * BAKE_N;
      for (let bi = 0; bi < BAKE_N; bi++) {
        const ci = Math.min(COARSE_RES - 1, bi >> 2);
        const o = (bi - ci * RATIO) * 4;
        const a = src + ci;
        const p0 = g[Math.max(src, a - 1)];
        const p1 = g[a];
        const p2 = g[Math.min(src + COARSE_RES, a + 1)];
        const p3 = g[Math.min(src + COARSE_RES, a + 2)];
        rows[dst + bi] = p0 * w[o] + p1 * w[o + 1] + p2 * w[o + 2] + p3 * w[o + 3];
      }
    }

    // Pass 2: vertical upsample + detail + rivers + airfield pads.
    const s = this.seed;
    const H = this.height;
    let mn = 1e9, mx = -1e9;
    const sites = this.airfields;

    for (let bj = 0; bj < BAKE_N; bj++) {
      const cj = Math.min(COARSE_RES - 1, bj >> 2);
      const o = (bj - cj * RATIO) * 4;
      const r0 = Math.max(0, cj - 1) * BAKE_N;
      const r1 = cj * BAKE_N;
      const r2 = Math.min(COARSE_RES, cj + 1) * BAKE_N;
      const r3 = Math.min(COARSE_RES, cj + 2) * BAKE_N;
      const w0 = w[o], w1 = w[o + 1], w2 = w[o + 2], w3 = w[o + 3];
      const z = -MAP_HALF + bj * BAKE_STEP;
      const dstRow = bj * BAKE_N;

      for (let bi = 0; bi < BAKE_N; bi++) {
        const x = -MAP_HALF + bi * BAKE_STEP;
        let h = rows[r0 + bi] * w0 + rows[r1 + bi] * w1 + rows[r2 + bi] * w2 + rows[r3 + bi] * w3;

        // --- detail -----------------------------------------------------------
        // Amplitude follows local relief: plains stay plain, mountainsides get
        // scree and gullies. Everything near the waterline is damped so beaches
        // do not turn into a chopped mess.
        // Relief-proportional detail. The floor of 4.5 m matters as much as the
        // ceiling: without it, farmland reads as a billiard table from 300 m.
        // Frequencies are capped so the finest feature stays around 70 m —
        // twice the 32 m post spacing, i.e. safely above Nyquist.
        const relief = clamp((h - 30) / 700, 0, 1);
        const amp = 4.5 + 26.0 * relief * relief;
        if (h > -30) {
          const d1 = fbm(x * 0.0035, z * 0.0035, s + 401, 3, 0.5, 2.09) * 2 - 1;
          const d2 = ridgedFbm(x * 0.0016, z * 0.0016, s + 407, 3) - 0.4;
          const shore = smoothstep(0, 26, h);
          h += (d1 * 0.85 + d2 * 1.15) * amp * shore;
        }

        // --- river carving ----------------------------------------------------
        // Cut a channel proportional to log-drainage. Two-stage: a broad,
        // shallow valley from the whole catchment, then a narrow deep channel
        // for the trunk. Near the coast the channel is pushed below sea level
        // so the ocean surface floods it — that is what produces a real river
        // mouth, an estuary and a tidal reach you can fly a torpedo run up.
        const fl = this.sampleFlow(x, z);
        if (fl > 0.26 && h > -8) {
          const valley = smoothstep(0.26, 0.48, fl);
          const trunk = smoothstep(0.44, 0.64, fl);
          h -= valley * 15 + trunk * 24;
          if (trunk > 0.05) {
            // Lowland reaches flood; upland reaches stay dry gorges.
            const tidal = smoothstep(60, 8, h) * trunk;
            h = lerp(h, Math.min(h, -3.5 - 4 * trunk), tidal);
          }
        }

        // --- airfield pads ------------------------------------------------------
        for (let k = 0; k < sites.length; k++) {
          const site = sites[k];
          const dx = x - site.x, dz = z - site.z;
          if (dx * dx + dz * dz > 9.0e6) continue; // 3 km reject radius
          airfieldLocal(site, x, z, _loc);
          const t = Math.max(Math.abs(_loc.a) / site.padHalfL, Math.abs(_loc.b) / site.padHalfW);
          if (t < 1.9) {
            const blend = 1 - smoothstep(1.0, 1.9, t);
            h = lerp(h, site.elevation, blend);
          }
        }

        if (h < mn) mn = h;
        if (h > mx) mx = h;
        H[dstRow + bi] = h;
      }
    }
    this.minHeight = mn;
    this.maxHeight = mx;
  }

  /** Bilinear sample of the drainage map in world space. */
  sampleFlow(x: number, z: number): number {
    const t = clamp((x + MAP_HALF) / COARSE_STEP, 0, COARSE_RES);
    const u = clamp((z + MAP_HALF) / COARSE_STEP, 0, COARSE_RES);
    const i = Math.min(COARSE_RES - 1, t | 0);
    const j = Math.min(COARSE_RES - 1, u | 0);
    const fx = t - i, fz = u - j;
    const i0 = j * COARSE_N + i;
    const f = this.flow;
    return (f[i0] * (1 - fx) + f[i0 + 1] * fx) * (1 - fz) +
      (f[i0 + COARSE_N] * (1 - fx) + f[i0 + COARSE_N + 1] * fx) * fz;
  }

  // -- stage 5: biome masks -------------------------------------------------

  /**
   * Masks consumed by the terrain shader and the vegetation scatterer:
   *   R moisture   — drainage + altitude + rain-shadow noise
   *   G river      — carved-channel strength (wet mud / water edges)
   *   B rock       — bare-rock exposure (steepness + altitude + noise)
   *   A macro      — large-scale biome variation (forest patches vs farmland)
   */
  private buildMasks(_g: Float32Array): void {
    const s = this.seed;
    const m = this.masks;
    for (let j = 0; j < MASK_N; j++) {
      const z = -MAP_HALF + j * MASK_STEP;
      for (let i = 0; i < MASK_N; i++) {
        const x = -MAP_HALF + i * MASK_STEP;
        const h = this.heightAt(x, z);
        const slope = this.slopeAt(x, z);
        const fl = this.sampleFlow(x, z);

        // Rain shadow: the seaward flank of the range is wet, the lee is dry.
        const rain = fbm(x * 0.000031, z * 0.000031, s + 601, 4);
        let moisture = 0.30 + 0.55 * fl + 0.42 * rain - clamp((h - 300) / 1400, 0, 1) * 0.55;
        moisture -= clamp(slope - 0.35, 0, 1) * 0.35;
        moisture = clamp(moisture, 0, 1);

        const river = clamp((fl - 0.30) / 0.26, 0, 1);

        let rock = smoothstep(BIOME.rockSlope - BIOME.rockFade, BIOME.rockSlope + BIOME.rockFade, slope);
        rock = Math.max(rock, smoothstep(700, 1400, h) * 0.7);
        rock *= 0.55 + 0.7 * fbm(x * 0.00042, z * 0.00042, s + 631, 3);
        rock = clamp(rock, 0, 1);

        const macro = fbm(x * 0.000067, z * 0.000067, s + 661, 4);

        const o = (j * MASK_N + i) * 4;
        m[o] = (moisture * 255) | 0;
        m[o + 1] = (river * 255) | 0;
        m[o + 2] = (rock * 255) | 0;
        m[o + 3] = (macro * 255) | 0;
      }
    }
  }

  // -- stage 6: quadtree min/max pyramid ------------------------------------

  private buildPyramid(): void {
    // Level 0 = LEAF_SIZE (512 m) nodes -> 128 x 128 over the map.
    const cellsPerLeaf = LEAF_SIZE / BAKE_STEP; // 16
    let count = MAP_SIZE / LEAF_SIZE;           // 128
    const l0 = new Float32Array(count * count * 2);
    const H = this.height;
    for (let j = 0; j < count; j++) {
      for (let i = 0; i < count; i++) {
        let mn = 1e9, mx = -1e9;
        const i0 = i * cellsPerLeaf, j0 = j * cellsPerLeaf;
        for (let b = 0; b <= cellsPerLeaf; b++) {
          const row = (j0 + b) * BAKE_N;
          for (let a = 0; a <= cellsPerLeaf; a++) {
            const h = H[row + i0 + a];
            if (h < mn) mn = h;
            if (h > mx) mx = h;
          }
        }
        const o = (j * count + i) * 2;
        l0[o] = mn; l0[o + 1] = mx;
      }
    }
    this.nodeMinMax.push(l0);
    this.nodeCounts.push(count);

    for (let lvl = 1; lvl < LOD_LEVELS; lvl++) {
      const prev = this.nodeMinMax[lvl - 1];
      const pc = this.nodeCounts[lvl - 1];
      const c = pc >> 1;
      const arr = new Float32Array(Math.max(1, c * c) * 2);
      for (let j = 0; j < c; j++) {
        for (let i = 0; i < c; i++) {
          let mn = 1e9, mx = -1e9;
          for (let b = 0; b < 2; b++) {
            for (let a = 0; a < 2; a++) {
              const o = ((j * 2 + b) * pc + (i * 2 + a)) * 2;
              if (prev[o] < mn) mn = prev[o];
              if (prev[o + 1] > mx) mx = prev[o + 1];
            }
          }
          const o = (j * c + i) * 2;
          arr[o] = mn; arr[o + 1] = mx;
        }
      }
      this.nodeMinMax.push(arr);
      this.nodeCounts.push(Math.max(1, c));
      if (c <= 1) break;
    }
  }

  // -- post-bake site flattening --------------------------------------------
  //
  // The factory and the rail yard are dead-flat slabs (190 x 130 m of apron, a
  // 44 x 220 m ballast bed and 218 m rails) sited by a test that only samples
  // eight points at 90 m and tolerates +/-9 m. Their corners are well outside
  // that radius, so on real ground the slab ends up metres in the air at one
  // corner and buried at the other, and the rails run through a hillside like a
  // girder. Rather than tightening the test until no site qualifies, do what a
  // civil engineer does and level the ground: the installations declare their
  // footprint and the baked field is graded to suit, exactly the way the
  // airfield pads are graded inside bake().
  //
  // The masks and the drainage map are deliberately left alone — a 200 m
  // platform does not change where the rain goes, and the terrain shader's
  // biome blend over a levelled site still wants the surrounding moisture.

  private sites: { x: number; z: number; halfA: number; halfB: number; sin: number; cos: number; y: number }[] = [];
  private pyramidDirty = false;

  /**
   * Grades a rotated rectangle of the baked field to a single elevation, with a
   * feathered skirt out to 'feather' times the half-extents. Returns the chosen
   * elevation so the caller can plant its geometry on it.
   */
  flattenSite(x: number, z: number, halfA: number, halfB: number, yaw: number, feather = 2.1): number {
    // The heightfield is a per-seed singleton, so a second WorldSystem.init
    // (hot reload, map restart) would otherwise grade the same site twice and
    // walk the platform elevation downhill each time.
    for (let k = 0; k < this.sites.length; k++) {
      const p = this.sites[k];
      if (Math.abs(p.x - x) < 1 && Math.abs(p.z - z) < 1 && Math.abs(p.halfA - halfA) < 1) return p.y;
    }
    const s = Math.sin(yaw), c = Math.cos(yaw);
    const reach = Math.hypot(halfA, halfB) * feather + BAKE_STEP * 2;
    const i0 = Math.max(0, Math.floor((x - reach + MAP_HALF) / BAKE_STEP));
    const i1 = Math.min(BAKE_RES, Math.ceil((x + reach + MAP_HALF) / BAKE_STEP));
    const j0 = Math.max(0, Math.floor((z - reach + MAP_HALF) / BAKE_STEP));
    const j1 = Math.min(BAKE_RES, Math.ceil((z + reach + MAP_HALF) / BAKE_STEP));

    // Pass 1: the platform elevation is the mean over the footprint itself.
    let sum = 0, cnt = 0;
    for (let j = j0; j <= j1; j++) {
      const pz = -MAP_HALF + j * BAKE_STEP;
      for (let i = i0; i <= i1; i++) {
        const px = -MAP_HALF + i * BAKE_STEP;
        const dx = px - x, dz = pz - z;
        const a = dx * s + dz * c, b = dx * c - dz * s;
        if (Math.abs(a) > halfA || Math.abs(b) > halfB) continue;
        sum += this.height[j * BAKE_N + i]; cnt++;
      }
    }
    const elev = cnt > 0 ? sum / cnt : this.heightAt(x, z);

    // Pass 2: level the footprint, then ramp back to natural ground.
    for (let j = j0; j <= j1; j++) {
      const pz = -MAP_HALF + j * BAKE_STEP;
      for (let i = i0; i <= i1; i++) {
        const px = -MAP_HALF + i * BAKE_STEP;
        const dx = px - x, dz = pz - z;
        const a = dx * s + dz * c, b = dx * c - dz * s;
        const t = Math.max(Math.abs(a) / halfA, Math.abs(b) / halfB);
        if (t >= feather) continue;
        const blend = 1 - smoothstep(1.0, feather, t);
        const o = j * BAKE_N + i;
        this.height[o] = lerp(this.height[o], elev, blend);
      }
    }

    this.sites.push({ x, z, halfA, halfB, sin: s, cos: c, y: elev });
    this.pyramidDirty = true;
    return elev;
  }

  /**
   * Normalised distance to the nearest graded installation footprint, in the
   * same units as padT(): 0 at the centre, 1 at the edge, >1 outside. Used to
   * keep vegetation and scatter props off the factory floor.
   */
  siteT(x: number, z: number): number {
    let best = Infinity;
    for (let k = 0; k < this.sites.length; k++) {
      const s = this.sites[k];
      const dx = x - s.x, dz = z - s.z;
      const a = dx * s.sin + dz * s.cos, b = dx * s.cos - dz * s.sin;
      const t = Math.max(Math.abs(a) / s.halfA, Math.abs(b) / s.halfB);
      if (t < best) best = t;
    }
    return best;
  }

  /**
   * Recomputes the culling pyramid and refreshes min/max after any grading.
   * Must be called once all installations have been sited and before the first
   * frame — a stale pyramid culls nodes whose real geometry now pokes out of
   * their recorded bounds.
   */
  commitSites(): boolean {
    if (!this.pyramidDirty) return false;
    this.pyramidDirty = false;
    let mn = 1e9, mx = -1e9;
    for (let i = 0; i < this.height.length; i++) {
      const h = this.height[i];
      if (h < mn) mn = h;
      if (h > mx) mx = h;
    }
    this.minHeight = mn;
    this.maxHeight = mx;
    this.nodeMinMax.length = 0;
    this.nodeCounts.length = 0;
    this.buildPyramid();
    return true;
  }

  /** min/max of the node at (i,j) on 'level' (0 = leaf). */
  nodeBounds(level: number, i: number, j: number, out: { min: number; max: number }): void {
    const lvl = clamp(level, 0, this.nodeMinMax.length - 1) | 0;
    const c = this.nodeCounts[lvl];
    const ii = clamp(i, 0, c - 1) | 0;
    const jj = clamp(j, 0, c - 1) | 0;
    const o = (jj * c + ii) * 2;
    out.min = this.nodeMinMax[lvl][o];
    out.max = this.nodeMinMax[lvl][o + 1];
  }

  // -- queries --------------------------------------------------------------

  /**
   * Exact terrain height. Bilinear over the baked posts — bit-for-bit the same
   * reconstruction the vertex shader performs, so physics and pixels agree.
   */
  heightAt(x: number, z: number): number {
    const t = (x + MAP_HALF) / BAKE_STEP;
    const u = (z + MAP_HALF) / BAKE_STEP;
    const tc = t < 0 ? 0 : t > BAKE_RES ? BAKE_RES : t;
    const uc = u < 0 ? 0 : u > BAKE_RES ? BAKE_RES : u;
    let i = tc | 0, j = uc | 0;
    if (i >= BAKE_RES) i = BAKE_RES - 1;
    if (j >= BAKE_RES) j = BAKE_RES - 1;
    const fx = tc - i, fz = uc - j;
    const H = this.height;
    const i0 = j * BAKE_N + i;
    const h0 = H[i0] + (H[i0 + 1] - H[i0]) * fx;
    const h1 = H[i0 + BAKE_N] + (H[i0 + BAKE_N + 1] - H[i0 + BAKE_N]) * fx;
    return h0 + (h1 - h0) * fz;
  }

  /**
   * Surface normal by central differences. 'eps' matches the post spacing, so
   * the normal is the analytic normal of the *rendered* bilinear surface
   * filtered over one cell — smooth enough for the camera and stable enough
   * for wheel contact.
   */
  normalAt(x: number, z: number, out: { x: number; y: number; z: number }): void {
    const e = BAKE_STEP;
    const hl = this.heightAt(x - e, z), hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e), hu = this.heightAt(x, z + e);
    const nx = hl - hr;
    const nz = hd - hu;
    const ny = 2 * e;
    const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
    out.x = nx * inv; out.y = ny * inv; out.z = nz * inv;
  }

  /** sin of the terrain inclination (0 flat, 1 vertical). */
  slopeAt(x: number, z: number): number {
    const e = BAKE_STEP;
    const hl = this.heightAt(x - e, z), hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e), hu = this.heightAt(x, z + e);
    const gx = (hr - hl) / (2 * e);
    const gz = (hu - hd) / (2 * e);
    const g = Math.sqrt(gx * gx + gz * gz);
    return g / Math.sqrt(1 + g * g);
  }

  /** Bilinear mask fetch; 'ch' 0..3 = moisture, river, rock, macro. Returns 0..1. */
  maskAt(x: number, z: number, ch: number): number {
    const t = clamp((x + MAP_HALF) / MASK_STEP, 0, MASK_N - 1);
    const u = clamp((z + MAP_HALF) / MASK_STEP, 0, MASK_N - 1);
    const i = Math.min(MASK_N - 2, t | 0);
    const j = Math.min(MASK_N - 2, u | 0);
    const fx = t - i, fz = u - j;
    const m = this.masks;
    const a = m[((j) * MASK_N + i) * 4 + ch];
    const b = m[((j) * MASK_N + i + 1) * 4 + ch];
    const c = m[((j + 1) * MASK_N + i) * 4 + ch];
    const d = m[((j + 1) * MASK_N + i + 1) * 4 + ch];
    return ((a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz) / 255;
  }

  /**
   * Normalised distance to the nearest airfield pad: 0 at the centre, 1 at the
   * edge of the flattened rectangle, >1 outside. Vegetation and prop scatter
   * use it to keep the aerodrome clear — a runway with a forest growing out of
   * it is the single most immersion-breaking thing a procedural world can do.
   */
  padT(x: number, z: number): number {
    let best = Infinity;
    for (let k = 0; k < this.airfields.length; k++) {
      const s = this.airfields[k];
      const dx = x - s.x, dz = z - s.z;
      if (dx * dx + dz * dz > 9.0e6) continue;
      airfieldLocal(s, x, z, _loc);
      const t = Math.max(Math.abs(_loc.a) / s.padHalfL, Math.abs(_loc.b) / s.padHalfW);
      if (t < best) best = t;
    }
    return best;
  }

  /** Is this point on airfield pavement? */
  isPaved(x: number, z: number): boolean {
    for (let k = 0; k < this.airfields.length; k++) {
      const s = this.airfields[k];
      const dx = x - s.x, dz = z - s.z;
      if (dx * dx + dz * dz > 4.0e6) continue;
      airfieldLocal(s, x, z, _loc);
      const a = Math.abs(_loc.a), b = Math.abs(_loc.b);
      // Runway strip.
      if (a < s.runwayLength * 0.5 + 40 && b < s.runwayWidth * 0.5 + 4) return true;
      // Parallel taxiway + apron block on the north side.
      if (a < s.runwayLength * 0.5 && _loc.b > 92 && _loc.b < 128) return true;
      if (a > -s.runwayLength * 0.35 && a < s.runwayLength * 0.10 && _loc.b > 128 && _loc.b < 240) return true;
    }
    return false;
  }

  /** Classification used by physics (friction/effects) and the AI. */
  typeAt(x: number, z: number): TerrainType {
    if (this.isPaved(x, z)) return 'runway';
    const h = this.heightAt(x, z);
    if (h <= SEA_LEVEL) return 'water';
    const slope = this.slopeAt(x, z);
    if (slope > BIOME.rockSlope) return 'rock';
    if (h < BIOME.beachTop) return 'sand';
    const snowJitter = (fbm(x * 0.00035, z * 0.00035, this.seed + 811, 3) * 2 - 1) * 150;
    if (h > BIOME.snowLine + snowJitter) return 'snow';
    if (h > 950 && slope > 0.35) return 'rock';
    return 'grass';
  }
}

/** LSD radix sort (2 x 16 bit) returning indices ordered by ascending key. */
function radixSortIndices(key: Uint32Array, n: number): Uint32Array {
  let src = new Uint32Array(n);
  for (let i = 0; i < n; i++) src[i] = i;
  let dst = new Uint32Array(n);
  const count = new Uint32Array(65536);
  for (let pass = 0; pass < 2; pass++) {
    const shift = pass * 16;
    count.fill(0);
    for (let i = 0; i < n; i++) count[(key[src[i]] >>> shift) & 0xffff]++;
    let run = 0;
    for (let b = 0; b < 65536; b++) { const c = count[b]; count[b] = run; run += c; }
    for (let i = 0; i < n; i++) dst[count[(key[src[i]] >>> shift) & 0xffff]++] = src[i];
    const t = src; src = dst; dst = t;
  }
  return src;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// ---------------------------------------------------------------------------
// Per-seed singleton — client and server both go through this so the field is
// built exactly once per process.
// ---------------------------------------------------------------------------

let cached: Heightfield | null = null;

export function getHeightfield(seed: number): Heightfield {
  if (!cached || cached.seed !== (seed >>> 0 || 1)) cached = new Heightfield(seed);
  return cached;
}
