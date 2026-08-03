import { el, setText, setClass, clamp } from '../dom';
import { BINDING_GROUPS, DEFAULT_BINDINGS, DEFAULT_PREFS, keyLabel, type ControlMode, type UiPrefs, type Units } from '../store';
import { segmented, settingRow, slider, toggle, textField, groupTitle } from './controls';
import type { QualityTier } from '../../engine/context';

type Tab = 'graphics' | 'controls' | 'audio' | 'interface';

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
  private listening: { key: string; node: HTMLElement } | null = null;
  private keyNodes = new Map<string, HTMLElement>();
  private rebuild: (() => void)[] = [];

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
    let r = settingRow(p, 'Control mode', {
      desc: 'Mouse aim flies for you; simulator gives raw surface control.',
    });
    const cm = segmented<ControlMode>(r, [
      ['mouse-aim', 'Mouse aim'], ['instructor', 'Assisted'],
      ['realistic', 'Realistic'], ['simulator', 'Sim'],
    ], this.prefs.controlMode, (v) => { this.prefs.controlMode = v; this.commit(); });
    this.rebuild.push(() => cm.set(this.prefs.controlMode));

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

    for (const grp of BINDING_GROUPS) {
      groupTitle(p, grp.title);
      for (const [key, label] of grp.items) {
        const row = el('div', 'ct-bind', p);
        el('span', 'k', row, label);
        const btn = el('button', 'ct-key', row, keyLabel(this.prefs.bindings[key] ?? ''));
        btn.onclick = () => this.beginListen(key, btn);
        this.keyNodes.set(key, btn);
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

  private beginListen(key: string, node: HTMLElement): void {
    if (this.listening) setClass(this.listening.node, 'is-listen', false);
    this.listening = { key, node };
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
    if (!this.listening) return;
    const { key, node } = this.listening;
    // A binding is exclusive: steal it from whatever held it.
    for (const [k, v] of Object.entries(this.prefs.bindings)) {
      if (v === code && k !== key) {
        this.prefs.bindings[k] = '';
        const other = this.keyNodes.get(k);
        if (other) setText(other, '—');
      }
    }
    this.prefs.bindings[key] = code;
    setText(node, keyLabel(code));
    setClass(node, 'is-listen', false);
    this.listening = null;
    this.commit();
  }

  private cancelListen(): void {
    if (!this.listening) return;
    setText(this.listening.node, keyLabel(this.prefs.bindings[this.listening.key] ?? ''));
    setClass(this.listening.node, 'is-listen', false);
    this.listening = null;
  }

  private restoreDefaults(): void {
    const name = this.prefs.playerName;
    const last = this.prefs.lastAircraft;
    Object.assign(this.prefs, DEFAULT_PREFS, { bindings: { ...DEFAULT_BINDINGS }, playerName: name, lastAircraft: last });
    for (const f of this.rebuild) f();
    for (const [k, node] of this.keyNodes) setText(node, keyLabel(this.prefs.bindings[k] ?? ''));
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
