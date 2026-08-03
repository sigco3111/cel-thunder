import { el, setText, setClass, clamp } from '../dom';
import {
  DEFAULT_BINDINGS, DEFAULT_PREFS,
  type AssistLevel, type ControlMode, type UiPrefs, type Units,
} from '../store';
import {
  BINDING_GROUPS, labelFor, type Action, type BindingSet,
} from '../../engine/input/bindings';
import { segmented, settingRow, slider, toggle, textField, groupTitle } from './controls';
import type { QualityTier } from '../../engine/context';
import { isWeatherId, type WeatherId } from '../../shared/environment';

type Tab = 'graphics' | 'controls' | 'audio' | 'interface';
type WeatherChoice = 'match' | WeatherId;

/** Minimal shape of the engine object 'main.ts' publishes on window. */
interface GameHandle {
  bus?: { emit(evt: string, payload?: unknown): void };
  get?(name: string): unknown;
  timeOfDay?: number;
}

function gameHandle(): GameHandle | null {
  return (window as unknown as { __game?: GameHandle }).__game ?? null;
}

function gameBus(): GameHandle['bus'] | null {
  return gameHandle()?.bus ?? null;
}

/** The server-chosen weather, read structurally off the net subsystem. */
function matchWeather(): WeatherId {
  const net = gameHandle()?.get?.('net') as { weather?: unknown } | undefined;
  return isWeatherId(net?.weather) ? net.weather : 'scattered';
}

function matchTimeOfDay(): number {
  const net = gameHandle()?.get?.('net') as { matchTimeOfDay?: unknown } | undefined;
  if (typeof net?.matchTimeOfDay === 'number') return net.matchTimeOfDay;
  const tod = gameHandle()?.timeOfDay;
  return typeof tod === 'number' ? tod : 9.5;
}

function formatClock(hours: number): string {
  const h = Math.floor(hours) % 24;
  const m = Math.round((hours - Math.floor(hours)) * 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Settings. One modal, four tabs, applied live.
 *
 * Every control writes straight into the prefs object and calls back so the
 * change is applied and persisted immediately — no Apply button, no dialog
 * state to get out of sync with the engine.
 */
export class SettingsPanel {
  readonly root: HTMLElement;
  private tabs = new Map<Tab, HTMLElement>();
  private panels = new Map<Tab, HTMLElement>();
  private tab: Tab = 'graphics';
  private prefs: UiPrefs;
  private listening: { action: Action; node: HTMLElement } | null = null;
  private rebuild: (() => void)[] = [];
  /**
   * The engine's live binding table.
   *
   * This panel used to rebind a private 'prefs.bindings' map that no subsystem
   * read and whose defaults had drifted away from the real ones — so it both
   * displayed the wrong keys and silently discarded every rebind the player
   * made. It now edits the table the input system dispatches from, which is the
   * only arrangement in which a controls screen can be correct.
   */
  private bindings: BindingSet | null = null;
  private bindHost: HTMLElement | null = null;
  private controlsRebuilt: (() => void) | null = null;
  /** Session-only sky overrides — see 'buildWeatherOverride'. */
  private weatherChoice: WeatherChoice = 'match';
  private todOverride: number | null = null;

  onChange: (prefs: UiPrefs) => void = () => {};
  onClose: () => void = () => {};

  constructor(parent: HTMLElement, prefs: UiPrefs) {
    this.prefs = prefs;
    this.root = el('div', 'ct-modal-wrap', parent);
    const modal = el('div', 'ct-modal ct-panel is-glass is-deep ct-hatch', this.root);

    const head = el('div', 'ct-modal-head', modal);
    el('div', 'ct-title', head, 'Settings');
    const tabBox = el('div', 'ct-seg', head);
    el('div', 'sp', head);
    const close = el('button', 'ct-btn is-ghost is-sm', head, 'Close');
    close.onclick = () => this.onClose();

    const body = el('div', 'ct-modal-body', modal);

    const defs: [Tab, string][] = [
      ['graphics', 'Graphics'], ['controls', 'Controls'],
      ['audio', 'Audio'], ['interface', 'Interface'],
    ];
    for (const [id, label] of defs) {
      const b = el('button', '', tabBox, label);
      b.onclick = () => this.setTab(id);
      this.tabs.set(id, b);
      const p = el('div', 'ct-tabbody ct-scroll', body);
      this.panels.set(id, p);
    }

    this.buildGraphics(this.panels.get('graphics')!);
    this.buildControls(this.panels.get('controls')!);
    this.buildAudio(this.panels.get('audio')!);
    this.buildInterface(this.panels.get('interface')!);

    const foot = el('div', 'ct-modal-foot', modal);
    const reset = el('button', 'ct-btn is-ghost is-sm', foot, 'Restore defaults');
    reset.onclick = () => this.restoreDefaults();
    el('div', 'sp', foot);
    const done = el('button', 'ct-btn is-primary is-sm', foot, 'Done');
    done.onclick = () => this.onClose();

    this.setTab('graphics');
    setClass(this.root, 'ct-hidden', true);

    // Rebinding capture. Bound at the panel so it cannot leak to the game.
    window.addEventListener('keydown', this.captureKey, true);
    window.addEventListener('mousedown', this.captureMouse, true);
  }

  private commit(): void {
    this.onChange(this.prefs);
  }

  // -------------------------------------------------------------------------

  private buildGraphics(p: HTMLElement): void {
    groupTitle(p, 'Presets');
    let r = settingRow(p, 'Quality tier', { desc: 'Auto lets the frame-time governor pick.' });
    const qual = segmented<QualityTier | 'auto'>(r, [
      ['low', 'Low'], ['medium', 'Med'], ['high', 'High'], ['ultra', 'Ultra'], ['auto', 'Auto'],
    ], this.prefs.quality, (v) => { this.prefs.quality = v; this.applyTierDefaults(v); this.commit(); });
    this.rebuild.push(() => qual.set(this.prefs.quality));

    r = settingRow(p, 'Render scale', { desc: 'Internal resolution multiplier.' });
    const rs = slider(r, 0.5, 2, 0.05, this.prefs.renderScale, (v) => `${Math.round(v * 100)}%`,
      (v) => { this.prefs.renderScale = v; this.commit(); }, [1]);
    this.rebuild.push(() => rs.set(this.prefs.renderScale));

    r = settingRow(p, 'Field of view');
    const fov = slider(r, 45, 110, 1, this.prefs.fov, (v) => `${Math.round(v)}°`,
      (v) => { this.prefs.fov = v; this.commit(); }, [68]);
    this.rebuild.push(() => fov.set(this.prefs.fov));

    groupTitle(p, 'Lighting & shadows');
    r = settingRow(p, 'Shadows');
    const sh = toggle(r, this.prefs.shadows, (v) => { this.prefs.shadows = v; this.commit(); });
    this.rebuild.push(() => sh.set(this.prefs.shadows));

    r = settingRow(p, 'Shadow resolution');
    const sm = segmented<string>(r, [['1024', '1K'], ['2048', '2K'], ['4096', '4K']],
      String(this.prefs.shadowMapSize), (v) => { this.prefs.shadowMapSize = Number(v); this.commit(); });
    this.rebuild.push(() => sm.set(String(this.prefs.shadowMapSize)));

    r = settingRow(p, 'Ambient occlusion');
    const ao = toggle(r, this.prefs.ssao, (v) => { this.prefs.ssao = v; this.commit(); });
    this.rebuild.push(() => ao.set(this.prefs.ssao));

    groupTitle(p, 'Atmosphere');
    r = settingRow(p, 'Volumetric clouds', { desc: 'Ray-marched cloud layer. Expensive.' });
    const cl = toggle(r, this.prefs.volumetricClouds, (v) => { this.prefs.volumetricClouds = v; this.commit(); });
    this.rebuild.push(() => cl.set(this.prefs.volumetricClouds));

    this.buildWeatherOverride(p);

    groupTitle(p, 'Post-processing');
    r = settingRow(p, 'Bloom');
    const bl = slider(r, 0, 1.5, 0.05, this.prefs.bloom, (v) => v.toFixed(2),
      (v) => { this.prefs.bloom = v; this.commit(); });
    this.rebuild.push(() => bl.set(this.prefs.bloom));

    r = settingRow(p, 'Depth of field');
    const dof = toggle(r, this.prefs.dof, (v) => { this.prefs.dof = v; this.commit(); });
    this.rebuild.push(() => dof.set(this.prefs.dof));

    r = settingRow(p, 'Motion blur');
    const mb = toggle(r, this.prefs.motionBlur, (v) => { this.prefs.motionBlur = v; this.commit(); });
    this.rebuild.push(() => mb.set(this.prefs.motionBlur));

    r = settingRow(p, 'Ink outline weight', { desc: 'Thickness of the cel silhouette pass.' });
    const ow = slider(r, 0, 2, 0.05, this.prefs.outlineWidth, (v) => v.toFixed(2),
      (v) => { this.prefs.outlineWidth = v; this.commit(); }, [1]);
    this.rebuild.push(() => ow.set(this.prefs.outlineWidth));
  }

  /**
   * Local weather and clock override.
   *
   * The match sky is the server's to choose (the flight model predicts against
   * the wind it implies), so this is a *view* override: it repaints the sky the
   * player sees without touching the air anyone integrates against. That is why
   * it is not persisted with the rest of the prefs and why it says so on the
   * row — a stormy sky forced here is a look, not a match.
   *
   * It talks to the engine through the global game object rather than a
   * callback, because everything else on this panel is a persisted preference
   * and threading one non-preference command through 'UiPrefs' would put a
   * debug knob in every player's saved settings forever.
   */
  private buildWeatherOverride(p: HTMLElement): void {
    const r = settingRow(p, 'Weather', {
      desc: 'Local preview only — the server picks the weather for a match.',
    });
    const wx = segmented<WeatherChoice>(r, [
      ['match', 'Match'], ['clear', 'Clear'], ['scattered', 'Cumulus'],
      ['overcast', 'Overcast'], ['storm', 'Storm'], ['fog', 'Fog'],
    ], this.weatherChoice, (v) => {
      this.weatherChoice = v;
      const bus = gameBus();
      if (!bus) return;
      const name = v === 'match' ? matchWeather() : v;
      bus.emit('sky:setWeather', { name, seconds: 6 });
    });
    this.rebuild.push(() => wx.set(this.weatherChoice));

    const rt = settingRow(p, 'Time of day', {
      desc: 'Local preview only. Drag to move the sun; Match restores the server clock.',
    });
    const tod = slider(rt, 0, 24, 0.25, this.todOverride ?? matchTimeOfDay(), formatClock, (v) => {
      this.todOverride = v;
      gameBus()?.emit('sky:timeOfDay', v);
    });
    this.rebuild.push(() => tod.set(this.todOverride ?? matchTimeOfDay()));
    const reset = el('button', 'ct-btn is-ghost is-sm', rt, 'Match');
    reset.onclick = () => {
      this.todOverride = null;
      const h = matchTimeOfDay();
      tod.set(h);
      gameBus()?.emit('sky:timeOfDay', h);
    };
  }

  private applyTierDefaults(tier: QualityTier | 'auto'): void {
    // Presets move the individual switches so the player can see what a tier
    // actually changed rather than having a hidden second state.
    if (tier === 'auto') return;
    const t = tier;
    this.prefs.shadows = t !== 'low';
    this.prefs.shadowMapSize = t === 'ultra' ? 4096 : t === 'high' ? 2048 : 1024;
    this.prefs.volumetricClouds = t === 'high' || t === 'ultra';
    this.prefs.ssao = t !== 'low';
    this.prefs.dof = t === 'ultra';
    this.prefs.motionBlur = t !== 'low';
    this.prefs.bloom = t === 'low' ? 0.3 : 0.55;
    this.prefs.renderScale = t === 'low' ? 0.75 : 1;
    for (const f of this.rebuild) f();
  }

  private buildControls(p: HTMLElement): void {
    groupTitle(p, 'Flight model assistance');
    let r = settingRow(p, 'Assists', {
      desc: 'Arcade keeps the g limiter, stall guard, auto-rudder and wing leveller '
        + 'in the loop — letting go of the controls always recovers.',
    });
    const asst = segmented<AssistLevel>(r, [['arcade', 'Arcade'], ['realistic', 'Realistic']],
      this.prefs.assists, (v) => { this.prefs.assists = v; this.commit(); });
    this.rebuild.push(() => asst.set(this.prefs.assists));

    r = settingRow(p, 'Control mode', {
      desc: 'Mouse aim flies for you; simulator gives raw surface control.',
    });
    const cm = segmented<ControlMode>(r, [
      ['mouse-aim', 'Mouse aim'], ['instructor', 'Assisted'],
      ['realistic', 'Realistic'], ['simulator', 'Sim'],
    ], this.prefs.controlMode, (v) => { this.prefs.controlMode = v; this.commit(); });
    this.rebuild.push(() => cm.set(this.prefs.controlMode));
    this.controlsRebuilt = () => cm.set(this.prefs.controlMode);

    r = settingRow(p, 'Mouse sensitivity');
    const ms = slider(r, 0.2, 3, 0.05, this.prefs.mouseSensitivity, (v) => v.toFixed(2),
      (v) => { this.prefs.mouseSensitivity = v; this.commit(); }, [1]);
    this.rebuild.push(() => ms.set(this.prefs.mouseSensitivity));

    r = settingRow(p, 'Invert vertical axis');
    const iv = toggle(r, this.prefs.invertY, (v) => { this.prefs.invertY = v; this.commit(); });
    this.rebuild.push(() => iv.set(this.prefs.invertY));

    r = settingRow(p, 'Lead indicator assist', { desc: 'How strongly the lead pip is smoothed.' });
    const aa = slider(r, 0, 1, 0.05, this.prefs.aimAssist, (v) => `${Math.round(v * 100)}%`,
      (v) => { this.prefs.aimAssist = v; this.commit(); });
    this.rebuild.push(() => aa.set(this.prefs.aimAssist));

    this.bindHost = el('div', '', p);
    this.paintBindings();
  }

  /** Hands the panel the engine's binding table. Repaints the key list. */
  setBindings(b: BindingSet | null): void {
    this.bindings = b;
    this.paintBindings();
  }

  /** Re-reads preferences into the controls tab (the scheme may change in game). */
  refreshControls(): void { this.controlsRebuilt?.(); }

  private paintBindings(): void {
    const host = this.bindHost;
    if (!host) return;
    this.cancelListen();
    host.textContent = '';
    const b = this.bindings;
    if (!b) {
      groupTitle(host, 'Key bindings');
      el('div', 'ct-row-desc', host, 'Unavailable — the input subsystem is not running.');
      return;
    }
    for (const grp of BINDING_GROUPS) {
      groupTitle(host, grp.title);
      for (const [action, label] of grp.items) {
        const row = el('div', 'ct-bind', host);
        el('span', 'k', row, label);
        const codes = b.codesFor(action).filter((c) => !c.startsWith('Pad'));
        // The alternates are shown but not editable: the second and third
        // entries are the arrow-key and gamepad mirrors, and letting a rebind
        // silently drop them is how a player loses the arrow keys forever.
        if (codes.length > 1) el('span', 'alt', row, codes.slice(1).map(labelFor).join(' · '));
        const btn = el('button', 'ct-key', row, labelFor(codes[0] ?? ''));
        btn.onclick = () => this.beginListen(action, btn);
      }
    }
  }

  private buildAudio(p: HTMLElement): void {
    groupTitle(p, 'Mix');
    const mk = (label: string, get: () => number, set: (v: number) => void) => {
      const r = settingRow(p, label);
      const s = slider(r, 0, 1, 0.01, get(), (v) => `${Math.round(v * 100)}`, (v) => { set(v); this.commit(); });
      this.rebuild.push(() => s.set(get()));
    };
    mk('Master', () => this.prefs.masterVolume, (v) => { this.prefs.masterVolume = v; });
    mk('Effects', () => this.prefs.effectsVolume, (v) => { this.prefs.effectsVolume = v; });
    mk('Engine', () => this.prefs.engineVolume, (v) => { this.prefs.engineVolume = v; });
    mk('Interface', () => this.prefs.uiVolume, (v) => { this.prefs.uiVolume = v; });
  }

  private buildInterface(p: HTMLElement): void {
    groupTitle(p, 'Pilot');
    let r = settingRow(p, 'Callsign', { desc: 'Shown in the killfeed and scoreboard.' });
    textField(r, this.prefs.playerName, 'Pilot', (v) => { this.prefs.playerName = v.slice(0, 20); this.commit(); });

    groupTitle(p, 'Head-up display');
    r = settingRow(p, 'Show HUD');
    const sh = toggle(r, this.prefs.showHud, (v) => { this.prefs.showHud = v; this.commit(); });
    this.rebuild.push(() => sh.set(this.prefs.showHud));

    r = settingRow(p, 'HUD scale');
    const hs = slider(r, 0.75, 1.5, 0.05, this.prefs.hudScale, (v) => `${Math.round(v * 100)}%`,
      (v) => { this.prefs.hudScale = v; this.commit(); }, [1]);
    this.rebuild.push(() => hs.set(this.prefs.hudScale));

    r = settingRow(p, 'Units');
    const un = segmented<Units>(r, [['metric', 'Metric'], ['imperial', 'Imperial']],
      this.prefs.units, (v) => { this.prefs.units = v; this.commit(); });
    this.rebuild.push(() => un.set(this.prefs.units));

    r = settingRow(p, 'Contact markers');
    const cm = toggle(r, this.prefs.showMarkers, (v) => { this.prefs.showMarkers = v; this.commit(); });
    this.rebuild.push(() => cm.set(this.prefs.showMarkers));

    r = settingRow(p, 'Minimap');
    const mm = toggle(r, this.prefs.showMinimap, (v) => { this.prefs.showMinimap = v; this.commit(); });
    this.rebuild.push(() => mm.set(this.prefs.showMinimap));
  }

  // -------------------------------------------------------------------------

  private beginListen(action: Action, node: HTMLElement): void {
    this.cancelListen();
    this.listening = { action, node };
    setClass(node, 'is-listen', true);
    setText(node, 'PRESS…');
  }

  private captureKey = (e: KeyboardEvent): void => {
    if (!this.listening) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code !== 'Escape') this.assign(e.code);
    else this.cancelListen();
  };

  private captureMouse = (e: MouseEvent): void => {
    if (!this.listening) return;
    // Clicking the button that started the capture must not bind LMB to it.
    if (e.target === this.listening.node) return;
    e.preventDefault();
    e.stopPropagation();
    this.assign(`Mouse${e.button}`);
  };

  private assign(code: string): void {
    const b = this.bindings;
    if (!this.listening || !b) return;
    const { action } = this.listening;
    // Keep the alternates: only the primary binding is being replaced.
    const kept = b.codesFor(action).slice(1);
    // A binding is exclusive, so take the code off whatever else held it.
    for (const other of b.actionsFor(code)) {
      if (other === action) continue;
      b.set(other, b.codesFor(other).filter((c) => c !== code));
    }
    b.set(action, [code, ...kept.filter((c) => c !== code)]);
    this.listening = null;
    // Repaint wholesale: a steal changes a row somewhere else on the page.
    this.paintBindings();
    this.commit();
  }

  private cancelListen(): void {
    if (!this.listening) return;
    const { action, node } = this.listening;
    const code = this.bindings?.codesFor(action)[0] ?? '';
    setText(node, labelFor(code));
    setClass(node, 'is-listen', false);
    this.listening = null;
  }

  private restoreDefaults(): void {
    const name = this.prefs.playerName;
    const last = this.prefs.lastAircraft;
    Object.assign(this.prefs, DEFAULT_PREFS, { bindings: { ...DEFAULT_BINDINGS }, playerName: name, lastAircraft: last });
    for (const f of this.rebuild) f();
    this.bindings?.reset();
    this.paintBindings();
    this.commit();
  }

  setTab(t: Tab): void {
    this.tab = t;
    for (const [k, b] of this.tabs) setClass(b, 'is-on', k === t);
    for (const [k, p] of this.panels) setClass(p, 'ct-hidden', k !== t);
  }

  setVisible(v: boolean): void {
    setClass(this.root, 'ct-hidden', !v);
    if (!v) this.cancelListen();
  }

  get isListening(): boolean { return this.listening !== null; }

  dispose(): void {
    window.removeEventListener('keydown', this.captureKey, true);
    window.removeEventListener('mousedown', this.captureMouse, true);
  }
}
