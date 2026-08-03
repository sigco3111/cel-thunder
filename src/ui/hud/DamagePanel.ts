import { el, svg, setState, setClass, setStyle, setAttr } from '../dom';
// (setClass is used for both the per-part fire animation and the panel alarm.)
import { DamageBits } from '../../shared/protocol';
import type { AircraftSpec } from '../../shared/aircraft';

/**
 * Battle-damage plan view.
 *
 * The silhouette is generated from the same 'GeometrySpec' the mesh builder
 * uses, so the panel always shows the aircraft you are actually flying — a
 * Spitfire's elliptical wing and a Mustang's wide gear track are both visible
 * at 40 px. Modules light amber on damage and red on failure; a severed wing
 * or tail is drawn as a dashed ghost.
 */
export class DamagePanel {
  readonly root: HTMLElement;
  private svgEl: SVGSVGElement;
  private parts = new Map<string, SVGPathElement>();
  private flags = new Map<string, HTMLElement>();
  private hpFill: HTMLElement;
  private builtFor = '';

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ct-dmg', parent);
    const body = el('div', 'ct-dmg-body', this.root);
    const holder = el('div', '', body);
    this.svgEl = svg('svg', { viewBox: '0 0 100 100' }, holder);

    // Status rows, not labels. Each carries its own state pip so a healthy
    // system reads as "monitored and nominal" rather than as dead grey type —
    // previously every row sat at 22 % alpha with a 10 % hairline whatever the
    // aircraft was doing, so a burning engine looked the same as a factory-fresh
    // one until you noticed the colour, and an undamaged aeroplane looked like a
    // panel of unimplemented placeholder text.
    const col = el('div', 'ct-dmg-flags', body);
    for (const k of ['FIRE', 'FUEL', 'OIL', 'ENGINE', 'PILOT', 'CONTROLS']) {
      const row = el('div', 'ct-dmg-flag', col);
      el('i', 'pip', row);
      el('span', 'k', row, k);
      this.flags.set(k, row);
    }

    const hp = el('div', 'ct-hp', this.root);
    this.hpFill = el('i', '', hp);
  }

  build(spec: AircraftSpec | null): void {
    const key = spec?.id ?? '';
    if (key === this.builtFor) return;
    this.builtFor = key;
    while (this.svgEl.firstChild) this.svgEl.removeChild(this.svgEl.firstChild);
    this.parts.clear();
    if (!spec) return;

    const g = spec.geom;
    const L = g.length;
    const span = spec.aero.span;
    const k = 86 / Math.max(L, span);
    const X = (x: number) => (50 + x * k).toFixed(2);
    const Z = (z: number) => (50 - z * k).toFixed(2);

    const zNose = L * 0.56;
    const zTail = -L * 0.44;
    const r = g.fuseRadius;

    const add = (name: string, d: string, cls = '') => {
      const p = svg('path', { d, class: `part ${cls}` }, this.svgEl);
      this.parts.set(name, p);
      return p;
    };

    // --- wings (drawn first, under the fuselage) --------------------------
    const halfSpan = span * 0.5;
    const sweepOff = Math.tan(g.wing.sweep) * halfSpan;
    const dihedralFade = 1 - Math.abs(g.wing.dihedral) * 0.12; // foreshortening
    const wing = (sgn: number) => {
      const rootLE = g.wingZ + g.wing.rootChord * 0.52;
      const rootTE = g.wingZ - g.wing.rootChord * 0.48;
      const tipZc = g.wingZ - sweepOff;
      const tipLE = tipZc + g.wing.tipChord * 0.5;
      const tipTE = tipZc - g.wing.tipChord * 0.5;
      const xTip = sgn * halfSpan * dihedralFade;
      const xMid = sgn * halfSpan * 0.55 * dihedralFade;
      const midLE = rootLE + (tipLE - rootLE) * 0.55;
      const midTE = rootTE + (tipTE - rootTE) * 0.55;
      if (g.ellipticalWing) {
        // Elliptical planform: quadratic curves through the mid-station give
        // the Spitfire its unmistakable outline.
        return `M ${X(sgn * r * 0.8)} ${Z(rootLE)} ` +
               `Q ${X(xMid)} ${Z(midLE + g.wing.tipChord * 0.22)} ${X(xTip)} ${Z(tipZc)} ` +
               `Q ${X(xMid)} ${Z(midTE - g.wing.tipChord * 0.22)} ${X(sgn * r * 0.8)} ${Z(rootTE)} Z`;
      }
      return `M ${X(sgn * r * 0.8)} ${Z(rootLE)} L ${X(xTip)} ${Z(tipLE)} ` +
             `L ${X(xTip)} ${Z(tipTE)} L ${X(sgn * r * 0.8)} ${Z(rootTE)} Z`;
    };
    add('wingL', wing(-1));
    add('wingR', wing(1));

    // Ailerons: the outer third of the trailing edge.
    const aileron = (sgn: number) => {
      const x0 = sgn * halfSpan * 0.55, x1 = sgn * halfSpan * 0.94;
      const z0 = g.wingZ - sweepOff * 0.55 - g.wing.tipChord * 0.28;
      const z1 = g.wingZ - sweepOff * 0.94 - g.wing.tipChord * 0.34;
      const c = g.wing.tipChord * 0.3;
      return `M ${X(x0)} ${Z(z0)} L ${X(x1)} ${Z(z1)} L ${X(x1)} ${Z(z1 - c)} L ${X(x0)} ${Z(z0 - c)} Z`;
    };
    add('ailL', aileron(-1), 'is-sub');
    add('ailR', aileron(1), 'is-sub');

    // --- tail -------------------------------------------------------------
    const hs = g.hStab;
    const hstab = (sgn: number) =>
      `M ${X(sgn * r * 0.6)} ${Z(hs.z + hs.chord * 0.5)} L ${X(sgn * hs.span * 0.5)} ${Z(hs.z + hs.chord * 0.18)} ` +
      `L ${X(sgn * hs.span * 0.5)} ${Z(hs.z - hs.chord * 0.32)} L ${X(sgn * r * 0.6)} ${Z(hs.z - hs.chord * 0.5)} Z`;
    add('tailL', hstab(-1));
    add('tailR', hstab(1));

    const vs = g.vStab;
    add('rudder',
      `M ${X(-r * 0.34)} ${Z(vs.z + vs.chord * 0.45)} L ${X(r * 0.34)} ${Z(vs.z + vs.chord * 0.45)} ` +
      `L ${X(r * 0.18)} ${Z(vs.z - vs.chord * 0.5)} L ${X(-r * 0.18)} ${Z(vs.z - vs.chord * 0.5)} Z`);

    // --- fuselage ---------------------------------------------------------
    add('fuse',
      `M ${X(0)} ${Z(zNose)} ` +
      `C ${X(r * 0.75)} ${Z(zNose - L * 0.06)} ${X(r)} ${Z(zNose - L * 0.2)} ${X(r)} ${Z(L * 0.12)} ` +
      `C ${X(r)} ${Z(-L * 0.1)} ${X(r * 0.62)} ${Z(zTail + L * 0.14)} ${X(r * 0.26)} ${Z(zTail)} ` +
      `L ${X(-r * 0.26)} ${Z(zTail)} ` +
      `C ${X(-r * 0.62)} ${Z(zTail + L * 0.14)} ${X(-r)} ${Z(-L * 0.1)} ${X(-r)} ${Z(L * 0.12)} ` +
      `C ${X(-r)} ${Z(zNose - L * 0.2)} ${X(-r * 0.75)} ${Z(zNose - L * 0.06)} ${X(0)} ${Z(zNose)} Z`);

    // --- engine / cowling -------------------------------------------------
    const cowlZ0 = zNose, cowlZ1 = zNose - L * 0.26;
    add('engine',
      `M ${X(0)} ${Z(cowlZ0)} C ${X(r * 0.8)} ${Z(cowlZ0 - L * 0.05)} ${X(r * 0.95)} ${Z(cowlZ1 + L * 0.08)} ${X(r * 0.95)} ${Z(cowlZ1)} ` +
      `L ${X(-r * 0.95)} ${Z(cowlZ1)} ` +
      `C ${X(-r * 0.95)} ${Z(cowlZ1 + L * 0.08)} ${X(-r * 0.8)} ${Z(cowlZ0 - L * 0.05)} ${X(0)} ${Z(cowlZ0)} Z`);

    // --- cockpit ----------------------------------------------------------
    const cz = (g.canopy.z0 + g.canopy.z1) * 0.5;
    const cw = g.canopy.width * 0.9;
    add('pilot',
      `M ${X(-cw)} ${Z(cz + g.canopy.z0 * 0.1)} ` +
      `C ${X(-cw)} ${Z(cz + 0.9)} ${X(cw)} ${Z(cz + 0.9)} ${X(cw)} ${Z(cz)} ` +
      `C ${X(cw)} ${Z(cz - 0.9)} ${X(-cw)} ${Z(cz - 0.9)} ${X(-cw)} ${Z(cz)} Z`);

    // Centreline datum, purely graphic — it makes the plan read as a technical
    // drawing rather than a sticker.
    svg('path', {
      d: `M 50 ${Z(zNose + 0.6)} L 50 ${Z(zTail - 0.6)}`,
      class: 'ct-dmg-datum',
    }, this.svgEl);
  }

  update(damage: number, health: number): void {
    const set = (name: string, state: 'ok' | 'hit' | 'crit' | 'gone', fire = false) => {
      const p = this.parts.get(name);
      if (!p) return;
      setState(p, state === 'ok' ? '' : `is-${state}`);
      setClass(p, 'is-fire', fire);
    };

    const d = damage;
    const wingRip = (d & DamageBits.WingRipped) !== 0;
    const lw = (d & DamageBits.LeftWing) !== 0;
    const rw = (d & DamageBits.RightWing) !== 0;
    // WingRipped does not say which side; treat the damaged side as severed,
    // and if both are flagged, both are gone.
    set('wingL', wingRip && lw ? 'gone' : lw ? 'crit' : 'ok');
    set('wingR', wingRip && rw ? 'gone' : rw ? 'crit' : 'ok');
    set('ailL', (d & DamageBits.Aileron) ? 'crit' : lw ? 'hit' : 'ok');
    set('ailR', (d & DamageBits.Aileron) ? 'crit' : rw ? 'hit' : 'ok');

    const tail = (d & DamageBits.Tail) !== 0;
    const elev = (d & DamageBits.Elevator) !== 0;
    set('tailL', tail ? 'gone' : elev ? 'crit' : 'ok');
    set('tailR', tail ? 'gone' : elev ? 'crit' : 'ok');
    set('rudder', (d & DamageBits.Rudder) ? 'crit' : tail ? 'hit' : 'ok');

    const fire = (d & DamageBits.EngineFire) !== 0;
    set('engine', fire ? 'crit' : (d & DamageBits.Engine) ? 'crit' : (d & DamageBits.OilLeak) ? 'hit' : 'ok', fire);
    set('fuse', (d & DamageBits.Destroyed) ? 'gone' : health < 0.45 ? 'crit' : health < 0.8 ? 'hit' : 'ok');
    set('pilot', (d & DamageBits.PilotDead) ? 'gone' : (d & DamageBits.PilotHit) ? 'crit' : 'ok');

    // Three states, not two: nominal, degraded (amber) and failed/burning (red,
    // pulsing). A fire is the loudest thing the airframe can tell you, so it
    // also drives the engine row — an engine that is alight is not merely
    // "damaged" — and lifts the whole panel into an alarm frame.
    const flag = (k: string, state: '' | 'is-warn' | 'is-on') => {
      const f = this.flags.get(k);
      if (f) setState(f, state);
    };
    flag('FIRE', fire ? 'is-on' : '');
    flag('FUEL', (d & DamageBits.FuelLeak) ? 'is-warn' : '');
    flag('OIL', (d & DamageBits.OilLeak) ? 'is-warn' : '');
    flag('ENGINE', fire || (d & DamageBits.Engine) ? 'is-on' : (d & DamageBits.OilLeak) ? 'is-warn' : '');
    flag('PILOT', (d & DamageBits.PilotDead) ? 'is-on' : (d & DamageBits.PilotHit) ? 'is-warn' : '');
    flag('CONTROLS', (d & DamageBits.ControlsSevered) ? 'is-on'
      : (d & (DamageBits.Aileron | DamageBits.Elevator | DamageBits.Rudder)) ? 'is-warn' : '');
    setClass(this.root, 'is-alarm', fire);

    const h = Math.max(0, Math.min(1, health));
    setStyle(this.hpFill, 'transform', `scaleX(${h.toFixed(3)})`);
    setStyle(this.hpFill, 'background', h > 0.6 ? 'var(--ok)' : h > 0.3 ? 'var(--warn)' : 'var(--danger)');
    setAttr(this.svgEl, 'data-dead', (d & DamageBits.Destroyed) ? '1' : '0');
  }
}
