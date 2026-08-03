import * as THREE from 'three';
import { createCelMaterial, type CelMaterial } from '../render/CelMaterial';
import { Rng } from '../shared/math';

/**
 * Solid tumbling debris: airframe chunks torn off by cannon fire, dirt clods
 * thrown out of a bomb crater, and ejected gun casings.
 *
 * Unlike the particle groups these are real, lit, outlined geometry, because a
 * chunk of wing needs to *read* as a chunk of wing — it catches the sun,
 * tumbles on its own axes and throws a silhouette. There are never more than a
 * few hundred alive, so they are simulated on the CPU (rigid integration plus a
 * terrain bounce) and pushed into an InstancedMesh.
 *
 * The outline is a second InstancedMesh sharing the same instanceMatrix buffer,
 * with its own inverted-hull shader that transforms the normal by the instance
 * matrix — the shared outline helper in CelMaterial does not, which would make
 * a tumbling chunk's outline slide off to one side.
 */

export type DebrisKind = 'chunk' | 'panel' | 'casing' | 'clod';

export interface DebrisSpawn {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  kind: DebrisKind;
  /** Metres, longest axis. */
  size: number;
  life: number;
  color: number;
  /** rad/s magnitude of the tumble. */
  spin: number;
  /** 0 = inert, 1 = pours smoke and embers behind it. */
  burning: number;
  /** Linear drag, 1/s. */
  drag: number;
}

interface Debris {
  active: boolean;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  q: THREE.Quaternion;
  wx: number; wy: number; wz: number;
  scale: number;
  age: number;
  life: number;
  drag: number;
  burning: number;
  kind: DebrisKind;
  color: THREE.Color;
  trailTimer: number;
  bounced: number;
  grounded: boolean;
}

const OUTLINE_VERT = /* glsl */`
uniform float uWidth;
uniform vec2  uResolution;
uniform float uFadeStart;
uniform float uFadeEnd;
varying float vFade;

void main() {
  // The instance matrix carries the tumble, so the hull must be expanded along
  // the *instance-rotated* normal or the outline detaches as the chunk spins.
  mat3 im = mat3( instanceMatrix );
  vec3 n = normalize( normalMatrix * ( im * normal ) );
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
  float dist = -mvPosition.z;
  float pixelScale = dist * ( 2.0 / projectionMatrix[1][1] ) / uResolution.y;
  mvPosition.xyz += n * ( uWidth * pixelScale * 90.0 );
  gl_Position = projectionMatrix * mvPosition;
  gl_Position.z += 0.00015 * gl_Position.w;
  vFade = 1.0 - smoothstep( uFadeStart, uFadeEnd, dist );
}
`;

const OUTLINE_FRAG = /* glsl */`
uniform vec3 uColor;
varying float vFade;
void main() {
  if ( vFade < 0.02 ) discard;
  gl_FragColor = vec4( uColor, vFade );
}
`;

/** Irregular faceted lump — an icosahedron with its vertices pulled about. */
function makeChunkGeometry(seed: number, flatness = 1): THREE.BufferGeometry {
  // PolyhedronGeometry is already non-indexed, so every triangle owns its
  // vertices and recomputed normals come out flat — which is what we want.
  const g = new THREE.IcosahedronGeometry(0.5, 0);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const rng = new Rng(seed);
  // Displace by vertex *key* rather than by index so shared corners of the
  // non-indexed mesh move together and the solid stays closed.
  const map = new Map<string, [number, number, number]>();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const key = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
    let d = map.get(key);
    if (!d) {
      const s = 0.55 + rng.next() * 0.85;
      d = [x * s, y * s * flatness, z * s];
      map.set(key, d);
    }
    p.setXYZ(i, d[0], d[1], d[2]);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

function makeCasingGeometry(): THREE.BufferGeometry {
  // A cartridge case: slightly tapered, rimmed, 6-sided so the facets catch
  // the stepped specular and it twinkles as it tumbles.
  const g = new THREE.CylinderGeometry(0.40, 0.46, 1.0, 6, 1, false);
  g.rotateZ(Math.PI / 2);  // long axis along X so `size` is the case length
  return g;
}

interface Bucket {
  kind: DebrisKind;
  mesh: THREE.InstancedMesh;
  outline: THREE.InstancedMesh;
  material: CelMaterial;
  outlineMaterial: THREE.ShaderMaterial;
  geometry: THREE.BufferGeometry;
  list: Debris[];
  count: number;
}

const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _qd = new THREE.Quaternion();
const _axis = new THREE.Vector3();

export interface DebrisEnv {
  terrainHeight(x: number, z: number): number;
  /** Called for burning chunks; the VFX system wires this to the particle pool. */
  // 'scale' (not 'size') — this is the live Debris record, whose longest-axis
  // extent is stored as 'scale' once it has been spawned.
  onTrail(d: { x: number; y: number; z: number; vx: number; vy: number; vz: number; burning: number; scale: number }): void;
  /** Called once when a chunk hits the ground. */
  onImpact(x: number, y: number, z: number, speed: number, kind: DebrisKind): void;
}

export class DebrisSystem {
  readonly root = new THREE.Group();
  private buckets = new Map<DebrisKind, Bucket>();
  private budget = 1;

  constructor(capacities: Record<DebrisKind, number>, outlineWidth = 0.010) {
    this.root.name = 'vfx.debris';
    this.root.matrixAutoUpdate = false;

    const defs: { kind: DebrisKind; geom: THREE.BufferGeometry; gloss: number; spec: number }[] = [
      { kind: 'chunk', geom: makeChunkGeometry(9137, 1.0), gloss: 0.45, spec: 0.55 },
      { kind: 'panel', geom: makeChunkGeometry(4421, 0.28), gloss: 0.28, spec: 0.85 },
      { kind: 'casing', geom: makeCasingGeometry(), gloss: 0.18, spec: 1.15 },
      { kind: 'clod', geom: makeChunkGeometry(7717, 0.85), gloss: 0.85, spec: 0.12 },
    ];

    for (const d of defs) {
      const cap = capacities[d.kind];
      const material = createCelMaterial({
        name: `vfx.debris.${d.kind}`,
        color: 0xffffff,
        bands: 3,
        bandSoftness: 0.05,
        gloss: d.gloss,
        specular: d.spec,
        specSteps: 2,
        rimStrength: 0.9,
        rimPower: 2.6,
        vertexColors: false,
        inkInterior: true,
      });
      // MeshToonMaterial has no flatShading flag, so faceting has to come from
      // the geometry: every triangle needs its own normals or tumbling debris
      // reads as smooth pebbles instead of hard-edged shrapnel. makeChunkGeometry
      // already de-indexes; only the lathed casing still carries an index.
      if (d.geom.getIndex() !== null) {
        const flat = d.geom.toNonIndexed();
        flat.computeVertexNormals();
        d.geom.dispose();
        d.geom = flat;
      }

      const mesh = new THREE.InstancedMesh(d.geom, material, cap);
      mesh.name = `vfx.debris.${d.kind}`;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Per-instance colour so one bucket covers camouflage green wing skin,
      // bare aluminium and burnt steel without extra draw calls.
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

      const outlineMaterial = new THREE.ShaderMaterial({
        uniforms: {
          uWidth: { value: outlineWidth },
          uColor: { value: new THREE.Color(0x0b0f16) },
          uResolution: { value: new THREE.Vector2(1920, 1080) },
          uFadeStart: { value: 700 },
          uFadeEnd: { value: 3400 },
        },
        vertexShader: OUTLINE_VERT,
        fragmentShader: OUTLINE_FRAG,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: true,
      });
      outlineMaterial.name = `vfx.debris.${d.kind}.outline`;

      const outline = new THREE.InstancedMesh(d.geom, outlineMaterial, cap);
      outline.name = `vfx.debris.${d.kind}.outline`;
      outline.frustumCulled = false;
      outline.count = 0;
      outline.renderOrder = -1;
      // Share the transform buffer outright: the outline is the same instances.
      outline.instanceMatrix = mesh.instanceMatrix;

      const list: Debris[] = [];
      for (let i = 0; i < cap; i++) {
        list.push({
          active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
          q: new THREE.Quaternion(), wx: 0, wy: 0, wz: 0,
          scale: 1, age: 0, life: 1, drag: 0.15, burning: 0,
          kind: d.kind, color: new THREE.Color(1, 1, 1),
          trailTimer: 0, bounced: 0, grounded: false,
        });
      }

      this.root.add(mesh);
      this.root.add(outline);
      this.buckets.set(d.kind, {
        kind: d.kind, mesh, outline, material, outlineMaterial,
        geometry: d.geom, list, count: 0,
      });
    }
  }

  setBudgetScale(f: number): void { this.budget = f; }

  setResolution(w: number, h: number): void {
    for (const b of this.buckets.values()) b.outlineMaterial.uniforms.uResolution.value.set(w, h);
  }

  /** Hull expansion in the same units as settings.outlineWidth's baseline. */
  setOutlineWidth(w: number): void {
    for (const b of this.buckets.values()) b.outlineMaterial.uniforms.uWidth.value = w;
  }

  spawn(s: DebrisSpawn): void {
    const b = this.buckets.get(s.kind);
    if (!b) return;
    const limit = Math.max(8, Math.floor(b.list.length * this.budget));
    let slot: Debris | null = null;
    let oldest: Debris | null = null;
    for (let i = 0; i < limit; i++) {
      const d = b.list[i];
      if (!d.active) { slot = d; break; }
      if (!oldest || d.age / d.life > oldest.age / oldest.life) oldest = d;
    }
    // Pool full: steal whichever chunk is closest to expiring anyway.
    const d = slot ?? oldest;
    if (!d) return;

    d.active = true;
    d.x = s.x; d.y = s.y; d.z = s.z;
    d.vx = s.vx; d.vy = s.vy; d.vz = s.vz;
    d.scale = s.size;
    d.age = 0; d.life = s.life;
    d.drag = s.drag;
    d.burning = s.burning;
    d.trailTimer = 0;
    d.bounced = 0;
    d.grounded = false;
    d.color.setHex(s.color);
    // Random orientation and tumble axis.
    _axis.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
    d.q.setFromAxisAngle(_axis, Math.random() * Math.PI * 2);
    _axis.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
    d.wx = _axis.x * s.spin; d.wy = _axis.y * s.spin; d.wz = _axis.z * s.spin;
  }

  update(dt: number, env: DebrisEnv): void {
    const g = 9.81;
    for (const b of this.buckets.values()) {
      let n = 0;
      const mat = b.mesh.instanceMatrix.array as Float32Array;
      const colArr = b.mesh.instanceColor!.array as Float32Array;

      for (let i = 0; i < b.list.length; i++) {
        const d = b.list[i];
        if (!d.active) continue;

        d.age += dt;
        if (d.age >= d.life) { d.active = false; continue; }

        if (!d.grounded) {
          // Semi-implicit Euler with linear drag; debris is light and blunt so
          // linear drag is a perfectly good stand-in for a quadratic law at
          // these speeds, and it stays stable at any dt.
          const k = Math.exp(-d.drag * dt);
          d.vx *= k; d.vz *= k;
          d.vy = (d.vy + -g * dt) * k;
          d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;

          const spinDecay = Math.exp(-0.35 * dt);
          d.wx *= spinDecay; d.wy *= spinDecay; d.wz *= spinDecay;
          const wl = Math.hypot(d.wx, d.wy, d.wz);
          if (wl > 1e-4) {
            _axis.set(d.wx / wl, d.wy / wl, d.wz / wl);
            _qd.setFromAxisAngle(_axis, wl * dt);
            d.q.premultiply(_qd);
          }

          const gy = env.terrainHeight(d.x, d.z);
          if (d.y <= gy + d.scale * 0.35) {
            const speed = Math.hypot(d.vx, d.vy, d.vz);
            d.y = gy + d.scale * 0.35;
            if (d.bounced === 0) env.onImpact(d.x, d.y, d.z, speed, d.kind);
            d.bounced++;
            if (speed < 3.5 || d.bounced > 2) {
              d.grounded = true;
              d.vx = d.vy = d.vz = 0;
              d.wx = d.wy = d.wz = 0;
              // Once it has come to rest, let it lie for a moment and go.
              d.life = Math.min(d.life, d.age + 3.5);
            } else {
              d.vy = Math.abs(d.vy) * 0.32;
              d.vx *= 0.55; d.vz *= 0.55;
              d.wx *= 0.5; d.wy *= 0.5; d.wz *= 0.5;
            }
          }

          if (d.burning > 0) {
            d.trailTimer -= dt;
            if (d.trailTimer <= 0) {
              d.trailTimer = 0.022;
              env.onTrail(d);
            }
          }
        }

        // Fade out by shrinking: a chunk that pops out of existence reads as a
        // bug, and alpha on an opaque cel material would break the outline.
        const fade = 1 - Math.max(0, (d.age - d.life * 0.82) / (d.life * 0.18));
        _s.setScalar(d.scale * (0.35 + 0.65 * fade));
        _m.compose(_TMP_POS.set(d.x, d.y, d.z), d.q, _s);
        _m.toArray(mat, n * 16);
        colArr[n * 3] = d.color.r; colArr[n * 3 + 1] = d.color.g; colArr[n * 3 + 2] = d.color.b;
        n++;
      }

      b.count = n;
      b.mesh.count = n;
      b.outline.count = n;
      if (n > 0) {
        b.mesh.instanceMatrix.needsUpdate = true;
        b.mesh.instanceColor!.needsUpdate = true;
      }
    }
  }

  get liveCount(): number {
    let n = 0;
    for (const b of this.buckets.values()) n += b.count;
    return n;
  }

  setOutlineEnabled(on: boolean): void {
    for (const b of this.buckets.values()) b.outline.visible = on;
  }

  clear(): void {
    for (const b of this.buckets.values()) {
      for (const d of b.list) d.active = false;
      b.count = 0; b.mesh.count = 0; b.outline.count = 0;
    }
  }

  dispose(): void {
    for (const b of this.buckets.values()) {
      b.geometry.dispose();
      b.material.dispose();
      b.outlineMaterial.dispose();
      b.mesh.dispose();
      b.outline.dispose();
    }
    this.buckets.clear();
  }
}

const _TMP_POS = new THREE.Vector3();

/** A few plausible airframe colours, used when the caller has no livery. */
export const DEBRIS_COLORS = {
  aluminium: 0xb9bec4,
  scorched: 0x3a3530,
  camoGreen: 0x54603f,
  camoGrey: 0x8b9299,
  wood: 0x8a6a44,
  brass: 0xd8b562,
  dirt: 0x6b5a42,
  sand: 0xb99b6d,
} as const;
