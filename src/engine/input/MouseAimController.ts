import * as THREE from 'three';
import type { AircraftView } from './aircraftView';
import { G0 } from '../../shared/combat/atmosphere';
import { clamp01, clampSym, smoothstep } from './curves';

/**
 * Mouse-aim flight control — the War Thunder default, and the control scheme
 * this game lives or dies by.
 *
 * ## The model
 *
 * The mouse does not move control surfaces. It moves a **virtual aim
 * direction** — a unit vector in world space, constrained to a cone in front of
 * the aircraft — and an autopilot flies the aeroplane so that its nose lands on
 * that vector. The cone is what makes it feel like flying rather than like
 * dragging a cursor: swing the mouse faster than the aircraft can turn and the
 * reticle pins to the cone edge and *drags the aircraft around with it*, which
 * is exactly the sensation of hauling on a stick against a rate limit.
 *
 * ## The autopilot
 *
 * A two-stage cascade, which is how real fly-by-wire flight directors are built
 * and for the same reason: the outer loop can be tuned for *how the aircraft
 * should behave*, and the inner loop for *what the airframe can actually do*,
 * independently.
 *
 *   outer (attitude -> body rate)
 *     The rotation that takes the nose onto the aim vector is decomposed in the
 *     body frame into a roll angle and a pitch angle. Aeroplanes turn by
 *     banking, so lateral error becomes a roll command and the pull only builds
 *     as the wings come round to meet it — 'cos(bank error)' does that
 *     naturally and continuously, with no mode switching.
 *
 *   limiter (body rate -> achievable body rate)
 *     The commanded pitch rate is clamped by three separate physical ceilings:
 *     the structural g limit, the wing's maximum lift coefficient (you cannot
 *     pull 8 g at 200 km/h no matter how hard you ask), and the raw control
 *     authority at the current dynamic pressure. This is the single thing that
 *     makes mouse aim feel like an aeroplane instead of a mouse cursor.
 *
 *   inner (body rate -> surface deflection)
 *     Feed-forward from the estimated rate authority plus a PI on rate error.
 *     The feed-forward does ~90 % of the work, so the integral term stays small
 *     and the response has no overshoot; the integral only trims out the slow
 *     errors (trim state, asymmetric damage, engine torque).
 *
 * ## Rudder
 *
 * Held to zero sideslip with a proportional-plus-derivative term on β, plus an
 * adverse-yaw feed-forward tied to aileron deflection. Uncoordinated flight is
 * the main reason a novice's shots miss, so the instructor keeps the ball
 * centred unless the player takes the rudder manually.
 */

export interface MouseAimConfig {
  /** Half-angle of the reticle cone, radians. */
  cone: number;
  /** Reticle travel in radians per 1000 px of mouse movement, before the user sensitivity. */
  sensitivity: number;
  invertY: boolean;
  /** Mouse acceleration, 0…1. */
  accel: number;
  /** Fraction of the structural g limit the instructor is willing to use. */
  gLimitFactor: number;
  /** Negative-g ceiling as a load factor magnitude (pushing). */
  negGLimit: number;
  /** Fraction of stall alpha at which pitch authority starts to be withheld. */
  stallMargin: number;
  /** Outer-loop attitude gain, 1/s. Higher = more urgent, more overshoot. */
  attitudeGain: number;
  /**
   * Outer-loop attitude integral, 1/s². Removes the residual quarter-degree of
   * pointing bias that a pure-proportional director always leaves against a
   * standing pitching moment. Small, hard-clamped, and washed out the moment the
   * error is large, so it can never wind up during a manoeuvre.
   */
  attitudeIGain: number;
  /** Outer-loop roll gain, 1/s. */
  rollGain: number;
  /** Inner-loop proportional gain on rate error. */
  ratePGain: number;
  /** Inner-loop integral gain. */
  rateIGain: number;
  /** How strongly the wings self-level when the player is tracking straight. */
  levelAssist: number;
  /** Enable the stall/g protections. */
  instructor: boolean;
  /** Rudder coordination strength. 0 disables auto-rudder. */
  coordination: number;
}

export const DEFAULT_MOUSE_AIM: MouseAimConfig = {
  cone: 0.52,               // 30° — enough to command a max-rate turn, small
  //                           enough that the reticle never leaves the frame
  sensitivity: 1.35,
  invertY: false,
  accel: 0.35,
  gLimitFactor: 0.86,       // pull to 86 % of the wings-off limit, not past it
  negGLimit: 2.2,
  stallMargin: 0.88,
  // Outer-loop gains. These decide how urgently the nose chases the reticle,
  // and they are the single biggest contributor to whether mouse aim reads as
  // "planted" or as "floaty". The inner loop is feed-forward dominated, so the
  // outer loop can be driven harder than a pure-PID cascade would tolerate
  // before it starts to overshoot.
  attitudeGain: 4.3,
  attitudeIGain: 1.3,
  rollGain: 5.4,
  ratePGain: 1.9,
  rateIGain: 1.4,
  levelAssist: 0.55,
  instructor: true,
  coordination: 1,
};

export interface AimOutput {
  pitch: number;
  roll: number;
  yaw: number;
  /** Load factor the limiter is currently allowing. */
  gAvailable: number;
  /** 0…1 — how close the reticle is to the cone edge. Drives the HUD ring. */
  conePull: number;
  /** True when the limiter is actively holding the aircraft back. */
  limited: boolean;
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * How much of the ROLL axis the player takes for a given stick deflection.
 *
 * Deliberately super-linear: 45 % of the travel already claims the whole axis,
 * so a decisive input is obeyed decisively while the shallow bottom of the
 * range is still available for trimming the director rather than overriding it.
 *
 * Roll only — see the blend at the end of 'update' for why pitch and yaw stay
 * linear.
 */
const MANUAL_GAIN = 2.2;
const authority = (m: number): number => Math.min(1, Math.abs(m) * MANUAL_GAIN);

const _e = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _qInv = new THREE.Quaternion();
const _qRot = new THREE.Quaternion();

export class MouseAimController {
  cfg: MouseAimConfig = { ...DEFAULT_MOUSE_AIM };

  /** The reticle direction, world space, unit length. */
  readonly aimDir = new THREE.Vector3(0, 0, 1);
  /** Raw, unclamped reticle direction — kept so the cone edge does not "stick". */
  private readonly aimRaw = new THREE.Vector3(0, 0, 1);
  private initialised = false;

  readonly out: AimOutput = {
    pitch: 0, roll: 0, yaw: 0, gAvailable: 1, conePull: 0, limited: false,
  };

  /** Off-axis angle of the reticle from the nose, radians. */
  theta = 0;
  /** Roll angle the director wants, radians (+ = right). */
  rollError = 0;

  private pitchI = 0;
  private rollI = 0;
  private yawI = 0;
  private attI = 0;
  private pushMode = false;
  private betaPrev = 0;

  /** Reset the reticle onto the nose. Call on spawn, respawn or mode change. */
  reset(view: AircraftView): void {
    this.aimDir.copy(view.forward);
    this.aimRaw.copy(view.forward);
    this.initialised = true;
    this.pitchI = 0;
    this.rollI = 0;
    this.yawI = 0;
    this.attI = 0;
    this.pushMode = false;
    this.out.pitch = 0; this.out.roll = 0; this.out.yaw = 0;
  }

  /**
   * Steers the reticle with a mouse delta expressed in the camera's screen
   * basis. 'right' and 'up' are the camera's world-space axes, so "mouse right"
   * always means "reticle right on screen" regardless of aircraft bank.
   */
  steer(dx: number, dy: number, right: THREE.Vector3, up: THREE.Vector3, userSens: number): void {
    if (!this.initialised) return;
    const s = (this.cfg.sensitivity * userSens) / 1000;
    const ax = dx * s;
    const ay = (this.cfg.invertY ? dy : -dy) * s;
    if (ax === 0 && ay === 0) return;

    // Rotate about the camera's up (yaw) and right (pitch) axes. Applying them
    // as two successive small rotations rather than one composite keeps the
    // reticle from drifting when the two are combined at speed.
    if (ax !== 0) {
      _qRot.setFromAxisAngle(up, -ax);
      this.aimRaw.applyQuaternion(_qRot);
    }
    if (ay !== 0) {
      _qRot.setFromAxisAngle(right, ay);
      this.aimRaw.applyQuaternion(_qRot);
    }
    this.aimRaw.normalize();
  }

  /** Nudges the reticle by an analogue stick, in radians/second. */
  steerAnalogue(x: number, y: number, right: THREE.Vector3, up: THREE.Vector3, rate: number, dt: number): void {
    if (!this.initialised || (x === 0 && y === 0)) return;
    this.steer(x * rate * dt * 1000, -y * rate * dt * 1000, right, up, 1 / this.cfg.sensitivity);
  }

  /**
   * Runs one control step.
   *
   * @param manualPitch  direct pitch input from keyboard/stick, nose-up positive
   * @param manualRoll   direct roll input, right positive
   * @param manualYaw    direct rudder input, right positive
   */
  update(
    view: AircraftView,
    dt: number,
    manualPitch: number,
    manualRoll: number,
    manualYaw: number,
  ): AimOutput {
    const out = this.out;
    if (!view.valid || dt <= 0) return out;
    if (!this.initialised) this.reset(view);

    const spec = view.spec;
    const aero = spec.aero;

    // Player intent, resolved up front: the wing leveller further down has to
    // know about it before it decides how hard to fight for level wings.
    const mp = clampSym(manualPitch), mr = clampSym(manualRoll), my = clampSym(manualYaw);
    const rollAuthority = authority(mr);

    // ---------------------------------------------------------------------
    // 1. Constrain the reticle to the cone in front of the nose.
    // ---------------------------------------------------------------------
    let cos = this.aimRaw.dot(view.forward);
    const coneCos = Math.cos(this.cfg.cone);
    if (cos < coneCos) {
      _axis.crossVectors(view.forward, this.aimRaw);
      if (_axis.lengthSq() < 1e-10) {
        // Reticle exactly opposite the nose — degenerate. Break the tie with
        // the aircraft's own up axis so the recovery is a pull, not a random
        // direction.
        _axis.copy(view.right);
      }
      _axis.normalize();
      _qRot.setFromAxisAngle(_axis, this.cfg.cone);
      this.aimRaw.copy(view.forward).applyQuaternion(_qRot).normalize();
      cos = coneCos;
    }
    this.aimDir.copy(this.aimRaw);
    out.conePull = clamp01((Math.acos(Math.min(1, cos)) / this.cfg.cone));

    // ---------------------------------------------------------------------
    // 2. Decompose the pointing error in the body frame.
    // ---------------------------------------------------------------------
    _qInv.copy(view.quat).invert();
    _e.copy(this.aimDir).applyQuaternion(_qInv).normalize();

    const perp = Math.hypot(_e.x, _e.y);
    const theta = Math.atan2(perp, _e.z);         // total off-axis angle, ≥ 0
    this.theta = theta;

    // Roll angle that would put the error directly above the nose, so the
    // correction becomes a pure (positive-g) pull. 'atan2(x, y)' — not the
    // usual (y, x) — because we are measuring from the body up axis.
    const rollToPull = perp > 1e-6 ? Math.atan2(_e.x, _e.y) : 0;
    // The mirror solution: roll the other way and push instead.
    const rollToPush = perp > 1e-6 ? Math.atan2(_e.x, -_e.y) : 0;

    // Hysteresis between pulling and pushing. Small downward corrections are
    // pushed through (nobody rolls inverted to drop the nose two degrees); big
    // ones roll and pull, because the airframe can only make −2 g but +8 g.
    if (this.pushMode) {
      if (theta > 0.42 || Math.abs(rollToPush) > 1.25) this.pushMode = false;
    } else if (theta < 0.30 && Math.abs(rollToPush) < Math.abs(rollToPull) - 0.15) {
      this.pushMode = true;
    }
    const rollAim = this.pushMode ? rollToPush : rollToPull;
    const pullSign = this.pushMode ? -1 : 1;

    // ---------------------------------------------------------------------
    // 3. Roll command.
    // ---------------------------------------------------------------------
    // How much of the error is lateral. With no lateral error there is nothing
    // to bank for, and 'rollAim' becomes numerically meaningless, so fade it
    // out and let the wing-leveller take over.
    const latFrac = theta > 1e-5 ? Math.abs(Math.sin(rollAim)) : 0;
    const aimAuthority = smoothstep(0.10, 0.45, latFrac) * smoothstep(0.004, 0.020, theta);

    // Wing leveller: bank angle relative to the horizon, signed so that
    // positive means "the right wing is low".
    const bankCos = view.up.dot(WORLD_UP);
    const bankSin = view.right.dot(WORLD_UP);
    const bankAngle = Math.atan2(bankSin, bankCos);   // = −bank for right-wing-low
    // Do not try to level while pointing steeply up or down: bank angle is
    // ill-conditioned near the vertical and the roll it asks for there is
    // meaningless. Inverted, though, it must still work — 'atan2' already
    // returns the angle past 90°, so driving it to zero rolls out the short
    // way. Refusing to level while inverted (which this used to do) meant that
    // letting go of the mouse after any hard turn left the aeroplane on its
    // back, and it simply flew into the ground from there.
    const pitchAttitude = Math.asin(clampSym(view.forward.y));
    const levelValid = Math.abs(pitchAttitude) < 1.05;
    // Stand down while the player is rolling deliberately. A leveller that
    // keeps pulling for wings-level against a held roll key is not an
    // assistant, it is a second pilot with different ideas, and the player
    // feels it as controls that mush and then snap back.
    const levelErr = levelValid
      ? bankAngle * this.cfg.levelAssist * (1 - rollAuthority)
      : 0;

    this.rollError = rollAim * aimAuthority + levelErr * (1 - aimAuthority);

    // Roll authority. The flight model publishes exactly this number
    // ('authRoll') folding in heavy controls, Mach stiffening and a shot-off
    // aileron; using it means the director stops asking for rates a damaged
    // aircraft cannot make, which is what otherwise winds the integrator up and
    // makes a crippled aeroplane oscillate.
    const vRef = 111;                                   // ~400 km/h, the reference for aero.rollRate
    const qRatio = clamp01(view.ias / vRef);
    const rollRateAvail = aero.rollRate * Math.max(0.10, view.authRoll);

    let rollRateCmd = this.rollError * this.cfg.rollGain;
    // Ask for everything the wing has when the player is clearly demanding a
    // hard turn; anything less and mouse aim feels like it is holding you back.
    if (out.conePull > 0.7) rollRateCmd *= 1 + (out.conePull - 0.7) * 2.0;
    rollRateCmd = Math.max(-rollRateAvail, Math.min(rollRateAvail, rollRateCmd));

    // ---------------------------------------------------------------------
    // 4. Pitch command, with the three physical ceilings.
    // ---------------------------------------------------------------------
    const alignment = Math.cos(rollAim);              // 1 when the wings are where we want them
    let pitchAngleCmd = pullSign * theta * Math.max(alignment, -0.25);
    // While the wings are still swinging round, do not fight the roll with a
    // half-hearted pull — it just bleeds energy.
    if (alignment < 0) pitchAngleCmd *= 0.35;

    // Outer-loop integral. Only active inside a few degrees of the target,
    // where the aircraft is tracking rather than manoeuvring: a proportional
    // director settles wherever the standing pitching moment balances its gain,
    // and at 600 m a quarter of a degree of residual is a whole wingspan of
    // miss. Outside that window it is bled away so it cannot wind up.
    if (theta < 0.06) {
      this.attI += pitchAngleCmd * this.cfg.attitudeIGain * dt;
      this.attI = Math.max(-0.12, Math.min(0.12, this.attI));
    } else {
      this.attI *= Math.exp(-dt * 2.5);
    }
    let pitchRateCmd = pitchAngleCmd * this.cfg.attitudeGain + this.attI;

    const v = Math.max(25, view.speed);
    // (a) structural
    const nStruct = aero.gLimit * this.cfg.gLimitFactor;
    // (b) aerodynamic — the most lift the wing can make right now
    const nAero = (0.5 * view.rho * v * v * aero.wingArea * aero.clMax) / (aero.mass * G0);
    const nMax = this.cfg.instructor ? Math.min(nStruct, nAero) : nStruct * 1.15;
    // Load factor from a pitch rate ω at speed V is n ≈ 1 + Vω/g for a pull.
    const pitchRateGLimit = (G0 * Math.max(0.15, nMax - 1)) / v;
    const pitchRatePushLimit = (G0 * (this.cfg.negGLimit + 1)) / v;
    // (c) control authority
    const pitchRateAvail = aero.pitchRate * Math.max(0.10, view.authPitch);

    const upLimit = Math.min(pitchRateGLimit, pitchRateAvail);
    const dnLimit = Math.min(pitchRatePushLimit, pitchRateAvail);
    const wanted = pitchRateCmd;
    pitchRateCmd = Math.max(-dnLimit, Math.min(upLimit, pitchRateCmd));
    out.gAvailable = nMax;
    out.limited = Math.abs(wanted - pitchRateCmd) > 0.02;

    // (d) stall protection — withhold the pull that would take us past the
    // buffet, in the direction that makes alpha worse only.
    if (this.cfg.instructor) {
      const aRatio = Math.abs(view.alpha) / Math.max(0.05, aero.stallAlpha);
      const withhold = smoothstep(this.cfg.stallMargin, 1.02, aRatio);
      if (withhold > 0) {
        const worsening = Math.sign(view.alpha) === Math.sign(pitchRateCmd) || view.alpha === 0;
        if (worsening) pitchRateCmd *= 1 - withhold * 0.85;
      }
    }

    // ---------------------------------------------------------------------
    // 4b. Spin recovery.
    // ---------------------------------------------------------------------
    // In an established spin the aircraft is autorotating and the aim error is
    // meaningless — pulling harder (which is what the director would otherwise
    // do) deepens it. The standard recovery is the only thing that works:
    // full opposite rudder, ailerons neutral, stick progressively forward to
    // break the stall. The instructor flies it and hands control back as the
    // rotation stops.
    let spinAuthority = 0;
    let spinRudder = 0;
    if (this.cfg.instructor && view.spinning > 0.12) {
      spinAuthority = smoothstep(0.12, 0.55, view.spinning);
      // Body +Y yaw rate is positive nose-right, so opposite rudder is −sign.
      const yawRate = view.omega.y;
      spinRudder = -Math.sign(yawRate || 1) * Math.min(1, Math.abs(yawRate) * 2.2 + 0.55);
      pitchRateCmd += (-dnLimit * 0.45 - pitchRateCmd) * spinAuthority;
      rollRateCmd *= 1 - spinAuthority * 0.9;
    }

    // ---------------------------------------------------------------------
    // 5. Inner loop: body rate -> surface deflection.
    // ---------------------------------------------------------------------
    // Body-frame sign conventions: a positive rotation about body +X drops the
    // nose, and about body +Z raises the right wing. Both are the opposite of
    // the pilot-facing sense, hence the negations.
    const pitchRateActual = -view.omega.x;
    const rollRateActual = -view.omega.z;

    const pitchFF = pitchRateCmd / Math.max(0.05, pitchRateAvail);
    const pitchErr = pitchRateCmd - pitchRateActual;
    let elevator = pitchFF + pitchErr * this.cfg.ratePGain / Math.max(0.05, pitchRateAvail) + this.pitchI;

    const rollFF = rollRateCmd / Math.max(0.05, rollRateAvail);
    const rollErrRate = rollRateCmd - rollRateActual;
    let aileron = rollFF + rollErrRate * this.cfg.ratePGain / Math.max(0.05, rollRateAvail) + this.rollI;

    // Integrators with clamping anti-windup: stop accumulating once the surface
    // is on the stop and the error still pushes the same way, otherwise the
    // controller keeps winding up during a sustained max-rate turn and then
    // overshoots badly on release.
    const pitchSat = elevator > 1 || elevator < -1;
    if (!(pitchSat && Math.sign(pitchErr) === Math.sign(elevator))) {
      this.pitchI += pitchErr * this.cfg.rateIGain * dt / Math.max(0.05, pitchRateAvail);
      this.pitchI = Math.max(-0.45, Math.min(0.45, this.pitchI));
    }
    const rollSat = aileron > 1 || aileron < -1;
    if (!(rollSat && Math.sign(rollErrRate) === Math.sign(aileron))) {
      this.rollI += rollErrRate * this.cfg.rateIGain * dt / Math.max(0.05, rollRateAvail);
      this.rollI = Math.max(-0.35, Math.min(0.35, this.rollI));
    }
    // Bleed the integrators when the aircraft is near the commanded rate so
    // they never become a hidden trim offset.
    this.pitchI *= Math.exp(-dt * 0.35);
    this.rollI *= Math.exp(-dt * 0.35);

    elevator = clampSym(elevator);
    aileron = clampSym(aileron);

    // ---------------------------------------------------------------------
    // 6. Rudder: hold the ball centred.
    // ---------------------------------------------------------------------
    let rudder = 0;
    if (this.cfg.coordination > 0 && Math.abs(manualYaw) < 0.05 && view.speed > 20) {
      const beta = view.beta;
      const betaDot = (beta - this.betaPrev) / dt;
      this.betaPrev = beta;
      // β > 0 means the relative wind comes from the right — the nose is left
      // of the flight path — so right rudder centres it.
      const p = beta * 2.6;
      const d = clampSym(betaDot * 0.35);
      // Integral term. Without it the ball sits permanently a degree or two out
      // of centre in a climb: engine torque, P-factor and slipstream swirl are
      // all one-sided and all constant, so a pure proportional term settles at
      // whatever slip produces enough rudder to balance them. This is exactly
      // what a rudder trim tab is for.
      this.yawI = Math.max(-0.4, Math.min(0.4, this.yawI + beta * 0.9 * dt));
      // Adverse yaw: the down-going aileron drags, swinging the nose away from
      // the roll. Feeding a slice of aileron into the rudder cancels most of it
      // before the sideslip even develops, which is what a good pilot does.
      const adverse = aileron * 0.22 * (1 - qRatio * 0.45);
      rudder = clampSym((p + d + this.yawI + adverse) * this.cfg.coordination);
      // At very low speed the rudder is the primary yaw control and the
      // coordination term would fight the pilot's ground steering.
      if (view.onGround) rudder *= 0.15;
    } else {
      this.betaPrev = view.beta;
      // The player has the rudder; bleed the auto-trim so it does not fight
      // them and does not snap back when they let go.
      this.yawI *= Math.exp(-dt * 1.5);
    }
    if (spinAuthority > 0) rudder = rudder * (1 - spinAuthority) + spinRudder * spinAuthority;

    // ---------------------------------------------------------------------
    // 7. Blend in direct player input. Manual authority scales with how hard
    //    the player is pushing, so a nudge biases the autopilot and a full
    //    deflection owns the axis outright.
    //
    //    Authority rises FASTER than deflection does. With a 1:1 mapping a
    //    quarter-deflection stick left the director holding three quarters of
    //    the axis, and since the director's job at that moment is usually to
    //    level the wings, the two were pulling against each other: measured,
    //    the commanded aileron went the *wrong way* for the first ~100 ms of a
    //    deliberate roll input and sometimes never crossed over at all. A
    //    quarter of a deflection is not a nudge, it is an instruction.
    // ---------------------------------------------------------------------
    // Pitch and yaw keep the 1:1 blend. The fast ramp belongs to roll alone,
    // and deliberately so: on pitch, the share the director retains is what
    // keeps the g limiter and the stall protection in the loop, and handing the
    // axis over at 45 % deflection let a full pull take the aeroplane straight
    // through the buffet — measured, "climb when told to" turned into a 36
    // degree nose-down departure. Roll has no such protection to bypass; what
    // it had was a wing leveller arguing with the player, which is what the
    // faster ramp is there to end.
    out.pitch = clampSym(elevator * (1 - Math.abs(mp)) + mp);
    out.roll = clampSym(aileron * (1 - rollAuthority) + mr);
    out.yaw = clampSym(rudder * (1 - Math.abs(my)) + my);

    return out;
  }

  /** Reticle offset from the nose, normalised by the cone — what goes on the wire. */
  wireAim(view: AircraftView, out: { x: number; y: number }): void {
    _qInv.copy(view.quat).invert();
    _e.copy(this.aimDir).applyQuaternion(_qInv);
    const perp = Math.hypot(_e.x, _e.y);
    const theta = Math.atan2(perp, _e.z);
    if (perp < 1e-6) { out.x = 0; out.y = 0; return; }
    const k = theta / (this.cfg.cone * perp);
    out.x = clampSym(_e.x * k);
    out.y = clampSym(_e.y * k);
  }

  /**
   * Places the reticle at a normalised screen position, [-1,1] with +Y up.
   *
   * Used for the unlocked-cursor fallback (before the player's first click, and
   * anywhere pointer lock is denied) and when replaying a recorded aim.
   *
   * 'right' and 'up' are the CAMERA's world axes, and that is the whole point.
   * This used to build the offset in the aircraft's own body frame, which meant
   * "cursor to the right of the screen" was read as "target off my right
   * wingtip" no matter how the aeroplane was banked. The director's job is to
   * roll until the error sits above the nose and then pull; with the error
   * pinned to the body's right by construction it could never get there, so it
   * commanded full aileron forever. The aeroplane barrel-rolled continuously,
   * never turned, never pulled a g, and mushed into the ground — which is what
   * "unflyable" looks like from the cockpit.
   */
  fromWireAim(
    view: AircraftView, x: number, y: number,
    right: THREE.Vector3, up: THREE.Vector3,
  ): void {
    const perp = Math.hypot(x, y);
    if (perp < 1e-6) { this.aimRaw.copy(view.forward); this.aimDir.copy(view.forward); return; }
    const theta = Math.min(1, perp) * this.cfg.cone;
    const s = Math.sin(theta) / perp;
    // Offset from the nose along the screen axes the player is looking through.
    _e.copy(view.forward).multiplyScalar(Math.cos(theta))
      .addScaledVector(right, x * s)
      .addScaledVector(up, y * s)
      .normalize();
    this.aimRaw.copy(_e);
    this.aimDir.copy(_e);
  }
}
