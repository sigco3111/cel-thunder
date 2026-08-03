import * as THREE from 'three';
import type { GameContext, Subsystem } from './context';
import { InputBits, type InputFrame } from '../shared/protocol';

import { BindingSet, type Action } from './input/bindings';
import { Keyboard } from './input/Keyboard';
import { Mouse } from './input/Mouse';
import { Gamepad_ } from './input/Gamepad';
import {
  applyCurve, approach, clamp01, clampSym, damp, defaultCurve, mouseAccel, type AxisCurve,
} from './input/curves';
import { AircraftViewTracker, discoverTerrainSampler, type AircraftView } from './input/aircraftView';
import { MouseAimController, DEFAULT_MOUSE_AIM } from './input/MouseAimController';
import { TargetTracker, type TrackedTarget } from './input/targeting';
import {
  BallisticTable, newLeadSolution, primaryGun, solveLead, type LeadSolution,
} from './input/ballistics';

/**
 * The control layer: devices in, one 'InputFrame' per rendered frame out, plus
 * the aiming state the HUD and the camera rigs read.
 *
 * Four control schemes share one pipeline:
 *
 *   **mouse-aim**  the default. The mouse positions a reticle and a flight
 *                  director flies the aircraft onto it (see MouseAimController).
 *   **realistic**  the mouse becomes a virtual joystick with absolute position;
 *                  axes go straight to the control surfaces, no assistance.
 *   **keyboard**   digital axes with a ramp, usable on a laptop with no mouse.
 *   **gamepad**    analogue sticks with dead zones and a response curve.
 *
 * The *device* is detected automatically (whatever moved last wins, with
 * hysteresis so a bumped mouse does not steal control mid-turn); the *scheme*
 * is a deliberate player choice, cycled with 'O', because switching a player
 * from assisted to manual without them asking is a crash.
 *
 * Frame timing: 'update()' runs before the camera, so the flight director acts
 * on this frame's input. 'lateUpdate()' runs after the camera has been posed,
 * which is when the aim and lead points can be projected to screen space for
 * the HUD without a frame of lag.
 */

export type ControlScheme = 'mouse' | 'realistic';
export type ActiveDevice = 'mouse' | 'keyboard' | 'gamepad';

const FLAP_STOPS = [0, 0.35, 0.7, 1];

const _v = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _proj = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();

export class InputSystem implements Subsystem {
  readonly name = 'input';

  // --- devices -------------------------------------------------------------
  readonly keyboard = new Keyboard();
  readonly mouse = new Mouse();
  readonly gamepad = new Gamepad_();
  readonly bindings = BindingSet.load();

  // --- schemes -------------------------------------------------------------
  scheme: ControlScheme = 'mouse';
  device: ActiveDevice = 'mouse';

  // --- controllers ---------------------------------------------------------
  readonly aim = new MouseAimController();
  readonly tracker = new AircraftViewTracker();
  readonly targets = new TargetTracker();
  readonly ballistics = new BallisticTable();
  readonly lead: LeadSolution = newLeadSolution();

  /** The frame produced this tick. Read by the flight subsystem for prediction. */
  readonly frame: InputFrame = {
    seq: 0, dt: 0, pitch: 0, roll: 0, yaw: 0, throttle: 0, bits: 0, aimX: 0, aimY: 0,
  };

  // --- exposed aiming state (HUD) -----------------------------------------
  /** Reticle direction in world space. */
  readonly aimDir = new THREE.Vector3(0, 0, 1);
  /** A world point on the reticle line, at the current target range. */
  readonly aimPoint = new THREE.Vector3();
  /** Reticle in normalised device coords, [-1,1]. 'aimOnScreen' says if it is visible. */
  readonly aimScreen = new THREE.Vector2();
  aimOnScreen = false;
  /** Lead pipper in normalised device coords. */
  readonly leadScreen = new THREE.Vector2();
  leadOnScreen = false;
  /** Where the guns actually are, world space — the origin of the lead solution. */
  readonly muzzlePoint = new THREE.Vector3();

  /** Raw (accelerated) mouse delta this frame, before any consumer claims it. */
  mouseDx = 0;
  mouseDy = 0;
  /**
   * Set by the camera when a rig needs the mouse for itself (the free orbit).
   * While true the reticle is frozen and the mouse drives the camera instead.
   */
  cameraOwnsMouse = false;

  /** Free-look request from the player: mouse delta while the look key is held. */
  lookDx = 0;
  lookDy = 0;
  lookActive = false;
  /** Wheel notches this frame, for camera zoom / distance. */
  zoomDelta = 0;
  /** True while the player is holding the zoom (gunsight magnification) key. */
  zoomHeld = false;

  // --- airframe mirror (for the HUD; the server remains authoritative) ------
  throttle = 0;
  wep = false;
  gearDown = true;
  flapIndex = 0;
  radiator = true;
  airbrake = false;
  wheelBrake = false;
  trimPitch = 0;
  trimRoll = 0;
  trimYaw = 0;
  bailProgress = 0;

  /** Suppressed while a modal (chat, map, menu) owns the input. */
  suspended = false;

  // --- tuning --------------------------------------------------------------
  /** Positional sticks: the virtual joystick and the gamepad. Expo belongs here. */
  stickCurve: AxisCurve = defaultCurve({ deadzone: 0.0, expo: 0.35 });
  /**
   * Digital (keyboard) axes.
   *
   * Almost linear, and deliberately so. Expo exists to give a *positional*
   * control fine authority near centre — but a keyboard axis has no position:
   * its travel is already generated by the slew rate in 'updateAxes', which is
   * the analogue element. Running the ramp through a cubic as well squares the
   * softness, so the first third of a key press produced under a tenth of the
   * available deflection and the aeroplane simply did not respond to the
   * beginning of an input.
   */
  keyCurve: AxisCurve = defaultCurve({ deadzone: 0.0, expo: 0.12 });
  /** Virtual-joystick sensitivity for the realistic scheme, screens per unit. */
  virtualStickSens = 1.9;
  /** Rate at which the virtual joystick self-centres, per second. 0 = never. */
  virtualStickReturn = 0;
  /**
   * The wire 'InputFrame' has no trim channel, so trim is added to the axis
   * commands here — which is physically what a trim tab does, and keeps the
   * server's view of the controls identical to the client's. Set false if the
   * flight subsystem starts driving 'adjustTrim()' from 'trimPitch/Roll/Yaw'
   * instead, or the trim would be applied twice.
   */
  foldTrimIntoAxes = true;

  private ctx!: GameContext;
  private canvas: HTMLElement | null = null;

  private codes = new Set<string>();
  private prevCodes = new Set<string>();
  private holdSince = new Map<Action, number>();

  private keyPitch = 0;
  private keyRoll = 0;
  private keyYaw = 0;
  private stickX = 0;   // virtual joystick, realistic scheme
  private stickY = 0;

  private mouseDrain = { dx: 0, dy: 0, wheel: 0 };
  private wireAim = { x: 0, y: 0 };
  private lastDeviceActivity = { mouse: 0, keyboard: 0, gamepad: 0 };
  private pulseBits = 0;
  private unsubs: Array<() => void> = [];

  // -------------------------------------------------------------------------

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.canvas = ctx.renderer.domElement;

    this.aim.cfg = { ...DEFAULT_MOUSE_AIM, invertY: ctx.settings.invertY };

    this.keyboard.attach();
    this.mouse.attach(this.canvas);
    this.gamepad.attach();
    this.mouse.setCaptureDesired(true);

    discoverTerrainSampler(ctx);

    // Restore the player's scheme choice; mouse aim is the default for anyone
    // who has never touched the setting.
    const saved = safeGet('celthunder.scheme');
    if (saved === 'realistic' || saved === 'mouse') this.scheme = saved;

    this.unsubs.push(
      ctx.bus.on('net:spawned', () => this.onSpawn()),
      ctx.bus.on('ui:modal', (open: unknown) => this.setSuspended(!!open)),
      ctx.bus.on('input:setScheme', (s: unknown) => {
        if (s === 'mouse' || s === 'realistic') this.setScheme(s);
      }),
      // Emitted from inside the click handler that deploys the player. Pointer
      // lock may only be requested during a user gesture, and "Deploy" is the
      // last gesture before the player is in the air — so taking the capture
      // there means the mouse is already the aircraft's the instant it exists,
      // instead of the player spawning uncaptured and having to discover a
      // second, separate click they were never told about.
      ctx.bus.on('input:captureMouse', () => this.mouse.requestLock()),
      ctx.bus.on('controls:changed', (p: unknown) => this.applyControlPrefs(p)),
    );
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.keyboard.detach();
    this.mouse.detach();
    this.gamepad.detach();
  }

  // -------------------------------------------------------------------------

  private onSpawn(): void {
    this.tracker.reset();
    this.targets.clear();
    this.throttle = 1;
    this.gearDown = false;
    this.flapIndex = 0;
    this.trimPitch = this.trimRoll = this.trimYaw = 0;
    this.bailProgress = 0;
    // Defer the reticle reset until the view has a valid orientation.
    this.pendingAimReset = true;
    // ...and stop the stale cursor position from immediately undoing it.
    this.mouse.releaseAbsoluteAim();
  }
  private pendingAimReset = true;

  /**
   * Re-seats the reticle on the nose and clears the flight director's
   * integrators. Call after anything that teleports or re-attitudes the
   * aircraft, or the director will read the discontinuity as a huge pointing
   * error and haul the aeroplane round to "correct" it.
   */
  resetAim(): void { this.pendingAimReset = true; }

  /**
   * Applies the settings panel's control preferences to the live controller.
   *
   * Before this existed, 'controls:changed' had no subscriber anywhere in the
   * codebase: the Control mode selector and the Invert vertical axis toggle
   * were both inert, and 'invertY' was read exactly once, at 'init', from a
   * 'ctx.settings' the UI had not necessarily populated yet.
   *
   * The first event is recorded rather than applied. It arrives during boot,
   * carrying whatever mode is stored in the UI's own preferences, and applying
   * it would overwrite the scheme the player last chose with the 'O' key —
   * which is persisted separately, under 'celthunder.scheme'.
   */
  private lastControlMode: string | null = null;
  private applyControlPrefs(raw: unknown): void {
    const p = raw as { mode?: string; assists?: string; invertY?: boolean } | null;
    if (!p) return;
    if (typeof p.invertY === 'boolean') this.aim.cfg.invertY = p.invertY;
    if (typeof p.assists === 'string') this.applyAssists(p.assists);

    const mode = p.mode;
    if (typeof mode !== 'string') return;
    const first = this.lastControlMode === null;
    const changed = this.lastControlMode !== mode;
    this.lastControlMode = mode;
    if (first || !changed) return;
    this.setScheme(mode === 'mouse-aim' || mode === 'instructor' ? 'mouse' : 'realistic');
  }

  /**
   * The beginner protections, as one switch.
   *
   * Arcade is the shipped default and every one of these is why: the g limiter
   * stops a novice pulling the wings off, the stall guard withholds the last of
   * the elevator before the buffet instead of letting them ride it into a spin,
   * the auto-rudder keeps the ball centred (uncoordinated flight is the main
   * reason a beginner's shots miss), the wings self-level whenever no turn is
   * demanded, and the reticle relaxes back to the horizon when the player takes
   * their hand off the mouse — which together are what make "let go of the
   * controls" a valid recovery from any attitude, the single most important
   * property a first flight can have.
   *
   * Realistic hands all of it back. It is a deliberate choice, never a default.
   */
  private applyAssists(level: string): void {
    const arcade = level !== 'realistic';
    const cfg = this.aim.cfg;
    cfg.instructor = arcade;
    cfg.coordination = arcade ? DEFAULT_MOUSE_AIM.coordination : 0;
    cfg.levelAssist = arcade ? DEFAULT_MOUSE_AIM.levelAssist : 0;
    cfg.levelOff = arcade ? DEFAULT_MOUSE_AIM.levelOff : 0;
    cfg.gLimitFactor = arcade ? DEFAULT_MOUSE_AIM.gLimitFactor : 1.05;
    cfg.stallMargin = arcade ? DEFAULT_MOUSE_AIM.stallMargin : 1.0;
  }

  setScheme(s: ControlScheme): void {
    if (this.scheme === s) return;
    this.scheme = s;
    this.stickX = 0; this.stickY = 0;
    this.pendingAimReset = true;
    safeSet('celthunder.scheme', s);
    this.ctx.bus.emit('input:scheme', s);
  }

  setSuspended(v: boolean): void {
    if (this.suspended === v) return;
    this.suspended = v;
    this.mouse.setCaptureDesired(!v);
    if (v) this.codes.clear();
  }

  // -------------------------------------------------------------------------

  update(ctx: GameContext): void {
    const dt = Math.max(1e-4, ctx.dt);

    this.gamepad.poll(dt);
    this.mouse.drain(this.mouseDrain);
    this.zoomDelta = this.mouseDrain.wheel;
    this.mouseDx = mouseAccel(this.mouseDrain.dx, dt, this.aim.cfg.accel);
    this.mouseDy = mouseAccel(this.mouseDrain.dy, dt, this.aim.cfg.accel);

    this.collectCodes();
    this.pickDevice(dt);

    const view = this.tracker.update(ctx, dt);
    if (this.pendingAimReset && view.valid) { this.aim.reset(view); this.pendingAimReset = false; }

    this.handleDiscreteActions(ctx, view, dt);
    this.updateThrottle(dt);
    this.updateAxes(view, dt);

    // Aim + gunnery, then the control solution.
    this.updateAiming(ctx, view, dt);
    this.buildFrame(ctx, view, dt);

    // Roll the edge buffers over for the next frame.
    this.prevCodes.clear();
    for (const c of this.codes) this.prevCodes.add(c);
    this.keyboard.clearTaps();
    this.pulseBits = 0;
  }

  /** Projection happens after the camera has been posed for this frame. */
  lateUpdate(ctx: GameContext): void {
    const cam = ctx.camera;
    if (!this.tracker.view.valid) {
      this.aimOnScreen = false;
      this.leadOnScreen = false;
      return;
    }
    this.aimOnScreen = projectToScreen(this.aimPoint, cam, this.aimScreen);
    if (this.lead.valid) {
      this.leadOnScreen = projectToScreen(this.lead.point, cam, this.leadScreen);
    } else {
      this.leadOnScreen = false;
    }
  }

  // -------------------------------------------------------------------------
  // Device arbitration
  // -------------------------------------------------------------------------

  private collectCodes(): void {
    this.codes.clear();
    if (this.suspended) return;
    for (const c of this.keyboard.codes) this.codes.add(c);
    // Sub-frame taps, so a quick stab at the gear lever is never swallowed.
    for (const c of this.keyboard.tapped) this.codes.add(c);
    for (const c of this.mouse.codes) this.codes.add(c);
    for (const c of this.gamepad.codes) this.codes.add(c);
  }

  private pickDevice(dt: number): void {
    const a = this.lastDeviceActivity;
    a.mouse = Math.max(0, a.mouse - dt);
    a.keyboard = Math.max(0, a.keyboard - dt);
    a.gamepad = Math.max(0, a.gamepad - dt);

    if (Math.abs(this.mouseDrain.dx) + Math.abs(this.mouseDrain.dy) > 0.5) a.mouse = 2.0;
    if (this.keyPitch !== 0 || this.keyRoll !== 0 || this.keyYaw !== 0) a.keyboard = 1.2;
    if (this.gamepad.activity > 0) a.gamepad = 2.0;

    // Hysteresis: the current device keeps a bonus so a stray input from
    // another device cannot take over mid-manoeuvre.
    const cur = a[this.device] + 0.9;
    let best: ActiveDevice = this.device;
    let bestV = cur;
    for (const d of ['mouse', 'keyboard', 'gamepad'] as ActiveDevice[]) {
      if (a[d] > bestV) { bestV = a[d]; best = d; }
    }
    if (best !== this.device) {
      this.device = best;
      this.ctx.bus.emit('input:device', best);
    }
  }

  // -------------------------------------------------------------------------
  // Binding queries
  // -------------------------------------------------------------------------

  down(a: Action): boolean {
    for (const c of this.bindings.codesFor(a)) if (this.codes.has(c)) return true;
    return false;
  }

  private wasDown(a: Action): boolean {
    for (const c of this.bindings.codesFor(a)) if (this.prevCodes.has(c)) return true;
    return false;
  }

  pressed(a: Action): boolean { return this.down(a) && !this.wasDown(a); }
  released(a: Action): boolean { return !this.down(a) && this.wasDown(a); }

  /** Seconds the action has been continuously held, 0 if not held. */
  heldFor(a: Action, now: number): number {
    const t = this.holdSince.get(a);
    return t === undefined ? 0 : now - t;
  }

  private trackHold(a: Action, now: number): void {
    if (this.down(a)) { if (!this.holdSince.has(a)) this.holdSince.set(a, now); }
    else this.holdSince.delete(a);
  }

  // -------------------------------------------------------------------------
  // Discrete actions
  // -------------------------------------------------------------------------

  private handleDiscreteActions(ctx: GameContext, view: AircraftView, dt: number): void {
    const now = ctx.time;
    this.trackHold('bail', now);
    this.trackHold('freeLook', now);

    // -- view -------------------------------------------------------------
    this.lookActive = this.down('freeLook');
    this.zoomHeld = this.down('zoom');
    if (this.lookActive) {
      this.lookDx = this.mouseDx;
      this.lookDy = this.mouseDy;
    } else {
      this.lookDx = 0; this.lookDy = 0;
    }
    if (this.gamepad.connected && (this.gamepad.lookX !== 0 || this.gamepad.lookY !== 0)) {
      this.lookActive = true;
      this.lookDx += this.gamepad.lookX * 900 * dt;
      this.lookDy -= this.gamepad.lookY * 900 * dt;
    }

    if (this.pressed('cameraCycle')) ctx.bus.emit('input:cameraCycle');
    if (this.pressed('map')) ctx.bus.emit('input:map');
    if (this.pressed('chat')) ctx.bus.emit('input:chat');
    if (this.pressed('toggleHud')) {
      ctx.settings.showHud = !ctx.settings.showHud;
      ctx.bus.emit('ui:showHud', ctx.settings.showHud);
    }
    if (this.pressed('toggleControls')) ctx.bus.emit('input:toggleControls');
    if (this.pressed('controlModeCycle')) this.setScheme(this.scheme === 'mouse' ? 'realistic' : 'mouse');

    // -- targeting --------------------------------------------------------
    if (this.pressed('targetCycle')) this.targets.cycle(ctx, view);
    if (this.pressed('targetClear')) this.targets.releaseManual();

    // -- airframe ---------------------------------------------------------
    if (this.pressed('gear')) {
      this.gearDown = !this.gearDown;
      this.pulseBits |= InputBits.GearToggle;
      ctx.bus.emit('input:gear', this.gearDown);
    }
    if (this.pressed('flaps')) {
      this.flapIndex = (this.flapIndex + 1) % FLAP_STOPS.length;
      this.pulseBits |= InputBits.FlapsDown;
      ctx.bus.emit('input:flaps', FLAP_STOPS[this.flapIndex]);
    }
    if (this.pressed('flapsUp')) {
      this.flapIndex = Math.max(0, this.flapIndex - 1);
      this.pulseBits |= InputBits.FlapsUp;
      ctx.bus.emit('input:flaps', FLAP_STOPS[this.flapIndex]);
    }
    if (this.pressed('radiator')) {
      this.radiator = !this.radiator;
      this.pulseBits |= InputBits.Radiator;
    }
    this.airbrake = this.down('airbrake');
    this.wheelBrake = this.down('wheelBrake');
    this.wep = this.down('wep');

    // -- ordnance ---------------------------------------------------------
    if (this.pressed('bombs')) this.pulseBits |= InputBits.DropBomb;
    if (this.pressed('rockets')) this.pulseBits |= InputBits.FireRocket;

    // -- trim: a held key walks the trim, exactly like a real trim wheel ---
    const trimRate = 0.16;
    if (this.down('trimNoseUp')) this.trimPitch = clampSym(this.trimPitch + trimRate * dt);
    if (this.down('trimNoseDown')) this.trimPitch = clampSym(this.trimPitch - trimRate * dt);
    if (this.down('trimRight')) this.trimRoll = clampSym(this.trimRoll + trimRate * dt);
    if (this.down('trimLeft')) this.trimRoll = clampSym(this.trimRoll - trimRate * dt);
    if (this.down('trimYawRight')) this.trimYaw = clampSym(this.trimYaw + trimRate * dt);
    if (this.down('trimYawLeft')) this.trimYaw = clampSym(this.trimYaw - trimRate * dt);
    if (this.pressed('trimReset')) { this.trimPitch = this.trimRoll = this.trimYaw = 0; }
    this.trimPitch = Math.max(-0.4, Math.min(0.4, this.trimPitch));
    this.trimRoll = Math.max(-0.3, Math.min(0.3, this.trimRoll));
    this.trimYaw = Math.max(-0.3, Math.min(0.3, this.trimYaw));

    // -- bail out: deliberately a long hold, because it is irreversible ---
    const bailHeld = this.heldFor('bail', now);
    const target = bailHeld > 0 ? clamp01(bailHeld / 1.5) : 0;
    this.bailProgress = bailHeld > 0 ? target : damp(this.bailProgress, 0, 8, dt);
    if (this.bailProgress > 0.02) ctx.bus.emit('input:bailProgress', this.bailProgress);
  }

  private updateThrottle(dt: number): void {
    const rate = 0.55;
    if (this.down('throttleUp')) this.throttle = clamp01(this.throttle + rate * dt);
    if (this.down('throttleDown')) this.throttle = clamp01(this.throttle - rate * dt);
    if (this.pressed('throttleMax')) this.throttle = 1;
    if (this.pressed('throttleIdle')) this.throttle = 0;
    if (this.device === 'gamepad' && Math.abs(this.gamepad.throttleRate) > 0.05) {
      this.throttle = clamp01(this.throttle + this.gamepad.throttleRate * rate * 1.4 * dt);
    }
  }

  // -------------------------------------------------------------------------
  // Axes
  // -------------------------------------------------------------------------

  private updateAxes(view: AircraftView, dt: number): void {
    // Digital axes ramp in rather than snapping: a keyboard player who taps
    // "roll left" should get a nudge, not an instant half-roll. The return to
    // centre is faster than the deflection, which is what makes the aircraft
    // feel like it has springs in the controls.
    //
    // The rates matter far more than the shape does. 'approach' is a *linear*
    // slew, so a rate of 3.4 meant 1 / 3.4 = 294 ms of travel before the stick
    // was even at the stop — measured, that was the single largest term in the
    // control latency, dwarfing every frame of pipeline lag put together, and
    // it is what made the controls feel like they were connected through
    // treacle. These rates put full deflection ~110-135 ms out, which still
    // reads as an analogue control rather than a switch, and returns to centre
    // in half that so the aeroplane stops when the player lets go.
    const kp = (this.down('pitchUp') ? 1 : 0) - (this.down('pitchDown') ? 1 : 0);
    const kr = (this.down('rollRight') ? 1 : 0) - (this.down('rollLeft') ? 1 : 0);
    const ky = (this.down('yawRight') ? 1 : 0) - (this.down('yawLeft') ? 1 : 0);
    this.keyPitch = digitalAxis(this.keyPitch, kp, BITE_PITCH, 7.5, 13, dt);
    this.keyRoll = digitalAxis(this.keyRoll, kr, BITE_ROLL, 11.0, 16, dt);
    this.keyYaw = digitalAxis(this.keyYaw, ky, BITE_YAW, 8.0, 14, dt);

    // Virtual joystick for the realistic scheme. Position is absolute and does
    // not self-centre by default — that is the whole point of "full real": the
    // stick stays where you put it and you fly the aircraft out of the turn.
    if (this.scheme === 'realistic' && this.device === 'mouse' && !this.lookActive && !this.cameraOwnsMouse) {
      const s = this.virtualStickSens * this.ctx.settings.mouseSensitivity / 900;
      this.stickX = clampSym(this.stickX + this.mouseDx * s);
      this.stickY = clampSym(this.stickY - this.mouseDy * s * (this.aim.cfg.invertY ? -1 : 1));
      if (this.virtualStickReturn > 0) {
        this.stickX = damp(this.stickX, 0, this.virtualStickReturn, dt);
        this.stickY = damp(this.stickY, 0, this.virtualStickReturn, dt);
      }
    }
    void view;
  }

  /** Direct (non-assisted) axis values from whichever device is live. */
  /**
   * The player's stick, in the flight model's sign convention.
   *
   * ## Why roll and yaw are negated
   *
   * The model's body frame is documented as "+X right wing, +Y up, +Z forward,
   * right-handed". Those three cannot all be true: X-right / Y-up / Z-forward
   * is the *left*-handed convention, and a rotation cannot change handedness,
   * so once that frame is placed in three.js's right-handed world the body +X
   * axis comes out on the **left** of the screen. Measured, not assumed: with
   * the chase camera looking straight down the nose, body +X dotted with the
   * camera's screen-right axis is −0.999.
   *
   * Everything inside the model is self-consistent, so this is invisible until
   * a *player-facing* word meets the screen — and then it is glaring: "roll
   * right" banked the aeroplane to the left and turned it left. Mirroring
   * flips roll and yaw and leaves pitch alone, which is exactly the two axes
   * corrected here.
   *
   * This is the one place the pilot's intent becomes model input (the mouse
   * director already works in measured screen axes and needs no correction),
   * so it is the one place the correction belongs.
   */
  private manualAxes(out: { pitch: number; roll: number; yaw: number }): void {
    if (this.device === 'gamepad' && this.gamepad.connected) {
      out.pitch = this.gamepad.pitch;
      out.roll = -this.gamepad.roll;
      out.yaw = -this.gamepad.yaw;
      return;
    }
    out.pitch = applyCurve(this.keyPitch, this.keyCurve);
    out.roll = -applyCurve(this.keyRoll, this.keyCurve);
    out.yaw = -applyCurve(this.keyYaw, this.keyCurve);
  }

  private axisScratch = { pitch: 0, roll: 0, yaw: 0 };

  // -------------------------------------------------------------------------
  // Aiming + gunnery
  // -------------------------------------------------------------------------

  private updateAiming(ctx: GameContext, view: AircraftView, dt: number): void {
    const target = this.targets.update(ctx, view, dt);

    if (!view.valid) {
      this.lead.valid = false;
      return;
    }

    // Screen basis for the reticle. The camera is one frame stale here, which
    // at 60 Hz is 16 ms of a rig that is itself spring-damped — invisible.
    ctx.camera.matrixWorld.extractBasis(_camRight, _camUp, _v);

    const mouseFree = !this.lookActive && !this.suspended && !this.cameraOwnsMouse;
    const mouseAim = this.scheme === 'mouse' && this.device !== 'gamepad' && mouseFree;
    if (mouseAim && this.mouse.locked) {
      this.aim.steer(this.mouseDx, this.mouseDy, _camRight, _camUp, ctx.settings.mouseSensitivity);
    } else if (mouseAim && this.mouse.lockDenied && this.mouse.movedUnlocked) {
      // Fallback for a browser that has refused pointer lock outright. There
      // are no unbounded deltas to integrate without a capture, so the absolute
      // cursor is mapped through the aim cone instead: the canvas edge is the
      // cone edge, which is the only mapping that stays consistent if a later
      // click does succeed and the relative path takes over. It is a worse way
      // to fly than a captured mouse, and it is only reached when there is no
      // captured mouse to be had — see 'Mouse.lockDenied'.
      this.aim.fromWireAim(view, this.mouse.nx, this.mouse.ny, _camRight, _camUp);
    } else if (mouseAim) {
      // Capture is available but not held: between the spawn and the player's
      // first click, or any time they have pressed Escape. The cursor's position
      // is not a command — it is wherever the OS happened to leave the arrow —
      // so the director parks the reticle on the nose and the aeroplane holds
      // its attitude instead of flying at the corner of the screen.
      this.aim.holdBoresight(view);
    } else if (this.scheme === 'mouse' && this.device === 'gamepad' && !this.lookActive) {
      // On a pad the right stick is the rudder, so the reticle is driven by the
      // left stick as a *rate*: hold it over and the reticle sweeps.
      this.aim.steerAnalogue(this.gamepad.roll, this.gamepad.pitch, _camRight, _camUp, 1.5, dt);
    }

    // -- gun position and the ballistic solution ---------------------------
    const gun = primaryGun(view.spec.guns);
    _muzzle.copy(view.pos);
    if (gun && gun.mounts.length) {
      // Average the battery: the convergence point of six wing guns is a better
      // origin than any single barrel, and it is what the sight is harmonised to.
      let mx = 0, my = 0, mz = 0;
      for (const m of gun.mounts) { mx += m[0]; my += m[1]; mz += m[2]; }
      const inv = 1 / gun.mounts.length;
      _v.set(mx * inv, my * inv, mz * inv).applyQuaternion(view.quat);
      _muzzle.add(_v);
    }
    this.muzzlePoint.copy(_muzzle);

    if (gun) {
      this.ballistics.ensure(gun, view.pos.y, view.velBody.z);
      if (target.id && target.range > 1) {
        solveLead(this.lead, this.ballistics, _muzzle, view.vel, target.pos, target.vel);
      } else {
        this.lead.valid = false;
      }
    } else {
      this.lead.valid = false;
    }

    // -- the reticle point -------------------------------------------------
    this.aimDir.copy(this.aim.aimDir);
    // Put the reticle at the target's range so it sits *on* the enemy rather
    // than floating in front of or behind it; fall back to the gun convergence
    // distance when nothing is tracked.
    const reticleRange = target.id && target.range > 60 ? target.range : 500;
    this.aimPoint.copy(view.pos).addScaledVector(this.aimDir, reticleRange);
  }

  // -------------------------------------------------------------------------
  // Frame assembly
  // -------------------------------------------------------------------------

  private buildFrame(ctx: GameContext, view: AircraftView, dt: number): void {
    const f = this.frame;
    const ax = this.axisScratch;
    this.manualAxes(ax);

    if (!view.valid) {
      f.pitch = ax.pitch; f.roll = ax.roll; f.yaw = ax.yaw;
    } else if (this.scheme === 'mouse') {
      const o = this.aim.update(view, dt, ax.pitch, ax.roll, ax.yaw);
      f.pitch = o.pitch; f.roll = o.roll; f.yaw = o.yaw;
    } else {
      // Realistic: the virtual stick (or the pad) drives the surfaces directly.
      if (this.device === 'mouse') {
        f.pitch = applyCurve(this.stickY, this.stickCurve);
        // Negated for the same reason as manualAxes: stick right must bank the
        // aeroplane toward the right of the screen.
        f.roll = -applyCurve(this.stickX, this.stickCurve);
        f.yaw = ax.yaw;
      } else {
        f.pitch = ax.pitch; f.roll = ax.roll; f.yaw = ax.yaw;
      }
      // Keep the reticle glued to the nose so switching schemes is not jarring.
      this.aim.reset(view);
    }

    // Trim is a standing offset on the surfaces — there is no trim field on the
    // wire, and physically that is exactly what a trim tab does.
    if (this.foldTrimIntoAxes) {
      f.pitch = clampSym(f.pitch + this.trimPitch);
      f.roll = clampSym(f.roll + this.trimRoll);
      f.yaw = clampSym(f.yaw + this.trimYaw);
    }

    f.throttle = this.throttle;
    f.dt = dt;

    let bits = this.pulseBits;
    if (this.down('fire1') || (this.device === 'gamepad' && this.gamepad.trigger1 > this.gamepad.triggerThreshold)) bits |= InputBits.Fire1;
    if (this.down('fire2') || (this.device === 'gamepad' && this.gamepad.trigger2 > this.gamepad.triggerThreshold)) bits |= InputBits.Fire2;
    if (this.airbrake) bits |= InputBits.BrakeAir;
    if (this.wheelBrake) bits |= InputBits.WheelBrake;
    if (this.wep) bits |= InputBits.Boost;
    if (this.down('lookBack')) bits |= InputBits.LookBack;
    if (this.bailProgress >= 1) bits |= InputBits.Bail;
    f.bits = bits;

    if (view.valid) {
      this.aim.wireAim(view, this.wireAim);
      f.aimX = this.wireAim.x;
      f.aimY = this.wireAim.y;
    } else {
      f.aimX = 0; f.aimY = 0;
    }

    // Deliberately NOT sent from here.
    //
    // FlightSystem.update() already hands this exact frame to net.sendInput(),
    // and it is the system that owns the prediction history the sequence number
    // indexes. Sending from here as well put two frames per render tick on the
    // wire, each carrying a full dt: the authoritative sim then integrated at
    // roughly twice wall-clock relative to the client's prediction,
    // reconciliation never converged, uplink bandwidth doubled and the pending
    // input ring filled twice as fast, halving the redundancy window. The seq
    // written here is advisory only — the authoritative one is the one
    // FlightSystem gets back from NetSystem.
    f.seq = (f.seq + 1) & 0xffff;
    void ctx;
  }

  // -------------------------------------------------------------------------
  // Public accessors for the HUD / camera
  // -------------------------------------------------------------------------

  get view(): AircraftView { return this.tracker.view; }
  get target(): TrackedTarget { return this.targets.target; }
  /** 0…1 — how far the reticle is pushed toward the cone edge. */
  get conePull(): number { return this.aim.out.conePull; }
  /** Load factor the flight director is currently willing to command. */
  get gAvailable(): number { return this.aim.out.gAvailable; }
  get flaps(): number { return FLAP_STOPS[this.flapIndex]; }
  /**
   * Virtual joystick position for the realistic-scheme HUD widget.
   * Reads into a shared object: this is polled every frame by the HUD and used
   * to mint a fresh '{x, y}' per read.
   */
  get stick(): { readonly x: number; readonly y: number } {
    this.stickOut.x = this.stickX;
    this.stickOut.y = this.stickY;
    return this.stickOut;
  }
  private readonly stickOut = { x: 0, y: 0 };

  /** Range readout for the HUD, in metres, or 0 when nothing is tracked. */
  get targetRange(): number { return this.targets.target.id ? this.targets.target.range : 0; }
}

// ---------------------------------------------------------------------------

/**
 * Deflection a digital axis takes on the *first frame* it is pressed.
 *
 * A pure ramp — however fast — spends its first frames near zero, and near
 * zero is exactly where a control does nothing the player can see. Measured
 * from key-down, a ramp-only axis left the aeroplane visibly inert for about
 * 60 ms before the nose began to move, which is the difference between
 * controls that feel connected and controls that feel like a suggestion.
 *
 * Biting immediately to a fraction of full travel and ramping on from there
 * gives both halves of what a keyboard axis needs: the aircraft responds on
 * the very next frame, and a tap still commands a nudge rather than a snap
 * roll, because the bite is well short of the stop.
 *
 * Pitch bites softest: it is the axis that pulls g, and a hard instant bite
 * there reads as snatchy rather than responsive.
 */
const BITE_PITCH = 0.26;
const BITE_ROLL = 0.38;
const BITE_YAW = 0.28;

/**
 * One digital axis: instant bite, linear ramp to full, quick return to centre.
 *
 * @param rate    slew toward full deflection, per second
 * @param centre  slew back toward zero, per second — faster, so the aeroplane
 *                stops when the player lets go rather than coasting
 */
function digitalAxis(
  cur: number, want: number, bite: number, rate: number, centre: number, dt: number,
): number {
  if (want === 0) return approach(cur, 0, centre, dt);
  // Reversing: come back through centre at the quick rate first, so a sign
  // flip is a sweep rather than a jump across the whole range.
  if (cur * want < 0) return approach(cur, want * bite, centre, dt);
  if (Math.abs(cur) < bite) return want * bite;
  return approach(cur, want, rate, dt);
}

/** Projects a world point to NDC. Returns false when behind the camera. */
function projectToScreen(p: THREE.Vector3, cam: THREE.Camera, out: THREE.Vector2): boolean {
  // View-space depth first: 'project()' mirrors anything behind the near plane,
  // which would otherwise draw the pipper on the wrong side of the screen.
  _v.copy(p).applyMatrix4(cam.matrixWorldInverse);
  _proj.copy(p).project(cam);
  if (_v.z >= 0) {
    // Behind us. Write a mirrored direction just outside the frame so a HUD
    // that clamps off-screen markers to the edge still points the right way.
    const m = Math.max(1e-3, Math.hypot(_proj.x, _proj.y));
    out.set((-_proj.x / m) * 1.4, (-_proj.y / m) * 1.4);
    return false;
  }
  out.set(_proj.x, _proj.y);
  return Math.abs(_proj.x) <= 1 && Math.abs(_proj.y) <= 1;
}

function safeGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k: string, v: string): void {
  try { localStorage.setItem(k, v); } catch { /* private mode */ }
}
