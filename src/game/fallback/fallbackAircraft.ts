import * as THREE from 'three';
import type { AircraftSpec } from '../../shared/aircraft';
import { createCelMaterial, addOutline, type CelMaterial } from '../../render/CelMaterial';
import { liveryTexture, insigniaTexture } from '../visual/textures';
import type { AircraftModel } from '../externals';

/**
 * Stand-in airframe builder, used only when 'src/assets/aircraft' has not
 * landed. It produces the same rig contract as the real builder — every hinged
 * part is a named 'Object3D' whose origin sits on its hinge line — so the
 * animation, damage and LOD code downstream is identical either way.
 *
 * The geometry is lofted rather than assembled from primitives: fuselages are
 * ring lofts over a smooth area distribution and flying surfaces are lofted
 * NACA sections. That costs a few dozen lines more than stacking boxes and is
 * the difference between "recognisably a Spitfire" and "programmer art".
 */

const TIP_FRACTION = 0.14;     // outboard span fraction that detaches as a wingtip
const SPAR_FRACTION = 0.74;    // chord fraction ahead of the control-surface hinge
const UV_METRES = 6;           // world metres per livery tile

/**
 * Under-surface tint, as a multiplier over the livery map. Geometry builders
 * mark each vertex 0 (upper) or 1 (lower) in the colour attribute and
 * {@link finishGeometry} resolves the marker against this — cheaper and far
 * simpler than a second material and a second draw call per surface.
 */
let underTint: [number, number, number] = [1, 1, 1];

function computeUnderTint(spec: AircraftSpec): [number, number, number] {
  const a = spec.livery.camoA, u = spec.livery.under;
  const ch = (shift: number) => {
    const av = Math.max(18, (a >> shift) & 255);
    return Math.min(2.6, ((u >> shift) & 255) / av);
  };
  return [ch(16), ch(8), ch(0)];
}

export function buildFallbackAircraft(spec: AircraftSpec): AircraftModel {
  underTint = computeUnderTint(spec);
  const geom = spec.geom;
  const L = geom.length;
  const noseZ = L * 0.47;
  const tailZ = -L * 0.53;

  const skin = makeSkinMaterial(spec);
  const dark = makeDarkMaterial();
  const glass = makeGlassMaterial();

  const root = new THREE.Group();
  root.name = `ac_${spec.id}`;

  // -------------------------------------------------------------------------
  // Fuselage
  // -------------------------------------------------------------------------
  const radial = spec.engine.kind === 'radial';
  const fuse = mesh(fuselageGeometry(spec, noseZ, tailZ, radial), skin, 'fuselage');
  root.add(fuse);

  // Chin/belly radiator or intake — silhouette detail that distinguishes types.
  if (geom.intake !== 'none') {
    const intake = makeIntake(spec, radial);
    root.add(intake);
  }

  // -------------------------------------------------------------------------
  // Wings
  // -------------------------------------------------------------------------
  const semi = geom.wing;
  const halfSpan = spec.aero.span / 2;
  const rootX = geom.fuseRadius * 0.82;
  const tipStart = halfSpan * (1 - TIP_FRACTION);

  for (const side of [-1, 1] as const) {
    const wing = mesh(
      wingGeometry({
        side, x0: rootX, x1: tipStart,
        rootChord: semi.rootChord, tipChord: semi.tipChord,
        halfSpan, sweep: semi.sweep, dihedral: semi.dihedral,
        incidence: semi.incidence, elliptical: geom.ellipticalWing,
        chordLimit: SPAR_FRACTION, tcRoot: 0.145, tcTip: 0.105,
        y0: geom.wingY, z0: geom.wingZ,
      }),
      skin, side < 0 ? 'wingL' : 'wingR',
    );
    root.add(wing);
  }

  // Detachable wingtips — separate objects so a hit can shear one off.
  const wingtipL = new THREE.Group(); wingtipL.name = 'wingtipL';
  const wingtipR = new THREE.Group(); wingtipR.name = 'wingtipR';
  for (const [side, holder] of [[-1, wingtipL], [1, wingtipR]] as const) {
    const g = wingGeometry({
      side, x0: tipStart * 0.99, x1: halfSpan,
      rootChord: semi.rootChord, tipChord: semi.tipChord,
      halfSpan, sweep: semi.sweep, dihedral: semi.dihedral,
      incidence: semi.incidence, elliptical: geom.ellipticalWing,
      chordLimit: 1.0, tcRoot: 0.11, tcTip: 0.09,
      y0: geom.wingY, z0: geom.wingZ,
    });
    holder.add(mesh(g, skin, side < 0 ? 'wingtipLMesh' : 'wingtipRMesh'));
    root.add(holder);
  }

  // Ailerons: outboard 44 % of the exposed span, hinged at the spar line.
  const ailInner = rootX + (tipStart - rootX) * 0.54;
  const aileronL = makeSurface(spec, skin, -1, ailInner, tipStart, 'aileronL');
  const aileronR = makeSurface(spec, skin, 1, ailInner, tipStart, 'aileronR');
  root.add(aileronL, aileronR);

  // Flaps: inboard, from the fuselage side to the aileron.
  const flapL = makeSurface(spec, skin, -1, rootX, ailInner * 0.98, 'flapL');
  const flapR = makeSurface(spec, skin, 1, rootX, ailInner * 0.98, 'flapR');
  root.add(flapL, flapR);

  // -------------------------------------------------------------------------
  // Empennage
  // -------------------------------------------------------------------------
  const hs = geom.hStab;
  for (const side of [-1, 1] as const) {
    const stab = mesh(
      wingGeometry({
        side, x0: geom.fuseRadius * 0.35, x1: hs.span / 2,
        rootChord: hs.chord, tipChord: hs.chord * 0.62,
        halfSpan: hs.span / 2, sweep: 0.18, dihedral: 0.02, incidence: 0,
        elliptical: false, chordLimit: 0.62, tcRoot: 0.10, tcTip: 0.09,
        y0: geom.fuseRadius * 0.12, z0: hs.z,
      }),
      skin, side < 0 ? 'hstabL' : 'hstabR',
    );
    root.add(stab);
  }
  const elevatorL = makeTailSurface(skin, -1, geom.fuseRadius * 0.35, hs.span / 2, hs.chord, hs.z, geom.fuseRadius * 0.12, 'elevatorL');
  const elevatorR = makeTailSurface(skin, 1, geom.fuseRadius * 0.35, hs.span / 2, hs.chord, hs.z, geom.fuseRadius * 0.12, 'elevatorR');
  root.add(elevatorL, elevatorR);

  const vs = geom.vStab;
  const fin = mesh(finGeometry(vs.height, vs.chord, vs.z, geom.fuseRadius * 0.35, 0.58), skin, 'fin');
  root.add(fin);

  const rudder = new THREE.Group();
  rudder.name = 'rudder';
  rudder.position.set(0, geom.fuseRadius * 0.3, vs.z - vs.chord * 0.08);
  const rudderMesh = mesh(rudderGeometry(vs.height, vs.chord * 0.42), skin, 'rudderMesh');
  rudder.add(rudderMesh);
  root.add(rudder);

  // -------------------------------------------------------------------------
  // Canopy, pilot
  // -------------------------------------------------------------------------
  const canopy = new THREE.Group();
  canopy.name = 'canopy';
  const canopyMesh = mesh(canopyGeometry(spec), glass, 'canopyGlass');
  canopyMesh.userData.noOutline = true;
  canopy.add(canopyMesh);
  // Frame rails so the glass has structure and reads at distance.
  canopy.add(mesh(canopyFrameGeometry(spec), dark, 'canopyFrame'));
  root.add(canopy);

  const pilot = makePilot(spec, dark);
  root.add(pilot);

  // -------------------------------------------------------------------------
  // Propeller
  // -------------------------------------------------------------------------
  const propHub = new THREE.Group();
  propHub.name = 'propHub';
  propHub.position.set(0, 0, noseZ + 0.04);

  const spinner = mesh(spinnerGeometry(spec), makeAccentMaterial(spec), 'spinner');
  propHub.add(spinner);

  const propeller = new THREE.Group();
  propeller.name = 'propeller';
  const bladeGeo = bladeGeometry(spec.engine.propDia / 2, spec.engine.propDia * 0.075);
  for (let i = 0; i < spec.engine.blades; i++) {
    const b = mesh(bladeGeo, dark, `blade${i}`);
    b.rotation.z = (i / spec.engine.blades) * Math.PI * 2;
    propeller.add(b);
  }
  propHub.add(propeller);

  const propDisc = new THREE.Mesh(
    new THREE.CircleGeometry(spec.engine.propDia / 2, 48),
    makeDiscMaterial(spec),
  );
  propDisc.name = 'propDisc';
  propDisc.position.z = 0.06;
  propDisc.visible = false;
  propDisc.userData.noOutline = true;
  propDisc.renderOrder = 3;
  propHub.add(propDisc);
  root.add(propHub);

  // -------------------------------------------------------------------------
  // Landing gear
  // -------------------------------------------------------------------------
  const gearSpec = geom.gear;
  const gearL = makeMainGear(gearSpec, -1, geom.wingY, dark);
  const gearR = makeMainGear(gearSpec, 1, geom.wingY, dark);
  root.add(gearL, gearR);

  const gearDoorL = makeGearDoor(gearSpec, -1, geom.wingY, skin);
  const gearDoorR = makeGearDoor(gearSpec, 1, geom.wingY, skin);
  root.add(gearDoorL, gearDoorR);

  const gearTail = new THREE.Group();
  gearTail.name = 'gearTail';
  gearTail.position.set(0, -geom.fuseRadius * 0.55, tailZ + 0.7);
  const tailLeg = mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.42, 8), dark, 'tailLeg');
  tailLeg.position.y = -0.21;
  const tailWheel = mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.09, 14), dark, 'tailWheel');
  tailWheel.rotation.z = Math.PI / 2;
  tailWheel.position.y = -0.42;
  tailWheel.name = 'wheelTail';
  gearTail.add(tailLeg, tailWheel);
  if (gearSpec.tailWheel) root.add(gearTail);

  // -------------------------------------------------------------------------
  // Anchors
  // -------------------------------------------------------------------------
  const exhaustPorts: THREE.Object3D[] = [];
  const stackCount = radial ? 2 : 6;
  const stackGeo = new THREE.CylinderGeometry(0.045, 0.055, 0.16, 6);
  for (let i = 0; i < stackCount; i++) {
    for (const side of [-1, 1] as const) {
      const port = new THREE.Object3D();
      const z = radial
        ? noseZ - 0.9 - i * 0.3
        : noseZ - 0.75 - i * (L * 0.055);
      port.position.set(side * geom.fuseRadius * 0.85, geom.fuseRadius * 0.18, z);
      port.name = `exhaust_${side < 0 ? 'L' : 'R'}${i}`;
      const stack = mesh(stackGeo, dark, 'stack');
      stack.rotation.z = Math.PI / 2;
      stack.rotation.y = side * 0.25;
      port.add(stack);
      root.add(port);
      exhaustPorts.push(port);
    }
  }

  const gunPorts: THREE.Object3D[] = [];
  for (const gun of spec.guns) {
    for (const m of gun.mounts) {
      const port = new THREE.Object3D();
      port.position.set(m[0], m[1], m[2]);
      port.name = `gunport_${gun.calibre}`;
      port.userData.calibre = gun.calibre;
      port.userData.tracer = gun.tracer;
      root.add(port);
      gunPorts.push(port);
      // Barrels only for wing-mounted guns; cowl guns are buried.
      if (Math.abs(m[0]) > geom.fuseRadius) {
        const barrel = mesh(
          new THREE.CylinderGeometry(gun.calibre * 0.0009, gun.calibre * 0.0011, 0.55, 6),
          dark, 'barrel',
        );
        barrel.rotation.x = Math.PI / 2;
        barrel.position.z = 0.2;
        port.add(barrel);
      }
    }
  }

  // National markings on the wings and fuselage.
  addInsignia(root, spec);

  // -------------------------------------------------------------------------
  // Outlines + LOD
  // -------------------------------------------------------------------------
  addOutlinesTo(root, 0.011);

  const detail = root;
  const lod = new THREE.LOD();
  lod.name = `lod_${spec.id}`;
  lod.addLevel(detail, 0);
  lod.addLevel(makeImpostor(spec, skin), 3200);

  const model: AircraftModel = {
    root: lod,
    propeller, propDisc, spinner,
    aileronL, aileronR, elevatorL, elevatorR, rudder,
    flapL, flapR,
    gearL, gearR, gearTail: gearSpec.tailWheel ? gearTail : undefined,
    gearDoorL, gearDoorR,
    canopy, pilot,
    wingtipL, wingtipR,
    exhaustPorts, gunPorts,
    damageParts: { fuselage: fuse, fin, propHub },
  };
  (model as Record<string, unknown>).__fallback = true;
  (model as Record<string, unknown>).__materials = [skin, dark, glass];
  return model;
}

export function disposeFallbackAircraft(model: AircraftModel): void {
  model.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.geometry.dispose();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat.dispose();
    }
  });
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

function makeSkinMaterial(spec: AircraftSpec): CelMaterial {
  return createCelMaterial({
    name: `skin_${spec.id}`,
    map: liveryTexture(spec),
    color: 0xffffff,
    vertexColors: true,
    bands: 3,
    bandSoftness: 0.05,
    gloss: 0.28,
    specular: 0.55,
    specSteps: 2,
    rimStrength: 0.9,
    rimPower: 3.0,
    shadowTint: 0x5c7ba6,
    terminatorTint: 0xffa864,
    outline: true,
  });
}

function makeDarkMaterial(): CelMaterial {
  return createCelMaterial({
    name: 'ac_dark',
    color: 0x2a2e34,
    bands: 3,
    gloss: 0.18,
    specular: 0.35,
    rimStrength: 0.7,
    shadowTint: 0x47607f,
  });
}

function makeAccentMaterial(spec: AircraftSpec): CelMaterial {
  return createCelMaterial({
    name: `ac_accent_${spec.id}`,
    color: spec.livery.accent,
    bands: 3,
    gloss: 0.12,
    specular: 0.8,
    specSteps: 1,
    rimStrength: 1.0,
  });
}

function makeGlassMaterial(): CelMaterial {
  // Canopy glazing: barely-there tint, one hard specular shape, strong rim.
  // Transparent so the pilot reads through it, but depth-writing so the
  // silhouette pass still sees the cockpit volume.
  return createCelMaterial({
    name: 'ac_glass',
    color: 0x9fc4d8,
    transparent: true,
    opacity: 0.34,
    bands: 2,
    gloss: 0.02,
    specular: 1.6,
    specSteps: 1,
    rimStrength: 1.5,
    rimPower: 2.0,
    shadowTint: 0x6d90bd,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/**
 * Propeller disc. Opacity rises with blade count because more blades sweep
 * more of the annulus per revolution; the radial gradient reproduces the way a
 * real blurred prop is nearly transparent at the hub and densest at ~0.7 R.
 */
function makeDiscMaterial(spec: AircraftSpec): THREE.ShaderMaterial {
  const density = 0.10 + spec.engine.blades * 0.038;
  return new THREE.ShaderMaterial({
    uniforms: {
      uOpacity: { value: 0 },
      uDensity: { value: density },
      uTint: { value: new THREE.Color(0x2b2f36) },
      uHot: { value: new THREE.Color(spec.livery.accent) },
      uPhase: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv * 2.0 - 1.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uOpacity;
      uniform float uDensity;
      uniform vec3  uTint;
      uniform vec3  uHot;
      uniform float uPhase;
      varying vec2 vUv;
      void main() {
        float r = length( vUv );
        if ( r > 1.0 ) discard;
        // Blade density peaks near 0.7 R and vanishes at the hub and the tip.
        float band = smoothstep( 0.10, 0.34, r ) * ( 1.0 - smoothstep( 0.86, 1.0, r ) );
        float a = atan( vUv.y, vUv.x );
        // Faint rotating streaks: the residual of individual blades, which is
        // what stops a blurred prop from looking like a flat grey plate.
        float streak = 0.5 + 0.5 * sin( a * 22.0 + uPhase );
        float alpha = uOpacity * uDensity * band * ( 0.72 + 0.28 * streak );
        // Tip flash: the outer few percent catches the sun.
        float tip = smoothstep( 0.90, 0.99, r ) * ( 1.0 - smoothstep( 0.99, 1.0, r ) );
        vec3 col = mix( uTint, uHot, tip * 0.8 );
        gl_FragColor = vec4( col, clamp( alpha + tip * uOpacity * 0.35, 0.0, 1.0 ) );
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, name: string): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.name = name;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function addOutlinesTo(root: THREE.Object3D, width: number): void {
  const targets: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !m.name.endsWith('__outline') && m.userData.noOutline !== true) targets.push(m);
  });
  for (const m of targets) addOutline(m, width, 0x0b0f16);
}

/**
 * NACA-style closed aerofoil outline in (chord, thickness) space, cosine
 * spaced so the leading edge keeps its curvature at low vertex counts.
 */
function foilOutline(n: number, tc: number, camber: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  const yt = (x: number) =>
    5 * tc * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4);
  const yc = (x: number) => camber * (x < 0.4 ? (2 * 0.4 * x - x * x) / 0.16 : ((1 - 2 * 0.4) + 2 * 0.4 * x - x * x) / 0.36);
  for (let i = 0; i <= n; i++) {
    const x = 0.5 - 0.5 * Math.cos((i / n) * Math.PI);
    pts.push([x, yc(x) + yt(x)]);
  }
  for (let i = n - 1; i > 0; i--) {
    const x = 0.5 - 0.5 * Math.cos((i / n) * Math.PI);
    pts.push([x, yc(x) - yt(x)]);
  }
  return pts;
}

interface WingOpts {
  side: -1 | 1;
  x0: number; x1: number;
  rootChord: number; tipChord: number;
  halfSpan: number;
  sweep: number; dihedral: number; incidence: number;
  elliptical: boolean;
  chordLimit: number;
  tcRoot: number; tcTip: number;
  y0: number; z0: number;
}

/**
 * Lofts a flying surface between two spanwise stations. 'chordLimit' truncates
 * the section at the spar so control surfaces can be modelled separately, and
 * 'elliptical' swaps the linear taper for the Spitfire's ellipse.
 */
function wingGeometry(o: WingOpts): THREE.BufferGeometry {
  const STATIONS = 9;
  const outlineRoot = foilOutline(9, o.tcRoot, 0.018);
  const P = outlineRoot.length;

  const pos: number[] = [], uv: number[] = [], col: number[] = [];
  const idx: number[] = [];

  for (let s = 0; s < STATIONS; s++) {
    const f = s / (STATIONS - 1);
    const x = o.x0 + (o.x1 - o.x0) * f;
    const t = Math.min(1, x / o.halfSpan);              // 0 at centreline, 1 at tip
    const taper = o.elliptical
      ? Math.sqrt(Math.max(0.02, 1 - t * t)) * 1.02
      : 1 - t * (1 - o.tipChord / o.rootChord);
    const chord = o.rootChord * taper;
    const tc = o.tcRoot + (o.tcTip - o.tcRoot) * t;
    const outline = foilOutline(9, tc, 0.018);

    // Quarter-chord sweep line and dihedral rise.
    const leZ = o.z0 + o.rootChord * 0.25 - chord * 0.25 - Math.tan(o.sweep) * x;
    const y = o.y0 + Math.tan(o.dihedral) * x;
    const inc = o.incidence * (1 - t * 0.55);            // washout toward the tip

    for (let p = 0; p < P; p++) {
      const [cx, cy] = outline[p];
      const cxl = Math.min(cx, o.chordLimit);
      // Chordwise axis points aft (−Z); thickness along +Y, rotated by incidence.
      const zc = -cxl * chord, yc2 = cy * chord;
      const ci = Math.cos(inc), si = Math.sin(inc);
      pos.push(
        o.side * x,
        y + yc2 * ci - zc * si,
        leZ + zc * ci + yc2 * si,
      );
      uv.push((cxl * chord) / UV_METRES, x / UV_METRES);
      // Undersides carry the pale under-surface colour.
      const under = cy < 0 ? 1 : 0;
      col.push(under, under, under);
    }
  }

  for (let s = 0; s < STATIONS - 1; s++) {
    for (let p = 0; p < P; p++) {
      const a = s * P + p, b = s * P + ((p + 1) % P);
      const c = (s + 1) * P + p, d = (s + 1) * P + ((p + 1) % P);
      if (o.side > 0) idx.push(a, c, b, b, c, d);
      else idx.push(a, b, c, b, d, c);
    }
  }
  // Cap the outboard station so a detached tip does not show a hollow shell.
  const base = (STATIONS - 1) * P;
  for (let p = 1; p < P - 1; p++) {
    if (o.side > 0) idx.push(base, base + p, base + p + 1);
    else idx.push(base, base + p + 1, base + p);
  }

  return finishGeometry(pos, uv, col, idx);
}

/** Control surface: a tapered slab hinged at its leading edge (local origin). */
function makeSurface(
  spec: AircraftSpec, mat: THREE.Material, side: -1 | 1,
  x0: number, x1: number, name: string,
): THREE.Group {
  const g = spec.geom;
  const w = g.wing;
  const halfSpan = spec.aero.span / 2;
  const holder = new THREE.Group();
  holder.name = name;

  // Hinge sits on the spar line at the inboard station.
  const t0 = Math.min(1, x0 / halfSpan);
  const taper0 = g.ellipticalWing ? Math.sqrt(Math.max(0.02, 1 - t0 * t0)) * 1.02 : 1 - t0 * (1 - w.tipChord / w.rootChord);
  const chord0 = w.rootChord * taper0;
  const leZ0 = g.wingZ + w.rootChord * 0.25 - chord0 * 0.25 - Math.tan(w.sweep) * x0;
  holder.position.set(0, g.wingY + Math.tan(w.dihedral) * x0, leZ0 - chord0 * SPAR_FRACTION);

  const pos: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
  const N = 4;
  for (let s = 0; s <= N; s++) {
    const f = s / N;
    const x = x0 + (x1 - x0) * f;
    const t = Math.min(1, x / halfSpan);
    const taper = g.ellipticalWing ? Math.sqrt(Math.max(0.02, 1 - t * t)) * 1.02 : 1 - t * (1 - w.tipChord / w.rootChord);
    const chord = w.rootChord * taper;
    const leZ = g.wingZ + w.rootChord * 0.25 - chord * 0.25 - Math.tan(w.sweep) * x;
    const localZ = (leZ - chord * SPAR_FRACTION) - holder.position.z;
    const localY = (g.wingY + Math.tan(w.dihedral) * x) - holder.position.y;
    const len = chord * (1 - SPAR_FRACTION);
    const thick = chord * 0.075 * (1 - t * 0.3);

    // Four corners: leading edge top/bottom, trailing edge top/bottom.
    pos.push(side * x, localY + thick * 0.5, localZ);
    pos.push(side * x, localY - thick * 0.5, localZ);
    pos.push(side * x, localY - thick * 0.10, localZ - len);
    pos.push(side * x, localY + thick * 0.10, localZ - len);
    for (let k = 0; k < 4; k++) uv.push((k < 2 ? 0 : len) / UV_METRES, x / UV_METRES);
    col.push(0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0);
  }
  for (let s = 0; s < N; s++) {
    for (let p = 0; p < 4; p++) {
      const a = s * 4 + p, b = s * 4 + ((p + 1) % 4);
      const c = (s + 1) * 4 + p, d = (s + 1) * 4 + ((p + 1) % 4);
      if (side > 0) idx.push(a, c, b, b, c, d);
      else idx.push(a, b, c, b, d, c);
    }
  }
  const last = N * 4;
  if (side > 0) idx.push(last, last + 1, last + 2, last, last + 2, last + 3);
  else idx.push(last, last + 2, last + 1, last, last + 3, last + 2);

  holder.add(mesh(finishGeometry(pos, uv, col, idx), mat, `${name}Mesh`));
  return holder;
}

/** Elevator half: slab hinged at the tailplane spar. */
function makeTailSurface(
  mat: THREE.Material, side: -1 | 1, x0: number, x1: number,
  chord: number, z: number, y: number, name: string,
): THREE.Group {
  const holder = new THREE.Group();
  holder.name = name;
  const hingeZ = z + chord * 0.25 - chord * 0.62;
  holder.position.set(0, y, hingeZ);

  const pos: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
  const N = 3;
  for (let s = 0; s <= N; s++) {
    const f = s / N;
    const x = x0 + (x1 - x0) * f;
    const c = chord * (1 - f * 0.38) * 0.38;
    const th = c * 0.14;
    pos.push(side * x, th * 0.5, 0);
    pos.push(side * x, -th * 0.5, 0);
    pos.push(side * x, -th * 0.08, -c);
    pos.push(side * x, th * 0.08, -c);
    for (let k = 0; k < 4; k++) uv.push((k < 2 ? 0 : c) / UV_METRES, x / UV_METRES);
    col.push(0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0);
  }
  for (let s = 0; s < N; s++) {
    for (let p = 0; p < 4; p++) {
      const a = s * 4 + p, b = s * 4 + ((p + 1) % 4);
      const c2 = (s + 1) * 4 + p, d = (s + 1) * 4 + ((p + 1) % 4);
      if (side > 0) idx.push(a, c2, b, b, c2, d);
      else idx.push(a, b, c2, b, d, c2);
    }
  }
  const last = N * 4;
  if (side > 0) idx.push(last, last + 1, last + 2, last, last + 2, last + 3);
  else idx.push(last, last + 2, last + 1, last, last + 3, last + 2);

  holder.add(mesh(finishGeometry(pos, uv, col, idx), mat, `${name}Mesh`));
  return holder;
}

function finGeometry(height: number, chord: number, z: number, y0: number, limit: number): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
  const N = 6;
  const P = 12;
  for (let s = 0; s <= N; s++) {
    const f = s / N;
    // Rounded fin planform: full chord at the root, swept and tapered upward.
    const c = chord * (1 - f * 0.45) * Math.sqrt(Math.max(0.05, 1 - f * f * 0.55));
    const y = y0 + height * f;
    const leZ = z + chord * 0.3 - c * 0.3 + f * chord * 0.22;
    const tc = 0.11 - f * 0.03;
    for (let p = 0; p < P; p++) {
      const a = (p / P) * Math.PI * 2;
      const cx = 0.5 - 0.5 * Math.cos(a > Math.PI ? Math.PI * 2 - a : a);
      const sgn = a > Math.PI ? -1 : 1;
      const th = 5 * tc * (0.2969 * Math.sqrt(cx) - 0.1260 * cx - 0.3516 * cx * cx + 0.2843 * cx ** 3 - 0.1015 * cx ** 4);
      const cl = Math.min(cx, limit);
      pos.push(sgn * th * c, y, leZ - cl * c);
      uv.push((cl * c) / UV_METRES, y / UV_METRES);
      col.push(0, 0, 0);
    }
  }
  for (let s = 0; s < N; s++) {
    for (let p = 0; p < P; p++) {
      const a = s * P + p, b = s * P + ((p + 1) % P);
      const c2 = (s + 1) * P + p, d = (s + 1) * P + ((p + 1) % P);
      idx.push(a, c2, b, b, c2, d);
    }
  }
  return finishGeometry(pos, uv, col, idx);
}

function rudderGeometry(height: number, chord: number): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
  const N = 5;
  for (let s = 0; s <= N; s++) {
    const f = s / N;
    const c = chord * (1 - f * 0.42) * Math.sqrt(Math.max(0.05, 1 - f * f * 0.5));
    const y = height * f * 1.02;
    const th = c * 0.13;
    pos.push(th * 0.5, y, 0);
    pos.push(-th * 0.5, y, 0);
    pos.push(-th * 0.06, y, -c);
    pos.push(th * 0.06, y, -c);
    for (let k = 0; k < 4; k++) uv.push((k < 2 ? 0 : c) / UV_METRES, y / UV_METRES);
    col.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }
  for (let s = 0; s < N; s++) {
    for (let p = 0; p < 4; p++) {
      const a = s * 4 + p, b = s * 4 + ((p + 1) % 4);
      const c2 = (s + 1) * 4 + p, d = (s + 1) * 4 + ((p + 1) % 4);
      idx.push(a, c2, b, b, c2, d);
    }
  }
  const last = N * 4;
  idx.push(last, last + 1, last + 2, last, last + 2, last + 3);
  return finishGeometry(pos, uv, col, idx);
}

/**
 * Fuselage as a ring loft over a smooth area distribution: a rounded nose, a
 * maximum just behind the wing leading edge, then a long taper to a knife edge
 * at the sternpost. Inline engines get a taller-than-wide section, radials a
 * round one — this is most of what makes the two engine families read apart.
 */
function fuselageGeometry(spec: AircraftSpec, noseZ: number, tailZ: number, radial: boolean): THREE.BufferGeometry {
  const R = spec.geom.fuseRadius;
  const N = 26, SEG = 16;
  const pos: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
  const kx = radial ? 1.0 : 0.86;
  const ky = radial ? 1.0 : 1.14;

  const span = noseZ - tailZ;
  for (let i = 0; i <= N; i++) {
    const f = i / N;
    const z = noseZ - span * f;
    // Area distribution: elliptical nose over the first 22 %, plateau, then a
    // cubic taper to a small but non-zero sternpost radius.
    let r: number;
    if (f < 0.22) r = R * Math.sqrt(Math.max(0.02, 1 - ((0.22 - f) / 0.22) ** 2)) * 0.98 + R * 0.16;
    else if (f < 0.46) r = R * (1.0 + 0.02 * Math.sin((f - 0.22) * 12));
    else r = R * (0.2 + 0.8 * (1 - (f - 0.46) / 0.54) ** 1.6);
    r = Math.max(R * 0.075, r);

    // Spine rises toward the cockpit and drops toward the tail.
    const spine = R * 0.16 * Math.sin(Math.min(1, Math.max(0, (f - 0.1) / 0.45)) * Math.PI);

    for (let s = 0; s < SEG; s++) {
      const a = (s / SEG) * Math.PI * 2;
      const cx = Math.sin(a) * r * kx;
      const cy = Math.cos(a) * r * ky + spine;
      pos.push(cx, cy, z);
      uv.push((a / (Math.PI * 2)) * ((2 * Math.PI * R) / UV_METRES), (noseZ - z) / UV_METRES);
      const under = Math.cos(a) < -0.25 ? 1 : 0;
      col.push(under, under, under);
    }
  }
  for (let i = 0; i < N; i++) {
    for (let s = 0; s < SEG; s++) {
      const a = i * SEG + s, b = i * SEG + ((s + 1) % SEG);
      const c = (i + 1) * SEG + s, d = (i + 1) * SEG + ((s + 1) % SEG);
      idx.push(a, b, c, b, d, c);
    }
  }
  // Caps.
  const nose = pos.length / 3;
  pos.push(0, 0, noseZ + R * 0.08); uv.push(0, 0); col.push(0, 0, 0);
  for (let s = 0; s < SEG; s++) idx.push(nose, (s + 1) % SEG, s);
  const tail = pos.length / 3;
  pos.push(0, 0, tailZ - R * 0.05); uv.push(0, 0); col.push(0, 0, 0);
  const lastRing = N * SEG;
  for (let s = 0; s < SEG; s++) idx.push(tail, lastRing + s, lastRing + ((s + 1) % SEG));

  return finishGeometry(pos, uv, col, idx);
}

function makeIntake(spec: AircraftSpec, radial: boolean): THREE.Mesh {
  const g = spec.geom;
  const R = g.fuseRadius;
  let geo: THREE.BufferGeometry;
  let px = 0, py = 0, pz = 0;
  switch (g.intake) {
    case 'chin':
      geo = new THREE.CylinderGeometry(R * 0.55, R * 0.62, R * 1.5, 12, 1, true, -Math.PI / 2, Math.PI);
      geo.rotateX(Math.PI / 2);
      py = -R * 0.55; pz = g.length * 0.24;
      break;
    case 'belly':
      geo = new THREE.CapsuleGeometry(R * 0.42, R * 2.0, 4, 10);
      geo.rotateX(Math.PI / 2);
      py = -R * 0.86; pz = -g.length * 0.06;
      break;
    case 'underwing':
    default:
      geo = new THREE.CapsuleGeometry(R * 0.26, R * 1.1, 4, 8);
      geo.rotateX(Math.PI / 2);
      px = radial ? 0 : -g.fuseRadius * 2.1;
      py = g.wingY - R * 0.5; pz = g.wingZ - R * 0.2;
      break;
  }
  const m = mesh(geo, makeDarkMaterial(), 'intake');
  m.position.set(px, py, pz);
  return m;
}

function canopyGeometry(spec: AircraftSpec): THREE.BufferGeometry {
  const c = spec.geom.canopy;
  const R = spec.geom.fuseRadius;
  const N = 10, SEG = 12;
  const pos: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
  const z0 = c.z0, z1 = c.z1;
  for (let i = 0; i <= N; i++) {
    const f = i / N;
    const z = z0 + (z1 - z0) * f;
    // Windscreen rakes up fast, the bubble peaks at ~35 % and fades into the
    // spine — a single ellipse would look like a bolted-on canopy.
    const prof = Math.sin(Math.min(1, f * 1.12) * Math.PI) ** 0.7;
    const h = c.height * prof;
    const w = c.width * (0.62 + 0.38 * prof);
    for (let s = 0; s <= SEG; s++) {
      const a = (s / SEG) * Math.PI;
      pos.push(Math.cos(a) * w, R * 0.62 + Math.sin(a) * h, z);
      uv.push(s / SEG, f);
      col.push(0, 0, 0);
    }
  }
  for (let i = 0; i < N; i++) {
    for (let s = 0; s < SEG; s++) {
      const a = i * (SEG + 1) + s, b = a + 1;
      const c2 = (i + 1) * (SEG + 1) + s, d = c2 + 1;
      idx.push(a, c2, b, b, c2, d);
    }
  }
  return finishGeometry(pos, uv, col, idx);
}

function canopyFrameGeometry(spec: AircraftSpec): THREE.BufferGeometry {
  const c = spec.geom.canopy;
  const R = spec.geom.fuseRadius;
  const parts: THREE.BufferGeometry[] = [];
  const rails = [0, 0.42, 0.78];
  for (const f of rails) {
    const z = c.z0 + (c.z1 - c.z0) * f;
    const prof = Math.sin(Math.min(1, f * 1.12) * Math.PI) ** 0.7;
    const h = c.height * prof, w = c.width * (0.62 + 0.38 * prof);
    const g = new THREE.TorusGeometry(1, 0.018 / Math.max(0.2, (h + w) * 0.5), 4, 14, Math.PI);
    g.scale(w, h, 1);
    g.translate(0, R * 0.62, z);
    parts.push(g);
  }
  return mergeGeometries(parts);
}

function makePilot(spec: AircraftSpec, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.name = 'pilot';
  const c = spec.geom.canopy;
  const R = spec.geom.fuseRadius;
  g.position.set(0, R * 0.28, c.z0 - (c.z0 - c.z1) * 0.42);

  const torso = mesh(new THREE.CapsuleGeometry(0.17, 0.24, 3, 8), mat, 'pilotTorso');
  torso.position.y = 0.18;
  const head = mesh(new THREE.SphereGeometry(0.115, 12, 10), mat, 'pilotHead');
  head.position.set(0, 0.46, 0.02);
  head.scale.set(1, 1.12, 1.05);
  // Goggles: a dark band, the only detail visible at combat range but the one
  // that makes the cockpit read as occupied.
  const goggles = mesh(new THREE.TorusGeometry(0.095, 0.022, 4, 10, Math.PI), mat, 'pilotGoggles');
  goggles.position.set(0, 0.48, 0.075);
  goggles.rotation.x = -0.25;
  const shoulders = mesh(new THREE.BoxGeometry(0.42, 0.10, 0.20), mat, 'pilotShoulders');
  shoulders.position.y = 0.30;
  g.add(torso, head, goggles, shoulders);
  return g;
}

function spinnerGeometry(spec: AircraftSpec): THREE.BufferGeometry {
  const r = spec.engine.propDia * 0.10;
  const g = new THREE.ConeGeometry(r, r * 2.6, 14);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, r * 1.3);
  return g;
}

/** One propeller blade: twisted, tapered, with a rounded tip. */
function bladeGeometry(radius: number, chord: number): THREE.BufferGeometry {
  const N = 6;
  const pos: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
  const r0 = radius * 0.14;
  for (let s = 0; s <= N; s++) {
    const f = s / N;
    const r = r0 + (radius - r0) * f;
    // Blades twist from ~34° at the root to ~14° at the tip so each station
    // meets the helical airflow at a workable angle.
    const twist = (34 - 20 * f) * (Math.PI / 180);
    const c = chord * (0.62 + 0.6 * Math.sin(Math.min(1, f * 1.15) * Math.PI) ** 0.6);
    const th = c * 0.13 * (1 - f * 0.5);
    const ct = Math.cos(twist), st = Math.sin(twist);
    // Section lies in the (x = span, y/z) plane; twist rotates it about x.
    for (const [cy, cz] of [[th * 0.5, c * 0.4], [-th * 0.5, c * 0.4], [-th * 0.15, -c * 0.6], [th * 0.15, -c * 0.6]]) {
      pos.push(r, cy * ct - cz * st, cy * st + cz * ct);
      uv.push(f, 0);
      col.push(0, 0, 0);
    }
  }
  for (let s = 0; s < N; s++) {
    for (let p = 0; p < 4; p++) {
      const a = s * 4 + p, b = s * 4 + ((p + 1) % 4);
      const c2 = (s + 1) * 4 + p, d = (s + 1) * 4 + ((p + 1) % 4);
      idx.push(a, c2, b, b, c2, d);
    }
  }
  const last = N * 4;
  idx.push(last, last + 1, last + 2, last, last + 2, last + 3);
  const g = finishGeometry(pos, uv, col, idx);
  // Blades are modelled along +X and rotated into place around Z by the caller.
  return g;
}

function makeMainGear(
  gear: AircraftSpec['geom']['gear'], side: -1 | 1, wingY: number, mat: THREE.Material,
): THREE.Group {
  const g = new THREE.Group();
  g.name = side < 0 ? 'gearL' : 'gearR';
  g.position.set(side * gear.track * 0.5, wingY, gear.mainZ);

  const leg = mesh(new THREE.CylinderGeometry(0.055, 0.07, gear.legLen, 8), mat, 'gearLeg');
  leg.position.y = -gear.legLen * 0.5;
  // A modest rake, as on a real oleo.
  leg.rotation.x = 0.12;

  const scissor = mesh(new THREE.BoxGeometry(0.03, gear.legLen * 0.4, 0.06), mat, 'gearScissor');
  scissor.position.set(0, -gear.legLen * 0.42, 0.09);

  const wheel = mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.14, 18), mat, 'wheel');
  wheel.rotation.z = Math.PI / 2;
  wheel.position.set(side * 0.02, -gear.legLen, 0.04);
  const hub = mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.155, 12), mat, 'wheelHub');
  hub.rotation.z = Math.PI / 2;
  wheel.add(hub);

  g.add(leg, scissor, wheel);
  return g;
}

function makeGearDoor(
  gear: AircraftSpec['geom']['gear'], side: -1 | 1, wingY: number, mat: THREE.Material,
): THREE.Group {
  const g = new THREE.Group();
  g.name = side < 0 ? 'gearDoorL' : 'gearDoorR';
  // Hinged at the inboard edge of the wheel well.
  g.position.set(side * (gear.track * 0.5 - 0.28), wingY - 0.02, gear.mainZ);
  const door = mesh(new THREE.BoxGeometry(0.56, 0.028, 0.9), mat, 'gearDoorPanel');
  door.position.x = side * 0.28;
  g.add(door);
  return g;
}

/**
 * Distant impostor: the same silhouette at a fraction of the triangles, with
 * no moving parts. Aircraft beyond ~3.2 km are three pixels of wing anyway;
 * what matters is that the outline and the value still read.
 */
function makeImpostor(spec: AircraftSpec, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.name = `impostor_${spec.id}`;
  const geo = spec.geom;
  const body = new THREE.CapsuleGeometry(geo.fuseRadius * 0.92, geo.length * 0.62, 2, 7);
  body.rotateX(Math.PI / 2);
  const wing = new THREE.BoxGeometry(spec.aero.span, geo.fuseRadius * 0.20, geo.wing.rootChord * 0.82);
  wing.translate(0, geo.wingY, geo.wingZ - geo.wing.rootChord * 0.1);
  const tail = new THREE.BoxGeometry(geo.hStab.span, geo.fuseRadius * 0.14, geo.hStab.chord * 0.8);
  tail.translate(0, geo.fuseRadius * 0.12, geo.hStab.z);
  const fin = new THREE.BoxGeometry(geo.fuseRadius * 0.14, geo.vStab.height, geo.vStab.chord * 0.8);
  fin.translate(0, geo.vStab.height * 0.5, geo.vStab.z);
  const merged = mergeGeometries([body, wing, tail, fin]);
  const m = mesh(merged, mat, 'impostorBody');
  addOutline(m, 0.014, 0x0b0f16);
  g.add(m);
  return g;
}

function addInsignia(root: THREE.Object3D, spec: AircraftSpec): void {
  const tex = insigniaTexture(spec);
  const matTop = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false, opacity: 0.92,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const size = Math.min(1.5, spec.aero.span * 0.13);
  const geo = new THREE.PlaneGeometry(size, size);

  const w = spec.geom.wing;
  const halfSpan = spec.aero.span / 2;
  const x = halfSpan * 0.58;
  const t = x / halfSpan;
  const taper = spec.geom.ellipticalWing
    ? Math.sqrt(Math.max(0.02, 1 - t * t)) * 1.02
    : 1 - t * (1 - w.tipChord / w.rootChord);
  const chord = w.rootChord * taper;
  const leZ = spec.geom.wingZ + w.rootChord * 0.25 - chord * 0.25 - Math.tan(w.sweep) * x;
  const y = spec.geom.wingY + Math.tan(w.dihedral) * x;

  for (const side of [-1, 1] as const) {
    for (const up of [1, -1] as const) {
      const m = new THREE.Mesh(geo, matTop);
      m.name = `insignia_${side}_${up}`;
      m.userData.noOutline = true;
      m.position.set(side * x, y + up * chord * 0.055, leZ - chord * 0.42);
      m.rotation.x = up > 0 ? -Math.PI / 2 : Math.PI / 2;
      m.renderOrder = 1;
      root.add(m);
    }
  }
  // Fuselage roundel.
  for (const side of [-1, 1] as const) {
    const m = new THREE.Mesh(geo, matTop);
    m.name = `insignia_fuse_${side}`;
    m.userData.noOutline = true;
    m.position.set(side * spec.geom.fuseRadius * 0.98, 0, spec.geom.hStab.z * 0.52);
    m.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
    m.scale.setScalar(0.85);
    m.renderOrder = 1;
    root.add(m);
  }
}

// ---------------------------------------------------------------------------

function finishGeometry(pos: number[], uv: number[], col: number[], idx: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  // Resolve the 0/1 upper/lower marker into the actual under-surface tint.
  const rgb = new Float32Array(col.length);
  for (let i = 0; i < col.length; i += 3) {
    const m = col[i];
    rgb[i] = 1 + (underTint[0] - 1) * m;
    rgb[i + 1] = 1 + (underTint[1] - 1) * m;
    rgb[i + 2] = 1 + (underTint[2] - 1) * m;
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/**
 * Minimal geometry merge — 'BufferGeometryUtils' lives in the examples tree and
 * we take no dependency on it. Only handles position/uv/normal/color, indexed
 * or not, which is all this builder produces.
 */
function mergeGeometries(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
  let base = 0;
  for (const g of list) {
    const p = g.getAttribute('position');
    const u = g.getAttribute('uv');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      uv.push(u ? u.getX(i) : 0, u ? u.getY(i) : 0);
      // Merge inputs are untinted primitives — mark them all as upper surface.
      col.push(0, 0, 0);
    }
    const ix = g.getIndex();
    if (ix) for (let i = 0; i < ix.count; i++) idx.push(base + ix.getX(i));
    else for (let i = 0; i < p.count; i++) idx.push(base + i);
    base += p.count;
    g.dispose();
  }
  return finishGeometry(pos, uv, col, idx);
}
