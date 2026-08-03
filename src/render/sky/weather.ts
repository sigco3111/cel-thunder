/**
 * Weather presets and the blend machine that moves between them.
 *
 * Every visual knob the sky owns lives in one flat struct of numbers so that a
 * transition is a single componentwise lerp. Colours are stored as linear RGB
 * triples for the same reason — no Color objects, no allocation, and the
 * interpolation is trivially frame-rate independent.
 */

export type WeatherName = 'clear' | 'scattered' | 'overcast' | 'storm' | 'fog';

export interface WeatherParams {
  // --- cloud layer geometry (metres above sea level) ---
  cloudBase: number;
  cloudTop: number;
  /** 0 = stratus sheets, 0.5 = cumulus, 1 = towering cumulonimbus. */
  cloudTypeBias: number;
  /** Global coverage multiplier applied on top of the weather map. */
  coverage: number;
  /** Extinction multiplier — how optically thick the cloud material is. */
  density: number;
  /** World size, in metres, of one tile of the base shape volume. */
  shapeSize: number;
  /** World size, in metres, of one tile of the detail volume. */
  detailSize: number;
  /** World size, in metres, of one tile of the weather map. */
  weatherSize: number;

  // --- wind ---
  windSpeed: number;      // m/s
  windDirDeg: number;     // meteorological: direction the wind comes FROM
  /** Rate at which cloud shapes evolve independently of translation. */
  evolveRate: number;

  // --- cel look ---
  /** Extra ambient bounce into the cloud shadow side. */
  cloudAmbient: number;
  /** Silver-lining strength when backlit. */
  silver: number;

  // --- atmosphere ---
  /** FogExp2 density used by scene materials. */
  fogDensity: number;
  /** Distance at which cel materials fully take the atmosphere colour. */
  aerialFar: number;
  /** Ground fog bank density (per metre) and the height it decays over. */
  groundFog: number;
  groundFogHeight: number;
  /** Haze added to the sky's Mie term — hazy days have a milky horizon. */
  hazeBoost: number;

  // --- high clouds ---
  cirrusAmount: number;
  cirrusHeight: number;
  /** Distant cumulus deck sitting on the horizon beyond the volumetric range. */
  deckAmount: number;

  // --- precipitation / drama ---
  rain: number;            // 0..1 canopy rain intensity
  lightningRate: number;   // mean strikes per second
  /** Multiplier on direct sun reaching the ground (thick decks kill it). */
  sunOcclusion: number;

  // --- god rays ---
  godRayStrength: number;
}

const P = (o: WeatherParams): WeatherParams => o;

export const WEATHER_PRESETS: Record<WeatherName, WeatherParams> = {
  /**
   * High-pressure summer morning. Fair-weather cumulus with big gaps, crisp
   * horizon, strong shafts of light through the few gaps there are.
   */
  clear: P({
    cloudBase: 1500, cloudTop: 3000, cloudTypeBias: 0.42,
    coverage: 0.34, density: 0.55,
    shapeSize: 5200, detailSize: 310, weatherSize: 34000,
    windSpeed: 7, windDirDeg: 250, evolveRate: 0.35,
    cloudAmbient: 0.5, silver: 1.15,
    fogDensity: 0.0000075, aerialFar: 42000, groundFog: 0, groundFogHeight: 300,
    hazeBoost: 0.7,
    cirrusAmount: 0.16, cirrusHeight: 8200, deckAmount: 0.35,
    rain: 0, lightningRate: 0, sunOcclusion: 1,
    godRayStrength: 0.55,
  }),

  /** The default air-combat sky: cumulus streets you can hide in. */
  scattered: P({
    cloudBase: 1250, cloudTop: 4100, cloudTypeBias: 0.55,
    coverage: 0.52, density: 0.8,
    shapeSize: 4600, detailSize: 270, weatherSize: 30000,
    windSpeed: 11, windDirDeg: 235, evolveRate: 0.5,
    cloudAmbient: 0.55, silver: 1.35,
    fogDensity: 0.0000125, aerialFar: 34000, groundFog: 0, groundFogHeight: 350,
    hazeBoost: 1,
    cirrusAmount: 0.30, cirrusHeight: 8600, deckAmount: 0.6,
    rain: 0, lightningRate: 0, sunOcclusion: 0.94,
    godRayStrength: 1,
  }),

  /** Low grey sheet. Flat light, cool shadows, aircraft read as silhouettes. */
  overcast: P({
    cloudBase: 850, cloudTop: 3400, cloudTypeBias: 0.24,
    coverage: 0.80, density: 1.05,
    shapeSize: 6200, detailSize: 350, weatherSize: 40000,
    windSpeed: 14, windDirDeg: 205, evolveRate: 0.4,
    cloudAmbient: 0.85, silver: 0.55,
    fogDensity: 0.0000235, aerialFar: 21000, groundFog: 0.00008, groundFogHeight: 500,
    hazeBoost: 1.9,
    cirrusAmount: 0.05, cirrusHeight: 9000, deckAmount: 0.85,
    rain: 0.18, lightningRate: 0, sunOcclusion: 0.3,
    godRayStrength: 0.3,
  }),

  /** Towering cumulonimbus, heavy rain, lightning inside the anvils. */
  storm: P({
    cloudBase: 620, cloudTop: 8200, cloudTypeBias: 0.95,
    coverage: 0.84, density: 1.35,
    shapeSize: 7400, detailSize: 380, weatherSize: 26000,
    windSpeed: 24, windDirDeg: 190, evolveRate: 1.1,
    cloudAmbient: 0.7, silver: 1.6,
    fogDensity: 0.000034, aerialFar: 15000, groundFog: 0.00012, groundFogHeight: 700,
    hazeBoost: 2.4,
    cirrusAmount: 0, cirrusHeight: 9500, deckAmount: 0.95,
    rain: 1, lightningRate: 0.22, sunOcclusion: 0.16,
    godRayStrength: 0.8,
  }),

  /** Radiation fog under a thin stratus lid — near-zero visibility at the deck. */
  fog: P({
    cloudBase: 1050, cloudTop: 2400, cloudTypeBias: 0.1,
    coverage: 0.62, density: 0.7,
    shapeSize: 6800, detailSize: 360, weatherSize: 38000,
    windSpeed: 3, windDirDeg: 300, evolveRate: 0.18,
    cloudAmbient: 0.9, silver: 0.8,
    fogDensity: 0.0000265, aerialFar: 12000, groundFog: 0.00055, groundFogHeight: 260,
    hazeBoost: 2.8,
    cirrusAmount: 0.10, cirrusHeight: 8800, deckAmount: 0.5,
    rain: 0.05, lightningRate: 0, sunOcclusion: 0.55,
    godRayStrength: 1.4,
  }),
};

export const WEATHER_NAMES: readonly WeatherName[] =
  ['clear', 'scattered', 'overcast', 'storm', 'fog'];

const KEYS = Object.keys(WEATHER_PRESETS.clear) as (keyof WeatherParams)[];

export function cloneWeather(src: WeatherParams): WeatherParams {
  return { ...src };
}

/**
 * Blend machine. 'windDirDeg' is interpolated on the shortest arc so a
 * 350 deg -> 10 deg transition does not swing the whole cloud field backwards.
 */
export class WeatherBlend {
  readonly current: WeatherParams = cloneWeather(WEATHER_PRESETS.scattered);
  private from: WeatherParams = cloneWeather(WEATHER_PRESETS.scattered);
  private to: WeatherParams = cloneWeather(WEATHER_PRESETS.scattered);
  private t = 1;
  private duration = 1;
  name: WeatherName = 'scattered';
  target: WeatherName = 'scattered';

  set(name: WeatherName, transitionSeconds: number): void {
    const preset = WEATHER_PRESETS[name];
    if (!preset) return;
    this.target = name;
    if (transitionSeconds <= 0.001) {
      Object.assign(this.current, preset);
      Object.assign(this.from, preset);
      Object.assign(this.to, preset);
      this.t = 1;
      this.name = name;
      return;
    }
    Object.assign(this.from, this.current);
    Object.assign(this.to, preset);
    this.duration = transitionSeconds;
    this.t = 0;
  }

  get transitioning(): boolean { return this.t < 1; }

  update(dt: number): void {
    if (this.t >= 1) return;
    this.t = Math.min(1, this.t + dt / this.duration);
    // Smootherstep: zero first and second derivative at both ends, so the
    // weather never appears to "start" or "stop" moving.
    const s = this.t * this.t * this.t * (this.t * (this.t * 6 - 15) + 10);
    for (const k of KEYS) {
      if (k === 'windDirDeg') continue;
      this.current[k] = this.from[k] + (this.to[k] - this.from[k]) * s;
    }
    let delta = ((this.to.windDirDeg - this.from.windDirDeg) % 360 + 540) % 360 - 180;
    this.current.windDirDeg = this.from.windDirDeg + delta * s;
    if (this.t >= 1) this.name = this.target;
  }
}
