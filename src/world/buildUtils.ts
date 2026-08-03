import * as THREE from 'three';

/**
 * A tiny CPU mesh builder.
 *
 * Every static prop in the world (hangars, gun pits, wagons, bridge sections)
 * is assembled from primitives into a *single* merged, vertex-coloured
 * BufferGeometry, so a whole airfield is a handful of draw calls rather than a
 * few hundred. Colours live in the vertex stream instead of in materials,
 * which is what lets a hangar, a fuel bowser and a windsock share one material.
 *
 * Colours are authored in sRGB (the way you would pick them in a palette) and
 * converted to linear on the way in, matching how the textures are decoded.
 */

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _n = new THREE.Matrix3();

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export class MeshBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly col: number[] = [];
  readonly uv: number[] = [];
  readonly idx: number[] = [];

  private cr = 1; private cg = 1; private cb = 1;

  /** Sets the active vertex colour (0xRRGGBB, sRGB). */
  color(hex: number): this {
    this.cr = srgbToLinear(((hex >> 16) & 255) / 255);
    this.cg = srgbToLinear(((hex >> 8) & 255) / 255);
    this.cb = srgbToLinear((hex & 255) / 255);
    return this;
  }

  /** Multiplies the active colour — handy for weathering variation. */
  shade(f: number): this {
    this.cr *= f; this.cg *= f; this.cb *= f;
    return this;
  }

  private vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, v = 0): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.col.push(this.cr, this.cg, this.cb);
    this.uv.push(u, v);
    return i;
  }

  /** Adds a quad from four corners in CCW order (as seen from the front). */
  quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    uvScale = 0,
  ): void {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = dx - ax, vy = dy - ay, vz = dz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const su = uvScale > 0 ? Math.hypot(ux, uy, uz) / uvScale : 1;
    const sv = uvScale > 0 ? Math.hypot(vx, vy, vz) / uvScale : 1;
    const i0 = this.vert(ax, ay, az, nx, ny, nz, 0, 0);
    const i1 = this.vert(bx, by, bz, nx, ny, nz, su, 0);
    const i2 = this.vert(cx, cy, cz, nx, ny, nz, su, sv);
    const i3 = this.vert(dx, dy, dz, nx, ny, nz, 0, sv);
    this.idx.push(i0, i1, i2, i0, i2, i3);
  }

  /**
   * Axis-aligned box centred on (x, y, z), optionally rotated about Y.
   * 'open' masks faces: bit 0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z.
   */
  box(x: number, y: number, z: number, sx: number, sy: number, sz: number, rotY = 0, open = 0): void {
    const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
    const c = Math.cos(rotY), s = Math.sin(rotY);
    const P = (px: number, py: number, pz: number): [number, number, number] =>
      [x + px * c + pz * s, y + py, z - px * s + pz * c];
    const p000 = P(-hx, -hy, -hz), p100 = P(hx, -hy, -hz), p110 = P(hx, hy, -hz), p010 = P(-hx, hy, -hz);
    const p001 = P(-hx, -hy, hz), p101 = P(hx, -hy, hz), p111 = P(hx, hy, hz), p011 = P(-hx, hy, hz);
    const q = (a: number[], b: number[], cc: number[], d: number[]) =>
      this.quad(a[0], a[1], a[2], b[0], b[1], b[2], cc[0], cc[1], cc[2], d[0], d[1], d[2]);
    if (!(open & 1)) q(p101, p100, p110, p111);
    if (!(open & 2)) q(p000, p001, p011, p010);
    if (!(open & 4)) q(p011, p111, p110, p010);
    if (!(open & 8)) q(p000, p100, p101, p001);
    if (!(open & 16)) q(p001, p101, p111, p011);
    if (!(open & 32)) q(p100, p000, p010, p110);
  }

  /** Flat quad lying in the XZ plane, facing +Y. */
  slab(x: number, y: number, z: number, sx: number, sz: number, rotY = 0): void {
    const hx = sx * 0.5, hz = sz * 0.5;
    const c = Math.cos(rotY), s = Math.sin(rotY);
    const P = (px: number, pz: number): [number, number, number] =>
      [x + px * c + pz * s, y, z - px * s + pz * c];
    // Wound so the face normal comes out +Y: quad() derives it from
    // (b-a) x (d-a), and the naive corner order yields a downward-facing
    // polygon that vanishes under back-face culling.
    const a = P(-hx, -hz), b = P(hx, -hz), cc = P(hx, hz), d = P(-hx, hz);
    this.quad(a[0], a[1], a[2], d[0], d[1], d[2], cc[0], cc[1], cc[2], b[0], b[1], b[2]);
  }

  /** Vertical cylinder along +Y, base at y. Set 'capTop'/'capBottom' for discs. */
  cylinder(
    x: number, y: number, z: number, rBottom: number, rTop: number, h: number,
    sides = 8, capTop = true, capBottom = false, rotY = 0,
  ): void {
    const start = this.pos.length / 3;
    const slope = (rBottom - rTop) / Math.max(1e-4, h);
    for (let i = 0; i <= sides; i++) {
      const a = rotY + (i / sides) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const ny = slope / Math.hypot(1, slope);
      const nr = 1 / Math.hypot(1, slope);
      this.vert(x + ca * rBottom, y, z + sa * rBottom, ca * nr, ny, sa * nr, i / sides, 0);
      this.vert(x + ca * rTop, y + h, z + sa * rTop, ca * nr, ny, sa * nr, i / sides, 1);
    }
    for (let i = 0; i < sides; i++) {
      const a = start + i * 2, b = a + 1, c = a + 2, d = a + 3;
      this.idx.push(a, c, b, b, c, d);
    }
    if (capTop && rTop > 1e-4) {
      const cIdx = this.vert(x, y + h, z, 0, 1, 0, 0.5, 0.5);
      const ring: number[] = [];
      for (let i = 0; i <= sides; i++) {
        const a = rotY + (i / sides) * Math.PI * 2;
        ring.push(this.vert(x + Math.cos(a) * rTop, y + h, z + Math.sin(a) * rTop, 0, 1, 0, 0, 0));
      }
      for (let i = 0; i < sides; i++) this.idx.push(cIdx, ring[i], ring[i + 1]);
    }
    if (capBottom && rBottom > 1e-4) {
      const cIdx = this.vert(x, y, z, 0, -1, 0, 0.5, 0.5);
      const ring: number[] = [];
      for (let i = 0; i <= sides; i++) {
        const a = rotY + (i / sides) * Math.PI * 2;
        ring.push(this.vert(x + Math.cos(a) * rBottom, y, z + Math.sin(a) * rBottom, 0, -1, 0, 0, 0));
      }
      for (let i = 0; i < sides; i++) this.idx.push(cIdx, ring[i + 1], ring[i]);
    }
  }

  /** Cone with apex up — foliage tiers, windsock cones, tent tops. */
  cone(x: number, y: number, z: number, r: number, h: number, sides = 7, rotY = 0): void {
    this.cylinder(x, y, z, r, 0.0001, h, sides, false, true, rotY);
  }

  /**
   * A gable-roofed shed: walls plus a two-slope roof. 'axis' 0 = ridge along
   * X, 1 = ridge along Z. Used for hangars, huts and the factory sheds.
   */
  shed(
    x: number, y: number, z: number, w: number, d: number, wallH: number, roofH: number,
    rotY: number, wallColor: number, roofColor: number, axis = 0,
  ): void {
    this.color(wallColor);
    this.box(x, y + wallH * 0.5, z, w, wallH, d, rotY, 4 | 8);
    this.color(roofColor);
    const c = Math.cos(rotY), s = Math.sin(rotY);
    const P = (px: number, py: number, pz: number): [number, number, number] =>
      [x + px * c + pz * s, y + py, z - px * s + pz * c];
    const hw = w * 0.5, hd = d * 0.5;
    const top = wallH + roofH;
    if (axis === 0) {
      const r0 = P(-hw, top, 0), r1 = P(hw, top, 0);
      const a = P(-hw, wallH, -hd), b = P(hw, wallH, -hd);
      const cc = P(hw, wallH, hd), dd = P(-hw, wallH, hd);
      this.quad(a[0], a[1], a[2], b[0], b[1], b[2], r1[0], r1[1], r1[2], r0[0], r0[1], r0[2]);
      this.quad(r0[0], r0[1], r0[2], r1[0], r1[1], r1[2], cc[0], cc[1], cc[2], dd[0], dd[1], dd[2]);
      // gable ends
      this.tri(a, r0, dd); this.tri(b, cc, r1);
    } else {
      const r0 = P(0, top, -hd), r1 = P(0, top, hd);
      const a = P(-hw, wallH, -hd), b = P(-hw, wallH, hd);
      const cc = P(hw, wallH, hd), dd = P(hw, wallH, -hd);
      this.quad(a[0], a[1], a[2], b[0], b[1], b[2], r1[0], r1[1], r1[2], r0[0], r0[1], r0[2]);
      this.quad(r0[0], r0[1], r0[2], r1[0], r1[1], r1[2], cc[0], cc[1], cc[2], dd[0], dd[1], dd[2]);
      this.tri(a, r0, dd); this.tri(b, cc, r1);
    }
  }

  /** Curved (Nissen / Bessonneau) roof — the WWII hangar silhouette. */
  arch(
    x: number, y: number, z: number, w: number, d: number, h: number,
    rotY: number, segments = 9,
  ): void {
    const c = Math.cos(rotY), s = Math.sin(rotY);
    const P = (px: number, py: number, pz: number): [number, number, number] =>
      [x + px * c + pz * s, y + py, z - px * s + pz * c];
    const hw = w * 0.5, hd = d * 0.5;
    for (let i = 0; i < segments; i++) {
      const t0 = i / segments, t1 = (i + 1) / segments;
      const a0 = t0 * Math.PI, a1 = t1 * Math.PI;
      const x0 = -Math.cos(a0) * hw, y0 = Math.sin(a0) * h;
      const x1 = -Math.cos(a1) * hw, y1 = Math.sin(a1) * h;
      const p0 = P(x0, y0, -hd), p1 = P(x1, y1, -hd);
      const p2 = P(x1, y1, hd), p3 = P(x0, y0, hd);
      this.quad(p0[0], p0[1], p0[2], p3[0], p3[1], p3[2], p2[0], p2[1], p2[2], p1[0], p1[1], p1[2]);
    }
  }

  tri(a: number[], b: number[], c: number[]): void {
    let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const i0 = this.vert(a[0], a[1], a[2], nx, ny, nz);
    const i1 = this.vert(b[0], b[1], b[2], nx, ny, nz);
    const i2 = this.vert(c[0], c[1], c[2], nx, ny, nz);
    this.idx.push(i0, i1, i2);
  }

  /** Appends another builder's contents, transformed. */
  append(other: MeshBuilder, m: THREE.Matrix4): void {
    const base = this.pos.length / 3;
    _n.setFromMatrix4(m);
    for (let i = 0; i < other.pos.length; i += 3) {
      _v.set(other.pos[i], other.pos[i + 1], other.pos[i + 2]).applyMatrix4(m);
      this.pos.push(_v.x, _v.y, _v.z);
      _v.set(other.nrm[i], other.nrm[i + 1], other.nrm[i + 2]).applyMatrix3(_n).normalize();
      this.nrm.push(_v.x, _v.y, _v.z);
    }
    for (let i = 0; i < other.col.length; i++) this.col.push(other.col[i]);
    for (let i = 0; i < other.uv.length; i++) this.uv.push(other.uv[i]);
    for (let i = 0; i < other.idx.length; i++) this.idx.push(other.idx[i] + base);
  }

  get triangleCount(): number { return this.idx.length / 3; }
  get empty(): boolean { return this.idx.length === 0; }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx.length > 65535
      ? new THREE.Uint32BufferAttribute(this.idx, 1)
      : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Convenience: a matrix for "stand this prop on the ground here, facing yaw". */
export function placement(x: number, y: number, z: number, yaw: number, scale = 1): THREE.Matrix4 {
  return _m.identity()
    .makeRotationY(yaw)
    .setPosition(x, y, z)
    .scale(_v.set(scale, scale, scale))
    .clone();
}
