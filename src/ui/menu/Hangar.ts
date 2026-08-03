import { el, setText, setClass, setStyle, clamp, fixed, int } from '../dom';
import { AIRCRAFT, AIRCRAFT_BY_ID, type AircraftSpec, type Nation } from '../../shared/aircraft';
import { NATION_LABEL, ROLE_LABEL } from '../theme';
import { makeRoundel } from './Emblem';
import { HangarViewer } from './HangarViewer';
import { performanceOf, statFraction } from './perf';

const NATIONS: (Nation | 'all')[] = ['all', 'britain', 'usa', 'ussr', 'germany', 'japan'];

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

  private nameEl: HTMLElement;
  private subEl: HTMLElement;
  private stats: StatRow[] = [];
  private extra = new Map<string, HTMLElement>();
  private arms: HTMLElement;
  private brEl: HTMLElement;
  private notes: HTMLElement;
  private liveryRow: HTMLElement;
  private deployBtn: HTMLButtonElement;

  onDeploy: (spec: AircraftSpec, livery: number) => void = () => {};
  onBack: () => void = () => {};
  onSelect: (spec: AircraftSpec, livery: number) => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ct-screen ct-cine', parent);
    this.root.id = 'ct-hangar';
    for (const c of ['tl', 'tr', 'bl', 'br']) el('div', `ct-corner ${c}`, this.root);

    // --- top bar ----------------------------------------------------------
    const top = el('div', 'ct-topbar', this.root);
    el('div', 'ct-title', top, 'Hangar');
    el('div', 'ct-sub', top, '// SELECT AIRCRAFT');
    el('div', 'sp', top);
    const back = el('button', 'ct-btn is-ghost is-sm', top, 'Back');
    back.onclick = () => this.onBack();
    el('div', 'ct-rule', this.root);

    const body = el('div', 'ct-hangar-body', this.root);

    // --- left: roster -----------------------------------------------------
    const left = el('div', 'ct-panel is-glass ct-hatch', body);
    (left as HTMLElement).style.display = 'flex';
    (left as HTMLElement).style.flexDirection = 'column';
    const lh = el('div', 'ct-head', left);
    el('span', '', lh, 'Roster');
    el('span', 'ct-head-rule', lh);
    const nations = el('div', 'ct-nations', left);
    for (const n of NATIONS) {
      const b = el('button', 'ct-nation', nations);
      if (n !== 'all') makeRoundel(b, n);
      el('span', '', b, n === 'all' ? 'ALL' : n.slice(0, 3).toUpperCase());
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
    el('span', '', ch, 'Performance');
    el('span', 'ct-head-rule', ch);
    el('span', 'ct-head-aux', ch, 'VS ROSTER');

    const statsBox = el('div', 'ct-stats ct-scroll', card);
    const defs: [string, string][] = [
      ['topSpeed', 'Max speed'],
      ['climb', 'Rate of climb'],
      ['turnTime', 'Turn time'],
      ['rollRate', 'Roll rate'],
      ['firepower', 'Firepower'],
      ['survivability', 'Survivability'],
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
      ['wingLoading', 'Wing loading'], ['powerToWeight', 'Power / weight'],
      ['stallSpeed', 'Stall speed'], ['ceiling', 'Service ceiling'],
    ] as [string, string][]) {
      const row = el('div', 'ct-kv', grid);
      el('span', 'k', row, label);
      this.extra.set(k, el('span', 'v', row, '—'));
    }

    const ah = el('div', 'ct-head', card);
    el('span', '', ah, 'Armament');
    el('span', 'ct-head-rule', ah);
    this.arms = el('div', 'ct-arms', card);

    const nh = el('div', 'ct-head', card);
    el('span', '', nh, 'Doctrine');
    el('span', 'ct-head-rule', nh);
    this.notes = el('div', 'ct-notes', card);

    const br = el('div', 'ct-brbadge', card);
    el('span', 'k', br, 'Battle rating');
    this.brEl = el('span', 'v', br, '—');

    const deploy = el('div', 'ct-deploy', card);
    this.deployBtn = el('button', 'ct-btn is-primary', deploy, 'Deploy') as HTMLButtonElement;
    this.deployBtn.onclick = () => this.onDeploy(this.selected, this.livery);

    this.buildList();
    this.setFilter('all');
  }

  // -------------------------------------------------------------------------

  private buildList(): void {
    while (this.list.firstChild) this.list.removeChild(this.list.firstChild);
    this.rows = [];
    for (const spec of AIRCRAFT) {
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
      el('span', 'cal', row, `${g.count}×${fixed(g.calibre, g.calibre % 1 ? 1 : 0)}mm`);
      el('span', 'nm', row, g.name.replace(/^[\d.]+\s*mm\s*/i, ''));
      el('span', 'am', row, `${g.ammo * g.count} rds · ${g.rpm} rpm`);
    }
    if (spec.bombs) {
      const row = el('div', 'ct-arm', this.arms);
      el('span', 'cal', row, `${spec.bombs.count}×`);
      el('span', 'nm', row, spec.bombs.name);
      el('span', 'am', row, `${spec.bombs.kg} kg`);
    }
    if (spec.rockets) {
      const row = el('div', 'ct-arm', this.arms);
      el('span', 'cal', row, `${spec.rockets.count}×`);
      el('span', 'nm', row, spec.rockets.name);
      el('span', 'am', row, `${spec.rockets.kg} kg`);
    }

    this.writeNotes(spec, p);
    this.buildLiveries(spec);
    this.viewer.show(spec, this.livery);
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
    lines.push(['Best altitude', `Peak power at ${critKm} km; power falls away above it.`]);

    if (p.turnTime < 15.5) {
      lines.push(['Turn fight', 'Out-turns most of the roster — force the merge and stay in the horizontal.']);
    } else if (p.topSpeed * 3.6 > 700) {
      lines.push(['Energy fight', 'Dive, fire, climb away. Do not follow a turn fighter into the horizontal.']);
    } else {
      lines.push(['Mixed', 'Comfortable in both planes of manoeuvre; fight whichever the enemy is worse at.']);
    }

    const cannon = spec.guns.some((g) => g.calibre >= 20);
    lines.push(['Guns', cannon
      ? 'Cannon armament — short bursts inside 400 m are decisive.'
      : 'Rifle- and heavy-calibre MGs — sustained fire, aim for the engine and pilot.']);

    if (spec.aero.vne < 200) {
      lines.push(['Limits', `Airframe is fragile in the dive — ${Math.round(spec.aero.vne * 3.6)} km/h never-exceed.`]);
    } else if (spec.damage.armour.pilotBack < 6) {
      lines.push(['Limits', 'Light armour and no self-sealing margin — avoid head-ons.']);
    } else {
      lines.push(['Limits', `Structural limit ${spec.aero.gLimit.toFixed(1)} g; strong airframe.`]);
    }

    for (const [k, v] of lines) {
      const row = el('div', 'ct-note', this.notes);
      el('span', 'k', row, k);
      el('span', 'v', row, v);
    }
  }

  private buildLiveries(spec: AircraftSpec): void {
    while (this.liveryRow.firstChild) this.liveryRow.removeChild(this.liveryRow.firstChild);
    el('span', 'ct-label', this.liveryRow, 'Livery');
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
    const hint = el('span', 'ct-label', this.liveryRow, 'DRAG TO ORBIT · SCROLL TO ZOOM');
    hint.style.opacity = '0.6';
  }

  selectById(id: string): void {
    const s = AIRCRAFT_BY_ID[id];
    if (s) this.select(s);
  }

  get current(): AircraftSpec { return this.selected; }
  get currentLivery(): number { return this.livery; }

  handleKey(e: KeyboardEvent): boolean {
    const visible = this.rows.filter((r) => r.node.style.display !== 'none');
    const i = visible.findIndex((r) => r.spec === this.selected);
    if (e.code === 'ArrowDown') { this.select(visible[Math.min(visible.length - 1, i + 1)].spec); return true; }
    if (e.code === 'ArrowUp') { this.select(visible[Math.max(0, i - 1)].spec); return true; }
    if (e.code === 'Enter') { this.onDeploy(this.selected, this.livery); return true; }
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
