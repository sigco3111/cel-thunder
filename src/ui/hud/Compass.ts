import { el, svg, setText, setTransform, setStyle, setAttr, clamp } from '../dom';

const SP = 5;          // design px per degree
const CYCLE = 360 * SP;

/**
 * Heading ribbon with a fixed lubber line and a target-bearing caret.
 *
 * Two full 360° cycles are built and the strip is always shown from the middle
 * of the second one, so wrapping through north is a plain translation — no
 * seam, no rebuild, no modulo popping.
 */
export class Compass {
  readonly root: HTMLElement;
  private strip: HTMLElement;
  private stripSvg: SVGSVGElement;
  private hdgLbl: HTMLElement;
  private tgt: HTMLElement;
  private u = 1;
  private halfW = 260;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ct-compass', parent);
    // The fade has to live on an element the size of the visible window, not on
    // the strip: the strip is two full 360° cycles (7 200 design px) wide, so a
    // percentage-based mask gradient applied to it would put its soft edges
    // three thousand pixels off screen and do nothing at all where it matters.
    const win = el('div', 'ct-compass-win', this.root);
    this.strip = el('div', 'ct-compass-strip', win);
    this.stripSvg = svg('svg', { preserveAspectRatio: 'none' }, this.strip);
    this.tgt = el('div', 'ct-compass-tgt', this.root);
    el('div', 'ct-compass-caret', this.root);
    // The heading readout belongs *above* the plate, sitting on the lubber
    // line. It cannot be a child of the plate to do that: the plate carries the
    // chamfer clip-path and its own overflow clip, both of which apply to
    // descendants, so anything positioned outside the plate's box is thrown
    // away. It is a sibling instead, centred on the same 50 % the plate is.
    this.hdgLbl = el('div', 'ct-compass-hdg', parent, '000');
    this.build();
  }

  private build(): void {
    const s = this.stripSvg;
    const H = 40;
    s.setAttribute('viewBox', `0 0 ${CYCLE * 2} ${H}`);
    // The artwork deliberately runs outside the viewBox, in both directions.
    //
    // The strip is two 360° cycles, 0…720°, and the viewBox is exactly that
    // wide — so the figure at 720° was anchored dead on the right-hand edge and
    // the outer <svg>'s default overflow clip ate its right half. That is the
    // half-eaten "N" that kept appearing at the end of the ribbon. It also runs
    // *short*: the visible window is ±268 design px and the strip is translated
    // by −(h + 360)·5, so at a heading of 359° the window reaches x ≈ 3 863,
    // 263 px past the end of the drawn range, and the last quarter of the tape
    // was simply blank. Both are fixed by drawing past the ends and letting the
    // artwork overflow; '.ct-compass-win' is what does the real clipping.

    // Tick hierarchy is the whole readability story on a heading tape: 5° for
    // the fine grain the eye interpolates between, 10° for the figures, 30° for
    // the coarse structure that lets you find a bearing without reading a
    // single number.
    //
    // The figures used to be drawn every 15° and printed as round(deg/10),
    // which turns 15° into "02", 45° into "05" and 75° into "08" — the tape
    // read 29·30·32·33·35 with 31 and 34 simply missing, and every other figure
    // was a lie about where its own tick was. A degrees-per-ten tape has to be
    // labelled on a multiple of ten.
    let minor = '', major = '', coarse = '';
    for (let d = -60; d <= 780; d += 5) {
      const x = d * SP;
      if (d % 30 === 0) coarse += `M ${x} 3 L ${x} 21 `;
      else if (d % 10 === 0) major += `M ${x} 7 L ${x} 21 `;
      else minor += `M ${x} 13 L ${x} 21 `;
    }
    svg('path', { d: minor, class: 'ct-cmp-minor' }, s);
    svg('path', { d: major, class: 'ct-cmp-major' }, s);
    svg('path', { d: coarse, class: 'ct-cmp-coarse' }, s);

    const CARD: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    for (let d = -60; d <= 780; d += 10) {
      const m = ((d % 360) + 360) % 360;
      const card = CARD[m];
      const t = svg('text', {
        x: d * SP, y: 34, 'text-anchor': 'middle',
        class: card ? 'ct-cmp-card' : 'ct-cmp-lbl',
      }, s);
      // m is always a multiple of ten here, so this is exact, not rounded.
      t.textContent = card ?? String(m / 10).padStart(2, '0');
    }
  }

  resize(u: number, widthPx: number): void {
    this.u = u;
    this.halfW = widthPx * 0.5;
    setStyle(this.stripSvg, 'width', `${CYCLE * 2 * u}px`);
    setStyle(this.stripSvg, 'height', `${40 * u}px`);
    setStyle(this.stripSvg, 'display', 'block');
    setStyle(this.strip, 'width', `${CYCLE * 2 * u}px`);
  }

  /** 'heading' 0..360; 'targetBearing' is absolute, or NaN for none. */
  update(heading: number, targetBearing: number): void {
    const h = ((heading % 360) + 360) % 360;
    setTransform(this.strip, `translate3d(${(-(h + 360) * SP * this.u).toFixed(1)}px,0,0)`);
    setText(this.hdgLbl, String(Math.round(h) % 360).padStart(3, '0'));

    if (Number.isFinite(targetBearing)) {
      let rel = targetBearing - h;
      while (rel > 180) rel -= 360;
      while (rel < -180) rel += 360;
      const x = clamp(rel * SP * this.u, -this.halfW * 0.86, this.halfW * 0.86);
      setStyle(this.tgt, 'display', 'block');
      setStyle(this.tgt, 'left', `calc(50% + ${x.toFixed(1)}px)`);
      setAttr(this.tgt, 'data-clamped', Math.abs(rel * SP * this.u) > this.halfW * 0.86 ? '1' : '0');
    } else {
      setStyle(this.tgt, 'display', 'none');
    }
  }
}
