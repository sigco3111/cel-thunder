import * as THREE from 'three';
import { createCelMaterial, addOutlinesRecursive } from '../render/CelMaterial';
import { Rng } from '../shared/math';
import { airfieldLocal, type AirfieldSite } from './heightfield';
import { MeshBuilder } from './buildUtils';
import { drawText } from './TerrainTextures';

/**
 * A working WWII forward airfield: runway with full markings, parallel
 * taxiway, dispersal hardstands, blister hangars, a control tower, bowsers,
 * tents, revetments, parked aircraft and windsocks.
 *
 * Everything paved is drawn at exactly 'site.elevation', which is the height
 * the heightfield was flattened to, so 'terrainHeight()' over the whole
 * complex returns that constant and wheels touch the painted surface with no
 * tolerance fudge. The pavement is one textured mesh; every structure is
 * merged into one vertex-coloured mesh; repeated props are instanced. An
 * airfield is 5 draw calls plus its outline pass.
 */

export interface AirfieldBuild {
  group: THREE.Group;
  /** Spawn slots on the hardstands, in world space, facing down the runway. */
  spawns: { x: number; y: number; z: number; yaw: number }[];
  /** Windsock roots, so the wind can animate them. */
  socks: THREE.Object3D[];
  dispose(): void;
}

const TAXI_OFFSET = 110;      // metres from the centreline to the taxiway
const APRON_OFFSET = 185;

/**
 * Depth bias for every surface that lies flat on flattened ground.
 *
 * -2 slope / -4 units is enough to clear a 24-bit non-linear depth buffer's
 * quantisation at any range with near=0.35, and small enough that the pavement
 * never pokes through a wheel or a sandbag standing on it. Exported so the
 * factory apron and the railyard ballast — which have exactly the same problem
 * — use exactly the same numbers.
 */
export function applyPavementOffset(mat: THREE.Material): void {
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  mat.polygonOffsetUnits = -4;
}

export function buildAirfield(site: AirfieldSite, seed: number): AirfieldBuild {
  const rng = new Rng((seed ^ (site.team * 0x9e37 + 7)) >>> 0 || 1);
  const group = new THREE.Group();
  group.name = `airfield_${site.team}`;
  group.matrixAutoUpdate = false;

  const L = site.runwayLength, W = site.runwayWidth;
  const y = site.elevation;
  const cosH = Math.cos(site.heading), sinH = Math.sin(site.heading);

  /** airfield-local (along, across) -> world XZ. */
  const wx = (a: number, b: number) => site.x + a * sinH + b * cosH;
  const wz = (a: number, b: number) => site.z + a * cosH - b * sinH;

  // -----------------------------------------------------------------------
  // Pavement — one textured mesh
  // -----------------------------------------------------------------------

  // Pavement sits a few millimetres proud of the pad so wheels contact sanely,
  // and wins the depth test through POLYGON OFFSET rather than through a
  // world-space lift. This matters more than it sounds: the pad is flattened to
  // exactly site.elevation and the pavement is a parallel plane over it, so the
  // two never fight locally — they cross the depth buffer's quantisation
  // threshold simultaneously, over the whole surface, at a distance that
  // depends only on the offset. A 6 cm lift with near=0.35/far=120000 strobes
  // the entire runway from about 400 m out, i.e. on every approach and every
  // landing. A depth-slope offset scales with distance automatically, which a
  // constant metre offset cannot.
  const PY = y + 0.005;

  const pav = new MeshBuilder();
  pav.color(0xffffff);
  /** Taxiways, links, apron and hardstands: concrete, its own texture. */
  const conc = new MeshBuilder();
  conc.color(0xffffff);

  /** UV-mapped strip in airfield-local space. v runs along, u runs across. */
  const strip = (
    b: MeshBuilder, a0: number, a1: number, b0: number, b1: number,
    u0: number, u1: number, v0: number, v1: number, yy: number,
  ) => {
    const p = (a: number, bb: number): [number, number, number] => [wx(a, bb), yy, wz(a, bb)];
    const A = p(a0, b0), B = p(a0, b1), C = p(a1, b1), D = p(a1, b0);
    const i0 = pavVert(b, A, u0, v0), i1 = pavVert(b, B, u1, v0);
    const i2 = pavVert(b, C, u1, v1), i3 = pavVert(b, D, u0, v1);
    // Reversed winding: A->B->C->D traced in airfield-local (along, across)
    // is clockwise seen from above, which back-face culling would discard.
    b.idx.push(i0, i2, i1, i0, i3, i2);
  };

  /**
   * Concrete strip with UVs in real metres. Stretching one texture over 1240 m
   * of taxiway is what made every non-runway surface read as a flat grey quad;
   * a fixed metric repeat keeps the slab joints the right size everywhere.
   */
  const CONC_REPEAT = 30;
  const cslab = (a0: number, a1: number, b0: number, b1: number) => {
    strip(conc, a0, a1, b0, b1,
      b0 / CONC_REPEAT, b1 / CONC_REPEAT, a0 / CONC_REPEAT, a1 / CONC_REPEAT, PY);
  };

  strip(pav, -L / 2, L / 2, -W / 2, W / 2, 0, 1, 0, 1, PY);

  // Grass-to-tarmac overrun at each end, sampling the unmarked rows the atlas
  // keeps just outside the marked region.
  strip(pav, -L / 2 - 24, -L / 2, -W / 2, W / 2, 0, 1, -0.018, 0, PY);
  strip(pav, L / 2, L / 2 + 24, -W / 2, W / 2, 0, 1, 1, 1.018, PY);

  const taxiW = 16;
  cslab(-L / 2 + 30, L / 2 - 30, TAXI_OFFSET - taxiW / 2, TAXI_OFFSET + taxiW / 2);
  // Two links joining runway to taxiway.
  for (const a of [-L / 2 + 90, L / 2 - 90]) {
    cslab(a - 11, a + 11, W / 2, TAXI_OFFSET - taxiW / 2);
  }
  // Apron / dispersal.
  cslab(-L * 0.30, L * 0.16, APRON_OFFSET - 55, APRON_OFFSET + 55);
  // Hardstand loops off the taxiway.
  const hardstands: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = -L * 0.36 + i * (L * 0.72 / 5);
    hardstands.push(a);
    cslab(a - 17, a + 17, TAXI_OFFSET + taxiW / 2, TAXI_OFFSET + 44);
  }

  const pavGeom = pav.build();
  const pavMat = createCelMaterial({
    name: 'airfieldRunway',
    color: 0xffffff,
    map: buildRunwayTexture(site.designator, rng),
    vertexColors: true,
    bands: 3,
    bandSoftness: 0.09,
    gloss: 0.62,
    specular: 0.16,
    specSteps: 1,
    rimStrength: 0.0,
    shadowTint: 0x59738f,
    inkInterior: false,
  });
  applyPavementOffset(pavMat);
  const pavMesh = new THREE.Mesh(pavGeom, pavMat);
  pavMesh.name = 'pavement';
  pavMesh.receiveShadow = true;
  pavMesh.castShadow = false;
  pavMesh.userData.noOutline = true;
  group.add(pavMesh);

  const concGeom = conc.build();
  const concMat = createCelMaterial({
    name: 'airfieldConcrete',
    color: 0xffffff,
    map: buildConcreteTexture(rng),
    vertexColors: true,
    bands: 3,
    bandSoftness: 0.09,
    gloss: 0.55,
    specular: 0.12,
    specSteps: 1,
    rimStrength: 0.0,
    shadowTint: 0x5b7592,
    inkInterior: false,
  });
  applyPavementOffset(concMat);
  const concMesh = new THREE.Mesh(concGeom, concMat);
  concMesh.name = 'apron';
  concMesh.receiveShadow = true;
  concMesh.castShadow = false;
  concMesh.userData.noOutline = true;
  group.add(concMesh);

  // -----------------------------------------------------------------------
  // Structures — one merged, vertex-coloured mesh
  // -----------------------------------------------------------------------

  const b = new MeshBuilder();
  const british = site.team === 0;
  const wall = british ? 0x8d8b7c : 0x8a8570;
  const roof = british ? 0x4c5148 : 0x55503f;
  const concCol = 0xa8a495;

  // -- control tower: two-storey block with a glazed cab and a railed balcony
  {
    const ta = -L * 0.05, tb = APRON_OFFSET + 78;
    const yaw = site.heading + Math.PI / 2;
    b.color(concCol);
    b.box(wx(ta, tb), y + 3.0, wz(ta, tb), 13, 6, 10, yaw);
    b.color(british ? 0x9a9787 : 0x8f8a74);
    b.box(wx(ta, tb), y + 8.2, wz(ta, tb), 11, 4.4, 8.4, yaw);
    // glazing band
    b.color(0x22333d);
    b.box(wx(ta, tb), y + 9.4, wz(ta, tb), 11.25, 2.1, 8.65, yaw);
    b.color(0x6d6a5e);
    b.box(wx(ta, tb), y + 10.6, wz(ta, tb), 12.2, 0.5, 9.4, yaw);
    // railing posts on the balcony
    b.color(0x4a4a44);
    for (let i = 0; i < 10; i++) {
      const t = (i / 9 - 0.5) * 11.4;
      b.box(wx(ta + t, tb - 4.9), y + 11.4, wz(ta + t, tb - 4.9), 0.14, 1.1, 0.14, yaw);
      b.box(wx(ta + t, tb + 4.9), y + 11.4, wz(ta + t, tb + 4.9), 0.14, 1.1, 0.14, yaw);
    }
    // mast
    b.color(0x6f6f68);
    b.cylinder(wx(ta + 5.4, tb + 3.6), y + 11.0, wz(ta + 5.4, tb + 3.6), 0.16, 0.08, 8.5, 5, false);
  }

  // -- blister hangars along the apron
  for (let i = 0; i < 3; i++) {
    const ha = -L * 0.26 + i * 62;
    const hb = APRON_OFFSET + 8;
    const yaw = site.heading;
    b.color(british ? 0x707462 : 0x6b6a55).shade(0.92 + i * 0.05);
    b.arch(wx(ha, hb), y, wz(ha, hb), 26, 34, 11, yaw, 9);
    // end walls with a door opening
    b.color(british ? 0x5f6354 : 0x5c5b4a);
    b.box(wx(ha, hb - 17.2), y + 3.2, wz(ha, hb - 17.2), 26, 6.4, 0.6, yaw);
    b.color(0x2b2b26);
    b.box(wx(ha, hb - 17.5), y + 3.6, wz(ha, hb - 17.5), 13, 7.2, 0.35, yaw);
  }

  // -- maintenance sheds + stores behind the apron
  for (let i = 0; i < 4; i++) {
    const sa = -L * 0.34 + i * 46 + rng.range(-6, 6);
    const sb = APRON_OFFSET + 100 + rng.range(-14, 14);
    b.shed(wx(sa, sb), y, wz(sa, sb), 14 + rng.range(0, 8), 9, 3.4, 2.0,
      site.heading + rng.range(-0.1, 0.1), wall, roof, 0);
  }

  // -- sandbagged blast walls flanking each hardstand
  // Both arms, laid across the hardstand rather than doubled up on one side:
  // s = -1 is the wall between the hardstand and the taxiway, s = +1 the one
  // behind it. The two splay outward with |t| so the aircraft can be pushed in.
  for (const a of hardstands) {
    const rb = TAXI_OFFSET + 30;
    for (let s = -1; s <= 1; s += 2) {
      for (let k = 0; k < 7; k++) {
        const t = (k / 6 - 0.5) * 26;
        const bb = rb + s * (16 + Math.abs(t) * 0.22);
        b.color(0x8b8064).shade(0.93 + (k % 3) * 0.05);
        b.box(wx(a + t, bb), y + 0.55, wz(a + t, bb), 3.4, 1.1, 2.0, site.heading);
        b.color(0x8b8064).shade(0.88 + (k % 2) * 0.09);
        b.box(wx(a + t, bb), y + 1.35, wz(a + t, bb), 3.0, 0.7, 1.7, site.heading + 0.12);
      }
    }
  }

  // -- fuel dump: bowsers and drum stacks
  for (let i = 0; i < 3; i++) {
    const fa = L * 0.22 + i * 13;
    const fb = APRON_OFFSET + 62;
    const yaw = site.heading + rng.range(-0.4, 0.4);
    buildBowser(b, wx(fa, fb), y, wz(fa, fb), yaw, british);
  }
  b.color(0x5d6b4e);
  for (let i = 0; i < 18; i++) {
    const da = L * 0.30 + (i % 6) * 1.4;
    const db = APRON_OFFSET + 88 + Math.floor(i / 6) * 1.4;
    b.cylinder(wx(da, db), y, wz(da, db), 0.42, 0.42, 0.92, 7, true, false);
  }

  // -- bell tents and a briefing marquee
  for (let i = 0; i < 7; i++) {
    const ta = -L * 0.40 + i * 11 + rng.range(-3, 3);
    const tb = APRON_OFFSET + 132 + rng.range(-8, 8);
    b.color(british ? 0x9b9478 : 0x8b8568);
    b.cone(wx(ta, tb), y, wz(ta, tb), 3.1, 3.6, 8, rng.range(0, 3));
    b.color(0x6e6a52);
    b.cylinder(wx(ta, tb), y, wz(ta, tb), 3.1, 3.1, 0.9, 8, false, false);
  }

  // -- perimeter fence posts (sparse — they read as texture from the air)
  b.color(0x59544a);
  for (let i = 0; i < 60; i++) {
    const t = i / 59;
    const a = -L * 0.62 + t * L * 1.24;
    b.box(wx(a, -W / 2 - 70), y + 0.8, wz(a, -W / 2 - 70), 0.16, 1.6, 0.16, site.heading);
    b.box(wx(a, APRON_OFFSET + 165), y + 0.8, wz(a, APRON_OFFSET + 165), 0.16, 1.6, 0.16, site.heading);
  }

  const structGeom = b.build();
  const structMat = createCelMaterial({
    name: 'airfieldStructures',
    color: 0xffffff,
    vertexColors: true,
    bands: 3,
    bandSoftness: 0.055,
    gloss: 0.7,
    specular: 0.22,
    specSteps: 2,
    rimStrength: 0.5,
    rimPower: 3.4,
    shadowTint: 0x55749b,
    terminatorTint: 0xffb070,
  });
  const structMesh = new THREE.Mesh(structGeom, structMat);
  structMesh.name = 'structures';
  structMesh.castShadow = true;
  structMesh.receiveShadow = true;
  group.add(structMesh);
  addOutlinesRecursive(structMesh, 0.010, 0x121a12);

  // -----------------------------------------------------------------------
  // Windsocks (animated) and parked aircraft (instanced)
  // -----------------------------------------------------------------------

  const socks: THREE.Object3D[] = [];
  const sockMat = createCelMaterial({
    name: 'windsock', color: 0xffffff, vertexColors: true, bands: 3,
    gloss: 0.9, specular: 0.1, rimStrength: 0.6, side: THREE.DoubleSide,
  });
  const sockGeom = buildWindsockCone();
  const poleB = new MeshBuilder();
  for (const [a, bb] of [[-L / 2 - 12, W / 2 + 22], [L / 2 + 12, -W / 2 - 22]] as [number, number][]) {
    poleB.color(0xb9b3a4);
    poleB.cylinder(wx(a, bb), y, wz(a, bb), 0.18, 0.13, 7.5, 6, true);
    const sock = new THREE.Mesh(sockGeom, sockMat);
    sock.position.set(wx(a, bb), y + 7.2, wz(a, bb));
    // 'YXZ', not three's default 'XYZ'. The sock geometry points along -Z and
    // is animated as (lift, windDir, 0). Under XYZ the composition is Rx.Ry:
    // the yaw happens first and the lift is then a pitch about the *world* X
    // axis, so lift only works when the wind blows along +/-Z. At windDir near
    // PI/2 — which the seed produces for half of all maps — the sock points
    // along X and the lift term just spins it about its own axis, leaving it
    // hanging dead vertical in a 13 m/s wind. YXZ yaws first and then pitches
    // about the sock's own lateral axis, which is what a mast does.
    sock.rotation.order = 'YXZ';
    sock.castShadow = false;
    group.add(sock);
    socks.push(sock);
  }
  const poleMesh = new THREE.Mesh(poleB.build(), structMat);
  poleMesh.castShadow = true;
  group.add(poleMesh);

  const parked = new THREE.InstancedMesh(buildParkedAircraft(british), structMat, 8);
  parked.name = 'parkedAircraft';
  parked.castShadow = true;
  parked.receiveShadow = true;
  let pn = 0;
  const spawns: AirfieldBuild['spawns'] = [];
  for (let i = 0; i < hardstands.length; i++) {
    const a = hardstands[i];
    const bb = TAXI_OFFSET + 26;
    const yaw = site.heading + Math.PI / 2 + (i % 2 ? 0.25 : -0.25);
    // Every other hardstand keeps a live spawn slot; the rest get scenery.
    if (i % 2 === 0) {
      spawns.push({ x: wx(a, bb), y, z: wz(a, bb), yaw });
    } else {
      _obj.position.set(wx(a, bb), y, wz(a, bb));
      _obj.rotation.set(0, yaw, 0);
      _obj.scale.setScalar(1);
      _obj.updateMatrix();
      parked.setMatrixAt(pn++, _obj.matrix);
    }
  }
  // A couple more parked on the apron.
  for (let i = 0; i < 2; i++) {
    _obj.position.set(wx(-L * 0.18 + i * 22, APRON_OFFSET - 26), y, wz(-L * 0.18 + i * 22, APRON_OFFSET - 26));
    _obj.rotation.set(0, site.heading + Math.PI, 0);
    _obj.scale.setScalar(1);
    _obj.updateMatrix();
    parked.setMatrixAt(pn++, _obj.matrix);
  }
  parked.count = pn;
  parked.instanceMatrix.needsUpdate = true;
  group.add(parked);

  // Runway-threshold spawn, used when every hardstand is taken.
  spawns.push({ x: wx(-L / 2 + 60, 0), y, z: wz(-L / 2 + 60, 0), yaw: site.heading });

  return {
    group, spawns, socks,
    dispose() {
      pavGeom.dispose(); pavMat.dispose();
      concGeom.dispose(); concMat.dispose();
      structGeom.dispose(); structMat.dispose();
      sockGeom.dispose(); sockMat.dispose();
      parked.geometry.dispose();
    },
  };
}

const _obj = new THREE.Object3D();

function pavVert(b: MeshBuilder, p: [number, number, number], u: number, v: number): number {
  const i = b.pos.length / 3;
  b.pos.push(p[0], p[1], p[2]);
  b.nrm.push(0, 1, 0);
  b.col.push(1, 1, 1);
  b.uv.push(u, v);
  return i;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

function buildBowser(b: MeshBuilder, x: number, y: number, z: number, yaw: number, british: boolean): void {
  b.color(british ? 0x4f5a45 : 0x5b5a42);
  b.box(x, y + 0.95, z, 2.3, 1.0, 5.6, yaw);          // chassis
  b.color(british ? 0x606b52 : 0x6a6850);
  b.cylinder(x, y + 1.45, z, 1.05, 1.05, 3.4, 9, true, true, yaw + Math.PI / 2);
  b.color(0x3c4238);
  b.box(x, y + 1.7, z, 2.0, 1.5, 1.6, yaw);           // cab
  b.color(0x1e2320);
  for (const [dx, dz] of [[-1.05, 1.9], [1.05, 1.9], [-1.05, -1.6], [1.05, -1.6]] as [number, number][]) {
    const px = x + dx * Math.cos(yaw) + dz * Math.sin(yaw);
    const pz = z - dx * Math.sin(yaw) + dz * Math.cos(yaw);
    b.cylinder(px, y + 0.05, pz, 0.55, 0.55, 0.34, 8, true, true, yaw + Math.PI / 2);
  }
}

/** A stylised parked fighter — silhouette only; the hero models live elsewhere. */
function buildParkedAircraft(british: boolean): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const body = british ? 0x5c6b4a : 0x6d6f5c;
  const under = british ? 0x8fa3b3 : 0x93a5b0;
  b.color(body);
  // fuselage
  b.box(0, 1.55, 0.2, 1.15, 1.35, 8.4);
  b.color(body).shade(0.9);
  b.cone(0, 1.55, 4.3, 0.62, 1.3, 8);
  // wings
  b.color(body).shade(1.05);
  b.box(0, 1.15, 0.4, 10.4, 0.30, 2.1);
  b.color(under);
  b.box(0, 1.02, 0.4, 10.0, 0.10, 1.9);
  // tail
  b.color(body).shade(0.95);
  b.box(0, 1.35, -3.9, 3.6, 0.22, 1.1);
  b.box(0, 2.2, -4.0, 0.20, 1.6, 1.3);
  // canopy
  b.color(0x2b3a44);
  b.box(0, 2.35, 0.9, 0.85, 0.62, 2.3);
  // spinner + prop disc edge-on
  b.color(0x33352e);
  b.cone(0, 1.55, 5.0, 0.34, 0.9, 7);
  // gear
  b.color(0x2a2c28);
  b.cylinder(-1.6, 0.0, 1.4, 0.42, 0.42, 0.26, 8, true, true, Math.PI / 2);
  b.cylinder(1.6, 0.0, 1.4, 0.42, 0.42, 0.26, 8, true, true, Math.PI / 2);
  b.box(-1.6, 0.6, 1.4, 0.16, 1.1, 0.16);
  b.box(1.6, 0.6, 1.4, 0.16, 1.1, 0.16);
  return b.build();
}

function buildWindsockCone(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  // Five alternating bands, open at both ends, tapering — the classic sock.
  const segs = 5;
  const len = 3.4;
  for (let i = 0; i < segs; i++) {
    b.color(i % 2 === 0 ? 0xdb5a25 : 0xf0ece2);
    const r0 = 0.55 - i * 0.075;
    const r1 = 0.55 - (i + 1) * 0.075;
    // Built along -Z so the sock trails downwind when the parent is yawed.
    const z0 = -i * (len / segs);
    const bb = new MeshBuilder();
    bb.color(i % 2 === 0 ? 0xdb5a25 : 0xf0ece2);
    bb.cylinder(0, 0, 0, r0, r1, len / segs, 9, false, false);
    const m = new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(0, 0, z0);
    b.append(bb, m);
  }
  return b.build();
}

// ---------------------------------------------------------------------------
// Runway marking texture
// ---------------------------------------------------------------------------

/**
 * Paints the runway surface: worn asphalt, centreline dashes, threshold
 * "piano key" stripes, touchdown-zone bars, edge lines and the designator
 * numbers at both ends (inverted at the far end, as they are in reality).
 *
 * The atlas is 256 (across the strip) x 1024 (along it), with a plain tarmac
 * band above v = 1.0 that the taxiways and apron sample.
 */
function buildRunwayTexture(designator: number, rng: Rng): THREE.DataTexture {
  const W = 256, H = 1024;
  const data = new Uint8Array(W * H * 4);

  const put = (x: number, yy: number, r: number, g: number, bl: number) => {
    if (x < 0 || x >= W || yy < 0 || yy >= H) return;
    const o = (yy * W + x) * 4;
    data[o] = r; data[o + 1] = g; data[o + 2] = bl; data[o + 3] = 255;
  };

  // --- base asphalt with patch repairs and rubber deposits
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const u = i / W, v = j / H;
      const n = fbm2(u * 9, v * 36, 3) * 0.5 + fbm2(u * 34, v * 130, 2) * 0.5;
      let base = 96 + n * 44;
      // Longitudinal wear strips where wheels run.
      const wear = Math.exp(-Math.pow((u - 0.5) / 0.19, 2) * 2.0);
      base -= wear * 16;
      // Patch repairs: darker rectangles.
      const patch = fbm2(u * 5 + 11, v * 14 + 3, 2);
      if (patch > 0.68) base -= 26;
      // Rubber deposits in the touchdown zones.
      const tz = Math.exp(-Math.pow((v - 0.13) / 0.045, 2)) + Math.exp(-Math.pow((v - 0.87) / 0.045, 2));
      base -= tz * 34 * (0.55 + wear);
      const g = Math.max(24, Math.min(210, base));
      put(i, j, g * 1.02, g, g * 0.96);
    }
  }

  const white = (x0: number, x1: number, y0: number, y1: number, bright = 214) => {
    for (let j = Math.round(y0); j < Math.round(y1); j++) {
      for (let i = Math.round(x0); i < Math.round(x1); i++) {
        // Paint is worn: modulate so the markings are not sterile.
        const w = fbm2(i * 0.09, j * 0.05, 2);
        if (w < 0.30) continue;
        const g = bright * (0.72 + 0.35 * w);
        put(i, j, Math.min(255, g), Math.min(255, g * 0.99), Math.min(255, g * 0.93));
      }
    }
  };

  // --- edge lines
  white(10, 16, 40, H - 40);
  white(W - 16, W - 10, 40, H - 40);

  // --- centreline dashes: 30 m stripe, 20 m gap over a 1300 m runway
  const dashPx = (30 / 1300) * H, gapPx = (20 / 1300) * H;
  for (let v = 120; v < H - 120; v += dashPx + gapPx) {
    white(W / 2 - 3, W / 2 + 3, v, v + dashPx);
  }

  // --- threshold piano keys at both ends
  for (const end of [0, 1]) {
    const y0 = end === 0 ? 26 : H - 26 - 62;
    for (let k = 0; k < 8; k++) {
      const x0 = 26 + k * 26;
      white(x0, x0 + 15, y0, y0 + 62);
    }
  }

  // --- touchdown-zone bars
  for (const end of [0, 1]) {
    for (let k = 1; k <= 3; k++) {
      const yy = end === 0 ? 110 + k * 52 : H - 110 - k * 52 - 26;
      white(W / 2 - 42, W / 2 - 26, yy, yy + 26);
      white(W / 2 + 26, W / 2 + 42, yy, yy + 26);
    }
  }

  // --- designators. The far end is the reciprocal heading, and both are
  // painted to be read on approach, so the far one is rotated 180 degrees.
  const near = String(designator).padStart(2, '0');
  const recip = String(((designator + 18 - 1) % 36) + 1).padStart(2, '0');
  const numBuf = new Uint8Array(W * H * 4);
  drawText(numBuf, W, H, near, W / 2 - 46, 320, W / 2 + 46, 430, 220, 219, 208);
  // Blit, rotating the near-end text 90 degrees so it reads along the strip.
  blitRotated(numBuf, data, W, H, 0);
  const numBuf2 = new Uint8Array(W * H * 4);
  drawText(numBuf2, W, H, recip, W / 2 - 46, 320, W / 2 + 46, 430, 220, 219, 208);
  blitRotated(numBuf2, data, W, H, 1);

  // NOTE: there is deliberately no "plain tarmac band" written here any more.
  // The taxiways used to sample rows 20..82 through wrapping, and painting that
  // band last erased 56 of the 62 rows of the near threshold's piano keys and
  // the first ~100 m of both edge lines — the runway ended up marked at one end
  // and bare at the other. The taxiways, links, apron and hardstands now carry
  // their own concrete texture (buildConcreteTexture) instead, which also gets
  // them slab joints, oil staining and tyre scrub rather than featureless grey.
  void rng;

  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  t.name = 'runway';
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/**
 * Taxiway / apron concrete, tiling over a 30 m repeat.
 *
 * "No untextured planes" was being violated by every paved surface that was not
 * the runway: 1240 m of taxiway and a 110 m apron all sampled one 62-row band
 * of featureless noise, which is the textbook programmer-art read from the air.
 * What makes concrete look like concrete from 300 m is not the aggregate — it
 * is the *layout*: bays poured to a fixed size with expansion joints between
 * them, each bay a slightly different age and therefore a slightly different
 * value, sealant tar down the joints, and staining where things stand.
 */
function buildConcreteTexture(rng: Rng): THREE.DataTexture {
  const N = 512;
  const data = new Uint8Array(N * N * 4);
  /** Bays are 7.5 m square in a 30 m repeat, so 4 x 4 to the tile. */
  const BAYS = 4;
  const bay = N / BAYS;

  const put = (x: number, yy: number, v: number, tintR = 1.0, tintG = 1.0, tintB = 1.0) => {
    const o = ((yy & (N - 1)) * N + (x & (N - 1))) * 4;
    data[o] = Math.max(0, Math.min(255, v * tintR));
    data[o + 1] = Math.max(0, Math.min(255, v * tintG));
    data[o + 2] = Math.max(0, Math.min(255, v * tintB));
    data[o + 3] = 255;
  };

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const bi = (i / bay) | 0, bj = (j / bay) | 0;
      // Each bay was poured on a different day. Kept to a few per cent: the
      // cue is that the slabs differ AT ALL, and pushing it further turns an
      // apron into a bathroom floor.
      const age = h2(bi * 13 + 7, bj * 29 + 3);
      let v = 116 + (age - 0.5) * 13;

      // Aggregate and float marks.
      v += (fbm2(i * 0.055, j * 0.055, 3) - 0.5) * 15;
      v += (fbm2(i * 0.31, j * 0.31, 2) - 0.5) * 11;

      // Expansion joints, with tar sealant. Slightly wandering so they do not
      // read as a pixel-perfect grid.
      const jitter = (n2(i * 0.02, j * 0.02) - 0.5) * 3.0;
      const du = Math.min((i % bay) + jitter, bay - (i % bay) - jitter);
      const dv = Math.min((j % bay) + jitter, bay - (j % bay) - jitter);
      const joint = Math.min(du, dv);
      if (joint < 2.2) v -= 26 * (1 - joint / 2.2);

      // Cracks radiating from a few bay corners.
      const cr = fbm2(i * 0.017 + 40, j * 0.017 + 90, 3);
      if (cr > 0.618 && cr < 0.640) v -= 16;

      let tr = 1.0, tg = 0.995, tb = 0.972;

      // Oil and fuel staining where aircraft stand. Ramped, not thresholded:
      // a hard cut on a smooth noise field draws a contour line, and a contour
      // line on an apron reads as a cartoon puddle rather than as a stain.
      const oil = fbm2(i * 0.026 + 200, j * 0.026 + 310, 4);
      const k = Math.max(0, Math.min(1, (oil - 0.52) * 2.4));
      v -= 17 * k * k;
      tr *= 1.0 + 0.02 * k; tg *= 1.0 - 0.01 * k; tb *= 1.0 - 0.07 * k;

      // Tyre scrub: rubber laid where aircraft are turned onto the hardstands.
      const arc = Math.abs(Math.sin((i + j * 0.6) * 0.021 + 1.3));
      if (arc > 0.94) v -= 11 * (arc - 0.94) * 16;

      put(i, j, v, tr, tg, tb);
    }
  }
  void rng;

  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.name = 'apronConcrete';
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/**
 * Copies non-transparent pixels of 'src' into 'dst', rotating the glyph block
 * a quarter turn so numbers read *along* the runway, and flipping it for the
 * reciprocal end.
 */
function blitRotated(src: Uint8Array, dst: Uint8Array, W: number, H: number, flip: number): void {
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const o = (j * W + i) * 4;
      if (src[o + 3] === 0) continue;
      // Source block is centred at (W/2, 375); map it to a rotated block at
      // the appropriate threshold.
      const lx = i - W / 2;
      const ly = j - 375;
      // A quarter turn is (x,y) -> (y,-x): determinant +1. The near end used to
      // map to (W/2 + ly, 190 + lx), whose determinant is -1 — a reflection
      // about the diagonal, not a rotation — while the far end got a proper
      // rotation. The two ends therefore had opposite handedness and one
      // designator was painted mirror-reversed, glyph shapes and digit order
      // both. A backwards '09' is the single most obvious tell on any
      // screenshot of an aerodrome.
      const tx = Math.round(flip ? W / 2 - ly * 0.9 : W / 2 + ly * 0.9);
      const ty = Math.round(flip ? (H - 190) + lx * 0.9 : 190 - lx * 0.9);
      if (tx < 0 || tx >= W || ty < 0 || ty >= H) continue;
      const d = (ty * W + tx) * 4;
      dst[d] = src[o]; dst[d + 1] = src[o + 1]; dst[d + 2] = src[o + 2]; dst[d + 3] = 255;
    }
  }
}

// Small local noise for the marking texture (independent of the terrain one).
function h2(x: number, y: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function n2(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = h2(xi, yi), b = h2(xi + 1, yi), c = h2(xi, yi + 1), d = h2(xi + 1, yi + 1);
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
}
function fbm2(x: number, y: number, oct: number): number {
  let s = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i++) { s += n2(x, y) * a; n += a; x *= 2.03; y *= 2.03; a *= 0.5; }
  return s / n;
}
