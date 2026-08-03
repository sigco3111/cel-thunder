/**
 * Aircraft assembly: turns an 'AircraftSpec' into a fully articulated,
 * cel-shaded, three-level LOD model with a distant imposter.
 *
 * Strategy
 * --------
 * Geometry and textures are expensive and identical for every aircraft of a
 * type, so a *template* is built once per type and then 'clone()'d per
 * instance. three's clone shares geometry and material references, so twenty
 * Spitfires cost twenty scene graphs and one set of buffers. Named part
 * references are re-bound after cloning by walking the clone and reading
 * 'userData.part', which survives cloning because it is a plain string.
 *
 * Draw-call budget
 * ----------------
 * Everything static at a given LOD is merged into one geometry. At LOD0 the
 * pieces that must stay separate are the ones that move (control surfaces,
 * gear, propeller, canopy) or that can be shot away (outer wing panels,
 * tailplanes). At LOD2 the entire aircraft is a single mesh with no outline.
 *
 * Sign conventions for the animation helpers
 * ------------------------------------------
 * Every hinge is driven by 'rotation.x' in its own pivot frame.
 *   - Ailerons use *outboard* hinge axes, so the same rotation raises the
 *     starboard trailing edge and lowers the port one: roll right.
 *   - Elevators, flaps and the rudder use a common axis, so the same rotation
 *     moves them together.
 * That is why 'setControlSurfaces' can apply one number per group.
 */

import * as THREE from 'three';
import type { AircraftSpec } from '../../shared/aircraft';
import { AIRCRAFT, AIRCRAFT_BY_ID } from '../../shared/aircraft';
import { DamageBits } from '../../shared/protocol';
import {
  LAYER_BLOOM, LAYER_COCKPIT, LAYER_INK,
  addOutlinesRecursive, createCelMaterial,
} from '../../render/CelMaterial';
import type { CelMaterial } from '../../render/CelMaterial';
import {
  damageBox, finUv, fuseUv, htailUv, swatchBox, wingUv,
} from '../textures/atlas';
import type { DamageDecal } from '../textures/atlas';
import { buildDamageAtlas } from '../textures/damageAtlas';
import { buildGaugeAtlas } from '../textures/instruments';
import { buildLivery } from '../textures/livery';
import type { LiveryMaps } from '../textures/livery';
import { ctx2d, makeCanvas } from '../textures/canvas2d';
import { FuselageProfile, buildCowl, buildFuselageSkin } from './fuselage';
import { WingPlan, buildLiftingSurface, buildWingFillet } from './wing';
import type { SurfaceCut } from './wing';
import { foilsFor, naca } from './naca';
import { MeshBuilder, boxGeom, makeHinge, mergeGeoms, quadGeom, triCount, trs } from './geom';
import { buildCanopy, canopyOpening, makeGlassStreakTexture } from './canopy';
import { buildCockpit, buildCockpitAtlas } from './cockpit';
import { buildPropeller, createPropDiscMaterial } from './propeller';
import { buildGear } from './gear';
import { buildDetails } from './details';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DamageParts {
  wingOuterL: THREE.Object3D;
  wingOuterR: THREE.Object3D;
  aileronL: THREE.Object3D;
  aileronR: THREE.Object3D;
  flapL: THREE.Object3D;
  flapR: THREE.Object3D;
  elevatorL: THREE.Object3D;
  elevatorR: THREE.Object3D;
  tailplaneL: THREE.Object3D;
  tailplaneR: THREE.Object3D;
  rudder: THREE.Object3D;
  fin: THREE.Object3D;
  canopyGlass: THREE.Object3D;
  spinner: THREE.Object3D;
  propBlades: THREE.Object3D;
  gearDoorL: THREE.Object3D;
  gearDoorR: THREE.Object3D;
  [key: string]: THREE.Object3D;
}

export interface AircraftModel {
  spec: AircraftSpec;
  /** Attach this to the scene. */
  root: THREE.Group;
  lod: THREE.LOD;

  propeller: THREE.Object3D;
  propDisc: THREE.Object3D;
  spinner: THREE.Object3D;
  aileronL: THREE.Object3D;
  aileronR: THREE.Object3D;
  elevatorL: THREE.Object3D;
  elevatorR: THREE.Object3D;
  rudder: THREE.Object3D;
  flapL: THREE.Object3D;
  flapR: THREE.Object3D;
  gearL: THREE.Object3D;
  gearR: THREE.Object3D;
  gearTail: THREE.Object3D;
  gearDoorL: THREE.Object3D;
  gearDoorR: THREE.Object3D;
  wheelL: THREE.Object3D;
  wheelR: THREE.Object3D;
  wheelTail: THREE.Object3D;
  canopy: THREE.Object3D;
  pilot: THREE.Object3D;
  exhaustPorts: THREE.Object3D[];
  gunPorts: THREE.Object3D[];
  wingtipL: THREE.Object3D;
  wingtipR: THREE.Object3D;
  /** Cockpit camera anchor. */
  eyePoint: THREE.Object3D;
  /** Instrument needles, keyed by gauge name. */
  needles: Record<string, THREE.Object3D>;
  damageParts: DamageParts;

  /** All objects sharing a part name, across every LOD level. */
  parts: Map<string, THREE.Object3D[]>;

  // mutable animation state
  propAngle: number;
  wheelAngle: number;
  decals: THREE.Mesh[];
}

export interface BuildOptions {
  /** Livery sheet size. 2048 is the shipping value; 1024 halves memory. */
  textureSize?: number;
  /** Camouflage field resolution divisor. Higher = faster, softer edges. */
  fieldDiv?: number;
  seed?: number;
}

// ---------------------------------------------------------------------------
// Level-of-detail configuration
// ---------------------------------------------------------------------------

interface Detail {
  level: number;
  fuseRings: number; fuseSegs: number;
  wingSpan: number; wingChord: number;
  tailSpan: number; tailChord: number;
  finSpan: number; finChord: number;
  filletStations: number; filletSteps: number;
  cockpit: boolean; gear: boolean; details: boolean; canopy: boolean; splitWing: boolean;
}

const DETAILS: Detail[] = [
  {
    level: 0, fuseRings: 26, fuseSegs: 26, wingSpan: 12, wingChord: 30,
    tailSpan: 8, tailChord: 20, finSpan: 8, finChord: 18,
    filletStations: 12, filletSteps: 6,
    cockpit: true, gear: true, details: true, canopy: true, splitWing: true,
  },
  {
    level: 1, fuseRings: 14, fuseSegs: 14, wingSpan: 7, wingChord: 16,
    tailSpan: 5, tailChord: 10, finSpan: 5, finChord: 10,
    filletStations: 6, filletSteps: 3,
    cockpit: false, gear: true, details: true, canopy: true, splitWing: false,
  },
  {
    level: 2, fuseRings: 8, fuseSegs: 9, wingSpan: 4, wingChord: 8,
    tailSpan: 3, tailChord: 6, finSpan: 3, finChord: 6,
    filletStations: 0, filletSteps: 0,
    cockpit: false, gear: false, details: false, canopy: false, splitWing: false,
  },
];

/** LOD switch distances, metres. */
const LOD_DIST = [0, 260, 1100];
const IMPOSTER_DIST = 6000;

/** Where the outer wing panel starts — outboard of every flap, inboard of none. */
const WING_SPLIT = 0.52;

// ---------------------------------------------------------------------------
// Shared (cross-type) assets
// ---------------------------------------------------------------------------

interface SharedAssets {
  gauge: ReturnType<typeof buildGaugeAtlas>;
  damage: ReturnType<typeof buildDamageAtlas>;
  glassStreak: THREE.CanvasTexture;
  dialMat: CelMaterial;
  decalMat: CelMaterial;
  lightMats: Map<number, CelMaterial>;
}
let shared: SharedAssets | null = null;

function getShared(): SharedAssets {
  if (shared) return shared;
  const gauge = buildGaugeAtlas(31);
  const damage = buildDamageAtlas(97);
  const glassStreak = makeGlassStreakTexture();
  const dialMat = createCelMaterial({
    map: gauge.texture, bands: 2, bandSoftness: 0.09, gloss: 0.12,
    specular: 0.75, specSteps: 1, rimStrength: 0.25, name: 'aircraftDials',
  });
  const decalMat = createCelMaterial({
    map: damage.texture, transparent: true, alphaTest: 0.03, depthWrite: false,
    bands: 3, gloss: 0.5, specular: 0.35, name: 'aircraftDamageDecal',
  });
  shared = { gauge, damage, glassStreak, dialMat, decalMat, lightMats: new Map() };
  return shared;
}

function lightMaterial(color: number): CelMaterial {
  const s = getShared();
  const hit = s.lightMats.get(color);
  if (hit) return hit;
  const m = createCelMaterial({
    color, emissive: color, emissiveIntensity: 1.35, bands: 2,
    gloss: 0.05, specular: 1.4, specSteps: 1, name: `navLight_${color.toString(16)}`,
  });
  s.lightMats.set(color, m);
  return m;
}

// ---------------------------------------------------------------------------
// Roughness modulation
// ---------------------------------------------------------------------------

/**
 * Feed the generated roughness map into the shared cel material.
 *
 * MeshToonMaterial (which 'createCelMaterial' extends) has no roughness slot, so
 * the map is injected as an extra sampler that scales the stepped specular:
 * matte camouflage loses almost all of its highlight, bare metal and polished
 * oleo legs keep theirs, and soot-covered panels go dead. Without this the
 * whole airframe has one gloss and reads as plastic.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. The cel material's specular is *hard
 * quantised* — 'floor(spec * steps + 0.5) / steps' — and an aircraft's upper
 * wing skin is very nearly a single plane. So the whole panel crosses the step
 * threshold at once and the entire wing snaps to a flat additive white sheet
 * that is not modulated by albedo at all. Dark Earth sits at about 0.15 in
 * linear light; a 0.5-step at strength 0.6 adds 0.3. The camouflage, the panel
 * lines, the stencilling and the roundel all vanish under it and the aircraft
 * reads as pale blue-white plastic. Attenuating by the roughness map is what
 * keeps that highlight on the cowl fillet and the canopy rail, where it
 * belongs, and off two square metres of matte paint.
 *
 * The patch chains onto whatever 'createCelMaterial' installed. It has to find
 * the accumulate line to work, and that line has moved between accumulators
 * before (specular → diffuse, because three's toon shader never reads
 * directSpecular), so both spellings are tried and a miss is reported once
 * rather than failing silently — a silently-dropped patch is exactly how the
 * washout survived a review.
 */
let roughWarned = false;

function attachRoughness(mat: CelMaterial, tex: THREE.Texture): void {
  const base = mat.onBeforeCompile;
  const baseKey = mat.customProgramCacheKey;
  const uniform = { value: tex };
  mat.onBeforeCompile = (shader, renderer) => {
    base.call(mat, shader, renderer);
    shader.uniforms.uCelRough = uniform;
    let fs = shader.fragmentShader;
    // The depth/normal prepass reuses this material's 'onBeforeCompile' with a
    // completely different, unlit shader. It has no specular term to attenuate,
    // so recognise it and leave it alone rather than reporting a false miss.
    if (!fs.includes('uniform float uHatchScale;')) return;
    fs = fs.replace(
      'uniform float uHatchScale;',
      'uniform float uHatchScale;\nuniform sampler2D uCelRough;',
    );

    // '.g' because the roughness canvas is greyscale; sampling one channel
    // keeps the door open to packing something else into r/b later.
    const attenuated = (acc: string) =>
      `float celRough = texture2D( uCelRough, vMapUv ).g;\n`
      + `${acc} += uSunColor * sq * uSpecular * ( 1.0 - celRough * 0.94 );`;

    let hit = false;
    for (const acc of ['reflectedLight.directDiffuse', 'reflectedLight.directSpecular']) {
      const marker = `${acc} += uSunColor * sq * uSpecular;`;
      if (fs.includes(marker)) { fs = fs.replace(marker, attenuated(acc)); hit = true; break; }
    }
    if (!hit && !roughWarned) {
      roughWarned = true;
      console.warn(
        '[aircraft] the cel material no longer contains the stepped-specular '
        + 'accumulate line; roughness attenuation is inactive and painted '
        + 'surfaces will show a full-strength highlight.',
      );
    }
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => `${baseKey.call(mat)}|rough`;
}

// ---------------------------------------------------------------------------
// Planform construction from the spec
// ---------------------------------------------------------------------------

interface Plans { wing: WingPlan; htail: WingPlan; fin: WingPlan }

function makePlans(spec: AircraftSpec, prof: FuselageProfile): Plans {
  const g = spec.geom;
  const foils = foilsFor(spec.id);

  const wing = new WingPlan({
    semi: spec.aero.span * 0.5,
    rootChord: g.wing.rootChord,
    tipChord: g.wing.tipChord,
    sweep: g.wing.sweep,
    dihedral: g.wing.dihedral,
    incidence: g.wing.incidence,
    // ~2.6° of washout: standard for these types, and it is what keeps the
    // stall breaking at the root so the ailerons stay effective.
    washout: -0.045,
    z0: g.wingZ,
    y0: g.wingY,
    elliptical: g.ellipticalWing,
    foilRoot: foils.root,
    foilTip: foils.tip,
    tipRound: 0.955,
  });

  const htail = new WingPlan({
    semi: g.hStab.span * 0.5,
    rootChord: g.hStab.chord * 1.28,
    tipChord: g.hStab.chord * 0.62,
    sweep: 0.11,
    dihedral: 0.02,
    incidence: -0.012,
    washout: 0,
    z0: g.hStab.z,
    y0: prof.at(g.hStab.z).yc + prof.R * 0.06,
    elliptical: false,
    foilRoot: foils.tail,
    foilTip: naca('0008'),
    tipRound: 0.90,
  });

  const fin = new WingPlan({
    semi: g.vStab.height,
    rootChord: g.vStab.chord * 1.05,
    tipChord: g.vStab.chord * 0.60,
    // A modest quarter-chord sweep: fins of this era have a strongly swept
    // *leading* edge, which falls out of the chord taper, not out of sweeping
    // the whole surface back like a jet fin.
    sweep: 0.20,
    dihedral: 0,
    incidence: 0,
    washout: 0,
    z0: g.vStab.z,
    y0: prof.topY(g.vStab.z) - 0.04,
    elliptical: false,
    foilRoot: foils.fin,
    foilTip: naca('0008'),
    tipRound: 0.78,
    vertical: true,
  });

  return { wing, htail, fin };
}

function makeCuts(): { aileron: SurfaceCut; flap: SurfaceCut; elevator: SurfaceCut; rudder: SurfaceCut } {
  return {
    aileron: { name: 'aileron', eta0: 0.56, eta1: 0.93, hinge: 0.76, mirrored: true },
    flap: { name: 'flap', eta0: 0.14, eta1: 0.50, hinge: 0.74, mirrored: false },
    elevator: { name: 'elevator', eta0: 0.05, eta1: 0.95, hinge: 0.56, mirrored: false },
    rudder: { name: 'rudder', eta0: 0.02, eta1: 0.94, hinge: 0.54, mirrored: false },
  };
}

// ---------------------------------------------------------------------------
// Dorsal fin fairing
// ---------------------------------------------------------------------------

/**
 * The fairing that blends the fin leading edge forward onto the spine. Small,
 * but its absence is instantly readable as "the fin was pasted on".
 */
function buildDorsalFin(prof: FuselageProfile, fin: WingPlan, detail: Detail): THREE.BufferGeometry {
  const n = Math.max(3, detail.finSpan);
  const zLE = fin.leZAt(0);
  const zEnd = zLE + fin.o.rootChord * 0.85;
  const hRoot = fin.run * 0.30;
  const b = new MeshBuilder();
  b.addGrid(n + 1, 3, (i, j, o) => {
    const t = i / n;
    const z = zLE + (zEnd - zLE) * t;
    const top = prof.topY(z);
    const h = hRoot * Math.pow(1 - t, 1.7);
    const w = prof.R * 0.055 * (1 - t) + 0.004;
    o.x = (j - 1) * w * (1 - Math.abs(j - 1) * 0.0);
    o.y = top + (j === 1 ? h : h * 0.55);
    o.z = z;
    const [u, v] = fuseUv(prof.tOfZ(z), 0.5 + (j - 1) * 0.02);
    o.u = u; o.v = v;
  });
  return b.build(true);
}

// ---------------------------------------------------------------------------
// Imposter
// ---------------------------------------------------------------------------

/**
 * Beyond 6 km an aircraft covers a couple of pixels. Rendering 18 000 triangles
 * to produce two dark pixels is the single easiest thing to get wrong in a
 * furball, so past that range the LOD swaps to a billboard whose texture is a
 * soft, correctly proportioned planform blob tinted with the aircraft's own
 * camouflage. It reads exactly like a distant contact and costs one quad.
 */
function makeImposterTexture(spec: AircraftSpec): THREE.CanvasTexture {
  const S = 64;
  const c = makeCanvas(S, S);
  const g = ctx2d(c);
  g.clearRect(0, 0, S, S);
  const col = spec.livery.camoA;
  const rgb = `${(col >> 16) & 255},${(col >> 8) & 255},${col & 255}`;
  // Wing band.
  const grdW = g.createLinearGradient(0, 0, S, 0);
  grdW.addColorStop(0, `rgba(${rgb},0)`);
  grdW.addColorStop(0.18, `rgba(${rgb},0.85)`);
  grdW.addColorStop(0.82, `rgba(${rgb},0.85)`);
  grdW.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grdW;
  g.fillRect(0, S * 0.44, S, S * 0.12);
  // Fuselage.
  const grdF = g.createLinearGradient(0, 0, 0, S);
  grdF.addColorStop(0, `rgba(${rgb},0)`);
  grdF.addColorStop(0.22, `rgba(${rgb},0.95)`);
  grdF.addColorStop(0.86, `rgba(${rgb},0.7)`);
  grdF.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grdF;
  g.fillRect(S * 0.45, 0, S * 0.10, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

interface Template {
  spec: AircraftSpec;
  root: THREE.Group;
  maps: LiveryMaps;
  materials: THREE.Material[];
  geometries: THREE.BufferGeometry[];
  textures: THREE.Texture[];
  triangles: number[];
}

const templates = new Map<string, Template>();

function tag(o: THREE.Object3D, part: string, noOutline = false): THREE.Object3D {
  o.userData.part = part;
  if (noOutline) o.userData.noOutline = true;
  o.name = part;
  return o;
}

function mesh(
  geo: THREE.BufferGeometry, mat: THREE.Material, part: string, noOutline = false,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  tag(m, part, noOutline);
  return m;
}

function buildTemplate(spec: AircraftSpec, opts: BuildOptions): Template {
  const prof = new FuselageProfile(spec);
  const plans = makePlans(spec, prof);
  const cuts = makeCuts();
  const seed = (opts.seed ?? 0) + hashString(spec.id);

  // Details are built first at full detail because the livery needs the exhaust
  // and gun positions to know where to put the soot.
  const detailsLod0 = buildDetails(spec, prof, plans.wing, plans.fin, 0);

  const maps = buildLivery({
    spec, prof, wing: plans.wing, htail: plans.htail, fin: plans.fin,
    exhausts: detailsLod0.exhausts.map((e) => e.pos),
    gunPorts: detailsLod0.gunPorts.map((e) => e.pos),
    aileron: cuts.aileron, flap: cuts.flap,
    elevator: { hinge: cuts.elevator.hinge }, rudder: { hinge: cuts.rudder.hinge },
    seed,
    fieldDiv: opts.fieldDiv ?? 2,
  });

  const sh = getShared();
  // Camouflage paint is the darkest, mattest thing in the frame — Dark Earth is
  // about 0.15 linear and Dark Green about 0.08 — so every *additive* lighting
  // term has to be sized against that, not against a mid-grey. The two that
  // were not are the reason the scheme washed out to pale blue-white:
  //
  //   specular 0.60 — quantised into two hard steps over a near-planar wing,
  //     so an entire upper surface flipped to +0.3 of un-tinted white at once.
  //     Now 0.18, and further scaled by the roughness map, which takes matte
  //     paint down to about 0.01 and leaves the highlight on the cowl, the
  //     canopy rail and the polished oleos where it reads as metal.
  //
  //   rim 0.90 at power 3 — a broad Fresnel wrap adding up to 0.25 of white
  //     across the whole of a wing seen at any oblique angle, which is most of
  //     the time. 0.42 at power 4.4 was meant to confine it to the last few
  //     degrees of grazing angle and did not, because the *rim itself* is
  //     multiplied by up to 2.6 when the sun is behind the subject
  //     ('backlit' in CelMaterial) and by uKeyLevel, which saturates at 4.2.
  //     Worked through, that is
  //         rimColor * sunColor * (4.2 * 0.62) * (2.6 * fres) * 0.42
  //       = 2.84 * fres  of untinted white, additively.
  //     A wing panel seen at 45° has fres = (1 - 0.7)^4.4 = 0.22 at power 4.4,
  //     so a *flat interior panel* — nowhere near the silhouette — collected
  //     0.6 of white on top of a Dark Earth albedo of 0.15. That is a four-fold
  //     wash, it lands on every panel bay of a near-planar wing at once, and it
  //     is exactly the "you can see cloud and terrain through the wing, it
  //     reads as a glass toy" regression: the wing ends up sitting at the same
  //     value as the sky behind it. Every framing but 'low' is deliberately
  //     lit with the sun 70-110 degrees off the lens, so 'backlit' is near 1
  //     in eight shots out of ten and this was never the edge case it looks.
  //
  //     Power 7.0 is the fix, and it is a *shape* change rather than a
  //     strength one: at the silhouette (N·V = 0.05) fres only falls from 0.80
  //     to 0.72, so the sun rim along the wing and fuselage top that the
  //     sunset framing is built around survives intact; on that same 45° panel
  //     it falls from 0.22 to 0.093, which is a 2.4x cut where the wash was.
  //     Strength comes back a little further, to 0.34, to hold the peak at
  //     roughly its old value once the two are multiplied out.
  //
  // Bands go from 4 to 3 as well: four steps over a range this dark put two of
  // them within a couple of per cent of each other and read as a smooth ramp,
  // which is precisely what cel shading is not.
  //
  // The third and worst offender was the shadow tint. The cel shader takes the
  // *hue* of 'shadowTint', normalises it to unit luminance and multiplies the
  // albedo by it. The default 0x5f7ea8 normalises to roughly (0.54, 1.04, 1.95)
  // — nearly four times as much blue as red — so any surface not in direct
  // sunlight came out grey-blue whatever colour it was painted. On terrain,
  // where the albedo is already green, that reads as cool skylight. On Dark
  // Earth it inverts the hue: RGB (0.152, 0.111, 0.054) becomes
  // (0.027, 0.038, 0.034) and the aircraft is blue. 0xadbbcf normalises to
  // (0.85, 1.02, 1.28): unmistakably a cool skylit shadow, but the brown stays
  // brown and the green stays green, which is the whole point of putting a
  // camouflage scheme on the aircraft in the first place.
  const hull = createCelMaterial({
    map: maps.albedo, normalMap: maps.normal, normalScale: 1.25,
    bands: 3, bandSoftness: 0.042, gloss: 0.34, specular: 0.18, specSteps: 2,
    rimStrength: 0.34, rimPower: 7.0, terminatorWidth: 0.13,
    shadowTint: 0xadbbcf,
    name: `hull_${spec.id}`,
  });
  attachRoughness(hull, maps.roughness);

  // Canopy glass takes the same treatment for the same reason, and it needs it
  // more: it is transparent, so whatever the rim adds is *not* competing with
  // an albedo at all. At strength 1.5 / power 2.2, a backlit hood collected
  // 1.5 * 2.84 / 0.42 ≈ 10 of white across its whole curved surface and stopped
  // being glass — it is the white blob sitting where the canopy should be in
  // hero.png. Power 3.4 keeps the highlight on the curvature where a canopy
  // really does catch the sky, strength 0.85 keeps it below the point where it
  // erases the framing and the pilot behind it.
  const glass = createCelMaterial({
    color: 0x9fb6c8, transparent: true, opacity: 0.32, depthWrite: false,
    side: THREE.DoubleSide, bands: 2, bandSoftness: 0.02,
    gloss: 0.03, specular: 1.8, specSteps: 1,
    rimStrength: 0.85, rimPower: 3.4,
    emissive: 0xffffff, emissiveMap: sh.glassStreak, emissiveIntensity: 0.40,
    name: `glass_${spec.id}`,
  });

  const prop0 = buildPropeller(spec, prof, 0);
  // The disc is a smear of moving air, not a surface — it gets its own shader
  // rather than a cel material with a texture on it. See 'propeller.ts'.
  const discMat = createPropDiscMaterial(spec, prop0.discRadius);

  const cockpitAtlas = buildCockpitAtlas(spec);
  // A cockpit is a box with one opening, so almost none of it ever sees the
  // sun: shaded strictly by N·L every surface in here lands in the bottom band
  // and the whole interior reads as one black mass with unreadable dials. Real
  // cockpits are legible because of bounce — light off the coaming, the pilot's
  // overalls and the ground below. Feeding the albedo back as a low-intensity
  // emissive is the cheapest honest stand-in: it lifts each surface in
  // proportion to what it is painted, so the dial faces come up and the black
  // crackle finish stays black.
  const cockpitMat = createCelMaterial({
    map: cockpitAtlas.texture,
    emissive: 0xffd9b0, emissiveMap: cockpitAtlas.texture, emissiveIntensity: 0.60,
    bands: 3, bandSoftness: 0.07, gloss: 0.20, specular: 0.30, specSteps: 2,
    rimStrength: 0.30, rimPower: 3.4, terminatorWidth: 0.16,
    // Nearly neutral, warmed a hair. The hull's cool skylight tint is right for
    // a surface under an open sky and quite wrong inside a box: it turned the
    // black instrument finish navy blue and gave every dial face a cast.
    shadowTint: 0xd0cabc, name: `cockpit_${spec.id}`,
  });
  // Reflector-sight glass and the graticule projected on it. Additive, because
  // a reflector sight is literally a projected image floating on the glass.
  const sightMat = createCelMaterial({
    map: cockpitAtlas.texture, transparent: true, opacity: 0.98, depthWrite: false,
    side: THREE.DoubleSide, bands: 2, gloss: 0.02, specular: 1.2, specSteps: 1,
    rimStrength: 0.9, rimPower: 2.0,
    emissive: 0xffffff, emissiveMap: cockpitAtlas.texture, emissiveIntensity: 1.05,
    name: `gunsight_${spec.id}`,
  });

  const materials: THREE.Material[] = [hull, glass, discMat, cockpitMat, sightMat];
  const geometries: THREE.BufferGeometry[] = [];
  const textures: THREE.Texture[] = [cockpitAtlas.texture];
  const triangles: number[] = [];

  const lod = new THREE.LOD();
  lod.name = 'aircraftLod';

  for (const d of DETAILS) {
    const grp = buildLevel(spec, prof, plans, cuts, d, {
      hull, glass, discMat, dial: sh.dialMat, cockpit: cockpitMat, sight: sightMat,
    }, geometries);
    let tris = 0;
    grp.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !o.name.endsWith('__outline')) tris += triCount(m.geometry);
    });
    triangles.push(tris);
    if (d.level === 0) {
      // Inverted-hull silhouettes on the airframe only. Interior, glass, lights
      // and decals opt out via userData.noOutline.
      addOutlinesRecursive(grp, 0.011, 0x0b1016);
    }
    lod.addLevel(grp, LOD_DIST[d.level], 0.08);
  }

  // Distant billboard.
  const impTex = makeImposterTexture(spec);
  textures.push(impTex);
  const impMat = new THREE.SpriteMaterial({
    map: impTex, transparent: true, depthWrite: false, fog: true,
    sizeAttenuation: true, opacity: 0.95,
  });
  materials.push(impMat);
  const imposter = new THREE.Sprite(impMat);
  imposter.scale.setScalar(spec.aero.span * 1.05);
  tag(imposter, 'imposter', true);
  lod.addLevel(imposter, IMPOSTER_DIST, 0.15);

  const root = new THREE.Group();
  root.name = `aircraft_${spec.id}`;
  root.add(lod);

  return { spec, root, maps, materials, geometries, textures, triangles };
}

interface LevelMats {
  hull: CelMaterial; glass: CelMaterial; discMat: THREE.Material; dial: CelMaterial;
  cockpit: CelMaterial; sight: CelMaterial;
}

function buildLevel(
  spec: AircraftSpec, prof: FuselageProfile, plans: Plans,
  cuts: ReturnType<typeof makeCuts>, d: Detail, mats: LevelMats,
  ownedGeoms: THREE.BufferGeometry[],
): THREE.Group {
  const grp = new THREE.Group();
  grp.name = `lod${d.level}`;
  const staticGeoms: THREE.BufferGeometry[] = [];
  const { wing, htail, fin } = plans;

  // ---- fuselage + cowl -----------------------------------------------------
  // The cockpit opening is only cut at LOD0, where the interior exists to be
  // seen through it. At LOD1 and beyond the aircraft is far enough away that
  // the hole would be a couple of dark pixels and the tub behind it none, so
  // the skin stays closed and the canopy glass carries the read.
  const skinCut = d.cockpit ? canopyOpening(spec, prof) : undefined;
  staticGeoms.push(buildFuselageSkin(prof, d.fuseRings, d.fuseSegs, fuseUv, skinCut));
  const cowl = buildCowl(
    prof, spec, d.level,
    swatchBox('hullPaint'), swatchBox('metalDark'), swatchBox('gunmetal'),
  );
  staticGeoms.push(cowl.hull);
  if (cowl.engine) staticGeoms.push(cowl.engine);

  // ---- wings ---------------------------------------------------------------
  const wingCuts = [cuts.aileron, cuts.flap];
  const inner = buildLiftingSurface(wing, {
    spanSegs: Math.max(3, Math.round(d.wingSpan * 0.55)), chordPts: d.wingChord,
    cuts: wingCuts, uv: wingUv, halves: [-1, 1], gap: 0.03, capRoot: false,
    etaMin: 0, etaMax: d.splitWing ? WING_SPLIT : 1,
  });
  staticGeoms.push(inner.skin);

  let outerParts: ReturnType<typeof buildLiftingSurface> | null = null;
  if (d.splitWing) {
    outerParts = buildLiftingSurface(wing, {
      spanSegs: Math.max(3, Math.round(d.wingSpan * 0.8)), chordPts: d.wingChord,
      cuts: wingCuts, uv: wingUv, halves: [-1, 1], gap: 0.03, capRoot: true,
      etaMin: WING_SPLIT, etaMax: 1,
    });
  }

  // Wing-root fillets.
  if (d.filletStations > 0) {
    staticGeoms.push(buildWingFillet(prof, wing, {
      stations: d.filletStations, steps: d.filletSteps, aftChords: 0.12,
      dTheta0: 0.16, dTheta1: 0.46, uv: fuseUv, halves: [-1, 1],
    }));
  }

  // ---- tail ----------------------------------------------------------------
  const tailRes = buildLiftingSurface(htail, {
    spanSegs: d.tailSpan, chordPts: d.tailChord, cuts: [cuts.elevator],
    uv: htailUv, halves: [-1, 1], gap: 0.03, capRoot: true, etaMin: 0.06,
  });
  const finRes = buildLiftingSurface(fin, {
    spanSegs: d.finSpan, chordPts: d.finChord, cuts: [cuts.rudder],
    uv: finUv, halves: [1], gap: 0.02, capRoot: false, etaMin: 0.02,
  });
  staticGeoms.push(finRes.skin);
  staticGeoms.push(buildDorsalFin(prof, fin, d));

  // ---- canopy frames -------------------------------------------------------
  const canopy = d.canopy ? buildCanopy(spec, prof, d.level, swatchBox('glassFrame')) : null;
  if (canopy) staticGeoms.push(canopy.frame);

  // ---- small details -------------------------------------------------------
  const det = d.details ? buildDetails(spec, prof, wing, fin, d.level) : null;
  if (det) staticGeoms.push(det.hull);

  // ---- LOD2 collapses everything that is left into the hull ----------------
  const prop = buildPropeller(spec, prof, d.level);
  if (d.level === 2) {
    staticGeoms.push(
      tailRes.skin,
      ...tailRes.parts.map((p) => p.geometry),
      ...finRes.parts.map((p) => p.geometry),
      ...inner.parts.map((p) => p.geometry),
      prop.spinner,
    );
    const merged = mergeGeoms(staticGeoms);
    ownedGeoms.push(merged);
    const hullMesh = mesh(merged, mats.hull, 'hull');
    hullMesh.layers.enable(LAYER_INK);
    grp.add(hullMesh);
    // A stopped or spinning prop still has to be there or the nose looks broken.
    const discGeo = prop.disc;
    ownedGeoms.push(discGeo);
    const disc = mesh(discGeo, mats.discMat, 'propDisc', true);
    disc.position.set(0, 0, prop.hubZ);
    disc.renderOrder = 4;
    // A translucent smear must never be in the shadow map: it casts a hard
    // black ellipse on the wing and on the ground beneath the aeroplane.
    disc.castShadow = false;
    disc.receiveShadow = false;
    grp.add(disc);
    return grp;
  }

  // ---- static hull ---------------------------------------------------------
  const hullGeo = mergeGeoms(staticGeoms);
  ownedGeoms.push(hullGeo);
  const hullMesh = mesh(hullGeo, mats.hull, 'hull');
  hullMesh.layers.enable(LAYER_INK);
  grp.add(hullMesh);

  // ---- detachable wing panels and tailplanes -------------------------------
  if (outerParts) {
    const halves = splitByHalf(outerParts.skin, wing);
    for (const [name, geo] of halves) {
      ownedGeoms.push(geo);
      const m = mesh(geo, mats.hull, name);
      m.layers.enable(LAYER_INK);
      grp.add(m);
    }
  }
  {
    const halves = splitByHalf(tailRes.skin, htail, 'tailplaneL', 'tailplaneR');
    for (const [name, geo] of halves) {
      ownedGeoms.push(geo);
      const m = mesh(geo, mats.hull, name);
      m.layers.enable(LAYER_INK);
      grp.add(m);
    }
  }

  // ---- hinged surfaces -----------------------------------------------------
  const hinged = [
    ...(outerParts ? outerParts.parts : inner.parts),
    ...inner.parts.filter((p) => p.name === 'flap'),
    ...tailRes.parts,
    ...finRes.parts,
  ];
  const seenNames = new Set<string>();
  for (const p of hinged) {
    const side = p.half < 0 ? 'L' : p.half > 0 ? 'R' : '';
    const name = p.name === 'rudder' ? 'rudder' : `${p.name}${side}`;
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    const h = makeHinge(p.geometry, p.point, p.axis, `${name}Pivot`);
    ownedGeoms.push(h.geometry);
    const m = mesh(h.geometry, mats.hull, name);
    m.layers.enable(LAYER_INK);
    h.pivot.add(m);
    tag(h.pivot, `${name}Pivot`);
    grp.add(h.root);
  }

  // ---- propeller -----------------------------------------------------------
  {
    const propGrp = new THREE.Group();
    propGrp.position.set(0, 0, prop.hubZ);
    tag(propGrp, 'propeller');
    ownedGeoms.push(prop.blades, prop.spinner, prop.disc);
    propGrp.add(mesh(prop.blades, mats.hull, 'propBlades'));
    propGrp.add(mesh(prop.spinner, mats.hull, 'spinner'));
    grp.add(propGrp);

    const disc = mesh(prop.disc, mats.discMat, 'propDisc', true);
    disc.position.set(0, 0, prop.hubZ + 0.02);
    disc.renderOrder = 4;
    disc.visible = false;
    disc.castShadow = false;
    disc.receiveShadow = false;
    grp.add(disc);
  }

  // ---- landing gear --------------------------------------------------------
  if (d.gear) {
    const gear = buildGear(spec, prof, wing, d.level);
    for (const leg of [...gear.main, ...(gear.tail ? [gear.tail] : [])]) {
      leg.geometry.translate(leg.pivot.x, leg.pivot.y, leg.pivot.z);
      const h = makeHinge(leg.geometry, leg.pivot, leg.axis, `${leg.name}`);
      ownedGeoms.push(h.geometry);
      const legMesh = mesh(h.geometry, mats.hull, `${leg.name}Strut`);
      h.pivot.add(legMesh);
      tag(h.pivot, leg.name);
      h.pivot.userData.upAngle = leg.upAngle;
      grp.add(h.root);

      // Wheel spin pivot. The wheel's axle is lateral in *body* space, so the
      // spin group first undoes the leg's hinge basis and then spins about its
      // own X — otherwise the wheel rotates about the retraction axis.
      const wheelWorld = leg.pivot.clone().add(leg.wheelPos);
      const wheelLocal = wheelWorld.clone().applyMatrix4(h.inv);
      const wheelOrient = new THREE.Group();
      wheelOrient.position.copy(wheelLocal);
      wheelOrient.quaternion.copy(h.basis).invert();
      const wheelPivot = new THREE.Group();
      const wheelName = leg.name === 'gearTail' ? 'wheelTail' : leg.name === 'gearL' ? 'wheelL' : 'wheelR';
      tag(wheelPivot, wheelName);
      ownedGeoms.push(leg.wheel);
      wheelPivot.add(mesh(leg.wheel, mats.hull, `${wheelName}Mesh`));
      wheelOrient.add(wheelPivot);
      h.pivot.add(wheelOrient);

      if (leg.door) {
        const dh = makeHinge(leg.door.geometry, leg.door.pivot, leg.door.axis, `${leg.name}Door`);
        ownedGeoms.push(dh.geometry);
        const doorName = leg.name === 'gearL' ? 'gearDoorL' : 'gearDoorR';
        const dm = mesh(dh.geometry, mats.hull, doorName);
        dm.layers.enable(LAYER_INK);
        dh.pivot.add(dm);
        tag(dh.pivot, `${doorName}Pivot`);
        dh.pivot.userData.closedAngle = leg.door.closedAngle;
        grp.add(dh.root);
      }
    }
  }

  // ---- canopy --------------------------------------------------------------
  if (canopy) {
    const canopyGrp = new THREE.Group();
    tag(canopyGrp, 'canopy');
    ownedGeoms.push(canopy.glass);
    const glassMesh = mesh(canopy.glass, mats.glass, 'canopyGlass', true);
    glassMesh.castShadow = false;
    glassMesh.renderOrder = 6;
    canopyGrp.add(glassMesh);
    grp.add(canopyGrp);
  }

  // ---- cockpit -------------------------------------------------------------
  if (d.cockpit) {
    const cp = buildCockpit(spec, prof);
    ownedGeoms.push(cp.interior, cp.sightGlass, cp.pilot);
    const interior = mesh(cp.interior, mats.cockpit, 'cockpitInterior', true);
    interior.castShadow = false;
    interior.layers.enable(LAYER_COCKPIT);
    grp.add(interior);

    // The reflector plate: translucent, emissive, and on the bloom layer so the
    // graticule blooms the way a projected image on glass does.
    const sight = mesh(cp.sightGlass, mats.sight, 'gunsightGlass', true);
    sight.castShadow = false;
    sight.renderOrder = 5;
    sight.layers.enable(LAYER_COCKPIT);
    sight.layers.enable(LAYER_BLOOM);
    grp.add(sight);

    // Needles: the pivot carries the panel rake and nothing else, so whatever
    // drives the instruments only ever writes 'rotation.z' — a needle angle in
    // the dial's own plane, positive clockwise as the pilot sees it.
    for (const n of cp.needles) {
      const pivot = new THREE.Group();
      pivot.position.copy(n.pos);
      pivot.rotation.set(cp.panelTilt, 0, 0);
      pivot.userData.gauge = n.range;
      tag(pivot, `needle_${n.fast ? 'fast_' : ''}${n.name}`);
      ownedGeoms.push(n.geometry);
      const nm = mesh(n.geometry, mats.cockpit, `needleMesh_${n.name}`, true);
      nm.castShadow = false;
      nm.layers.enable(LAYER_COCKPIT);
      pivot.add(nm);
      grp.add(pivot);
    }

    const pilot = mesh(cp.pilot, mats.cockpit, 'pilot', true);
    pilot.castShadow = false;
    grp.add(pilot);

    const eye = new THREE.Object3D();
    eye.position.copy(cp.eyePoint);
    tag(eye, 'eyePoint', true);
    grp.add(eye);
  }

  // ---- lights and markers --------------------------------------------------
  if (det) {
    for (const l of det.lights) {
      ownedGeoms.push(l.geometry);
      const lm = mesh(l.geometry, lightMaterial(l.color), `navLight_${l.color.toString(16)}`, true);
      lm.castShadow = false;
      lm.layers.enable(LAYER_BLOOM);
      grp.add(lm);
    }
    det.exhausts.forEach((e, i) => {
      const o = new THREE.Object3D();
      o.position.copy(e.pos);
      o.lookAt(e.pos.clone().add(e.dir));
      tag(o, `exhaustPort${i}`, true);
      grp.add(o);
    });
    det.gunPorts.forEach((gp, i) => {
      const o = new THREE.Object3D();
      o.position.copy(gp.pos);
      tag(o, `gunPort${i}`, true);
      grp.add(o);
    });
    for (const [name, v] of [['wingtipL', det.wingtipL], ['wingtipR', det.wingtipR]] as [string, THREE.Vector3][]) {
      const o = new THREE.Object3D();
      o.position.copy(v);
      tag(o, name, true);
      grp.add(o);
    }
  }

  return grp;
}

/**
 * Split a two-half lifting-surface skin back into port and starboard geometries
 * so each side can be shot off independently. Cheaper and less error-prone than
 * running the loft twice with different halves, and it keeps the two sides'
 * vertex ordering identical.
 */
function splitByHalf(
  geo: THREE.BufferGeometry, plan: WingPlan, nameL = 'wingOuterL', nameR = 'wingOuterR',
): [string, THREE.BufferGeometry][] {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const idx = geo.getIndex();
  if (!idx) return [[nameR, geo]];

  const out: [string, THREE.BufferGeometry][] = [];
  for (const [name, sign] of [[nameL, -1], [nameR, 1]] as [string, number][]) {
    const map = new Map<number, number>();
    const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = [];
    for (let t = 0; t < idx.count; t += 3) {
      const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
      const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
      if (Math.sign(cx) !== sign) continue;
      for (const v of [a, b, c]) {
        let nv = map.get(v);
        if (nv === undefined) {
          nv = P.length / 3;
          map.set(v, nv);
          P.push(pos.getX(v), pos.getY(v), pos.getZ(v));
          N.push(nrm.getX(v), nrm.getY(v), nrm.getZ(v));
          U.push(uv.getX(v), uv.getY(v));
        }
        I.push(nv);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    g.setIndex(I);
    g.computeBoundingSphere();
    out.push([name, g]);
  }
  void plan;
  return out;
}

const hashString = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Build (or fetch the cached template for) one aircraft type and instance it. */
export function buildAircraft(spec: AircraftSpec, opts: BuildOptions = {}): AircraftModel {
  let tpl = templates.get(spec.id);
  if (!tpl) {
    tpl = buildTemplate(spec, opts);
    templates.set(spec.id, tpl);
  }
  return instantiate(tpl);
}

export function buildAircraftById(id: string, opts: BuildOptions = {}): AircraftModel {
  const spec = AIRCRAFT_BY_ID[id] ?? AIRCRAFT[0];
  return buildAircraft(spec, opts);
}

/**
 * Pre-build and cache every aircraft type. Yields between types so a loading
 * bar can actually move — generating five 2048² sheets is roughly a second of
 * solid main-thread work and would otherwise be one frozen frame.
 */
export async function buildAllAircraft(
  onProgress?: (frac: number, label: string) => void,
  opts: BuildOptions = {},
): Promise<void> {
  getShared();
  for (let i = 0; i < AIRCRAFT.length; i++) {
    const spec = AIRCRAFT[i];
    onProgress?.(i / AIRCRAFT.length, `building ${spec.name}`);
    await new Promise<void>((r) => setTimeout(r, 0));
    if (!templates.has(spec.id)) templates.set(spec.id, buildTemplate(spec, opts));
  }
  onProgress?.(1, 'aircraft ready');
}

/** Triangle counts per LOD level for a built type — for the perf HUD. */
export function aircraftTriangleCounts(id: string): number[] {
  return templates.get(id)?.triangles.slice() ?? [];
}

function instantiate(tpl: Template): AircraftModel {
  const root = tpl.root.clone(true) as THREE.Group;
  const parts = new Map<string, THREE.Object3D[]>();
  root.traverse((o) => {
    const p = o.userData.part as string | undefined;
    if (!p) return;
    const list = parts.get(p);
    if (list) list.push(o); else parts.set(p, [o]);
  });

  const first = (n: string): THREE.Object3D => parts.get(n)?.[0] ?? new THREE.Object3D();
  const all = (prefix: string): THREE.Object3D[] => {
    const out: THREE.Object3D[] = [];
    for (const [k, v] of parts) if (k.startsWith(prefix)) out.push(v[0]);
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };

  const needles: Record<string, THREE.Object3D> = {};
  for (const [k, v] of parts) if (k.startsWith('needle_')) needles[k.slice(7)] = v[0];

  const lod = root.children.find((c) => (c as THREE.LOD).isLOD) as THREE.LOD;

  const dp = {} as DamageParts;
  for (const n of [
    'wingOuterL', 'wingOuterR', 'aileronL', 'aileronR', 'flapL', 'flapR',
    'elevatorL', 'elevatorR', 'tailplaneL', 'tailplaneR', 'rudder', 'fin',
    'canopyGlass', 'spinner', 'propBlades', 'gearDoorL', 'gearDoorR',
  ]) dp[n] = first(n);

  return {
    spec: tpl.spec,
    root,
    lod,
    propeller: first('propeller'),
    propDisc: first('propDisc'),
    spinner: first('spinner'),
    aileronL: first('aileronLPivot'),
    aileronR: first('aileronRPivot'),
    elevatorL: first('elevatorLPivot'),
    elevatorR: first('elevatorRPivot'),
    rudder: first('rudderPivot'),
    flapL: first('flapLPivot'),
    flapR: first('flapRPivot'),
    gearL: first('gearL'),
    gearR: first('gearR'),
    gearTail: first('gearTail'),
    gearDoorL: first('gearDoorLPivot'),
    gearDoorR: first('gearDoorRPivot'),
    wheelL: first('wheelL'),
    wheelR: first('wheelR'),
    wheelTail: first('wheelTail'),
    canopy: first('canopy'),
    pilot: first('pilot'),
    exhaustPorts: all('exhaustPort'),
    gunPorts: all('gunPort'),
    wingtipL: first('wingtipL'),
    wingtipR: first('wingtipR'),
    eyePoint: first('eyePoint'),
    needles,
    damageParts: dp,
    parts,
    propAngle: 0,
    wheelAngle: 0,
    decals: [],
  };
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

const AILERON_MAX = 0.32;   // ±18°
const ELEVATOR_MAX = 0.38;  // ±22°
const RUDDER_MAX = 0.44;    // ±25°

const applyAll = (model: AircraftModel, part: string, fn: (o: THREE.Object3D) => void): void => {
  const list = model.parts.get(part);
  if (!list) return;
  for (const o of list) fn(o);
};

/**
 * Deflect the control surfaces. Inputs are normalised [-1,1] except 'flaps'
 * which is [0,1]. Signs follow the aircraft body frame: +pitch is nose up,
 * +roll is right wing down, +yaw is nose right.
 */
export function setControlSurfaces(
  model: AircraftModel, pitch: number, roll: number, yaw: number, flaps: number,
): void {
  const flapMax = model.spec.geom.ellipticalWing ? 1.05 : 0.79;   // Spitfire flaps go to 85°
  applyAll(model, 'aileronLPivot', (o) => { o.rotation.x = roll * AILERON_MAX; });
  applyAll(model, 'aileronRPivot', (o) => { o.rotation.x = roll * AILERON_MAX; });
  applyAll(model, 'elevatorLPivot', (o) => { o.rotation.x = pitch * ELEVATOR_MAX; });
  applyAll(model, 'elevatorRPivot', (o) => { o.rotation.x = pitch * ELEVATOR_MAX; });
  applyAll(model, 'rudderPivot', (o) => { o.rotation.x = yaw * RUDDER_MAX; });
  applyAll(model, 'flapLPivot', (o) => { o.rotation.x = -flaps * flapMax; });
  applyAll(model, 'flapRPivot', (o) => { o.rotation.x = -flaps * flapMax; });
}

/**
 * Gear deployment, 0 = up and locked, 1 = down and locked.
 *
 * Doors lead the legs: they are fully open by 35 % of the cycle and start to
 * close again only after the legs are stowed, which is the real sequence and
 * stops the leg from clipping through a half-open door.
 */
export function setGear(model: AircraftModel, t: number): void {
  const c = Math.max(0, Math.min(1, t));
  const legT = smooth01((c - 0.15) / 0.85);
  const doorT = smooth01(c / 0.35);
  applyAll(model, 'gearL', (o) => { o.rotation.x = (o.userData.upAngle ?? 0) * (1 - legT); });
  applyAll(model, 'gearR', (o) => { o.rotation.x = (o.userData.upAngle ?? 0) * (1 - legT); });
  applyAll(model, 'gearTail', (o) => { o.rotation.x = (o.userData.upAngle ?? 0) * (1 - legT); });
  applyAll(model, 'gearDoorLPivot', (o) => { o.rotation.x = (o.userData.closedAngle ?? 0) * (1 - doorT); });
  applyAll(model, 'gearDoorRPivot', (o) => { o.rotation.x = (o.userData.closedAngle ?? 0) * (1 - doorT); });
}

const smooth01 = (x: number) => {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
};

/**
 * Spin the propeller and cross-fade to the blurred disc.
 *
 * 'rpmNorm' is 0..1 of maximum RPM. Blades stay visible up to 0.42 and the disc
 * comes in from 0.32, so there is a band where both are drawn — which is exactly
 * what a real propeller looks like as it spools past the point where the eye
 * stops resolving individual blades.
 */
export function setPropeller(model: AircraftModel, rpmNorm: number, dt: number): void {
  const spec = model.spec;
  const rps = (rpmNorm * spec.engine.maxRpm) / 60;
  model.propAngle = (model.propAngle + rps * dt * Math.PI * 2 * spec.engine.propDir) % (Math.PI * 2);
  applyAll(model, 'propeller', (o) => { o.rotation.z = model.propAngle; });
  const showBlades = rpmNorm < 0.42;
  const showDisc = rpmNorm > 0.32;
  applyAll(model, 'propBlades', (o) => { o.visible = showBlades; });
  applyAll(model, 'propDisc', (o) => { o.visible = showDisc; });
}

/** Spin the wheels. 'speed' is ground speed in m/s. */
export function setWheelSpin(model: AircraftModel, speed: number, dt: number): void {
  // Radius is baked into the geometry; derive it from the leg length instead of
  // storing it, since the gear builder uses the same ratio.
  const r = model.spec.geom.gear.legLen * 0.36;
  model.wheelAngle = (model.wheelAngle + (speed / r) * dt) % (Math.PI * 2);
  for (const n of ['wheelL', 'wheelR']) applyAll(model, n, (o) => { o.rotation.x = model.wheelAngle; });
  applyAll(model, 'wheelTail', (o) => { o.rotation.x = model.wheelAngle * 2.6; });
}

/** Hide the parts that a damage bitmask says have come off. */
export function setDamage(model: AircraftModel, damage: number): void {
  const off = (name: string, gone: boolean) => applyAll(model, name, (o) => { o.visible = !gone; });
  const wingL = (damage & DamageBits.LeftWing) !== 0 && (damage & DamageBits.WingRipped) !== 0;
  const wingR = (damage & DamageBits.RightWing) !== 0 && (damage & DamageBits.WingRipped) !== 0;
  off('wingOuterL', wingL); off('aileronL', wingL);
  off('wingOuterR', wingR); off('aileronR', wingR);
  const tail = (damage & DamageBits.Tail) !== 0;
  off('tailplaneL', tail); off('tailplaneR', tail);
  off('elevatorL', tail || (damage & DamageBits.Elevator) !== 0);
  off('elevatorR', tail || (damage & DamageBits.Elevator) !== 0);
  off('rudder', (damage & DamageBits.Rudder) !== 0);
  off('canopyGlass', (damage & DamageBits.PilotHit) !== 0 && (damage & DamageBits.Destroyed) !== 0);
  off('pilot', (damage & DamageBits.PilotDead) !== 0);
}

/** Detach a named part and hand it back so VFX can turn it into debris. */
export function detachPart(model: AircraftModel, name: string): THREE.Object3D | null {
  const list = model.parts.get(name);
  if (!list || list.length === 0) return null;
  const o = list[0];
  o.removeFromParent();
  for (const other of list.slice(1)) other.visible = false;
  return o;
}

const MAX_DECALS = 18;
const _decalM = new THREE.Matrix4();
const _decalQ = new THREE.Quaternion();
const _decalUp = new THREE.Vector3(0, 1, 0);

/**
 * Stick a battle-damage decal on the airframe.
 *
 * The quad is offset 8 mm along the surface normal — enough to beat depth
 * fighting on a curved skin at any sane camera distance, small enough that it
 * never floats visibly. Decals are capped and recycled oldest-first.
 */
export function addBulletHole(
  model: AircraftModel, localPos: THREE.Vector3, localNormal: THREE.Vector3,
  size: number, kind: DamageDecal = 'hole_a',
): void {
  const sh = getShared();
  const box = damageBox(kind);
  const geo = quadGeom(size, size, box);
  const m = new THREE.Mesh(geo, sh.decalMat);
  m.castShadow = false;
  m.receiveShadow = false;
  m.userData.noOutline = true;
  m.renderOrder = 3;
  m.position.copy(localPos).addScaledVector(localNormal, 0.008);
  _decalM.lookAt(new THREE.Vector3(0, 0, 0), localNormal, _decalUp);
  _decalQ.setFromRotationMatrix(_decalM);
  m.quaternion.copy(_decalQ);
  m.rotateZ(Math.random() * Math.PI * 2);

  const target = model.parts.get('hull')?.[0] ?? model.root;
  target.add(m);
  model.decals.push(m);
  if (model.decals.length > MAX_DECALS) {
    const old = model.decals.shift();
    if (old) { old.removeFromParent(); old.geometry.dispose(); }
  }
}

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

/** Release one instance. Shared geometry and materials are left alone. */
export function disposeAircraft(model: AircraftModel): void {
  for (const d of model.decals) { d.removeFromParent(); d.geometry.dispose(); }
  model.decals.length = 0;
  model.root.removeFromParent();
  model.parts.clear();
}

/** Release every cached type. Call on teardown, not between matches. */
export function disposeAircraftAssets(): void {
  for (const tpl of templates.values()) {
    for (const g of tpl.geometries) g.dispose();
    for (const m of tpl.materials) m.dispose();
    for (const t of tpl.textures) t.dispose();
    tpl.maps.dispose();
  }
  templates.clear();
  if (shared) {
    shared.gauge.dispose();
    shared.damage.dispose();
    shared.glassStreak.dispose();
    shared.dialMat.dispose();
    shared.decalMat.dispose();
    for (const m of shared.lightMats.values()) m.dispose();
    shared = null;
  }
}

