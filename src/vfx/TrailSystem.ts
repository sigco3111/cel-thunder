import * as THREE from 'three';
import type { ParticleGlobals } from './ParticleEngine';

/**
 * Ribbon trails: contrails, wingtip vortices, ordnance smoke, ricochet streaks
 * and the smoke that pours off ripped structure.
 *
 * Two orientation modes share one implementation:
 *
 *  - **billboard** — the strip is twisted to face the camera each frame in the
 *    vertex shader. Right for contrails and ordnance trails, which have no
 *    meaningful "up" of their own.
 *  - **ribbon** — the strip keeps a real geometric orientation supplied per
 *    point. Wingtip and propeller vortices use this and rotate that up-vector
 *    around the trail tangent as they are emitted, which is what produces the
 *    corkscrew: a genuine helical ribbon, not a scrolling texture.
 *
 * Points are stored newest-first and shifted down on emit. A shift is a single
 * 'copyWithin' over a few hundred floats and only happens on emit (10-30 Hz per
 * trail), which is far cheaper than the per-frame index rebuild a ring needs,
 * and keeps the strip topology trivially correct.
 *
 * Age lives in the vertex data as an absolute birth time, so a trail that is
 * not being extended costs *zero* CPU per frame while it fades out.
 */

export type TrailMode = 'billboard' | 'ribbon';

export interface TrailConfig {
  /** Ramp atlas row. */
  ramp: number;
  /** Metres, at birth and at the end of a point's life. */
  width0: number;
  width1: number;
  /** Seconds each point survives. */
  life: number;
  /** Overall alpha multiplier. */
  alpha: number;
  /** Tint over the ramp colour. */
  r: number; g: number; b: number;
  /** Minimum metres between emitted points. */
  minStep: number;
  /** Radians of ribbon twist added per emitted point (ribbon mode). */
  twistRate: number;
  /** Number of hard alpha bands across the ribbon. 0 = smooth. */
  bands: number;
  /** Ink edge width in pixels along the ribbon's long edges. */
  ink: number;
  /** Additive (vapour catching the sun) vs normal (dark smoke). */
  additive: boolean;
}

export const DEFAULT_TRAIL: TrailConfig = {
  ramp: 0, width0: 1, width1: 4, life: 6, alpha: 1,
  r: 1, g: 1, b: 1, minStep: 8, twistRate: 0, bands: 3, ink: 0, additive: false,
};

const VERT = /* glsl */`
attribute vec3 aTangent;
attribute vec3 aUp;
attribute vec4 aP0;   // side(-1/+1), birth, life, width0
attribute vec4 aP1;   // widthGrow, ramp, alphaMul, bands
attribute vec3 aTint;

uniform float uTime;
uniform float uCameraFacing;

varying vec4  vP;     // age01, ramp, alphaMul, bands
varying vec3  vTint;
varying float vSide;
varying float vViewZ;

void main() {
  float t = uTime - aP0.y;
  float life = max( aP0.z, 1e-3 );
  float age = clamp( t / life, 0.0, 1.0 );

  // A ribbon is a strip: a dead point cannot simply be clipped away, because
  // the quad it shares with its still-living neighbour would survive clipping
  // as a stray sliver. Instead a dead point collapses to zero width, which
  // makes that quad a genuinely degenerate (zero-area) triangle pair and, at
  // the live/dead boundary, tapers the ribbon to a point exactly where the
  // trail ended. Same trick retires unused slots.
  float dead = step( life, t ) + step( t, -1e-6 );

  vec3 wp = position;
  vec3 tang = normalize( aTangent + vec3( 0.0, 1e-5, 0.0 ) );
  vec3 right;
  if ( uCameraFacing > 0.5 ) {
    vec3 toCam = normalize( cameraPosition - wp );
    right = cross( tang, toCam );
    float l = length( right );
    // Looking straight down the trail: any perpendicular will do.
    right = l > 1e-4 ? right / l : normalize( cross( tang, vec3( 0.0, 1.0, 0.0 ) + vec3( 1e-3 ) ) );
  } else {
    right = normalize( aUp - tang * dot( aUp, tang ) );
  }

  float w = ( aP0.w + aP1.x * max( t, 0.0 ) ) * ( 1.0 - min( dead, 1.0 ) );
  wp += right * ( aP0.x * w * 0.5 );

  vec4 mv = viewMatrix * vec4( wp, 1.0 );
  vViewZ = mv.z;
  vP = vec4( age, aP1.y, aP1.z, aP1.w );
  vTint = aTint;
  vSide = aP0.x;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */`
uniform sampler2D uRamps;
uniform float uRampCount;
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform vec3  uInkColor;
uniform float uAdditive;
uniform float uOpacity;
uniform float uInk;

varying vec4  vP;
varying vec3  vTint;
varying float vSide;
varying float vViewZ;

void main() {
  vec4 ramp = texture2D( uRamps, vec2( vP.x, ( vP.y + 0.5 ) / uRampCount ) );
  float alpha = ramp.a * vP.z * uOpacity;

  // Cross-ribbon shaping: opaque core, translucent edges — but banded, so it
  // reads as a stack of flat ribbons rather than an airbrushed gradient.
  float e = 1.0 - abs( vSide );
  float shape = smoothstep( 0.0, 0.35, e );
  if ( vP.w > 0.5 ) {
    float b = max( vP.w, 1.0 );
    shape = floor( shape * b + 0.5 ) / b;
  }
  alpha *= shape;
  if ( alpha <= 0.004 ) discard;

  vec3 col = ramp.rgb * vTint;

  if ( uInk > 0.0 ) {
    float w = fwidth( e ) * uInk;
    col = mix( uInkColor, col, smoothstep( 0.0, w, e ) );
  }

  float fogDepth = -vViewZ;
  float fogF = clamp( 1.0 - exp( -uFogDensity * uFogDensity * fogDepth * fogDepth ), 0.0, 1.0 );
  col = mix( col, uFogColor * ( 1.0 - uAdditive ), fogF );

  gl_FragColor = vec4( col, alpha );
}
`;

interface TrailSlot {
  active: boolean;
  /** Bumped on release so a stale handle can never write to a reused slot. */
  generation: number;
  count: number;
  cfg: TrailConfig;
  lastX: number; lastY: number; lastZ: number;
  hasLast: boolean;
  twist: number;
  /** Absolute time of the newest point; used to retire the slot. */
  newest: number;
}

/** Opaque handle: slot index in the low bits, generation in the high bits. */
export type TrailHandle = number;
const NO_TRAIL: TrailHandle = -1;
export { NO_TRAIL };

export class TrailPool {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  private geom: THREE.BufferGeometry;
  private maxTrails: number;
  private maxPoints: number;

  private pos: THREE.BufferAttribute;
  private tang: THREE.BufferAttribute;
  private up: THREE.BufferAttribute;
  private p0: THREE.BufferAttribute;
  private p1: THREE.BufferAttribute;
  private tint: THREE.BufferAttribute;
  private attrs: THREE.BufferAttribute[];

  private slots: TrailSlot[] = [];
  private dirty = new Set<number>();

  constructor(
    name: string,
    mode: TrailMode,
    maxTrails: number,
    maxPoints: number,
    globals: ParticleGlobals,
    renderOrder: number,
    additive: boolean,
    bloom: boolean,
  ) {
    this.maxTrails = maxTrails;
    this.maxPoints = maxPoints;

    const verts = maxTrails * maxPoints * 2;
    const g = new THREE.BufferGeometry();
    const mk = (items: number) => {
      const a = new THREE.BufferAttribute(new Float32Array(verts * items), items);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.pos = mk(3); this.tang = mk(3); this.up = mk(3);
    this.p0 = mk(4); this.p1 = mk(4); this.tint = mk(3);
    this.attrs = [this.pos, this.tang, this.up, this.p0, this.p1, this.tint];

    g.setAttribute('position', this.pos);
    g.setAttribute('aTangent', this.tang);
    g.setAttribute('aUp', this.up);
    g.setAttribute('aP0', this.p0);
    g.setAttribute('aP1', this.p1);
    g.setAttribute('aTint', this.tint);

    // Static strip topology: two triangles per segment, per trail. Unused
    // segments have coincident vertices and cost nothing.
    const segs = maxPoints - 1;
    const idx = new Uint32Array(maxTrails * segs * 6);
    let w = 0;
    for (let tr = 0; tr < maxTrails; tr++) {
      const base = tr * maxPoints * 2;
      for (let s = 0; s < segs; s++) {
        const a = base + s * 2, b = a + 1, c = a + 3, d = a + 2;
        idx[w++] = a; idx[w++] = b; idx[w++] = c;
        idx[w++] = a; idx[w++] = c; idx[w++] = d;
      }
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.geom = g;

    // Side is a per-vertex constant and never changes; write it once.
    const p0a = this.p0.array as Float32Array;
    for (let i = 0; i < verts; i++) p0a[i * 4] = (i & 1) === 0 ? -1 : 1;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: globals.uTime,
        uRamps: globals.uRamps,
        uRampCount: globals.uRampCount,
        uFogColor: globals.uFogColor,
        uFogDensity: globals.uFogDensity,
        uInkColor: globals.uInkColor,
        uCameraFacing: { value: mode === 'billboard' ? 1 : 0 },
        uAdditive: { value: additive ? 1 : 0 },
        uOpacity: { value: 1 },
        uInk: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.material.name = `vfx.trail.${name}`;

    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = `vfx.trail.${name}`;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.matrixAutoUpdate = false;
    if (bloom) this.mesh.layers.enable(2);

    for (let i = 0; i < maxTrails; i++) {
      this.slots.push({
        active: false, generation: 1, count: 0, cfg: { ...DEFAULT_TRAIL },
        lastX: 0, lastY: 0, lastZ: 0, hasLast: false, twist: 0, newest: -1,
      });
    }
  }

  // -------------------------------------------------------------------------

  /** Grabs a free trail. Returns NO_TRAIL when the pool is exhausted. */
  acquire(cfg: Partial<TrailConfig>): TrailHandle {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.active) continue;
      // The previous tenant's points are still live in the vertex buffer — a
      // released slot only stops *growing*, its points keep rendering until
      // they age out, and flush() will not retire a slot that has been taken
      // again. Without this, a 30 s contrail landing on a slot a ricochet used
      // 40 ms ago inherits the ricochet's points and draws a wedge back to the
      // old impact, and the reverse case draws a kilometre of white ribbon
      // across the sky. collapse() backdates every birth to -1e9, which the
      // vertex shader's 'dead' term turns into zero-width degenerate quads.
      this.collapse(i);
      s.active = true;
      s.count = 0;
      s.hasLast = false;
      s.twist = 0;
      s.newest = -1;
      Object.assign(s.cfg, DEFAULT_TRAIL, cfg);
      return (s.generation << 12) | i;
    }
    return NO_TRAIL;
  }

  private resolve(h: TrailHandle): TrailSlot | null {
    if (h < 0) return null;
    const i = h & 0xfff;
    if (i >= this.slots.length) return null;
    const s = this.slots[i];
    if (!s.active || s.generation !== (h >>> 12)) return null;
    return s;
  }

  isAlive(h: TrailHandle): boolean { return this.resolve(h) !== null; }

  config(h: TrailHandle): TrailConfig | null {
    const s = this.resolve(h);
    return s ? s.cfg : null;
  }

  /** Detaches the trail: it stops growing but its points still fade out. */
  release(h: TrailHandle): void {
    const s = this.resolve(h);
    if (!s) return;
    s.active = false;
    s.generation = (s.generation + 1) & 0xfffff;
  }

  /** Wipes the trail immediately (used when an entity teleports or despawns). */
  kill(h: TrailHandle): void {
    const s = this.resolve(h);
    if (!s) return;
    const i = h & 0xfff;
    this.collapse(i);
    s.active = false;
    s.count = 0;
    s.generation = (s.generation + 1) & 0xfffff;
  }

  /**
   * Adds a point if the trail has moved far enough. 'ux/uy/uz' is the ribbon's
   * up vector in ribbon mode (ignored when billboarding).
   */
  extend(
    h: TrailHandle, now: number,
    x: number, y: number, z: number,
    ux = 0, uy = 1, uz = 0,
    force = false,
  ): boolean {
    const s = this.resolve(h);
    if (!s) return false;

    if (s.hasLast) {
      const dx = x - s.lastX, dy = y - s.lastY, dz = z - s.lastZ;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (!force && d2 < s.cfg.minStep * s.cfg.minStep) return false;
      // Teleport guard. A respawn, a snapshot resync or a camera cut moves the
      // anchor by an impossible amount, and a strip is more than happy to draw
      // a kilometre-long ribbon across the map to prove it. Start over instead.
      const jump = Math.max(120, s.cfg.minStep * 24);
      if (d2 > jump * jump) {
        this.collapse(h & 0xfff);
        s.count = 0;
        s.hasLast = false;
        s.twist = 0;
      }
    }

    const i = h & 0xfff;
    const base = i * this.maxPoints * 2;

    // Tangent from the previous point; the very first point has no history so
    // it borrows the up vector's perpendicular and is immediately superseded.
    let tx = 0, ty = 0, tz = 1;
    if (s.hasLast) {
      tx = x - s.lastX; ty = y - s.lastY; tz = z - s.lastZ;
      const l = Math.hypot(tx, ty, tz) || 1;
      tx /= l; ty /= l; tz /= l;
    }

    s.twist += s.cfg.twistRate;
    // Rotate the supplied up-vector around the tangent (Rodrigues) to build the
    // helix. With twistRate = 0 this is the identity.
    let rx = ux, ry = uy, rz = uz;
    if (s.cfg.twistRate !== 0 && s.hasLast) {
      const c = Math.cos(s.twist), sn = Math.sin(s.twist);
      const dot = tx * ux + ty * uy + tz * uz;
      const cx = ty * uz - tz * uy, cy = tz * ux - tx * uz, cz = tx * uy - ty * ux;
      rx = ux * c + cx * sn + tx * dot * (1 - c);
      ry = uy * c + cy * sn + ty * dot * (1 - c);
      rz = uz * c + cz * sn + tz * dot * (1 - c);
    }

    // Shift every existing point one slot toward the tail, then write the new
    // point at local index 0 so index order always equals age order.
    const n = Math.min(s.count, this.maxPoints - 1);
    if (n > 0) {
      for (const a of this.attrs) {
        const arr = a.array as Float32Array;
        const it = a.itemSize;
        const from = base * it;
        arr.copyWithin(from + 2 * it, from, from + n * 2 * it);
      }
      // 'side' is positional, and copyWithin just scrambled it — restore.
      const p0a = this.p0.array as Float32Array;
      for (let k = 0; k <= n; k++) {
        p0a[(base + k * 2) * 4] = -1;
        p0a[(base + k * 2 + 1) * 4] = 1;
      }
    }
    s.count = Math.min(s.count + 1, this.maxPoints);

    const cfg = s.cfg;
    const grow = (cfg.width1 - cfg.width0) / Math.max(cfg.life, 1e-3);
    for (let side = 0; side < 2; side++) {
      const v = base + side;
      let o = v * 3;
      const pa = this.pos.array as Float32Array;
      pa[o] = x; pa[o + 1] = y; pa[o + 2] = z;
      const ta = this.tang.array as Float32Array;
      ta[o] = tx; ta[o + 1] = ty; ta[o + 2] = tz;
      const ua = this.up.array as Float32Array;
      ua[o] = rx; ua[o + 1] = ry; ua[o + 2] = rz;
      const tn = this.tint.array as Float32Array;
      tn[o] = cfg.r; tn[o + 1] = cfg.g; tn[o + 2] = cfg.b;

      o = v * 4;
      const a0 = this.p0.array as Float32Array;
      a0[o] = side === 0 ? -1 : 1; a0[o + 1] = now; a0[o + 2] = cfg.life; a0[o + 3] = cfg.width0;
      const a1 = this.p1.array as Float32Array;
      a1[o] = grow; a1[o + 1] = cfg.ramp; a1[o + 2] = cfg.alpha; a1[o + 3] = cfg.bands;
    }

    // Cap the strip. The slot just past the oldest live point is a zero-width
    // duplicate of it, so the closing quad is exactly collinear (zero area)
    // and can never stretch off toward a stale position left by a previous
    // tenant of this slot.
    if (s.count < this.maxPoints) {
      const oldest = base + (s.count - 1) * 2;
      const guard = base + s.count * 2;
      for (const a of this.attrs) {
        const arr = a.array as Float32Array;
        const it = a.itemSize;
        arr.copyWithin(guard * it, oldest * it, (oldest + 2) * it);
      }
      const g0 = this.p0.array as Float32Array;
      const g1 = this.p1.array as Float32Array;
      g0[guard * 4] = -1; g0[(guard + 1) * 4] = 1;
      g0[guard * 4 + 3] = 0; g0[(guard + 1) * 4 + 3] = 0;   // width0 = 0
      g1[guard * 4] = 0; g1[(guard + 1) * 4] = 0;           // widthGrow = 0
    }

    s.lastX = x; s.lastY = y; s.lastZ = z; s.hasLast = true;
    s.newest = now;
    this.dirty.add(i);
    return true;
  }

  private collapse(i: number): void {
    const base = i * this.maxPoints * 2;
    const a0 = this.p0.array as Float32Array;
    for (let k = 0; k < this.maxPoints * 2; k++) a0[(base + k) * 4 + 1] = -1e9;
    this.dirty.add(i);
  }

  /** Uploads touched trails and retires slots whose points have all expired. */
  flush(now: number): void {
    if (this.dirty.size) {
      // A single range covering the touched slots is cheaper to submit than a
      // dozen tiny ones and trails are spatially clustered in the pool.
      let lo = Infinity, hi = -1;
      for (const i of this.dirty) { if (i < lo) lo = i; if (i > hi) hi = i; }
      const stride = this.maxPoints * 2;
      const start = lo * stride;
      const count = (hi - lo + 1) * stride;
      for (const a of this.attrs) {
        a.clearUpdateRanges();
        a.addUpdateRange(start * a.itemSize, count * a.itemSize);
        a.needsUpdate = true;
      }
      this.dirty.clear();
    }

    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.active || s.count === 0) continue;
      if (s.newest >= 0 && now - s.newest > s.cfg.life) {
        this.collapse(i);
        s.count = 0;
        s.newest = -1;
      }
    }
  }

  setOpacity(v: number): void { this.material.uniforms.uOpacity.value = v; }
  setInk(px: number): void { this.material.uniforms.uInk.value = px; }

  get freeSlots(): number {
    let n = 0;
    for (const s of this.slots) if (!s.active) n++;
    return n;
  }

  clear(): void {
    for (let i = 0; i < this.slots.length; i++) {
      this.collapse(i);
      const s = this.slots[i];
      s.active = false; s.count = 0; s.newest = -1;
      s.generation = (s.generation + 1) & 0xfffff;
    }
  }

  dispose(): void {
    this.geom.dispose();
    this.material.dispose();
  }
}
