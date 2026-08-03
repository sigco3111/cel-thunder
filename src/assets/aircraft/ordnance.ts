/**
 * External stores: bomb racks, rocket rails and the ordnance hung on them.
 *
 * Every store is a *separate scene-graph node* rather than merged into the
 * static hull, because the whole point is that they come off. The build tags
 * each one 'store_<loadoutId>_<b|r><index>', so the presentation layer can show
 * exactly the stores a given aeroplane is carrying and hide the ones it has
 * already dropped without knowing anything about how they were made.
 *
 * Geometry is deliberately cheap — a 12-sided lathed body, four fins and a
 * pylon — because a strike loadout can be eight items and each one is at most
 * a few hundred pixels of a wing seen from the side.
 */

import * as THREE from 'three';
import type {
  AircraftSpec, BombLoad, Loadout, RocketLoad,
} from '../../shared/aircraft';
import { loadoutsFor } from '../../shared/aircraft';
import { swatchBox } from '../textures/atlas';
import { boxGeom, cylGeom, latheGeom, mergeGeoms, quadGeom, trs } from './geom';

export interface StorePiece {
  /** 'store_<loadoutId>_b0', 'store_<loadoutId>_r3', and so on. */
  part: string;
  geometry: THREE.BufferGeometry;
}

/**
 * All stores for every loadout this airframe can carry, in one flat list.
 *
 * The template is built once per aircraft *type*, so it has to contain the
 * union of every configuration; the instance then hides all but the chosen
 * one. That costs a few thousand triangles in the template and nothing at all
 * per frame, and it is the only way to keep the template cache meaningful.
 */
export function buildStores(spec: AircraftSpec, detail: number): StorePiece[] {
  const out: StorePiece[] = [];
  for (const l of loadoutsFor(spec)) {
    if (l.bombs) buildBombs(l, l.bombs, detail, out);
    if (l.rockets) buildRockets(l, l.rockets, detail, out);
  }
  return out;
}

/** Part-name prefix shared by every store, of every loadout. */
export const STORE_PREFIX = 'store_';

/** The part-name prefix one loadout's stores share. */
export const storePrefix = (loadoutId: string): string => `${STORE_PREFIX}${loadoutId}_`;

/** Part name of one store within a loadout. */
export const storeName = (loadoutId: string, kind: 'b' | 'r', i: number): string =>
  `${storePrefix(loadoutId)}${kind}${i}`;

// ---------------------------------------------------------------------------

function buildBombs(l: Loadout, b: BombLoad, detail: number, out: StorePiece[]): void {
  const seg = detail === 0 ? 12 : 7;
  for (let i = 0; i < b.count && i < b.mounts.length; i++) {
    const m = b.mounts[i];
    const parts: THREE.BufferGeometry[] = [];
    // The mount point is where the *lug* is, i.e. the top of the bomb, so the
    // body hangs a radius and a bit below it and the pylon reaches up into the
    // wing skin above.
    const drop = b.diameter * 0.5 + 0.06;
    parts.push(bombBody(b.diameter, b.length, seg).applyMatrix4(trs([0, -drop, 0])));
    parts.push(bombRack(b.diameter, b.length, drop));
    out.push({
      part: storeName(l.id, 'b', i),
      geometry: place(mergeGeoms(parts), m),
    });
  }
}

function buildRockets(l: Loadout, r: RocketLoad, detail: number, out: StorePiece[]): void {
  const seg = detail === 0 ? 10 : 6;
  for (let i = 0; i < r.count && i < r.mounts.length; i++) {
    const m = r.mounts[i];
    const parts: THREE.BufferGeometry[] = [];
    const drop = r.diameter * 0.5 + 0.05;
    parts.push(rocketBody(r.diameter, r.length, seg).applyMatrix4(trs([0, -drop, 0])));
    parts.push(rocketRail(r.diameter, r.length, drop));
    out.push({
      part: storeName(l.id, 'r', i),
      geometry: place(mergeGeoms(parts), m),
    });
  }
}

/** Move a store from the origin to its carriage point. */
function place(g: THREE.BufferGeometry, m: [number, number, number]): THREE.BufferGeometry {
  g.applyMatrix4(trs([m[0], m[1], m[2]]));
  g.computeBoundingSphere();
  return g;
}

/**
 * A general-purpose bomb, lying along +Z (nose forward).
 *
 * The profile is the classic WWII GP shape: a blunt ogival nose about a
 * calibre long, a long parallel mid-body, and a tail cone into a boxed fin
 * assembly. Built about +Y by the lathe and rotated, which is cheaper than
 * writing a second lathe that sweeps about Z.
 */
function bombBody(d: number, len: number, seg: number): THREE.BufferGeometry {
  const R = d * 0.5;
  const paint = swatchBox('olive');
  const steel = swatchBox('steel');

  // Profile runs nose (y = +len/2) to tail (y = -len/2).
  const nose = len * 0.26;
  const tail = len * 0.30;
  const prof: { r: number; y: number }[] = [];
  const y0 = len * 0.5;
  prof.push({ r: 0, y: y0 });
  for (let i = 1; i <= 4; i++) {
    const t = i / 4;
    // Ogive: radius grows as sqrt so the nose is round rather than conical.
    prof.push({ r: R * Math.sqrt(t), y: y0 - nose * t });
  }
  prof.push({ r: R, y: y0 - nose - (len - nose - tail) });
  prof.push({ r: R * 0.52, y: -y0 + len * 0.06 });
  prof.push({ r: R * 0.46, y: -y0 });
  prof.push({ r: 0, y: -y0 });

  const parts: THREE.BufferGeometry[] = [
    latheGeom(prof, seg, paint, 1),
  ];

  // Two suspension lugs on the spine.
  for (const z of [0.14, -0.10]) {
    parts.push(boxGeom(d * 0.10, d * 0.20, d * 0.16, steel)
      .applyMatrix4(trs([0, len * z + R * 0.9, 0])));
  }

  // Four cruciform fins in a box tail, the way a 250 lb GP or an SC actually
  // looked: the fins are braced by a square shroud rather than free-standing.
  const finLen = len * 0.24;
  const finH = R * 1.15;
  const fy = -y0 + finLen * 0.55;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const fin = quadGeom(finLen, finH, steel);
    // quadGeom is in XY facing +Z: rotate it into a radial blade about +Y.
    fin.applyMatrix4(trs([0, 0, 0], [0, Math.PI / 2, Math.PI / 2]));
    fin.applyMatrix4(trs([0, fy, 0]));
    fin.applyMatrix4(new THREE.Matrix4().makeRotationY(a));
    fin.applyMatrix4(new THREE.Matrix4().makeTranslation(
      Math.cos(a) * finH * 0.5, 0, Math.sin(a) * finH * 0.5,
    ));
    parts.push(fin);
  }
  // The shroud.
  parts.push(cylGeom(finH * 0.98, finH * 0.98, finLen * 0.34, seg, steel, false)
    .applyMatrix4(trs([0, -y0 + finLen * 0.18, 0])));

  const g = mergeGeoms(parts);
  // +Y (lathe axis) onto +Z (nose forward).
  g.applyMatrix4(trs([0, 0, 0], [Math.PI * 0.5, 0, 0]));
  return g;
}

/** Ejector rack: a shallow faired pylon with the crutch pads under it. */
function bombRack(d: number, len: number, drop: number): THREE.BufferGeometry {
  const metal = swatchBox('metalDark');
  const w = d * 0.42;
  const parts: THREE.BufferGeometry[] = [
    boxGeom(w, drop + 0.10, len * 0.34, metal).applyMatrix4(trs([0, -drop * 0.5 + 0.05, 0])),
  ];
  // Sway braces fore and aft of the lugs.
  for (const z of [len * 0.14, -len * 0.10]) {
    parts.push(boxGeom(w * 1.5, 0.03, 0.05, metal).applyMatrix4(trs([0, -drop + d * 0.30, z])));
  }
  return mergeGeoms(parts);
}

/**
 * An unguided rocket: a plain tube with a slightly pointed head, a nozzle and
 * four straight tail fins. Nothing about a 1943 aircraft rocket was subtle.
 */
function rocketBody(d: number, len: number, seg: number): THREE.BufferGeometry {
  const R = d * 0.5;
  const paint = swatchBox('olive');
  const steel = swatchBox('gunmetal');
  const y0 = len * 0.5;
  const nose = len * 0.20;

  const prof: { r: number; y: number }[] = [
    { r: 0, y: y0 },
    { r: R * 0.55, y: y0 - nose * 0.45 },
    { r: R, y: y0 - nose },
    { r: R, y: -y0 + len * 0.10 },
    { r: R * 0.86, y: -y0 },
    { r: R * 0.55, y: -y0 },
    { r: 0, y: -y0 + 0.01 },
  ];
  const parts: THREE.BufferGeometry[] = [latheGeom(prof, seg, paint, 1)];

  const finH = R * 1.6;
  const finLen = len * 0.16;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const fin = quadGeom(finLen, finH, steel);
    fin.applyMatrix4(trs([0, 0, 0], [0, Math.PI / 2, Math.PI / 2]));
    fin.applyMatrix4(trs([0, -y0 + finLen * 0.5, 0]));
    fin.applyMatrix4(new THREE.Matrix4().makeRotationY(a));
    fin.applyMatrix4(new THREE.Matrix4().makeTranslation(
      Math.cos(a) * finH * 0.5, 0, Math.sin(a) * finH * 0.5,
    ));
    parts.push(fin);
  }

  const g = mergeGeoms(parts);
  g.applyMatrix4(trs([0, 0, 0], [Math.PI * 0.5, 0, 0]));
  return g;
}

/** Zero-length launch rail plus its stub pylon. */
function rocketRail(d: number, len: number, drop: number): THREE.BufferGeometry {
  const metal = swatchBox('metalDark');
  const parts: THREE.BufferGeometry[] = [
    // The rail itself, a shallow beam the rocket's lugs run down.
    boxGeom(d * 0.30, 0.035, len * 0.78, metal).applyMatrix4(trs([0, -drop + d * 0.52, 0])),
  ];
  for (const z of [len * 0.24, -len * 0.20]) {
    parts.push(boxGeom(0.028, drop, 0.05, metal).applyMatrix4(trs([0, -drop * 0.5, z])));
  }
  return mergeGeoms(parts);
}
