import * as THREE from 'three';

/**
 * Procedurally generated 3D colour lookup table — the "creative" half of the
 * grade.
 *
 * Splitting the grade in two is deliberate. The *technical* transform (exposure
 * and the filmic S-curve) stays analytic in the shader, because it has to
 * operate on unbounded scene-referred values and because it is the part that
 * has to stay smooth. Everything discretionary — lifted tinted blacks, split
 * toning, luma-dependent saturation, hue-targeted pushes — is baked into a
 * 32^3 lattice here and applied with one trilinear fetch. That is how a real
 * DI works, it makes the look editable as data rather than as shader edits, and
 * it costs one texture read instead of thirty ALU ops.
 *
 * The look: cool, slightly desaturated shadows with a blue-violet film base;
 * warm amber highlights; European-theatre foliage pulled off video-game green
 * toward olive; sky pushed a touch cyan so it separates from the grey-blue of
 * aircraft camouflage; reds (roundels, tracer, fire) protected and slightly
 * enriched so they stay the most saturated thing on screen.
 */

const SIZE = 32;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Film base + printing density: shadows never reach zero, highlights warm. */
const LIFT = [0.021, 0.029, 0.055];
const GAIN = [1.040, 1.004, 0.958];
/**
 * Split-tone targets. Deliberately far apart: the whole colour story of the
 * game is one axis — a saturated cool cyan-blue in everything the sun does not
 * reach, against a warm cream-amber in everything it does. A timid split reads
 * as an ungraded render with a slight cast; a decisive one reads as a look.
 */
const SHADOW_TONE = [0.26, 0.47, 0.94];
const HIGHLIGHT_TONE = [1.00, 0.855, 0.61];

function rgb2hsv(r: number, g: number, b: number, out: number[]): number[] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  out[0] = h;
  out[1] = max > 1e-6 ? d / max : 0;
  out[2] = max;
  return out;
}

function hsv2rgb(h: number, s: number, v: number, out: number[]): number[] {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  out[0] = r + m; out[1] = g + m; out[2] = b + m;
  return out;
}

/** Angular distance between two hues, in degrees. */
function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const _hsv = [0, 0, 0];
const _rgb = [0, 0, 0];

/**
 * The colour transform, evaluated per lattice point. Input and output are
 * display-referred [0,1] — this runs *after* tone mapping.
 */
export function gradeColor(rIn: number, gIn: number, bIn: number, out: number[]): number[] {
  let r = rIn, g = gIn, b = bIn;
  const l0 = luma(r, g, b);

  // --- split toning -------------------------------------------------------
  // Multiply-blend the cool tone into shadows, screen-blend the warm tone into
  // highlights. Blend modes rather than lerps so neutral mid-grey is untouched
  // and the toning strengthens naturally toward each end of the range.
  const shadowW = Math.pow(1 - smoothstep(0.0, 0.58, l0), 1.35);
  const highW = Math.pow(smoothstep(0.42, 1.0, l0), 1.25);

  const sAmt = 0.46 * shadowW;
  r = mix(r, r * SHADOW_TONE[0] + 0.018, sAmt);
  g = mix(g, g * SHADOW_TONE[1] + 0.022, sAmt);
  b = mix(b, b * SHADOW_TONE[2] + 0.030, sAmt);

  const hAmt = 0.32 * highW;
  r = mix(r, 1 - (1 - r) * (1 - HIGHLIGHT_TONE[0] * 0.35), hAmt);
  g = mix(g, 1 - (1 - g) * (1 - HIGHLIGHT_TONE[1] * 0.35), hAmt);
  b = mix(b, 1 - (1 - b) * (1 - HIGHLIGHT_TONE[2] * 0.35), hAmt);

  // --- lift / gain --------------------------------------------------------
  r = LIFT[0] + r * (1 - LIFT[0]);
  g = LIFT[1] + g * (1 - LIFT[1]);
  b = LIFT[2] + b * (1 - LIFT[2]);
  r *= GAIN[0]; g *= GAIN[1]; b *= GAIN[2];

  // --- hue-targeted pushes ------------------------------------------------
  rgb2hsv(clamp01(r), clamp01(g), clamp01(b), _hsv);
  let h = _hsv[0], s = _hsv[1];
  const v = _hsv[2];

  if (s > 0.02) {
    // Foliage: rotate away from primary green toward olive and take the edge
    // off the saturation. Untreated greens are the single clearest tell of an
    // ungraded real-time frame.
    const wGreen = Math.max(0, 1 - hueDist(h, 118) / 55);
    h += (95 - h) * wGreen * 0.55;
    s *= 1 - 0.26 * wGreen;

    // Sky and water: more cyan and more saturation, which also separates them
    // from the grey-blues used on airframes. This is the dominant of the
    // palette, so it is allowed to be the most saturated large area in frame.
    // Narrow: at 48 degrees this window also swallowed the grey-blue of RAF
    // camouflage and turned every airframe cyan.
    const wSky = Math.max(0, 1 - hueDist(h, 212) / 32) * smoothstep(0.18, 0.42, s);
    h += (202 - h) * wSky * 0.42;
    s *= 1 + 0.26 * wSky;

    // Reds and oranges — roundels, tracer, fire, warning stripes — are the
    // accent, and stay the hottest thing in frame.
    const wRed = Math.max(0, 1 - hueDist(h, 14) / 42);
    s *= 1 + 0.30 * wRed;

    // Global luma-shaped saturation: rich mids, restrained extremes. Film
    // desaturates as it approaches the shoulder; skipping this is what makes
    // bright cel colours look like plastic.
    s *= 1.26 - 0.34 * highW - 0.10 * shadowW;

    hsv2rgb(h, clamp01(s), v, _rgb);
    r = _rgb[0]; g = _rgb[1]; b = _rgb[2];
  }

  // --- per-channel micro-curves ------------------------------------------
  // A small amount of blue toe lift and red shoulder rolloff. This is the
  // "print" character; keep it subtle enough that it reads as stock, not as a
  // colour cast.
  b = b + 0.018 * (1 - b) * (1 - l0);
  r = r - 0.020 * r * highW;

  out[0] = clamp01(r);
  out[1] = clamp01(g);
  out[2] = clamp01(b);
  return out;
}

/**
 * Bakes 'gradeColor' into a 32^3 RGBA8 volume.
 *
 * 8-bit is not a compromise here: the LUT operates on already tone-mapped
 * display-referred values, trilinear interpolation between 32 levels is
 * smoother than the 8-bit quantisation of the lattice itself, and this is
 * exactly the precision a .cube file from a real grading suite carries.
 */
export function buildGradeLut(strength = 1): THREE.Data3DTexture {
  const n = SIZE;
  const data = new Uint8Array(n * n * n * 4);
  const out = [0, 0, 0];

  let i = 0;
  for (let z = 0; z < n; z++) {
    const b0 = z / (n - 1);
    for (let y = 0; y < n; y++) {
      const g0 = y / (n - 1);
      for (let x = 0; x < n; x++) {
        const r0 = x / (n - 1);
        gradeColor(r0, g0, b0, out);
        data[i++] = Math.round(mix(r0, out[0], strength) * 255);
        data[i++] = Math.round(mix(g0, out[1], strength) * 255);
        data[i++] = Math.round(mix(b0, out[2], strength) * 255);
        data[i++] = 255;
      }
    }
  }

  const tex = new THREE.Data3DTexture(data, n, n, n);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/** Lattice size, so the shader can build the correct scale/offset. */
export const LUT_SIZE = SIZE;
