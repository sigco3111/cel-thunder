/**
 * Minimal DOM/SVG helpers for the UI layer.
 *
 * Everything here is written for the hot path: the HUD touches hundreds of
 * nodes per frame, and the single biggest cost in a DOM HUD is redundant
 * writes — the browser invalidates style/layout even when you assign the value
 * it already has. So every setter here is change-detected against a cached
 * last-written value stored on the node itself.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export type AttrMap = Record<string, string | number>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  parent?: Node | null,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  if (parent) parent.appendChild(n);
  return n;
}

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: AttrMap,
  parent?: Node | null,
): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const k in attrs) n.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(n);
  return n;
}

export function attr(n: Element, attrs: AttrMap): void {
  for (const k in attrs) n.setAttribute(k, String(attrs[k]));
}

/** Change-detected textContent write. */
export function setText(n: Element | null | undefined, s: string): void {
  if (!n) return;
  const c = n as Element & { __t?: string };
  if (c.__t === s) return;
  c.__t = s;
  n.textContent = s;
}

/** Change-detected transform write (HTML). */
export function setTransform(n: HTMLElement | null | undefined, t: string): void {
  if (!n) return;
  const c = n as HTMLElement & { __x?: string };
  if (c.__x === t) return;
  c.__x = t;
  n.style.transform = t;
}

/** Change-detected transform write (SVG attribute — cheaper than CSS on SVG). */
export function setSvgTransform(n: SVGElement | null | undefined, t: string): void {
  if (!n) return;
  const c = n as SVGElement & { __x?: string };
  if (c.__x === t) return;
  c.__x = t;
  n.setAttribute('transform', t);
}

/** Change-detected single-attribute write. */
export function setAttr(n: Element | null | undefined, name: string, v: string | number): void {
  if (!n) return;
  const c = n as Element & { __a?: Record<string, string> };
  const s = String(v);
  if (!c.__a) c.__a = {};
  if (c.__a[name] === s) return;
  c.__a[name] = s;
  n.setAttribute(name, s);
}

/** Change-detected inline style write. */
export function setStyle(n: HTMLElement | SVGElement | null | undefined, prop: string, v: string): void {
  if (!n) return;
  const c = n as (HTMLElement | SVGElement) & { __s?: Record<string, string> };
  if (!c.__s) c.__s = {};
  if (c.__s[prop] === v) return;
  c.__s[prop] = v;
  (n as HTMLElement).style.setProperty(prop, v);
}

export function setClass(n: Element | null | undefined, cls: string, on: boolean): void {
  if (!n) return;
  if (n.classList.contains(cls) === on) return;
  n.classList.toggle(cls, on);
}

/** Replaces the element's state class ('is-ok', 'is-warn', …) in one go. */
export function setState(n: Element | null | undefined, state: string): void {
  if (!n) return;
  const c = n as Element & { __st?: string };
  if (c.__st === state) return;
  if (c.__st) n.classList.remove(c.__st);
  if (state) n.classList.add(state);
  c.__st = state;
}

export function clear(n: Node): void {
  while (n.firstChild) n.removeChild(n.firstChild);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export const pad = (v: number, n: number): string => {
  const s = Math.abs(Math.trunc(v)).toString();
  return s.length >= n ? s : '0'.repeat(n - s.length) + s;
};

export const fixed = (v: number, d: number): string =>
  (Number.isFinite(v) ? v : 0).toFixed(d);

export const signed = (v: number, d = 0): string =>
  (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d);

export const int = (v: number): string => String(Math.round(Number.isFinite(v) ? v : 0));

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Frame-rate independent exponential approach; 'rate' is per second. */
export const damp = (a: number, b: number, rate: number, dt: number): number =>
  a + (b - a) * (1 - Math.exp(-rate * dt));
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Distance readout: metres under 1 km, otherwise kilometres to 1 dp. */
export function distStr(m: number): string {
  if (!Number.isFinite(m)) return '—';
  if (m < 1000) return `${Math.round(m / 5) * 5}m`;
  return `${(m / 1000).toFixed(1)}km`;
}

export function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${pad(s % 60, 2)}`;
}

/** Escapes user-authored strings (chat, player names) before innerHTML use. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');
}
