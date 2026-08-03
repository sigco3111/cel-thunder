import * as THREE from 'three';
import { createCelMaterial } from '../../render/CelMaterial';
import { EntityKind, type EntityState } from '../../shared/protocol';

/**
 * The stores themselves, once they have left the aeroplane.
 *
 * A falling bomb is one of the few things in an air-combat game the player
 * follows with their eyes for several seconds, so it has to be a real object
 * rather than a particle: it weathercocks into the airflow, it recedes, and it
 * has to still be findable against the ground at two thousand metres. Both
 * bodies are instanced — one draw call for every bomb in the sky and one for
 * every rocket — and their size comes off the entity's own type field, which
 * carries the store's calibre in twentieths of a metre.
 *
 * Rocket motors are not modelled here. The burn fraction is published on the
 * entity's 'throttle' channel and 'EntitySystem' spends it on the shared fire
 * and smoke fields, so a salvo costs no extra draw calls at all.
 */

const MAX_STORES = 32;

const _obj = new THREE.Object3D();
const _q = new THREE.Quaternion();

export class OrdnanceField {
  readonly group = new THREE.Group();

  private bombs: THREE.InstancedMesh;
  private rockets: THREE.InstancedMesh;
  private geoms: THREE.BufferGeometry[] = [];
  private mat: THREE.Material;

  constructor() {
    this.group.name = 'ordnance';
    this.mat = createCelMaterial({
      name: 'ordnance',
      // Olive drab, the colour almost every GP bomb and rocket of the period
      // was actually painted, with a yellow filler band the texture-free path
      // cannot show — so the value is picked to read against both sky and field.
      color: 0x565a3e,
      bands: 3, bandSoftness: 0.05,
      gloss: 0.55, specular: 0.30, specSteps: 2,
      rimStrength: 0.6, rimPower: 3.0,
      shadowTint: 0x9fb0c8, terminatorTint: 0xffab63,
    });

    // Slenderness ratios: about 5 calibres for a GP bomb, 12 for a rocket.
    const bombGeo = storeGeometry(5.0, 4);
    const rocketGeo = storeGeometry(12.0, 4);
    this.geoms.push(bombGeo, rocketGeo);

    this.bombs = this.makeBatch(bombGeo, 'bombs');
    this.rockets = this.makeBatch(rocketGeo, 'rockets');
  }

  private makeBatch(geo: THREE.BufferGeometry, name: string): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(geo, this.mat, MAX_STORES);
    m.name = name;
    m.count = 0;
    m.castShadow = true;
    m.receiveShadow = false;
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(m);
    return m;
  }

  /**
   * Rebuilds both batches from the replicated table.
   *
   * 'emit' is called once per burning rocket with the nozzle position and the
   * exhaust direction, so the caller can spend its own particle budget on the
   * motor plume without this class owning a second particle system.
   */
  collect(
    entities: ReadonlyMap<number, EntityState>,
    emit: (x: number, y: number, z: number, dx: number, dy: number, dz: number, burn: number) => void,
  ): void {
    let nb = 0;
    let nr = 0;
    for (const e of entities.values()) {
      const rocket = e.kind === EntityKind.Rocket;
      if (!rocket && e.kind !== EntityKind.Bomb) continue;
      const batch = rocket ? this.rockets : this.bombs;
      const i = rocket ? nr : nb;
      if (i >= MAX_STORES) continue;

      // typeId carries the body diameter in twentieths of a metre — the widest
      // channel the 4-bit wire field allows and enough to tell a 5 in rocket
      // from a 500 lb bomb at a glance.
      const d = Math.max(1, e.typeId) / 20;
      _q.set(e.qx, e.qy, e.qz, e.qw);
      _obj.position.set(e.px, e.py, e.pz);
      _obj.quaternion.copy(_q);
      _obj.scale.set(d, d, d);
      _obj.updateMatrix();
      batch.setMatrixAt(i, _obj.matrix);

      if (rocket) {
        nr++;
        if (e.throttle > 0.01) {
          // Nozzle is half a body length aft along the store's own axis.
          const len = d * 12 * 0.5;
          const fx = 2 * (e.qx * e.qz + e.qw * e.qy);
          const fy = 2 * (e.qy * e.qz - e.qw * e.qx);
          const fz = 1 - 2 * (e.qx * e.qx + e.qy * e.qy);
          emit(e.px - fx * len, e.py - fy * len, e.pz - fz * len, -fx, -fy, -fz, e.throttle);
        }
      } else {
        nb++;
      }
    }

    this.bombs.count = nb;
    this.rockets.count = nr;
    if (nb) this.bombs.instanceMatrix.needsUpdate = true;
    if (nr) this.rockets.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const g of this.geoms) g.dispose();
    this.geoms.length = 0;
    this.mat.dispose();
    this.bombs.dispose();
    this.rockets.dispose();
    this.group.parent?.remove(this.group);
  }
}

/**
 * A generic finned store of unit diameter lying along +Z, nose forward.
 *
 * 'slender' is the body length as a multiple of the diameter — about 5 for a
 * GP bomb, 12 for an aircraft rocket — and it is baked into the geometry
 * rather than applied as a non-uniform instance scale, because a skewed scale
 * skews the normals with it and cel shading is far less forgiving of that than
 * a smooth ramp would be.
 */
function storeGeometry(slender: number, fins: number): THREE.BufferGeometry {
  const R = 0.5;
  const L = slender * 0.5;
  const seg = 10;

  // (radius, z) profile: ogival nose, parallel mid-body, tail taper.
  const prof: [number, number][] = [
    [0, L],
    [R * 0.62, L - slender * 0.10],
    [R, L - slender * 0.24],
    [R, -L + slender * 0.26],
    [R * 0.56, -L],
    [0, -L],
  ];

  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];

  for (let i = 0; i < prof.length; i++) {
    const [r, z] = prof[i];
    // Slope of the profile gives the surface normal in the (radial, z) plane.
    const p = prof[Math.max(0, i - 1)];
    const n = prof[Math.min(prof.length - 1, i + 1)];
    const dr = n[0] - p[0];
    const dz = n[1] - p[1];
    const inv = 1 / (Math.hypot(dr, dz) || 1);
    const nr = -dz * inv;
    const nz = dr * inv;
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      pos.push(c * r, s * r, z);
      nrm.push(c * nr, s * nr, nz);
    }
  }
  const ring = seg + 1;
  for (let i = 0; i < prof.length - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * ring + j, b = a + 1, cc = a + ring, dd = cc + 1;
      idx.push(a, cc, b, b, cc, dd);
    }
  }

  // Tail fins, as flat double-sided blades.
  const finH = R * 1.5;
  const z0 = -L;
  const z1 = -L + slender * 0.16;
  for (let f = 0; f < fins; f++) {
    const a = (f / fins) * Math.PI * 2 + Math.PI / 4;
    const c = Math.cos(a), s = Math.sin(a);
    const base = pos.length / 3;
    // Four corners: root/tip × fore/aft.
    const corners: [number, number, number][] = [
      [c * R * 0.5, s * R * 0.5, z0],
      [c * finH, s * finH, z0],
      [c * finH, s * finH, z1],
      [c * R * 0.5, s * R * 0.5, z1],
    ];
    for (const [x, y, z] of corners) {
      pos.push(x, y, z);
      nrm.push(-s, c, 0);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    // Back face, so a fin edge-on never disappears.
    const back = pos.length / 3;
    for (const [x, y, z] of corners) {
      pos.push(x, y, z);
      nrm.push(s, -c, 0);
    }
    idx.push(back, back + 2, back + 1, back, back + 3, back + 2);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  // A flat UV set: the material is untextured, but three's shader chunks and
  // the cel material's roughness path both expect the attribute to exist.
  const uv: number[] = [];
  for (let i = 0; i < pos.length / 3; i++) uv.push(0.5, 0.5);
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}
