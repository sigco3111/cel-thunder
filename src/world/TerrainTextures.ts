import * as THREE from 'three';

/**
 * Every surface texture in the world is generated here at load time — there
 * are no binary art assets in this project.
 *
 * The goal is *graphic* material identity rather than photoreal detail: each
 * material is built from a bump field plus a colour field, both quantised into
 * a small number of tonal steps so that when the cel lighting bands the
 * surface, the texture bands with it instead of fighting it. Normal maps are
 * derived from the bump field by Sobel so albedo and relief always agree.
 *
 * All noise here is *periodic* (the lattice hash wraps at the tile size), so
 * the textures tile seamlessly at any mip level.
 */

// ---------------------------------------------------------------------------
// Periodic noise
// ---------------------------------------------------------------------------

function phash(x: number, y: number, p: number, seed: number): number {
  const xi = ((x % p) + p) % p;
  const yi = ((y % p) + p) % p;
  let h = (Math.imul(xi, 374761393) + Math.imul(yi, 668265263) + Math.imul(seed, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Tileable value noise with period 'p' lattice cells. */
function pnoise(x: number, y: number, p: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const a = phash(xi, yi, p, seed);
  const b = phash(xi + 1, yi, p, seed);
  const c = phash(xi, yi + 1, p, seed);
  const d = phash(xi + 1, yi + 1, p, seed);
  const ab = a + (b - a) * u;
  const cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

/** Tileable fBm. 'base' is the lattice period at the first octave. */
function pfbm(x: number, y: number, base: number, octaves: number, seed: number, gain = 0.5): number {
  let amp = 1, sum = 0, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += pnoise(x * base * f, y * base * f, base * f, seed + o * 71) * amp;
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

/**
 * Tileable Worley (cellular) noise, returning distance to the nearest feature
 * point normalised to roughly [0,1]. Used for rock fracture patterns, gravel
 * and the cracked-mud look on riverbanks.
 */
function pworley(x: number, y: number, cells: number, seed: number): number {
  const px = x * cells, py = y * cells;
  const xi = Math.floor(px), yi = Math.floor(py);
  let best = 8;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j;
      const fx = cx + phash(cx, cy, cells, seed);
      const fy = cy + phash(cx, cy, cells, seed + 9173);
      const dx = fx - px, dy = fy - py;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.min(1, Math.sqrt(best));
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const sstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Posterise a value into 'n' steps with a soft edge — the cel look, in texel space. */
function quantise(v: number, n: number, soft = 0.5): number {
  const s = v * n;
  const i = Math.floor(s);
  const f = s - i;
  const e = soft <= 0 ? (f > 0.5 ? 1 : 0) : sstep(0.5 - soft * 0.5, 0.5 + soft * 0.5, f);
  return (i + e) / n;
}

// ---------------------------------------------------------------------------
// Texture assembly
// ---------------------------------------------------------------------------

export interface MaterialSample {
  /** Linear-ish RGB in 0..1. */
  r: number; g: number; b: number;
  /** Bump height in 0..1 — drives the derived normal map. */
  h: number;
}

type Sampler = (u: number, v: number, out: MaterialSample) => void;

const RES = 256;

function buildPair(sampler: Sampler, normalStrength: number, name: string): {
  albedo: THREE.DataTexture;
  normal: THREE.DataTexture;
} {
  const n = RES;
  const alb = new Uint8Array(n * n * 4);
  const bump = new Float32Array(n * n);
  const s: MaterialSample = { r: 0, g: 0, b: 0, h: 0 };

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      sampler(i / n, j / n, s);
      const o = (j * n + i) * 4;
      alb[o] = (clamp01(s.r) * 255) | 0;
      alb[o + 1] = (clamp01(s.g) * 255) | 0;
      alb[o + 2] = (clamp01(s.b) * 255) | 0;
      alb[o + 3] = 255;
      bump[j * n + i] = s.h;
    }
  }

  // Sobel -> tangent-space normal. Wrapping indices keeps the normal map
  // seamless exactly where the albedo is.
  const nrm = new Uint8Array(n * n * 4);
  const at = (i: number, j: number) => bump[((j + n) % n) * n + ((i + n) % n)];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const gx =
        (at(i + 1, j - 1) + 2 * at(i + 1, j) + at(i + 1, j + 1)) -
        (at(i - 1, j - 1) + 2 * at(i - 1, j) + at(i - 1, j + 1));
      const gy =
        (at(i - 1, j + 1) + 2 * at(i, j + 1) + at(i + 1, j + 1)) -
        (at(i - 1, j - 1) + 2 * at(i, j - 1) + at(i + 1, j - 1));
      let nx = -gx * normalStrength;
      let ny = -gy * normalStrength;
      const nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv; ny *= inv;
      const o = (j * n + i) * 4;
      nrm[o] = ((nx * 0.5 + 0.5) * 255) | 0;
      nrm[o + 1] = ((ny * 0.5 + 0.5) * 255) | 0;
      nrm[o + 2] = ((nz * inv * 0.5 + 0.5) * 255) | 0;
      nrm[o + 3] = 255;
    }
  }

  const albedo = new THREE.DataTexture(alb, n, n, THREE.RGBAFormat);
  albedo.name = `${name}_albedo`;
  albedo.colorSpace = THREE.SRGBColorSpace;
  const normal = new THREE.DataTexture(nrm, n, n, THREE.RGBAFormat);
  normal.name = `${name}_normal`;
  normal.colorSpace = THREE.NoColorSpace;

  for (const t of [albedo, normal]) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
  }
  return { albedo, normal };
}

// ---------------------------------------------------------------------------
// The materials
// ---------------------------------------------------------------------------

/**
 * Rock: fractured plates from two Worley scales, a sedimentary banding term,
 * and a cool grey-brown palette. The bump is deliberately high-contrast so the
 * triplanar cliffs catch a hard terminator.
 */
const rockSampler: Sampler = (u, v, o) => {
  const plates = pworley(u, v, 9, 17);
  const grit = pworley(u, v, 26, 31);
  const fbm1 = pfbm(u, v, 7, 4, 41);
  const strata = 0.5 + 0.5 * Math.sin((v * 9.0 + fbm1 * 2.4) * Math.PI * 2);

  let h = 0.42 * fbm1 + 0.30 * plates + 0.16 * grit + 0.12 * strata;
  // Crack lines: the low end of the Worley distance field, sharpened.
  const crack = 1 - sstep(0.0, 0.14, plates);
  h -= crack * 0.35;
  h = clamp01(h);

  const tone = quantise(mix(h, fbm1, 0.35), 6, 0.55);
  // Grey-brown with a slight warm shift in the lit steps.
  o.r = mix(0.27, 0.62, tone) + strata * 0.045;
  o.g = mix(0.26, 0.585, tone) + strata * 0.030;
  o.b = mix(0.255, 0.545, tone);
  // Lichen: a sparse cool-green mottle, very War-Thunder-Ardennes.
  const lich = sstep(0.62, 0.80, pfbm(u + 3.1, v + 7.7, 5, 4, 53));
  o.r = mix(o.r, o.r * 0.72, lich);
  o.g = mix(o.g, o.g * 0.95 + 0.06, lich);
  o.b = mix(o.b, o.b * 0.70, lich);
  o.r *= 1 - crack * 0.45; o.g *= 1 - crack * 0.45; o.b *= 1 - crack * 0.42;
  o.h = h;
};

/**
 * Grass: clumped tufts at two scales plus dry patches. Kept desaturated —
 * saturated green terrain is the single fastest way to look like a toy.
 */
const grassSampler: Sampler = (u, v, o) => {
  // IMPORTANT: a tiling texture must carry *only* fine detail. Any feature
  // larger than about a fifth of the tile turns into a visible polka-dot grid
  // on the ground once the tile repeats every 24 m. All the mid- and
  // macro-scale variation is added in the terrain shader instead, where the
  // noise does not repeat.
  const tuft = pfbm(u, v, 32, 3, 61);
  const clump = pfbm(u, v, 12, 3, 67);
  const dry = sstep(0.50, 0.80, pfbm(u + 1.0, v + 2.0, 8, 3, 71));

  const h = clamp01(0.60 * tuft + 0.40 * clump);

  const tone = quantise(0.34 + 0.66 * (0.55 * clump + 0.45 * tuft), 5, 0.6);
  // Two greens plus a straw tone for the dry patches. Desaturated on purpose —
  // saturated green terrain is the fastest way to look like a toy.
  let r = mix(0.215, 0.395, tone);
  let g = mix(0.275, 0.495, tone);
  let b = mix(0.150, 0.250, tone);
  r = mix(r, r * 1.35, dry);
  g = mix(g, g * 1.14, dry);
  b = mix(b, b * 0.92, dry);
  // Bare-earth scars. Must use a coordinate that still has period 1 in u/v,
  // otherwise the tile no longer wraps and every repeat shows a seam.
  const bare = sstep(0.78, 0.94, pfbm(u + 5.5, v + 0.4, 14, 3, 79));
  o.r = mix(r, 0.335, bare * 0.7);
  o.g = mix(g, 0.280, bare * 0.7);
  o.b = mix(b, 0.205, bare * 0.7);
  o.h = h;
};

/** Sand: wind ripples (warped sine) plus fine grain, warm and pale. */
const sandSampler: Sampler = (u, v, o) => {
  const warp = pfbm(u, v, 3, 3, 83);
  const ripple = 0.5 + 0.5 * Math.sin((u * 14 + v * 5 + warp * 3.2) * Math.PI * 2);
  const grain = pfbm(u, v, 40, 2, 89);
  const shells = sstep(0.90, 0.97, pworley(u, v, 30, 97));

  const h = clamp01(0.62 * ripple + 0.24 * grain + 0.14 * warp);
  const tone = quantise(0.35 + 0.65 * (0.7 * ripple + 0.3 * warp), 5, 0.7);
  o.r = mix(0.545, 0.845, tone);
  o.g = mix(0.478, 0.775, tone);
  o.b = mix(0.360, 0.610, tone);
  o.r = mix(o.r, 0.93, shells);
  o.g = mix(o.g, 0.91, shells);
  o.b = mix(o.b, 0.86, shells);
  o.h = h;
};

/** Snow: smooth drifts, wind-scoured ridges, a faint blue in the hollows. */
const snowSampler: Sampler = (u, v, o) => {
  const drift = pfbm(u, v, 8, 3, 101);
  // Integer frequencies only — a fractional one would not close over the tile.
  const scour = 0.5 + 0.5 * Math.sin((u * 4 - v * 7 + drift * 4.5) * Math.PI * 2);
  const crust = pfbm(u, v, 30, 2, 107);

  const h = clamp01(0.55 * drift + 0.35 * scour + 0.10 * crust);
  const tone = quantise(0.45 + 0.55 * h, 4, 0.8);
  // Snow in shade is blue; keep the darkest step cool rather than grey.
  o.r = mix(0.640, 0.985, tone);
  o.g = mix(0.700, 0.995, tone);
  o.b = mix(0.795, 1.000, tone);
  // Sparse exposed grit poking through thin cover.
  const grit = sstep(0.955, 0.995, pworley(u, v, 14, 113));
  o.r = mix(o.r, 0.52, grit * 0.30);
  o.g = mix(o.g, 0.51, grit * 0.30);
  o.b = mix(o.b, 0.50, grit * 0.30);
  o.h = h;
};

/**
 * Foam: the toon shoreline needs a *shape*, not a gradient. This is a
 * high-contrast, quantised cloud of blobs with hard edges that reads as
 * cartoon sea-foam when scrolled and thresholded in the water shader.
 */
function buildFoam(): THREE.DataTexture {
  const n = RES;
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = i / n, v = j / n;
      const f = pfbm(u, v, 5, 5, 131);
      const w = 1 - pworley(u, v, 9, 137);
      let a = clamp01(f * 0.65 + w * 0.55 - 0.28);
      a = quantise(a, 3, 0.25);
      const streak = pfbm(u * 0.6, v * 3.0, 4, 3, 139);
      const o = (j * n + i) * 4;
      data[o] = 255; data[o + 1] = 255; data[o + 2] = 255;
      data[o + 3] = (clamp01(a * (0.55 + 0.75 * streak)) * 255) | 0;
    }
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.name = 'foam';
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/**
 * Water detail normal: two crossed bands of stretched fBm. Scrolled at
 * different rates in the shader this reads as capillary chop riding on the
 * Gerstner swell.
 */
function buildWaterNormal(): THREE.DataTexture {
  const n = RES;
  const bump = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = i / n, v = j / n;
      const a = pfbm(u, v, 6, 4, 151);
      const b = pfbm(v * 1.3 + 0.2, u * 0.7 + 0.9, 9, 3, 157);
      bump[j * n + i] = a * 0.6 + b * 0.4;
    }
  }
  const data = new Uint8Array(n * n * 4);
  const at = (i: number, j: number) => bump[((j + n) % n) * n + ((i + n) % n)];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const gx = at(i + 1, j) - at(i - 1, j);
      const gy = at(i, j + 1) - at(i, j - 1);
      let nx = -gx * 7, ny = -gy * 7;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv; ny *= inv;
      const o = (j * n + i) * 4;
      data[o] = ((nx * 0.5 + 0.5) * 255) | 0;
      data[o + 1] = ((ny * 0.5 + 0.5) * 255) | 0;
      data[o + 2] = ((inv * 0.5 + 0.5) * 255) | 0;
      data[o + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.name = 'waterNormal';
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// Bitmap font — runway designators and unit markings
// ---------------------------------------------------------------------------

/**
 * 5x7 bitmap glyphs for the characters we actually paint on the world
 * (runway numbers, L/R suffixes). Each entry is 7 rows of 5 bits, MSB left.
 */
const GLYPHS: Record<string, number[]> = {
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  'L': [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  'R': [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  ' ': [0, 0, 0, 0, 0, 0, 0],
};

/**
 * Paints text into an RGBA byte buffer. 'w'/'h' describe the buffer; the text
 * is drawn into the box (x0,y0)-(x1,y1) in pixels, stretched to fill it, with
 * the glyph grid rotated 90 degrees when 'vertical' — runway numbers are read
 * along the strip.
 */
export function drawText(
  buf: Uint8Array, w: number, h: number,
  text: string, x0: number, y0: number, x1: number, y1: number,
  r: number, g: number, b: number, a = 255,
): void {
  const n = text.length;
  if (n === 0) return;
  const cellW = (x1 - x0) / (n * 6 - 1);
  const cellH = (y1 - y0) / 7;
  for (let c = 0; c < n; c++) {
    const rows = GLYPHS[text[c]] ?? GLYPHS[' '];
    for (let ry = 0; ry < 7; ry++) {
      const bits = rows[ry];
      for (let rx = 0; rx < 5; rx++) {
        if (!(bits & (1 << (4 - rx)))) continue;
        const px0 = Math.round(x0 + (c * 6 + rx) * cellW);
        const px1 = Math.round(x0 + (c * 6 + rx + 1) * cellW);
        const py0 = Math.round(y0 + ry * cellH);
        const py1 = Math.round(y0 + (ry + 1) * cellH);
        for (let y = py0; y < py1; y++) {
          if (y < 0 || y >= h) continue;
          for (let x = px0; x < px1; x++) {
            if (x < 0 || x >= w) continue;
            const o = (y * w + x) * 4;
            buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = a;
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public bundle
// ---------------------------------------------------------------------------

export interface WorldTextures {
  /** [0] rock  [1] grass  [2] sand  [3] snow */
  albedo: THREE.DataTexture[];
  normal: THREE.DataTexture[];
  foam: THREE.DataTexture;
  waterNormal: THREE.DataTexture;
  dispose(): void;
}

let bundle: WorldTextures | null = null;

export function getWorldTextures(anisotropy: number): WorldTextures {
  if (bundle) return bundle;
  const rock = buildPair(rockSampler, 2.6, 'rock');
  const grass = buildPair(grassSampler, 1.5, 'grass');
  const sand = buildPair(sandSampler, 1.1, 'sand');
  const snow = buildPair(snowSampler, 1.3, 'snow');
  const foam = buildFoam();
  const waterNormal = buildWaterNormal();

  const albedo = [rock.albedo, grass.albedo, sand.albedo, snow.albedo];
  const normal = [rock.normal, grass.normal, sand.normal, snow.normal];
  for (const t of [...albedo, ...normal, foam, waterNormal]) t.anisotropy = anisotropy;

  bundle = {
    albedo, normal, foam, waterNormal,
    dispose() {
      for (const t of [...albedo, ...normal, foam, waterNormal]) t.dispose();
      bundle = null;
    },
  };
  return bundle;
}
