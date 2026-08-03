/**
 * Procedural livery generation: albedo, normal and roughness for one aircraft
 * type, on a single 2048² sheet.
 *
 * The pipeline, in order, because the order is the whole trick:
 *
 *  1. **Base coat, per-pixel.** A camouflage *field* is evaluated in model space
 *     — not in texture space — so the pattern is continuous across the wing
 *     root, over the spine and around the fuselage. The field is sampled at half
 *     resolution and thresholded at full resolution, which keeps hard-edged
 *     schemes hard while costing a quarter of the noise evaluations. The
 *     upper/under demarcation comes from the surface normal on wings and from a
 *     wavy waterline on the fuselage, which is how it was actually masked off.
 *  2. **Structure.** Panel lines follow spars, ribs, frames, longerons, gun bays
 *     and access hatches. Each line goes into three maps at once: a dark scribe
 *     plus an offset light highlight in albedo, a recess in the height field,
 *     and a dirt-roughened band in the roughness map. Rivet rows follow the
 *     lines.
 *  3. **Markings.** Insignia, codes, serials and stencilling, all drawn in
 *     *metres* through a per-region transform, so a 0.9 m roundel is 0.9 m on
 *     every surface regardless of that region's texel density.
 *  4. **Weathering.** Exhaust staining, oil from the cowl joint, gunpowder blast
 *     behind the ports, chipping on the walkway and hatch edges, mud behind the
 *     wheels, sun fade and grime in the panel-line crevices.
 *  5. **Derivation.** The height field becomes the normal map by Sobel.
 */

import * as THREE from 'three';
import type { AircraftSpec, Nation } from '../../shared/aircraft';
import type { FuselageProfile } from '../aircraft/fuselage';
import type { WingPlan } from '../aircraft/wing';
import { DETAIL, REGION, SWATCH, TEX_SIZE } from './atlas';
import type { Rect } from './atlas';
import {
  Rand, blurRegion, buildField, clamp01, ctx2d, drawText, fbm, hex, heightToNormal,
  makeSurface, makeTexture, mix, mixHex, overlayGrain, polyPath, rgba, rgbOf, roundRectPath,
  sampleField, scaleHex, scratches, smoothstep, softBlob, streak, vnoise, warpFbm, worley,
} from './canvas2d';
import type { Ctx2D, Surface } from './canvas2d';
import { drawInsignia, drawTailMarking } from './insignia';

export interface LiveryInput {
  spec: AircraftSpec;
  prof: FuselageProfile;
  wing: WingPlan;
  htail: WingPlan;
  fin: WingPlan;
  /** Exhaust stub tips in body space — origin of the soot streaks. */
  exhausts: THREE.Vector3[];
  /** Gun muzzles in body space — origin of the blast staining. */
  gunPorts: THREE.Vector3[];
  /** Hinge fractions so the panel layout matches the geometry exactly. */
  aileron: { eta0: number; eta1: number; hinge: number };
  flap: { eta0: number; eta1: number; hinge: number };
  elevator: { hinge: number };
  rudder: { hinge: number };
  seed: number;
  /** Half-resolution divisor for the camouflage field. 2 = half res. */
  fieldDiv?: number;
}

export interface LiveryMaps {
  albedo: THREE.CanvasTexture;
  normal: THREE.CanvasTexture;
  roughness: THREE.CanvasTexture;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Multi-target painter
// ---------------------------------------------------------------------------

interface Target { g: Ctx2D; s: number }

/**
 * Draws one logical feature into albedo, height and roughness simultaneously.
 * All coordinates are in albedo (2048) pixel space; the other two targets are
 * scaled into automatically, line widths included.
 */
class Painter {
  constructor(readonly alb: Target, private hgt: Target, private rgh: Target) {}

  private stroke(t: Target, pts: number[], w: number, style: string, dash?: number[]): void {
    if (w * t.s < 0.28) return;
    const g = t.g;
    g.save();
    g.scale(t.s, t.s);
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.lineWidth = w;
    g.strokeStyle = style;
    if (dash) g.setLineDash(dash);
    g.beginPath();
    g.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.stroke();
    g.restore();
  }

  /**
   * A scribed panel line. 'nx,ny' is the unit direction the light comes from in
   * texture space; the highlight is offset that way by one texel so the line
   * reads as a step in the surface and not as a painted stripe.
   */
  panelLine(pts: number[], nx = 0, ny = 1, strength = 1): void {
    // Grime halo first, widest and faintest.
    this.stroke(this.alb, pts, 4.5, `rgba(20,18,16,${0.045 * strength})`);
    this.stroke(this.alb, pts, 2.4, `rgba(24,22,20,${0.065 * strength})`);
    const hi = pts.slice();
    for (let i = 0; i < hi.length; i += 2) { hi[i] += nx * 1.2; hi[i + 1] += ny * 1.2; }
    this.stroke(this.alb, hi, 0.9, `rgba(255,252,244,${0.10 * strength})`);
    this.stroke(this.alb, pts, 1.05, `rgba(16,15,14,${0.26 * strength})`);
    this.stroke(this.hgt, pts, 2.2, `rgba(74,74,74,${0.85 * strength})`);
    this.stroke(this.rgh, pts, 3.0, `rgba(255,255,255,${0.28 * strength})`);
  }

  /** A butt joint between panels: lighter than a scribed line, no recess. */
  seam(pts: number[], strength = 0.6): void {
    this.stroke(this.alb, pts, 1.0, `rgba(20,19,17,${0.12 * strength})`);
    this.stroke(this.hgt, pts, 1.6, `rgba(100,100,100,${0.6 * strength})`);
  }

  /** Rivet row along a polyline. */
  rivets(pts: number[], spacing: number, r = 1.15, alpha = 1): void {
    const alb = this.alb.g, hgt = this.hgt.g;
    alb.save(); alb.scale(this.alb.s, this.alb.s);
    hgt.save(); hgt.scale(this.hgt.s, this.hgt.s);
    let carry = 0;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-3) continue;
      const ux = (bx - ax) / len, uy = (by - ay) / len;
      for (let d = carry; d < len; d += spacing) {
        const x = ax + ux * d, y = ay + uy * d;
        alb.fillStyle = `rgba(18,17,15,${0.20 * alpha})`;
        alb.beginPath(); alb.arc(x, y, r, 0, 6.2832); alb.fill();
        alb.fillStyle = `rgba(255,250,240,${0.14 * alpha})`;
        alb.beginPath(); alb.arc(x - 0.55, y - 0.55, r * 0.55, 0, 6.2832); alb.fill();
        if (r * this.hgt.s > 0.4) {
          hgt.fillStyle = `rgba(168,168,168,${0.75 * alpha})`;
          hgt.beginPath(); hgt.arc(x, y, r * 0.95, 0, 6.2832); hgt.fill();
        }
      }
      carry = spacing - ((len - carry) % spacing);
    }
    alb.restore(); hgt.restore();
  }

  /** Access panel: outline, corner fasteners and a faint tonal shift. */
  hatch(x: number, y: number, w: number, h: number, r: number, fasteners = 8, tone = 0.035): void {
    const alb = this.alb.g;
    alb.save(); alb.scale(this.alb.s, this.alb.s);
    roundRectPath(alb, x, y, w, h, r);
    alb.fillStyle = `rgba(255,255,255,${tone})`;
    alb.fill();
    alb.restore();

    const pts = [x, y, x + w, y, x + w, y + h, x, y + h, x, y];
    this.panelLine(pts, 0, 1, 1);
    const per = Math.max(2, Math.round(fasteners / 2));
    const ring: number[] = [];
    for (let i = 0; i <= per; i++) ring.push(x + (w * i) / per, y);
    for (let i = 1; i <= per; i++) ring.push(x + w, y + (h * i) / per);
    for (let i = 1; i <= per; i++) ring.push(x + w - (w * i) / per, y + h);
    for (let i = 1; i <= per; i++) ring.push(x, y + h - (h * i) / per);
    this.rivets(ring, Math.max(6, Math.min(w, h) / per), 1.5, 1.1);
  }
}

// ---------------------------------------------------------------------------
// Region coordinate frames — everything is drawn in metres
// ---------------------------------------------------------------------------

interface Frame {
  rect: Rect;
  /** metres → pixels */
  px(a: number, b: number): [number, number];
  sa: number;   // px per metre along axis a
  sb: number;   // px per metre along axis b
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function buildLivery(input: LiveryInput): LiveryMaps {
  const { spec, prof, wing, htail, fin } = input;
  const S = TEX_SIZE;
  const rnd = new Rand(input.seed || 12345);

  const alb: Surface = makeSurface(S, hex(spec.livery.under));
  const hgt: Surface = makeSurface(S >> 1, '#808080', true);
  const rgh: Surface = makeSurface(S >> 2, '#c4c4c4');
  const P = new Painter({ g: alb.g, s: 1 }, { g: hgt.g, s: 0.5 }, { g: rgh.g, s: 0.25 });

  paintBase(input, alb, rgh, rnd);
  paintSwatches(alb, rgh, hgt, spec, rnd);
  paintDetailRects(alb, rgh, spec, rnd);

  paintFuseStructure(P, input);
  paintWingStructure(P, input, true);
  paintWingStructure(P, input, false);
  paintTailStructure(P, input);

  paintMarkings(alb.g, input, rnd);
  paintStencils(alb.g, input, rnd);
  paintWeathering(alb, rgh, input, rnd);

  // Final grain, kept off the swatch strip so small parts stay clean-edged.
  overlayGrain(alb.g, REGION.fuse, 0.055, input.seed);
  overlayGrain(alb.g, REGION.wingTop, 0.05, input.seed + 3);
  overlayGrain(alb.g, REGION.wingBot, 0.05, input.seed + 7);

  const albedo = makeTexture(alb.canvas, { srgb: true, aniso: 8 });
  const normal = makeTexture(heightToNormal(hgt.canvas, 2.1), { srgb: false, aniso: 4 });
  const roughness = makeTexture(rgh.canvas, { srgb: false, aniso: 2 });

  return {
    albedo, normal, roughness,
    dispose() { albedo.dispose(); normal.dispose(); roughness.dispose(); },
  };
}

// ---------------------------------------------------------------------------
// 1. Base coat
// ---------------------------------------------------------------------------

interface ColSample { z: number; x: number; yBase: number; chord: number; leZ: number; rAvg: number }

/**
 * Camouflage field in model space, blended between a plan projection and a side
 * projection by how "upward-facing" the surface is. Thresholding this single
 * continuous field (rather than two thresholded patterns) is what keeps the
 * demarcation crisp while the pattern stays continuous around the fuselage.
 */
function camoField(
  pattern: string, seed: number, x: number, y: number, z: number, upness: number,
): number {
  const w = 1 - Math.min(1, Math.abs(upness));
  switch (pattern) {
    case 'splinter': {
      // Angular hard-edged cells — Soviet two-tone splinter.
      const c1 = worley(x * 0.46 + 3.1, z * 0.30, seed).id;
      const v1 = ((c1 >>> 5) & 255) / 255;
      const c2 = worley(y * 0.75 + 9.4, z * 0.30, seed + 51).id;
      const v2 = ((c2 >>> 5) & 255) / 255;
      return mix(v1, v2, w);
    }
    case 'blotch': {
      const a = fbm(x * 0.88, z * 0.68, 3, seed);
      const b = fbm(y * 1.36 + 5.0, z * 0.68, 3, seed + 61);
      return mix(a, b, w);
    }
    case 'mottle':
    case 'wave':
    default: {
      // Large soft-shouldered shapes with a strong domain warp: the RAF
      // day-fighter scheme and the Luftwaffe upper split both come from here,
      // only the threshold and edge hardness differ.
      //
      // The frequency matters more than it looks. At the original 0.30/0.24 a
      // Spitfire's 11 m span spans barely 1.7 units of noise, which is two or
      // three shapes over the whole aeroplane — so one colour covers a wing and
      // the other covers a wingtip and the scheme reads as a single flat brown.
      // The real 1940 pattern is four to five sinuous shapes per wing panel;
      // 0.52/0.42 puts it there.
      const a = warpFbm(x * 0.52, z * 0.42, 3, seed, 1.7);
      const b = warpFbm(y * 0.80 + 12.0, z * 0.42, 3, seed + 83, 1.7);
      return mix(a, b, w);
    }
  }
}

/**
 * The field value that splits the two camouflage colours 50/50.
 *
 * Thresholding fbm at a fixed 0.5 assumes the noise is symmetric about 0.5,
 * and it is not: the domain warp and the octave sum skew it, so whichever
 * colour happens to sit on the fat side of the distribution swallows most of
 * the airframe. Sampling the field over the aircraft's own bounding volume and
 * taking the median makes the split exact regardless of pattern, seed or how
 * anyone later retunes the frequencies. It is ~4k noise evaluations, once per
 * aircraft type, against a livery bake that already costs a hundred times that.
 *
 * A single threshold is shared by every region so a shape that crosses the wing
 * root or the tailplane joint does not step colour at the seam.
 */
function camoThreshold(pattern: string, seed: number, span: number, length: number): number {
  if (pattern === 'solid') return 0.5;
  const N = 48;
  const vals: number[] = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = (i / (N - 1) - 0.5) * span;
      const z = (j / (N - 1) - 0.5) * length;
      // Sweep y and the up/side projection blend too, since the field mixes a
      // plan and a side projection and the median has to cover both.
      const y = ((i * 7 + j * 5) % 13) / 13 - 0.35;
      const up = (((i + j) % 3) - 1) * 0.9;
      vals.push(camoField(pattern, seed, x, y, z, up));
    }
  }
  vals.sort((a, b) => a - b);
  return vals[vals.length >> 1];
}

/**
 * Pushes the two camouflage tones apart in value.
 *
 * The nominal colours are historically right but sit within about 6 % of each
 * other in luminance, and at gameplay distance under a banded cel ramp that is
 * no separation at all — the scheme reads as one flat colour with a slight hue
 * wobble. Real sprayed Dark Green over Dark Earth is closer to a 1.35:1 value
 * ratio. This spreads whichever tone is already darker down and the lighter one
 * up, symmetrically, so it works for every nation's pair without knowing which
 * of camoA/camoB is meant to be the dark one.
 */
const CAMO_SPREAD = 0.13;
function spreadTones(cA: number[], cB: number[]): [number[], number[]] {
  const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const k = lum(cA) < lum(cB) ? -CAMO_SPREAD : CAMO_SPREAD;
  const scale = (c: number[], f: number) => c.map((v) => Math.max(0, Math.min(255, v * (1 + f))));
  return [scale(cA, k), scale(cB, -k)];
}

/**
 * Threshold width in field units.
 *
 * These have to be *tiny*. The camouflage field varies slowly in space, so even
 * a 0.01-wide smoothstep spreads over twenty texels and the crisp masked edge of
 * an RAF day-fighter scheme turns into an airbrushed smudge. Bilinear
 * resampling of the half-resolution field already supplies about two texels of
 * anti-aliasing, which is all a sprayed-over-tape edge should have.
 */
function edgeSoftness(pattern: string): number {
  switch (pattern) {
    case 'splinter': return 0.0015;
    case 'wave': return 0.0025;
    case 'mottle': return 0.004;
    case 'blotch': return 0.045;
    default: return 0.004;
  }
}

function paintBase(input: LiveryInput, alb: Surface, rgh: Surface, rnd: Rand): void {
  const { spec, prof, wing, htail, fin } = input;
  const div = input.fieldDiv ?? 2;
  const L = spec.livery;
  const pat = spec.livery.pattern;

  // One 50/50 threshold per seed the field is evaluated with. The tail surfaces
  // use offset seeds so their pattern does not repeat the wing's; each still
  // needs its own median or the offset re-introduces the coverage skew.
  const span = spec.aero.span, len = spec.geom.length;
  const thFuse = camoThreshold(pat, input.seed, span, len);
  const thTail = camoThreshold(pat, input.seed + 11, span, len);
  const thFin = camoThreshold(pat, input.seed + 23, span, len);

  paintRegionBase(alb, rgh, REGION.fuse, div, L, spec.livery.pattern, input.seed, thFuse, 'fuse',
    (u) => {
      const z = prof.zOfT(u);
      const s = prof.at(z);
      return { z, x: 0, yBase: s.yc, chord: 0, leZ: 0, rAvg: (s.rx + s.ryTop + s.ryBot) / 3 };
    },
    (col, v, out) => {
      const th = v * Math.PI * 2;
      prof.point(col.z, th, _p3);
      out.x = _p3.x; out.y = _p3.y; out.z = _p3.z;
      // Cross-section normal is enough for the projection blend, and it is two
      // trig calls instead of four surface evaluations.
      const nx = Math.sin(th), ny = -Math.cos(th);
      out.up = -ny;
      // Camouflage waterline: masked off by eye along the fuselage side, so it
      // wanders by a few centimetres rather than running dead level.
      const wave = (vnoise(col.z * 1.15 + 3.3, 5.1, input.seed + 401) - 0.5) * 0.34 * prof.R;
      out.upper = _p3.y > prof.demarcY(col.z) + wave;
      out.chordFrac = 0;
      out.side = nx;
    });

  for (const [region, side] of [[REGION.wingTop, 1], [REGION.wingBot, -1]] as [Rect, number][]) {
    paintRegionBase(alb, rgh, region, div, L, spec.livery.pattern, input.seed, thFuse, 'wing',
      (u) => {
        const etaS = u * 2 - 1;
        const eta = Math.min(1, Math.abs(etaS));
        return {
          z: 0, x: Math.sign(etaS || 1) * eta * wing.run * Math.cos(wing.o.dihedral),
          yBase: wing.o.y0 + eta * wing.run * Math.sin(wing.o.dihedral),
          chord: wing.chordAt(eta), leZ: wing.leZAt(eta), rAvg: 1,
        };
      },
      (col, v, out) => {
        out.x = col.x; out.y = col.yBase; out.z = col.leZ - v * col.chord;
        out.up = side;
        // The undersurface colour wraps a little way round the leading edge, as
        // it does when a real aircraft is masked and sprayed.
        out.upper = side > 0 || v < 0.035;
        out.chordFrac = v;
        out.side = 0;
      });
  }

  for (const [region, side] of [[REGION.htailTop, 1], [REGION.htailBot, -1]] as [Rect, number][]) {
    paintRegionBase(alb, rgh, region, div, L, spec.livery.pattern, input.seed + 11, thTail, 'wing',
      (u) => {
        const etaS = u * 2 - 1;
        const eta = Math.min(1, Math.abs(etaS));
        return {
          z: 0, x: Math.sign(etaS || 1) * eta * htail.run, yBase: htail.o.y0,
          chord: htail.chordAt(eta), leZ: htail.leZAt(eta), rAvg: 1,
        };
      },
      (col, v, out) => {
        out.x = col.x; out.y = col.yBase; out.z = col.leZ - v * col.chord;
        out.up = side;
        out.upper = side > 0 || v < 0.05;
        out.chordFrac = v;
        out.side = 0;
      });
  }

  // Fin: vertical, so it is upper-surface camouflage all over.
  paintRegionBase(alb, rgh, REGION.fin, div, L, spec.livery.pattern, input.seed + 23, thFin, 'fin',
    (u) => {
      const cf = u < 0.5 ? u * 2 : (1 - u) * 2;
      return { z: 0, x: 0, yBase: 0, chord: 1, leZ: 0, rAvg: cf };
    },
    (col, v, out) => {
      const eta = 1 - v;
      out.x = (col.rAvg - 0.5) * fin.chordAt(eta) * 0.6;
      out.y = fin.o.y0 + eta * fin.run;
      out.z = fin.leZAt(eta) - col.rAvg * fin.chordAt(eta);
      out.up = 0;
      out.upper = true;
      out.chordFrac = col.rAvg;
      out.side = 0;
    });
}

interface PixOut { x: number; y: number; z: number; up: number; upper: boolean; chordFrac: number; side: number }
const _p3 = new THREE.Vector3();

function paintRegionBase(
  alb: Surface, rgh: Surface, rect: Rect, div: number,
  L: AircraftSpec['livery'], pattern: string, seed: number, thresh: number, kind: string,
  col: (u: number) => ColSample,
  at: (col: ColSample, v: number, out: PixOut) => void,
): void {
  const W = rect.w, H = rect.h;
  const fw = Math.max(4, Math.ceil(W / div)), fh = Math.max(4, Math.ceil(H / div));
  const out: PixOut = { x: 0, y: 0, z: 0, up: 0, upper: true, chordFrac: 0, side: 0 };

  // Half-resolution scalar fields. Columns share a surface sample, which is why
  // the loft can be queried at all without dominating the load time.
  const camo = new Float32Array(fw * fh);
  const upperMask = new Float32Array(fw * fh);
  const tone = new Float32Array(fw * fh);
  for (let i = 0; i < fw; i++) {
    const c = col((i + 0.5) / fw);
    for (let j = 0; j < fh; j++) {
      at(c, (j + 0.5) / fh, out);
      const k = j * fw + i;
      camo[k] = camoField(pattern, seed, out.x, out.y, out.z, out.up);
      upperMask[k] = out.upper ? 1 : 0;
      // Panel-to-panel tonal variation: each structural bay took paint slightly
      // differently, and on bare metal each sheet is a different alloy batch.
      const cell = worley(out.z * 1.45 + 20, (Math.abs(out.x) + out.y * 0.7) * 1.15, seed + 909);
      tone[k] = ((cell.id >>> 9) & 255) / 255 - 0.5;
    }
  }
  const fCamo = { w: fw, h: fh, data: camo };
  const fTone = { w: fw, h: fh, data: tone };

  const soft = edgeSoftness(pattern);
  const solid = pattern === 'solid';
  const toneAmp = solid ? 0.085 : 0.032;

  const g = alb.g;
  const img = g.createImageData(W, H);
  const d = img.data;
  const [cA, cB] = spreadTones(rgbOf(L.camoA), rgbOf(L.camoB));
  // Undersurface, knocked back 13 %. The nominal Sky / Medium Sea Grey values
  // are correct as paint chips, but a belly is lit by skylight from every
  // direction and then picks up the rim and specular terms on top, so at the
  // nominal value it renders within a few per cent of white — the panel lines,
  // the wheel-well shadows and the radiator fairings all disappear and the
  // aeroplane reads as a blank plastic shape from below. Every hero framing in
  // the harness looks up at the subject, so this is the face most often seen.
  const cU = rgbOf(L.under).map((v) => v * 0.87);

  const rg = rgh.g;
  const rImg = rg.createImageData(Math.ceil(W / 4), Math.ceil(H / 4));
  const rd = rImg.data;

  const fUpper = { w: fw, h: fh, data: upperMask };
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const k = (y * W + x) * 4;
      const cf = sampleField(fCamo, u, v);
      const um = sampleField(fUpper, u, v);
      const tn = sampleField(fTone, u, v) * toneAmp;

      let r: number, gg: number, b: number;
      if (um < 0.5) {
        r = cU[0]; gg = cU[1]; b = cU[2];
      } else if (solid) {
        r = cA[0]; gg = cA[1]; b = cA[2];
      } else {
        const t = smoothstep(thresh - soft, thresh + soft, cf);
        r = mix(cA[0], cB[0], t); gg = mix(cA[1], cB[1], t); b = mix(cA[2], cB[2], t);
      }
      // Sun fade on upper surfaces, applied as a lift toward warm grey rather
      // than a brightness scale so the hue drifts the way real enamel does.
      if (um >= 0.5) {
        const fade = 0.045 + 0.05 * fbm(u * 6, v * 6, 2, seed + 77);
        r = mix(r, 196, fade); gg = mix(gg, 190, fade); b = mix(b, 178, fade * 0.8);
      }
      const k2 = 1 + tn;
      d[k] = Math.min(255, r * k2);
      d[k + 1] = Math.min(255, gg * k2);
      d[k + 2] = Math.min(255, b * k2);
      d[k + 3] = 255;
    }
  }
  g.putImageData(img, rect.x, rect.y);

  // Roughness: matte camouflage, glossier where the paint is thin over rivets
  // and on the undersurface (which was usually a lighter, glossier dope).
  const rw = rImg.width, rh = rImg.height;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const u = (x + 0.5) / rw, v = (y + 0.5) / rh;
      const um = sampleField(fUpper, u, v);
      const n = fbm(u * 9, v * 9, 3, seed + 313);
      let rough = solid ? 88 : um < 0.5 ? 176 : 206;
      rough += (n - 0.5) * 46;
      const k = (y * rw + x) * 4;
      rd[k] = rd[k + 1] = rd[k + 2] = Math.max(0, Math.min(255, rough));
      rd[k + 3] = 255;
    }
  }
  rg.putImageData(rImg, Math.round(rect.x / 4), Math.round(rect.y / 4));
}

// ---------------------------------------------------------------------------
// 2. Structure
// ---------------------------------------------------------------------------

function fuseFrame(prof: FuselageProfile): Frame {
  const r = REGION.fuse;
  const len = prof.noseZ - prof.tailZ;
  return {
    rect: r,
    sa: r.w / len,
    sb: r.h,   // per turn; callers convert with the local circumference
    px(z: number, theta01: number) {
      return [r.x + ((prof.noseZ - z) / len) * r.w, r.y + theta01 * r.h];
    },
  };
}

function paintFuseStructure(P: Painter, input: LiveryInput): void {
  const { prof, spec } = input;
  const F = fuseFrame(prof);
  const rnd = new Rand(input.seed + 5);
  const R = prof.R;

  // --- longerons, running the full length -----------------------------------
  // Only the structural longerons show as skin joints; the intermediate
  // stringers are under the skin and are read from the rivet rows, not from
  // lines. Drawing every stringer is what turns a fuselage into graph paper.
  const stringers = [0.06, 0.22, 0.50, 0.78, 0.94];
  for (const th of stringers) {
    const pts: number[] = [];
    for (let i = 0; i <= 22; i++) {
      const t = i / 22;
      const z = prof.zOfT(t * 0.995);
      // Longerons converge toward the tail as the section shrinks.
      const conv = 0.5 + (th - 0.5) * (0.60 + 0.40 * (1 - t));
      const [x, y] = F.px(z, conv);
      pts.push(x, y);
    }
    const major = Math.abs(th - 0.22) < 0.02 || Math.abs(th - 0.78) < 0.02;
    P.panelLine(pts, 0, -1, major ? 0.9 : 0.45);
    P.rivets(pts, 8.5, 1.05, major ? 0.75 : 0.45);
  }
  // Rivet-only stringer rows between the longerons.
  for (const th of [0.13, 0.35, 0.65, 0.87]) {
    const pts: number[] = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const conv = 0.5 + (th - 0.5) * (0.60 + 0.40 * (1 - t));
      const [x, y] = F.px(prof.zOfT(t * 0.98), conv);
      pts.push(x, y);
    }
    P.rivets(pts, 9.5, 1.0, 0.45);
  }

  // --- transverse frames ----------------------------------------------------
  const frameSpacing = 0.68;
  const nFrames = Math.floor((prof.noseZ - prof.tailZ) / frameSpacing);
  for (let i = 1; i < nFrames; i++) {
    const z = prof.noseZ - i * frameSpacing;
    const t = prof.tOfZ(z);
    const pts: number[] = [];
    for (let j = 0; j <= 24; j++) {
      const [x, y] = F.px(z, j / 24);
      pts.push(x, y);
    }
    // Cowl frames are quick-release joints; aft frames are riveted skin joints.
    const isCowl = t < 0.22;
    P.panelLine(pts, 1, 0, isCowl ? 0.95 : 0.55);
    P.rivets(pts, isCowl ? 5.5 : 9.0, isCowl ? 1.45 : 1.0, isCowl ? 1.0 : 0.6);
  }

  // --- cowl split lines -----------------------------------------------------
  const zCowl0 = prof.noseZ - 0.03, zCowl1 = prof.zOfT(0.24);
  for (const th of [0.5, 0.0, 0.30, 0.70]) {
    const pts: number[] = [];
    for (let i = 0; i <= 10; i++) {
      const z = zCowl0 + (zCowl1 - zCowl0) * (i / 10);
      const [x, y] = F.px(z, th);
      pts.push(x, y);
    }
    P.panelLine(pts, 0, -1, 1);
    P.rivets(pts, 5.0, 1.5, 1.2);
  }

  // --- access hatches -------------------------------------------------------
  const hatchAt = (z: number, th: number, wM: number, hTurns: number, fast = 10) => {
    const [x, y] = F.px(z, th);
    const w = wM * F.sa;
    const h = hTurns * F.rect.h;
    P.hatch(x - w / 2, y - h / 2, w, h, Math.min(w, h) * 0.16, fast);
  };
  // Radio / battery hatch behind the cockpit, port side.
  hatchAt(spec.geom.canopy.z1 - 0.55, 0.74, 0.46, 0.085, 10);
  // Oxygen and first-aid hatches.
  hatchAt(spec.geom.canopy.z1 - 1.30, 0.28, 0.30, 0.06, 8);
  hatchAt(spec.geom.canopy.z1 - 1.95, 0.70, 0.26, 0.052, 8);
  // Fuel filler on the spine ahead of the windscreen.
  hatchAt(spec.geom.canopy.z0 + 0.42, 0.50, 0.24, 0.05, 6);
  // Tail-plane and control-run inspection panels along the lower flanks.
  for (let i = 0; i < 4; i++) {
    const z = spec.geom.canopy.z1 - 1.0 - i * 0.85;
    hatchAt(z, 0.155 + (i % 2) * 0.69, 0.20, 0.042, 6);
  }
  // Engine bearer / accessory panels on the cowl sides.
  hatchAt(prof.zOfT(0.13), 0.27, R * 0.9, 0.10, 12);
  hatchAt(prof.zOfT(0.13), 0.73, R * 0.9, 0.10, 12);

  void rnd;
}

function paintWingStructure(P: Painter, input: LiveryInput, upper: boolean): void {
  const { wing, spec } = input;
  const r = upper ? REGION.wingTop : REGION.wingBot;
  const px = (etaS: number, cf: number): [number, number] =>
    [r.x + (0.5 + 0.5 * etaS) * r.w, r.y + cf * r.h];

  // --- spanwise structure: spars, LE joint, hinge lines ---------------------
  const spanLine = (cf: number, e0: number, e1: number, strength: number, riv: number) => {
    for (const sgn of [-1, 1]) {
      const pts: number[] = [];
      for (let i = 0; i <= 16; i++) {
        const eta = e0 + (e1 - e0) * (i / 16);
        pts.push(...px(sgn * eta, cf));
      }
      P.panelLine(pts, 0, -1, strength);
      if (riv > 0) P.rivets(pts, riv, 1.2, 0.9);
    }
  };
  spanLine(0.055, 0, 1, 0.85, 6.5);                 // leading-edge skin joint
  spanLine(0.25, 0, 1, 1.0, 6.0);                   // main spar
  spanLine(0.62, 0, 1, 0.85, 7.5);                  // rear spar
  spanLine(0.965, 0, 1, 0.7, 0);                    // trailing edge

  const ail = input.aileron, fl = input.flap;
  spanLine(ail.hinge, ail.eta0, ail.eta1, 1.0, 5.0);
  spanLine(fl.hinge, fl.eta0, fl.eta1, 1.0, 5.0);
  // Control-surface end ribs.
  for (const e of [ail.eta0, ail.eta1, fl.eta0, fl.eta1]) {
    for (const sgn of [-1, 1]) {
      P.panelLine([...px(sgn * e, ail.hinge > 0 ? Math.min(ail.hinge, fl.hinge) - 0.03 : 0.7), ...px(sgn * e, 1)], 1, 0, 0.8);
    }
  }

  // --- ribs -----------------------------------------------------------------
  // Ribs are under a stressed skin: they show as rivet rows, and only the
  // heavier ones (every third, at the fuel-bay and gun-bay bulkheads) as a
  // visible joint.
  const ribStep = 0.44;   // metres of span
  const ribs = Math.floor(wing.run / ribStep);
  for (let i = 1; i <= ribs; i++) {
    const eta = (i * ribStep) / wing.run;
    if (eta > 0.995) break;
    for (const sgn of [-1, 1]) {
      const pts = [...px(sgn * eta, 0.02), ...px(sgn * eta, 0.25), ...px(sgn * eta, 0.62), ...px(sgn * eta, 0.96)];
      if (i % 3 === 0) P.seam(pts, 0.75);
      P.rivets(pts, 9, 1.0, i % 3 === 0 ? 0.65 : 0.4);
    }
  }

  // --- gun bays and ammo hatches -------------------------------------------
  const wingGuns = input.gunPorts.filter((g) => Math.abs(g.x) > 0.6);
  for (const gun of wingGuns) {
    const eta = Math.abs(gun.x) / wing.run;
    const sgn = Math.sign(gun.x);
    const [cx, cy] = px(sgn * eta, 0.30);
    const w = 0.42 * (r.w / (2 * wing.run));
    const h = 0.34 * r.h;
    P.hatch(cx - w / 2, cy - h * 0.5, w, h, 6, 12, upper ? 0.03 : 0.05);
    // Ammunition bay outboard of the gun.
    const [ax, ay] = px(sgn * Math.min(0.96, eta + 0.13), 0.42);
    P.hatch(ax - w * 0.6, ay - h * 0.35, w * 1.2, h * 0.7, 6, 10, 0.025);
  }

  // --- wheel wells / gear doors on the underside ----------------------------
  if (!upper) {
    const trackEta = (spec.geom.gear.track * 0.5) / wing.run;
    for (const sgn of [-1, 1]) {
      const [cx, cy] = px(sgn * trackEta, 0.34);
      const w = 0.55 * (r.w / (2 * wing.run));
      const h = 0.30 * r.h;
      // Darken the bay so the well reads as an opening rather than an outline.
      const alb = P.alb.g;
      alb.save();
      alb.fillStyle = 'rgba(28,34,26,0.55)';
      alb.fillRect(cx - w / 2, cy - h / 2, w, h);
      alb.fillStyle = 'rgba(10,12,10,0.35)';
      alb.fillRect(cx - w / 2 + 3, cy - h / 2 + 3, w - 6, h * 0.45);
      alb.restore();
      P.panelLine([cx - w / 2, cy - h / 2, cx + w / 2, cy - h / 2, cx + w / 2, cy + h / 2, cx - w / 2, cy + h / 2, cx - w / 2, cy - h / 2], 0, 1, 1.1);
      P.rivets([cx - w / 2, cy - h / 2, cx + w / 2, cy - h / 2], 6, 1.3, 1);
    }
    // Radiator/oil-cooler fairing outlines.
    if (spec.geom.intake === 'underwing') {
      for (const sgn of [-1, 1]) {
        const [cx, cy] = px(sgn * 0.30, 0.52);
        const w = 0.5 * (r.w / (2 * wing.run));
        const h = 0.26 * r.h;
        P.hatch(cx - w / 2, cy - h / 2, w, h, 8, 14, 0.05);
      }
    }
  }

  // --- wing-root walkway ----------------------------------------------------
  if (upper) {
    for (const sgn of [-1, 1]) {
      const e0 = 0.04, e1 = 0.30;
      const [x0, y0] = px(sgn * e0, 0.18);
      const [x1, y1] = px(sgn * e1, 0.70);
      const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
      P.panelLine([xa, y0, xb, y0, xb, y1, xa, y1, xa, y0], 0, 1, 0.9);
    }
  }
}

function paintTailStructure(P: Painter, input: LiveryInput): void {
  const { htail, fin } = input;
  for (const [r, ] of [[REGION.htailTop], [REGION.htailBot]] as [Rect][]) {
    const px = (etaS: number, cf: number): [number, number] =>
      [r.x + (0.5 + 0.5 * etaS) * r.w, r.y + cf * r.h];
    for (const cf of [0.08, 0.30, input.elevator.hinge, 0.95]) {
      for (const sgn of [-1, 1]) {
        const pts: number[] = [];
        for (let i = 0; i <= 8; i++) pts.push(...px(sgn * (i / 8), cf));
        P.panelLine(pts, 0, -1, cf === input.elevator.hinge ? 1 : 0.7);
        P.rivets(pts, 7, 1.0, 0.7);
      }
    }
    const ribs = Math.max(3, Math.floor(htail.run / 0.35));
    for (let i = 1; i < ribs; i++) {
      const eta = i / ribs;
      for (const sgn of [-1, 1]) P.seam([...px(sgn * eta, 0.05), ...px(sgn * eta, 0.95)], 0.55);
    }
  }

  const rf = REGION.fin;
  const fpx = (half: number, cf: number, eta: number): [number, number] =>
    [rf.x + (half === 0 ? 0.5 * cf : 1 - 0.5 * cf) * rf.w, rf.y + (1 - eta) * rf.h];
  for (const half of [0, 1]) {
    for (const cf of [0.10, 0.34, input.rudder.hinge, 0.95]) {
      const pts: number[] = [];
      for (let i = 0; i <= 8; i++) pts.push(...fpx(half, cf, i / 8));
      P.panelLine(pts, half === 0 ? 1 : -1, 0, cf === input.rudder.hinge ? 1 : 0.7);
      P.rivets(pts, 7, 1.0, 0.7);
    }
    const ribs = Math.max(3, Math.floor(fin.run / 0.30));
    for (let i = 1; i < ribs; i++) {
      const eta = i / ribs;
      P.seam([...fpx(half, 0.05, eta), ...fpx(half, 0.95, eta)], 0.5);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Markings
// ---------------------------------------------------------------------------

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function makeCodes(nation: Nation, rnd: Rand): { squadron: string; individual: string; serial: string } {
  const L = () => CODE_LETTERS[rnd.int(CODE_LETTERS.length)];
  const D = () => String(rnd.int(10));
  switch (nation) {
    case 'britain': return { squadron: `${L()}${L()}`, individual: L(), serial: `${L()}${L()}${D()}${D()}${D()}` };
    case 'usa': return { squadron: `${L()}${L()}`, individual: L(), serial: `4${D()}-${D()}${D()}${D()}${D()}${D()}` };
    case 'germany': return { squadron: `${rnd.int(9) + 1}`, individual: '', serial: `${D()}${D()}${D()}${D()}${D()}${D()}` };
    case 'japan': return { squadron: `${D()}${D()}${D()}`, individual: '', serial: `${D()}-${D()}${D()}${D()}` };
    default: return { squadron: `${rnd.int(89) + 10}`, individual: '', serial: `${D()}${D()}${D()}${D()}${D()}` };
  }
}

function paintMarkings(g: Ctx2D, input: LiveryInput, rnd: Rand): void {
  const { spec, prof, wing, htail, fin } = input;
  const nation = spec.livery.insignia;
  const codes = makeCodes(nation, rnd);
  const F = fuseFrame(prof);
  const R = prof.R;

  // --- fuselage sides -------------------------------------------------------
  // Insignia sit aft of the wing trailing edge on every one of these types.
  // Aft of both the wing-root fairing and the cockpit: the fillet is unwrapped
  // into this same region, so an insignia that overlaps it gets painted onto the
  // fairing as well and shows up as a second, sheared copy.
  const zIns = Math.min(spec.geom.canopy.z1 - 1.05, wing.teZAt(0) - 0.85);
  const circ = 2 * Math.PI * prof.at(zIns).rx;
  const pxPerM_arc = F.rect.h / Math.max(0.6, circ);
  const pxPerM_z = F.sa;
  const rIns = 0.48 * R * 1.55;

  for (const th of [0.27, 0.73]) {
    const [cx, cy] = F.px(zIns, th);
    g.save();
    g.translate(cx, cy);
    g.scale(pxPerM_z, pxPerM_arc);
    // Port side reads right-to-left in texture space; mirror so text is correct.
    if (th > 0.5) g.scale(-1, 1);
    drawInsignia(g, nation, 'fuselage', 0, 0, rIns);
    g.restore();
  }

  // Squadron / individual codes flanking the insignia (RAF and USAAF practice).
  const codeH = R * 1.15;
  if (nation === 'britain' || nation === 'usa') {
    for (const th of [0.27, 0.73]) {
      const ahead = th > 0.5 ? -1 : 1;
      const [cx, cy] = F.px(zIns + (rIns + codeH * 0.62) * 1.0, th);
      g.save(); g.translate(cx, cy); g.scale(pxPerM_z, pxPerM_arc);
      if (th > 0.5) g.scale(-1, 1);
      drawText(g, codes.squadron, 0, 0, {
        size: codeH, color: nation === 'britain' ? 0xa9b0a2 : 0x1b1b1b,
        align: 'center', weight: 800, squash: 0.78, tracking: codeH * 0.10,
      });
      g.restore();
      const [dx, dy] = F.px(zIns - (rIns + codeH * 0.55), th);
      g.save(); g.translate(dx, dy); g.scale(pxPerM_z, pxPerM_arc);
      if (th > 0.5) g.scale(-1, 1);
      drawText(g, codes.individual, 0, 0, {
        size: codeH, color: nation === 'britain' ? 0xa9b0a2 : 0x1b1b1b,
        align: 'center', weight: 800, squash: 0.78,
      });
      g.restore();
      void ahead;
    }
  } else if (nation === 'germany') {
    // Staffel chevron / bar ahead of the cross.
    for (const th of [0.27, 0.73]) {
      const [cx, cy] = F.px(zIns + rIns * 1.9, th);
      g.save(); g.translate(cx, cy); g.scale(pxPerM_z, pxPerM_arc);
      g.fillStyle = rgba(spec.livery.accent, 0.9);
      polyPath(g, [-R * 0.5, R * 0.45, 0, -R * 0.45, R * 0.12, -R * 0.45, -R * 0.38, R * 0.45]);
      g.fill();
      g.restore();
    }
  } else if (nation === 'ussr') {
    for (const th of [0.27, 0.73]) {
      const [cx, cy] = F.px(zIns + rIns * 2.1, th);
      g.save(); g.translate(cx, cy); g.scale(pxPerM_z, pxPerM_arc);
      if (th > 0.5) g.scale(-1, 1);
      drawText(g, codes.squadron, 0, 0, { size: R * 1.4, color: 0xf2ece0, align: 'center', weight: 800, outline: 0x232323, outlineWidth: R * 0.09 });
      g.restore();
    }
  }

  // Small serial on the rear fuselage.
  for (const th of [0.30, 0.70]) {
    const [cx, cy] = F.px(prof.tailZ + 1.35, th);
    g.save(); g.translate(cx, cy); g.scale(pxPerM_z, pxPerM_arc);
    if (th > 0.5) g.scale(-1, 1);
    drawText(g, codes.serial, 0, 0, {
      size: R * 0.30, color: 0x22201d, alpha: 0.85, align: 'center', weight: 700, squash: 0.8,
    });
    g.restore();
  }

  // --- wings ----------------------------------------------------------------
  const wr = { top: REGION.wingTop, bot: REGION.wingBot };
  const wingEta = 0.55;
  const wingCf = 0.44;
  const rWing = 0.55 * Math.min(1.4, wing.chordAt(wingEta));
  const drawWing = (region: Rect, side: 'wingUpper' | 'wingLower', halves: number[]) => {
    const sx = region.w / (2 * wing.run);
    const sy = region.h / wing.chordAt(wingEta);
    for (const sgn of halves) {
      const cx = region.x + (0.5 + 0.5 * sgn * wingEta) * region.w;
      const cy = region.y + wingCf * region.h;
      g.save(); g.translate(cx, cy); g.scale(sx, sy);
      drawInsignia(g, nation, side, 0, 0, rWing);
      g.restore();
    }
  };
  if (nation === 'usa') {
    // AN-I-9b: left upper surface and right lower surface only.
    drawWing(wr.top, 'wingUpper', [-1]);
    drawWing(wr.bot, 'wingLower', [1]);
  } else if (nation === 'ussr') {
    drawWing(wr.bot, 'wingLower', [-1, 1]);
    drawWing(wr.top, 'wingUpper', [-1, 1]);
  } else {
    drawWing(wr.top, 'wingUpper', [-1, 1]);
    drawWing(wr.bot, 'wingLower', [-1, 1]);
  }

  // --- fin ------------------------------------------------------------------
  const rf = REGION.fin;
  for (const half of [0, 1]) {
    g.save();
    const x0 = rf.x + half * rf.w * 0.5;
    if (half === 1) { g.translate(x0 + rf.w * 0.5, rf.y); g.scale(-1, 1); }
    else { g.translate(x0, rf.y); }
    drawTailMarking(g, nation, 0, 0, rf.w * 0.5, rf.h, { rnd, accent: spec.livery.accent, serial: codes.serial });
    g.restore();
  }
  void htail; void fin;
}

// ---------------------------------------------------------------------------
// 4. Stencilling
// ---------------------------------------------------------------------------

function paintStencils(g: Ctx2D, input: LiveryInput, rnd: Rand): void {
  const { spec, prof, wing } = input;
  const F = fuseFrame(prof);
  const R = prof.R;
  const ink = 0x24211d;

  // Walkway boundary + NO STEP on the upper wing root.
  const rt = REGION.wingTop;
  // Texel density along each wing axis, so stencils come out the right size in
  // metres and are not stretched by the region's aspect ratio.
  const pxPerM_span = rt.w / (2 * wing.run);
  const pxPerM_chord = rt.h / wing.o.rootChord;
  for (const sgn of [-1, 1]) {
    const e0 = 0.045, e1 = 0.30;
    const x0 = rt.x + (0.5 + 0.5 * sgn * e0) * rt.w;
    const x1 = rt.x + (0.5 + 0.5 * sgn * e1) * rt.w;
    const y0 = rt.y + 0.17 * rt.h, y1 = rt.y + 0.71 * rt.h;
    g.save();
    g.setLineDash([9, 7]);
    g.lineWidth = 2.2;
    g.strokeStyle = rgba(0xe8e2d4, 0.45);
    g.strokeRect(Math.min(x0, x1), y0, Math.abs(x1 - x0), y1 - y0);
    g.setLineDash([]);
    g.restore();
    // NO STEP just outboard of the walkway, reading spanwise (i.e. along the
    // texture's u axis) and always left-to-right on the surface.
    const xs = rt.x + (0.5 + 0.5 * sgn * 0.375) * rt.w;
    g.save();
    g.translate(xs, rt.y + 0.30 * rt.h);
    // Seen from above with the nose up, the wing-top unwrap's u axis runs
    // right-to-left across the screen, so upper-surface lettering has to be
    // mirrored in texture space to read forwards on the aircraft.
    g.scale(-1, 1);
    drawText(g, 'NO STEP', 0, 0, {
      size: 0.075 * pxPerM_chord, color: 0xe6e0d2, alpha: 0.62, align: 'center',
      weight: 800, squash: 0.78 * (pxPerM_span / pxPerM_chord) * 2.2, stencil: false,
    });
    g.restore();
  }

  // Fuel filler triangle + grade, on the spine.
  const [fx, fy] = F.px(spec.geom.canopy.z0 + 0.42, 0.50);
  g.save();
  g.translate(fx, fy + 22);
  g.fillStyle = rgba(0xe4d7a0, 0.85);
  polyPath(g, [0, -13, 11, 8, -11, 8]);
  g.fill();
  drawText(g, spec.nation === 'usa' ? '100/130' : '87 OCT', 0, 22, {
    size: 11, color: 0xe8e2d4, alpha: 0.7, align: 'center', weight: 700, squash: 0.8,
  });
  g.restore();

  // Handhold / rescue markings by the cockpit.
  for (const th of [0.30, 0.70]) {
    const [hx, hy] = F.px(spec.geom.canopy.z1 - 0.10, th);
    g.save();
    g.translate(hx, hy);
    if (th > 0.5) g.scale(-1, 1);
    drawText(g, 'PUSH', 0, 0, { size: 12, color: 0xe0dbcd, alpha: 0.62, align: 'center', weight: 700, squash: 0.78 });
    g.strokeStyle = rgba(0xe0dbcd, 0.5);
    g.lineWidth = 1.6;
    g.strokeRect(-16, -9, 32, 18);
    g.restore();
  }

  // Rescue arrow / first-aid on the rear fuselage.
  for (const th of [0.22, 0.78]) {
    const [ax, ay] = F.px(spec.geom.canopy.z1 - 1.95, th);
    g.save(); g.translate(ax, ay);
    if (th > 0.5) g.scale(-1, 1);
    drawText(g, 'FIRST AID', 0, -13, { size: 9, color: ink, alpha: 0.6, align: 'center', weight: 700, squash: 0.78 });
    g.restore();
  }

  // Undersurface stencilling: jacking points and lifting-tube marks.
  const rb = REGION.wingBot;
  for (const sgn of [-1, 1]) {
    const x = rb.x + (0.5 + 0.5 * sgn * 0.22) * rb.w;
    drawText(g, 'JACK', x, rb.y + 0.30 * rb.h, {
      size: 13, color: 0x2a2723, alpha: 0.55, align: 'center', weight: 700, squash: 0.75,
    });
  }

  void R; void rnd;
}

// ---------------------------------------------------------------------------
// 5. Weathering
// ---------------------------------------------------------------------------

function paintWeathering(alb: Surface, rgh: Surface, input: LiveryInput, rnd: Rand): void {
  const { spec, prof, wing } = input;
  const g = alb.g;
  const rg = rgh.g;
  const F = fuseFrame(prof);
  const R = prof.R;
  const soot = 0x211d18;

  // --- exhaust staining -----------------------------------------------------
  // Streaks start at the stub, run aft and are dragged slightly outboard and
  // down by the slipstream over the fuselage flank.
  for (const e of input.exhausts) {
    const th = ((Math.atan2(e.x, -e.y) / (Math.PI * 2)) % 1 + 1) % 1;
    const [x0, y0] = F.px(e.z - 0.05, th);
    const [x1] = F.px(e.z - 2.6, th);
    const dy = (th < 0.5 ? 1 : -1) * F.rect.h * 0.035;
    streak(g, x0, y0, x1 - x0, dy, 7, 22, soot, 0.30, 0.0, 22);
    streak(g, x0, y0, (x1 - x0) * 0.55, dy * 0.5, 4, 10, soot, 0.34, 0.02, 14);
    // Roughness: soot is dead matte.
    rg.save();
    rg.globalAlpha = 0.5;
    rg.fillStyle = '#ffffff';
    rg.beginPath();
    rg.ellipse((x0 + x1) * 0.5 / 4, (y0 + dy * 0.5) / 4, Math.abs(x1 - x0) * 0.5 / 4, 7, 0, 0, 6.283);
    rg.fill();
    rg.restore();
  }
  // Exhaust wash across the wing root on inline engines.
  if (spec.engine.kind === 'inline') {
    const rt = REGION.wingTop;
    for (const sgn of [-1, 1]) {
      const x = rt.x + (0.5 + 0.5 * sgn * 0.07) * rt.w;
      streak(g, x, rt.y + 0.06 * rt.h, sgn * rt.w * 0.022, rt.h * 0.62, 6, 15, soot, 0.07, 0, 14);
    }
  }

  // --- oil from the cowl joint ----------------------------------------------
  const zCowl = prof.zOfT(0.24);
  for (let i = 0; i < 7; i++) {
    const th = 0.5 + (rnd.next() - 0.5) * 0.9;
    const thb = ((th % 1) + 1) % 1;
    const [x0, y0] = F.px(zCowl, thb);
    const [x1] = F.px(zCowl - rnd.range(0.6, 2.2), thb);
    streak(g, x0, y0, x1 - x0, rnd.gauss(6), 2.4, 5, 0x14100b, rnd.range(0.16, 0.34), 0, 14);
  }
  // Belly oil pooling behind the engine and the radiator exit.
  const [bx, by] = F.px(zCowl - 0.4, 0.0);
  softBlob(g, bx, by, 60, rgba(0x140f0a, 0.30), 1, 0.1);
  softBlob(g, bx, by + F.rect.h, 60, rgba(0x140f0a, 0.30), 1, 0.1);

  // --- gunpowder blast staining --------------------------------------------
  for (const gun of input.gunPorts) {
    if (Math.abs(gun.x) > 0.6) {
      // Wing gun: soot fans back over both surfaces from the muzzle.
      const eta = Math.abs(gun.x) / wing.run;
      const sgn = Math.sign(gun.x);
      for (const region of [REGION.wingTop, REGION.wingBot]) {
        const cx = region.x + (0.5 + 0.5 * sgn * eta) * region.w;
        const cy = region.y + 0.03 * region.h;
        streak(g, cx, cy, sgn * region.w * 0.012, region.h * 0.55, 5, 20, soot, 0.26, 0, 16);
      }
    } else {
      // Cowl gun: stain runs back along the fuselage top.
      const th = ((Math.atan2(gun.x, -gun.y) / (Math.PI * 2)) % 1 + 1) % 1;
      const [x0, y0] = F.px(gun.z - 0.1, th);
      const [x1] = F.px(gun.z - 1.5, th);
      streak(g, x0, y0, x1 - x0, 0, 5, 13, soot, 0.24, 0, 14);
    }
  }

  // --- paint chipping -------------------------------------------------------
  // Chips are bare metal with a dark lip: draw the light core, then a thin dark
  // edge on the downstream side. Concentrated where boots and spanners go.
  const chip = (rect: Rect, cx: number, cy: number, spread: number, count: number, size: number) => {
    for (let i = 0; i < count; i++) {
      const x = cx + rnd.gauss(spread);
      const y = cy + rnd.gauss(spread * 0.6);
      if (x < rect.x || x > rect.x + rect.w || y < rect.y || y > rect.y + rect.h) continue;
      const s = size * rnd.range(0.5, 1.6);
      g.fillStyle = rgba(0x9aa0a4, rnd.range(0.20, 0.52));
      g.beginPath();
      g.ellipse(x, y, s, s * rnd.range(0.5, 1.1), rnd.next() * 3.14, 0, 6.2832);
      g.fill();
      g.fillStyle = rgba(0x191713, 0.35);
      g.beginPath();
      g.ellipse(x + s * 0.4, y + s * 0.4, s * 0.75, s * 0.5, 0, 0, 6.2832);
      g.fill();
    }
  };
  const rt = REGION.wingTop;
  for (const sgn of [-1, 1]) {
    // Walkway.
    chip(rt, rt.x + (0.5 + 0.5 * sgn * 0.17) * rt.w, rt.y + 0.44 * rt.h, 26, 90, 1.9);
    // Wing root leading edge, stone damage.
    chip(rt, rt.x + (0.5 + 0.5 * sgn * 0.20) * rt.w, rt.y + 0.03 * rt.h, 40, 40, 1.3);
  }
  // Cowl fasteners and the cockpit sill get handled constantly.
  const [sx0, sy0] = F.px(spec.geom.canopy.z1 + 0.3, 0.415);
  chip(REGION.fuse, sx0, sy0, 16, 40, 1.2);
  const [sx1, sy1] = F.px(spec.geom.canopy.z1 + 0.3, 0.585);
  chip(REGION.fuse, sx1, sy1, 16, 40, 1.2);
  chip(REGION.fuse, ...F.px(prof.zOfT(0.13), 0.27), 24, 32, 1.1);
  chip(REGION.fuse, ...F.px(prof.zOfT(0.13), 0.73), 24, 32, 1.1);

  // --- mud spray behind the wheels ------------------------------------------
  const rb = REGION.wingBot;
  const trackEta = Math.min(0.95, (spec.geom.gear.track * 0.5) / wing.run);
  for (const sgn of [-1, 1]) {
    const cx = rb.x + (0.5 + 0.5 * sgn * trackEta) * rb.w;
    const cy = rb.y + 0.42 * rb.h;
    for (let i = 0; i < 130; i++) {
      const t = rnd.next();
      const x = cx + rnd.gauss(16);
      const y = cy + t * rb.h * 0.45;
      const a = 0.30 * (1 - t) * rnd.range(0.3, 1);
      g.fillStyle = rgba(0x6b5a42, a);
      g.beginPath();
      g.arc(x, y, rnd.range(0.8, 3.2), 0, 6.2832);
      g.fill();
    }
  }
  // Belly grime.
  for (let i = 0; i < 40; i++) {
    const z = prof.tailZ + rnd.next() * (prof.noseZ - prof.tailZ);
    const [x, y] = F.px(z, rnd.range(-0.06, 0.06));
    softBlob(g, x, ((y - F.rect.y + F.rect.h) % F.rect.h) + F.rect.y, rnd.range(8, 26), rgba(0x4c4235, 0.16), 1, 0.2);
  }

  // --- general grime in the low-pressure corners ----------------------------
  scratches(g, REGION.fuse, 200, rnd, 0x1a1815, 0.055, 6, 28, 0, 0.10);
  scratches(g, REGION.wingTop, 130, rnd, 0x1a1815, 0.040, 8, 34, 0, 0.08);
  scratches(g, REGION.wingBot, 170, rnd, 0x1a1815, 0.055, 8, 38, 0, 0.08);

  void R;
}

// ---------------------------------------------------------------------------
// 6. Material swatches and one-off detail panels
// ---------------------------------------------------------------------------

function fillNoisy(g: Ctx2D, r: Rect, base: number, amp: number, seed: number, scale = 0.09): void {
  const img = g.createImageData(r.w, r.h);
  const d = img.data;
  const [br, bg, bb] = rgbOf(base);
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const n = fbm(x * scale, y * scale, 3, seed) - 0.5;
      const k = (y * r.w + x) * 4;
      d[k] = clamp255(br * (1 + n * amp));
      d[k + 1] = clamp255(bg * (1 + n * amp));
      d[k + 2] = clamp255(bb * (1 + n * amp));
      d[k + 3] = 255;
    }
  }
  g.putImageData(img, r.x, r.y);
}
const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

function paintSwatches(alb: Surface, rgh: Surface, hgt: Surface, spec: AircraftSpec, rnd: Rand): void {
  const g = alb.g;
  const rg = rgh.g;
  const setRough = (r: Rect, v: number) => {
    rg.fillStyle = `rgb(${v},${v},${v})`;
    rg.fillRect(r.x / 4, r.y / 4, r.w / 4, r.h / 4);
  };

  // Painted airframe offcut — used by small fairings so they match the hull.
  fillNoisy(g, SWATCH.hullPaint, spec.livery.camoA, 0.16, rnd.int(9999));
  setRough(SWATCH.hullPaint, 190);

  // Dark anti-glare / interior black.
  fillNoisy(g, SWATCH.metalDark, 0x2b2d30, 0.35, rnd.int(9999));
  scratches(g, SWATCH.metalDark, 90, rnd, 0x7a8086, 0.25, 4, 26, 0.4, 0.7);
  setRough(SWATCH.metalDark, 150);

  // Bare aluminium: fine directional grain plus a few polish streaks.
  fillNoisy(g, SWATCH.metalBare, 0xa8adb2, 0.13, rnd.int(9999), 0.25);
  scratches(g, SWATCH.metalBare, 220, rnd, 0xd8dde2, 0.18, 10, 70, 0, 0.06);
  scratches(g, SWATCH.metalBare, 120, rnd, 0x6f757b, 0.14, 8, 50, 0, 0.06);
  setRough(SWATCH.metalBare, 70);

  fillNoisy(g, SWATCH.steel, 0x8f9499, 0.16, rnd.int(9999), 0.18);
  scratches(g, SWATCH.steel, 140, rnd, 0xc6ccd2, 0.16, 6, 40, 0.2, 0.5);
  setRough(SWATCH.steel, 95);

  fillNoisy(g, SWATCH.gunmetal, 0x3a3d42, 0.28, rnd.int(9999), 0.2);
  setRough(SWATCH.gunmetal, 110);

  // Tyre: u runs around the circumference, v across the tread.
  {
    const r = SWATCH.tyre;
    fillNoisy(g, r, 0x232326, 0.30, rnd.int(9999), 0.14);
    g.save();
    g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip();
    // Circumferential ribs plus a cross-hatched block tread.
    for (let i = 0; i < 46; i++) {
      const x = r.x + (i / 46) * r.w;
      g.fillStyle = rgba(0x141416, 0.55);
      g.fillRect(x, r.y + r.h * 0.22, r.w / 46 * 0.45, r.h * 0.56);
    }
    g.fillStyle = rgba(0x0e0e10, 0.5);
    g.fillRect(r.x, r.y + r.h * 0.16, r.w, 3);
    g.fillRect(r.x, r.y + r.h * 0.80, r.w, 3);
    // Sidewall lettering.
    drawText(g, 'DUNLOP  650x175', r.x + r.w * 0.5, r.y + r.h * 0.08, {
      size: r.h * 0.075, color: 0x5a5a5e, alpha: 0.55, align: 'center', weight: 700, squash: 0.85,
    });
    g.restore();
    setRough(r, 215);
  }

  // Propeller blade: matt black with a yellow tip band at the outboard end.
  {
    const r = SWATCH.propBlade;
    fillNoisy(g, r, 0x1c1c1e, 0.22, rnd.int(9999), 0.2);
    const grd = g.createLinearGradient(r.x, 0, r.x + r.w, 0);
    grd.addColorStop(0.0, 'rgba(0,0,0,0)');
    grd.addColorStop(0.855, 'rgba(0,0,0,0)');
    grd.addColorStop(0.86, 'rgba(214,166,40,1)');
    grd.addColorStop(0.99, 'rgba(214,166,40,1)');
    grd.addColorStop(1.0, 'rgba(180,138,32,1)');
    g.fillStyle = grd;
    g.fillRect(r.x, r.y, r.w, r.h);
    // Leading-edge erosion at the tip.
    scratches(g, { x: r.x + r.w * 0.6, y: r.y, w: r.w * 0.4, h: r.h * 0.3 }, 60, rnd, 0xb9bec4, 0.3, 3, 12, 0, 0.4);
    drawText(g, 'HAMILTON STANDARD', r.x + r.w * 0.30, r.y + r.h * 0.5, {
      size: r.h * 0.085, color: 0xb8b19a, alpha: 0.55, align: 'center', weight: 600, squash: 0.85,
    });
    setRough(r, 120);
  }

  // Cockpit interior green / grey.
  {
    const interior = spec.nation === 'usa' ? 0x40483c : spec.nation === 'germany' ? 0x5a6069
      : spec.nation === 'japan' ? 0x6a6c4e : spec.nation === 'ussr' ? 0x5b6a63 : 0x3f4a3f;
    fillNoisy(g, SWATCH.interior, interior, 0.20, rnd.int(9999), 0.12);
    scratches(g, SWATCH.interior, 120, rnd, 0x9aa0a4, 0.18, 5, 26, 0, 0.8);
    setRough(SWATCH.interior, 200);
  }

  fillNoisy(g, SWATCH.leather, 0x4a3526, 0.22, rnd.int(9999), 0.3);
  scratches(g, SWATCH.leather, 160, rnd, 0x7a5c44, 0.2, 4, 18, 0, 1.2);
  setRough(SWATCH.leather, 205);

  fillNoisy(g, SWATCH.brass, 0xa8894a, 0.16, rnd.int(9999), 0.2);
  setRough(SWATCH.brass, 80);

  fillNoisy(g, SWATCH.chrome, 0xc9ced4, 0.08, rnd.int(9999), 0.3);
  scratches(g, SWATCH.chrome, 90, rnd, 0xffffff, 0.25, 10, 60, 0, 0.05);
  setRough(SWATCH.chrome, 40);

  // Exhaust stub metal: heat-tinted straw → blue → soot along v.
  {
    const r = SWATCH.exhaust;
    const grd = g.createLinearGradient(0, r.y, 0, r.y + r.h);
    grd.addColorStop(0, '#6b5a3f');
    grd.addColorStop(0.35, '#4e4436');
    grd.addColorStop(0.7, '#3a3730');
    grd.addColorStop(1, '#241f1a');
    g.fillStyle = grd;
    g.fillRect(r.x, r.y, r.w, r.h);
    overlayGrain(g, r, 0.20, rnd.int(9999), 64);
    setRough(r, 235);
  }

  fillNoisy(g, SWATCH.navRed, 0xc02a22, 0.10, rnd.int(9999));
  setRough(SWATCH.navRed, 60);
  fillNoisy(g, SWATCH.navGreen, 0x1f9a52, 0.10, rnd.int(9999));
  setRough(SWATCH.navGreen, 60);

  // Doped fabric with visible rib tapes — control surfaces on most of these.
  {
    const r = SWATCH.fabric;
    fillNoisy(g, r, spec.livery.camoA, 0.10, rnd.int(9999), 0.06);
    for (let i = 0; i < 10; i++) {
      const y = r.y + ((i + 0.5) / 10) * r.h;
      g.fillStyle = rgba(0xffffff, 0.06);
      g.fillRect(r.x, y - 2, r.w, 4);
      g.fillStyle = rgba(0x000000, 0.08);
      g.fillRect(r.x, y + 2, r.w, 2);
    }
    setRough(r, 215);
  }

  fillNoisy(g, SWATCH.glassFrame, scaleHex(spec.livery.camoA, 0.75), 0.16, rnd.int(9999));
  setRough(SWATCH.glassFrame, 130);

  // Undersurface paint, for everything that hangs below the aircraft: radiator
  // fairings, intake ducts, pitot masts. Painting those in upper camouflage is
  // the single most common giveaway of a procedurally textured aeroplane.
  fillNoisy(g, SWATCH.underPaint, spec.livery.under, 0.12, rnd.int(9999));
  scratches(g, SWATCH.underPaint, 70, rnd, 0x2a2622, 0.10, 6, 30, 0, 0.2);
  setRough(SWATCH.underPaint, 195);

  fillNoisy(g, SWATCH.zincPrimer, 0x6f7a4e, 0.20, rnd.int(9999), 0.14);
  setRough(SWATCH.zincPrimer, 200);
  fillNoisy(g, SWATCH.wood, 0x7a5a34, 0.22, rnd.int(9999), 0.4);
  setRough(SWATCH.wood, 190);
  fillNoisy(g, SWATCH.copper, 0x9a6a44, 0.16, rnd.int(9999));
  setRough(SWATCH.copper, 95);
  fillNoisy(g, SWATCH.plexi, 0xa8bcc8, 0.06, rnd.int(9999), 0.3);
  setRough(SWATCH.plexi, 35);
  fillNoisy(g, SWATCH.olive, 0x4d5540, 0.18, rnd.int(9999));
  setRough(SWATCH.olive, 200);
  fillNoisy(g, SWATCH.sootMetal, 0x2a2724, 0.30, rnd.int(9999), 0.2);
  setRough(SWATCH.sootMetal, 240);
  fillNoisy(g, SWATCH.strap, 0x6b6350, 0.20, rnd.int(9999), 0.25);
  setRough(SWATCH.strap, 215);

  // Height: swatches are essentially flat, but a little tooth stops the normal
  // map from being perfectly featureless on close-up parts.
  const hg = hgt.g;
  hg.save();
  hg.globalAlpha = 0.35;
  overlayGrain(hg, { x: REGION.swatch.x / 2, y: REGION.swatch.y / 2, w: REGION.swatch.w / 2, h: REGION.swatch.h / 2 }, 0.25, 7);
  hg.restore();
}

function paintDetailRects(alb: Surface, rgh: Surface, spec: AircraftSpec, rnd: Rand): void {
  const g = alb.g;
  const rg = rgh.g;
  const setRough = (r: Rect, v: number) => {
    rg.fillStyle = `rgb(${v},${v},${v})`;
    rg.fillRect(r.x / 4, r.y / 4, r.w / 4, r.h / 4);
  };

  // Gear door: undersurface colour with pressed stiffening ribs. A box maps
  // every face to the whole rect, so the rect has to be uniform in tone or the
  // door comes out banded.
  {
    const r = DETAIL.gearDoor;
    fillNoisy(g, r, spec.livery.under, 0.10, rnd.int(9999));
    for (let i = 1; i < 5; i++) {
      g.fillStyle = rgba(0x000000, 0.13);
      g.fillRect(r.x + (i / 5) * r.w - 2, r.y + r.h * 0.10, 4, r.h * 0.80);
      g.fillStyle = rgba(0xffffff, 0.09);
      g.fillRect(r.x + (i / 5) * r.w + 2, r.y + r.h * 0.10, 2, r.h * 0.80);
    }
    scratches(g, r, 60, rnd, 0x2c2b26, 0.12, 5, 22, 0, 0.3);
    setRough(r, 185);
  }

  // Wheel well: dark, oily, full of structure.
  {
    const r = DETAIL.wheelWell;
    fillNoisy(g, r, 0x4a5340, 0.30, rnd.int(9999), 0.15);
    for (let i = 0; i < 26; i++) {
      g.strokeStyle = rgba(0x1b1e18, rnd.range(0.2, 0.6));
      g.lineWidth = rnd.range(1, 3.5);
      g.beginPath();
      g.moveTo(r.x + rnd.next() * r.w, r.y + rnd.next() * r.h);
      g.lineTo(r.x + rnd.next() * r.w, r.y + rnd.next() * r.h);
      g.stroke();
    }
    softBlob(g, r.x + r.w * 0.5, r.y + r.h * 0.7, r.w * 0.4, 'rgba(10,8,6,0.5)', 1, 0.1);
    setRough(r, 150);
  }

  // Radiator matrix: a fine honeycomb, dark and recessed. Cells are 4 px so
  // that at the physical size of a radiator face (~0.2 m) they land at a
  // believable 3 mm pitch instead of reading as a chessboard up close.
  {
    const r = DETAIL.radiator;
    g.fillStyle = '#0d0f12';
    g.fillRect(r.x, r.y, r.w, r.h);
    const cell = 4;
    for (let y = 0; y < r.h; y += cell) {
      for (let x = 0; x < r.w; x += cell) {
        const off = ((y / cell) | 0) % 2 ? cell * 0.5 : 0;
        g.fillStyle = rgba(0x2e353d, 0.85);
        g.fillRect(r.x + x + off, r.y + y, cell - 1.4, cell - 1.4);
      }
    }
    // Frame around the matrix.
    g.strokeStyle = rgba(0x8f959b, 0.65);
    g.lineWidth = 6;
    g.strokeRect(r.x + 3, r.y + 3, r.w - 6, r.h - 6);
    setRough(r, 205);
  }

  // Cowl interior.
  fillNoisy(g, DETAIL.cowlInner, 0x30352f, 0.30, rnd.int(9999), 0.16);
  setRough(DETAIL.cowlInner, 190);

  // Instrument panel backing: matt black with a hint of texture.
  fillNoisy(g, DETAIL.instrPanel, 0x1a1c1e, 0.25, rnd.int(9999), 0.2);
  setRough(DETAIL.instrPanel, 205);

  // Seat: metal pan with a leather cushion band.
  {
    const r = DETAIL.seat;
    fillNoisy(g, r, spec.nation === 'britain' ? 0x6a5535 : 0x4b5245, 0.22, rnd.int(9999), 0.14);
    g.fillStyle = rgba(0x3a2a1d, 0.9);
    g.fillRect(r.x, r.y + r.h * 0.55, r.w, r.h * 0.45);
    scratches(g, r, 90, rnd, 0x8d8674, 0.2, 4, 22, 0, 1.0);
    setRough(r, 205);
  }

  fillNoisy(g, DETAIL.bulkhead, 0x3f4a3f, 0.24, rnd.int(9999), 0.14);
  setRough(DETAIL.bulkhead, 200);
  fillNoisy(g, DETAIL.floor, 0x33372f, 0.28, rnd.int(9999), 0.2);
  setRough(DETAIL.floor, 210);

  // Armour plate: bare rolled steel, bolted.
  {
    const r = DETAIL.armour;
    fillNoisy(g, r, 0x6f747a, 0.14, rnd.int(9999), 0.2);
    for (let i = 0; i < 14; i++) {
      const x = r.x + 12 + (i % 7) * ((r.w - 24) / 6);
      const y = r.y + 14 + ((i / 7) | 0) * (r.h - 28);
      g.fillStyle = rgba(0x2b2e32, 0.8);
      g.beginPath(); g.arc(x, y, 4, 0, 6.2832); g.fill();
      g.fillStyle = rgba(0xd0d5da, 0.35);
      g.beginPath(); g.arc(x - 1.2, y - 1.2, 2.2, 0, 6.2832); g.fill();
    }
    setRough(r, 120);
  }
}

// ---------------------------------------------------------------------------
// Utility used by the imposter generator
// ---------------------------------------------------------------------------

/** Average albedo colour of a region — used to tint the distant imposter. */
export function regionAverage(canvas: HTMLCanvasElement, r: Rect): number {
  const g = ctx2d(canvas, true);
  const step = 8;
  const data = g.getImageData(r.x, r.y, r.w, r.h).data;
  let cr = 0, cg = 0, cb = 0, n = 0;
  for (let y = 0; y < r.h; y += step) {
    for (let x = 0; x < r.w; x += step) {
      const k = (y * r.w + x) * 4;
      cr += data[k]; cg += data[k + 1]; cb += data[k + 2]; n++;
    }
  }
  if (!n) return 0x808080;
  return ((cr / n) << 16 | (cg / n) << 8 | (cb / n)) & 0xffffff;
}

