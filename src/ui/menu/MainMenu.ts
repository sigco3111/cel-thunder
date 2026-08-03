import { el, setText, setClass, clamp } from '../dom';
import { makeEmblem } from './Emblem';

export interface MenuItem {
  id: string;
  label: string;
  hint: string;
}

/**
 * Title screen.
 *
 * The live game scene renders behind it — the menu only supplies the
 * cinematic treatment (letterbox, vignette, grain, registration corners) and
 * the type. That way the first thing a player sees is the actual renderer,
 * not a static splash.
 */
export class MainMenu {
  readonly root: HTMLElement;
  private items: { def: MenuItem; node: HTMLElement }[] = [];
  private sel = 0;
  private kv = new Map<string, HTMLElement>();

  onSelect: (id: string) => void = () => {};

  constructor(parent: HTMLElement, defs: MenuItem[]) {
    this.root = el('div', 'ct-screen ct-cine', parent);
    this.root.id = 'ct-menu';
    for (const c of ['tl', 'tr', 'bl', 'br']) el('div', `ct-corner ${c}`, this.root);

    const brand = el('div', 'ct-brand', this.root);
    const row = el('div', 'ct-brand-row', brand);
    makeEmblem(row);
    const word = el('div', 'ct-word', row);
    el('span', 'l1', word, 'Cel');
    el('span', 'l2', word, 'Thunder');
    const tag = el('div', 'ct-tagline', brand);
    el('i', 'dash', tag);
    el('span', '', tag, 'Aerial combat · 1939–1945');

    const nav = el('nav', 'ct-nav', this.root);
    defs.forEach((def, i) => {
      const node = el('button', 'ct-navitem', nav);
      el('span', 'idx', node, String(i + 1).padStart(2, '0'));
      el('span', 'nm', node, def.label);
      el('span', 'hint', node, def.hint);
      node.addEventListener('mouseenter', () => this.select(i));
      node.addEventListener('click', () => { this.select(i); this.activate(); });
      this.items.push({ def, node });
    });

    const side = el('aside', 'ct-menu-side ct-panel is-glass ct-hatch', this.root);
    const head = el('div', 'ct-head', side);
    el('span', '', head, 'Situation');
    el('span', 'ct-head-rule', head);
    for (const [k, label] of [
      ['server', 'Server'], ['map', 'Theatre'], ['players', 'Pilots'],
      ['team', 'Assignment'], ['aircraft', 'Selected'], ['ping', 'Latency'],
    ] as [string, string][]) {
      const row2 = el('div', 'ct-kv', side);
      el('span', 'k', row2, label);
      this.kv.set(k, el('span', 'v', row2, '—'));
    }

    const foot = el('div', 'ct-foot', this.root);
    el('span', '', foot, 'CEL THUNDER · BUILD 1.0');
    el('span', 'sp', foot);
    el('span', '', foot, '↑↓ NAVIGATE · ENTER SELECT');

    this.select(0);
  }

  select(i: number): void {
    this.sel = clamp(i, 0, this.items.length - 1);
    this.items.forEach((it, k) => setClass(it.node, 'is-sel', k === this.sel));
  }

  activate(): void {
    const it = this.items[this.sel];
    if (it) this.onSelect(it.def.id);
  }

  handleKey(e: KeyboardEvent): boolean {
    if (e.code === 'ArrowDown' || e.code === 'KeyS') { this.select(this.sel + 1); return true; }
    if (e.code === 'ArrowUp' || e.code === 'KeyW') { this.select(this.sel - 1); return true; }
    if (e.code === 'Enter' || e.code === 'Space') { this.activate(); return true; }
    const n = Number(e.key);
    if (n >= 1 && n <= this.items.length) { this.select(n - 1); this.activate(); return true; }
    return false;
  }

  setInfo(key: string, value: string, state: '' | 'ok' | 'warn' = ''): void {
    const n = this.kv.get(key);
    if (!n) return;
    setText(n, value);
    setClass(n, 'is-ok', state === 'ok');
    setClass(n, 'is-warn', state === 'warn');
  }

  setVisible(v: boolean): void {
    setClass(this.root, 'ct-hidden', !v);
  }
}

/** In-flight pause menu — same visual language, compact. */
export class PauseMenu {
  readonly root: HTMLElement;
  private items: { id: string; node: HTMLElement }[] = [];
  private sel = 0;

  onSelect: (id: string) => void = () => {};

  constructor(parent: HTMLElement, defs: MenuItem[]) {
    this.root = el('div', 'ct-layer is-interactive', parent);
    this.root.id = 'ct-pause';
    const card = el('div', 'ct-pause-card ct-panel is-glass is-deep ct-hatch', this.root);
    const head = el('div', 'ct-head', card);
    el('span', '', head, 'Paused');
    el('span', 'ct-head-rule', head);

    defs.forEach((def, i) => {
      const node = el('button', 'ct-navitem', card);
      el('span', 'idx', node, String(i + 1).padStart(2, '0'));
      el('span', 'nm', node, def.label);
      el('span', 'hint', node, def.hint);
      node.addEventListener('mouseenter', () => this.select(i));
      node.addEventListener('click', () => { this.select(i); this.onSelect(def.id); });
      this.items.push({ id: def.id, node });
    });
    this.select(0);
    setClass(this.root, 'ct-hidden', true);
  }

  select(i: number): void {
    this.sel = clamp(i, 0, this.items.length - 1);
    this.items.forEach((it, k) => setClass(it.node, 'is-sel', k === this.sel));
  }

  handleKey(e: KeyboardEvent): boolean {
    if (e.code === 'ArrowDown') { this.select(this.sel + 1); return true; }
    if (e.code === 'ArrowUp') { this.select(this.sel - 1); return true; }
    if (e.code === 'Enter') { this.onSelect(this.items[this.sel].id); return true; }
    return false;
  }

  setVisible(v: boolean): void { setClass(this.root, 'ct-hidden', !v); }
}
