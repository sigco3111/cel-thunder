import * as THREE from 'three';
import type { GameContext } from '../engine/context';
import {
  BAKE_N, LEAF_SIZE, LOD_LEVELS, MAP_HALF, MAP_SIZE, MASK_N, type Heightfield,
} from './heightfield';
import { createTerrainMaterial, type TerrainMaterial } from './terrainMaterial';
import { createTerrainPrepassMaterial, type PrepassMaterial } from './prepassMaterial';
import type { WorldTextures } from './TerrainTextures';

/**
 * CDLOD terrain renderer.
 *
 * The whole 65 km x 65 km surface is drawn in ONE draw call. A quadtree over
 * the map is walked on the CPU each frame; every selected node becomes an
 * instance of a single unit grid mesh, carrying (origin, size, morph band) in
 * per-instance attributes. The vertex shader displaces that grid from the
 * baked height texture and geomorphs it toward its parent level, which is what
 * removes both cracks and popping — see terrainMaterial.ts.
 *
 * Selection rule (classic CDLOD): starting at the root, a node is rendered at
 * its own level if the camera is farther from its bounding box than that
 * level's range; otherwise it is subdivided. Because the morph completes
 * exactly at the range where the parent level takes over, and because the
 * shared edge of any two adjacent nodes lies inside the coarser node's box,
 * every seam is guaranteed to be fully morphed and therefore watertight.
 */

/**
 * Ratio between a node's edge length and the distance at which that level is
 * considered good enough. 2.6 keeps the highest LOD comfortably inside a
 * kilometre while limiting the visible node count to a few hundred.
 */
const RANGE_K = 2.6;
/** Hard cap on instances; the selector stops emitting past this. */
const MAX_INSTANCES = 1600;
/** Nodes whose highest point is this far below the sea are never visible. */
const DEEP_CULL = -70;

const _box = new THREE.Box3();
const _frustum = new THREE.Frustum();
const _projView = new THREE.Matrix4();
const _bounds = { min: 0, max: 0 };

export class TerrainRenderer {
  readonly mesh: THREE.Mesh;
  readonly material: TerrainMaterial;
  /** Gbuffer material published through mesh.userData — see prepassMaterial.ts. */
  readonly prepassMaterial: PrepassMaterial;
  readonly heightTex: THREE.DataTexture;
  readonly maskTex: THREE.DataTexture;

  private hf: Heightfield;
  private geom: THREE.InstancedBufferGeometry;
  private nodeAttr: THREE.InstancedBufferAttribute;
  private morphAttr: THREE.InstancedBufferAttribute;
  private nodeData: Float32Array;
  private morphData: Float32Array;
  private count = 0;
  private grid: number;

  /** range[L] and the morph band [start, end] for each level. */
  private range = new Float32Array(LOD_LEVELS + 1);
  private morphStart = new Float32Array(LOD_LEVELS);
  private morphInv = new Float32Array(LOD_LEVELS);

  /** Frustum from the last update — reused by the vegetation scatterer. */
  readonly frustum = _frustum;

  /** Diagnostics for the perf HUD. */
  visibleNodes = 0;
  visibleTris = 0;

  constructor(hf: Heightfield, textures: WorldTextures, grid: number) {
    this.hf = hf;
    this.grid = grid;

    // --- height texture: R32F, unfiltered. The shader does its own bilinear
    // so that the GPU surface is identical to Heightfield.heightAt().
    this.heightTex = new THREE.DataTexture(
      hf.height, BAKE_N, BAKE_N, THREE.RedFormat, THREE.FloatType,
    );
    this.heightTex.name = 'terrainHeight';
    this.heightTex.magFilter = THREE.NearestFilter;
    this.heightTex.minFilter = THREE.NearestFilter;
    this.heightTex.wrapS = THREE.ClampToEdgeWrapping;
    this.heightTex.wrapT = THREE.ClampToEdgeWrapping;
    this.heightTex.generateMipmaps = false;
    this.heightTex.colorSpace = THREE.NoColorSpace;
    this.heightTex.needsUpdate = true;

    // --- biome masks: moisture / river / rock / macro. Data, not colour.
    this.maskTex = new THREE.DataTexture(
      hf.masks, MASK_N, MASK_N, THREE.RGBAFormat, THREE.UnsignedByteType,
    );
    this.maskTex.name = 'terrainMask';
    this.maskTex.magFilter = THREE.LinearFilter;
    this.maskTex.minFilter = THREE.LinearFilter;
    this.maskTex.wrapS = THREE.ClampToEdgeWrapping;
    this.maskTex.wrapT = THREE.ClampToEdgeWrapping;
    this.maskTex.generateMipmaps = false;
    this.maskTex.colorSpace = THREE.NoColorSpace;
    this.maskTex.needsUpdate = true;

    this.material = createTerrainMaterial({
      heightTex: this.heightTex,
      maskTex: this.maskTex,
      textures,
      grid,
    });

    this.geom = buildPatchGeometry(grid);
    this.nodeData = new Float32Array(MAX_INSTANCES * 4);
    this.morphData = new Float32Array(MAX_INSTANCES * 2);
    this.nodeAttr = new THREE.InstancedBufferAttribute(this.nodeData, 4);
    this.morphAttr = new THREE.InstancedBufferAttribute(this.morphData, 2);
    this.nodeAttr.setUsage(THREE.DynamicDrawUsage);
    this.morphAttr.setUsage(THREE.DynamicDrawUsage);
    this.geom.setAttribute('iNode', this.nodeAttr);
    this.geom.setAttribute('iMorph', this.morphAttr);
    this.geom.instanceCount = 0;

    this.prepassMaterial = createTerrainPrepassMaterial(this.material.terrainUniforms);

    this.mesh = new THREE.Mesh(this.geom, this.material);
    this.mesh.name = 'terrain';
    this.mesh.frustumCulled = false;   // we cull per node, not per mesh
    this.mesh.castShadow = false;      // see note in WorldSystem
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 0;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    // The gbuffer hook. 'noPrepass' is the safe fallback for a prepass that
    // does not yet know about 'prepassMaterial': without it the scene override
    // rasterises the raw unit patch as a stack of 1 m quads at the world
    // origin. A prepass that DOES honour the hook must test it first — see the
    // contract in prepassMaterial.ts.
    this.mesh.userData.prepassMaterial = this.prepassMaterial;
    this.mesh.userData.noPrepass = true;

    this.computeRanges();
  }

  /** Rebuild the patch mesh at a new tessellation (quality change). */
  setGrid(grid: number): void {
    if (grid === this.grid) return;
    this.grid = grid;
    const old = this.geom;
    this.geom = buildPatchGeometry(grid);
    this.geom.setAttribute('iNode', this.nodeAttr);
    this.geom.setAttribute('iMorph', this.morphAttr);
    this.geom.instanceCount = this.count;
    this.mesh.geometry = this.geom;
    this.material.terrainUniforms.uGrid.value = grid;
    old.dispose();
  }

  /**
   * Publishes the supply road so the terrain shader can paint it. The convoy in
   * GroundTargets drives the identical curve.
   */
  setRoad(ax: number, az: number, bx: number, bz: number): void {
    const u = this.material.terrainUniforms;
    (u.uRoadA.value as THREE.Vector2).set(ax, az);
    (u.uRoadB.value as THREE.Vector2).set(bx, bz);
    u.uRoadOn.value = 1;
  }

  /** Publishes the flattened aerodrome pads so cultivation stays off them. */
  setPads(sites: readonly { x: number; z: number; heading: number; padHalfL: number; padHalfW: number }[]): void {
    const u = this.material.terrainUniforms;
    const arr = u.uPad.value as THREE.Vector4[];
    const n = Math.min(arr.length, sites.length);
    for (let i = 0; i < n; i++) {
      const s = sites[i];
      arr[i].set(s.x, s.z, Math.sin(s.heading), Math.cos(s.heading));
    }
    if (n > 0) (u.uPadHalf.value as THREE.Vector2).set(sites[0].padHalfL, sites[0].padHalfW);
    u.uPadCount.value = n;
  }

  private computeRanges(): void {
    for (let L = 0; L <= LOD_LEVELS; L++) {
      this.range[L] = LEAF_SIZE * Math.pow(2, L) * RANGE_K;
    }
    for (let L = 0; L < LOD_LEVELS; L++) {
      const lo = this.range[L], hi = this.range[L + 1];
      // Start morphing partway through the band so the finer grid is still
      // fully resolved for most of its useful range, then finish exactly at
      // 'hi' — the distance at which the parent level takes over. Finishing
      // early would be harmless; finishing late would crack.
      const start = lo + (hi - lo) * 0.42;
      this.morphStart[L] = start;
      this.morphInv[L] = 1 / Math.max(1, hi - start);
    }
  }

  /** Walk the quadtree and refill the instance buffers. */
  update(ctx: GameContext): void {
    const cam = ctx.camera;
    cam.updateMatrixWorld();
    _projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projView);

    this.count = 0;
    const root = LOD_LEVELS - 1;
    this.select(root, 0, 0, cam.position);

    this.nodeAttr.addUpdateRange(0, this.count * 4);
    this.morphAttr.addUpdateRange(0, this.count * 2);
    this.nodeAttr.needsUpdate = true;
    this.morphAttr.needsUpdate = true;
    this.geom.instanceCount = this.count;
    this.visibleNodes = this.count;
    this.visibleTris = this.count * this.grid * this.grid * 2;
  }

  /**
   * Recursive node selection. 'i'/'j' are node indices at 'level'; level 0 is
   * the leaf (LEAF_SIZE metres).
   */
  private select(level: number, i: number, j: number, camPos: THREE.Vector3): void {
    if (this.count >= MAX_INSTANCES) return;

    const size = LEAF_SIZE * Math.pow(2, level);
    const ox = -MAP_HALF + i * size;
    const oz = -MAP_HALF + j * size;

    this.hf.nodeBounds(level, i, j, _bounds);
    // Nothing above the deep-water cutoff can ever be seen through the ocean.
    if (_bounds.max < DEEP_CULL) return;

    _box.min.set(ox, _bounds.min, oz);
    _box.max.set(ox + size, _bounds.max, oz + size);
    if (!_frustum.intersectsBox(_box)) return;

    const d = _box.distanceToPoint(camPos);
    // Budget check *before* descending. Bailing out mid-walk (the old
    // behaviour) abandoned nodes without emitting their ancestor, so an
    // overflow punched a see-through hole straight to the sky background —
    // the worst possible failure mode for a terrain renderer. Refusing to
    // subdivide instead degrades the patch to a coarser tessellation, which
    // nobody will notice.
    if (level > 0 && d <= this.range[level] && this.count + 4 <= MAX_INSTANCES) {
      const c = level - 1;
      this.select(c, i * 2, j * 2, camPos);
      this.select(c, i * 2 + 1, j * 2, camPos);
      this.select(c, i * 2, j * 2 + 1, camPos);
      this.select(c, i * 2 + 1, j * 2 + 1, camPos);
      return;
    }

    const n = this.count++;
    const o4 = n * 4, o2 = n * 2;
    this.nodeData[o4] = ox;
    this.nodeData[o4 + 1] = oz;
    this.nodeData[o4 + 2] = size;
    this.nodeData[o4 + 3] = level;
    this.morphData[o2] = this.morphStart[Math.min(level, LOD_LEVELS - 1)];
    this.morphData[o2 + 1] = this.morphInv[Math.min(level, LOD_LEVELS - 1)];
  }

  dispose(): void {
    this.geom.dispose();
    this.material.dispose();
    this.prepassMaterial.dispose();
    this.heightTex.dispose();
    this.maskTex.dispose();
  }
}

/**
 * The unit grid every terrain node instances. Positions are (gx, 0, gz) with
 * gx/gz in [0,1]; the vertex shader maps them into the node's footprint. The
 * grid size must be even for the CDLOD odd-vertex snap to work.
 */
function buildPatchGeometry(grid: number): THREE.InstancedBufferGeometry {
  const g = grid | 0;
  const n = g + 1;
  const pos = new Float32Array(n * n * 3);
  const nrm = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const o = (j * n + i) * 3;
      pos[o] = i / g;
      pos[o + 1] = 0;
      pos[o + 2] = j / g;
      nrm[o + 1] = 1;
    }
  }
  const idx = new Uint32Array(g * g * 6);
  let k = 0;
  for (let j = 0; j < g; j++) {
    for (let i = 0; i < g; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      // Alternate the diagonal so the triangulation does not bias the
      // silhouette of ridgelines along one direction.
      if (((i + j) & 1) === 0) {
        idx[k++] = a; idx[k++] = c; idx[k++] = b;
        idx[k++] = b; idx[k++] = c; idx[k++] = d;
      } else {
        idx[k++] = a; idx[k++] = c; idx[k++] = d;
        idx[k++] = a; idx[k++] = d; idx[k++] = b;
      }
    }
  }

  const geom = new THREE.InstancedBufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geom.setIndex(new THREE.BufferAttribute(idx, 1));
  // Never used for culling (the mesh opts out) but three wants it defined.
  geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), MAP_SIZE);
  geom.boundingBox = new THREE.Box3(
    new THREE.Vector3(-MAP_HALF, -1000, -MAP_HALF),
    new THREE.Vector3(MAP_HALF, 4000, MAP_HALF),
  );
  return geom;
}
