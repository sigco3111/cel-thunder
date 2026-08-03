import * as THREE from 'three';
import type { GameContext, Subsystem } from './context';
import type { InputSystem } from './InputSystem';
import { EventKind, InputBits } from '../shared/protocol';
import {
  AircraftViewTracker, discoverTerrainSampler, hasTerrainSampler, placeSubjectForShot,
  terrainHeightAt, type AircraftView,
} from './input/aircraftView';
import {
  CHASE, COCKPIT, GUNSIGHT, ORBIT, FLYBY, KILLCAM,
  CYCLE_MODES, MODE_LABELS, newScreenEffects,
  type CameraMode, type ScreenEffects,
} from './camera/modes';
import { SpringVec3, SpringScalar, SpringAngle, dampScalar, dampQuat } from './camera/springs';
import { CameraShake, HandheldDrift } from './camera/shake';
import {
  FRAMINGS, composeFraming, newComposedShot,
  type FramingName, type FramingSpec, type ComposedShot, type WeatherDirective,
} from './camera/framings';

/**
 * Camera rigs and screen effects.
 *
 * Six rigs share one pipeline: each writes a desired position, orientation and
 * field of view into 'want*', and a single commit stage applies shake, terrain
 * avoidance and the projection update. That means shake, g-effects and the
 * screenshot framings work identically in every mode instead of having to be
 * re-implemented per rig.
 *
 * The chase rig is where most of the effort went, because it is where 90 % of
 * the play time is spent:
 *
 *  - The boom trails the *flight path*, not the nose, so during a hard turn the
 *    aircraft leans across the frame instead of sitting nailed to the centre.
 *  - The look point is lifted above the aircraft, which is what pushes the
 *    subject down toward the lower third — the same trick every third-person
 *    game uses and the reason a centred chase camera looks amateur.
 *  - The camera leads into the turn by an amount proportional to the yaw rate,
 *    so you see where you are going rather than where you have been.
 *  - Position and look point are on separate critically-damped springs at
 *    different frequencies (the look point is stiffer), which reads as a
 *    cameraman who tracks smartly but moves the tripod smoothly.
 *  - The boom is lifted and, if that is not enough, shortened when terrain
 *    would come between the camera and the aircraft. Pulling in beats clipping
 *    through a hill, and beats a camera that suddenly finds itself underground.
 *  - Field of view widens with airspeed. It is a lie — the lens does not change
 *    — but it is the single most effective speed cue available and every racing
 *    and flight game uses it.
 */

export type { CameraMode };

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

// Module-level scratch — never allocate in the rig path.
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _boom = new THREE.Vector3();
const _look = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _omegaWorld = new THREE.Vector3();
/** Cockpit anchor scratch: world eye point and the drawn model's orientation. */
const _eyeWorld = new THREE.Vector3();
const _bodyQuat = new THREE.Quaternion();
/** Orbit centre, kept separate from the station scratch so it cannot alias it. */
const _centre = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _relOut = new THREE.Vector3();
const _relOut2 = new THREE.Vector3();

/** Rotation that turns aircraft body axes into camera axes (camera looks down −Z). */
const BODY_TO_CAM = new THREE.Quaternion().setFromAxisAngle(AXIS_Y, Math.PI);

export class CameraSystem implements Subsystem {
  readonly name = 'camera';

  mode: CameraMode = 'chase';
  /** Mode to return to when a temporary rig (kill-cam, scripted) finishes. */
  private returnMode: CameraMode = 'chase';

  readonly effects: ScreenEffects = newScreenEffects();

  /** Set false to stop the kill-cam hijacking the view when you score a kill. */
  killcamOnKill = true;
  killcamOnDeath = true;

  // --- rig state -----------------------------------------------------------
  private posSpring = new SpringVec3();
  private lookSpring = new SpringVec3();
  private rollSpring = new SpringAngle();
  private fovSpring = new SpringScalar(62);
  private headSpring = new SpringVec3();
  private shake = new CameraShake();
  private drift = new HandheldDrift();

  private lookYaw = new SpringScalar(0);
  private lookPitch = new SpringScalar(0);
  private lookYawTarget = 0;
  private lookPitchTarget = 0;

  private orbitAz = 0.6;
  private orbitEl = 0.32;
  private orbitDist = 30;

  private flybyStation = new THREE.Vector3();
  private flybyLook = new SpringVec3();
  private flybyTimer = 0;
  private flybyValid = false;
  private flybyPhase = 0;

  private killcamId = 0;
  private killcamTimer = 0;
  private readonly killcamPos = new THREE.Vector3();
  private readonly killcamVel = new THREE.Vector3();
  private killcamAz = 0;

  private framing: FramingSpec | null = null;
  private framingName: FramingName | null = null;
  private shot: ComposedShot = newComposedShot();
  private readonly anchorPos = new THREE.Vector3();
  private readonly anchorFwd = new THREE.Vector3(0, 0, 1);
  private anchorScale = 1;
  /** 'showHud' as it was before the first framing took it over; null = untouched. */
  private hudBeforeFraming: boolean | null = null;

  // --- outputs -------------------------------------------------------------
  private readonly wantPos = new THREE.Vector3();
  private readonly wantQuat = new THREE.Quaternion();
  /** Filtered orientation, kept clean of shake so the filter cannot integrate it. */
  private readonly smoothQuat = new THREE.Quaternion();
  private wantFov = 62;
  private wantNear = 0.35;
  private snapNext = true;
  /** True for the single frame the rigs must place themselves without easing. */
  private snapping = true;

  private aspect = 16 / 9;
  private ctx!: GameContext;
  private input?: InputSystem;
  private ownTracker = new AircraftViewTracker();
  private unsubs: Array<() => void> = [];
  private firing = 0;
  private eyeCache = new Map<number, THREE.Vector3>();
  private eyeProbeAt = -99;
  private cockpitRig: CockpitRig | null = null;
  private cockpitRigFor = -1;
  private terrainProbeAt = -99;
  private hadView = false;

  // -------------------------------------------------------------------------

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.input = ctx.get<InputSystem>('input');
    this.aspect = ctx.camera.aspect;
    this.fovSpring.set(ctx.settings.fov);
    this.wantFov = ctx.settings.fov;
    discoverTerrainSampler(ctx);

    this.unsubs.push(
      ctx.bus.on('input:cameraCycle', () => this.cycle()),
      ctx.bus.on('camera:setMode', (m: unknown) => {
        if (typeof m === 'string' && (CYCLE_MODES as string[]).includes(m)) this.setMode(m as CameraMode);
      }),
      ctx.bus.on('game:event', (e: unknown) => this.onGameEvent(e as GameEventPayload)),
      ctx.bus.on('net:spawned', () => {
        this.exitScripted();
        this.setMode('chase');
        this.snapNext = true;
        // The model is rebuilt on respawn, so any cached node is a dangling
        // reference into a pooled rig.
        this.cockpitRig = null;
        this.cockpitRigFor = -1;
        this.eyeCache.clear();
      }),
      ctx.bus.on('quality', () => { /* effect budget is read live from ctx.quality */ }),
    );

    // Expose the framing hook for the screenshot harness even if it reaches for
    // the system before the registry lookup is wired.
    (globalThis as unknown as Record<string, unknown>)['__cameraSystem'] = this;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
  }

  resize(width: number, height: number): void {
    this.aspect = width / Math.max(1, height);
  }

  // -------------------------------------------------------------------------
  // Spring helpers
  // -------------------------------------------------------------------------
  //
  // A "snap" has to happen where the rig computes its target, not in the commit
  // stage: by then the spring has already been stepped from its old value and
  // setting it to that stepped value snaps nothing. These wrappers put the snap
  // exactly where it belongs and keep every rig honest about it.

  private stepPos(target: THREE.Vector3, dt: number, freq: number, damping: number): THREE.Vector3 {
    if (this.snapping) this.posSpring.set(target);
    return this.posSpring.step(target, dt, freq, damping);
  }

  private stepLook(target: THREE.Vector3, dt: number, freq: number, damping: number): THREE.Vector3 {
    if (this.snapping) this.lookSpring.set(target);
    return this.lookSpring.step(target, dt, freq, damping);
  }

  /**
   * Springs an *offset* from a moving base and returns the resulting world
   * point.
   *
   * This is the difference between a chase camera that works and one that
   * doesn't. A spring tracking a world position that is moving at constant
   * velocity settles at a constant lag of 2ζv/ω behind it — at 126 m/s and
   * 2.35 Hz that is seventeen metres, so the boom silently grows by 80 % the
   * moment the aircraft is fast, and the whole sense of speed inverts (fast
   * feels far away and small). Springing the offset instead means steady flight
   * produces *zero* spring error, and only genuine changes in the framing —
   * attitude, terrain avoidance, the turn lead — get smoothed.
   */
  private stepPosRel(base: THREE.Vector3, target: THREE.Vector3, dt: number, freq: number, damping: number): THREE.Vector3 {
    _rel.subVectors(target, base);
    if (this.snapping) this.posSpring.set(_rel);
    return _relOut.copy(this.posSpring.step(_rel, dt, freq, damping)).add(base);
  }

  private stepLookRel(base: THREE.Vector3, target: THREE.Vector3, dt: number, freq: number, damping: number): THREE.Vector3 {
    _rel.subVectors(target, base);
    if (this.snapping) this.lookSpring.set(_rel);
    return _relOut2.copy(this.lookSpring.step(_rel, dt, freq, damping)).add(base);
  }

  private stepRoll(target: number, dt: number, freq: number, damping: number): number {
    if (this.snapping) this.rollSpring.set(target);
    return this.rollSpring.step(target, dt, freq, damping);
  }

  private stepFov(target: number, dt: number, freq: number, damping: number): number {
    if (this.snapping) this.fovSpring.set(target);
    return this.fovSpring.step(target, dt, freq, damping);
  }

  private stepHead(target: THREE.Vector3, dt: number, freq: number, damping: number): THREE.Vector3 {
    if (this.snapping) this.headSpring.set(target);
    return this.headSpring.step(target, dt, freq, damping);
  }

  private stepFlybyLook(target: THREE.Vector3, dt: number, freq: number, damping: number): THREE.Vector3 {
    if (this.snapping) this.flybyLook.set(target);
    return this.flybyLook.step(target, dt, freq, damping);
  }

  // -------------------------------------------------------------------------
  // Mode control
  // -------------------------------------------------------------------------

  setMode(m: CameraMode): void {
    if (this.mode === m) return;
    this.mode = m;
    this.snapNext = true;
    this.lookYawTarget = 0;
    this.lookPitchTarget = 0;
    if (m === 'orbit') {
      // Start the orbit where the chase camera was so the transition reads as
      // the player taking hold of the same camera, not a cut.
      const view = this.currentView();
      if (view.valid) {
        _v.subVectors(this.ctx.camera.position, view.pos);
        this.orbitDist = Math.max(6, _v.length());
        this.orbitAz = Math.atan2(_v.x, _v.z);
        this.orbitEl = Math.asin(Math.max(-1, Math.min(1, _v.y / Math.max(1e-3, _v.length()))));
      }
    }
    if (m === 'flyby') this.flybyValid = false;
    this.ctx.bus.emit('camera:mode', { mode: m, label: MODE_LABELS[m] });
  }

  cycle(): void {
    if (this.mode === 'scripted' || this.mode === 'killcam') { this.exitScripted(); return; }
    const i = CYCLE_MODES.indexOf(this.mode);
    this.setMode(CYCLE_MODES[(i + 1) % CYCLE_MODES.length]);
  }

  private exitScripted(): void {
    this.framing = null;
    this.framingName = null;
    this.killcamId = 0;
    this.killcamTimer = 0;
    this.effects.timeScale = 1;
    this.effects.desaturate = 0;
    // The beauty framings switch the HUD off. Nothing else ever switched it back
    // on, so after a screenshot run — or after anyone typed debugFraming() into
    // the console — the game was permanently HUD-less until the player found the
    // toggle key.
    if (this.hudBeforeFraming !== null) {
      this.ctx.settings.showHud = this.hudBeforeFraming;
      this.ctx.bus.emit('ui:showHud', this.hudBeforeFraming);
      this.hudBeforeFraming = null;
    }
    this.mode = this.returnMode === 'scripted' || this.returnMode === 'killcam' ? 'chase' : this.returnMode;
    this.snapNext = true;
    this.ctx.bus.emit('camera:mode', { mode: this.mode, label: MODE_LABELS[this.mode] });
  }

  /** Starts the kill-cam on an entity. Public so scripted sequences can use it. */
  killcam(entityId: number): void {
    const e = this.ctx.entities.get(entityId);
    if (!e) return;
    if (this.mode !== 'killcam' && this.mode !== 'scripted') this.returnMode = this.mode;
    this.killcamId = entityId;
    this.killcamTimer = 0;
    this.killcamPos.set(e.px, e.py, e.pz);
    this.killcamVel.set(e.vx, e.vy, e.vz);
    _v.subVectors(this.ctx.camera.position, this.killcamPos);
    this.killcamAz = Math.atan2(_v.x, _v.z);
    this.mode = 'killcam';
    this.snapNext = false;
    // The position spring holds an *offset*, and its base has just jumped from
    // the player's own aircraft to the victim's. Left alone, frame one places
    // the camera at (victim + the old chase offset) — a hard teleport of exactly
    // the distance between the two aeroplanes, which at the 900 m the kill-cam
    // allows is a very visible jump. Re-express the current camera position
    // against the new base so the spring starts from where the camera actually
    // is and eases into the orbit, which is what 'snapNext = false' intended.
    this.posSpring.set(_v);
    // Same for the look spring: seed it with wherever the camera is currently
    // pointed, at the victim's range, so the pan is swept rather than cut.
    const d = Math.max(1, _v.length());
    _v2.set(0, 0, -1).applyQuaternion(this.ctx.camera.quaternion).multiplyScalar(d)
      .add(this.ctx.camera.position).sub(this.killcamPos);
    this.lookSpring.set(_v2);
    this.ctx.bus.emit('camera:mode', { mode: 'killcam', label: MODE_LABELS.killcam });
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(ctx: GameContext): void {
    const dt = Math.max(1e-4, ctx.dt);
    const view = this.currentView();

    // The orbit rig takes the mouse away from the reticle. Assigning it here
    // rather than in 'setMode' covers every path that changes the mode
    // (framings, kill-cam, bus events) with one line.
    if (this.input) this.input.cameraOwnsMouse = this.mode === 'orbit';

    // The world subsystem may resolve its terrain sampler well after we
    // initialised; keep asking once a second until it does.
    if (!hasTerrainSampler() && ctx.time - this.terrainProbeAt > 1) {
      this.terrainProbeAt = ctx.time;
      discoverTerrainSampler(ctx);
    }

    // Gaining or losing a subject changes what the position spring *means*
    // (a world point when idle, a boom offset when following), so re-seat it.
    if (view.valid !== this.hadView) { this.hadView = view.valid; this.snapNext = true; }

    this.snapping = this.snapNext;
    this.pumpLookInput(dt);

    switch (this.mode) {
      case 'chase': this.rigChase(view, dt); break;
      case 'cockpit': this.rigCockpit(view, dt, false); break;
      case 'gunsight': this.rigCockpit(view, dt, true); break;
      case 'orbit': this.rigOrbit(view, dt); break;
      case 'flyby': this.rigFlyby(view, dt); break;
      case 'killcam': this.rigKillcam(view, dt); break;
      case 'scripted': this.rigScripted(view, dt); break;
    }

    this.updateShake(view, dt);
    this.commit(ctx, view, dt);
  }

  lateUpdate(ctx: GameContext): void {
    this.applyProjection(ctx);
    ctx.bus.emit('camera:effects', this.effects);
  }

  private currentView(): AircraftView {
    if (this.input) return this.input.view;
    return this.ownTracker.update(this.ctx, Math.max(1e-4, this.ctx.dt));
  }

  // -------------------------------------------------------------------------
  // Free-look
  // -------------------------------------------------------------------------

  private pumpLookInput(dt: number): void {
    const inp = this.input;
    const active = !!inp?.lookActive;
    if (inp && active) {
      const s = 0.0026 * this.ctx.settings.mouseSensitivity;
      this.lookYawTarget = clampSym(this.lookYawTarget + inp.lookDx * s, COCKPIT.yawLimit);
      this.lookPitchTarget = clampSym(this.lookPitchTarget - inp.lookDy * s, COCKPIT.pitchLimit);
    } else if (inp && !active) {
      // Snap back to boresight, quickly but not instantly — an instant snap
      // makes the horizon jump and is a reliable way to induce motion sickness.
      this.lookYawTarget = dampScalar(this.lookYawTarget, 0, COCKPIT.recenterRate, dt);
      this.lookPitchTarget = dampScalar(this.lookPitchTarget, 0, COCKPIT.recenterRate, dt);
    }
    // The "look back" binding is a hard 180 rather than a mouse gesture.
    if (inp && (inp.frame.bits & InputBits.LookBack) !== 0) this.lookYawTarget = Math.PI * 0.92;

    this.lookYaw.step(this.lookYawTarget, dt, 4.2, 1.0);
    this.lookPitch.step(this.lookPitchTarget, dt, 4.2, 1.0);
  }

  // -------------------------------------------------------------------------
  // Chase rig
  // -------------------------------------------------------------------------

  private rigChase(view: AircraftView, dt: number): void {
    if (!view.valid) { this.rigNoSubject(view, dt); return; }

    const L = Math.max(5, view.spec.geom.length);
    const dist = L * CHASE.distanceMul;
    const height = L * CHASE.heightMul;

    // --- boom direction: blend the nose vector toward the flight path -------
    _v.copy(view.forward);
    if (view.speed > 18) {
      _v2.copy(view.vel).multiplyScalar(1 / view.speed);
      _v.lerp(_v2, CHASE.velocityBias).normalize();
    }
    _boom.copy(_v).multiplyScalar(-1);

    // Stretch under longitudinal acceleration: the camera is on a spring, so
    // the aircraft physically pulls away from it when it accelerates. Adding a
    // little explicitly makes the effect legible instead of subliminal.
    const accelFwd = view.accelBody.z;
    const stretch = Math.max(-2.5, Math.min(7, accelFwd * CHASE.accelStretch));

    // Reference up: mostly world up, partly the aircraft's, so the boom rides
    // over the top of the aircraft in a bank instead of ploughing sideways.
    _v2.copy(WORLD_UP).multiplyScalar(1 - CHASE.rollFollow * 0.6)
      .addScaledVector(view.up, CHASE.rollFollow * 0.6);
    if (_v2.lengthSq() < 0.04) _v2.copy(WORLD_UP);
    _v2.normalize();

    _v3.copy(view.pos)
      .addScaledVector(_boom, dist + stretch)
      .addScaledVector(_v2, height);

    this.avoidTerrain(view.pos, _v3, CHASE.terrainClearance);

    const pos = this.stepPosRel(view.pos, _v3, dt, CHASE.posFreq, CHASE.posDamping);

    // --- look target --------------------------------------------------------
    // World-frame angular velocity, so the lead-look works in every attitude.
    _omegaWorld.copy(view.omega).applyQuaternion(view.quat);
    const turnRate = _omegaWorld.dot(WORLD_UP);

    _camFwd.subVectors(view.pos, pos);
    const boomLen = Math.max(1, _camFwd.length());
    _camFwd.multiplyScalar(1 / boomLen);
    _camRight.crossVectors(_camFwd, WORLD_UP);
    if (_camRight.lengthSq() < 1e-6) _camRight.copy(view.right);
    _camRight.normalize();
    _camUp.crossVectors(_camRight, _camFwd).normalize();

    // --- field of view ------------------------------------------------------
    // Solved before the look target because the composition below converts a
    // normalised-device offset into metres at the subject's distance, which
    // needs the lens the frame will actually be shot on. Reading last frame's
    // 'wantFov' instead put the subject a couple of per cent off its third
    // during the fov transient — invisible in play, but the screenshot harness
    // captures barely a second after the framing is applied, which is exactly
    // when that transient is largest.
    const speedT = smoothstep(60, CHASE.speedFovRef, view.speed);
    const wepKick = (view.throttle > 0.99 ? 1 : 0) * 1.5;
    const targetFov = (CHASE.baseFov + CHASE.speedFov * speedT * speedT + wepKick) * this.fovScale;

    _look.copy(view.pos);
    // Look ahead along the flight path.
    if (view.speed > 12) _look.addScaledVector(_v2.copy(view.vel).multiplyScalar(1 / view.speed), boomLen * 0.5 * CHASE.lookAhead * 0.6);

    // Where the subject sits in frame.
    //
    // In play that is a fixed lift — the aircraft rides in the lower third so
    // the sky it is climbing into, and the target it is chasing, both have the
    // upper two thirds to happen in. A screenshot framing that runs *this* rig
    // (rather than the scripted one) gets to compose the frame properly
    // instead: its 'frameX' / 'frameY' are the same normalised-device targets
    // the scripted rig honours, converted to metres at the boom's length, so a
    // gameplay frame can put the aeroplane on a third with the nose leading
    // into the empty side of the picture instead of pinning it dead centre
    // under the reticle.
    const comp = this.framing?.mode === 'chase' ? this.framing : null;
    if (comp) {
      const tanV = Math.tan((targetFov * Math.PI) / 360);
      _look.addScaledVector(_camRight, -comp.frameX * tanV * this.aspect * boomLen);
      _look.addScaledVector(_camUp, -comp.frameY * tanV * boomLen);
    } else {
      _look.addScaledVector(_camUp, boomLen * CHASE.frameLift);
    }
    // Lead into the turn.
    _look.addScaledVector(_camRight, Math.max(-14, Math.min(14, turnRate * CHASE.turnLead)));

    const look = this.stepLookRel(view.pos, _look, dt, CHASE.lookFreq, CHASE.lookDamping);

    // --- orientation --------------------------------------------------------
    // The roll is sprung once per frame, on the boresight view axis, and then
    // re-applied to whichever axis the rig actually ends up using. Free-look
    // used to overwrite the whole orientation with a level look-at, so holding
    // the look key in a 60° bank snapped the horizon flat and releasing it
    // snapped back — in the camera the player spends most of the game in.
    _camFwd.subVectors(look, pos);
    if (_camFwd.lengthSq() < 1e-8) _camFwd.copy(view.forward);
    _camFwd.normalize();
    const rolled = this.stepRoll(this.rollAbout(_camFwd, view) * CHASE.rollFollow, dt, 2.2, 1.0);

    // Free-look orbits the boom rather than just turning the head, because in
    // third person turning the camera in place just shows you the inside of the
    // aeroplane's tail.
    if (Math.abs(this.lookYaw.value) > 1e-3 || Math.abs(this.lookPitch.value) > 1e-3) {
      _q.setFromAxisAngle(WORLD_UP, -this.lookYaw.value);
      _v.subVectors(pos, view.pos).applyQuaternion(_q);
      _camRight.crossVectors(WORLD_UP, _v);
      // The boom can be exactly vertical (straight-up climb with the camera
      // directly below); fall back to the aircraft's own lateral axis.
      if (_camRight.lengthSq() < 1e-8) _camRight.copy(view.right);
      _camRight.normalize();
      _q2.setFromAxisAngle(_camRight, this.lookPitch.value);
      _v.applyQuaternion(_q2);
      this.wantPos.copy(view.pos).add(_v);
      this.avoidTerrain(view.pos, this.wantPos, CHASE.terrainClearance);
      this.applyRolledLookAt(this.wantPos, view.pos, rolled, view);
    } else {
      this.wantPos.copy(pos);
      this.applyRolledLookAt(pos, look, rolled, view);
    }

    this.wantFov = this.stepFov(targetFov, dt, 0.9, 1.0);
    this.wantNear = 0.35;
    this.effects.interior = false;
  }

  /**
   * No aircraft to follow. If a screenshot framing is active its composition is
   * still honoured against a synthetic anchor; otherwise we fall back to a slow
   * establishing drift so the pre-spawn screen is never a static frame.
   */
  private rigNoSubject(view: AircraftView, dt: number): void {
    if (this.framing) this.rigScripted(view, dt);
    else this.rigIdle(dt);
  }

  /** Slow drift when there is nothing to follow (pre-spawn, spectator gap). */
  private rigIdle(dt: number): void {
    const t = this.ctx.time * 0.06;
    const r = 210;
    const y = terrainHeightAt(0, 0) + 900;
    _v3.set(Math.cos(t) * r, y + Math.sin(t * 0.7) * 40, Math.sin(t) * r);
    const pos = this.stepPos(_v3, dt, 0.5, 1.0);
    _look.set(Math.cos(t + 1.2) * 40, y - 120, Math.sin(t + 1.2) * 40);
    const look = this.stepLook(_look, dt, 0.5, 1.0);
    this.wantPos.copy(pos);
    _m.lookAt(pos, look, WORLD_UP);
    this.wantQuat.setFromRotationMatrix(_m);
    this.wantFov = this.stepFov(52, dt, 0.8, 1.0);
    this.wantNear = 0.35;
    this.effects.interior = false;
  }

  /**
   * The aircraft's bank measured about a given view axis, radians.
   *
   * Split out from the look-at so free-look can reuse the *same* sprung roll on
   * a different view axis. Rolling with the aircraft — even partly — is what
   * sells a turn; rolling fully with it makes the horizon spin and the player
   * lose the ground.
   */
  private rollAbout(fwd: THREE.Vector3, view: AircraftView): number {
    // Project both candidate ups into the plane perpendicular to the view axis.
    _v.copy(WORLD_UP).addScaledVector(fwd, -WORLD_UP.dot(fwd));
    if (_v.lengthSq() < 1e-5) _v.copy(view.up).addScaledVector(fwd, -view.up.dot(fwd));
    _v.normalize();

    _v2.copy(view.up).addScaledVector(fwd, -view.up.dot(fwd));
    if (_v2.lengthSq() < 1e-5) return 0;
    _v2.normalize();
    // Signed angle from the world-up reference to the aircraft up, about the axis.
    const cos = Math.max(-1, Math.min(1, _v.dot(_v2)));
    _v3.crossVectors(_v, _v2);
    return Math.atan2(_v3.dot(fwd), cos);
  }

  /**
   * Builds an orientation that looks from 'pos' at 'look' with a given roll
   * about the view axis, expressed relative to level.
   */
  private applyRolledLookAt(
    pos: THREE.Vector3, look: THREE.Vector3, roll: number, view: AircraftView,
  ): void {
    _camFwd.subVectors(look, pos);
    if (_camFwd.lengthSq() < 1e-8) _camFwd.copy(view.forward);
    _camFwd.normalize();

    _v.copy(WORLD_UP).addScaledVector(_camFwd, -WORLD_UP.dot(_camFwd));
    if (_v.lengthSq() < 1e-5) _v.copy(view.up).addScaledVector(_camFwd, -view.up.dot(_camFwd));
    _v.normalize();

    _q.setFromAxisAngle(_camFwd, roll);
    _camUp.copy(_v).applyQuaternion(_q);

    _m.lookAt(pos, look, _camUp);
    this.wantQuat.setFromRotationMatrix(_m);
  }

  // -------------------------------------------------------------------------
  // Cockpit / gunsight
  // -------------------------------------------------------------------------

  private rigCockpit(view: AircraftView, dt: number, gunsight: boolean): void {
    if (!view.valid) { this.rigNoSubject(view, dt); return; }

    // Anchor to the *drawn* aircraft, not to the predicted state.
    //
    // 'view.pos' is the flight model's locally predicted position; the model in
    // the scene is placed by the entity subsystem from the replicated
    // 'EntityState'. Those two agree to within a frame of integration — which at
    // 130 m/s is over a metre. In every external rig a metre of boom error is
    // invisible; in the cockpit it is the difference between sitting at the
    // gunsight and sitting behind the headrest, and it is exactly why the panel
    // was out of frame. When the model is reachable we take its published eye
    // node and its own world orientation, so the camera is welded to the
    // geometry it is looking at and the panel cannot swim.
    const rig = this.resolveCockpitRig(view);
    if (rig) {
      rig.eye.getWorldPosition(_eyeWorld);
      rig.root.getWorldQuaternion(_bodyQuat);
    } else {
      this.resolveEyeOffset(view, _eye);
      _eyeWorld.copy(_eye).applyQuaternion(view.quat).add(view.pos);
      _bodyQuat.copy(view.quat);
    }

    // --- head displacement under g ------------------------------------------
    // The head is a 5 kg mass on a compliant neck: under load it sinks, under
    // lateral acceleration it lolls, and under longitudinal acceleration it
    // pitches back. Reproducing that — subtly — is most of what makes a
    // cockpit view feel like being in an aeroplane.
    const gx = view.accelBody.x / 9.80665;
    const gy = view.accelBody.y / 9.80665 - 1;
    const gz = view.accelBody.z / 9.80665;
    _v.set(
      clampSym(-gx * COCKPIT.headThrowPerG, COCKPIT.maxHeadThrow),
      clampSym(-gy * COCKPIT.headThrowPerG, COCKPIT.maxHeadThrow),
      clampSym(-gz * COCKPIT.headThrowPerG, COCKPIT.maxHeadThrow),
    );
    // Head lag: the neck cannot follow a snap roll instantly.
    _v.addScaledVector(view.omega, -COCKPIT.headLagPerRate);
    const head = this.stepHead(_v, dt, COCKPIT.headFreq, COCKPIT.headDamping);

    // Seat adjustment: composition, applied on top of the anatomical eye point.
    // See COCKPIT.seatRaise. The gunsight mode leans in further still — that is
    // what a pilot physically does to use a reflector sight.
    _v2.set(0, COCKPIT.seatRaise, COCKPIT.seatForward).add(head);
    if (gunsight) _v2.z += GUNSIGHT.setback;
    _v2.applyQuaternion(_bodyQuat);
    this.wantPos.copy(_eyeWorld).add(_v2);

    // --- orientation ---------------------------------------------------------
    this.wantQuat.copy(_bodyQuat).multiply(BODY_TO_CAM);
    if (gunsight) {
      // The sight is bolted to the airframe; only a whisper of head motion.
      _q.setFromAxisAngle(AXIS_Y, -this.lookYaw.value * GUNSIGHT.compliance);
      this.wantQuat.multiply(_q);
      _q.setFromAxisAngle(AXIS_X, this.lookPitch.value * GUNSIGHT.compliance);
      this.wantQuat.multiply(_q);
    } else {
      _q.setFromAxisAngle(AXIS_Y, -this.lookYaw.value);
      this.wantQuat.multiply(_q);
      _q.setFromAxisAngle(AXIS_X, this.lookPitch.value);
      this.wantQuat.multiply(_q);
      // A little head roll into sustained lateral g — pilots do it without
      // noticing and it reads as effort.
      _q.setFromAxisAngle(AXIS_Z, clampSym(gx * 0.035, 0.08));
      this.wantQuat.multiply(_q);
    }

    const zoomed = !!this.input?.zoomHeld;
    // The gunsight is a magnification, not a preference: it keeps its authored
    // lens whatever the player's FOV slider says.
    const base = gunsight ? GUNSIGHT.baseFov : COCKPIT.baseFov * this.fovScale;
    const zoom = gunsight ? GUNSIGHT.zoomFov : COCKPIT.zoomFov;
    this.wantFov = this.stepFov(zoomed ? zoom : base, dt, 3.2, 1.0);
    this.wantNear = COCKPIT.near;
    this.effects.interior = true;
  }

  /**
   * The scene nodes the cockpit rig rides on: the model's published eye anchor
   * and the root that defines its body frame.
   *
   * Re-probed at most a few times a second because models stream in after the
   * entity does, and a miss is cheap (one Map lookup) while a hit is cached for
   * as long as the entity lives.
   */
  private resolveCockpitRig(view: AircraftView): CockpitRig | null {
    if (this.cockpitRigFor === view.entityId && this.cockpitRig) return this.cockpitRig;
    if (this.ctx.time - this.eyeProbeAt < 0.35 && this.cockpitRigFor === view.entityId) return null;
    this.eyeProbeAt = this.ctx.time;
    this.cockpitRigFor = view.entityId;
    this.cockpitRig = findCockpitRig(this.ctx, view.entityId);
    return this.cockpitRig;
  }

  /**
   * Eye position in body space, for the frames before the model exists.
   *
   * Derived from the canopy geometry the same way the model builder derives it,
   * so the fallback and the real thing agree to a couple of centimetres and the
   * view does not jump when the model arrives. Canopy z0 is the forward edge and
   * z1 the aft one (z0 > z1, since +Z is the nose), and the builder seats the
   * pilot just aft of the canopy's midpoint.
   */
  private resolveEyeOffset(view: AircraftView, out: THREE.Vector3): void {
    const cached = this.eyeCache.get(view.entityId);
    if (cached) { out.copy(cached); return; }

    const g = view.spec.geom;
    const z = g.canopy.z0 + (g.canopy.z1 - g.canopy.z0) * COCKPIT.eyeForwardBias;
    const y = g.fuseRadius * 0.45 + g.canopy.height * COCKPIT.eyeHeight;
    out.set(0, y, z);
  }

  // -------------------------------------------------------------------------
  // Free orbit
  // -------------------------------------------------------------------------

  private rigOrbit(view: AircraftView, dt: number): void {
    const inp = this.input;
    const L = view.valid ? Math.max(5, view.spec.geom.length) : 9.5;

    // In orbit mode the mouse belongs to the camera outright — the whole point
    // of the mode is to look at your aeroplane, and requiring a modifier to do
    // it makes the mode useless. 'cameraOwnsMouse' tells the input system to
    // stop steering the reticle while we are here.
    if (inp) {
      this.orbitAz -= inp.mouseDx * ORBIT.dragSensitivity;
      this.orbitEl = clampSym(this.orbitEl + inp.mouseDy * ORBIT.dragSensitivity, ORBIT.elevationLimit);
      if (inp.zoomDelta !== 0) this.orbitDist *= Math.pow(ORBIT.zoomStep, -inp.zoomDelta);
    }
    this.orbitDist = Math.max(L * ORBIT.minDistanceMul, Math.min(L * ORBIT.maxDistanceMul, this.orbitDist));

    // The fallback centre goes in its own scratch. Putting it in '_v3' — which
    // is also the station scratch two lines down — made 'centre' an alias of the
    // camera position: the orbit centre became the camera, the boom collapsed to
    // zero, and 'lookAt(pos, pos)' left the pre-spawn free camera staring at a
    // degenerate axis.
    const centre = view.valid ? view.pos : _centre.set(0, terrainHeightAt(0, 0) + 900, 0);
    const ce = Math.cos(this.orbitEl), se = Math.sin(this.orbitEl);
    _v.set(Math.sin(this.orbitAz) * ce, se, Math.cos(this.orbitAz) * ce).multiplyScalar(this.orbitDist);
    _v3.copy(centre).add(_v);
    this.avoidTerrain(centre, _v3, 2.5);

    const pos = this.stepPosRel(centre, _v3, dt, ORBIT.freq, ORBIT.damping);
    const look = this.stepLookRel(centre, centre, dt, ORBIT.freq * 1.4, ORBIT.damping);
    this.wantPos.copy(pos);
    _m.lookAt(pos, look, WORLD_UP);
    this.wantQuat.setFromRotationMatrix(_m);
    this.wantFov = this.stepFov(ORBIT.fov, dt, 2.5, 1.0);
    this.wantNear = 0.35;
    this.effects.interior = false;
  }

  // -------------------------------------------------------------------------
  // Fly-by
  // -------------------------------------------------------------------------

  private rigFlyby(view: AircraftView, dt: number): void {
    if (!view.valid) { this.rigNoSubject(view, dt); return; }

    this.flybyTimer += dt;
    const passed = this.flybyValid && (
      this.flybyTimer > FLYBY.maxDwell ||
      view.pos.distanceTo(this.flybyStation) > FLYBY.passDistance
    );
    if (!this.flybyValid || passed) this.stationFlyby(view);

    // Slow dolly: the station creeps across the aircraft's path, which turns a
    // static shot into a moving one without ever losing the subject.
    _v.copy(view.vel);
    if (_v.lengthSq() > 1) _v.normalize(); else _v.copy(view.forward);
    _v2.crossVectors(WORLD_UP, _v).normalize();
    this.flybyStation.addScaledVector(_v2, FLYBY.dolly * dt * (this.flybyPhase % 2 === 0 ? 1 : -1));

    // Lead the subject slightly: a camera operator anticipates, and a pass shot
    // where the aircraft is always dead centre looks robotic.
    _look.copy(view.pos).addScaledVector(view.vel, 0.16);
    const look = this.stepFlybyLook(_look, dt, FLYBY.lookFreq, 1.0);

    this.wantPos.copy(this.flybyStation);
    _m.lookAt(this.flybyStation, look, WORLD_UP);
    this.wantQuat.setFromRotationMatrix(_m);

    // Tighten the lens as the aircraft recedes so it keeps its size in frame.
    const d = this.flybyStation.distanceTo(view.pos);
    const target = FLYBY.fov * clamp(120 / Math.max(60, d), 0.55, 1.5);
    this.wantFov = this.stepFov(target, dt, 1.2, 1.0);
    this.wantNear = 0.35;
    this.effects.interior = false;
  }

  private stationFlyby(view: AircraftView): void {
    this.flybyValid = true;
    this.flybyTimer = 0;
    this.flybyPhase++;

    const lead = Math.max(FLYBY.minLead, view.speed * FLYBY.leadSeconds);
    _v.copy(view.vel);
    if (_v.lengthSq() > 1) _v.normalize(); else _v.copy(view.forward);
    _v2.crossVectors(WORLD_UP, _v).normalize();

    // Alternate sides and heights so consecutive passes are not identical.
    const side = this.flybyPhase % 2 === 0 ? 1 : -1;
    const r = hash01(this.flybyPhase * 7919);
    const lat = FLYBY.lateral[0] + (FLYBY.lateral[1] - FLYBY.lateral[0]) * r;
    const vert = FLYBY.vertical[0] + (FLYBY.vertical[1] - FLYBY.vertical[0]) * hash01(this.flybyPhase * 104729);

    this.flybyStation.copy(view.pos)
      .addScaledVector(_v, lead)
      .addScaledVector(_v2, lat * side)
      .addScaledVector(WORLD_UP, vert);

    // Never station the camera inside a hill, and prefer a low angle looking up
    // when the terrain is close — it is a far better shot.
    const th = terrainHeightAt(this.flybyStation.x, this.flybyStation.z);
    if (this.flybyStation.y < th + 12) this.flybyStation.y = th + 12;

    this.flybyLook.set(view.pos);
  }

  // -------------------------------------------------------------------------
  // Kill-cam
  // -------------------------------------------------------------------------

  private rigKillcam(view: AircraftView, dt: number): void {
    this.killcamTimer += dt;

    const e = this.ctx.entities.get(this.killcamId);
    if (e) {
      this.killcamPos.set(e.px, e.py, e.pz);
      this.killcamVel.set(e.vx, e.vy, e.vz);
    } else {
      // The wreck may despawn mid-shot; keep coasting so the camera does not
      // snap to the origin.
      this.killcamPos.addScaledVector(this.killcamVel, dt);
      this.killcamVel.y -= 9.81 * dt * 0.4;
    }

    // Slow-motion ramp: hold the slowdown, then ease back to real time. The
    // camera keeps moving in real time so the orbit does not crawl.
    const t = this.killcamTimer;
    let scale: number;
    if (t < KILLCAM.slowMoHold) scale = KILLCAM.slowMo;
    else scale = KILLCAM.slowMo + (1 - KILLCAM.slowMo) * smoothstep(KILLCAM.slowMoHold, KILLCAM.duration * 0.92, t);
    this.effects.timeScale = scale;
    this.effects.desaturate = 0.35 * (1 - smoothstep(KILLCAM.duration * 0.7, KILLCAM.duration, t));

    this.killcamAz += KILLCAM.spin * dt;
    const L = view.valid ? Math.max(6, view.spec.geom.length) : 9.5;
    const dist = L * KILLCAM.distanceMul;
    const height = L * KILLCAM.heightMul;

    _v3.copy(this.killcamPos)
      .add(_v.set(Math.sin(this.killcamAz) * dist, height, Math.cos(this.killcamAz) * dist));
    this.avoidTerrain(this.killcamPos, _v3, 3);

    const pos = this.stepPosRel(this.killcamPos, _v3, dt, 1.9, 1.0);
    const look = this.stepLookRel(this.killcamPos, this.killcamPos, dt, 3.0, 1.0);
    this.wantPos.copy(pos);
    _m.lookAt(pos, look, WORLD_UP);
    this.wantQuat.setFromRotationMatrix(_m);
    this.wantFov = this.stepFov(KILLCAM.fov, dt, 1.4, 1.0);
    this.wantNear = 0.35;
    this.effects.interior = false;

    if (t > KILLCAM.duration) this.exitScripted();
  }

  // -------------------------------------------------------------------------
  // Scripted framings
  // -------------------------------------------------------------------------

  private rigScripted(view: AircraftView, dt: number): void {
    const spec = this.framing;
    if (!spec) { this.exitScripted(); return; }

    this.resolveAnchor(spec, view);
    composeFraming(this.shot, spec, this.anchorPos, this.anchorFwd, this.ctx.sunDir, this.aspect, this.anchorScale);

    this.drift.update(dt);
    this.wantPos.copy(this.shot.position).add(this.drift.offset);
    this.wantQuat.copy(this.shot.quaternion);
    _q.setFromEuler(_euler.set(this.drift.angles.x, this.drift.angles.y, this.drift.angles.z));
    this.wantQuat.multiply(_q);
    this.wantFov = this.stepFov(this.shot.fov, dt, 4.0, 1.0);
    this.wantNear = 0.35;
    this.effects.interior = false;
  }

  /** Where the scripted shot is pointed: the live aircraft, or a synthetic pose. */
  private resolveAnchor(spec: FramingSpec, view: AircraftView): void {
    if (view.valid) {
      this.anchorPos.copy(view.pos);
      this.anchorFwd.copy(view.forward);
      this.anchorScale = Math.max(0.6, view.spec.geom.length / 9.5);
      return;
    }
    // No aircraft: synthesise one so the harness still gets a composed frame.
    const f = spec.fallback;
    if (!this.anchorSite) this.anchorSite = this.siteFor(spec);
    const site = this.anchorSite;
    this.anchorPos.set(site.x, terrainHeightAt(site.x, site.z) + f.altitude, site.z);
    _q.setFromEuler(_euler.set(f.pitch, this.anchorHeading, -f.bank, 'YXZ'));
    this.anchorFwd.set(0, 0, 1).applyQuaternion(_q);
    this.anchorScale = 1;
  }
  private anchorSite: { x: number; z: number } | null = null;
  /** Heading the shot was set up on — sun-solved for 'sunLocked' framings. */
  private anchorHeading = 0;

  /**
   * The heading that satisfies a framing's 'bearing' and 'sunRel' at once.
   *
   * See FramingSpec.sunLocked. The camera station sits at azimuth
   * 'heading + π + bearing' from the subject and the sun-driven station sits at
   * 'sunAzimuth − π − sunRel'; setting the heading to 'sunAzimuth − sunRel −
   * bearing' makes those the same angle, so the blend in 'composeFraming'
   * becomes a no-op and both constraints are exact.
   */
  private headingFor(spec: FramingSpec): number {
    if (!spec.sunLocked) return spec.fallback.heading;
    // 'ctx.sunDir' points from the sun toward the scene; negate for the bearing
    // of the sun itself, in the same atan2(x, z) convention 'composeFraming' uses.
    const sunAz = Math.atan2(-this.ctx.sunDir.x, -this.ctx.sunDir.z);
    return sunAz - spec.sunRel - spec.bearing;
  }

  /**
   * Makes the sky resolve the time of day we have just published, now.
   *
   * 'sky:timeOfDay' only marks the ephemeris dirty; 'ctx.sunDir' is not rebuilt
   * until the sky's own update runs, which is *after* ours. A sun-locked framing
   * that read it at that point would solve its heading against the previous
   * shot's sun — the aeroplane would be pointing the right way for the framing
   * before it. Nudging the sky's update once here costs one LUT rebuild per
   * framing change (this is a debug entry point, not a frame path) and makes the
   * solve exact on the first frame, which matters because the harness captures
   * barely a second later.
   */
  private pumpSky(): void {
    const sky = this.ctx.get('sky') as unknown as Record<string, unknown> | undefined;
    const update = sky?.['update'];
    if (typeof update !== 'function') return;
    try { (update as (c: GameContext) => void).call(sky, this.ctx); } catch { /* different shape */ }
  }

  /**
   * Where on the map the shot happens.
   *
   * Two stages. First a place: either a real, generated feature the world
   * subsystem can name (an airfield with hangars, revetments and flak on it) or,
   * failing that, a height-scored patch that matches the requested biome.
   * Then a *standoff* — the subject is pushed back along its own heading so the
   * feature is ahead of the nose at the moment of capture rather than under the
   * tail, which is the whole difference between a strafing frame and a
   * photograph of some fields.
   */
  private siteFor(spec: FramingSpec): { x: number; z: number } {
    const aim = spec.scene.aimAt ? this.worldFeature(spec.scene.aimAt) : null;
    // The camera sits at azimuth 'heading + π + bearing' from the subject and
    // looks back along it, so the lens points down 'heading + bearing'. The
    // biome search needs that, not the heading: see findAnchorSite.
    if (!aim) return findAnchorSite(spec.scene.biome, this.anchorHeading + spec.bearing);
    const back = spec.scene.standoff ?? 700;
    const h = this.anchorHeading;
    return { x: aim.x - Math.sin(h) * back, z: aim.z - Math.cos(h) * back };
  }

  /**
   * Asks the world subsystem for a real feature of the generated map.
   *
   * Duck-typed, like every other cross-subsystem reach in this file: the world
   * is authored separately and a miss has to degrade to the biome search rather
   * than throw during a screenshot run. Nearest-to-centre wins because the
   * terrain streamer is guaranteed to have that tile resident, and a framing
   * that lands on an unstreamed corner photographs a hole.
   */
  private worldFeature(kind: 'airfield' | 'target'): { x: number; z: number } | null {
    const w = this.ctx.get('world') as unknown as Record<string, unknown> | undefined;
    if (!w) return null;
    const list = w[kind === 'airfield' ? 'airfields' : 'targets'];
    if (!Array.isArray(list)) return null;
    let best: { x: number; z: number } | null = null;
    let bestD = Infinity;
    for (const item of list) {
      const x = (item as { x?: unknown })?.x;
      const z = (item as { z?: unknown })?.z;
      if (typeof x !== 'number' || typeof z !== 'number') continue;
      const d = x * x + z * z;
      if (d < bestD) { bestD = d; best = { x, z }; }
    }
    return best;
  }

  /**
   * Drives the camera into a named, hand-composed framing and asks the rest of
   * the game for the scene state that shot needs. Used by the screenshot
   * harness; safe to call at any time.
   */
  debugFraming(name: string): void {
    const spec = FRAMINGS[name as FramingName];
    if (!spec) {
      console.warn(`[camera] unknown framing "${name}" — expected one of ${Object.keys(FRAMINGS).join(', ')}`);
      return;
    }
    const ctx = this.ctx;
    if (!ctx) {
      // Registered but not yet initialised — the harness can reach a subsystem
      // through the registry the moment it is registered, which during a boot
      // (or a hot reload) is several hundred milliseconds before 'init' runs.
      // Failing loudly here beats a 'cannot read properties of undefined' from
      // six frames deeper.
      console.warn(`[camera] debugFraming("${name}") ignored — the camera has not initialised yet`);
      return;
    }
    this.framingName = name as FramingName;
    this.framing = spec;

    // The sun first: it is an input to where the aeroplane is pointed, which is
    // an input to where on the map it stands, so the order here is load-bearing.
    ctx.timeOfDay = spec.timeOfDay;
    ctx.bus.emit('sky:timeOfDay', spec.timeOfDay);
    this.pumpSky();
    this.anchorHeading = this.headingFor(spec);

    // --- put the subject where the shot was composed for --------------------
    //
    // Every framing states the altitude, attitude and biome it was designed
    // around: a 75 m deck pass over farmland, a 190 m run over open sea, a dive
    // onto an airfield. Pointing a camera at whatever altitude the aircraft
    // happened to be at cannot produce any of those — all ten shots come out as
    // the same aeroplane at its 2.3 km spawn altitude with the ground hazed out
    // two kilometres below. The framing owns the composition, and the
    // composition includes where the subject is standing.
    this.anchorSite = this.siteFor(spec);
    const site = this.anchorSite;
    const f = spec.fallback;
    const subject = {
      x: site.x,
      z: site.z,
      // Above the *surface*: over water the terrain height is negative and a
      // sea-level shot must be referenced to the waterline, not the seabed.
      // Then moved clear of the cloud deck — see 'clearOfCloudDeck'. A framing
      // that is composed *on* the deck states its own offset from the tops and
      // skips the correction entirely.
      altitude: spec.cloudTopOffset !== undefined
        ? spec.weather.cloudBase + spec.weather.cloudDepth * DECK_TOP_FRACTION + spec.cloudTopOffset
        : clearOfCloudDeck(
          Math.max(terrainHeightAt(site.x, site.z), 0) + f.altitude,
          spec.weather,
        ),
      heading: this.anchorHeading,
      pitch: f.pitch,
      bank: f.bank,
      speed: f.speed,
    };
    // Place it ourselves through the shared flight model when we can reach the
    // local state, and broadcast the request regardless so the entity/AI layer
    // can arrange opponents, ground targets and damage to match.
    const placed = placeSubjectForShot(ctx, subject);
    // The reticle is still pointing where the aircraft used to be looking; left
    // alone the flight director reads that as a 90° pointing error and hauls the
    // aeroplane round mid-shot, which shows up as a 3 g pull in the g meter.
    if (placed) this.input?.resetAim();
    ctx.bus.emit('debug:place', {
      ...subject,
      y: subject.altitude,
      placed,
      opponent: spec.scene.opponent ?? null,
      damage: spec.scene.damage ?? 0,
      gear: spec.scene.gear,
      flaps: spec.scene.flaps,
    });

    // One payload, two vocabularies. The sky reads coverage/cloudBase/turbidity;
    // the VFX layer reads rain/humidity/windX-Y-Z and silently ignored the
    // directive because not one field name matched. Both halves are published
    // together so a framing's weather actually reaches the particles that carry
    // it — contrails and wingtip vortices key off humidity, and the wind vector
    // is what makes a smoke trail lie down.
    ctx.bus.emit('weather', weatherPayload(spec.weather, this.anchorHeading));

    // Everything the shot needs from the other subsystems, in one payload.
    ctx.bus.emit('debug:framing', {
      name, spec, scene: spec.scene, weather: spec.weather,
      timeOfDay: spec.timeOfDay, subject, subjectPlaced: placed,
    });
    ctx.bus.emit('debug:scene', spec.scene);

    // The HUD is opt-in per framing, not sticky. 'hero', 'sunset' and the rest
    // are beauty frames — leaving the last shot's HUD switched on puts a
    // gunsight across the box art. Only 'cockpit' and 'hud' ask for it.
    const wantHud = spec.scene.hud === true;
    if (this.hudBeforeFraming === null) this.hudBeforeFraming = ctx.settings.showHud;
    ctx.settings.showHud = wantHud;
    ctx.bus.emit('ui:showHud', wantHud);

    // A framing is a *gameplay* frame. If the game is still sitting on the main
    // menu the shot is of a blurred menu background, so ask the UI to get out of
    // the way — by event, and by calling it directly if it is listening for
    // neither.
    ctx.bus.emit('ui:setScreen', 'flight');
    ctx.bus.emit('ui:closeMenus');
    // The harness never clicks, so the "click to take the controls" prompt would
    // otherwise be printed across every beauty shot.
    this.input?.mouse.setPromptSuppressed(true);
    // ...and for the same reason, the teaching overlays stand down: a framing
    // means "compose a picture", not "play the game", and flight school across
    // the middle of a hero shot is a regression in every framing at once.
    ctx.bus.emit('ui:debugFraming');
    const ui = ctx.get('ui') as unknown as Record<string, unknown> | undefined;
    const setScreen = ui?.['setScreen'];
    if (typeof setScreen === 'function') {
      try { (setScreen as (s: string) => void).call(ui, 'flight'); } catch { /* different signature */ }
    }

    if (this.mode !== 'scripted' && this.mode !== 'killcam') this.returnMode = this.mode;
    // 'cockpit' and 'chase' framings run the real rig, because the point of
    // those two shots is that the live rig is good enough to screenshot.
    this.mode = spec.mode;

    // Snap every spring so the very next frame is already the finished shot;
    // the harness only waits a beat before capturing.
    this.snapNext = true;
    this.fovSpring.set(spec.fov);
    this.shake.reset();
    this.lookYawTarget = 0; this.lookPitchTarget = 0;
    this.lookYaw.set(0); this.lookPitch.set(0);
    this.effects.timeScale = 1;
    this.effects.desaturate = 0;

    ctx.bus.emit('camera:framing', name);
  }

  /** The framing currently applied, or null. */
  get currentFraming(): FramingName | null { return this.framingName; }

  /**
   * The scene directives of the framing currently applied.
   *
   * Published for the screenshot harness. 'firing' is the one directive nothing
   * inside the engine can honour on its own — the guns are driven by the input
   * layer and the harness is the only thing holding a button — so the harness
   * reads it here and presses the real fire control for the duration of the
   * settle. Everything downstream (muzzle flash, tracer geometry, ballistics,
   * impacts, recoil shake) is then the game's own, not a posed effect.
   */
  get framingScene(): FramingSpec['scene'] | null { return this.framing?.scene ?? null; }

  // -------------------------------------------------------------------------
  // Terrain avoidance
  // -------------------------------------------------------------------------

  /**
   * Keeps the segment from 'subject' to 'cam' above the ground.
   *
   * Lifting the whole boom is tried first because it preserves the shot's
   * distance and therefore its sense of speed; only when the required lift gets
   * absurd (a cliff directly behind) does the boom shorten, which is still far
   * better than the camera burrowing through a hill.
   */
  private avoidTerrain(subject: THREE.Vector3, cam: THREE.Vector3, clearance: number): void {
    // Degenerate boom: nothing to keep clear of, and the shrink branch below
    // would divide a lerp between a point and itself.
    if (subject.distanceToSquared(cam) < 1e-6) return;
    let lift = 0;
    const N = 5;
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const x = subject.x + (cam.x - subject.x) * t;
      const y = subject.y + (cam.y - subject.y) * t;
      const z = subject.z + (cam.z - subject.z) * t;
      const need = terrainHeightAt(x, z) + clearance - y;
      if (need > lift) lift = need;
    }
    if (lift <= 0) return;

    const boomLen = cam.distanceTo(subject);
    if (lift < boomLen * 0.55) {
      cam.y += lift;
      return;
    }
    // Too steep to lift out of: pull the camera in toward the subject and take
    // whatever lift is still needed at the shorter range.
    const shrink = clamp(boomLen * 0.55 / lift, 0.25, 1);
    cam.lerpVectors(subject, cam, shrink);
    const th = terrainHeightAt(cam.x, cam.z) + clearance;
    if (cam.y < th) cam.y = th;
  }

  // -------------------------------------------------------------------------
  // Shake and effects
  // -------------------------------------------------------------------------

  private updateShake(view: AircraftView, dt: number): void {
    // Sustained sources, refreshed every frame.
    let sustained = 0;
    if (view.valid) {
      sustained += view.buffet * 0.30;
      // An autorotating aircraft is genuinely violent; this is the one time the
      // camera is allowed to make the game hard to play.
      sustained += view.spinning * 0.28;
      // Airframe rumble at high indicated airspeed — the aeroplane complaining.
      sustained += smoothstep(0.82, 1.05, view.ias / Math.max(40, view.spec.aero.vne)) * 0.22;
      if (view.onGround && view.speed > 3) sustained += 0.05 + Math.min(0.10, view.speed * 0.0015);
    }
    // Gunfire: sustained rather than per-shot, so the shake does not beat
    // against the rate of fire.
    const bits = this.input?.frame.bits ?? 0;
    const firingNow = (bits & 0b11) !== 0 ? 1 : 0;
    this.firing = dampScalar(this.firing, firingNow, firingNow ? 22 : 9, dt);
    if (view.valid) {
      const guns = view.spec.guns;
      let recoil = 0;
      for (const g of guns) recoil += g.count * g.calibre * g.calibre * 1.1e-4;
      sustained += this.firing * Math.min(0.30, recoil);
    }

    // Cockpit shake is bigger: your head is bolted to the thing that is
    // vibrating. In third person the camera is notionally a chase plane.
    // Applied once, here: 'shake.update' multiplies its own 'intensityScale'
    // into the *squared* trauma, so passing modeScale to both attenuated the
    // third-person rig by 0.55² = 0.30 instead of 0.55 and knocked every hit and
    // explosion impulse down with it.
    const modeScale = this.mode === 'cockpit' || this.mode === 'gunsight' ? 1.0 : 0.55;
    this.shake.sustained = sustained;
    this.shake.update(dt, modeScale);
  }

  private onGameEvent(e: GameEventPayload): void {
    if (!e) return;
    const localId = this.ctx.localEntityId;
    switch (e.kind) {
      case EventKind.HitSpark:
      case EventKind.HitArmour:
        // 'a' is the entity that was hit.
        if (e.a === localId) this.shake.impulse(e.kind === EventKind.HitArmour ? 0.34 : 0.20);
        break;
      case EventKind.Critical:
        if (e.a === localId) this.shake.impulse(0.55);
        break;
      case EventKind.StructureFail:
        if (e.a === localId) this.shake.impulse(0.8);
        break;
      case EventKind.Explosion:
      case EventKind.GroundImpact:
      case EventKind.WaterImpact: {
        // Blast falls off with distance; 120 m is about where a 250 kg bomb
        // stops being felt through the airframe.
        const d = Math.hypot(e.x - this.ctx.camera.position.x, e.y - this.ctx.camera.position.y, e.z - this.ctx.camera.position.z);
        const s = Math.max(0.4, e.scale || 1);
        const amt = clamp((160 * s - d) / (160 * s), 0, 1);
        if (amt > 0) this.shake.impulse(amt * amt * 0.7);
        break;
      }
      case EventKind.Kill: {
        const victim = e.a;
        if (victim === localId) {
          if (this.killcamOnDeath) this.killcam(victim);
        } else if (this.killcamOnKill && e.b === this.ctx.localPlayerId) {
          const v = this.ctx.entities.get(victim);
          if (v) {
            const d = Math.hypot(v.px - this.ctx.camera.position.x, v.py - this.ctx.camera.position.y, v.pz - this.ctx.camera.position.z);
            if (d < 900) this.killcam(victim);
          }
        }
        break;
      }
      default: break;
    }
  }

  // -------------------------------------------------------------------------
  // Commit
  // -------------------------------------------------------------------------

  private commit(ctx: GameContext, view: AircraftView, dt: number): void {
    const cam = ctx.camera;

    // Shake is applied in camera space so it reads as the *camera* being
    // knocked about rather than the world moving.
    _v.copy(this.shake.offset).applyQuaternion(this.wantQuat);
    cam.position.copy(this.wantPos).add(_v);

    // The smoothing filter runs on a *separate* orientation from the one the
    // camera ends up with. Feeding the shaken quaternion back into the filter
    // would integrate the shake, turning a 1.5° tremor into a slow wallow.
    if (this.snapNext) {
      // The springs were already placed by the rig through 'stepPos'/'stepLook';
      // all that is left here is the orientation filter.
      this.smoothQuat.copy(this.wantQuat);
      this.snapNext = false;
      this.snapping = false;
    } else {
      // A light orientation filter on top of the rigs removes the last of the
      // network jitter without adding perceptible lag.
      dampQuat(this.smoothQuat, this.wantQuat, 34, dt);
    }
    cam.quaternion.copy(this.smoothQuat);
    const a = this.shake.angles;
    if (a.lengthSq() > 1e-9) {
      _q.setFromEuler(_euler.set(a.x, a.y, a.z, 'ZYX'));
      cam.quaternion.multiply(_q);
    }

    this.applyProjection(ctx);

    // Keep the world matrices current: the input system projects the aim and
    // lead pippers to screen space in its lateUpdate, before the renderer has
    // had a chance to refresh them.
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();

    this.updateEffects(ctx, view);
  }

  /**
   * Writes the field of view and near plane onto the camera.
   *
   * Called twice a frame, deliberately. The settings UI also owns 'camera.fov'
   * — it is a slider with an immediate visual consequence — and it writes it
   * from its own 'update', which runs after ours. Re-asserting in 'lateUpdate'
   * (before the renderer, which is registered last) means the frame is drawn
   * with the rig's lens while the player's slider still sets the base. Both
   * writes are guarded, so the common case costs one float comparison.
   */
  private applyProjection(ctx: GameContext): void {
    const cam = ctx.camera;
    const fov = clamp(this.wantFov, 12, 110);
    if (Math.abs(cam.fov - fov) > 0.01 || Math.abs(cam.near - this.wantNear) > 1e-4 || cam.aspect !== this.aspect) {
      cam.fov = fov;
      cam.near = this.wantNear;
      cam.aspect = this.aspect;
      cam.updateProjectionMatrix();
    }
  }

  /**
   * The player's FOV preference relative to the 68° default.
   *
   * Applied to the two rigs the slider is actually about — the chase boom and
   * the cockpit — because someone who sets 100° wants a wider view *while
   * flying*. It is deliberately NOT applied to the gunsight, the orbit, the
   * fly-by, the kill-cam or the scripted framings: those lenses are
   * magnifications and compositions, not preferences. Scaling the gunsight by
   * the cockpit-FOV slider turns its 17° zoom into 25° for a player on 100° and
   * takes away the whole reason the mode exists.
   */
  private get fovScale(): number {
    return clamp(this.ctx.settings.fov / COCKPIT.baseFov, 0.55, 1.6);
  }

  private updateEffects(ctx: GameContext, view: AircraftView): void {
    const fx = this.effects;
    const cheap = ctx.quality === 'low';

    fx.fov = ctx.camera.fov;
    fx.shake = Math.min(1, this.shake.trauma + this.shake.sustained);

    if (view.valid) {
      fx.gEffect = view.gEffect;
      // Speed vignette: the frame tightens as the airframe approaches Vne.
      const speedT = smoothstep(0.55, 1.02, view.ias / Math.max(40, view.spec.aero.vne));
      // The g vignette is the dominant term — tunnel vision closes from the
      // periphery, so it is a vignette, not a fade.
      const gV = Math.abs(view.gEffect);
      fx.vignette = clamp(gV * 0.85 + speedT * 0.3, 0, 1);
      fx.radialBlur = cheap ? 0 : clamp(speedT * 0.55 + gV * 0.45 + fx.shake * 0.15, 0, 1);
      fx.motionBlur = clamp(0.6 + speedT * 0.8 + Math.abs(view.omega.length()) * 0.25, 0, 2);
      fx.chromatic = 1 + gV * 1.6 + speedT * 0.5;
    } else {
      fx.gEffect = 0;
      fx.vignette = 0;
      fx.radialBlur = 0;
      fx.motionBlur = 0.6;
      fx.chromatic = 1;
    }

    // Blur centre: the vanishing point of the flight path, which is where the
    // eye is looking, so the sharp region lands where it should.
    if (view.valid && this.input?.aimOnScreen) {
      fx.blurCenterX = this.input.aimScreen.x * 0.6;
      fx.blurCenterY = this.input.aimScreen.y * 0.6;
    } else {
      fx.blurCenterX = 0;
      fx.blurCenterY = 0;
    }

    if (this.mode !== 'killcam') {
      fx.timeScale = 1;
      fx.desaturate = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface GameEventPayload {
  kind: EventKind;
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  scale: number; a: number; b: number;
}

const _euler = new THREE.Euler();

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clampSym = (v: number, lim = 1) => (v < -lim ? -lim : v > lim ? lim : v);
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

function hash01(n: number): number {
  let h = Math.imul(n | 0, 374761393);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Finds a spot on the map that matches a biome hint, for the framings that need
 * one when no aircraft is spawned. A coarse spiral sample is plenty — this runs
 * once per framing change, never per frame.
 */
/**
 * Moves a shot altitude out of the cumulus deck it would otherwise sit inside.
 *
 * Framing altitudes and weather presets are authored independently, so it is
 * easy for the two to collide — and an aeroplane *inside* a volumetric deck is
 * not a moody shot, it is a grey rectangle with a wing in it. Three of the ten
 * framings were landing in the middle of their own weather.
 *
 * The correction moves to whichever face of the deck is nearer, which preserves
 * the author's intent without needing a per-framing exception: a shot composed
 * below the base stays below it with cloud overhead, and one composed high in
 * the deck ends up skimming the tops, which is what those shots are about.
 */
/**
 * Where the *visible* top of a cumulus deck actually is, as a fraction of the
 * authored slab depth.
 *
 * 'cloudBase + cloudDepth' is the raymarcher's ceiling — the highest altitude it
 * will ever find density at — not the surface you can see. VolumetricClouds
 * gives every column its own convection height, 'base + depth × hScale' with
 * hScale between 0.40 and 1.00 (sampleWeather), and then thins what is left with
 * a density profile that falls off toward the top of the slab. Averaged over a
 * field, the surface a camera reads as "the cloud tops" sits around three
 * quarters of the way up — and measured against what the camera actually sees,
 * rather less: the density profile takes the last of it out, so the surface that
 * reads as "the tops" sits a bit over four tenths of the way into the slab.
 * Shot at 0.76 the aeroplane was still in clear air with the field a distant
 * white smudge; 0.42 puts it on the towers. This is a rendering constant, not an
 * art choice, and if VolumetricClouds' height gradient changes it moves with it.
 *
 * Composing against the ceiling instead put the cloud framing a kilometre and a
 * half of empty air above the cloudscape, which is precisely the "aeroplane
 * floating beside the cloud rather than interacting with it" the critique named.
 */
const DECK_TOP_FRACTION = 0.42;

function clearOfCloudDeck(y: number, weather: { coverage: number; cloudBase: number; cloudDepth: number }): number {
  const base = weather.cloudBase;
  const top = base + weather.cloudDepth;
  // Thin scattered cloud is not opaque enough to ruin a frame.
  if (weather.coverage < 0.18 || y <= base || y >= top) return y;
  // Enough to be clearly outside the deck rather than grazing its boundary,
  // where the density falloff still fogs the shot.
  const margin = 260;
  return y - base < top - y ? base - margin : top + margin;
}

/**
 * Picks a place on the map that matches a biome hint.
 *
 * 'viewAz' is the compass bearing the camera will be *looking along*, and for
 * the two maritime biomes it is not optional flavour — it is most of the
 * answer. A sun-locked framing has no freedom left in where the lens points, so
 * "somewhere with water under it" is not a specification: stand a shot on the
 * wrong side of a headland and a sea framing photographs a field. Scoring the
 * candidate along the actual view direction is what turns "there is water
 * nearby" into "there is water in the picture".
 */
function findAnchorSite(biome: string | undefined, viewAz = 0): { x: number; z: number } {
  if (!biome) return { x: 900, z: -1400 };
  const vx = Math.sin(viewAz), vz = Math.cos(viewAz);
  let best = { x: 900, z: -1400 };
  let bestScore = -Infinity;
  const R = 22000;
  for (let i = 0; i < 512; i++) {
    // Golden-angle spiral: uniform coverage without a grid's directional bias.
    const t = i / 512;
    const r = Math.sqrt(t) * R;
    const a = i * 2.39996;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = terrainHeightAt(x, z);
    let score: number;
    switch (biome) {
      case 'water': score = h < 0 ? 100 - Math.abs(h + 40) * 0.1 : -Math.abs(h); break;
      /**
       * Offshore, with a *straight* shore beside it.
       *
       * Scoring 'coast' as "height nearest zero" put the camera exactly on the
       * waterline of whatever the search found first, and what the generator
       * makes most of is small radially-falling islands — hence the perfect
       * circular beach arc across the bottom of the water frame, a shape no real
       * coastline has. Requiring deep water under the anchor and along the first
       * three kilometres of the view, with land only beyond six, selects a
       * genuine open-sea station looking at a distant shore: sea in the lower
       * two thirds, a coastline as a straight receding edge near the horizon,
       * and nothing in between for the sun's specular track to run over.
       *
       * The second half of that test is why it takes a view bearing at all. The
       * first version scored the surrounding compass instead, found a perfectly
       * respectable shoreline, and then — because the framing is sun-locked and
       * cannot turn — pointed the camera at the land side of it. Both the water
       * and sunset frames came back as photographs of a field.
       */
      case 'coast': {
        // Standing over water…
        if (h > -6 || h < -170) { score = -1000; break; }
        const along = (d: number) => terrainHeightAt(x + vx * d, z + vz * d);
        // …with open sea for the first few kilometres of the shot, so the whole
        // lower half of the frame is water and the glitter path has room to run…
        if (along(700) > -4 || along(1900) > -4 || along(3400) > -4) { score = -800; break; }
        // …and a coast standing across the far third, which is the difference
        // between "the sea" and "an empty blue rectangle".
        const far = Math.max(along(6500), along(9000), along(12000));
        score = far > 8 ? 100 - Math.abs(h + 70) * 0.25 : -300;
        break;
      }
      case 'hills': score = h > 60 ? h : -100; break;
      case 'airfield':
      case 'farmland': score = h > 5 && h < 140 ? 100 - Math.abs(h - 60) : -100; break;
      default: score = 0; break;
    }
    // Prefer sites near the middle of the map so the terrain around them is
    // fully streamed in.
    score -= r * 0.002;
    if (score > bestScore) { bestScore = score; best = { x, z }; }
  }
  return best;
}

/**
 * Widens a framing's weather directive into the union of the field names the
 * subsystems that consume it actually look for.
 *
 * Allocates — deliberately: this runs once per framing change, from a debug
 * entry point, and a shared mutable payload broadcast on a bus is a much worse
 * idea than one object.
 */
function weatherPayload(w: WeatherDirective, windFrom: number): Record<string, number> {
  // Humidity from the deck: a sky at 80 % cover with 2.6 km of vertical
  // development is saturated, a thin scattered day is not. Contrails and
  // wingtip vortices key off this.
  const humidity = clamp(0.25 + w.coverage * 0.9 + (w.haze - 0.5) * 0.25, 0, 1.4);
  // Wind blows *across* the shot rather than along it, so a smoke trail lies
  // down visibly instead of trailing straight back down the boom.
  const az = windFrom + Math.PI * 0.5;
  return {
    coverage: w.coverage, cloudBase: w.cloudBase, cloudDepth: w.cloudDepth,
    haze: w.haze, turbidity: w.turbidity, windSpeed: w.windSpeed,
    rain: w.rain,
    humidity,
    windX: Math.sin(az) * w.windSpeed,
    windY: 0,
    windZ: Math.cos(az) * w.windSpeed,
  };
}

/** The two scene nodes the cockpit rig needs from a built aircraft model. */
interface CockpitRig {
  /** The model's own eye anchor — an empty at the pilot's eye, in body space. */
  eye: THREE.Object3D;
  /** The node body space is expressed relative to. */
  root: THREE.Object3D;
}

/**
 * Best-effort lookup of an aircraft model's published cockpit anchor.
 *
 * The model builder emits an 'eyePoint' empty at the exact position it seated
 * the pilot's eye, which is the only authoritative answer: deriving one from
 * the pilot mesh's bounding box (what this used to do) is off by however much
 * the arms and thighs skew the box, and deriving one from the canopy numbers is
 * off by whatever the builder's own seat placement differs by. Duck-typed
 * because the entity subsystem is authored separately; a miss falls through to
 * the canopy estimate rather than failing.
 */
function findCockpitRig(ctx: GameContext, entityId: number): CockpitRig | null {
  const bag = (name: string) => ctx.get(name) as unknown as Record<string, unknown> | undefined;
  for (const sysName of ['entities', 'entity', 'aircraft']) {
    const sys = bag(sysName);
    if (!sys) continue;
    for (const fn of ['modelFor', 'getModel', 'model', 'viewFor']) {
      const f = sys[fn];
      if (typeof f !== 'function') continue;
      try {
        const r = (f as (id: number) => unknown).call(sys, entityId) as Record<string, unknown> | undefined;
        if (!r) continue;
        // 'viewFor' hands back a view wrapping the model; 'modelFor' the model.
        const m = (r['model'] as Record<string, unknown> | undefined) ?? r;
        const eye = m['eyePoint'] as THREE.Object3D | undefined;
        const root = (m['root'] as THREE.Object3D | undefined) ?? eye?.parent ?? undefined;
        if (eye?.isObject3D && root?.isObject3D) return { eye, root };
      } catch { /* wrong signature — try the next candidate */ }
    }
  }
  return null;
}

