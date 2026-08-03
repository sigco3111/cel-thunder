/**
 * Undercarriage, airframe contact and propeller strikes.
 *
 * Each leg is an independent spring-damper strut carrying a wheel with
 * separate longitudinal and lateral friction. That is enough for all of the
 * behaviour a taildragger needs to feel right:
 *
 *  - The mainwheels sit *ahead* of the centre of gravity, so any yaw on the
 *    ground throws the CG outwards and the yaw grows — the ground loop. It is
 *    not scripted; it is the lateral tyre force acting forward of the CG.
 *  - The tailwheel has a deliberately low lateral limit, so once it slides it
 *    keeps sliding.
 *  - Braking hard while the tail is light pitches the aircraft onto its nose
 *    and the propeller into the ground.
 *  - Landing harder than the strut can absorb collapses the leg.
 *
 * Structural hardpoints (belly, wingtips, spinner, fin, canopy) give a
 * gear-up landing and a cartwheel somewhere to happen.
 */

import { clamp, qrot, qrotInv, v3, vdot, vnorm, vset, type Q, type V3 } from '../math';
import { DamageBits } from '../protocol';
import {
  G0, SURFACE_SOFT, SURFACE_WATER,
  type DerivedSpec, type Environment, type FlightState,
} from './types';

const _p = v3();
const _n = v3();
const _axis = v3();
const _vc = v3();
const _vt = v3();
const _fwd = v3();
const _lat = v3();
const _fw = v3();
const _fb = v3();
const _rb = v3();
const _nb = v3();
const _tmp = v3();

/** Smooth, bounded friction curve. Saturates at ±1 within a few 'vRef'. */
function slip(v: number, vRef: number): number {
  return Math.tanh(v / vRef);
}

/**
 * Contact model for one frame's substep. Accumulates into the body-frame force
 * and moment accumulators.
 */
export function applyGroundContact(
  st: FlightState, d: DerivedSpec, env: Environment,
  rot: Q, pos: V3, velWorld: V3, omega: V3, cgOff: V3,
  fBody: V3, mBody: V3, h: number,
): void {
  let anyContact = false;
  let scrape = 0;
  const gearOut = st.gear > 0.55 && st.dmg.gearOk;
  const gearFrac = clamp((st.gear - 0.55) / 0.45, 0, 1);

  // ---- suspension legs ---------------------------------------------------
  for (let i = 0; i < d.nLegs; i++) {
    const leg = d.gearLegs[i];
    if (!gearOut) {
      st.gearCompress[i] *= Math.exp(-8 * h);
      st.gearLoad[i] = 0;
      st.wheelSpin[i] *= Math.exp(-0.4 * h);
      continue;
    }
    const rest = leg.restLength * gearFrac;

    // Fully extended wheel centre, world frame.
    _tmp.x = leg.mount.x - cgOff.x + leg.axis.x * rest;
    _tmp.y = leg.mount.y - cgOff.y + leg.axis.y * rest;
    _tmp.z = leg.mount.z - cgOff.z + leg.axis.z * rest;
    qrot(rot, _tmp, _p);
    _p.x += pos.x; _p.y += pos.y; _p.z += pos.z;

    const gY = env.terrainHeight(_p.x, _p.z);
    env.terrainNormal(_p.x, _p.z, _n);
    const surf = env.surfaceType ? env.surfaceType(_p.x, _p.z) : 0;
    if (surf === SURFACE_WATER) { st.gearLoad[i] = 0; st.gearCompress[i] *= Math.exp(-8 * h); continue; }

    const dist = (_p.y - gY) * _n.y;
    const pen = leg.radius - dist;
    if (pen <= 0) {
      st.gearCompress[i] = 0;
      st.gearLoad[i] = 0;
      // Free-spinning wheel slowly stops in the air.
      st.wheelSpin[i] *= Math.exp(-0.6 * h);
      continue;
    }

    qrot(rot, leg.axis, _axis);
    const proj = Math.max(-vdot(_axis, _n), 0.25);
    const comp = clamp(pen / proj, 0, leg.travel);
    const bottomed = pen / proj - leg.travel;

    // Contact-patch position and velocity.
    qrotInv(rot, _n, _nb);
    _rb.x = leg.mount.x - cgOff.x + leg.axis.x * (rest - comp) - leg.radius * _nb.x;
    _rb.y = leg.mount.y - cgOff.y + leg.axis.y * (rest - comp) - leg.radius * _nb.y;
    _rb.z = leg.mount.z - cgOff.z + leg.axis.z * (rest - comp) - leg.radius * _nb.z;
    // v = v_cg + R(ω × r)
    _tmp.x = omega.y * _rb.z - omega.z * _rb.y;
    _tmp.y = omega.z * _rb.x - omega.x * _rb.z;
    _tmp.z = omega.x * _rb.y - omega.y * _rb.x;
    qrot(rot, _tmp, _vc);
    _vc.x += velWorld.x; _vc.y += velWorld.y; _vc.z += velWorld.z;

    const vN = vdot(_vc, _n);
    const compRate = -vN / proj;

    let N = leg.spring * comp + leg.damper * compRate;
    if (bottomed > 0) N += leg.spring * 9 * bottomed;
    if (N < 0) N = 0;
    if (surf === SURFACE_SOFT) N *= 0.92;

    // Touchdown detection & structural limit.
    if (st.gearCompress[i] <= 1e-4 && comp > 1e-4) {
      const vs = -vN;
      if (vs > st.touchdownVs) st.touchdownVs = vs;
      if (vs > leg.breakVs) {
        st.damage |= DamageBits.GearBroken;
        st.health = Math.max(0, st.health - clamp((vs - leg.breakVs) * 0.06, 0, 0.5));
      }
    }
    st.gearCompress[i] = comp;
    st.gearLoad[i] = N;
    anyContact = true;

    // Tangential velocity at the patch.
    _vt.x = _vc.x - vN * _n.x;
    _vt.y = _vc.y - vN * _n.y;
    _vt.z = _vc.z - vN * _n.z;

    // Rolling direction: nose axis, steered, projected onto the ground.
    const steer = leg.steerMax * st.steer;
    vset(_tmp, Math.sin(steer), 0, Math.cos(steer));
    qrot(rot, _tmp, _fwd);
    const fd = vdot(_fwd, _n);
    _fwd.x -= fd * _n.x; _fwd.y -= fd * _n.y; _fwd.z -= fd * _n.z;
    if (Math.hypot(_fwd.x, _fwd.y, _fwd.z) < 1e-4) continue;
    vnorm(_fwd, _fwd);
    // lateral = n × forward (right-handed, points to the wheel's left/right)
    _lat.x = _n.y * _fwd.z - _n.z * _fwd.y;
    _lat.y = _n.z * _fwd.x - _n.x * _fwd.z;
    _lat.z = _n.x * _fwd.y - _n.y * _fwd.x;

    const vLong = vdot(_vt, _fwd);
    const vLat = vdot(_vt, _lat);
    st.wheelSpin[i] = vLong / Math.max(leg.radius, 0.05);

    const soft = surf === SURFACE_SOFT ? 3.2 : 1;
    const brake = leg.brakeMu > 0 ? leg.brakeMu * st.wheelBrake : 0;
    const muLong = leg.rollMu * soft + brake;
    let fLong = -N * muLong * slip(vLong, brake > 0.05 ? 0.55 : 0.3);
    let fLat = -N * leg.sideMu * slip(vLat, 0.75);
    // Friction circle — you cannot brake and corner at 100 % of both.
    const fMag = Math.hypot(fLong, fLat);
    const fCap = N * Math.max(leg.sideMu, muLong) * 1.05;
    if (fMag > fCap && fMag > 1e-6) { const k = fCap / fMag; fLong *= k; fLat *= k; }

    _fw.x = N * _n.x + fLong * _fwd.x + fLat * _lat.x;
    _fw.y = N * _n.y + fLong * _fwd.y + fLat * _lat.y;
    _fw.z = N * _n.z + fLong * _fwd.z + fLat * _lat.z;

    qrotInv(rot, _fw, _fb);
    fBody.x += _fb.x; fBody.y += _fb.y; fBody.z += _fb.z;
    mBody.x += _rb.y * _fb.z - _rb.z * _fb.y;
    mBody.y += _rb.z * _fb.x - _rb.x * _fb.z;
    mBody.z += _rb.x * _fb.y - _rb.y * _fb.x;
  }

  // ---- structural contact points ----------------------------------------
  const kHard = 25 * st.mass * G0;
  const cHard = 1.6 * Math.sqrt(kHard * st.mass);
  for (let i = 0; i < d.nHard; i++) {
    const hp = d.hardPoints[i];
    if ((hp.id === 'tipL' && st.dmg.wingLGone) || (hp.id === 'tipR' && st.dmg.wingRGone)) continue;
    _tmp.x = hp.pos.x - cgOff.x; _tmp.y = hp.pos.y - cgOff.y; _tmp.z = hp.pos.z - cgOff.z;
    qrot(rot, _tmp, _p);
    _p.x += pos.x; _p.y += pos.y; _p.z += pos.z;

    const gY = env.terrainHeight(_p.x, _p.z);
    env.terrainNormal(_p.x, _p.z, _n);
    const dist = (_p.y - gY) * _n.y;
    const pen = hp.radius - dist;
    if (pen <= 0) continue;

    const surf = env.surfaceType ? env.surfaceType(_p.x, _p.z) : 0;
    const water = surf === SURFACE_WATER;

    _rb.x = _tmp.x; _rb.y = _tmp.y; _rb.z = _tmp.z;
    _tmp.x = omega.y * _rb.z - omega.z * _rb.y;
    _tmp.y = omega.z * _rb.x - omega.x * _rb.z;
    _tmp.z = omega.x * _rb.y - omega.y * _rb.x;
    qrot(rot, _tmp, _vc);
    _vc.x += velWorld.x; _vc.y += velWorld.y; _vc.z += velWorld.z;
    const vN = vdot(_vc, _n);

    let N = (water ? kHard * 0.22 : kHard) * Math.min(pen, 0.9) + cHard * Math.max(-vN, 0);
    if (N < 0) N = 0;

    _vt.x = _vc.x - vN * _n.x;
    _vt.y = _vc.y - vN * _n.y;
    _vt.z = _vc.z - vN * _n.z;
    const vtLen = Math.hypot(_vt.x, _vt.y, _vt.z);
    const mu = water ? 1.6 : 0.62;
    const fT = vtLen > 1e-4 ? -N * mu * slip(vtLen, 1.2) / vtLen : 0;

    _fw.x = N * _n.x + fT * _vt.x;
    _fw.y = N * _n.y + fT * _vt.y;
    _fw.z = N * _n.z + fT * _vt.z;

    qrotInv(rot, _fw, _fb);
    fBody.x += _fb.x; fBody.y += _fb.y; fBody.z += _fb.z;
    mBody.x += _rb.y * _fb.z - _rb.z * _fb.y;
    mBody.y += _rb.z * _fb.x - _rb.x * _fb.z;
    mBody.z += _rb.x * _fb.y - _rb.y * _fb.x;

    anyContact = true;
    // Scraping the airframe along the ground hurts, proportionally to how
    // fragile that part is and how fast it is going.
    const wear = (N / (st.mass * G0)) * hp.fragility * (0.25 + vtLen * 0.06) * h;
    st.health = Math.max(0, st.health - wear * 0.14);
    scrape = Math.max(scrape, clamp(vtLen * 0.06 * hp.fragility, 0, 1));
    if (hp.id === 'tipL' && wear > 0.02) st.damage |= DamageBits.LeftWing;
    if (hp.id === 'tipR' && wear > 0.02) st.damage |= DamageBits.RightWing;
    if ((hp.id === 'canopy' || hp.id === 'finTop') && wear > 0.03) st.damage |= DamageBits.Tail;
  }

  st.onGround = anyContact;
  st.scrape = scrape;

  // ---- propeller strike --------------------------------------------------
  st.propStrike = false;
  _tmp.x = d.propPos.x - cgOff.x; _tmp.y = d.propPos.y - cgOff.y; _tmp.z = d.propPos.z - cgOff.z;
  qrot(rot, _tmp, _p);
  _p.x += pos.x; _p.y += pos.y; _p.z += pos.z;
  const gYp = env.terrainHeight(_p.x, _p.z);
  env.terrainNormal(_p.x, _p.z, _n);
  vset(_axis, 0, 0, 1);
  qrot(rot, _axis, _fwd);
  const tilt = vdot(_fwd, _n);
  const drop = d.propRadius * Math.sqrt(Math.max(0, 1 - tilt * tilt));
  const clearance = (_p.y - gYp) * _n.y - drop;
  if (clearance < 0 && st.propRpm > 60) {
    st.propStrike = true;
    // Blades dig in: enormous retarding force at the hub plus rapid engine
    // destruction. Two seconds of this and the engine is finished.
    const bite = clamp(-clearance / Math.max(d.propRadius * 0.3, 0.1), 0, 1);
    const f = bite * st.mass * G0 * 1.4;
    _rb.x = _tmp.x; _rb.y = _tmp.y; _rb.z = _tmp.z;
    _fb.x = 0; _fb.y = 0; _fb.z = -f;
    fBody.x += _fb.x; fBody.y += _fb.y; fBody.z += _fb.z;
    mBody.x += _rb.y * _fb.z - _rb.z * _fb.y;
    mBody.y += _rb.z * _fb.x - _rb.x * _fb.z;
    mBody.z += _rb.x * _fb.y - _rb.y * _fb.x;
    st.engineHealth = Math.max(0, st.engineHealth - bite * 0.9 * h);
    st.engOmega *= Math.exp(-6 * bite * h);
    st.health = Math.max(0, st.health - bite * 0.06 * h);
    if (st.engineHealth <= 0.02) { st.engineRunning = false; st.damage |= DamageBits.Engine; }
  }
}
