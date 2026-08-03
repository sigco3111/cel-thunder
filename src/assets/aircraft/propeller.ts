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
  /**
   * How far the spinner reaches forward of 'hubZ'.
   *
   * The disc quad is placed part way along it rather than at its base: the
   * blade roots emerge from the middle of a Rotol spinner, and a disc sitting
   * behind the whole cone reads — from any quarter view — as a ring floating
   * *behind* the nose with the spinner poking out of it, which is most of what
   * "the disc does not encircle the spinner" was describing.
   */
  spinnerLen: number;
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
    spinnerLen: spinLen,
  };
}

// ---------------------------------------------------------------------------
// The spinning disc
// ---------------------------------------------------------------------------

/**
 * Why this is a shader and not a translucent texture — and why it is written
 * the way it is now rather than the way it was.
 *
 * A propeller turning at 1 500 rpm sweeps its blades past a given azimuth
 * twenty-five times a second. What the eye integrates is a *partly opaque
 * annulus*: mostly background seen through air, with a smear of matt-black
 * blade laid over it, thickening from the spinner out to the tip.
 *
 * The previous version got one thing badly wrong and everything else followed
 * from it. It asserted that the disc "must not darken a bright background", so
 * its colour was authored *brighter than the sky* and its base alpha was a few
 * per cent. Composited premultiplied, that makes the disc a no-op over sky: the
 * only fragments that survived were the peaks of a high-frequency angular
 * grain term and a narrow Gaussian tip ring. So the same shader produced a
 * fan of white filaments in 'hero', a bare wireframe ellipse in 'clouds',
 * concentric hairlines in 'hud' and a rimmed hoop in 'low' — four different
 * descriptions of one defect, which is that only the *detail* terms were ever
 * visible and never the disc they were meant to decorate.
 *
 * A real propeller is matt black with painted tips. Its blurred image is
 * therefore darker than a bright sky and lighter than dark terrain, and it
 * reads against both. That is the whole design here:
 *
 *  1. **A hub-to-tip radial ramp, and nothing that spikes.** Alpha climbs out
 *     of the spinner, rises with blade area, and holds all the way to a soft
 *     outer falloff. No term anywhere is allowed to reach zero between lobes
 *     or to peak at one radius: a narrow bright annulus *is* the wireframe
 *     hoop, and a modulation that bottoms out at zero *is* the filament fan.
 *     Both the blade arcs and the blur streaks are shallow modulations of a
 *     solid disc (0.72…1.0 and ±13 %), never the disc itself.
 *
 *  2. **Blade-paint colour, not sky colour.** Mid-value, sun-graded across the
 *     azimuth so one half of the annulus is lit and the other skylit, with a
 *     strong forward-scatter lift when the sun is ahead of the aeroplane —
 *     which is what saves the golden-hour frame, where the disc is genuinely
 *     luminous.
 *
 *  3. **Painted tips as a tint, not as alpha.** The yellow tip band is a wide,
 *     low-contrast colour shift over the outer third with only a 25 % alpha
 *     lift where a blade currently is. The previous 0.20 *additive* tip spike
 *     at a 0.055-wide Gaussian was the bright rim line the critique called out
 *     in four separate frames.
 *
 * The composite stays premultiplied ('One / OneMinusSrcAlpha'): with a colour
 * that can be either side of the background it both attenuates and adds, which
 * is exactly what a partly transparent lit medium does.
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
varying float vFace;

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

  // How square-on the disc is to the lens.
  //
  // The blur is a *volume* of swept blade, not a decal, so the path length the
  // eye looks through is 1/cos of the viewing angle. Seen edge-on the annulus
  // covers a handful of pixels and every one of them is looking through the
  // whole width of the sweep, which is why a propeller photographed from the
  // beam is a dense dark sliver rather than an invisible line. Without this,
  // the same alpha that reads face-on disappears entirely at the angles the
  // 'clouds' and 'hero' framings use.
  vec3 axis = normalize((modelViewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
  vec3 toEye = normalize(-mv.xyz);
  vFace = abs(dot(axis, toEye));

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
uniform float uKeyLevel;
uniform float uOpacity;
uniform float uPhase;
uniform float uBlades;
varying vec2 vP;
varying vec2 vSun;
varying float vSunZ;
varying float vDepth;
varying float vFace;

void main() {
  float r = length(vP);
  if (r > 1.0) discard;
  vec2 dir = r > 1e-4 ? vP / r : vec2(1.0, 0.0);
  float ang = atan(dir.y, dir.x);

  // --- density: one monotone ramp out of the hub ---------------------------
  // The spinner fills the inboard fifth. The ramp out of it is smooth and
  // short: too long and the disc is a ring with a hole punched in it rather
  // than a smear centred on the nose.
  float hub = smoothstep(0.06, 0.30, r);
  // Soft outer falloff, wide enough that the rim can never draw a line.
  float edge = 1.0 - smoothstep(0.82, 1.0, r);
  // Blade area swept per unit annulus. Chord peaks a little outboard of
  // mid-span, and because the pitch flattens toward the tip the projected
  // smear stays thick all the way out — so this is a broad hump on a
  // substantial floor, never a lobe that closes to nothing.
  float chord = 0.54 + 0.46 * exp(-pow((r - 0.72) / 0.50, 2.0));

  // Blade-count arcs, advanced by the hub phase. Shallow: this modulates a
  // solid disc, it is not the disc.
  float sweep = 0.5 + 0.5 * cos(ang * uBlades - uPhase * uBlades);
  float arc = 0.72 + 0.28 * sweep * sweep;
  // Blade-blur streaks — the fine radial texture of a real disc. Bounded to
  // +-13 % so it can decorate the smear but never become the only thing left
  // of it, which is what the previous 0.66 + 0.34 grain term did over a bright
  // sky: the troughs went to zero alpha and only the crests survived, as a fan
  // of white hairs off the nose.
  float streak = 1.0 + 0.13 * sin(ang * uBlades * 4.0 - uPhase * uBlades * 4.0 + r * 9.0);

  // Optical thickness of the annulus, thickened by the slant path length (see
  // vFace), then turned into coverage through Beer-Lambert. Going through the
  // exponential rather than using the thickness directly is what keeps the
  // grazing-angle case honest: the slant term can double the path without ever
  // pushing the disc past the roughly two-thirds opacity a real one reaches,
  // and it softens the outer falloff into a curve with no terminating edge.
  float slant = mix(1.5, 1.0, smoothstep(0.0, 0.55, vFace));
  // Thinned right up close. From the cockpit the disc is two and a half metres
  // from the eye and fills most of the windscreen, and at the density that
  // reads correctly from twenty metres it becomes a structureless warm wash
  // over the gunsight. A pilot cannot focus on it either — at that distance it
  // is a shimmer, not a surface.
  float near = mix(0.45, 1.0, smoothstep(2.0, 7.0, vDepth));
  float tau = 1.10 * near * slant * hub * edge * chord * arc * streak;
  float a = 1.0 - exp(-tau);

  // --- colour: blade paint, not sky ----------------------------------------
  // Which half of the annulus has its blade faces turned to the sun. This is
  // the gradient that makes the disc read as a rotating solid rather than as
  // a decal, and it works at every view angle because it is computed in the
  // propeller's own frame.
  float lit = 0.5 + 0.5 * dot(dir, vSun);
  // Sun ahead of the aeroplane: we are looking *through* a backlit blur, which
  // forward-scatters hard. This is what makes the golden-hour disc luminous.
  float glow = clamp(vSunZ, 0.0, 1.0);

  vec3 skylit = uSkyColor * 0.44;
  vec3 sunlit = uSunColor * uKeyLevel * 0.115;
  vec3 col = mix(skylit, sunlit, clamp(lit * 0.85 + 0.10, 0.0, 1.0));
  col += sunlit * (0.95 * glow * (0.35 + 0.65 * lit));

  // Painted tips: a wide, low-contrast warm band over the outer third, with
  // only a small alpha lift where a blade currently is. As a tint it reads as
  // paint being swept round at 250 m/s; as an alpha spike — which is what it
  // used to be — it reads as a wire hoop hung in front of the nose.
  float tipBand = smoothstep(0.58, 0.94, r) * edge;
  col = mix(col, uTip * (0.30 + 0.55 * lit) + sunlit * 0.45, tipBand * 0.30);
  a *= 1.0 + 0.22 * tipBand * sweep;

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
  'uKeyLevel',
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
      uKeyLevel: celGlobals.uKeyLevel,
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

