import * as THREE from 'three';
import type { GameContext, QualityTier, Subsystem } from '../../engine/context';

/**
 * Fitted directional shadow.
 *
 * The problem this solves: a 64 km map, a camera that flies from 0 to 11 km,
 * and a requirement that an aircraft's shadow on the ground stays crisp with
 * the aircraft 1–5 km away. A single ortho frustum covering the visible world
 * would give a shadow texel tens of metres across — a blob.
 *
 * True CSM is the textbook answer, but it requires patching the shadow lookup
 * inside every lit material to pick a cascade, and the cel material is owned by
 * another module. Two shadow-casting directional lights is *not* an equivalent
 * — each light applies its own shadow term to its own diffuse contribution, so
 * splitting intensity between two cascades halves the shadow density everywhere
 * instead of handing off between them.
 *
 * So: one light, with the frustum fitted per frame to the region that actually
 * matters, which for an air combat game is a sphere around the point the camera
 * is looking at (or the ground beneath it) sized from the subject distance.
 * That yields 0.4–2 m texels in practice — a 10 m fighter's shadow is 5–25
 * texels across at 1 km, which is a readable aeroplane shape rather than a
 * smudge.
 *
 * Two details that make or break it:
 *  - The fit is a *sphere*, not the frustum's bounding box. A box changes size
 *    as the camera rotates, which makes every shadow edge crawl.
 *  - The centre is snapped to whole shadow texels in light space, which removes
 *    the last source of sub-texel swimming as the camera translates.
 */
export class ShadowRig {
  private light: THREE.DirectionalLight | null = null;
  /** True when we created the light ourselves (no sun in the scene). */
  private owned = false;
  private targetObj: THREE.Object3D | null = null;
  private mapSize = 0;
  private rescanCountdown = 0;
  private enabled = true;

  /** Radius of the fitted region, metres — exposed for debugging. */
  fitRadius = 0;
  /** Index into RADIUS_LADDER currently in use (see quantiseRadius). */
  private fitIndex = 0;
  /** Duck-typed terrain sampler from the world subsystem (see groundHeight). */
  private terrainAt: ((x: number, z: number) => number) | null = null;
  private samplerTick = 0;

  init(ctx: GameContext): void {
    this.acquireLight(ctx);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.light) this.light.castShadow = on;
  }

  private acquireLight(ctx: GameContext): void {
    const candidates: THREE.DirectionalLight[] = [];
    ctx.scene.traverse((o) => {
      const l = o as THREE.DirectionalLight;
      if (l.isDirectionalLight === true) candidates.push(l);
    });
    // Prefer a light that already wants to cast; otherwise take the first sun
    // the sky system put in the scene.
    const found = candidates.find((l) => l.castShadow) ?? candidates[0];

    if (found === undefined) {
      // Nothing to adopt — stand up our own key light so the renderer still
      // produces shadows in isolation (and in the screenshot harness).
      const l = new THREE.DirectionalLight(ctx.sunColor.clone(), ctx.sunIntensity);
      l.name = 'render:sun';
      ctx.scene.add(l);
      ctx.scene.add(l.target);
      this.light = l;
      this.owned = true;
    } else {
      this.light = found;
      this.owned = false;
    }

    const light = this.light!;
    light.castShadow = this.enabled;
    this.targetObj = light.target;
    if (!this.targetObj.parent) ctx.scene.add(this.targetObj);

    const s = light.shadow;
    s.camera.near = 1;
    s.autoUpdate = true;
    // Slightly negative constant bias; the real work is done by normalBias,
    // which is set per frame from the world size of a shadow texel.
    s.bias = -0.00006;
    s.blurSamples = 8;
  }

  setQuality(q: QualityTier, shadowsEnabled: boolean, requestedSize: number): void {
    if (!this.light) return;
    this.enabled = shadowsEnabled;
    this.light.castShadow = shadowsEnabled;

    const cap = q === 'ultra' ? 4096 : q === 'high' ? 2048 : q === 'medium' ? 2048 : 1024;
    const size = Math.min(cap, Math.max(512, requestedSize | 0));
    if (size !== this.mapSize) {
      this.mapSize = size;
      this.light.shadow.mapSize.set(size, size);
      // three allocates the map lazily; dropping it forces a resize.
      if (this.light.shadow.map) {
        this.light.shadow.map.dispose();
        this.light.shadow.map = null;
      }
    }
  }

  /**
   * @param subject  World position of the player's aircraft, if there is one.
   *                 The fit is biased to keep it (and its cast shadow) inside.
   */
  update(ctx: GameContext, subject: THREE.Vector3 | null): void {
    // The sun light may be created (or replaced) by the sky system after us.
    if (this.light === null || this.light.parent === null) {
      this.rescanCountdown -= 1;
      if (this.rescanCountdown <= 0) {
        this.rescanCountdown = 30;
        this.acquireLight(ctx);
      }
    }
    const light = this.light;
    if (light === null || !light.castShadow) return;

    const cam = ctx.camera;
    cam.getWorldDirection(_forward);

    // --- pick the point the shadow map should be centred on ---------------
    //
    // Key insight: an aircraft and the shadow it casts on the ground sit on the
    // *same light ray*, so in the shadow map's own (x, y) they occupy the same
    // footprint however high the aircraft is flying. Covering both therefore
    // costs depth range, which an orthographic projection has in abundance, and
    // no lateral extent at all. So the fit is centred on the aircraft, not on
    // some compromise point between it and the ground.
    let radius: number;
    let reachHeight: number;
    if (subject) {
      const subjectDist = cam.position.distanceTo(subject);
      reachHeight = Math.max(0, subject.y - this.groundHeight(ctx, subject.x, subject.z));
      // Two competing requirements, and the fit takes whichever is larger.
      //
      // (a) A chase camera sits 15-30 m behind the aircraft. Fitting to that
      //     alone gives a 55 m radius and a 0.054 m texel at 2048 — crisp
      //     enough that the aircraft self-shadows its own tailplane and the
      //     cast shadow reads as a wing and a fuselage rather than a blob.
      // (b) The higher the aircraft flies, the more ground is in frame and the
      //     further away its shadow lands, so a bubble that size becomes a
      //     postage stamp in the middle of two kilometres of unshadowed
      //     landscape — and the boundary where every tree shadow stops at once
      //     is more conspicuous than having no shadows at all. Scaling with
      //     height above the terrain keeps the shadowed region roughly the
      //     size of the ground the player can see.
      //
      // The height term used to stop *growing* at 320 m but never came back
      // down, and that was the wrong shape. It was written to keep the
      // shadowed patch of ground roughly the size of the ground the player can
      // see, which is a real concern on a deck pass — but it kept paying for
      // that at 1.2 km and at 2.1 km, where there is no ground detail left to
      // shadow. The cost is not abstract: at the 311 m rung a 2048 map has a
      // 0.30 m texel and normalBias (which is derived from it) is 0.26 m, so a
      // wing 2 m in chord self-shadows across six texels with a quarter-metre
      // offset — which is to say it does not self-shadow at all. Six of the ten
      // capture framings fly above a kilometre, and in all six the aircraft was
      // the only thing in frame that the shadow map could still have resolved
      // and the only thing it had stopped resolving.
      //
      // So the height term is now *windowed*: it grows while the deck is close
      // enough for its own shadows to be worth texels, and releases back to a
      // subject-tight fit once the ground is far enough below that nothing on
      // it survives a shadow map at any rung. The release is a smoothstep, not
      // a cliff, because the fit radius drives the texel size and the texel
      // size drives normalBias — snapping between them pops every shadow edge
      // in the frame. The ladder's own hysteresis does the rest.
      //
      // 260 -> 900 m is chosen off what the shadows are actually for: below
      // ~260 m a hedge, a tree and a hangar are still several pixels tall and
      // their shadows are load-bearing depth cues; by 900 m the terrain under
      // the aircraft is a texture and the only shadow anyone can read is the
      // one the aeroplane throws on itself.
      const deckClose = 1 - smoothstep01(260, 900, reachHeight);
      const groundTerm = 55 + Math.min(reachHeight, 320) * 0.75 * deckClose;
      radius = this.quantiseRadius(Math.max(subjectDist * 0.5 + 42, groundTerm));
      // Nudge the centre forward along the view so the terrain the player is
      // diving toward is covered too, but never far enough to push the
      // aircraft itself out of the box.
      _focus.copy(subject).addScaledVector(_forward, radius * 0.28);
    } else {
      // Spectator / menu camera: fit the region the camera is actually looking
      // at, biased to the ground if the view ray reaches it soon enough.
      let fitDist = 320;
      if (_forward.y < -0.02) {
        const tGround = -cam.position.y / _forward.y;
        if (tGround > 0 && tGround < 2600) fitDist = clamp(tGround, 120, 2600);
      }
      radius = this.quantiseRadius(fitDist * 0.75);
      _focus.copy(cam.position).addScaledVector(_forward, fitDist);
      reachHeight = Math.max(0, cam.position.y - this.groundHeight(ctx, _focus.x, _focus.z));
    }
    this.fitRadius = radius;

    // --- place the light --------------------------------------------------
    // Far enough back to catch casters above the receiver plane (an aircraft
    // 3 km up still has to be inside the depth range), but no further: every
    // extra metre of depth range costs shadow-map precision.
    const altitude = Math.max(cam.position.y, subject ? subject.y : 0);
    const back = clamp(altitude + 1200, 2000, 14000);

    _snapHelper.position.copy(_focus).addScaledVector(ctx.sunDir, -back);
    // Around solar noon the light direction is nearly parallel to world up, and
    // lookAt() with up = (0,1,0) degenerates: three perturbs the basis, which
    // flips the snapping lattice from frame to frame and adds a second source
    // of shadow crawl on top of the one the snap exists to remove. Pick
    // whichever cardinal axis the sun is *least* parallel to instead.
    if (Math.abs(ctx.sunDir.y) > 0.95) _snapHelper.up.set(0, 0, 1);
    else _snapHelper.up.set(0, 1, 0);
    _snapHelper.lookAt(_focus);
    _snapHelper.updateMatrixWorld(true);

    // --- snap the centre to whole shadow texels ---------------------------
    const size = this.mapSize || light.shadow.mapSize.x;
    const texel = (2 * radius) / Math.max(1, size);
    _inv.copy(_snapHelper.matrixWorld).invert();
    _p.copy(_focus).applyMatrix4(_inv);
    _p.x = Math.round(_p.x / texel) * texel;
    _p.y = Math.round(_p.y / texel) * texel;
    _p.applyMatrix4(_snapHelper.matrixWorld);

    light.position.copy(_p).addScaledVector(ctx.sunDir, -back);
    light.updateMatrixWorld(true);
    if (this.targetObj) {
      this.targetObj.position.copy(_p);
      this.targetObj.updateMatrixWorld(true);
    }

    const sc = light.shadow.camera;
    sc.left = -radius;
    sc.right = radius;
    sc.top = radius;
    sc.bottom = -radius;
    sc.near = 1;
    // THE FAR PLANE HAS TO REACH THE GROUND, NOT THE AIRCRAFT.
    //
    // The fit is centred on the caster, and the caster's shadow lies further
    // down the same light ray by (height above the ground) / sin(sun
    // elevation). That divisor is the whole problem: at the 8-12 degree sun the
    // sunset and hero framings use, an aircraft 1.2 km up throws its shadow
    // eight kilometres along the ray. The old far plane was
    // back + altitude + 2r + 2000, which for that case stopped roughly 3 km
    // short — the caster was in the map, the shadow-map lookup on the receiver
    // was outside the frustum, and 'frustumTest' handed back "lit". That is why
    // not one aircraft in the ten framings had a shadow while the rig itself
    // measured as fitting correctly.
    //
    // An orthographic depth range is linear, so even a 30 km span still
    // resolves centimetres in a 24-bit buffer — depth is nearly free here,
    // unlike in the perspective case. It is not free in *fill*, though, which
    // is why the reach is derived from the real height above the terrain rather
    // than from the absolute altitude.
    const sinElev = Math.max(0.06, Math.abs(ctx.sunDir.y));
    const shadowReach = clamp(clamp(reachHeight, 0, 12000) / sinElev, 0, 30000);
    sc.far = back + shadowReach + radius * 2 + 600;
    sc.updateProjectionMatrix();

    // Normal-offset bias scaled to the world size of one texel: the offset has
    // to cover half a texel's worth of depth slope, and the texel size changes
    // every frame as the fit adapts. Held below one texel — an aileron is 40 mm
    // thick and a 1.4-texel push along the normal walked its own shadow clean
    // off it, which is a light leak the eye reads as "the wing is not solid".
    light.shadow.normalBias = Math.max(0.03, texel * 0.85);
    // Constant bias expressed in *metres* rather than in depth-buffer units,
    // so widening the frustum does not silently turn into peter-panning.
    light.shadow.bias = -0.12 / Math.max(1, sc.far - sc.near);

    if (this.owned) {
      light.color.copy(ctx.sunColor);
      light.intensity = ctx.sunIntensity;
    }
  }

  /**
   * Height of the terrain under a world point, or 0 (sea level) if the world
   * subsystem has not published a sampler.
   *
   * Both the fit radius and the far plane want *height above the ground*, not
   * altitude: over a 2 km plateau the two differ by 2 km, which is the
   * difference between a 100 m fit and a 1.5 km one. Resolved by duck-typing so
   * this module keeps no dependency on the world subsystem, and re-probed on a
   * countdown because the world can initialise after the composer does.
   *
   * Clamped at sea level, because what this is really asking is "how far below
   * the aircraft is the surface that receives its shadow". Offshore the
   * heightfield keeps returning the *seabed* — it reads −110 m under the water
   * framing's coastline — and the receiver there is the water plane at y = 0.
   * Left unclamped the fit and the far plane were both sized for a drop 70%
   * larger than the real one, which on a low pass over the sea is a whole rung
   * of the ladder spent on nothing.
   */
  private groundHeight(ctx: GameContext, x: number, z: number): number {
    if (this.terrainAt === null) {
      if (this.samplerTick-- > 0) return 0;
      this.samplerTick = 60;
      const w = ctx.get<Subsystem & { terrainHeight?: (px: number, pz: number) => number }>('world');
      if (typeof w?.terrainHeight !== 'function') return 0;
      this.terrainAt = w.terrainHeight.bind(w);
    }
    const h = this.terrainAt(x, z);
    return Number.isFinite(h) ? Math.max(h, 0) : 0;
  }

  /**
   * Snaps the raw fit radius onto a fixed ladder.
   *
   * Texel snapping only works if the lattice it snaps to holds still. The
   * lattice spacing is 2*radius/mapSize, so a radius that varies continuously
   * with camera distance — which in a spring-damped chase camera means *every
   * frame* — re-lands the centre on a different lattice every frame and
   * reintroduces exactly the sub-texel swimming the snap was written to
   * remove. Quantising the radius to sqrt(2) steps means the texel size (and
   * with it the normal-offset bias) changes only when the fit genuinely
   * doubles in area, and the 6% hysteresis on the way back down stops the fit
   * chattering between two rungs when the camera sits on a boundary.
   */
  private quantiseRadius(raw: number): number {
    const L = RADIUS_LADDER;
    let i = this.fitIndex;
    // Grow immediately: an under-sized fit clips shadows out of the frame.
    while (i < L.length - 1 && raw > L[i]) i++;
    // Shrink only once the raw radius is clearly inside the rung below.
    while (i > 0 && raw < L[i - 1] * 0.94) i--;
    this.fitIndex = i;
    return L[i];
  }

  dispose(): void {
    if (this.light && this.owned) {
      this.light.parent?.remove(this.light);
      this.light.dispose();
    }
    this.light = null;
  }
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Hermite ramp, 0 below 'lo' and 1 above 'hi'. */
const smoothstep01 = (lo: number, hi: number, v: number): number => {
  const t = clamp((v - lo) / Math.max(1e-6, hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Allowed fit radii, sqrt(2) apart (each rung doubles the covered area). The
 * span covers a 55 m fit for a close chase camera up to a 1.8 km fit for a
 * high cinematic rig; past that the shadow is too coarse to read anyway and the
 * cel material's own ambient term carries the form.
 */
const RADIUS_LADDER = [55, 78, 110, 156, 220, 311, 440, 622, 880, 1244, 1760];

const _forward = new THREE.Vector3();
const _focus = new THREE.Vector3();
const _p = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const _snapHelper = new THREE.Object3D();
