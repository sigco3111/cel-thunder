/**
 * The livery atlas layout.
 *
 * Geometry and texture generation both need to agree, to the pixel, on where a
 * given surface lives in the 2048² sheet — so the layout lives here, imported
 * by both sides, and nowhere else defines a UV rectangle.
 *
 * Layout reasoning: each region's *aspect ratio* is chosen so that the texel
 * density along the two model-space axes comes out roughly equal. The fuselage
 * is long and thin, so length runs along the wide axis of its rectangle and the
 * circumferential sweep runs up it. Wings are the opposite way round. Target is
 * ~100–200 px per metre everywhere, which puts a panel line at ~2 px — thin
 * enough to read as a scribed line rather than a painted stripe.
 *
 * Canvas coordinates are y-down; UVs are y-up. 'uvOf' does the flip, so callers
 * never think about it.
 */

export interface Rect { x: number; y: number; w: number; h: number }
export interface UvBox { u0: number; v0: number; u1: number; v1: number }

export const TEX_SIZE = 2048;

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

export const REGION = {
  /** Fuselage: horizontal = nose→tail, vertical = circumference (θ=0 belly). */
  fuse: R(0, 0, 1280, 900),
  /** Large one-off painted parts: doors, radiators, cowl interior, wheel wells. */
  detail: R(1288, 0, 760, 900),
  /** Wing upper: horizontal = port tip→stbd tip, vertical = LE→TE. */
  wingTop: R(0, 912, 1024, 480),
  wingBot: R(1024, 912, 1024, 480),
  htailTop: R(0, 1400, 600, 230),
  htailBot: R(608, 1400, 600, 230),
  /** Fin: two halves side by side (stbd left, port right), vertical = root→tip. */
  fin: R(1216, 1400, 460, 230),
  misc: R(1684, 1400, 364, 230),
  /** Material swatch strip for all the small hard parts. */
  swatch: R(0, 1640, 2048, 408),
} as const;

export type RegionName = keyof typeof REGION;

/** Sub-rectangles inside REGION.detail. */
export const DETAIL: Record<string, Rect> = {
  gearDoor: R(1288, 0, 250, 300),
  wheelWell: R(1546, 0, 250, 300),
  radiator: R(1804, 0, 244, 300),
  cowlInner: R(1288, 308, 250, 280),
  instrPanel: R(1546, 308, 250, 280),
  seat: R(1804, 308, 244, 280),
  bulkhead: R(1288, 596, 250, 300),
  floor: R(1546, 596, 250, 300),
  armour: R(1804, 596, 244, 300),
};

/**
 * Material swatches. Small parts (struts, barrels, hinges, tyres…) map into one
 * of these boxes instead of getting bespoke unwraps — a 16-cell grid across the
 * bottom strip. Each cell is painted with its own grain, scratches and grime so
 * that even a 30-triangle oleo strut reads as machined metal, not flat colour.
 */
export const SWATCH_NAMES = [
  'hullPaint', 'metalDark', 'metalBare', 'steel',
  'gunmetal', 'tyre', 'propBlade', 'interior',
  'leather', 'brass', 'chrome', 'exhaust',
  'navRed', 'navGreen', 'fabric', 'glassFrame',
  'underPaint', 'zincPrimer', 'wood', 'copper',
  'plexi', 'olive', 'sootMetal', 'strap',
] as const;
export type SwatchName = (typeof SWATCH_NAMES)[number];

export const SWATCH: Record<SwatchName, Rect> = (() => {
  const out = {} as Record<SwatchName, Rect>;
  const s = REGION.swatch;
  const cols = 8, rows = 3;
  const cw = Math.floor(s.w / cols), ch = Math.floor(s.h / rows);
  SWATCH_NAMES.forEach((n, i) => {
    const c = i % cols, r = (i / cols) | 0;
    out[n] = R(s.x + c * cw, s.y + r * ch, cw, ch);
  });
  return out;
})();

/** Pixel rect → UV pair, with the y flip baked in. u,v are 0..1 inside the rect. */
export function uvOf(r: Rect, u: number, v: number, size = TEX_SIZE): [number, number] {
  return [(r.x + u * r.w) / size, 1 - (r.y + v * r.h) / size];
}

/**
 * Pixel rect → normalised UV box, inset by 'pad' texels.
 *
 * The inset is a mip gutter: without it, texels from a neighbouring region bleed
 * across the seam at distance and you get a bright fringe along the wing root.
 */
export function boxOf(r: Rect, pad = 3, size = TEX_SIZE): UvBox {
  return {
    u0: (r.x + pad) / size,
    u1: (r.x + r.w - pad) / size,
    v0: 1 - (r.y + r.h - pad) / size,
    v1: 1 - (r.y + pad) / size,
  };
}

/** Point inside a UV box. */
export function inBox(b: UvBox, u: number, v: number): [number, number] {
  return [b.u0 + (b.u1 - b.u0) * u, b.v0 + (b.v1 - b.v0) * v];
}

export const swatchBox = (n: SwatchName, pad = 6): UvBox => boxOf(SWATCH[n], pad);
export const detailBox = (n: string, pad = 8): UvBox => boxOf(DETAIL[n] ?? DETAIL.gearDoor, pad);

// ---------------------------------------------------------------------------
// Surface unwraps — the single definition shared by geometry and painting
// ---------------------------------------------------------------------------

/** Fuselage: cylindrical. t = 0 nose → 1 tail, θ01 = 0 belly → 0.5 top. */
export const fuseUv = (t: number, theta01: number): [number, number] =>
  uvOf(REGION.fuse, t, theta01);

/** Wing: planar per surface. Signed η spans port tip (−1) to starboard tip (+1). */
export const wingUv = (etaSigned: number, chordFrac: number, side: number): [number, number] =>
  uvOf(side > 0 ? REGION.wingTop : REGION.wingBot, 0.5 + 0.5 * etaSigned, chordFrac);

export const htailUv = (etaSigned: number, chordFrac: number, side: number): [number, number] =>
  uvOf(side > 0 ? REGION.htailTop : REGION.htailBot, 0.5 + 0.5 * etaSigned, chordFrac);

/**
 * Fin: both faces in one rectangle, starboard on the left half with its leading
 * edge at u=0, port on the right half with its leading edge at u=1. Mirroring
 * the port half is what keeps serials and unit codes reading forwards from both
 * sides instead of one of them coming out backwards.
 */
export const finUv = (eta: number, chordFrac: number, side: number): [number, number] =>
  uvOf(REGION.fin, side > 0 ? 1 - 0.5 * chordFrac : 0.5 * chordFrac, 1 - Math.abs(eta));

/** Gauge dial atlas — its own small sheet, 4×4 tiles. */
export const GAUGE_TEX_SIZE = 512;
export const GAUGE_TILES = [
  'airspeed', 'altimeter', 'horizon', 'turnslip',
  'vsi', 'compass', 'rpm', 'boost',
  'oiltemp', 'oilpress', 'fuel', 'clock',
  'ammo', 'radiator', 'blank', 'placard',
] as const;
export type GaugeName = (typeof GAUGE_TILES)[number];

export function gaugeBox(n: GaugeName): UvBox {
  const i = Math.max(0, GAUGE_TILES.indexOf(n));
  const c = i % 4, r = (i / 4) | 0;
  const t = GAUGE_TEX_SIZE / 4;
  return boxOf(R(c * t, r * t, t, t), 2, GAUGE_TEX_SIZE);
}

/** Battle-damage decal atlas — 4×4 tiles of 256 px. */
export const DAMAGE_TEX_SIZE = 1024;
export const DAMAGE_TILES = [
  'hole_a', 'hole_b', 'hole_c', 'hole_d',
  'exit_a', 'exit_b', 'cannon_a', 'cannon_b',
  'cannon_c', 'scorch_a', 'scorch_b', 'scorch_c',
  'tear_a', 'tear_b', 'crack', 'oil',
] as const;
export type DamageDecal = (typeof DAMAGE_TILES)[number];

export function damageBox(n: DamageDecal): UvBox {
  const i = Math.max(0, DAMAGE_TILES.indexOf(n));
  const c = i % 4, r = (i / 4) | 0;
  const t = DAMAGE_TEX_SIZE / 4;
  return boxOf(R(c * t, r * t, t, t), 1, DAMAGE_TEX_SIZE);
}
