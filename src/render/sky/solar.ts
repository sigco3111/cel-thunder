import * as THREE from 'three';

/**
 * Real solar/lunar ephemeris plus a CPU mirror of the atmospheric scattering
 * model used by the sky shader.
 *
 * Why bother with a real ephemeris in an arcade air-combat game: the *shape* of
 * a day is what sells a sky. A hand-authored keyframe curve gives you a sunrise
 * that is symmetric with sunset, a sun that tracks a great circle through the
 * zenith regardless of season, and twilight of the wrong length. The correct
 * declination/hour-angle solution gives you, for free, a sun that rises in the
 * north-east in June over Normandy, a shallow winter arc, and twilight that
 * lasts the right number of minutes for the latitude. All of that is legible in
 * a screenshot even when the player could never name why.
 *
 * Coordinate convention (matches the brief): right-handed, +Y up, +X east,
 * -Z north. Azimuth is measured from north, increasing eastward.
 */

const DEG = Math.PI / 180;
const J2000 = 2451545.0;

const norm360 = (d: number): number => d - 360 * Math.floor(d / 360);

/** Julian Day for a UTC calendar date plus fractional hours. */
export function julianDay(year: number, month: number, day: number, hoursUtc: number): number {
  let y = year, m = month;
  if (m <= 2) { y -= 1; m += 12; }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1))
    + day + b - 1524.5 + hoursUtc / 24;
}

/** Greenwich mean sidereal time in degrees. */
export function gmstDeg(jd: number): number {
  return norm360(280.46061837 + 360.98564736629 * (jd - J2000));
}

export interface EquatorialPos { ra: number; dec: number }
export interface HorizontalPos { alt: number; az: number }

/**
 * Equatorial -> horizontal for an observer at 'latRad' with local sidereal time
 * 'lstRad'.
 *
 * 'out' is mandatory rather than optional on purpose: this runs five times per
 * frame from 'computeEphemeris', and the brief's "nothing in the per-frame path
 * allocates" rule is a hard one. Callers pass one of the module-level structs.
 */
export function equatorialToHorizontal(
  eq: EquatorialPos, latRad: number, lstRad: number, out: HorizontalPos,
): HorizontalPos {
  const H = lstRad - eq.ra;                     // hour angle
  const sinLat = Math.sin(latRad), cosLat = Math.cos(latRad);
  const sinDec = Math.sin(eq.dec), cosDec = Math.cos(eq.dec);
  const cosH = Math.cos(H), sinH = Math.sin(H);
  out.alt = Math.asin(Math.max(-1, Math.min(1, sinDec * sinLat + cosDec * cosLat * cosH)));
  // Azimuth from north, eastward positive.
  out.az = Math.atan2(-cosDec * sinH, sinDec * cosLat - cosDec * sinLat * cosH);
  return out;
}

/**
 * Low-precision solar position (Meeus ch. 25). Accurate to about one arcminute
 * over the 20th century, which is several orders of magnitude better than the
 * eye can resolve against a stylised sky.
 */
export function sunEquatorial(jd: number, out: EquatorialPos): EquatorialPos {
  const n = jd - J2000;
  const L = norm360(280.460 + 0.9856474 * n);        // mean longitude
  const g = norm360(357.528 + 0.9856003 * n) * DEG;  // mean anomaly
  // Equation of centre — the two leading terms of Earth's orbital eccentricity.
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  out.ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  out.dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  return out;
}

export interface MoonState extends EquatorialPos {
  /** Ecliptic longitude, radians — used for the phase angle. */
  lambda: number;
  /** Distance in km; drives apparent angular size (perigee moons read bigger). */
  distanceKm: number;
}

/** Abbreviated lunar theory (Meeus ch. 47, leading terms only). */
export function moonEquatorial(jd: number, out: MoonState): MoonState {
  const T = (jd - J2000) / 36525;
  const Lp = norm360(218.316 + 481267.8813 * T) * DEG;   // mean longitude
  const M = norm360(357.529 + 35999.0503 * T) * DEG;     // sun mean anomaly
  const Mp = norm360(134.963 + 477198.8676 * T) * DEG;   // moon mean anomaly
  const D = norm360(297.850 + 445267.1115 * T) * DEG;    // mean elongation
  const F = norm360(93.272 + 483202.0175 * T) * DEG;     // argument of latitude

  const lambda = Lp
    + (6.289 * Math.sin(Mp)
      + 1.274 * Math.sin(2 * D - Mp)   // evection
      + 0.658 * Math.sin(2 * D)        // variation
      + 0.214 * Math.sin(2 * Mp)
      - 0.186 * Math.sin(M)            // annual equation
      - 0.114 * Math.sin(2 * F)) * DEG;

  const beta = (5.128 * Math.sin(F)
    + 0.281 * Math.sin(Mp + F)
    - 0.278 * Math.sin(F - Mp)
    - 0.173 * Math.sin(2 * D - F)) * DEG;

  const distanceKm = 385001
    - 20905 * Math.cos(Mp)
    - 3699 * Math.cos(2 * D - Mp)
    - 2956 * Math.cos(2 * D);

  const eps = 23.4393 * DEG;
  const sinL = Math.sin(lambda), cosL = Math.cos(lambda);
  const sinB = Math.sin(beta), cosB = Math.cos(beta);
  out.ra = Math.atan2(sinL * Math.cos(eps) - (sinB / cosB) * Math.sin(eps), cosL);
  out.dec = Math.asin(sinB * Math.cos(eps) + cosB * Math.sin(eps) * sinL);
  out.lambda = lambda;
  out.distanceKm = distanceKm;
  return out;
}

/** Horizontal direction -> world-space unit vector (+X east, +Y up, -Z north). */
export function horizontalToWorld(h: HorizontalPos, out: THREE.Vector3): THREE.Vector3 {
  const ca = Math.cos(h.alt);
  return out.set(ca * Math.sin(h.az), Math.sin(h.alt), -ca * Math.cos(h.az));
}

export interface SkyEphemeris {
  /** Unit vector pointing *toward* the sun. */
  sunDir: THREE.Vector3;
  /** Unit vector pointing *toward* the moon. */
  moonDir: THREE.Vector3;
  sunAlt: number;
  moonAlt: number;
  /** 0 = new, 0.5 = full, 1 = new again. */
  moonPhase: number;
  /** Fraction of the lunar disc illuminated, 0..1. */
  moonIllum: number;
  /** Apparent angular radius of the moon, radians. */
  moonAngularRadius: number;
  /** Rotation that takes equatorial (RA/Dec) directions into world space. */
  starRotation: THREE.Matrix4;
  julianDay: number;
}

// Module-level scratch. computeEphemeris runs once per frame from the sky's
// updateSlow; allocating eight objects in it is 480 short-lived allocations a
// second, which is exactly the GC sawtooth the brief forbids.
const _sunEq: EquatorialPos = { ra: 0, dec: 0 };
const _moonSt: MoonState = { ra: 0, dec: 0, lambda: 0, distanceKm: 385001 };
const _hA: HorizontalPos = { alt: 0, az: 0 };
const _hB: HorizontalPos = { alt: 0, az: 0 };
const _eqOrigin: EquatorialPos = { ra: 0, dec: 0 };
const _c0 = new THREE.Vector3();
const _c1 = new THREE.Vector3();
const _c2 = new THREE.Vector3();

/**
 * Full ephemeris for a given civil date/time and observer position.
 * 'timeOfDay' is local solar-clock hours; 'timezoneHours' converts to UTC.
 */
export function computeEphemeris(
  year: number, month: number, day: number,
  timeOfDay: number, timezoneHours: number,
  latDeg: number, lonDeg: number,
  out: SkyEphemeris,
): SkyEphemeris {
  const jd = julianDay(year, month, day, timeOfDay - timezoneHours);
  out.julianDay = jd;

  const latRad = latDeg * DEG;
  const lstRad = (gmstDeg(jd) + lonDeg) * DEG;

  const sunH = equatorialToHorizontal(sunEquatorial(jd, _sunEq), latRad, lstRad, _hA);
  horizontalToWorld(sunH, out.sunDir);
  out.sunAlt = sunH.alt;

  const moon = moonEquatorial(jd, _moonSt);
  const moonH = equatorialToHorizontal(moon, latRad, lstRad, _hB);
  horizontalToWorld(moonH, out.moonDir);
  out.moonAlt = moonH.alt;

  // Phase from the sun-moon elongation in ecliptic longitude.
  const n = jd - J2000;
  const sunLambda = (norm360(280.460 + 0.9856474 * n)
    + 1.915 * Math.sin(norm360(357.528 + 0.9856003 * n) * DEG)) * DEG;
  const elong = moon.lambda - sunLambda;
  out.moonPhase = ((elong / (Math.PI * 2)) % 1 + 1) % 1;
  out.moonIllum = (1 - Math.cos(elong)) * 0.5;
  // 1737.4 km mean radius; the 1.03 fudge accounts for the classic "moon
  // illusion" expectation — a geometrically correct moon reads too small.
  out.moonAngularRadius = Math.atan(1737.4 / moon.distanceKm) * 1.6;

  // Star field: build the basis that maps equatorial coordinates to world.
  // Columns are the world directions of RA=0/Dec=0, RA=6h/Dec=0 and the pole.
  const m = out.starRotation;
  _eqOrigin.ra = 0; _eqOrigin.dec = 0;
  const c0 = horizontalToWorld(equatorialToHorizontal(_eqOrigin, latRad, lstRad, _hA), _c0);
  _eqOrigin.ra = Math.PI / 2; _eqOrigin.dec = 0;
  const c1 = horizontalToWorld(equatorialToHorizontal(_eqOrigin, latRad, lstRad, _hA), _c1);
  _eqOrigin.ra = 0; _eqOrigin.dec = Math.PI / 2;
  const c2 = horizontalToWorld(equatorialToHorizontal(_eqOrigin, latRad, lstRad, _hA), _c2);
  m.set(
    c0.x, c1.x, c2.x, 0,
    c0.y, c1.y, c2.y, 0,
    c0.z, c1.z, c2.z, 0,
    0, 0, 0, 1,
  );

  return out;
}

export function makeEphemeris(): SkyEphemeris {
  return {
    sunDir: new THREE.Vector3(0, 1, 0),
    moonDir: new THREE.Vector3(0, -1, 0),
    sunAlt: Math.PI / 2,
    moonAlt: -Math.PI / 2,
    moonPhase: 0.5,
    moonIllum: 1,
    moonAngularRadius: 0.0045,
    starRotation: new THREE.Matrix4(),
    julianDay: J2000,
  };
}

// ---------------------------------------------------------------------------
// CPU atmospheric scattering
//
// This is the same single-scattering model the sky LUT shader runs, at lower
// sample counts. We need it on the CPU because ctx.sunColor / ctx.ambientColor
// feed the cel materials and the shadow-ramp tint, and reading those back from
// the GPU would stall the pipeline every frame.
// ---------------------------------------------------------------------------

/** Planet and atmosphere radii, metres. */
export const R_GROUND = 6360000;
export const R_ATMOS = 6420000;
/** Rayleigh scattering coefficients at sea level, m^-1 (Bruneton 2017). */
export const BETA_R = [5.802e-6, 13.558e-6, 33.1e-6] as const;
/** Mie scattering coefficient at sea level, m^-1. */
export const BETA_M = 3.996e-6;
export const H_RAYLEIGH = 8000;
export const H_MIE = 1200;

/** Positive root of the ray/sphere intersection, or -1 when there is none. */
function raySphereFar(originY: number, dirY: number, dirLenXZ: number, radius: number): number {
  // Ray starts on the +Y axis at (0, originY, 0); direction has vertical
  // component dirY and horizontal magnitude dirLenXZ (unit length overall).
  const b = originY * dirY;
  const c = originY * originY - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t = -b + s;
  void dirLenXZ;
  return t;
}

const _od = [0, 0];

/** Rayleigh + Mie optical depth along a ray, in units of the reference density. */
function opticalDepth(startAlt: number, cosZenith: number, samples: number, out: number[]): void {
  const r0 = R_GROUND + startAlt;
  const dirY = cosZenith;
  const horiz = Math.sqrt(Math.max(0, 1 - cosZenith * cosZenith));
  const tMax = raySphereFar(r0, dirY, horiz, R_ATMOS);
  out[0] = 0; out[1] = 0;
  if (tMax <= 0) return;
  const ds = tMax / samples;
  for (let i = 0; i < samples; i++) {
    const t = (i + 0.5) * ds;
    // Height above ground at distance t (law of cosines on the sphere).
    const r = Math.sqrt(r0 * r0 + t * t + 2 * r0 * t * dirY);
    const h = Math.max(0, r - R_GROUND);
    out[0] += Math.exp(-h / H_RAYLEIGH) * ds;
    out[1] += Math.exp(-h / H_MIE) * ds;
  }
}

/**
 * Direct sunlight colour after atmospheric extinction, normalised so that a
 * high sun gives roughly (1,1,1). This is what makes sunsets go orange without
 * a single hand-picked colour.
 */
export function sunTransmittance(sunAlt: number, observerAlt: number, out: THREE.Color): THREE.Color {
  // Below the horizon the direct beam is gone; the caller cross-fades to
  // twilight/moon lighting.
  const cz = Math.sin(sunAlt);
  // Chapman-style softening near and below the horizon: a hard cut at alt = 0
  // produces a visible pop, and refraction genuinely lifts the disc by ~0.57°.
  const czEff = Math.max(cz, -0.035);
  opticalDepth(observerAlt, czEff, 12, _od);
  const eR = _od[0], eM = _od[1];
  // 1.1x on Mie extinction accounts for absorption by the aerosol itself.
  out.setRGB(
    Math.exp(-(BETA_R[0] * eR + BETA_M * 1.1 * eM)),
    Math.exp(-(BETA_R[1] * eR + BETA_M * 1.1 * eM)),
    Math.exp(-(BETA_R[2] * eR + BETA_M * 1.1 * eM)),
  );
  return out;
}

/**
 * Coarse sky radiance toward a given zenith cosine, integrated over the view
 * ray with single scattering. Used for the horizon/zenith reference colours
 * that drive fog, aerial perspective and the cel shadow tint.
 */
export function skyRadiance(
  cosViewZenith: number, cosSunAngle: number, sunAlt: number, observerAlt: number,
  out: THREE.Color,
): THREE.Color {
  const r0 = R_GROUND + observerAlt;
  const horiz = Math.sqrt(Math.max(0, 1 - cosViewZenith * cosViewZenith));
  let tMax = raySphereFar(r0, cosViewZenith, horiz, R_ATMOS);
  if (tMax <= 0) { out.setRGB(0, 0, 0); return out; }
  tMax = Math.min(tMax, 200000);

  const N = 10;
  const ds = tMax / N;
  // Spectral accumulation is mandatory, not an optimisation target: extinction
  // along a horizon path is ~2.5x stronger in blue than in green, and folding
  // that into a single achromatic transmittance makes the horizon read as a
  // vivid cyan wash instead of a warm, desaturated band.
  let sR0 = 0, sR1 = 0, sR2 = 0;
  let sM0 = 0, sM1 = 0, sM2 = 0;
  let odR = 0, odM = 0;
  const cz = Math.max(Math.sin(sunAlt), -0.035);

  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) * ds;
    const r = Math.sqrt(r0 * r0 + t * t + 2 * r0 * t * cosViewZenith);
    const h = Math.max(0, r - R_GROUND);
    const dR = Math.exp(-h / H_RAYLEIGH) * ds;
    const dM = Math.exp(-h / H_MIE) * ds;
    odR += dR; odM += dM;
    opticalDepth(h, cz, 4, _od);
    const tauR = odR + _od[0];
    const tauM = odM + _od[1];
    const mieTau = BETA_M * 1.1 * tauM;
    const t0 = Math.exp(-(BETA_R[0] * tauR + mieTau));
    const t1 = Math.exp(-(BETA_R[1] * tauR + mieTau));
    const t2 = Math.exp(-(BETA_R[2] * tauR + mieTau));
    sR0 += dR * t0; sR1 += dR * t1; sR2 += dR * t2;
    sM0 += dM * t0; sM1 += dM * t1; sM2 += dM * t2;
  }

  // Rayleigh phase, and Cornette-Shanks for Mie with g = 0.76.
  const mu = cosSunAngle;
  const phaseR = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const g = 0.76, g2 = g * g;
  const phaseM = (3 / (8 * Math.PI)) * ((1 - g2) * (1 + mu * mu))
    / ((2 + g2) * Math.pow(1 + g2 - 2 * g * mu, 1.5));

  // Must match ATMOSPHERE's 'uIrradiance' in the LUT pass, or the CPU-derived
  // fog/ambient colours will not agree with the sky the player sees.
  const irradiance = 22;
  out.setRGB(
    (sR0 * BETA_R[0] * phaseR + sM0 * BETA_M * phaseM) * irradiance,
    (sR1 * BETA_R[1] * phaseR + sM1 * BETA_M * phaseM) * irradiance,
    (sR2 * BETA_R[2] * phaseR + sM2 * BETA_M * phaseM) * irradiance,
  );
  return out;
}
