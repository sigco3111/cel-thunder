import { el, setText, clamp } from '../dom';
import { COLORS } from '../theme';
import { EntityKind, type EntityState } from '../../shared/protocol';
import { hash2 } from '../../shared/math';

export interface WorldMarker {
  kind: 'airfield' | 'capture' | 'objective' | 'spawn';
  x: number;
  z: number;
  team: number;
  name: string;
  /** Capture progress −1 … 1 (sign = owning team), for capture points. */
  progress?: number;
}

const ZOOMS = [1500, 3000, 6000, 12000, 24000];
/** Terrain bake resolution. 512² over a 64 km world is ~125 m per texel —
 *  enough that the closest zoom still reads as landscape, not as Lego. */
const BAKE = 640;
/** Rows of the bake done per frame. 32 rows is well under a millisecond. */
const BAKE_ROWS = 32;

/**
 * Elevation bands.
 *
 * Five, not seven, and every one of them a flat ink-chart colour rather than a
 * sample of what the terrain looks like from orbit. The previous set combined
 * seven bands with a per-texel hillshade quantised into four steps: twenty-eight
 * distinct colours, driven by a 125 m/texel gradient, then bilinearly upscaled
 * into a 244 px widget. The result was a mottled, low-contrast raster that read
 * as a blurry satellite photograph — the one thing a tactical map in this game
 * must not be, because nothing else in the frame is photographic.
 *
 * These are picked from the same palette as the panels around them: the sea is
 * the HUD's own water blue, the land greens are the terrain's greens knocked
 * back and desaturated so contact markers and objectives stay the most saturated
 * things on the map, and each band is separated from its neighbour by a drawn
 * ink contour rather than by a gradient.
 */
const BANDS = [
  { h: -1e9, c: [16, 34, 52] },    // sea
  { h: -30, c: [26, 54, 80] },     // shoal
  { h: 6, c: [52, 72, 52] },       // lowland
  { h: 420, c: [72, 92, 60] },     // upland
  { h: 1100, c: [124, 124, 104] }, // high ground
];
/** Ink used for contours, the coastline and the frame — the HUD's outline blue-black. */
const INK: [number, number, number] = [7, 12, 19];

/**
 * Tactical minimap.
 *
 * Terrain is baked once into an offscreen canvas at world scale: elevation is
 * quantised into four bands with a cel-style ink coastline, which reads far
 * better at 220 px than a smooth heightfield would. Per frame the map only
 * blits the relevant crop of that bake and draws a few dozen vectors, so it
 * costs well under a millisecond even at 4K.
 */
export class Minimap {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D | null;
  private bake: HTMLCanvasElement;
  private baked = false;
  private zoom = 2;
  private scaleLbl: HTMLElement;
  private size = 220;
  private dpr = 1;
  private worldExtent = 32000;
  private seed = 1337;

  markers: WorldMarker[] = [];
  terrain: ((x: number, z: number) => number) | null = null;

  constructor(parent: HTMLElement) {
    // Deliberately not 'is-glass ct-hatch'. The canvas is opaque and covers the
    // whole panel interior, so a backdrop blur and an overlay-blended hatch were
    // being composited against the live 3D canvas every frame to tint three
    // pixels of padding. Dropping both removes two per-frame full-panel
    // compositing passes and, incidentally, is what lets the chart's flat
    // colours stay flat.
    this.root = el('div', 'ct-panel ct-mm', parent);
    this.root.id = 'ct-minimap';

    const head = el('div', 'ct-head', this.root);
    el('span', '', head, 'TACTICAL');
    el('span', 'ct-head-rule', head);
    const zoomBox = el('div', 'ct-mm-zoom', head);
    const zOut = el('button', '', zoomBox, '−');
    const zIn = el('button', '', zoomBox, '+');
    zOut.onclick = () => this.setZoom(this.zoom + 1);
    zIn.onclick = () => this.setZoom(this.zoom - 1);

    const wrap = el('div', 'ct-mm-wrap', this.root);
    this.canvas = el('canvas', '', wrap);
    this.scaleLbl = el('div', 'ct-mm-scale', wrap, '3 km');
    this.g = this.canvas.getContext('2d');

    this.bake = document.createElement('canvas');
    this.bake.width = this.bake.height = BAKE;
    this.setZoom(2);

    wrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.setZoom(this.zoom + Math.sign(e.deltaY));
    }, { passive: false });
  }

  setZoom(i: number): void {
    this.zoom = clamp(Math.round(i), 0, ZOOMS.length - 1);
    const r = ZOOMS[this.zoom];
    setText(this.scaleLbl, r >= 1000 ? `${(r / 1000).toFixed(0)} km` : `${r} m`);
  }

  setSeed(seed: number, extent: number): void {
    if (seed === this.seed && extent === this.worldExtent && this.baked) return;
    this.seed = seed;
    this.worldExtent = extent;
    this.baked = false;
    this.hs = null;
    this.bakeRow = 0;
    this.bakePhase = 0;
  }

  resize(cssSize: number, dpr: number): void {
    this.size = Math.max(64, Math.round(cssSize));
    this.dpr = clamp(dpr, 1, 2);
    this.canvas.width = Math.round(this.size * this.dpr);
    this.canvas.height = Math.round(this.size * this.dpr);
  }

  // -------------------------------------------------------------------------

  /** Height sampler with a deterministic fallback when the world has none. */
  private height(x: number, z: number): number {
    if (this.terrain) return this.terrain(x, z);
    // Value-noise fbm — same hash the world uses, so the fallback map at least
    // shares the world's seed and feels like the same place.
    let h = 0, amp = 1, freq = 1 / 9000, norm = 0;
    for (let o = 0; o < 5; o++) {
      h += amp * vnoise(x * freq, z * freq, this.seed + o * 37);
      norm += amp;
      amp *= 0.5; freq *= 2.07;
    }
    h /= norm;
    // Push a coastline through the middle of the range and lift ridges.
    return (h - 0.46) * 2600;
  }

  /**
   * Advances the terrain bake by a bounded slice of work.
   *
   * The bake is 512² = 262 144 terrain samples, a second 262 k pass to write
   * the ImageData, and a Canvas2D path of tens of thousands of coastline
   * segments. Doing all of that in one call — which is what happened, lazily,
   * on the first minimap frame after the player deployed — is a multi-frame
   * hitch at the exact moment they enter combat. It is now spread over about
   * thirty frames at a fixed row budget, and every completed slice is pushed to
   * the offscreen canvas immediately, so the map fills in from the north
   * instead of appearing all at once. Nothing waits on it: the widget draws
   * whatever is ready.
   */
  private stepBake(): void {
    if (this.baked) return;
    const N = BAKE;
    const g = this.bake.getContext('2d');
    if (!g) { this.baked = true; return; }
    const E = this.worldExtent;
    const step = (E * 2) / N;

    if (!this.hs) {
      this.hs = new Float32Array(N * N);
      this.bakeRow = 0;
      this.bakePhase = 0;
      // Sea, so the unfinished part of the map is not transparent.
      g.fillStyle = 'rgb(18,41,63)';
      g.fillRect(0, 0, N, N);
    }
    const hs = this.hs;

    // --- phase 0: sample the heightfield ------------------------------------
    if (this.bakePhase === 0) {
      const end = Math.min(N, this.bakeRow + BAKE_ROWS);
      for (let j = this.bakeRow; j < end; j++) {
        const z = -E + j * step;
        for (let i = 0; i < N; i++) hs[j * N + i] = this.height(-E + i * step, z);
      }
      this.bakeRow = end;
      if (this.bakeRow >= N) { this.bakePhase = 1; this.bakeRow = 0; }
      return;
    }

    // --- phase 1: band, contour and ink, one horizontal strip at a time -----
    //
    // This is the whole "ink and flat colour" idea applied to cartography.
    // Three rules, in this order:
    //
    //  1. Low-pass the heightfield before banding. At 125 m per texel the raw
    //     sampler is full of single-texel ridges and gullies; banding that
    //     directly is what produced the salt-and-pepper mottle that made the old
    //     map look like a compressed aerial photograph. A 3x3 box is enough to
    //     turn it into regions.
    //  2. Fill each region with one flat colour. No hillshade, no gradient — a
    //     chart states elevation, it does not attempt to depict light.
    //  3. Draw ink wherever the band index changes. That single test gives both
    //     the contour lines between elevation steps and, at the waterline, the
    //     coastline — one pass, no Canvas2D path, and it is the same graphic
    //     language as the inverted-hull outlines on the aircraft.
    if (this.bakePhase === 1) {
      const end = Math.min(N, this.bakeRow + BAKE_ROWS);
      const rows = end - this.bakeRow;
      const img = g.createImageData(N, rows);
      const d = img.data;

      const smooth = (i: number, j: number): number => {
        let sum = 0;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj < 0 ? 0 : j + dj >= N ? N - 1 : j + dj;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di < 0 ? 0 : i + di >= N ? N - 1 : i + di;
            sum += hs[jj * N + ii];
          }
        }
        return sum * (1 / 9);
      };
      const bandOf = (h: number): number => {
        let b = 0;
        for (let k = 0; k < BANDS.length; k++) if (h >= BANDS[k].h) b = k;
        return b;
      };

      for (let j = this.bakeRow; j < end; j++) {
        for (let i = 0; i < N; i++) {
          const b = bandOf(smooth(i, j));
          // Ink a texel whose left or upper neighbour belongs to a different
          // band; the waterline (band 1 -> 2) gets a second texel of weight so
          // the coast reads heavier than an inland contour, exactly as it does
          // on a printed chart.
          const bl = i > 0 ? bandOf(smooth(i - 1, j)) : b;
          const bu = j > 0 ? bandOf(smooth(i, j - 1)) : b;
          const coast = (b >= 2) !== (bl >= 2) || (b >= 2) !== (bu >= 2);
          const contour = b !== bl || b !== bu;

          const o = ((j - this.bakeRow) * N + i) * 4;
          if (coast) {
            d[o] = INK[0]; d[o + 1] = INK[1]; d[o + 2] = INK[2];
          } else if (contour) {
            // Contours are the band's own colour darkened, not full ink, so the
            // map keeps its hierarchy: coast reads first, contours second.
            const c = BANDS[b].c;
            d[o] = c[0] * 0.55; d[o + 1] = c[1] * 0.55; d[o + 2] = c[2] * 0.55;
          } else {
            const c = BANDS[b].c;
            d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2];
          }
          d[o + 3] = 255;
        }
      }
      g.putImageData(img, 0, this.bakeRow);
      this.bakeRow = end;
      if (this.bakeRow >= N) {
        this.bakePhase = 2;
        this.baked = true;
        // 1 MB of scratch that is never needed again.
        this.hs = null;
      }
    }
  }
  private hs: Float32Array | null = null;
  private bakeRow = 0;
  private bakePhase = 0;

  // The minimap used to invent five objectives — two airfields and three
  // capture points at hashed positions, complete with fabricated capture
  // progress — whenever nothing had pushed it real ones. A tactical map that
  // makes up tactical information is worse than a bare one: the player flies to
  // a capture point that does not exist. The real airfields now come from the
  // world subsystem (UiSystem.resolveWorldApi), and if nothing has been pushed
  // the map simply shows terrain and contacts.

  // -------------------------------------------------------------------------

  update(
    entities: Map<number, EntityState>,
    localId: number,
    localTeam: number,
    px: number,
    pz: number,
    headingDeg: number,
  ): void {
    const g = this.g;
    if (!g) return;
    this.stepBake();

    const S = this.size * this.dpr;
    const R = ZOOMS[this.zoom];
    const k = S / (R * 2);          // pixels per metre
    const E = this.worldExtent;

    g.save();
    g.clearRect(0, 0, S, S);

    // Blit the crop of the bake that covers the visible world rectangle.
    const bx = ((px - R) + E) / (E * 2) * BAKE;
    const bz = ((pz - R) + E) / (E * 2) * BAKE;
    const bw = (R * 2) / (E * 2) * BAKE;
    // Filtering is chosen from the magnification. Under about 4x the bilinear
    // softening of a one-texel contour still reads as a drawn line; past that it
    // turns every contour into a gradient smear, which is exactly the "blurry
    // satellite photo" the map is trying not to be, and hard texels read better.
    const mag = S / Math.max(1, bw);
    g.imageSmoothingEnabled = mag < 4;
    g.imageSmoothingQuality = 'high';
    g.fillStyle = COLORS.waterDeep;
    g.fillRect(0, 0, S, S);
    g.drawImage(this.bake, bx, bz, bw, bw, 0, 0, S, S);

    const X = (wx: number) => (wx - px) * k + S * 0.5;
    const Z = (wz: number) => (wz - pz) * k + S * 0.5;

    // Graticule ------------------------------------------------------------
    // Two weights: a fine grid at the working interval and a heavy line every
    // fifth one, which is what makes a chart countable at a glance instead of
    // being a uniform mesh.
    const grid = R > 8000 ? 10000 : R > 3000 ? 5000 : 1000;
    for (const pass of [0, 1]) {
      g.strokeStyle = pass ? 'rgba(206, 232, 252, 0.20)' : 'rgba(190, 220, 245, 0.09)';
      g.lineWidth = (pass ? 1.4 : 1) * this.dpr;
      g.beginPath();
      for (let v = Math.ceil((px - R) / grid) * grid; v < px + R; v += grid) {
        if ((Math.round(v / grid) % 5 === 0) !== (pass === 1)) continue;
        g.moveTo(X(v), 0); g.lineTo(X(v), S);
      }
      for (let v = Math.ceil((pz - R) / grid) * grid; v < pz + R; v += grid) {
        if ((Math.round(v / grid) % 5 === 0) !== (pass === 1)) continue;
        g.moveTo(0, Z(v)); g.lineTo(S, Z(v));
      }
      g.stroke();
    }

    // Range rings, dashed so they never read as a contour on the chart.
    g.save();
    g.setLineDash([3 * this.dpr, 4 * this.dpr]);
    g.strokeStyle = 'rgba(220, 236, 251, 0.22)';
    g.lineWidth = 1 * this.dpr;
    g.beginPath();
    g.arc(S * 0.5, S * 0.5, S * 0.25, 0, Math.PI * 2);
    g.moveTo(S * 0.5 + S * 0.42, S * 0.5);
    g.arc(S * 0.5, S * 0.5, S * 0.42, 0, Math.PI * 2);
    g.stroke();
    g.restore();

    // Objectives -----------------------------------------------------------
    for (const m of this.markers) {
      const x = X(m.x), z = Z(m.z);
      if (x < -30 || z < -30 || x > S + 30 || z > S + 30) continue;
      const col = m.team < 0 ? COLORS.neutral : m.team === localTeam ? COLORS.ally : COLORS.enemy;
      g.lineWidth = 2 * this.dpr;
      g.strokeStyle = 'rgba(6,10,16,0.8)';
      if (m.kind === 'airfield') {
        // Runway glyph: a bar with a bracket, unmistakable at 6 px.
        const w = 9 * this.dpr, h = 3.4 * this.dpr;
        g.save();
        g.translate(x, z);
        g.fillStyle = 'rgba(6,10,16,0.7)';
        g.fillRect(-w - 1, -h - 1, (w + 1) * 2, (h + 1) * 2);
        g.fillStyle = col;
        g.fillRect(-w, -h, w * 2, h * 2);
        g.fillStyle = 'rgba(6,10,16,0.85)';
        g.fillRect(-w * 0.55, -h * 0.35, w * 1.1, h * 0.7);
        g.restore();
      } else {
        const r = 7 * this.dpr;
        g.beginPath(); g.arc(x, z, r, 0, Math.PI * 2);
        g.fillStyle = 'rgba(6,10,16,0.55)'; g.fill();
        g.strokeStyle = col; g.lineWidth = 2 * this.dpr; g.stroke();
        if (m.progress !== undefined && Math.abs(m.progress) > 0.02) {
          g.beginPath();
          g.arc(x, z, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.abs(m.progress), m.progress < 0);
          g.lineTo(x, z);
          g.fillStyle = (m.progress < 0 ? COLORS.ally : COLORS.enemy) + 'aa';
          g.fill();
        }
        g.fillStyle = '#fff';
        g.font = `700 ${8 * this.dpr}px ui-monospace, monospace`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(m.name, x, z + 0.5 * this.dpr);
      }
    }

    // Contacts -------------------------------------------------------------
    for (const e of entities.values()) {
      if (e.kind !== EntityKind.Aircraft && e.kind !== EntityKind.GroundUnit) continue;
      const isLocal = e.id === localId;
      const x = X(e.px), z = Z(e.pz);
      if (x < -10 || z < -10 || x > S + 10 || z > S + 10) continue;
      const hdg = Math.atan2(e.vx, e.vz);
      const col = isLocal ? COLORS.accent : e.team === localTeam ? COLORS.ally : COLORS.enemy;
      const r = (isLocal ? 6.5 : 5) * this.dpr;
      g.save();
      g.translate(x, z);
      g.rotate(-hdg);
      g.beginPath();
      g.moveTo(0, -r);
      g.lineTo(r * 0.72, r * 0.8);
      g.lineTo(0, r * 0.35);
      g.lineTo(-r * 0.72, r * 0.8);
      g.closePath();
      g.fillStyle = col;
      g.strokeStyle = 'rgba(6,10,16,0.9)';
      g.lineWidth = 1.6 * this.dpr;
      g.fill(); g.stroke();
      g.restore();
    }

    // Own view cone --------------------------------------------------------
    const hr = -headingDeg * Math.PI / 180;
    g.save();
    g.translate(S * 0.5, S * 0.5);
    g.rotate(hr);
    const cone = g.createLinearGradient(0, 0, 0, -S * 0.34);
    cone.addColorStop(0, 'rgba(255,178,58,0.28)');
    cone.addColorStop(1, 'rgba(255,178,58,0)');
    g.fillStyle = cone;
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, S * 0.34, -Math.PI / 2 - 0.42, -Math.PI / 2 + 0.42);
    g.closePath();
    g.fill();
    g.restore();

    // North index ----------------------------------------------------------
    g.fillStyle = 'rgba(6,10,16,0.7)';
    g.fillRect(S * 0.5 - 7 * this.dpr, 3 * this.dpr, 14 * this.dpr, 12 * this.dpr);
    g.fillStyle = 'rgba(240,248,255,0.9)';
    g.font = `700 ${9 * this.dpr}px ui-monospace, monospace`;
    g.textAlign = 'center'; g.textBaseline = 'top';
    g.fillText('N', S * 0.5, 5 * this.dpr);
    g.strokeStyle = 'rgba(230,241,251,0.55)';
    g.lineWidth = 1 * this.dpr;
    g.beginPath();
    g.moveTo(S * 0.5, 17 * this.dpr); g.lineTo(S * 0.5, 23 * this.dpr);
    g.stroke();

    // Chart border: an ink keyline inside the panel's own hairline. It closes
    // the drawing off from the frame the way a printed chart's neat line does,
    // and stops the terrain bleeding into the panel edge.
    g.strokeStyle = 'rgba(6,11,18,0.85)';
    g.lineWidth = 2 * this.dpr;
    g.strokeRect(1 * this.dpr, 1 * this.dpr, S - 2 * this.dpr, S - 2 * this.dpr);
    g.strokeStyle = 'rgba(158,199,230,0.28)';
    g.lineWidth = 1 * this.dpr;
    g.strokeRect(2.5 * this.dpr, 2.5 * this.dpr, S - 5 * this.dpr, S - 5 * this.dpr);

    g.restore();
  }
}

/** Smooth 2-D value noise built on the shared integer hash. */
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
