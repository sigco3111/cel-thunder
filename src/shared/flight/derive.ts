/**
 * Turns an 'AircraftSpec' into the concrete geometry the physics integrator
 * needs: a set of discrete aerodynamic strips, undercarriage legs, structural
 * contact points and a propeller.
 *
 * Two things happen here that are worth understanding:
 *
 * 1. **The spec's handling numbers are honoured by construction.** 'cmAlpha',
 *    'cnBeta', 'clBeta', 'rollRate' and 'yawRate' are not applied as lumped
 *    moment terms at run time. Instead this module *solves the geometry* —
 *    where the wing's aerodynamic centre sits, how much effective dihedral the
 *    panels get, how big the fin's lift slope is, how far the ailerons throw —
 *    so that the emergent behaviour of the strip model matches the spec. That
 *    keeps every run-time force physical while still letting the designer tune
 *    an aircraft by editing one number.
 *
 * 2. **Each wing is split into an inboard and an outboard panel.** Four wing
 *    strips rather than two is what makes tip-stall, washout, differential
 *    ailerons, propwash over the wing root and autorotation fall out of the
 *    same code path instead of needing special cases.
 *
 * Everything here runs once per archetype and is cached.
 */

import { clamp, v3, vcross, vnorm, vset, type V3 } from '../math';
import type { AircraftSpec } from '../aircraft';
import {
  DG_BODY, DG_FIN, DG_NONE, DG_TAIL, DG_WING_L, DG_WING_R, G0, RHO0,
  type DerivedSpec, type GearLeg, type HardPoint, type Surface,
} from './types';

/** 2-D lift-curve slope of a thin section, per rad. */
const A2D = 2 * Math.PI * 0.94;

/** Spanwise station splitting the inboard and outboard wing panels. */
const PANEL_SPLIT = 0.55;
/** Geometric washout applied to the outboard panels, rad. Tips stall last. */
const WASHOUT = 0.026;

/** Finite-wing lift slope from the 2-D slope and aspect ratio. */
function liftSlope3D(ar: number, e: number, a2d = A2D): number {
  return a2d / (1 + a2d / (Math.PI * Math.max(ar, 0.2) * e));
}

/** Local chord at spanwise station η ∈ [0,1]. */
function chordAt(root: number, tip: number, elliptical: boolean, eta: number): number {
  if (!elliptical) return root + (tip - root) * eta;
  // Ellipse that still lands exactly on the specified tip chord, so the two
  // planform families share the same parameters.
  const k = tip / Math.max(root, 1e-4);
  return root * Math.sqrt(Math.max(0, 1 - eta * eta * (1 - k * k)));
}

interface PanelGeom { area: number; centroid: number; meanChord: number }

/** Integrate a planform strip between two spanwise stations. */
function panelGeom(
  root: number, tip: number, elliptical: boolean, e0: number, e1: number, semi: number,
): PanelGeom {
  const N = 32;
  let a = 0, m = 0;
  for (let i = 0; i < N; i++) {
    const t0 = e0 + (e1 - e0) * (i / N);
    const t1 = e0 + (e1 - e0) * ((i + 1) / N);
    const tm = 0.5 * (t0 + t1);
    const c = chordAt(root, tip, elliptical, tm);
    const dEta = t1 - t0;
    a += c * dEta;
    m += c * tm * dEta;
  }
  return {
    area: a * semi,
    centroid: (a > 1e-6 ? m / a : 0.5 * (e0 + e1)) * semi,
    meanChord: a / Math.max(e1 - e0, 1e-6),
  };
}

/** Build a surface's orthonormal triad from an incidence and a dihedral angle. */
function orient(surf: Surface, incidence: number, dihedral: number, mirror: boolean): void {
  const si = Math.sin(incidence), ci = Math.cos(incidence);
  const g = mirror ? -dihedral : dihedral;
  const sg = Math.sin(g), cg = Math.cos(g);
  // Chord line pitched nose-up by 'incidence' about the span axis, then the
  // whole panel rotated about +Z by the dihedral. A right panel with positive
  // dihedral has its lift normal tilted *inboard* — that inward tilt is what
  // produces the restoring roll in a sideslip.
  vset(surf.chord, -si * sg, si * cg, ci);
  vset(surf.normal, -ci * sg, ci * cg, -si);
  vnorm(surf.chord, surf.chord);
  vnorm(surf.normal, surf.normal);
  vcross(surf.normal, surf.chord, surf.spanDir);
  vnorm(surf.spanDir, surf.spanDir);
}

function blankSurface(id: string, kind: Surface['kind'], index: number): Surface {
  return {
    id, kind, side: 0, index,
    pos: v3(), normal: v3(0, 1, 0), chord: v3(0, 0, 1), spanDir: v3(1, 0, 0),
    area: 1, chordLen: 1, ar: 6, oswald: 0.8, liftSlope: 5, cl0: 0,
    clMax: 1.4, clMin: -1.0, stallAlpha: 0.28, cd0: 0.009,
    elevator: 0, aileron: 0, rudder: 0, flap: 0, flapCd: 0,
    wash: 0, downwash: 0, damageGroup: DG_NONE, isWing: false,
  };
}

/** Overlap of the interval [a0,a1] with [0,R], as a fraction of its length. */
function immersion(a0: number, a1: number, R: number): number {
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  if (hi <= lo + 1e-6) return lo < R ? 1 : 0;
  return clamp((Math.min(hi, R) - Math.min(lo, R)) / (hi - lo), 0, 1);
}

const cache = new WeakMap<AircraftSpec, DerivedSpec>();

/** Build (and cache) everything derivable from an archetype. */
export function getDerived(spec: AircraftSpec): DerivedSpec {
  let d = cache.get(spec);
  if (!d) { d = build(spec); cache.set(spec, d); }
  return d;
}

function build(spec: AircraftSpec): DerivedSpec {
  const aero = spec.aero, geom = spec.geom, eng = spec.engine;
  const S = aero.wingArea, b = aero.span, c = aero.chord;
  const semi = b * 0.5;
  const arWing = (b * b) / S;
  const surfaces: Surface[] = [];

  // ---- wing panels -------------------------------------------------------
  const w = geom.wing;
  const gIn = panelGeom(w.rootChord, w.tipChord, geom.ellipticalWing, 0, PANEL_SPLIT, semi);
  const gOut = panelGeom(w.rootChord, w.tipChord, geom.ellipticalWing, PANEL_SPLIT, 1, semi);
  // Rescale so the four panels reproduce the spec's reference area exactly.
  const areaScale = S / (2 * (gIn.area + gOut.area));
  const areaIn = gIn.area * areaScale, areaOut = gOut.area * areaScale;

  // ---- horizontal tail ---------------------------------------------------
  const hs = geom.hStab;
  const areaTailHalf = hs.span * hs.chord * 0.5;
  const arTail = (hs.span * hs.span) / (hs.span * hs.chord);
  const aTail = liftSlope3D(arTail, 0.9);
  const yTail = hs.span * 0.25;
  const yTailIn = 0, yTailOut = hs.span * 0.5;

  // ---- fin ---------------------------------------------------------------
  const vs = geom.vStab;
  const areaFin = vs.height * vs.chord * 0.86;
  // The fuselage acts as a partial end plate, so a fin's effective aspect
  // ratio runs ~1.5× its geometric value.
  const arFin = 1.55 * (vs.height * vs.height) / areaFin;
  const aFinBase = liftSlope3D(arFin, 0.85);
  const finY = vs.height * 0.38 + geom.fuseRadius * 0.5;

  // ---- fuselage ----------------------------------------------------------
  const noseZ = geom.length * 0.47;
  const areaBody = Math.PI * geom.fuseRadius * geom.fuseRadius;
  // Slender-body cross-flow acts around a quarter of the body length aft of
  // the nose — well forward of the CG, which is exactly why it is destabilising.
  const zBody = noseZ - 0.25 * geom.length;
  const aBody = 2.0;

  // ---- stability calibration --------------------------------------------
  // Fin scale so the emergent weathercock stiffness matches spec.cnBeta.
  const finArm = Math.max(0.5, -vs.z);
  const cnFinBase = aFinBase * 0.95 * (areaFin / S) * (finArm / b);
  const cnBody = -aBody * (areaBody / S) * (zBody / b);
  const finScale = clamp((aero.cnBeta - cnBody) / Math.max(cnFinBase, 1e-4), 0.4, 3.0);
  const aFin = aFinBase * finScale;

  // Effective dihedral so the emergent roll-due-to-sideslip matches spec.clBeta.
  // The fin sits above the CG and contributes too, so it is subtracted first.
  const clBetaFin = aFin * 0.95 * (areaFin / S) * (finY / b);
  const dihedralScale = clamp(
    (Math.abs(aero.clBeta) - clBetaFin) * 4 / Math.max(aero.clAlpha * w.dihedral, 1e-3),
    0.2, 2.2,
  );
  const dihEff = w.dihedral * dihedralScale;

  // Wing AC station so the neutral point lands the spec's static margin behind
  // the CG.  z_np = Σ(S·a·η·z)/Σ(S·a·η)  →  solve for the wing term.
  const sm = clamp(-aero.cmAlpha / Math.max(aero.clAlpha, 1e-3), 0.02, 0.45);
  const deps = 4 / (arWing + 2);                       // dε/dα
  const wWing = S * aero.clAlpha;
  const wTail = 2 * areaTailHalf * aTail * (1 - deps) * 0.92;
  const wBody = areaBody * aBody;
  const tanSweep = Math.tan(w.sweep);
  const sweepShift =
    2 * (areaIn * aero.clAlpha * gIn.centroid + areaOut * aero.clAlpha * gOut.centroid) * tanSweep;
  const wingAcZ =
    (-sm * c * (wWing + wTail + wBody) + sweepShift - wTail * hs.z - wBody * zBody) / wWing;

  // ---- residual damping --------------------------------------------------
  // Strip theory produces the right *shape* of damping but the reference tail
  // volumes in the archetypes are smaller than the real aircraft's, so a
  // residual derivative tops each axis up to the specified handling. The
  // spec's 'damp' array is treated as a relative tuning knob against these
  // reference values rather than as literal derivatives.
  const cmqRes = 12.0 * (aero.damp[0] / 11.0);
  const cnrRes = 0.09 * (aero.damp[1] / 4.6);
  const clpRes = 0.12 * (aero.damp[2] / 5.6);

  // ---- surface construction ---------------------------------------------
  const mkWing = (side: -1 | 1, outer: boolean): Surface => {
    const g = outer ? gOut : gIn;
    const s = blankSurface(`wing${side < 0 ? 'L' : 'R'}${outer ? 'Out' : 'In'}`, 'wing', surfaces.length);
    s.side = side;
    s.area = outer ? areaOut : areaIn;
    s.chordLen = g.meanChord;
    s.ar = arWing;
    s.oswald = aero.oswald;
    s.liftSlope = aero.clAlpha;
    s.cl0 = aero.cl0;
    s.clMax = aero.clMax;
    s.clMin = -aero.clMax * 0.72;
    s.stallAlpha = aero.stallAlpha + (outer ? 0.012 : 0);
    s.cd0 = 0.0085;
    s.damageGroup = side < 0 ? DG_WING_L : DG_WING_R;
    s.isWing = true;
    const inc = w.incidence - (outer ? WASHOUT : 0);
    orient(s, inc, dihEff, side < 0);
    const y = g.centroid;
    vset(s.pos,
      side * y * Math.cos(w.dihedral),
      geom.wingY + y * Math.sin(w.dihedral),
      wingAcZ - y * tanSweep);
    const eta0 = outer ? PANEL_SPLIT * semi : 0;
    const eta1 = outer ? semi : PANEL_SPLIT * semi;
    // Only the inboard third of the wing sits in a fully developed slipstream,
    // and it is only ~half a diameter behind the disc, so the wash is weaker
    // there than over the tail.
    s.wash = immersion(eta0, eta1, eng.propDia * 0.42) * 0.7;
    return s;
  };
  surfaces.push(mkWing(-1, false), mkWing(1, false), mkWing(-1, true), mkWing(1, true));

  const mkTail = (side: -1 | 1): Surface => {
    const s = blankSurface(`hstab${side < 0 ? 'L' : 'R'}`, 'hstab', surfaces.length);
    s.side = side;
    s.area = areaTailHalf;
    s.chordLen = hs.chord;
    s.ar = arTail;
    s.oswald = 0.9;
    s.liftSlope = aTail;
    s.cl0 = 0;
    s.clMax = 1.5;      // symmetric section with a large plain flap
    s.clMin = -1.5;
    s.stallAlpha = 0.36;
    s.cd0 = 0.0095;
    s.damageGroup = DG_TAIL;
    orient(s, 0, 0, side < 0);
    vset(s.pos, side * yTail, geom.fuseRadius * 0.15, hs.z);
    s.downwash = 1;
    s.wash = immersion(yTailIn, yTailOut, eng.propDia * 0.42);
    return s;
  };
  surfaces.push(mkTail(-1), mkTail(1));

  const fin = blankSurface('fin', 'fin', surfaces.length);
  fin.side = 0;
  fin.area = areaFin;
  fin.chordLen = vs.chord;
  fin.ar = arFin;
  fin.oswald = 0.85;
  fin.liftSlope = aFin;
  fin.cl0 = 0;
  fin.clMax = 1.5;
  fin.clMin = -1.5;
  fin.stallAlpha = 0.42;     // low aspect ratio → stalls late
  fin.cd0 = 0.0095;
  fin.damageGroup = DG_FIN;
  {
    // Fin rigged a degree off the centreline to trim out the slipstream swirl
    // at climb power — exactly what the real aircraft did.
    const eps = -eng.propDir * 0.017;
    const se = Math.sin(eps), ce = Math.cos(eps);
    vset(fin.chord, se, 0, ce);
    vset(fin.normal, ce, 0, -se);
    vcross(fin.normal, fin.chord, fin.spanDir);
    vnorm(fin.spanDir, fin.spanDir);
    vset(fin.pos, 0, finY, vs.z);
  }
  fin.wash = immersion(geom.fuseRadius * 0.5, geom.fuseRadius * 0.5 + vs.height, eng.propDia * 0.42);
  surfaces.push(fin);

  const fuseV = blankSurface('fuseV', 'body', surfaces.length);
  fuseV.area = areaBody; fuseV.chordLen = geom.length * 0.4; fuseV.ar = 0.55;
  fuseV.oswald = 0.7; fuseV.liftSlope = aBody; fuseV.clMax = 1.2; fuseV.clMin = -1.2;
  fuseV.stallAlpha = 0.6; fuseV.cd0 = 0.02; fuseV.damageGroup = DG_BODY;
  vset(fuseV.pos, 0, 0, zBody);
  vset(fuseV.normal, 0, 1, 0); vset(fuseV.chord, 0, 0, 1); vset(fuseV.spanDir, 1, 0, 0);
  surfaces.push(fuseV);

  const fuseH = blankSurface('fuseH', 'body', surfaces.length);
  fuseH.area = areaBody; fuseH.chordLen = geom.length * 0.4; fuseH.ar = 0.55;
  fuseH.oswald = 0.7; fuseH.liftSlope = aBody; fuseH.clMax = 1.2; fuseH.clMin = -1.2;
  fuseH.stallAlpha = 0.6; fuseH.cd0 = 0.02; fuseH.damageGroup = DG_BODY;
  vset(fuseH.pos, 0, geom.fuseRadius * 0.2, zBody);
  vset(fuseH.normal, 1, 0, 0); vset(fuseH.chord, 0, 0, 1); vset(fuseH.spanDir, 0, -1, 0);
  surfaces.push(fuseH);

  // Assign the per-surface state indices only now: 'Array.push(a(), b())'
  // evaluates every argument before any of them lands in the array, so the
  // constructors above cannot use 'surfaces.length' to number themselves.
  for (let i = 0; i < surfaces.length; i++) surfaces[i].index = i;

  // ---- control heaviness --------------------------------------------------
  // Stick force scales with q·δ, so the deflection a pilot can hold falls as
  // 1/q above a reference speed. Deriving that reference from the archetype's
  // own max roll rate makes the Bf 109's and the Zero's famous aileron
  // stiffening emerge from their spec numbers rather than a special case.
  const vHeavyRoll = clamp(100 * (aero.rollRate / 2.0), 68, 150);
  const vHeavyPitch = clamp(118 * (aero.pitchRate / 1.2), 80, 190);
  const vHeavyYaw = clamp(112 * (aero.yawRate / 0.6), 75, 170);

  // ---- control power ------------------------------------------------------
  // Ailerons: solved so the steady roll rate at 400 km/h IAS equals spec.rollRate.
  const vRoll = 111.1;                        // 400 km/h
  const qRoll = 0.5 * RHO0 * vRoll * vRoll;
  let sumSy2 = 0;
  for (const s of surfaces) if (s.isWing) sumSy2 += s.area * s.pos.x * s.pos.x;
  const ailArmSum =
    Math.abs(surfaces[2].pos.x) * areaOut * 1.0 + Math.abs(surfaces[3].pos.x) * areaOut * 0.62;
  // The reference roll rate is quoted at 400 km/h IAS, which is a speed at
  // which several of these archetypes can no longer hold full aileron. Divide
  // the requirement by the authority actually available there, so the *quoted*
  // rate is what the aircraft really achieves and the stiffening still bites
  // above it.
  const rollAuthAtRef = vRoll > vHeavyRoll ? Math.pow(vHeavyRoll / vRoll, 1.8) : 1;
  const ailPower = clamp(
    (aero.rollRate / (vRoll * Math.max(ailArmSum, 1e-3) * rollAuthAtRef)) *
      (aero.clAlpha * sumSy2 + clpRes * S * b * b * 0.5),
    0.1, 3.0,
  );
  surfaces[2].aileron = -ailPower;   // left outer  (index 2 is the LEFT outer)
  surfaces[3].aileron = -ailPower;   // right outer — sign resolved per-side below

  // Elevator: sized so full deflection can hold the wing well *past* its stall
  // angle, not merely up to it. A fighter that cannot be held stalled cannot
  // be spun, and being able to spin it — and having to recover — is part of
  // the point. The margin is deliberately generous because the aircraft's
  // pitching moment stops growing linearly once the wing separates.
  const elevPower = clamp(
    (Math.abs(aero.cmAlpha) * (aero.stallAlpha + 0.16) * S * c) /
      Math.max(2 * areaTailHalf * Math.abs(hs.z) * 0.92, 1e-3),
    0.5, 2.6,
  );
  // Negative: a nose-UP command deflects the elevator up, which makes the
  // tailplane lift *downwards*; that download aft of the CG is what raises the
  // nose. (Moment check: F = +Y at z = −l gives Mx = +l·F, and +Mx is nose-down
  // in this body frame — see types.ts.)
  surfaces[4].elevator = -elevPower;
  surfaces[5].elevator = -elevPower;

  // Rudder: sized for ~13° of steady sideslip at full pedal.
  const rudPower = clamp(
    (aero.cnBeta * 0.22 * S * b) / Math.max(areaFin * finArm, 1e-3),
    0.25, 2.0,
  );
  fin.rudder = -rudPower;   // negative fin lift → tail swings left → nose right

  // Flaps live on the inboard panels only; scale so the whole-wing ΔCL matches.
  const flapScale = S / Math.max(2 * areaIn, 1e-3);
  surfaces[0].flap = aero.flapCl * flapScale;
  surfaces[1].flap = aero.flapCl * flapScale;
  surfaces[0].flapCd = aero.flapCd * flapScale * 0.45;
  surfaces[1].flapCd = aero.flapCd * flapScale * 0.45;

  // ---- drag bookkeeping ---------------------------------------------------
  let surfaceCd0Area = 0;
  for (const s of surfaces) surfaceCd0Area += s.cd0 * s.area;
  let parasiteArea = aero.cd0 * S - surfaceCd0Area;
  if (parasiteArea < 0.05 * aero.cd0 * S) {
    // The archetype's cd0 is tighter than the sum of the strip profile drags;
    // shrink the strips proportionally rather than inventing negative drag.
    const k = (aero.cd0 * S * 0.95) / Math.max(surfaceCd0Area, 1e-6);
    for (const s of surfaces) s.cd0 *= k;
    parasiteArea = aero.cd0 * S * 0.05;
  }

  // ---- propeller ----------------------------------------------------------
  const propRadius = eng.propDia * 0.5;
  const propDiscArea = Math.PI * propRadius * propRadius;
  const gearRatio = eng.kind === 'inline' ? 0.50 : 0.60;
  // A metal constant-speed prop: I ≈ 0.11·m_blade·R² summed over blades. Mass
  // scales roughly with D³, which is what this collapses to.
  const propInertia = 0.38 * eng.blades * Math.pow(propRadius, 3.2);
  const rotInertia = 1.6 + propInertia * gearRatio * gearRatio;
  const bladeChord = 0.075 * eng.propDia * Math.pow(3 / eng.blades, 0.35);
  const bladeAreaArm = bladeChord * propRadius * 0.75;
  const qTorque = eng.blades * 0.5 * bladeAreaArm * 5.6 * (0.7 * propRadius);
  const qProfile = eng.blades * 0.5 * bladeAreaArm;

  // ---- undercarriage ------------------------------------------------------
  const g0 = geom.gear;
  const massFull = aero.mass;
  const wheelR = clamp(geom.length * 0.036, 0.2, 0.45);
  const tailWheelR = wheelR * 0.4;
  const gearLegs: GearLeg[] = [];
  const mkMain = (side: -1 | 1): GearLeg => {
    const staticComp = 0.09;
    const k = (0.45 * massFull * G0) / staticComp;
    return {
      role: side < 0 ? 'main-left' : 'main-right',
      mount: v3(side * g0.track * 0.5, geom.wingY, g0.mainZ),
      axis: v3(0, -1, 0),
      restLength: g0.legLen,
      travel: 0.26,
      radius: wheelR,
      spring: k,
      damper: 2 * 0.55 * Math.sqrt(k * 0.45 * massFull),
      rollMu: 0.022,
      brakeMu: 0.55,
      sideMu: 0.85,
      steerMax: 0,
      breakVs: 4.6,
      index: gearLegs.length,
    };
  };
  gearLegs.push(mkMain(-1), mkMain(1));
  if (g0.tailWheel) {
    const staticComp = 0.03;
    const k = (0.12 * massFull * G0) / staticComp;
    gearLegs.push({
      role: 'tail',
      mount: v3(0, -geom.fuseRadius * 0.35, vs.z + 0.25),
      axis: v3(0, -1, 0),
      restLength: 0.16,
      travel: 0.1,
      radius: tailWheelR,
      spring: k,
      damper: 2 * 0.6 * Math.sqrt(k * 0.12 * massFull),
      rollMu: 0.03,
      brakeMu: 0,
      // A deliberately low lateral limit: once the tail slides the aircraft
      // will try to swap ends, which is the ground loop.
      sideMu: 0.52,
      // Negative on purpose: steering a *trailing* wheel to the right drags
      // the tail right, which swings the nose left. Right rudder therefore
      // castors the tailwheel left.
      steerMax: -0.28,
      breakVs: 5.5,
      index: gearLegs.length,
    });
  } else {
    const staticComp = 0.05;
    const k = (0.14 * massFull * G0) / staticComp;
    gearLegs.push({
      role: 'nose',
      mount: v3(0, geom.wingY * 0.4, noseZ - 1.1),
      axis: v3(0, -1, 0),
      restLength: g0.legLen * 1.05,
      travel: 0.2,
      radius: tailWheelR * 1.6,
      spring: k,
      damper: 2 * 0.6 * Math.sqrt(k * 0.14 * massFull),
      rollMu: 0.025,
      brakeMu: 0,
      sideMu: 0.8,
      steerMax: 0.32,
      breakVs: 4.2,
      index: gearLegs.length,
    });
  }

  // Static ground line: the plane through the three unloaded contact points.
  const contact = gearLegs.map((l) => ({
    x: l.mount.x, y: l.mount.y - l.restLength - l.radius, z: l.mount.z,
  }));
  const groundPitch = (() => {
    const rear = contact[2], fwd = contact[0];
    const dz = fwd.z - rear.z;
    return dz !== 0 ? Math.atan2(rear.y - fwd.y, Math.abs(dz)) : 0;
  })();
  const groundOffsetY = contact[0].y;

  // Prop hub: on the thrust line but lifted just enough that the disc clears
  // the ground at the static attitude with 15 cm to spare.
  const propZ = noseZ - 0.3;
  const gn = (() => {
    // Normal of the static ground plane expressed in body coordinates.
    const ax = contact[1].x - contact[0].x, ay = contact[1].y - contact[0].y, az = contact[1].z - contact[0].z;
    const bx = contact[2].x - contact[0].x, by = contact[2].y - contact[0].y, bz = contact[2].z - contact[0].z;
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    return { x: nx, y: ny, z: nz, d: nx * contact[0].x + ny * contact[0].y + nz * contact[0].z };
  })();
  const discDrop = propRadius * Math.sqrt(Math.max(0, 1 - gn.z * gn.z));
  const propY = clamp(
    (gn.d + discDrop + 0.15 - gn.z * propZ) / Math.max(gn.y, 0.2),
    -0.1, 0.55,
  );

  // ---- structural contact points -----------------------------------------
  const hardPoints: HardPoint[] = [];
  const mkHard = (id: string, x: number, y: number, z: number, r: number, frag: number) => {
    hardPoints.push({ id, pos: v3(x, y, z), radius: r, fragility: frag, index: hardPoints.length });
  };
  mkHard('spinner', 0, propY, propZ + 0.2, 0.14, 1.5);
  mkHard('bellyFwd', 0, -geom.fuseRadius * 0.98, geom.length * 0.2, 0.3, 1.0);
  mkHard('bellyMid', 0, -geom.fuseRadius * 0.95, -geom.length * 0.05, 0.3, 0.85);
  mkHard('bellyAft', 0, -geom.fuseRadius * 0.72, -geom.length * 0.3, 0.28, 0.8);
  mkHard('tailSkid', 0, -geom.fuseRadius * 0.3, vs.z - 0.3, 0.16, 0.7);
  const tipY = geom.wingY + semi * 0.97 * Math.sin(w.dihedral);
  mkHard('tipL', -semi * 0.97, tipY, wingAcZ - semi * tanSweep, 0.15, 1.15);
  mkHard('tipR', semi * 0.97, tipY, wingAcZ - semi * tanSweep, 0.15, 1.15);
  mkHard('canopy', 0, geom.canopy.height + geom.fuseRadius * 0.55, (geom.canopy.z0 + geom.canopy.z1) * 0.5, 0.28, 1.35);
  mkHard('finTop', 0, vs.height + geom.fuseRadius * 0.55, vs.z, 0.2, 1.25);

  // Nothing except the wheels may touch the ground when the aircraft is simply
  // parked. Archetype geometry is authored for looks, not for clearance, so
  // any structural point that would foul the static ground line is lifted just
  // clear of it. (The belly points still sit well below the wheels, so a
  // gear-up landing lands on them as intended.)
  {
    const need = 0.16;
    for (const hp of hardPoints) {
      const above = gn.x * hp.pos.x + gn.y * hp.pos.y + gn.z * hp.pos.z - gn.d;
      const slack = above - hp.radius - need;
      if (slack < 0) hp.pos.y += -slack / Math.max(gn.y, 0.25);
    }
  }

  // ---- speeds -------------------------------------------------------------
  const vStall = Math.sqrt((2 * massFull * G0) / (RHO0 * S * aero.clMax));
  const vCorner = vStall * Math.sqrt(aero.gLimit);

  const derived: DerivedSpec = {
    spec,
    surfaces,
    nSurf: surfaces.length,
    gearLegs,
    nLegs: gearLegs.length,
    hardPoints,
    nHard: hardPoints.length,
    parasiteArea,
    gearArea: aero.gearCd * S,
    flapArea: aero.flapCd * S * 0.55,
    brakeArea: aero.brakeCd * S,
    radiatorArea: 0.011 * S,
    wingArea: S,
    span: b,
    chord: c,
    massFull,
    massDry: massFull - spec.damage.fuel,
    wingMass: massFull * 0.105,
    wingMassArm: semi * 0.36,
    inertia: v3(aero.inertia[0], aero.inertia[1], aero.inertia[2]),
    propPos: v3(0, propY, propZ),
    propRadius,
    propDiscArea,
    gearRatio,
    rotInertia,
    propInertia,
    qTorque,
    qProfile,
    slipRadius: propRadius * 0.85,
    mapRated: 200000,
    mapIdle: 30000,
    superPR: 1,
    vHeavyRoll,
    vHeavyPitch,
    vHeavyYaw,
    flapLimit: aero.vne * 0.52,
    gearLimit: aero.vne * 0.62,
    cmqRes,
    cnrRes,
    clpRes,
    wingAcZ,
    dihedralScale,
    finScale,
    pilotY: geom.canopy.height * 0.35 + geom.fuseRadius * 0.2,
    pilotZ: (geom.canopy.z0 + geom.canopy.z1) * 0.5,
    groundPitch,
    groundOffsetY,
    vStall,
    vCorner,
  };

  // Supercharger: the pressure ratio that just holds rated manifold pressure
  // at the archetype's critical altitude.
  const pCrit = isaPressureLocal(eng.critAlt);
  derived.superPR = derived.mapRated / Math.max(pCrit, 1000);

  // Resolve the aileron signs now that we know which index is which side.
  for (const s of surfaces) {
    if (s.aileron !== 0) s.aileron = s.side > 0 ? -Math.abs(s.aileron) : Math.abs(s.aileron);
  }

  return derived;
}

/** Local ISA pressure — duplicated to keep 'derive' free of import cycles. */
function isaPressureLocal(y: number): number {
  const T0l = 288.15, L = 0.0065, R = 287.05287;
  if (y < 11000) return 101325 * Math.pow((T0l - L * y) / T0l, 9.80665 / (R * L));
  const pT = 101325 * Math.pow((T0l - L * 11000) / T0l, 9.80665 / (R * L));
  return pT * Math.exp(-9.80665 * (y - 11000) / (R * (T0l - L * 11000)));
}
