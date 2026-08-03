import { el, svg, setText, setTransform, setStyle, setClass, clamp } from '../dom';

/**
 * Vertical moving-scale tapes (airspeed on the left, altitude on the right)
 * with an odometer readout, plus the vertical-speed strip.
 *
 * The scale is built once as an SVG whose user units *are* design pixels and
 * whose CSS size is 'designPx × u'. That means a resize is two style writes
 * instead of a rebuild, and the tick spacing stays exact at any DPI.
 */

export interface TapeConfig {
  min: number;
  max: number;
  /** Value between minor ticks. */
  tick: number;
  /** Every n-th tick is major and carries a label. */
  labelEvery: number;
  /** Design pixels per minor tick. */
  spacing: number;
  unit: string;
  digits: number;
  /** Round the odometer to this multiple (altitude reads in 10 s of metres). */
  quantum: number;
}

const W = 96; // strip width in design px

export class Tape {
  readonly root: HTMLElement;
  /** The odometer chip. Exposed so the marker layer can refuse to draw over it. */
  readonly chip: HTMLElement;
  /** The two auxiliary chips above and below the tape (TAS/MACH, RDR/VS). */
  readonly subs: HTMLElement[];
  private mask: HTMLElement;
  private strip: HTMLElement;
  private stripSvg: SVGSVGElement;
  private odo: Odometer;
  private subTop: HTMLElement;
  private subBot: HTMLElement;
  private subTopV: HTMLElement;
  private subBotV: HTMLElement;
  private cfg: TapeConfig;
  private pxPerUnit = 1;
  private totalH = 1;
  private u = 1;
  private side: 'left' | 'right';

  constructor(parent: HTMLElement, side: 'left' | 'right', cfg: TapeConfig, topKey: string, botKey: string) {
    this.side = side;
    this.cfg = cfg;
    this.root = el('div', `ct-tape is-${side}`, parent);
    this.mask = el('div', 'ct-tape-mask', this.root);
    this.strip = el('div', 'ct-tape-strip', this.mask);
    this.stripSvg = svg('svg', { preserveAspectRatio: 'none' }, this.strip);
    el('div', 'ct-tape-rule', this.root);

    const read = el('div', 'ct-readout', this.root);
    this.chip = read;
    this.odo = new Odometer(read, cfg.digits);
    el('span', 'ct-odo-unit', read, cfg.unit);
    el('div', 'ct-caret', this.root);

    this.subTop = el('div', 'ct-tape-sub is-top', this.root);
    el('span', 'k', this.subTop, topKey);
    this.subTopV = el('span', 'v', this.subTop, '—');
    this.subBot = el('div', 'ct-tape-sub is-bot', this.root);
    el('span', 'k', this.subBot, botKey);
    this.subBotV = el('span', 'v', this.subBot, '—');
    this.subs = [this.subTop, this.subBot];

    this.build();
  }

  setConfig(cfg: TapeConfig): void {
    this.cfg = cfg;
    this.build();
    this.resize(this.u);
  }

  private build(): void {
    const c = this.cfg;
    const n = Math.round((c.max - c.min) / c.tick);
    this.pxPerUnit = c.spacing / c.tick;
    this.totalH = n * c.spacing;
    const s = this.stripSvg;
    while (s.firstChild) s.removeChild(s.firstChild);
    s.setAttribute('viewBox', `0 0 ${W} ${this.totalH}`);

    // One path for all minor ticks and one for all major ticks keeps this to
    // two draw nodes instead of several hundred.
    let minor = '', major = '';
    const texts: string[] = [];
    for (let i = 0; i <= n; i++) {
      const v = c.min + i * c.tick;
      // Value increases upward, so the tape is built top-down from max.
      const y = (c.max - v) * this.pxPerUnit;
      const isMajor = i % c.labelEvery === 0;
      if (this.side === 'left') {
        if (isMajor) major += `M ${W - 4} ${y} L ${W - 22} ${y} `;
        else minor += `M ${W - 4} ${y} L ${W - 13} ${y} `;
      } else {
        if (isMajor) major += `M 4 ${y} L 22 ${y} `;
        else minor += `M 4 ${y} L 13 ${y} `;
      }
      if (isMajor) texts.push(`${y}|${v}`);
    }
    svg('path', { d: minor, class: 'ct-tape-minor' }, s);
    svg('path', { d: major, class: 'ct-tape-major' }, s);
    for (const t of texts) {
      const [ys, vs] = t.split('|');
      const tx = svg('text', {
        x: this.side === 'left' ? W - 27 : 27,
        y: Number(ys) + 5,
        'text-anchor': this.side === 'left' ? 'end' : 'start',
        class: 'ct-tape-lbl',
      }, s);
      tx.textContent = vs;
    }
  }

  resize(u: number): void {
    this.u = u;
    setStyle(this.stripSvg, 'width', `${W * u}px`);
    setStyle(this.stripSvg, 'height', `${this.totalH * u}px`);
    setStyle(this.stripSvg, 'display', 'block');
    this.odo.resize(u);
  }

  /** 'value' is already in display units. */
  update(value: number): void {
    const c = this.cfg;
    const v = clamp(value, c.min, c.max);
    // Translate so the current value sits on the tape's centreline.
    const y = -(c.max - v) * this.pxPerUnit * this.u;
    setTransform(this.strip, `translate3d(0,${y.toFixed(1)}px,0)`);
    this.odo.set(v / Math.max(1e-6, c.quantum));
  }

  setSub(top: string, bot: string, topState = '', botState = ''): void {
    setText(this.subTopV, top);
    setText(this.subBotV, bot);
    setClass(this.subTopV, 'is-warn', topState === 'warn');
    setClass(this.subTopV, 'is-danger', topState === 'danger');
    setClass(this.subBotV, 'is-warn', botState === 'warn');
    setClass(this.subBotV, 'is-danger', botState === 'danger');
  }
}

// ---------------------------------------------------------------------------

/**
 * Mechanical odometer readout.
 *
 * A real altimeter drum only rolls the digit that is actually changing, and it
 * rolls the one above it only during the carry. Reproducing that (rather than
 * sliding every column) is what makes the readout feel like an instrument.
 */
export class Odometer {
  private root: HTMLElement;
  private cols: HTMLElement[] = [];
  private cells: HTMLElement[] = [];
  private sign: HTMLElement | null = null;
  private digitH = 26;
  private u = 1;

  constructor(parent: HTMLElement, digits: number, withSign = false) {
    this.root = el('div', 'ct-odo', parent);
    if (withSign) this.sign = el('span', 'ct-odo-sign', this.root, '+');
    for (let i = 0; i < digits; i++) {
      const cell = el('div', 'ct-odo-d', this.root);
      const col = el('div', 'ct-odo-col', cell);
      // 0…9 plus a repeated 0 so the wrap from 9 to 0 is continuous.
      col.textContent = '0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n0';
      col.style.whiteSpace = 'pre';
      this.cells.push(cell);
      this.cols.push(col);
    }
  }

  resize(u: number): void {
    this.u = u;
    // Must equal the cell height in CSS exactly. It was 24 against a 26 px
    // window, so the window was always showing 2 px of the neighbouring glyph —
    // a permanent white sliver above the leading digit that reads as a drum
    // that has failed to seat.
    this.digitH = CELL_H * u;
  }

  set(value: number): void {
    const neg = value < 0;
    if (this.sign) setText(this.sign, neg ? '−' : '+');
    const v = Math.abs(value);
    const n = this.cols.length;

    /*
     * Carry chain.
     *
     * A drum altimeter does not slide every column at once. Only the ones drum
     * turns continuously; the tens drum is dragged by the ones' 9 -> 0 carry and
     * is stationary the rest of the time, the hundreds by the tens', and so on
     * up the stack. The previous rule — "roll whenever this column is in the
     * last 12 % of its own decade" — is not that: at 596 km/h the hundreds
     * column is 96 % of the way through its decade, so the leading 5 was sitting
     * two thirds of a glyph out of line with the 9 and the 6 beside it for the
     * whole twelve km/h from 588 to 600. Three digits at three different heights
     * is exactly the "clipped rolling digit" the readout was accused of.
     *
     * So the roll is computed once, on the ones column, and propagated upward
     * only through columns whose lower neighbour is actually showing a 9 and
     * actually rolling. Every other column is pinned dead on its glyph.
     */
    let roll = 0;
    let carry = true;
    for (let i = n - 1; i >= 0; i--) {
      const place = n - 1 - i;              // 0 = ones column
      const p = Math.pow(10, place);
      const scaled = v / p;
      const d = Math.floor(scaled) % 10;
      const frac = scaled - Math.floor(scaled);

      if (place === 0) {
        // Ease the transit so the drum spends most of the roll window seated on
        // a glyph and crosses the illegible half-way point quickly. Linear
        // motion leaves it legibly split for the whole window.
        const t = frac > ROLL_START ? (frac - ROLL_START) / (1 - ROLL_START) : 0;
        roll = t * t * t * (t * (t * 6 - 15) + 10);
      } else if (!carry) {
        roll = 0;
      }
      setTransform(this.cols[i], `translate3d(0,${(-(d + roll) * this.digitH).toFixed(2)}px,0)`);
      // This column only drags the one above it if it is on 9 and moving.
      carry = carry && d === 9 && roll > 0;
    }

    // Leading-zero suppression runs top-down, so it needs its own pass.
    let leading = true;
    for (let i = 0; i < n; i++) {
      const place = n - 1 - i;
      const p = Math.pow(10, place);
      const blank = leading && Math.floor(v / p) % 10 === 0 && place > 0 && v < p;
      setClass(this.cells[i], 'is-blank', blank);
      if (!blank) leading = false;
    }
  }
}

/** Digit cell height in design px. Mirrors '.ct-odo-d' / '.ct-odo-col'. */
const CELL_H = 26;
/** Fraction of the ones digit's cycle spent carrying to the next glyph. */
const ROLL_START = 0.9;

// ---------------------------------------------------------------------------

/**
 * Vertical-speed strip: a bar growing up or down from a centre datum.
 *
 * A bar with no scale states nothing. The previous version drew ten unlabelled
 * hairlines at 22 % alpha and a 1 px zero line, which at capture resolution is
 * a bare cyan rectangle floating beside the altimeter — the player can see that
 * something is happening but not whether it is two metres a second or twenty,
 * which is the entire question a VSI answers. So the strip now carries a
 * labelled scale: figures at ±5/±10/±20 m/s, a heavy zero datum with its own
 * index arm, and a unit caption. The tick positions come from the same
 * square-root compression the bar uses, so a figure is always exactly where the
 * bar tip reaches at that rate.
 */
export class VsiStrip {
  readonly root: HTMLElement;
  private up: HTMLElement;
  private dn: HTMLElement;
  private max: number;

  constructor(parent: HTMLElement, maxMs = 40) {
    this.max = maxMs;
    this.root = el('div', 'ct-vsi', parent);
    // Compressed position of a rate, 0 (bottom) … 1 (top).
    const at = (v: number) => 50 - clamp(Math.sign(v) * Math.sqrt(Math.abs(v) / maxMs), -1, 1) * 50;
    for (const v of [30, 20, 10, 5, -5, -10, -20, -30]) {
      const major = Math.abs(v) === 10 || Math.abs(v) === 20;
      const t = el('i', major ? 'tick is-major' : 'tick', this.root);
      t.style.top = `${at(v)}%`;
      if (major) {
        const lb = el('b', 'lbl', this.root, String(Math.abs(v)));
        lb.style.top = `${at(v)}%`;
      }
    }
    const z = el('div', 'zero', this.root);
    el('i', '', z);
    el('div', 'cap', this.root, 'V/S');
    el('div', 'unit', this.root, 'm/s');
    this.up = el('i', 'bar', this.root);
    this.dn = el('i', 'bar is-down', this.root);
  }

  update(ms: number): void {
    // Square-root compression: gives fine resolution around zero (where you
    // trim) while still showing a 40 m/s dive without running off the strip.
    const t = clamp(Math.sign(ms) * Math.sqrt(Math.abs(ms) / this.max), -1, 1);
    setStyle(this.up, 'height', `${Math.max(0, t) * 50}%`);
    setStyle(this.dn, 'height', `${Math.max(0, -t) * 50}%`);
  }
}
