import * as THREE from 'three';
import { Rng } from '../../shared/math';

/**
 * Procedural noise bakery for the cloud system.
 *
 * There are no binary assets in this project, so every texture the cloud
 * raymarcher samples is generated on the CPU at load time. Three things matter
 * here and they are all easy to get wrong:
 *
 * 1. **Everything must tile.** The cloud volume is sampled in world space over
 *    a 64 km map; a non-tiling 3D texture produces visible seams every time the
 *    sampler wraps. Both the Perlin lattice and the Worley cell grid are made
 *    periodic by wrapping their integer coordinates.
 *
 * 2. **Channel layout follows Nubis/Guerrilla.** The shape volume packs a
 *    Perlin-Worley in R and three octaves of inverted Worley in GBA. The shader
 *    rebuilds an FBM from GBA and uses it to erode R. Storing the octaves
 *    separately (instead of a pre-summed FBM) is what lets the shader change
 *    the erosion strength per cloud type at zero cost.
 *
 * 3. **Generation cost is real.** A naive per-voxel Worley evaluation walks 27
 *    neighbour cells and re-indexes the point array every time. We instead
 *    iterate cell-major and hoist the 27 feature points into a small stack
 *    array once per cell, which keeps the inner loop entirely in L1 and cuts
 *    bake time by roughly 3x.
 */

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Unclamped remap; callers clamp when they need to. */
export const remap = (v: number, a: number, b: number, c: number, d: number): number =>
  c + ((v - a) / (b - a)) * (d - c);

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

// The classic 12 edge-midpoint gradients. They give noticeably fewer axis
// alignment artefacts than random unit vectors at this lattice size.
const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

/** Periodic 3D Perlin noise. Coordinates are in lattice units. */
export class Perlin3 {
  private readonly p = new Uint8Array(256);

  constructor(rng: Rng) {
    for (let i = 0; i < 256; i++) this.p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = rng.int(i + 1);
      const t = this.p[i]; this.p[i] = this.p[j]; this.p[j] = t;
    }
  }

  private hash(x: number, y: number, z: number): number {
    const p = this.p;
    return p[(p[(p[x & 255] + y) & 255] + z) & 255];
  }

  private grad(h: number, x: number, y: number, z: number): number {
    const i = (h % 12) * 3;
    return GRAD3[i] * x + GRAD3[i + 1] * y + GRAD3[i + 2] * z;
  }

  /** Noise in roughly [-1,1], periodic with the given integer periods. */
  noise(x: number, y: number, z: number, px: number, py: number, pz: number): number {
    const X0 = Math.floor(x), Y0 = Math.floor(y), Z0 = Math.floor(z);
    const fx = x - X0, fy = y - Y0, fz = z - Z0;
    const u = fade(fx), v = fade(fy), w = fade(fz);

    const xi = ((X0 % px) + px) % px, yi = ((Y0 % py) + py) % py, zi = ((Z0 % pz) + pz) % pz;
    const xj = (xi + 1) % px, yj = (yi + 1) % py, zj = (zi + 1) % pz;

    const n000 = this.grad(this.hash(xi, yi, zi), fx, fy, fz);
    const n100 = this.grad(this.hash(xj, yi, zi), fx - 1, fy, fz);
    const n010 = this.grad(this.hash(xi, yj, zi), fx, fy - 1, fz);
    const n110 = this.grad(this.hash(xj, yj, zi), fx - 1, fy - 1, fz);
    const n001 = this.grad(this.hash(xi, yi, zj), fx, fy, fz - 1);
    const n101 = this.grad(this.hash(xj, yi, zj), fx - 1, fy, fz - 1);
    const n011 = this.grad(this.hash(xi, yj, zj), fx, fy - 1, fz - 1);
    const n111 = this.grad(this.hash(xj, yj, zj), fx - 1, fy - 1, fz - 1);

    const x00 = n000 + u * (n100 - n000);
    const x10 = n010 + u * (n110 - n010);
    const x01 = n001 + u * (n101 - n001);
    const x11 = n011 + u * (n111 - n011);
    const y0 = x00 + v * (x10 - x00);
    const y1 = x01 + v * (x11 - x01);
    // Scale to fill [-1,1] more completely; raw output peaks near ±0.7.
    return (y0 + w * (y1 - y0)) * 1.42;
  }

  /**
   * Periodic FBM over the unit cube. 'base' is the lattice period of the first
   * octave, so the result tiles over [0,1)^3 for any octave count.
   */
  fbm(x: number, y: number, z: number, base: number, octaves: number, gain = 0.5): number {
    let sum = 0, amp = 1, norm = 0, f = base;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x * f, y * f, z * f, f, f, f);
      norm += amp;
      amp *= gain;
      f *= 2;
    }
    return sum / norm;
  }
}

// ---------------------------------------------------------------------------
// Worley (cellular) noise
// ---------------------------------------------------------------------------

interface WorleyGrid { n: number; pts: Float32Array }

function buildWorleyGrid(n: number, rng: Rng): WorleyGrid {
  const pts = new Float32Array(n * n * n * 3);
  for (let i = 0; i < n * n * n; i++) {
    // Keep points away from the exact cell corners; perfectly uniform samples
    // occasionally produce a degenerate flat region.
    pts[i * 3 + 0] = 0.08 + rng.next() * 0.84;
    pts[i * 3 + 1] = 0.08 + rng.next() * 0.84;
    pts[i * 3 + 2] = 0.08 + rng.next() * 0.84;
  }
  return { n, pts };
}

/**
 * Rasterises inverted Worley noise (1 - distance to nearest feature point)
 * into one channel of an RGBA volume. 'size' must be a multiple of 'grid.n'.
 */
function renderWorleyVolume(out: Uint8Array, size: number, grid: WorleyGrid, channel: number): void {
  const n = grid.n;
  const per = size / n;
  const nb = new Float32Array(81); // 27 neighbour points, xyz each
  const pts = grid.pts;

  for (let cz = 0; cz < n; cz++) {
    for (let cy = 0; cy < n; cy++) {
      for (let cx = 0; cx < n; cx++) {
        // Gather the 3x3x3 neighbourhood once. Feature point coordinates stay
        // in *unwrapped* cell space so distances are correct across the seam.
        let k = 0;
        for (let dz = -1; dz <= 1; dz++) {
          const iz = cz + dz, wz = ((iz % n) + n) % n;
          for (let dy = -1; dy <= 1; dy++) {
            const iy = cy + dy, wy = ((iy % n) + n) % n;
            for (let dx = -1; dx <= 1; dx++) {
              const ix = cx + dx, wx = ((ix % n) + n) % n;
              const idx = ((wz * n + wy) * n + wx) * 3;
              nb[k++] = ix + pts[idx];
              nb[k++] = iy + pts[idx + 1];
              nb[k++] = iz + pts[idx + 2];
            }
          }
        }

        for (let vz = 0; vz < per; vz++) {
          const fz = cz + (vz + 0.5) / per;
          const oz = cz * per + vz;
          for (let vy = 0; vy < per; vy++) {
            const fy = cy + (vy + 0.5) / per;
            const oy = cy * per + vy;
            let row = ((oz * size + oy) * size) * 4 + channel;
            for (let vx = 0; vx < per; vx++) {
              const fx = cx + (vx + 0.5) / per;
              let best = 1e9;
              for (let i = 0; i < 81; i += 3) {
                const ax = nb[i] - fx, ay = nb[i + 1] - fy, az = nb[i + 2] - fz;
                const d = ax * ax + ay * ay + az * az;
                if (d < best) best = d;
              }
              const w = 1 - Math.sqrt(best);
              const b = w <= 0 ? 0 : w >= 1 ? 255 : (w * 255) | 0;
              out[row + (cx * per + vx) * 4] = b;
            }
          }
        }
      }
    }
  }
}

/** 2D inverted Worley over a periodic cell grid, used by the weather map. */
function worley2(x: number, y: number, n: number, pts: Float32Array): number {
  const fx = x * n, fy = y * n;
  const cx = Math.floor(fx), cy = Math.floor(fy);
  let best = 1e9;
  for (let dy = -1; dy <= 1; dy++) {
    const iy = cy + dy, wy = ((iy % n) + n) % n;
    for (let dx = -1; dx <= 1; dx++) {
      const ix = cx + dx, wx = ((ix % n) + n) % n;
      const idx = (wy * n + wx) * 2;
      const ax = ix + pts[idx] - fx, ay = iy + pts[idx + 1] - fy;
      const d = ax * ax + ay * ay;
      if (d < best) best = d;
    }
  }
  return clamp01(1 - Math.sqrt(best));
}

function buildWorley2Grid(n: number, rng: Rng): Float32Array {
  const pts = new Float32Array(n * n * 2);
  for (let i = 0; i < n * n; i++) {
    pts[i * 2] = 0.08 + rng.next() * 0.84;
    pts[i * 2 + 1] = 0.08 + rng.next() * 0.84;
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Baked texture set
// ---------------------------------------------------------------------------

export interface CloudNoiseSet {
  /** 64^3 RGBA8: R = Perlin-Worley, GBA = inverted Worley at f = 4/8/16. */
  shape: THREE.Data3DTexture;
  /** 32^3 RGBA8: RGB = inverted Worley at f = 6/12/24, used for edge erosion. */
  detail: THREE.Data3DTexture;
  /** 256^2 RGBA8: R = coverage, G = cloud type, B = precipitation, A = variation. */
  weather: THREE.DataTexture;
  /** 512^2 RGBA8: R = cirrus wisps, G = fine detail, B = deck silhouette, A = deck detail. */
  cirrus: THREE.DataTexture;

  /** Retained CPU copy so gameplay code can query density without a GPU readback. */
  shapeData: Uint8Array;
  shapeSize: number;
  weatherData: Uint8Array;
  weatherSize: number;

  dispose(): void;
}

const yieldToBrowser = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

function make3D(data: Uint8Array, size: number, name: string): THREE.Data3DTexture {
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.name = name;
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.wrapR = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.unpackAlignment = 4;
  tex.needsUpdate = true;
  return tex;
}

function make2D(data: Uint8Array, w: number, h: number, name: string): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = name;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Bakes the full cloud texture set. Yields to the event loop between stages so
 * the boot progress bar keeps animating on slower machines.
 *
 * 'detailLevel' trades bake time and VRAM for silhouette quality:
 *   1 -> 64^3 shape (default), 0 -> 32^3 shape for low-end hardware.
 */
export async function bakeCloudNoise(seed: number, detailLevel: 0 | 1 = 1): Promise<CloudNoiseSet> {
  const rng = new Rng(seed >>> 0 || 1);
  const perlin = new Perlin3(rng);

  // ---- shape volume ------------------------------------------------------
  const S = detailLevel === 1 ? 64 : 32;
  const shapeData = new Uint8Array(S * S * S * 4);

  // GBA: three single-frequency Worley octaves. The shader recombines them.
  const freqs = [4, 8, 16];
  for (let i = 0; i < 3; i++) {
    renderWorleyVolume(shapeData, S, buildWorleyGrid(freqs[i], rng), i + 1);
    await yieldToBrowser();
  }

  // R: Perlin FBM eroded by the low-frequency Worley FBM we just wrote. This is
  // the "Perlin-Worley" of the Nubis paper: it keeps Perlin's connected,
  // billowy structure but replaces its smooth valleys with cellular pockets,
  // which is what makes cumulus read as clumped rather than foggy.
  {
    const inv = 1 / S;
    for (let z = 0; z < S; z++) {
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const o = ((z * S + y) * S + x) * 4;
          const px = (x + 0.5) * inv, py = (y + 0.5) * inv, pz = (z + 0.5) * inv;
          // 4 octaves is enough: higher frequencies are supplied by GBA.
          const p = perlin.fbm(px, py, pz, 4, 4) * 0.5 + 0.5;
          const wFbm = (shapeData[o + 1] * 0.625 + shapeData[o + 2] * 0.25 + shapeData[o + 3] * 0.125) / 255;
          const pw = clamp01(remap(p, wFbm - 1, 1, 0, 1));
          shapeData[o] = (pw * 255) | 0;
        }
      }
      if ((z & 15) === 15) await yieldToBrowser();
    }
  }
  const shape = make3D(shapeData, S, 'cloudShape');

  // ---- detail volume -----------------------------------------------------
  const D = 32;
  const detailData = new Uint8Array(D * D * D * 4);
  // 2/4/8, not 4/8/16. 'renderWorleyVolume' rasterises 'size / n' voxels per
  // cell, so a 16-cell octave in a 32^3 volume gets *two* voxels per axis per
  // cell — and a Worley distance field sweeps its whole range inside one cell.
  // Sampled twice per axis that octave is not detail, it is aliasing, and it is
  // the erosion term that is supposed to make cloud edges cauliflower rather
  // than blobby. At 2/4/8 the finest octave gets four voxels per cell, matching
  // the 64^3 shape volume; the weather presets halve 'detailSize' to keep the
  // *world-space* feature size exactly where it was.
  const dFreqs = [2, 4, 8];
  for (let i = 0; i < 3; i++) {
    renderWorleyVolume(detailData, D, buildWorleyGrid(dFreqs[i], rng), i);
  }
  for (let i = 3; i < detailData.length; i += 4) detailData[i] = 255;
  const detail = make3D(detailData, D, 'cloudDetail');
  await yieldToBrowser();

  // ---- weather map -------------------------------------------------------
  // Coverage is deliberately low frequency and heavily contrasted: real cloud
  // fields are organised into streets and open cells tens of kilometres across,
  // not uniform static.
  const W = 256;
  const weatherData = new Uint8Array(W * W * 4);
  const cellPts = buildWorley2Grid(6, rng);
  {
    const inv = 1 / W;
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const u = (x + 0.5) * inv, v = (y + 0.5) * inv;
        // Two-scale coverage: broad organisation modulated by mesoscale cells.
        const broad = perlin.fbm(u, v, 0.31, 2, 4) * 0.5 + 0.5;
        const cells = worley2(u, v, 6, cellPts);
        let cov = clamp01(broad * 0.72 + cells * 0.42 - 0.14);
        cov = clamp01(remap(cov, 0.18, 0.86, 0, 1));
        // Contrast curve: pushes toward "either clear or cloudy", which is what
        // makes the sky read as a photograph rather than an even grey wash.
        cov = cov * cov * (3 - 2 * cov);

        // Cloud type: 0 = stratus, 0.5 = cumulus, 1 = cumulonimbus. Tall types
        // cluster where coverage is high, exactly as convective towers do.
        const typeN = perlin.fbm(u, v, 0.77, 3, 3) * 0.5 + 0.5;
        const type = clamp01(typeN * 0.55 + cov * 0.55);

        const precip = clamp01(remap(cov * 0.6 + typeN * 0.5, 0.45, 1, 0, 1));
        const varia = perlin.fbm(u + 3.1, v - 1.7, 0.63, 7, 3) * 0.5 + 0.5;

        const o = (y * W + x) * 4;
        weatherData[o] = (cov * 255) | 0;
        weatherData[o + 1] = (type * 255) | 0;
        weatherData[o + 2] = (precip * 255) | 0;
        weatherData[o + 3] = (varia * 255) | 0;
      }
    }
  }
  const weather = make2D(weatherData, W, W, 'cloudWeather');
  await yieldToBrowser();

  // ---- cirrus / horizon deck ---------------------------------------------
  // Cirrus is anisotropic: ice crystals get sheared into long streaks by the
  // jet stream, so the domain is compressed on one axis before the FBM.
  const C = 512;
  const cirrusData = new Uint8Array(C * C * 4);
  {
    const inv = 1 / C;
    for (let y = 0; y < C; y++) {
      for (let x = 0; x < C; x++) {
        const u = (x + 0.5) * inv, v = (y + 0.5) * inv;

        // Stretch x by 5 by using a 5x lower base frequency on that axis.
        const w1 = perlin.noise(u * 3, v * 15, 0.5, 3, 15, 1) * 0.5 + 0.5;
        const w2 = perlin.noise(u * 6, v * 30, 1.5, 6, 30, 1) * 0.5 + 0.5;
        const w3 = perlin.noise(u * 12, v * 60, 2.5, 12, 60, 1) * 0.5 + 0.5;
        let wisp = w1 * 0.55 + w2 * 0.3 + w3 * 0.15;
        // Ridged transform turns soft blobs into filament edges.
        wisp = 1 - Math.abs(wisp * 2 - 1);
        wisp = clamp01(remap(wisp, 0.35, 0.98, 0, 1));

        const fine = clamp01(perlin.fbm(u, v, 0.19, 24, 3) * 0.5 + 0.5);

        // Horizon deck: chunky cumulus silhouettes, isotropic and much larger.
        const deckBase = perlin.fbm(u, v, 0.86, 5, 4) * 0.5 + 0.5;
        const deck = clamp01(remap(deckBase, 0.42, 0.9, 0, 1));
        const deckDetail = clamp01(perlin.fbm(u + 5.5, v + 2.5, 0.41, 14, 3) * 0.5 + 0.5);

        const o = (y * C + x) * 4;
        cirrusData[o] = (wisp * 255) | 0;
        cirrusData[o + 1] = (fine * 255) | 0;
        cirrusData[o + 2] = (deck * 255) | 0;
        cirrusData[o + 3] = (deckDetail * 255) | 0;
      }
      if ((y & 127) === 127) await yieldToBrowser();
    }
  }
  const cirrus = make2D(cirrusData, C, C, 'cirrus');

  return {
    shape, detail, weather, cirrus,
    shapeData, shapeSize: S,
    weatherData, weatherSize: W,
    dispose() {
      shape.dispose(); detail.dispose(); weather.dispose(); cirrus.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// CPU-side sampling — mirrors the GPU density function closely enough for
// gameplay queries (turbulence, "am I in cloud", AI visibility).
// ---------------------------------------------------------------------------

function sample3DWrapped(data: Uint8Array, size: number, x: number, y: number, z: number, ch: number): number {
  // Trilinear with wrap, matching GL_REPEAT + GL_LINEAR.
  const fx = x * size - 0.5, fy = y * size - 0.5, fz = z * size - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
  const tx = fx - x0, ty = fy - y0, tz = fz - z0;
  const w = (i: number) => ((i % size) + size) % size;
  const x0w = w(x0), x1w = w(x0 + 1), y0w = w(y0), y1w = w(y0 + 1), z0w = w(z0), z1w = w(z0 + 1);
  const at = (xi: number, yi: number, zi: number) => data[((zi * size + yi) * size + xi) * 4 + ch];
  const c00 = at(x0w, y0w, z0w) + (at(x1w, y0w, z0w) - at(x0w, y0w, z0w)) * tx;
  const c10 = at(x0w, y1w, z0w) + (at(x1w, y1w, z0w) - at(x0w, y1w, z0w)) * tx;
  const c01 = at(x0w, y0w, z1w) + (at(x1w, y0w, z1w) - at(x0w, y0w, z1w)) * tx;
  const c11 = at(x0w, y1w, z1w) + (at(x1w, y1w, z1w) - at(x0w, y1w, z1w)) * tx;
  const c0 = c00 + (c10 - c00) * ty;
  const c1 = c01 + (c11 - c01) * ty;
  return (c0 + (c1 - c0) * tz) / 255;
}

function sample2DWrapped(data: Uint8Array, size: number, x: number, y: number, ch: number): number {
  const fx = x * size - 0.5, fy = y * size - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const w = (i: number) => ((i % size) + size) % size;
  const x0w = w(x0), x1w = w(x0 + 1), y0w = w(y0), y1w = w(y0 + 1);
  const at = (xi: number, yi: number) => data[(yi * size + xi) * 4 + ch];
  const a = at(x0w, y0w) + (at(x1w, y0w) - at(x0w, y0w)) * tx;
  const b = at(x0w, y1w) + (at(x1w, y1w) - at(x0w, y1w)) * tx;
  return (a + (b - a) * ty) / 255;
}

export interface CpuDensityParams {
  base: number; top: number;
  coverage: number; density: number;
  /** Weather-map cloud-type bias — the shader's 'uCloudType'. */
  cloudTypeBias: number;
  shapeScale: number; weatherScale: number;
  windX: number; windY: number; windZ: number;
  weatherOffsetX: number; weatherOffsetY: number;
  /**
   * Centre of the camera-centred cloud sphere and its radius. The GPU measures
   * cloud altitude against a sphere sitting under the *viewer* (see
   * 'altitudeAt' in VolumetricClouds.ts) so that bases bend down toward the
   * observer's horizon; a flat 'y - base' on the CPU disagrees with it by tens
   * of metres at a kilometre out and by hundreds at the march limit.
   */
  camX: number; camZ: number; planetR: number;
}

/** Height gradient — must stay in lockstep with 'heightGradient()' in the shader. */
export function cpuHeightGradient(h: number, type: number): number {
  const st = clamp01(remap(h, 0, 0.07, 0, 1)) * clamp01(remap(h, 0.2, 0.36, 1, 0));
  const cu = clamp01(remap(h, 0, 0.22, 0, 1)) * clamp01(remap(h, 0.55, 0.96, 1, 0));
  const cb = clamp01(remap(h, 0, 0.09, 0, 1)) * clamp01(remap(h, 0.84, 1, 1, 0));
  const wS = clamp01(1 - type * 2);
  const wC = clamp01(1 - Math.abs(type - 0.5) * 2);
  const wB = clamp01(type * 2 - 1);
  return st * wS + cu * wC + cb * wB;
}

/** Vertical density ramp — mirrors 'densityProfile()' in the shader. */
export function cpuDensityProfile(h: number): number {
  return clamp01(remap(h, 0, 0.14, 0, 1)) * clamp01(remap(h, 0.88, 1, 1, 0.25)) * (0.4 + 0.7 * h);
}

/**
 * Approximate cloud density at a world point, 0..1.
 *
 * Mirrors 'cloudDensityCore' in VolumetricClouds.ts term for term except for
 * the detail-erosion octave — gameplay (buffeting, "am I in cloud", AI
 * visibility) does not need 20 m features, and that octave only ever *removes*
 * density, so this reads slightly high inside a cloud and exactly right about
 * where clouds are.
 *
 * Everything else has to match, and previously did not: the weather map's cloud
 * type was passed through raw instead of through the shader's remap (so the
 * vertical profile was computed for the wrong cloud type), the vertical density
 * ramp was missing entirely (25-60 % too dense), and altitude was measured on a
 * flat plane rather than against the camera-centred sphere.
 */
export function cpuCloudDensity(
  set: CloudNoiseSet, p: CpuDensityParams, x: number, y: number, z: number,
): number {
  const wu = (x * p.weatherScale + p.weatherOffsetX);
  const wv = (z * p.weatherScale + p.weatherOffsetY);
  const covRaw = sample2DWrapped(set.weatherData, set.weatherSize, wu, wv, 0);
  const typeRaw = sample2DWrapped(set.weatherData, set.weatherSize, wu, wv, 1);
  const variaRaw = sample2DWrapped(set.weatherData, set.weatherSize, wu, wv, 3);
  const cov = Math.min(clamp01(covRaw * (0.5 + p.coverage) + (p.coverage - 0.55)), 0.86);
  if (cov <= 0.002) return 0;
  const type = clamp01(typeRaw * 0.62 + p.cloudTypeBias * 0.72 - 0.17);
  const hScale = 0.40 + 0.60 * clamp01(variaRaw * 0.80 + covRaw * 0.42 - 0.06);

  const dx = x - p.camX, dz = z - p.camZ, dy = y + p.planetR;
  const alt = Math.sqrt(dx * dx + dy * dy + dz * dz) - p.planetR;
  const h = (alt - p.base) / Math.max((p.top - p.base) * hScale, 1);
  if (h < 0 || h > 1) return 0;

  const sx = (x + p.windX) * p.shapeScale;
  const sy = (y + p.windY) * p.shapeScale;
  const sz = (z + p.windZ) * p.shapeScale;
  const r = sample3DWrapped(set.shapeData, set.shapeSize, sx, sy, sz, 0);
  const g = sample3DWrapped(set.shapeData, set.shapeSize, sx, sy, sz, 1);
  const b = sample3DWrapped(set.shapeData, set.shapeSize, sx, sy, sz, 2);
  const a = sample3DWrapped(set.shapeData, set.shapeSize, sx, sy, sz, 3);

  const lowFbm = g * 0.625 + b * 0.25 + a * 0.125;
  let d = clamp01(remap(r, lowFbm - 1, 1, 0, 1));
  d *= cpuHeightGradient(h, type);
  d = clamp01(remap(d, 1 - cov, 1, 0, 1)) * cov;
  return d * p.density * cpuDensityProfile(h);
}
