import * as THREE from 'three';

/**
 * One shared uniform block for the whole sky subsystem.
 *
 * Every pass — LUT, backdrop, cloud march, temporal resolve, god rays, rain —
 * reads camera, sun, weather and lightning state. Sharing the same
 * 'THREE.IUniform' object instances across all of their materials means the
 * per-frame update is written once and there is no chance of one pass drifting
 * out of sync with another (which shows up immediately as clouds lit by
 * yesterday's sun).
 */
export interface SkyUniforms {
  [name: string]: THREE.IUniform;
}

export function createSkyUniforms(): SkyUniforms {
  return {
    // --- frame / camera ---
    uTime: { value: 0 },
    uFrame: { value: 0 },
    uResolution: { value: new THREE.Vector2(1920, 1080) },
    uCamPos: { value: new THREE.Vector3() },
    uCamFwd: { value: new THREE.Vector3(0, 0, -1) },
    uInvViewProj: { value: new THREE.Matrix4() },
    uPrevViewProj: { value: new THREE.Matrix4() },
    uNear: { value: 0.35 },
    uFar: { value: 120000 },

    // --- celestial ---
    /** Unit vector pointing toward the sun. */
    uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.6) },
    /** Sun colour after atmospheric extinction, roughly white at high sun. */
    uSunColor: { value: new THREE.Color(1, 0.96, 0.9) },
    uSunIntensity: { value: 1 },
    uSunAngularRadius: { value: 0.00465 },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uMoonColor: { value: new THREE.Color(0.72, 0.78, 0.95) },
    uMoonIllum: { value: 1 },
    uMoonAngularRadius: { value: 0.0075 },
    /** Equatorial -> world basis; shaders use 'dir * mat3(m)' for the inverse. */
    uStarRot: { value: new THREE.Matrix4() },
    /** 0 = full day, 1 = astronomical night. Gates stars, moon and the ink palette. */
    uNight: { value: 0 },

    // --- reference colours sampled on the CPU from the same scattering model ---
    uZenithColor: { value: new THREE.Color(0.09, 0.19, 0.42) },
    uHorizonColor: { value: new THREE.Color(0.62, 0.72, 0.86) },
    uAmbientColor: { value: new THREE.Color(0.42, 0.55, 0.72) },
    /**
     * Art-directed twilight lift. Single scattering systematically
     * under-predicts the sky after sunset — most of that light has bounced
     * several times — so the physical model alone gives a dusk that is both
     * too dark and too red. This adds back the blue-violet wedge, shaped by
     * elevation and azimuth in the backdrop shader.
     */
    uTwilight: { value: new THREE.Color(0, 0, 0) },

    // --- stylisation ---
    /** Camera altitude the scattering LUT was last built for, metres. */
    uAltitudeLut: { value: 0 },
    /**
     * Global scale on the physical radiance before stylisation. The
     * scattering integral is calibrated in absolute terms, which lands a
     * clear zenith around 0.5 and a hazy horizon near 1.0 — correct, but a
     * stop brighter than a photograph of the same sky. This pulls it back.
     */
    uSkyExposure: { value: 0.62 },
    /**
     * Sky value quantisation.
     *
     * 7 steps across the Reinhard-compressed luminance, of which a typical
     * framing traverses three or four between zenith and horizon — the number a
     * painter would actually use. 'soft' is the half-width of the smoothstep at
     * each step edge as a fraction of the step: at 0.34 the ramps overlap so
     * heavily that the result is indistinguishable from the continuous gradient
     * (i.e. the stylisation was doing nothing), at 0.0 it is a hard posterise.
     * 0.15 leaves a visible, deliberate, slightly brush-loaded edge.
     */
    uSkyBands: { value: 10 },
    uSkyBandSoft: { value: 0.11 },
    uSkyBandAmount: { value: 0.60 },
    uSkySaturation: { value: 1.10 },
    uHorizonWarm: { value: new THREE.Color(1.0, 0.845, 0.66) },
    uHorizonWarmAmount: { value: 0.42 },

    // --- weather-driven cloud parameters ---
    uCloudBase: { value: 1250 },
    uCloudTop: { value: 4100 },
    uCoverage: { value: 0.52 },
    uDensity: { value: 0.8 },
    uCloudType: { value: 0.55 },
    uShapeScale: { value: 1 / 4600 },
    uDetailScale: { value: 1 / 540 },
    uWeatherScale: { value: 1 / 30000 },
    /** Accumulated wind translation applied to the shape volume, metres. */
    uWind: { value: new THREE.Vector3() },
    uWeatherOffset: { value: new THREE.Vector2() },
    uCloudAmbient: { value: 0.55 },
    uSilver: { value: 1.35 },
    uCloudMaxDist: { value: 38000 },
    /**
     * Art-directed planet radius for the cloud shells. Real Earth curvature
     * (6371 km) is far too gentle to bend clouds down inside a 38 km march, so
     * the volumetric layer uses a tighter sphere. The result is that cloud
     * bases converge toward the horizon the way they do in a photograph
     * instead of marching off as an infinite flat slab.
     */
    uCloudPlanetR: { value: 900000 },
    /** Extinction coefficient per unit density, m^-1. */
    uSigma: { value: 0.019 },
    /** Strength of the Beer-Powder edge-darkening term. */
    uPowder: { value: 0.44 },
    /**
     * Multiplier applied to scattered energy before the expansion curve and the
     * cel quantisation.
     *
     * This is the single knob that decides whether a cumulus deck reads as a
     * sculpted form or as a white bedsheet. Too high and the sunlit top of every
     * cloud saturates the quantiser, so the whole upper surface collapses into
     * the brightest band and all the shading information the march just paid for
     * is thrown away; too low and the entire layer sits in one dark band. 1.55
     * puts a fully exposed sunlit top just inside the top band and a shadowed
     * base three bands below it.
     */
    uEnergyGain: { value: 0.85 },
    uCloudSteps: { value: 48 },
    uCloudLightSteps: { value: 5 },

    // --- cel palette for clouds ---
    uCloudBands: { value: 5 },
    uCloudBandSoft: { value: 0.045 },
    uCloudCelMix: { value: 0.95 },
    uCloudLit: { value: new THREE.Color(1.0, 0.975, 0.93) },
    /**
     * Tint of the deepest cloud value. Multiplied by the light a cloud actually
     * receives from its surroundings (sky above + ground bounce below), so the
     * core stays a *saturated cool colour* rather than collapsing to black —
     * a cumulus base in life sits around 15-25 % of the luminance of its sunlit
     * top, not 3 %, and anything darker reads as a smudge rather than as cloud.
     */
    uCloudCore: { value: new THREE.Color(0.50, 0.55, 0.90) },
    /** Light bouncing up off terrain/sea into the cloud base. */
    uCloudGround: { value: new THREE.Color(0.12, 0.13, 0.10) },
    uCloudRim: { value: new THREE.Color(1.0, 0.92, 0.74) },
    uCloudRimStrength: { value: 2.4 },
    /**
     * How much of the shading comes from the *shape* of the cloud (the gradient
     * of the density field at the first hit, used as a surface normal) rather
     * than purely from the transmittance integral. Zero is physically honest and
     * visually flat: under a deck every ray is fully shadowed, the energy field
     * is constant, and the whole underside collapses to one cel band. Around
     * 0.6 the billows get sunward faces and cool undersides and the layer reads
     * as sculpture.
     */
    uCloudForm: { value: 0.62 },
    uCloudInk: { value: new THREE.Color(0.13, 0.15, 0.26) },
    uCloudInkAmount: { value: 0.55 },
    /** Ink line half-width, in *screen* pixels — not march-buffer texels. */
    uCloudInkWidth: { value: 1.35 },

    // --- atmosphere / fog ---
    uHaze: { value: 1 },
    uAerialFar: { value: 34000 },
    uGroundFog: { value: 0 },
    uGroundFogHeight: { value: 350 },

    // --- high clouds ---
    uCirrusAmount: { value: 0.5 },
    uCirrusHeight: { value: 8600 },
    uCirrusOffset: { value: new THREE.Vector2() },
    uCirrusOffset2: { value: new THREE.Vector2() },
    uDeckAmount: { value: 0.6 },
    uDeckHeight: { value: 1900 },
    uDeckOffset: { value: new THREE.Vector2() },
    /**
     * Fraction of 'uCloudMaxDist' at which the painted horizon deck starts to
     * fade in. 0.72 hands the near field to the volumetric layer; the sky drops
     * it to almost zero when volumetrics are switched off, because otherwise the
     * low-end path renders 27 km of completely empty air.
     */
    uDeckNear: { value: 0.72 },

    // --- drama ---
    uRain: { value: 0 },
    uLightningFlash: { value: 0 },
    uLightningColor: { value: new THREE.Color(0.82, 0.88, 1.0) },
    /** World position of the current in-cloud discharge; w component is range. */
    uBoltPos: { value: new THREE.Vector3() },
    uBoltIntensity: { value: 0 },
    uGodRayStrength: { value: 1 },
  };
}
