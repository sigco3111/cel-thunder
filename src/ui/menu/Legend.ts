import { el, setClass, setText } from '../dom';
import { t } from '../../i18n';
import {
  BINDING_GROUPS, ESSENTIALS, axisLabel, labelFor, primaryLabel,
  type BindingSet,
} from '../../engine/input/bindings';

/**
 * Teaching the controls.
 *
 * The game shipped with no way to learn what any key did. The settings screen
 * had a "Controls" tab, but it listed a hard-coded table that had drifted away
 * from the real bindings years ago — it claimed WEP was on R (it is Space), the
 * camera on V (it is C) and the cannons on the middle mouse button (they are on
 * the right one), and rebinding anything on it changed nothing, because nothing
 * in the engine read the values it wrote.
 *
 * So both surfaces here render from the live 'BindingSet' — the same object
 * 'InputSystem.down()' dispatches through. A legend that can be wrong is worse
 * than no legend: it costs the player the time to learn it *and* the time to
 * unlearn it.
 *
 * Two of them, because they answer different questions:
 *
 *   'FirstFlight'   — "what do I do right now?" Nine lines, shown once, on the
 *                     very first flight, and never again.
 *   'ControlLegend' — "what was the key for the gear?" Everything, on demand,
 *                     from a key the first-flight card told them about.
 *
 * Both are 'pointer-events: none'. That is not a detail: a panel that swallows
 * clicks would eat the click that takes pointer lock, and the player would be
 * left reading about a mouse that does not work.
 */

type Bindings = BindingSet;

// ---------------------------------------------------------------------------

/** The full, live control list. Toggled in flight; also used by the pause menu. */
export class ControlLegend {
  readonly root: HTMLElement;
  private grid: HTMLElement;
  private bindings: Bindings | null = null;
  private visible = false;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ct-legend ct-hidden', parent);
    const panel = el('div', 'ct-legend-panel ct-panel is-glass is-deep', this.root);

    const head = el('div', 'ct-legend-head', panel);
    el('div', 'ct-title', head, t('legendControls'));
    el('div', 'ct-legend-hint', head, '');
    this.grid = el('div', 'ct-legend-grid', panel);
  }

  /** Hands over the live binding table and paints. Safe to call repeatedly. */
  setBindings(b: Bindings | null): void {
    this.bindings = b;
    this.paint();
  }

  private paint(): void {
    const b = this.bindings;
    this.grid.textContent = '';
    const hint = this.root.querySelector('.ct-legend-hint');
    if (hint) {
      setText(hint as HTMLElement,
        b ? t('legendClosesThis', { key: primaryLabel(b, 'toggleControls') }) : '');
    }
    if (!b) {
      el('div', 'ct-legend-empty', this.grid, t('legendUnavailable'));
      return;
    }
    for (const grp of BINDING_GROUPS) {
      const col = el('div', 'ct-legend-col', this.grid);
      el('div', 'ct-legend-title', col, localizeBindingGroup(grp.title));
      for (const lead of grp.lead ?? []) {
        const row = el('div', 'ct-legend-row', col);
        el('kbd', 'ct-kbd', el('div', 'ct-legend-keys', row), lead.keys);
        el('div', 'ct-legend-name', row, lead.note);
      }
      for (const [action, label] of grp.items) {
        const row = el('div', 'ct-legend-row', col);
        // Every binding, not just the primary one: this is the reference sheet,
        // and "the arrow keys also work" is exactly the sort of thing a player
        // comes here to find out.
        const codes = b.codesFor(action).filter((c) => !c.startsWith('Pad'));
        const keys = el('div', 'ct-legend-keys', row);
        if (!codes.length) el('kbd', 'ct-kbd is-none', keys, '—');
        else for (const c of codes) el('kbd', 'ct-kbd', keys, labelFor(c));
        el('div', 'ct-legend-name', row, localizeBindingLabel(label));
      }
    }
  }

  setVisible(v: boolean): void {
    if (this.visible === v) return;
    this.visible = v;
    if (v) this.paint();
    setClass(this.root, 'ct-hidden', !v);
  }

  toggle(): boolean {
    this.setVisible(!this.visible);
    return this.visible;
  }

  get isOpen(): boolean { return this.visible; }
}

// ---------------------------------------------------------------------------

const SEEN_KEY = 'celthunder.firstflight.v1';

/**
 * The card a player sees on their very first flight, and only then.
 *
 * It is deliberately short. A wall of forty bindings on the first frame of the
 * first sortie is not onboarding, it is a manual; what a new pilot needs is the
 * five things that make the aeroplane go where they want, plus where to find
 * the rest.
 */
export class FirstFlight {
  readonly root: HTMLElement;
  private list: HTMLElement;
  private life = 0;
  private visible = false;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ct-firstflight ct-hidden', parent);
    const panel = el('div', 'ct-ff-panel ct-panel is-glass is-deep', this.root);
    el('div', 'ct-ff-kicker', panel, t('ffKicker'));
    el('div', 'ct-ff-title', panel, t('ffTitle'));
    this.list = el('div', 'ct-ff-list', panel);
    el('div', 'ct-ff-foot', panel, '');
  }

  /** True if this player has never flown before. */
  static isFirstEver(): boolean {
    try { return localStorage.getItem(SEEN_KEY) !== '1'; } catch { return false; }
  }

  private static markSeen(): void {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode */ }
  }

  /**
   * Shows the card, built from the live bindings.
   *
   * @param force  show it even for a returning player (the pause menu's
   *               "Show the basics again").
   */
  show(b: Bindings | null, seconds = 16, force = false): void {
    if (!b) return;
    if (!force && !FirstFlight.isFirstEver()) return;
    FirstFlight.markSeen();

    this.list.textContent = '';
    for (const e of ESSENTIALS) {
      const row = el('div', 'ct-ff-row', this.list);
      const keys = el('div', 'ct-ff-keys', row);
      if (e.literal) el('kbd', 'ct-kbd', keys, e.literal);
      else for (const part of axisLabel(b, e.actions).split(' / ')) {
        el('kbd', 'ct-kbd', keys, part);
      }
      el('div', 'ct-ff-note', row, localizeEssentialNote(e.note));
    }
    const foot = this.root.querySelector('.ct-ff-foot');
    if (foot) {
      setText(foot as HTMLElement,
        t('ffFullList', { key: primaryLabel(b, 'toggleControls') }));
    }

    this.life = seconds;
    this.visible = true;
    setClass(this.root, 'ct-hidden', false);
    // Restart the entrance animation on a re-show.
    this.root.style.animation = 'none';
    void this.root.offsetWidth;
    this.root.style.animation = '';
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.life = 0;
    setClass(this.root, 'ct-hidden', true);
  }

  update(dt: number): void {
    if (!this.visible) return;
    this.life -= dt;
    if (this.life <= 0) this.hide();
  }

  get isOpen(): boolean { return this.visible; }
}

// ---------------------------------------------------------------------------
// Translation helpers — the binding table is *owned* by the engine, so by
// design it still carries English titles and labels (they are paired with the
// action IDs). Translation happens here at the call site, mapping each known
// title or label string to its dictionary key.

export function localizeBindingGroup(title: string): string {
  switch (title) {
    case 'Flight': return t('bindGroupFlight');
    case 'Engine': return t('bindGroupEngine');
    case 'Weapons': return t('bindGroupWeapons');
    case 'Airframe': return t('bindGroupAirframe');
    case 'View': return t('bindGroupView');
    case 'Trim': return t('bindGroupTrim');
    case 'Interface': return t('bindGroupInterface');
    default: return title;
  }
}

export function localizeBindingLabel(label: string): string {
  switch (label) {
    case 'Pull up / nose up': return t('bindPullUp');
    case 'Push / nose down': return t('bindPushDown');
    case 'Roll left': return t('bindRollLeft');
    case 'Roll right': return t('bindRollRight');
    case 'Rudder left': return t('bindRudderLeft');
    case 'Rudder right': return t('bindRudderRight');
    case 'Throttle up': return t('bindThrottleUp');
    case 'Throttle down': return t('bindThrottleDown');
    case 'Throttle 100 %': return t('bindThrottleMax');
    case 'Throttle idle': return t('bindThrottleIdle');
    case 'War emergency power': return t('bindWep');
    case 'Radiator': return t('bindRadiator');
    case 'Machine guns': return t('bindMachineGuns');
    case 'Cannons': return t('bindCannons');
    case 'Release bombs': return t('bindBombs');
    case 'Launch rockets': return t('bindRockets');
    case 'Cycle target': return t('bindCycleTarget');
    case 'Clear target': return t('bindClearTarget');
    case 'Landing gear': return t('bindGear');
    case 'Flaps down a stage': return t('bindFlapsDown');
    case 'Flaps up a stage': return t('bindFlapsUp');
    case 'Air brake': return t('bindAirBrake');
    case 'Wheel brake': return t('bindWheelBrake');
    case 'Bail out (hold)': return t('bindBail');
    case 'Cycle camera': return t('bindCycleCamera');
    case 'Free look (hold)': return t('bindFreeLook');
    case 'Look back': return t('bindLookBack');
    case 'Gunsight zoom (hold)': return t('bindZoom');
    case 'Hide the HUD': return t('bindHideHud');
    case 'This control list': return t('bindThisControlList');
    case 'Trim nose up': return t('bindTrimNoseUp');
    case 'Trim nose down': return t('bindTrimNoseDown');
    case 'Trim left': return t('bindTrimLeft');
    case 'Trim right': return t('bindTrimRight');
    case 'Trim rudder left': return t('bindTrimRudderLeft');
    case 'Trim rudder right': return t('bindTrimRudderRight');
    case 'Reset trim': return t('bindTrimReset');
    case 'Map': return t('bindMap');
    case 'Chat': return t('bindChat');
    case 'Mouse aim / simulator': return t('bindMouseAimSimulator');
    default: return label;
  }
}

function localizeEssentialNote(note: string): string {
  switch (note) {
    case 'Steers — the aeroplane flies to the reticle. Right turns right, back pulls up':
      return t('essMouse');
    case 'Stop moving the mouse and it levels off by itself':
      return t('essLetGo');
    case 'Machine guns / cannons':
      return t('essMachineCannons');
    case 'Pitch — an alternative to the mouse, never a requirement':
      return t('essPitch');
    case 'Roll — likewise':
      return t('essRoll');
    case 'Throttle':
      return t('essThrottle');
    case 'War emergency power':
      return t('essWep');
    case 'Landing gear / flaps':
      return t('essGearFlaps');
    case 'Change camera':
      return t('essCamera');
    case 'Show every control':
      return t('essShowAll');
    default: return note;
  }
}
