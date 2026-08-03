import * as THREE from 'three';
import type { GameContext, QualityTier, Subsystem } from '../../engine/context';
import { clamp, smoothstep, DEG, Rng } from '../../shared/math';
import { celGlobals } from '../CelMaterial';

import { PassRunner, makeHdrTarget, makeScreenLayer } from './fullscreen';
import { createSkyUniforms, type SkyUniforms } from './sharedUniforms';
import {
  createSkyBackdropMaterial, createSkyLutMaterial,
  SKY_LUT_WIDTH, SKY_LUT_HEIGHT,
} from './SkyDome';
import { VolumetricClouds, type CloudQuality } from './VolumetricClouds';
import { createRainLayer } from './RainCanopy';
import {
  bakeCloudNoise, cpuCloudDensity,
  type CloudNoiseSet, type CpuDensityParams,
} from './noise';
import {
  computeEphemeris, makeEphemeris, skyRadiance, sunTransmittance,
  type SkyEphemeris,
} from './solar';
import {
  WeatherBlend, WEATHER_NAMES, type WeatherName, type WeatherParams,
} from './weather';

export type { WeatherName } from './weather';
export { WEATHER_NAMES, WEATHER_PRESETS } from './weather';

/**
 * Sky, atmosphere, volumetric clouds and weather.
 *
 * ## Frame order
 *
 * 'update()' runs before the camera system has finalised its rig, so it only
 * does camera-independent work: advance the clock, run the ephemeris, blend
 * weather, publish 'ctx.sunDir' / 'sunColor' / 'sunIntensity' / 'ambientColor',
 * and drive the scene lights and fog.
 *
 * 'lateUpdate()' runs after every other subsystem's 'update()' and before the
 * render subsystem draws, which is the only point in the frame where the camera
 * matrices are final *and* we can still render offscreen passes. Everything
 * view-dependent lives there: the scattering LUT, the cloud raymarch, the
 * temporal resolve, and the god-ray buffer.
 *
 * The parts that end up on screen are four screen-aligned meshes parented to
 * the scene, ordered so that they interleave correctly with world geometry:
 *
 *   -10000  sky backdrop   (opaque queue, first — acts as the background)
 *     -500  cloud composite (transparent queue, first — over opaque, under VFX)
 *     4000  canopy rain     (transparent queue, last)
 *
 * That means the sky works unchanged whether the renderer is a bare
 * 'renderer.render(scene, camera)' or a full HDR composer.
 *
 * ## Depth
 *
 * Clouds need the opaque scene's depth to occlude correctly. If the render
 * subsystem publishes one (see 'setSceneDepth', or emit 'render:depth' on the
 * bus) we use it directly and cost nothing extra. Otherwise we run our own
 * depth-only prepass, which is correct but pays for a second scene traversal.
 */

const CLOUD_TIERS: Record<QualityTier, {
  renderScale: number; stepMul: number; lightSteps: number;
  godRaySamples: number; temporalBlend: number; lutInterval: number;
}> = {
  low: { renderScale: 0.26, stepMul: 0.38, lightSteps: 2, godRaySamples: 0, temporalBlend: 0.26, lutInterval: 8 },
  medium: { renderScale: 0.38, stepMul: 0.62, lightSteps: 3, godRaySamples: 16, temporalBlend: 0.18, lutInterval: 6 },
  high: { renderScale: 0.44, stepMul: 0.85, lightSteps: 4, godRaySamples: 24, temporalBlend: 0.15, lutInterval: 4 },
  ultra: { renderScale: 0.55, stepMul: 1.15, lightSteps: 5, godRaySamples: 32, temporalBlend: 0.12, lutInterval: 2 },
};

// Module-level scratch. Nothing in the per-frame path is allowed to allocate.
const _viewProj = new THREE.Matrix4();
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _size = new THREE.Vector2();
const _cA = new THREE.Color();
const _cB = new THREE.Color();
const _cC = new THREE.Color();
const _cD = new THREE.Color();

export class SkySystem implements Subsystem {
  readonly name = 'sky';

  // ---- authored state ----------------------------------------------------
  /** Observer position. Defaults to the Normandy coast, June 1944. */
  latitude = 49.4;
  longitude = -0.8;
  timezoneHours = 1;
  year = 1944; month = 6; day = 6;
  /** Real seconds per in-game day. 0 freezes the clock (the default). */
  dayLengthSeconds = 0;
  /** Multiplier the camera system can use to suppress rain in external views. */
  canopyRain = 1;

  // ---- published read-only state -----------------------------------------
  /** Screen-space position of the sun in [0,1] UV, valid when 'sunOnScreen'. */
  readonly sunScreenPos = new THREE.Vector2(0.5, 0.5);
  sunOnScreen = false;
  /** True while the camera is inside cloud. Driven from the CPU density field. */
  cameraInCloud = false;
  /** Cloud density at the camera, 0..1. Useful for buffeting and audio. */
  cameraCloudDensity = 0;

  // ---- internals ---------------------------------------------------------
  private ctx!: GameContext;
  private u!: SkyUniforms;
  private noise!: CloudNoiseSet;
  private readonly weather = new WeatherBlend();
  private readonly eph: SkyEphemeris = makeEphemeris();
  private readonly rng = new Rng(0xC10D5);

  private group = new THREE.Group();
  private backdrop!: THREE.Mesh;
  private rainMesh!: THREE.Mesh;
  private rainMat!: THREE.ShaderMaterial;
  private clouds!: VolumetricClouds;

  private lutRT!: THREE.WebGLRenderTarget;
  private lutMat!: THREE.ShaderMaterial;
  private readonly lutRunner = new PassRunner();
  private lutAge = 999;
  private lutSunY = -99;
  private lutAltitude = -99;

  private sun!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;

  private depthRT: THREE.WebGLRenderTarget | null = null;
  private depthMat!: THREE.MeshBasicMaterial;
  private externalDepth: THREE.Texture | null = null;
  /**
   * The render subsystem, when one is present. Two things come from it and
   * nothing else does: its depth buffer (so we never run a second scene
   * traversal) and the knowledge that *it* owns the shadow rig, so we must not
   * touch the light's placement. Held as a structural type rather than an
   * import so the two modules stay independently replaceable.
   */
  private renderSub: { readonly depthTexture?: THREE.Texture | null } | null = null;
  private renderSubProbed = false;
  /** Objects hidden for the duration of the cloud-occlusion depth prepass. */
  private readonly depthHidden: THREE.Object3D[] = [];

  /**
   * Art-direction override pushed by a camera framing (see
   * 'engine/camera/framings.ts'). A framing composes for a specific sky — the
   * hero shot wants a broken cumulus field it can sit *above*, the sunset shot
   * wants a thin high deck the sun can burn through — so the shot, not the
   * ambient weather machine, gets the last word while it is applied.
   */
  private directive: {
    coverage: number; cloudBase: number; cloudTop: number;
    haze: number; windSpeed: number;
  } | null = null;

  private timeOfDay = 9.5;
  private lastPublishedTod = -1;
  private tier: QualityTier = 'high';
  private cloudQuality: CloudQuality = {
    renderScale: 0.5, steps: 48, lightSteps: 5, godRaySamples: 24, temporalBlend: 0.14,
  };
  private bufferW = 0;
  private bufferH = 0;

  private lightningTimer = 5;
  private bolt = { t: -1, dur: 0.62, peak: 0 };
  private readonly boltPos = new THREE.Vector3();

  private readonly windToward = new THREE.Vector3(0, 0, 1);
  private windOverride: { dirDeg: number; speed: number } | null = null;
  private readonly cpuParams: CpuDensityParams = {
    base: 1250, top: 4100, coverage: 0.52, density: 0.8, cloudTypeBias: 0.55,
    shapeScale: 1 / 4600, weatherScale: 1 / 30000,
    windX: 0, windY: 0, windZ: 0, weatherOffsetX: 0, weatherOffsetY: 0,
    camX: 0, camZ: 0, planetR: 900000,
  };
  private readonly disposers: (() => void)[] = [];

  // =========================================================================
  // Public API
  // =========================================================================

  /** Cross-fade to a weather state. 'transitionSeconds' 0 snaps instantly. */
  setWeather(name: WeatherName, transitionSeconds = 20): void {
    if (WEATHER_NAMES.indexOf(name) < 0) {
      console.warn(`[sky] unknown weather "${name}"`);
      return;
    }
    this.weather.set(name, Math.max(0, transitionSeconds));
    // Deliberately NOT 'sky:weather': that channel is an *inbound* command
    // carrying a WeatherDirective from the camera framings. Echoing a
    // '{name, seconds}' payload back onto it made the sky talk over its own
    // director.
    this.ctx?.bus.emit('sky:weatherChanged', { name, transitionSeconds });
    // A hard cut invalidates every cached temporal sample.
    if (transitionSeconds <= 0.001) this.clouds?.reset();
  }

  /**
   * Hands a camera framing direct control of the cloud field.
   *
   * Without this the framings only *described* their sky — 'hero' asks for a
   * 1700 m cumulus base so the camera can sit above it at 2100 m, but the sky
   * stayed on the ambient 'scattered' preset whose deck runs 1250-4100 m, and
   * the hero shot came out from inside the cloud: a flat grey wall with no
   * horizon, no sun and no separation. Pass null to hand control back.
   */
  setWeatherDirective(d: {
    coverage?: number; cloudBase?: number; cloudDepth?: number;
    haze?: number; turbidity?: number; windSpeed?: number;
  } | null): void {
    if (!d) { this.directive = null; return; }
    const base = Math.max(120, d.cloudBase ?? 1600);
    const depth = Math.max(250, d.cloudDepth ?? 1400);
    // Turbidity is an aerosol count; haze is a straight multiplier. Both end up
    // in the same Mie term, so fold them into one number the sky understands.
    const haze = (d.haze ?? 1) * (0.55 + 0.16 * (d.turbidity ?? 2.8));
    this.directive = {
      coverage: clamp(d.coverage ?? 0.45, 0, 1),
      cloudBase: base,
      cloudTop: base + depth,
      haze: clamp(haze, 0.15, 3.2),
      windSpeed: Math.max(0, d.windSpeed ?? 8),
    };
    this.clouds?.reset();
  }

  /**
   * Folds the active framing directive over the blended weather. Runs every
   * frame rather than once, because the blend machine rewrites 'current' in
   * place and would otherwise wash the directive out over the transition.
   */
  private applyDirective(w: WeatherParams): void {
    const d = this.directive;
    if (!d) return;
    w.coverage = d.coverage;
    w.cloudBase = d.cloudBase;
    w.cloudTop = d.cloudTop;
    w.windSpeed = d.windSpeed;
    w.hazeBoost = d.haze;
    // Keep the ground-level atmosphere consistent with the requested haze, or a
    // "clear" framing still gets the default deck's milk on the horizon.
    w.fogDensity = 0.0000042 * d.haze;
    w.aerialFar = 62000 / Math.max(0.35, d.haze);
    // A thin, high, broken deck is cumulus; a thick low one is stratus.
    w.cloudTypeBias = clamp(0.28 + (d.cloudTop - d.cloudBase) / 4200, 0.1, 0.95);
    w.deckAmount = clamp(0.22 + d.coverage * 0.7, 0, 0.95);
    // Optical thickness has to rise with coverage or a broken deck comes out
    // translucent — you could read the farmland through the cumulus in the
    // 'clouds' framing, which turns the whole layer into ground fog.
    w.density = clamp(0.62 + d.coverage * 0.85, 0.5, 1.35);
    w.sunOcclusion = clamp(1 - d.coverage * 0.35, 0.35, 1);
    // Cirrus used to be one tiling anisotropic texture on one shell, and the
    // ceiling here existed to stop that texture's repeat becoming legible. It
    // now comes from a domain-warped procedural field on two shells at
    // different headings, with nothing in it that can repeat, so the amount is
    // free to be set on what the *picture* wants instead of on what the
    // sampling artefact tolerated.
    //
    // What the picture wants is a floor well above zero. A framing that asks
    // for clear weather still needs *a sky*: an ice veil is the cheapest thing
    // that gives a cloudless frame structure, scale and something for the sun
    // to light, and the rubric fails "subject on a plain backdrop" outright.
    // The old 0.09 floor left 'water' and 'hero' with an empty gradient.
    w.cirrusAmount = clamp(0.19 + d.coverage * 0.11 + (d.haze - 0.8) * 0.11, 0.17, 0.32);
  }

  /** The weather state currently being blended toward. */
  get weatherName(): WeatherName { return this.weather.target; }
  get weatherTransitioning(): boolean { return this.weather.transitioning; }

  /** Set the local solar clock, in hours [0,24). */
  setTimeOfDay(hours: number): void {
    this.timeOfDay = ((hours % 24) + 24) % 24;
    this.lutAge = 999;
  }
  getTimeOfDay(): number { return this.timeOfDay; }

  /** Real seconds for one in-game day. 0 freezes the sun where it is. */
  setDayLength(seconds: number): void { this.dayLengthSeconds = Math.max(0, seconds); }

  /** Calendar date, which is what actually sets the solar declination. */
  setDate(year: number, month: number, day: number): void {
    this.year = year; this.month = month; this.day = day; this.lutAge = 999;
  }

  setLocation(latitudeDeg: number, longitudeDeg: number, timezoneHours = this.timezoneHours): void {
    this.latitude = clamp(latitudeDeg, -89, 89);
    this.longitude = longitudeDeg;
    this.timezoneHours = timezoneHours;
    this.lutAge = 999;
  }

  /**
   * Override the wind the weather preset asked for.
   * 'dirDeg' is meteorological — the direction the wind blows *from*.
   * Pass 'null' to hand control back to the weather state.
   */
  setWind(dirDeg: number | null, speedMs = 0): void {
    this.windOverride = dirDeg === null ? null : { dirDeg, speed: Math.max(0, speedMs) };
  }

  /** Current wind as a world-space vector (metres per second, the way it blows). */
  getWind(out = new THREE.Vector3()): THREE.Vector3 {
    const w = this.weather.current;
    const speed = this.windOverride ? this.windOverride.speed : w.windSpeed;
    return out.copy(this.windToward).multiplyScalar(speed);
  }

  /**
   * Trigger a lightning discharge. With no position, one is chosen inside the
   * cloud deck a few kilometres from the camera. Emits 'sky:lightning' with
   * '{ x, y, z, distance, intensity }' so audio can delay the thunder.
   */
  strikeLightning(position?: THREE.Vector3): void {
    const cam = this.ctx?.camera;
    const w = this.weather.current;
    if (position) {
      this.boltPos.copy(position);
    } else {
      const ang = this.rng.range(0, Math.PI * 2);
      const dist = this.rng.range(2500, 11000);
      const cx = cam ? cam.position.x : 0;
      const cz = cam ? cam.position.z : 0;
      this.boltPos.set(
        cx + Math.cos(ang) * dist,
        w.cloudBase + (w.cloudTop - w.cloudBase) * this.rng.range(0.15, 0.55),
        cz + Math.sin(ang) * dist,
      );
    }
    this.bolt.t = 0;
    this.bolt.peak = this.rng.range(0.75, 1.4);
    const d = cam ? cam.position.distanceTo(this.boltPos) : 5000;
    this.ctx?.bus.emit('sky:lightning', {
      x: this.boltPos.x, y: this.boltPos.y, z: this.boltPos.z,
      distance: d, intensity: this.bolt.peak,
    });
  }

  /**
   * Hand the cloud pass a depth texture for the opaque scene. Strongly
   * preferred over the internal prepass: it removes a whole scene traversal.
   * The texture must be a 'DepthTexture' for the same camera as 'ctx.camera'
   * with a standard (non-logarithmic, non-reversed) projection.
   */
  setSceneDepth(texture: THREE.Texture | null): void {
    this.externalDepth = texture;
    if (texture && this.depthRT) {
      this.depthRT.dispose();
      this.depthRT = null;
    }
  }

  /**
   * Approximate cloud density at a world point, 0..1. Sampled from the same
   * baked volume the GPU uses (base shape only, no detail erosion) so gameplay
   * and visuals agree about where the clouds are.
   */
  cloudDensityAt(x: number, y: number, z: number): number {
    if (!this.noise) return 0;
    return cpuCloudDensity(this.noise, this.cpuParams, x, y, z);
  }

  // =========================================================================
  // Subsystem
  // =========================================================================

  async init(ctx: GameContext): Promise<void> {
    this.ctx = ctx;
    this.timeOfDay = ctx.timeOfDay;
    this.tier = ctx.quality;

    this.u = createSkyUniforms();
    this.noise = await bakeCloudNoise(ctx.mapSeed, ctx.quality === 'low' ? 0 : 1);

    // ---- sky backdrop ----
    this.lutRT = makeHdrTarget(SKY_LUT_WIDTH, SKY_LUT_HEIGHT);
    this.lutMat = createSkyLutMaterial(this.u);
    const backdropMat = createSkyBackdropMaterial(this.u, this.lutRT.texture, this.noise.cirrus);
    this.backdrop = makeScreenLayer(backdropMat, -10000, 'skyBackdrop');
    this.backdrop.layers.enable(3);
    // The backdrop is a screen-aligned *clip-space* triangle: its position
    // attribute is (-1,-1)..(3,3), which any pass that swaps in its own vertex
    // program (the composer's depth/normal prepass does exactly that) reads as a
    // 4 m triangle sitting at the world origin. That stamps a lump of near-field
    // depth into the g-buffer at sea level in the middle of the map, which the
    // DOF and AO passes then believe. 'noPrepass' is the hook DepthNormalPass
    // already honours; the sky must never be in a geometry prepass anyway.
    this.backdrop.userData.noPrepass = true;

    // ---- clouds ----
    this.clouds = new VolumetricClouds(this.u, this.noise);
    this.clouds.compositeMesh.userData.noPrepass = true;

    // ---- rain / lightning overlay ----
    const rain = createRainLayer(this.u);
    this.rainMesh = rain.mesh;
    this.rainMat = rain.material;
    this.rainMesh.userData.noPrepass = true;

    this.group.name = 'sky';
    this.group.matrixAutoUpdate = false;
    this.group.add(this.backdrop, this.clouds.compositeMesh, this.rainMesh);
    ctx.scene.add(this.group);

    // The backdrop paints every pixel, so a scene clear colour would be pure
    // overdraw. Removing it also stops three clearing to a stale blue on any
    // frame where the sky is disabled.
    ctx.scene.background = null;
    ctx.scene.fog = new THREE.FogExp2(0xa8ccdf, 0.0000125);

    // ---- lights ----
    // One directional key light, retargeted to the moon after dusk, plus a
    // hemisphere fill whose colours come from the same scattering integral the
    // sky shader uses, so lit surfaces always agree with the background.
    this.sun = new THREE.DirectionalLight(0xffffff, 3.1);
    this.sun.castShadow = ctx.settings.shadows;
    this.sun.shadow.mapSize.set(ctx.settings.shadowMapSize, ctx.settings.shadowMapSize);
    const sc = this.sun.shadow.camera;
    sc.near = 1; sc.far = 6000;
    sc.left = -900; sc.right = 900; sc.top = 900; sc.bottom = -900;
    // Slope-scaled bias: the shallow sun angles of dawn and dusk are exactly
    // when unbiased shadow maps produce acne across every horizontal surface.
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 1.2;
    ctx.scene.add(this.sun);
    ctx.scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbcd8f0, 0x54604a, 1.0);
    ctx.scene.add(this.hemi);

    this.depthMat = new THREE.MeshBasicMaterial({ colorWrite: false });
    this.depthMat.name = 'skyDepthPrepass';

    this.applyQuality(ctx.quality);

    this.disposers.push(ctx.bus.on('quality', (q: QualityTier) => this.applyQuality(q)));
    // Decoupled hand-off: a render subsystem can publish its depth buffer
    // without either module importing the other.
    this.disposers.push(ctx.bus.on('render:depth', (p: { texture?: THREE.Texture } | null) => {
      this.setSceneDepth(p?.texture ?? null);
    }));
    this.disposers.push(ctx.bus.on('sky:setWeather', (p: { name: WeatherName; seconds?: number }) => {
      if (p?.name) this.setWeather(p.name, p.seconds ?? 20);
    }));
    // A camera framing broadcasts the sky it was composed for, on two channels
    // ('weather' for everyone, 'sky:weather' addressed at us). Accept either,
    // and accept a named preset on the same channel so a mission script can say
    // 'storm' where a framing says 'coverage 0.84'.
    const onWeather = (p: {
      name?: WeatherName; seconds?: number;
      coverage?: number; cloudBase?: number; cloudDepth?: number;
      haze?: number; turbidity?: number; windSpeed?: number;
    } | null): void => {
      if (!p) { this.setWeatherDirective(null); return; }
      if (typeof p.cloudBase === 'number') { this.setWeatherDirective(p); return; }
      if (p.name) this.setWeather(p.name, p.seconds ?? 20);
    };
    this.disposers.push(ctx.bus.on('weather', onWeather));
    this.disposers.push(ctx.bus.on('sky:weather', onWeather));
    // Framings set ctx.timeOfDay *and* announce it. Taking the announcement is
    // the only reliable path: the ctx diff heuristic in updateSlow cannot fire
    // on the first frame, when lastPublishedTod is still -1.
    this.disposers.push(ctx.bus.on('sky:timeOfDay', (hours: number) => {
      if (typeof hours === 'number' && isFinite(hours)) this.setTimeOfDay(hours);
    }));

    // Seed everything so frame 0 already looks correct.
    this.weather.set('scattered', 0);
    this.updateSlow(ctx, 0);
    ctx.bus.emit('sky:ready', { system: this });
  }

  update(ctx: GameContext): void {
    this.updateSlow(ctx, ctx.dt);
  }

  lateUpdate(ctx: GameContext): void {
    const renderer = ctx.renderer;
    const cam = ctx.camera;

    // The camera rig runs after us in update order, so recompute its matrices
    // here rather than trusting whatever the last render left behind.
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    _viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

    const u = this.u;
    (u.uCamPos.value as THREE.Vector3).copy(cam.position);
    (u.uCamFwd.value as THREE.Vector3).set(0, 0, -1).applyQuaternion(cam.quaternion);
    (u.uInvViewProj.value as THREE.Matrix4).copy(_viewProj).invert();
    u.uNear.value = cam.near;
    u.uFar.value = cam.far;
    u.uTime.value = ctx.time;
    u.uFrame.value = ctx.frame;

    // The composer draws the whole scene into a buffer of
    // 'drawingBufferSize * settings.renderScale' and blits up at the end, so
    // that — not the canvas — is the resolution every sky buffer has to match.
    // Sizing off the canvas made renderScale, the one lever the adaptive
    // governor has for an integrated GPU, do nothing at all for the most
    // expensive pass in the frame, and silently changed the cloud-buffer to
    // scene-buffer ratio the depth-aware upsample tolerance is tuned against.
    renderer.getDrawingBufferSize(_size);
    const rs = clamp(ctx.settings.renderScale || 1, 0.5, 1);
    const w = Math.max(8, Math.round(_size.x * rs));
    const h = Math.max(8, Math.round(_size.y * rs));
    if (w !== this.bufferW || h !== this.bufferH) {
      this.bufferW = w; this.bufferH = h;
      (u.uResolution.value as THREE.Vector2).set(w, h);
      this.rainMat.uniforms.uAspect.value = w / Math.max(1, h);
      this.clouds.resize(w, h, true);
      this.rebuildDepthTarget();
    }

    this.updateSunScreenPosition(cam);
    this.refreshSkyLut(renderer, cam);

    const cloudsOn = ctx.settings.volumetricClouds;
    this.clouds.compositeMesh.visible = cloudsOn;
    // With the volumetric layer switched off the only clouds left are the two
    // shells on the backdrop, and the horizon deck normally does not fade in
    // until 0.72 * uCloudMaxDist — i.e. 27 km of completely empty sky. Pull it
    // all the way in so the low-end path still has a sky with weather in it.
    u.uDeckNear.value = cloudsOn ? 0.72 : 0.02;

    if (cloudsOn) {
      const depth = this.acquireSceneDepth(ctx);
      if (depth) {
        this.clouds.sunUv.copy(this.sunScreenPos);
        this.clouds.sunOnScreen = this.sunOnScreen;
        this.clouds.render(renderer, depth, this.cloudQuality.godRaySamples > 0);
      } else {
        this.clouds.compositeMesh.visible = false;
      }
    }

    // Held for next frame's temporal reprojection.
    (u.uPrevViewProj.value as THREE.Matrix4).copy(_viewProj);

    // Keep the shadow frustum wrapped around the viewer; a static one either
    // wastes almost all of its texels or clips shadows a few hundred metres out.
    this.updateShadowCamera(ctx);
  }

  resize(width: number, height: number): void {
    // Actual buffer sizing happens in lateUpdate against the drawing buffer,
    // which is the only size that accounts for devicePixelRatio and renderScale.
    void width; void height;
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.group.parent?.remove(this.group);
    this.clouds?.dispose();
    this.lutRT?.dispose();
    this.lutMat?.dispose();
    this.lutRunner.dispose();
    this.depthRT?.dispose();
    this.depthMat?.dispose();
    this.rainMat?.dispose();
    (this.backdrop?.material as THREE.Material | undefined)?.dispose();
    this.noise?.dispose();
  }

  // =========================================================================
  // Per-frame, camera-independent
  // =========================================================================

  private updateSlow(ctx: GameContext, dt: number): void {
    const u = this.u;

    // ---- clock -----------------------------------------------------------
    // If anything else moved ctx.timeOfDay (a mission script, a debug slider),
    // adopt it rather than fighting over the value.
    if (this.lastPublishedTod >= 0 && Math.abs(ctx.timeOfDay - this.lastPublishedTod) > 1e-4) {
      this.timeOfDay = ctx.timeOfDay;
      this.lutAge = 999;
    }
    if (this.dayLengthSeconds > 0 && dt > 0) {
      this.timeOfDay += (dt / this.dayLengthSeconds) * 24;
    }
    this.timeOfDay = ((this.timeOfDay % 24) + 24) % 24;
    ctx.timeOfDay = this.timeOfDay;
    this.lastPublishedTod = this.timeOfDay;

    // ---- weather ---------------------------------------------------------
    this.weather.update(dt);
    const w = this.weather.current;
    this.applyDirective(w);

    // ---- ephemeris -------------------------------------------------------
    computeEphemeris(
      this.year, this.month, this.day, this.timeOfDay, this.timezoneHours,
      this.latitude, this.longitude, this.eph,
    );

    const sunAlt = this.eph.sunAlt;
    const sinAlt = Math.sin(sunAlt);
    const camAlt = Math.max(0, ctx.camera.position.y);

    // Twilight ramps. 'day' gates the direct beam, 'night' gates stars, the
    // moon and the cool palette shift; the gap between them is dusk.
    const day = smoothstep(-0.06, 0.12, sinAlt);
    const night = 1 - smoothstep(-0.19, 0.035, sinAlt);

    (u.uSunDir.value as THREE.Vector3).copy(this.eph.sunDir);
    (u.uMoonDir.value as THREE.Vector3).copy(this.eph.moonDir);
    (u.uStarRot.value as THREE.Matrix4).copy(this.eph.starRotation);
    u.uMoonIllum.value = this.eph.moonIllum;
    u.uMoonAngularRadius.value = this.eph.moonAngularRadius;
    u.uNight.value = night;

    // ---- direct sunlight -------------------------------------------------
    // Hue comes from the real transmittance integral (this is what turns the
    // sun orange at low elevation without a single authored colour); magnitude
    // is art-directed, because the physical value at sunset is ~1e-5 and would
    // read as a bug.
    sunTransmittance(sunAlt, camAlt, _cA);
    const maxC = Math.max(_cA.r, _cA.g, _cA.b, 1e-5);
    // Floor the cool channels relative to red. Below about 2 degrees of
    // elevation the physical transmittance collapses to essentially pure red,
    // which lights an aircraft like a darkroom safelight; real low-sun light is
    // a deep orange because a meaningful fraction of it arrives scattered.
    _cA.setRGB(
      _cA.r / maxC,
      Math.max(_cA.g / maxC, 0.26 * (_cA.r / maxC)),
      Math.max(_cA.b / maxC, 0.075 * (_cA.r / maxC)),
    );

    const moonUp = Math.max(0, Math.sin(this.eph.moonAlt));
    const moonPower = moonUp * this.eph.moonIllum;
    const useMoon = day < 0.02 && moonPower > 0.02;

    if (useMoon) {
      // Moonlight is not actually blue — it is slightly warmer than sunlight —
      // but the Purkinje shift makes low-light scenes read as blue, and every
      // night scene in cinema honours that. So do we.
      ctx.sunColor.setRGB(0.60, 0.71, 1.0);
      ctx.sunIntensity = 0.44 * moonPower;
      ctx.sunDir.copy(this.eph.moonDir).multiplyScalar(-1).normalize();
    } else {
      ctx.sunColor.copy(_cA);
      ctx.sunIntensity = 3.25 * day * w.sunOcclusion;
      ctx.sunDir.copy(this.eph.sunDir).multiplyScalar(-1).normalize();
    }

    // Drive the actual key light. Without these two lines the whole
    // solar/transmittance pipeline terminated in ctx.sunColor/sunIntensity and
    // nothing consumed it for direct light: the sky owns this DirectionalLight,
    // so ShadowRig's 'if (owned)' branch never fires, and every MeshToonMaterial
    // in the world stayed lit by the constructor's full-strength white at
    // midnight, at dusk and under a storm alike.
    // (The light's *placement* belongs to whoever fits the shadow frustum —
    // ShadowRig when a composer is present, updateShadowCamera when not. It
    // takes its direction from ctx.sunDir, which we set just above.)
    this.sun.color.copy(ctx.sunColor);
    this.sun.intensity = ctx.sunIntensity;

    // The sky/cloud shaders want absolute radiance, not a normalised light
    // colour, so they get their own version scaled by the day factor.
    const skySunScale = day * (0.35 + 0.65 * w.sunOcclusion) * 1.25;
    (u.uSunColor.value as THREE.Color).setRGB(
      _cA.r * skySunScale + 0.02 * night,
      _cA.g * skySunScale + 0.025 * night,
      _cA.b * skySunScale + 0.04 * night,
    );
    u.uSunIntensity.value = ctx.sunIntensity;

    // ---- reference sky colours ------------------------------------------
    const exposure = u.uSkyExposure.value as number;
    const haze = w.hazeBoost;
    u.uHaze.value = haze;

    // Zenith: view straight up, so the angle to the sun is the sun's zenith
    // distance. Horizon: sample both toward and away from the sun and mix,
    // because fog and aerial perspective need an average, not a direction.
    skyRadiance(1.0, sinAlt, sunAlt, camAlt, _cB).multiplyScalar(exposure);
    skyRadiance(0.05, Math.cos(sunAlt), sunAlt, camAlt, _cC).multiplyScalar(exposure);
    skyRadiance(0.05, -Math.cos(sunAlt), sunAlt, camAlt, _cD).multiplyScalar(exposure);
    _cC.lerp(_cD, 0.45);

    // Night floor: airglow plus scattered moonlight, so nothing crushes to
    // black and the cel shadow tint stays a colour rather than a void.
    const nightFloor = 0.004 + 0.05 * moonPower;
    _cB.setRGB(
      Math.max(_cB.r, nightFloor * 0.55 * night),
      Math.max(_cB.g, nightFloor * 0.75 * night),
      Math.max(_cB.b, nightFloor * 1.35 * night),
    );
    _cC.setRGB(
      Math.max(_cC.r, nightFloor * 0.7 * night),
      Math.max(_cC.g, nightFloor * 0.85 * night),
      Math.max(_cC.b, nightFloor * 1.2 * night),
    );

    // Twilight lift, peaking a few degrees below the horizon and gone by the
    // time the sun is 12 degrees down.
    const tw = clamp(1 - Math.abs(sinAlt + 0.075) / 0.215, 0, 1);
    const twP = tw * tw * (3 - 2 * tw);
    (u.uTwilight.value as THREE.Color).setRGB(0.052 * twP, 0.058 * twP, 0.105 * twP);
    _cB.setRGB(
      Math.max(_cB.r, 0.016 * twP), Math.max(_cB.g, 0.026 * twP), Math.max(_cB.b, 0.062 * twP));
    _cC.setRGB(
      Math.max(_cC.r, 0.075 * twP), Math.max(_cC.g, 0.070 * twP), Math.max(_cC.b, 0.098 * twP));

    (u.uZenithColor.value as THREE.Color).copy(_cB);
    (u.uHorizonColor.value as THREE.Color).copy(_cC);

    // Ambient is the hemispherical average the shadow side of everything sees.
    _cA.setRGB(
      _cB.r * 0.5 + _cC.r * 0.5,
      _cB.g * 0.5 + _cC.g * 0.5,
      _cB.b * 0.5 + _cC.b * 0.5,
    );
    // Overcast decks scatter far more light down than a clear sky does.
    const ambientBoost = 1 + (1 - w.sunOcclusion) * 0.9;
    _cA.multiplyScalar(ambientBoost);
    // ctx.ambientColor is consumed as a *light colour* (hemisphere light, cel
    // shadow tint), so it has to stay inside [0,1] or every shadow side blows
    // out. Compress the magnitude with Reinhard and keep the chroma exactly:
    // the hue of skylight is the whole point of the cel shadow ramp.
    const lum = 0.2126 * _cA.r + 0.7152 * _cA.g + 0.0722 * _cA.b;
    const compressed = (lum / (1 + lum)) * 0.94;
    _cA.multiplyScalar(compressed / Math.max(lum, 1e-4));
    ctx.ambientColor.copy(_cA);
    (u.uAmbientColor.value as THREE.Color).copy(_cA);

    this.hemi.color.copy(_cA);
    // Ground bounce: a desaturated, darker version of the sky tinted toward
    // the terrain's own albedo.
    this.hemi.groundColor.setRGB(
      _cA.r * 0.42 + 0.055,
      _cA.g * 0.44 + 0.058,
      _cA.b * 0.34 + 0.036,
    );
    this.hemi.intensity = 0.55 + 0.75 * day + 0.35 * (1 - w.sunOcclusion);
    // The clouds see the same ground bounce the aircraft do. Scaled up because
    // the hemisphere light's groundColor is a *light colour* (it gets multiplied
    // by intensity downstream) while the cloud shader wants radiance.
    (u.uCloudGround.value as THREE.Color).copy(this.hemi.groundColor)
      .multiplyScalar(0.55 + 0.45 * day);

    // ---- fog and aerial perspective for everything else -----------------
    const fog = ctx.scene.fog;
    if (fog) {
      fog.color.copy(_cC);
      if ((fog as THREE.FogExp2).isFogExp2) (fog as THREE.FogExp2).density = w.fogDensity;
    }
    celGlobals.uAerialColor.value.copy(_cC);
    // Aerosol has a ~1.2 km scale height, so a camera at altitude looks at
    // distant ground through far less of it than the sea-level formula assumes.
    // Without this correction a 4 km cruise turns the whole lower half of the
    // frame into one flat cyan wash, which is both wrong and the fastest way to
    // lose every depth cue the terrain has.
    const aerialLift = 1 + Math.min(camAlt / 2800, 1.9);
    u.uAerialFar.value = w.aerialFar * aerialLift;
    celGlobals.uAerialFar.value = w.aerialFar * aerialLift;
    celGlobals.uAerialStrength.value = 0.9;
    celGlobals.uGroundColor.value.copy(this.hemi.groundColor);

    // ---- weather -> uniforms --------------------------------------------
    u.uCloudBase.value = w.cloudBase;
    u.uCloudTop.value = w.cloudTop;
    u.uCoverage.value = w.coverage;
    u.uDensity.value = w.density;
    u.uCloudType.value = w.cloudTypeBias;
    u.uShapeScale.value = 1 / w.shapeSize;
    u.uDetailScale.value = 1 / w.detailSize;
    u.uWeatherScale.value = 1 / w.weatherSize;
    u.uCloudAmbient.value = w.cloudAmbient;
    u.uSilver.value = w.silver;
    u.uGroundFog.value = w.groundFog;
    u.uGroundFogHeight.value = w.groundFogHeight;
    u.uCirrusAmount.value = w.cirrusAmount;
    u.uCirrusHeight.value = w.cirrusHeight;
    u.uDeckAmount.value = w.deckAmount;
    // The painted deck stands in for the volumetric layer past the march range,
    // so its shell has to sit where that layer's *silhouette* does — around the
    // middle of the slab, not below its base. At 0.85 x cloudBase the distant
    // deck rendered underneath the near clouds and the two met at a visible
    // horizontal step in the cross-fade band.
    u.uDeckHeight.value = Math.max(600, w.cloudBase + (w.cloudTop - w.cloudBase) * 0.34);
    u.uGodRayStrength.value = w.godRayStrength;
    u.uRain.value = clamp(w.rain * this.canopyRain, 0, 1);

    // Sky stylisation shifts through the day: midday skies band cleanly and
    // stay saturated, twilight wants softer steps or the gradient shatters.
    // Band strength, not band count. Leaving a fraction of the continuous
    // gradient in place is what makes the steps read as brushwork sitting on a
    // sky rather than as a posterise filter over one: at 1.0 the top of the
    // frame becomes a single flat lobe with a hard rim, which reads as a bug.
    u.uSkyBandAmount.value = 0.62 - 0.50 * night - 0.16 * (1 - day) * (1 - night);
    // Saturation is applied around luminance, so pushing it hard on a sky whose
    // mid-elevations are already a desaturated blue-green mix rotates that whole
    // band toward green — the exact fringe the additive horizon warm exists to
    // avoid. Keep the boost modest and let the warm term do the work.
    u.uSkySaturation.value = 1.12 - 0.16 * night;
    // Strength of the horizon haze band. This used to be almost zero in
    // daylight because the band was an unbounded additive cream and any real
    // weight on it blew the horizon out. The band is now a bounded blend
    // toward a sun-angle-tinted haze colour, and at high sun that colour is a
    // cool blue-white — which is what the daytime horizon is, and what the sky
    // needs to be pulled toward. Left alone, the LUT's near-horizon gradient
    // crosses a band where green is the largest surviving channel and puts a
    // teal fringe between the blue sky and the cloud deck. Desaturating toward
    // the haze colour is the fix; being timid about it was the bug.
    u.uHorizonWarmAmount.value = 0.16 + 0.44 * (1 - day) * (1 - night) + 0.30 * day;

    // ---- wind ------------------------------------------------------------
    const windDir = this.windOverride ? this.windOverride.dirDeg : w.windDirDeg;
    const windSpeed = this.windOverride ? this.windOverride.speed : w.windSpeed;
    const rad = windDir * DEG;
    // Meteorological convention: 'windDirDeg' is where it comes FROM, and
    // north is -Z, so the vector it blows toward is (-sin, 0, +cos).
    this.windToward.set(-Math.sin(rad), 0, Math.cos(rad));

    if (dt > 0) {
      const wind = u.uWind.value as THREE.Vector3;
      // Sampling at (p + uWind) with uWind moving against the wind translates
      // the cloud field along it.
      wind.addScaledVector(this.windToward, -windSpeed * dt);
      // Slow vertical drift so towers boil rather than sliding rigidly.
      wind.y -= w.evolveRate * dt * 1.4;

      const wo = u.uWeatherOffset.value as THREE.Vector2;
      // The organisation of a cloud field drifts far slower than the cells
      // inside it; 18% of the wind speed matches how cumulus streets behave.
      const wk = (windSpeed * 0.18 * dt) / w.weatherSize;
      wo.x -= this.windToward.x * wk;
      wo.y -= this.windToward.z * wk;

      // Cirrus lives in the jet stream and moves much faster than the deck.
      const ck = (windSpeed * 2.6 * dt) / 52000;
      const c1 = u.uCirrusOffset.value as THREE.Vector2;
      const c2 = u.uCirrusOffset2.value as THREE.Vector2;
      c1.x -= this.windToward.x * ck; c1.y -= this.windToward.z * ck;
      c2.x -= this.windToward.x * ck * 1.7; c2.y -= this.windToward.z * ck * 1.7;
      const dk = (windSpeed * 0.5 * dt) / 190000;
      const d1 = u.uDeckOffset.value as THREE.Vector2;
      d1.x -= this.windToward.x * dk; d1.y -= this.windToward.z * dk;
    }

    // ---- lightning -------------------------------------------------------
    this.updateLightning(dt, w.lightningRate);

    // ---- rain overlay ----------------------------------------------------
    const rainAmount = u.uRain.value as number;
    const flash = u.uLightningFlash.value as number;
    this.rainMesh.visible = rainAmount > 0.004 || flash > 0.002;
    // Streaks are blown aft: on a moving aircraft the apparent rain direction
    // is the vector sum of fall speed and airspeed, mostly the latter.
    const streak = this.rainMat.uniforms.uStreakDir.value as THREE.Vector2;
    streak.set(0.10 + 0.28 * Math.sin(ctx.time * 0.7), -1);

    // ---- CPU cloud query -------------------------------------------------
    const p = this.cpuParams;
    p.base = w.cloudBase; p.top = w.cloudTop;
    p.coverage = w.coverage; p.density = w.density;
    p.cloudTypeBias = w.cloudTypeBias;
    p.shapeScale = 1 / w.shapeSize; p.weatherScale = 1 / w.weatherSize;
    const wind = u.uWind.value as THREE.Vector3;
    p.windX = wind.x; p.windY = wind.y; p.windZ = wind.z;
    const wo = u.uWeatherOffset.value as THREE.Vector2;
    p.weatherOffsetX = wo.x; p.weatherOffsetY = wo.y;

    const cp = ctx.camera.position;
    p.camX = cp.x; p.camZ = cp.z;
    p.planetR = u.uCloudPlanetR.value as number;
    this.cameraCloudDensity = this.cloudDensityAt(cp.x, cp.y, cp.z);
    // 0.12, not 0.16: the CPU field now applies the same vertical density ramp
    // the GPU does, which takes typical in-cloud values down by a quarter to a
    // half. The old threshold was calibrated against a number that no longer
    // exists, and with the ramp in place it would only fire in the very densest
    // core of a tower rather than when the canopy actually goes white.
    const inside = this.cameraCloudDensity > 0.12;
    if (inside !== this.cameraInCloud) {
      this.cameraInCloud = inside;
      ctx.bus.emit('sky:inCloud', { inside, density: this.cameraCloudDensity });
    }
  }

  // =========================================================================
  // Lightning
  // =========================================================================

  private updateLightning(dt: number, rate: number): void {
    const u = this.u;
    if (rate > 0 && dt > 0) {
      this.lightningTimer -= dt;
      if (this.lightningTimer <= 0) {
        this.strikeLightning();
        // Exponential inter-arrival times: a Poisson process is what makes a
        // storm feel random rather than metronomic.
        this.lightningTimer = -Math.log(Math.max(1e-4, 1 - this.rng.next())) / rate;
      }
    }

    if (this.bolt.t >= 0) {
      this.bolt.t += dt;
      const x = this.bolt.t / this.bolt.dur;
      // Three overlapping strokes — real flashes are a leader plus return
      // strokes a few tens of milliseconds apart, which is why lightning
      // flickers instead of simply fading.
      const g = (c: number, k: number) => Math.exp(-((x - c) * k) * ((x - c) * k));
      const env = (g(0.04, 13) + 0.8 * g(0.19, 17) + 0.45 * g(0.40, 21)) * this.bolt.peak;
      u.uBoltIntensity.value = env * 2.2;
      (u.uBoltPos.value as THREE.Vector3).copy(this.boltPos);
      u.uLightningFlash.value = env * 0.42;
      if (this.bolt.t > this.bolt.dur) {
        this.bolt.t = -1;
        u.uBoltIntensity.value = 0;
        u.uLightningFlash.value = 0;
      }
    }
  }

  // =========================================================================
  // Rendering helpers
  // =========================================================================

  private applyQuality(tier: QualityTier): void {
    this.tier = tier;
    const t = CLOUD_TIERS[tier] ?? CLOUD_TIERS.high;
    const settingsSteps = this.ctx?.settings.cloudSteps ?? 48;
    this.cloudQuality = {
      renderScale: t.renderScale,
      steps: clamp(Math.round(settingsSteps * t.stepMul), 12, 96),
      lightSteps: t.lightSteps,
      godRaySamples: t.godRaySamples,
      temporalBlend: t.temporalBlend,
    };
    this.clouds?.applyQuality(this.cloudQuality);
    // Fewer bands and a softer sky at low quality: the banding and the ink
    // contour both need resolution to read as deliberate. Five is the useful
    // maximum — core, cool shadow, mid, warm mid, full sun — and four collapses
    // the two mid steps, which is what flattened lit cloud tops into one white.
    this.u.uCloudBands.value = tier === 'low' ? 3 : tier === 'medium' ? 4 : 5;
    this.u.uCloudInkAmount.value = tier === 'low' ? 0.55 : 1.05;
    if (this.sun) this.sun.castShadow = this.ctx?.settings.shadows ?? true;
  }

  /**
   * The scattering LUT only depends on sun elevation, camera altitude and haze,
   * so it is rebuilt on a change threshold rather than every frame. At a normal
   * day-cycle rate that is a handful of rebuilds per second.
   */
  private refreshSkyLut(renderer: THREE.WebGLRenderer, cam: THREE.PerspectiveCamera): void {
    const sunY = (this.u.uSunDir.value as THREE.Vector3).y;
    const alt = Math.max(0, cam.position.y);
    const interval = (CLOUD_TIERS[this.tier] ?? CLOUD_TIERS.high).lutInterval;
    this.lutAge++;
    const moved = Math.abs(sunY - this.lutSunY) > 0.0015 || Math.abs(alt - this.lutAltitude) > 120;
    if (!moved && this.lutAge < interval * 30) return;
    if (this.lutAge < interval) return;

    this.lutSunY = sunY;
    this.lutAltitude = alt;
    this.lutAge = 0;
    this.lutMat.uniforms.uSunCosZenith.value = sunY;
    this.u.uAltitudeLut.value = alt;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    this.lutRunner.render(renderer, this.lutMat, this.lutRT);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  private updateSunScreenPosition(cam: THREE.PerspectiveCamera): void {
    const sunDir = this.u.uSunDir.value as THREE.Vector3;
    _v3a.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const facing = _v3a.dot(sunDir);
    // _viewProj is already this frame's projection * inverse-view, so a direct
    // applyMatrix4 (which performs the perspective divide) is both correct and
    // cheaper than Vector3.project(), which would recompute camera matrices.
    _v3b.copy(cam.position).addScaledVector(sunDir, 20000);
    _v3b.applyMatrix4(_viewProj);
    this.sunScreenPos.set(_v3b.x * 0.5 + 0.5, _v3b.y * 0.5 + 0.5);
    // God rays only make sense with the sun in front of the camera, and the
    // radial blur degenerates once the source leaves the frame by much.
    this.sunOnScreen = facing > 0.05
      && this.sunScreenPos.x > -0.6 && this.sunScreenPos.x < 1.6
      && this.sunScreenPos.y > -0.6 && this.sunScreenPos.y < 1.6
      && sunDir.y > -0.02;
  }

  /**
   * Depth for the cloud occlusion test, in order of preference:
   *
   *  1. a texture handed to us on 'render:depth' (or through 'setSceneDepth');
   *  2. the render subsystem's own g-buffer depth, read through its public
   *     accessor — same thing, but it works whether or not that module has got
   *     round to emitting the event;
   *  3. our own depth-only prepass, which is correct but pays for a second full
   *     scene traversal and only exists so the sky stands alone.
   *
   * (2) is one frame stale, because the sky's lateUpdate runs before the
   * composer's. That is deliberate and invisible: the cloud buffer is half
   * resolution and 85 % history anyway, so a one-frame-old occluder silhouette
   * cannot be told apart from the temporal filter's own lag — and it is worth a
   * whole scene traversal per frame.
   */
  private acquireSceneDepth(ctx: GameContext): THREE.Texture | null {
    if (this.externalDepth) return this.externalDepth;
    if (!this.renderSubProbed) {
      this.renderSubProbed = true;
      const sub = ctx.get('render') as unknown as
        { depthTexture?: THREE.Texture | null } | undefined;
      if (sub && 'depthTexture' in sub) this.renderSub = sub;
    }
    const shared = this.renderSub?.depthTexture;
    if (shared) {
      // Once a composer is supplying depth our own target is dead weight.
      if (this.depthRT) { this.depthRT.dispose(); this.depthRT = null; }
      return shared;
    }
    return this.renderDepthPrepass(ctx);
  }

  private rebuildDepthTarget(): void {
    if (this.externalDepth || this.renderSub?.depthTexture) return;
    this.depthRT?.dispose();
    const w = this.bufferW, h = this.bufferH;
    const depthTexture = new THREE.DepthTexture(w, h);
    depthTexture.type = THREE.UnsignedIntType;
    depthTexture.format = THREE.DepthFormat;
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;
    this.depthRT = new THREE.WebGLRenderTarget(w, h, {
      depthTexture,
      depthBuffer: true,
      stencilBuffer: false,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
    });
  }

  /**
   * Fallback depth source. Renders the scene depth-only with colour writes
   * masked; the sky's own screen layers are hidden so they cannot contribute.
   *
   * This exists so the sky is correct standing alone. A render subsystem that
   * already has a depth buffer should call 'setSceneDepth' and skip it.
   */
  private renderDepthPrepass(ctx: GameContext): THREE.Texture | null {
    if (!this.depthRT) this.rebuildDepthTarget();
    const rt = this.depthRT;
    if (!rt) return null;

    const renderer = ctx.renderer;
    const scene = ctx.scene;
    const prevOverride = scene.overrideMaterial;
    const prevBackground = scene.background;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    // Critical: three re-renders every shadow map on each renderer.render()
    // call. Without this the prepass silently doubles the shadow cost of the
    // whole frame, which is far more expensive than the prepass itself.
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;

    // Alpha-blended surfaces must not appear in this buffer. The override
    // material is opaque and depth-writing, so a propeller disc, a smoke
    // billboard or a tree card would stamp its whole *quad* into depth — and
    // the cloud march reads this buffer as "solid geometry occludes the sky
    // here". The visible symptom is a hard-edged rectangle of raw backdrop
    // punched through the cloud layer wherever a transparent quad happens to
    // be, which is exactly what a prop disc did in every chase framing.
    // Same rule the composer's own gbuffer prepass uses; opt back in with
    // 'userData.forcePrepass'.
    const hidden = this.depthHidden;
    hidden.length = 0;
    scene.traverseVisible((o) => {
      const any = o as unknown as {
        isMesh?: boolean; isPoints?: boolean; isLine?: boolean; isSprite?: boolean;
        material?: THREE.Material | THREE.Material[];
      };
      if (!any.isMesh && !any.isPoints && !any.isLine && !any.isSprite) return;
      if (o.userData.forcePrepass === true) return;
      let skip = o.userData.noPrepass === true
        || any.isPoints === true || any.isSprite === true || any.isLine === true;
      if (!skip && any.material) {
        const m = any.material;
        skip = Array.isArray(m)
          ? m.some((x) => x.transparent === true || x.alphaTest > 0)
          : (m.transparent === true || m.alphaTest > 0);
      }
      if (skip) { o.visible = false; hidden.push(o); }
    });

    this.group.visible = false;
    scene.overrideMaterial = this.depthMat;
    scene.background = null;
    renderer.autoClear = false;
    renderer.setRenderTarget(rt);
    renderer.clear(false, true, false);
    renderer.render(scene, ctx.camera);

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;
    this.group.visible = true;
    for (const o of hidden) o.visible = true;
    hidden.length = 0;

    return rt.depthTexture;
  }

  /**
   * Standalone shadow placement.
   *
   * Only runs when there is no render subsystem. The composer owns a proper
   * fitted, texel-snapped ortho rig (see passes/ShadowRig) which explicitly
   * adopts whatever DirectionalLight the sky put in the scene; overwriting its
   * placement afterwards destroyed the texel snap — so every shadow edge in the
   * frame crawled — and left the ortho bounds describing a point the light was
   * no longer at, which dropped terrain shadows entirely at altitude. The sky
   * owns the sun's *direction, colour and intensity*; the renderer owns where
   * the shadow box goes.
   */
  private updateShadowCamera(ctx: GameContext): void {
    if (!this.sun.castShadow) return;
    if (ctx.get('render') !== undefined) return;
    const cam = ctx.camera;
    // Push the shadow volume ahead of the camera so most of its texels land on
    // what the player is actually looking at.
    _v3a.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _v3b.copy(cam.position).addScaledVector(_v3a, 450);
    _v3b.y = Math.max(0, _v3b.y - 200);
    this.sun.target.position.copy(_v3b);
    this.sun.position.copy(_v3b).addScaledVector(ctx.sunDir, -2500);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }
}
