import { svg } from '../dom';

/**
 * Two-pass vector drawing for the HUD.
 *
 * A gunsight has to stay legible over a white cloud *and* over black forest.
 * The cheapest robust answer — the one real HUD art uses — is to draw every
 * stroke twice: a thick dark "ink" pass underneath and a thin bright pass on
 * top. Doing that naively doubles the per-frame transform updates, so instead
 * the geometry lives once inside '<defs>' and is instantiated twice with
 * '<use>'. Animating the original updates both copies for free.
 *
 * All ink passes are emitted before all lit passes so no dark stroke can ever
 * land on top of a bright one.
 */
export class VecStage {
  readonly svg: SVGSVGElement;
  private defs: SVGDefsElement;
  private inkPass: SVGGElement;
  private litPass: SVGGElement;
  private n = 0;
  private lits = new WeakMap<SVGGElement, SVGUseElement>();
  private pairs = new WeakMap<SVGGElement, SVGUseElement[]>();

  constructor(parent: Element, cls = '') {
    this.svg = svg('svg', { class: cls }, parent);
    this.defs = svg('defs', undefined, this.svg);
    this.inkPass = svg('g', undefined, this.svg);
    this.litPass = svg('g', undefined, this.svg);
  }

  /**
   * Creates a drawable group. Returns the '<g>' inside '<defs>' — draw and
   * animate that; the two visible instances follow.
   *
   * 'inkCls' selects the weight of the dark pass. The default halo is tuned for
   * short strokes over mixed backgrounds; long thin runs like the pitch ladder
   * need a heavier one or they wash out completely against a sunlit cumulus,
   * which is the single worst background a white 1.7 px line can have.
   */
  layer(cls = '', id?: string, inkCls = ''): SVGGElement {
    const gid = id ?? `ctv${this.n++}`;
    const g = svg('g', { id: gid }, this.defs);
    const ink = svg('use', { href: `#${gid}`, class: `ct-vec-ink ${inkCls}` }, this.inkPass);
    const lit = svg('use', { href: `#${gid}`, class: `ct-vec-lit ${cls}` }, this.litPass);
    this.lits.set(g, lit);
    this.pairs.set(g, [ink, lit]);
    return g;
  }

  /**
   * Both visible instances of a layer.
   *
   * Needed for anything that has to affect the mark as it is *drawn* rather
   * than as it is defined — a clip path, in particular. Setting clip-path on
   * the '<g>' inside '<defs>' does nothing useful, because the clip would then
   * be evaluated in the referenced element's own space rather than in the
   * screen space the occluder (an instrument coaming) actually lives in.
   */
  uses(g: SVGGElement): SVGUseElement[] {
    return this.pairs.get(g) ?? [];
  }

  /** The '<defs>' block, for clip paths and gradients the layers reference. */
  get definitions(): SVGDefsElement { return this.defs; }

  /** The bright instance of a layer — the handle for per-state colouring. */
  lit(g: SVGGElement): SVGUseElement | undefined {
    return this.lits.get(g);
  }

  /** A layer whose two passes can be moved independently (rarely needed). */
  rawLayer(): SVGGElement {
    return svg('g', undefined, this.litPass);
  }
}

/** Builds an SVG arc path centred on the origin. Angles in radians, 0 = +X. */
export function arcPath(r: number, a0: number, a1: number): string {
  const x0 = Math.cos(a0) * r, y0 = Math.sin(a0) * r;
  const x1 = Math.cos(a1) * r, y1 = Math.sin(a1) * r;
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** Ring of radial tick marks: 'n' ticks from r0 to r1 over a full circle. */
export function tickRing(r0: number, r1: number, n: number, phase = 0): string {
  let d = '';
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    d += `M ${(c * r0).toFixed(2)} ${(s * r0).toFixed(2)} L ${(c * r1).toFixed(2)} ${(s * r1).toFixed(2)} `;
  }
  return d;
}
