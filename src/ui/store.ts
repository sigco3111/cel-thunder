import type { GameContext, QualityTier } from '../engine/context';

/**
 * Persisted user preferences.
 *
 * 'Settings' on the GameContext is the *live* contract other subsystems read;
 * this store is the superset the UI owns (audio submixes, units, HUD scale,
 * key bindings) plus the persistence and the apply-to-context logic. Anything
 * the engine understands is mirrored into 'ctx.settings' on apply, and a bus
 * event is emitted so subsystems can react without polling.
 */

export type ControlMode = 'mouse-aim' | 'instructor' | 'realistic' | 'simulator';
export type Units = 'metric' | 'imperial';

export interface UiPrefs {
  // --- graphics ---
  quality: QualityTier | 'auto';
  shadows: boolean;
  shadowMapSize: number;
  volumetricClouds: boolean;
  bloom: number;
  ssao: boolean;
  dof: boolean;
  motionBlur: boolean;
  renderScale: number;
  fov: number;
  outlineWidth: number;

  // --- controls ---
  controlMode: ControlMode;
  mouseSensitivity: number;
  invertY: boolean;
  aimAssist: number;

  // --- audio ---
  masterVolume: number;
  effectsVolume: number;
  engineVolume: number;
  uiVolume: number;

  // --- hud ---
  showHud: boolean;
  hudScale: number;
  units: Units;
  showMarkers: boolean;
  showMinimap: boolean;

  playerName: string;
  lastAircraft: string;
  livery: number;
  bindings: Record<string, string>;
}

export const DEFAULT_BINDINGS: Record<string, string> = {
  pitchUp: 'KeyS',
  pitchDown: 'KeyW',
  rollLeft: 'KeyA',
  rollRight: 'KeyD',
  yawLeft: 'KeyQ',
  yawRight: 'KeyE',
  throttleUp: 'ShiftLeft',
  throttleDown: 'ControlLeft',
  wep: 'KeyR',
  fire1: 'Mouse0',
  fire2: 'Mouse1',
  bomb: 'KeyB',
  rocket: 'KeyN',
  gear: 'KeyG',
  flapsDown: 'KeyF',
  flapsUp: 'KeyV',
  airbrake: 'KeyX',
  wheelBrake: 'KeyZ',
  radiator: 'KeyC',
  bail: 'KeyK',
  lookBack: 'KeyH',
  camera: 'KeyV',
  freeLook: 'AltLeft',
  scoreboard: 'Tab',
  chat: 'Enter',
  hudToggle: 'KeyU',
  menu: 'Escape',
};

/** Human labels for the controls screen, in display order. */
export const BINDING_GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Flight',
    items: [
      ['pitchUp', 'Pitch up'],
      ['pitchDown', 'Pitch down'],
      ['rollLeft', 'Roll left'],
      ['rollRight', 'Roll right'],
      ['yawLeft', 'Rudder left'],
      ['yawRight', 'Rudder right'],
      ['throttleUp', 'Throttle up'],
      ['throttleDown', 'Throttle down'],
      ['wep', 'War emergency power'],
    ],
  },
  {
    title: 'Weapons',
    items: [
      ['fire1', 'Fire machine guns'],
      ['fire2', 'Fire cannons'],
      ['bomb', 'Release bombs'],
      ['rocket', 'Launch rockets'],
    ],
  },
  {
    title: 'Systems',
    items: [
      ['gear', 'Landing gear'],
      ['flapsDown', 'Flaps down'],
      ['flapsUp', 'Flaps up'],
      ['airbrake', 'Air brake'],
      ['wheelBrake', 'Wheel brake'],
      ['radiator', 'Radiator'],
      ['bail', 'Bail out'],
    ],
  },
  {
    title: 'View & interface',
    items: [
      ['camera', 'Cycle camera'],
      ['freeLook', 'Free look'],
      ['lookBack', 'Look back'],
      ['scoreboard', 'Scoreboard (hold)'],
      ['chat', 'Chat'],
      ['hudToggle', 'Toggle HUD'],
      ['menu', 'Menu / cancel'],
    ],
  },
];

export const DEFAULT_PREFS: UiPrefs = {
  quality: 'auto',
  shadows: true,
  shadowMapSize: 2048,
  volumetricClouds: true,
  bloom: 0.55,
  ssao: true,
  dof: true,
  motionBlur: true,
  renderScale: 1,
  fov: 68,
  outlineWidth: 1,

  controlMode: 'mouse-aim',
  mouseSensitivity: 1,
  invertY: false,
  aimAssist: 0.5,

  masterVolume: 0.8,
  effectsVolume: 0.9,
  engineVolume: 0.8,
  uiVolume: 0.7,

  showHud: true,
  hudScale: 1,
  units: 'metric',
  showMarkers: true,
  showMinimap: true,

  playerName: '',
  lastAircraft: 'spitfire_mk9',
  livery: 0,
  bindings: { ...DEFAULT_BINDINGS },
};

const KEY = 'celthunder.prefs.v1';

export function loadPrefs(): UiPrefs {
  const p: UiPrefs = { ...DEFAULT_PREFS, bindings: { ...DEFAULT_BINDINGS } };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const j = JSON.parse(raw) as Partial<UiPrefs>;
      for (const k of Object.keys(p) as (keyof UiPrefs)[]) {
        const v = j[k];
        if (v === undefined || v === null) continue;
        if (k === 'bindings') {
          p.bindings = { ...DEFAULT_BINDINGS, ...(v as Record<string, string>) };
        } else if (typeof v === typeof p[k]) {
          // Runtime-checked assignment: the stored blob is user-editable, so a
          // type mismatch must not be allowed to poison the live settings.
          (p as unknown as Record<string, unknown>)[k] = v;
        }
      }
    }
  } catch {
    /* corrupt or unavailable storage — defaults are fine */
  }
  if (!p.playerName) {
    p.playerName = localStorage.getItem('celthunder.name')
      || `Pilot${Math.floor(Math.random() * 900 + 100)}`;
  }
  return p;
}

let saveTimer = 0;

export function savePrefs(p: UiPrefs): void {
  // Coalesce writes: dragging a slider must not hit localStorage 200 times.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(p));
      localStorage.setItem('celthunder.name', p.playerName);
    } catch { /* private mode */ }
  }, 220) as unknown as number;
}

/**
 * Pushes preferences into the engine's live 'Settings' object and announces the
 * change. Called on boot and after every settings edit.
 */
export function applyPrefs(p: UiPrefs, ctx: GameContext): void {
  const s = ctx.settings;
  s.shadows = p.shadows;
  s.shadowMapSize = p.shadowMapSize;
  s.volumetricClouds = p.volumetricClouds;
  s.cloudSteps = p.volumetricClouds ? (p.quality === 'ultra' ? 64 : p.quality === 'low' ? 24 : 48) : 0;
  s.outlineWidth = p.outlineWidth;
  s.bloom = p.bloom;
  s.ssao = p.ssao;
  s.motionBlur = p.motionBlur;
  s.dof = p.dof;
  s.renderScale = p.renderScale;
  s.fov = p.fov;
  s.masterVolume = p.masterVolume;
  s.mouseSensitivity = p.mouseSensitivity;
  s.invertY = p.invertY;
  s.showHud = p.showHud;

  if (p.quality !== 'auto' && ctx.quality !== p.quality) {
    ctx.quality = p.quality;
    ctx.bus.emit('quality', p.quality);
  }

  // The camera is ours to keep in sync — FOV is a settings value with an
  // immediate visual consequence and no other owner.
  if (Math.abs(ctx.camera.fov - p.fov) > 0.01) {
    ctx.camera.fov = p.fov;
    ctx.camera.updateProjectionMatrix();
  }

  ctx.bus.emit('settings:changed', s);
  // Announced separately because the camera rig owns the *live* FOV (it may
  // widen with speed); this is the base value it should return to.
  ctx.bus.emit('settings:fov', p.fov);
  ctx.bus.emit('audio:volumes', {
    master: p.masterVolume,
    effects: p.effectsVolume,
    engine: p.engineVolume,
    ui: p.uiVolume,
  });
  ctx.bus.emit('controls:changed', {
    mode: p.controlMode,
    sensitivity: p.mouseSensitivity,
    invertY: p.invertY,
    aimAssist: p.aimAssist,
    bindings: p.bindings,
  });
}

/** Pretty-prints a KeyboardEvent.code / mouse token for the bindings UI. */
export function keyLabel(code: string): string {
  if (!code) return '—';
  if (code.startsWith('Mouse')) {
    const i = Number(code.slice(5));
    return ['LMB', 'MMB', 'RMB', 'M4', 'M5'][i] ?? `M${i}`;
  }
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `NUM ${code.slice(6)}`;
  if (code.startsWith('Arrow')) return code.slice(5).toUpperCase();
  const map: Record<string, string> = {
    ShiftLeft: 'L SHIFT', ShiftRight: 'R SHIFT',
    ControlLeft: 'L CTRL', ControlRight: 'R CTRL',
    AltLeft: 'L ALT', AltRight: 'R ALT',
    Space: 'SPACE', Escape: 'ESC', Enter: 'ENTER', Tab: 'TAB',
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  };
  return map[code] ?? code.toUpperCase();
}
