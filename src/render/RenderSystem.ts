import * as THREE from 'three';
import type { EventBus, GameContext, QualityTier, Subsystem } from '../engine/context';
import {
  LAYER_COCKPIT, LAYER_DEFAULT, LAYER_INK, celGlobals, updateCelGlobals,
} from './CelMaterial';
import {
  disposeRT, makeRT, updateFrameInfo, type FrameInfo,
} from './passes/PassCore';
import { DepthNormalPass } from './passes/DepthNormalPass';
import { InkPass } from './passes/InkPass';
import { AoPass } from './passes/AoPass';
import { BloomPass } from './passes/BloomPass';
import { DofPass } from './passes/DofPass';
import { MotionBlurPass } from './passes/MotionBlurPass';
import { GradePass } from './passes/GradePass';
import { FxaaPass } from './passes/FxaaPass';
import { DebugViewPass, type DebugView } from './passes/DebugViewPass';
import { ShadowRig } from './passes/ShadowRig';

/**
 * The cel-shading composer.
 *
 * Frame graph (all intermediates are RGBA16F — the chain carries values above
 * 1.0 and 8-bit intermediates band visibly across the large flat areas a toon
 * ramp produces):
 *
 *   shadow fit  ─→ directional shadow map, frustum fitted + texel snapped
 *   prepass     ─→ MRT gbuffer: oct normal + linear depth + object id, velocity
 *   scene       ─→ sceneRT (sky, opaque, transparent, particles)
 *   HBAO        ─→ half-res occlusion, bilateral blurred
 *   INK + AO    ─→ the signature pass; edge detect and AO composite in one go
 *   DOF         ─→ optional, focused on the player's aircraft
 *   motion blur ─→ optional, per-object velocities
 *   bloom       ─→ threshold + 5-level down/upsample pyramid
 *   grade       ─→ tonemap, filmic S, procedural 3D LUT, vignette, CA, grain
 *   FXAA        ─→ canvas
 *
 * Pass order is not arbitrary. Ink and AO run before DOF and motion blur so
 * that lines are blurred *by* those effects (a sharp ink line on a defocused
 * wing is an instant tell). Bloom is thresholded after ink so that ink darkens
 * the source of the glow rather than being drawn over it. The grade is last
 * because everything before it is scene-referred linear light.
 */

/** Names accepted by 'setPassEnabled', for A/B in the critique harness. */
export type PassName =
  | 'shadows' | 'ssao' | 'ao' | 'ink' | 'dof' | 'motionBlur' | 'bloom'
  | 'grade' | 'lut' | 'vignette' | 'grain' | 'chromatic' | 'fxaa';

interface QualityProfile {
  ssao: boolean;
  dof: boolean;
  motionBlur: boolean;
  bloomLevels: number;
  /** Update the shadow map every N frames. */
  shadowInterval: number;
}

const PROFILES: Record<QualityTier, QualityProfile> = {
  // DOF, motion blur and SSAO are the three passes that cost the most for the
  // least at small window sizes, so 'low' drops all three and shortens the
  // bloom pyramid; the ink pass — the whole point of the renderer — never goes.
  low: { ssao: false, dof: false, motionBlur: false, bloomLevels: 3, shadowInterval: 2 },
  medium: { ssao: true, dof: false, motionBlur: true, bloomLevels: 4, shadowInterval: 1 },
  high: { ssao: true, dof: true, motionBlur: true, bloomLevels: 5, shadowInterval: 1 },
  ultra: { ssao: true, dof: true, motionBlur: true, bloomLevels: 6, shadowInterval: 1 },
};

/**
 * Layers the prepass renders. Sky domes and clouds (LAYER_SKY) must not be
 * inked or occluded, and bloom-only props like tracers (LAYER_BLOOM) are
 * additive sprites with no meaningful depth or normal.
 */
const PREPASS_LAYER_MASK =
  (1 << LAYER_DEFAULT) | (1 << LAYER_INK) | (1 << LAYER_COCKPIT);

export class RenderSystem implements Subsystem {
  readonly name = 'render';

  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;

  // --- targets -------------------------------------------------------------
  private sceneRT!: THREE.WebGLRenderTarget;
  private rtA!: THREE.WebGLRenderTarget;
  private rtB!: THREE.WebGLRenderTarget;

  // --- passes --------------------------------------------------------------
  private prepass!: DepthNormalPass;
  private ink!: InkPass;
  private ao!: AoPass;
  private bloom!: BloomPass;
  private dof!: DofPass;
  private motionBlur!: MotionBlurPass;
  private grade!: GradePass;
  private fxaa!: FxaaPass;
  private debugPass!: DebugViewPass;
  private shadowRig = new ShadowRig();

  // --- state ---------------------------------------------------------------
  private info: FrameInfo = {
    width: 1, height: 1,
    texel: new THREE.Vector2(1, 1),
    near: 0.35, far: 120000,
    projParams: new THREE.Vector2(1, 1),
    projScale: 800,
    quality: 'high', dt: 1 / 60, time: 0, frame: 0,
  };

  private viewProj = new THREE.Matrix4();
  private prevViewProj = new THREE.Matrix4();
  private invViewProj = new THREE.Matrix4();
  private reproject = new THREE.Matrix4();

  /** Canvas drawing-buffer size. */
  private bufferWidth = 1;
  private bufferHeight = 1;
  /** Internal render size (buffer size scaled by settings.renderScale). */
  private renderWidth = 1;
  private renderHeight = 1;
  private appliedRenderScale = 1;

  private currentQuality: QualityTier | null = null;
  private ready = false;
  private debugView: DebugView = 'off';
  /** Frames since the last shadow-map refresh. */
  private shadowTick = 0;
  /** True on the first frame — velocity has no history yet. */
  private firstFrame = true;
  private bus: EventBus | null = null;

  /** Camera pose last frame, for cut detection (see cameraCut). */
  private prevCamPos = new THREE.Vector3();
  private prevCamQuat = new THREE.Quaternion();
  /** Subject position last frame, for the teleport half of cut detection. */
  private prevSubject = new THREE.Vector3();
  private hasPrevSubject = false;
  /**
   * Frames left in the post-cut blackout. See cameraCut: one frame is not
   * enough, because a cut re-seats the camera springs and re-poses the subject,
   * and the frame *after* the discontinuity still reprojects through a pose
   * that no longer describes anything.
   */
  private cutHold = 0;

  /** Frames until the next attempt to opt the ocean into the prepass. */
  private optInTick = 0;
  private optInDone = false;

  /**
   * Art-directed base values that a per-frame uniform write would otherwise
   * clobber. 'tune()' is the only writer; 'lateUpdate' reads them. Before this
   * existed, seven of the documented knobs reverted one frame after being set,
   * because update()/setFeature() assigned literals over the top of them.
   */
  private tuned = {
    inkWidth: 1.0,
    inkOpacity: 0.92,
    inkAoStrength: 0.85,
    gradeContrast: 0.30,
    // --- highlight headroom ------------------------------------------------
    // The grade expands about a pivot in gamma-encoded space and then clamps,
    // so the straight-line gain decides where the frame runs out of white:
    // everything above 'pivot + (1 - pivot) / gain' is the same paper white and
    // has no value structure left in it at all.
    //
    // At the pair this shipped with (pivot 0.44, gain 1.30) the ceiling landed
    // at 0.871 gamma, i.e. scene-referred 1.41 — and a sunlit upper surface
    // under a key of ~3 clears that easily, which is how a whole airframe ends
    // up as one uniform cream with no separation between the upper wing, the
    // fuselage side and the underside.
    //
    // Raising the pivot to the value mid-grey actually lands on and taking the
    // gain back to 1.20 moves the ceiling to 0.909 gamma (scene-referred 1.70,
    // a quarter of a stop more headroom) while leaving the mid-tone the curve
    // pivots about EXACTLY where it was — a pivot is a fixed point of its own
    // gain, so nothing at mid-grey moves. Shadows lift about 4 %, which is the
    // direction the critique wanted them in anyway, and the top four per cent
    // of the range stops being a cliff.
    gradePivot: 0.455,
    gradeGain: 1.20,
  };

  /** Debug switches. Everything defaults on; quality/settings gate separately. */
  private toggles: Record<PassName, boolean> = {
    shadows: true, ssao: true, ao: true, ink: true, dof: true, motionBlur: true,
    bloom: true, grade: true, lut: true, vignette: true, grain: true,
    chromatic: true, fxaa: true,
  };

  // -------------------------------------------------------------------------

  init(ctx: GameContext): void {
    this.renderer = ctx.renderer;
    this.scene = ctx.scene;
    this.camera = ctx.camera;

    // The composer clears explicitly; three must not clear behind our back.
    this.renderer.autoClear = false;
    this.renderer.autoClearColor = true;
    this.renderer.autoClearDepth = true;
    // We drive the shadow refresh ourselves so the depth/normal prepass does
    // not re-render the shadow map a second time every frame.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.autoUpdate = false;
    // r185 deprecated PCFSoftShadowMap. PCF plus the normal-offset bias the
    // shadow rig computes per frame gives a cleaner edge than the old
    // poisson-tap "soft" filter did anyway, and it is markedly cheaper.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Tone mapping and the output transform are ours; three must stay neutral.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    const size = this.renderer.getDrawingBufferSize(_v2);
    this.bufferWidth = Math.max(1, size.x);
    this.bufferHeight = Math.max(1, size.y);
    this.computeRenderSize(ctx.settings.renderScale);

    const w = this.renderWidth;
    const h = this.renderHeight;

    this.sceneRT = makeRT(w, h, { depth: true, name: 'scene' });
    this.rtA = makeRT(w, h, { name: 'postA' });
    this.rtB = makeRT(w, h, { name: 'postB' });

    this.prepass = new DepthNormalPass(w, h);
    this.ink = new InkPass();
    this.ao = new AoPass(w, h);
    this.bloom = new BloomPass(w, h);
    this.dof = new DofPass(w, h);
    this.motionBlur = new MotionBlurPass(w, h);
    this.grade = new GradePass();
    this.fxaa = new FxaaPass();
    this.debugPass = new DebugViewPass();
    this.fxaa.setSize(w, h);

    // The threshold is where "bloom" stops being a highlight effect and becomes
    // a full-frame veil, and it has to be read together with the knee: the
    // prefilter starts contributing at threshold * (1 - knee), not at
    // threshold. At 1.05 / 0.6 that floor was 0.42 scene-linear — and the
    // measured sky in these framings sits at 0.48-0.81 mean (1.3-1.9 peak) with
    // the sunlit terrain right behind it. In other words the *entire frame* was
    // feeding the pyramid, and a six-level pyramid whose levels are each added
    // back at full weight turns that into a low-frequency wash roughly six
    // times the local average of the thresholded image.
    //
    // Added over the darkest thing in the picture — the subject — that wash is
    // not subtle. Measured over the player's airframe it was 19 % of the
    // aircraft's own mean value in 'water' and over 100 % on its shadowed
    // panels, and because it is a *blur of the background* it carries the
    // background's colour and its low-frequency structure with it. That is
    // precisely the "you can see the fields through the wing / it reads as a
    // glass toy" failure: rendering the aircraft alone against a flat magenta
    // clear colour tinted the whole airframe magenta with bloom on and produced
    // a clean opaque silhouette with it off.
    //
    // 1.6 / 0.35 puts the floor at 1.04 linear, above every ordinary sky and
    // terrain value measured across the framings (0.48-0.81 mean, 1.3 peak) and
    // below the things that are *meant* to glow — the sun disc, sea specular
    // glitter (2.9), tracers and muzzle flash (5.3). Measured on the same
    // frames, that takes the veil sitting on the player's airframe from 0.122
    // to 0.001 scene-linear while keeping 68 % of the peak bloom value, so the
    // sun and the glitter path still bloom hard and the subject stops being
    // painted with the background. Pushing further (2.0 / 0.30) does take the
    // veil to zero, but it also drops the peak to a third and puts out the sun.
    // Tunable at runtime through setBloom().
    this.bloom.setThreshold(1.6, 0.35);

    this.shadowRig.init(ctx);
    this.applyQuality(ctx, true);

    ctx.bus.on('quality', () => { this.currentQuality = null; });

    this.ready = true;
    this.bus = ctx.bus;
    this.publishDepth();
  }

  /**
   * Hands the prepass depth buffer to anyone who wants it.
   *
   * SkySystem listens for this and otherwise re-renders the entire scene
   * depth-only every frame the volumetric clouds are on (which is the default),
   * so publishing it deletes a whole geometry submission per frame. The
   * DepthTexture object survives setSize, but the event is re-emitted after
   * every reallocate so a listener that cached a size alongside it can react.
   */
  private publishDepth(): void {
    if (!this.ready || !this.bus) return;
    this.bus.emit('render:depth', {
      texture: this.prepass.depthTexture,
      width: this.renderWidth,
      height: this.renderHeight,
    });
  }

  // -------------------------------------------------------------------------
  // Sizing
  // -------------------------------------------------------------------------

  /**
   * Recomputes the internal render resolution from the canvas drawing buffer
   * and 'settings.renderScale'. The final blit stretches back to the canvas, so
   * a scale below 1 costs resolution but keeps the UI and the ink line weight
   * relative to the frame rather than to the buffer.
   */
  private computeRenderSize(scale: number): void {
    const s = clamp(scale || 1, 0.5, 1);
    this.appliedRenderScale = s;
    this.renderWidth = Math.max(1, Math.round(this.bufferWidth * s));
    this.renderHeight = Math.max(1, Math.round(this.bufferHeight * s));
  }

  resize(width: number, height: number): void {
    if (!this.ready) return;
    // 'width'/'height' are CSS pixels; the render targets live in device
    // pixels, so go through the renderer rather than trusting the arguments.
    void width; void height;
    const size = this.renderer.getDrawingBufferSize(_v2);
    this.bufferWidth = Math.max(1, size.x);
    this.bufferHeight = Math.max(1, size.y);
    this.computeRenderSize(this.appliedRenderScale);
    this.reallocate();
  }

  private reallocate(): void {
    const w = this.renderWidth;
    const h = this.renderHeight;
    this.sceneRT.setSize(w, h);
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
    this.prepass.setSize(w, h);
    this.ao.setSize(w, h);
    this.bloom.setSize(w, h);
    this.dof.setSize(w, h);
    this.motionBlur.setSize(w, h);
    this.fxaa.setSize(w, h);
    this.publishDepth();
  }

  // -------------------------------------------------------------------------
  // Quality
  // -------------------------------------------------------------------------

  private applyQuality(ctx: GameContext, force = false): void {
    if (!force && ctx.quality === this.currentQuality) return;
    this.currentQuality = ctx.quality;
    const p = PROFILES[ctx.quality];

    this.ink.setQuality(ctx.quality);
    this.ao.setQuality(ctx.quality);
    this.dof.setQuality(ctx.quality);
    this.motionBlur.setQuality(ctx.quality);
    this.bloom.setLevels(p.bloomLevels);
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  lateUpdate(ctx: GameContext): void {
    if (!this.ready) return;
    const renderer = this.renderer;
    const camera = this.camera;
    const scene = this.scene;
    const settings = ctx.settings;
    const profile = PROFILES[ctx.quality];

    this.applyQuality(ctx);

    // Settings can change the internal resolution at runtime (options menu,
    // performance governor), and the drawing buffer can change without a
    // resize event ever reaching us (device pixel ratio changes when a window
    // is dragged between monitors). Both are one comparison per frame, which
    // is cheaper than being wrong about the size of every render target.
    const dbs = renderer.getDrawingBufferSize(_v2);
    const scaleChanged = clamp(settings.renderScale || 1, 0.5, 1) !== this.appliedRenderScale;
    if (scaleChanged || dbs.x !== this.bufferWidth || dbs.y !== this.bufferHeight) {
      this.bufferWidth = Math.max(1, dbs.x);
      this.bufferHeight = Math.max(1, dbs.y);
      this.computeRenderSize(settings.renderScale);
      this.reallocate();
    }

    // --- global shader state ---------------------------------------------
    updateCelGlobals(ctx);
    // updateCelGlobals reads the *canvas* size; screen-space effects inside the
    // cel material (hatching, outline width) must use the internal resolution
    // or they change weight whenever renderScale does.
    celGlobals.uResolution.value.set(this.renderWidth, this.renderHeight);

    // --- camera matrices ---------------------------------------------------
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (this.firstFrame) this.prevViewProj.copy(this.viewProj);

    updateFrameInfo(this.info, camera, this.renderWidth, this.renderHeight);
    this.info.quality = ctx.quality;
    this.info.dt = ctx.dt;
    this.info.time = ctx.time;
    this.info.frame = ctx.frame;

    // --- camera cuts -------------------------------------------------------
    // The framing system hard-cuts between ten cinematic rigs. Across a cut the
    // previous view-projection describes a completely unrelated viewpoint, so
    // both the sky reprojection branch of the motion blur and every object's
    // velocity vector come out at maximum length: one frame of full-strength
    // smear on the first frame of every new shot. Detect the discontinuity and
    // sit the pass out for that frame, exactly as the first frame does.
    const subject = this.subjectPosition(ctx);
    const cut = this.cameraCut(camera, subject, ctx.dt);

    // --- which passes actually run this frame -----------------------------
    const shadowsOn = settings.shadows && this.toggles.shadows;
    const ssaoOn = settings.ssao && profile.ssao && this.toggles.ssao && this.toggles.ao;
    const inkOn = this.toggles.ink;
    // Cockpit and gunsight put the camera 1-3 m from the instrument panel, so a
    // subject-locked focus makes the entire world a background pixel. There is
    // no useful depth of field to be had from that framing; the pass is off.
    const closeUp = this.isCloseUpView(ctx);
    const dofOn = settings.dof && profile.dof && this.toggles.dof && !closeUp;
    // 'available' and 'on' are separate: the velocity history the pass compares
    // against has to be latched on the frames the blur itself sits out, or the
    // frame after a cut compares against a field two frames old — which for a
    // one-frame oscillation is exactly the wrong parity.
    const mbAvailable = settings.motionBlur && profile.motionBlur && this.toggles.motionBlur;
    const mbOn = mbAvailable && !this.firstFrame && !cut;
    if (cut) this.motionBlur.reset();
    const bloomAmount = this.toggles.bloom ? settings.bloom : 0;
    const bloomOn = bloomAmount > 0.001;
    const fxaaOn = this.toggles.fxaa;

    // --- prepass opt-ins ---------------------------------------------------
    this.applyPrepassOptIns(ctx);

    // --- shadows -----------------------------------------------------------
    this.shadowRig.setEnabled(shadowsOn);
    this.shadowRig.setQuality(ctx.quality, shadowsOn, settings.shadowMapSize);
    this.shadowRig.update(ctx, subject);

    // --- depth / normal / velocity prepass --------------------------------
    // Runs with shadowMap.needsUpdate false so the shadow map is not rebuilt
    // for this extra geometry pass.
    renderer.shadowMap.needsUpdate = false;
    this.prepass.render(renderer, scene, camera, this.prevViewProj, PREPASS_LAYER_MASK);

    // --- main scene --------------------------------------------------------
    this.shadowTick++;
    if (shadowsOn && this.shadowTick >= profile.shadowInterval) {
      this.shadowTick = 0;
      renderer.shadowMap.needsUpdate = true;
    }
    renderer.setRenderTarget(this.sceneRT);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);

    // --- debug buffer inspection ------------------------------------------
    if (this.debugView !== 'off') {
      this.renderDebug(renderer, ssaoOn, bloomOn);
      // The velocity history is not latched down this path, so the first frame
      // back from a buffer view would compare against a field an arbitrary
      // number of frames old. Drop it rather than trust it.
      this.motionBlur.reset();
      this.endFrame();
      return;
    }

    // --- ambient occlusion -------------------------------------------------
    if (ssaoOn) this.ao.render(renderer, this.prepass.gbuffer, this.info);

    // --- ink (+ AO composite) ---------------------------------------------
    let cur: THREE.WebGLRenderTarget = this.sceneRT;
    if (inkOn || ssaoOn) {
      this.ink.update(
        this.info, settings.outlineWidth * this.tuned.inkWidth, ssaoOn, this.tuned.inkAoStrength,
      );
      // With ink toggled off the pass still runs to composite AO; zero opacity
      // makes it a pure AO combine so the A/B stays honest.
      this.ink.material.uniforms.uOpacity.value = inkOn ? this.tuned.inkOpacity : 0.0;
      const dst = this.next(cur);
      this.ink.render(
        renderer, cur.texture, this.prepass.gbuffer,
        ssaoOn ? this.ao.texture : null, dst,
      );
      cur = dst;
    }

    // --- depth of field ----------------------------------------------------
    if (dofOn) {
      // A cut is a new shot, and a camera operator does not rack focus across
      // one — the next frame is already sharp on its new subject. Without this
      // the 4.5 Hz damping racks in from the old shot's distance for about half
      // a second, which is long enough for a capture to land inside it.
      if (cut) this.dof.snapFocus();
      this.dof.setFocusTarget(this.focusDistance(ctx, subject), ctx.dt);
      const dst = this.next(cur);
      this.dof.render(renderer, cur.texture, this.prepass.gbuffer, dst, this.info, DOF_STRENGTH);
      cur = dst;
    }

    // --- motion blur -------------------------------------------------------
    if (mbOn) {
      this.invViewProj.copy(this.viewProj).invert();
      this.reproject.multiplyMatrices(this.prevViewProj, this.invViewProj);
      const dst = this.next(cur);
      this.motionBlur.render(
        renderer, cur.texture, this.prepass.velocity, this.prepass.gbuffer,
        this.reproject, dst, MOTION_SHUTTER, this.renderWidth, this.renderHeight,
      );
      cur = dst;
    }
    if (mbAvailable) this.motionBlur.captureHistory(renderer, this.prepass.velocity);

    // --- bloom -------------------------------------------------------------
    if (bloomOn) this.bloom.render(renderer, cur.texture);

    // --- grade -------------------------------------------------------------
    const gradeOn = this.toggles.grade;
    this.grade.setFeature('lut', gradeOn && this.toggles.lut);
    this.grade.setFeature('vignette', gradeOn && this.toggles.vignette);
    this.grade.setFeature('grain', gradeOn && this.toggles.grain);
    this.grade.setFeature('chromatic', gradeOn && this.toggles.chromatic);
    this.grade.material.uniforms.uContrast.value = gradeOn ? this.tuned.gradeContrast : 0.0;
    this.grade.material.uniforms.uGain.value = gradeOn ? this.tuned.gradeGain : 1.0;
    this.grade.material.uniforms.uPivot.value = this.tuned.gradePivot;
    this.grade.update(this.info, celGlobals.uExposure.value, bloomAmount);

    if (fxaaOn) {
      const dst = this.next(cur);
      this.grade.render(renderer, cur.texture, bloomOn ? this.bloom.texture : null, dst);
      this.fxaa.render(renderer, dst.texture, null);
    } else {
      this.grade.render(renderer, cur.texture, bloomOn ? this.bloom.texture : null, null);
    }

    this.endFrame();
  }

  private endFrame(): void {
    this.prevViewProj.copy(this.viewProj);
    this.firstFrame = false;
    this.renderer.setRenderTarget(null);
  }

  /** Ping-pong helper: whichever full-res post target is not 'cur'. */
  private next(cur: THREE.WebGLRenderTarget): THREE.WebGLRenderTarget {
    return cur === this.rtA ? this.rtB : this.rtA;
  }

  private renderDebug(renderer: THREE.WebGLRenderer, ssaoOn: boolean, bloomOn: boolean): void {
    const v = this.debugView;
    if (v === 'off') return;
    let src: THREE.Texture;
    switch (v) {
      case 'velocity': src = this.prepass.velocity; break;
      case 'ao':
        if (!ssaoOn) this.ao.render(renderer, this.prepass.gbuffer, this.info);
        src = this.ao.texture;
        break;
      case 'bloom':
        if (!bloomOn) this.bloom.render(renderer, this.sceneRT.texture);
        src = this.bloom.texture;
        break;
      default: src = this.prepass.gbuffer; break;
    }
    this.debugPass.render(renderer, v, src, this.info.far, null);
  }

  // -------------------------------------------------------------------------
  // Focus / subject helpers
  // -------------------------------------------------------------------------

  /**
   * True while a shot is still discontinuous with the frame before it.
   *
   * A cut is a translation no aircraft could have flown in one frame, or a
   * rotation no gimbal could have swung. The thresholds are deliberately
   * generous — 300 m/s is faster than any dive in the game and 12 rad/s is
   * three times the fastest snap roll — so ordinary flying never trips them.
   *
   * Two things this used to miss.
   *
   * First, the SUBJECT can be teleported without the camera moving far.
   * 'CameraSystem.debugFraming' re-poses the player's aircraft on the far side
   * of the map before it re-seats the rig, and the ten capture framings do that
   * ten times a run. The aircraft's own previous model matrix is then a
   * kilometre away, so its velocity vector is the full width of the screen and
   * it is the *subject* that smears, not the background — the camera-only test
   * saw nothing wrong. Watching the subject as well closes that.
   *
   * Second, one frame of blackout is not enough. A cut re-seats every spring in
   * the rig, so the frame after the discontinuity is still reprojecting through
   * a pose that describes nothing. The hold is three frames, which at 60 fps is
   * 50 ms — far below the threshold at which a viewer could notice the blur is
   * missing, and long enough that a capture cannot land inside the smear.
   */
  private cameraCut(
    camera: THREE.PerspectiveCamera,
    subject: THREE.Vector3 | null,
    dt: number,
  ): boolean {
    const step = Math.max(dt, 1 / 240);
    const moved = camera.position.distanceTo(this.prevCamPos);
    const turned = 2 * Math.acos(
      Math.min(1, Math.abs(camera.quaternion.dot(this.prevCamQuat))),
    );
    let jumped = false;
    if (subject) {
      jumped = this.hasPrevSubject && subject.distanceTo(this.prevSubject) > 300 * step;
      this.prevSubject.copy(subject);
      this.hasPrevSubject = true;
    } else {
      this.hasPrevSubject = false;
    }
    const discontinuity = !this.firstFrame
      && (moved > 300 * step || turned > 12 * step || jumped);
    this.prevCamPos.copy(camera.position);
    this.prevCamQuat.copy(camera.quaternion);
    if (discontinuity) this.cutHold = CUT_HOLD_FRAMES;
    else if (this.cutHold > 0) this.cutHold--;
    return discontinuity || this.cutHold > 0;
  }

  /** Cockpit-class framings, where the subject is centimetres from the lens. */
  private isCloseUpView(ctx: GameContext): boolean {
    const cam = ctx.get<Subsystem & { mode?: string }>('camera');
    const mode = cam?.mode;
    return mode === 'cockpit' || mode === 'gunsight';
  }

  /**
   * Opts surfaces into the prepass that cannot declare it for themselves yet.
   *
   * The ocean is drawn with 'transparent: true' (it blends its own shoreline
   * and glitter) but it is an opaque *surface*: leaving it out of the gbuffer
   * gives the whole sea far-plane depth — no coastline ink, no AO, sky-branch
   * motion blur and, before the DOF rework, maximum background defocus over
   * every water pixel. Water.ts now publishes a 'userData.prepassMaterial',
   * which the pass honours directly; this is the fallback for the case where it
   * does not, and opts the surface in with its own vertex program instead.
   * Runs at most once every 30 frames and stops as soon as it resolves.
   */
  private applyPrepassOptIns(ctx: GameContext): void {
    if (this.optInDone) return;
    if (this.optInTick-- > 0) return;
    this.optInTick = 30;
    const ocean = ctx.scene.getObjectByName('ocean');
    if (!ocean) return;
    if (ocean.userData.prepassMaterial === undefined) ocean.userData.forcePrepass = true;
    this.optInDone = true;
  }

  /** World position of the player's aircraft, or null when spectating. */
  private subjectPosition(ctx: GameContext): THREE.Vector3 | null {
    const e = ctx.localEntityId !== 0 ? ctx.entities.get(ctx.localEntityId) : undefined;
    if (!e) return null;
    return _subject.set(e.px, e.py, e.pz);
  }

  /**
   * Focus distance for the DOF pass, in metres.
   *
   * The player's own aircraft is the subject in every chase camera, which is
   * what makes the effect read as a camera operator following an aeroplane
   * rather than as a blur filter.
   *
   * This is only ever asked for when the DOF pass runs at all, and it does not
   * run in cockpit or gunsight (see isCloseUpView) — there the aircraft origin
   * is 1-3 m away and locking focus to it would make a background pixel of the
   * entire world.
   */
  private focusDistance(ctx: GameContext, subject: THREE.Vector3 | null): number {
    void ctx;
    if (subject) return Math.max(2, this.camera.position.distanceTo(subject));
    // No player aircraft to lock onto — hand focus to the pass's own GPU
    // autofocus, which measures the nearest surface under the reticle. A
    // guessed number here (say, where the view ray meets the ground) would put
    // the whole frame out of focus whenever the camera is not looking down.
    return -1;
  }

  // -------------------------------------------------------------------------
  // Debug API
  // -------------------------------------------------------------------------

  /**
   * Enables or disables a single pass. Used by the visual-critique harness to
   * A/B individual effects.
   *
   * Note that 'grade' off does not mean "no output transform" — tone mapping
   * and the sRGB encode always run, or the frame would be unviewable. It
   * disables the creative half: LUT, contrast S-curve, vignette, grain and
   * chromatic aberration.
   *
   * @returns false if the name is not a known pass.
   */
  setPassEnabled(name: string, enabled: boolean): boolean {
    if (!(name in this.toggles)) {
      console.warn(`[render] unknown pass "${name}"; known: ${this.listPasses().join(', ')}`);
      return false;
    }
    this.toggles[name as PassName] = enabled;
    if (name === 'ssao' || name === 'ao') {
      this.toggles.ssao = enabled;
      this.toggles.ao = enabled;
    }
    return true;
  }

  getPassEnabled(name: string): boolean {
    return this.toggles[name as PassName] ?? false;
  }

  listPasses(): PassName[] {
    return Object.keys(this.toggles) as PassName[];
  }

  /** Routes the frame through a buffer visualiser instead of the grade. */
  setDebugView(view: DebugView): void {
    this.debugView = view;
  }

  getDebugView(): DebugView { return this.debugView; }

  // -------------------------------------------------------------------------
  // Buffers other subsystems may read
  // -------------------------------------------------------------------------

  /**
   * Hardware device depth of the current frame's opaque geometry.
   *
   * Forward-rendered effects drawn inside the main scene pass (soft particles,
   * decals, water) can sample this to fade against geometry — it is written by
   * the prepass, so it is complete before the scene pass starts. Non-linear
   * depth: use three's 'perspectiveDepthToViewZ( d, camera.near, camera.far )'.
   * Null before init.
   */
  get depthTexture(): THREE.DepthTexture | null {
    return this.ready ? this.prepass.depthTexture : null;
  }

  /**
   * Packed gbuffer: rg = octahedral view normal, b = view distance / far,
   * a = object id. Handy for anything that wants linear depth without a divide.
   */
  get gbufferTexture(): THREE.Texture | null {
    return this.ready ? this.prepass.gbuffer : null;
  }

  /** Screen-space motion vectors in UV units (this frame minus last). */
  get velocityTexture(): THREE.Texture | null {
    return this.ready ? this.prepass.velocity : null;
  }

  /** Internal render resolution, which may differ from the canvas size. */
  getRenderSize(target: THREE.Vector2): THREE.Vector2 {
    return target.set(this.renderWidth, this.renderHeight);
  }

  // -------------------------------------------------------------------------
  // Art-direction tuning
  // -------------------------------------------------------------------------

  /**
   * Live tuning hook for the two passes an art director actually iterates on.
   * Every knob is a scalar uniform, so this can be driven from the console or
   * from a settings panel without touching shader source.
   *
   *   ink:   opacity, width, depthSens, normalSens, normalWeight, idWeight,
   *          darken, saturate, tintAmount, fadeStart, fadeEnd,
   *          interiorFadeStart, interiorFadeEnd, aoStrength
   *   grade: exposure, contrast, shoulder, bloom, vignetteDark, vignetteDesat,
   *          chromatic, grain, lutAmount
   *
   * @returns false if the knob is unknown.
   */
  tune(pass: 'ink' | 'grade' | 'cel', param: string, value: number): boolean {
    if (pass === 'cel') {
      switch (param) {
        // Key-to-fill ratio. 'ambient' is the art-directed hemispheric fill,
        // 'fillKeep' is how much of three's own hemisphere light survives.
        // Together they set how deep a cast shadow lands; see the ambient
        // block in CelMaterial.
        case 'ambient': celGlobals.uAmbient.value = value; return true;
        case 'fillKeep': celGlobals.uFillKeep.value = value; return true;
        case 'keyLevel': celGlobals.uKeyLevel.value = value; return true;
        case 'aerialStrength': celGlobals.uAerialStrength.value = value; return true;
        default: break;
      }
      console.warn(`[render] unknown cel parameter "${param}"`);
      return false;
    }
    if (pass === 'ink') {
      const u = this.ink.material.uniforms;
      switch (param) {
        // 'opacity', 'width' and 'aoStrength' are re-derived every frame from
        // settings, so tuning them means moving the base the frame code reads,
        // not the uniform it writes. 'width' is a multiplier on
        // settings.outlineWidth; the others are absolute.
        case 'opacity': this.tuned.inkOpacity = value; u.uOpacity.value = value; return true;
        case 'width': this.tuned.inkWidth = value; return true;
        case 'heroWidth': u.uHeroWidth.value = value; return true;
        case 'depthSens': u.uDepthSens.value = value; return true;
        case 'normalSens': u.uNormalSens.value = value; return true;
        case 'normalWeight': u.uNormalWeight.value = value; return true;
        case 'idWeight': u.uIdWeight.value = value; return true;
        case 'darken': u.uDarken.value = value; return true;
        case 'saturate': u.uSaturate.value = value; return true;
        case 'tintAmount': u.uTintAmount.value = value; return true;
        case 'aoStrength': this.tuned.inkAoStrength = value; u.uAOStrength.value = value; return true;
        case 'fadeStart': (u.uFade.value as THREE.Vector2).x = value; return true;
        case 'fadeEnd': (u.uFade.value as THREE.Vector2).y = value; return true;
        case 'interiorFadeStart': (u.uFadeInterior.value as THREE.Vector2).x = value; return true;
        case 'interiorFadeEnd': (u.uFadeInterior.value as THREE.Vector2).y = value; return true;
        default: break;
      }
    } else {
      const u = this.grade.material.uniforms;
      switch (param) {
        case 'exposure': celGlobals.uExposure.value = value; return true;
        case 'contrast': this.tuned.gradeContrast = value; u.uContrast.value = value; return true;
        case 'shoulder': u.uShoulder.value = value; return true;
        case 'pivot': this.tuned.gradePivot = value; u.uPivot.value = value; return true;
        case 'gain': this.tuned.gradeGain = value; u.uGain.value = value; return true;
        case 'vignetteDark': u.uVignetteDark.value = value; return true;
        case 'vignetteDesat': u.uVignetteDesat.value = value; return true;
        // These four are (enabled ? base : 0) inside the pass, so the tuned
        // value has to go to the base or the next toggle sweep erases it.
        case 'chromatic': this.grade.setFeatureAmount('chromatic', value); return true;
        case 'grain': this.grade.setFeatureAmount('grain', value); return true;
        case 'lutAmount': this.grade.setFeatureAmount('lut', value); return true;
        case 'vignetteAmount': this.grade.setFeatureAmount('vignette', value); return true;
        default: break;
      }
    }
    console.warn(`[render] unknown ${pass} parameter "${param}"`);
    return false;
  }

  /** Bloom threshold and knee. Intensity comes from 'settings.bloom'. */
  setBloom(threshold: number, knee = 0.6): void {
    this.bloom.setThreshold(threshold, knee);
  }

  /** Snapshot of the composer state, for HUD overlays and the harness. */
  getStats(): {
    width: number; height: number; scale: number; quality: QualityTier | null;
    focus: number; shadowRadius: number;
  } {
    return {
      width: this.renderWidth,
      height: this.renderHeight,
      scale: this.appliedRenderScale,
      quality: this.currentQuality,
      focus: this.dof.focusDistance,
      shadowRadius: this.shadowRig.fitRadius,
    };
  }

  // -------------------------------------------------------------------------

  dispose(): void {
    if (!this.ready) return;
    this.ready = false;
    disposeRT(this.sceneRT);
    disposeRT(this.rtA);
    disposeRT(this.rtB);
    this.prepass.dispose();
    this.ink.dispose();
    this.ao.dispose();
    this.bloom.dispose();
    this.dof.dispose();
    this.motionBlur.dispose();
    this.grade.dispose();
    this.fxaa.dispose();
    this.debugPass.dispose();
    this.shadowRig.dispose();
  }
}

/**
 * Aperture-equivalent, i.e. the peak background circle of confusion.
 *
 * Together with the hyperfocal falloff in DofPass this is what keeps the world
 * sharp: 0.13 peaks at roughly a third of the blurred image (the composite caps
 * background blend at uFarCap) a little way behind the subject, and is back to
 * zero by the hyperfocal distance. At the original 0.42 with no falloff and no
 * cap, everything past ~60 m — terrain, sea, cloud, horizon, the entire
 * environment the frame exists to show off — took 87 % of a 13 px blur, which
 * is why every chase shot read as a tilt-shift model. Near-field defocus is
 * unaffected: a foreground object's CoC is negative and unbounded.
 */
const DOF_STRENGTH = 0.13;

/**
 * Shutter angle as a fraction of the frame interval. 0.45 is a ~160-degree
 * shutter, which is what a film camera shooting action actually runs; the 0.55
 * this started at plus the old length cap turned every hard roll into a smear
 * with no readable silhouette left in it.
 */
const MOTION_SHUTTER = 0.45;

/** Frames the motion blur sits out after a cut. See cameraCut. */
const CUT_HOLD_FRAMES = 3;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

const _v2 = new THREE.Vector2();
const _subject = new THREE.Vector3();
const _dir = new THREE.Vector3();
