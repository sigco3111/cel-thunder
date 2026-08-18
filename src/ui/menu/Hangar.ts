import { el, setText, setClass, setStyle, clamp, fixed, int } from '../dom';
import { t } from '../../i18n';
import {
  AIRCRAFT, AIRCRAFT_BY_ID, CLEAN_LOADOUT, loadoutMass, loadoutsFor, nationTeam,
  type AircraftSpec, type Loadout, type Nation,
} from '../../shared/aircraft';
import { NATION_LABEL, ROLE_LABEL } from '../theme';
import { makeRoundel } from './Emblem';
import { HangarViewer } from './HangarViewer';
import { performanceOf, statFraction } from './perf';

const NATIONS: (Nation | 'all')[] = ['all', 'britain', 'usa', 'ussr', 'germany', 'japan'];
const CLEAN = CLEAN_LOADOUT;

/** Aircraft a side may actually field. Never empty. */
export function airframesForTeam(team: number): AircraftSpec[] {
  const list = AIRCRAFT.filter((a) => nationTeam(a.nation) === team);
  return list.length ? list : AIRCRAFT.slice(0, 1);
}

interface StatRow {
  key: string;
  label: string;
  fill: HTMLElement;
  value: HTMLElement;
}

/**
 * Aircraft selection.
 *
 * The stat bars are *comparisons* — each is normalised across the whole roster
 * — because an absolute "580 km/h" tells a new player nothing, while "fastest
 * in the hangar, worst turn time" tells them everything.
 */
export class Hangar {
  readonly root: HTMLElement;
  readonly viewer: HangarViewer;

  private list: HTMLElement;
  private rows: { spec: AircraftSpec; node: HTMLElement }[] = [];
  private nationBtns = new Map<string, HTMLElement>();
  private filter: Nation | 'all' = 'all';
  private selected: AircraftSpec = AIRCRAFT[0];
  private livery = 0;
  /**
   * The side this player flies for. The roster is restricted to it.
   *
   * The hangar used to offer all five airframes to everyone, and the server
   * quietly substituted a valid one when the choice did not match the side it
   * had put you on — so a pilot could select a P-51D, be given a Bf 109, and
   * spend the sortie unable to work out why the Messerschmitts were friendly.
   * A choice that the authority silently overrules is not a choice; the fix is
   * to only ever offer what can actually be flown, and to say which side that
   * is.
   */
  private team = 0;
  private sideEl: HTMLElement;

  private nameEl: HTMLElement;
  private subEl: HTMLElement;
  private stats: StatRow[] = [];
  private extra = new Map<string, HTMLElement>();
  private arms: HTMLElement;
  private loadoutRow: HTMLElement;
  private loadoutNote: HTMLElement;
  private loadout: Loadout = CLEAN;
  private brEl: HTMLElement;
  private notes: HTMLElement;
  private liveryRow: HTMLElement;
  private deployBtn: HTMLButtonElement;

  onDeploy: (spec: AircraftSpec, livery: number, loadout: string) => void = () => {};
  onBack: () => void = () => {};
  onSelect: (spec: AircraftSpec, livery: number) => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ct-screen ct-cine', parent);
    this.root.id = 'ct-hangar';
    for (const c of ['tl', 'tr', 'bl', 'br']) el('div', `ct-corner ${c}`, this.root);

    // --- top bar ----------------------------------------------------------
    const top = el('div', 'ct-topbar', this.root);
    el('div', 'ct-title', top, t('hangarTitle'));
    el('div', 'ct-sub', top, t('hangarSelect'));
    el('div', 'sp', top);
    const back = el('button', 'ct-btn is-ghost is-sm', top, t('hangarBack'));
    back.onclick = () => this.onBack();
    el('div', 'ct-rule', this.root);

    const body = el('div', 'ct-hangar-body', this.root);

    // --- left: roster -----------------------------------------------------
    const left = el('div', 'ct-panel is-glass ct-hatch', body);
    (left as HTMLElement).style.display = 'flex';
    (left as HTMLElement).style.flexDirection = 'column';
    const lh = el('div', 'ct-head', left);
    el('span', '', lh, t('hangarRoster'));
    el('span', 'ct-head-rule', lh);
    // Which side the player is on, stated where the aircraft are chosen. A
    // pilot who does not know whether they are Allied or Axis cannot read a
    // marker colour, and this is the only screen that can tell them before
    // they are in the air.
    this.sideEl = el('span', 'ct-head-aux ct-side', lh, '—');
    const nations = el('div', 'ct-nations', left);
    for (const n of NATIONS) {
      const b = el('button', 'ct-nation', nations);
      if (n !== 'all') makeRoundel(b, n);
      el('span', '', b, n === 'all' ? t('hangarAll') : n.slice(0, 3).toUpperCase());
      b.onclick = () => this.setFilter(n);
      this.nationBtns.set(n, b);
    }
    this.list = el('div', 'ct-planelist ct-scroll', left);

    // --- centre: turntable ------------------------------------------------
    const stage = el('div', 'ct-stage', body);
    const view = el('div', 'ct-stage-view ct-panel is-flat', stage);
    el('div', 'ct-stage-grid', view);
    this.viewer = new HangarViewer(view);
    const nameBox = el('div', 'ct-stage-name', view);
    this.nameEl = el('div', 'n1', nameBox, '—');
    this.subEl = el('div', 'n2', nameBox, '—');
    this.liveryRow = el('div', 'ct-liveries ct-panel is-flat', stage);

    // --- right: stat card -------------------------------------------------
    const card = el('div', 'ct-statcard ct-panel is-glass ct-hatch', body);
    const ch = el('div', 'ct-head', card);
    el('span', '', ch, t('hangarPerformance'));
    el('span', 'ct-head-rule', ch);
    el('span', 'ct-head-aux', ch, t('hangarVsRoster'));

    const statsBox = el('div', 'ct-stats ct-scroll', card);
    const defs: [string, string][] = [
      ['topSpeed', t('statMaxSpeed')],
      ['climb', t('statClimb')],
      ['turnTime', t('statTurnTime')],
      ['rollRate', t('statRollRate')],
      ['firepower', t('statFirepower')],
      ['survivability', t('statSurvivability')],
    ];
    for (const [key, label] of defs) {
      const s = el('div', 'ct-stat', statsBox);
      el('span', 'k', s, label);
      const value = el('span', 'v', s, '—');
      const trk = el('div', 'trk', s);
      const fill = el('i', 'fil', trk);
      this.stats.push({ key, label, fill, value });
    }

    const grid = el('div', '', statsBox);
    (grid as HTMLElement).style.marginTop = 'var(--s2)';
    for (const [k, label] of [
      ['wingLoading', t('statWingLoading')], ['powerToWeight', t('statPowerWeight')],
      ['stallSpeed', t('statStallSpeed')], ['ceiling', t('statCeiling')],
    ] as [string, string][]) {
      const row = el('div', 'ct-kv', grid);
      el('span', 'k', row, label);
      this.extra.set(k, el('span', 'v', row, '—'));
    }

    const ah = el('div', 'ct-head', card);
    el('span', '', ah, t('hangarArmament'));
    el('span', 'ct-head-rule', ah);
    this.arms = el('div', 'ct-arms', card);

    // --- loadout ----------------------------------------------------------
    // Ordnance is a *choice*, not a property of the airframe: a Spitfire with
    // two 250 lb bombs is thirty km/h slower and cannot fight until it has
    // dropped them, so the trade has to be made here rather than assumed.
    const loh = el('div', 'ct-head', card);
    el('span', '', loh, t('hangarLoadout'));
    el('span', 'ct-head-rule', loh);
    this.loadoutRow = el('div', 'ct-liveries ct-panel is-flat', card);
    (this.loadoutRow as HTMLElement).style.flexWrap = 'wrap';
    this.loadoutNote = el('div', 'ct-label', card, '');
    (this.loadoutNote as HTMLElement).style.opacity = '0.72';
    (this.loadoutNote as HTMLElement).style.margin = 'var(--s1) 0 var(--s2)';
    (this.loadoutNote as HTMLElement).style.lineHeight = '1.5';
    (this.loadoutNote as HTMLElement).style.textTransform = 'none';
    (this.loadoutNote as HTMLElement).style.letterSpacing = '.02em';

    const nh = el('div', 'ct-head', card);
    el('span', '', nh, t('hangarDoctrine'));
    el('span', 'ct-head-rule', nh);
    this.notes = el('div', 'ct-notes', card);

    const br = el('div', 'ct-brbadge', card);
    el('span', 'k', br, t('hangarBattleRating'));
    this.brEl = el('span', 'v', br, '—');

    const deploy = el('div', 'ct-deploy', card);
    this.deployBtn = el('button', 'ct-btn is-primary', deploy, t('hangarDeploy')) as HTMLButtonElement;
    this.deployBtn.onclick = () => this.onDeploy(this.selected, this.livery, this.loadout.id);

    // Seeds the roster; 'setTeam' is called again for real as soon as the
    // server (or the sandbox) says which side this pilot is on.
    this.team = -1;
    this.setTeam(0);
  }

  // -------------------------------------------------------------------------

  /**
   * Puts the player on a side and rebuilds the roster around it.
   *
   * Idempotent and safe to call every time the hangar is shown — the team can
   * change between sorties (a rebalance, a reconnect onto the other side), and
   * a hangar still offering the old side's aircraft is exactly the state this
   * whole mechanism exists to prevent.
   */
  setTeam(team: number): void {
    const teamIdx = team === 1 ? 1 : 0;
    if (teamIdx === this.team && this.rows.length) return;
    this.team = teamIdx;
    setText(this.sideEl, t(teamIdx === 0 ? 'hangarAlliedForces' : 'hangarAxisForces'));
    // A nation tab for a side you are not on filters the list down to nothing.
    for (const [n, b] of this.nationBtns) {
      setStyle(b, 'display',
        n === 'all' || nationTeam(n as Nation) === teamIdx ? '' : 'none');
    }
    this.buildList();
    // Whatever was selected may belong to the other side now.
    const allowed = airframesForTeam(teamIdx);
    if (!allowed.includes(this.selected)) this.selected = allowed[0];
    this.setFilter(allowed.some((a) => a.nation === this.filter) ? this.filter : 'all');
  }

  /** The side the player is flying for, as the hangar understands it. */
  get currentTeam(): number { return this.team; }

  private buildList(): void {
    while (this.list.firstChild) this.list.removeChild(this.list.firstChild);
    this.rows = [];
    for (const spec of airframesForTeam(this.team)) {
      const node = el('button', 'ct-plane', this.list);
      const col = el('div', '', node);
      el('div', 'nm', col, spec.name);
      el('div', 'rl', col, `${ROLE_LABEL[spec.role] ?? spec.role} · ${spec.year}`);
      el('span', 'br', node, spec.br.toFixed(1));
      node.onclick = () => this.select(spec);
      this.rows.push({ spec, node });
    }
  }

  setFilter(n: Nation | 'all'): void {
    this.filter = n;
    for (const [k, b] of this.nationBtns) setClass(b, 'is-on', k === n);
    let firstVisible: AircraftSpec | null = null;
    for (const r of this.rows) {
      const show = n === 'all' || r.spec.nation === n;
      setStyle(r.node, 'display', show ? 'grid' : 'none');
      if (show && !firstVisible) firstVisible = r.spec;
    }
    if (firstVisible && (this.filter !== 'all' && this.selected.nation !== this.filter)) {
      this.select(firstVisible);
    } else {
      this.select(this.selected);
    }
  }

  select(spec: AircraftSpec): void {
    this.selected = spec;
    for (const r of this.rows) setClass(r.node, 'is-on', r.spec === spec);

    setText(this.nameEl, spec.name);
    setText(this.subEl, `${NATION_LABEL[spec.nation]} · ${ROLE_LABEL[spec.role] ?? spec.role}`);
    setText(this.brEl, spec.br.toFixed(1));

    const p = performanceOf(spec);
    const fmt: Record<string, string> = {
      topSpeed: `${Math.round(p.topSpeed * 3.6)} km/h`,
      climb: `${p.climb.toFixed(1)} m/s`,
      turnTime: `${p.turnTime.toFixed(1)} s`,
      rollRate: `${Math.round(p.rollRate)} °/s`,
      firepower: `${Math.round(p.firepower)} kJ/s`,
      survivability: `${Math.round(p.survivability)}`,
    };
    for (const s of this.stats) {
      const raw = (p as unknown as Record<string, number>)[s.key];
      const frac = statFraction(s.key as keyof typeof p, raw, s.key === 'turnTime');
      setText(s.value, fmt[s.key] ?? String(Math.round(raw)));
      // Reset then animate so the bars re-run their sweep on every selection.
      setStyle(s.fill, 'transform', 'scaleX(0)');
      const target = clamp(frac, 0.04, 1);
      requestAnimationFrame(() => setStyle(s.fill, 'transform', `scaleX(${target.toFixed(3)})`));
    }
    setText(this.extra.get('wingLoading')!, `${int(p.wingLoading)} kg/m²`);
    setText(this.extra.get('powerToWeight')!, `${int(p.powerToWeight)} kW/t`);
    setText(this.extra.get('stallSpeed')!, `${int(p.stallSpeed * 3.6)} km/h`);
    setText(this.extra.get('ceiling')!, `${int(p.ceiling)} m`);

    while (this.arms.firstChild) this.arms.removeChild(this.arms.firstChild);
    for (const g of spec.guns) {
      const row = el('div', 'ct-arm', this.arms);
      el('span', 'cal', row, t('ammoPrefix', { count: g.count, cal: fixed(g.calibre, g.calibre % 1 ? 1 : 0) }));
      el('span', 'nm', row, g.name.replace(/^[\d.]+\s*mm\s*/i, ''));
      el('span', 'am', row, t('ammoRdsRpm', { rds: g.ammo * g.count, rpm: g.rpm }));
    }
    if (spec.bombs) {
      const row = el('div', 'ct-arm', this.arms);
      el('span', 'cal', row, t('ammoPrefixSimple', { count: spec.bombs.count }));
      el('span', 'nm', row, spec.bombs.name);
      el('span', 'am', row, t('bombKg', { kg: spec.bombs.kg }));
    }
    if (spec.rockets) {
      const row = el('div', 'ct-arm', this.arms);
      el('span', 'cal', row, t('ammoPrefixSimple', { count: spec.rockets.count }));
      el('span', 'nm', row, spec.rockets.name);
      el('span', 'am', row, t('bombKg', { kg: spec.rockets.kg }));
    }

    this.buildLoadouts(spec);
    this.writeNotes(spec, p);
    this.buildLiveries(spec);
    this.viewer.show(spec, this.livery);
    this.viewer.setLoadout(this.loadout.id);
    this.onSelect(spec, this.livery);
  }

  /**
   * A short tactical brief, generated from the numbers rather than written per
   * aircraft: it can never contradict the flight model, and it tells a new
   * player the one thing the bars do not — *how to fly the thing*.
   */
  private writeNotes(spec: AircraftSpec, p: ReturnType<typeof performanceOf>): void {
    while (this.notes.firstChild) this.notes.removeChild(this.notes.firstChild);
    const lines: [string, string][] = [];

    const critKm = (spec.engine.critAlt / 1000).toFixed(1);
    lines.push([t('noteBestAltitudeTitle'), t('noteBestAltitudeBody', { alt: critKm })]);

    if (p.turnTime < 15.5) {
      lines.push([t('noteTurnFightTitle'), t('noteTurnFightBody')]);
    } else if (p.topSpeed * 3.6 > 700) {
      lines.push([t('noteEnergyFightTitle'), t('noteEnergyFightBody')]);
    } else {
      lines.push([t('noteMixedTitle'), t('noteMixedBody')]);
    }

    const cannon = spec.guns.some((g) => g.calibre >= 20);
    lines.push([t('noteGunsTitle'), cannon
      ? t('noteGunsCannon')
      : t('noteGunsRifle')]);

    if (spec.aero.vne < 200) {
      lines.push([t('noteLimitsTitle'), t('noteLimitsDive', { vne: Math.round(spec.aero.vne * 3.6) })]);
    } else if (spec.damage.armour.pilotBack < 6) {
      lines.push([t('noteLimitsTitle'), t('noteLimitsLight')]);
    } else {
      lines.push([t('noteLimitsTitle'), t('noteLimitsStructure', { gLim: spec.aero.gLimit.toFixed(1) })]);
    }

    for (const [k, v] of lines) {
      const row = el('div', 'ct-note', this.notes);
      el('span', 'k', row, k);
      el('span', 'v', row, v);
    }
  }

  /**
   * The loadout chips, and the one line of consequence that matters: how much
   * a strike fit costs in weight, so the choice is informed rather than free.
   */
  private buildLoadouts(spec: AircraftSpec): void {
    while (this.loadoutRow.firstChild) this.loadoutRow.removeChild(this.loadoutRow.firstChild);
    const options = loadoutsFor(spec);
    // Changing aircraft can invalidate the choice; fall back to clean.
    if (!options.some((l) => l.id === this.loadout.id)) this.loadout = options[0];

    for (const l of options) {
      const b = el('button', 'ct-btn is-ghost is-sm', this.loadoutRow, l.name);
      setClass(b, 'is-on', l.id === this.loadout.id);
      if (l.id === this.loadout.id) {
        (b as HTMLElement).style.boxShadow = 'inset 0 0 0 1px var(--accent)';
        (b as HTMLElement).style.color = 'var(--accent)';
      }
      b.onclick = () => {
        this.loadout = l;
        this.buildLoadouts(spec);
        this.viewer.setLoadout(l.id);
      };
    }
    if (options.length <= 1) {
      setText(this.loadoutNote, t('hangarNoHardpoints'));
      return;
    }
    const kg = loadoutMass(this.loadout);
    setText(this.loadoutNote, kg > 0
      ? t('hangarStoresLoaded', { kg: int(kg) })
      : t('hangarClean'));
  }

  private buildLiveries(spec: AircraftSpec): void {
    while (this.liveryRow.firstChild) this.liveryRow.removeChild(this.liveryRow.firstChild);
    el('span', 'ct-label', this.liveryRow, t('hangarLivery'));
    const hexes = (v: number) => `#${(v >>> 0).toString(16).padStart(6, '0')}`;
    for (let i = 0; i < 3; i++) {
      const sw = el('button', 'ct-livery', this.liveryRow);
      const a = hexes(shiftHue(spec.livery.camoA, i * 0.05));
      const b = hexes(shiftHue(spec.livery.camoB, -i * 0.03));
      const u = hexes(spec.livery.under);
      sw.style.background = `linear-gradient(126deg, ${a} 0 44%, ${b} 44% 72%, ${u} 72% 100%)`;
      setClass(sw, 'is-on', i === this.livery);
      sw.onclick = () => {
        this.livery = i;
        this.buildLiveries(spec);
        this.viewer.show(spec, i);
        this.onSelect(spec, i);
      };
    }
    el('span', 'sp', this.liveryRow).style.flex = '1';
    const hint = el('span', 'ct-label', this.liveryRow, t('hangarOrbitHint'));
    hint.style.opacity = '0.6';
  }

  selectById(id: string): void {
    const s = AIRCRAFT_BY_ID[id];
    // An id from the other side cannot be honoured — it is not in the list and
    // the server would substitute it anyway. Ignoring it leaves the hangar
    // showing something the player can actually take off in.
    if (s && nationTeam(s.nation) === this.team) this.select(s);
  }

  get current(): AircraftSpec { return this.selected; }
  get currentLivery(): number { return this.livery; }
  /** Loadout id the player has selected, for the deploy path and respawns. */
  get currentLoadout(): string { return this.loadout.id; }

  handleKey(e: KeyboardEvent): boolean {
    const visible = this.rows.filter((r) => r.node.style.display !== 'none');
    const i = visible.findIndex((r) => r.spec === this.selected);
    if (e.code === 'ArrowDown') { this.select(visible[Math.min(visible.length - 1, i + 1)].spec); return true; }
    if (e.code === 'ArrowUp') { this.select(visible[Math.max(0, i - 1)].spec); return true; }
    if (e.code === 'Enter') { this.onDeploy(this.selected, this.livery, this.loadout.id); return true; }
    return false;
  }

  setVisible(v: boolean): void {
    setClass(this.root, 'ct-hidden', !v);
    this.viewer.setActive(v);
  }

  update(dt: number): void {
    this.viewer.render(dt);
  }
}

function shiftHue(hex: number, amount: number): number {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  // Cheap hue rotation in RGB — enough for a swatch, and avoids pulling in a
  // colour library for three squares.
  const k = amount * 255;
  const nr = clamp(r + k, 0, 255), ng = clamp(g + k * 0.4, 0, 255), nb = clamp(b - k * 0.6, 0, 255);
  return (Math.round(nr) << 16) | (Math.round(ng) << 8) | Math.round(nb);
}
