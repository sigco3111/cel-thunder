/**
 * BufferGeometry construction toolkit.
 *
 * Everything the aircraft builder makes goes through 'MeshBuilder', which keeps
 * three concerns straight that are easy to get wrong when hand-rolling meshes:
 *
 *  1. **UV boxing.** Every primitive takes a 'UvBox' from the atlas, so a bolt
 *     head or an oleo strut lands on the right painted swatch instead of on
 *     whatever texels happened to be at UV (0,0).
 *  2. **Seam-safe normals.** Lofts and lathes need a duplicated column of
 *     vertices at the UV seam. 'build()' therefore averages normals across
 *     *positions* rather than vertices, so the seam does not show up as a
 *     lighting crease — and, just as importantly, so the inverted-hull outline
 *     does not split open along it.
 *  3. **Merging.** Static hull parts get merged into a single geometry, which is
 *     the difference between ~40 draw calls per aircraft and 2.
 */

import * as THREE from 'three';
import type { UvBox } from '../textures/atlas';

export interface Vtx {
  x: number; y: number; z: number; u: number; v: number;
  /**
   * Set by a sampler to punch a hole: every quad touching this node is dropped.
   * The vertex itself is still emitted so the lattice stays rectangular, which
   * is what lets a loft carry an opening (the cockpit cutout) without the
   * sampler having to know anything about indexing.
   */
  skip?: boolean;
}

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();

export const uvIn = (b: UvBox, u: number, v: number): [number, number] =>
  [b.u0 + (b.u1 - b.u0) * u, b.v0 + (b.v1 - b.v0) * v];

export class MeshBuilder {
  private p: number[] = [];
  private uv: number[] = [];
  private idx: number[] = [];

  get vertexCount(): number { return this.p.length / 3; }
  get triangleCount(): number { return this.idx.length / 3; }

  vert(x: number, y: number, z: number, u: number, v: number): number {
    const i = this.p.length / 3;
    this.p.push(x, y, z);
    this.uv.push(u, v);
    return i;
  }

  tri(a: number, b: number, c: number): void { this.idx.push(a, b, c); }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /**
   * Build a rows×cols vertex lattice and stitch it with quads.
   * 'sample' fills 'out' for lattice node (i,j). Degenerate quads (any edge
   * shorter than 1e-6 m, e.g. at a lathe pole) are skipped rather than emitted.
   */
  addGrid(rows: number, cols: number, sample: (i: number, j: number, out: Vtx) => void, flip = false): number[][] {
    const out: Vtx = { x: 0, y: 0, z: 0, u: 0, v: 0, skip: false };
    const ids: number[][] = [];
    const holes: boolean[][] = [];
    for (let i = 0; i < rows; i++) {
      const row: number[] = [];
      const hole: boolean[] = [];
      for (let j = 0; j < cols; j++) {
        out.skip = false;
        sample(i, j, out);
        row.push(this.vert(out.x, out.y, out.z, out.u, out.v));
        // Read through a fresh reference: the assignment above narrows
        // 'out.skip' to 'false' and the compiler cannot see that 'sample'
        // writes it, so a direct comparison is flagged as always-false.
        hole.push((out as { skip?: boolean }).skip === true);
      }
      ids.push(row);
      holes.push(hole);
    }
    for (let i = 0; i < rows - 1; i++) {
      for (let j = 0; j < cols - 1; j++) {
        if (holes[i][j] || holes[i][j + 1] || holes[i + 1][j] || holes[i + 1][j + 1]) continue;
        const a = ids[i][j], b = ids[i][j + 1], c = ids[i + 1][j + 1], d = ids[i + 1][j];
        if (this.degenerate(a, b) && this.degenerate(b, c)) continue;
        if (flip) { this.quadSafe(a, d, c, b); } else { this.quadSafe(a, b, c, d); }
      }
    }
    return ids;
  }

  private degenerate(a: number, b: number): boolean {
    const dx = this.p[a * 3] - this.p[b * 3];
    const dy = this.p[a * 3 + 1] - this.p[b * 3 + 1];
    const dz = this.p[a * 3 + 2] - this.p[b * 3 + 2];
    return dx * dx + dy * dy + dz * dz < 1e-12;
  }

  private quadSafe(a: number, b: number, c: number, d: number): void {
    if (!this.degenerate(a, b) && !this.degenerate(b, c)) this.tri(a, b, c);
    if (!this.degenerate(a, c) && !this.degenerate(c, d)) this.tri(a, c, d);
  }

  /** Triangle fan around a centre vertex — lathe poles, tip ribs, disc caps. */
  fan(centre: number, ring: number[], flip = false): void {
    for (let i = 0; i < ring.length - 1; i++) {
      if (flip) this.tri(centre, ring[i + 1], ring[i]);
      else this.tri(centre, ring[i], ring[i + 1]);
    }
  }

  build(weld = true): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    if (weld) weldNormals(g);
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Average vertex normals across coincident positions.
 *
 * Positions are hashed at 0.1 mm, which is finer than any deliberate gap in the
 * model and coarser than float error in the loft maths.
 */
export function weldNormals(g: THREE.BufferGeometry, tol = 1e-4): void {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  if (!pos || !nrm) return;
  const inv = 1 / tol;
  const map = new Map<string, number[]>();
  const n = pos.count;
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos.getX(i) * inv)},${Math.round(pos.getY(i) * inv)},${Math.round(pos.getZ(i) * inv)}`;
    const list = map.get(k);
    if (list) list.push(i); else map.set(k, [i]);
  }
  for (const list of map.values()) {
    if (list.length < 2) continue;
    let x = 0, y = 0, z = 0;
    for (const i of list) { x += nrm.getX(i); y += nrm.getY(i); z += nrm.getZ(i); }
    const l = Math.hypot(x, y, z);
    if (l < 1e-9) continue;
    x /= l; y /= l; z /= l;
    for (const i of list) nrm.setXYZ(i, x, y, z);
  }
  nrm.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Merge indexed position/normal/uv geometries. Written by hand rather than
 * pulled from BufferGeometryUtils so the aircraft module has no addon imports
 * and so we can guarantee the attribute set.
 */
export function mergeGeoms(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const geoms = list.filter((g) => g && g.getAttribute('position'));
  if (geoms.length === 0) return new THREE.BufferGeometry();
  if (geoms.length === 1) return geoms[0];

  let vTotal = 0, iTotal = 0;
  for (const g of geoms) {
    vTotal += g.getAttribute('position').count;
    const idx = g.getIndex();
    iTotal += idx ? idx.count : g.getAttribute('position').count;
  }

  const P = new Float32Array(vTotal * 3);
  const N = new Float32Array(vTotal * 3);
  const U = new Float32Array(vTotal * 2);
  const I = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);

  let vo = 0, io = 0;
  for (const g of geoms) {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const nAttr = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const uAttr = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const c = p.count;
    for (let i = 0; i < c; i++) {
      P[(vo + i) * 3] = p.getX(i); P[(vo + i) * 3 + 1] = p.getY(i); P[(vo + i) * 3 + 2] = p.getZ(i);
      if (nAttr) { N[(vo + i) * 3] = nAttr.getX(i); N[(vo + i) * 3 + 1] = nAttr.getY(i); N[(vo + i) * 3 + 2] = nAttr.getZ(i); }
      if (uAttr) { U[(vo + i) * 2] = uAttr.getX(i); U[(vo + i) * 2 + 1] = uAttr.getY(i); }
    }
    const idx = g.getIndex();
    if (idx) { for (let i = 0; i < idx.count; i++) I[io + i] = vo + idx.getX(i); io += idx.count; }
    else { for (let i = 0; i < c; i++) I[io + i] = vo + i; io += c; }
    vo += c;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  out.setIndex(new THREE.BufferAttribute(I, 1));
  out.computeBoundingSphere();
  return out;
}

/**
 * Reverse triangle winding and flip normals in place — turns a tube inside out.
 * Used for anything you look *into*: cowl interiors, wheel wells, gun bays.
 */
export function flipWinding(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const idx = g.getIndex();
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      const a = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, a);
    }
    idx.needsUpdate = true;
  }
  const n = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (n) {
    for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
    n.needsUpdate = true;
  }
  return g;
}

export function triCount(g: THREE.BufferGeometry): number {
  const idx = g.getIndex();
  return (idx ? idx.count : g.getAttribute('position')?.count ?? 0) / 3;
}

export function applyMat(g: THREE.BufferGeometry, m: THREE.Matrix4): THREE.BufferGeometry {
  g.applyMatrix4(m);
  return g;
}

export function trs(
  pos: [number, number, number] = [0, 0, 0],
  euler: [number, number, number] = [0, 0, 0],
  scale: [number, number, number] = [1, 1, 1],
): THREE.Matrix4 {
  return _m.clone().compose(
    new THREE.Vector3(pos[0], pos[1], pos[2]),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(euler[0], euler[1], euler[2], 'XYZ')),
    new THREE.Vector3(scale[0], scale[1], scale[2]),
  );
}

// ---------------------------------------------------------------------------
// Primitives — all in a canonical orientation, all UV-boxed
// ---------------------------------------------------------------------------

/** Axis-aligned box centred on the origin. Each face maps to the whole UV box. */
export function boxGeom(w: number, h: number, d: number, box: UvBox, uvScale = 1): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const hx = w / 2, hy = h / 2, hz = d / 2;
  const s = uvScale;
  const face = (
    ax: [number, number, number], ay: [number, number, number], c: [number, number, number],
  ) => {
    const v: number[] = [];
    const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const [i, j] of corners) {
      const x = c[0] + ax[0] * i + ay[0] * j;
      const y = c[1] + ax[1] * i + ay[1] * j;
      const z = c[2] + ax[2] * i + ay[2] * j;
      const [u, vv] = uvIn(box, 0.5 + i * 0.5 * s, 0.5 + j * 0.5 * s);
      v.push(b.vert(x, y, z, u, vv));
    }
    b.quad(v[0], v[1], v[2], v[3]);
  };
  face([hx, 0, 0], [0, hy, 0], [0, 0, hz]);          // +Z
  face([-hx, 0, 0], [0, hy, 0], [0, 0, -hz]);        // -Z
  face([0, 0, -hz], [0, hy, 0], [hx, 0, 0]);         // +X
  face([0, 0, hz], [0, hy, 0], [-hx, 0, 0]);         // -X
  face([hx, 0, 0], [0, 0, -hz], [0, hy, 0]);         // +Y
  face([hx, 0, 0], [0, 0, hz], [0, -hy, 0]);         // -Y
  return b.build(false);
}

/** Cylinder / cone frustum about +Y, centred vertically on the origin. */
export function cylGeom(
  r0: number, r1: number, h: number, seg: number, box: UvBox,
  caps: boolean | 'top' | 'bottom' = true, uvTurns = 1,
): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const ring: number[][] = [];
  for (let i = 0; i < 2; i++) {
    const r = i === 0 ? r0 : r1;
    const y = i === 0 ? -h / 2 : h / 2;
    const row: number[] = [];
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const [u, v] = uvIn(box, (j / seg) * uvTurns % 1.0001, i);
      row.push(b.vert(Math.cos(a) * r, y, Math.sin(a) * r, u, v));
    }
    ring.push(row);
  }
  for (let j = 0; j < seg; j++) b.quad(ring[0][j], ring[0][j + 1], ring[1][j + 1], ring[1][j]);

  const wantTop = caps === true || caps === 'top';
  const wantBot = caps === true || caps === 'bottom';
  if (wantTop && r1 > 1e-5) {
    const c = b.vert(0, h / 2, 0, ...uvIn(box, 0.5, 0.5));
    const row: number[] = [];
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      row.push(b.vert(Math.cos(a) * r1, h / 2, Math.sin(a) * r1, ...uvIn(box, 0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5)));
    }
    b.fan(c, row, false);
  }
  if (wantBot && r0 > 1e-5) {
    const c = b.vert(0, -h / 2, 0, ...uvIn(box, 0.5, 0.5));
    const row: number[] = [];
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      row.push(b.vert(Math.cos(a) * r0, -h / 2, Math.sin(a) * r0, ...uvIn(box, 0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5)));
    }
    b.fan(c, row, true);
  }
  return b.build(true);
}

/** Surface of revolution about +Y from a (radius, y) profile. */
export function latheGeom(
  profile: { r: number; y: number }[], seg: number, box: UvBox, uvTurns = 1,
): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.addGrid(profile.length, seg + 1, (i, j, o) => {
    const a = (j / seg) * Math.PI * 2;
    const p = profile[i];
    o.x = Math.cos(a) * p.r; o.y = p.y; o.z = Math.sin(a) * p.r;
    const [u, v] = uvIn(box, (j / seg) * uvTurns % 1.0001, i / (profile.length - 1));
    o.u = u; o.v = v;
  }, true);
  return b.build(true);
}

export function sphereGeom(r: number, seg: number, rings: number, box: UvBox): THREE.BufferGeometry {
  const prof: { r: number; y: number }[] = [];
  for (let i = 0; i <= rings; i++) {
    const t = (i / rings) * Math.PI;
    prof.push({ r: Math.sin(t) * r, y: Math.cos(t) * r });
  }
  return latheGeom(prof, seg, box);
}

/** Torus about +Y (tyre-shaped): major radius R in the XZ plane, tube radius r. */
export function torusGeom(R: number, r: number, seg: number, tube: number, box: UvBox, squash = 1): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.addGrid(seg + 1, tube + 1, (i, j, o) => {
    const a = (i / seg) * Math.PI * 2;
    const t = (j / tube) * Math.PI * 2;
    const rr = R + Math.cos(t) * r;
    o.x = Math.cos(a) * rr;
    o.z = Math.sin(a) * rr;
    o.y = Math.sin(t) * r * squash;
    const [u, v] = uvIn(box, i / seg, j / tube);
    o.u = u; o.v = v;
  }, true);
  return b.build(true);
}

/** Flat annulus in the XZ plane. */
export function ringGeom(rIn: number, rOut: number, seg: number, box: UvBox, flip = false): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.addGrid(2, seg + 1, (i, j, o) => {
    const a = (j / seg) * Math.PI * 2;
    const r = i === 0 ? rIn : rOut;
    o.x = Math.cos(a) * r; o.y = 0; o.z = Math.sin(a) * r;
    const [u, v] = uvIn(box, 0.5 + Math.cos(a) * 0.5 * (r / rOut), 0.5 + Math.sin(a) * 0.5 * (r / rOut));
    o.u = u; o.v = v;
  }, flip);
  return b.build(true);
}

/** Quad in the XY plane facing +Z. */
export function quadGeom(w: number, h: number, box: UvBox): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const a0 = b.vert(-w / 2, -h / 2, 0, ...uvIn(box, 0, 1));
  const a1 = b.vert(w / 2, -h / 2, 0, ...uvIn(box, 1, 1));
  const a2 = b.vert(w / 2, h / 2, 0, ...uvIn(box, 1, 0));
  const a3 = b.vert(-w / 2, h / 2, 0, ...uvIn(box, 0, 0));
  b.quad(a0, a1, a2, a3);
  return b.build(false);
}

/**
 * Round tube swept along a polyline with a variable radius. Frames are
 * propagated by parallel transport, so the tube does not spin about its own
 * axis where the path twists (which is what naive up-vector framing does to
 * exhaust stacks and gear scissor links).
 */
export function tubeGeom(
  path: THREE.Vector3[], radius: (t: number) => number, seg: number, box: UvBox, caps = true,
): THREE.BufferGeometry {
  const n = path.length;
  if (n < 2) return new THREE.BufferGeometry();
  const tangents: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)], c = path[Math.min(n - 1, i + 1)];
    tangents.push(new THREE.Vector3().subVectors(c, a).normalize());
  }
  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  let nrm = new THREE.Vector3(0, 1, 0);
  if (Math.abs(tangents[0].dot(nrm)) > 0.9) nrm.set(1, 0, 0);
  nrm.crossVectors(tangents[0], nrm).normalize();
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      // Parallel transport: rotate the previous normal by the tangent delta.
      const axis = _v.crossVectors(tangents[i - 1], tangents[i]);
      const len = axis.length();
      if (len > 1e-6) {
        axis.divideScalar(len);
        const ang = Math.acos(Math.min(1, Math.max(-1, tangents[i - 1].dot(tangents[i]))));
        nrm = nrm.clone().applyAxisAngle(axis, ang);
      }
    }
    nrm = nrm.clone().sub(tangents[i].clone().multiplyScalar(nrm.dot(tangents[i]))).normalize();
    normals.push(nrm.clone());
    binormals.push(new THREE.Vector3().crossVectors(tangents[i], nrm).normalize());
  }

  const b = new MeshBuilder();
  const rows = b.addGrid(n, seg + 1, (i, j, o) => {
    const t = i / (n - 1);
    const a = (j / seg) * Math.PI * 2;
    const r = radius(t);
    const p = path[i], N = normals[i], B = binormals[i];
    o.x = p.x + (N.x * Math.cos(a) + B.x * Math.sin(a)) * r;
    o.y = p.y + (N.y * Math.cos(a) + B.y * Math.sin(a)) * r;
    o.z = p.z + (N.z * Math.cos(a) + B.z * Math.sin(a)) * r;
    const [u, v] = uvIn(box, j / seg, t);
    o.u = u; o.v = v;
  });
  if (caps) {
    for (const [k, flip] of [[0, true], [n - 1, false]] as [number, boolean][]) {
      const p = path[k];
      const c = b.vert(p.x, p.y, p.z, ...uvIn(box, 0.5, 0.5));
      b.fan(c, rows[k], flip);
    }
  }
  return b.build(true);
}

// ---------------------------------------------------------------------------
// Scene-graph helpers
// ---------------------------------------------------------------------------

export interface Hinge {
  /** Add this to the scene. Carries the hinge-line orientation; never rotate it. */
  root: THREE.Group;
  /** Drive 'rotation.x' on this to deflect the surface. */
  pivot: THREE.Group;
  geometry: THREE.BufferGeometry;
  /** World → hinge-local, for positioning sub-pivots such as the wheel spin. */
  inv: THREE.Matrix4;
  /** Rotation-only part of the hinge basis. */
  basis: THREE.Quaternion;
}

/**
 * Wrap geometry in a hinge.
 *
 * Two nested groups, not one, and the reason matters: 'Object3D.rotation' and
 * 'Object3D.quaternion' are two views of the same state, so writing
 * 'pivot.rotation.x' *overwrites* whatever quaternion the pivot was given.
 * Storing the hinge-line basis on the object you animate silently throws that
 * basis away the first time the surface deflects — the aileron hinges about the
 * wrong axis and the landing gear folds sideways into the wing. The outer group
 * therefore holds the basis and is never touched; the inner one is the animation
 * handle and starts at identity.
 *
 * The geometry is baked into hinge-local space so a single 'rotation.x' deflects
 * the surface about its real hinge line, sweep and dihedral included. 'axis'
 * should point outboard for surfaces that must move antisymmetrically (ailerons)
 * and along +X for surfaces that move together (elevators, flaps).
 */
export function makeHinge(
  geo: THREE.BufferGeometry, point: THREE.Vector3, axis: THREE.Vector3, name: string,
): Hinge {
  const ex = axis.clone().normalize();
  // Keep +Z as close to aircraft-forward as possible so "rotate about local X"
  // always means "trailing edge up".
  let ez = new THREE.Vector3(0, 0, 1);
  if (Math.abs(ez.dot(ex)) > 0.98) ez.set(0, 1, 0);
  const ey = new THREE.Vector3().crossVectors(ez, ex).normalize();
  ez = new THREE.Vector3().crossVectors(ex, ey).normalize();

  const basisM = new THREE.Matrix4().makeBasis(ex, ey, ez);
  const basis = new THREE.Quaternion().setFromRotationMatrix(basisM);
  basisM.setPosition(point);
  const inv = basisM.clone().invert();
  geo.applyMatrix4(inv);

  const root = new THREE.Group();
  root.name = `${name}__orient`;
  root.position.copy(point);
  root.quaternion.copy(basis);

  const pivot = new THREE.Group();
  pivot.name = name;
  root.add(pivot);

  return { root, pivot, geometry: geo, inv, basis };
}
