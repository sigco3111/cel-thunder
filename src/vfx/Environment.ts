import * as THREE from 'three';
import { resetSpawn, type ParticleSpawn } from './ParticleEngine';
import { RAMP, SMOKE_TILES, TILE, buildNoiseTexture } from './VfxTextures';
import type { VfxCore } from './VfxCore';

/**
 * Weather and airfield dressing.
 *
 * The canopy rain is a full-screen card pinned just past the near plane rather
 * than a particle system, for two reasons: a real windscreen has water *on* it,
 * not in front of it, and a screen-space effect can afford the per-pixel detail
 * that sells surface tension — beaded droplets that sit still until they get
 * heavy, then run, and streaks whose angle is set by the ratio of airspeed to
 * the drops' terminal velocity.
 *
 * The streaks are hard-edged and quantised like everything else: the reference
 * is ink on a cel, not a soft photographic blur.
 */

const RAIN_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const RAIN_FRAG = /* glsl */`
uniform sampler2D uNoise;
uniform float uTime;
uniform float uIntensity;
uniform float uSpeed;       // airspeed, m/s: sets streak angle and length
uniform float uAspect;
uniform vec3  uTint;
uniform vec3  uInkColor;

varying vec2 vUv;

/**
 * One layer of rivulets. Each cell holds at most one drop; "thresh" decides how
 * many cells are occupied, which is the only honest way to control rain density
 * -- scaling alpha instead just produces grey haze.
 */
float streaks( vec2 uv, float cell, float phase, float len, float speed, float thresh ) {
  vec2 g = vec2( uv.x * cell, uv.y * cell * 0.55 );
  vec2 id = floor( g );
  vec2 f = fract( g );
  // Sample the uniform per-texel hash channel at exact texel centres: the fbm
  // channel clusters around 0.5 and would never cross a high threshold, which
  // is the classic way procedural rain ends up either absent or wall-to-wall.
  vec2 huv = ( id + phase + 0.5 ) / 128.0;
  float r = texture2D( uNoise, huv ).g;
  if ( r < thresh ) return 0.0;

  float r2 = texture2D( uNoise, huv.yx + 0.37 ).g;
  // A rivulet does not slide at constant speed: it hangs, then releases. The
  // squared phase gives that stop-start crawl for free.
  float t = fract( uTime * speed * ( 0.35 + r * 0.9 ) + r2 * 7.0 );
  t = t * t;
  float y = f.y - t * 1.35 + 0.18;
  float w = 0.020 + r2 * 0.018;
  float d = abs( f.x - 0.5 + ( r2 - 0.5 ) * 0.5 );

  // The head is fat and the tail is a thread: that asymmetry is what makes it
  // read as water rather than as a scratch on the lens.
  float along = clamp( 1.0 - abs( y ) / len, 0.0, 1.0 );
  float taper = mix( 0.30, 1.0, smoothstep( 0.0, 0.45, along ) );
  float head = 1.0 - smoothstep( 0.0, w * 2.0, length( vec2( d, y * 0.5 ) ) );
  float body = ( 1.0 - smoothstep( 0.0, w * taper, d ) ) * along * step( y, 0.0 );
  return max( head, body * 0.8 );
}

void main() {
  if ( uIntensity <= 0.002 ) discard;

  // Shear the whole field by airspeed: parked, the rivulets run straight down;
  // at 150 m/s the slipstream lays them almost flat across the glass.
  float shear = clamp( uSpeed / 110.0, 0.0, 1.8 );
  vec2 uv = vUv;
  uv.x *= uAspect;
  uv.x += ( uv.y - 0.5 ) * shear;

  float len = mix( 0.16, 0.42, clamp( uSpeed / 150.0, 0.0, 1.0 ) );
  // Occupancy carries the intensity, not opacity. Scaling alpha would give a
  // grey film over the whole canopy, which is the classic wrong-looking rain.
  float thresh = mix( 0.90, 0.42, uIntensity );

  float s = 0.0;
  s = max( s, streaks( uv, 15.0, 0.0, len, 0.55, thresh ) );
  s = max( s, streaks( uv, 23.0, 5.0, len * 0.65, 0.85, thresh + 0.05 ) * 0.75 );

  // Beading: drops that sit still on the glass. Above about 45 m/s the airflow
  // strips them off, which is why a taxiing aircraft looks wetter than a
  // diving one.
  vec4 nz = texture2D( uNoise, uv * 0.85 + vec2( 0.0, uTime * 0.006 ) );
  float bead = smoothstep( 0.80, 0.93, nz.b ) *
               ( 1.0 - clamp( uSpeed / 45.0, 0.0, 1.0 ) ) * uIntensity;
  s = max( s, bead * 0.8 );

  // Keep the middle of the windscreen clear: that is where the airflow scours
  // hardest, and it is also where the player is trying to aim.
  vec2 c = ( vUv - 0.5 ) * vec2( 1.6, 1.0 );
  s *= mix( 0.28, 1.0, smoothstep( 0.12, 0.60, length( c ) ) );

  // Hard threshold with a one-pixel AA band: graphic, not a grey wash.
  float aa = fwidth( s ) * 0.9 + 1e-4;
  float a = smoothstep( 0.34 - aa, 0.34 + aa, s );
  if ( a <= 0.01 ) discard;

  float hot = smoothstep( 0.62, 0.88, s );
  vec3 col = mix( uTint * 0.85, uTint * 1.5, hot );
  // A dark lip where the drop thins out reads as refraction.
  col = mix( uInkColor, col, smoothstep( 0.34, 0.50, s ) );

  gl_FragColor = vec4( col, a * ( 0.22 + 0.42 * uIntensity ) );
}
`;

export class CanopyRain {
  readonly mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private noise: THREE.DataTexture;
  private geom: THREE.PlaneGeometry;
  intensity = 0;

  constructor() {
    this.noise = buildNoiseTexture(128, 0x51ee);
    this.geom = new THREE.PlaneGeometry(1, 1);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uNoise: { value: this.noise },
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uSpeed: { value: 0 },
        uAspect: { value: 1.78 },
        uTint: { value: new THREE.Color(0.82, 0.90, 0.97) },
        uInkColor: { value: new THREE.Color(0x121821) },
      },
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.material.name = 'vfx.canopyRain';
    this.mesh = new THREE.Mesh(this.geom, this.material);
    this.mesh.name = 'vfx.canopyRain';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4000;
    this.mesh.visible = false;
    this.mesh.matrixAutoUpdate = false;
  }

  update(time: number, camera: THREE.PerspectiveCamera, speed: number): void {
    this.material.uniforms.uIntensity.value = this.intensity;
    this.mesh.visible = this.intensity > 0.002;
    if (!this.mesh.visible) return;

    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uSpeed.value = speed;
    this.material.uniforms.uAspect.value = camera.aspect;

    // Pin the card just past the near plane and size it to exactly fill the
    // frustum there, so it behaves like a screen-space pass without needing
    // one.
    const d = camera.near * 2.2;
    const h = 2 * d * Math.tan((camera.fov * Math.PI) / 360);
    const w = h * camera.aspect;
    this.mesh.quaternion.copy(camera.quaternion);
    this.mesh.position.copy(camera.position).addScaledVector(
      _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion), d);
    this.mesh.scale.set(w, h, 1);
    this.mesh.updateMatrix();
    this.mesh.matrixWorldNeedsUpdate = true;
  }

  dispose(): void {
    this.geom.dispose();
    this.material.dispose();
    this.noise.dispose();
  }
}

const _fwd = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Persistent world emitters: airfield smoke pots, burning wreckage, oil fires
// ---------------------------------------------------------------------------

export interface SmokeSource {
  id: number;
  x: number; y: number; z: number;
  /** 0 = a marker pot, 1 = a serious fire. */
  heat: number;
  scale: number;
  ramp: number;
  /** Seconds remaining; Infinity for permanent airfield markers. */
  ttl: number;
  timer: number;
  active: boolean;
}

export class SmokeSources {
  private list: SmokeSource[] = [];
  private nextId = 1;

  constructor(capacity = 48) {
    for (let i = 0; i < capacity; i++) {
      this.list.push({ id: 0, x: 0, y: 0, z: 0, heat: 0, scale: 1, ramp: RAMP.SmokePot, ttl: 0, timer: 0, active: false });
    }
  }

  add(x: number, y: number, z: number, scale: number, heat: number, ttl = Infinity, ramp?: number): number {
    for (const s of this.list) {
      if (s.active) continue;
      s.active = true;
      s.id = this.nextId++;
      s.x = x; s.y = y; s.z = z;
      s.scale = scale; s.heat = heat; s.ttl = ttl; s.timer = 0;
      s.ramp = ramp ?? (heat > 0.5 ? RAMP.SmokeBlack : RAMP.SmokePot);
      return s.id;
    }
    return 0;
  }

  remove(id: number): void {
    for (const s of this.list) if (s.id === id) { s.active = false; s.id = 0; }
  }

  /**
   * Back-dates a column so it is already established.
   *
   * A source lit this frame is a smudge on the ground for the next ten seconds,
   * which is useless for a screenshot (and for a player who has just flown into
   * a battle that is supposed to have been going on without them). The particle
   * engine solves each trajectory in closed form from an absolute birth time,
   * so a *negative* spawn delay is a particle that was born in the past: it
   * appears already risen, already grown, already partly dissolved. Priming
   * with a spread of ages therefore produces the whole column in one frame,
   * exactly as if it had been burning for 'seconds'.
   */
  prime(core: VfxCore, id: number, seconds: number): void {
    const src = this.list.find((s) => s.active && s.id === id);
    if (!src) return;
    const now = core.time;
    const p = resetSpawn();
    // Match the steady-state rate below (one tick every 0.09 s, ~2 per tick) so
    // the primed history has the same density as what follows it.
    const ticks = Math.max(1, Math.round(seconds / 0.09));
    for (let k = 0; k < ticks; k++) {
      const age = seconds * (1 - k / ticks);
      const n = core.count(2, src.x, src.y, src.z);
      for (let i = 0; i < n; i++) {
        this.fillPlume(core, p, src, i);
        p.delay = -age;
        // Skip anything that would already be dead — it is a wasted ring slot.
        if (age >= p.life) continue;
        core.smoke.emit(now, p);
      }
    }
    p.delay = 0;
  }

  clear(): void { for (const s of this.list) { s.active = false; s.id = 0; } }

  /**
   * One stamp of a column, shared by the live emitter and the priming pass so
   * a back-dated history is indistinguishable from smoke that really burned.
   */
  private fillPlume(core: VfxCore, p: ParticleSpawn, s: SmokeSource, i: number): void {
    p.x = s.x + core.sym(s.scale * 0.35);
    p.y = s.y + core.rand(0, s.scale * 0.4);
    p.z = s.z + core.sym(s.scale * 0.35);
    p.vx = core.sym(0.8);
    p.vy = core.rand(1.8, 4.5) * (0.6 + s.heat);
    p.vz = core.sym(0.8);
    p.life = core.rand(5, 12);
    p.size0 = s.scale * core.rand(0.5, 1.0);
    p.size1 = s.scale * core.rand(4, 9);
    p.rot = core.rand(0, 6.283); p.spin = core.sym(0.4);
    p.drag = core.rand(0.25, 0.5);
    p.grav = -0.12;
    p.wind = 1.35;                  // pots are the wind indicator
    p.turb = s.scale * 0.25;
    p.ramp = s.ramp;
    p.tile = core.rng.next() < 0.2 ? TILE.Torn : SMOKE_TILES[i % SMOKE_TILES.length];
    p.erode = core.rand(0.55, 0.85); p.band = 0.9;
    p.r = p.g = p.b = core.rand(0.74, 1.18);
    p.a = 1;
    p.stretch = 0;
  }

  update(core: VfxCore): void {
    const now = core.time;
    const p = resetSpawn();
    for (const s of this.list) {
      if (!s.active) continue;
      s.ttl -= core.dt;
      if (s.ttl <= 0) { s.active = false; s.id = 0; continue; }
      if (core.tooFar(s.x, s.y, s.z, 9000)) continue;

      // A burning wreck is a light source, not just a smoke source. Reported
      // every frame (the rig scores by apparent brightness and only two survive)
      // so a strafed vehicle actually lights the ground it is standing on.
      if (s.heat > 0.5) {
        core.fireLight.report(s.x, s.y + s.scale * 0.4, s.z, 0.7 + s.heat * 0.9 + s.scale * 0.25);
      }

      s.timer -= core.dt;
      if (s.timer > 0) continue;
      s.timer = 0.09;

      const n = core.count(2, s.x, s.y, s.z);
      for (let i = 0; i < n; i++) {
        this.fillPlume(core, p, s, i);
        core.smoke.emit(now, p);
      }

      // Hot sources get a flame licking at the base.
      if (s.heat > 0.5) {
        const fn = core.count(2, s.x, s.y, s.z);
        for (let i = 0; i < fn; i++) {
          p.x = s.x + core.sym(s.scale * 0.3);
          p.y = s.y + core.rand(0, s.scale * 0.3);
          p.z = s.z + core.sym(s.scale * 0.3);
          p.vx = core.sym(1.2);
          p.vy = core.rand(2, 6);
          p.vz = core.sym(1.2);
          p.life = core.rand(0.3, 0.8);
          p.size0 = s.scale * core.rand(0.4, 0.8);
          p.size1 = s.scale * core.rand(1.0, 2.0);
          p.rot = core.rand(0, 6.283); p.spin = core.sym(2);
          p.drag = 2.0; p.grav = -0.7; p.wind = 0.3; p.turb = s.scale * 0.4;
          p.ramp = RAMP.FireStream; p.tile = TILE.Wisp;
          p.erode = core.rand(0.3, 0.7); p.band = 1.6;
          p.a = 1;
          core.fire.emit(now, p);
        }
      }
    }
  }
}
