/**
 * The fuselage: a true loft, not a stretched capsule.
 *
 * A spline of cross-sections is swept from the cowl to the tail post. Each
 * station is an *asymmetric superellipse* — independent half-width, upper
 * half-height and lower half-height, plus an exponent that goes from nearly
 * rectangular at a radial cowl to a soft oval at mid-fuselage. That single extra
 * exponent is what separates a monocoque fighter fuselage from a tube: real
 * fighters are flat-sided under the cockpit and round underneath, and an ellipse
 * cannot express that.
 *
 * On top of the base table sits a *spine* term — the raised turtledeck behind
 * the canopy that fairs into the fin. It is applied only to the upper radius, is
 * blended in over 0.6 m ahead of the canopy rear so there is no crease, and
 * decays aft.
 *
 * Everything else in the model (canopy sill, wing fillet, gear bay, exhaust
 * stubs, aerial mast, the livery's cylindrical unwrap) queries this object
 * rather than guessing where the skin is.
 */

import * as THREE from 'three';
import type { AircraftSpec } from '../../shared/aircraft';
import type { UvBox } from '../textures/atlas';
import { MeshBuilder, cylGeom, flipWinding, latheGeom, mergeGeoms, trs } from './geom';

export interface FuseSample { rx: number; ryTop: number; ryBot: number; yc: number; n: number }

/**
 * Whether this type wears a frameless teardrop hood over a cut-down rear
 * fuselage rather than a framed greenhouse. It changes the turtledeck, the
 * canopy profile and the frame layout, so both modules ask the same question
 * here rather than each keeping their own list.
 */
export const bubbleCanopy = (spec: AircraftSpec): boolean => spec.id === 'p51d';

/** t, rx, ryTop, ryBot, yc, superellipse exponent — all radii in units of fuseRadius. */
type Row = [number, number, number, number, number, number];

const INLINE: Row[] = [
  [0.00, 0.40, 0.42, 0.38, 0.03, 2.60],
  [0.05, 0.58, 0.66, 0.50, 0.05, 2.70],
  [0.12, 0.70, 0.80, 0.58, 0.06, 2.55],
  [0.20, 0.82, 0.90, 0.70, 0.05, 2.40],
  [0.28, 0.92, 0.97, 0.84, 0.02, 2.30],
  [0.36, 0.99, 1.00, 0.95, 0.00, 2.20],
  [0.45, 1.00, 0.97, 1.00, -0.01, 2.12],
  [0.55, 0.93, 0.88, 0.93, -0.02, 2.10],
  [0.66, 0.79, 0.72, 0.78, -0.02, 2.12],
  [0.76, 0.62, 0.55, 0.60, -0.01, 2.18],
  [0.85, 0.45, 0.40, 0.42, 0.01, 2.25],
  [0.92, 0.30, 0.28, 0.27, 0.04, 2.35],
  [0.97, 0.16, 0.16, 0.14, 0.07, 2.45],
  [1.00, 0.05, 0.09, 0.04, 0.09, 2.55],
];

const RADIAL: Row[] = [
  [0.00, 0.86, 0.86, 0.86, 0.00, 3.20],
  [0.05, 0.99, 0.99, 0.99, 0.00, 3.30],
  [0.13, 1.00, 1.00, 1.00, 0.00, 3.05],
  [0.22, 0.96, 0.98, 0.93, 0.00, 2.70],
  [0.30, 0.92, 0.95, 0.89, 0.00, 2.45],
  [0.40, 0.94, 0.96, 0.92, -0.01, 2.25],
  [0.50, 0.90, 0.86, 0.90, -0.02, 2.15],
  [0.62, 0.78, 0.72, 0.77, -0.02, 2.15],
  [0.73, 0.62, 0.56, 0.60, -0.01, 2.20],
  [0.83, 0.45, 0.41, 0.42, 0.01, 2.28],
  [0.91, 0.30, 0.28, 0.27, 0.04, 2.38],
  [0.97, 0.16, 0.16, 0.14, 0.07, 2.48],
  [1.00, 0.05, 0.09, 0.04, 0.09, 2.55],
];

/** Cubic Hermite over a non-uniform table; tangents from central differences. */
function hermite(tab: Row[], col: number, t: number): number {
  const n = tab.length;
  if (t <= tab[0][0]) return tab[0][col];
  if (t >= tab[n - 1][0]) return tab[n - 1][col];
  let i = 0;
  while (i < n - 2 && tab[i + 1][0] < t) i++;
  const t0 = tab[i][0], t1 = tab[i + 1][0];
  const h = t1 - t0;
  const s = (t - t0) / h;
  const y0 = tab[i][col], y1 = tab[i + 1][col];
  const ym = tab[Math.max(0, i - 1)][col], yp = tab[Math.min(n - 1, i + 2)][col];
  const tm = tab[Math.max(0, i - 1)][0], tp = tab[Math.min(n - 1, i + 2)][0];
  const m0 = (y1 - ym) / Math.max(1e-6, t1 - tm) * h;
  const m1 = (yp - y0) / Math.max(1e-6, tp - t0) * h;
  const s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * y0 + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * y1 + (s3 - s2) * m1;
}

const sgnpow = (v: number, e: number) => (v < 0 ? -Math.pow(-v, e) : Math.pow(v, e));

export class FuselageProfile {
  readonly noseZ: number;
  readonly tailZ: number;
  readonly R: number;
  readonly radial: boolean;
  private tab: Row[];
  private spineA: number;
  private spineZ0: number;   // canopy rear
  private spineLen: number;
  private cowlBumps: number;
  private cowlBumpAmp: number;

  constructor(readonly spec: AircraftSpec) {
    const g = spec.geom;
    // The datum: 44 % of the length ahead of the origin puts the origin near the
    // quarter-chord/CG, which is where the flight model expects the body frame.
    this.noseZ = g.length * 0.44;
    this.tailZ = -g.length * 0.56;
    this.R = g.fuseRadius;
    this.radial = spec.engine.kind === 'radial';
    this.tab = this.radial ? RADIAL : INLINE;
    // A cut-down rear fuselage under a teardrop hood has almost no turtledeck —
    // that low spine is half of why a bubble-canopy Mustang is recognisable.
    this.spineA = (bubbleCanopy(spec) ? 0.07 : 0.26) * this.R;
    this.spineZ0 = g.canopy.z1;
    this.spineLen = Math.max(0.8, this.spineZ0 - (g.vStab.z + g.vStab.chord * 0.5));
    this.cowlBumps = this.radial ? 7 : 0;
    this.cowlBumpAmp = 0.022 * this.R;
  }

  zOfT(t: number): number { return this.noseZ + (this.tailZ - this.noseZ) * t; }
  tOfZ(z: number): number {
    return Math.max(0, Math.min(1, (z - this.noseZ) / (this.tailZ - this.noseZ)));
  }

  /** Additional upper radius from the turtledeck spine, in metres. */
  private spine(z: number): number {
    const s = this.spineZ0 - z;
    let v: number;
    if (s < -0.6) v = 0;
    else if (s < 0) { const u = (s + 0.6) / 0.6; v = this.spineA * u * u * (3 - 2 * u); }
    else v = this.spineA * (0.12 + 0.88 * Math.exp(-2.2 * s / this.spineLen));
    // Fade out over the last half metre so the tail post is clean.
    const tailFade = Math.min(1, Math.max(0, (z - this.tailZ) / 0.5));
    return v * tailFade;
  }

  sampleT(t: number, out: FuseSample = { rx: 0, ryTop: 0, ryBot: 0, yc: 0, n: 2 }): FuseSample {
    const R = this.R;
    out.rx = hermite(this.tab, 1, t) * R;
    out.ryTop = hermite(this.tab, 2, t) * R;
    out.ryBot = hermite(this.tab, 3, t) * R;
    out.yc = hermite(this.tab, 4, t) * R;
    out.n = hermite(this.tab, 5, t);
    out.ryTop += this.spine(this.zOfT(t));
    return out;
  }

  at(z: number, out?: FuseSample): FuseSample { return this.sampleT(this.tOfZ(z), out); }

  /**
   * Skin point. θ = 0 is bottom dead centre, increasing toward the starboard
   * side, so the UV seam lands on the belly where nothing is ever painted.
   */
  point(z: number, theta: number, out = new THREE.Vector3()): THREE.Vector3 {
    const s = this.at(z, _s);
    const cx = Math.sin(theta), cy = -Math.cos(theta);
    const e = 2 / s.n;
    let rx = s.rx;
    let ry = cy >= 0 ? s.ryTop : s.ryBot;
    if (this.cowlBumps > 0) {
      // Cylinder-head bumps on a radial cowl: lobed ripple that dies away aft of
      // the firewall. Most of the read comes from the normal map; this is just
      // enough geometry to catch a rim light.
      const t = this.tOfZ(z);
      const k = Math.max(0, 1 - Math.abs(t - 0.10) / 0.16);
      if (k > 0) {
        const bump = Math.cos(theta * this.cowlBumps) * this.cowlBumpAmp * k * k;
        rx += bump; ry += bump;
      }
    }
    out.set(rx * sgnpow(cx, e), s.yc + ry * sgnpow(cy, e), z);
    return out;
  }

  /** Outward normal by central differences on the skin. */
  normal(z: number, theta: number, out = new THREE.Vector3()): THREE.Vector3 {
    const d = 1e-3;
    const a = this.point(z, theta + d, _a);
    const b = this.point(z, theta - d, _b);
    const c = this.point(z + d, theta, _c);
    const e = this.point(z - d, theta, _d);
    _t1.subVectors(a, b);
    _t2.subVectors(c, e);
    out.crossVectors(_t2, _t1).normalize();
    return out;
  }

  topY(z: number): number { const s = this.at(z, _s); return s.yc + s.ryTop; }
  bottomY(z: number): number { const s = this.at(z, _s); return s.yc - s.ryBot; }
  halfWidth(z: number): number { return this.at(z, _s).rx; }

  /**
   * Nominal camouflage demarcation height on the side of the fuselage.
   *
   * Clamped to sit below the wing root: the upper-surface colour has to carry
   * across the wing-root fairing, and if the waterline creeps above the root the
   * fillet paints a stripe of undersurface colour across the top of the wing.
   */
  demarcY(z: number): number {
    const s = this.at(z, _s);
    return Math.min(s.yc - s.ryBot * 0.24, this.spec.geom.wingY - 0.06);
  }
}

const _s: FuseSample = { rx: 0, ryTop: 0, ryBot: 0, yc: 0, n: 2 };
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Skin geometry
// ---------------------------------------------------------------------------

export interface FuseUv { (t: number, theta01: number): [number, number] }

/**
 * An opening cut in the top of the skin, given as a half-width against body z.
 * Supplied by 'canopyOpening' so the hole and the glasshouse agree exactly.
 */
export interface SkinCut {
  z0: number;
  z1: number;
  halfWidth(z: number): number;
}

/**
 * Half-angle of the opening at a station, measured from top dead centre.
 *
 * The section is a superellipse |x/rx|^n + |y/ry|^n = 1, so a point at angle φ
 * off the crown sits at x = rx·sin(φ)^(2/n). Inverting that for the requested
 * half-width is what puts the cut edge exactly under the canopy sill instead of
 * a few centimetres inboard or outboard of it.
 */
function cutAngle(prof: FuselageProfile, cut: SkinCut, z: number): number {
  const hw = cut.halfWidth(z);
  if (hw <= 1e-4) return 0;
  const s = prof.at(z);
  const ratio = Math.min(0.999, hw / Math.max(1e-4, s.rx));
  return Math.asin(Math.min(1, Math.pow(ratio, s.n * 0.5)));
}

/**
 * Loft the skin. Station spacing is cosine-clustered so the highly curved cowl
 * and tail cone get the rings and the straight mid-section does not waste them.
 *
 * ## The cockpit cutout
 *
 * When 'cut' is supplied the lattice is *warped* rather than masked. Two columns
 * either side of top dead centre are pinned to the exact opening edge at every
 * station and the quads between them are dropped; the remaining columns are
 * redistributed over the surviving arc. Masking a uniform θ grid instead would
 * stair-step the sill by up to half a segment — 7 cm on a fighter fuselage —
 * and no amount of coaming hides that. Where the opening has closed the two
 * pinned columns coincide at the crown, the in-between quads collapse to
 * degenerate and 'MeshBuilder' drops them on its own, so the ring closes
 * cleanly with no special case.
 *
 * Extra stations are also inserted through the opening: the base cosine spacing
 * puts its rings on the cowl and the tail cone, and the cut edge needs samples
 * where the cut is.
 */
export function buildFuselageSkin(
  prof: FuselageProfile, rings: number, segs: number, uv: FuseUv, cut?: SkinCut,
): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const p = new THREE.Vector3();

  // --- stations -------------------------------------------------------------
  const ts: number[] = [];
  for (let i = 0; i < rings; i++) ts.push(0.5 - 0.5 * Math.cos((i / (rings - 1)) * Math.PI));
  if (cut) {
    const tA = prof.tOfZ(cut.z0), tB = prof.tOfZ(cut.z1);
    const n = 20;
    // Duplicated boundary stations a fifth of a millimetre outside the opening
    // give the cut a hard corner rather than a long ramp from the neighbouring
    // cosine station.
    ts.push(tA - 2e-5, tB + 2e-5);
    // Cosine-clustered inside the opening: the sill's curvature is all in the
    // rounded corners at either end, and the long straight sides need nothing.
    for (let i = 0; i <= n; i++) {
      ts.push(tA + (tB - tA) * (0.5 - 0.5 * Math.cos((i / n) * Math.PI)));
    }
    ts.sort((x, y) => x - y);
  }

  // --- angular columns ------------------------------------------------------
  // jA..jB span the opening; k is chosen so those columns are neither starved
  // nor hogging the ring when the cut is at its widest.
  const half = Math.floor(segs / 2);
  const k = Math.max(2, Math.round(segs * 0.14));
  const jA = half - k, jB = half + k;

  const rows = ts.length;
  const theta = (i: number, j: number): number => {
    const h = cut ? cutAngle(prof, cut, prof.zOfT(ts[i])) : 0;
    const a = Math.PI - h, c = Math.PI + h;
    if (j <= jA) return a * (j / jA);
    if (j >= jB) return c + (Math.PI * 2 - c) * ((j - jB) / (segs - jB));
    return a + 2 * h * ((j - jA) / (jB - jA));
  };

  b.addGrid(rows, segs + 1, (i, j, o) => {
    const t = ts[i];
    const th = theta(i, j);
    prof.point(prof.zOfT(t), th, p);
    o.x = p.x; o.y = p.y; o.z = p.z;
    const [u, v] = uv(t, th / (Math.PI * 2));
    o.u = u; o.v = v;
    // Columns strictly inside the opening are unreferenced once their quads are
    // dropped; leaving them on the surface keeps the lattice rectangular and
    // costs a handful of vertices.
    if (cut && j > jA && j < jB) o.skip = true;
  }, true);

  // Front and rear caps. The nose annulus is hidden by the spinner or cowl face
  // but must exist or you can see straight down the fuselage from ahead.
  const parts: THREE.BufferGeometry[] = [b.build(true)];
  const back = new MeshBuilder();
  const sTail = prof.sampleT(1);
  const ringIds: number[] = [];
  for (let j = 0; j <= segs; j++) {
    const th = (j / segs) * Math.PI * 2;
    prof.point(prof.tailZ, th, p);
    ringIds.push(back.vert(p.x, p.y, p.z, ...uv(1, j / segs)));
  }
  const cTail = back.vert(0, sTail.yc, prof.tailZ - 0.02, ...uv(1, 0.5));
  back.fan(cTail, ringIds, true);
  parts.push(back.build(true));

  return mergeGeoms(parts);
}

// ---------------------------------------------------------------------------
// Cowling
// ---------------------------------------------------------------------------

export interface CowlParts {
  /** Merged static cowl detail — always part of the hull. */
  hull: THREE.BufferGeometry;
  /** Engine internals seen through a radial cowl opening (LOD0/1 only). */
  engine: THREE.BufferGeometry | null;
}

/**
 * Cowl detailing.
 *
 * Radial: an annular cowl face with a real opening, a ring of finned cylinder
 * heads visible inside it, and a segmented cowl-flap ring at the rear.
 * Inline: a shallow lip ring around the spinner and the raised rocker-cover
 * blisters that give a Merlin or DB 605 nose its distinctive cross-section.
 */
export function buildCowl(
  prof: FuselageProfile, spec: AircraftSpec, detail: number, metal: UvBox, dark: UvBox, inner: UvBox,
): CowlParts {
  const R = prof.R;
  const hull: THREE.BufferGeometry[] = [];
  let engine: THREE.BufferGeometry | null = null;
  const seg = detail === 0 ? 24 : detail === 1 ? 14 : 8;

  if (prof.radial) {
    const s0 = prof.sampleT(0);
    const outerR = Math.max(s0.rx, s0.ryTop);
    const openR = outerR * 0.52;
    const zFront = prof.noseZ;

    // Cowl lip: a rolled annulus, thicker at the leading edge than a flat ring
    // so it catches a hard specular band all the way round.
    const lipProfile: { r: number; y: number }[] = [];
    for (let i = 0; i <= 8; i++) {
      const a = Math.PI * (i / 8);
      lipProfile.push({ r: openR + (outerR - openR) * (0.5 - 0.5 * Math.cos(a)), y: Math.sin(a) * 0.055 * R });
    }
    const lip = latheGeom(lipProfile, seg, metal);
    lip.applyMatrix4(trs([0, 0, zFront], [Math.PI / 2, 0, 0]));
    hull.push(lip);

    // Interior of the cowl: a short tube, turned inside out so we see its inner
    // wall rather than looking straight through the model.
    const barrel = flipWinding(cylGeom(openR, openR * 0.95, R * 0.75, seg, inner, false));
    barrel.applyMatrix4(trs([0, 0, zFront - R * 0.38], [Math.PI / 2, 0, 0]));
    hull.push(barrel);

    if (detail <= 1) {
      const eng: THREE.BufferGeometry[] = [];
      const cyls = detail === 0 ? 9 : 6;
      for (let i = 0; i < cyls; i++) {
        const a = (i / cyls) * Math.PI * 2 + 0.2;
        const rr = openR * 0.62;
        // Cylinder barrel with cooling fins faked by three stacked discs.
        const c = cylGeom(openR * 0.20, openR * 0.17, R * 0.42, detail === 0 ? 8 : 6, dark, true);
        c.applyMatrix4(trs(
          [Math.cos(a) * rr, Math.sin(a) * rr, zFront - R * 0.30],
          [Math.PI / 2, 0, 0],
        ));
        eng.push(c);
        if (detail === 0) {
          for (let k = 0; k < 3; k++) {
            const fin = cylGeom(openR * 0.25, openR * 0.25, R * 0.03, 8, dark, false);
            fin.applyMatrix4(trs(
              [Math.cos(a) * rr, Math.sin(a) * rr, zFront - R * 0.16 - k * R * 0.11],
              [Math.PI / 2, 0, 0],
            ));
            eng.push(fin);
          }
        }
      }
      // Reduction-gear housing behind the spinner.
      const hub = cylGeom(openR * 0.30, openR * 0.24, R * 0.5, seg, dark, true);
      hub.applyMatrix4(trs([0, 0, zFront - R * 0.28], [Math.PI / 2, 0, 0]));
      eng.push(hub);
      engine = mergeGeoms(eng);
    }

    // Cowl-flap collar: a flared ring at the cowl trailing edge. Real cowl flaps
    // are individual scalloped plates; at every distance the player ever sees
    // them, a flare plus the scalloped edge painted into the normal map reads
    // identically and costs a twentieth of the triangles.
    if (detail <= 1) {
      const zF = prof.zOfT(0.19);
      const sF = prof.at(zF);
      const collar = cylGeom(sF.rx * 1.005, sF.rx * 1.055, R * 0.20, seg, metal, false);
      collar.applyMatrix4(trs([0, sF.yc, zF], [Math.PI / 2, 0, 0]));
      hull.push(collar);
    }
  } else {
    // Inline: rocker-cover blisters along the upper cowl flanks. These are the
    // shapes that make a Merlin nose readable in silhouette.
    if (detail <= 1) {
      const blisters: THREE.BufferGeometry[] = [];
      for (const sx of [-1, 1]) {
        const pts: { r: number; y: number }[] = [];
        const n = detail === 0 ? 7 : 4;
        for (let i = 0; i <= n; i++) {
          const u = i / n;
          pts.push({ r: R * 0.16 * Math.sin(Math.PI * Math.min(1, u * 1.05)), y: -R * 0.9 + u * R * 1.8 });
        }
        const bl = latheGeom(pts, detail === 0 ? 10 : 6, metal);
        const zc = prof.zOfT(0.14);
        const sC = prof.at(zc);
        bl.applyMatrix4(trs(
          [sx * sC.rx * 0.60, sC.yc + sC.ryTop * 0.62, zc],
          [Math.PI / 2, 0, sx * 0.18],
        ));
        blisters.push(bl);
      }
      hull.push(mergeGeoms(blisters));
    }
    // Spinner back-plate ring so the cowl front is not an open circle.
    const s0 = prof.sampleT(0);
    const ring = latheGeom(
      [{ r: s0.rx * 0.34, y: 0 }, { r: Math.max(s0.rx, s0.ryTop) * 0.99, y: -0.012 }],
      seg, metal,
    );
    ring.applyMatrix4(trs([0, s0.yc, prof.noseZ], [Math.PI / 2, 0, 0]));
    hull.push(ring);
  }

  return { hull: mergeGeoms(hull), engine };
}
