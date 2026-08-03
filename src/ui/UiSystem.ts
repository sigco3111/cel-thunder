import * as THREE from 'three';
import type { GameContext, Subsystem } from '../engine/context';
import type { NetSystem } from '../net/NetSystem';
import {
  DamageBits, EntityKind, EventKind, newEntityState,
  type EntityState, type PlayerInfo,
} from '../shared/protocol';
import { AIRCRAFT, AIRCRAFT_BY_ID, aircraftByIndex, aircraftIndex, type AircraftSpec } from '../shared/aircraft';
import { injectStyles } from './styles';
import { el, clamp, setClass, setStyle } from './dom';
import { TelemetryModel, type HudTelemetry } from './Telemetry';
import { applyPrefs, loadPrefs, savePrefs, type UiPrefs } from './store';
import { Hud } from './hud/Hud';
import type { LeadState } from './hud/CenterHud';
import type { WorldMarker } from './hud/Minimap';
import type { TargetInfo } from './hud/Markers';
import { hoverSfx, setUiAudioSink, sfx, type UiSoundName } from './sfx';
import { MainMenu, PauseMenu } from './menu/MainMenu';
import { Hangar } from './menu/Hangar';
import { SettingsPanel } from './menu/SettingsPanel';
import { Scoreboard } from './menu/Scoreboard';
import { DeathScreen, MatchEnd } from './menu/DeathScreen';
import type { AircraftBuilder } from './menu/HangarViewer';

export type UiScreen = 'menu' | 'hangar' | 'flight';

const _v = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const G = 9.80665;
const QUALITY_TIERS = ['low', 'medium', 'high', 'ultra'] as const;

/**
 * The whole interface layer: head-up display, menus, hangar, scoreboard,
 * settings and the death/respawn flow.
 *
 * Design contract with the rest of the engine
 * -------------------------------------------
 * The UI is a *consumer*. It reads 'ctx.entities', 'ctx.camera' and the event
 * bus, and it never writes to the world. The two exceptions are deliberate and
 * both are settings-shaped: it owns 'ctx.settings' (it is the only place the
 * player can change them) and it keeps 'camera.fov' in sync with the FOV
 * setting, because nothing else owns that value.
 *
 * Anything the UI cannot know for itself is *pushed* to it:
 *   ui.setTelemetry({...})   — authoritative instrument values
 *   ui.setLead(...)          — the fire-control solution from InputSystem
 *   ui.hitMarker(kind)       — confirmed hits from the combat system
 *   ui.setWorldMarkers([...])— airfields and capture points from the world
 *   ui.setAircraftBuilder(f) — the real mesh builder for the hangar
 * Every one of those has a self-contained fallback so the UI is fully alive
 * before any of them exist.
 */
export class UiSystem implements Subsystem {
  readonly name = 'ui';

  root!: HTMLElement;
  prefs: UiPrefs = loadPrefs();
  readonly telemetry = new TelemetryModel();

  private ctx!: GameContext;
  private net: NetSystem | null = null;

  private hud!: Hud;
  private menu!: MainMenu;
  private pause!: PauseMenu;
  private hangar!: Hangar;
  private settings!: SettingsPanel;
  private scoreboard!: Scoreboard;
  private death!: DeathScreen;
  private matchEnd!: MatchEnd;

  private screen: UiScreen = 'menu';
  private settingsOpen = false;
  private pauseOpen = false;
  private scoreOpen = false;

  private u = 1;
  private w = 1920;
  private h = 1080;

  private lead: LeadState = { x: 0, y: 0, visible: false, range: 0, onTarget: false, tof: 0 };
  private leadExternal = false;
  private leadExternalT = 0;
  private target: TargetInfo | null = null;

  private spec: AircraftSpec | null = null;
  private players: PlayerInfo[] = [];
  private mapName = 'Unknown';
  private minimapAcc = 0;
  private directHitT = 0;
  private inputBits = 0;
  private lastDamage = 0;
  private wasAlive = false;
  private synth: EntityState = newEntityState();
  private synthActive = false;
  private unsubs: (() => void)[] = [];
  private respawnSeconds = 8;

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.net = ctx.get<NetSystem>('net') ?? null;
    this.bindAudio();
    injectStyles();

    const host = document.getElementById('ui') ?? document.body;
    this.root = el('div', '', host);
    this.root.id = 'ct-root';

    this.hud = new Hud(this.root);
    this.scoreboard = new Scoreboard(this.root);
    this.death = new DeathScreen(this.root);
    this.matchEnd = new MatchEnd(this.root);

    this.menu = new MainMenu(this.root, [
      { id: 'play', label: 'Play', hint: 'ENTER' },
      { id: 'hangar', label: 'Hangar', hint: 'H' },
      { id: 'settings', label: 'Settings', hint: 'O' },
      { id: 'controls', label: 'Controls', hint: 'K' },
    ]);
    this.hangar = new Hangar(this.root);
    this.pause = new PauseMenu(this.root, [
      { id: 'resume', label: 'Resume', hint: 'ESC' },
      { id: 'hangar', label: 'Change aircraft', hint: '' },
      { id: 'settings', label: 'Settings', hint: '' },
      { id: 'menu', label: 'Leave battle', hint: '' },
    ]);
    this.settings = new SettingsPanel(this.root, this.prefs);

    this.wire();
    this.applyPrefs();
    this.resolveWorldApi();
    this.screen = 'menu';
    this.applyScreen();
    this.settings.setVisible(false);
    this.scoreboard.setVisible(false);
    this.death.hide();
    this.matchEnd.hide();

    // Seed the hangar with the last aircraft flown.
    this.hangar.selectById(this.prefs.lastAircraft);
    this.spec = this.hangar.current;
    this.telemetry.setAircraft(this.spec);

    // The network subsystem initialises before this one, so its welcome or
    // offline event has already fired and been missed. Read the state directly
    // instead of waiting for an event that will never come again.
    this.syncNetState();

    this.applyQuality(String(this.ctx.quality ?? 'high'));
    this.bindPointerSfx();

    addEventListener('keydown', this.onKeyDown, false);
    addEventListener('keyup', this.onKeyUp, false);
    this.resize(
      (this.root.parentElement?.clientWidth) || innerWidth,
      (this.root.parentElement?.clientHeight) || innerHeight,
    );
  }

  /**
   * Routes the UI's sound effects into the audio subsystem, if there is one.
   *
   * Duck-typed on purpose: the UI must stay fully usable in a build with no
   * audio subsystem registered, and an exception thrown from a menu click
   * because a sound could not play would be a far worse bug than silence.
   */
  private bindAudio(): void {
    const audio = this.ctx.get('audio') as unknown as {
      playSound?: (name: string, opts?: Record<string, unknown>) => boolean;
    } | undefined;
    if (!audio || typeof audio.playSound !== 'function') { setUiAudioSink(null); return; }
    const play = audio.playSound.bind(audio);
    setUiAudioSink((name: UiSoundName) => { play(name); });
  }

  /**
   * One delegated pair of listeners for the whole interface.
   *
   * Wiring a hover and a click sound into every button, tab, plane card, livery
   * swatch and slider individually is a hundred call sites that the next person
   * to add a control will forget. Delegation on the root means a new control is
   * audible the moment it exists, and it costs two listeners instead of two
   * hundred.
   */
  private bindPointerSfx(): void {
    const CONTROL = 'button,[role="button"],input,select,.ct-nation,.ct-plane,.ct-livery,.ct-menu-item,.ct-tab,.ct-key,.ct-opt';
    const control = (e: Event): HTMLElement | null => {
      const t = e.target as HTMLElement | null;
      return t?.closest?.(CONTROL) as HTMLElement | null ?? null;
    };
    this.root.addEventListener('pointerover', (e) => hoverSfx(control(e)), true);
    this.root.addEventListener('pointerdown', (e) => {
      const c = control(e);
      if (!c) return;
      // A disabled control that the player clicked anyway is information: it
      // should say no rather than say nothing.
      const disabled = (c as HTMLButtonElement).disabled === true
        || c.getAttribute('aria-disabled') === 'true'
        || c.classList.contains('is-disabled');
      sfx(disabled ? 'ui:error' : 'ui:click');
    }, true);
  }

  private wire(): void {
    const b = this.ctx.bus;
    const on = (evt: string, fn: (p: any) => void) => this.unsubs.push(b.on(evt, fn));

    // --- menus ------------------------------------------------------------
    this.menu.onSelect = (id) => {
      if (id === 'play') this.setScreen('hangar');
      else if (id === 'hangar') this.setScreen('hangar');
      else if (id === 'settings') this.openSettings('graphics');
      else if (id === 'controls') this.openSettings('controls');
    };
    this.hangar.onBack = () => { sfx('ui:back'); this.setScreen(this.ctx.localEntityId ? 'flight' : 'menu'); };
    this.hangar.onSelect = (spec, livery) => {
      this.prefs.lastAircraft = spec.id;
      this.prefs.livery = livery;
      savePrefs(this.prefs);
      this.menu.setInfo('aircraft', spec.name);
    };
    this.hangar.onDeploy = (spec, livery) => this.deploy(spec, livery);

    this.pause.onSelect = (id) => {
      if (id === 'resume') { sfx('ui:back'); this.closePause(); }
      else if (id === 'hangar') { this.closePause(); this.setScreen('hangar'); }
      else if (id === 'settings') { this.openSettings('graphics'); }
      else if (id === 'menu') { sfx('ui:back'); this.closePause(); this.setScreen('menu'); }
    };

    this.settings.onChange = (p) => { this.prefs = p; this.applyPrefs(); savePrefs(p); };
    this.settings.onClose = () => { sfx('ui:back'); this.closeSettings(); };

    this.death.onRespawn = () => {
      if (!this.death.canRespawn) { sfx('ui:error'); return; }
      sfx('ui:confirm');
      this.death.hide();
      this.deploy(this.spec ?? this.hangar.current, this.prefs.livery);
    };
    this.death.onHangar = () => { this.death.hide(); this.setScreen('hangar'); };
    this.matchEnd.onContinue = () => { this.matchEnd.hide(); this.setScreen('hangar'); };

    this.hud.chat.onSend = (text) => {
      this.net?.sendChat(text);
      // Echo locally so the player sees their own message even offline.
      this.hud.chat.push(this.prefs.playerName, text, this.ctx.localTeam, this.ctx.localTeam);
    };
    this.hud.chat.onClose = () => this.ctx.bus.emit('ui:modal', this.isModal());

    this.hud.markers.nameOf = (ownerId) => this.players.find((p) => p.id === ownerId)?.name ?? '';
    this.hud.markers.labelOf = (typeId) => aircraftByIndex(typeId).name;

    // --- network ----------------------------------------------------------
    on('net:welcome', (m) => {
      this.players = m.players ?? [];
      this.mapName = m.mapName ?? 'Unknown';
      this.menu.setInfo('server', 'Connected', 'ok');
      this.menu.setInfo('map', this.mapName);
      this.menu.setInfo('team', m.team === 0 ? 'Allied' : 'Axis');
      this.hud.notices.clear('link');
      this.lastLink = '';
      this.hud.chat.push('', `Joined ${this.mapName}`, 0, 0, true);
    });
    on('net:offline', () => {
      this.menu.setInfo('server', 'Offline sandbox', 'warn');
      this.announceLink('Server unavailable — flying offline', 'warn');
    });
    on('net:disconnected', () => {
      this.announceLink('Connection lost — flying offline', 'danger');
      this.menu.setInfo('server', 'Disconnected', 'warn');
    });
    on('net:match', (m) => {
      this.players = m.players ?? this.players;
      if (m.timeLeft !== undefined && m.timeLeft <= 0 && m.scoreA !== undefined) this.onMatchEnd(m);
    });
    on('net:kill', (m) => {
      this.hud.killLine(m.killer, m.victim, m.weapon, m.killerTeam, m.victimTeam,
        this.ctx.localTeam, this.prefs.playerName);
      if (m.killer === this.prefs.playerName) {
        this.hud.popups.push('AIRCRAFT DESTROYED', 100, true);
        this.hud.center.hit('kill');
        sfx('kill:confirm');
      }
      if (m.victim === this.prefs.playerName) this.onDeath(m.killer, m.weapon);
    });
    on('net:chat', (m) => this.hud.chat.push(m.from, m.text, m.team, this.ctx.localTeam));
    on('net:spawned', (m) => this.onSpawned(m));
    on('game:event', (e) => this.onGameEvent(e));
    on('quality', (q) => {
      this.applyQuality(String(q));
      // The engine's auto-scaler settles the tier during the first seconds of a
      // session, and every step of that settling used to raise a banner across
      // the top of the frame. Announcing a tier the player did not choose, while
      // they are still watching the world stream in, is noise — and it is noise
      // that lands in the middle of a screenshot. Only changes after the ramp
      // has finished are worth a word.
      if (this.age > 12) this.hud.notices.show('quality', `Quality: ${String(q).toUpperCase()}`, '', 2);
    });

    // --- optional producer channels --------------------------------------
    on('hud:telemetry', (p) => this.setTelemetry(p));
    on('hud:lead', (p) => this.setLead(p.x, p.y, p.visible ?? true, p.range ?? 0, p.onTarget ?? false, p.tof ?? 0));
    on('hud:hit', (p) => this.hitMarker(p?.kind ?? 'hit'));
    on('hud:input', (p) => { this.inputBits = p?.bits ?? 0; });
    on('ui:notice', (p) => this.hud.notices.show(p.key ?? 'x', p.text ?? '', p.kind ?? '', p.life ?? 4));
    on('world:markers', (p) => this.setWorldMarkers(p));
  }

  /**
   * Announces a change in link state — once, and then it goes away.
   *
   * This used to be a sticky banner, which meant "SERVER UNAVAILABLE — FLYING
   * OFFLINE" was painted across the top of the frame for the entire session
   * whenever no match server answered. That is the default state of a local
   * build, so it landed in the middle of every screenshot: a modal-looking
   * warning strip sitting over the gunsight in a frame that is supposed to be
   * a game, permanently, describing a condition the player cannot act on.
   *
   * The persistent statement of link state belongs where it already is — the
   * connection pill in the top-left corner, which reads OFFLINE · SOLO and is
   * styled for it. The banner's job is only to tell you the moment it changes,
   * so it is now a timed notice and it fires once per transition.
   */
  private lastLink = '';
  private announceLink(text: string, kind: 'warn' | 'danger'): void {
    if (this.lastLink === text) return;
    this.lastLink = text;
    this.hud.notices.show('link', text, kind, 6);
  }

  /** Reconciles the UI with whatever state the network subsystem is already in. */
  private syncNetState(): void {
    const net = this.net;
    this.menu.setInfo('aircraft', this.spec?.name ?? '—');
    this.menu.setInfo('team', this.ctx.localTeam === 0 ? 'Allied' : 'Axis');
    if (!net) {
      this.menu.setInfo('server', 'Local', 'warn');
      this.menu.setInfo('map', 'Sandbox');
      return;
    }
    this.mapName = net.mapName || this.mapName;
    this.players = net.players ?? [];
    this.menu.setInfo('map', this.mapName);
    if (net.offline) {
      this.menu.setInfo('server', 'Offline sandbox', 'warn');
      this.announceLink('Server unavailable — flying offline', 'warn');
    } else if (net.connected) {
      this.menu.setInfo('server', 'Connected', 'ok');
    } else {
      this.menu.setInfo('server', 'Connecting…');
    }
  }

  /** Finds the world subsystem's terrain sampler and its real objectives. */
  private resolveWorldApi(): void {
    const world = this.ctx.get('world') as unknown as {
      terrainHeight?: (x: number, z: number) => number;
      worldExtent?: number;
      airfields?: readonly { x: number; z: number; team: number }[];
    } | undefined;
    // Real airfields, rather than the five fictional objectives the minimap
    // used to invent. 'world:ready' covers the case where the world finishes
    // building after this runs; reading the property covers the case where it
    // already has.
    this.adoptAirfields(world?.airfields);
    this.unsubs.push(this.ctx.bus.on('world:ready', (p: { airfields?: readonly { x: number; z: number; team: number }[] }) => {
      this.adoptAirfields(p?.airfields);
    }));
    if (world && typeof world.terrainHeight === 'function') {
      const fn = world.terrainHeight.bind(world);
      this.telemetry.terrain = fn;
      this.hud.minimap.terrain = fn;
    } else {
      // Secondary route: the world module may export free functions. The
      // specifier is assembled at runtime so a missing module is a caught 404
      // rather than a build error.
      const spec = ['..', 'world'].join('/');
      import(/* @vite-ignore */ spec)
        .then((mod: Record<string, unknown>) => {
          const fn = mod?.terrainHeight;
          if (typeof fn === 'function') {
            const f = fn as (x: number, z: number) => number;
            this.telemetry.terrain = f;
            this.hud.minimap.terrain = f;
          }
        })
        .catch(() => { /* world exposes no sampler yet — minimap uses its own */ });
    }
    this.hud.minimap.setSeed(this.ctx.mapSeed, 32000);
  }

  /**
   * Mirrors the engine's quality tier onto the root as a class.
   *
   * The expensive parts of this stylesheet — backdrop blur over the live canvas,
   * overlay-blended hatching, the animated grain — are switched off from CSS
   * rather than from script, because they are presentation and because a class
   * swap costs one style recalculation instead of touching every panel.
   */
  private applyQuality(q: string): void {
    for (const t of QUALITY_TIERS) setClass(this.root, `q-${t}`, t === q);
  }

  /**
   * Turns the world's airfield sites into map markers.
   *
   * Only airfields: they are the one objective the world actually models, and
   * the map states nothing it cannot source. Anything richer (capture points and
   * their progress) has to arrive through 'world:markers' from whatever
   * subsystem owns the game mode.
   */
  private adoptAirfields(sites: readonly { x: number; z: number; team: number }[] | undefined): void {
    if (!sites || !sites.length) return;
    const out: WorldMarker[] = [];
    // A, B, C… per team, which is how players refer to them over the radio.
    const perTeam = new Map<number, number>();
    for (const s of sites) {
      const n = (perTeam.get(s.team) ?? 0) + 1;
      perTeam.set(s.team, n);
      out.push({
        kind: 'airfield', x: s.x, z: s.z, team: s.team,
        name: `AIRFIELD ${String.fromCharCode(64 + n)}`,
      });
    }
    this.hud.minimap.markers = out;
  }

  // -------------------------------------------------------------------------
  // Public API for other subsystems
  // -------------------------------------------------------------------------

  /** Pushes authoritative instrument values. Pushed keys stop being derived. */
  setTelemetry(partial: Partial<HudTelemetry>): void {
    const keys = Object.keys(partial) as (keyof HudTelemetry)[];
    this.telemetry.setOwned(keys);
    Object.assign(this.telemetry.data, partial);
  }

  /** Fire-control solution in screen pixels (InputSystem owns this). */
  setLead(x: number, y: number, visible: boolean, range: number, onTarget: boolean, tof = 0): void {
    this.lead.x = x; this.lead.y = y; this.lead.visible = visible;
    this.lead.range = range; this.lead.onTarget = onTarget; this.lead.tof = tof;
    this.leadExternal = true;
    this.leadExternalT = 0.5;
  }

  /** Same, but given a world-space aim point — projected here. */
  setLeadWorld(x: number, y: number, z: number, range = 0, onTarget = false): void {
    _aim.set(x, y, z).project(this.ctx.camera);
    const sx = (_aim.x * 0.5 + 0.5) * this.w;
    const sy = (-_aim.y * 0.5 + 0.5) * this.h;
    this.setLead(sx, sy, _aim.z < 1, range, onTarget);
  }

  hitMarker(kind: 'hit' | 'crit' | 'kill' | 'armour' = 'hit'): void {
    this.hud.center.hit(kind);
    sfx(kind === 'kill' ? 'kill:confirm' : 'hit:marker');
    this.directHitT = 0.25;
  }

  /** Flashes a damage-direction arc pointing at a world position. */
  damageFrom(x: number, y: number, z: number): void {
    const local = this.localState();
    if (!local) return;
    const dx = x - local.px, dz = z - local.pz;
    const heading = Math.atan2(local.vx, local.vz);
    const bearing = Math.atan2(dx, dz) - heading;
    this.hud.center.damageFrom(bearing);
  }

  scorePopup(text: string, points = 0, big = false): void {
    this.hud.popups.push(text, points, big);
  }

  notice(text: string, kind: '' | 'warn' | 'danger' = '', life = 4, key = 'msg'): void {
    this.hud.notices.show(key, text, kind, life);
  }

  setWorldMarkers(markers: WorldMarker[]): void {
    if (Array.isArray(markers)) this.hud.minimap.markers = markers;
  }

  /** Hands the hangar the real aircraft mesh builder. */
  setAircraftBuilder(fn: AircraftBuilder): void {
    this.hangar.viewer.builder = fn;
  }

  setAmmo(counts: number[]): void {
    this.telemetry.setAmmoAbsolute(counts);
  }

  get currentScreen(): UiScreen { return this.screen; }
  /** True while a menu, chat entry or modal has the keyboard. */
  isModal(): boolean {
    return this.screen !== 'flight' || this.settingsOpen || this.pauseOpen
      || this.hud.chat.isTyping || this.death.isOpen;
  }

  // -------------------------------------------------------------------------
  // Screens
  // -------------------------------------------------------------------------

  setScreen(s: UiScreen): void {
    if (this.screen === s) return;
    this.screen = s;
    this.applyScreen();
    this.ctx.bus.emit('ui:screen', s);
    this.ctx.bus.emit('ui:modal', this.isModal());
  }

  /** Pushes the current screen into the DOM. Also used once at boot, where
   *  'setScreen' would short-circuit and leave every screen visible. */
  private applyScreen(): void {
    const s = this.screen;
    this.menu.setVisible(s === 'menu');
    this.hangar.setVisible(s === 'hangar');
    this.hud.setVisible(s === 'flight' && this.prefs.showHud);
    if (s !== 'flight') this.closePause();
  }

  private deploy(spec: AircraftSpec, livery: number): void {
    sfx('ui:confirm');
    this.spec = spec;
    this.prefs.lastAircraft = spec.id;
    this.prefs.livery = livery;
    savePrefs(this.prefs);
    this.telemetry.setAircraft(spec);
    this.telemetry.refill();
    this.death.hide();
    this.setScreen('flight');
    this.ctx.bus.emit('ui:spawn', { aircraft: spec.id, livery, typeId: aircraftIndex(spec.id) });
    this.net?.requestSpawn(spec.id);
    this.hud.notices.show('deploy', `${spec.name} — cleared for take-off`, '', 3);
  }

  private onSpawned(m: { entityId?: number; aircraft?: string }): void {
    if (m?.aircraft && AIRCRAFT_BY_ID[m.aircraft]) {
      this.spec = AIRCRAFT_BY_ID[m.aircraft];
      this.telemetry.setAircraft(this.spec);
      this.telemetry.refill();
    }
    // Offline, NetSystem announces a spawn without owning an entity id; adopt
    // it so the HUD has something to track. Harmless when another subsystem
    // has already set it.
    if (!this.ctx.localEntityId && m?.entityId) this.ctx.localEntityId = m.entityId;
    this.death.hide();
    this.setScreen('flight');
    this.wasAlive = true;
    this.lastDamage = 0;
  }

  private onDeath(killer: string, weapon: string): void {
    if (this.death.isOpen) return;
    this.death.show(killer, weapon, this.respawnSeconds);
    this.ctx.bus.emit('ui:killcam', { progress: 0, killer });
    this.ctx.bus.emit('ui:modal', true);
  }

  private onMatchEnd(m: { scoreA: number; scoreB: number }): void {
    if (!this.matchEnd.root.classList.contains('ct-hidden')) return;
    const allyScore = this.ctx.localTeam === 0 ? m.scoreA : m.scoreB;
    const foeScore = this.ctx.localTeam === 0 ? m.scoreB : m.scoreA;
    this.matchEnd.show(allyScore >= foeScore, `${allyScore} — ${foeScore} · ${this.mapName}`);
    this.scoreboard.setVisible(true);
  }

  private openSettings(tab: 'graphics' | 'controls' | 'audio' | 'interface'): void {
    this.settingsOpen = true;
    this.settings.setTab(tab);
    this.settings.setVisible(true);
    this.ctx.bus.emit('ui:modal', true);
  }

  private closeSettings(): void {
    this.settingsOpen = false;
    this.settings.setVisible(false);
    this.ctx.bus.emit('ui:modal', this.isModal());
  }

  private openPause(): void {
    this.pauseOpen = true;
    this.pause.setVisible(true);
    this.ctx.bus.emit('ui:modal', true);
  }

  private closePause(): void {
    this.pauseOpen = false;
    this.pause.setVisible(false);
    this.ctx.bus.emit('ui:modal', this.isModal());
  }

  private applyPrefs(): void {
    applyPrefs(this.prefs, this.ctx);
    this.hud.setUnits(this.prefs.units);
    setStyle(this.root, '--scale', String(this.prefs.hudScale));
    this.hud.setVisible(this.screen === 'flight' && this.prefs.showHud);
    // The HUD-scale setting changes --px on the HUD layer, so the JS design
    // pixel has to be re-read before the geometry is rebuilt.
    // FOV changes move the conformal ladder, so the centre group is rebuilt too.
    this.resize(this.w, this.h);
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.settings.isListening) return;
    const chatting = this.hud.chat.isTyping;
    if (chatting) return;    // the input field handles its own keys

    const bind = this.prefs.bindings;

    if (e.code === 'Escape') {
      sfx('ui:back');
      if (this.settingsOpen) { this.closeSettings(); return; }
      if (this.screen === 'hangar') { this.hangar.onBack(); return; }
      if (this.screen === 'flight') { this.pauseOpen ? this.closePause() : this.openPause(); return; }
      return;
    }

    if (this.settingsOpen) return;

    if (this.pauseOpen) { if (this.pause.handleKey(e)) e.preventDefault(); return; }
    if (this.screen === 'menu') { if (this.menu.handleKey(e)) e.preventDefault(); return; }
    if (this.screen === 'hangar') { if (this.hangar.handleKey(e)) e.preventDefault(); return; }

    // --- in flight --------------------------------------------------------
    if (e.code === (bind.scoreboard ?? 'Tab')) {
      e.preventDefault();
      if (!this.scoreOpen) { this.scoreOpen = true; this.scoreboard.setVisible(true); }
      return;
    }
    if (e.code === (bind.chat ?? 'Enter')) {
      if (this.death.isOpen && this.death.canRespawn) { this.death.onRespawn(); return; }
      e.preventDefault();
      this.hud.chat.open();
      this.ctx.bus.emit('ui:modal', true);
      return;
    }
    if (e.code === (bind.hudToggle ?? 'KeyU')) {
      this.prefs.showHud = !this.prefs.showHud;
      this.applyPrefs();
      savePrefs(this.prefs);
      return;
    }
    if (e.code === 'Space' && this.death.isOpen && this.death.canRespawn) {
      e.preventDefault();
      this.death.onRespawn();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === (this.prefs.bindings.scoreboard ?? 'Tab') && this.scoreOpen) {
      this.scoreOpen = false;
      // The match-end card keeps the scoreboard pinned open.
      if (this.matchEnd.root.classList.contains('ct-hidden')) this.scoreboard.setVisible(false);
    }
  };

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private onGameEvent(e: {
    kind: EventKind; x: number; y: number; z: number;
    nx: number; ny: number; nz: number; scale: number; a: number; b: number;
  }): void {
    const localId = this.ctx.localEntityId;
    switch (e.kind) {
      case EventKind.Gunfire:
        if (e.a === localId) this.telemetry.consumeAmmo(e.b === 2 ? 2 : 1, 1);
        break;
      case EventKind.HitSpark:
      case EventKind.HitArmour:
        if (e.a === localId) {
          this.damageFrom(e.x, e.y, e.z);
        } else if (this.directHitT <= 0 && this.target && e.a === this.target.id) {
          // No explicit hit report from the combat system: infer one when the
          // impact lands on the contact we are currently tracking.
          this.hud.center.hit(e.kind === EventKind.HitArmour ? 'armour' : 'hit');
          sfx('hit:marker');
          this.hud.popups.push('HIT', 10);
        }
        break;
      case EventKind.Critical:
        if (e.a !== localId) { this.hud.center.hit('crit'); sfx('hit:marker'); this.hud.popups.push('CRITICAL HIT', 40); }
        break;
      case EventKind.Kill:
        if (e.a === localId) this.onDeath('', '');
        break;
      case EventKind.Explosion:
        if (e.a === localId) this.damageFrom(e.x, e.y, e.z);
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  private localState(): EntityState | null {
    const e = this.ctx.entities.get(this.ctx.localEntityId);
    if (e) { this.synthActive = false; return e; }
    if (this.screen !== 'flight') return null;
    return this.synthesise();
  }

  /**
   * Keeps the HUD alive before the flight/entity systems replicate anything.
   *
   * The camera is the only thing guaranteed to exist and to be moving, so the
   * fallback derives an aircraft state from it. What it must never do is look
   * like real instrumentation: it used to publish throttle 0.82, rpm 0.86, full
   * health and a hard-coded 118 m/s, which drove the tapes to a confident
   * ~425 km/h and the gauges to a running engine — numbers indistinguishable
   * from the real thing and completely invented.
   *
   * Now the position and attitude are real (they come from the camera, and the
   * ladder, compass and FPM are honest about the view), and everything the
   * camera cannot know is zeroed. 'synthActive' is published to the HUD, which
   * dashes the tapes and greys the gauges rather than printing a fiction.
   */
  private synthesise(): EntityState {
    const cam = this.ctx.camera;
    const s = this.synth;
    if (!this.synthActive) {
      this.synthActive = true;
      s.id = -1;
      s.kind = EntityKind.Aircraft;
      s.health = 1;
      s.damage = 0;
      // Nothing the camera can tell us about the powerplant. Zero, not a
      // plausible cruise setting.
      s.throttle = 0;
      s.rpm = 0;
      s.flaps = 0;
      s.gear = 0;
    }
    cam.getWorldDirection(_v);
    s.px = cam.position.x + _v.x * 12;
    s.py = cam.position.y + _v.y * 12;
    s.pz = cam.position.z + _v.z * 12;
    const q = cam.quaternion;
    s.qx = q.x; s.qy = q.y; s.qz = q.z; s.qw = q.w;
    // No airspeed to report. The old 118 m/s made the tapes read a confident
    // 425 km/h that no part of the game had produced.
    s.vx = 0; s.vy = 0; s.vz = 0;
    return s;
  }

  /** Seconds since the UI came up; gates boot-time chatter. */
  private age = 0;

  private cameraSys: (Subsystem & { mode?: string }) | null = null;
  private wasCockpit = false;

  update(ctx: GameContext): void {
    const dt = ctx.dt;
    this.age += dt;

    // Mirror external changes to showHud (another subsystem may toggle it).
    if (ctx.settings.showHud !== this.prefs.showHud) {
      this.prefs.showHud = ctx.settings.showHud;
      this.hud.setVisible(this.screen === 'flight' && this.prefs.showHud);
    }

    // The centre HUD needs to know when it is being drawn inside a cockpit, and
    // the camera does not announce it: screenshot framings assign the mode
    // directly rather than going through 'setMode', so there is no event to
    // listen for. Reading the subsystem is what the registry is for, and the
    // lookup is cached because it cannot change after boot.
    if (!this.cameraSys) this.cameraSys = ctx.get<Subsystem & { mode?: string }>('camera') ?? null;
    const inCockpit = this.cameraSys?.mode === 'cockpit';
    if (inCockpit !== this.wasCockpit) {
      this.wasCockpit = inCockpit;
      this.hud.setCockpitView(inCockpit);
    }

    // Dimming is derived, never latched: every path that opens or closes an
    // overlay would otherwise have to remember to undo it.
    this.hud.setDim(this.screen !== 'flight' || this.death.isOpen || this.scoreOpen || this.pauseOpen);

    this.directHitT = Math.max(0, this.directHitT - dt);
    this.leadExternalT -= dt;
    if (this.leadExternalT <= 0) this.leadExternal = false;

    const local = this.localState();
    this.telemetry.update(local, dt, this.inputBits);
    const t = this.telemetry.data;
    // Be visibly honest when the instruments have nothing behind them.
    this.hud.setNoData(this.synthActive);

    // Death detection from replicated state, as a backstop for the kill event.
    if (local && this.screen === 'flight') {
      const destroyed = (t.damage & DamageBits.Destroyed) !== 0 || (t.health <= 0 && this.wasAlive);
      if (destroyed && !this.death.isOpen) this.onDeath('', '');
      // New damage this frame: warn, and point at whoever is behind us.
      if (t.damage !== this.lastDamage) {
        const added = t.damage & ~this.lastDamage;
        this.lastDamage = t.damage;
        if (added) this.announceDamage(added);
      }
      this.wasAlive = t.health > 0;
    }

    if (this.screen === 'flight') {
      this.target = this.hud.updateContacts(ctx, this.prefs);
      this.hud.updateFpm(ctx);
      if (!this.leadExternal) this.computeLead(local, t);
      this.hud.update(ctx, t, this.lead, this.prefs, dt);
    } else {
      // Menus still need the feeds to tick so notices expire.
      this.hud.notices.update(dt);
      this.hud.killfeed.update(dt);
      this.hud.chat.update(dt);
    }

    if (this.screen === 'hangar') this.hangar.update(dt);

    // Connection + match strip run in every screen.
    const net = this.net;
    if (net) {
      this.hud.conn.update(net.connected, net.offline, net.rttMs);
      this.hud.match.update(net.scoreA, net.scoreB, net.timeLeft);
      if (net.players.length) this.players = net.players;
      this.menu.setInfo('players', String(this.players.length || 1));
      this.menu.setInfo('ping', net.offline ? 'n/a' : `${Math.round(net.rttMs)} ms`);
    }

    if (this.scoreOpen || !this.matchEnd.root.classList.contains('ct-hidden')) {
      this.scoreboard.update(
        this.players, net?.scoreA ?? 0, net?.scoreB ?? 0, net?.timeLeft ?? 0,
        ctx.localPlayerId, ctx.localTeam, this.mapName, ctx.entities, net?.rttMs ?? 0,
      );
    }

    if (this.death.isOpen) {
      const ramp = this.death.update(dt);
      ctx.bus.emit('ui:killcam', { progress: ramp });
      setStyle(this.root, 'filter', ramp > 0 ? `saturate(${(1 - ramp * 0.75).toFixed(2)})` : '');
    } else {
      setStyle(this.root, 'filter', '');
    }

    this.minimapAcc += dt;
  }

  private announceDamage(added: number): void {
    // No notice for fire: the master caution banner under the reticle already
    // says ENGINE FIRE, in larger type, and holds for as long as the fire burns.
    // Raising a second banner directly above it that says the same thing in
    // different words is the kind of duplicated chrome that makes a HUD read as
    // assembled rather than designed.
    if (added & DamageBits.EngineFire) { /* covered by #ct-firewarn */ }
    else if (added & DamageBits.Engine) this.notice('Engine damaged', 'danger', 3, 'dmg-eng');
    else if (added & DamageBits.WingRipped) this.notice('Wing failure', 'danger', 3, 'dmg-wing');
    else if (added & DamageBits.ControlsSevered) this.notice('Controls severed', 'danger', 3, 'dmg-ctl');
    else if (added & DamageBits.PilotHit) this.notice('Pilot wounded', 'danger', 3, 'dmg-pilot');
    else if (added & DamageBits.FuelLeak) this.notice('Fuel leak', 'warn', 3, 'dmg-fuel');
    else if (added & DamageBits.OilLeak) this.notice('Oil leak', 'warn', 3, 'dmg-oil');
    else if (added & (DamageBits.LeftWing | DamageBits.RightWing | DamageBits.Tail)) {
      this.notice('Airframe damaged', 'warn', 2, 'dmg-frame');
    }
  }

  /**
   * Fallback fire-control solution.
   *
   * Solves the classic lead problem: find the flight time 't' such that the
   * round and the target arrive at the same place, then aim there, corrected
   * for gravity drop over that time. Two fixed-point iterations converge to
   * well under a metre at fighter ranges — far below the dispersion of the
   * guns themselves. InputSystem is expected to own this; until it does, this
   * keeps the lead pip real rather than decorative.
   */
  private computeLead(local: EntityState | null, tel: HudTelemetry): void {
    const tgt = this.target;
    if (!local || !tgt || !tgt.state || !this.spec) {
      this.lead.visible = false;
      return;
    }
    const gun = this.spec.guns[0];
    const muzzle = gun ? gun.muzzle : 850;
    const s = tgt.state;

    let dx = s.px - local.px, dy = s.py - local.py, dz = s.pz - local.pz;
    const rvx = s.vx - local.vx, rvy = s.vy - local.vy, rvz = s.vz - local.vz;
    let tof = Math.hypot(dx, dy, dz) / muzzle;
    for (let i = 0; i < 2; i++) {
      const ax = dx + rvx * tof, ay = dy + rvy * tof, az = dz + rvz * tof;
      tof = Math.hypot(ax, ay, az) / muzzle;
    }
    // Aim point in world space, lifted by the ballistic drop over the flight.
    _aim.set(
      s.px + s.vx * tof,
      s.py + s.vy * tof + 0.5 * G * tof * tof,
      s.pz + s.vz * tof,
    );
    _tmp.copy(_aim).project(this.ctx.camera);
    const behind = _tmp.z > 1;
    const x = (_tmp.x * 0.5 + 0.5) * this.w;
    const y = (-_tmp.y * 0.5 + 0.5) * this.h;

    const dist = Math.hypot(dx, dy, dz);
    // Smoothing: the assist slider trades pip steadiness for responsiveness.
    const k = clamp(1 - this.prefs.aimAssist * 0.75, 0.12, 1);
    this.lead.x += (x - this.lead.x) * k;
    this.lead.y += (y - this.lead.y) * k;
    if (!Number.isFinite(this.lead.x)) { this.lead.x = x; this.lead.y = y; }
    this.lead.visible = !behind && dist < 2600 && x > 0 && x < this.w && y > 0 && y < this.h;
    this.lead.range = dist;
    this.lead.tof = tof;
    this.lead.onTarget = this.lead.visible
      && Math.hypot(this.lead.x - this.w * 0.5, this.lead.y - this.h * 0.5) < 26 * this.u;
    dx = dy = dz = 0;
  }

  // -------------------------------------------------------------------------

  resize(width: number, height: number): void {
    this.w = width || innerWidth;
    this.h = height || innerHeight;
    // Read the design-pixel unit straight from CSS so JS-driven geometry and
    // CSS-driven layout can never disagree about scale — and read it from the
    // HUD layer, not the root, because that is where the HUD-scale setting is
    // folded into --px.
    const px = parseFloat(getComputedStyle(this.hud.root).getPropertyValue('--px'));
    this.u = Number.isFinite(px) && px > 0 ? px : Math.min(this.w / 1920, this.h / 1080);
    this.hud.resize(this.w, this.h, this.u, this.prefs.fov);
  }

  dispose(): void {
    setUiAudioSink(null);
    removeEventListener('keydown', this.onKeyDown, false);
    removeEventListener('keyup', this.onKeyUp, false);
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.settings.dispose();
    this.hangar.viewer.dispose();
    this.root.remove();
  }
}

/** Re-exported so integrators can type against the roster without a new import. */
export { AIRCRAFT };
