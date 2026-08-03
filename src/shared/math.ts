/**
 * Minimal dependency-free math used by both the browser client and the
 * headless authoritative server. Deliberately does NOT import three.js so the
 * server stays light and the flight model stays bit-identical on both sides.
 */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential approach. 'rate' is per-second. */
export const damp = (a: number, b: number, rate: number, dt: number) =>
  lerp(a, b, 1 - Math.exp(-rate * dt));

export interface V3 { x: number; y: number; z: number }
export interface Q { x: number; y: number; z: number; w: number }

export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
export const vcopy = (a: V3): V3 => ({ x: a.x, y: a.y, z: a.z });
export const vset = (o: V3, x: number, y: number, z: number): V3 => { o.x = x; o.y = y; o.z = z; return o; };
export const vadd = (a: V3, b: V3, o: V3 = v3()): V3 => vset(o, a.x + b.x, a.y + b.y, a.z + b.z);
export const vsub = (a: V3, b: V3, o: V3 = v3()): V3 => vset(o, a.x - b.x, a.y - b.y, a.z - b.z);
export const vmul = (a: V3, s: number, o: V3 = v3()): V3 => vset(o, a.x * s, a.y * s, a.z * s);
export const vaddScaled = (a: V3, b: V3, s: number, o: V3 = v3()): V3 =>
  vset(o, a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
export const vdot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const vcross = (a: V3, b: V3, o: V3 = v3()): V3 =>
  vset(o, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const vlen = (a: V3) => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
export const vlenSq = (a: V3) => a.x * a.x + a.y * a.y + a.z * a.z;
export const vdist = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const vnorm = (a: V3, o: V3 = v3()): V3 => {
  const l = vlen(a);
  return l > 1e-9 ? vset(o, a.x / l, a.y / l, a.z / l) : vset(o, 0, 0, 0);
};
export const vlerp = (a: V3, b: V3, t: number, o: V3 = v3()): V3 =>
  vset(o, lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));

export const q = (x = 0, y = 0, z = 0, w = 1): Q => ({ x, y, z, w });
export const qcopy = (a: Q): Q => ({ x: a.x, y: a.y, z: a.z, w: a.w });

export const qmul = (a: Q, b: Q, o: Q = q()): Q => {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  o.x = x; o.y = y; o.z = z; o.w = w;
  return o;
};

export const qnorm = (a: Q): Q => {
  const l = Math.hypot(a.x, a.y, a.z, a.w) || 1;
  a.x /= l; a.y /= l; a.z /= l; a.w /= l;
  return a;
};

export const qconj = (a: Q, o: Q = q()): Q => { o.x = -a.x; o.y = -a.y; o.z = -a.z; o.w = a.w; return o; };

/** Rotate vector 'v' by quaternion 'a' (world = a * v * a^-1). */
export const qrot = (a: Q, v: V3, o: V3 = v3()): V3 => {
  const ix = a.w * v.x + a.y * v.z - a.z * v.y;
  const iy = a.w * v.y + a.z * v.x - a.x * v.z;
  const iz = a.w * v.z + a.x * v.y - a.y * v.x;
  const iw = -a.x * v.x - a.y * v.y - a.z * v.z;
  return vset(o,
    ix * a.w + iw * -a.x + iy * -a.z - iz * -a.y,
    iy * a.w + iw * -a.y + iz * -a.x - ix * -a.z,
    iz * a.w + iw * -a.z + ix * -a.y - iy * -a.x);
};

/** Inverse-rotate: world -> body. */
export const qrotInv = (a: Q, v: V3, o: V3 = v3()): V3 => qrot(qconj(a, _qt), v, o);
const _qt = q();

/** Integrate a quaternion by body-frame angular velocity (rad/s) over dt. */
export const qIntegrate = (o: Q, wBody: V3, dt: number): Q => {
  const hx = wBody.x * dt * 0.5, hy = wBody.y * dt * 0.5, hz = wBody.z * dt * 0.5;
  const dx = o.w * hx + o.y * hz - o.z * hy;
  const dy = o.w * hy + o.z * hx - o.x * hz;
  const dz = o.w * hz + o.x * hy - o.y * hx;
  const dw = -o.x * hx - o.y * hy - o.z * hz;
  o.x += dx; o.y += dy; o.z += dz; o.w += dw;
  return qnorm(o);
};

export const qslerp = (a: Q, b: Q, t: number, o: Q = q()): Q => {
  let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  if (cos > 0.9995) {
    o.x = lerp(a.x, bx, t); o.y = lerp(a.y, by, t);
    o.z = lerp(a.z, bz, t); o.w = lerp(a.w, bw, t);
    return qnorm(o);
  }
  const th = Math.acos(cos), s = Math.sin(th);
  const sa = Math.sin((1 - t) * th) / s, sb = Math.sin(t * th) / s;
  o.x = a.x * sa + bx * sb; o.y = a.y * sa + by * sb;
  o.z = a.z * sa + bz * sb; o.w = a.w * sa + bw * sb;
  return o;
};

export const qFromAxisAngle = (axis: V3, angle: number, o: Q = q()): Q => {
  const h = angle * 0.5, s = Math.sin(h);
  o.x = axis.x * s; o.y = axis.y * s; o.z = axis.z * s; o.w = Math.cos(h);
  return o;
};

export const qFromEuler = (pitch: number, yaw: number, roll: number, o: Q = q()): Q => {
  const cy = Math.cos(yaw * 0.5), sy = Math.sin(yaw * 0.5);
  const cp = Math.cos(pitch * 0.5), sp = Math.sin(pitch * 0.5);
  const cr = Math.cos(roll * 0.5), sr = Math.sin(roll * 0.5);
  o.x = sp * cy * cr + cp * sy * sr;
  o.y = cp * sy * cr - sp * cy * sr;
  o.z = cp * cy * sr - sp * sy * cr;
  o.w = cp * cy * cr + sp * sy * sr;
  return o;
};

/** Deterministic hash-based PRNG — identical results on client and server. */
export class Rng {
  private s: number;
  constructor(seed = 1) { this.s = seed >>> 0 || 1; }
  next(): number {
    // xorshift32
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  range(a: number, b: number) { return a + this.next() * (b - a); }
  int(n: number) { return Math.floor(this.next() * n); }
  pick<T>(arr: readonly T[]): T { return arr[this.int(arr.length)]; }
}

/** 2D value-noise hash, deterministic across platforms (integer math only). */
export const hash2 = (x: number, y: number, seed = 0): number => {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 1274126177;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
