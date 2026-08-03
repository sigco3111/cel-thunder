/**
 * Propeller: real twisted aerofoil blades, a lathed spinner, and a blurred disc
 * that takes over above a threshold RPM.
 *
 * The blades are lofts of a cambered section along the radius with:
 *  - a paddle chord distribution peaking at ~55 % radius,
 *  - geometric twist from ~62° at the shank to ~22° at the tip, so that the
 *    section pitch angle falls with radius the way it must for the local helix
 *    angle to stay sensible — this is the twist you can actually see when the
 *    prop is stopped, and getting it wrong is instantly obvious,
 *  - thickness tapering from 20 % at the root to 7 % at the tip,
 *  - a rounded tip.
 *
 * The disc is a single quad carrying a purpose-written shader — see
 * 'createPropDiscMaterial'. It is swapped in with a small hysteresis band where
 * both the blades and the disc are visible, which is exactly what a real prop
 * looks like at the transition.
 */

import * as THREE from 'three';
import type { AircraftSpec } from '../../shared/aircraft';
import { swatchBox } from '../textures/atlas';
import type { UvBox } from '../textures/atlas';
import { MeshBuilder, cylGeom, latheGeom, mergeGeoms, quadGeom, trs, uvIn } from './geom';
import { foilCamber, foilThickness, naca } from './naca';
import type { FuselageProfile } from './fuselage';
import { celGlobals } from '../../render/CelMaterial';

export interface PropellerResult {
  spinner: THREE.BufferGeometry;
  blades: THREE.BufferGeometry;
  /** Quad geometry for the blurred disc. */
  disc: THREE.BufferGeometry;
  /** Body-space z of the propeller plane. */
  hubZ: number;
  radius: number;
  /** Half-width of the disc quad, in metres — the shader's radial unit. */
  discRadius: number;
}

/** Chord as a fraction of the maximum, against radius fraction. */
function chordFrac(x: number): number {
  const t = (x - 0.55) / 0.66;
  const base = Math.sqrt(Math.max(0, 1 - t * t));
  // Round the last 6 % into a tip.
  const tip = x > 0.94 ? Math.sqrt(Math.max(0, 1 - ((x - 0.94) / 0.06) ** 2)) : 1;
  return base * (0.35 + 0.65 * tip);
}

/** Blade angle from the disc plane, radians. */
const bladeTwist = (x: number) => (62 - 40 * Math.pow(Math.min(1, x / 0.95), 0.72)) * Math.PI / 180;

export function buildPropeller(
  spec: AircraftSpec, prof: FuselageProfile, detail: number,
): PropellerResult {
  const R = spec.engine.propDia * 0.5;
  const s0 = prof.sampleT(0);
  const spinR = Math.max(0.13, Math.min(s0.rx, s0.ryTop) * (prof.radial ? 0.44 : 0.92));
  const spinLen = spinR * (prof.radial ? 1.15 : 2.45);
  // The spinner base ring must sit *on* the cowl front, not ahead of it, or
  // there is a visible gap straight into the fuselage from any front angle.
  const hubZ = prof.noseZ - 0.015;

  const propBox = swatchBox('propBlade');
  const spinBox = swatchBox('hullPaint');
  const darkBox = swatchBox('metalDark');

  // --- spinner --------------------------------------------------------------
  // Two different families, because the two installations look nothing alike
  // from the front. An inline engine gets a *pointed* spinner, r = Rs·u^0.78,
  // between a cone and a needle, which is the late Merlin Rotol shape. A radial
  // gets the blunt elliptical cap r = Rs·√(1−(1−u)²) that sits in the middle of
  // the cowl opening.
  const nSeg = detail === 0 ? 9 : detail === 1 ? 6 : 4;
  const profile: { r: number; y: number }[] = [];
  for (let i = 0; i <= nSeg; i++) {
    const u = i / nSeg;
    const y = -spinLen * (1 - u);
    const k = 1 - u;
    const r = prof.radial
      ? spinR * Math.sqrt(Math.max(0, 1 - k * k))
      : spinR * Math.pow(u, 0.78);
    profile.push({ r, y });
  }
  profile.push({ r: spinR * 0.98, y: 0.02 });
  const spinnerGeo = latheGeom(profile, detail === 0 ? 16 : 10, spinBox);
  // Lathe is about +Y; the propeller axis is +Z.
  spinnerGeo.applyMatrix4(trs([0, 0, 0], [-Math.PI / 2, 0, 0]));

  const spinnerParts: THREE.BufferGeometry[] = [spinnerGeo];
  // Hub cannon aperture, where one is fitted.
  const hubGun = spec.guns.find((g) => g.mounts.some((m) => Math.abs(m[0]) < 0.08 && Math.abs(m[1]) < 0.12));
  if (hubGun) {
    const bore = cylGeom(hubGun.calibre * 0.0009, hubGun.calibre * 0.0009, spinLen * 1.6, 8, darkBox, false);
    bore.applyMatrix4(trs([0, 0, spinLen * 0.25], [Math.PI / 2, 0, 0]));
    spinnerParts.push(bore);
  }

  // --- blades ---------------------------------------------------------------
  const foil = naca('4412', 0.34, 0.004);
  const nBlades = Math.max(2, spec.engine.blades);
  const spanSegs = detail === 0 ? 11 : detail === 1 ? 6 : 3;
  const chordSegs = detail === 0 ? 14 : detail === 1 ? 8 : 6;
  const cMax = spec.engine.propDia * 0.082;
  const x0 = 0.16;

  const bladeGeoms: THREE.BufferGeometry[] = [];
  for (let bIdx = 0; bIdx < nBlades; bIdx++) {
    const phase = (bIdx / nBlades) * Math.PI * 2;
    const mb = new MeshBuilder();
    mb.addGrid(spanSegs + 1, chordSegs + 1, (i, j, o) => {
      const x = x0 + (1 - x0) * (i / spanSegs);
      const r = x * R;
      const c = cMax * chordFrac(x);
      const beta = bladeTwist(x);
      const tRatio = 0.20 + (0.07 - 0.20) * ((x - x0) / (1 - x0));
      // Contour param: 0 at LE upper, wraps at 1.
      const s = j / chordSegs;
      const upper = s <= 0.5;
      const xi = upper ? s * 2 : (1 - s) * 2;
      const xa = (1 - Math.cos(Math.PI * xi)) * 0.5;
      const sign = upper ? 1 : -1;
      const yt = foilThickness(foil, xa) * (tRatio / foil.t);
      const yc = foilCamber(foil, xa).yc;
      const ya = yc + sign * yt;

      const cb = Math.cos(beta), sb = Math.sin(beta);
      const along = (0.32 - xa) * c;
      const across = ya * c;
      // Chord direction in the disc plane, thickness normal to it.
      const px = along * cb - across * sb;
      const pz = along * sb + across * cb;
      const cp = Math.cos(phase), sp = Math.sin(phase);
      o.x = px * cp - r * sp;
      o.y = px * sp + r * cp;
      o.z = pz;
      const [u, v] = uvIn(propBox, x, s);
      o.u = u; o.v = v;
    }, true);
    bladeGeoms.push(mb.build(true));

    // Blade cuff at the hub.
    const cuff = cylGeom(cMax * 0.30, cMax * 0.26, spinR * 0.9, 8, darkBox, false);
    cuff.applyMatrix4(trs(
      [-Math.sin(phase) * x0 * R * 0.6, Math.cos(phase) * x0 * R * 0.6, -spinLen * 0.1],
      [0, 0, phase],
    ));
    bladeGeoms.push(cuff);
  }

  // --- blurred disc ---------------------------------------------------------
  // The quad is a hair larger than the swept circle so the shader's soft outer
  // falloff has somewhere to land; anything tighter clips the fade and the disc
  // comes back as a hard-edged ellipse.
  const discRadius = R * 1.03;
  const disc = quadGeom(discRadius * 2, discRadius * 2, { u0: 0, v0: 0, u1: 1, v1: 1 });

  return {
    spinner: mergeGeoms(spinnerParts),
    blades: mergeGeoms(bladeGeoms),
    disc,
    hubZ,
    radius: R,
    discRadius,
  };
}

// ---------------------------------------------------------------------------
// The spinning disc
// ---------------------------------------------------------------------------

/**
 * Why this is a shader and not a translucent texture.
 *
 * A propeller turning at 1 500 rpm sweeps its blades past a given azimuth
 * twenty-five times a second. What the eye integrates is *not* a uniformly
 * tinted circle: it is mostly the background, seen through air, with a thin
 * smear of blade laid over it. Three properties follow, and the previous flat
 * 34 %-opacity quad had none of them:
 *
 *  1. **Density follows blade area, not radius.** Chord peaks around 60 % of
 *     the radius and the inboard third is spinner and blade cuff, so the disc
 *     is essentially invisible at the hub. A constant alpha put a grey plate
 *     over the cowl.
 *
 *  2. **It must not darken a bright background.** Straight alpha blending
 *     lerps toward the disc colour, so a dark smear over a sunset punches a
 *     grey hole — which is exactly what it did. The composite here is
 *     *premultiplied*: 'dst·(1−a) + colour·a' with a bright, sun-tinted colour,
 *     so the disc attenuates the background by a couple of per cent and adds
 *     its own scattered light on top. Against a bright sky it is a faint sheen;
 *     against dark terrain it is a pale smear. Both are what a photograph does.
 *
 *  3. **It has angular structure and it moves.** Blade-count arcs advance with
 *     the hub phase and finer filaments break the ring up, so it reads as
 *     motion rather than as a decal. The painted tips smear into a hot arc
 *     near the rim — the single most recognisable feature of a running prop.
 *
 * Everything is driven off two per-view uniforms ('uOpacity' from the rpm
 * cross-fade, 'uPhase' from the hub angle) plus the shared cel globals, so one
 * material serves every aircraft of a type and still tracks the sun.
 */

const DISC_VERT = /* glsl */`
uniform float uRadius;
uniform vec3 uSunDir;
varying vec2 vP;
varying vec2 vSun;
varying float vSunZ;
varying float vDepth;

void main() {
  vP = position.xy / uRadius;

  // The sun, brought into the propeller's own frame. Aircraft rigs are never
  // scaled, so the model matrix is orthonormal and its transpose is its
  // inverse — which is all three of these dot products are.
  vec3 s = vec3(
    dot(uSunDir, modelMatrix[0].xyz),
    dot(uSunDir, modelMatrix[1].xyz),
    dot(uSunDir, modelMatrix[2].xyz));
  float l = length(s.xy);
  vSun = l > 1e-4 ? s.xy / l : vec2(0.0, 1.0);
  vSunZ = s.z;

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const DISC_FRAG = /* glsl */`
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uAerialColor;
uniform vec3 uTip;
uniform float uAerialFar;
uniform float uAerialStrength;
uniform float uOpacity;
uniform float uPhase;
uniform float uBlades;
varying vec2 vP;
varying vec2 vSun;
varying float vSunZ;
varying float vDepth;

void main() {
  float r = length(vP);
  if (r > 1.0) discard;
  vec2 dir = r > 1e-4 ? vP / r : vec2(1.0, 0.0);
  float ang = atan(dir.y, dir.x);

  // Spinner and blade cuffs occupy the inboard third: nothing smears there.
  float hub = smoothstep(0.17, 0.44, r);
  // Soft outer falloff. Without it the disc reads as a cut ellipse against
  // the sky, which is the defect the art director found in water.png.
  float edge = 1.0 - smoothstep(0.945, 1.0, r);
  // Paddle-blade chord distribution, peaking a little outboard of mid-span.
  float chord = exp(-pow((r - 0.64) / 0.40, 2.0));

  // Blade-count arcs, advanced by the hub phase. The power narrows each lobe
  // into a streak rather than a broad scallop.
  float sweep = 0.5 + 0.5 * cos(ang * uBlades - uPhase * uBlades);
  float streak = pow(sweep, 2.0);
  // Finer filaments: the shed vorticity that makes a real disc look grainy
  // instead of airbrushed. Drifting slowly against the arcs breaks up any
  // stationary pattern.
  float grain = 0.66 + 0.34 * sin(ang * 23.0 + uPhase * 1.6 + r * 15.0);

  // One half of the disc has the blade backs turned to the sun.
  float lit = 0.55 + 0.45 * dot(dir, vSun);
  // Sun ahead of the aeroplane means we are looking at a backlit disc, which
  // scatters hard — this is what saves the sunset frame.
  float glow = 0.85 + 0.75 * clamp(vSunZ, 0.0, 1.0);

  float a = hub * edge * (0.045 + 0.110 * chord)
          * (0.35 + 1.15 * streak) * grain * lit * glow;

  // Painted tips, smeared into a hot ring and brightest where a blade is now.
  // Wide and soft on purpose. A narrow, opaque ring reads as a wireframe hoop
  // hanging in front of the nose rather than as paint being swept round at
  // 250 m/s, and that is exactly what it looked like at half this width.
  float tipRing = exp(-pow((r - 0.930) / 0.055, 2.0)) * edge;
  float tipHot = tipRing * (0.28 + 0.72 * pow(sweep, 5.0));
  a += tipHot * 0.20 * glow;

  vec3 col = mix(uSkyColor * 1.30, uSunColor, 0.60) * (0.70 + 0.60 * lit) * glow;
  col = mix(col, uSunColor * 1.7 + uTip * 0.5, clamp(tipHot * 1.3, 0.0, 1.0));

  // Same aerial-perspective ramp the hull uses, so a distant disc sits in the
  // same haze as the aeroplane carrying it.
  float f = clamp(vDepth / uAerialFar, 0.0, 1.0) * uAerialStrength;
  col = mix(col, uAerialColor, f);

  a = clamp(a * uOpacity, 0.0, 1.0);
  gl_FragColor = vec4(col * a, a);
}
`;

/** Uniform names that must stay shared with 'celGlobals' across a clone. */
export const PROP_DISC_SHARED_UNIFORMS = [
  'uSunDir', 'uSunColor', 'uSkyColor', 'uAerialColor', 'uAerialFar', 'uAerialStrength',
];

export function createPropDiscMaterial(spec: AircraftSpec, discRadius: number): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    name: `propdisc_${spec.id}`,
    uniforms: {
      uSunDir: celGlobals.uSunDir,
      uSunColor: celGlobals.uSunColor,
      uSkyColor: celGlobals.uSkyColor,
      uAerialColor: celGlobals.uAerialColor,
      uAerialFar: celGlobals.uAerialFar,
      uAerialStrength: celGlobals.uAerialStrength,
      uTip: { value: new THREE.Color(spec.livery.accent) },
      uRadius: { value: discRadius },
      uBlades: { value: Math.max(2, spec.engine.blades) },
      uPhase: { value: 0 },
      uOpacity: { value: 0 },
    },
    vertexShader: DISC_VERT,
    fragmentShader: DISC_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    // Premultiplied: see the note above. 'One / OneMinusSrcAlpha' is the only
    // composite that both attenuates and adds, which is what a smear of lit air
    // in front of a background actually does.
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    blendEquation: THREE.AddEquation,
  });
  // A clone deep-copies its uniforms, which would sever the link to the shared
  // sky/sun state and freeze the disc at build-time lighting. AircraftView
  // re-points these by name after cloning.
  mat.userData.sharedUniformNames = PROP_DISC_SHARED_UNIFORMS;
  return mat;
}

