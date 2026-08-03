/**
 * 2D canvas + procedural-noise toolkit used by every texture generator in the
 * game. No image assets exist, so everything here is arithmetic.
 *
 * Performance notes (these matter — this all runs during the loading bar):
 *  - Per-pixel work is done through a Float32Array "field" evaluated at half
 *    resolution and bilinearly resampled. Camouflage edges are then thresholded
 *    at full resolution, so a hard edge stays hard even though the field that
 *    produced it was cheap.
 *  - Grain and speckle come from one small tiling canvas drawn as a pattern,
 *    never from a per-pixel loop.
 *  - 'getImageData' is only called on contexts created with
 *    'willReadFrequently', otherwise browsers keep the surface on the GPU and
 *    every readback stalls.
 */

import * as THREE from 'three';
import type { Rect } from './atlas';

export type Ctx2D = CanvasRenderingContext2D;

// ---------------------------------------------------------------------------
// Canvas plumbing
// ---------------------------------------------------------------------------

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  if (typeof document === 'undefined') {
    throw new Error('[assets] texture generation requires a DOM (browser) environment');
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function ctx2d(c: HTMLCanvasElement, readFrequently = false): Ctx2D {
  const g = c.getContext('2d', { willReadFrequently: readFrequently, alpha: true });
  if (!g) throw new Error('[assets] 2D canvas context unavailable');
  return g;
}

export interface Surface { canvas: HTMLCanvasElement; g: Ctx2D; size: number }

export function makeSurface(size: number, fill?: string, readFrequently = false): Surface {
  const canvas = makeCanvas(size, size);
  const g = ctx2d(canvas, readFrequently);
  if (fill) { g.fillStyle = fill; g.fillRect(0, 0, size, size); }
  return { canvas, g, size };
}

export function makeTexture(
  canvas: HTMLCanvasElement,
  opts: { srgb?: boolean; aniso?: number; mips?: boolean } = {},
): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = opts.mips !== false;
  t.minFilter = opts.mips !== false ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = opts.aniso ?? 4;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// Deterministic noise
// ---------------------------------------------------------------------------

/** Integer hash → [0,1). Same shape as shared/math hash2 but inlined for speed. */
export function ihash(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Bilinear value noise with a smootherstep fade — C² so fbm has no grid ghosts. */
export function vnoise(x: number, y: number, s = 0): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const a = ihash(xi, yi, s), b = ihash(xi + 1, yi, s);
  const c = ihash(xi, yi + 1, s), d = ihash(xi + 1, yi + 1, s);
  const ab = a + (b - a) * u;
  const cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

export function fbm(x: number, y: number, oct = 4, s = 0, lac = 2.03, gain = 0.5): number {
  let a = 0.5, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += a * vnoise(x * f, y * f, s + i * 131);
    norm += a;
    a *= gain; f *= lac;
  }
  return sum / norm;
}

/** Domain-warped fbm — the difference between "noise" and "organic camouflage". */
export function warpFbm(x: number, y: number, oct: number, s: number, warp: number): number {
  const wx = fbm(x * 0.6 + 11.3, y * 0.6 - 4.1, 2, s + 977) - 0.5;
  const wy = fbm(x * 0.6 - 7.7, y * 0.6 + 2.9, 2, s + 1553) - 0.5;
  return fbm(x + wx * warp, y + wy * warp, oct, s);
}

/** Jittered-grid Worley. Returns the nearest cell id and the two nearest distances. */
export interface CellHit { id: number; d1: number; d2: number; cx: number; cy: number }
const _cell: CellHit = { id: 0, d1: 0, d2: 0, cx: 0, cy: 0 };
export function worley(x: number, y: number, s = 0, jitter = 0.85): CellHit {
  const xi = Math.floor(x), yi = Math.floor(y);
  let d1 = 1e9, d2 = 1e9, id = 0, bx = 0, by = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = xi + i, gy = yi + j;
      const px = gx + 0.5 + (ihash(gx, gy, s) - 0.5) * jitter;
      const py = gy + 0.5 + (ihash(gx, gy, s + 7919) - 0.5) * jitter;
      const dx = px - x, dy = py - y;
      const d = dx * dx + dy * dy;
      if (d < d1) { d2 = d1; d1 = d; id = (Math.imul(gx, 73856093) ^ Math.imul(gy, 19349663)) >>> 0; bx = px; by = py; }
      else if (d < d2) d2 = d;
    }
  }
  _cell.id = id; _cell.d1 = Math.sqrt(d1); _cell.d2 = Math.sqrt(d2); _cell.cx = bx; _cell.cy = by;
  return _cell;
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a || 1e-9));
  return t * t * (3 - 2 * t);
};
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Cheap deterministic PRNG for layout decisions (rivet jitter, chip placement). */
export class Rand {
  private s: number;
  constructor(seed = 1) { this.s = (seed >>> 0) || 1; }
  next(): number {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  range(a: number, b: number) { return a + this.next() * (b - a); }
  int(n: number) { return Math.floor(this.next() * n) % Math.max(1, n); }
  bool(p = 0.5) { return this.next() < p; }
  pick<T>(a: readonly T[]): T { return a[this.int(a.length)]; }
  /** Box–Muller, for scatter that clusters naturally instead of looking uniform. */
  gauss(sigma = 1): number {
    const u = Math.max(1e-6, this.next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185307 * this.next()) * sigma;
  }
}

// ---------------------------------------------------------------------------
// Field buffers — half-res scalar evaluation + bilinear resample
// ---------------------------------------------------------------------------

export interface Field { w: number; h: number; data: Float32Array }

export function buildField(w: number, h: number, fn: (x: number, y: number) => number): Field {
  const data = new Float32Array(w * h);
  let k = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[k++] = fn(x, y);
  return { w, h, data };
}

/** Bilinear sample in [0,1]² space. */
export function sampleField(f: Field, u: number, v: number): number {
  const x = clamp01(u) * (f.w - 1), y = clamp01(v) * (f.h - 1);
  const x0 = x | 0, y0 = y | 0;
  const x1 = Math.min(f.w - 1, x0 + 1), y1 = Math.min(f.h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = f.data[y0 * f.w + x0], b = f.data[y0 * f.w + x1];
  const c = f.data[y1 * f.w + x0], d = f.data[y1 * f.w + x1];
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

export const hex = (n: number): string => `#${(n >>> 0 & 0xffffff).toString(16).padStart(6, '0')}`;
export const rgba = (n: number, a: number): string =>
  `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;

export function mixHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(mix(ar, br, t)) << 16) | (Math.round(mix(ag, bg, t)) << 8) | Math.round(mix(ab, bb, t));
}

/** Multiply brightness, keeping hue. 'k' > 1 lightens. */
export function scaleHex(c: number, k: number): number {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((c >> 8) & 255) * k));
  const b = Math.min(255, Math.round((c & 255) * k));
  return (r << 16) | (g << 8) | b;
}

/** Shift toward a hue without changing perceived value much — used for sun fade. */
export function tintHex(c: number, target: number, t: number): number {
  return mixHex(c, target, t);
}

export const rgbOf = (c: number): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

// ---------------------------------------------------------------------------
// Drawing primitives
// ---------------------------------------------------------------------------

export function softBlob(g: Ctx2D, x: number, y: number, r: number, color: string, alpha = 1, hardness = 0.45): void {
  const grd = g.createRadialGradient(x, y, r * hardness, x, y, r);
  grd.addColorStop(0, color);
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.save();
  g.globalAlpha = alpha;
  g.fillStyle = grd;
  g.beginPath(); g.arc(x, y, r, 0, 6.2831853); g.fill();
  g.restore();
}

/**
 * Tapered streak with a soft-edged core — the shape exhaust soot, oil and
 * gun-blast staining all make. Width and opacity both fall off downstream.
 */
export function streak(
  g: Ctx2D, x0: number, y0: number, dx: number, dy: number,
  w0: number, w1: number, color: number, a0: number, a1 = 0, steps = 18,
): void {
  g.save();
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps, t1 = (i + 1) / steps;
    const a = mix(a0, a1, t0);
    if (a <= 0.002) continue;
    const wA = mix(w0, w1, t0), wB = mix(w0, w1, t1);
    const nx = -dy, ny = dx;
    const len = Math.hypot(nx, ny) || 1;
    const ux = nx / len, uy = ny / len;
    const ax = x0 + dx * t0, ay = y0 + dy * t0;
    const bx = x0 + dx * t1, by = y0 + dy * t1;
    g.fillStyle = rgba(color, a);
    g.beginPath();
    g.moveTo(ax - ux * wA, ay - uy * wA);
    g.lineTo(ax + ux * wA, ay + uy * wA);
    g.lineTo(bx + ux * wB, by + uy * wB);
    g.lineTo(bx - ux * wB, by - uy * wB);
    g.closePath(); g.fill();
  }
  g.restore();
}

/** Random thin scratches — used on walkways, around handholds and on bare metal. */
export function scratches(
  g: Ctx2D, r: Rect, count: number, rnd: Rand,
  color: number, alpha: number, lenMin: number, lenMax: number, angle: number, spread: number,
): void {
  g.save();
  g.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const x = r.x + rnd.next() * r.w, y = r.y + rnd.next() * r.h;
    const a = angle + rnd.gauss(spread);
    const l = rnd.range(lenMin, lenMax);
    g.strokeStyle = rgba(color, alpha * rnd.range(0.35, 1));
    g.lineWidth = rnd.range(0.6, 1.8);
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }
  g.restore();
}

/** A tiling grain patch, cached — drawn as a pattern rather than per-pixel. */
const grainCache = new Map<string, CanvasPattern | null>();
export function grainPattern(g: Ctx2D, size: number, amp: number, seed: number): CanvasPattern | null {
  const key = `${size}|${amp}|${seed}`;
  const hit = grainCache.get(key);
  if (hit !== undefined) return hit;
  const c = makeCanvas(size, size);
  const gg = ctx2d(c, true);
  const img = gg.createImageData(size, size);
  const d = img.data;
  for (let y = 0, k = 0; y < size; y++) {
    for (let x = 0; x < size; x++, k += 4) {
      // Two octaves: fine sensor-like grain over a slower blotch so it does not
      // look like TV static tiled across the model.
      const n = vnoise(x * 0.9, y * 0.9, seed) * 0.6 + vnoise(x * 0.11, y * 0.11, seed + 31) * 0.4;
      const v = Math.round(128 + (n - 0.5) * 255);
      d[k] = d[k + 1] = d[k + 2] = v;
      d[k + 3] = Math.round(amp * 255);
    }
  }
  gg.putImageData(img, 0, 0);
  const pat = g.createPattern(c, 'repeat');
  grainCache.set(key, pat);
  return pat;
}

export function overlayGrain(g: Ctx2D, r: Rect, amp: number, seed: number, size = 128): void {
  const pat = grainPattern(g, size, amp, seed);
  if (!pat) return;
  g.save();
  g.globalCompositeOperation = 'overlay';
  g.fillStyle = pat;
  g.fillRect(r.x, r.y, r.w, r.h);
  g.restore();
}

/** Rounded rectangle path (Path2D.roundRect is not universal enough to rely on). */
export function roundRectPath(g: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, Math.abs(w) * 0.5, Math.abs(h) * 0.5);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y); g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + h - rr); g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  g.lineTo(x + rr, y + h); g.quadraticCurveTo(x, y + h, x, y + h - rr);
  g.lineTo(x, y + rr); g.quadraticCurveTo(x, y, x + rr, y);
  g.closePath();
}

export function polyPath(g: Ctx2D, pts: ArrayLike<number>): void {
  g.beginPath();
  g.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
  g.closePath();
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export const FONT_STACK = '"Arial Narrow","Helvetica Neue",Helvetica,Arial,sans-serif';

export interface TextOpts {
  size: number;
  color: number;
  alpha?: number;
  weight?: number;
  tracking?: number;      // extra px between glyphs
  align?: 'left' | 'center' | 'right';
  rotate?: number;
  outline?: number;       // outline colour
  outlineWidth?: number;
  squash?: number;        // horizontal scale, <1 for condensed military lettering
  stencil?: boolean;      // cut bridge gaps like a real stencil
}

/**
 * Manual per-glyph text so that tracking works everywhere (ctx.letterSpacing is
 * still patchy) and so stencil bridges can be punched out afterwards.
 */
export function drawText(g: Ctx2D, text: string, x: number, y: number, o: TextOpts): number {
  const weight = o.weight ?? 700;
  g.save();
  g.translate(x, y);
  if (o.rotate) g.rotate(o.rotate);
  if (o.squash && o.squash !== 1) g.scale(o.squash, 1);
  g.font = `${weight} ${o.size}px ${FONT_STACK}`;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  const track = o.tracking ?? o.size * 0.06;

  let total = 0;
  for (let i = 0; i < text.length; i++) total += g.measureText(text[i]).width + (i < text.length - 1 ? track : 0);

  let cx = o.align === 'center' ? -total / 2 : o.align === 'right' ? -total : 0;
  g.globalAlpha = o.alpha ?? 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (o.outline !== undefined) {
      g.lineJoin = 'round';
      g.lineWidth = o.outlineWidth ?? Math.max(1, o.size * 0.09);
      g.strokeStyle = hex(o.outline);
      g.strokeText(ch, cx, 0);
    }
    g.fillStyle = hex(o.color);
    g.fillText(ch, cx, 0);
    cx += g.measureText(ch).width + track;
  }

  if (o.stencil) {
    // Punch two thin horizontal bridges through the glyph band.
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000';
    const bw = Math.max(1, o.size * 0.055);
    const x0 = o.align === 'center' ? -total / 2 : o.align === 'right' ? -total : 0;
    g.fillRect(x0 - 2, -o.size * 0.20, total + 4, bw);
    g.fillRect(x0 - 2, o.size * 0.16, total + 4, bw);
  }
  g.restore();
  return total;
}

export function textWidth(g: Ctx2D, text: string, size: number, weight = 700, tracking = 0): number {
  g.save();
  g.font = `${weight} ${size}px ${FONT_STACK}`;
  let w = 0;
  for (let i = 0; i < text.length; i++) w += g.measureText(text[i]).width + (i < text.length - 1 ? tracking : 0);
  g.restore();
  return w;
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

export function blurRegion(src: HTMLCanvasElement, r: Rect, radius: number): void {
  if (radius <= 0) return;
  const g = ctx2d(src);
  if (!('filter' in g)) return;
  const tmp = makeCanvas(Math.ceil(r.w), Math.ceil(r.h));
  const tg = ctx2d(tmp);
  tg.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  g.save();
  g.filter = `blur(${radius}px)`;
  g.clearRect(r.x, r.y, r.w, r.h);
  g.drawImage(tmp, 0, 0, r.w, r.h, r.x, r.y, r.w, r.h);
  g.restore();
  g.filter = 'none';
}

/**
 * Sobel height → tangent-space normal map.
 *
 * The height field is authored in the green channel (grey works too). Strength
 * is in "height units per texel"; a scribed panel line wants ~2–3, a rivet ~4.
 */
export function heightToNormal(src: HTMLCanvasElement, strength = 2.5): HTMLCanvasElement {
  const w = src.width, h = src.height;
  const sg = ctx2d(src, true);
  const sd = sg.getImageData(0, 0, w, h).data;
  const out = makeCanvas(w, h);
  const og = ctx2d(out, true);
  const oi = og.createImageData(w, h);
  const od = oi.data;

  const at = (x: number, y: number) => {
    const xx = x < 0 ? 0 : x >= w ? w - 1 : x;
    const yy = y < 0 ? 0 : y >= h ? h - 1 : y;
    return sd[(yy * w + xx) * 4 + 1] / 255;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv; ny *= inv; nz *= inv;
      const k = (y * w + x) * 4;
      od[k] = Math.round((nx * 0.5 + 0.5) * 255);
      // Canvas y runs down while tangent-space +Y runs up, hence the flip.
      od[k + 1] = Math.round((-ny * 0.5 + 0.5) * 255);
      od[k + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      od[k + 3] = 255;
    }
  }
  og.putImageData(oi, 0, 0);
  return out;
}

/** Downsample a canvas with smoothing (used to derive the half-res height map). */
export function downsample(src: HTMLCanvasElement, size: number): HTMLCanvasElement {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, src.width, src.height, 0, 0, size, size);
  return c;
}
