import * as THREE from 'three';
import { createCelMaterial, createOutlineMaterial, addOutlinesRecursive } from '../render/CelMaterial';
import { Rng } from '../shared/math';
import { COARSE_N, COARSE_STEP, MAP_HALF, SEA_LEVEL, type Heightfield } from './heightfield';
import { MeshBuilder } from './buildUtils';
import { applyPavementOffset } from './Airfield';

/**
 * Inverted-hull outline material that is correct on *rotated* instances.
 *
 * createOutlineMaterial expands along 'normalMatrix * objectNormal' but the
 * position path multiplies by instanceMatrix, so on any batch with a per-unit
 * yaw — which is every truck, flak gun, wagon and armoured car here — the hull
 * grows along an unrotated normal: thick on two sides, thin to absent on the
 * other two, and varying with each unit's heading. Rotating the normal by the
 * instance matrix first is the fix. This belongs in CelMaterial (see the report
 * to the integrator); patching the shader string here keeps the silhouettes
 * correct until it lands there.
 */
function instancedOutlineMaterial(width: number, color: number): THREE.ShaderMaterial {
  const m = createOutlineMaterial(width, color);
  m.vertexShader = m.vertexShader.replace(
    'vec3 nView = normalize( normalMatrix * objectNormal );',
    /* glsl */`
        #ifdef USE_INSTANCING
          objectNormal = mat3( instanceMatrix ) * objectNormal;
        #endif
        vec3 nView = normalize( normalMatrix * objectNormal );`,
  );
  return m;
}

/**
 * Attackable ground furniture: flak emplacements, truck convoys, a rail yard,
 * a factory complex and a river bridge.
 *
 * These are *targets*, so every one of them is registered with a world-space
 * position, a bounding radius and a hit-point pool, and each is a separate
 * child object so the damage system can hide, blacken or replace it. Geometry
 * is merged per installation (one draw call each) and repeated items —
 * trucks, wagons, gun pits — are instanced across the whole map.
 */

export type TargetKind = 'aa' | 'truck' | 'bridge' | 'factory' | 'railyard' | 'depot';

export interface GroundTarget {
  id: number;
  kind: TargetKind;
  team: number;
  x: number; y: number; z: number;
  /** Bounding radius for hit tests and for the HUD marker. */
  radius: number;
  hp: number;
  maxHp: number;
  /** Instanced group + slot, so the damage system can remove a single unit. */
  batch: string;
  slot: number;
  alive: boolean;
}

export interface GroundTargetsBuild {
  group: THREE.Group;
  targets: GroundTarget[];
  /** Removes an instance from the render batches (used on destruction). */
  kill(target: GroundTarget): void;
  dispose(): void;
}

const _obj = new THREE.Object3D();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

export function buildGroundTargets(
  hf: Heightfield, seed: number, teamCentres: { x: number; z: number }[],
): GroundTargetsBuild {
  const rng = new Rng((seed ^ 0x517cc1b7) >>> 0 || 1);
  const group = new THREE.Group();
  group.name = 'groundTargets';
  group.matrixAutoUpdate = false;

  const mat = createCelMaterial({
    name: 'groundTargets',
    color: 0xffffff,
    vertexColors: true,
    bands: 3,
    bandSoftness: 0.05,
    gloss: 0.62,
    specular: 0.28,
    specSteps: 2,
    rimStrength: 0.55,
    rimPower: 3.0,
    shadowTint: 0x50719b,
    terminatorTint: 0xffab63,
  });

  const targets: GroundTarget[] = [];
  const outlineMeshes: THREE.InstancedMesh[] = [];
  let nextId = 1;
  const batches = new Map<string, THREE.InstancedMesh>();

  const addBatch = (name: string, geom: THREE.BufferGeometry, cap: number): THREE.InstancedMesh => {
    const m = new THREE.InstancedMesh(geom, mat, cap);
    m.name = name;
    m.count = 0;
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = true;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    batches.set(name, m);
    group.add(m);
    return m;
  };

  const aaBatch = addBatch('aaGuns', buildFlakGun(), 96);
  // Sandbag rings used to be merged, in world space, into the single static
  // mesh — 22 identical 28-box rings spread over the whole map, guaranteeing
  // that mesh a bounding sphere the size of the world. They are the same
  // geometry every time, so they instance.
  const pitBatch = addBatch('gunPits', buildSandbagRing(6.2), 96);
  let pitCount = 0;
  const placePit = (x: number, y: number, z: number, yaw: number): void => {
    if (pitCount >= pitBatch.instanceMatrix.count) return;
    _obj.position.set(x, y, z);
    _obj.rotation.set(0, yaw, 0);
    _obj.scale.setScalar(1);
    _obj.updateMatrix();
    pitBatch.setMatrixAt(pitCount++, _obj.matrix);
    pitBatch.count = pitCount;
  };
  const truckBatch = addBatch('trucks', buildTruck(), 120);
  const wagonBatch = addBatch('wagons', buildWagon(), 64);
  const tankBatch = addBatch('lightArmour', buildArmouredCar(), 48);

  const place = (
    batch: THREE.InstancedMesh, name: string, kind: TargetKind, team: number,
    x: number, y: number, z: number, yaw: number, radius: number, hp: number, scale = 1,
  ): GroundTarget | null => {
    if (batch.count >= batch.instanceMatrix.count) return null;
    const slot = batch.count++;
    _obj.position.set(x, y, z);
    _obj.rotation.set(0, yaw, 0);
    _obj.scale.setScalar(scale);
    _obj.updateMatrix();
    batch.setMatrixAt(slot, _obj.matrix);
    const t: GroundTarget = {
      id: nextId++, kind, team, x, y, z, radius, hp, maxHp: hp,
      batch: name, slot, alive: true,
    };
    targets.push(t);
    return t;
  };

  // ------------------------------------------------------------------
  // Flak: rings around each airfield plus a scattered belt between them
  // ------------------------------------------------------------------
  // 'padT() >= 1.6' is the same guard the vegetation scatterer uses. Without it
  // the r = 700..1500 m annulus overlaps the 990 x 480 m flattened pad and the
  // taxiway/apron block, and because the pad is dead flat the slope test passes
  // cleanly — so an 88 flush on the tarmac at the runway threshold was not an
  // unlucky roll, it was the expected outcome for several guns per map.
  const clearOfWorks = (x: number, z: number): boolean =>
    hf.padT(x, z) >= 1.6 && hf.siteT(x, z) >= 1.25;

  for (let team = 0; team < teamCentres.length; team++) {
    const c = teamCentres[team];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + rng.range(-0.2, 0.2);
      const r = rng.range(700, 1500);
      const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
      if (hf.heightAt(x, z) < SEA_LEVEL + 3 || hf.slopeAt(x, z) > 0.30) continue;
      if (!clearOfWorks(x, z)) continue;
      const y = hf.heightAt(x, z);
      const g = place(aaBatch, 'aaGuns', 'aa', team, x, y, z, a + Math.PI, 7, 260);
      if (g) placePit(x, y, z, a + rng.range(-0.4, 0.4));
    }
  }
  // Contested belt down the middle of the map.
  const mid = {
    x: (teamCentres[0].x + teamCentres[1].x) * 0.5,
    z: (teamCentres[0].z + teamCentres[1].z) * 0.5,
  };
  for (let i = 0; i < 14; i++) {
    const x = mid.x + rng.range(-9000, 9000);
    const z = mid.z + rng.range(-9000, 9000);
    if (hf.heightAt(x, z) < SEA_LEVEL + 4 || hf.slopeAt(x, z) > 0.28) continue;
    if (!clearOfWorks(x, z)) continue;
    const y = hf.heightAt(x, z);
    const g = place(aaBatch, 'aaGuns', 'aa', 2, x, y, z, rng.range(0, 6.28), 7, 220);
    if (g) placePit(x, y, z, rng.range(0, 6.28));
  }

  // ------------------------------------------------------------------
  // Truck convoy on the road between the two fields
  // ------------------------------------------------------------------
  // The curve here is the *same* one the terrain shader paints (see
  // 'roadDistance' in terrainMaterial.ts), so the column drives on the road
  // surface rather than through standing wheat. The lateral scatter is a lane
  // width, not 60 m, and the heading follows the tangent of the wander rather
  // than the straight chord — a convoy pointing 12 degrees off its own road is
  // as obvious from 1000 m as no road at all.
  {
    const ax = teamCentres[0].x, az = teamCentres[0].z;
    const bx = teamCentres[1].x, bz = teamCentres[1].z;
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len, nz = dx / len;
    const roadOff = (t: number) => Math.sin(t * 9.1) * 420 + Math.sin(t * 3.3) * 900;
    let placed = 0;
    for (let i = 0; i < 90 && placed < 26; i++) {
      const t = 0.22 + (i / 90) * 0.56;
      const off = roadOff(t);
      // Tangent of the wandered curve, in world units per unit t.
      const dOff = (roadOff(t + 1e-3) - roadOff(t - 1e-3)) / 2e-3;
      const tanX = dx + nx * dOff, tanZ = dz + nz * dOff;
      const lane = rng.range(-3.0, 3.0);
      const x = ax + dx * t + nx * (off + lane);
      const z = az + dz * t + nz * (off + lane);
      const y = hf.heightAt(x, z);
      if (y < SEA_LEVEL + 4 || hf.slopeAt(x, z) > 0.22) continue;
      if (!clearOfWorks(x, z)) continue;
      const yaw = Math.atan2(tanX, tanZ) + rng.range(-0.05, 0.05);
      place(truckBatch, 'trucks', 'truck', 2, x, y, z, yaw, 4.5, 90);
      placed++;
      if (placed % 5 === 0) {
        // Armour pulled off onto the verge, not driving abreast in the field.
        const ox = x + nx * 8.5, oz = z + nz * 8.5;
        place(tankBatch, 'lightArmour', 'truck', 2, ox, hf.heightAt(ox, oz), oz, yaw, 4.0, 150);
      }
    }
  }

  // ------------------------------------------------------------------
  // Factory complex — sited on flat ground near a river
  // ------------------------------------------------------------------
  //
  // Each installation gets its OWN merged mesh. Merging the factory, the rail
  // yard, the bridge and 22 sandbag rings scattered over 65 km into a single
  // BufferGeometry gave it a map-spanning bounding sphere, so frustumCulled was
  // true but never once culled anything: every frame submitted the whole
  // installation set twice (the inverted-hull outline shares the bounds) and
  // drew all of it into every shadow cascade. Five extra draw calls against a
  // 1200 budget buys tight bounds for each.
  const staticParts: { name: string; b: MeshBuilder }[] = [];
  /** Everything that lies flat on graded ground — needs the depth bias. */
  const slabB = new MeshBuilder();

  const facB = new MeshBuilder();
  {
    const site = findFlatSite(hf, rng, mid.x, mid.z, 12000, 60, 500, 0.10);
    if (site) {
      // Grade the ground to the footprint the geometry actually occupies
      // (the apron is 190 x 130 m and the perimeter wall reaches 95 m), so the
      // slab corners are neither buried nor cantilevered into the air.
      const y = hf.flattenSite(site.x, site.z, 108, 78, site.yaw);
      buildFactory(facB, slabB, site.x, y, site.z, site.yaw, rng);
      staticParts.push({ name: 'factory', b: facB });
      targets.push({
        id: nextId++, kind: 'factory', team: 2,
        x: site.x, y, z: site.z, radius: 95, hp: 2400, maxHp: 2400,
        batch: 'static', slot: -1, alive: true,
      });
    }
  }

  // ------------------------------------------------------------------
  // Rail yard
  // ------------------------------------------------------------------
  {
    const site = findFlatSite(hf, rng, mid.x + rng.range(-8000, 8000), mid.z + rng.range(-8000, 8000),
      11000, 30, 420, 0.07);
    if (site) {
      // 218 m of rail cannot follow a hillside: grade the whole yard.
      const y = hf.flattenSite(site.x, site.z, 118, 42, site.yaw);
      const yardB = new MeshBuilder();
      buildRailYard(yardB, slabB, site.x, y, site.z, site.yaw);
      staticParts.push({ name: 'railyard', b: yardB });
      // Rolling stock as instanced wagons on the sidings.
      const c = Math.cos(site.yaw), s = Math.sin(site.yaw);
      for (let track = -1; track <= 1; track++) {
        for (let k = 0; k < 7; k++) {
          const a = -70 + k * 21 + track * 6;
          const bcoord = track * 9;
          const x = site.x + a * s + bcoord * c;
          const z = site.z + a * c - bcoord * s;
          place(wagonBatch, 'wagons', 'railyard', 2, x, y, z, site.yaw, 6, 140);
        }
      }
      targets.push({
        id: nextId++, kind: 'railyard', team: 2,
        x: site.x, y, z: site.z, radius: 110, hp: 1500, maxHp: 1500,
        batch: 'static', slot: -1, alive: true,
      });
    }
  }

  // ------------------------------------------------------------------
  // Bridge — spans the trunk river where it is widest and lowest
  // ------------------------------------------------------------------
  {
    const span = findRiverCrossing(hf, rng);
    if (span) {
      const bridgeB = new MeshBuilder();
      buildBridge(bridgeB, span);
      staticParts.push({ name: 'bridge', b: bridgeB });
      targets.push({
        id: nextId++, kind: 'bridge', team: 2,
        x: span.cx, y: span.deck, z: span.cz, radius: span.half + 12,
        hp: 1800, maxHp: 1800, batch: 'static', slot: -1, alive: true,
      });
    }
  }

  const staticMeshes: THREE.Mesh[] = [];
  for (const part of staticParts) {
    if (part.b.idx.length === 0) continue;
    const geom = part.b.build();
    const m = new THREE.Mesh(geom, mat);
    m.name = `target_${part.name}`;
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = true;
    group.add(m);
    addOutlinesRecursive(m, 0.010, 0x14140f);
    staticMeshes.push(m);
  }

  // Aprons and ballast beds: the same z-fighting problem as the runway, and the
  // same fix — a few millimetres of lift plus a depth-slope bias, not 6 cm of
  // parallel plane that strobes the whole surface at once from 400 m out.
  let slabMesh: THREE.Mesh | null = null;
  const slabMat = createCelMaterial({
    name: 'targetSlabs',
    color: 0xffffff,
    vertexColors: true,
    bands: 3,
    bandSoftness: 0.06,
    gloss: 0.55,
    specular: 0.12,
    rimStrength: 0.0,
    shadowTint: 0x5b7592,
    inkInterior: false,
  });
  applyPavementOffset(slabMat);
  if (slabB.idx.length > 0) {
    slabMesh = new THREE.Mesh(slabB.build(), slabMat);
    slabMesh.name = 'targetSlabs';
    slabMesh.castShadow = false;
    slabMesh.receiveShadow = true;
    slabMesh.userData.noOutline = true;
    group.add(slabMesh);
    staticMeshes.push(slabMesh);
  }

  // Inverted-hull outlines for the instanced batches. addOutline() parents a
  // plain Mesh to its target, which for an InstancedMesh would draw ONE hull
  // at the origin instead of one per instance — so build a sibling
  // InstancedMesh that shares the same instanceMatrix attribute instead. One
  // extra draw call per batch, correct silhouettes on every unit.
  for (const b of batches.values()) {
    const ol = new THREE.InstancedMesh(
      b.geometry, instancedOutlineMaterial(0.013, 0x14140f), b.instanceMatrix.count);
    ol.name = `${b.name}__outline`;
    ol.instanceMatrix = b.instanceMatrix;
    ol.count = b.count;
    ol.frustumCulled = b.frustumCulled;
    ol.castShadow = false;
    ol.receiveShadow = false;
    ol.renderOrder = -1;
    outlineMeshes.push(ol);
    group.add(ol);
  }

  return {
    group,
    targets,
    kill(t: GroundTarget) {
      if (!t.alive) return;
      t.alive = false;
      const b = batches.get(t.batch);
      if (b && t.slot >= 0) {
        b.setMatrixAt(t.slot, _zero);
        b.instanceMatrix.needsUpdate = true;
      }
    },
    dispose() {
      for (const m of staticMeshes) m.geometry.dispose();
      for (const b of batches.values()) b.geometry.dispose();
      for (const o of outlineMeshes) (o.material as THREE.Material).dispose();
      slabMat.dispose();
      mat.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Siting helpers
// ---------------------------------------------------------------------------

function findFlatSite(
  hf: Heightfield, rng: Rng, cx: number, cz: number, searchR: number,
  minH: number, maxH: number, maxSlope: number,
): { x: number; y: number; z: number; yaw: number } | null {
  for (let i = 0; i < 400; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.next()) * searchR;
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    const y = hf.heightAt(x, z);
    if (y < minH || y > maxH) continue;
    let ok = true;
    for (let k = 0; k < 8 && ok; k++) {
      const ka = (k / 8) * Math.PI * 2;
      const px = x + Math.cos(ka) * 90, pz = z + Math.sin(ka) * 90;
      if (Math.abs(hf.heightAt(px, pz) - y) > 9 || hf.slopeAt(px, pz) > maxSlope) ok = false;
    }
    if (ok) return { x, y, z, yaw: rng.range(0, Math.PI * 2) };
  }
  return null;
}

interface RiverSpan {
  cx: number; cz: number;
  /** Direction across the river (unit). */
  dx: number; dz: number;
  half: number;
  deck: number;
}

/**
 * Finds a place to put the bridge: walks the drainage map for a strong reach,
 * then measures the width of the low ground perpendicular to the flow.
 */
function findRiverCrossing(hf: Heightfield, _rng: Rng): RiverSpan | null {
  let best: RiverSpan | null = null;
  let bestScore = -Infinity;

  // Scan the drainage grid directly rather than sampling at random: the
  // flooded reach is one or two 128 m cells wide out of a 65 km map, and a
  // Monte-Carlo search finds it about once in three attempts.
  for (let j = 2; j < COARSE_N - 2; j++) {
    for (let i = 2; i < COARSE_N - 2; i++) {
      const fl = hf.flow[j * COARSE_N + i];
      if (fl < 0.44) continue;
      const x = -MAP_HALF + i * COARSE_STEP;
      const z = -MAP_HALF + j * COARSE_STEP;
      // The channel must be flooded here, else the bridge spans a dry gully.
      if (hf.heightAt(x, z) > SEA_LEVEL - 1.0) continue;

      // Channel direction from the flow gradient; cross it perpendicular.
      const e = 128;
      const gx = hf.sampleFlow(x + e, z) - hf.sampleFlow(x - e, z);
      const gz = hf.sampleFlow(x, z + e) - hf.sampleFlow(x, z - e);
      let dx = gx, dz = gz;
      const l = Math.hypot(dx, dz);
      if (l < 1e-6) continue;
      dx /= l; dz /= l;

      // Walk out to dry land on both banks.
      let half = 0, ok = false;
      for (let sdist = 12; sdist <= 260; sdist += 12) {
        const h1 = hf.heightAt(x + dx * sdist, z + dz * sdist);
        const h2 = hf.heightAt(x - dx * sdist, z - dz * sdist);
        half = sdist;
        if (h1 > SEA_LEVEL + 2.5 && h2 > SEA_LEVEL + 2.5) { ok = true; break; }
      }
      if (!ok || half < 30) continue;

      // Favour a strong river at a narrow point — that is where engineers put
      // bridges, and it is where a bomb run has to be precise.
      const score = fl * 3 - half / 90;
      if (score > bestScore) {
        bestScore = score;
        best = { cx: x, cz: z, dx, dz, half: half + 22, deck: SEA_LEVEL + 10.5 };
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** 88 mm-style flak piece on a cruciform mount. */
function buildFlakGun(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.color(0x5b5c4a);
  // cruciform base
  b.box(0, 0.22, 0, 6.4, 0.30, 1.1);
  b.box(0, 0.22, 0, 1.1, 0.30, 6.4);
  b.color(0x63644f);
  b.box(0, 0.75, 0, 2.0, 0.9, 2.0);
  // turntable + shield
  b.color(0x6a6b55);
  b.cylinder(0, 1.2, 0, 1.05, 0.95, 0.7, 9, true);
  b.color(0x565844);
  b.box(0, 1.95, 0.95, 2.9, 1.5, 0.16, 0);
  // barrel, elevated
  b.color(0x3f4136);
  const bb = new MeshBuilder();
  bb.color(0x3f4136);
  bb.cylinder(0, 0, 0, 0.20, 0.15, 6.2, 8, true);
  bb.color(0x4a4c3f);
  bb.cylinder(0, -0.5, 0, 0.34, 0.34, 1.4, 8, true, true);
  const m = new THREE.Matrix4().makeRotationX(-0.62).setPosition(0, 1.85, -0.2);
  b.append(bb, m);
  // crew step
  b.color(0x4d4f3f);
  b.box(-1.5, 0.5, -1.5, 1.2, 0.2, 1.2);
  return b.build();
}

/** Sandbag emplacement ring, built at the origin so it can be instanced. */
function buildSandbagRing(r: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const n = 16;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    // Leave a gap for the crew entrance.
    if (i === 4 || i === 5) continue;
    const px = Math.cos(a) * r, pz = Math.sin(a) * r;
    b.color(0x8f8464).shade(0.92 + (i % 3) * 0.06);
    b.box(px, 0.45, pz, 2.6, 0.9, 1.2, -a);
    b.color(0x8f8464).shade(0.88 + (i % 2) * 0.10);
    b.box(px, 1.2, pz, 2.3, 0.6, 1.0, -a + 0.15);
  }
  return b.build();
}

/** Opel-Blitz-ish 3-tonner with a canvas tilt. */
function buildTruck(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.color(0x4e5540);
  b.box(0, 0.95, 0, 2.3, 0.7, 6.2);           // chassis / bed
  b.color(0x565f45);
  b.box(0, 1.75, 1.9, 2.15, 1.7, 1.9);        // cab
  b.color(0x22282a);
  b.box(0, 2.05, 2.85, 1.85, 0.75, 0.12);     // windscreen
  b.color(0x7e7a5f);
  b.box(0, 2.05, -1.0, 2.35, 1.6, 4.0);       // tilt
  b.color(0x6d6a52);
  b.box(0, 2.9, -1.0, 2.15, 0.4, 4.1);        // tilt ridge
  b.color(0x1d211d);
  for (const [dx, dz] of [[-1.05, 2.1], [1.05, 2.1], [-1.05, -1.5], [1.05, -1.5]] as [number, number][]) {
    b.cylinder(dx, 0.05, dz, 0.55, 0.55, 0.30, 8, true, true, Math.PI / 2);
  }
  b.color(0x3d4237);
  b.box(0, 1.5, 3.15, 2.0, 0.35, 0.3);        // bumper
  return b.build();
}

function buildArmouredCar(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.color(0x565b45);
  b.box(0, 1.0, 0, 2.5, 0.9, 5.4);
  b.color(0x5e6349);
  b.box(0, 1.7, -0.3, 2.2, 0.6, 3.2);
  b.color(0x4f543f);
  b.cylinder(0, 2.0, -0.5, 0.95, 0.85, 0.8, 8, true);
  b.color(0x3a3e32);
  const bb = new MeshBuilder();
  bb.color(0x3a3e32);
  bb.cylinder(0, 0, 0, 0.12, 0.10, 2.6, 7, true);
  b.append(bb, new THREE.Matrix4().makeRotationX(-0.10).setPosition(0, 2.3, -1.0));
  b.color(0x1d211d);
  for (const [dx, dz] of [[-1.2, 1.7], [1.2, 1.7], [-1.2, -1.5], [1.2, -1.5]] as [number, number][]) {
    b.cylinder(dx, 0.05, dz, 0.62, 0.62, 0.34, 8, true, true, Math.PI / 2);
  }
  return b.build();
}

function buildWagon(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.color(0x5a4436);
  b.box(0, 1.55, 0, 3.0, 2.3, 9.0);
  b.color(0x4a382c);
  b.box(0, 2.85, 0, 3.15, 0.35, 9.2);
  b.color(0x2e2a26);
  b.box(0, 0.55, 0, 2.6, 0.5, 9.4);
  for (const dz of [-3.2, 3.2]) {
    b.color(0x24211d);
    b.cylinder(-1.15, 0.05, dz, 0.5, 0.5, 0.22, 8, true, true, Math.PI / 2);
    b.cylinder(1.15, 0.05, dz, 0.5, 0.5, 0.22, 8, true, true, Math.PI / 2);
  }
  return b.build();
}

function buildFactory(
  b: MeshBuilder, slab: MeshBuilder, x: number, y: number, z: number, yaw: number, rng: Rng,
): void {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const P = (a: number, bb: number): [number, number] => [x + a * s + bb * c, z + a * c - bb * s];

  // Concrete apron. Millimetres above the graded platform, on polygon offset.
  slab.color(0x8e8b80);
  slab.slab(x, y + 0.006, z, 190, 130, yaw);

  // Three production halls. Big, simple, gabled — a factory has to read as a
  // silhouette from 1500 m, and a silhouette is what a shed gives you.
  for (let i = 0; i < 3; i++) {
    const [px, pz] = P(-52 + i * 46, -22);
    b.shed(px, y, pz, 36, 72, 13, 6.5, yaw, i === 1 ? 0x8b8578 : 0x817c6f, 0x4e4b42, 1);
    // Roof-light strip along the ridge.
    b.color(0x3a5560);
    b.box(px, y + 18.6, pz, 5.0, 0.7, 66, yaw);
  }

  // Office / boiler block
  {
    const [px, pz] = P(64, -46);
    b.shed(px, y, pz, 22, 16, 8, 3.2, yaw, 0x9a8f7c, 0x584f44, 0);
  }

  // Chimneys
  for (let i = 0; i < 2; i++) {
    const [px, pz] = P(62, -6 + i * 26);
    b.color(0x7d5f4c);
    b.cylinder(px, y, pz, 3.4, 2.2, 34 + rng.range(0, 9), 10, false);
    b.color(0x4c3a2d);
    b.cylinder(px, y + 33, pz, 2.5, 2.4, 2.2, 10, true);
  }

  // Storage tanks
  for (let i = 0; i < 4; i++) {
    const [px, pz] = P(52 - i * 16, 44);
    b.color(0x8a8f86);
    b.cylinder(px, y, pz, 6.2, 6.2, 9.0, 12, true, false);
    b.color(0x6f746c);
    b.cylinder(px, y + 9.0, pz, 6.2, 4.6, 1.8, 12, true);
  }

  // Rail spur into the yard side of the plant
  b.color(0x4b3f31);
  for (let k = 0; k < 30; k++) {
    const [px, pz] = P(-92 + k * 3.0, 20);
    b.box(px, y + 0.18, pz, 0.5, 0.24, 2.7, yaw);
  }

  // Perimeter wall
  b.color(0x8b8778);
  for (let i = 0; i < 40; i++) {
    const t = i / 39;
    const [ax, az] = P(-95 + t * 190, -65);
    const [bx2, bz2] = P(-95 + t * 190, 65);
    b.box(ax, y + 1.4, az, 5.2, 2.8, 0.5, yaw);
    b.box(bx2, y + 1.4, bz2, 5.2, 2.8, 0.5, yaw);
  }
}

function buildRailYard(
  b: MeshBuilder, slab: MeshBuilder, x: number, y: number, z: number, yaw: number,
): void {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const P = (a: number, bb: number): [number, number] => [x + a * s + bb * c, z + a * c - bb * s];

  // Ballast bed. Same treatment as the factory apron and the runway.
  slab.color(0x6e6a60);
  slab.slab(x, y + 0.006, z, 44, 220, yaw);

  // Four tracks: sleepers + rails
  for (let track = -1; track <= 2; track++) {
    const off = track * 9;
    b.color(0x4b3f31);
    for (let k = 0; k < 74; k++) {
      const [px, pz] = P(-108 + k * 3.0, off);
      b.box(px, y + 0.16, pz, 0.5, 0.22, 2.7, yaw);
    }
    b.color(0x7c7468);
    for (const rail of [-0.72, 0.72]) {
      const [ax, az] = P(0, off + rail);
      b.box(ax, y + 0.36, az, 218, 0.16, 0.14, yaw + Math.PI / 2);
    }
  }

  // Engine shed, water tower and coaling stage
  const [sx, sz] = P(-70, 30);
  b.shed(sx, y, sz, 26, 44, 8, 4, yaw, 0x7b6a58, 0x4f4a41, 1);
  const [wx2, wz2] = P(58, 26);
  b.color(0x5f5548);
  for (const [dx, dz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]] as [number, number][]) {
    b.box(wx2 + dx, y + 5.0, wz2 + dz, 0.5, 10, 0.5, yaw);
  }
  b.color(0x77685a);
  b.cylinder(wx2, y + 10, wz2, 4.6, 4.6, 5.4, 12, true, true);
  b.color(0x4a4238);
  b.cylinder(wx2, y + 15.4, wz2, 4.9, 3.0, 1.6, 12, true);
}

function buildBridge(b: MeshBuilder, span: RiverSpan): void {
  const { cx, cz, dx, dz, half, deck } = span;
  const yaw = Math.atan2(dx, dz);
  const len = half * 2;
  // Deck
  b.color(0x76736a);
  b.box(cx, deck, cz, 9.5, 1.1, len, yaw);
  b.color(0x5f5c55);
  b.box(cx, deck + 0.62, cz, 10.4, 0.25, len, yaw);

  // Piers every ~34 m
  const piers = Math.max(2, Math.round(len / 34));
  for (let i = 1; i < piers; i++) {
    const t = (i / piers - 0.5) * len;
    const px = cx + dx * t, pz = cz + dz * t;
    b.color(0x8a8578);
    b.box(px, deck * 0.5 - 1, pz, 3.2, deck + 2, 7.0, yaw);
    b.color(0x777264);
    b.box(px, deck - 1.1, pz, 4.6, 1.2, 8.4, yaw);
  }

  // Truss girders down both sides — the shape that makes a bridge read as a
  // bridge from 1 km up.
  for (const side of [-1, 1]) {
    const ox = -dz * side * 4.9, oz = dx * side * 4.9;
    b.color(0x60655c);
    b.box(cx + ox, deck + 3.6, cz + oz, 0.5, 0.55, len, yaw);
    const bays = Math.max(6, Math.round(len / 9));
    for (let i = 0; i <= bays; i++) {
      const t = (i / bays - 0.5) * len;
      const px = cx + dx * t + ox, pz = cz + dz * t + oz;
      b.box(px, deck + 2.0, pz, 0.42, 3.6, 0.42, yaw);
      if (i < bays) {
        // diagonal
        const t2 = ((i + 1) / bays - 0.5) * len;
        const qx = cx + dx * t2 + ox, qz = cz + dz * t2 + oz;
        const mx = (px + qx) * 0.5, mz = (pz + qz) * 0.5;
        const seg = Math.hypot(qx - px, qz - pz);
        const ang = Math.atan2(3.6, seg);
        const bb = new MeshBuilder();
        bb.color(0x60655c);
        bb.box(0, 0, 0, 0.3, 0.3, Math.hypot(seg, 3.6));
        const m = new THREE.Matrix4()
          .makeRotationX(ang)
          .premultiply(new THREE.Matrix4().makeRotationY(yaw))
          .setPosition(mx, deck + 2.0, mz);
        b.append(bb, m);
      }
    }
  }

  // Approach embankments
  for (const side of [-1, 1]) {
    const t = side * (half + 14);
    const px = cx + dx * t, pz = cz + dz * t;
    b.color(0x6c6553);
    b.box(px, deck * 0.5, pz, 11, deck, 30, yaw);
  }
}
