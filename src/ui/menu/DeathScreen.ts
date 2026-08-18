import { el, svg, setText, setClass, setAttr, clamp } from '../dom';
import { t } from '../../i18n';

/**
 * Death, respawn and match end.
 *
 * The killcam "ramp" is a timed curve, not just an overlay: 'progress' runs
 * 0 → 1 over ~1.4 s and is published on the bus so the camera system can pull
 * back and orbit the wreck in step with the UI desaturating and the card
 * sliding in. If nothing listens, the UI still reads correctly on its own.
 */
export class DeathScreen {
  readonly root: HTMLElement;
  private title: HTMLElement;
  private sub: HTMLElement;
  private killerEl: HTMLElement;
  private weaponEl: HTMLElement;
  private ringFill: SVGCircleElement;
  private num: HTMLElement;
  private respawnBtn: HTMLButtonElement;
  private ringLen = 1;

  private timer = 0;
  private total = 8;
  private ramp = 0;
  private open = false;

  onRespawn: () => void = () => {};
  onHangar: () => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ct-layer', parent);
    this.root.id = 'ct-death';

    const card = el('div', 'ct-death-card ct-panel is-glass is-deep ct-hatch', this.root);
    this.title = el('div', 'ct-death-title', card, t('deathShotDown'));
    this.sub = el('div', 'ct-death-sub', card);
    el('span', '', this.sub, t('deathDestroyedBy'));
    this.killerEl = el('span', 'who', this.sub, '—');
    el('span', '', this.sub, ' · ');
    this.weaponEl = el('span', 'wpn', this.sub, '—');

    const foot = el('div', 'ct-death-foot', card);
    const ring = el('div', 'ct-respawn', foot);
    const s = svg('svg', { viewBox: '0 0 100 100' }, ring);
    svg('circle', { cx: 50, cy: 50, r: 44, class: 'rt' }, s);
    this.ringFill = svg('circle', { cx: 50, cy: 50, r: 44, class: 'rf' }, s);
    this.ringLen = 2 * Math.PI * 44;
    setAttr(this.ringFill, 'stroke-dasharray', this.ringLen.toFixed(2));
    this.num = el('div', 'num', ring, '0');

    const col = el('div', '', foot);
    (col as HTMLElement).style.flex = '1';
    el('div', 'ct-label', col, t('deathReinforcements'));
    const btns = el('div', '', col);
    (btns as HTMLElement).style.display = 'flex';
    (btns as HTMLElement).style.gap = 'var(--s3)';
    (btns as HTMLElement).style.marginTop = 'var(--s2)';
    this.respawnBtn = el('button', 'ct-btn is-primary', btns, t('deathRespawn')) as HTMLButtonElement;
    this.respawnBtn.onclick = () => this.onRespawn();
    const hangar = el('button', 'ct-btn is-ghost', btns, t('deathChangeAircraft'));
    hangar.onclick = () => this.onHangar();

    setClass(this.root, 'ct-hidden', true);
  }

  show(killer: string, weapon: string, respawnSeconds: number): void {
    this.open = true;
    this.timer = respawnSeconds;
    this.total = Math.max(0.001, respawnSeconds);
    this.ramp = 0;
    setText(this.title, killer ? t('deathShotDown') : t('deathDestroyed'));
    setText(this.killerEl, killer || t('deathTheGround'));
    setText(this.weaponEl, weapon || t('deathImpact'));
    setClass(this.root, 'ct-hidden', false);
    this.respawnBtn.disabled = respawnSeconds > 0;
  }

  hide(): void {
    this.open = false;
    setClass(this.root, 'ct-hidden', true);
  }

  /** Returns the killcam ramp 0..1 for this frame. */
  update(dt: number): number {
    if (!this.open) return 0;
    this.ramp = clamp(this.ramp + dt / 1.4, 0, 1);
    if (this.timer > 0) {
      this.timer = Math.max(0, this.timer - dt);
      if (this.timer === 0) this.respawnBtn.disabled = false;
    }
    setText(this.num, String(Math.ceil(this.timer)));
    const f = 1 - this.timer / this.total;
    setAttr(this.ringFill, 'stroke-dashoffset', (this.ringLen * (1 - f)).toFixed(2));
    return this.ramp;
  }

  get canRespawn(): boolean { return this.open && this.timer <= 0; }
  get isOpen(): boolean { return this.open; }
}

/** End-of-match result card over the final scoreboard. */
export class MatchEnd {
  readonly root: HTMLElement;
  private result: HTMLElement;
  private detail: HTMLElement;

  onContinue: () => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ct-layer ct-cine', parent);
    this.root.id = 'ct-matchend';
    const box = el('div', '', this.root);
    (box as HTMLElement).style.textAlign = 'center';
    this.result = el('div', 'ct-result is-win', box, t('matchVictory'));
    this.detail = el('div', 'ct-sub', box, '');
    (this.detail as HTMLElement).style.marginTop = 'var(--s4)';
    const btn = el('button', 'ct-btn is-primary', box, t('matchContinue'));
    (btn as HTMLElement).style.marginTop = 'var(--s5)';
    btn.onclick = () => this.onContinue();
    setClass(this.root, 'ct-hidden', true);
  }

  show(win: boolean, detail: string): void {
    setText(this.result, win ? t('matchVictory') : t('matchDefeat'));
    setClass(this.result, 'is-win', win);
    setClass(this.result, 'is-lose', !win);
    setText(this.detail, detail);
    setClass(this.root, 'ct-hidden', false);
  }

  hide(): void { setClass(this.root, 'ct-hidden', true); }
}
