/**
 * Retractable landing gear: oleo struts with a visible sliding member, torque
 * scissor links, retraction jacks, wheels with hubs and tread, and doors.
 *
 * Retraction direction is inferred from the track: the wide-track types in this
 * roster (P-51, A6M5, La-5) fold inboard toward the fuselage, the narrow-track
 * ones (Spitfire, Bf 109) fold outboard toward the tips. That single rule
 * happens to be historically correct for all five, and it keeps the wheel
 * sweeping through the right part of the wing when the animation plays.
 *
 * The legs are built in a local frame whose origin is the trunnion, so the whole
 * assembly retracts with one rotation about the fore-aft axis, and the wheel
 * carries its own spin pivot inside that.
 */

import * as THREE from 'three';
import type { AircraftSpec } from '../../shared/aircraft';
import { detailBox, swatchBox } from '../textures/atlas';
import { boxGeom, cylGeom, mergeGeoms, torusGeom, trs } from './geom';
import type { FuselageProfile } from './fuselage';
import type { WingPlan } from './wing';

export interface GearDoor {
  geometry: THREE.BufferGeometry;
  pivot: THREE.Vector3;
  axis: THREE.Vector3;
  /**
   * Rotation in radians that folds the door flush with the wing skin. The door
   * is modelled hanging vertically (the gear-down attitude), so the animation
   * drives it toward this angle as the gear stows.
   */
  closedAngle: number;
}

export interface GearLeg {
  name: string;
  /** Trunnion position in body space. */
  pivot: THREE.Vector3;
  /** Retraction axis in body space. */
  axis: THREE.Vector3;
  /** Rotation applied when fully retracted. */
  upAngle: number;
  /** Strut geometry, in leg-local space (origin at the trunnion). */
  geometry: THREE.BufferGeometry;
  /** Wheel geometry in wheel-local space plus its position in leg-local space. */
  wheel: THREE.BufferGeometry;
  wheelPos: THREE.Vector3;
  wheelRadius: number;
  door: GearDoor | null;
}

export interface GearResult {
  main: GearLeg[];
  tail: GearLeg | null;
}

function buildWheel(r: number, width: number, detail: number): THREE.BufferGeometry {
  const tyreBox = swatchBox('tyre');
  const hubBox = swatchBox('metalBare');
  const darkBox = swatchBox('metalDark');
  const seg = detail === 0 ? 20 : detail === 1 ? 12 : 8;
  const parts: THREE.BufferGeometry[] = [];

  // Tyre: a squashed torus so the tread face is flat rather than round.
  const tyre = torusGeom(r * 0.74, r * 0.30, seg, detail === 0 ? 10 : 6, tyreBox, 0.78);
  tyre.applyMatrix4(trs([0, 0, 0], [0, 0, Math.PI / 2]));
  tyre.scale(width / (r * 0.47), 1, 1);
  parts.push(tyre);

  // Hub: a disc each side with a raised centre.
  for (const sx of [-1, 1]) {
    const hub = cylGeom(r * 0.46, r * 0.40, width * 0.30, seg, hubBox, true);
    hub.applyMatrix4(trs([sx * width * 0.34, 0, 0], [0, 0, Math.PI / 2]));
    parts.push(hub);
    const cap = cylGeom(r * 0.15, r * 0.12, width * 0.24, 8, darkBox, true);
    cap.applyMatrix4(trs([sx * width * 0.52, 0, 0], [0, 0, Math.PI / 2]));
    parts.push(cap);
    if (detail === 0) {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const bolt = cylGeom(r * 0.035, r * 0.035, width * 0.12, 6, darkBox, true);
        bolt.applyMatrix4(trs([sx * width * 0.48, Math.sin(a) * r * 0.28, Math.cos(a) * r * 0.28], [0, 0, Math.PI / 2]));
        parts.push(bolt);
      }
    }
  }
  return mergeGeoms(parts);
}

function buildStrut(legLen: number, wheelR: number, detail: number, rake: number): THREE.BufferGeometry {
  const steel = swatchBox('steel');
  const chrome = swatchBox('chrome');
  const dark = swatchBox('metalDark');
  const parts: THREE.BufferGeometry[] = [];
  const seg = detail === 0 ? 10 : 6;
  const rOuter = legLen * 0.062, rInner = legLen * 0.046;

  // Trunnion fitting.
  parts.push(applyRake(cylGeom(rOuter * 1.5, rOuter * 1.35, legLen * 0.10, seg, dark, true), 0, -legLen * 0.03, rake));
  // Outer (fixed) oleo cylinder.
  parts.push(applyRake(cylGeom(rOuter, rOuter, legLen * 0.50, seg, steel, true), 0, -legLen * 0.28, rake));
  // Inner sliding member — polished, and the reason gear reads as sprung.
  parts.push(applyRake(cylGeom(rInner, rInner, legLen * 0.44, seg, chrome, true), 0, -legLen * 0.72, rake));

  if (detail <= 1) {
    // Torque scissor links on the forward face.
    for (const [y0, y1, zOff] of [[-0.46, -0.62, 0.055], [-0.62, -0.80, 0.055]] as [number, number, number][]) {
      const len = Math.abs(y1 - y0) * legLen;
      const link = boxGeom(legLen * 0.014, len, legLen * 0.030, steel);
      link.applyMatrix4(trs(
        [0, (y0 + y1) * 0.5 * legLen, zOff * legLen * 1.6],
        [0, 0, 0],
      ));
      parts.push(applyRakeGeom(link, rake));
    }
    // Retraction jack, angled up and inboard.
    const jack = cylGeom(legLen * 0.026, legLen * 0.022, legLen * 0.52, 8, steel, true);
    jack.applyMatrix4(trs([legLen * 0.14, -legLen * 0.26, -legLen * 0.05], [0, 0, 0.52]));
    parts.push(applyRakeGeom(jack, rake));
    // Brake line running down the leg.
    const line = cylGeom(legLen * 0.008, legLen * 0.008, legLen * 0.80, 5, dark, false);
    line.applyMatrix4(trs([-rOuter * 1.1, -legLen * 0.44, 0]));
    parts.push(applyRakeGeom(line, rake));
  }

  // Axle stub.
  const axle = cylGeom(wheelR * 0.16, wheelR * 0.16, wheelR * 0.7, 8, steel, true);
  axle.applyMatrix4(trs([0, -legLen, 0], [0, 0, Math.PI / 2]));
  parts.push(applyRakeGeom(axle, rake));

  return mergeGeoms(parts);
}

function applyRake(g: THREE.BufferGeometry, x: number, y: number, rake: number): THREE.BufferGeometry {
  g.applyMatrix4(trs([x, y, 0]));
  return applyRakeGeom(g, rake);
}
function applyRakeGeom(g: THREE.BufferGeometry, rake: number): THREE.BufferGeometry {
  g.applyMatrix4(trs([0, 0, 0], [rake, 0, 0]));
  return g;
}

/**
 * Gear door: a slightly curved plate, length fore-and-aft, height vertical,
 * thickness across. Built about its own origin so the caller can hang it off a
 * hinge line at the top edge.
 */
function buildDoor(len: number, h: number, curve: number): THREE.BufferGeometry {
  const box = detailBox('gearDoor');
  const parts: THREE.BufferGeometry[] = [];
  const segs = 3;
  for (let i = 0; i < segs; i++) {
    const t = (i + 0.5) / segs;
    const seg = boxGeom(0.012, h, len / segs, box);
    seg.applyMatrix4(trs([Math.sin(t * Math.PI) * curve, 0, (t - 0.5) * len]));
    parts.push(seg);
  }
  return mergeGeoms(parts);
}

export function buildGear(
  spec: AircraftSpec, prof: FuselageProfile, wing: WingPlan, detail: number,
): GearResult {
  const g = spec.geom.gear;
  const legLen = g.legLen;
  const wheelR = legLen * 0.36;
  const wheelW = wheelR * 0.46;
  const inward = g.track > 2.4;
  const rake = 0.10;   // legs lean forward slightly

  const main: GearLeg[] = [];
  for (const sx of [-1, 1]) {
    const px = sx * g.track * 0.5;
    // Trunnion sits on the wing lower surface, or on the fuselage if the track
    // is narrow enough that the leg is fuselage-mounted.
    const yWing = wing.surfaceY(px, g.mainZ, -1);
    const py = yWing !== null ? yWing + 0.02 : prof.bottomY(g.mainZ) + 0.05;

    const strut = buildStrut(legLen, wheelR, detail, rake);
    const wheel = buildWheel(wheelR, wheelW, detail);
    // Outward for narrow tracks, inward for wide ones; sign flips per side.
    const dir = inward ? -sx : sx;
    const doorH = legLen * 0.48;
    const door = detail <= 1
      ? {
        geometry: buildDoor(legLen * 0.64, doorH, legLen * 0.030)
          .translate(px + sx * legLen * 0.055, py - doorH * 0.5, g.mainZ),
        pivot: new THREE.Vector3(px + sx * legLen * 0.055, py - 0.005, g.mainZ),
        axis: new THREE.Vector3(0, 0, 1),
        closedAngle: sx * 1.50,
      }
      : null;

    main.push({
      name: sx < 0 ? 'gearL' : 'gearR',
      pivot: new THREE.Vector3(px, py, g.mainZ),
      axis: new THREE.Vector3(0, 0, 1),
      upAngle: dir * 1.50,
      geometry: strut,
      wheel,
      wheelPos: new THREE.Vector3(0, -legLen + Math.sin(rake) * 0, legLen * Math.sin(rake)),
      wheelRadius: wheelR,
      door,
    });
  }

  let tail: GearLeg | null = null;
  if (g.tailWheel) {
    const tz = prof.tailZ + 0.55;
    const ty = prof.bottomY(tz);
    const tLen = legLen * 0.40;
    const tR = tLen * 0.42;
    const steel = swatchBox('steel');
    const parts: THREE.BufferGeometry[] = [];
    // Shock strut.
    const leg = cylGeom(tLen * 0.10, tLen * 0.085, tLen * 0.72, 8, steel, true);
    leg.applyMatrix4(trs([0, -tLen * 0.34, 0], [0.22, 0, 0]));
    parts.push(leg);
    // Fork.
    for (const sx of [-1, 1]) {
      const arm = boxGeom(tLen * 0.05, tLen * 0.40, tLen * 0.10, steel);
      arm.applyMatrix4(trs([sx * tR * 0.55, -tLen * 0.80, 0]));
      parts.push(arm);
    }
    tail = {
      name: 'gearTail',
      pivot: new THREE.Vector3(0, ty + 0.02, tz),
      axis: new THREE.Vector3(1, 0, 0),
      upAngle: -1.35,
      geometry: mergeGeoms(parts),
      wheel: buildWheel(tR, tR * 0.5, Math.min(1, detail + 1)),
      wheelPos: new THREE.Vector3(0, -tLen, 0),
      wheelRadius: tR,
      door: null,
    };
  }

  return { main, tail };
}
