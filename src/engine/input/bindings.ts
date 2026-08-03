/**
 * Action map and key bindings.
 *
 * Bindings are stored as *physical* codes ('KeyboardEvent.code'), never
 * 'key', so an AZERTY or QWERTZ player gets the same finger positions as a
 * QWERTY one rather than having their roll axis land on the other side of the
 * keyboard. Mouse buttons and gamepad buttons live in the same namespace with
 * 'Mouse<n>' / 'Pad<n>' prefixes so a single lookup covers every device.
 */

export type Action =
  // Flight axes (digital, from keyboard/gamepad d-pad)
  | 'pitchDown' | 'pitchUp'
  | 'rollLeft' | 'rollRight'
  | 'yawLeft' | 'yawRight'
  // Engine
  | 'throttleUp' | 'throttleDown' | 'throttleMax' | 'throttleIdle'
  | 'wep' | 'radiator'
  // Trim
  | 'trimNoseUp' | 'trimNoseDown' | 'trimLeft' | 'trimRight'
  | 'trimYawLeft' | 'trimYawRight' | 'trimReset'
  // Airframe
  | 'flaps' | 'flapsUp' | 'gear' | 'airbrake' | 'wheelBrake'
  // Weapons
  | 'fire1' | 'fire2' | 'bombs' | 'rockets'
  // View
  | 'cameraCycle' | 'freeLook' | 'lookBack' | 'zoom'
  // Meta
  | 'map' | 'chat' | 'bail' | 'targetCycle' | 'targetClear'
  | 'controlModeCycle' | 'toggleHud';

export type Bindings = Record<Action, string[]>;

/**
 * Defaults follow War Thunder's mouse-aim layout, which is itself close to the
 * de-facto arcade flight standard: WASD for the primary two axes, Q/E for
 * rudder, Shift/Ctrl for throttle. Arrow keys mirror WASD so a keyboard-only
 * player can fly with one hand on the arrows and the other on the function row.
 *
 * Note the pitch sense: 'W' / 'ArrowUp' push the stick *forward* (nose down),
 * which is what every flight sim does and what anyone who has flown one
 * expects, even though it surprises FPS players for the first thirty seconds.
 */
export const DEFAULT_BINDINGS: Bindings = {
  pitchDown: ['KeyW', 'ArrowUp'],
  pitchUp: ['KeyS', 'ArrowDown'],
  rollLeft: ['KeyA', 'ArrowLeft'],
  rollRight: ['KeyD', 'ArrowRight'],
  yawLeft: ['KeyQ'],
  yawRight: ['KeyE'],

  throttleUp: ['ShiftLeft', 'Equal', 'NumpadAdd'],
  throttleDown: ['ControlLeft', 'Minus', 'NumpadSubtract'],
  throttleMax: ['Digit0'],
  throttleIdle: ['Digit9'],
  wep: ['Space', 'Pad0'],
  radiator: ['KeyN'],

  trimNoseUp: ['Numpad2'],
  trimNoseDown: ['Numpad8'],
  trimLeft: ['Numpad4'],
  trimRight: ['Numpad6'],
  trimYawLeft: ['Numpad7'],
  trimYawRight: ['Numpad9'],
  trimReset: ['Numpad5'],

  flaps: ['KeyF', 'Pad5'],
  flapsUp: ['KeyH'],
  gear: ['KeyG', 'Pad4'],
  airbrake: ['KeyB', 'Pad1'],
  wheelBrake: ['KeyK'],

  fire1: ['Mouse0', 'Pad7'],
  fire2: ['Mouse2', 'Pad6'],
  bombs: ['KeyV', 'Pad2'],
  rockets: ['KeyR', 'Pad3'],

  cameraCycle: ['KeyC', 'Pad9'],
  freeLook: ['AltLeft', 'AltRight', 'Mouse1', 'Pad10'],
  lookBack: ['KeyZ', 'Pad11'],
  zoom: ['KeyX'],

  map: ['KeyM', 'Pad8'],
  chat: ['Enter'],
  bail: ['Backspace'],
  targetCycle: ['Tab'],
  targetClear: ['Escape'],
  controlModeCycle: ['KeyO'],
  toggleHud: ['F1'],
};

/** Actions that must not have the browser's default behaviour applied. */
const SWALLOW = new Set<string>([
  'Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Backspace', 'F1', 'Slash', 'Quote',
]);

export const shouldSwallow = (code: string): boolean => SWALLOW.has(code);

/** Human-readable label for a binding code, for the controls screen. */
export function labelFor(code: string): string {
  if (code.startsWith('Mouse')) {
    const n = Number(code.slice(5));
    return ['LMB', 'MMB', 'RMB', 'M4', 'M5'][n] ?? `Mouse${n}`;
  }
  if (code.startsWith('Pad')) return `Pad ${code.slice(3)}`;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (code.startsWith('Arrow')) return code.slice(5);
  return code
    .replace(/^(Shift|Control|Alt|Meta)(Left|Right)$/, (_m, a, b) => `${a[0] === 'C' ? 'Ctrl' : a} ${b[0]}`)
    .replace('ControlLeft', 'Ctrl L');
}

const STORAGE_KEY = 'celthunder.bindings.v1';

export class BindingSet {
  private map: Bindings;
  /** Reverse index: code -> actions. Rebuilt whenever bindings change. */
  private reverse = new Map<string, Action[]>();

  constructor(initial?: Partial<Bindings>) {
    this.map = { ...DEFAULT_BINDINGS };
    if (initial) for (const k of Object.keys(initial) as Action[]) {
      const v = initial[k];
      if (Array.isArray(v)) this.map[k] = v.slice();
    }
    this.rebuild();
  }

  static load(): BindingSet {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return new BindingSet(JSON.parse(raw));
    } catch { /* corrupt or unavailable storage — fall back to defaults */ }
    return new BindingSet();
  }

  save(): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.map)); } catch { /* private mode */ }
  }

  reset(): void {
    this.map = { ...DEFAULT_BINDINGS };
    this.rebuild();
    this.save();
  }

  codesFor(a: Action): readonly string[] { return this.map[a]; }

  actionsFor(code: string): readonly Action[] { return this.reverse.get(code) ?? EMPTY; }

  /** Replaces the binding for one action. Returns any actions it now clashes with. */
  set(a: Action, codes: string[]): Action[] {
    this.map[a] = codes.slice();
    this.rebuild();
    this.save();
    const clashes = new Set<Action>();
    for (const c of codes) for (const other of this.actionsFor(c)) if (other !== a) clashes.add(other);
    return [...clashes];
  }

  private rebuild(): void {
    this.reverse.clear();
    for (const a of Object.keys(this.map) as Action[]) {
      for (const code of this.map[a]) {
        let list = this.reverse.get(code);
        if (!list) { list = []; this.reverse.set(code, list); }
        list.push(a);
      }
    }
  }

  /** Serialisable snapshot, for the settings UI. */
  snapshot(): Bindings { return JSON.parse(JSON.stringify(this.map)); }
}

const EMPTY: Action[] = [];
