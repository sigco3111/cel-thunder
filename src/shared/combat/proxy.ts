/**
 * Aircraft collision proxies, swept-ray hit detection and lag compensation.
 *
 * A single capsule around the whole aeroplane is what an arcade shooter does
 * and it is why arcade shooters cannot model damage: there is nowhere for the
 * bullet to *be*. Here every aircraft is decomposed into ~25 oriented boxes and
 * capsules, one per damageable module, built parametrically from the geometry
 * already declared in '../aircraft.ts'. A round entering the left wing root
 * from behind passes through the wing skin, maybe clips the spar, maybe finds
 * the fuel tank, and exits — and each of those is a separate, ordered event.
 *
 * Everything is tested as a *swept segment*, never as a point sample, so a
 * 900 m/s round cannot tunnel through a 120 mm thick aileron.
 */

import {
  type V3, type Q, v3, vset, vsub, vadd, vlen, vnorm,
  qrot, qrotInv, qFromAxisAngle, q as mkq, qslerp, lerp, clamp,
} from '../math';
import type { AircraftSpec } from '../aircraft';
import {
  type AircraftProxy, type ProxyShape, type HistoryBuffer, type TransformSample,
  type CombatTarget, ModuleId, type ArmourMaterial, RHA_EQUIV,
} from './types';

// ---------------------------------------------------------------------------
// Shape construction helpers
// ---------------------------------------------------------------------------

interface BoxOpts {
  module: ModuleId;
  c: V3; h: V3; q?: Q;
  armourFront?: number; armourRear?: number; armourSide?: number;
  material?: ArmourMaterial;
  skinMm?: number; internalMm?: number;
}

function box(o: BoxOpts): ProxyShape {
  const h = o.h;
  return {
    module: o.module, kind: 'box',
    c: o.c, h, q: o.q,
    a: undefined, b: undefined, r: undefined,
    armourFront: o.armourFront ?? 0,
    armourRear: o.armourRear ?? 0,
    armourSide: o.armourSide ?? 0,
    armourMaterial: o.material ?? 'rha',
    skinMm: o.skinMm ?? 0.33,
    internalMm: o.internalMm ?? 1,
    radius: Math.hypot(h.x, h.y, h.z),
    centre: { x: o.c.x, y: o.c.y, z: o.c.z },
    // Mean projected area of a box over all directions is half its surface
    // area (Cauchy). Good enough for fragment counting.
    area: 2 * (h.x * h.y + h.y * h.z + h.z * h.x),
  };
}

interface CapOpts {
  module: ModuleId;
  a: V3; b: V3; r: number;
  armourFront?: number; armourRear?: number; armourSide?: number;
  material?: ArmourMaterial;
  skinMm?: number; internalMm?: number;
}

function capsule(o: CapOpts): ProxyShape {
  const mid = v3((o.a.x + o.b.x) * 0.5, (o.a.y + o.b.y) * 0.5, (o.a.z + o.b.z) * 0.5);
  const half = vlen(vsub(o.b, o.a, v3())) * 0.5;
  const L = half * 2;
  return {
    module: o.module, kind: 'capsule',
    c: mid, h: v3(o.r, o.r, half),
    q: undefined,
    a: o.a, b: o.b, r: o.r,
    armourFront: o.armourFront ?? 0,
    armourRear: o.armourRear ?? 0,
    armourSide: o.armourSide ?? 0,
    armourMaterial: o.material ?? 'rha',
    skinMm: o.skinMm ?? 0.33,
    internalMm: o.internalMm ?? 1,
    radius: half + o.r,
    centre: mid,
    // Mean projected area of a capsule: cylinder (2rL/π averaged) + sphere.
    area: (2 * o.r * L) * 0.5 + Math.PI * o.r * o.r,
  };
}

// ---------------------------------------------------------------------------
// Proxy generation from an AircraftSpec
// ---------------------------------------------------------------------------

const proxyCache = new Map<string, AircraftProxy>();

/**
 * Build (and cache) the collision/damage proxy for an aircraft archetype.
 *
 * Origin is the CG, which is where the flight model puts it. The longitudinal
 * extent is anchored to the tail surfaces declared in the spec and extended
 * forward by the published overall length, because those two numbers are the
 * only ones in the spec that are dimensionally trustworthy together.
 */
export function buildAircraftProxy(spec: AircraftSpec): AircraftProxy {
  const cached = proxyCache.get(spec.id);
  if (cached) return cached;

  const g = spec.geom;
  const arm = spec.damage.armour;

  const tailZ = Math.min(g.hStab.z - g.hStab.chord * 0.5, g.vStab.z - g.vStab.chord * 0.5);
  const noseZ = tailZ + g.length;
  const semi = spec.aero.span * 0.5;
  const fr = g.fuseRadius;
  const cockpitZ = (g.canopy.z0 + g.canopy.z1) * 0.5;
  const dihedralY = (yFrac: number) => g.wingY + Math.sin(g.wing.dihedral) * semi * yFrac;

  const shapes: ProxyShape[] = [];

  // --- powerplant -----------------------------------------------------
  // The engine bay runs from just aft of the spinner back to the firewall.
  // The block itself is the single most bullet-resistant thing on a fighter:
  // 200+ kg of cast aluminium and steel. 'internalMm' reflects that.
  const engLen = Math.min(1.45, (noseZ - cockpitZ) * 0.42);
  const engZ = noseZ - 0.55 - engLen;
  shapes.push(box({
    module: ModuleId.Engine,
    c: v3(0, 0.03, engZ), h: v3(fr * 0.72, fr * 0.72, engLen),
    armourFront: arm.engineFront, armourRear: 0, armourSide: 0,
    skinMm: 0.5, internalMm: spec.engine.kind === 'radial' ? 34 : 42,
  }));
  // Prop hub / reduction gear — small, dense, and directly in front of the
  // engine, so head-on shots meet it first.
  shapes.push(box({
    module: ModuleId.PropHub,
    c: v3(0, 0.02, noseZ - 0.25), h: v3(fr * 0.34, fr * 0.34, 0.28),
    skinMm: 0.4, internalMm: 18,
  }));
  // Radiator/oil cooler position follows the intake style.
  const radY = g.intake === 'belly' ? -fr * 1.1 : g.intake === 'chin' ? -fr * 0.75 : g.wingY - 0.05;
  const radZ = g.intake === 'underwing' ? g.wingZ - 0.2 : engZ - 0.1;
  const radX = g.intake === 'underwing' ? semi * 0.28 : 0;
  shapes.push(box({
    module: ModuleId.Radiator,
    c: v3(-radX, radY, radZ), h: v3(0.30, 0.20, 0.42),
    skinMm: 0.33, internalMm: 3,
  }));
  if (radX > 0) {
    shapes.push(box({
      module: ModuleId.Radiator,
      c: v3(radX, radY, radZ), h: v3(0.30, 0.20, 0.42),
      skinMm: 0.33, internalMm: 3,
    }));
  }
  // Oil tank sits on the firewall, between engine and cockpit.
  shapes.push(box({
    module: ModuleId.OilTank,
    c: v3(0, fr * 0.35, engZ - engLen - 0.3), h: v3(0.26, 0.24, 0.28),
    skinMm: 0.4, internalMm: 2,
  }));

  // --- pilot ----------------------------------------------------------
  // The armour box: a back plate behind the seat, a front plate/bulkhead ahead
  // of the instrument panel and usually laminated glass in the windscreen.
  shapes.push(box({
    module: ModuleId.Pilot,
    c: v3(0, g.canopy.height * 0.15, cockpitZ),
    h: v3(0.30, 0.44, Math.max(0.45, Math.abs(g.canopy.z1 - g.canopy.z0) * 0.42)),
    armourFront: arm.pilotFront, armourRear: arm.pilotBack, armourSide: 0,
    material: 'rha', skinMm: 0.4, internalMm: 1.5,
  }));

  // --- fuel -----------------------------------------------------------
  // Single-engine fighters of this era put the main tank between the engine
  // and the pilot (Bf 109, Spitfire) or in the wing roots (P-51, Zero).
  const wingTanks = spec.damage.fuel > 330 || g.gear.track > 3.0;
  const fusTankZ = lerp(cockpitZ, engZ - engLen, 0.55);
  shapes.push(box({
    module: ModuleId.FuelFuselage,
    c: v3(0, -fr * 0.15, fusTankZ), h: v3(fr * 0.55, fr * 0.45, 0.48),
    armourFront: arm.fuel, armourRear: arm.fuel, armourSide: arm.fuel,
    skinMm: 0.5, internalMm: 2.5,
  }));
  if (wingTanks) {
    for (const s of [-1, 1]) {
      shapes.push(box({
        module: s < 0 ? ModuleId.FuelLeft : ModuleId.FuelRight,
        c: v3(s * semi * 0.30, dihedralY(0.30), g.wingZ - 0.05),
        h: v3(semi * 0.16, 0.13, g.wing.rootChord * 0.28),
        armourFront: arm.fuel, armourRear: arm.fuel, armourSide: arm.fuel,
        skinMm: 0.33, internalMm: 2.0,
      }));
    }
  }

  // --- ammunition -----------------------------------------------------
  // Trays live wherever the guns are. Wing guns => wing trays (and a wing
  // tray detonation takes the wing off); cowl guns => a fuselage tray.
  let wingGuns = false;
  for (const gun of spec.guns) for (const m of gun.mounts) if (Math.abs(m[0]) > 0.9) wingGuns = true;
  if (wingGuns) {
    for (const s of [-1, 1]) {
      shapes.push(box({
        module: s < 0 ? ModuleId.AmmoLeft : ModuleId.AmmoRight,
        c: v3(s * semi * 0.42, dihedralY(0.42), g.wingZ + 0.05),
        h: v3(semi * 0.10, 0.10, 0.34),
        skinMm: 0.33, internalMm: 4,
      }));
    }
  } else {
    shapes.push(box({
      module: ModuleId.AmmoLeft,
      c: v3(-0.22, fr * 0.5, lerp(cockpitZ, engZ, 0.5)), h: v3(0.16, 0.20, 0.42),
      skinMm: 0.4, internalMm: 4,
    }));
    shapes.push(box({
      module: ModuleId.AmmoRight,
      c: v3(0.22, fr * 0.5, lerp(cockpitZ, engZ, 0.5)), h: v3(0.16, 0.20, 0.42),
      skinMm: 0.4, internalMm: 4,
    }));
  }

  // --- wings ----------------------------------------------------------
  // The wing panel is a thin, wide box rotated by the dihedral angle. This is
  // the single largest target on the aeroplane and where most rounds land.
  for (const s of [-1, 1]) {
    const dih = mkq();
    qFromAxisAngle(v3(0, 0, 1), -s * g.wing.dihedral, dih);
    const meanChord = (g.wing.rootChord + g.wing.tipChord) * 0.5;
    // The panel runs all the way to the centreline: the wing centre section is
    // structurally continuous through the fuselage, and leaving a gap there
    // would let rounds fly straight through the aircraft's belly untouched.
    shapes.push(box({
      module: s < 0 ? ModuleId.WingLeft : ModuleId.WingRight,
      c: v3(s * semi * 0.5, dihedralY(0.5) + 0.02, g.wingZ - meanChord * 0.05),
      h: v3(semi * 0.5, meanChord * 0.055 + 0.05, meanChord * 0.5),
      q: dih,
      skinMm: 0.33, internalMm: 1.2,
    }));
    // Main spar: a solid alloy beam. Rounds that clip it lose real energy and
    // the wing loses real strength.
    shapes.push(capsule({
      module: s < 0 ? ModuleId.SparLeft : ModuleId.SparRight,
      a: v3(s * 0.18, g.wingY, g.wingZ + 0.05),
      b: v3(s * semi * 0.94, dihedralY(0.94), g.wingZ + 0.05),
      r: 0.085,
      skinMm: 0.33, internalMm: 9,
    }));
    // Aileron: outboard, on the trailing edge.
    shapes.push(box({
      module: s < 0 ? ModuleId.AileronLeft : ModuleId.AileronRight,
      c: v3(s * semi * 0.74, dihedralY(0.74), g.wingZ - g.wing.tipChord * 0.62),
      h: v3(semi * 0.20, 0.045, g.wing.tipChord * 0.22),
      skinMm: 0.25, internalMm: 0.6,
    }));
    // Main gear, stowed in the wing.
    shapes.push(capsule({
      module: s < 0 ? ModuleId.GearLeft : ModuleId.GearRight,
      a: v3(s * g.gear.track * 0.5, g.wingY - 0.05, g.gear.mainZ),
      b: v3(s * g.gear.track * 0.5, g.wingY - 0.10, g.gear.mainZ - 0.35),
      r: 0.14, skinMm: 0.33, internalMm: 5,
    }));
  }

  // --- fuselage & tail ------------------------------------------------
  shapes.push(capsule({
    module: ModuleId.Fuselage,
    a: v3(0, 0, engZ - engLen - 0.1),
    b: v3(0, 0.03, cockpitZ - 1.1),
    r: fr,
    skinMm: 0.33, internalMm: 1.6,
  }));
  shapes.push(capsule({
    module: ModuleId.TailBoom,
    a: v3(0, 0.03, cockpitZ - 1.1),
    b: v3(0, 0.06, tailZ + 0.15),
    r: fr * 0.62,
    skinMm: 0.33, internalMm: 1.4,
  }));
  shapes.push(box({
    module: ModuleId.HStab,
    c: v3(0, 0.05, g.hStab.z + g.hStab.chord * 0.18),
    h: v3(g.hStab.span * 0.5, 0.045, g.hStab.chord * 0.34),
    skinMm: 0.25, internalMm: 0.8,
  }));
  shapes.push(box({
    module: ModuleId.Elevator,
    c: v3(0, 0.05, g.hStab.z - g.hStab.chord * 0.36),
    h: v3(g.hStab.span * 0.5, 0.04, g.hStab.chord * 0.22),
    skinMm: 0.22, internalMm: 0.5,
  }));
  shapes.push(box({
    module: ModuleId.VStab,
    c: v3(0, g.vStab.height * 0.5, g.vStab.z + g.vStab.chord * 0.16),
    h: v3(0.05, g.vStab.height * 0.5, g.vStab.chord * 0.32),
    skinMm: 0.25, internalMm: 0.8,
  }));
  shapes.push(box({
    module: ModuleId.Rudder,
    c: v3(0, g.vStab.height * 0.48, g.vStab.z - g.vStab.chord * 0.36),
    h: v3(0.04, g.vStab.height * 0.46, g.vStab.chord * 0.20),
    skinMm: 0.22, internalMm: 0.5,
  }));

  // --- control runs ---------------------------------------------------
  // Push-rods and cables run low down the fuselage to the tail, and out along
  // the rear spar to the ailerons. They are thin (2 cm), so hitting one is
  // rare and dramatic — exactly the feel we want. Note they are *inside* the
  // tail boom capsule, so a round has to be going through the tail anyway.
  shapes.push(capsule({
    module: ModuleId.CablePitch,
    a: v3(-0.07, -fr * 0.45, cockpitZ - 0.5), b: v3(-0.05, -fr * 0.25, g.hStab.z),
    r: 0.030, skinMm: 0, internalMm: 0.4,
  }));
  shapes.push(capsule({
    module: ModuleId.CableYaw,
    a: v3(0.07, -fr * 0.45, cockpitZ - 0.5), b: v3(0.05, -fr * 0.20, g.vStab.z),
    r: 0.030, skinMm: 0, internalMm: 0.4,
  }));
  shapes.push(capsule({
    module: ModuleId.CableRoll,
    a: v3(-semi * 0.70, g.wingY - 0.02, g.wingZ - g.wing.rootChord * 0.30),
    b: v3(semi * 0.70, g.wingY - 0.02, g.wingZ - g.wing.rootChord * 0.30),
    r: 0.026, skinMm: 0, internalMm: 0.4,
  }));

  // Bounding sphere over everything.
  let br = 0;
  let bro = 0;
  const bc = v3(0, 0, (noseZ + tailZ) * 0.5);
  for (const s of shapes) {
    const d = vlen(vsub(s.centre, bc, _t0)) + s.radius;
    if (d > br) br = d;
    const o = vlen(s.centre) + s.radius;
    if (o > bro) bro = o;
  }

  const proxy: AircraftProxy = {
    specId: spec.id, shapes, boundRadius: br, boundCentre: bc, boundRadiusOrigin: bro,
  };
  proxyCache.set(spec.id, proxy);
  return proxy;
}

/** Drop a cached proxy (used by tests that mutate specs). */
export function clearProxyCache(): void { proxyCache.clear(); }

// ---------------------------------------------------------------------------
// Ray/segment intersection
// ---------------------------------------------------------------------------

export interface ShapeHit {
  shape: ProxyShape;
  module: ModuleId;
  /** Parametric entry/exit distance along the segment, metres from p0. */
  tEnter: number;
  tExit: number;
  /** Entry surface normal in body space (unit, pointing out of the shape). */
  nx: number; ny: number; nz: number;
}

const _t0 = v3(), _t1 = v3(), _t2 = v3(), _t3 = v3(), _t4 = v3();
const _lo = v3(), _ld = v3(), _sd = v3();
const _bo = v3(), _bd = v3();

/**
 * Slab test of a segment against an oriented box.
 * 'o'/'d' are the ray origin and *unit* direction in the box's local frame.
 * Returns entry distance, or -1. Writes the entry normal into 'outN'.
 */
function rayBox(o: V3, d: V3, h: V3, len: number, outN: V3, out: { tExit: number }): number {
  let tmin = 0, tmax = len;
  let axis = -1, sign = 1;

  // X
  {
    const inv = d.x !== 0 ? 1 / d.x : Infinity;
    let t1 = (-h.x - o.x) * inv, t2 = (h.x - o.x) * inv;
    let s = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = 0; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  // Y
  {
    const inv = d.y !== 0 ? 1 / d.y : Infinity;
    let t1 = (-h.y - o.y) * inv, t2 = (h.y - o.y) * inv;
    let s = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = 1; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  // Z
  {
    const inv = d.z !== 0 ? 1 / d.z : Infinity;
    let t1 = (-h.z - o.z) * inv, t2 = (h.z - o.z) * inv;
    let s = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = 2; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }

  out.tExit = tmax;
  if (axis < 0) {
    // Segment started inside the box: use the reverse travel direction as the
    // "entry normal" so angle maths stays well defined.
    vset(outN, -d.x, -d.y, -d.z);
  } else {
    vset(outN, axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
  }
  return tmin;
}

/** Ray vs sphere; returns near root or -1. */
function raySphere(o: V3, d: V3, c: V3, r: number, len: number, roots: { t0: number; t1: number }): boolean {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return false;
  const s = Math.sqrt(disc);
  roots.t0 = -b - s;
  roots.t1 = -b + s;
  return roots.t1 >= 0 && roots.t0 <= len;
}

const _roots = { t0: 0, t1: 0 };
const _rootsB = { t0: 0, t1: 0 };
const _exit = { tExit: 0 };

/**
 * Segment vs capsule. Analytic: solve the infinite-cylinder quadratic, clamp
 * the axial parameter, fall back to the end-cap spheres.
 */
function rayCapsule(o: V3, d: V3, a: V3, b: V3, r: number, len: number, outN: V3, out: { tExit: number }): number {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const aox = o.x - a.x, aoy = o.y - a.y, aoz = o.z - a.z;
  const ab2 = abx * abx + aby * aby + abz * abz;
  if (ab2 < 1e-12) {
    if (!raySphere(o, d, a, r, len, _roots)) return -1;
    out.tExit = _roots.t1;
    const t = Math.max(0, _roots.t0);
    vset(outN, o.x + d.x * t - a.x, o.y + d.y * t - a.y, o.z + d.z * t - a.z);
    vnorm(outN, outN);
    return t;
  }

  const abd = abx * d.x + aby * d.y + abz * d.z;
  const abao = abx * aox + aby * aoy + abz * aoz;
  const m = abd / ab2;
  const n = abao / ab2;

  // Components of d and ao perpendicular to the axis.
  const qx = d.x - abx * m, qy = d.y - aby * m, qz = d.z - abz * m;
  const rx = aox - abx * n, ry = aoy - aby * n, rz = aoz - abz * n;

  const A = qx * qx + qy * qy + qz * qz;
  const B = 2 * (qx * rx + qy * ry + qz * rz);
  const C = rx * rx + ry * ry + rz * rz - r * r;

  let tEnter = Infinity, tExit = -Infinity;
  let nSet = false;

  if (A > 1e-12) {
    const disc = B * B - 4 * A * C;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      const t0 = (-B - s) / (2 * A);
      const t1 = (-B + s) / (2 * A);
      const u0 = n + t0 * m;
      const u1 = n + t1 * m;
      if (u0 >= 0 && u0 <= 1 && t0 <= len && t1 >= 0) {
        tEnter = t0;
        const px = o.x + d.x * t0 - (a.x + abx * u0);
        const py = o.y + d.y * t0 - (a.y + aby * u0);
        const pz = o.z + d.z * t0 - (a.z + abz * u0);
        vset(outN, px, py, pz); vnorm(outN, outN);
        nSet = true;
      }
      if (u1 >= 0 && u1 <= 1) tExit = Math.max(tExit, t1);
    }
  } else {
    // Ray parallel to the axis: inside the infinite cylinder or not at all.
    if (C > 0) return -1;
  }

  // End caps.
  if (raySphere(o, d, a, r, len, _roots)) {
    if (_roots.t0 < tEnter && _roots.t1 >= 0) {
      const t = _roots.t0;
      // Only count the cap if the hit point is beyond the a-end of the axis.
      const hx = o.x + d.x * t - a.x, hy = o.y + d.y * t - a.y, hz = o.z + d.z * t - a.z;
      if (hx * abx + hy * aby + hz * abz <= 0) {
        tEnter = t;
        vset(outN, hx, hy, hz); vnorm(outN, outN);
        nSet = true;
      }
    }
    tExit = Math.max(tExit, _roots.t1);
  }
  if (raySphere(o, d, b, r, len, _rootsB)) {
    if (_rootsB.t0 < tEnter && _rootsB.t1 >= 0) {
      const t = _rootsB.t0;
      const hx = o.x + d.x * t - b.x, hy = o.y + d.y * t - b.y, hz = o.z + d.z * t - b.z;
      if (hx * abx + hy * aby + hz * abz >= 0) {
        tEnter = t;
        vset(outN, hx, hy, hz); vnorm(outN, outN);
        nSet = true;
      }
    }
    tExit = Math.max(tExit, _rootsB.t1);
  }

  if (!isFinite(tEnter)) {
    // Possibly started inside.
    if (C <= 0 || (A <= 1e-12 && C <= 0)) {
      tEnter = 0; tExit = Math.max(tExit, 0);
      vset(outN, -d.x, -d.y, -d.z);
      nSet = true;
    } else return -1;
  }
  if (tExit < 0 || tEnter > len) return -1;
  if (tEnter < 0) {
    tEnter = 0;
    if (!nSet) vset(outN, -d.x, -d.y, -d.z);
  }
  out.tExit = tExit;
  return tEnter;
}

// ---------------------------------------------------------------------------
// Proxy sweep
// ---------------------------------------------------------------------------

const _hitPool: ShapeHit[] = [];
let _hitPoolUsed = 0;

function acquireHit(): ShapeHit {
  let h = _hitPool[_hitPoolUsed];
  if (!h) {
    h = { shape: null as unknown as ProxyShape, module: ModuleId.Fuselage, tEnter: 0, tExit: 0, nx: 0, ny: 0, nz: 0 };
    _hitPool[_hitPoolUsed] = h;
  }
  _hitPoolUsed++;
  return h;
}

/**
 * Sweep the segment p0->p1 (world space) against a proxy at world transform
 * (tp, tq). Results are appended to 'out', sorted ascending by entry distance.
 *
 * Returns the number of shapes hit. Allocation-free after warm-up: hits come
 * from a module-level pool that is reset by 'beginSweepBatch'.
 */
export function sweepProxy(
  proxy: AircraftProxy, tp: V3, tq: Q, p0: V3, p1: V3, out: ShapeHit[],
): number {
  vsub(p1, p0, _ld);
  const len = vlen(_ld);
  if (len < 1e-9) return 0;
  vset(_ld, _ld.x / len, _ld.y / len, _ld.z / len);

  // Broad phase, in world space: closest approach of the segment to the
  // aircraft's origin-centred bounding sphere. This runs before the two
  // quaternion rotations below because it rejects the overwhelming majority
  // of (round, aircraft) pairs and costs nine flops to do it.
  {
    const ox = tp.x - p0.x, oy = tp.y - p0.y, oz = tp.z - p0.z;
    const t = clamp(ox * _ld.x + oy * _ld.y + oz * _ld.z, 0, len);
    const cx = ox - _ld.x * t, cy = oy - _ld.y * t, cz = oz - _ld.z * t;
    const rr = proxy.boundRadiusOrigin;
    if (cx * cx + cy * cy + cz * cz > rr * rr) return 0;
  }

  // World -> body.
  vsub(p0, tp, _t0);
  qrotInv(tq, _t0, _bo);
  qrotInv(tq, _ld, _bd);

  // Whole-aircraft bounding sphere reject.
  {
    const cx = _bo.x - proxy.boundCentre.x;
    const cy = _bo.y - proxy.boundCentre.y;
    const cz = _bo.z - proxy.boundCentre.z;
    const b = cx * _bd.x + cy * _bd.y + cz * _bd.z;
    const c = cx * cx + cy * cy + cz * cz - proxy.boundRadius * proxy.boundRadius;
    if (c > 0) {
      const disc = b * b - c;
      if (disc < 0) return 0;
      const tNear = -b - Math.sqrt(disc);
      if (tNear > len) return 0;
    }
  }

  const start = out.length;

  for (let i = 0; i < proxy.shapes.length; i++) {
    const s = proxy.shapes[i];

    // Per-shape bounding sphere reject — cheap and kills most of the list.
    {
      const cx = _bo.x - s.centre.x, cy = _bo.y - s.centre.y, cz = _bo.z - s.centre.z;
      const b = cx * _bd.x + cy * _bd.y + cz * _bd.z;
      const c = cx * cx + cy * cy + cz * cz - s.radius * s.radius;
      if (c > 0) {
        const disc = b * b - c;
        if (disc < 0) continue;
        if (-b - Math.sqrt(disc) > len) continue;
      }
    }

    let tEnter = -1;
    if (s.kind === 'box') {
      if (s.q) {
        // Body -> shape-local. '_sd' is a dedicated scratch so the body-space
        // ray in '_bo'/'_bd' survives untouched for the next shape.
        vsub(_bo, s.c, _t1);
        qrotInv(s.q, _t1, _lo);
        qrotInv(s.q, _bd, _sd);
        tEnter = rayBox(_lo, _sd, s.h, len, _t3, _exit);
        // Shape-local normal -> body.
        if (tEnter >= 0) qrot(s.q, _t3, _t4);
      } else {
        vsub(_bo, s.c, _lo);
        tEnter = rayBox(_lo, _bd, s.h, len, _t3, _exit);
        if (tEnter >= 0) vset(_t4, _t3.x, _t3.y, _t3.z);
      }
    } else {
      tEnter = rayCapsule(_bo, _bd, s.a!, s.b!, s.r!, len, _t3, _exit);
      if (tEnter >= 0) vset(_t4, _t3.x, _t3.y, _t3.z);
    }

    if (tEnter < 0 || tEnter > len) continue;

    const h = acquireHit();
    h.shape = s;
    h.module = s.module;
    h.tEnter = tEnter;
    h.tExit = Math.min(_exit.tExit, len);
    // Body -> world normal.
    qrot(tq, _t4, _t2);
    h.nx = _t2.x; h.ny = _t2.y; h.nz = _t2.z;
    out.push(h);
  }

  // Insertion sort the slice we just added. Counts are tiny (2-8 shapes on a
  // typical pass), and this avoids the array churn of splice + sort + push in
  // the hottest loop in the whole subsystem.
  for (let i = start + 1; i < out.length; i++) {
    const v = out[i];
    let j = i - 1;
    while (j >= start && out[j].tEnter > v.tEnter) { out[j + 1] = out[j]; j--; }
    out[j + 1] = v;
  }
  return out.length - start;
}

/** Reset the ShapeHit pool. Call once per projectile step, before sweeping. */
export function beginSweepBatch(): void { _hitPoolUsed = 0; }

// ---------------------------------------------------------------------------
// Distance query (blast / fragments)
// ---------------------------------------------------------------------------

/** Distance from a body-space point to a shape's surface (0 if inside). */
export function shapeDistance(s: ProxyShape, pBody: V3): number {
  if (s.kind === 'box') {
    let lx: number, ly: number, lz: number;
    if (s.q) {
      vsub(pBody, s.c, _t0);
      qrotInv(s.q, _t0, _t1);
      lx = _t1.x; ly = _t1.y; lz = _t1.z;
    } else {
      lx = pBody.x - s.c.x; ly = pBody.y - s.c.y; lz = pBody.z - s.c.z;
    }
    const dx = Math.abs(lx) - s.h.x;
    const dy = Math.abs(ly) - s.h.y;
    const dz = Math.abs(lz) - s.h.z;
    const ox = Math.max(dx, 0), oy = Math.max(dy, 0), oz = Math.max(dz, 0);
    const outside = Math.sqrt(ox * ox + oy * oy + oz * oz);
    const inside = Math.min(Math.max(dx, Math.max(dy, dz)), 0);
    return outside + inside;
  }
  // Capsule: distance to the segment, minus radius.
  const a = s.a!, b = s.b!;
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = pBody.x - a.x, apy = pBody.y - a.y, apz = pBody.z - a.z;
  const ab2 = abx * abx + aby * aby + abz * abz;
  const t = ab2 > 1e-12 ? clamp((apx * abx + apy * aby + apz * abz) / ab2, 0, 1) : 0;
  const cx = apx - abx * t, cy = apy - aby * t, cz = apz - abz * t;
  return Math.sqrt(cx * cx + cy * cy + cz * cz) - s.r!;
}

/** Closest point on a shape's surface, in body space. Written into 'out'. */
export function shapeClosestPoint(s: ProxyShape, pBody: V3, out: V3): V3 {
  if (s.kind === 'box') {
    if (s.q) {
      vsub(pBody, s.c, _t0);
      qrotInv(s.q, _t0, _t1);
      vset(_t1, clamp(_t1.x, -s.h.x, s.h.x), clamp(_t1.y, -s.h.y, s.h.y), clamp(_t1.z, -s.h.z, s.h.z));
      qrot(s.q, _t1, _t2);
      return vadd(_t2, s.c, out);
    }
    return vset(out,
      clamp(pBody.x, s.c.x - s.h.x, s.c.x + s.h.x),
      clamp(pBody.y, s.c.y - s.h.y, s.c.y + s.h.y),
      clamp(pBody.z, s.c.z - s.h.z, s.c.z + s.h.z));
  }
  const a = s.a!, b = s.b!;
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = pBody.x - a.x, apy = pBody.y - a.y, apz = pBody.z - a.z;
  const ab2 = abx * abx + aby * aby + abz * abz;
  const t = ab2 > 1e-12 ? clamp((apx * abx + apy * aby + apz * abz) / ab2, 0, 1) : 0;
  return vset(out, a.x + abx * t, a.y + aby * t, a.z + abz * t);
}

/**
 * Which armour face a round meets, given the entry normal in *body* space.
 * Real armour is directional: a back plate protects from six o'clock only.
 */
export function armourForNormal(s: ProxyShape, nBody: V3): number {
  const ax = Math.abs(nBody.x), ay = Math.abs(nBody.y), az = Math.abs(nBody.z);
  if (az >= ax && az >= ay) return nBody.z > 0 ? s.armourFront : s.armourRear;
  return s.armourSide;
}

// ---------------------------------------------------------------------------
// Lag compensation
// ---------------------------------------------------------------------------

export function createHistoryBuffer(capacity = 64): HistoryBuffer {
  const samples: TransformSample[] = new Array(capacity);
  for (let i = 0; i < capacity; i++) {
    samples[i] = { t: 0, px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
  }
  return { samples, head: -1, count: 0 };
}

/** Record the current transform. Call once per server tick per entity. */
export function pushHistory(h: HistoryBuffer, t: number, p: V3, q: Q): void {
  h.head = (h.head + 1) % h.samples.length;
  const s = h.samples[h.head];
  s.t = t;
  s.px = p.x; s.py = p.y; s.pz = p.z;
  s.qx = q.x; s.qy = q.y; s.qz = q.z; s.qw = q.w;
  if (h.count < h.samples.length) h.count++;
}

const _qa = mkq(), _qb = mkq();

/**
 * Reconstruct the transform at time 't' by interpolating the ring. Returns
 * false and leaves the outputs untouched if the buffer has no coverage — the
 * caller should then fall back to the present-day transform.
 */
export function sampleHistory(h: HistoryBuffer, t: number, outP: V3, outQ: Q): boolean {
  if (h.count === 0) return false;
  const n = h.samples.length;
  const newest = h.samples[h.head];
  if (t >= newest.t) {
    vset(outP, newest.px, newest.py, newest.pz);
    outQ.x = newest.qx; outQ.y = newest.qy; outQ.z = newest.qz; outQ.w = newest.qw;
    return true;
  }
  // Walk back from the head until we straddle 't'.
  for (let i = 1; i < h.count; i++) {
    const iCur = (h.head - i + 1 + n * 2) % n;
    const iPrev = (h.head - i + n * 2) % n;
    const cur = h.samples[iCur];
    const prev = h.samples[iPrev];
    if (prev.t <= t && t <= cur.t) {
      const span = cur.t - prev.t;
      const a = span > 1e-6 ? (t - prev.t) / span : 0;
      vset(outP, lerp(prev.px, cur.px, a), lerp(prev.py, cur.py, a), lerp(prev.pz, cur.pz, a));
      _qa.x = prev.qx; _qa.y = prev.qy; _qa.z = prev.qz; _qa.w = prev.qw;
      _qb.x = cur.qx; _qb.y = cur.qy; _qb.z = cur.qz; _qb.w = cur.qw;
      qslerp(_qa, _qb, a, outQ);
      return true;
    }
  }
  // Older than anything we kept: clamp to the oldest sample.
  const oldest = h.samples[(h.head - h.count + 1 + n * 2) % n];
  vset(outP, oldest.px, oldest.py, oldest.pz);
  outQ.x = oldest.qx; outQ.y = oldest.qy; outQ.z = oldest.qz; outQ.w = oldest.qw;
  return true;
}

const _lagP = v3(), _lagQ = mkq();

/**
 * Sweep a target with lag compensation applied.
 *
 * 'atTime' is the server time the shot is being resolved at; 'rewind' is the
 * shooter's measured latency (plus interpolation delay). Together they say
 * "test against where this aeroplane appeared on the shooter's screen".
 */
export function sweepTarget(
  target: CombatTarget, atTime: number, rewind: number, p0: V3, p1: V3, out: ShapeHit[],
): number {
  let tp = target.p, tq = target.q;
  if (rewind > 0 && target.history && target.history.count > 1) {
    if (sampleHistory(target.history, atTime - rewind, _lagP, _lagQ)) {
      tp = _lagP; tq = _lagQ;
    }
  }
  return sweepProxy(target.proxy, tp, tq, p0, p1, out);
}

/** Resolve the transform a lag-compensated test would use. */
export function resolveTargetTransform(
  target: CombatTarget, atTime: number, rewind: number, outP: V3, outQ: Q,
): void {
  if (rewind > 0 && target.history && target.history.count > 1 &&
      sampleHistory(target.history, atTime - rewind, outP, outQ)) {
    return;
  }
  vset(outP, target.p.x, target.p.y, target.p.z);
  outQ.x = target.q.x; outQ.y = target.q.y; outQ.z = target.q.z; outQ.w = target.q.w;
}

/** RHA-equivalent thickness of a plate of the given material. */
export function rhaEquivalent(mm: number, material: ArmourMaterial): number {
  return mm * RHA_EQUIV[material];
}
