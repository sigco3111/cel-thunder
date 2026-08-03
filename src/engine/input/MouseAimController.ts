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
 *     The pointing error is split in two. Its *azimuth* half — the heading
 *     difference between the nose and the reticle, measured about the world
 *     vertical — becomes a **bank angle demand**, because that is how an
 *     aeroplane turns; its *elevation* half becomes a pull, and the pull only
 *     builds as the wings come round to meet it, which 'cos(bank error)' does
 *     naturally and continuously with no mode switching.
 *
 *     Measuring the turn demand about the world vertical rather than in the
 *     body frame is what makes the loop stable. A body-frame lateral error
 *     vanishes the moment the aircraft banks — the error simply rotates round
 *     to sit above the nose — so a bank demand built from it collapses before
 *     the aircraft has turned at all, rolls back level, and starts again. The
 *     azimuth error is invariant under roll, so the demand only decays as the
 *     nose actually comes round.
 *
 *     Zero azimuth error means zero bank demand, and holding zero bank is
 *     exactly what a wing leveller does — so there is no separate leveller and
 *     no crossfade between two laws that disagree. See section 3.
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
  /** Outer-loop roll gain, 1/s — how hard the director closes on the bank it wants. */
  rollGain: number;
  /** Inner-loop proportional gain on rate error. */
  ratePGain: number;
  /** Inner-loop integral gain. */
  rateIGain: number;
  /** How strongly the wings self-level when the player is tracking straight. */
  levelAssist: number;
  /**
   * Bank angle commanded per radian of azimuth pointing error.
   *
   * This is the entire turn law and the single number that decides how a turn
   * feels. Too low and the aeroplane wallows after the reticle; too high and
   * the outer loop closes faster than the roll rate can follow and the nose
   * hunts either side of the target.
   */
  turnGain: number;
  /** Hard ceiling on the bank the director will command, rad. */
  maxBank: number;
  /**
   * Seconds of lead taken from the rate at which the azimuth error is already
   * closing. This is the damping term of the outer loop: without it the bank
   * demand has no idea the turn is working, holds full bank all the way to the
   * target and sails past it.
   */
  turnLead: number;
  /**
   * How fast the reticle relaxes back to straight-and-level once the player
   * stops moving the mouse, 1/s. 0 disables it.
   *
   * The reticle is a *world* direction: left alone at the edge of the cone it
   * commands a max-rate turn forever, which is correct for a simulator and
   * lethal for a beginner. Relaxing it means "let go of the mouse" is always a
   * valid recovery — the wings come level, the nose comes to the horizon, and
   * the aeroplane flies itself — which is the single most important property a
   * first flight can have.
   */
  levelOff: number;
  /** Seconds the mouse must be still before 'levelOff' starts. */
  relaxDelay: number;
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
  // 10° of azimuth error asks for 42° of bank and 18° saturates it — decisive
  // enough that the aeroplane visibly goes where the reticle is pointed,
  // shallow enough near centre that tracking does not wobble.
  turnGain: 4.2,
  maxBank: 1.31,            // 75°: a 3.9 g turn, and still a recoverable attitude
  turnLead: 0.22,
  levelOff: 0.8,
  relaxDelay: 0.45,
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

/**
 * How far off the nose the reticle is allowed to sit while the capture is not
 * held, radians. See 'parkLevel'.
 *
 * Two degrees — deliberately a fifteenth of the aim cone, because this is a
 * nudge toward level and not a place the player asked to point, and an
 * uncaptured aeroplane that could command more than a nudge would be a worse
 * bug than the one it fixes. Through the outer loop's gain it is 8.6 deg/s of
 * pitch authority: enough to take the nose down out of a 40 degree zoom climb
 * in five seconds, which is the state a player leaves behind when they press
 * Escape in the middle of something, and roughly twelve times the 0.7 deg/s
 * nose-up drift it exists to cancel.
 */
const PARK_LEAD = 0.035;

/** Flight-path angle inside which the level-off stops correcting, radians. */
const FLIGHT_PATH_DEAD = 0.0015;

const _e = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _qInv = new THREE.Quaternion();
const _qRot = new THREE.Quaternion();

/**
 * Signed heading difference from 'a' to 'b', measured about the world vertical.
 *
 * Returns 0 when either vector is within a whisker of vertical, where a heading
 * is not a thing that exists; the caller blends to a body-referenced law there.
 */
function azimuthTo(a: THREE.Vector3, b: THREE.Vector3): number {
  const fa = Math.hypot(a.x, a.z);
  const fb = Math.hypot(b.x, b.z);
  if (fa < 1e-3 || fb < 1e-3) return 0;
  const ax = a.x / fa, az = a.z / fa;
  const bx = b.x / fb, bz = b.z / fb;
  // Positive = a rotation about world +Y takes 'a' onto 'b'.
  return Math.atan2(az * bx - ax * bz, ax * bx + az * bz);
}

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
  /** Bank angle the turn law is currently asking for, radians. Read by the HUD. */
  bankDemand = 0;

  private pitchI = 0;
  private rollI = 0;
  private yawI = 0;
  private attI = 0;
  private pushMode = false;
  private betaPrev = 0;
  private azPrev = 0;
  private azRate = 0;
  /** Seconds since the player last moved the reticle. Drives 'levelOff'. */
  private idleTime = 0;
  /** The reticle is parked on the nose because the capture is not held. */
  private parked = false;
  /** The reticle is the absolute cursor position, not an integrated delta. */
  private absolute = false;

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
    this.azPrev = 0;
    this.azRate = 0;
    this.idleTime = 0;
    this.bankDemand = 0;
    this.out.pitch = 0; this.out.roll = 0; this.out.yaw = 0;
  }

  /**
   * Parks the reticle on the nose, leaving every integrator alone.
   *
   * This is what the director does while the pointer is *not* captured but
   * could be — the state between spawning and the player's first click, and
   * every moment after they press Escape. The cursor's position is not a
   * command in that state (it is wherever the OS left the arrow), so the
   * reticle goes on the nose and stays there.
   *
   * "On the nose" alone is NOT a steady state, and believing it was is what
   * this comment used to get wrong. With the reticle exactly on the nose the
   * outer loop asks for nothing at all, which leaves the elevator free — and a
   * fighter at full throttle with a free elevator does not hold its attitude,
   * it pitches slowly up. Measured, uncaptured, hands off for twelve seconds:
   * the nose walked from −3° to −11°, the aeroplane climbed 187 m and the
   * airspeed decayed 463 → 433 km/h, monotonically, on its way to a stall.
   * 'parkLevel' below supplies the small, bounded nudge that makes it a real
   * steady state.
   *
   * Distinct from 'reset', which also clears the PI state; doing that every
   * frame would throw away the trim the integrators have earned and the
   * aeroplane would sag each time the mouse was released.
   */
  holdBoresight(view: AircraftView): void {
    this.parked = true;
    this.absolute = false;
    if (!this.initialised || !view.valid) return;
    this.aimRaw.copy(view.forward);
    this.aimDir.copy(view.forward);
  }

  /**
   * Steers the reticle with a mouse delta expressed in the camera's screen
   * basis. 'right' and 'up' are the camera's world-space axes, so "mouse right"
   * always means "reticle right on screen" regardless of aircraft bank.
   */
  steer(dx: number, dy: number, right: THREE.Vector3, up: THREE.Vector3, userSens: number): void {
    // Claim the reticle even for a zero delta: this is the relative path, and
    // saying so is what stops 'levelOff' from being skipped on the frames where
    // the player happens not to be moving — which are precisely the frames it
    // exists for.
    this.parked = false;
    this.absolute = false;
    if (!this.initialised) return;
    const s = (this.cfg.sensitivity * userSens) / 1000;
    const ax = dx * s;
    const ay = (this.cfg.invertY ? dy : -dy) * s;
    if (ax === 0 && ay === 0) return;
    this.idleTime = 0;

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
    this.parked = false;
    this.absolute = false;
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
    // 0. Relax the reticle back to straight and level once the player lets go.
    // ---------------------------------------------------------------------
    this.idleTime += dt;
    if (Math.abs(mp) > 0.02 || Math.abs(mr) > 0.02 || Math.abs(my) > 0.02) this.idleTime = 0;
    if (this.parked) this.parkLevel(view); else this.relax(view, dt);

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
    // 3. Roll command: one law, from the azimuth error to a bank angle held.
    //
    // This used to be two laws crossfaded, and they disagreed. The aim half
    // asked for 'rollAim' — an atan2, so it returns ±90° for a purely sideways
    // error *however small that error is*; a tenth of a degree off to the side
    // commanded a ninety degree roll. The crossfade that was supposed to
    // suppress it reached full authority at 1.1° of pointing error, which in
    // cruise is nothing at all, so the director sat on the steep part of the
    // ramp and slammed between "roll ninety degrees" and "level the wings".
    // Measured hands-off, with the mouse untouched: ±0.5° of pointing error
    // produced full aileron, ±60°/s of roll rate and a permanent limit cycle.
    // That is what the player reported as "the plane is jittery".
    //
    // Banking in *proportion* to the error removes both the discontinuity and
    // the wing leveller with it — no error means no bank demand, and holding
    // zero bank IS levelling the wings, so there is nothing left to hand over
    // between and no bias where the handover used to be.
    // ---------------------------------------------------------------------

    // The turn demand is the heading error, taken about the world vertical so
    // that it does not vanish the instant the aircraft banks (see the header).
    const azErr = azimuthTo(view.forward, this.aimDir);

    // Filtered closing rate — the damping term of the outer loop. Without it
    // the demand holds full bank all the way to the target and sails past.
    if (dt > 1e-5) {
      const raw = (azErr - this.azPrev) / dt;
      this.azRate += (raw - this.azRate) * (1 - Math.exp(-dt * 10));
    }
    this.azPrev = azErr;
    // Clamped hard: at a max-rate turn the closing rate alone is worth tens of
    // degrees of bank, and an unclamped lead cancels the very demand that is
    // producing it — the aircraft rolls out before the nose arrives, the rate
    // dies, the demand comes back, and the turn hunts.
    const lead = Math.max(-0.10, Math.min(0.10, this.azRate * this.cfg.turnLead));

    // Bank angle relative to the horizon, signed so that positive means "the
    // right wing is low" — the same sense as the demand below.
    const bankCos = view.up.dot(WORLD_UP);
    const bankSin = view.right.dot(WORLD_UP);
    const bankAngle = Math.atan2(bankSin, bankCos);

    // A positive azimuth error is an error toward body +X, and it takes
    // negative bank to fly there.
    const maxBank = this.cfg.maxBank;
    this.bankDemand = -Math.max(-maxBank, Math.min(maxBank, (azErr + lead) * this.cfg.turnGain));

    // How hard the director closes on the bank it wants. 'levelAssist' is the
    // strength of the wings-level *default*, and it is a preference the player
    // can turn off; a real turn demand always closes at full strength, or the
    // aeroplane could never reach the bank the turn needs.
    const hold = Math.max(this.cfg.levelAssist, smoothstep(0.004, 0.05, Math.abs(azErr)));
    const bankTerm = (bankAngle - this.bankDemand) * hold;

    // Near the vertical a horizon-referenced bank angle stops meaning anything
    // — and so does an azimuth. There, fall back to rolling the lift vector
    // straight onto the error, scaled by the error so that this branch is zero
    // at zero too. Inverted is *not* one of these cases and must not be: atan2
    // already returns the angle past 90°, so driving 'bankAngle' to zero rolls
    // out the short way, and that is what makes letting go of the mouse a valid
    // recovery from any attitude.
    const pitchAttitude = Math.asin(clampSym(view.forward.y));
    const vertical = smoothstep(1.02, 1.36, Math.abs(pitchAttitude));
    const bodyTerm = rollAim * smoothstep(0.010, 0.09, theta);

    // Stand down while the player is rolling deliberately. A director that
    // keeps pulling for its own bank against a held roll key is not an
    // assistant, it is a second pilot with different ideas, and the player
    // feels it as controls that mush and then snap back.
    this.rollError = (bankTerm * (1 - vertical) + bodyTerm * vertical) * (1 - rollAuthority);

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

  /**
   * Walks the reticle back toward straight and level while the player is not
   * touching it.
   *
   * The reticle is a direction in the *world*, which is the right model for a
   * gunsight and the wrong one for a beginner's aeroplane: parked at the edge
   * of the cone after a break turn it commands that break turn forever, and
   * "let go of the controls" — the one recovery every first-time pilot knows —
   * does nothing at all. Measured before this existed: 2.5 s of mouse held over
   * left the aeroplane still pulling 5 s later, 400 m lower and inverted.
   *
   * The target is the horizon on the aircraft's *current* heading, so the relax
   * does two things at once and both of them are what "let go" should mean:
   * the azimuth error goes to zero, which stops the turn and (the turn law
   * being what it is) rolls the wings level, and the elevation error goes to
   * zero, which brings the nose to the horizon and holds the altitude.
   *
   * It is deliberately slower than a player's own correction and delayed behind
   * a beat of stillness, so it reads as the aeroplane settling rather than as
   * the game taking the stick. Realistic assists set 'levelOff' to zero and get
   * none of it.
   */
  private relax(view: AircraftView, dt: number): void {
    const rate = this.cfg.levelOff;
    if (rate <= 0 || this.absolute) return;
    const idle = this.idleTime - this.cfg.relaxDelay;
    if (idle <= 0) return;
    if (!this.levelTarget(view, _tgt)) return;

    // Ramp in over the first half second, so releasing the mouse is a release
    // and not a grab.
    const k = 1 - Math.exp(-dt * rate * clamp01(idle / 0.5));
    if (k <= 0) return;
    this.aimRaw.lerp(_tgt, k).normalize();
  }

  /**
   * The same level-off, for the state where the capture is not held.
   *
   * 'holdBoresight' re-seats the reticle on the nose every frame, so a relax
   * that accumulated would be wiped each time. Instead the reticle is placed a
   * fixed, small angle off the nose toward level — an offset, not an
   * accumulation, which is exactly the right shape here. It is a bounded
   * command that can never grow into "fly at the corner of the screen" no
   * matter what the aeroplane does, and it is enough: 0.02 rad through the
   * outer loop's gain is 4.9 deg/s of pitch rate, against a nose-up drift
   * measured at 0.7 deg/s.
   */
  private parkLevel(view: AircraftView): void {
    if (this.cfg.levelOff <= 0) return;
    if (!this.levelTarget(view, _tgt)) return;
    const ang = Math.acos(clampSym(_tgt.dot(view.forward)));
    if (!(ang > 1e-5)) return;
    _axis.crossVectors(view.forward, _tgt);
    if (_axis.lengthSq() < 1e-12) return;
    _axis.normalize();
    _qRot.setFromAxisAngle(_axis, Math.min(ang, PARK_LEAD));
    this.aimRaw.copy(view.forward).applyQuaternion(_qRot).normalize();
    this.aimDir.copy(this.aimRaw);
  }

  /**
   * Where "straight and level" is, as a direction the reticle can be pointed at.
   *
   * Dead ahead on the current heading, at the attitude that puts the **flight
   * path** — not the nose — on the horizon. That distinction is the difference
   * between holding altitude and not: an aeroplane flown nose-on-the-horizon is
   * still climbing by its angle of attack, which at cruise is around a degree,
   * and a degree at 450 km/h is 2 m/s. Two metres a second is sixty metres in
   * half a minute, every one of them paid for out of airspeed, and it was still
   * enough drift to fail a thirty-second hands-off test.
   *
   * Returns false within ten degrees of the vertical, where "the horizon ahead"
   * is not a direction; the caller leaves the reticle alone there and picks the
   * aeroplane up again once it has fallen out of the climb.
   */
  private levelTarget(view: AircraftView, out: THREE.Vector3): boolean {
    out.copy(view.forward);
    const horiz = Math.hypot(out.x, out.z);
    if (horiz <= 0.17) return false;
    const nose = Math.atan2(out.y, horiz);
    const speed = Math.max(1, view.vel.length());
    const gamma = Math.asin(clampSym(view.vel.y / speed));
    // A whisker of deadband, only enough that the loop is not chasing the last
    // few centimetres a second of climb.
    const err = Math.abs(gamma) <= FLIGHT_PATH_DEAD
      ? 0
      : gamma - Math.sign(gamma) * FLIGHT_PATH_DEAD;
    const want = Math.max(-0.6, Math.min(0.6, nose - err));
    const cp = Math.cos(want), sp = Math.sin(want);
    out.set((out.x / horiz) * cp, sp, (out.z / horiz) * cp);
    return true;
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
    // The cursor *is* the reticle here, so relaxing it would be the game
    // dragging the pointer out from under the player's hand.
    this.parked = false;
    this.absolute = true;
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
