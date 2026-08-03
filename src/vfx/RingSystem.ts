import * as THREE from 'three';
import type { ParticleGlobals } from './ParticleEngine';

/**
 * Expanding annuli — the blast shockwave, the dust ring that rolls out from a
 * ground hit and settles, water ripples, and the condensation collar that snaps
 * on near critical Mach.
 *
 * These are geometry, not sprites: a real ring in world space, oriented by a
 * per-instance basis, whose radius and thickness are evaluated in the vertex
 * shader. That is what lets a shockwave sit *on* the ground plane and read
 * correctly from any angle, which a billboard cannot do.
 *
 * The "distorting" part of the annulus is faked with three ingredients that
 * cost nothing and survive without a refraction pass: a hard white leading
 * edge, an ink-dark trailing edge, and a radial squeeze of the interior bands
 * so the ring looks like compressed air rather than a drawn circle. If the
 * renderer later hands us a scene-colour texture, 'uRefract' switches on a real
 * screen-space UV displacement instead.
 */

const SEGMENTS = 96;

const VERT = /* glsl */`
attribute vec3 iCenter;
attribute vec3 iRight;
attribute vec3 iUp;
attribute vec4 iT;    // birth, life, r0, r1
attribute vec4 iW;    // thick0, thick1, ramp, wobble
attribute vec4 iTint; // rgb, alphaMul

uniform float uTime;

varying vec4  vP;      // age, ramp, alphaMul, radialParam
varying vec3  vTint;
varying float vViewZ;
varying float vWobble;

void main() {
  float t = uTime - iT.x;
  if ( t < 0.0 || t >= iT.y ) {
    gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );
    return;
  }
  float age = t / iT.y;

  // Blast fronts decelerate hard: most of the radius is covered in the first
  // fifth of the life. A cubic ease-out is a good stand-in for the Sedov
  // similarity solution over the short window we actually draw.
  float e = 1.0 - pow( 1.0 - age, 3.0 );
  float r = mix( iT.z, iT.w, e );
  float th = mix( iW.x, iW.y, age );

  float ang = position.x;
  float radial = position.y;            // 0 = inner edge, 1 = outer edge

  // Ragged the circumference a little so it never reads as a CAD circle.
  float wob = 1.0 + iW.w * sin( ang * 7.0 + iT.x * 3.1 ) * 0.5
                  + iW.w * sin( ang * 13.0 - iT.x * 1.7 ) * 0.25;

  float rr = r * wob + ( radial - 0.35 ) * th;
  vec3 dir = iRight * cos( ang ) + iUp * sin( ang );
  vec3 p = iCenter + dir * rr;

  vec4 mv = viewMatrix * vec4( p, 1.0 );
  vViewZ = mv.z;
  vP = vec4( age, iW.z, iTint.a, radial );
  vTint = iTint.rgb;
  vWobble = wob;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */`
uniform sampler2D uRamps;
uniform float uRampCount;
uniform vec3  uInkColor;
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform float uAdditive;
uniform float uOpacity;
uniform float uBands;

varying vec4  vP;
varying vec3  vTint;
varying float vViewZ;
varying float vWobble;

void main() {
  float radial = vP.w;

  // Cross-section profile: a hot, thin leading edge on the outside, a fast
  // fall-off inward. Quantised into hard bands.
  float prof = smoothstep( 0.0, 0.22, radial ) * ( 1.0 - smoothstep( 0.55, 1.0, radial ) );
  prof = max( prof, smoothstep( 0.80, 0.94, radial ) * ( 1.0 - smoothstep( 0.94, 1.0, radial ) ) * 1.4 );
  float b = max( uBands, 1.0 );
  float banded = floor( prof * b + 0.35 ) / b;

  vec4 ramp = texture2D( uRamps, vec2( vP.x, ( vP.y + 0.5 ) / uRampCount ) );
  float alpha = ramp.a * vP.z * banded * uOpacity;
  if ( alpha <= 0.004 ) discard;

  vec3 col = ramp.rgb * vTint;
  // Ink the inner lip: a dark edge behind the bright front is what sells the
  // "compressed air" read in stylised art.
  col = mix( uInkColor, col, smoothstep( 0.02, 0.16, radial ) );

  float fogDepth = -vViewZ;
  float fogF = clamp( 1.0 - exp( -uFogDensity * uFogDensity * fogDepth * fogDepth ), 0.0, 1.0 );
  col = mix( col, uFogColor * ( 1.0 - uAdditive ), fogF );

  gl_FragColor = vec4( col, alpha );
}
`;

export interface RingSpawn {
  x: number; y: number; z: number;
  /** Ring plane normal. */
  nx: number; ny: number; nz: number;
  life: number;
  r0: number; r1: number;
  thick0: number; thick1: number;
  ramp: number;
  /** Circumference raggedness, 0..0.2. */
  wobble: number;
  r: number; g: number; b: number; a: number;
}

const _n = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _tmp = new THREE.Vector3();

export class RingSystem {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly capacity: number;

  private geom: THREE.InstancedBufferGeometry;
  private iCenter: THREE.InstancedBufferAttribute;
  private iRight: THREE.InstancedBufferAttribute;
  private iUp: THREE.InstancedBufferAttribute;
  private iT: THREE.InstancedBufferAttribute;
  private iW: THREE.InstancedBufferAttribute;
  private iTint: THREE.InstancedBufferAttribute;
  private attrs: THREE.InstancedBufferAttribute[];

  private head = 0;
  private wrapped = false;
  private latestDeath = -1;
  private dirtyLo = Infinity;
  private dirtyHi = -1;

  constructor(name: string, capacity: number, globals: ParticleGlobals, additive: boolean, renderOrder: number) {
    this.capacity = capacity;

    const g = new THREE.InstancedBufferGeometry();
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2;
      pos.push(a, 0, 0);
      pos.push(a, 1, 0);
    }
    for (let i = 0; i < SEGMENTS; i++) {
      const a = i * 2, b = a + 1, c = a + 3, d = a + 2;
      idx.push(a, b, c, a, c, d);
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);

    const mk = (items: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * items), items);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.iCenter = mk(3); this.iRight = mk(3); this.iUp = mk(3);
    this.iT = mk(4); this.iW = mk(4); this.iTint = mk(4);
    this.attrs = [this.iCenter, this.iRight, this.iUp, this.iT, this.iW, this.iTint];

    g.setAttribute('iCenter', this.iCenter);
    g.setAttribute('iRight', this.iRight);
    g.setAttribute('iUp', this.iUp);
    g.setAttribute('iT', this.iT);
    g.setAttribute('iW', this.iW);
    g.setAttribute('iTint', this.iTint);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.geom = g;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: globals.uTime,
        uRamps: globals.uRamps,
        uRampCount: globals.uRampCount,
        uInkColor: globals.uInkColor,
        uFogColor: globals.uFogColor,
        uFogDensity: globals.uFogDensity,
        uAdditive: { value: additive ? 1 : 0 },
        uOpacity: { value: 1 },
        uBands: { value: 2 },
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
    this.material.name = `vfx.ring.${name}`;

    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = `vfx.ring.${name}`;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.matrixAutoUpdate = false;
    if (additive) this.mesh.layers.enable(2);
  }

  emit(now: number, s: RingSpawn): void {
    const i = this.head;
    this.head = (i + 1) % this.capacity;
    if (this.head === 0) this.wrapped = true;

    _n.set(s.nx, s.ny, s.nz);
    if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0);
    _n.normalize();
    // Any stable perpendicular basis in the ring plane.
    _tmp.set(0, 1, 0);
    if (Math.abs(_n.dot(_tmp)) > 0.95) _tmp.set(1, 0, 0);
    _r.copy(_tmp).cross(_n).normalize();
    _u.copy(_n).cross(_r).normalize();

    let o = i * 3;
    const c = this.iCenter.array as Float32Array;
    c[o] = s.x; c[o + 1] = s.y; c[o + 2] = s.z;
    const rr = this.iRight.array as Float32Array;
    rr[o] = _r.x; rr[o + 1] = _r.y; rr[o + 2] = _r.z;
    const uu = this.iUp.array as Float32Array;
    uu[o] = _u.x; uu[o + 1] = _u.y; uu[o + 2] = _u.z;

    o = i * 4;
    const t = this.iT.array as Float32Array;
    t[o] = now; t[o + 1] = Math.max(0.05, s.life); t[o + 2] = s.r0; t[o + 3] = s.r1;
    const w = this.iW.array as Float32Array;
    w[o] = s.thick0; w[o + 1] = s.thick1; w[o + 2] = s.ramp; w[o + 3] = s.wobble;
    const tn = this.iTint.array as Float32Array;
    tn[o] = s.r; tn[o + 1] = s.g; tn[o + 2] = s.b; tn[o + 3] = s.a;

    const death = now + s.life;
    if (death > this.latestDeath) this.latestDeath = death;
    if (i < this.dirtyLo) this.dirtyLo = i;
    if (i > this.dirtyHi) this.dirtyHi = i;
  }

  flush(now: number): void {
    if (this.dirtyHi >= this.dirtyLo) {
      const count = this.dirtyHi - this.dirtyLo + 1;
      for (const a of this.attrs) {
        a.clearUpdateRanges();
        a.addUpdateRange(this.dirtyLo * a.itemSize, count * a.itemSize);
        a.needsUpdate = true;
      }
    }
    this.dirtyLo = Infinity; this.dirtyHi = -1;

    if (this.latestDeath >= 0 && now > this.latestDeath) {
      this.head = 0; this.wrapped = false; this.latestDeath = -1;
    }
    this.geom.instanceCount = this.wrapped ? this.capacity : this.head;
  }

  setOpacity(v: number): void { this.material.uniforms.uOpacity.value = v; }

  clear(): void {
    this.head = 0; this.wrapped = false; this.latestDeath = -1;
    this.geom.instanceCount = 0;
  }

  dispose(): void { this.geom.dispose(); this.material.dispose(); }
}
