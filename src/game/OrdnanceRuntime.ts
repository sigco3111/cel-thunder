import type { GameContext } from '../engine/context';
import {
  EntityKind, EventKind, InputBits, newEntityState, type EntityState,
} from '../shared/protocol';
import { AIRCRAFT, type AircraftSpec } from '../shared/aircraft';
import { clamp, q, qrot, Rng, v3, vlen, type Q, type V3 } from '../shared/math';
import type { ClientEnv } from './env';
import { dropBomb, launchRocket, predictBombImpact } from '../shared/combat/ordnance';
import {
  ProjectilePool, advanceBallistic,
} from '../shared/combat/ballistics';
import { applyExplosion, warheadCasing, visualBlastRadius } from '../shared/combat/explosion';
import { peakBlastDamage } from '../shared/combat/penetration';
import { buildAircraftProxy } from '../shared/combat/proxy';
import {
  type CombatEnv, type CombatTarget, type HitResult, type Projectile,
  ProjectileKind,
} from '../shared/combat/types';
import { resolveLoadout, type RuntimeLoadout } from './loadout';

/**
 * Air-to-ground ordnance, from the pickle button to the crater.
 *
 * Everything simulated here already existed and was tested in
 * 'src/shared/combat/' — 'ordnance.ts' for release and launch, 'ballistics.ts'
 * for the integrator, 'explosion.ts' and 'penetration.ts' for the blast. What
 * was missing was anything that called it. This is that caller: it holds the
 * local aircraft's stores, releases them on the input bits the input layer has
 * always set, steps them through the real integrator, and hands the burst to
 * the real blast model.
 *
 * ## Offline it simulates; online it displays
 *
 * The server is now authoritative over ordnance: it holds the racks, it
 * releases on the input bits, it flies the stores through the same shared
 * integrator and it owns the ground order of battle (see 'server/Room.ts' and
 * 'server/GroundUnits.ts'). So in an online match this class simulates
 * *nothing*. It keeps the bombsight — which is a prediction, and is allowed to
 * be — mirrors the rack state the server sends in 'stores', and mirrors the
 * replicated GroundUnit health onto the local world's targets so the models the
 * player can see agree with the ones the match is scored on.
 *
 * Offline there is no server, so it runs the whole thing itself, through
 * exactly the same shared code the server calls.
 *
 * ## Fusing
 *
 * Bombs arm 0.6 s after release and function 45 ms after impact, which is what
 * stops a low pass from fragging the aeroplane that made it. Rockets arm 0.35 s
 * off the rail. Both come straight from the shared specs; nothing is special
 * cased here.
 */

/** Structural view of the world subsystem — see the note in FlightSystem. */
interface GroundTargetLike {
  id: number;
  kind: string;
  team: number;
  x: number; y: number; z: number;
  radius: number;
  hp: number;
  maxHp: number;
  alive: boolean;
}

interface WorldLike {
  targets: readonly GroundTargetLike[];
  destroyTarget(t: GroundTargetLike): void;
}

/** What the HUD needs to draw the stores readout and the bombsight. */
export interface OrdnanceHudState {
  /** Loadout display name, '' when clean. */
  name: string;
  short: string;
  bombName: string;
  bombs: number;
  bombsMax: number;
  rocketName: string;
  rockets: number;
  rocketsMax: number;
  /** True when a bomb impact prediction is available. */
  hasSolution: boolean;
  /** Predicted impact point of a bomb released now, world space. */
  ix: number; iy: number; iz: number;
  /** Time of fall to that point, s. */
  fallTime: number;
  /** Slant range from the aircraft to the predicted impact, m. */
  range: number;
  /** True while the release would put the aircraft inside its own blast. */
  tooLow: boolean;
  /** Seconds since the last release — drives the release flash. */
  sinceRelease: number;
}

/** One store still attached to the aeroplane, for the model. */
interface StoreSlot {
  /** 0 = bomb, 1 = rocket. */
  kind: 0 | 1;
  index: number;
  attached: boolean;
}

const FWD: V3 = { x: 0, y: 0, z: 1 };
const DOWN_BODY: V3 = { x: 0, y: -1, z: 0 };

/** Ejector-rack push-off, m/s. Enough to clear the propeller arc in a dive. */
const EJECT_SPEED = 2.4;
/** Minimum interval between rockets in a ripple, s. */
const RIPPLE = 0.09;
/** Bomb release interval when more than one is on the rack, s. */
const STICK_INTERVAL = 0.12;

/** How often the impact prediction is re-run, s. It is the only heavy call. */
const SIGHT_PERIOD = 0.12;

const _rot: Q = q();
const _mount: V3 = v3();
const _fwd: V3 = v3();
const _down: V3 = v3();
const _origin: V3 = v3();
const _vel: V3 = v3();
const _impact: V3 = v3();

export class OrdnanceRuntime {
  private ctx!: GameContext;
  private env!: ClientEnv;
  private world: WorldLike | null = null;
  private worldResolved = false;
  /**
   * True in an online match: the server owns the stores and the ground units,
   * and everything below that would simulate either of them stands down.
   */
  private authoritative = false;
  /** Local target each replicated GroundUnit entity stands for. */
  private unitTargets = new Map<number, GroundTargetLike>();

  private pool = new ProjectilePool(48);
  private rng = new Rng(0x51f00d);
  private live: Projectile[] = [];
  /** Replicated records for the stores in flight, keyed by projectile id. */
  private states = new Map<number, EntityState>();
  private nextId = 60000;

  private rl: RuntimeLoadout | null = null;
  private slots: StoreSlot[] = [];
  private bombsLeft = 0;
  private rocketsLeft = 0;
  private releaseCd = 0;
  private prevBits = 0;
  private sinceRelease = 99;
  private sightAcc = 0;

  private hud: OrdnanceHudState = {
    name: '', short: '', bombName: '', bombs: 0, bombsMax: 0,
    rocketName: '', rockets: 0, rocketsMax: 0,
    hasSolution: false, ix: 0, iy: 0, iz: 0, fallTime: 0, range: 0,
    tooLow: false, sinceRelease: 99,
  };

  /**
   * Combat environment for the blast model. 'queryTargets' walks the replicated
   * entity table, which is the only aircraft list that is correct in both the
   * offline sandbox and an online match.
   */
  private combatEnv: CombatEnv = {
    time: 0,
    rng: this.rng,
    terrainHeight: (x, z) => this.env.terrainHeight(x, z),
    queryTargets: (p0, p1, pad, out) => this.queryTargets(p0, p1, pad, out),
  };

  private targetPool: CombatTarget[] = [];

  init(ctx: GameContext, env: ClientEnv): void {
    this.ctx = ctx;
    this.env = env;
    const net = ctx.get('net') as { connected?: boolean } | undefined;
    this.authoritative = net?.connected === true;
    // The racks are the server's online; this is the only thing that moves the
    // counts, so a release the player made is reflected when the server has
    // actually made it.
    ctx.bus.on('net:stores', (m: { loadout?: string; bombs?: number; rockets?: number }) => {
      this.authoritative = true;
      if (typeof m?.bombs === 'number') this.bombsLeft = m.bombs;
      if (typeof m?.rockets === 'number') this.rocketsLeft = m.rockets;
      this.refreshHudCounts();
    });
  }

  // -------------------------------------------------------------------------
  // Loadout
  // -------------------------------------------------------------------------

  /** Arms the local aeroplane. Called on every deploy and every respawn. */
  setLoadout(spec: AircraftSpec | null, loadoutId: string | undefined): void {
    this.rl = spec ? resolveLoadout(spec, loadoutId) : null;
    this.slots.length = 0;
    this.bombsLeft = 0;
    this.rocketsLeft = 0;
    this.releaseCd = 0;
    this.sinceRelease = 99;

    const l = this.rl?.loadout;
    if (l?.bombs) {
      this.bombsLeft = l.bombs.count;
      for (let i = 0; i < l.bombs.count; i++) this.slots.push({ kind: 0, index: i, attached: true });
    }
    if (l?.rockets) {
      this.rocketsLeft = l.rockets.count;
      for (let i = 0; i < l.rockets.count; i++) this.slots.push({ kind: 1, index: i, attached: true });
    }
    this.publishStores();
    this.refreshHudCounts();
  }

  /** Mass still hanging on the aeroplane, kg. */
  get extraMass(): number {
    const rl = this.rl;
    if (!rl) return 0;
    return this.bombsLeft * rl.bombMass + this.rocketsLeft * rl.rocketMass;
  }

  /**
   * External drag area, m². The racks stay behind after release, so this never
   * returns to zero once something has been hung on the aeroplane — which is
   * exactly the small permanent penalty a strike fighter pays.
   */
  get extraDragArea(): number {
    const rl = this.rl;
    if (!rl) return 0;
    const total = (rl.loadout.bombs?.count ?? 0) + (rl.loadout.rockets?.count ?? 0);
    if (total <= 0) return 0;
    const left = this.bombsLeft + this.rocketsLeft;
    return rl.rackDrag + rl.storeDrag * (left / total);
  }

  get hudState(): Readonly<OrdnanceHudState> { return this.hud; }
  get bombsRemaining(): number { return this.bombsLeft; }
  get rocketsRemaining(): number { return this.rocketsLeft; }
  /**
   * Stores in the air. Offline that is the local list; online it is the count of
   * replicated Bomb and Rocket entities, which is the same thing seen from the
   * other side of the wire — and which every other client can see too.
   */
  get storesInFlight(): number {
    if (!this.authoritative) return this.live.length;
    let n = 0;
    for (const e of this.ctx.entities.values()) {
      if (e.kind === EntityKind.Bomb || e.kind === EntityKind.Rocket) n++;
    }
    return n;
  }
  get loadoutId(): string { return this.rl?.loadout.id ?? 'clean'; }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /**
   * One frame. 'bits' is the input frame the flight path just consumed, so a
   * release happens on exactly the tick the player pressed the button.
   */
  update(dt: number, bits: number): void {
    const ctx = this.ctx;
    this.combatEnv.time = ctx.time;
    this.sinceRelease += dt;
    if (this.releaseCd > 0) this.releaseCd -= dt;

    const self = ctx.entities.get(ctx.localEntityId);

    if (self && self.kind === EntityKind.Aircraft && self.health > 0) {
      // Edge-triggered: the input layer pulses these bits for a single frame,
      // but a dropped frame or a repeated input frame must not double-release.
      const down = bits & ~this.prevBits;
      if (!this.authoritative) {
        if (down & InputBits.DropBomb) this.releaseBomb(self);
        if (down & InputBits.FireRocket) this.fireRockets(self);
      } else if (down & (InputBits.DropBomb | InputBits.FireRocket)) {
        // The bit is already on its way to the server in this frame's input.
        this.sinceRelease = 0;
      }
      this.updateSight(dt, self);
    } else {
      this.hud.hasSolution = false;
    }
    this.prevBits = bits;

    if (this.authoritative) this.syncGroundUnits();
    else this.stepStores(dt);
    this.hud.sinceRelease = this.sinceRelease;
  }

  // -------------------------------------------------------------------------
  // Release
  // -------------------------------------------------------------------------

  private releaseBomb(s: EntityState): void {
    const rl = this.rl;
    if (!rl || !rl.bomb || this.bombsLeft <= 0 || this.releaseCd > 0) return;

    const slot = this.nextSlot(0);
    if (!slot) return;
    slot.attached = false;
    this.bombsLeft--;
    this.releaseCd = STICK_INTERVAL;
    this.sinceRelease = 0;

    this.bodyFrame(s);
    const mount = rl.bombMounts[slot.index % rl.bombMounts.length];
    qrot(_rot, v3(mount[0], mount[1], mount[2]), _mount);
    _origin.x = s.px + _mount.x; _origin.y = s.py + _mount.y; _origin.z = s.pz + _mount.z;
    _vel.x = s.vx; _vel.y = s.vy; _vel.z = s.vz;

    const p = dropBomb({
      spec: rl.bomb,
      origin: _origin,
      velocity: _vel,
      ownerId: s.ownerId,
      team: s.team,
      shooterEntity: s.id,
      time: this.ctx.time,
      // The ejector rack pushes the bomb clear along the aircraft's own down
      // axis, which is what keeps it out of the propeller in a steep dive and
      // off the belly in inverted release.
      ejectSpeed: EJECT_SPEED,
      down: _down,
      rng: this.rng,
      pool: this.pool,
    });
    this.spawnStore(p, EntityKind.Bomb, s);
    this.publishStores();
    this.refreshHudCounts();
    this.notice(`${rl.loadout.bombs?.name ?? 'Bomb'} away`);
  }

  /**
   * Rockets go off in a ripple, not a volley: firing six motors at once from
   * one wing station is how you lose the wing, and the staggered launch is
   * also what gives the salvo its spread.
   */
  private fireRockets(s: EntityState): void {
    const rl = this.rl;
    if (!rl || !rl.rocket || this.rocketsLeft <= 0 || this.releaseCd > 0) return;

    // Fire a symmetric pair where there is one, so the asymmetric moment of a
    // single rail never has to be trimmed out.
    const pairs = rl.rocketMounts.length >= 2 && this.rocketsLeft >= 2 ? 2 : 1;
    this.bodyFrame(s);
    _vel.x = s.vx; _vel.y = s.vy; _vel.z = s.vz;

    for (let n = 0; n < pairs; n++) {
      const slot = this.nextSlot(1);
      if (!slot) break;
      slot.attached = false;
      this.rocketsLeft--;

      const mount = rl.rocketMounts[slot.index % rl.rocketMounts.length];
      qrot(_rot, v3(mount[0], mount[1], mount[2]), _mount);
      _origin.x = s.px + _mount.x; _origin.y = s.py + _mount.y; _origin.z = s.pz + _mount.z;

      const p = launchRocket({
        spec: rl.rocket,
        origin: _origin,
        // Straight off the rail along the nose: the rocket's own dispersion and
        // gravity drop are modelled by the shared launcher, and adding rail
        // droop on top of a sight that does not know about it would only make
        // the salvo harder to place.
        direction: _fwd,
        velocity: _vel,
        ownerId: s.ownerId,
        team: s.team,
        shooterEntity: s.id,
        time: this.ctx.time,
        rng: this.rng,
        pool: this.pool,
        tag: slot.index,
      });
      this.spawnStore(p, EntityKind.Rocket, s);
      // Deliberately no 'Gunfire' event: the UI treats one as a round leaving a
      // gun and would count a rocket against the cannon ammunition. The motor
      // flame and smoke are emitted by the presentation layer from the store's
      // own burn fraction instead.
    }

    this.releaseCd = RIPPLE;
    this.sinceRelease = 0;
    this.publishStores();
    this.refreshHudCounts();
  }

  private nextSlot(kind: 0 | 1): StoreSlot | null {
    // Highest station first, so a partially expended rack empties in a
    // repeatable order and the model always agrees with the count.
    for (let i = this.slots.length - 1; i >= 0; i--) {
      const sl = this.slots[i];
      if (sl.kind === kind && sl.attached) return sl;
    }
    return null;
  }

  /** Body axes of the aircraft into the module scratch vectors. */
  private bodyFrame(s: EntityState): void {
    _rot.x = s.qx; _rot.y = s.qy; _rot.z = s.qz; _rot.w = s.qw;
    qrot(_rot, FWD, _fwd);
    qrot(_rot, DOWN_BODY, _down);
  }

  private spawnStore(p: Projectile, kind: EntityKind, from: EntityState): void {
    p.id = this.nextId++;
    if (this.nextId > 63000) this.nextId = 60000;
    this.live.push(p);

    const st = newEntityState();
    st.id = p.id;
    st.kind = kind;
    st.ownerId = from.ownerId;
    st.team = from.team;
    // The renderer sizes the store from its type field, which carries the body
    // diameter in twentieths of a metre — the widest channel the 4-bit wire
    // field allows, and enough to tell a 5 in rocket from a 500 lb bomb.
    // 'calibre' is the diameter in millimetres (see ordnance.ts).
    st.typeId = clamp(Math.round(p.calibre / 50), 1, 15);
    st.health = 1;
    this.writeStoreState(p, st);
    this.states.set(p.id, st);
    this.ctx.entities.set(p.id, st);
  }

  // -------------------------------------------------------------------------
  // Flight of the stores
  // -------------------------------------------------------------------------

  private stepStores(dt: number): void {
    if (!this.live.length) return;
    const env = this.env;

    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];

      // The shared integrator: G1/bomb/rocket drag, motor thrust and burn-off,
      // gravity and wind. Substepped so a 400 m/s rocket cannot skip terrain.
      const speed = vlen(p.v);
      const n = clamp(Math.ceil((speed * dt) / 8), 1, 8);
      const h = dt / n;
      let done = false;
      for (let k = 0; k < n && !done; k++) {
        const y0 = p.p.y, x0 = p.p.x, z0 = p.p.z;
        advanceBallistic(p, this.combatEnv, h);

        const gh = env.terrainHeight(p.p.x, p.p.z);
        if (p.p.y <= gh) {
          // Interpolate to the surface so the crater is where the bomb met the
          // ground, not up to 8 m past it.
          const g0 = env.terrainHeight(x0, z0);
          const num = y0 - g0;
          const den = num - (p.p.y - gh);
          const a = clamp(den !== 0 ? num / den : 0, 0, 1);
          const hx = x0 + (p.p.x - x0) * a;
          const hz = z0 + (p.p.z - z0) * a;
          this.detonate(p, hx, env.terrainHeight(hx, hz), hz, gh <= 0.4);
          done = true;
          break;
        }

        if (this.hitAircraft(p, x0, y0, z0)) { done = true; break; }

        if (p.t >= p.maxTime) {
          // A dud: no fuse function, no bang. Just gone.
          this.retire(p);
          done = true;
          break;
        }
      }

      if (!p.alive) {
        this.live.splice(i, 1);
        continue;
      }
      const st = this.states.get(p.id);
      if (st) this.writeStoreState(p, st);
    }
  }

  /**
   * A rocket that flies into an aeroplane functions on it. Bombs get the same
   * test almost for free and it is not academic — a stick dropped through a
   * formation is a real thing that happened.
   */
  private hitAircraft(p: Projectile, x0: number, y0: number, z0: number): boolean {
    if (p.t < p.armTime) return false;
    for (const [id, e] of this.ctx.entities) {
      if (e.kind !== EntityKind.Aircraft) continue;
      if (id === p.shooterEntity || e.team === p.team || e.health <= 0) continue;
      if (!segmentSphere(x0, y0, z0, p.p.x, p.p.y, p.p.z, e.px, e.py, e.pz, 6.5)) continue;
      this.detonate(p, p.p.x, p.p.y, p.p.z, false);
      return true;
    }
    return false;
  }

  private writeStoreState(p: Projectile, st: EntityState): void {
    st.px = p.p.x; st.py = p.p.y; st.pz = p.p.z;
    st.vx = p.v.x; st.vy = p.v.y; st.vz = p.v.z;
    // Stores weathercock into the airflow, so the attitude is the velocity
    // direction. That is what makes a bomb's nose-down rotation through the
    // fall read correctly without simulating its pitch dynamics.
    const sp = vlen(p.v);
    if (sp > 1) {
      const dx = p.v.x / sp, dy = p.v.y / sp, dz = p.v.z / sp;
      quatFromForward(dx, dy, dz, st);
    }
    // Presentation channel: how much motor is left, for the flame and smoke.
    st.throttle = p.kind === ProjectileKind.Rocket && p.t < p.tracerTime
      ? 1 - p.t / Math.max(0.01, p.tracerTime)
      : 0;
    st.rpm = 0;
  }

  private retire(p: Projectile): void {
    p.alive = false;
    this.ctx.entities.delete(p.id);
    this.states.delete(p.id);
    this.pool.release(p);
  }

  // -------------------------------------------------------------------------
  // Detonation
  // -------------------------------------------------------------------------

  private detonate(p: Projectile, x: number, y: number, z: number, water: boolean): void {
    const he = p.heGrams;
    const casing = warheadCasing(p.mass0, he);
    const rVisual = visualBlastRadius(he);

    // Aircraft: the shared blast model, unchanged. It does the fragment cone,
    // the shielding and the module lookup — none of which belongs here.
    this.targetPool.length = 0;
    applyExplosion(this.combatEnv, {
      x, y, z,
      heGrams: he,
      casingKg: casing.casingKg,
      fragMass: casing.fragMass,
      fragVelocity: casing.fragVelocity,
      ownerId: p.ownerId,
      team: p.team,
      shooterEntity: p.shooterEntity,
      ammo: p.ammo,
      kind: p.kind,
      projectileId: p.id,
      time: this.ctx.time,
      maxTargets: 8,
    }, this.onBlastHit);

    if (!water) this.damageGround(x, y, z, he, p.shooterEntity);

    this.event(
      water ? EventKind.WaterImpact : EventKind.Explosion,
      x, y, z, 0, 1, 0,
      // The VFX and audio layers scale off this; a 250 kg bomb has to read as
      // an order of magnitude more than a cannon shell, and the cube root of
      // the charge is the honest way to say so.
      clamp(rVisual / 9, 1.6, 9),
      0, p.shooterEntity,
    );
    this.retire(p);
  }

  /**
   * Blast and fragments against the world's ground installations.
   *
   * This deliberately does *not* reuse 'blastDamage'. That curve is tuned for
   * aircraft: it falls as (1 − d/R)^1.6 inside a radius of 3.6·W^⅓, which is
   * the distance at which overpressure alone will wreck a stressed-skin
   * airframe — about 11 m for a 250 lb bomb. Ground targets are killed by a
   * completely different mechanism and over a completely different scale.
   * A lorry, a gun crew or a stack of ammunition is destroyed by fragments and
   * ground shock, and the RAF's own effectiveness tables put the radius at
   * which a 250 lb GP will disable soft-skinned transport at around 25–30 m
   * and a 250 kg SC at nearer 45 — roughly 9·W^⅓, three times the aircraft
   * figure. Applying the aeroplane curve to a truck makes bombing an exercise
   * in landing a direct hit, which is not what bombing was.
   *
   * So: an inverse-square-ish falloff over 9·W^⅓, with the same peak the shared
   * model derives from the filling, scaled up by the 1.6× that ground shock and
   * a reflecting surface add to a surface burst.
   */
  private damageGround(
    x: number, y: number, z: number, he: number, shooter: number,
  ): void {
    const world = this.worldSystem();
    if (!world) return;
    const kgTnt = Math.max(1e-3, he * 0.001);
    const rF = 9 * Math.cbrt(kgTnt);
    // Surface bursts couple roughly 1.6× the free-air overpressure into a
    // target standing on the same ground, because the reflected wave arrives
    // with the incident one.
    const peak = peakBlastDamage(he) * 1.6;

    for (const t of world.targets) {
      if (!t.alive) continue;
      // Bounding radius counts: a bomb 12 m from the centre of a 20 m factory
      // is a hit on the factory.
      const d = Math.max(0, Math.hypot(t.x - x, t.y - y, t.z - z) - t.radius * 0.6);
      if (d >= rF) continue;
      const dmg = peak * (1 - d / rF) ** 2;
      if (dmg <= 0) continue;

      t.hp -= dmg;
      if (t.hp <= 0) {
        t.hp = 0;
        t.alive = false;
        world.destroyTarget(t);
        // A secondary: fuel, ammunition or whatever the thing was carrying.
        this.event(EventKind.Explosion, t.x, t.y + 1.5, t.z, 0, 1, 0,
          clamp(2 + t.radius * 0.35, 2, 7), 0, shooter);
        this.ctx.bus.emit('net:kill', {
          t: 'kill',
          killer: 'You',
          victim: groundTargetName(t.kind),
          weapon: 'ordnance',
          killerTeam: this.ctx.localTeam,
          victimTeam: t.team,
        });
      } else {
        this.event(EventKind.GroundImpact, t.x, t.y + 1, t.z, 0, 1, 0, 1.4, 0, shooter);
      }
    }
  }

  /**
   * Blast hits on aircraft. The shared model produces a full 'HitResult'; the
   * client's damage bookkeeping is the simple health pool the sandbox uses, so
   * the damage is converted into it the same way gunfire is.
   */
  private onBlastHit = (h: HitResult): void => {
    if (!h.targetId || h.damage <= 0) return;
    this.ctx.bus.emit('game:ordnanceHit', {
      targetId: h.targetId,
      damage: h.damage,
      x: h.px, y: h.py, z: h.pz,
      shooter: h.shooterEntity,
    });
  };

  // -------------------------------------------------------------------------
  // Bombsight
  // -------------------------------------------------------------------------

  /**
   * Continuously computed impact point.
   *
   * It is the *actual integrator* run forward from the current release
   * conditions, not a vacuum parabola, so it accounts for drag, forward throw
   * and the terminal velocity a bomb reaches from height — which is the whole
   * reason a real bombsight and a real bomb ever agree. It costs a few hundred
   * integration steps, so it runs at 8 Hz rather than per frame.
   */
  private updateSight(dt: number, s: EntityState): void {
    const rl = this.rl;
    if (!rl || !rl.bomb || this.bombsLeft <= 0) { this.hud.hasSolution = false; return; }

    this.sightAcc += dt;
    if (this.sightAcc < SIGHT_PERIOD && this.hud.hasSolution) return;
    this.sightAcc = 0;

    _origin.x = s.px; _origin.y = s.py; _origin.z = s.pz;
    _vel.x = s.vx; _vel.y = s.vy; _vel.z = s.vz;
    const t = predictBombImpact(rl.bomb, _origin, _vel, this.combatEnv, _impact, 45);

    this.hud.hasSolution = t < 45;
    this.hud.ix = _impact.x; this.hud.iy = _impact.y; this.hud.iz = _impact.z;
    this.hud.fallTime = t;
    this.hud.range = Math.hypot(_impact.x - s.px, _impact.y - s.py, _impact.z - s.pz);

    // Safe-escape check: the fuse arms in 0.6 s and functions on impact, so the
    // danger is not the arming delay but flying through your own fragments.
    const he = rl.bomb.kg * rl.bomb.fillFraction * 1000;
    const agl = s.py - this.env.terrainHeight(s.px, s.pz);
    this.hud.tooLow = agl < visualBlastRadius(he) * 0.55
      && vlen(_vel) * t < visualBlastRadius(he);
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private queryTargets(p0: V3, p1: V3, pad: number, out: CombatTarget[]): void {
    const ctx = this.ctx;
    let n = 0;
    for (const [id, e] of ctx.entities) {
      if (e.kind !== EntityKind.Aircraft || e.health <= 0) continue;
      // Cheap segment-sphere reject before building a target record.
      if (!segmentSphere(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, e.px, e.py, e.pz, pad + 14)) continue;
      const spec = specForType(e.typeId);
      let t = this.targetPool[n];
      if (!t) {
        t = {
          id, team: e.team, ownerId: e.ownerId, alive: true,
          proxy: buildAircraftProxy(spec),
          p: v3(), q: q(), v: v3(),
        };
        this.targetPool[n] = t;
      }
      t.id = id; t.team = e.team; t.ownerId = e.ownerId; t.alive = true;
      t.proxy = buildAircraftProxy(spec);
      t.p.x = e.px; t.p.y = e.py; t.p.z = e.pz;
      t.q.x = e.qx; t.q.y = e.qy; t.q.z = e.qz; t.q.w = e.qw;
      t.v.x = e.vx; t.v.y = e.vy; t.v.z = e.vz;
      out.push(t);
      n++;
      if (n >= 12) break;
    }
  }

  /**
   * The world subsystem, resolved once and structurally: this module must not
   * depend on 'src/world' (it is another owner's, and 'src/game' is loaded in
   * environments where the renderer is not), so all it asks for is something
   * with a target list and a way to kill one.
   */
  private worldSystem(): WorldLike | null {
    if (!this.worldResolved) {
      this.worldResolved = true;
      const w = this.ctx.get('world') as unknown as Partial<WorldLike> | undefined;
      this.world = w && typeof w.destroyTarget === 'function' && w.targets
        ? (w as WorldLike)
        : null;
    }
    return this.world;
  }

  /**
   * Mirrors the replicated GroundUnit health onto the local world's targets.
   *
   * The server sites its ground units from the same shared pass the renderer
   * does ('src/world/groundSites.ts'), so they are the same objects in the same
   * places and matching them by position is exact rather than approximate. Once
   * a unit's entity disappears the server has destroyed it, so the local model
   * comes off the map too — which is what makes a convoy another player bombed
   * actually stop existing on your screen.
   */
  private syncGroundUnits(): void {
    const world = this.worldSystem();
    if (!world) return;
    const seen = _seen;
    seen.clear();

    for (const [id, e] of this.ctx.entities) {
      if (e.kind !== EntityKind.GroundUnit) continue;
      seen.add(id);
      let t = this.unitTargets.get(id);
      if (!t) {
        const found = nearestTarget(world.targets, e.px, e.pz);
        if (!found) continue;
        t = found;
        this.unitTargets.set(id, t);
      }
      t.hp = Math.max(0, e.health * t.maxHp);
    }

    for (const [id, t] of this.unitTargets) {
      if (seen.has(id)) continue;
      this.unitTargets.delete(id);
      if (!t.alive) continue;
      t.hp = 0;
      t.alive = false;
      world.destroyTarget(t);
    }
  }

  /** Ground installations, for the HUD and for the harness. */
  get groundTargets(): readonly GroundTargetLike[] {
    return this.worldSystem()?.targets ?? EMPTY;
  }

  /** Tells the presentation layer which stores are still on the aeroplane. */
  private publishStores(): void {
    if (!this.rl) return;
    const bomb: number[] = [];
    const rocket: number[] = [];
    for (const sl of this.slots) {
      if (!sl.attached) continue;
      (sl.kind === 0 ? bomb : rocket).push(sl.index);
    }
    // Always the *current* local entity: 'setLoadout' runs on the spawn event,
    // by which point the id has already been swapped, and publishing to the
    // aeroplane that was just destroyed would dress a corpse.
    this.ctx.bus.emit('game:stores', {
      entityId: this.ctx.localEntityId,
      loadout: this.rl.loadout.id,
      bomb, rocket,
    });
  }

  private refreshHudCounts(): void {
    const l = this.rl?.loadout;
    const h = this.hud;
    h.name = l && l.id !== 'clean' ? l.name : '';
    h.short = l && l.id !== 'clean' ? l.short : '';
    h.bombName = l?.bombs?.name ?? '';
    h.bombs = this.bombsLeft;
    h.bombsMax = l?.bombs?.count ?? 0;
    h.rocketName = l?.rockets?.name ?? '';
    h.rockets = this.rocketsLeft;
    h.rocketsMax = l?.rockets?.count ?? 0;
  }

  private notice(text: string): void {
    this.ctx.bus.emit('ui:notice', { key: 'stores', text, kind: '', life: 1.6 });
  }

  private event(
    kind: EventKind, x: number, y: number, z: number,
    nx: number, ny: number, nz: number, scale: number, a: number, b: number,
  ): void {
    this.ctx.bus.emit('game:event', { kind, x, y, z, nx, ny, nz, scale, a, b });
  }

  dispose(): void {
    for (const p of this.live) this.ctx.entities.delete(p.id);
    this.live.length = 0;
    this.states.clear();
  }
}

// ---------------------------------------------------------------------------

const EMPTY: readonly GroundTargetLike[] = [];
const _seen = new Set<number>();

/**
 * The local model standing where a replicated ground unit stands. Both come out
 * of the same siting pass, so the match is a metre or two at worst; anything
 * further away is a different object and is deliberately not matched.
 */
function nearestTarget(
  targets: readonly GroundTargetLike[], x: number, z: number,
): GroundTargetLike | null {
  let best: GroundTargetLike | null = null;
  let bestD = 12 * 12;
  for (const t of targets) {
    const dx = t.x - x, dz = t.z - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

function groundTargetName(kind: string): string {
  switch (kind) {
    case 'aa': return 'AA emplacement';
    case 'truck': return 'Transport';
    case 'bridge': return 'Bridge';
    case 'factory': return 'Factory';
    case 'railyard': return 'Rail yard';
    default: return 'Ground target';
  }
}

function specForType(typeId: number): AircraftSpec {
  return AIRCRAFT[clamp(typeId, 0, AIRCRAFT.length - 1) | 0] ?? AIRCRAFT[0];
}

/**
 * Minimal-rotation quaternion taking body +Z onto a unit direction, written
 * straight into an entity record. Roll is arbitrary for a body of revolution.
 */
function quatFromForward(
  dx: number, dy: number, dz: number,
  out: { qx: number; qy: number; qz: number; qw: number },
): void {
  // q = (axis = z × d, w = 1 + z · d), normalised.
  const dot = dz;
  if (dot < -0.999999) { out.qx = 1; out.qy = 0; out.qz = 0; out.qw = 0; return; }
  const ax = -dy, ay = dx, az = 0;
  const w = 1 + dot;
  const inv = 1 / Math.sqrt(ax * ax + ay * ay + az * az + w * w);
  out.qx = ax * inv; out.qy = ay * inv; out.qz = az * inv; out.qw = w * inv;
}

/** Closest approach of segment AB to a sphere at C with radius r. */
function segmentSphere(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number, r: number,
): boolean {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const fx = ax - cx, fy = ay - cy, fz = az - cz;
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-9) return fx * fx + fy * fy + fz * fz <= r * r;
  let t = -(fx * dx + fy * dy + fz * dz) / a;
  t = clamp(t, 0, 1);
  const px = fx + dx * t, py = fy + dy * t, pz = fz + dz * t;
  return px * px + py * py + pz * pz <= r * r;
}
