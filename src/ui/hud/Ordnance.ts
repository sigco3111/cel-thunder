import { el, svg, setText, setStyle, setAttr, fixed, distStr } from '../dom';
import { t } from '../../i18n';

/**
 * The two things a pilot needs to use air-to-ground ordnance: a readout of what
 * is still on the aeroplane, and somewhere to put it.
 *
 * ## The readout
 *
 * Modelled on the ammunition counters next to it rather than on a modern
 * stores page: one row per store type, the remaining count large, and a strip
 * of pips — one per hardpoint — so a glance says *which* stations are still
 * loaded rather than only how many. A clean fighter never sees the panel at
 * all.
 *
 * ## The sight
 *
 * A continuously computed impact point. The pipper sits exactly where a bomb
 * released this instant would land, so aiming is: put the pipper on the target,
 * press the button. The solution comes from the flight side, which runs the
 * *actual* ballistic integrator forward rather than a vacuum parabola, so the
 * pipper and the bombs can never disagree.
 *
 * The line from the flight-path marker down to the pipper is the part that
 * makes it usable in a dive. Without it the pipper is an unanchored cross a
 * long way from the reticle and the eye has to hunt for it; with it there is a
 * continuous, foreshortening cue that reads as "the bomb goes *there*", and it
 * doubles as an attitude reference — it lies down as the dive steepens.
 *
 * Both are styled inline. This is a small, self-contained instrument and
 * keeping it out of the shared stylesheet means it cannot collide with the rest
 * of the HUD's layout work.
 */

export interface OrdnanceView {
  name: string;
  short: string;
  bombName: string;
  bombs: number;
  bombsMax: number;
  rocketName: string;
  rockets: number;
  rocketsMax: number;
  hasSolution: boolean;
  ix: number; iy: number; iz: number;
  fallTime: number;
  range: number;
  tooLow: boolean;
  sinceRelease: number;
}

interface StoreRow {
  root: HTMLElement;
  name: HTMLElement;
  count: HTMLElement;
  pips: HTMLElement;
  cells: HTMLElement[];
}

// ---------------------------------------------------------------------------
// Stores panel
// ---------------------------------------------------------------------------

export class OrdnancePanel {
  readonly root: HTMLElement;
  private aux: HTMLElement;
  private bomb: StoreRow;
  private rocket: StoreRow;
  private empty = true;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ct-panel ct-hatch', parent);
    setStyle(this.root, 'display', 'none');
    const h = el('div', 'ct-head', this.root);
    el('span', '', h, t('hudStores'));
    el('span', 'ct-head-rule', h);
    this.aux = el('span', 'ct-head-aux', h, '—');

    this.bomb = this.makeRow();
    this.rocket = this.makeRow();
  }

  private makeRow(): StoreRow {
    const root = el('div', '', this.root);
    setStyle(root, 'display', 'grid');
    setStyle(root, 'grid-template-columns', '1fr auto');
    setStyle(root, 'align-items', 'baseline');
    setStyle(root, 'column-gap', 'var(--s2)');
    setStyle(root, 'margin-top', 'var(--s1)');

    const name = el('span', '', root, '—');
    setStyle(name, 'font-family', 'var(--font-cond)');
    setStyle(name, 'font-size', 'var(--f-micro)');
    setStyle(name, 'letter-spacing', '.09em');
    setStyle(name, 'color', 'var(--hud-dim)');
    setStyle(name, 'white-space', 'nowrap');
    setStyle(name, 'overflow', 'hidden');
    setStyle(name, 'text-overflow', 'ellipsis');

    const count = el('span', '', root, '0');
    setStyle(count, 'font-family', 'var(--font-mono)');
    setStyle(count, 'font-variant-numeric', 'tabular-nums');
    setStyle(count, 'font-size', 'var(--f-sm)');
    setStyle(count, 'font-weight', '700');

    const pips = el('div', '', root);
    setStyle(pips, 'grid-column', '1 / -1');
    setStyle(pips, 'display', 'flex');
    setStyle(pips, 'gap', '2px');
    setStyle(pips, 'margin-top', '3px');

    return { root, name, count, pips, cells: [] };
  }

  /** Grows or shrinks a row's pip strip to match the number of hardpoints. */
  private sizePips(row: StoreRow, n: number): void {
    while (row.cells.length < n) {
      const c = el('i', '', row.pips);
      setStyle(c, 'flex', '1 1 0');
      setStyle(c, 'height', '4px');
      setStyle(c, 'min-width', '4px');
      row.cells.push(c);
    }
    for (let i = 0; i < row.cells.length; i++) {
      setStyle(row.cells[i], 'display', i < n ? 'block' : 'none');
    }
  }

  update(v: OrdnanceView | null): void {
    const on = !!v && (v.bombsMax > 0 || v.rocketsMax > 0);
    if (on !== !this.empty) {
      this.empty = !on;
      setStyle(this.root, 'display', on ? 'block' : 'none');
    }
    if (!on || !v) return;

    setText(this.aux, v.short || '—');
    this.updateRow(this.bomb, v.bombName, v.bombs, v.bombsMax, '#ffd27a');
    this.updateRow(this.rocket, v.rocketName, v.rockets, v.rocketsMax, '#ff9d5c');
  }

  private updateRow(
    row: StoreRow, name: string, left: number, max: number, colour: string,
  ): void {
    if (max <= 0) { setStyle(row.root, 'display', 'none'); return; }
    setStyle(row.root, 'display', 'grid');
    setText(row.name, name.toUpperCase());
    setText(row.count, `${left}/${max}`);
    setStyle(row.count, 'color', left > 0 ? 'var(--hud)' : 'var(--hud-faint)');
    this.sizePips(row, max);
    for (let i = 0; i < max; i++) {
      setStyle(row.cells[i], 'background', i < left ? colour : 'rgba(255,255,255,.13)');
    }
  }
}

// ---------------------------------------------------------------------------
// Bombsight
// ---------------------------------------------------------------------------

/** Radius of the impact pipper, in HUD units. */
const PIP_R = 11;

export class BombSight {
  readonly root: HTMLElement;
  private svg: SVGSVGElement;
  private fall: SVGPathElement;
  private pip: SVGGElement;
  private pipRing: SVGCircleElement;
  private label: SVGTextElement;
  private warn: SVGTextElement;
  private u = 1;
  private w = 1920;
  private h = 1080;
  private visible = false;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ct-layer', parent);
    this.root.id = 'ct-bombsight';
    setStyle(this.root, 'pointer-events', 'none');
    setStyle(this.root, 'display', 'none');

    this.svg = svg('svg', { width: '100%', height: '100%' }, this.root);
    setStyle(this.svg, 'position', 'absolute');
    setStyle(this.svg, 'inset', '0');

    // Fall line: dashed, drawn under the pipper so the cross stays legible.
    this.fall = svg('path', {
      fill: 'none', stroke: 'rgba(255, 200, 110, .55)',
      'stroke-width': 1.6, 'stroke-dasharray': '7 6', 'stroke-linecap': 'round',
    }, this.svg);

    this.pip = svg('g', {}, this.svg);
    this.pipRing = svg('circle', {
      cx: 0, cy: 0, r: PIP_R, fill: 'none',
      stroke: '#ffc86e', 'stroke-width': 2,
    }, this.pip);
    // Cruciform ticks through the ring: a bombing pipper, not a gunsight.
    svg('path', {
      d: `M ${-PIP_R * 1.8} 0 H ${-PIP_R * 0.45} M ${PIP_R * 0.45} 0 H ${PIP_R * 1.8}`
        + ` M 0 ${-PIP_R * 1.8} V ${-PIP_R * 0.45} M 0 ${PIP_R * 0.45} V ${PIP_R * 1.8}`,
      stroke: '#ffc86e', 'stroke-width': 2, 'stroke-linecap': 'round', fill: 'none',
    }, this.pip);
    svg('circle', { cx: 0, cy: 0, r: 1.8, fill: '#ffc86e' }, this.pip);

    this.label = svg('text', {
      x: 0, y: 0, 'text-anchor': 'start', fill: '#ffc86e',
      'font-family': 'var(--font-mono)', 'font-size': 11, 'font-weight': 600,
      'paint-order': 'stroke', stroke: 'rgba(4,8,13,.85)', 'stroke-width': 3,
    }, this.pip);

    this.warn = svg('text', {
      x: 0, y: 0, 'text-anchor': 'middle', fill: '#ff6b57',
      'font-family': 'var(--font-cond)', 'font-size': 13, 'font-weight': 700,
      'letter-spacing': 1.4,
      'paint-order': 'stroke', stroke: 'rgba(4,8,13,.85)', 'stroke-width': 3,
    }, this.pip);
    this.warn.textContent = t('hudTooLow');
  }

  resize(w: number, h: number, u: number): void {
    this.w = w; this.h = h; this.u = u;
    setAttr(this.svg, 'viewBox', `0 0 ${Math.round(w / u)} ${Math.round(h / u)}`);
  }

  /**
   * 'px, py' is the projected impact point in CSS pixels; 'fx, fy' the
   * flight-path marker the fall line springs from. 'onScreen' is false when
   * the impact point is behind the camera or off the frame, in which case the
   * whole instrument is hidden rather than clamped to an edge — a pipper
   * pinned to the frame border is a lie about where the bombs are going.
   */
  update(
    show: boolean, onScreen: boolean,
    px: number, py: number, fx: number, fy: number,
    range: number, fallTime: number, tooLow: boolean,
  ): void {
    const on = show && onScreen;
    if (on !== this.visible) {
      this.visible = on;
      setStyle(this.root, 'display', on ? 'block' : 'none');
    }
    if (!on) return;

    const u = this.u;
    const x = px / u, y = py / u;
    const ax = fx / u, ay = fy / u;

    // A gentle bow toward the pipper, so the line reads as a trajectory rather
    // than as a leader line pointing at a label.
    const mx = (ax + x) * 0.5;
    const my = (ay + y) * 0.5 + Math.min(60, Math.abs(y - ay) * 0.16);
    setAttr(this.fall, 'd', `M ${ax.toFixed(1)} ${ay.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}`);

    setAttr(this.pip, 'transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
    setText(this.label, `${distStr(range)}  ${fixed(fallTime, 1)}s`);
    setAttr(this.label, 'x', PIP_R * 2.2);
    setAttr(this.label, 'y', 4);
    setAttr(this.warn, 'y', PIP_R * 2.9);
    setAttr(this.warn, 'display', tooLow ? 'inline' : 'none');
    // The ring pulses amber → white as the solution tightens up close in, which
    // is the cue that the release is inside its useful envelope.
    setAttr(this.pipRing, 'stroke', tooLow ? '#ff6b57' : '#ffc86e');
    void this.w; void this.h;
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    setStyle(this.root, 'display', 'none');
  }
}
