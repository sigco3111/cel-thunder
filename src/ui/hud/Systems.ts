import { el, svg, setText, setStyle, setState, setClass, setAttr, setSvgTransform, clamp, fixed } from '../dom';
import { gaugeState } from '../theme';
import type { AmmoState } from '../Telemetry';

/** A labelled horizontal bar with the shared ok/warn/danger ramp. */
export class Gauge {
  readonly root: HTMLElement;
  private fil: HTMLElement;
  private val: HTMLElement;

  constructor(parent: HTMLElement, key: string, redlineFrac = 0.86) {
    this.root = el('div', 'ct-gauge is-ok', parent);
    el('span', 'k', this.root, key);
    const trk = el('div', 'trk', this.root);
    this.fil = el('i', 'fil', trk);
    const lim = el('i', 'lim', trk);
    lim.style.left = `${redlineFrac * 100}%`;
    this.val = el('span', 'v', this.root, '—');
  }

  /** 'frac' fills the bar; 'badness' (default = frac) drives the colour. */
  update(frac: number, text: string, badness = frac): void {
    setStyle(this.fil, 'transform', `scaleX(${clamp(frac, 0, 1).toFixed(3)})`);
    setText(this.val, text);
    setState(this.root, gaugeState(badness));
  }
}

/** Throttle bar with the WEP detent shaded at the top of travel. */
export class ThrottleBar {
  readonly root: HTMLElement;
  private fil: HTMLElement;
  private val: HTMLElement;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ct-thr', parent);
    el('span', 'k', this.root, 'THR');
    const trk = el('div', 'trk', this.root);
    this.fil = el('i', 'fil', trk);
    el('i', 'wep', trk);
    this.val = el('span', 'v', this.root, '0%');
  }

  update(throttle: number, wep: boolean): void {
    setStyle(this.fil, 'transform', `scaleX(${clamp(throttle, 0, 1).toFixed(3)})`);
    setText(this.val, wep ? 'WEP' : `${Math.round(throttle * 100)}%`);
    setClass(this.root, 'is-wep', wep);
  }
}

/** Row of state chips (gear, flaps, brakes, …). */
export class FlagRow {
  readonly root: HTMLElement;
  private flags = new Map<string, HTMLElement>();

  constructor(parent: HTMLElement, keys: string[]) {
    this.root = el('div', 'ct-flags', parent);
    for (const k of keys) this.flags.set(k, el('div', 'ct-flag', this.root, k));
  }

  set(key: string, state: '' | 'on' | 'warn' | 'danger'): void {
    const f = this.flags.get(key);
    if (!f) return;
    setState(f, state ? `is-${state}` : '');
  }

  setLabel(key: string, text: string): void {
    const f = this.flags.get(key);
    if (f) setText(f, text);
  }
}

/** Per-gun ammunition counters, rebuilt whenever the aircraft changes. */
export class AmmoPanel {
  readonly root: HTMLElement;
  private rows: { row: HTMLElement; count: HTMLElement; bar: HTMLElement; name: HTMLElement }[] = [];
  private builtFor = '';

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ct-ammo', parent);
  }

  build(ammo: AmmoState[], key: string): void {
    if (key === this.builtFor) return;
    this.builtFor = key;
    while (this.root.firstChild) this.root.removeChild(this.root.firstChild);
    this.rows = [];
    for (const a of ammo) {
      const row = el('div', 'ct-ammo-row', this.root);
      const name = el('span', 'n', row, `${a.calibre}mm ${a.short}`);
      const count = el('span', 'c', row, String(a.rounds));
      const bar = el('div', 'ct-ammo-bar', row);
      const fil = el('i', '', bar);
      // The tracer colour identifies which trigger group a row belongs to
      // without spending a label on it.
      fil.style.background = `#${(a.tracer >>> 0).toString(16).padStart(6, '0')}`;
      this.rows.push({ row, count, bar: fil, name });
    }
  }

  update(ammo: AmmoState[]): void {
    for (let i = 0; i < this.rows.length && i < ammo.length; i++) {
      const a = ammo[i], r = this.rows[i];
      const f = a.max > 0 ? a.rounds / a.max : 0;
      setText(r.count, String(a.rounds));
      setStyle(r.bar, 'transform', `scaleX(${f.toFixed(3)})`);
      setClass(r.row, 'is-low', f <= 0.25 && f > 0);
      setClass(r.row, 'is-empty', a.rounds <= 0);
    }
  }
}

/**
 * Accelerometer dial with dragging peak needles.
 *
 * Scale runs −5 … +12 g over 280°, laid out like a wartime three-pointer
 * accelerometer: negative g at the lower left, the 1 g datum where the needle
 * rests in level flight, positive g sweeping clockwise over the top to the
 * structural limit at the lower right.
 *
 * The dial and the figure under it are one instrument and have to agree, which
 * previously they did not:
 *
 *  - the needle was clamped to the dial's −5 … +12 range while the figure
 *    printed the raw value, so past the end of the scale the pointer parked and
 *    the number carried on climbing — the two halves of the same readout saying
 *    different things at the one moment the pilot cares most;
 *  - the figure was warned amber at 0.85 × the structural limit while the red
 *    arc on the dial started at the limit itself, so number and arc disagreed
 *    about where danger began;
 *  - the figure sat at r = 0 in the middle of the lower gap at 20 px, straddling
 *    the "12" label at (66, 69) and the unit caption below it. Three pieces of
 *    type in one place is not a readout.
 *
 * So: the pointer's clamp is shared with the figure (over-range prints a chevron
 * rather than a number the needle cannot show), the amber band is derived from
 * the same gLimit that paints the arc, the dial is lifted off centre and the
 * figure gets its own plate in the space that opens up underneath.
 */
export class GMeter {
  readonly root: HTMLElement;
  private needle: SVGGElement;
  private peak: SVGGElement;
  private min: SVGGElement;
  private val: SVGTextElement;
  private lim: SVGPathElement;
  private datum: SVGPathElement;
  private gLimit = 9;
  private static readonly G0 = -5;
  private static readonly G1 = 12;
  private static readonly A0 = 130;   // degrees, screen space
  private static readonly A1 = 410;
  /** Dial centre. Lifted above the box centre to open a readout well below it. */
  private static readonly CX = 50;
  private static readonly CY = 44;

  private static ang(g: number): number {
    return GMeter.A0 + (g - GMeter.G0) / (GMeter.G1 - GMeter.G0) * (GMeter.A1 - GMeter.A0);
  }

  private static pt(g: number, r: number): [number, number] {
    const a = GMeter.ang(g) * Math.PI / 180;
    return [GMeter.CX + Math.cos(a) * r, GMeter.CY + Math.sin(a) * r];
  }

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ct-gmeter', parent);
    const s = svg('svg', { viewBox: '0 0 100 100' }, this.root);
    const pt = GMeter.pt;

    // Dial ground. Without it the tick ring and the pointer are hairlines on
    // whatever the aeroplane happens to be over, and against a cumulus top the
    // instrument disappears entirely — the same failure the pitch ladder had.
    svg('circle', { cx: GMeter.CX, cy: GMeter.CY, r: 42, class: 'ct-gm-face' }, s);

    // Dial face
    let ticks = '';
    for (let g = -4; g <= 12; g += 1) {
      const major = g % 2 === 0;
      const [x0, y0] = pt(g, major ? 28 : 32);
      const [x1, y1] = pt(g, 37);
      ticks += `M ${x0.toFixed(2)} ${y0.toFixed(2)} L ${x1.toFixed(2)} ${y1.toFixed(2)} `;
    }
    svg('path', { d: ticks, class: 'ct-gm-tick' }, s);

    const arcTo = (g0: number, g1: number) => {
      const [x0, y0] = pt(g0, 40);
      const [x1, y1] = pt(g1, 40);
      const large = (GMeter.ang(g1) - GMeter.ang(g0)) > 180 ? 1 : 0;
      return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A 40 40 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    };
    svg('path', { d: arcTo(GMeter.G0, GMeter.G1), class: 'ct-gm-arc' }, s);
    this.lim = svg('path', { d: arcTo(9, GMeter.G1), class: 'ct-gm-red' }, s);

    // 1 g datum. Straight-and-level is the reading the pointer holds for most
    // of a sortie, and marking it is what lets the eye check the needle against
    // the scale without reading a single figure.
    const [dx0, dy0] = pt(1, 24);
    const [dx1, dy1] = pt(1, 40);
    this.datum = svg('path', {
      d: `M ${dx0.toFixed(2)} ${dy0.toFixed(2)} L ${dx1.toFixed(2)} ${dy1.toFixed(2)}`,
      class: 'ct-gm-datum',
    }, s);

    // Figures pulled inside the tick ring so nothing can collide with the
    // readout well at the bottom of the box.
    for (const g of [0, 4, 8, 12]) {
      const [x, y] = pt(g, 20);
      const t = svg('text', { x: x.toFixed(1), y: (y + 2.2).toFixed(1), 'text-anchor': 'middle', class: 'ct-gm-lbl' }, s);
      t.textContent = String(g);
    }

    const tri = `M ${GMeter.CX} ${GMeter.CY - 32} L ${GMeter.CX - 3} ${GMeter.CY - 38} L ${GMeter.CX + 3} ${GMeter.CY - 38} Z`;
    this.min = svg('g', { class: 'ct-gm-peak is-min' }, s);
    svg('path', { d: tri }, this.min);
    this.peak = svg('g', { class: 'ct-gm-peak' }, s);
    svg('path', { d: tri }, this.peak);

    this.needle = svg('g', { class: 'ct-gm-needle' }, s);
    svg('path', {
      d: `M ${GMeter.CX} ${GMeter.CY} L ${GMeter.CX - 1.6} ${GMeter.CY - 8} `
        + `L ${GMeter.CX} ${GMeter.CY - 36} L ${GMeter.CX + 1.6} ${GMeter.CY - 8} Z`,
    }, this.needle);
    svg('circle', { cx: GMeter.CX, cy: GMeter.CY, r: 3.2, class: 'ct-gm-hub' }, s);

    // Readout well: a plate, the figure, and the unit on the same baseline.
    svg('rect', { x: 26, y: 80, width: 48, height: 18, class: 'ct-gm-plate' }, s);
    this.val = svg('text', { x: 58, y: 94, 'text-anchor': 'end', class: 'ct-gm-val' }, s);
    const lbl = svg('text', { x: 61, y: 94, 'text-anchor': 'start', class: 'ct-gm-unit' }, s);
    lbl.textContent = 'G';
  }

  /** 'gLimit' paints the structural red arc from the spec. */
  update(g: number, peak: number, min: number, gLimit: number): void {
    const rot = (v: number) =>
      // The needle art points up (−90°), so add that back onto the dial angle.
      `rotate(${(GMeter.ang(clamp(v, GMeter.G0, GMeter.G1)) + 90).toFixed(2)} ${GMeter.CX} ${GMeter.CY})`;
    setSvgTransform(this.needle, rot(g));
    setSvgTransform(this.peak, rot(peak));
    setSvgTransform(this.min, rot(min));

    // The figure never states something the pointer cannot show. Past the end
    // of the scale it reads as an over-range chevron, which is unambiguous and
    // cannot be mistaken for a live number.
    const over = g > GMeter.G1 ? 1 : g < GMeter.G0 ? -1 : 0;
    setText(this.val, over > 0 ? '›12' : over < 0 ? '‹−5' : fixed(g, 1));

    // One threshold for the figure and the arc: amber from 85 % of the
    // structural limit, red at the limit — the point where the arc turns red.
    const lim = gLimit > 0 ? gLimit : this.gLimit;
    const a = Math.abs(g);
    const state = a >= lim || over !== 0 ? ' is-danger' : a >= lim * 0.85 ? ' is-warn' : '';
    setAttr(this.val, 'class', `ct-gm-val${state}`);

    // Peak needles only mean something once they are away from the datum;
    // parked on top of the pointer at 1 g they are just two more marks.
    setAttr(this.peak, 'display', peak > 1.6 ? 'inline' : 'none');
    setAttr(this.min, 'display', min < 0.4 ? 'inline' : 'none');
  }

  setLimit(gLimit: number): void {
    this.gLimit = gLimit;
    const g0 = clamp(gLimit, -4, GMeter.G1);
    const [x0, y0] = GMeter.pt(g0, 40);
    const [x1, y1] = GMeter.pt(GMeter.G1, 40);
    setAttr(this.lim, 'd', `M ${x0.toFixed(2)} ${y0.toFixed(2)} A 40 40 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`);
    setAttr(this.datum, 'display', 'inline');
  }
}
