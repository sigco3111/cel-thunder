import { el, setText, setClass, setStyle, mmss } from '../dom';
import type { PlayerInfo, EntityState } from '../../shared/protocol';
import { aircraftByIndex } from '../../shared/aircraft';

interface Row {
  root: HTMLElement;
  name: HTMLElement;
  dot: HTMLElement;
  ac: HTMLElement;
  kills: HTMLElement;
  deaths: HTMLElement;
  score: HTMLElement;
  ping: HTMLElement;
  pingBars: HTMLElement[];
}

/**
 * Hold-Tab scoreboard.
 *
 * Rows are pooled and reused: the scoreboard is opened and closed constantly
 * mid-fight, and rebuilding two team lists on every keypress is a guaranteed
 * frame hitch at the exact moment the player is turning to look at something.
 */
/** Hoisted so the sort does not mint a closure every frame Tab is held. */
const byScore = (a: PlayerInfo, b: PlayerInfo): number =>
  b.score - a.score || b.kills - a.kills;

export class Scoreboard {
  readonly root: HTMLElement;
  private teamBoxes: HTMLElement[] = [];
  private rows: Row[][] = [[], []];
  /** Reused per-frame scratch — see the note in 'update'. */
  private readonly acOf = new Map<number, string>();
  private readonly side: PlayerInfo[][] = [[], []];
  private scoreA: HTMLElement;
  private scoreB: HTMLElement;
  private timer: HTMLElement;
  private mapName: HTMLElement;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ct-layer', parent);
    this.root.id = 'ct-scoreboard';
    this.root.style.display = 'grid';

    const sb = el('div', 'ct-sb ct-panel is-glass is-deep ct-hatch', this.root);
    const head = el('div', 'ct-sb-head', sb);
    const title = el('div', '', head);
    el('div', 'ct-title', title, 'Scoreboard');
    this.mapName = el('div', 'ct-sub', title, '—');
    el('div', 'sp', head).style.flex = '1';
    const score = el('div', 'ct-sb-score', head);
    this.scoreA = el('span', 'a', score, '0');
    el('span', 'sep', score, '/');
    this.scoreB = el('span', 'b', score, '0');
    this.timer = el('div', 'ct-sub', head, '--:--');

    const teams = el('div', 'ct-sb-teams', sb);
    for (const t of [0, 1]) {
      const box = el('div', `ct-sb-team ${t === 0 ? 'is-ally' : 'is-enemy'}`, teams);
      const hd = el('div', 'hd', box);
      el('span', '', hd, t === 0 ? 'Allies' : 'Axis');
      el('span', '', hd, 'Aircraft');
      el('span', '', hd, 'K');
      el('span', '', hd, 'D');
      el('span', '', hd, 'Score');
      el('span', '', hd, 'Ping');
      this.teamBoxes.push(box);
    }
    setClass(this.root, 'ct-hidden', true);
  }

  private rowFor(team: number, i: number): Row {
    const list = this.rows[team];
    if (list[i]) return list[i];
    const root = el('div', 'ct-sb-row', this.teamBoxes[team]);
    const nm = el('div', 'nm', root);
    const dot = el('i', 'dot', nm);
    const name = el('span', '', nm, '');
    const ac = el('span', 'ac', root, '—');
    const kills = el('span', 'n', root, '0');
    const deaths = el('span', 'n', root, '0');
    const score = el('span', 'n', root, '0');
    const ping = el('div', 'ct-ping', root);
    const pingBars: HTMLElement[] = [];
    for (let k = 0; k < 3; k++) {
      const b = el('i', '', ping);
      b.style.height = `${34 + k * 24}%`;
      pingBars.push(b);
    }
    const pv = el('span', '', ping, '—');
    const row: Row = { root, name, dot, ac, kills, deaths, score, ping: pv, pingBars };
    list[i] = row;
    return row;
  }

  update(
    players: PlayerInfo[], scoreA: number, scoreB: number, timeLeft: number,
    localId: number, localTeam: number, mapName: string,
    entities: Map<number, EntityState>, localRtt: number,
  ): void {
    setText(this.scoreA, String(Math.round(scoreA)));
    setText(this.scoreB, String(Math.round(scoreB)));
    setText(this.timer, mmss(timeLeft));
    setText(this.mapName, `// ${mapName.toUpperCase()}`);

    // Aircraft per player, resolved through the entity list. The map and the
    // two per-team arrays are reused: this runs every frame Tab is held.
    const acOf = this.acOf;
    acOf.clear();
    for (const e of entities.values()) {
      if (e.ownerId) acOf.set(e.ownerId, aircraftByIndex(e.typeId).name);
    }

    // Team 0 is always drawn on the left, but the *local* team is shown in the
    // ally colour regardless of which side that is.
    for (const t of [0, 1]) {
      const list = this.side[t];
      list.length = 0;
      for (const p of players) {
        if ((t === 0) === (p.team === localTeam)) list.push(p);
      }
      list.sort(byScore);
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        const row = this.rowFor(t, i);
        setStyle(row.root, 'display', 'grid');
        setText(row.name, p.name);
        setText(row.ac, acOf.get(p.id) ?? '—');
        setText(row.kills, String(p.kills));
        setText(row.deaths, String(p.deaths));
        setText(row.score, String(p.score));
        setClass(row.root, 'is-me', p.id === localId);
        setClass(row.root, 'is-dead', !p.alive);
        const ping = p.id === localId ? localRtt : (p as unknown as { ping?: number }).ping ?? 0;
        setText(row.ping, ping > 0 ? String(Math.round(ping)) : '—');
        const level = ping <= 0 ? 0 : ping < 60 ? 3 : ping < 130 ? 2 : 1;
        for (let k = 0; k < row.pingBars.length; k++) {
          setStyle(row.pingBars[k], 'opacity', k < level ? '1' : '0.18');
        }
        setClass(row.ping.parentElement!, 'is-warn', level === 2);
        setClass(row.ping.parentElement!, 'is-danger', level === 1);
      }
      for (let i = list.length; i < this.rows[t].length; i++) {
        setStyle(this.rows[t][i].root, 'display', 'none');
      }
    }
  }

  setVisible(v: boolean): void {
    setClass(this.root, 'ct-hidden', !v);
  }
}
