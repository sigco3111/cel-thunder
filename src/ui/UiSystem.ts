import * as THREE from 'three';
import type { GameContext, Subsystem } from '../engine/context';
import type { NetSystem } from '../net/NetSystem';
import {
  DamageBits, EntityKind, EventKind, newEntityState,
  type EntityState, type PlayerInfo,
} from '../shared/protocol';
import {
  AIRCRAFT, AIRCRAFT_BY_ID, aircraftByIndex, aircraftIndex, nationTeam,
  type AircraftSpec,
} from '../shared/aircraft';
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
import { ControlLegend, FirstFlight } from './menu/Legend';
import { Tutorial, type TutorialProbe } from './menu/Tutorial';
import type { BindingSet } from '../engine/input/bindings';
import type { AircraftBuilder } from './menu/HangarViewer';

export type UiScreen = 'menu' | 'hangar' | 'flight';

const _v = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const G = 9.80665;
const QUALITY_TIERS = ['low', 'medium', 'high', 'ultra'] as const;
/**
 * Seconds a hit keeps crediting the player for what happens to that aeroplane.
 *
 * Long enough to cover the gap between the burst that started a fire and the
 * server's fire event, short enough that a bandit which broke away and was
 * finished off by somebody else does not report as the player's work.
 */
const MY_VICTIM_MEMORY = 4;
/**
 * Seconds a death screen may sit over a living aeroplane before it is closed
 * as stale. Long enough that a 'Kill' event arriving a frame or two ahead of
 * the snapshot which carries the 'Destroyed' bit is not mistaken for one.
 */
const STALE_DEATH_S = 1.0;

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
  private legend!: ControlLegend;
  private firstFlight!: FirstFlight;
  private tutorial!: Tutorial;
  /** Set once a cinematic framing has been applied — see 'ui:debugFraming'. */
  private cinematic = false;

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
  /** Entity the player's rounds last landed on, and how long that is trusted. */
  private myVictim = 0;
  private myVictimT = 0;
  /** Seconds a death screen has been up over an aeroplane that is alive. */
  private deathStale = 0;
  private inputBits = 0;
  private lastDamage = 0;
  private wasAlive = false;
  private synth: EntityState = newEntityState();
  private synthActive = false;
  private unsubs: (() => void)[] = [];
  /** Must match 'OfflineSandbox.RESPAWN_DELAY' / the server's match rules. */
  private respawnSeconds = 5;

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
      { id: 'tutorial', label: 'Flight school', hint: '' },
      { id: 'hangar', label: 'Hangar', hint: 'H' },
      { id: 'settings', label: 'Settings', hint: 'O' },
      { id: 'controls', label: 'Controls', hint: 'K' },
    ]);
    this.hangar = new Hangar(this.root);
    this.pause = new PauseMenu(this.root, [
      { id: 'resume', label: 'Resume', hint: 'ESC' },
      { id: 'controls', label: 'Controls', hint: 'F1' },
      { id: 'hangar', label: 'Change aircraft', hint: '' },
      { id: 'settings', label: 'Settings', hint: '' },
      { id: 'menu', label: 'Leave battle', hint: '' },
    ]);
    this.settings = new SettingsPanel(this.root, this.prefs);
    this.legend = new ControlLegend(this.root);
    this.firstFlight = new FirstFlight(this.root);
    this.tutorial = new Tutorial(this.root);
    // The engine's binding table is the only true one — see menu/Legend.ts.
    this.legend.setBindings(this.liveBindings());
    this.settings.setBindings(this.liveBindings());
    this.tutorial.setBindings(this.liveBindings());
    // A player who skips flight school still gets the one-card summary; one who
    // sat through it has just been taught the same six things, at length.
    this.tutorial.onEnd = (completed) => {
      this.mutePrompt(false);
      // Only in the air. Leaving the aeroplane also ends flight school, and
      // without this guard the "basics" card would follow the player into the
      // hangar and sit over the aircraft they were choosing.
      if (!completed && this.screen === 'flight') {
        this.firstFlight.show(this.liveBindings(), 14, true);
      }
    };

    this.wire();
    this.applyPrefs();
    this.resolveWorldApi();
    this.screen = 'menu';
    this.applyScreen();
    this.settings.setVisible(false);
    this.scoreboard.setVisible(false);
    this.death.hide();
    this.matchEnd.hide();

    // The network subsystem initialises before this one, so its welcome or
    // offline event has already fired and been missed. Read the state directly
    // instead of waiting for an event that will never come again. This also
    // puts the hangar on the right side and seeds it with the last aircraft
    // flown, in that order — the roster has to exist before a selection can
    // land in it.
    this.syncNetState();
    this.spec = this.hangar.current;
    this.telemetry.setAircraft(this.spec);

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
      else if (id === 'tutorial') {
        // Arm it and send them to the hangar; it starts on the next Deploy,
        // which is where the aeroplane it teaches actually appears.
        Tutorial.replay();
        this.replayTutorial = true;
        this.setScreen('hangar');
      } else if (id === 'hangar') this.setScreen('hangar');
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
    this.hangar.onDeploy = (spec, livery, loadout) => this.deploy(spec, livery, loadout);

    this.pause.onSelect = (id) => {
      if (id === 'resume') { sfx('ui:back'); this.closePause(); }
      else if (id === 'controls') { this.openSettings('controls'); }
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
      this.deploy(this.spec ?? this.hangar.current, this.prefs.livery, this.hangar.currentLoadout);
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
      // The hangar's roster is the side's roster. Told here so the very first
      // visit already offers the right aircraft, before any screen change.
      this.hangar.setTeam(m.team === 1 ? 1 : 0);
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
      if (isLocalName(m.killer, this.prefs.playerName)) {
        this.hud.popups.push('AIRCRAFT DESTROYED', 100, true);
        this.hud.center.hit('kill');
        sfx('kill:confirm');
      }
      if (isLocalName(m.victim, this.prefs.playerName)) this.onDeath(m.killer, m.weapon);
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
    // Stores readout + bombsight solution, produced by FlightSystem's ordnance
    // runtime. Pushed rather than polled: the impact prediction is a real
    // ballistic integration and runs on its own schedule.
    on('hud:ordnance', (p) => this.hud.setOrdnance(p ?? null));
    on('hud:lead', (p) => this.setLead(p.x, p.y, p.visible ?? true, p.range ?? 0, p.onTarget ?? false, p.tof ?? 0));
    on('hud:hit', (p) => this.hitMarker(p?.kind ?? 'hit'));
    on('hud:input', (p) => { this.inputBits = p?.bits ?? 0; });
    on('ui:notice', (p) => this.hud.notices.show(p.key ?? 'x', p.text ?? '', p.kind ?? '', p.life ?? 4));
    on('world:markers', (p) => this.setWorldMarkers(p));

    // --- controls ---------------------------------------------------------
    on('input:toggleControls', () => this.toggleLegend());
    // The screenshot harness poses the camera directly rather than playing the
    // game, so every teaching overlay stands down for good once it does.
    on('ui:debugFraming', () => {
      this.cinematic = true;
      this.tutorial.finish(false);
      this.firstFlight.hide();
      this.legend.setVisible(false);
    });
    // The 'O' key cycles the scheme inside the input subsystem; mirror it back
    // into the preference so the settings panel never contradicts the game.
    on('input:scheme', (s) => {
      const mode = s === 'realistic' ? 'realistic' : 'mouse-aim';
      if (this.prefs.controlMode === mode) return;
      this.prefs.controlMode = mode;
      savePrefs(this.prefs);
      this.settings.refreshControls();
    });
  }

  /**
   * The engine's live binding table, or null in a build without an input
   * subsystem. Looked up structurally for the same reason the audio sink is:
   * the interface must stay usable when a subsystem is missing.
   */
  private liveBindings(): BindingSet | null {
    const input = this.ctx.get('input') as unknown as { bindings?: BindingSet } | undefined;
    return input?.bindings ?? null;
  }

  /** Mutes the engine's own "click to take the controls" prompt. */
  private mutePrompt(v: boolean): void {
    const input = this.ctx.get('input') as unknown as {
      mouse?: { setPromptMuted?: (v: boolean) => void };
    } | undefined;
    input?.mouse?.setPromptMuted?.(v);
  }

  private toggleLegend(): void {
    if (this.screen !== 'flight') return;
    this.legend.setBindings(this.liveBindings());
    sfx(this.legend.toggle() ? 'ui:click' : 'ui:back');
    // Deliberately NOT a modal: the legend does not suspend input and does not
    // release the pointer. A player checking which key drops the gear is still
    // flying the aeroplane, and yanking the mouse out of the game to show them
    // a list would be its own small betrayal.
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
    // 'welcome' lands inside NetSystem.init, which has already finished by the
    // time this subsystem exists — so the event handler above can and does
    // miss it, and the hangar would sit on its constructor default. This is
    // the reconciliation path that exists for exactly that reason, so the side
    // is re-asserted here too. Without it a pilot on the Axis roster is
    // offered Spitfires, picks one, and is silently handed a Bf 109.
    this.hangar.setTeam(this.ctx.localTeam);
    this.hangar.selectById(this.prefs.lastAircraft);
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
    // Re-assert the side every time the hangar opens rather than once at boot:
    // the team is not known until 'welcome' lands, and it can move between
    // sorties. An out-of-date roster here is how a Mustang pilot ends up in a
    // Messerschmitt.
    if (s === 'hangar') this.hangar.setTeam(this.ctx.localTeam);
    this.hangar.setVisible(s === 'hangar');
    this.hud.setVisible(s === 'flight' && this.prefs.showHud);
    if (s !== 'flight') {
      this.closePause();
      // Leaving the aeroplane ends the lesson; it re-arms on the next Deploy
      // only if the player asked for it from the menu. Finished first, so its
      // 'onEnd' cannot put a card up that the two lines below were meant to
      // have cleared.
      this.tutorial.finish(false);
      this.legend.setVisible(false);
      this.firstFlight.hide();
    }
  }

  private deploy(spec: AircraftSpec, livery: number, loadout = 'clean'): void {
    sfx('ui:confirm');
    this.spec = spec;
    this.prefs.lastAircraft = spec.id;
    this.prefs.livery = livery;
    savePrefs(this.prefs);
    this.telemetry.setAircraft(spec);
    this.telemetry.refill();
    this.death.hide();
    this.setScreen('flight');
    this.ctx.bus.emit('ui:spawn', {
      aircraft: spec.id, livery, loadout, typeId: aircraftIndex(spec.id),
    });
    this.net?.requestSpawn(spec.id, loadout);
    this.hud.notices.show('deploy', `${spec.name} — cleared for take-off`, '', 3);

    // Take the pointer here, synchronously, while the browser still counts this
    // as the Deploy click.
    //
    // Pointer lock may only be requested from inside a user gesture, and this is
    // the last gesture before the player is in the air. Asking for it here is
    // the difference between spawning with the mouse already flying the
    // aeroplane and spawning uncaptured — which is the state the player was
    // actually in, chasing a cursor they did not know was the stick. It must
    // stay in the same task: an await, a timeout or a promise callback here and
    // the gesture has expired and the request is refused.
    this.ctx.bus.emit('input:captureMouse');

    // ...and, on the very first sortie, teach them to fly it.
    //
    // Not while a cinematic framing is driving the camera: the screenshot
    // harness poses the world itself and a tutorial card across every beauty
    // shot would be a regression in ten framings at once.
    if (!this.cinematic) {
      const started = this.tutorial.start(this.replayTutorial);
      this.replayTutorial = false;
      // Flight school says "click to take the controls" itself, larger and in
      // the same place; two panels with the same sentence is worse than one.
      if (started) this.mutePrompt(true);
      // No tutorial (already seen) but still a first flight — show the card.
      if (!started) this.firstFlight.show(this.liveBindings());
    }
  }
  private replayTutorial = false;

  private onSpawned(m: { entityId?: number; aircraft?: string }): void {
    if (m?.aircraft && AIRCRAFT_BY_ID[m.aircraft]) {
      this.spec = AIRCRAFT_BY_ID[m.aircraft];
      this.telemetry.setAircraft(this.spec);
      this.telemetry.refill();
      // Whatever the authority actually put us in is what the hangar should be
      // showing next time, and what the menu should be naming. Anything else
      // leaves the interface describing an aeroplane the player is not in.
      this.menu.setInfo('aircraft', this.spec.name);
      this.hangar.setTeam(nationTeam(this.spec.nation));
      this.hangar.selectById(this.spec.id);
    }
    // Offline, NetSystem announces a spawn without owning an entity id; adopt
    // it so the HUD has something to track. Harmless when another subsystem
    // has already set it.
    if (!this.ctx.localEntityId && m?.entityId) this.ctx.localEntityId = m.entityId;
    this.death.hide();
    this.setScreen('flight');
    // Explicitly, and NOT via 'setScreen'. The death screen is an overlay, not
    // a screen, so on respawn 'this.screen' is already 'flight' and setScreen
    // short-circuits before it re-emits the modal state — leaving 'ui:modal'
    // latched true from 'onDeath', which suspends the input subsystem. The
    // aeroplane then respawns with the controls dead and the player cannot fly
    // it again for the rest of the session.
    //
    // The bug is older than the death screen ever firing: offline, the killfeed
    // name never matched the local player, so 'onDeath' was unreachable and
    // this could not be hit. Making death work is what surfaced it.
    this.ctx.bus.emit('ui:modal', this.isModal());
    this.wasAlive = true;
    this.lastDamage = 0;
    // Say where the fight is, once the world has had a moment to replicate.
    this.briefIn = 4;
  }

  /** Seconds until the post-spawn "where is everyone" brief. 0 = done. */
  private briefIn = 0;

  /**
   * Tells the player what to do next.
   *
   * A new pilot spawns into an empty sky with a compass, a minimap and no idea
   * which way anything is. The markers were always there; what was missing was
   * the sentence that makes them mean something. This posts once per life,
   * after the entity table has had a few seconds to fill.
   */
  private briefObjective(): void {
    const me = this.ctx.entities.get(this.ctx.localEntityId);
    if (!me) return;
    let best: EntityState | null = null;
    let bestD = Infinity;
    for (const e of this.ctx.entities.values()) {
      if (e.kind !== EntityKind.Aircraft || e.id === me.id) continue;
      if (e.team === this.ctx.localTeam || e.health <= 0) continue;
      const d = Math.hypot(e.px - me.px, e.py - me.py, e.pz - me.pz);
      if (d < bestD) { bestD = d; best = e; }
    }
    if (!best) {
      this.notice('No contacts — steer for the marked airfields', '', 6, 'brief');
      return;
    }
    // Compass bearing to the contact: +Z is north in this world, and 'atan2(x, z)'
    // is what the HUD's own compass uses, so the number the player is told
    // matches the number on the tape.
    const brg = ((Math.atan2(best.px - me.px, best.pz - me.pz) * 180) / Math.PI + 360) % 360;
    this.notice(
      `Hostiles bearing ${Math.round(brg).toString().padStart(3, '0')}° · ${(bestD / 1000).toFixed(1)} km — marked in red`,
      '', 7, 'brief',
    );
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
    this.legend.setVisible(false);
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

    // The first-flight card is an interruption, so any key clears it — but it
    // does not *consume* the key, or the first thing a new player learns is
    // that their first input did nothing.
    this.firstFlight.hide();

    if (e.code === 'Escape') {
      // Escape unwinds one layer at a time, innermost first. Closing the legend
      // must not also open the pause menu.
      if (this.tutorial.handleEscape()) return;
      if (this.legend.isOpen) { sfx('ui:back'); this.legend.setVisible(false); return; }
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
        } else if (e.b === localId) {
          // Remember whose aeroplane we are putting rounds into, so the
          // 'Critical' arm below can tell "the engine I just set on fire" from
          // "somebody else's fight two kilometres away".
          this.myVictim = e.a;
          this.myVictimT = MY_VICTIM_MEMORY;
          if (this.directHitT <= 0) {
            // Gate on "I fired the round", not on "I have this contact locked".
            // The event already carries the shooter, so the lock was never
            // needed — and gating on it meant that every hit on anything the
            // player had not explicitly targeted produced the hit *sound*
            // (which is not gated) with no marker to go with it. Landing shots
            // on an untracked bandit is the single most common thing that
            // happens in a furball, and it was the case with the weakest
            // feedback.
            this.hud.center.hit(e.kind === EventKind.HitArmour ? 'armour' : 'hit');
            sfx('hit:marker');
            this.hud.popups.push('HIT', 10);
          }
        }
        break;
      case EventKind.Critical:
        // Only a critical the player caused.
        //
        // This used to fire for a critical on *any* aeroplane that was not the
        // player's, which at four a side was a rare and roughly accurate
        // approximation and at ten a side is a permanent ticker: twenty
        // aircraft in three simultaneous engagements produce a fire, a seized
        // engine or a severed control run every few seconds, none of which the
        // player did or can see. The wire event names the victim and the
        // module but not the attacker, so the attribution comes from the hit
        // sparks the player's own rounds produced a moment earlier.
        if (e.a !== localId && e.a === this.myVictim && this.myVictimT > 0) {
          this.hud.center.hit('crit');
          sfx('hit:marker');
          this.hud.popups.push('CRITICAL HIT', 40);
        }
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

    this.firstFlight.update(dt);
    if (this.tutorial.isActive) this.tutorial.update(dt, this.probeForTutorial());
    if (this.briefIn > 0 && this.screen === 'flight' && !this.cinematic) {
      this.briefIn -= dt;
      if (this.briefIn <= 0) this.briefObjective();
    }
    this.directHitT = Math.max(0, this.directHitT - dt);
    this.myVictimT = Math.max(0, this.myVictimT - dt);

    /*
     * A death screen must never outlive the death.
     *
     * The three things that make one up arrive on three different channels: the
     * kill feed as JSON, the 'Kill' event in the binary event stream, and the
     * respawn as another JSON message. Nothing orders them against each other,
     * so a Kill event that lands *after* the 'spawned' it belongs to reopens
     * the screen over an aeroplane that is already flying again — and because
     * the screen is modal, the input subsystem stays suspended. The player is
     * then airborne, healthy, and unable to move the controls for the rest of
     * the session, with no further spawn coming to clear it.
     *
     * At four a side that was rare enough to have never been seen. At ten it
     * happens in the ordinary course of a match, so it is closed here on the
     * only fact that matters: the aeroplane is alive. The hold-off covers the
     * genuine case, where the Kill event legitimately precedes the snapshot
     * carrying the 'Destroyed' bit by a frame or two.
     */
    if (this.death.isOpen) {
      const me = this.ctx.localEntityId
        ? this.ctx.entities.get(this.ctx.localEntityId) : undefined;
      const flying = !!me && me.health > 0 && !(me.damage & DamageBits.Destroyed);
      this.deathStale = flying ? this.deathStale + dt : 0;
      if (this.deathStale > STALE_DEATH_S) {
        this.deathStale = 0;
        this.death.hide();
        this.ctx.bus.emit('ui:modal', this.isModal());
        console.warn('[ui] closed a death screen that outlived the death');
      }
    } else {
      this.deathStale = 0;
    }
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

  /**
   * One frame's worth of "what has the player actually done", for the tutorial.
   *
   * Read off the live subsystems rather than pushed, because every value here
   * already has an owner and duplicating them into an event would be one more
   * thing to keep in step. Structurally typed for the usual reason: a build
   * without an input subsystem must still reach the menu.
   */
  private probeForTutorial(): TutorialProbe {
    const input = this.ctx.get('input') as unknown as {
      mouse?: { locked?: boolean; lockDenied?: boolean };
      throttle?: number;
      down?: (a: string) => boolean;
    } | undefined;
    const down = (a: string): boolean => input?.down?.(a) === true;
    const t = this.telemetry.data;
    return {
      locked: input?.mouse?.locked === true,
      lockUnavailable: input?.mouse?.lockDenied === true,
      throttleKey: down('throttleUp') || down('throttleDown'),
      throttle: input?.throttle ?? 0,
      firing: down('fire1') || down('fire2'),
      cameraMode: this.cameraSys?.mode ?? '',
      pitchDeg: t.pitch,
      bankDeg: t.roll,
      flying: this.screen === 'flight' && !this.synthActive && !this.death.isOpen && t.health > 0,
    };
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

/**
 * Whether a killfeed name refers to the local player.
 *
 * Online the server sends the player's chosen name, so a plain comparison is
 * right. Offline the sandbox has no idea what the player called themselves and
 * labels them 'You' — while 'prefs.playerName' defaults to something like
 * 'Pilot417'. The two never matched, which meant that in single player the kill
 * banner, the kill-confirm sting, the 'kill' hit marker and the death screen
 * were all silently switched off. Every one of those features existed and was
 * correct; they were being asked the wrong question.
 */
function isLocalName(name: string | undefined, playerName: string): boolean {
  return !!name && (name === playerName || name === 'You');
}

/** Re-exported so integrators can type against the roster without a new import. */
export { AIRCRAFT };
