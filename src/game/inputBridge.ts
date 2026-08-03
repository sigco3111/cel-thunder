import { InputBits, type InputFrame } from '../shared/protocol';
import type { Settings, Subsystem } from '../engine/context';
import { clamp } from '../shared/math';

/**
 * Adapter between whatever the input subsystem exposes and the 'InputFrame' the
 * flight model consumes.
 *
 * 'InputSystem' is owned by another module and is still in flux, so this probes
 * for the shapes it might publish — a 'sample(dt)' method, a live 'frame'
 * object, or in the worst case just the raw key set — and never assumes. If it
 * finds nothing usable it flies the aeroplane from the keyboard itself, which
 * means the game is controllable from the first boot rather than after the
 * input layer lands.
 *
 * ## Sign conventions
 *
 * These match the flight model and 'server/Room.ts':
 *   - 'pitch' > 0 is **stick back / nose up**;
 *   - 'roll'  > 0 rolls **right**;
 *   - 'yaw'   > 0 yaws **right**.
 */

type Probe = 'sample' | 'frame' | 'keys' | 'none';

interface MaybeInputSystem extends Subsystem {
  sample?: (dt: number) => Partial<InputFrame> | undefined;
  frame?: Partial<InputFrame>;
  current?: Partial<InputFrame>;
  inputFrame?: Partial<InputFrame>;
  keys?: Set<string>;
}

/** Keyboard fallback map. */
const K = {
  pitchDown: ['KeyW', 'ArrowUp'],
  pitchUp: ['KeyS', 'ArrowDown'],
  rollLeft: ['KeyA', 'ArrowLeft'],
  rollRight: ['KeyD', 'ArrowRight'],
  yawLeft: ['KeyQ'],
  yawRight: ['KeyE'],
  throttleUp: ['ShiftLeft', 'ShiftRight'],
  throttleDown: ['ControlLeft', 'ControlRight'],
  fire1: ['Space'],
  fire2: ['KeyX'],
  gear: ['KeyG'],
  flapsDown: ['KeyF'],
  flapsUp: ['KeyR'],
  airbrake: ['KeyB'],
  wheelBrake: ['KeyH'],
  boost: ['KeyZ'],
  bail: ['KeyJ'],
  lookBack: ['KeyC'],
};

/** Axis slew rates for keyboard flying, per second. */
const RAMP = 3.6;
const CENTRE = 5.5;

export class InputBridge {
  private probe: Probe = 'none';
  private sys: MaybeInputSystem | undefined;

  private pitch = 0;
  private roll = 0;
  private yaw = 0;
  private throttle = 0.85;
  private prevKeys = new Set<string>();

  /** Reusable output — the flight path calls this every frame. */
  private out: InputFrame = {
    seq: 0, dt: 1 / 60, pitch: 0, roll: 0, yaw: 0, throttle: 0.85, bits: 0, aimX: 0, aimY: 0,
  };

  attach(sys: Subsystem | undefined): void {
    this.sys = sys as MaybeInputSystem | undefined;
    if (!this.sys) { this.probe = 'none'; return; }
    if (typeof this.sys.sample === 'function') this.probe = 'sample';
    else if (this.sys.frame || this.sys.current || this.sys.inputFrame) this.probe = 'frame';
    else if (this.sys.keys instanceof Set) this.probe = 'keys';
    else this.probe = 'none';
    console.info(`[flight] input source: ${this.probe}`);
  }

  /** Re-probes: the input subsystem may publish 'frame' only after its init. */
  refresh(): void {
    if (this.probe === 'keys' || this.probe === 'none') {
      const s = this.sys;
      if (s && typeof s.sample === 'function') this.probe = 'sample';
      else if (s && (s.frame || s.current || s.inputFrame)) this.probe = 'frame';
    }
  }

  sample(dt: number, settings: Settings): InputFrame {
    const o = this.out;
    o.dt = dt;

    let src: Partial<InputFrame> | undefined;
    if (this.probe === 'sample') {
      try { src = this.sys!.sample!(dt); } catch { src = undefined; }
    } else if (this.probe === 'frame') {
      src = this.sys!.frame ?? this.sys!.current ?? this.sys!.inputFrame;
    }

    if (src && typeof src.pitch === 'number') {
      o.pitch = clamp(src.pitch, -1, 1);
      o.roll = clamp(src.roll ?? 0, -1, 1);
      o.yaw = clamp(src.yaw ?? 0, -1, 1);
      o.throttle = clamp(src.throttle ?? this.throttle, 0, 1);
      o.bits = (src.bits ?? 0) | 0;
      o.aimX = clamp(src.aimX ?? 0, -1, 1);
      o.aimY = clamp(src.aimY ?? 0, -1, 1);
      this.throttle = o.throttle;
      return o;
    }

    return this.fromKeyboard(dt, settings, o);
  }

  private fromKeyboard(dt: number, settings: Settings, o: InputFrame): InputFrame {
    const keys = this.sys?.keys;
    const down = (list: string[]) => !!keys && list.some((k) => keys.has(k));
    const pressed = (list: string[]) =>
      !!keys && list.some((k) => keys.has(k) && !this.prevKeys.has(k));

    // Analogue-feel axes: keyboard input ramps in and springs back, which is
    // the difference between "flyable" and "twitchy digital nonsense".
    const axis = (cur: number, neg: boolean, pos: boolean) => {
      const want = (pos ? 1 : 0) - (neg ? 1 : 0);
      if (want === 0) {
        const s = Math.sign(cur);
        const n = cur - s * CENTRE * dt;
        return Math.sign(n) === s ? n : 0;
      }
      return clamp(cur + want * RAMP * dt, -1, 1);
    };

    // Positive pitch is stick back = nose up, matching the flight model, so the
    // nose-down keys drive the negative side of the axis.
    this.pitch = axis(this.pitch, down(K.pitchDown), down(K.pitchUp));
    this.roll = axis(this.roll, down(K.rollLeft), down(K.rollRight));
    this.yaw = axis(this.yaw, down(K.yawLeft), down(K.yawRight));

    if (down(K.throttleUp)) this.throttle = clamp(this.throttle + dt * 0.6, 0, 1);
    if (down(K.throttleDown)) this.throttle = clamp(this.throttle - dt * 0.6, 0, 1);

    let bits = 0;
    if (down(K.fire1)) bits |= InputBits.Fire1;
    if (down(K.fire2)) bits |= InputBits.Fire2;
    if (down(K.airbrake)) bits |= InputBits.BrakeAir;
    if (down(K.wheelBrake)) bits |= InputBits.WheelBrake;
    if (down(K.boost)) bits |= InputBits.Boost;
    if (down(K.lookBack)) bits |= InputBits.LookBack;
    // Edge-triggered actions: the flight model toggles on the rising edge, so
    // the bit must be present for exactly the frame the key goes down.
    if (pressed(K.gear)) bits |= InputBits.GearToggle;
    if (pressed(K.flapsDown)) bits |= InputBits.FlapsDown;
    if (pressed(K.flapsUp)) bits |= InputBits.FlapsUp;
    if (pressed(K.bail)) bits |= InputBits.Bail;

    this.prevKeys.clear();
    if (keys) for (const k of keys) this.prevKeys.add(k);

    o.pitch = settings.invertY ? -this.pitch : this.pitch;
    o.roll = this.roll;
    o.yaw = this.yaw;
    o.throttle = this.throttle;
    o.bits = bits;
    o.aimX = 0; o.aimY = 0;
    return o;
  }
}
