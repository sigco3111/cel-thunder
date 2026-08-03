import { applyCurve, radialDeadzone, type AxisCurve, defaultCurve } from './curves';

/**
 * Gamepad device (standard mapping).
 *
 * Layout is chosen for flight rather than for a shooter:
 *
 *   left stick   pitch / roll        — the primary flying stick
 *   right stick  X = rudder, Y = throttle (rate, self-centring)
 *   triggers     RT primary guns, LT secondary guns (analogue -> hair trigger)
 *   bumpers      flaps / gear
 *   face         A = WEP, B = airbrake, X = bombs, Y = rockets
 *   d-pad        trim
 *   stick clicks free-look (L3) / camera cycle (R3)
 *
 * Throttle on a self-centring stick has to be a *rate* control: pushing the
 * stick forward increases throttle while held, rather than mapping absolute
 * position, because the physical stick springs back to centre and an absolute
 * mapping would slam the engine to 50 % every time the thumb lifts.
 */
export class Gamepad_ {
  connected = false;
  index = -1;
  id = '';

  /** Conditioned axes, all [-1,1]. */
  roll = 0;
  pitch = 0;
  yaw = 0;
  /** Throttle *rate* command, [-1,1] — integrate this, do not use it directly. */
  throttleRate = 0;
  /** Free-look axes when L3 is held, else zero. */
  lookX = 0;
  lookY = 0;
  /** Analogue trigger pulls, [0,1]. */
  trigger1 = 0;
  trigger2 = 0;

  /** Button codes ('Pad0'…) currently down, in the shared binding namespace. */
  readonly codes = new Set<string>();

  /** Rises above zero whenever the pad is touched; used for device arbitration. */
  activity = 0;

  stickCurve: AxisCurve = defaultCurve({ deadzone: 0.10, expo: 0.5, saturation: 0.04 });
  rudderCurve: AxisCurve = defaultCurve({ deadzone: 0.14, expo: 0.4, saturation: 0.05 });
  /** Trigger travel at which a trigger counts as "pressed" for digital actions. */
  triggerThreshold = 0.35;

  private scratch = { x: 0, y: 0 };
  private lastTimestamp = -1;

  attach(): void {
    addEventListener('gamepadconnected', this.onConnect);
    addEventListener('gamepaddisconnected', this.onDisconnect);
    this.rescan();
  }

  detach(): void {
    removeEventListener('gamepadconnected', this.onConnect);
    removeEventListener('gamepaddisconnected', this.onDisconnect);
    this.codes.clear();
    this.connected = false;
  }

  private onConnect = (e: Event): void => {
    const gp = (e as GamepadEvent).gamepad;
    if (this.index < 0) { this.index = gp.index; this.id = gp.id; this.connected = true; }
  };

  private onDisconnect = (e: Event): void => {
    if ((e as GamepadEvent).gamepad.index === this.index) {
      this.index = -1; this.connected = false; this.codes.clear();
      this.rescan();
    }
  };

  private rescan(): void {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) {
      if (p && p.connected) { this.index = p.index; this.id = p.id; this.connected = true; return; }
    }
  }

  /** Poll once per frame. 'dt' is used to decay the activity latch. */
  poll(dt: number): void {
    this.activity = Math.max(0, this.activity - dt);

    const pads = navigator.getGamepads?.() ?? [];
    const gp = this.index >= 0 ? pads[this.index] : null;
    if (!gp || !gp.connected) {
      if (this.connected) { this.connected = false; this.codes.clear(); }
      this.roll = this.pitch = this.yaw = this.throttleRate = 0;
      this.lookX = this.lookY = 0;
      this.trigger1 = this.trigger2 = 0;
      return;
    }
    this.connected = true;

    const ax = gp.axes;
    const lx = ax[0] ?? 0, ly = ax[1] ?? 0;
    const rx = ax[2] ?? 0, ry = ax[3] ?? 0;

    // Left stick: radial dead zone first (round gate), then per-axis expo.
    radialDeadzone(lx, ly, this.stickCurve.deadzone, this.scratch);
    const freeLook = this.isDown(gp, 10);   // L3 held = pan the camera instead
    this.roll = applyCurve(this.scratch.x, this.stickCurve, 0);
    // Stick forward (negative Y) = nose down, matching the keyboard sense.
    this.pitch = applyCurve(-this.scratch.y, this.stickCurve, 0);

    radialDeadzone(rx, ry, this.rudderCurve.deadzone, this.scratch);
    if (freeLook) {
      this.lookX = this.scratch.x; this.lookY = -this.scratch.y;
      this.yaw = 0; this.throttleRate = 0;
    } else {
      this.lookX = 0; this.lookY = 0;
      this.yaw = applyCurve(this.scratch.x, this.rudderCurve, 0);
      this.throttleRate = -this.scratch.y;
    }

    this.trigger1 = gp.buttons[7]?.value ?? 0;
    this.trigger2 = gp.buttons[6]?.value ?? 0;

    // Buttons -> shared code namespace. Triggers become digital via a
    // threshold so they can be bound like any other button.
    this.codes.clear();
    let touched = false;
    for (let i = 0; i < gp.buttons.length; i++) {
      const b = gp.buttons[i];
      const down = i === 6 || i === 7 ? b.value > this.triggerThreshold : b.pressed;
      if (down) { this.codes.add(`Pad${i}`); touched = true; }
    }
    // Standard-mapping d-pad is buttons 12..15; expose it as trim.
    if (Math.abs(lx) > 0.25 || Math.abs(ly) > 0.25 || Math.abs(rx) > 0.25 || Math.abs(ry) > 0.25) touched = true;
    if (gp.timestamp !== this.lastTimestamp && touched) this.activity = 2.5;
    this.lastTimestamp = gp.timestamp;
  }

  private isDown(gp: Gamepad, i: number): boolean {
    return gp.buttons[i]?.pressed ?? false;
  }

  /** Fire a rumble pulse if the pad supports it. Silently ignored otherwise. */
  rumble(strong: number, weak: number, ms: number): void {
    const pads = navigator.getGamepads?.() ?? [];
    const gp = this.index >= 0 ? pads[this.index] : null;
    const actuator = (gp as unknown as { vibrationActuator?: { playEffect: (t: string, o: object) => Promise<unknown> } })?.vibrationActuator;
    if (!actuator) return;
    actuator.playEffect('dual-rumble', {
      duration: ms, strongMagnitude: strong, weakMagnitude: weak, startDelay: 0,
    }).catch(() => { /* unsupported effect type */ });
  }
}
