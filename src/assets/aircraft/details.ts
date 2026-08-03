/**
 * The small parts that separate a shape from an aircraft: exhaust stubs,
 * radiators and intakes, gun barrels and blast tubes, the pitot head, the aerial
 * mast and wire, and navigation lights.
 *
 * Everything here is placed by querying the fuselage loft and the wing planform
 * rather than by hard-coded offsets, so a stub sits *on* the skin and a barrel
 * comes out *of* the leading edge on all five aircraft without per-type nudging.
 */

import * as THREE from 'three';
import type { AircraftSpec } from '../../shared/aircraft';
import { detailBox, swatchBox } from '../textures/atlas';
import { boxGeom, cylGeom, latheGeom, mergeGeoms, quadGeom, sphereGeom, trs, tubeGeom } from './geom';
import type { FuselageProfile } from './fuselage';
import type { WingPlan } from './wing';

export interface Marker { pos: THREE.Vector3; dir: THREE.Vector3 }

export interface DetailsResult {
  /** Merged into the static hull. */
  hull: THREE.BufferGeometry;
  /** Emissive nav-light lenses (own material). */
  lights: { geometry: THREE.BufferGeometry; color: number }[];
  exhausts: Marker[];
  gunPorts: Marker[];
  wingtipL: THREE.Vector3;
  wingtipR: THREE.Vector3;
  mastTop: THREE.Vector3;
}

export function buildDetails(
  spec: AircraftSpec, prof: FuselageProfile, wing: WingPlan, fin: WingPlan, detail: number,
): DetailsResult {
  const parts: THREE.BufferGeometry[] = [];
  const lights: { geometry: THREE.BufferGeometry; color: number }[] = [];
  const exhausts: Marker[] = [];
  const gunPorts: Marker[] = [];
  const R = prof.R;

  const exhaustBox = swatchBox('exhaust');
  const gunBox = swatchBox('gunmetal');
  const steelBox = swatchBox('steel');
  // Fairings that hang below the aircraft take the undersurface colour; the
  // ones on top take the camouflage.
  const paintBox = swatchBox('underPaint');
  const topPaint = swatchBox('hullPaint');
  const darkBox = swatchBox('metalDark');
  const seg = detail === 0 ? 8 : 5;

  // -------------------------------------------------------------------------
  // Exhausts
  // -------------------------------------------------------------------------
  if (spec.engine.kind === 'inline') {
    // Six ejector stubs per bank, on the cowl flanks, angled down and aft.
    const n = detail === 0 ? 6 : 3;
    const z0 = prof.zOfT(0.075), z1 = prof.zOfT(0.215);
    for (const sx of [-1, 1]) {
      for (let i = 0; i < n; i++) {
        const z = z0 + (z1 - z0) * ((i + 0.5) / n);
        const th = (sx > 0 ? 1 : -1) * 0.30 * Math.PI * 2;
        const base = prof.point(z, ((th / (Math.PI * 2)) % 1 + 1) % 1 * Math.PI * 2, new THREE.Vector3());
        const nrm = prof.normal(z, ((th / (Math.PI * 2)) % 1 + 1) % 1 * Math.PI * 2, new THREE.Vector3());
        const tip = base.clone().addScaledVector(nrm, R * 0.10).add(new THREE.Vector3(0, -R * 0.04, -R * 0.16));
        const stub = tubeGeom(
          [base.clone().addScaledVector(nrm, -R * 0.04), tip],
          () => R * 0.055, seg, exhaustBox, true,
        );
        parts.push(stub);
        exhausts.push({ pos: tip, dir: new THREE.Vector3(sx * 0.25, -0.15, -1).normalize() });
      }
    }
  } else {
    // Radial: collector pipes exiting low on each side of the cowl.
    for (const sx of [-1, 1]) {
      const z = prof.zOfT(0.23);
      const th = sx > 0 ? Math.PI * 0.42 : Math.PI * 1.58;
      const base = prof.point(z, th, new THREE.Vector3());
      const tip = base.clone().add(new THREE.Vector3(sx * R * 0.08, -R * 0.18, -R * 0.55));
      parts.push(tubeGeom([base, tip], (t) => R * (0.10 - 0.02 * t), seg, exhaustBox, true));
      exhausts.push({ pos: tip, dir: new THREE.Vector3(sx * 0.2, -0.3, -1).normalize() });
    }
  }

  // -------------------------------------------------------------------------
  // Radiators and intakes
  // -------------------------------------------------------------------------
  const radBox = detailBox('radiator');
  switch (spec.geom.intake) {
    case 'chin': {
      const z0 = prof.zOfT(0.06), z1 = prof.zOfT(0.30);
      const yb = prof.bottomY((z0 + z1) * 0.5);
      const w = R * 0.86, h = R * 0.34;
      const duct = boxGeom(w, h, Math.abs(z1 - z0), paintBox);
      duct.applyMatrix4(trs([0, yb + h * 0.18, (z0 + z1) * 0.5]));
      parts.push(duct);
      const face = quadGeom(w * 0.86, h * 0.72, radBox);
      face.applyMatrix4(trs([0, yb + h * 0.18, z0 - 0.005]));
      parts.push(face);
      break;
    }
    case 'belly': {
      // The Mustang's ventral scoop: a long fairing with an inlet lip standing
      // clear of the fuselage (boundary-layer splitter) and an exit flap.
      const z0 = spec.geom.wingZ - 0.35, z1 = z0 - R * 3.4;
      const yb = prof.bottomY((z0 + z1) * 0.5);
      const w = R * 1.06, h = R * 0.80;
      const body = boxGeom(w, h, Math.abs(z1 - z0), paintBox);
      body.applyMatrix4(trs([0, yb - h * 0.30, (z0 + z1) * 0.5]));
      parts.push(body);
      const lip = latheGeom(
        [{ r: w * 0.36, y: 0 }, { r: w * 0.47, y: 0.045 }, { r: w * 0.50, y: 0.10 }],
        detail === 0 ? 14 : 8, paintBox,
      );
      lip.applyMatrix4(trs([0, yb - h * 0.30, z0], [-Math.PI / 2, 0, 0]));
      lip.scale(1, 0.62, 1);
      parts.push(lip);
      const face = quadGeom(w * 0.72, h * 0.60, radBox);
      face.applyMatrix4(trs([0, yb - h * 0.30, z0 - 0.02]));
      parts.push(face);
      // Exit flap at the aft end, hinged down a few degrees.
      const flap = boxGeom(w * 0.86, 0.02, R * 0.55, paintBox);
      flap.applyMatrix4(trs([0, yb - h * 0.62, z1 + R * 0.20], [0.22, 0, 0]));
      parts.push(flap);
      break;
    }
    case 'underwing': {
      // Starboard radiator, port oil cooler — the smaller port unit is one of
      // the details that makes a Spitfire or a 109 look asymmetric the way it
      // should from below.
      for (const sx of [-1, 1]) {
        const k = sx > 0 ? 1 : 0.62;
        const eta = 0.30;
        const cx = sx * eta * wing.run;
        const cz = wing.qcZAt(eta);
        const cy = (wing.surfaceY(cx, cz, -1) ?? spec.geom.wingY) - 0.01;
        const c = wing.chordAt(eta);
        const w = c * 0.26 * k, h = R * 0.32 * k, len = c * 0.62;
        // Body plus a tapering aft fairing, so it is a duct and not a brick.
        const body = boxGeom(w, h, len * 0.68, paintBox);
        body.applyMatrix4(trs([cx, cy - h * 0.50, cz + len * 0.10]));
        parts.push(body);
        const tailFair = boxGeom(w * 0.86, h * 0.55, len * 0.42, paintBox);
        tailFair.applyMatrix4(trs([cx, cy - h * 0.42, cz - len * 0.42], [0.10, 0, 0]));
        parts.push(tailFair);
        const face = quadGeom(w * 0.80, h * 0.66, radBox);
        face.applyMatrix4(trs([cx, cy - h * 0.50, cz + len * 0.44]));
        parts.push(face);
      }
      break;
    }
    default: break;
  }

  // Carburettor / supercharger intake under the nose for inline engines.
  if (spec.engine.kind === 'inline' && spec.geom.intake !== 'chin') {
    const z0 = prof.zOfT(0.10), z1 = prof.zOfT(0.34);
    const yb = prof.bottomY((z0 + z1) * 0.5);
    const duct = boxGeom(R * 0.38, R * 0.19, Math.abs(z1 - z0) * 0.85, paintBox);
    duct.applyMatrix4(trs([0, yb + R * 0.085, (z0 + z1) * 0.5]));
    parts.push(duct);
    const face = quadGeom(R * 0.30, R * 0.12, darkBox);
    face.applyMatrix4(trs([0, yb + R * 0.085, z0 - 0.004]));
    parts.push(face);
  }

  // -------------------------------------------------------------------------
  // Guns
  // -------------------------------------------------------------------------
  for (const gun of spec.guns) {
    for (const m of gun.mounts) {
      const pos = new THREE.Vector3(m[0], m[1], m[2]);
      const dir = new THREE.Vector3(0, 0, 1);
      const bore = Math.max(0.012, gun.calibre * 0.0012);
      if (Math.abs(m[0]) > 0.6) {
        // Wing gun. The spec gives an armament position, not a point on the
        // skin, so the muzzle is snapped onto the actual leading edge at that
        // spanwise station — otherwise barrels float in front of the wing.
        const eta = Math.min(0.98, Math.abs(m[0]) / wing.run);
        const gx = Math.sign(m[0]) * eta * wing.run * Math.cos(wing.o.dihedral);
        const leZ = wing.leZAt(eta);
        const gy = wing.place(Math.sign(m[0]), eta, 0.02, 0, new THREE.Vector3()).y;
        pos.set(gx, gy, leZ + 0.16);
        // Blast tube protruding from the leading edge, plus its fairing ring.
        const barrel = cylGeom(bore, bore * 0.92, 0.30, seg, gunBox, false);
        barrel.applyMatrix4(trs([gx, gy, leZ + 0.06], [Math.PI / 2, 0, 0]));
        parts.push(barrel);
        const fairing = cylGeom(bore * 2.4, bore * 1.7, 0.14, seg, topPaint, true);
        fairing.applyMatrix4(trs([gx, gy, leZ - 0.03], [Math.PI / 2, 0, 0]));
        parts.push(fairing);
        gunPorts.push({ pos, dir });
        continue;
      }
      gunPorts.push({ pos: pos.clone(), dir });
      if (Math.abs(m[1]) > 0.12) {
        // Cowl gun: a trough in the upper decking with the muzzle recessed.
        const trough = boxGeom(bore * 3.4, bore * 2.2, 0.42, darkBox);
        trough.applyMatrix4(trs([m[0], m[1] - bore, m[2] - 0.16]));
        parts.push(trough);
        const muzzle = cylGeom(bore * 1.15, bore, 0.10, seg, gunBox, false);
        muzzle.applyMatrix4(trs([m[0], m[1], m[2]], [Math.PI / 2, 0, 0]));
        parts.push(muzzle);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Pitot head, under the port wing
  // -------------------------------------------------------------------------
  {
    const eta = 0.72;
    const px = -eta * wing.run;
    const pz = wing.qcZAt(eta) - wing.chordAt(eta) * 0.05;
    const py = (wing.surfaceY(px, pz, -1) ?? spec.geom.wingY) - 0.02;
    const mast = boxGeom(0.022, 0.11, 0.07, steelBox);
    mast.applyMatrix4(trs([px, py - 0.055, pz]));
    parts.push(mast);
    const tube = cylGeom(0.012, 0.010, 0.44, 6, steelBox, true);
    tube.applyMatrix4(trs([px, py - 0.11, pz + 0.16], [Math.PI / 2, 0, 0]));
    parts.push(tube);
  }

  // -------------------------------------------------------------------------
  // Aerial mast and wire
  // -------------------------------------------------------------------------
  const mastZ = spec.geom.canopy.z1 - 0.16;
  const mastBase = new THREE.Vector3(0, prof.topY(mastZ), mastZ);
  const mastTop = mastBase.clone().add(new THREE.Vector3(0, R * 0.55, -R * 0.10));
  {
    const mast = tubeGeom([mastBase, mastTop], (t) => R * (0.045 - 0.028 * t), 6, topPaint, true);
    parts.push(mast);
    // Aerial wire to the fin tip and the lead-in down to the fuselage. Modelled
    // at 12 mm rather than the true 2 mm: a sub-pixel wire aliases into a
    // crawling dotted line, and a slightly fat one reads correctly at all ranges.
    const finTip = new THREE.Vector3(0, fin.o.y0 + fin.run * 0.97, fin.qcZAt(0.97) + fin.chordAt(0.97) * 0.10);
    const sag = mastTop.clone().lerp(finTip, 0.5).add(new THREE.Vector3(0, -R * 0.10, 0));
    parts.push(tubeGeom([mastTop, sag, finTip], () => 0.008, 3, darkBox, false));
    const leadIn = new THREE.Vector3(0.04, prof.topY(mastZ - 0.55), mastZ - 0.55);
    parts.push(tubeGeom([mastTop, leadIn], () => 0.007, 3, darkBox, false));
  }

  // -------------------------------------------------------------------------
  // Wing-tip navigation lights and the tail light
  // -------------------------------------------------------------------------
  const tipL = wing.place(-1, 0.985, 0.45, 0, new THREE.Vector3());
  const tipR = wing.place(1, 0.985, 0.45, 0, new THREE.Vector3());
  for (const [tip, color] of [[tipL, 0xd8342a], [tipR, 0x2fbf62]] as [THREE.Vector3, number][]) {
    const lens = sphereGeom(0.045, 8, 5, swatchBox(color === 0xd8342a ? 'navRed' : 'navGreen'));
    lens.scale(0.8, 0.7, 1.3);
    lens.applyMatrix4(trs([tip.x, tip.y, tip.z]));
    lights.push({ geometry: lens, color });
  }
  {
    const tailLight = sphereGeom(0.035, 8, 5, swatchBox('chrome'));
    tailLight.applyMatrix4(trs([0, prof.at(prof.tailZ).yc, prof.tailZ - 0.02]));
    lights.push({ geometry: tailLight, color: 0xf2ede0 });
  }

  return {
    hull: mergeGeoms(parts),
    lights,
    exhausts,
    gunPorts,
    wingtipL: tipL,
    wingtipR: tipR,
    mastTop,
  };
}
