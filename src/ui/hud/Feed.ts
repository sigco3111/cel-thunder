import { el, setText, setClass, setStyle, clamp, mmss } from '../dom';

/** Rolling kill log, newest at the bottom, auto-expiring. */
export class Killfeed {
  readonly root: HTMLElement;
  private rows: { node: HTMLElement; t: number }[] = [];
  private max = 6;

  constructor(parent: HTMLElement) {
    this.root = el('div', '', parent);
    this.root.id = 'ct-killfeed';
  }

  push(killer: string, victim: string, weapon: string, killerTeam: number, victimTeam: number,
       localTeam: number, meName: string): void {
    const row = el('div', 'ct-kill', this.root);
    const kc = killer === meName ? 'is-me' : killerTeam === localTeam ? 'is-ally' : 'is-enemy';
    const vc = victim === meName ? 'is-me' : victimTeam === localTeam ? 'is-ally' : 'is-enemy';
    el('span', `who ${kc}`, row, killer);
    el('span', 'wpn', row, `▸ ${weapon} ▸`);
    el('span', `who ${vc}`, row, victim);
    this.rows.push({ node: row, t: 0 });
    while (this.rows.length > this.max) {
      const r = this.rows.shift();
      r?.node.remove();
    }
  }

  update(dt: number): void {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i];
      r.t += dt;
      if (r.t > 8) setClass(r.node, 'is-fading', true);
      if (r.t > 8.6) { r.node.remove(); this.rows.splice(i, 1); }
    }
  }
}

/** Centre-top banner queue (warnings, objectives, connection state). */
export class Notices {
  readonly root: HTMLElement;
  private items: { node: HTMLElement; t: number; life: number; key: string }[] = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', '', parent);
    this.root.id = 'ct-notices';
  }

  /** 'key' de-duplicates: pushing the same key refreshes instead of stacking. */
  show(key: string, text: string, kind: '' | 'warn' | 'danger' = '', life = 4): void {
    const found = this.items.find((i) => i.key === key);
    if (found) {
      found.t = 0; found.life = life;
      setText(found.node, text);
      return;
    }
    const node = el('div', `ct-notice${kind ? ` is-${kind}` : ''}`, this.root, text);
    this.items.push({ node, t: 0, life, key });
  }

  /** Sticky notices (offline banner) never expire until cleared. */
  sticky(key: string, text: string, kind: '' | 'warn' | 'danger' = ''): void {
    this.show(key, text, kind, Infinity);
  }

  clear(key: string): void {
    const i = this.items.findIndex((x) => x.key === key);
    if (i >= 0) { this.items[i].node.remove(); this.items.splice(i, 1); }
  }

  update(dt: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      if (it.t > it.life) setClass(it.node, 'is-fading', true);
      if (it.t > it.life + 0.6) { it.node.remove(); this.items.splice(i, 1); }
    }
  }
}

/** Floating score/award text near the reticle. */
export class Popups {
  readonly root: HTMLElement;
  private live: { node: HTMLElement; t: number }[] = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', '', parent);
    this.root.id = 'ct-popups';
  }

  push(text: string, points = 0, big = false): void {
    const node = el('div', `ct-pop${big ? ' is-kill' : ''}`, this.root);
    node.appendChild(document.createTextNode(text));
    if (points) {
      const b = el('b', '', node, ` +${points}`);
      b.style.marginLeft = '0.4em';
    }
    // Stagger vertically so a burst of hits does not overprint.
    node.style.marginTop = `${(this.live.length % 4) * -1.6}em`;
    this.live.push({ node, t: 0 });
  }

  update(dt: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.t += dt;
      if (p.t > 1.6) { p.node.remove(); this.live.splice(i, 1); }
    }
  }
}

/** Connection quality pill: signal bars + round-trip time. */
export class ConnPill {
  readonly root: HTMLElement;
  private bars: HTMLElement[] = [];
  private lbl: HTMLElement;
  private ms: HTMLElement;

  constructor(parent: HTMLElement) {
    this.root = el('div', '', parent);
    this.root.id = 'ct-conn';
    const b = el('div', 'bars', this.root);
    for (let i = 0; i < 4; i++) {
      const bar = el('i', '', b);
      bar.style.height = `${30 + i * 23}%`;
      this.bars.push(bar);
    }
    this.lbl = el('span', 'lbl', this.root, 'LINK');
    this.ms = el('span', 'ms', this.root, '—');
  }

  update(connected: boolean, offline: boolean, rttMs: number): void {
    setClass(this.root, 'is-offline', offline);
    let level = 0;
    if (connected) level = rttMs < 45 ? 4 : rttMs < 90 ? 3 : rttMs < 160 ? 2 : 1;
    for (let i = 0; i < this.bars.length; i++) setClass(this.bars[i], 'is-on', i < level);
    setClass(this.root, 'is-warn', level === 2);
    setClass(this.root, 'is-danger', connected && level <= 1);
    setText(this.lbl, offline ? 'OFFLINE' : connected ? 'LINK' : 'NO LINK');
    setText(this.ms, offline ? 'SOLO' : connected ? `${Math.round(rttMs)}ms` : '--');
  }
}

/** Score / timer strip under the compass. */
export class MatchStrip {
  readonly root: HTMLElement;
  private a: HTMLElement;
  private b: HTMLElement;
  private t: HTMLElement;
  private fill: HTMLElement;

  constructor(parent: HTMLElement) {
    this.root = el('div', '', parent);
    this.root.id = 'ct-match';
    this.a = el('span', 'a', this.root, '0');
    const bar = el('div', 'bar', this.root);
    this.fill = el('i', '', bar);
    this.b = el('span', 'b', this.root, '0');
    this.t = el('span', 't', this.root, '--:--');
  }

  update(scoreA: number, scoreB: number, timeLeft: number): void {
    // Offline or pre-match there is no score to show; an empty 0–0 strip with a
    // dead clock is worse than no strip at all.
    const live = timeLeft > 0 || scoreA > 0 || scoreB > 0;
    setStyle(this.root, 'display', live ? 'flex' : 'none');
    if (!live) return;
    setText(this.a, String(Math.round(scoreA)));
    setText(this.b, String(Math.round(scoreB)));
    setText(this.t, mmss(timeLeft));
    const total = Math.max(1, scoreA + scoreB);
    setStyle(this.fill, 'transform', `scaleX(${clamp(scoreA / total, 0, 1).toFixed(3)})`);
  }
}

/** In-flight chat: transcript plus an Enter-activated entry field. */
export class ChatBox {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
  private log: HTMLElement;
  private msgs: { node: HTMLElement; t: number }[] = [];
  private typing = false;

  onSend: (text: string) => void = () => {};
  onClose: () => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = el('div', '', parent);
    this.root.id = 'ct-chat';
    this.log = el('div', 'ct-chat-log', this.root);
    const entry = el('div', '', this.root);
    entry.id = 'ct-chat-entry';
    el('span', 'tag', entry, 'ALL');
    this.input = el('input', 'ct-input', entry) as HTMLInputElement;
    this.input.maxLength = 140;
    this.input.placeholder = 'Message…';
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const v = this.input.value.trim();
        if (v) this.onSend(v);
        this.close();
      } else if (e.key === 'Escape') {
        this.close();
      }
    });
  }

  push(from: string, text: string, team: number, localTeam: number, system = false): void {
    const node = el('div', 'ct-chat-msg', this.log);
    el('span', `from ${system ? 'is-sys' : team === localTeam ? 'is-ally' : 'is-enemy'}`, node, system ? '◆' : `${from}:`);
    node.appendChild(document.createTextNode(text));
    this.msgs.push({ node, t: 0 });
    while (this.msgs.length > 8) this.msgs.shift()?.node.remove();
  }

  open(): void {
    this.typing = true;
    setClass(this.root, 'is-typing', true);
    this.input.value = '';
    this.input.focus();
  }

  close(): void {
    this.typing = false;
    setClass(this.root, 'is-typing', false);
    this.input.blur();
    this.onClose();
  }

  get isTyping(): boolean { return this.typing; }

  update(dt: number): void {
    for (let i = this.msgs.length - 1; i >= 0; i--) {
      const m = this.msgs[i];
      m.t += dt;
      const fade = !this.typing && m.t > 14;
      setClass(m.node, 'is-fading', fade);
      if (m.t > 15.2 && !this.typing) { m.node.remove(); this.msgs.splice(i, 1); }
    }
  }
}
