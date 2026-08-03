import * as THREE from 'three';
import type { AircraftSpec } from '../shared/aircraft';
import { DamageBits, type EntityState } from '../shared/protocol';
import { clamp, smoothstep } from '../shared/math';
import type { AircraftModel } from './externals';
import type { BillboardField } from './visual/Particles';
import { SMOKE_PRESETS, FIRE_PRESETS } from './visual/Particles';
import type { DebrisField } from './visual/Debris';
import type { BulletHoleField } from './visual/Decals';

/**
 * One aircraft on screen: the rig, its animation state, and everything the
 * damage model does to it.
 *
 * ## Rig conventions — read 'src/assets/aircraft/build.ts' before changing these
 *
 * The procedural builder hinges **every** moving part through a pivot whose
 * local +X *is* the hinge axis (see 'geom.ts makeHinge'), so every surface,
 * every gear leg, every gear door and every wheel is driven by 'rotation.x' in
 * its own frame. There is no part anywhere in the rig that rotates about y or
 * z except the propeller group, which spins about the thrust line (+Z).
 * Writing 'rudder.rotation.y' tilts the fin about a chordwise axis instead of
 * deflecting it; writing 'gearL.rotation.z' swings the leg sideways through
 * the wing. Both were doing exactly that.
 *
 * Retraction and door angles are *not* 90°: the builder stores the real values
 * per leg in 'userData.upAngle' and per door in 'userData.closedAngle', because
 * a Spitfire's mains rotate outboard through about 87° while its tailwheel
 * swings aft through far less. Read them; never hard-code π/2.
 *
 * Ailerons use *mirrored outboard* hinge axes, so the SAME signed rotation
 * raises the starboard trailing edge and lowers the port one. Applying opposite
 * signs — the obvious thing to do — deflects both surfaces the same way and
 * produces a flap deflection with no visible roll input at all. The 3:2 up/down
 * differential real fighters used is therefore encoded as a per-side
 * *magnitude*, never as a sign flip.
 *
 * Finally, every one of these parts exists three times over — once per LOD
 * level — and 'model.parts' maps a part name to all of them. Driving only the
 * LOD0 reference freezes every surface and resurrects every shot-off panel the
 * instant the aircraft crosses a LOD threshold, which at 260 m happens
 * constantly in a furball.
 *
 * ## Travel limits
 *
 * Real WWII fighters used roughly ±20–25° of aileron with 3:2 differential
 * (up-going more than down-going, to fight adverse yaw), ±25–30° of elevator
 * and ±25–30° of rudder. Flaps ran to 55–85° for landing — the Spitfire's
 * split flaps went to the top of that range, which is why the limit is read
 * off the spec rather than fixed.
 */

const AIL_UP = 22 * (Math.PI / 180);
const AIL_DOWN = 15 * (Math.PI / 180);
const ELEV_UP = 27 * (Math.PI / 180);
const ELEV_DOWN = 22 * (Math.PI / 180);
const RUDDER_MAX = 26 * (Math.PI / 180);
/** Split-flap travel: 85° on an elliptical (Spitfire) wing, 45° otherwise. */
const FLAP_MAX_ELLIPTICAL = 85 * (Math.PI / 180);
const FLAP_MAX = 45 * (Math.PI / 180);

/** Hydraulic travel times, seconds. */
const GEAR_TIME = 8.0;
const DOOR_TIME = 1.3;
const FLAP_TIME = 3.5;

/** Surface actuator bandwidth, rad/s of command per second. */
const SURFACE_RATE = 5.5;

/** Propeller cross-fade thresholds, rpm. */
const DISC_IN = 380;
const DISC_FULL = 780;
const BLADE_OUT = 760;

export interface ViewFx {
  smoke: BillboardField;
  fire: BillboardField;
  debris: DebrisField;
  holes: BulletHoleField;
}

/** How much detail this frame's distance justifies. */
export const enum DetailTier {
  Full = 0,     // surfaces, gear, prop, pilot, wheels
  Medium = 1,   // surfaces, gear, prop
  Coarse = 2,   // prop disc + gear only
  None = 3,     // transform only
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _omegaWorld = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Names of the parts that carry real geometry and can therefore be shot off.
 * 'wingtipL/R' are deliberately absent: the builder creates them as bare,
 * position-only 'Object3D' anchors so VFX can find the tip, and detaching one
 * throws an invisible empty into the debris field while the wing stays whole.
 */
type ShedName =
  | 'wingOuterL' | 'wingOuterR' | 'aileronL' | 'aileronR' | 'flapL' | 'flapR'
  | 'elevatorL' | 'elevatorR' | 'tailplaneL' | 'tailplaneR' | 'rudder' | 'fin'
  | 'canopyGlass' | 'spinner' | 'propBlades' | 'gearDoorL' | 'gearDoorR';

/** Parts whose rest pose has to be restored when a pooled rig is recycled. */
/** Shared empty list so stripping stores allocates nothing. */
const EMPTY_STORES: readonly number[] = [];

const POSED_PARTS = [
  'aileronLPivot', 'aileronRPivot', 'elevatorLPivot', 'elevatorRPivot',
  'rudderPivot', 'flapLPivot', 'flapRPivot',
  'gearL', 'gearR', 'gearTail', 'gearDoorLPivot', 'gearDoorRPivot',
  'wheelL', 'wheelR', 'wheelTail', 'propeller', 'pilot',
] as const;

/** Everything that can be hidden or detached, so a recycled rig comes back whole. */
const RESTORED_PARTS = [
  'wingOuterL', 'wingOuterR', 'aileronL', 'aileronR', 'flapL', 'flapR',
  'elevatorL', 'elevatorR', 'tailplaneL', 'tailplaneR', 'rudder', 'fin',
  'canopyGlass', 'canopy', 'spinner', 'propBlades', 'propeller',
  'gearDoorL', 'gearDoorR', 'pilot',
] as const;

export class AircraftView {
  readonly holder = new THREE.Group();
  readonly spec: AircraftSpec;
  readonly model: AircraftModel;
  readonly typeId: number;
  /** Stable id used to key decals; equals the entity id while alive. */
  viewId = 0;
  entityId = 0;
  team = 0;

  /** Lagged surface commands. */
  private sPitch = 0;
  private sRoll = 0;
  private sYaw = 0;
  private gearVis = 1;
  private doorVis = 1;
  private flapVis = 0;
  private propAngle = 0;
  private wheelAngle = 0;
  private wheelSpin = 0;

  private prevDamage = 0;
  private actuatorsPrimed = false;
  private detached = new Set<string>();
  private slump = 0;
  private canopyGone = false;

  /** Fractional particle accumulators, so emission is frame-rate independent. */
  private accSmoke = 0;
  private accFire = 0;
  private accOil = 0;

  /**
   * Set by the entity system when 'src/vfx' is live. The VFX subsystem's
   * DamageFx already runs a staged coolant → oil → fuel → fire plume off
   * 'ctx.entities'; running ours as well gave every damaged aircraft two
   * overlapping trails at double the particle cost. Ours is kept only as the
   * fallback for when the VFX subsystem failed to boot.
   */
  damagePlumeOwnedByVfx = false;

  /** Last frame's world position, for velocity-derived effects. */
  private lastPos = new THREE.Vector3();
  private worldVel = new THREE.Vector3();
  private omega = new THREE.Vector3();
  private prevQuat = new THREE.Quaternion();
  private inited = false;

  tier: DetailTier = DetailTier.Full;
  distance = 0;
  onGround = false;

  /**
   * Every object sharing a part name, across all three LOD levels. Resolved
   * once at construction so the per-frame path is a map lookup and a loop over
   * (typically) three references rather than a scene-graph walk.
   */
  private partsOf: Map<string, THREE.Object3D[]>;
  /** Per-view propeller-disc materials — see 'cloneDiscMaterials'. */
  private discMats: THREE.Material[] = [];
  /**
   * One entry per LOD level, not one per view. Keeping a single reference here
   * meant only whichever level was cloned last ever had its opacity written,
   * and since that is LOD2 the disc on the aeroplane you are actually looking
   * at stayed at zero — an invisible propeller at full power.
   */
  private discUniforms: THREE.IUniform[] = [];
  private discPhases: THREE.IUniform[] = [];
  private engineAnchor: THREE.Object3D;
  private flapMax: number;

  constructor(spec: AircraftSpec, typeId: number, model: AircraftModel) {
    this.spec = spec;
    this.typeId = typeId;
    this.model = model;
    this.holder.name = `view_${spec.id}`;
    this.holder.add(model.root as THREE.Object3D);

    this.partsOf = resolveParts(model);
    this.flapMax = spec.geom.ellipticalWing ? FLAP_MAX_ELLIPTICAL : FLAP_MAX;
    this.cloneDiscMaterials();

    this.engineAnchor = (model.spinner ?? model.propeller ?? model.root) as THREE.Object3D;
  }

  // -------------------------------------------------------------------------
  // Part access
  // -------------------------------------------------------------------------

  /**
   * Applies 'fn' to every LOD level's copy of a part. This is the only way the
   * rig should ever be touched: 'THREE.LOD.update()' is called by the renderer
   * itself, so a surface driven at LOD0 alone freezes mid-deflection the moment
   * the aircraft crosses 260 m and stays frozen until it comes back.
   */
  private applyAll(part: string, fn: (o: THREE.Object3D) => void): void {
    const list = this.partsOf.get(part);
    if (!list) return;
    for (let i = 0; i < list.length; i++) fn(list[i]);
  }

  private firstOf(part: string): THREE.Object3D | undefined {
    return this.partsOf.get(part)?.[0];
  }

  /**
   * Per-view propeller-disc material.
   *
   * The builder creates one disc material per aircraft *type* and every clone
   * of that type references it, so writing opacity through it made all four
   * Bf 109s in a furball render at whichever value the last-updated view
   * happened to write — a parked aircraft's disc as solid as one at full power.
   * Materials are a few hundred bytes; geometry is what must stay shared.
   */
  private cloneDiscMaterials(): void {
    this.applyAll('propDisc', (o) => {
      const m = o as THREE.Mesh;
      const src = m.material as THREE.Material | THREE.Material[] | undefined;
      if (!src || Array.isArray(src)) return;
      const copy = src.clone();
      // 'Material.copy' does not carry 'onBeforeCompile' or the cache key, so a
      // naive clone of a cel material silently reverts to stock MeshToon — no
      // aerial perspective, no shadow tint, and a second compiled program.
      // Both hooks are closures over the source material's own uniforms, which
      // are constant for the whole type, so sharing them is correct; only
      // 'opacity' is per-view and that lives on the material itself.
      copy.onBeforeCompile = src.onBeforeCompile;
      copy.customProgramCacheKey = src.customProgramCacheKey;
      const cel = (src as THREE.Material & { celUniforms?: Record<string, THREE.IUniform> }).celUniforms;
      if (cel) (copy as THREE.Material & { celUniforms?: Record<string, THREE.IUniform> }).celUniforms = cel;
      copy.transparent = true;
      m.material = copy;
      this.discMats.push(copy);
      const u = (copy as THREE.Material & { uniforms?: Record<string, THREE.IUniform> }).uniforms;
      const srcU = (src as THREE.Material & { uniforms?: Record<string, THREE.IUniform> }).uniforms;
      // 'ShaderMaterial.clone' deep-copies its uniforms, which severs the link
      // to the shared sky/sun state the disc shader reads — the clone would
      // then be lit by whatever the sun was doing at *build* time, which in a
      // sunset framing is a different sun entirely. The material publishes the
      // names that must stay shared; re-point those uniform objects by
      // reference and leave the per-view ones (opacity, phase) copied.
      const shared = copy.userData.sharedUniformNames as string[] | undefined;
      if (u && srcU && Array.isArray(shared)) {
        for (const n of shared) if (srcU[n]) u[n] = srcU[n];
      }
      if (u?.uOpacity) this.discUniforms.push(u.uOpacity);
      if (u?.uPhase) this.discPhases.push(u.uPhase);
    });
  }

  /** Resets every animated and damage-related field for a fresh spawn. */
  reset(entityId: number, team: number): void {
    this.entityId = entityId;
    this.viewId = entityId;
    this.team = team;
    this.sPitch = this.sRoll = this.sYaw = 0;
    this.gearVis = 1; this.doorVis = 1; this.flapVis = 0;
    // The first animate() snaps the actuators to whatever the server says
    // rather than animating from a guessed position — otherwise an aircraft
    // that spawns airborne plays an eight-second gear retraction on arrival.
    this.actuatorsPrimed = false;
    this.propAngle = 0; this.wheelAngle = 0; this.wheelSpin = 0;
    this.prevDamage = 0;
    this.detached.clear();
    this.slump = 0;
    this.canopyGone = false;
    this.accSmoke = this.accFire = this.accOil = 0;
    this.inited = false;
    this.holder.visible = true;
    this.holder.scale.setScalar(1);

    // These rigs are pooled: a recycled airframe that keeps the previous
    // occupant's missing outer wing panel is the classic pooling bug, and it
    // has to be undone at every LOD level, not just the one that was drawn.
    for (const p of POSED_PARTS) {
      this.applyAll(p, (o) => { o.rotation.set(0, 0, 0); o.scale.setScalar(1); o.visible = true; });
    }
    for (const p of RESTORED_PARTS) {
      this.applyAll(p, (o) => { o.visible = true; o.scale.setScalar(1); });
    }
    this.applyAll('propDisc', (o) => { o.visible = false; });
    // A pooled airframe must not inherit the last occupant's bomb load.
    this.setStores('clean', EMPTY_STORES, EMPTY_STORES);
    this.applyAll('pilot', (o) => {
      const baseY = o.userData.baseY as number | undefined;
      if (baseY !== undefined) o.position.setY(baseY);
    });
  }

  /**
   * Hangs (or strips) external stores.
   *
   * The mesh builder owns the part-naming convention and binds a closure per
   * instance, so this only has to find it. Models that predate the loadout
   * work — and the stand-in airframe — simply have no such function, and an
   * aeroplane without visible bombs is a far better failure than a crash in
   * the render loop.
   */
  setStores(loadoutId: string, bombs: readonly number[], rockets: readonly number[]): void {
    const fn = (this.model as {
      setStores?: (id: string, b: readonly number[], r: readonly number[]) => void;
    }).setStores;
    if (typeof fn !== 'function') return;
    try { fn.call(this.model, loadoutId, bombs, rockets); } catch { /* stand-in rig */ }
  }

  /** World transform + kinematics. Always runs, at every distance. */
  applyTransform(s: EntityState, dt: number): void {
    this.holder.position.set(s.px, s.py, s.pz);
    _q.set(s.qx, s.qy, s.qz, s.qw);
    if (!this.inited) {
      this.holder.quaternion.copy(_q);
      this.lastPos.set(s.px, s.py, s.pz);
      this.prevQuat.copy(_q);
      this.inited = true;
    } else {
      this.holder.quaternion.copy(_q);
    }

    this.worldVel.set(s.vx, s.vy, s.vz);

    // Angular velocity from the quaternion delta — needed so shot-off parts
    // inherit the right tangential throw. Cheaper and more robust than asking
    // the flight model, which remote aircraft do not have.
    if (dt > 1e-4) {
      _qDelta.copy(this.prevQuat).invert().premultiply(_q);
      if (_qDelta.w < 0) { _qDelta.x = -_qDelta.x; _qDelta.y = -_qDelta.y; _qDelta.z = -_qDelta.z; _qDelta.w = -_qDelta.w; }
      const sinHalf = Math.hypot(_qDelta.x, _qDelta.y, _qDelta.z);
      if (sinHalf > 1e-6) {
        const angle = 2 * Math.atan2(sinHalf, _qDelta.w);
        const k = angle / (sinHalf * dt);
        this.omega.set(_qDelta.x * k, _qDelta.y * k, _qDelta.z * k);
      } else {
        this.omega.multiplyScalar(Math.exp(-dt * 8));
      }
    }
    this.prevQuat.copy(_q);
    this.lastPos.set(s.px, s.py, s.pz);
  }

  /**
   * Animates the rig. Skipped entirely for 'DetailTier.None', and progressively
   * trimmed above that — at 3 km a moving aileron is a sub-pixel change and
   * costs the same matrix update as a close one.
   */
  animate(s: EntityState, dt: number, time: number, groundClearance: number): void {
    const tier = this.tier;
    if (tier >= DetailTier.None) return;

    const dmgFlags = s.damage;
    const severed = (dmgFlags & DamageBits.ControlsSevered) !== 0;
    const cmdPitch = severed ? this.sPitch * 0.98 : s.ctlPitch;
    const cmdRoll = severed ? this.sRoll * 0.98 : s.ctlRoll;
    const cmdYaw = severed ? this.sYaw * 0.98 : s.ctlYaw;

    // Actuator lag: surfaces have mass and the pilot has muscles. A first-order
    // follower at ~5.5 s⁻¹ gives the ~0.2 s snap of a manual control run.
    const k = 1 - Math.exp(-SURFACE_RATE * dt);
    this.sPitch += (cmdPitch - this.sPitch) * k;
    this.sRoll += (cmdRoll - this.sRoll) * k;
    this.sYaw += (cmdYaw - this.sYaw) * k;

    // --- ailerons, with up/down differential -------------------------------
    // Same SIGN both sides — the pivots are mirrored, so that is what produces
    // roll. The 3:2 differential lives in the magnitude: whichever surface is
    // going up travels further than the one going down.
    const r = clamp(this.sRoll, -1, 1);
    const aR = r > 0 ? r * AIL_UP : r * AIL_DOWN;
    const aL = r > 0 ? r * AIL_DOWN : r * AIL_UP;
    if (!this.detached.has('aileronR')) this.applyAll('aileronRPivot', (o) => { o.rotation.x = aR; });
    if (!this.detached.has('aileronL')) this.applyAll('aileronLPivot', (o) => { o.rotation.x = aL; });

    // --- elevator ----------------------------------------------------------
    // Common hinge axis, so both halves take the same rotation.
    // ctlPitch > 0 is stick back = nose up = trailing edge up = +rotation.x.
    const p = clamp(this.sPitch, -1, 1);
    const eAng = p > 0 ? p * ELEV_UP : p * ELEV_DOWN;
    if (!this.detached.has('elevatorL')) this.applyAll('elevatorLPivot', (o) => { o.rotation.x = eAng; });
    if (!this.detached.has('elevatorR')) this.applyAll('elevatorRPivot', (o) => { o.rotation.x = eAng; });

    // --- rudder ------------------------------------------------------------
    if (!this.detached.has('rudder')) {
      const yAng = clamp(this.sYaw, -1, 1) * RUDDER_MAX;
      this.applyAll('rudderPivot', (o) => { o.rotation.x = yAng; });
    }

    // --- gear + door sequencing (also primes the actuators on first frame) ---
    this.animateGear(s, dt);

    // --- flaps: rate-limited to their real deployment time ------------------
    this.flapVis += clamp(s.flaps - this.flapVis, -dt / FLAP_TIME, dt / FLAP_TIME);
    const flapAng = -this.flapVis * this.flapMax;
    this.applyAll('flapLPivot', (o) => { o.rotation.x = flapAng; });
    this.applyAll('flapRPivot', (o) => { o.rotation.x = flapAng; });

    // --- propeller ----------------------------------------------------------
    this.animateProp(s, dt);

    // --- wheels -------------------------------------------------------------
    if (tier <= DetailTier.Full && this.gearVis > 0.5) {
      const contact = groundClearance < 0.9;
      this.onGround = contact;
      if (contact) {
        // Rolling without slip: ω = v / r, with a 0.32 m wheel.
        this.wheelSpin = Math.hypot(s.vx, s.vz) / 0.32;
      } else {
        // After lift-off the wheels keep turning and spin down over ~8 s.
        this.wheelSpin *= Math.exp(-dt / 2.6);
      }
      // Wrapped: a wheel left spinning for a long taxi otherwise reaches tens
      // of thousands of radians, where float32 quantises the rotation into
      // visible steps.
      this.wheelAngle = (this.wheelAngle + this.wheelSpin * dt) % (Math.PI * 2);
      // The wheel *pivot* spins about its own X. Its 'wheelLMesh' child must be
      // left alone — a '/wheel/i' traverse matches both and doubles the rate.
      const wa = this.wheelAngle;
      this.applyAll('wheelL', (o) => { o.rotation.x = wa; });
      this.applyAll('wheelR', (o) => { o.rotation.x = wa; });
      // The tailwheel is roughly 2.6× smaller, so it turns that much faster.
      this.applyAll('wheelTail', (o) => { o.rotation.x = wa * 2.6; });
    }

    // --- instruments --------------------------------------------------------
    // Only worth doing when someone can actually read them: from the cockpit,
    // or from an external camera close enough to see through the glass.
    if (tier <= DetailTier.Full && this.distance < 90) this.updateInstruments(s, time);

    // --- pilot --------------------------------------------------------------
    if (tier <= DetailTier.Full) {
      const pilot = this.firstOf('pilot');
      if (pilot) {
        const dead = (dmgFlags & (DamageBits.PilotDead | DamageBits.Destroyed)) !== 0;
        const hit = (dmgFlags & DamageBits.PilotHit) !== 0;
        const target = dead ? 1 : hit ? 0.35 : 0;
        this.slump += (target - this.slump) * Math.min(1, dt * (dead ? 2.2 : 1.2));
        if (this.slump > 0.001) {
          const sl = this.slump;
          this.applyAll('pilot', (o) => {
            if (o.userData.baseY === undefined) o.userData.baseY = o.position.y;
            // Head and shoulders fall forward and to the left against the harness.
            o.rotation.x = sl * 0.62;
            o.rotation.z = sl * 0.30;
            o.position.y = (o.userData.baseY as number) - sl * 0.16;
          });
        }
        // Living pilots track the horizon a little — the eye picks this up even
        // at a few hundred metres and it stops the cockpit reading as a dummy.
        if (!dead && !hit && tier === DetailTier.Full) {
          const yaw = Math.sin(time * 0.4 + this.entityId) * 0.12;
          this.applyAll('pilot', (o) => { o.rotation.y = yaw; });
        }
      }
    }
  }

  /**
   * Drives the cockpit instruments.
   *
   * The rig publishes each needle's value→angle mapping on its pivot
   * ('userData.gauge'), painted from the same table the dial faces were drawn
   * from, so a hand can never point somewhere its own ticks disagree with. All
   * this side has to do is produce the numbers, which is why there is no import
   * of the asset module here — the aircraft builder is resolved lazily and may
   * not exist at all.
   *
   * Everything is derived from replicated state, so a wingman's panel is as
   * alive as the player's when you slide up alongside and look in.
   */
  private updateInstruments(s: EntityState, time: number): void {
    const spec = this.spec;
    // Indicated airspeed: what the pitot reads, which falls off with density,
    // not the true speed over the ground. Otherwise a dive from 8 km shows an
    // ASI reading no pilot of the period would ever have seen.
    const tas = Math.hypot(s.vx, s.vy, s.vz);
    const density = Math.exp(-Math.max(0, s.py) / 8500);
    this.setNeedle('airspeed', tas * Math.sqrt(density) * 3.6);
    this.setNeedle('altimeter', s.py);
    this.setNeedle('altimeter', s.py, true);
    this.setNeedle('vsi', s.vy);
    // Heading off the drawn attitude: +Z is the nose, and the compass card
    // counts clockwise from north.
    this.holder.getWorldDirection(_fwd);
    let hdg = Math.atan2(_fwd.x, _fwd.z);
    if (hdg < 0) hdg += Math.PI * 2;
    this.setNeedle('compass', hdg);

    const rpm = clamp(s.rpm, 0, 1) * spec.engine.maxRpm;
    this.setNeedle('rpm', rpm);
    // Manifold pressure tracks throttle and falls with altitude once the
    // supercharger runs out of rated altitude.
    const thr = clamp(s.throttle, 0, 1);
    this.setNeedle('boost', -8 + thr * 24 * (0.55 + 0.45 * density));
    // Engine temperatures lag; a damaged or burning engine runs away.
    const hurt = (s.damage & (DamageBits.Engine | DamageBits.EngineFire)) !== 0;
    this.setNeedle('oiltemp', (hurt ? 108 : 62) + thr * 22 + Math.sin(time * 0.21 + this.entityId) * 3);
    this.setNeedle('oilpress', (hurt ? 26 : 78) - thr * 6 + Math.sin(time * 0.9) * 2);
    this.setNeedle('fuel', clamp(0.15 + s.health * 0.7, 0, 1));
    this.setNeedle('ammo', clamp(s.health, 0, 1));
    this.setNeedle('radiator', 0.35 + thr * 0.5);
    // The clock is the one instrument that is right without any state at all.
    this.setNeedle('clock', (time / 3600) % 12);
  }

  private setNeedle(name: string, value: number, fast = false): void {
    const list = this.partsOf.get(`needle_${fast ? 'fast_' : ''}${name}`);
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      const g = o.userData.gauge as
        { a0: number; a1: number; v0: number; v1: number; wrap?: boolean } | undefined;
      if (!g) continue;
      let f = (value - g.v0) / (g.v1 - g.v0);
      if (g.wrap) f -= Math.floor(f); else f = clamp(f, 0, 1);
      // The pivot's +Z is the aircraft's nose, pointing away from the pilot,
      // and the body frame is left-handed on screen — so a positive rotation
      // about it is clockwise as the pilot reads the dial, which is the sense
      // the painted sweep was authored in.
      o.rotation.z = g.a0 + (g.a1 - g.a0) * f;
    }
  }

  private animateGear(s: EntityState, dt: number): void {
    const target = clamp(s.gear, 0, 1);
    if (!this.actuatorsPrimed) {
      this.actuatorsPrimed = true;
      this.gearVis = target;
      this.flapVis = clamp(s.flaps, 0, 1);
      // Doors sit open with the gear down and closed with it up — snapping them
      // to the wrong end of that on spawn is what left every parked aircraft
      // with its bay doors hanging open.
      this.doorVis = target;
    }
    const moving = Math.abs(target - this.gearVis) > 0.005;

    // Doors lead the legs out and trail them in: they are open for the whole
    // transit and stay open while the gear is down, which is how a leg-mounted
    // fairing on these types actually behaves.
    const doorTarget = moving ? 1 : Math.max(target, 0);
    this.doorVis += clamp(doorTarget - this.doorVis, -dt / DOOR_TIME, dt / DOOR_TIME);

    // The legs cannot move until the bay is open.
    const gate = smoothstep(0.55, 0.9, this.doorVis);
    const rate = (dt / GEAR_TIME) * gate;
    this.gearVis += clamp(target - this.gearVis, -rate, rate);

    // Retraction is about the leg's own hinge axis, through the angle the gear
    // builder measured for this airframe — reading 'upAngle' is what keeps a
    // Spitfire's mains folding outboard into the wing instead of pivoting a
    // hard 90° through it.
    const up = 1 - this.gearVis;
    const broken = (s.damage & DamageBits.GearBroken) !== 0;
    for (const leg of ['gearL', 'gearR', 'gearTail'] as const) {
      this.applyAll(leg, (o) => {
        const upAngle = (o.userData.upAngle as number | undefined) ?? Math.PI / 2;
        o.rotation.x = upAngle * up;
      });
    }
    // A broken right leg hangs half-extended and skewed.
    if (broken) {
      this.applyAll('gearR', (o) => {
        const upAngle = (o.userData.upAngle as number | undefined) ?? Math.PI / 2;
        o.rotation.x = upAngle * 0.42;
        o.rotation.z = 0.28;
      });
    }

    const doorOpen = this.doorVis;
    for (const door of ['gearDoorLPivot', 'gearDoorRPivot'] as const) {
      this.applyAll(door, (o) => {
        const closed = (o.userData.closedAngle as number | undefined) ?? 0;
        o.rotation.x = closed * (1 - doorOpen);
      });
    }
  }

  private animateProp(s: EntityState, dt: number): void {
    const eng = this.spec.engine;
    // 'EntityState.rpm' is normalised *engine* speed. The propeller turns
    // through a reduction gear — about 0.50 on an inline, 0.60 on a radial —
    // because a blade tip at crankshaft speed would go supersonic and lose all
    // its thrust. That gearing is why a Merlin screaming at 3000 rpm still
    // shows a propeller turning at only ~1500.
    const gearRatio = eng.kind === 'inline' ? 0.50 : 0.60;
    const rpm = clamp(s.rpm, 0, 1) * eng.maxRpm * gearRatio;
    const omega = (rpm * Math.PI * 2) / 60 * eng.propDir;
    this.propAngle += omega * dt;
    if (this.propAngle > 1e5 || this.propAngle < -1e5) this.propAngle %= Math.PI * 2;

    // The propeller *group* carries both the blades and the spinner, so it is
    // the group that spins — rotating the spinner as well double-rotates it —
    // and it is only the BLADES that may be hidden. Hiding the group above
    // ~760 rpm, i.e. all through normal cruise, left a hole in the nose.
    const bladesGone = this.detached.has('propBlades');
    const spinnerGone = this.detached.has('spinner');
    if (!bladesGone || !spinnerGone) {
      const a = this.propAngle;
      this.applyAll('propeller', (o) => { o.rotation.z = a; });
    }
    const showBlades = rpm < BLADE_OUT && !bladesGone;
    this.applyAll('propBlades', (o) => { o.visible = showBlades; });

    // Above ~380 rpm the blades smear; by ~780 they are gone and only the
    // translucent disc remains. Opacity is not linear in rpm — the perceived
    // solidity follows how much of the annulus is swept per exposure, which
    // saturates.
    const f = smoothstep(DISC_IN, DISC_FULL, rpm);
    const opacity = f * f * (0.55 + 0.45 * f);
    const showDisc = opacity > 0.01 && !bladesGone;
    this.applyAll('propDisc', (o) => { o.visible = showDisc; });
    if (this.discUniforms.length > 0) {
      for (let i = 0; i < this.discUniforms.length; i++) this.discUniforms[i].value = opacity;
    } else {
      // Fallback rig: its disc is a plain textured quad authored at 0.34, so
      // scale that, not 1.0, or a fully spun-up disc reads as an opaque plate.
      const o = opacity * 0.34;
      for (let i = 0; i < this.discMats.length; i++) this.discMats[i].opacity = o;
    }
    // Wrapped before it reaches the shader: 'propAngle' is allowed to run to
    // 1e5 rad, and a float32 cosine of 1e5 has quantised into visible steps
    // long before that.
    const phase = this.propAngle % (Math.PI * 2);
    for (let i = 0; i < this.discPhases.length; i++) this.discPhases[i].value = phase;
  }

  /**
   * Reacts to changes in the damage mask and keeps continuous effects alive.
   * Called every frame regardless of tier — smoke from a distant burning
   * aircraft is a tactical signal and must never be culled away.
   */
  updateDamage(s: EntityState, dt: number, fx: ViewFx, quality: number): void {
    const d = s.damage;
    const newBits = d & ~this.prevDamage;
    if (newBits) this.onNewDamage(newBits, d, fx);
    this.prevDamage = d;

    // 'src/vfx/DamageFx.ts' owns the staged coolant → oil → fuel → fire plume
    // and drives it off ctx.entities every frame. When it is live, emitting
    // here as well doubles the particle cost and composites a cruder plume on
    // top of the art-directed one.
    if (this.damagePlumeOwnedByVfx) return;

    const destroyed = (d & DamageBits.Destroyed) !== 0;
    const fire = (d & DamageBits.EngineFire) !== 0 || destroyed;
    const engine = (d & DamageBits.Engine) !== 0;
    const oil = (d & DamageBits.OilLeak) !== 0;
    const fuel = (d & DamageBits.FuelLeak) !== 0;
    if (!fire && !engine && !oil && !fuel) return;

    // Emitters run at reduced rate far away — the plume still reads, at a
    // fraction of the particle budget.
    const lodRate = this.distance > 2500 ? 0.35 : this.distance > 900 ? 0.7 : 1;
    const rate = lodRate * quality;

    this.engineAnchor.getWorldPosition(_v);
    const vx = this.worldVel.x, vy = this.worldVel.y, vz = this.worldVel.z;

    // Smoke leaves the aircraft at roughly the local airflow speed, not at the
    // aircraft's speed — otherwise the trail travels with the aeroplane and
    // never falls behind it.
    const shed = 0.30;

    if (destroyed) {
      this.accSmoke += dt * 26 * rate;
      this.accFire += dt * 30 * rate;
    } else if (fire) {
      this.accSmoke += dt * 18 * rate;
      this.accFire += dt * 22 * rate;
    } else if (engine) {
      const heavy = s.health < 0.45;
      this.accSmoke += dt * (heavy ? 14 : 7) * rate;
    }
    if (oil) this.accOil += dt * 16 * rate;
    if (fuel) this.accOil += dt * 10 * rate;

    const preset = destroyed
      ? (this.onGround ? SMOKE_PRESETS.wreck : SMOKE_PRESETS.fire)
      : fire ? SMOKE_PRESETS.fire
        : s.health < 0.45 ? SMOKE_PRESETS.engineHeavy : SMOKE_PRESETS.engineLight;

    while (this.accSmoke >= 1) {
      this.accSmoke -= 1;
      fx.smoke.emit(
        _v.x + (Math.random() - 0.5) * 0.5,
        _v.y + (Math.random() - 0.5) * 0.5,
        _v.z + (Math.random() - 0.5) * 0.5,
        vx * shed + (Math.random() - 0.5) * 3,
        vy * shed + (Math.random() - 0.5) * 3,
        vz * shed + (Math.random() - 0.5) * 3,
        preset,
      );
    }

    while (this.accFire >= 1) {
      this.accFire -= 1;
      // Flame streams aft along the fuselage, not straight up: at 100 m/s the
      // relative wind wins over buoyancy by an order of magnitude.
      const t = Math.random();
      _v2.copy(_v).addScaledVector(this.holder.getWorldDirection(_fwd), -t * 3.2);
      fx.fire.emit(
        _v2.x, _v2.y + t * 0.3, _v2.z,
        vx * 0.55, vy * 0.55, vz * 0.55,
        destroyed && this.onGround ? FIRE_PRESETS.wreck : FIRE_PRESETS.engine,
      );
    }

    while (this.accOil >= 1) {
      this.accOil -= 1;
      const src = fuel && !oil ? SMOKE_PRESETS.fuel
        : (this.spec.engine.kind === 'inline' && oil ? SMOKE_PRESETS.coolant : SMOKE_PRESETS.oil);
      // Fuel vents from a wing tank; oil and coolant from the engine bay. The
      // wingtip marker is an anchor, not geometry — using it here is correct.
      const anchor = fuel && !oil
        ? ((this.model.wingtipL as THREE.Object3D | undefined) ?? this.engineAnchor)
        : this.engineAnchor;
      anchor.getWorldPosition(_v2);
      fx.smoke.emit(
        _v2.x, _v2.y, _v2.z,
        vx * 0.5, vy * 0.5, vz * 0.5,
        src,
      );
    }
  }

  /**
   * One-shot structural failures.
   *
   * Everything shed here is real geometry taken from 'model.damageParts'. The
   * only parts that must never be shed are 'wingtipL/R', which are empty
   * anchors — detaching one launches an invisible Object3D and leaves the wing
   * visually intact, which is what "damage-driven part shedding" used to do.
   */
  private onNewDamage(bits: number, full: number, fx: ViewFx): void {
    // Body-frame ω → world, so debris inherits the correct tangential throw.
    _omegaWorld.copy(this.omega);

    // Ballistic coefficients (drag area / mass, m²/kg): a wing panel is mostly
    // area and flutters down, a rudder less so, a canopy is light and tumbles.
    if (bits & DamageBits.WingRipped) {
      // Which panel departs is decided by the side bits in the *full* mask —
      // the server sets LeftWing/RightWing first and raises WingRipped on a
      // later tick, so testing only this frame's new bits loses the side.
      const leftGone = (full & DamageBits.LeftWing) !== 0;
      const rightGone = (full & DamageBits.RightWing) !== 0 || !leftGone;
      if (leftGone) { this.shed('wingOuterL', fx, 0.055); this.shed('aileronL', fx, 0.09); }
      if (rightGone) { this.shed('wingOuterR', fx, 0.055); this.shed('aileronR', fx, 0.09); }
    }
    if (bits & DamageBits.Rudder) this.shed('rudder', fx, 0.07);
    if (bits & DamageBits.Elevator) this.shed('elevatorR', fx, 0.075);
    if (bits & DamageBits.Aileron) this.shed('aileronL', fx, 0.09);
    if (bits & DamageBits.Tail) {
      this.shed('tailplaneL', fx, 0.06);
      this.shed('elevatorL', fx, 0.075);
      this.shed('rudder', fx, 0.07);
    }
    if (bits & DamageBits.Destroyed) {
      this.jettisonCanopy(fx);
      // A destroyed airframe usually loses something structural on the way down.
      if (Math.random() < 0.65) this.shed('wingOuterL', fx, 0.055, true);
      if (Math.random() < 0.45) this.shed('elevatorL', fx, 0.075, true);
      if (Math.random() < 0.35) this.shed('propBlades', fx, 0.02, true);
    }
  }

  /**
   * Detaches one named part into the debris field and hides the copies of it
   * that live at the other LOD levels, so the panel stays gone whichever level
   * the renderer picks next frame.
   */
  private shed(name: ShedName, fx: ViewFx, ballistic: number, burning = false): void {
    if (this.detached.has(name)) return;
    const list = this.partsOf.get(name);
    if (!list || list.length === 0) return;
    const lead = list[0];
    if (!lead.visible || !lead.parent) return;
    this.detached.add(name);
    if (!fx.debris.detach(this.viewId, lead, this.worldVel, _omegaWorld, ballistic, burning)) {
      lead.visible = false;
    }
    for (let i = 1; i < list.length; i++) list[i].visible = false;
  }

  /** Canopy jettison — fired on bailout and on destruction. */
  jettisonCanopy(fx: ViewFx): void {
    if (this.canopyGone) return;
    this.canopyGone = true;
    const list = this.partsOf.get('canopy');
    if (!list || list.length === 0) return;
    this.detached.add('canopy');
    // Very light and very draggy: a jettisoned hood goes straight over the tail.
    if (!fx.debris.detach(this.viewId, list[0], this.worldVel, this.omega, 0.22, false, 9)) {
      list[0].visible = false;
    }
    for (let i = 1; i < list.length; i++) list[i].visible = false;
  }

  /** Hides the pilot after a bailout. */
  removePilot(): void {
    this.applyAll('pilot', (o) => { o.visible = false; });
  }

  /** World position of the cockpit — used by camera and audio. */
  cockpitPosition(out: THREE.Vector3): THREE.Vector3 {
    const p = this.firstOf('pilot') ?? this.firstOf('eyePoint') ?? this.firstOf('canopy');
    if (p) return p.getWorldPosition(out);
    return out.copy(this.holder.position);
  }

  /** Releases the per-view material clones. Geometry is shared and untouched. */
  dispose(): void {
    for (const m of this.discMats) m.dispose();
    this.discMats.length = 0;
    this.discUniforms.length = 0;
    this.discPhases.length = 0;
  }

  get velocity(): THREE.Vector3 { return this.worldVel; }
  get angularVelocity(): THREE.Vector3 { return this.omega; }
  get worldMatrix(): THREE.Matrix4 { return this.holder.matrixWorld; }
}

// ---------------------------------------------------------------------------

/**
 * Builds the name → objects map this view drives.
 *
 * The real builder ships one already ('model.parts', every LOD level's copy of
 * each part). The stand-in rig does not, so one is synthesised from its named
 * references — that keeps a single code path here instead of an optional-chain
 * guard on every
 * line, and means the fallback animates through exactly the same logic.
 */
function resolveParts(model: AircraftModel): Map<string, THREE.Object3D[]> {
  const supplied = (model as { parts?: unknown }).parts;
  if (supplied instanceof Map && supplied.size > 0) {
    return supplied as Map<string, THREE.Object3D[]>;
  }
  const out = new Map<string, THREE.Object3D[]>();
  const put = (name: string, o: THREE.Object3D | undefined): void => {
    if (o) out.set(name, [o]);
  };
  put('aileronLPivot', model.aileronL);
  put('aileronRPivot', model.aileronR);
  put('elevatorLPivot', model.elevatorL);
  put('elevatorRPivot', model.elevatorR);
  put('rudderPivot', model.rudder);
  put('flapLPivot', model.flapL);
  put('flapRPivot', model.flapR);
  put('aileronL', model.aileronL);
  put('aileronR', model.aileronR);
  put('elevatorL', model.elevatorL);
  put('elevatorR', model.elevatorR);
  put('rudder', model.rudder);
  put('gearL', model.gearL);
  put('gearR', model.gearR);
  put('gearTail', model.gearTail);
  put('gearDoorLPivot', model.gearDoorL);
  put('gearDoorRPivot', model.gearDoorR);
  put('gearDoorL', model.gearDoorL);
  put('gearDoorR', model.gearDoorR);
  put('propeller', model.propeller);
  put('propBlades', model.propeller);
  put('propDisc', model.propDisc);
  put('spinner', model.spinner);
  put('canopy', model.canopy);
  put('pilot', model.pilot);
  // The stand-in has no separate wheel pivots; spinning its gear group would
  // rotate the whole leg, so it simply does not spin wheels.
  return out;
}

const _qDelta = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
