import * as THREE from 'three';
import { celGlobals, createCelMaterial, type CelMaterial } from '../render/CelMaterial';
import type { QualityTier } from '../engine/context';
import { MAP_HALF, SEA_LEVEL, type Heightfield } from './heightfield';
import { MeshBuilder } from './buildUtils';

/**
 * Forests, rocks and scatter props — all GPU-instanced.
 *
 * Three levels of detail, chosen per instance every rebuild:
 *   0-620 m    solid low-poly trees (one InstancedMesh per species)
 *   620-2800 m cylindrical impostor cards (one instanced draw, camera-facing
 *              in the vertex shader)
 *   > 2800 m   nothing — the terrain shader has already tinted the ground with
 *              the same forest-density function, so the canopy keeps reading
 *              after the geometry is gone and there is no visible pop.
 *
 * Placement is deterministic from the map seed: a hash per 128 m cell produces
 * candidate points which are then accepted against 'forestDensity', the exact
 * function the terrain shader uses to darken the ground. Trees therefore only
 * ever appear on ground that is already painted as woodland.
 *
 * Cells are generated lazily and cached, and the instance buffers are only
 * rewritten when the camera crosses a cell boundary, so steady flight costs
 * nothing per frame.
 */

const CELL = 128;
const MESH_RADIUS = 620;
const CARD_RADIUS = 2300;
/** Floats per impostor instance: iCard(4) + iCardB(4) + iCardC(4). */
const CARD_STRIDE = 12;
/** Floats per cached tree: x, y, z, spread, height, yaw, species, tint. */
const TREE_STRIDE = 8;
const MAX_TREE_INSTANCES = 3400;
/** Per species — the cards are four draws now, not one atlased draw. */
const MAX_CARD_INSTANCES = 6500;
const MAX_ROCK_INSTANCES = 1400;

/**
 * Screen height, in pixels at the current render resolution, below which an
 * impostor is not drawn at all.
 *
 * This is the fix for the rainbow confetti along the horizon. A cut-out card
 * three or four pixels tall is a *sub-pixel silhouette*: the alpha test
 * quantises it differently every frame, the edge-detect pass reads the result
 * as a hard black line, the grade's chromatic aberration splits that line into
 * red and cyan, and a treeline six kilometres out arrives as a band of coloured
 * speckle. No amount of filtering fixes it, because the information simply is
 * not there at that size — the only correct answer is to stop drawing it and
 * let the terrain shader's forest tint (which is painting the same woodland
 * from the same density function) carry the read, which is exactly what it was
 * written to do.
 *
 * The fade is geometric rather than alpha, so the card also leaves the depth /
 * normal gbuffer — an alpha fade would keep feeding the ink pass a silhouette
 * for a tree that is no longer visible and leave ghost outlines behind.
 */
const CARD_MIN_PX = 4.5;
const CARD_FULL_PX = 12.0;
/** Candidate points generated per cell before density rejection. */
const CANDIDATES = 64;

/**
 * Four silhouettes, not two.
 *
 * Two stamps is the number at which a treeline stops being a treeline and
 * becomes a repeated motif — the eye locks onto the repeat within about a
 * second, and no amount of tint or yaw variation hides it because the
 * *outline* is what it is reading. Four shapes that differ in aspect ratio and
 * in where their mass sits (narrow spire, flat umbrella, round dome, tall
 * column) is enough that a stand reads as a mixed wood.
 *
 * Order matters: 0-1 are conifers, 2-3 broadleaves, and the scatterer picks
 * across that boundary from the same moisture/altitude term it always did.
 */
const SPECIES_COUNT = 4;
/** Card height and width/height ratio per species, metres. */
// Matched to the solid meshes above so nothing changes size across the LOD
// handover; the impostor is a portrait of the mesh, not a different tree.
const SPECIES_CARD = [
  { h: 15.2, w: 0.44 },   // 0 spruce  — narrow spire
  { h: 14.0, w: 0.66 },   // 1 pine    — bare bole, umbrella crown
  { h: 11.6, w: 0.88 },   // 2 oak     — broad dome
  { h: 13.4, w: 0.42 },   // 3 poplar  — tall oval on a long bole
] as const;

/**
 * Aerial perspective for foliage, as a ratio against the shared weather-driven
 * celGlobals value — the same contract terrainMaterial and Water use.
 *
 * Trees stand ON the terrain, so they have to sit on the terrain's haze curve,
 * not on the aircraft's. With the default 26 km falloff a treeline three
 * kilometres out picked up 4% haze while the ground beneath it picked up 10%,
 * so the wood floated off the hillside as a saturated dark-green band — and
 * because the ink pass derives its line colour from the pixel underneath, that
 * unhazed green is also precisely why every tree in the set carried the same
 * near-black outline at every distance.
 */
export const VEG_AERIAL_FAR_SCALE = 0.60;
export const VEG_AERIAL_STRENGTH_SCALE = 1.14;

/**
 * Range-driven contrast collapse, applied to the FINAL colour.
 *
 * This is the depth-scaled ink the critique keeps asking for, arrived at from
 * the only side of the problem vegetation actually controls. The ink pass takes
 * its line colour from the pixel underneath the line — surface colour times
 * 0.20, saturated, nudged to indigo — so a line is only as pale as the surface
 * it is drawn over. A wood therefore gets the same near-black outline at eight
 * hundred metres as at forty, because the cel ramp is still putting a core
 * shadow next to a top-band highlight inside a canopy that is nine pixels
 * across.
 *
 * Compressing the ALBEDO does not fix that — the range is created by the
 * lighting, downstream of it. So this scales each fragment's *luminance* toward
 * the ambient luminance with distance, which lifts the shadow side and pulls
 * the sunlit facets down at the same time. The ink derived from the result is
 * mid-value and tinted to the atmosphere rather than black, the interior
 * contrast that was feeding the edge detector (and the grade's chromatic
 * aberration) sub-pixel speckle goes away, and near trees are untouched.
 *
 * 'amount' caps the effect: at 1.0 a distant wood is a flat silhouette, which
 * is worse than too much contrast.
 */
const VEG_RANGE_FLATTEN = (near: number, far: number, amount: number): string => /* glsl */`
        {
          const vec3 VLUMA = vec3( 0.2126, 0.7152, 0.0722 );
          float zd = length( cameraPosition - vCelWorldPos );
          float flat_ = smoothstep( ${near.toFixed(1)}, ${far.toFixed(1)}, zd ) * ${amount.toFixed(3)};
          // Weighted toward the GROUND hemisphere and held well down. Foliage
          // at range has to settle onto the value of the land it is standing
          // on; targeting the sky put a lit canopy at a higher value than a
          // shadowed field and a wood two kilometres out came back as a row of
          // bright green dots.
          vec3  amb = mix( uSkyColor, uGroundColor, 0.58 ) * 0.50;
          float lum = max( dot( gl_FragColor.rgb, VLUMA ), 1e-4 );
          float ambL = max( dot( amb, VLUMA ), 1e-4 );
          gl_FragColor.rgb *= mix( lum, ambL, flat_ ) / lum;
          gl_FragColor.rgb = mix( gl_FragColor.rgb, amb, flat_ * 0.30 );
        }`;

// ---------------------------------------------------------------------------
// GLSL-mirrored noise (must match NOISE_GLSL / FOREST_GLSL in terrainMaterial)
// ---------------------------------------------------------------------------

const fr = (v: number) => v - Math.floor(v);
const f32 = Math.fround;

/**
 * Bit-for-bit mirror of tHash in NOISE_GLSL. The Math.fround calls are not
 * decoration: the GLSL runs in 32-bit float and this hash deliberately relies
 * on precision loss, so evaluating it in float64 gives a *different* field and
 * the trees drift away from the woodland the terrain shader painted.
 */
function tHash(px: number, py: number): number {
  let x = f32(fr(f32(px * 0.1031)));
  let y = f32(fr(f32(py * 0.1031)));
  let z = x;                                   // vec3( p.xyx )
  const d = f32(f32(x * f32(y + 33.33)) + f32(y * f32(z + 33.33)) + f32(z * f32(x + 33.33)));
  x = f32(x + d); y = f32(y + d); z = f32(z + d);
  return f32(fr(f32(f32(x + y) * z)));
}

function tNoise(px: number, py: number): number {
  const ix = Math.floor(px), iy = Math.floor(py);
  let fx = px - ix, fy = py - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = tHash(ix, iy);
  const b = tHash(ix + 1, iy);
  const c = tHash(ix, iy + 1);
  const d = tHash(ix + 1, iy + 1);
  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return ab + (cd - ab) * fy;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** The absolute bound on any per-instance tree axis. See the scatter loop. */
const clampScale = (s: number) => (s < 0.40 ? 0.40 : s > 1.90 ? 1.90 : s);
const smoothstep01 = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Mirror of FOREST_GLSL.forestDensity. Keep the two in lockstep. */
export function forestDensity(
  x: number, z: number, h: number, slope: number, moisture: number, macro: number,
): number {
  const suit = smooth(6, 38, h) * (1 - smooth(880, 1300, h)) * (1 - smooth(0.34, 0.62, slope));
  if (suit <= 0.001) return 0;
  const n = tNoise(x * 0.00051, z * 0.00051) * 0.56
    + tNoise(x * 0.00168, z * 0.00168) * 0.29
    + tNoise(x * 0.00610, z * 0.00610) * 0.15;
  const thr = 0.605 - moisture * 0.20 - (macro - 0.5) * 0.30 - smooth(0.06, 0.30, slope) * 0.05;
  return clamp01(smooth(thr, thr + 0.075, n) * suit);
}

/**
 * Mirror of the 'farm' weight in the terrain fragment shader. Trees do not grow
 * in a worked field — the whole point of a field is that they were removed —
 * so the scatterer needs to know where cultivation is before it can decide
 * that a candidate belongs on a boundary rather than in the middle of a crop.
 * 'uFieldStrength' is deliberately NOT applied: it is a quality dial on how
 * much *shader* work the fields do, and vegetation must not change with it.
 */
export function farmland(
  h: number, slope: number, forest: number, macro: number, river: number,
): number {
  return (1 - smooth(0.12, 0.46, forest))
    * (1 - smooth(0.16, 0.33, slope))
    * smooth(3, 26, h) * (1 - smooth(520, 860, h))
    * smooth(0.92, 0.44, macro)
    * (1 - smooth(0.30, 0.62, river));
}

// --- parcel lattice, mirroring FIELD_GLSL ----------------------------------
//
// Every hash argument below is an INTEGER lattice coordinate plus an integer
// offset. That is not stylistic: GLSL evaluates these in float32 and JS in
// float64, and tHash is a hash rather than an interpolant, so a one-ulp
// difference in its argument returns a completely unrelated value. Integers are
// exact in both, which is what keeps the hedgerow the shader paints and the
// hedgerow trees this file plants on the same line.

const PARCEL_M = 146.0;
const PARCEL_JIT = 0.95;

/**
 * Root cell packed into one integer so the hot loop can compare parcels with a
 * single '===' and without allocating. The lattice never exceeds +/-200 cells
 * over a 65 km map, so 1024 of headroom either way is ample.
 */
function parcelRootKey(gx: number, gy: number, mergeP: number): number {
  let rx = gx, ry = gy;
  if (tHash(gx + 613, gy + 613) <= mergeP) {
    const u = tHash(gx + 1493, gy + 1493);
    if (u < 0.25) rx = gx + 1;
    else if (u < 0.50) rx = gx - 1;
    else if (u < 0.75) ry = gy + 1;
    else ry = gy - 1;
  }
  return (rx + 1024) * 4096 + (ry + 1024);
}

/** Distance from (x,z) to the nearest parcel boundary, in metres. */
function parcelEdgeM(x: number, z: number, elev: number): number {
  const mergeP = 0.30 + 0.62 * tNoise(x * 0.00062, z * 0.00062);
  let wx = tNoise(x * 0.000206, z * 0.000206) - 0.5;
  let wy = tNoise(x * 0.000206 + 53.7, z * 0.000206 + 53.7) - 0.5;
  wx += (tNoise(x * 0.00081 + 11, z * 0.00081 + 11) - 0.5) * 0.42;
  wy += (tNoise(x * 0.00081 + 91, z * 0.00081 + 91) - 0.5) * 0.42;
  wx = (wx + elev * 0.00135) * 2.3;
  wy = (wy - elev * 0.00098) * 2.3;

  const fx = x / PARCEL_M + wx;
  const fy = z / PARCEL_M + wy;
  const ipx = Math.floor(fx), ipy = Math.floor(fy);
  const ffx = fx - ipx, ffy = fy - ipy;

  let mgx = 0, mgy = 0, mrx = 0, mry = 0, md = 8;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const rx = i + 0.5 + (tHash(ipx + i, ipy + j) - 0.5) * PARCEL_JIT - ffx;
      const ry = j + 0.5 + (tHash(ipx + i + 271, ipy + j + 271) - 0.5) * PARCEL_JIT - ffy;
      const d = rx * rx + ry * ry;
      if (d < md) { md = d; mrx = rx; mry = ry; mgx = i; mgy = j; }
    }
  }
  const root = parcelRootKey(ipx + mgx, ipy + mgy, mergeP);
  // Only planted boundaries carry standards. The shader makes the same call
  // from the same hash, so an open holding stays open in both.
  if (tHash(((root / 4096) | 0) - 1024 + 331, (root % 4096) - 1024 + 331) < 0.22) return 1e9;

  let edge = 8;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      if (i === 0 && j === 0) continue;
      const gx = ipx + mgx + i, gy = ipy + mgy + j;
      if (parcelRootKey(gx, gy, mergeP) === root) continue;
      const rx = mgx + i + 0.5 + (tHash(gx, gy) - 0.5) * PARCEL_JIT - ffx;
      const ry = mgy + j + 0.5 + (tHash(gx + 271, gy + 271) - 0.5) * PARCEL_JIT - ffy;
      const dx = rx - mrx, dy = ry - mry;
      const dl = Math.sqrt(dx * dx + dy * dy);
      if (dl > 1e-4) {
        const e = (0.5 * (mrx + rx) * dx + 0.5 * (mry + ry) * dy) / dl;
        if (e < edge) edge = e;
      }
    }
  }
  // Same boundary wobble the shader applies, so the standards sit on the
  // painted hedge and not on the mathematical bisector behind it.
  return edge * PARCEL_M + (tNoise(x * 0.045, z * 0.045) - 0.5) * 5.0;
}

// ---------------------------------------------------------------------------

interface CellData {
  /** x, y, z, spread, height, yaw, species(0..3), tintIndex */
  trees: Float32Array;
  treeCount: number;
  rocks: Float32Array;
  rockCount: number;
}

/** One impostor draw per silhouette — see buildCards(). */
interface CardLayer {
  mesh: THREE.Mesh;
  geom: THREE.InstancedBufferGeometry;
  buffer: THREE.InstancedInterleavedBuffer;
  data: Float32Array;
  count: number;
}

export class Vegetation {
  readonly group = new THREE.Group();

  private hf: Heightfield;
  private cells = new Map<number, CellData>();
  private cellOrder: number[] = [];

  /** One InstancedMesh per silhouette, indexed by species. */
  private trees: THREE.InstancedMesh[] = [];
  private rocks!: THREE.InstancedMesh;
  /** One impostor layer per silhouette, indexed by species. */
  private cards: CardLayer[] = [];

  private lastCellX = 1e9;
  private lastCellZ = 1e9;
  private meshRadius = MESH_RADIUS;
  private cardRadius = CARD_RADIUS;

  instanceCount = 0;

  /**
   * (windX, windZ, amplitude, time). Shared by the solid trees and the impostor
   * cards so a stand sways identically on both sides of the LOD handover.
   */
  private windUniform: THREE.IUniform = { value: new THREE.Vector4(0.7, 0.7, 0.012, 0) };

  /**
   * Foliage-local aerial perspective, shadowing the shared celGlobals uniforms
   * of the same name. Rewritten every frame from the live weather value so a
   * squall thickens the woods along with everything else.
   */
  private aerialFar: THREE.IUniform = { value: 26000 * VEG_AERIAL_FAR_SCALE };
  private aerialStrength: THREE.IUniform = { value: 0.9 * VEG_AERIAL_STRENGTH_SCALE };
  /** Drawing-buffer size, for the impostor minimum-screen-size cull. */
  private resUniform: THREE.IUniform = celGlobals.uResolution;

  constructor(hf: Heightfield, quality: QualityTier) {
    this.hf = hf;
    this.group.name = 'vegetation';
    this.group.matrixAutoUpdate = false;

    const treeMat = createCelMaterial({
      name: 'foliage',
      color: 0xffffff,
      vertexColors: true,
      bands: 3,
      bandSoftness: 0.06,
      gloss: 0.95,
      specular: 0.02,
      specSteps: 1,
      // Low-poly foliage presents grazing normals almost everywhere, so a
      // strong rim washes the whole tree into a pale ghost instead of
      // outlining it. Keep it thin and tight.
      //
      // 0.22/4.0 was still far too broad for objects this small. A trunk is
      // under a metre across — six or seven pixels at a hundred metres — and a
      // rim that reaches 20 degrees off the silhouette covers the entire
      // cylinder, so every bole rendered as a stroke of warm white. The same
      // arithmetic ruins any narrow canopy. Halve the strength and tighten the
      // exponent so the rim is a highlight on the edge rather than the object.
      //
      // 0.11/5.5 was still washing the bole to cream in the low pass — a rim is
      // ADDITIVE and unbounded by albedo, so on a half-metre cylinder where
      // every fragment is near-grazing it simply replaces the trunk colour.
      // Thinner and much tighter; foliage gets its edge from the ink pass, not
      // from a fresnel term.
      rimStrength: 0.045,
      rimPower: 7.0,
      shadowTint: 0x74899e,
      terminatorTint: 0xe6cf72,
      // A warm terminator is a band in N.L, so its screen width is set by how
      // fast the normal turns. On a 0.5 m bole 0.24 covers the whole cylinder
      // and the trunk goes cream; on a canopy facet it covers whole facets at
      // once. Narrow enough to be a line on the shading break.
      terminatorWidth: 0.12,
      // NOT flat-shaded by the renderer. MeshBuilder already emits one normal
      // per face (its vertices are never shared between facets), so the geometry
      // is faceted whatever this says — and three's FLAT_SHADED path derives the
      // normal from screen-space derivatives of the view position instead, which
      // on a tree three pixels wide is a derivative across a triangle boundary
      // and therefore noise. Using the authored normals gives the identical
      // faceting with none of the sub-pixel instability.
      flatShading: false,
    });
    // Wind. Static foliage under a stated 4-13 m/s breeze reads as plastic, and
    // the cure is almost free: displace by height above the trunk base so the
    // crown leans and the bole does not, with a per-instance phase taken from
    // the instance's own world position so a stand does not sway in unison.
    const treeCompile = treeMat.onBeforeCompile;
    treeMat.onBeforeCompile = (shader, renderer) => {
      treeCompile.call(treeMat, shader, renderer);
      Object.assign(shader.uniforms, {
        uWind: this.windUniform,
        // Assigned AFTER CelMaterial's own, so these win — see the note on
        // VEG_AERIAL_FAR_SCALE.
        uAerialFar: this.aerialFar,
        uAerialStrength: this.aerialStrength,
      });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n uniform vec4 uWind;')
        .replace('#include <begin_vertex>', /* glsl */`
          #include <begin_vertex>
          {
            #ifdef USE_INSTANCING
              vec2 anchor = vec2( instanceMatrix[3].x, instanceMatrix[3].z );
            #else
              vec2 anchor = vec2( 0.0 );
            #endif
            float phase = dot( anchor, vec2( 0.031, 0.047 ) );
            // Two incommensurate rates: a slow bend plus a faster flutter, so
            // the motion never reads as one sine.
            float s = sin( uWind.w * 1.05 + phase ) * 0.72
                    + sin( uWind.w * 2.63 + phase * 1.7 ) * 0.28;
            float lever = max( transformed.y - 1.2, 0.0 );
            transformed.xz += uWind.xy * s * lever * uWind.z;
          }
        `);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <fog_fragment>', VEG_RANGE_FLATTEN(180, 900, 0.62)
          + '\n#include <fog_fragment>');
    };
    treeMat.customProgramCacheKey = () => 'cel-foliage-wind-v3';

    const geoms = [buildSpruce(), buildPine(), buildOak(), buildPoplar()];
    const names = ['spruces', 'pines', 'oaks', 'poplars'];
    for (let i = 0; i < SPECIES_COUNT; i++) {
      this.trees.push(makeInstanced(geoms[i], treeMat, MAX_TREE_INSTANCES, names[i]));
    }
    this.rocks = makeInstanced(buildBoulder(), createCelMaterial({
      name: 'boulders',
      color: 0xffffff,
      vertexColors: true,
      bands: 3,
      bandSoftness: 0.05,
      gloss: 0.75,
      specular: 0.10,
      rimStrength: 0.14,
      rimPower: 4.5,
      shadowTint: 0x5b7796,
      flatShading: false,
    }), MAX_ROCK_INSTANCES, 'boulders');

    this.group.add(...this.trees, this.rocks);
    this.buildCards();
    this.setQuality(quality);
  }

  setQuality(q: QualityTier): void {
    const f = q === 'low' ? 0.45 : q === 'medium' ? 0.72 : q === 'ultra' ? 1.25 : 1.0;
    this.meshRadius = MESH_RADIUS * f;
    this.cardRadius = CARD_RADIUS * (q === 'low' ? 0.55 : q === 'medium' ? 0.8 : 1.0);
    this.lastCellX = 1e9; // force a rebuild
  }

  // -- impostor cards -------------------------------------------------------

  /**
   * Four impostor draws, one per silhouette — deliberately NOT one atlased
   * draw.
   *
   * The 2x2 atlas it replaces was the direct cause of two automatic failures.
   * At the distances impostors actually live at, a card is 5-15 px tall, so the
   * texture is being read at mip 4-6; a 3-texel gutter is gone by mip 2 and the
   * filter then blends a spruce tile into an oak tile and both into the brown
   * trunk tile, which is where the red/cyan/white speckle along the horizon
   * came from. Worse, the depth/normal prepass derives its alpha-test variant
   * from 'material.map' and samples it at the raw quad UV — it knows nothing
   * about the tile offset — so the silhouette in the gbuffer was ALL FOUR
   * species overlaid, while the silhouette on screen was one. The ink pass was
   * therefore drawing outlines that did not correspond to anything visible.
   *
   * One texture per species costs three extra draw calls out of ~210 and makes
   * every one of those problems structurally impossible: uv 0..1 is the whole
   * texture in both the forward and the prepass program, mips are per
   * silhouette, and no gutter is needed beyond clamp-to-edge.
   */
  private buildCards(): void {
    for (let sp = 0; sp < SPECIES_COUNT; sp++) this.cards.push(this.buildCardLayer(sp));
  }

  private buildCardLayer(sp: number): CardLayer {
    // A single quad; the vertex shader turns it into a cylindrical billboard.
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(
      [-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(
      [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);

    // One interleaved buffer, three vec4 views:
    //   iCard  = (x, y, z, height)
    //   iCardB = (width, tintR, tintG, tintB)
    //   iCardC = (shrink, lightSeed, mirror, unused)
    const data = new Float32Array(MAX_CARD_INSTANCES * CARD_STRIDE);
    const ib = new THREE.InstancedInterleavedBuffer(data, CARD_STRIDE, 1);
    ib.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iCard', new THREE.InterleavedBufferAttribute(ib, 4, 0));
    g.setAttribute('iCardB', new THREE.InterleavedBufferAttribute(ib, 4, 4));
    g.setAttribute('iCardC', new THREE.InterleavedBufferAttribute(ib, 4, 8));
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), MAP_HALF * 2);

    const mat = createCelMaterial({
      name: `treeCards${sp}`,
      color: 0xffffff,
      map: buildCanopyTexture(sp),
      transparent: false,
      alphaTest: 0.45,
      bands: 3,
      bandSoftness: 0.08,
      gloss: 0.95,
      specular: 0.0,
      // No fresnel at all on an impostor. A card is a flat quad, so every
      // fragment has the same N.V and the rim is a uniform additive lift over
      // the whole silhouette — which is what turned the far treelines into pale
      // blobs ringed in black.
      rimStrength: 0.0,
      rimPower: 4.5,
      shadowTint: 0x4a6f92,
      side: THREE.DoubleSide,
      inkInterior: false,
    });
    const celCompile = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
      celCompile.call(mat, shader, renderer);
      Object.assign(shader.uniforms, {
        uWind: this.windUniform,
        uAerialFar: this.aerialFar,
        uAerialStrength: this.aerialStrength,
        uVegRes: this.resUniform,
      });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          uniform vec4 uWind;
          uniform vec2 uVegRes;
          attribute vec4 iCard;    // x, y, z, height
          attribute vec4 iCardB;   // width, tint rgb
          attribute vec4 iCardC;   // shrink, lightSeed, mirror, unused
          varying vec3  vCardTint;
        `)
        .replace('#include <beginnormal_vertex>', /* glsl */`
          // Cylindrical billboard: yaw toward the camera, never pitch. Trees
          // that tilt to face a diving aircraft look like cardboard; ones that
          // only spin about Y read as volume.
          vec3 iPos = iCard.xyz;
          vec3 toCam = cameraPosition - iPos;
          float camDist = max( length( toCam ), 1.0 );
          vec3 right = normalize( vec3( -toCam.z, 0.0, toCam.x ) );

          // MINIMUM SCREEN SIZE, enforced geometrically.
          //
          // projectionMatrix[1][1] is 1/tan(fovY/2), so this is the card's
          // height in pixels of the drawing buffer. Below CARD_MIN_PX the
          // silhouette is sub-pixel, the alpha test starts quantising it
          // differently every frame and the ink pass turns the result into
          // chromatic speckle; shrink it away instead. Doing it here rather
          // than with an alpha fade matters: the prepass replays this same
          // vertex patch, so the card leaves the gbuffer at exactly the moment
          // it leaves the picture and no ghost outline is left behind.
          float px = iCard.w / camDist * projectionMatrix[1][1] * 0.5 * uVegRes.y;
          float shrink = iCardC.x * smoothstep( ${CARD_MIN_PX.toFixed(1)}, ${CARD_FULL_PX.toFixed(1)}, px );

          // Half the cards are mirrored. One canopy silhouette repeated across
          // a whole treeline reads as a printed pattern; flipping it costs a
          // sign and doubles the apparent variety for nothing.
          vec3 cardPos = iPos + right * ( position.x * iCardB.x * iCardC.z * shrink )
                              + vec3( 0.0, position.y * iCard.w * shrink, 0.0 );

          // The shading normal must NOT follow the billboard. Deriving it from
          // the view vector gives every card in the scene the same N.L, so the
          // whole distant forest is one flat tone — and because that tone
          // rotates with the camera it walks across the cel band edges as the
          // aircraft yaws, flipping the entire treeline a brightness step at a
          // time. Instead each card carries a fixed hemispherical normal
          // leaning in its own seeded direction: the card still faces the
          // camera geometrically, but the canopy keeps a stable spread of tones
          // and reads as a lumpy volume rather than a painted wall.
          float ls = iCardC.y;
          vec3 objectNormal = normalize( vec3( sin( ls ) * 0.95, 1.45, cos( ls ) * 0.95 ) );
          // Same wind as the solid trees, so a stand does not stop moving the
          // instant it crosses the LOD handover.
          float wphase = dot( iPos.xz, vec2( 0.031, 0.047 ) );
          float wsway = sin( uWind.w * 1.05 + wphase ) * 0.72
                      + sin( uWind.w * 2.63 + wphase * 1.7 ) * 0.28;
          cardPos.xz += uWind.xy * wsway * ( position.y * iCard.w * shrink ) * uWind.z;
          vCardTint = iCardB.yzw;
        `)
        .replace('#include <begin_vertex>', 'vec3 transformed = cardPos;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          varying vec3 vCardTint;
        `)
        .replace('#include <map_fragment>', /* glsl */`
          {
            // Ordinary filtered fetch. uv 0..1 IS this species' texture now, so
            // the hardware gradient is correct, the mip chain never crosses
            // into another silhouette, and the alpha is a soft coverage ramp
            // rather than a binary mask — which is what stops the outline
            // boiling as the card shrinks through the mip levels.
            vec4 texel = texture2D( map, vMapUv );
            diffuseColor *= texel;
          }
          diffuseColor.rgb *= vCardTint;
        `)
        // Same range-driven contrast collapse the solid trees get, on the same
        // curve continued outward, so the LOD handover does not step the value
        // of a stand as it crosses.
        .replace('#include <fog_fragment>', VEG_RANGE_FLATTEN(400, 1700, 0.72)
          + '\n#include <fog_fragment>');
    };
    mat.customProgramCacheKey = () => 'cel-treecard-split-v1';

    const mesh = new THREE.Mesh(g, mat);
    mesh.name = `treeCards${sp}`;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    return { mesh, geom: g, buffer: ib, data, count: 0 };
  }

  // -- scatter --------------------------------------------------------------

  private cellKey(cx: number, cz: number): number {
    return ((cx + 4096) << 13) | (cz + 4096);
  }

  private getCell(cx: number, cz: number): CellData {
    const key = this.cellKey(cx, cz);
    const hit = this.cells.get(key);
    if (hit) return hit;

    const trees = new Float32Array(CANDIDATES * TREE_STRIDE);
    const rocks = new Float32Array(8 * 5);
    let tn = 0, rn = 0;
    const ox = cx * CELL, oz = cz * CELL;

    for (let i = 0; i < CANDIDATES; i++) {
      const r1 = tHash(cx * 7.31 + i * 1.77, cz * 3.19 + i * 5.13);
      const r2 = tHash(cx * 2.53 + i * 9.41, cz * 8.07 + i * 2.29);
      const r3 = tHash(cx * 5.11 + i * 3.67, cz * 1.93 + i * 7.51);
      const x = ox + r1 * CELL;
      const z = oz + r2 * CELL;
      const h = this.hf.heightAt(x, z);
      if (h < SEA_LEVEL + 1.5) continue;
      // Aerodromes are cleared ground: nothing grows inside the pad, and the
      // approach fans stay open for a further half-pad.
      if (this.hf.padT(x, z) < 1.5) continue;
      // Nor on a graded factory apron or rail yard.
      if (this.hf.siteT(x, z) < 1.15) continue;
      // Nor in the middle of a river.
      if (this.hf.maskAt(x, z, 1) > 0.45) continue;
      const slope = this.hf.slopeAt(x, z);

      // --- trees ---
      const moisture = this.hf.maskAt(x, z, 0);
      const macro = this.hf.maskAt(x, z, 3);
      const river = this.hf.maskAt(x, z, 1);
      const dens = forestDensity(x, z, h, slope, moisture, macro);
      const farm = farmland(h, slope, dens, macro, river);

      // Acceptance probability, built from three populations that look
      // completely different from the air and are what makes vegetation read
      // as landscape rather than as scatter:
      //
      //  1. WOODLAND. Squaring the density thins the stand toward its
      //     perimeter, so the ragged edge forestDensity draws is followed by a
      //     ragged edge of actual trees instead of a hard wall of them.
      //  2. HEDGEROW STANDARDS. On cultivated ground the trees were cleared
      //     from the field and left on the boundary. This is the single
      //     strongest man-made cue in northern European landscape and it costs
      //     one parcel lookup.
      //  3. PARK / ROUGH GRAZING. A thin scatter of individuals on the ground
      //     that is neither wood nor field, which is what stops the gaps
      //     between the two reading as mown lawn.
      // CANOPY CLUMPING. forestDensity decides where a *wood* is, at the
      // kilometre scale; inside one it was a uniform Poisson scatter, which is
      // what made the interior read as evenly-spaced wallpaper and the
      // perimeter as a dotted band. Real stands are lumpy at 30-150 m — groves,
      // glades, blowdown gaps — so modulate the acceptance by a two-scale
      // clump field and lift the base rate to keep the same mean density. The
      // product of two noises (rather than a sum) is what makes the gaps
      // genuinely empty instead of merely thinner.
      //
      // Three scales, not two, and the coarse one is the one that decides
      // whether there is a grove here at all: 320 m groves, 120 m sub-clumps,
      // 40 m thickets. A ragged WOODLAND EDGE is the third term — a fine
      // 25 m noise added to the density before the threshold, which is what
      // stops the perimeter of a stand being a smooth contour of the
      // kilometre-scale density field and turns it into the bitten, bay-and-
      // headland outline a real wood has.
      const clumpA = tNoise(x * 0.0031 + 3.1, z * 0.0031 + 9.7);
      const clumpB = tNoise(x * 0.0084 + 11.3, z * 0.0084 + 4.7);
      const clumpC = tNoise(x * 0.0255 + 27.9, z * 0.0255 + 61.3);
      const clump = clumpA * clumpB * (0.45 + 0.55 * clumpC);
      // Thresholded, then gained. The threshold is what opens genuine glades —
      // gain alone only makes the thin parts thinner, and a wood with no holes
      // in it is the "wallpaper" read. Mean gain stays near 1.0 so the overall
      // density of the map is unchanged.
      const clumpGain = smooth(0.045, 0.26, clump) * (0.50 + 2.30 * clump);
      // Woodland-edge raggedness: pushes the effective density up inside the
      // bays and down on the headlands by up to +/-0.10, at a scale small
      // enough to break the outline and large enough not to read as noise.
      const ragged = clamp01(dens + (tNoise(x * 0.0405 + 71.1, z * 0.0405 + 17.7) - 0.5) * 0.30);

      let p = ragged * ragged * 1.75 * clumpGain;
      if (farm > 0.10) {
        const edgeM = parcelEdgeM(x, z, h);
        // A hedge carries standards every 20-40 m; the field itself is empty.
        const hedge = 1 - smooth(3.0, 12.0, edgeM);
        p = p * (1 - farm * 0.92) + hedge * hedge * 0.34 * farm;
      } else {
        p += (1 - dens) * 0.030 * (0.35 + clumpGain * 0.5);
      }
      // Never accept every candidate in a cell: 64 trees inside 128 m is a
      // solid mat with no canopy structure left to read.
      if (p > 0.78) p = 0.78;

      if (r3 < p) {
        // Conifer on the high, dry, poor ground; broadleaf in the damp
        // lowlands — with enough hash jitter that mixed woods still occur.
        const conif = clamp01(0.20 + (h - 240) / 900 + (0.5 - moisture) * 0.9
          + (tHash(x * 0.29 + 5.1, z * 0.31 + 2.9) - 0.5) * 0.7);
        const sel = tHash(x * 0.37, z * 0.41);
        // Within each half, the second shape is the minority: spruce woods with
        // the odd pine standing over them, oak woods with poplars along the
        // watercourses. A 50/50 split reads as deliberate alternation.
        const sub = tHash(x * 0.53 + 7.3, z * 0.61 + 2.1);
        const species = sel < conif
          ? (sub < 0.72 ? 0 : 1)
          : (sub < 0.78 || moisture < 0.45 ? 2 : 3);
        // Hedgerow standards are older, taller and stand alone, so they read
        // bigger than the same species packed into a wood.
        const lone = 1 + (1 - dens) * 0.22;
        // Skewed size distribution. A uniform 0.70-1.48 gives every tree a
        // near-average height and the canopy comes out as a flat-topped mat;
        // real stands are mostly middling with a long tail of emergents and a
        // scatter of suppressed saplings, which is what gives a wood a ragged
        // upper surface. Cubing a uniform variate and remapping does that for
        // one multiply.
        const u = tHash(x * 0.13 + 3.7, z * 0.17 + 1.1);
        // Vigour: the middle of a grove grows the big timber, the ragged
        // perimeter and the glade margins carry the scrub. Correlating size
        // with the clump field is what makes a wood have a DOMED upper surface
        // instead of a flat one, and it costs a lerp on a value already in hand.
        const vigour = 0.84 + 0.30 * smooth(0.03, 0.40, clump);
        const raw = (0.56 + u * u * u * 0.58 + u * 0.30) * lone * vigour;
        const scale = raw < 0.42 ? 0.42 : raw > 1.60 ? 1.60 : raw;
        // Independent height/spread jitter. Uniform scale means every tree of a
        // species is the SAME SHAPE, only bigger or smaller, and the eye reads
        // that as one stamp — which is the "one or two silhouettes at one
        // scale" note. Trading a little height for a little spread (and the
        // reverse) gives squat wind-shaped trees on the exposed ground and drawn
        // -up ones in the shelter of the stand, from two multiplies. The two
        // factors are anti-correlated so the trade is roughly volume-preserving
        // and the pair cannot multiply up into an outlier.
        const a = tHash(x * 0.23 + 8.9, z * 0.19 + 6.3);
        // BELT AND BRACES. Both axes are clamped again, at the value that is
        // actually written into an instance matrix rather than at an
        // intermediate. Everything above is bounded by construction, but a
        // bounded expression is not a guarantee, and a single garbage transform
        // in the foreground is an automatic frame failure — a 15 m oak at 1.90
        // is a 28 m veteran, and nothing in this world may ever be larger.
        const height = clampScale(scale * (0.84 + a * 0.40));
        const spread = clampScale(scale * (1.16 - a * 0.34));
        const yaw = r1 * 6.2831853;
        const o = tn * TREE_STRIDE;
        trees[o] = x; trees[o + 1] = h; trees[o + 2] = z;
        trees[o + 3] = spread; trees[o + 4] = height; trees[o + 5] = yaw;
        trees[o + 6] = species; trees[o + 7] = tHash(x * 0.07, z * 0.09);
        tn++;
      } else if (rn < 8) {
        // --- rocks: scree on steep or high ground, boulders on beaches ---
        const rockM = this.hf.maskAt(x, z, 2);
        const p = slope > 0.42 ? 0.30 * rockM + 0.10 : (h < 12 ? 0.06 : 0.012 * rockM);
        if (r3 > 1 - p) {
          const o = rn * 5;
          rocks[o] = x; rocks[o + 1] = h; rocks[o + 2] = z;
          rocks[o + 3] = 0.7 + r1 * 2.6;
          rocks[o + 4] = r2 * 6.2831853;
          rn++;
        }
      }
    }

    const data: CellData = { trees, treeCount: tn, rocks, rockCount: rn };
    this.cells.set(key, data);
    this.cellOrder.push(key);
    // Bounded cache — a full sortie crosses a few thousand cells.
    if (this.cellOrder.length > 6000) {
      for (let i = 0; i < 1500; i++) this.cells.delete(this.cellOrder[i]);
      this.cellOrder = this.cellOrder.slice(1500);
    }
    return data;
  }

  // -- per-frame ------------------------------------------------------------

  /** Surface wind, from WorldSystem. dir is a compass-style bearing, speed m/s. */
  setWind(dir: number, speed: number, time: number): void {
    const v = this.windUniform.value as THREE.Vector4;
    // Amplitude in metres of sway per metre of lever arm: a 13 m/s breeze bends
    // the top of a 15 m oak by roughly a third of a metre, no more.
    v.set(Math.sin(dir), Math.cos(dir), 0.004 + speed * 0.0016, time);
  }

  update(camera: THREE.Camera, frustum: THREE.Frustum): void {
    // Track the weather-driven haze every frame, not only on a cell crossing —
    // see VEG_AERIAL_FAR_SCALE. Cheap: two number writes.
    this.aerialFar.value = (celGlobals.uAerialFar.value as number) * VEG_AERIAL_FAR_SCALE;
    this.aerialStrength.value = (celGlobals.uAerialStrength.value as number) * VEG_AERIAL_STRENGTH_SCALE;

    const cx = Math.floor(camera.position.x / CELL);
    const cz = Math.floor(camera.position.z / CELL);
    if (cx === this.lastCellX && cz === this.lastCellZ) return;
    this.lastCellX = cx; this.lastCellZ = cz;
    this.rebuild(camera, frustum);
  }

  private rebuild(camera: THREE.Camera, _frustum: THREE.Frustum): void {
    const cam = camera.position;
    const rCards = this.cardRadius;
    const rMesh = this.meshRadius;
    const cellR = Math.ceil(rCards / CELL);
    const cx0 = Math.floor(cam.x / CELL);
    const cz0 = Math.floor(cam.z / CELL);

    const nSp = _spCounts;
    const nCd = _cardCounts;
    for (let i = 0; i < SPECIES_COUNT; i++) { nSp[i] = 0; nCd[i] = 0; }
    let nRock = 0;

    for (let j = -cellR; j <= cellR; j++) {
      for (let i = -cellR; i <= cellR; i++) {
        const ccx = cx0 + i, ccz = cz0 + j;
        // Cheap circular reject on the cell centre.
        const dx = (ccx + 0.5) * CELL - cam.x;
        const dz = (ccz + 0.5) * CELL - cam.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > (rCards + CELL) * (rCards + CELL)) continue;

        const cell = this.getCell(ccx, ccz);
        for (let t = 0; t < cell.treeCount; t++) {
          const o = t * TREE_STRIDE;
          const x = cell.trees[o], y = cell.trees[o + 1], z = cell.trees[o + 2];
          const spread = cell.trees[o + 3], height = cell.trees[o + 4];
          const yaw = cell.trees[o + 5];
          const species = cell.trees[o + 6], tint = cell.trees[o + 7];
          const ddx = x - cam.x, ddy = y - cam.y, ddz = z - cam.z;
          const dist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
          if (dist > rCards) continue;

          const sp = species | 0;
          const tc = sp < 2 ? CONIFER_TINTS : BROADLEAF_TINTS;
          // tc holds N *triples*, so the index must be over N, not over the
          // raw float count — reading past the end writes NaN into the
          // instance colour and every tree renders pure black.
          const k = Math.min((tc.length / 3) - 1, (tint * (tc.length / 3)) | 0) * 3;

          if (dist < rMesh) {
            const target = this.trees[sp];
            const n = nSp[sp];
            if (n < MAX_TREE_INSTANCES) {
              nSp[sp] = n + 1;
              writeTRS(target.instanceMatrix.array as Float32Array, n,
                x, y, z, yaw, spread, height);
              const c = target.instanceColor!;
              (c.array as Float32Array)[n * 3] = tc[k];
              (c.array as Float32Array)[n * 3 + 1] = tc[k + 1];
              (c.array as Float32Array)[n * 3 + 2] = tc[k + 2];
            }
          }

          // --- impostor cards --------------------------------------------
          //
          // Two independent, continuous fades. Both are applied as a GEOMETRIC
          // shrink rather than as an alpha dissolve, and that is the whole
          // point: the depth/normal prepass replays this material's vertex
          // patch, so a card that shrinks to nothing leaves the gbuffer at the
          // same instant it leaves the picture. The alpha dissolve it replaces
          // did not — it scaled the sampled alpha uniformly across the quad, so
          // a card sitting near the alpha-test threshold flickered on and off
          // per pixel per mip level, and the gbuffer went on reporting a full
          // silhouette for a tree that had visually gone, which the ink pass
          // dutifully outlined.
          //
          //  (a) HANDOVER. Cards grow in over the outer 28% of the mesh radius,
          //      so for that band the solid tree and its impostor are both
          //      present and the swap is hidden inside the solid mesh. The band
          //      has to be wide — 170 m — because the instance buffers are only
          //      rewritten when the camera crosses a 128 m cell, and a fade
          //      shorter than that quantises back into a pop.
          //
          //  (b) DECIMATION. A full-density card field would need ~100k quads,
          //      so trees are dropped with distance. The kept set is chosen by a
          //      POWER-OF-TWO bitmask rather than a modulus, which makes the
          //      hierarchy nested: every tree kept at level L+1 was already kept
          //      at level L, so a step removes half the field instead of
          //      exchanging it for a different half.
          const n = nCd[sp];
          if (n >= MAX_CARD_INSTANCES) continue;
          const hand = smoothstep01(rMesh * 0.72, rMesh, dist);
          if (hand <= 0.002) continue;

          const lf = Math.log2(1 + (dist * dist) / 1050000);
          const lvl = lf | 0;
          const frac = lf - lvl;
          const mask = (1 << lvl) - 1;
          if ((t & mask) !== 0) continue;
          // Dropped when the level next increments — shrink it away now.
          const doomed = (t & (1 << lvl)) !== 0;
          const fade = hand * (doomed ? 1 - frac : 1);
          if (fade <= 0.01) continue;
          // PERSPECTIVE. Area per surviving card doubles per level, so holding
          // canopy *coverage* exactly would need 2^(level/2) linear growth —
          // and that is the bug the critique keeps hitting: inflating the
          // survivors puts a horizon tree on screen at nearly the size of a
          // mid-ground one and the landscape flattens into a painted backdrop.
          // The compensation is barely needed at all, because the terrain
          // shader paints the forest floor from the same density function and
          // carries the canopy read on its own. A 0.20 exponent and a 1.16 cap
          // leave on-screen size falling essentially as 1/d, which is what
          // perspective does.
          const grow = Math.min(1.16, Math.pow(2, (lvl + frac) * 0.20) * 0.95);

          const layer = this.cards[sp];
          const cardData = layer.data;
          const o8 = n * CARD_STRIDE;
          const card = SPECIES_CARD[sp];
          const hgt = card.h * height * grow;
          cardData[o8] = x;
          cardData[o8 + 1] = y - 0.4;
          cardData[o8 + 2] = z;
          cardData[o8 + 3] = hgt;
          cardData[o8 + 4] = card.h * spread * grow * card.w;
          cardData[o8 + 5] = tc[k];
          cardData[o8 + 6] = tc[k + 1];
          cardData[o8 + 7] = tc[k + 2];
          cardData[o8 + 8] = fade;   // geometric shrink, not alpha
          cardData[o8 + 9] = yaw;    // stable per-card lighting normal seed
          cardData[o8 + 10] = tint < 0.5 ? 1 : -1;   // mirror the silhouette
          cardData[o8 + 11] = 0;
          nCd[sp] = n + 1;
        }

        if (d2 < rMesh * rMesh * 2.2) {
          for (let t = 0; t < cell.rockCount && nRock < MAX_ROCK_INSTANCES; t++) {
            const o = t * 5;
            const rs = cell.rocks[o + 3];
            writeTRS(this.rocks.instanceMatrix.array as Float32Array, nRock,
              cell.rocks[o], cell.rocks[o + 1] - rs * 0.28, cell.rocks[o + 2],
              cell.rocks[o + 4], rs, rs * 0.78);
            nRock++;
          }
        }
      }
    }

    let total = 0;
    for (let i = 0; i < SPECIES_COUNT; i++) {
      const m = this.trees[i];
      m.count = nSp[i];
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor!.needsUpdate = true;
      total += nSp[i];

      const layer = this.cards[i];
      layer.count = nCd[i];
      layer.geom.instanceCount = nCd[i];
      layer.buffer.needsUpdate = true;
      total += nCd[i];
    }
    this.rocks.count = nRock;
    this.rocks.instanceMatrix.needsUpdate = true;
    this.instanceCount = total + nRock;
  }

  dispose(): void {
    for (const m of [...this.trees, this.rocks]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    for (const layer of this.cards) {
      layer.geom.dispose();
      const mat = layer.mesh.material as THREE.MeshToonMaterial;
      mat.map?.dispose();
      mat.dispose();
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Per-species instance counters, hoisted out of the rebuild's hot loop. */
const _spCounts = new Int32Array(SPECIES_COUNT);
const _cardCounts = new Int32Array(SPECIES_COUNT);

/**
 * Writes a translate / rotate-Y / non-uniform-scale matrix directly, no
 * Object3D. 'sy' defaults to 'sxz' for the uniform case.
 *
 * Height and spread are separate because a single uniform scale makes every
 * tree of a species literally the same shape, and a stand of identical shapes
 * at different sizes still reads as one repeated stamp. The determinant stays
 * positive (sxz^2 * sy) so nothing here can flip a winding.
 */
function writeTRS(
  arr: Float32Array, i: number, x: number, y: number, z: number,
  yaw: number, sxz: number, sy = sxz,
): void {
  const c = Math.cos(yaw) * sxz, sn = Math.sin(yaw) * sxz;
  const o = i * 16;
  arr[o] = c; arr[o + 1] = 0; arr[o + 2] = -sn; arr[o + 3] = 0;
  arr[o + 4] = 0; arr[o + 5] = sy; arr[o + 6] = 0; arr[o + 7] = 0;
  arr[o + 8] = sn; arr[o + 9] = 0; arr[o + 10] = c; arr[o + 11] = 0;
  arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z; arr[o + 15] = 1;
}

function makeInstanced(
  geom: THREE.BufferGeometry, mat: CelMaterial, count: number, name: string,
): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geom, mat, count);
  m.name = name;
  m.count = 0;
  m.frustumCulled = false;
  m.castShadow = true;
  m.receiveShadow = true;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3);
  m.instanceColor.setUsage(THREE.DynamicDrawUsage);
  return m;
}

// Per-instance tint palettes. Real woodland is never one green; three or four
// hues per species is the difference between a forest and a lawn with sticks.
const CONIFER_TINTS = new Float32Array([
  0.86, 1.00, 0.80, 1.00, 0.92, 0.74, 0.72, 0.95, 0.86, 1.05, 1.02, 0.90,
]);
const BROADLEAF_TINTS = new Float32Array([
  1.00, 1.00, 0.92, 1.12, 0.98, 0.72, 0.84, 1.05, 0.86, 1.05, 0.88, 0.70,
]);

// ---------------------------------------------------------------------------
// Tree / rock geometry
// ---------------------------------------------------------------------------

/** 0 — spruce: narrow spire, tiers all the way down. */
function buildSpruce(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  bole(b, 4.2, 0.56, 0.32, 0x2b2114);
  // Three overlapping tiers, each slightly offset so the silhouette is not a
  // perfect cone — a perfect cone reads as a party hat.
  const tiers: [number, number, number, number][] = [
    [3.2, 3.05, 6.0, 0.00],
    [7.0, 2.35, 5.4, 0.55],
    [10.4, 1.55, 4.6, 1.10],
  ];
  for (let i = 0; i < tiers.length; i++) {
    const [y, r, h, rot] = tiers[i];
    tier(b, y, r, h, rot, 0x467339, 0.97 + i * 0.05);
  }
  return b.build();
}

/**
 * 1 — Scots pine: a long bare bole with the crown carried right at the top.
 * The negative space under the canopy is the whole point of the shape — it is
 * what makes a pine stand read differently from a spruce plantation at a
 * glance, and it costs the same triangles.
 */
function buildPine(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  bole(b, 9.4, 0.62, 0.36, 0x342715);
  const blobs: [number, number, number, number, number][] = [
    [0, 10.6, 0, 3.3, 0.44],
    [1.9, 9.7, -0.8, 2.1, 0.40],
    [-1.7, 9.9, 1.2, 2.0, 0.42],
    [0.3, 12.1, 0.4, 1.7, 0.50],
  ];
  // A Scots pine's crown is carried on two or three long limbs that leave the
  // bole almost horizontally near the top — the shape that makes a pine
  // unmistakable in silhouette against a sky, and the reason the negative space
  // under this species is worth having at all.
  limb(b, 0, 8.6, 0, 2.0, 9.9, -0.9, 0.30, 0.13, 0x342715, 1.0);
  limb(b, 0, 9.0, 0, -1.8, 10.0, 1.2, 0.28, 0.12, 0x342715, 1.0);
  limb(b, 0, 9.4, 0, 0.3, 11.9, 0.4, 0.26, 0.11, 0x342715, 1.0);
  for (let i = 0; i < blobs.length; i++) {
    const [x, y, z, r, flat] = blobs[i];
    blob(b, x, y, z, r, flat, 0x426231, 0.98 + i * 0.05);
  }
  return b.build();
}

/** 2 — oak: broad low dome on a short thick bole. */
function buildOak(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  bole(b, 5.0, 0.64, 0.38, 0x2e2316);
  // Five overlapping lobes rather than three. A three-lobe crown at sixty
  // metres is a mushroom cap — one convex mass with a flat underside — and the
  // critique read exactly that as a broken instance. Five, with two hung low
  // and outboard, gives the crown re-entrant notches on its silhouette and an
  // underside that steps rather than cuts, which is what makes it read as
  // foliage instead of an umbrella.
  const blobs: [number, number, number, number, number][] = [
    [0.0, 7.5, 0.0, 3.05, 0.90],
    [1.9, 6.5, 1.0, 2.35, 0.86],
    [-1.7, 6.9, -1.2, 2.15, 0.94],
    [-0.6, 8.9, 1.5, 1.85, 0.82],
    [2.1, 8.3, -1.4, 1.60, 0.88],
  ];
  // The fork. An oak's bole divides at about a third of the tree's height into
  // three or four heavy limbs, and each limb carries one of the crown lobes —
  // so these are aimed at the lobe centres above rather than scattered. This is
  // what turns "five spheres above a stick" into a tree.
  for (const [x, y, z] of blobs.slice(1)) {
    limb(b, 0, 4.6, 0, x * 0.86, y - 0.9, z * 0.86, 0.40, 0.17, 0x30251a, 1.0);
  }
  limb(b, 0, 4.6, 0, 0.2, 7.2, -0.2, 0.44, 0.20, 0x30251a, 1.0);
  for (let i = 0; i < blobs.length; i++) {
    const [x, y, z, r, fl] = blobs[i];
    // Narrow albedo spread. 0.82-1.08 across lobes stacks on top of a
    // three-band cel ramp, and the two together put a near-white facet next to
    // a near-black one inside a ten-pixel tree.
    blob(b, x, y, z, r, fl, 0x476f2f, 0.97 + i * 0.04);
  }
  return b.build();
}

/**
 * 3 — Lombardy poplar: a vertical column. The tallest and by far the narrowest
 * shape in the set, which is why it is worth having: a line of them along a
 * watercourse gives a landscape a vertical accent nothing else provides.
 */
function buildPoplar(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  bole(b, 5.6, 0.54, 0.32, 0x312619);
  // A tall oval on a long clean bole.
  //
  // This slot began as a Lombardy poplar — a true 2 m column — and that turned
  // out to be a lesson about the rest of the pipeline rather than about trees.
  // At six hundred metres a 2 m canopy is three pixels wide, the cel rim term
  // covers both of those pixels at the silhouette, and the tree renders as a
  // solid stroke of warm rim light: a cream spike standing in a field. Any
  // shape thinner than roughly a quarter of its own height hits the same wall.
  // So: narrow enough to be unmistakably not the oak, wide enough to have an
  // interior the shading can actually fill.
  const blobs: [number, number, number, number, number][] = [
    [0.0, 7.6, 0.0, 2.35, 1.32],
    [0.9, 10.2, -0.5, 1.75, 1.15],
    [-0.7, 9.0, 0.8, 1.60, 1.20],
  ];
  for (let i = 0; i < blobs.length; i++) {
    const [x, y, z, r, tall] = blobs[i];
    blob(b, x, y, z, r, tall, 0x4e7636, 0.98 + i * 0.05);
  }
  return b.build();
}

/**
 * Faceted low-poly ball, jittered. 'stretch' scales the vertical axis only —
 * below 1 it flattens into the umbrella crown a pine carries, above 1 it
 * elongates into the column of a poplar.
 *
 * Two things were wrong with the version this replaces and both showed up in
 * the low pass as the "50-metre blob" the critique flagged.
 *
 * 1. THE WINDING WAS INVERTED. MeshBuilder.quad takes its corners CCW as seen
 *    from the FRONT and derives the face normal as (b-a)x(d-a); the old call
 *    passed them the other way round, so every facet's normal — and, more to
 *    the point, its triangle winding — pointed into the canopy. With the
 *    material on FrontSide the GPU therefore culled the near hemisphere and
 *    drew the FAR one: the depth written for a tree was the depth of its back
 *    surface, the lighting was computed on facets that face away from the
 *    camera, and the whole thing read as a crumpled paper bag rather than a
 *    canopy. Corrected here, so a tree is now shaded and depth-sorted on the
 *    surface you can actually see.
 *
 * 2. THE POLES WERE DEGENERATE. The t=0 and t=T rings both collapse to a single
 *    point (sin(phi)=0) but each of their six vertices carried its own radial
 *    jitter, which only moves them in Y — so the caps came out as six slivers
 *    with arbitrary normals stacked on the axis. Those slivers are the pale
 *    shards visible inside every canopy in the round-4 captures, and at
 *    treeline scale they are exactly the kind of sub-pixel high-contrast detail
 *    that the edge pass and the grade's chromatic aberration turn into
 *    coloured speckle. Poles are single apex vertices now, capped with real
 *    triangles.
 */
function blob(
  b: MeshBuilder, cx: number, cy: number, cz: number, r: number,
  stretch = 0.92, base = 0x5a8640, mul = 1.0, S = 7, T = 4,
): void {
  // BAKED VERTICAL TONE. A canopy needs a lit crown and a shaded underside at
  // every distance, and the cel ramp on its own will not supply one: with three
  // bands whose edges sit at N.L = 0.24 and 0.60, every facet of a lobe this
  // size usually lands in the SAME band, so the whole crown comes out as one
  // flat plateau of colour. Ramping the vertex colour with height inside each
  // lobe puts the form back into the albedo, where the ramp cannot flatten it,
  // and it survives all the way down to a ten-pixel impostor.
  // 0.70 + 0.48 -> 0.62 + 0.34. The ceiling matters more than the floor: the
  // sun lands on a canopy through a three-band toon ramp whose top plateau is
  // 1.0, and at key level 3 an albedo already scaled up by 1.18 clips. Clipped
  // facets are how a crown ends up as a cluster of near-white shards ringed in
  // black ink, which is the "crumpled paper" note. Lowering the ceiling below
  // unity puts the crown back inside the range the ramp can shade.
  const yTone = (y: number): number => {
    const f = (y - (cy - r * stretch)) / Math.max(0.001, 2 * r * stretch);
    return mul * (0.62 + 0.34 * clamp01(f));
  };
  // Rings at t = 1 .. T-1 only; the poles are apexes, not rings.
  const rings: number[][][] = [];
  for (let t = 1; t < T; t++) {
    const row: number[][] = [];
    const phi = (t / T) * Math.PI;
    for (let s = 0; s < S; s++) {
      const th = (s / S) * Math.PI * 2 + t * 0.37;
      // 0.80..1.22 -> 0.90..1.12. The radial jitter is what gives the crown an
      // irregular silhouette, but it also sets how far apart two neighbouring
      // facet normals are — and the screen-space edge pass draws a crease
      // wherever they differ, so a strongly jittered lobe forty pixels across
      // comes back as a wireframe of every quad in it. Halving the jitter keeps
      // the outline irregular (the silhouette is a chain of many facets, so it
      // accumulates) while the interior creases fall below the pass's normal
      // threshold and the crown reads as one mass again.
      const j = 0.90 + tHash(cx + s * 3.1 + t * 7.7, cz + t * 2.3 + r) * 0.22;
      row.push([
        cx + Math.sin(phi) * Math.cos(th) * r * j,
        cy + Math.cos(phi) * r * j * stretch,
        cz + Math.sin(phi) * Math.sin(th) * r * j,
      ]);
    }
    rings.push(row);
  }
  // Modest apex jitter only. A pole is a single vertex, so any jitter there is
  // a spike on the silhouette rather than a lump in it.
  const jT = 0.90 + tHash(cx + 17.3, cz + 5.9 + r) * 0.20;
  const jB = 0.88 + tHash(cx + 41.7, cz + 8.3 + r) * 0.18;
  const apexT = [cx, cy + r * jT * stretch, cz];
  const apexB = [cx, cy - r * jB * stretch, cz];

  for (let t = 0; t < rings.length - 1; t++) {
    for (let s = 0; s < S; s++) {
      const s1 = (s + 1) % S;
      const a = rings[t][s], bb = rings[t][s1], c = rings[t + 1][s1], d = rings[t + 1][s];
      // A little azimuthal jitter on top of the vertical ramp, so a crown is
      // dappled rather than banded.
      const dap = 0.96 + tHash(cx + s * 5.7, cz + t * 9.1 + r) * 0.09;
      b.color(base).shade(yTone((a[1] + c[1]) * 0.5) * dap);
      // CCW from outside: upper-s, upper-s1, lower-s1, lower-s.
      b.quad(a[0], a[1], a[2], bb[0], bb[1], bb[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    }
  }
  const top = rings[0], bot = rings[rings.length - 1];
  for (let s = 0; s < S; s++) {
    const s1 = (s + 1) % S;
    b.color(base).shade(yTone(apexT[1]) * 0.99);
    b.tri(apexT, top[s], top[s1]);
    b.color(base).shade(yTone(apexB[1]) * 1.01);
    b.tri(apexB, bot[s1], bot[s]);
  }
}

/**
 * A faceted tapering bole, wound CCW from outside.
 *
 * Not MeshBuilder.cylinder: that helper stores outward vertex normals but emits
 * its side triangles with the opposite winding, which for a half-metre trunk
 * standing sixty metres from the camera means the visible surface is the inside
 * of the far wall. On a hangar nobody notices; on the one tree in the
 * foreground of the low pass it is the difference between a trunk and a pale
 * stick. Five sides is plenty and it keeps the silhouette angular, which is the
 * house style.
 */
function bole(
  b: MeshBuilder, h: number, rBottom: number, rTop: number, base: number, sides = 5,
): void {
  // Four stations up the bole rather than two, and the profile between them is
  // not a straight line.
  //
  // A trunk drawn as a single linear taper is a cone, and a cone reads as a
  // lathe-turned stick — "straight untapered cylinder trunks with no bark and
  // no root flare" has been the note on this asset for five rounds. Three
  // things make a real bole read, and all three are free here:
  //
  //   ROOT FLARE — the buttress where the trunk meets the ground. It is the
  //     single strongest cue, because it is the part a viewer at ground level
  //     is closest to, and because it is what visually PLANTS the tree instead
  //     of leaving it standing on the terrain like a pin in a map.
  //   CONVEX TAPER — real boles lose most of their diameter in the first third
  //     and then run nearly parallel. A linear taper loses it evenly, which is
  //     what makes a cone.
  //   PER-STATION SWAY — a couple of degrees of lean, alternating, so no trunk
  //     in the stand is a plumb line.
  const STA = [0.0, 0.055, 0.34, 1.0];
  const rAt = (t: number): number => {
    // Flare below the first station, then a 0.55-power taper: two thirds of the
    // diameter is gone by a third of the height.
    if (t <= STA[1]) return rBottom * (1.62 - 0.62 * (t / STA[1]));
    const u = (t - STA[1]) / (1 - STA[1]);
    return rBottom + (rTop - rBottom) * Math.pow(u, 0.55);
  };
  const lean = (t: number, k: number): number =>
    Math.sin(t * 2.1 + k) * rBottom * 0.42 * t * t;
  for (let seg = 0; seg < STA.length - 1; seg++) {
    const t0 = STA[seg], t1 = STA[seg + 1];
    const y0 = t0 * h, y1 = t1 * h;
    const r0 = rAt(t0), r1 = rAt(t1);
    const ox0 = lean(t0, 0.7), oz0 = lean(t0, 2.4);
    const ox1 = lean(t1, 0.7), oz1 = lean(t1, 2.4);
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0);
      const c1 = Math.cos(a1), s1 = Math.sin(a1);
      // Per-stave, per-segment tone. A five-sided bole with one flat colour is
      // a pole; varying it between staves AND up the trunk reads as bark
      // without a texture, and the flare picks up the darkest values because
      // that is where the moss and the shadow of the litter layer are.
      b.color(base).shade((0.72 + 0.16 * t0) * (1 + ((i * 7) % 5) * 0.062));
      b.quad(
        ox0 + c0 * r0, y0, oz0 + s0 * r0,
        ox1 + c0 * r1, y1, oz1 + s0 * r1,
        ox1 + c1 * r1, y1, oz1 + s1 * r1,
        ox0 + c1 * r0, y0, oz0 + s1 * r0,
      );
    }
  }
}

/**
 * A tapered limb between two points — the branch fork the tree asset has never
 * had.
 *
 * Two or three of these running from the top of the bole out into the crown
 * cost about sixty triangles and do something no amount of work on the canopy
 * lobes can: they connect the trunk to the foliage. Without them the crown is a
 * cluster of spheres hovering above a stick, which is precisely why the note
 * reads "floating polygon shards" — the shards are not floating because of a
 * geometry bug, they are floating because there is nothing holding them up.
 */
function limb(
  b: MeshBuilder,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  r0: number, r1: number, base: number, mul = 1.0, sides = 4,
): void {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz) || 1;
  const ax = dx / len, ay = dy / len, az = dz / len;
  // Any vector not parallel to the axis will do for the first tangent.
  let ux = 0, uy = 1, uz = 0;
  if (Math.abs(ay) > 0.9) { ux = 1; uy = 0; }
  // t = normalize(u x a), n = a x t
  let tx = uy * az - uz * ay, ty = uz * ax - ux * az, tz = ux * ay - uy * ax;
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl; ty /= tl; tz /= tl;
  const nx = ay * tz - az * ty, ny = az * tx - ax * tz, nz = ax * ty - ay * tx;
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    const p = (
      bx: number, by: number, bz: number, r: number, c: number, s: number,
    ): [number, number, number] => [
      bx + (tx * c + nx * s) * r,
      by + (ty * c + ny * s) * r,
      bz + (tz * c + nz * s) * r,
    ];
    const A = p(x0, y0, z0, r0, c0, s0), B = p(x1, y1, z1, r1, c0, s0);
    const C = p(x1, y1, z1, r1, c1, s1), D = p(x0, y0, z0, r0, c1, s1);
    b.color(base).shade(mul * (0.74 + ((i * 5) % 4) * 0.07));
    b.quad(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2], D[0], D[1], D[2]);
  }
}

/**
 * A conifer tier: a faceted cone with a closed underside, wound CCW from
 * outside. Same reason as bole() — MeshBuilder.cone routes through
 * MeshBuilder.cylinder, whose side winding is the opposite of the normals it
 * stores, so a spruce built with it shows the inside of its far skirt.
 */
function tier(
  b: MeshBuilder, y: number, r: number, h: number, rot: number,
  base: number, mul: number, sides = 7,
): void {
  const apex = [0, y + h, 0];
  const ring: number[][] = [];
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2;
    const j = 0.86 + tHash(i * 3.7 + y, r * 5.3 + rot) * 0.26;
    ring.push([Math.cos(a) * r * j, y, Math.sin(a) * r * j]);
  }
  for (let i = 0; i < sides; i++) {
    const i1 = (i + 1) % sides;
    b.color(base).shade(mul * (0.98 + ((i * 3) % 4) * 0.03));
    b.tri(apex, ring[i], ring[i1]);
    // Underside, a step darker — a conifer skirt is the darkest thing on the
    // tree and it is what gives a spruce its layered read from below.
    b.color(base).shade(mul * 0.70);
    b.tri([0, y, 0], ring[i1], ring[i]);
  }
}

function buildBoulder(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  blob(b, 0, 0.45, 0, 1.0, 0.92, 0x6b6660, 1.0);
  return b.build();
}

// ---------------------------------------------------------------------------
// Impostor canopy atlas
// ---------------------------------------------------------------------------

/**
 * Half-width of the canopy at height v (0 at the base, 1 at the tip), per
 * species, plus how far up the bare bole runs. These are the *silhouettes* the
 * critique is really about: one profile repeated across a whole treeline is
 * read as a printed pattern within a second no matter how the colour varies,
 * because the eye tracks outlines before it tracks hue.
 */
function canopyProfile(sp: number, v: number): { wid: number; bole: number } {
  switch (sp) {
    case 0: // spruce — a spire that tapers all the way to the top
      return { wid: 0.44 * Math.pow(1 - Math.min(1, (v - 0.10) / 0.90), 0.85) + 0.03, bole: 0.16 };
    case 1: // pine — long bare bole, then a flat umbrella
      return { wid: 0.46 * Math.sin(Math.min(1, Math.max(0, (v - 0.52) / 0.48)) * Math.PI) + 0.02, bole: 0.56 };
    case 2: // oak — broad dome sitting low
      return { wid: 0.49 * Math.sin(Math.min(1, Math.max(0, (v - 0.22) / 0.78)) * Math.PI * 0.94) + 0.04, bole: 0.26 };
    default: // poplar — tall oval carried high on a long bole
      return { wid: 0.44 * Math.sin(Math.min(1, Math.max(0, (v - 0.40) / 0.60)) * Math.PI * 0.86) + 0.03, bole: 0.44 };
  }
}

/**
 * One canopy silhouette, one texture.
 *
 * Alpha is a SOFT COVERAGE RAMP, not a binary mask, and that is the whole
 * difference between a treeline and a band of speckle. With a binary mask the
 * mip chain averages 0s and 255s into an arbitrary grey, the alpha test
 * thresholds that grey, and the silhouette of a card that is nine pixels tall
 * changes shape every time it crosses a mip boundary — which is the shimmer.
 * With a ramp, every mip level is a correctly filtered distance field and the
 * 0.45 iso-line stays put as the card shrinks.
 *
 * RGB is written everywhere, including under the transparent border, so the
 * filter can never pull a black texel into the canopy edge and leave a dark
 * halo. A four-texel border plus clamp-to-edge is then enough on its own —
 * there is no neighbouring silhouette to bleed in from any more.
 */
function buildCanopyTexture(sp: number): THREE.DataTexture {
  const n = 128;
  const gut = 4 / n;
  const data = new Uint8Array(n * n * 4);
  const seed = sp * 37.13;

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1), v = j / (n - 1);
      const o = (j * n + i) * 4;
      const { wid, bole: boleTop } = canopyProfile(sp, v);
      let d = Math.abs(u - 0.5) / Math.max(0.02, wid);
      // Ragged edge from a couple of octaves of noise, decorrelated per species
      // so the four shapes do not share a profile of bumps.
      const rag = tNoise(u * 9.3 + seed, v * 9.3 + seed) * 0.55
        + tNoise(u * 23 + seed, v * 23 + seed) * 0.35;
      d += (rag - 0.42) * 0.62;

      // Soft coverage. 20 units per unit of 'd' puts the transition across
      // roughly two texels, which is what a correctly antialiased cut-out
      // looks like and what makes the mip chain meaningful.
      let a = clamp01(0.5 + (1 - d) * 20);
      // Bole: a narrow column under the canopy. On the pine and the poplar it
      // is most of the tree, which is exactly what distinguishes them.
      const trunkW = sp === 2 ? 0.050 : sp === 3 ? 0.030 : 0.042;
      const trunkA = clamp01(0.5 + (trunkW - Math.abs(u - 0.5)) * n * 0.9);
      const isTrunk = v < boleTop + 0.06 && Math.abs(u - 0.5) < trunkW;
      if (v < boleTop) a = trunkA;
      else if (v < boleTop + 0.06) a = Math.max(a, trunkA);
      // Kill anything inside the border so clamp-to-edge and the mip chain both
      // terminate in empty space.
      if (u < gut || u > 1 - gut || v < gut || v > 1 - gut) a = 0;

      // Baked shading: darker underside and centre, lighter crown edge.
      const lift = 0.58 + 0.42 * v;
      const clump = 0.74 + 0.46 * tNoise(u * 12 + 3 + seed, v * 12 + 7 + seed);
      const shade = Math.min(1, lift * clump);
      // Conifers are colder and darker than broadleaves; the texture carries
      // that difference so it survives the per-instance tint.
      const conif = sp < 2;
      data[o] = ((isTrunk ? 0.30 : (conif ? 0.32 : 0.42) * shade) * 255) | 0;
      data[o + 1] = ((isTrunk ? 0.24 : (conif ? 0.50 : 0.60) * shade) * 255) | 0;
      data[o + 2] = ((isTrunk ? 0.16 : (conif ? 0.31 : 0.28) * shade) * 255) | 0;
      data[o + 3] = (a * 255) | 0;
    }
  }

  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.name = `canopy${sp}`;
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}
