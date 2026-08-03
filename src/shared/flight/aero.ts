/**
 * Strip-theory aerodynamics.
 *
 * One function, 'evalSurface', evaluates a single aerodynamic strip in the
 * local flow — including the strip's own velocity from the body's rotation
 * rate, the propeller slipstream (axial *and* swirl), and the wing's downwash
 * where it applies — and accumulates the resulting force and moment.
 *
 * Everything interesting in the flight model is emergent from calling this
 * eight or nine times per substep:
 *
 *  - **Roll damping** — a rolling aircraft raises the alpha of the down-going
 *    wing panels and lowers it on the up-going ones.
 *  - **Autorotation** — past the stall, that same alpha change *reduces* lift
 *    on the down-going wing, so the damping term inverts and the roll runs
 *    away. Recovery needs the alpha brought back below the reattachment angle
 *    (forward stick) plus yaw damping (opposite rudder).
 *  - **Asymmetric damage** — a missing or holed panel is simply skipped or
 *    scaled; the resulting roll and yaw come out of 'r × F' for free.
 *  - **Adverse yaw** — the down-going aileron adds induced drag on that side.
 *  - **Nose-drop at the stall** — the wing's downwash on the tailplane is
 *    driven by the wing's *actual* CL, so when the wing lets go the downwash
 *    collapses, the tailplane's alpha jumps, and the nose falls.
 *
 * Flow separation carries hysteresis (fast to separate, slow to reattach) and
 * a rate term, so a snatched pull can briefly exceed CLmax and a developed
 * stall keeps its grip until the angle of attack is properly reduced.
 */

import { clamp, smoothstep, v3, vdot, type V3 } from '../math';
import { DG_FIN, DG_TAIL, DG_WING_L, DG_WING_R, type DerivedSpec, type Surface } from './types';

/** Per-step aerodynamic environment shared by every surface. */
export interface AeroContext {
  rho: number;
  mach: number;
  machCrit: number;
  /** Control commands, −1..1, already damage- and authority-limited. */
  elev: number;
  ail: number;
  rud: number;
  /** Flap position, 0..1. */
  flap: number;
  /** Fully developed slipstream velocity increment (2w), m/s. */
  washAxial: number;
  /** Slipstream swirl rate about the thrust axis, rad/s, signed. */
  swirl: number;
  /** Radius of the swirl core, m. */
  swirlCore: number;
  /** Thrust-axis offset from the reference origin (body Y), m. */
  propAxisY: number;
  /** Downward air velocity at the tailplane from the wing's wake, m/s. */
  downwashV: number;
  /**
   * Aft shift of the wing's aerodynamic centre, m (negative = aft). Above the
   * critical Mach the centre of pressure marches rearwards, which is the
   * nose-down "Mach tuck" that made high-speed dives so dangerous.
   */
  wingAcShift: number;

  /** Damage scaling per group: 1 = intact, 0 = ineffective. */
  scaleWingL: number;
  scaleWingR: number;
  scaleTail: number;
  scaleFin: number;
  goneWingL: boolean;
  goneWingR: boolean;

  // --- outputs, reset by resetAeroOutputs() -------------------------------
  /** Σ cl·area over the wing panels, and Σ area — gives the wing CL. */
  wingClArea: number;
  wingArea: number;
  /** Mean in-plane flow speed over the wing panels, m/s. */
  wingV: number;
  wingVWeight: number;
  /** Normal-direction force per wing, N — feeds the structural model. */
  liftL: number;
  liftR: number;
  /** Area-weighted separation fraction per wing. */
  sepL: number;
  sepR: number;
  sepLW: number;
  sepRW: number;
  /** Peak buffet signal this step, 0..1. */
  buffet: number;
  /** Total lift and drag magnitudes for telemetry. */
  totalLift: number;
  totalDrag: number;
}

export function makeAeroContext(): AeroContext {
  return {
    rho: 1.225, mach: 0, machCrit: 0.75,
    elev: 0, ail: 0, rud: 0, flap: 0,
    washAxial: 0, swirl: 0, swirlCore: 0.6, propAxisY: 0, downwashV: 0, wingAcShift: 0,
    scaleWingL: 1, scaleWingR: 1, scaleTail: 1, scaleFin: 1,
    goneWingL: false, goneWingR: false,
    wingClArea: 0, wingArea: 0, wingV: 0, wingVWeight: 0,
    liftL: 0, liftR: 0, sepL: 0, sepR: 0, sepLW: 0, sepRW: 0,
    buffet: 0, totalLift: 0, totalDrag: 0,
  };
}

export function resetAeroOutputs(c: AeroContext): void {
  c.wingClArea = 0; c.wingArea = 0; c.wingV = 0; c.wingVWeight = 0;
  c.liftL = 0; c.liftR = 0; c.sepL = 0; c.sepR = 0; c.sepLW = 0; c.sepRW = 0;
  c.buffet = 0; c.totalLift = 0; c.totalDrag = 0;
}

// ---------------------------------------------------------------------------
// Section coefficients
// ---------------------------------------------------------------------------

/**
 * Width of the separation transition, rad. Real wings do not let go all at
 * once: there is roughly 10–12° between the first separation and a fully
 * stalled strip, and that band is where the lift-curve slope is negative —
 * i.e. where autorotation lives. Too narrow and a stalled aeroplane snaps
 * straight into the flat-plate regime, where the slope is positive again and
 * spins damp themselves out.
 */
const SEP_BAND = 0.20;

/** Numerically safe softplus. */
function softplus(u: number, k: number): number {
  const x = u / k;
  if (x > 25) return u;
  if (x < -25) return 0;
  return k * Math.log1p(Math.exp(x));
}

/**
 * Round the top (and bottom) off the linear lift curve so it approaches CLmax
 * asymptotically instead of hitting a corner. 'k' sets how wide the knee is.
 */
function softCap(v: number, hi: number, lo: number, k: number): number {
  if (v >= 0) return hi - softplus(hi - v, k);
  return lo + softplus(v - lo, k);
}

/**
 * Fully separated (flat-plate) lift. sin 2α is the classical thin-plate
 * result: it peaks at 45° and falls to zero at 90°, which is what gives a
 * developed stall its characteristic "the wing stops working" feel.
 */
function clFlatPlate(alpha: number): number {
  return 0.95 * Math.sin(2 * alpha);
}

/** Fully separated drag — a flat plate normal to the flow reaches Cd ≈ 2. */
function cdFlatPlate(alpha: number): number {
  const s = Math.sin(alpha);
  return 2.0 * s * s;
}

/**
 * Transonic drag rise. Lock's quartic is the standard empirical fit and has
 * the right explosive shape without needing a table.
 */
function waveDrag(mach: number, mcrit: number): number {
  if (mach <= mcrit) return 0;
  const dm = mach - mcrit;
  return Math.min(0.4, 20 * dm * dm * dm * dm);
}

// ---------------------------------------------------------------------------
// Surface evaluation
// ---------------------------------------------------------------------------

const _vp = v3();
const _vs = v3();
const _f = v3();

/**
 * Evaluate one strip and accumulate its force (body frame) and its moment
 * about the CG.
 *
 * @param velBody  airframe CG velocity relative to the air mass, body frame
 * @param omega    body angular velocity
 * @param cgOff    body-frame offset from the reference origin to the true CG
 * @param sep      per-surface separation state array (mutated)
 * @param aRate    per-surface low-passed dα/dt (mutated)
 * @param aPrev    per-surface previous α (mutated)
 * @param h        substep length, s
 */
export function evalSurface(
  s: Surface,
  d: DerivedSpec,
  c: AeroContext,
  velBody: V3,
  omega: V3,
  cgOff: V3,
  sep: Float64Array,
  aRate: Float64Array,
  aPrev: Float64Array,
  h: number,
  fOut: V3,
  mOut: V3,
): void {
  if (s.damageGroup === DG_WING_L && c.goneWingL) return;
  if (s.damageGroup === DG_WING_R && c.goneWingR) return;

  // ---- local flow --------------------------------------------------------
  const rx = s.pos.x - cgOff.x;
  const ry = s.pos.y - cgOff.y;
  const rz = s.pos.z - cgOff.z + (s.isWing ? c.wingAcShift : 0);

  // v_point = v_cg + ω × r
  _vp.x = velBody.x + omega.y * rz - omega.z * ry;
  _vp.y = velBody.y + omega.z * rx - omega.x * rz;
  _vp.z = velBody.z + omega.x * ry - omega.y * rx;

  // Propeller slipstream. The tube of air behind the disc moves aft faster
  // than the freestream, so a strip inside it sees more forward speed; it also
  // rotates with the blades, which is the spiral slipstream that yaws the
  // aircraft at high power and low speed.
  if (s.wash > 0 && (c.washAxial !== 0 || c.swirl !== 0)) {
    _vp.z += c.washAxial * s.wash;
    if (c.swirl !== 0) {
      const sx = s.pos.x, sy = s.pos.y - c.propAxisY;
      const rad = Math.hypot(sx, sy);
      if (rad > 1e-3) {
        // Rankine vortex: solid-body rotation inside the core, 1/r outside.
        const core = Math.max(c.swirlCore, 0.15);
        const vth = c.swirl * core * Math.min(rad / core, core / rad) * s.wash;
        // Tangential unit vector about +Z is (−y, x)/r.
        const k = vth / rad;
        _vp.x -= -sy * k;
        _vp.y -= sx * k;
      }
    }
  }

  // Wing wake: the tailplane flies in air that is already moving downwards.
  if (s.downwash > 0 && c.downwashV !== 0) _vp.y += c.downwashV * s.downwash;

  // ---- project into the strip's own plane (cross-flow principle) ----------
  const sp = vdot(_vp, s.spanDir);
  _vs.x = _vp.x - sp * s.spanDir.x;
  _vs.y = _vp.y - sp * s.spanDir.y;
  _vs.z = _vp.z - sp * s.spanDir.z;
  const vf = vdot(_vs, s.chord);
  const vn = vdot(_vs, s.normal);
  const V = Math.hypot(vf, vn);

  const idx = s.index;
  if (V < 0.25) {
    // Effectively stationary: no force, but let the separation state relax so
    // the aircraft does not "remember" a stall through a full stop.
    sep[idx] += (0 - sep[idx]) * (1 - Math.exp(-2 * h));
    aRate[idx] *= Math.exp(-6 * h);
    return;
  }

  const alpha = Math.atan2(-vn, vf);

  // ---- control and flap camber ------------------------------------------
  let dcl = 0;
  if (s.elevator !== 0) dcl += s.elevator * c.elev;
  if (s.aileron !== 0) {
    const raw = s.aileron * c.ail;
    // Frise / differential linkage: the up-going aileron throws further than
    // the down-going one, which is what keeps adverse yaw manageable.
    dcl += raw * (raw < 0 ? 1.0 : 0.62);
  }
  if (s.rudder !== 0) dcl += s.rudder * c.rud;
  if (s.flap !== 0 && c.flap > 0) dcl += s.flap * c.flap;

  // ---- compressibility ---------------------------------------------------
  let slope = s.liftSlope;
  let cdWave = 0;
  if (s.kind !== 'body') {
    const m = c.mach;
    if (m > 0.25) {
      // Prandtl–Glauert lift amplification, capped so it cannot run away.
      const pg = 1 / Math.sqrt(Math.max(0.18, 1 - Math.min(m, 0.905) ** 2));
      slope *= Math.min(pg, 1.9);
    }
    // A loaded surface reaches its own critical Mach earlier: the suction peak
    // grows with lift.
    const clNow = s.cl0 + slope * alpha + dcl;
    const mcritLocal = c.machCrit - 0.13 * Math.min(Math.abs(clNow), 1.6);
    cdWave = waveDrag(m, mcritLocal);
    if (cdWave > 0) slope *= clamp(1 - 1.4 * cdWave, 0.35, 1);
  }

  // ---- separation dynamics ----------------------------------------------
  const prev = aPrev[idx];
  aPrev[idx] = alpha;
  const rawRate = h > 1e-6 ? (alpha - prev) / h : 0;
  aRate[idx] += (clamp(rawRate, -40, 40) - aRate[idx]) * (1 - Math.exp(-22 * h));

  // Deflecting a control shifts the whole lift curve, so the surface reaches
  // its stall at a smaller geometric alpha.
  const camberShift = 0.55 * dcl / Math.max(slope, 1e-3);
  // Goman–Khrabrov style rate term: a fast pull delays separation. Bounded,
  // because a large unbounded rate term turns the stall into an oscillator.
  const tau2 = 1.2 * s.chordLen / Math.max(V, 12);
  const dyn = clamp(-tau2 * aRate[idx], -0.06, 0.06);
  const alphaDyn = alpha + camberShift + dyn;

  const sPrev = sep[idx];
  // Hysteresis: the angle at which flow reattaches is well below the angle at
  // which it separates, which is why a spin will not stop until the stick goes
  // properly forward.
  // Hysteresis: once separated, the flow will not reattach until alpha comes
  // back well below the angle at which it let go. Note that it widens the
  // transition *downwards* rather than sliding the whole band up — which
  // matters, because it leaves the strip sitting on the negative-slope part of
  // its lift curve once stalled. That negative slope is the entire mechanism
  // of autorotation: a rolling stalled wing loses lift on the down-going side
  // instead of gaining it, so the roll runs away rather than damping out.
  const aRef = s.stallAlpha - 0.10 * sPrev;
  const sepT = smoothstep(aRef, s.stallAlpha + SEP_BAND, Math.abs(alphaDyn));
  const rate = sepT > sPrev ? 14 : 3.6;
  const sNew = sPrev + (sepT - sPrev) * (1 - Math.exp(-rate * h));
  sep[idx] = sNew;

  // ---- coefficients ------------------------------------------------------
  const clLin = s.cl0 + slope * alpha + dcl;
  const clAtt = softCap(clLin, s.clMax, s.clMin, 0.13 * s.clMax);
  const cl = (1 - sNew) * clAtt + sNew * clFlatPlate(alpha);

  const cdi = (1 - sNew) * (clAtt * clAtt) / (Math.PI * Math.max(s.ar, 0.3) * s.oswald);
  const cdSep = sNew * cdFlatPlate(alpha);
  let cd = s.cd0 * (1 + 1.6 * sNew) + cdi + cdSep + cdWave;
  if (s.flapCd !== 0 && c.flap > 0) cd += s.flapCd * c.flap;

  // ---- damage ------------------------------------------------------------
  let clScale = 1;
  if (s.damageGroup === DG_WING_L) { clScale = c.scaleWingL; cd += (1 - clScale) * 0.07; }
  else if (s.damageGroup === DG_WING_R) { clScale = c.scaleWingR; cd += (1 - clScale) * 0.07; }
  else if (s.damageGroup === DG_TAIL) { clScale = c.scaleTail; }
  else if (s.damageGroup === DG_FIN) { clScale = c.scaleFin; }

  // ---- force -------------------------------------------------------------
  const q = 0.5 * c.rho * V * V;
  const qa = q * s.area;
  const L = qa * cl * clScale;
  const D = qa * cd;

  // Lift acts perpendicular to the local flow in the strip's plane, drag along
  // it. In (chord, normal) components the flow is (vf, vn)/V and lift is the
  // perpendicular (−vn, vf)/V.
  const invV = 1 / V;
  const lcx = -vn * invV, lcn = vf * invV;
  const dcx = -vf * invV, dcn = -vn * invV;
  const fc = L * lcx + D * dcx;      // component along the chord axis
  const fn = L * lcn + D * dcn;      // component along the normal axis

  _f.x = fc * s.chord.x + fn * s.normal.x;
  _f.y = fc * s.chord.y + fn * s.normal.y;
  _f.z = fc * s.chord.z + fn * s.normal.z;

  fOut.x += _f.x; fOut.y += _f.y; fOut.z += _f.z;
  mOut.x += ry * _f.z - rz * _f.y;
  mOut.y += rz * _f.x - rx * _f.z;
  mOut.z += rx * _f.y - ry * _f.x;

  c.totalLift += L;
  c.totalDrag += D;

  // ---- telemetry ---------------------------------------------------------
  if (s.isWing) {
    c.wingClArea += cl * clScale * s.area;
    c.wingArea += s.area;
    c.wingV += V * s.area;
    c.wingVWeight += s.area;
    if (s.side < 0) { c.liftL += L; c.sepL += sNew * s.area; c.sepLW += s.area; }
    else { c.liftR += L; c.sepR += sNew * s.area; c.sepRW += s.area; }
    // Buffet: shaking starts well before the break, then stays with the
    // separated flow.
    const pre = smoothstep(0.74, 1.02, Math.abs(alphaDyn) / Math.max(s.stallAlpha, 1e-3));
    const bf = Math.max(pre * 0.8, sNew * 0.95);
    if (bf > c.buffet) c.buffet = bf;
  }
  if (cdWave > 0.02) {
    const mb = clamp((cdWave - 0.02) * 8, 0, 1);
    if (mb > c.buffet) c.buffet = mb;
  }
}

export { softCap, clFlatPlate, cdFlatPlate, waveDrag };
