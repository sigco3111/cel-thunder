import * as THREE from 'three';
import { el, setText, setClass, setStyle, clamp, int, fixed, mmss, distStr } from '../dom';
import { t } from '../../i18n';
import type { GameContext } from '../../engine/context';
import type { HudTelemetry } from '../Telemetry';
import { manifoldUnit } from '../Telemetry';
import type { UiPrefs } from '../store';
import { CenterHud, type LeadState } from './CenterHud';
import { Tape, VsiStrip, type TapeConfig } from './Tapes';
import { Compass } from './Compass';
import { Gauge, ThrottleBar, FlagRow, AmmoPanel, GMeter } from './Systems';
import { DamagePanel } from './DamagePanel';
import { Markers, type TargetInfo } from './Markers';
import { Minimap } from './Minimap';
import { Killfeed, Notices, Popups, ConnPill, MatchStrip, ChatBox } from './Feed';
import { OrdnancePanel, BombSight, type OrdnanceView } from './Ordnance';

const SPEED_METRIC: TapeConfig = { min: 0, max: 1000, tick: 10, labelEvery: 5, spacing: 13, unit: 'km/h', digits: 3, quantum: 1 };
const SPEED_IMPERIAL: TapeConfig = { min: 0, max: 640, tick: 10, labelEvery: 5, spacing: 16, unit: 'mph', digits: 3, quantum: 1 };
const ALT_METRIC: TapeConfig = { min: 0, max: 12000, tick: 100, labelEvery: 5, spacing: 22, unit: 'm', digits: 5, quantum: 1 };
const ALT_IMPERIAL: TapeConfig = { min: 0, max: 40000, tick: 500, labelEvery: 4, spacing: 26, unit: 'ft', digits: 5, quantum: 1 };

const _pos = new THREE.Vector3();
const _sight = new THREE.Vector3();
const _fpm = new THREE.Vector3();
const _lp = new THREE.Vector3();
const _vel = new THREE.Vector3();

/**
 * Assembles and drives every in-flight HUD element.
 *
 * Layout follows the reading order a pilot actually uses: attitude and
 * gunsight dead centre, energy state (speed/altitude/VSI) on the primary
 * scan either side of it, systems and damage bottom-right where they are
 * glanceable but never in the way of a gun solution, situational awareness
 * (map, feed, compass) around the frame.
 */
export class Hud {
  readonly root: HTMLElement;
  readonly center: CenterHud;
  readonly markers: Markers;
  readonly minimap: Minimap;
  readonly killfeed: Killfeed;
  readonly notices: Notices;
  readonly popups: Popups;
  readonly conn: ConnPill;
  readonly match: MatchStrip;
  readonly chat: ChatBox;

  private speedTape: Tape;
  private altTape: Tape;
  private vsi: VsiStrip;
  private compass: Compass;
  private throttle: ThrottleBar;
  private gRpm: Gauge;
  private gMap: Gauge;
  private gOil: Gauge;
  private gWater: Gauge;
  private gFuel: Gauge;
  private flags: FlagRow;
  private ammo: AmmoPanel;
  private stores: OrdnancePanel;
  private bombsight: BombSight;
  /** Latest ordnance state pushed in by the flight side; null when clean. */
  private ordnance: OrdnanceView | null = null;
  private damage: DamagePanel;
  private gmeter: GMeter;
  private fireWarn: HTMLElement;
  private sysHeadAux: HTMLElement;
  /* Instruments a contact label may not be drawn over, and the scratch buffer
     their measured rectangles go into. Measured from the live layout rather
     than hard-coded from the stylesheet, so the two can never drift. */
  private protectEls: HTMLElement[] = [];
  private protectBuf = new Float64Array(4 * 16);
  private protectAcc = 99;

  private units: 'metric' | 'imperial' = 'metric';
  private u = 1;
  private w = 1920;
  private h = 1080;
  private lastSpecId = '';
  private lastGLimit = NaN;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ct-layer', parent);
    this.root.id = 'ct-hud';

    this.center = new CenterHud(this.root);

    this.speedTape = new Tape(this.root, 'left', SPEED_METRIC, 'TAS', 'MACH');
    this.altTape = new Tape(this.root, 'right', ALT_METRIC, 'RDR', 'V/S');
    this.vsi = new VsiStrip(this.root, 40);
    this.compass = new Compass(this.root);
    this.match = new MatchStrip(this.root);
    this.conn = new ConnPill(this.root);

    // --- systems column ---------------------------------------------------
    const sys = el('div', 'ct-sys', this.root);

    const power = el('div', 'ct-panel ct-hatch', sys);
    const ph = el('div', 'ct-head', power);
    el('span', '', ph, t('hudPowerplant'));
    el('span', 'ct-head-rule', ph);
    this.sysHeadAux = el('span', 'ct-head-aux', ph, '—');
    this.throttle = new ThrottleBar(power);
    const grid = el('div', 'ct-sys-grid', power);
    this.gRpm = new Gauge(grid, t('hudGaugeRpm'), 0.92);
    this.gMap = new Gauge(grid, t('hudGaugeMap'), 0.9);
    this.gOil = new Gauge(grid, t('hudGaugeOil'), 0.86);
    this.gWater = new Gauge(grid, t('hudGaugeH2o'), 0.86);
    this.gFuel = new Gauge(grid, t('hudGaugeFuel'), 1);
    // FlagRow keys are looked up by an internal map, so they must stay as the
    // English internal identifiers (matching the abbreviations used elsewhere).
    // The display text is rewritten to the localised label via setLabel() below.
    this.flags = new FlagRow(power, ['GEAR', 'FLAPS', 'BRAKE', 'RAD', 'WEP', 'WHL']);
    this.flags.setLabel('GEAR', t('hudFlagGear'));
    this.flags.setLabel('FLAPS', t('hudFlagFlaps'));
    this.flags.setLabel('BRAKE', t('hudFlagBrake'));
    this.flags.setLabel('RAD', t('hudFlagRad'));
    this.flags.setLabel('WEP', t('hudFlagWep'));
    this.flags.setLabel('WHL', t('hudFlagWhl'));

    const frame = el('div', 'ct-panel ct-hatch', sys);
    const fh = el('div', 'ct-head', frame);
    el('span', '', fh, t('hudAirframe'));
    el('span', 'ct-head-rule', fh);
    this.damage = new DamagePanel(frame);
    this.ammo = new AmmoPanel(frame);

    // Stores go under the airframe panel, in the same column as the ammunition
    // counters: they are the same class of information — what is left to shoot
    // with — and a pilot scans them together.
    this.stores = new OrdnancePanel(sys);

    this.gmeter = new GMeter(this.root);

    this.fireWarn = el('div', '', this.root, t('hudEngineFire'));
    this.fireWarn.id = 'ct-firewarn';
    setStyle(this.fireWarn, 'display', 'none');

    // Under the markers so a contact label is never printed over the pipper,
    // and over the centre stack so the fall line reads across the reticle.
    this.bombsight = new BombSight(this.root);

    this.minimap = new Minimap(this.root);
    this.markers = new Markers(this.root);
    this.killfeed = new Killfeed(this.root);
    this.popups = new Popups(this.root);
    this.notices = new Notices(this.root);
    this.chat = new ChatBox(this.root);

    // Everything a target block must never be printed on top of. The airspeed
    // and altitude odometers are first because they are the readouts a pilot
    // scans continuously and they sit exactly where contacts in the forward
    // quarter project to.
    this.protectEls = [
      this.speedTape.chip, this.altTape.chip,
      ...this.speedTape.subs, ...this.altTape.subs,
      this.vsi.root, this.compass.root, this.minimap.root, sys, this.gmeter.root,
    ];
  }

  /**
   * Re-measures the keep-out rectangles and hands them to the marker layer.
   *
   * getBoundingClientRect forces a style/layout flush, so this runs a few times
   * a second rather than every frame — the panels it measures only move on a
   * resize or when a panel is toggled, and a 400 ms stale rectangle on a chip
   * that has not moved costs nothing.
   */
  private measureProtected(): void {
    const buf = this.protectBuf;
    let n = 0;
    const pad = 6 * this.u;
    for (const e of this.protectEls) {
      if (n * 4 >= buf.length) break;
      if (!e.offsetParent && e.style.display === 'none') continue;
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const o = n * 4;
      buf[o] = r.left - pad; buf[o + 1] = r.top - pad;
      buf[o + 2] = r.right + pad; buf[o + 3] = r.bottom + pad;
      n++;
    }
    this.markers.setProtected(buf, n);
  }

  // -------------------------------------------------------------------------

  resize(w: number, h: number, u: number, fov: number): void {
    this.w = w; this.h = h; this.u = u;
    this.center.resize(w, h, u, fov);
    this.speedTape.resize(u);
    this.altTape.resize(u);
    this.compass.resize(u, 540 * u);
    this.markers.resize(w, h, u);
    this.bombsight.resize(w, h, u);
    this.minimap.resize(244 * u, Math.min(devicePixelRatio || 1, 2));
    this.protectAcc = 99;
  }

  setUnits(units: 'metric' | 'imperial'): void {
    if (units === this.units) return;
    this.units = units;
    this.speedTape.setConfig(units === 'metric' ? SPEED_METRIC : SPEED_IMPERIAL);
    this.altTape.setConfig(units === 'metric' ? ALT_METRIC : ALT_IMPERIAL);
  }

  setVisible(on: boolean): void {
    setClass(this.root, 'is-off', !on);
  }

  /**
   * Tells the HUD the camera is inside the cockpit.
   *
   * Only the centre stack cares: the ladder has to be occluded by the coaming
   * and the convergence bracket has to go, because the reflector sight's own
   * frame already brackets the aiming point. Everything else — tapes, systems,
   * minimap, contact labels — is head-up furniture that reads the same either
   * way.
   */
  setCockpitView(on: boolean): void {
    this.center.setCockpit(on);
  }

  /** Dims the whole HUD (used during the killcam ramp and in menus). */
  setDim(on: boolean): void {
    setClass(this.root, 'is-dim', on);
  }

  /**
   * Marks the instruments as unfed.
   *
   * The HUD has a fallback that derives an aircraft state from the camera so it
   * stays alive between pressing Deploy and the spawn landing. That fallback
   * knows where the camera is and nothing else, and a HUD that prints an
   * invented airspeed and a running engine is worse than one that admits it has
   * no data — the player cannot tell the difference, which is exactly the
   * problem. This greys the instrument groups and puts a NO TELEMETRY caption
   * under the reticle so it is unmistakable.
   */
  setNoData(on: boolean): void {
    if (this.noData === on) return;
    this.noData = on;
    setClass(this.root, 'is-nodata', on);
    if (on) this.notices.sticky('nodata', t('hudNoTelemetry'), 'warn');
    else this.notices.clear('nodata');
  }
  private noData = false;

  // -------------------------------------------------------------------------

  update(ctx: GameContext, telem: HudTelemetry, lead: LeadState, prefs: UiPrefs, dt: number): void {
    const imperial = this.units === 'imperial';

    // --- energy state -----------------------------------------------------
    const spd = imperial ? telem.ias * 2.236936 : telem.ias * 3.6;
    const tas = imperial ? telem.tas * 2.236936 : telem.tas * 3.6;
    this.speedTape.update(spd);
    this.speedTape.setSub(
      int(tas),
      fixed(telem.mach, 2),
      telem.overspeed ? 'danger' : '',
      telem.mach > 0.72 ? 'warn' : '',
    );

    const alt = imperial ? telem.altBaro * 3.28084 : telem.altBaro;
    const rad = imperial ? telem.altRadar * 3.28084 : telem.altRadar;
    this.altTape.update(alt);
    const vs = imperial ? telem.vspeed * 196.85 : telem.vspeed;
    this.altTape.setSub(
      rad < 9999 ? int(rad) : '----',
      (vs >= 0 ? '+' : '') + int(vs),
      telem.altRadar < 150 && telem.vspeed < -8 ? 'danger' : '',
      '',
    );
    this.vsi.update(telem.vspeed);

    // --- attitude / gunsight ---------------------------------------------
    // Track the live camera FOV, not the setting: the camera rig may zoom or
    // widen with speed, and a ladder that ignores that stops being conformal.
    this.center.setFov(ctx.camera.fov);
    this.center.update(telem, lead, dt);
    this.compass.update(telem.heading, this.bearingCache);

    // --- powerplant -------------------------------------------------------
    this.throttle.update(telem.throttle, telem.wep);
    const spec = telem.spec;
    if (spec) {
      const mu = manifoldUnit(spec.nation);
      this.gRpm.update(telem.rpmFrac, int(telem.rpm), telem.rpmFrac > 1.02 ? 1 : telem.rpmFrac * 0.82);
      const mp = telem.manifold * mu.scale;
      this.gMap.update(clamp(telem.manifold / 1.7, 0, 1), `${mp.toFixed(mu.digits)}`, clamp(telem.manifold / 1.62, 0, 1));
      this.gOil.update(clamp(telem.oilTemp / 140, 0, 1), `${Math.round(telem.oilTemp)}°`, telem.oilFrac);
      this.gWater.update(clamp(telem.coolantTemp / 150, 0, 1), `${Math.round(telem.coolantTemp)}°`, telem.coolantFrac);
      const ff = telem.fuelMax > 0 ? telem.fuel / telem.fuelMax : 0;
      this.gFuel.update(ff, telem.fuelTime > 0 ? mmss(telem.fuelTime) : '—', 1 - ff);
      setText(this.sysHeadAux, `${spec.engine.kind === 'radial' ? t('hudRadial') : t('hudInline')} · ${mu.unit.toUpperCase()}`);
      // The red arc only moves when the airframe does. Rebuilding it every
      // frame allocated two closures and two arrays for an identical path.
      if (spec.aero.gLimit !== this.lastGLimit) {
        this.lastGLimit = spec.aero.gLimit;
        this.gmeter.setLimit(spec.aero.gLimit);
      }
    }

    this.flags.set('GEAR', telem.gear > 0.98 ? 'on' : telem.gear > 0.02 ? 'warn' : '');
    this.flags.set('FLAPS', telem.flaps > 0.66 ? 'on' : telem.flaps > 0.02 ? 'warn' : '');
    this.flags.set('BRAKE', telem.airbrake > 0.5 ? 'on' : '');
    this.flags.set('RAD', telem.radiator > 0.8 ? 'on' : '');
    this.flags.set('WEP', telem.wep ? 'danger' : '');
    this.flags.set('WHL', telem.altRadar < 5 && telem.gear > 0.9 ? 'on' : '');

    // --- airframe ---------------------------------------------------------
    const specId = spec?.id ?? '';
    if (specId !== this.lastSpecId) {
      this.lastSpecId = specId;
      this.damage.build(spec);
      this.ammo.build(telem.ammo, specId);
    }
    this.damage.update(telem.damage, telem.health);
    this.stores.update(this.ordnance);
    this.updateBombSight(ctx, telem);
    this.ammo.update(telem.ammo);
    this.gmeter.update(telem.gLoad, telem.gPeak, telem.gMin, spec?.aero.gLimit ?? 9);

    const fire = (telem.damage & 128) !== 0; // DamageBits.EngineFire
    setStyle(this.fireWarn, 'display', fire ? 'block' : 'none');

    // --- envelope warnings ------------------------------------------------
    if (telem.alive) {
      if (telem.stall) this.notices.show('stall', t('hudStall'), 'danger', 0.6);
      if (telem.overspeed) this.notices.show('vne', t('hudOverspeed'), 'danger', 0.6);
      if (telem.gWarn) this.notices.show('g', t('hudGLimit'), 'warn', 0.5);
      if (telem.fuelMax > 0 && telem.fuel / telem.fuelMax < 0.12) this.notices.show('fuel', t('hudLowFuel'), 'warn', 1.2);
      if (telem.altRadar < 120 && telem.vspeed < -12) this.notices.show('gpws', t('hudPullUp'), 'danger', 0.5);
    }

    // --- surroundings -----------------------------------------------------
    this.killfeed.update(dt);
    this.notices.update(dt);
    this.popups.update(dt);
    this.chat.update(dt);
    setStyle(this.minimap.root, 'display', prefs.showMinimap ? 'block' : 'none');
  }

  /**
   * Latest stores state from the flight side.
   *
   * Pushed rather than pulled: the impact solution is expensive enough that the
   * flight system runs it on its own schedule, and the HUD has no business
   * asking for a fresh one every frame.
   */
  setOrdnance(v: OrdnanceView | null): void {
    this.ordnance = v;
  }

  /**
   * Projects the impact solution and the flight-path marker into screen space.
   *
   * Both come from the same camera the frame is rendered with, so the pipper
   * is conformal: it sits on the piece of ground the bombs will actually hit,
   * at any field of view and in any attitude.
   */
  private updateBombSight(ctx: GameContext, t: HudTelemetry): void {
    const o = this.ordnance;
    const local = ctx.entities.get(ctx.localEntityId);
    if (!o || !o.hasSolution || o.bombs <= 0 || !local || !t.alive) {
      this.bombsight.hide();
      return;
    }

    _sight.set(o.ix, o.iy, o.iz).project(ctx.camera);
    const behind = _sight.z > 1;
    const px = (_sight.x * 0.5 + 0.5) * this.w;
    const py = (-_sight.y * 0.5 + 0.5) * this.h;
    // A little slack past the frame edge so the pipper does not blink out the
    // instant it touches the border during a hard pull.
    const margin = 40 * this.u;
    const onScreen = !behind
      && px > -margin && px < this.w + margin && py > -margin && py < this.h + margin;

    // The fall line springs from the flight-path marker — where the aeroplane
    // is going — because that is the point the bomb inherits its velocity from.
    const speed = Math.hypot(local.vx, local.vy, local.vz);
    let fx = this.w * 0.5, fy = this.h * 0.5;
    if (speed > 12) {
      _fpm.set(local.vx, local.vy, local.vz).multiplyScalar(600 / speed)
        .add(_lp.set(local.px, local.py, local.pz))
        .project(ctx.camera);
      if (_fpm.z <= 1) {
        fx = (_fpm.x * 0.5 + 0.5) * this.w;
        fy = (-_fpm.y * 0.5 + 0.5) * this.h;
      }
    }

    this.bombsight.update(true, onScreen, px, py, fx, fy, o.range, o.fallTime, o.tooLow);
  }

  /** Bearing of the current primary target, cached for the compass caret. */
  private bearingCache = NaN;
  private minimapAcc = 0;

  updateContacts(ctx: GameContext, prefs: UiPrefs): TargetInfo | null {
    const local = ctx.entities.get(ctx.localEntityId);
    if (local) _pos.set(local.px, local.py, local.pz);
    else _pos.copy(ctx.camera.position);

    this.protectAcc += ctx.dt;
    if (this.protectAcc >= 0.4) { this.protectAcc = 0; this.measureProtected(); }

    const tgt = this.markers.update(
      ctx.camera, ctx.entities, ctx.localEntityId, ctx.localTeam, _pos, prefs.showMarkers,
    );
    this.bearingCache = tgt ? tgt.bearing : NaN;

    // The minimap redraws a whole canvas; 20 Hz is indistinguishable from 60
    // for a map at this scale and keeps it off the frame budget.
    this.minimapAcc += ctx.dt;
    if (prefs.showMinimap && this.minimapAcc >= 0.05) {
      this.minimapAcc = 0;
      let hdg = 0;
      if (local) hdg = Math.atan2(local.vx, local.vz) * 57.29578;
      this.minimap.update(ctx.entities, ctx.localEntityId, ctx.localTeam, _pos.x, _pos.z, hdg);
    }
    return tgt;
  }

  /** Projects the velocity vector to screen space for the flight-path marker. */
  updateFpm(ctx: GameContext): void {
    const local = ctx.entities.get(ctx.localEntityId);
    if (!local) { this.center.setFpm(0, 0, false); return; }
    const speed = Math.hypot(local.vx, local.vy, local.vz);
    if (speed < 12) { this.center.setFpm(0, 0, false); return; }
    _vel.set(local.vx, local.vy, local.vz).multiplyScalar(600 / speed)
      .add(_pos.set(local.px, local.py, local.pz));
    _vel.project(ctx.camera);
    const behind = _vel.z > 1;
    const x = (_vel.x * 0.5 + 0.5) * this.w;
    const y = (-_vel.y * 0.5 + 0.5) * this.h;
    const inside = !behind && x > 0 && x < this.w && y > 0 && y < this.h;
    this.center.setFpm(x, y, inside);
  }

  hint(text: string): void {
    this.notices.show('hint', text, '', 5);
  }

  killLine(killer: string, victim: string, weapon: string, kt: number, vt: number, localTeam: number, me: string): void {
    this.killfeed.push(killer, victim, weapon, kt, vt, localTeam, me);
  }

  distanceLabel(m: number): string { return distStr(m); }
}
