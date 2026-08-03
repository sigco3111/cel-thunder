/**
 * Aircraft archetypes — the single source of truth consumed by the flight
 * model, the procedural mesh builder, the damage model and the UI.
 *
 * Figures are drawn from real WWII-era performance data and then tuned for
 * readable arcade-sim handling. Keep the units honest (SI) — the flight model
 * assumes them.
 */

export type Nation = 'britain' | 'germany' | 'usa' | 'japan' | 'ussr';
export type Role = 'fighter' | 'interceptor' | 'attacker' | 'boom-and-zoom' | 'turnfighter';

export interface GunSpec {
  /** Display name, e.g. "20 mm MG 151/20". */
  name: string;
  /** Calibre in mm — drives damage, penetration and tracer size. */
  calibre: number;
  /** Rounds per minute per barrel. */
  rpm: number;
  /** Number of barrels of this type. */
  count: number;
  /** Muzzle velocity, m/s. */
  muzzle: number;
  /** Rounds carried per barrel. */
  ammo: number;
  /** Body-space mount offsets (metres, +X right, +Y up, +Z forward). */
  mounts: [number, number, number][];
  /** Explosive filler in grams (0 for ball/AP). Drives blast damage. */
  he: number;
  /** Projectile mass, kg — combined with drag for the ballistic arc. */
  mass: number;
  /** Which trigger group: 1 = primary, 2 = secondary. */
  group: 1 | 2;
  /** Tracer colour as 0xRRGGBB. */
  tracer: number;
}

export interface EngineSpec {
  kind: 'inline' | 'radial';
  /** Rated power at sea level, kW. */
  powerKw: number;
  /** WEP multiplier over rated power. */
  wepMul: number;
  /** Altitude of peak power (supercharger critical altitude), m. */
  critAlt: number;
  /** Power falloff above/below critical altitude — higher = sharper. */
  altFalloff: number;
  /** Propeller diameter, m. */
  propDia: number;
  /** Max propeller RPM. */
  maxRpm: number;
  /** Rotation sense seen from cockpit: +1 clockwise (P-factor / torque sign). */
  propDir: 1 | -1;
  /** Blade count — visual + disc opacity. */
  blades: number;
  /** Seconds from idle to full power (spool). */
  spool: number;
}

export interface AeroSpec {
  /** Wing reference area, m². */
  wingArea: number;
  /** Wing span, m. */
  span: number;
  /** Mean aerodynamic chord, m. */
  chord: number;
  /** Empty + fuel + ammo mass, kg. */
  mass: number;
  /** Moments of inertia about body X (pitch), Y (yaw), Z (roll), kg·m². */
  inertia: [number, number, number];
  /** Zero-lift drag coefficient (gear/flaps up). */
  cd0: number;
  /** Oswald efficiency factor for induced drag. */
  oswald: number;
  /** Lift-curve slope, per radian (thin-aerofoil ≈ 2π, real wings less). */
  clAlpha: number;
  /** Angle of attack at which the wing stalls, radians. */
  stallAlpha: number;
  /** Max lift coefficient. */
  clMax: number;
  /** Zero-alpha lift coefficient from aerofoil camber. */
  cl0: number;
  /** Control authority: max roll rate rad/s at ~400 km/h IAS. */
  rollRate: number;
  /** Max pitch rate rad/s at corner speed. */
  pitchRate: number;
  /** Max yaw rate rad/s. */
  yawRate: number;
  /** Static stability derivatives (restoring moment coefficients). */
  cmAlpha: number;   // pitch stiffness (negative = stable)
  cnBeta: number;    // yaw stiffness (positive = stable)
  clBeta: number;    // dihedral effect (negative = roll away from sideslip)
  /** Damping derivatives about each axis. */
  damp: [number, number, number];
  /** Critical Mach — above this, drag rises and controls stiffen. */
  machCrit: number;
  /** Structural limit, g. Exceed and the wings come off. */
  gLimit: number;
  /** Never-exceed IAS, m/s. */
  vne: number;
  /** Flap lift/drag deltas at full deployment. */
  flapCl: number;
  flapCd: number;
  /** Gear drag delta. */
  gearCd: number;
  /** Airbrake drag delta (0 if not fitted). */
  brakeCd: number;
}

export interface DamageSpec {
  /** Structural hit points of the fuselage. */
  hull: number;
  /** Per-wing hit points before separation. */
  wing: number;
  /** Tail assembly hit points. */
  tail: number;
  /** Engine hit points. */
  engine: number;
  /** Armour thickness in mm at key locations. */
  armour: { pilotBack: number; pilotFront: number; engineFront: number; fuel: number };
  /** Self-sealing fuel tanks reduce fire chance. */
  selfSealing: boolean;
  /** Fuel capacity, kg — burns off, affects mass and fire severity. */
  fuel: number;
}

export interface GeometrySpec {
  /** Overall length, m. */
  length: number;
  /** Fuselage max radius, m. */
  fuseRadius: number;
  /** Wing planform: root chord, tip chord, sweep at quarter chord (rad), dihedral (rad). */
  wing: { rootChord: number; tipChord: number; sweep: number; dihedral: number; incidence: number };
  /** Tailplane span and chord. */
  hStab: { span: number; chord: number; z: number };
  /** Fin height and chord. */
  vStab: { height: number; chord: number; z: number };
  /** Canopy: start z, end z, height above fuselage centreline. */
  canopy: { z0: number; z1: number; height: number; width: number };
  /** Wing vertical offset from fuselage centreline (low/mid/high wing). */
  wingY: number;
  /** Wing longitudinal position (z). */
  wingZ: number;
  /** Radiator/intake style hint for the mesh builder. */
  intake: 'chin' | 'belly' | 'underwing' | 'none';
  /** Landing gear: main gear track, leg length, retract direction. */
  gear: { track: number; legLen: number; mainZ: number; tailWheel: boolean };
  /** Elliptical wing tips (Spitfire) vs straight taper. */
  ellipticalWing: boolean;
}

export interface LiverySpec {
  /** Primary upper-surface camouflage colours. */
  camoA: number;
  camoB: number;
  /** Under-surface colour. */
  under: number;
  /** Spinner / nose art accent. */
  accent: number;
  /** Roundel / insignia style. */
  insignia: Nation;
  /** Camouflage pattern generator. */
  pattern: 'splinter' | 'blotch' | 'wave' | 'solid' | 'mottle';
}

export interface AircraftSpec {
  id: string;
  name: string;
  nation: Nation;
  role: Role;
  year: number;
  /** Battle rating — used for matchmaking/balance display. */
  br: number;
  engine: EngineSpec;
  aero: AeroSpec;
  guns: GunSpec[];
  damage: DamageSpec;
  geom: GeometrySpec;
  livery: LiverySpec;
  /** Ordnance loadouts. */
  bombs?: { name: string; count: number; kg: number; mounts: [number, number, number][] };
  rockets?: { name: string; count: number; kg: number; he: number; mounts: [number, number, number][] };
}

// ---------------------------------------------------------------------------

const spitfire: AircraftSpec = {
  id: 'spitfire_mk9',
  name: 'Spitfire Mk IX',
  nation: 'britain',
  role: 'turnfighter',
  year: 1942,
  br: 4.7,
  engine: {
    kind: 'inline', powerKw: 1096, wepMul: 1.18, critAlt: 6400, altFalloff: 1.0,
    propDia: 3.27, maxRpm: 3000, propDir: 1, blades: 4, spool: 1.6,
  },
  aero: {
    wingArea: 22.48, span: 11.23, chord: 2.03, mass: 3400,
    inertia: [7800, 12500, 5200],
    cd0: 0.0229, oswald: 0.82, clAlpha: 5.1, stallAlpha: 0.279, clMax: 1.42, cl0: 0.12,
    rollRate: 2.24, pitchRate: 1.15, yawRate: 0.62,
    cmAlpha: -0.72, cnBeta: 0.13, clBeta: -0.10, damp: [11.5, 4.8, 6.2],
    machCrit: 0.75, gLimit: 9.6, vne: 208,
    flapCl: 0.55, flapCd: 0.075, gearCd: 0.021, brakeCd: 0,
  },
  guns: [
    {
      name: '20 mm Hispano Mk II', calibre: 20, rpm: 600, count: 2, muzzle: 860, ammo: 120,
      mounts: [[-2.5, -0.18, 0.9], [2.5, -0.18, 0.9]], he: 10.5, mass: 0.130, group: 2, tracer: 0xffd36b,
    },
    {
      name: '7.7 mm Browning', calibre: 7.7, rpm: 1150, count: 4, muzzle: 811, ammo: 350,
      mounts: [[-3.3, -0.15, 0.85], [-3.7, -0.15, 0.82], [3.3, -0.15, 0.85], [3.7, -0.15, 0.82]],
      he: 0, mass: 0.0115, group: 1, tracer: 0xfff0a8,
    },
  ],
  damage: {
    hull: 210, wing: 130, tail: 95, engine: 110,
    armour: { pilotBack: 9, pilotFront: 4, engineFront: 3, fuel: 0 },
    selfSealing: true, fuel: 285,
  },
  geom: {
    length: 9.47, fuseRadius: 0.62,
    wing: { rootChord: 2.6, tipChord: 0.95, sweep: 0.04, dihedral: 0.105, incidence: 0.035 },
    hStab: { span: 3.2, chord: 1.05, z: -3.9 },
    vStab: { height: 1.5, chord: 1.5, z: -4.0 },
    canopy: { z0: 0.35, z1: -1.5, height: 0.52, width: 0.52 },
    wingY: -0.22, wingZ: 0.35, intake: 'underwing',
    gear: { track: 1.7, legLen: 0.95, mainZ: 0.9, tailWheel: true },
    ellipticalWing: true,
  },
  livery: { camoA: 0x4a5c3a, camoB: 0x6b5a3c, under: 0x9fb4c4, accent: 0xb03a2e, insignia: 'britain', pattern: 'wave' },
};

const bf109: AircraftSpec = {
  id: 'bf109_g6',
  name: 'Bf 109 G-6',
  nation: 'germany',
  role: 'boom-and-zoom',
  year: 1943,
  br: 4.7,
  engine: {
    kind: 'inline', powerKw: 1100, wepMul: 1.15, critAlt: 6900, altFalloff: 1.05,
    propDia: 3.0, maxRpm: 2800, propDir: -1, blades: 3, spool: 1.5,
  },
  aero: {
    wingArea: 16.05, span: 9.92, chord: 1.74, mass: 3200,
    inertia: [6600, 10800, 3900],
    cd0: 0.0217, oswald: 0.79, clAlpha: 4.95, stallAlpha: 0.262, clMax: 1.34, cl0: 0.10,
    rollRate: 1.92, pitchRate: 1.22, yawRate: 0.58,
    cmAlpha: -0.68, cnBeta: 0.125, clBeta: -0.085, damp: [10.2, 4.4, 5.1],
    machCrit: 0.78, gLimit: 10.2, vne: 216,
    flapCl: 0.60, flapCd: 0.082, gearCd: 0.019, brakeCd: 0,
  },
  guns: [
    {
      name: '20 mm MG 151/20', calibre: 20, rpm: 700, count: 1, muzzle: 800, ammo: 200,
      mounts: [[0, 0, 1.9]], he: 18.6, mass: 0.115, group: 2, tracer: 0xffc94d,
    },
    {
      name: '13 mm MG 131', calibre: 13, rpm: 900, count: 2, muzzle: 750, ammo: 300,
      mounts: [[-0.28, 0.34, 1.35], [0.28, 0.34, 1.35]], he: 1.2, mass: 0.0343, group: 1, tracer: 0xffe08a,
    },
  ],
  damage: {
    hull: 200, wing: 118, tail: 88, engine: 115,
    armour: { pilotBack: 8, pilotFront: 5, engineFront: 4, fuel: 0 },
    selfSealing: true, fuel: 300,
  },
  geom: {
    length: 8.95, fuseRadius: 0.58,
    wing: { rootChord: 2.2, tipChord: 0.9, sweep: 0.06, dihedral: 0.115, incidence: 0.033 },
    hStab: { span: 3.1, chord: 1.0, z: -3.6 },
    vStab: { height: 1.35, chord: 1.45, z: -3.7 },
    canopy: { z0: 0.1, z1: -1.35, height: 0.5, width: 0.48 },
    wingY: -0.20, wingZ: 0.3, intake: 'underwing',
    gear: { track: 2.0, legLen: 0.9, mainZ: 1.35, tailWheel: true },
    ellipticalWing: false,
  },
  livery: { camoA: 0x6f7a5c, camoB: 0x8b9375, under: 0x9db6c6, accent: 0xf0d060, insignia: 'germany', pattern: 'mottle' },
};

const p51: AircraftSpec = {
  id: 'p51d',
  name: 'P-51D Mustang',
  nation: 'usa',
  role: 'boom-and-zoom',
  year: 1944,
  br: 5.0,
  engine: {
    kind: 'inline', powerKw: 1111, wepMul: 1.22, critAlt: 7600, altFalloff: 0.92,
    propDia: 3.4, maxRpm: 3000, propDir: 1, blades: 4, spool: 1.7,
  },
  aero: {
    wingArea: 21.83, span: 11.28, chord: 1.98, mass: 4585,
    inertia: [10200, 16800, 6900],
    cd0: 0.0176, oswald: 0.85, clAlpha: 5.0, stallAlpha: 0.268, clMax: 1.36, cl0: 0.08,
    rollRate: 2.05, pitchRate: 1.02, yawRate: 0.55,
    cmAlpha: -0.75, cnBeta: 0.14, clBeta: -0.095, damp: [12.8, 5.4, 6.8],
    machCrit: 0.80, gLimit: 10.0, vne: 232,
    flapCl: 0.62, flapCd: 0.09, gearCd: 0.022, brakeCd: 0,
  },
  guns: [
    {
      name: '12.7 mm M2 Browning', calibre: 12.7, rpm: 800, count: 6, muzzle: 887, ammo: 300,
      mounts: [
        [-1.6, -0.22, 1.0], [-2.0, -0.22, 0.95], [-2.4, -0.22, 0.9],
        [1.6, -0.22, 1.0], [2.0, -0.22, 0.95], [2.4, -0.22, 0.9],
      ],
      he: 0, mass: 0.046, group: 1, tracer: 0xff9d4d,
    },
  ],
  damage: {
    hull: 230, wing: 145, tail: 100, engine: 120,
    armour: { pilotBack: 11, pilotFront: 8, engineFront: 6, fuel: 0 },
    selfSealing: true, fuel: 490,
  },
  geom: {
    length: 9.83, fuseRadius: 0.63,
    wing: { rootChord: 2.75, tipChord: 1.05, sweep: 0.03, dihedral: 0.087, incidence: 0.017 },
    hStab: { span: 3.9, chord: 1.15, z: -4.1 },
    vStab: { height: 1.6, chord: 1.7, z: -4.2 },
    canopy: { z0: 0.3, z1: -1.7, height: 0.56, width: 0.55 },
    wingY: -0.24, wingZ: 0.25, intake: 'belly',
    gear: { track: 3.6, legLen: 1.0, mainZ: 0.8, tailWheel: true },
    ellipticalWing: false,
  },
  livery: { camoA: 0xb8bcc0, camoB: 0xd4d8dc, under: 0xc8ccd0, accent: 0xe03c31, insignia: 'usa', pattern: 'solid' },
};

const zero: AircraftSpec = {
  id: 'a6m5',
  name: 'A6M5 Zero',
  nation: 'japan',
  role: 'turnfighter',
  year: 1943,
  br: 4.3,
  engine: {
    kind: 'radial', powerKw: 843, wepMul: 1.10, critAlt: 6000, altFalloff: 1.1,
    propDia: 3.05, maxRpm: 2600, propDir: 1, blades: 3, spool: 1.4,
  },
  aero: {
    wingArea: 21.3, span: 11.0, chord: 1.94, mass: 2733,
    inertia: [6100, 9800, 4300],
    cd0: 0.0248, oswald: 0.84, clAlpha: 5.2, stallAlpha: 0.297, clMax: 1.52, cl0: 0.14,
    rollRate: 1.68, pitchRate: 1.30, yawRate: 0.66,
    cmAlpha: -0.62, cnBeta: 0.115, clBeta: -0.105, damp: [10.8, 4.2, 5.6],
    machCrit: 0.68, gLimit: 7.8, vne: 186,
    flapCl: 0.52, flapCd: 0.07, gearCd: 0.020, brakeCd: 0,
  },
  guns: [
    {
      name: '20 mm Type 99', calibre: 20, rpm: 490, count: 2, muzzle: 750, ammo: 100,
      mounts: [[-2.3, -0.16, 0.95], [2.3, -0.16, 0.95]], he: 8.0, mass: 0.128, group: 2, tracer: 0xffcf5c,
    },
    {
      name: '13.2 mm Type 3', calibre: 13.2, rpm: 800, count: 1, muzzle: 790, ammo: 240,
      mounts: [[0.28, 0.32, 1.4]], he: 0, mass: 0.052, group: 1, tracer: 0xffe89a,
    },
  ],
  damage: {
    hull: 165, wing: 95, tail: 72, engine: 100,
    armour: { pilotBack: 0, pilotFront: 0, engineFront: 0, fuel: 0 },
    selfSealing: false, fuel: 420,
  },
  geom: {
    length: 9.12, fuseRadius: 0.66,
    wing: { rootChord: 2.5, tipChord: 1.1, sweep: 0.02, dihedral: 0.10, incidence: 0.035 },
    hStab: { span: 3.4, chord: 1.05, z: -3.7 },
    vStab: { height: 1.4, chord: 1.5, z: -3.8 },
    canopy: { z0: 0.5, z1: -1.6, height: 0.5, width: 0.5 },
    wingY: -0.26, wingZ: 0.2, intake: 'chin',
    gear: { track: 3.5, legLen: 0.9, mainZ: 0.7, tailWheel: true },
    ellipticalWing: false,
  },
  livery: { camoA: 0x4f5b3f, camoB: 0x5d6a49, under: 0xa8a58c, accent: 0xc8342a, insignia: 'japan', pattern: 'blotch' },
};

const la5: AircraftSpec = {
  id: 'la5fn',
  name: 'La-5FN',
  nation: 'ussr',
  role: 'fighter',
  year: 1943,
  br: 4.7,
  engine: {
    kind: 'radial', powerKw: 1287, wepMul: 1.12, critAlt: 5000, altFalloff: 1.15,
    propDia: 3.1, maxRpm: 2500, propDir: 1, blades: 3, spool: 1.5,
  },
  aero: {
    wingArea: 17.6, span: 9.8, chord: 1.86, mass: 3290,
    inertia: [7000, 11200, 4400],
    cd0: 0.0234, oswald: 0.80, clAlpha: 5.05, stallAlpha: 0.271, clMax: 1.40, cl0: 0.11,
    rollRate: 2.10, pitchRate: 1.20, yawRate: 0.60,
    cmAlpha: -0.66, cnBeta: 0.12, clBeta: -0.09, damp: [10.6, 4.5, 5.4],
    machCrit: 0.72, gLimit: 9.0, vne: 200,
    flapCl: 0.56, flapCd: 0.078, gearCd: 0.020, brakeCd: 0,
  },
  guns: [
    {
      name: '20 mm ShVAK', calibre: 20, rpm: 800, count: 2, muzzle: 790, ammo: 200,
      mounts: [[-0.24, 0.30, 1.6], [0.24, 0.30, 1.6]], he: 6.7, mass: 0.096, group: 2, tracer: 0xffd97a,
    },
  ],
  damage: {
    hull: 195, wing: 112, tail: 84, engine: 128,
    armour: { pilotBack: 10, pilotFront: 6, engineFront: 0, fuel: 0 },
    selfSealing: true, fuel: 340,
  },
  geom: {
    length: 8.67, fuseRadius: 0.68,
    wing: { rootChord: 2.35, tipChord: 1.0, sweep: 0.05, dihedral: 0.095, incidence: 0.03 },
    hStab: { span: 3.2, chord: 1.0, z: -3.5 },
    vStab: { height: 1.35, chord: 1.45, z: -3.6 },
    canopy: { z0: 0.2, z1: -1.4, height: 0.5, width: 0.5 },
    wingY: -0.22, wingZ: 0.3, intake: 'chin',
    gear: { track: 2.6, legLen: 0.9, mainZ: 0.9, tailWheel: true },
    ellipticalWing: false,
  },
  livery: { camoA: 0x3f4a3a, camoB: 0x2c3540, under: 0x8fa6b8, accent: 0xd03a2e, insignia: 'ussr', pattern: 'splinter' },
};

export const AIRCRAFT: AircraftSpec[] = [spitfire, bf109, p51, zero, la5];

export const AIRCRAFT_BY_ID: Record<string, AircraftSpec> =
  Object.fromEntries(AIRCRAFT.map((a) => [a.id, a]));

/** Stable index used on the wire (typeId). Keep AIRCRAFT order stable. */
export const aircraftIndex = (id: string) => AIRCRAFT.findIndex((a) => a.id === id);
export const aircraftByIndex = (i: number) => AIRCRAFT[i] ?? AIRCRAFT[0];

/** Teams: 0 = Allies (britain/usa/ussr), 1 = Axis (germany/japan). */
export const nationTeam = (n: Nation): number => (n === 'germany' || n === 'japan' ? 1 : 0);
