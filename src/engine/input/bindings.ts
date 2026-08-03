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
  | 'controlModeCycle' | 'toggleHud' | 'toggleControls';

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
  // F1 is the near-universal "what are the controls?" key, so it opens the
  // legend; hiding the HUD moves to F2 (and 'U' still does it from the UI
  // layer). A player who presses F1 expecting help must not instead have their
  // instruments vanish with no explanation.
  toggleHud: ['F2'],
  toggleControls: ['F1'],
};

/** Actions that must not have the browser's default behaviour applied. */
const SWALLOW = new Set<string>([
  'Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Backspace', 'F1', 'F2', 'Slash', 'Quote',
]);

export const shouldSwallow = (code: string): boolean => SWALLOW.has(code);

const NAMED: Record<string, string> = {
  Space: 'Space', Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
  Minus: '−', Equal: '+', BracketLeft: '[', BracketRight: ']',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  Backquote: '`', NumpadAdd: 'Num +', NumpadSubtract: 'Num −',
  CapsLock: 'Caps', PageUp: 'PgUp', PageDown: 'PgDn', Home: 'Home', End: 'End',
};

/** Human-readable label for a binding code, for the controls screen. */
export function labelFor(code: string): string {
  if (!code) return '—';
  if (code.startsWith('Mouse')) {
    const n = Number(code.slice(5));
    return ['LMB', 'MMB', 'RMB', 'M4', 'M5'][n] ?? `Mouse${n}`;
  }
  if (NAMED[code]) return NAMED[code];
  if (code.startsWith('Pad')) return `Pad ${code.slice(3)}`;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (code.startsWith('Arrow')) return code.slice(5);
  return code.replace(
    /^(Shift|Control|Alt|Meta)(Left|Right)$/,
    (_m, a: string, b: string) => `${a === 'Control' ? 'Ctrl' : a} ${b[0]}`,
  );
}

/**
 * Display grouping for every action, in the order a player wants to read them.
 *
 * This lives next to the actions rather than in the UI layer on purpose. The
 * controls screen used to carry its own private copy of the list — with its own
 * private, *different* default keys — so it confidently told players that WEP
 * was on R (it is Space), that the camera was on V (it is C) and that cannons
 * were on the middle mouse button (they are the right one). Reading the same
 * table the input system dispatches from is the only way a controls screen can
 * be trusted, and it is why 'Legend' and 'SettingsPanel' both source from here.
 */
export const BINDING_GROUPS: {
  title: string;
  /**
   * Rows that are not bindings, printed above the group's keys.
   *
   * The reference sheet is generated from the binding table, and the mouse is
   * not in the binding table — so the one control the whole game is flown with
   * was the only one the control list did not mention. A player who opened it
   * to find out how to fly came away with a keyboard layout.
   */
  lead?: { keys: string; note: string }[];
  items: [Action, string][];
}[] = [
  {
    title: 'Flight',
    lead: [
      { keys: 'Mouse', note: 'Steers. The aeroplane flies to the reticle — right turns right, back pulls up' },
      { keys: 'Let go', note: 'Stop moving the mouse and it levels the wings and holds the horizon' },
    ],
    items: [
      ['pitchUp', 'Pull up / nose up'],
      ['pitchDown', 'Push / nose down'],
      ['rollLeft', 'Roll left'],
      ['rollRight', 'Roll right'],
      ['yawLeft', 'Rudder left'],
      ['yawRight', 'Rudder right'],
    ],
  },
  {
    title: 'Engine',
    items: [
      ['throttleUp', 'Throttle up'],
      ['throttleDown', 'Throttle down'],
      ['throttleMax', 'Throttle 100 %'],
      ['throttleIdle', 'Throttle idle'],
      ['wep', 'War emergency power'],
      ['radiator', 'Radiator'],
    ],
  },
  {
    title: 'Weapons',
    items: [
      ['fire1', 'Machine guns'],
      ['fire2', 'Cannons'],
      ['bombs', 'Release bombs'],
      ['rockets', 'Launch rockets'],
      ['targetCycle', 'Cycle target'],
      ['targetClear', 'Clear target'],
    ],
  },
  {
    title: 'Airframe',
    items: [
      ['gear', 'Landing gear'],
      ['flaps', 'Flaps down a stage'],
      ['flapsUp', 'Flaps up a stage'],
      ['airbrake', 'Air brake'],
      ['wheelBrake', 'Wheel brake'],
      ['bail', 'Bail out (hold)'],
    ],
  },
  {
    title: 'View',
    items: [
      ['cameraCycle', 'Cycle camera'],
      ['freeLook', 'Free look (hold)'],
      ['lookBack', 'Look back'],
      ['zoom', 'Gunsight zoom (hold)'],
      ['toggleHud', 'Hide the HUD'],
      ['toggleControls', 'This control list'],
    ],
  },
  {
    title: 'Trim',
    items: [
      ['trimNoseUp', 'Trim nose up'],
      ['trimNoseDown', 'Trim nose down'],
      ['trimLeft', 'Trim left'],
      ['trimRight', 'Trim right'],
      ['trimYawLeft', 'Trim rudder left'],
      ['trimYawRight', 'Trim rudder right'],
      ['trimReset', 'Reset trim'],
    ],
  },
  {
    title: 'Interface',
    items: [
      ['map', 'Map'],
      ['chat', 'Chat'],
      ['controlModeCycle', 'Mouse aim / simulator'],
    ],
  },
];

/**
 * What a first-time pilot has to know, in the order they need it.
 *
 * 'actions' is a list because the useful unit here is an *axis*, not a key:
 * "W / S — pitch" teaches the control, whereas two separate rows for "pitch
 * down" and "pitch up" teach a keyboard layout. 'literal' covers the one entry
 * that is not a binding at all — the mouse itself.
 */
export const ESSENTIALS: { actions: Action[]; literal?: string; note: string }[] = [
  { actions: [], literal: 'Mouse', note: 'Steers — the aeroplane flies to the reticle. Right turns right, back pulls up' },
  { actions: [], literal: 'Let go', note: 'Stop moving the mouse and it levels off by itself' },
  { actions: ['fire1', 'fire2'], note: 'Machine guns / cannons' },
  { actions: ['pitchDown', 'pitchUp'], note: 'Pitch — an alternative to the mouse, never a requirement' },
  { actions: ['rollLeft', 'rollRight'], note: 'Roll — likewise' },
  { actions: ['throttleUp', 'throttleDown'], note: 'Throttle' },
  { actions: ['wep'], note: 'War emergency power' },
  { actions: ['gear', 'flaps'], note: 'Landing gear / flaps' },
  { actions: ['cameraCycle'], note: 'Change camera' },
  { actions: ['toggleControls'], note: 'Show every control' },
];

/**
 * The label a player should see for an action: its first binding, which is the
 * primary one by convention (later entries are the arrow-key and gamepad
 * mirrors, and printing all of them turns a legend into a wall of text).
 */
export function primaryLabel(set: BindingSet, a: Action): string {
  return labelFor(set.codesFor(a)[0] ?? '');
}

/** 'W / S' — the primary binding of each action, joined. */
export function axisLabel(set: BindingSet, actions: readonly Action[]): string {
  return actions.map((a) => primaryLabel(set, a)).filter((s) => s !== '—').join(' / ');
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
