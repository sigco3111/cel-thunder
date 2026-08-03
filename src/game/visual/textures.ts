import * as THREE from 'three';
import { Rng } from '../../shared/math';
import type { AircraftSpec } from '../../shared/aircraft';

/**
 * Every texture in this subsystem is drawn into a canvas at load time — there
 * are no binary assets. The rules that keep them from reading as programmer
 * art are consistent across all of them:
 *
 *  - never a flat fill: there is always a value gradient, grain or streaking;
 *  - edges are drawn, not implied — panel lines, rivets, seams and scorch rims
 *    give the eye something to lock onto at every distance;
 *  - alpha is authored deliberately so additive and alpha-blended sprites both
 *    composite without a visible quad edge.
 */

const cache = new Map<string, THREE.Texture>();

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d')!;
  return [c, ctx];
}

function finish(c: HTMLCanvasElement, opts: {
  srgb?: boolean; wrap?: THREE.Wrapping; aniso?: number;
} = {}): THREE.Texture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = opts.wrap ?? THREE.RepeatWrapping;
  t.anisotropy = opts.aniso ?? 8;
  t.needsUpdate = true;
  return t;
}

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

/** Shifts a packed 0xRRGGBB colour in HSL space — used for weathering variety. */
function shade(color: number, mul: number, sat = 1): string {
  let r = ((color >> 16) & 255) / 255, g = ((color >> 8) & 255) / 255, b = (color & 255) / 255;
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  r = (l + (r - l) * sat) * mul; g = (l + (g - l) * sat) * mul; b = (l + (b - l) * sat) * mul;
  const q = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${q(r)},${q(g)},${q(b)})`;
}

// ---------------------------------------------------------------------------
// Aircraft livery
// ---------------------------------------------------------------------------

/**
 * Camouflage + panel lines + weathering, 1024². UVs on the fallback meshes are
 * laid out so one tile covers roughly 6 m, which puts panel lines at a plausible
 * 0.5 m pitch and rivets just at the edge of legibility at combat range.
 */
export function liveryTexture(spec: AircraftSpec): THREE.Texture {
  const key = `livery:${spec.id}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const N = 1024;
  const [c, g] = canvas(N);
  const rng = new Rng(hashString(spec.id));
  const L = spec.livery;

  // Base coat with a subtle vertical value gradient — upper surfaces catch more
  // sun and fade, undersides stay saturated.
  const grad = g.createLinearGradient(0, 0, 0, N);
  grad.addColorStop(0, shade(L.camoA, 1.08, 0.95));
  grad.addColorStop(0.55, hex(L.camoA));
  grad.addColorStop(1, shade(L.camoA, 0.88, 1.05));
  g.fillStyle = grad;
  g.fillRect(0, 0, N, N);

  // --- camouflage pattern -------------------------------------------------
  g.globalAlpha = 0.92;
  switch (L.pattern) {
    case 'splinter': {
      // Hard-edged angular polygons, Soviet/Luftwaffe splinter style.
      for (let i = 0; i < 26; i++) {
        g.fillStyle = shade(L.camoB, rng.range(0.9, 1.12));
        g.beginPath();
        const x = rng.range(-100, N), y = rng.range(-100, N);
        const n = 3 + rng.int(3);
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2 + rng.range(-0.4, 0.4);
          const r = rng.range(60, 230);
          const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r * 0.6;
          k === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
        }
        g.closePath(); g.fill();
      }
      break;
    }
    case 'wave': {
      // RAF-style soft serpentine bands.
      for (let i = 0; i < 14; i++) {
        g.strokeStyle = shade(L.camoB, rng.range(0.92, 1.1));
        g.lineWidth = rng.range(60, 150);
        g.lineCap = 'round';
        g.beginPath();
        let x = rng.range(-150, N), y = rng.range(-50, N);
        g.moveTo(x, y);
        for (let k = 0; k < 6; k++) {
          x += rng.range(90, 220); y += rng.range(-150, 150);
          g.quadraticCurveTo(x - 60, y + rng.range(-90, 90), x, y);
        }
        g.stroke();
      }
      break;
    }
    case 'mottle': {
      // Luftwaffe fuselage mottling: many small soft dabs.
      for (let i = 0; i < 900; i++) {
        const r = rng.range(6, 34);
        const x = rng.range(0, N), y = rng.range(0, N);
        const rg = g.createRadialGradient(x, y, 0, x, y, r);
        rg.addColorStop(0, shade(L.camoB, rng.range(0.85, 1.15)));
        rg.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = rg;
        g.globalAlpha = rng.range(0.25, 0.75);
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
      break;
    }
    case 'blotch': {
      for (let i = 0; i < 60; i++) {
        g.fillStyle = shade(L.camoB, rng.range(0.9, 1.1));
        g.globalAlpha = rng.range(0.5, 0.95);
        const x = rng.range(0, N), y = rng.range(0, N);
        g.beginPath();
        for (let k = 0; k <= 12; k++) {
          const a = (k / 12) * Math.PI * 2;
          const r = rng.range(40, 120) * (0.7 + 0.3 * Math.sin(a * 3));
          const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
          k === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
        }
        g.closePath(); g.fill();
      }
      break;
    }
    case 'solid':
    default: {
      // Bare metal: brushed, with faint tonal panel variation.
      for (let i = 0; i < 2200; i++) {
        g.strokeStyle = `rgba(255,255,255,${rng.range(0.012, 0.05)})`;
        g.lineWidth = rng.range(0.5, 2);
        const y = rng.range(0, N);
        g.beginPath(); g.moveTo(rng.range(0, N), y); g.lineTo(rng.range(0, N), y + rng.range(-2, 2)); g.stroke();
      }
      break;
    }
  }
  g.globalAlpha = 1;

  // --- panel lines --------------------------------------------------------
  // Slight per-panel tonal offset first, then the ink line itself. Without the
  // tonal offset the lines read as a decal rather than as structure.
  const pitch = N / 12;                       // ≈ 0.5 m panels at 6 m per tile
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 12; j++) {
      if (rng.next() > 0.42) continue;
      g.fillStyle = `rgba(${rng.next() > 0.5 ? '255,255,255' : '0,0,0'},${rng.range(0.012, 0.045)})`;
      g.fillRect(i * pitch, j * pitch, pitch, pitch);
    }
  }
  g.strokeStyle = 'rgba(14,18,24,0.42)';
  g.lineWidth = 1.4;
  for (let i = 1; i < 12; i++) {
    g.beginPath(); g.moveTo(i * pitch, 0); g.lineTo(i * pitch, N); g.stroke();
    g.beginPath(); g.moveTo(0, i * pitch); g.lineTo(N, i * pitch); g.stroke();
  }
  // Highlight on the lower/right side of each line = a raised lap joint.
  g.strokeStyle = 'rgba(255,255,255,0.10)';
  g.lineWidth = 1;
  for (let i = 1; i < 12; i++) {
    g.beginPath(); g.moveTo(i * pitch + 1.6, 0); g.lineTo(i * pitch + 1.6, N); g.stroke();
    g.beginPath(); g.moveTo(0, i * pitch + 1.6); g.lineTo(N, i * pitch + 1.6); g.stroke();
  }

  // --- rivets -------------------------------------------------------------
  const rivetPitch = pitch / 7;
  g.fillStyle = 'rgba(10,14,20,0.20)';
  for (let i = 1; i < 12; i++) {
    for (let y = rivetPitch; y < N; y += rivetPitch) {
      g.fillRect(i * pitch - 0.9, y, 1.8, 1.8);
      g.fillRect(y, i * pitch - 0.9, 1.8, 1.8);
    }
  }

  // --- exhaust staining and oil streaks -----------------------------------
  for (let i = 0; i < 22; i++) {
    const x = rng.range(0, N), y = rng.range(0, N);
    const len = rng.range(70, 320);
    const lg = g.createLinearGradient(x, y, x + len, y + rng.range(-14, 14));
    lg.addColorStop(0, `rgba(24,20,16,${rng.range(0.14, 0.34)})`);
    lg.addColorStop(1, 'rgba(24,20,16,0)');
    g.strokeStyle = lg;
    g.lineWidth = rng.range(4, 20);
    g.lineCap = 'round';
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + len, y + rng.range(-14, 14)); g.stroke();
  }

  // --- paint chipping: bare metal at panel corners and leading edges -------
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgba(196,201,208,${rng.range(0.18, 0.6)})`;
    const x = Math.round(rng.range(0, 12)) * pitch + rng.range(-6, 6);
    const y = rng.range(0, N);
    g.fillRect(x, y, rng.range(1, 5), rng.range(1, 3));
  }

  // --- fine surface grain, keeps large flats alive under toon banding ------
  const img = g.getImageData(0, 0, N, N);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng.next() - 0.5) * 11;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);

  const tex = finish(c, { aniso: 16 });
  tex.repeat.set(1, 1);
  cache.set(key, tex);
  return tex;
}

/** National insignia as a standalone alpha sprite for wings and fuselage. */
export function insigniaTexture(spec: AircraftSpec): THREE.Texture {
  const key = `insignia:${spec.livery.insignia}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const N = 256, R = N / 2;
  const [c, g] = canvas(N);
  g.clearRect(0, 0, N, N);
  const ring = (r: number, col: string) => {
    g.fillStyle = col; g.beginPath(); g.arc(R, R, r, 0, Math.PI * 2); g.fill();
  };
  switch (spec.livery.insignia) {
    case 'britain':
      ring(R * 0.94, '#153a7a'); ring(R * 0.62, '#e8e4dc'); ring(R * 0.34, '#b8232f');
      break;
    case 'usa': {
      ring(R * 0.62, '#153a7a');
      g.fillStyle = '#e8e4dc';
      // Five-pointed star.
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 === 0 ? R * 0.58 : R * 0.24;
        const x = R + Math.cos(a) * rr, y = R + Math.sin(a) * rr;
        i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.closePath(); g.fill();
      // Side bars.
      g.fillRect(R * 0.55, R * 0.78, R * 1.0, R * 0.44);
      g.fillRect(R * 0.45, R * 0.78, -R * 1.0, R * 0.44);
      g.fillStyle = '#153a7a';
      g.fillRect(R * 0.55, R * 0.78, R * 1.0, R * 0.10);
      break;
    }
    case 'germany': {
      // Balkenkreuz.
      g.fillStyle = '#e8e4dc';
      g.fillRect(R * 0.18, R * 0.72, R * 1.64, R * 0.56);
      g.fillRect(R * 0.72, R * 0.18, R * 0.56, R * 1.64);
      g.fillStyle = '#14171c';
      g.fillRect(R * 0.34, R * 0.83, R * 1.32, R * 0.34);
      g.fillRect(R * 0.83, R * 0.34, R * 0.34, R * 1.32);
      break;
    }
    case 'japan':
      ring(R * 0.62, '#c8342a');
      break;
    case 'ussr': {
      g.fillStyle = '#c8342a';
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 === 0 ? R * 0.88 : R * 0.36;
        const x = R + Math.cos(a) * rr, y = R + Math.sin(a) * rr;
        i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.closePath(); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 3; g.stroke();
      break;
    }
  }
  // Weather the marking so it does not sit on top of the paint like a sticker.
  const rng = new Rng(7);
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 140; i++) {
    g.fillStyle = `rgba(0,0,0,${rng.range(0.05, 0.3)})`;
    g.fillRect(rng.range(0, N), rng.range(0, N), rng.range(1, 6), rng.range(1, 4));
  }
  g.globalCompositeOperation = 'source-over';

  const tex = finish(c, { wrap: THREE.ClampToEdgeWrapping });
  cache.set(key, tex);
  return tex;
}

// ---------------------------------------------------------------------------
// Damage decal atlas
// ---------------------------------------------------------------------------

/** Column index into the 4×2 decal atlas. */
export const DECAL_RIFLE = 0;   // 7.7–13 mm entry hole
export const DECAL_HMG = 1;     // 12.7 mm hole with petalled metal
export const DECAL_CANNON = 2;  // 20 mm entry: torn hole + scorch
export const DECAL_TEAR = 3;    // structural tear / blown panel
export const DECAL_COLS = 4;
export const DECAL_ROWS = 2;

/**
 * Bullet damage atlas, 4 columns × 2 rows (two variants of each type so
 * repeated hits on one panel do not visibly tile).
 *
 * Anatomy of a convincing hole at game scale: a dark centre that reads as a
 * void, a bright rim of exposed bare metal where the paint sheared away, a
 * ring of radial petals for the larger calibres, and a soft asymmetric scorch
 * halo biased downstream of the impact.
 */
export function damageDecalAtlas(): THREE.Texture {
  const key = 'decals';
  const hit = cache.get(key);
  if (hit) return hit;

  const CELL = 256;
  const c = document.createElement('canvas');
  c.width = CELL * DECAL_COLS; c.height = CELL * DECAL_ROWS;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);

  for (let row = 0; row < DECAL_ROWS; row++) {
    for (let col = 0; col < DECAL_COLS; col++) {
      const rng = new Rng(101 + col * 31 + row * 977);
      const ox = col * CELL, oy = row * CELL;
      const cx = ox + CELL / 2, cy = oy + CELL / 2;
      const scale = [0.14, 0.20, 0.28, 0.40][col];
      const R = CELL * scale;

      g.save();
      g.beginPath(); g.rect(ox, oy, CELL, CELL); g.clip();

      // Scorch halo — offset so it reads as directional gas wash.
      const hx = cx + rng.range(-R * 0.4, R * 0.4);
      const hy = cy + rng.range(-R * 0.4, R * 0.4);
      const halo = g.createRadialGradient(hx, hy, R * 0.5, hx, hy, R * (col === 3 ? 4.0 : 3.0));
      halo.addColorStop(0, 'rgba(18,14,12,0.62)');
      halo.addColorStop(0.35, 'rgba(26,20,16,0.30)');
      halo.addColorStop(1, 'rgba(26,20,16,0)');
      g.fillStyle = halo;
      g.beginPath(); g.arc(hx, hy, R * 4.2, 0, Math.PI * 2); g.fill();

      if (col === DECAL_TEAR) {
        // A blown panel: jagged aperture with bright torn skin around it.
        g.fillStyle = 'rgba(206,212,220,0.85)';
        g.beginPath();
        for (let k = 0; k <= 18; k++) {
          const a = (k / 18) * Math.PI * 2;
          const rr = R * rng.range(0.75, 1.5);
          const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.8;
          k === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
        }
        g.closePath(); g.fill();
        g.fillStyle = 'rgba(6,7,9,0.96)';
        g.beginPath();
        for (let k = 0; k <= 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          const rr = R * rng.range(0.5, 1.1);
          const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.8;
          k === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
        }
        g.closePath(); g.fill();
      } else {
        // Petals of torn metal, more numerous with calibre.
        const petals = col === 0 ? 0 : 5 + col * 3;
        for (let k = 0; k < petals; k++) {
          const a = (k / petals) * Math.PI * 2 + rng.range(-0.2, 0.2);
          const len = R * rng.range(1.05, 1.9);
          g.fillStyle = `rgba(${190 + rng.int(40)},${196 + rng.int(30)},204,${rng.range(0.4, 0.85)})`;
          g.beginPath();
          g.moveTo(cx + Math.cos(a - 0.18) * R * 0.9, cy + Math.sin(a - 0.18) * R * 0.9);
          g.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
          g.lineTo(cx + Math.cos(a + 0.18) * R * 0.9, cy + Math.sin(a + 0.18) * R * 0.9);
          g.closePath(); g.fill();
        }
        // Bare-metal rim.
        g.strokeStyle = 'rgba(214,220,228,0.9)';
        g.lineWidth = Math.max(1.5, R * 0.16);
        g.beginPath(); g.arc(cx, cy, R * 0.94, 0, Math.PI * 2); g.stroke();
        // The void.
        g.fillStyle = 'rgba(5,6,8,0.97)';
        g.beginPath();
        for (let k = 0; k <= 14; k++) {
          const a = (k / 14) * Math.PI * 2;
          const rr = R * rng.range(0.78, 1.0);
          const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
          k === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
        }
        g.closePath(); g.fill();
      }

      // Spall speckle around the impact.
      for (let k = 0; k < 40; k++) {
        const a = rng.range(0, Math.PI * 2), rr = R * rng.range(1.2, 3.4);
        g.fillStyle = `rgba(30,26,22,${rng.range(0.1, 0.45)})`;
        g.fillRect(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, rng.range(1, 3), rng.range(1, 3));
      }
      g.restore();
    }
  }

  const tex = finish(c, { wrap: THREE.ClampToEdgeWrapping, aniso: 4 });
  cache.set(key, tex);
  return tex;
}

// ---------------------------------------------------------------------------
// Particle sprites
// ---------------------------------------------------------------------------

/** Soft turbulent puff. Luminance carries shape; alpha carries the edge. */
export function smokeSprite(): THREE.Texture {
  const key = 'smoke';
  const hit = cache.get(key);
  if (hit) return hit;

  const N = 256, R = N / 2;
  const [c, g] = canvas(N);
  const rng = new Rng(4242);
  // Build from overlapping soft lobes so the silhouette is billowy rather than
  // a perfect circle — a circular puff is the classic tell of a fake smoke.
  for (let i = 0; i < 26; i++) {
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(0, R * 0.42);
    const x = R + Math.cos(a) * d, y = R + Math.sin(a) * d;
    const r = rng.range(R * 0.22, R * 0.5);
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    const v = Math.round(rng.range(190, 255));
    rg.addColorStop(0, `rgba(${v},${v},${v},0.32)`);
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  // Clip to a soft disc so rotating the sprite never reveals a square edge.
  g.globalCompositeOperation = 'destination-in';
  const mask = g.createRadialGradient(R, R, R * 0.30, R, R, R);
  mask.addColorStop(0, 'rgba(0,0,0,1)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = mask; g.fillRect(0, 0, N, N);
  g.globalCompositeOperation = 'source-over';

  const tex = finish(c, { wrap: THREE.ClampToEdgeWrapping });
  cache.set(key, tex);
  return tex;
}

/** Additive flame lick: hot white core, orange body, ragged top. */
export function fireSprite(): THREE.Texture {
  const key = 'fire';
  const hit = cache.get(key);
  if (hit) return hit;

  const N = 256, R = N / 2;
  const [c, g] = canvas(N);
  const rg = g.createRadialGradient(R, R * 1.15, 0, R, R * 1.15, R * 0.95);
  rg.addColorStop(0.00, 'rgba(255,252,236,1)');
  rg.addColorStop(0.16, 'rgba(255,226,148,0.95)');
  rg.addColorStop(0.42, 'rgba(255,140,44,0.66)');
  rg.addColorStop(0.72, 'rgba(190,52,16,0.26)');
  rg.addColorStop(1.00, 'rgba(90,20,8,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, N, N);

  // Ragged licks pulled upward.
  const rng = new Rng(88);
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 18; i++) {
    const x = R + rng.range(-R * 0.45, R * 0.45);
    const h = rng.range(R * 0.4, R * 1.0);
    const lg = g.createLinearGradient(x, R * 1.1, x, R * 1.1 - h);
    lg.addColorStop(0, 'rgba(255,190,90,0.30)');
    lg.addColorStop(1, 'rgba(255,120,40,0)');
    g.strokeStyle = lg;
    g.lineWidth = rng.range(6, 22);
    g.lineCap = 'round';
    g.beginPath(); g.moveTo(x, R * 1.1); g.lineTo(x + rng.range(-14, 14), R * 1.1 - h); g.stroke();
  }
  g.globalCompositeOperation = 'destination-in';
  const mask = g.createRadialGradient(R, R, R * 0.1, R, R, R);
  mask.addColorStop(0, 'rgba(0,0,0,1)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = mask; g.fillRect(0, 0, N, N);
  g.globalCompositeOperation = 'source-over';

  const tex = finish(c, { wrap: THREE.ClampToEdgeWrapping });
  cache.set(key, tex);
  return tex;
}

/** Ground scorch left by a burning wreck. */
export function scarTexture(): THREE.Texture {
  const key = 'scar';
  const hit = cache.get(key);
  if (hit) return hit;

  const N = 512, R = N / 2;
  const [c, g] = canvas(N);
  const rng = new Rng(1201);
  const rg = g.createRadialGradient(R, R, 0, R, R, R);
  rg.addColorStop(0.0, 'rgba(10,9,8,0.94)');
  rg.addColorStop(0.35, 'rgba(24,20,17,0.72)');
  rg.addColorStop(0.7, 'rgba(46,38,30,0.34)');
  rg.addColorStop(1.0, 'rgba(60,50,40,0)');
  g.fillStyle = rg; g.fillRect(0, 0, N, N);

  // Radial soot fingers and gouged earth.
  for (let i = 0; i < 60; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r0 = R * rng.range(0.15, 0.45), r1 = R * rng.range(0.6, 1.0);
    const lg = g.createLinearGradient(
      R + Math.cos(a) * r0, R + Math.sin(a) * r0,
      R + Math.cos(a) * r1, R + Math.sin(a) * r1,
    );
    lg.addColorStop(0, `rgba(12,10,9,${rng.range(0.2, 0.5)})`);
    lg.addColorStop(1, 'rgba(12,10,9,0)');
    g.strokeStyle = lg;
    g.lineWidth = rng.range(4, 26);
    g.beginPath();
    g.moveTo(R + Math.cos(a) * r0, R + Math.sin(a) * r0);
    g.lineTo(R + Math.cos(a) * r1, R + Math.sin(a) * r1);
    g.stroke();
  }
  // Ember speckle in the crater.
  for (let i = 0; i < 200; i++) {
    const a = rng.range(0, Math.PI * 2), r = R * rng.range(0, 0.4);
    g.fillStyle = `rgba(${180 + rng.int(60)},${60 + rng.int(60)},20,${rng.range(0.05, 0.3)})`;
    g.fillRect(R + Math.cos(a) * r, R + Math.sin(a) * r, rng.range(1, 4), rng.range(1, 4));
  }

  const tex = finish(c, { wrap: THREE.ClampToEdgeWrapping });
  cache.set(key, tex);
  return tex;
}

/** Parachute canopy: gores, seams and a shadowed underside. */
export function chuteTexture(): THREE.Texture {
  const key = 'chute';
  const hit = cache.get(key);
  if (hit) return hit;

  const N = 512;
  const [c, g] = canvas(N);
  g.fillStyle = '#d9d4c6';
  g.fillRect(0, 0, N, N);
  // Gore panels run in U; alternate the value so the canopy reads as fabric.
  const gores = 16;
  for (let i = 0; i < gores; i++) {
    g.fillStyle = i % 2 ? 'rgba(0,0,0,0.055)' : 'rgba(255,255,255,0.05)';
    g.fillRect((i * N) / gores, 0, N / gores, N);
  }
  g.strokeStyle = 'rgba(60,56,48,0.42)';
  g.lineWidth = 2;
  for (let i = 0; i <= gores; i++) {
    g.beginPath(); g.moveTo((i * N) / gores, 0); g.lineTo((i * N) / gores, N); g.stroke();
  }
  // Latitudinal reinforcement tapes.
  g.strokeStyle = 'rgba(60,56,48,0.22)'; g.lineWidth = 3;
  for (let j = 1; j < 6; j++) {
    g.beginPath(); g.moveTo(0, (j * N) / 6); g.lineTo(N, (j * N) / 6); g.stroke();
  }
  // Ambient occlusion toward the skirt.
  const lg = g.createLinearGradient(0, 0, 0, N);
  lg.addColorStop(0, 'rgba(255,255,255,0.10)');
  lg.addColorStop(1, 'rgba(20,24,32,0.30)');
  g.fillStyle = lg; g.fillRect(0, 0, N, N);

  const tex = finish(c);
  cache.set(key, tex);
  return tex;
}

// ---------------------------------------------------------------------------

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function disposeTextures(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
