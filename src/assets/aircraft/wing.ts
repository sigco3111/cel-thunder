/**
 * Lifting surfaces: wings, tailplanes and fins, all from one lofted-aerofoil
 * builder, plus the wing-root fillets.
 *
 * The wing is a swept loft of NACA sections. Every geometric feature that makes
 * a real wing look like a wing is parameterised rather than faked:
 *
 *  - **Taper** in chord and in thickness ratio (the tip section is a different,
 *    thinner aerofoil than the root, interpolated per station).
 *  - **Sweep** applied to the quarter-chord line, so the leading edge sweeps
 *    more than the trailing edge, exactly as on the real planform.
 *  - **Dihedral** applied to the spanwise axis *and* to the section frame, so
 *    the aerofoil stays perpendicular to the wing plane instead of shearing.
 *  - **Incidence and washout**: each section is rotated about its own quarter
 *    chord, tip incidence lower than root, which is what puts the visible twist
 *    into the leading edge when you sight along the wing.
 *  - **Elliptical planform** when the spec asks for it. Chord follows
 *    c(η) = c₀√(1 − k η²) about a straight quarter-chord line — the actual
 *    construction Mitchell used, which is why both the LE and the TE curve and
 *    why the result is unmistakably a Spitfire.
 *  - **Rounded tips**: the last few percent of span collapse the section
 *    thickness on a circular arc so the tip is a rolled edge, not a sawn-off rib.
 *
 * Control surfaces are cut out of the skin rather than laid on top: the main
 * loft is generated over [0, hinge] of the chord across the aileron/flap span,
 * and the movable surface is a separate loft over [hinge, 1] with its own hinge
 * pivot. You can see daylight through the gap.
 */

import * as THREE from 'three';
import type { UvBox } from '../textures/atlas';
import { MeshBuilder, mergeGeoms } from './geom';
import { foilCamber, foilContourRange, foilThickness, lerpFoil } from './naca';
import type { Foil, FoilPoint } from './naca';
import type { FuselageProfile } from './fuselage';

// ---------------------------------------------------------------------------
// Planform
// ---------------------------------------------------------------------------

export interface WingPlanOpts {
  /** Projected semi-span (m). */
  semi: number;
  rootChord: number;
  tipChord: number;
  /** Quarter-chord sweep, rad (positive = swept back). */
  sweep: number;
  dihedral: number;
  /** Root incidence, rad. */
  incidence: number;
  /** Tip incidence minus root incidence, rad (negative = washout). */
  washout: number;
  /** Quarter-chord z at the root. */
  z0: number;
  /** Root y. */
  y0: number;
  elliptical: boolean;
  foilRoot: Foil;
  foilTip: Foil;
  /** η at which the rounded tip starts. */
  tipRound: number;
  /**
   * Vertical surface (fin): span runs up +Y and thickness runs across ∓X.
   * Handled here rather than by rotating the finished geometry so that hinge
   * lines, UVs and the fillet solver all stay in body space.
   */
  vertical?: boolean;
}

export class WingPlan {
  readonly o: WingPlanOpts;
  /** Distance along the (dihedralled) wing axis to the tip. */
  readonly run: number;
  private ke: number;

  constructor(o: WingPlanOpts) {
    this.o = o;
    this.run = o.semi / Math.cos(o.dihedral);
    // Choose the ellipse eccentricity so that c(1) lands at a plausible tip
    // chord rather than a knife edge — real "elliptical" wings are truncated.
    const target = Math.max(0.18, o.tipChord * 0.42);
    this.ke = Math.min(0.999, 1 - (target / o.rootChord) ** 2);
  }

  chordAt(eta: number): number {
    const o = this.o;
    if (o.elliptical) return o.rootChord * Math.sqrt(Math.max(0, 1 - this.ke * eta * eta));
    return o.rootChord + (o.tipChord - o.rootChord) * eta;
  }

  /** Multiplier applied to chord and thickness inside the rounded tip. */
  tipScale(eta: number): { c: number; t: number } {
    const r = this.o.tipRound;
    if (eta <= r) return { c: 1, t: 1 };
    const s = Math.min(1, (eta - r) / (1 - r));
    return { c: 1 - 0.16 * s * s, t: Math.sqrt(Math.max(0, 1 - s * s)) };
  }

  qcZAt(eta: number): number { return this.o.z0 - eta * this.o.semi * Math.tan(this.o.sweep); }
  twistAt(eta: number): number { return this.o.incidence + this.o.washout * eta; }
  foilAt(eta: number): Foil { return lerpFoil(this.o.foilRoot, this.o.foilTip, eta); }
  leZAt(eta: number): number { return this.qcZAt(eta) + 0.25 * this.chordAt(eta); }
  teZAt(eta: number): number { return this.qcZAt(eta) - 0.75 * this.chordAt(eta); }

  /**
   * Place a section-local point (chordwise station xa ∈ [0,1], ordinate ya in
   * chord units) into aircraft body space for wing half 'sx'.
   */
  place(sx: number, eta: number, xa: number, ya: number, out = new THREE.Vector3()): THREE.Vector3 {
    const o = this.o;
    const ts = this.tipScale(eta);
    const c = this.chordAt(eta) * ts.c;
    const tw = this.twistAt(eta);
    // Chordwise offset from the quarter chord, positive forward.
    const dz = (0.25 - xa) * c;
    const dy = ya * c * ts.t;
    const ct = Math.cos(tw), st = Math.sin(tw);
    const yR = dy * ct + dz * st;
    const zR = -dy * st + dz * ct;
    const r = eta * this.run;
    if (o.vertical) {
      // Thickness maps to −X so that the contour's "upper" side is the port
      // face, which is the convention finUv expects.
      out.set(-yR, o.y0 + r, this.qcZAt(eta) + zR);
      return out;
    }
    const cd = Math.cos(o.dihedral), sd = Math.sin(o.dihedral);
    out.set(
      sx * (r * cd - yR * sd),
      o.y0 + r * sd + yR * cd,
      this.qcZAt(eta) + zR,
    );
    return out;
  }

  /** Wing surface ordinate at a body-space (x, z), or null if off the planform. */
  surfaceY(x: number, z: number, side: number): number | null {
    const eta = Math.abs(x) / this.run;
    if (eta > 1) return null;
    const c = this.chordAt(eta);
    const xa = (this.leZAt(eta) - z) / c;
    if (xa < -0.02 || xa > 1.02) return null;
    const xc = Math.min(1, Math.max(0, xa));
    const f = this.foilAt(eta);
    const ya = foilCamber(f, xc).yc + side * foilThickness(f, xc);
    return this.place(x >= 0 ? 1 : -1, eta, xc, ya, _p).y;
  }
}

const _p = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Control surface description
// ---------------------------------------------------------------------------

export interface SurfaceCut {
  name: string;
  /** Spanwise extent as a fraction of semi-span. */
  eta0: number;
  eta1: number;
  /** Hinge line as a fraction of local chord. */
  hinge: number;
  /**
   * true  → hinge axis points outboard (surfaces deflect antisymmetrically:
   *         ailerons). false → axis always +X (surfaces deflect together:
   *         elevators, flaps).
   */
  mirrored: boolean;
}

export interface HingedPart {
  name: string;
  /** -1 port, +1 starboard, 0 centreline. */
  half: number;
  geometry: THREE.BufferGeometry;
  point: THREE.Vector3;
  axis: THREE.Vector3;
}

export interface LiftingSurfaceOpts {
  spanSegs: number;
  chordPts: number;
  cuts: SurfaceCut[];
  /** UV for a skin point: signed η ∈ [-1,1], chordwise fraction, surface side. */
  uv: (etaSigned: number, chordFrac: number, side: number) => [number, number];
  /** Which halves to build. [1] for a fin, [-1, 1] for a wing. */
  halves: number[];
  /** Spanwise gap at each end of a movable surface, in metres. */
  gap: number;
  /** Cap the root end (skip when the root is buried in the fuselage). */
  capRoot: boolean;
  /**
   * Spanwise panel range. Wings are built as an inner panel merged into the
   * static hull and an outer panel kept separate so it can be shot off, so this
   * builder has to be able to make a mid-span section with ribs at both ends.
   */
  etaMin?: number;
  etaMax?: number;
}

export interface LiftingSurfaceResult {
  skin: THREE.BufferGeometry;
  parts: HingedPart[];
}

/** Chordwise extent of the fixed skin at η (1 = full chord). */
function limitAt(cuts: SurfaceCut[], eta: number): number {
  for (const c of cuts) if (eta > c.eta0 && eta < c.eta1) return c.hinge;
  return 1;
}

export function buildLiftingSurface(plan: WingPlan, o: LiftingSurfaceOpts): LiftingSurfaceResult {
  const skins: THREE.BufferGeometry[] = [];
  const parts: HingedPart[] = [];

  const eMin = o.etaMin ?? 0;
  const eMax = o.etaMax ?? 1;
  const wholeTip = eMax > 0.999;

  for (const sx of o.halves) {
    // --- spanwise station list ---------------------------------------------
    const base: number[] = [];
    const nTip = 4;
    const eSpan = (wholeTip ? plan.o.tipRound : eMax) - eMin;
    for (let i = 0; i <= o.spanSegs; i++) {
      const u = i / o.spanSegs;
      // Elliptical planforms change chord fastest near the tip, so cluster
      // there; straight-taper wings only need a mild bias.
      const f = plan.o.elliptical ? Math.sin(u * Math.PI * 0.5) : Math.pow(u, 0.86);
      base.push(eMin + f * eSpan);
    }
    if (wholeTip) {
      for (let i = 1; i <= nTip; i++) {
        const s = i / nTip;
        base.push(plan.o.tipRound + (1 - plan.o.tipRound) * Math.sin(s * Math.PI * 0.5));
      }
    }
    // Stations exactly at every control-surface boundary, doubled so the cutout
    // gets a clean end rib instead of a ramp.
    const stations: { eta: number; limit: number }[] = [];
    const boundaries = new Set<number>();
    for (const c of o.cuts) {
      if (c.eta0 > eMin && c.eta0 < eMax) boundaries.add(c.eta0);
      if (c.eta1 > eMin && c.eta1 < eMax) boundaries.add(c.eta1);
    }
    const merged = Array.from(new Set(base.concat(Array.from(boundaries))))
      .filter((e) => e >= eMin - 1e-9 && e <= eMax + 1e-9)
      .sort((a, b) => a - b);
    for (const eta of merged) {
      if (boundaries.has(eta)) {
        stations.push({ eta, limit: limitAt(o.cuts, eta - 1e-4) });
        stations.push({ eta, limit: limitAt(o.cuts, eta + 1e-4) });
      } else {
        stations.push({ eta, limit: limitAt(o.cuts, eta) });
      }
    }

    // --- skin loft ----------------------------------------------------------
    const b = new MeshBuilder();
    const contours: FoilPoint[][] = stations.map((s) =>
      foilContourRange(plan.foilAt(s.eta), o.chordPts, 0, s.limit));
    const cols = o.chordPts + 1;   // +1 duplicated column to close the loop
    const v = new THREE.Vector3();
    const rows = b.addGrid(stations.length, cols, (i, j, out) => {
      const st = stations[i];
      const cn = contours[i];
      const pt = cn[j % o.chordPts];
      plan.place(sx, st.eta, pt.x, pt.y, v);
      out.x = v.x; out.y = v.y; out.z = v.z;
      // The duplicated closing column must not reuse column 0's UV or the
      // trailing-edge strip samples the whole texture backwards.
      const cf = j === o.chordPts ? cn[0].s : pt.s;
      const [u, vv] = o.uv(sx * st.eta, cf, j === o.chordPts ? -cn[0].side : pt.side);
      out.u = u; out.v = vv;
    }, sx < 0);

    if (o.capRoot) {
      const st = stations[0];
      plan.place(sx, st.eta, 0.5, 0, v);
      const c = b.vert(v.x, v.y, v.z, ...o.uv(sx * st.eta, 0.5, 1));
      b.fan(c, rows[0], sx > 0);
    }
    if (!wholeTip) {
      // Rib closing the outboard end of a mid-span panel.
      const st = stations[stations.length - 1];
      plan.place(sx, st.eta, 0.5, 0, v);
      const c = b.vert(v.x, v.y, v.z, ...o.uv(sx * st.eta, 0.5, 1));
      b.fan(c, rows[rows.length - 1], sx < 0);
    }
    skins.push(b.build(true));

    // --- movable surfaces ---------------------------------------------------
    for (const cut of o.cuts) {
      if (cut.eta1 <= eMin + 1e-6 || cut.eta0 >= eMax - 1e-6) continue;
      const dEta = o.gap / plan.run;
      const e0 = Math.max(eMin, cut.eta0) + dEta, e1 = Math.min(eMax, cut.eta1) - dEta;
      if (e1 <= e0) continue;
      const n = Math.max(2, Math.round(o.spanSegs * (e1 - e0) * 1.4));
      const cb = new MeshBuilder();
      const sts: number[] = [];
      for (let i = 0; i <= n; i++) sts.push(e0 + (e1 - e0) * (i / n));
      const cts = sts.map((e) => foilContourRange(plan.foilAt(e), Math.max(8, o.chordPts >> 1), cut.hinge, 1));
      const ccols = cts[0].length + 1;
      const crows = cb.addGrid(sts.length, ccols, (i, j, out) => {
        const cn = cts[i];
        const pt = cn[j % cn.length];
        plan.place(sx, sts[i], pt.x, pt.y, v);
        out.x = v.x; out.y = v.y; out.z = v.z;
        const cf = j === cn.length ? cn[0].s : pt.s;
        const [u, vv] = o.uv(sx * sts[i], cf, j === cn.length ? -cn[0].side : pt.side);
        out.u = u; out.v = vv;
      }, sx < 0);
      // End ribs.
      for (const [ri, flip] of [[0, sx > 0], [sts.length - 1, sx < 0]] as [number, boolean][]) {
        plan.place(sx, sts[ri], (cut.hinge + 1) * 0.5, 0, v);
        const c = cb.vert(v.x, v.y, v.z, ...o.uv(sx * sts[ri], (cut.hinge + 1) * 0.5, 1));
        cb.fan(c, crows[ri], flip);
      }
      const geo = cb.build(true);

      // Hinge line: mid-thickness at the hinge station, inboard end to outboard.
      const pA = plan.place(sx, e0, cut.hinge, 0, new THREE.Vector3());
      const pB = plan.place(sx, e1, cut.hinge, 0, new THREE.Vector3());
      const mid = pA.clone().add(pB).multiplyScalar(0.5);
      let axis = pB.clone().sub(pA).normalize();
      if (!cut.mirrored && axis.x < 0) axis.negate();
      parts.push({ name: cut.name, half: sx, geometry: geo, point: mid, axis });
    }
  }

  return { skin: mergeGeoms(skins), parts };
}

// ---------------------------------------------------------------------------
// Wing-root fillet
// ---------------------------------------------------------------------------

export interface FilletOpts {
  /** Chordwise stations along the root. */
  stations: number;
  /** Blend steps across the fillet. */
  steps: number;
  /** How far behind the root trailing edge the fairing runs, in root chords. */
  aftChords: number;
  /** Angular size of the fillet on the fuselage at the LE / at the aft end. */
  dTheta0: number;
  dTheta1: number;
  /** UV callback in fuselage space: (t, θ/2π). */
  uv: (t: number, theta01: number) => [number, number];
  halves: number[];
}

/**
 * Blend the wing root into the fuselage with a proper tangent-continuous
 * fillet.
 *
 * At every chordwise station the fillet cross-section is a quadratic Bézier from
 * a point A on the wing skin to a point B on the fuselage skin, with its control
 * point at the intersection of the two surface tangents. That construction is
 * tangent to both surfaces by definition — which is the whole point, because a
 * fillet that is merely *near* both surfaces reads as a lump of putty.
 *
 * The fairing keeps going aft of the trailing edge, growing in angular size and
 * then dying onto the fuselage, which is what real root fairings do and what
 * stops the wing root looking like two shapes that collided.
 */
export function buildWingFillet(
  prof: FuselageProfile, plan: WingPlan, o: FilletOpts,
): THREE.BufferGeometry {
  const geoms: THREE.BufferGeometry[] = [];
  const zLE = plan.leZAt(0) - 0.02;
  const zTE = plan.teZAt(0);
  const zEnd = zTE - plan.o.rootChord * o.aftChords;

  for (const sx of o.halves) {
    for (const side of [1, -1]) {
      const b = new MeshBuilder();
      b.addGrid(o.stations, o.steps + 1, (i, j, out) => {
        const ti = i / (o.stations - 1);
        const z = zLE + (zEnd - zLE) * ti;
        const aft = z >= zTE ? 0 : Math.min(1, (zTE - z) / Math.max(1e-3, zTE - zEnd));
        const chordFrac = Math.min(1, Math.max(0, (zLE - z) / Math.max(1e-3, zLE - zTE)));

        // --- B: the point on the fuselage skin --------------------------------
        const hw = prof.halfWidth(z);
        const xF = hw * (1.06 + 0.30 * aft);
        let yW = plan.surfaceY(sx * xF, z, side);
        if (yW === null) yW = plan.surfaceY(sx * xF, zTE + 0.01, side) ?? prof.at(z).yc;
        const thJoint = thetaAtHeight(prof, z, yW, sx);
        // The upper fillet is a small radius; the big fairing is underneath,
        // where the wing meets the belly. Sizing them the same is what makes a
        // procedural wing root look inflated.
        const dTh = (o.dTheta0 + (o.dTheta1 - o.dTheta0) * (0.35 * chordFrac + 0.65 * aft))
          * (side > 0 ? 0.55 : 1.0);
        const thB = thJoint + sx * side * dTh;
        const B = prof.point(z, thB, _b1);
        const Bt = tangentAt(prof, z, thB, _t1);

        // --- A: the point on the wing skin -----------------------------------
        const A = _a1.set(sx * xF, yW, z);
        // Wing surface tangent in the cross-section plane, pointing inboard.
        const yIn = plan.surfaceY(sx * xF * 0.72, z, side);
        const At = _t2.set(-sx * xF * 0.28, (yIn ?? yW) - yW, 0).normalize();
        // Aft of the trailing edge the fairing collapses onto the fuselage.
        const kill = 1 - Math.min(1, Math.max(0, (zTE - z) / Math.max(1e-3, zTE - zEnd)));
        A.lerp(B, 1 - kill * kill);

        // --- Bézier control point = tangent intersection ----------------------
        const span = Math.hypot(B.x - A.x, B.y - A.y);
        const C = intersect2D(A.x, A.y, At.x, At.y, B.x, B.y, Bt.x, Bt.y, span, _c1);
        const t = j / o.steps;
        const mt = 1 - t;
        out.x = mt * mt * A.x + 2 * mt * t * C.x + t * t * B.x;
        out.y = mt * mt * A.y + 2 * mt * t * C.y + t * t * B.y;
        out.z = z;

        // The fillet is unwrapped as part of the fuselage so panel lines and
        // camouflage run across it without a visible discontinuity.
        const thEff = thJoint + (thB - thJoint) * t;
        const [u, vv] = o.uv(prof.tOfZ(z), ((thEff / (Math.PI * 2)) % 1 + 1) % 1);
        out.u = u; out.v = vv;
      }, (sx * side) < 0);
      // The four patches (two sides × two halves) do not all come out of the
      // lattice with the same handedness, and a fillet lit from inside reads as
      // a black gash across the wing root. Rather than reason about the winding
      // per case, orient each patch empirically against the fuselage axis.
      geoms.push(orientOutward(b.build(true), plan.o.z0));
    }
  }
  return mergeGeoms(geoms);
}

/** Flip a patch's winding if its normals point back at the fuselage centreline. */
function orientOutward(geo: THREE.BufferGeometry, zRef: number): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  if (!pos || !nrm) return geo;
  let acc = 0;
  const step = Math.max(1, Math.floor(pos.count / 64));
  for (let i = 0; i < pos.count; i += step) {
    // Reference direction: away from the fuselage axis at the same station.
    const dx = pos.getX(i), dy = pos.getY(i);
    const l = Math.hypot(dx, dy) || 1;
    acc += (nrm.getX(i) * dx + nrm.getY(i) * dy) / l;
  }
  if (acc < 0) {
    const idx = geo.getIndex();
    if (idx) {
      for (let i = 0; i < idx.count; i += 3) {
        const a = idx.getX(i + 1);
        idx.setX(i + 1, idx.getX(i + 2));
        idx.setX(i + 2, a);
      }
      idx.needsUpdate = true;
    }
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, -nrm.getX(i), -nrm.getY(i), -nrm.getZ(i));
    nrm.needsUpdate = true;
  }
  void zRef;
  return geo;
}

const _a1 = new THREE.Vector3(), _b1 = new THREE.Vector3(), _c1 = new THREE.Vector3();
const _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3();

/**
 * Find θ where the fuselage skin is at height y, on the side given by 'sx'.
 * Height is monotone in θ over a half section, so bisection is exact and cheap.
 */
function thetaAtHeight(prof: FuselageProfile, z: number, y: number, sx: number): number {
  let lo = 0.02, hi = Math.PI - 0.02;
  for (let k = 0; k < 22; k++) {
    const mid = (lo + hi) * 0.5;
    if (prof.point(z, mid, _b1).y < y) lo = mid; else hi = mid;
  }
  const th = (lo + hi) * 0.5;
  return sx > 0 ? th : Math.PI * 2 - th;
}

function tangentAt(prof: FuselageProfile, z: number, th: number, out: THREE.Vector3): THREE.Vector3 {
  const d = 2e-3;
  const a = prof.point(z, th + d, _a1);
  const ax = a.x, ay = a.y;
  const c = prof.point(z, th - d, _a1);
  return out.set(ax - c.x, ay - c.y, 0).normalize();
}

/**
 * Intersection of two 2D lines, used to place the fillet's Bézier control
 * point. 'span' is the A–B distance: the control point is clamped to just over
 * that, because a shallow tangent intersection would otherwise fling it metres
 * away and balloon the fillet into a fairing the size of the fuselage.
 */
function intersect2D(
  px: number, py: number, dx: number, dy: number,
  qx: number, qy: number, ex: number, ey: number, span: number, out: THREE.Vector3,
): THREE.Vector3 {
  const den = dx * ey - dy * ex;
  const lim = span * 1.1;
  if (Math.abs(den) < 1e-4) return out.set((px + qx) * 0.5, (py + qy) * 0.5, 0);
  const t = ((qx - px) * ey - (qy - py) * ex) / den;
  const tc = Math.max(-lim, Math.min(lim, t));
  return out.set(px + dx * tc, py + dy * tc, 0);
}
