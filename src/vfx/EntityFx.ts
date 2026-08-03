import * as THREE from 'three';
import { EntityKind, type EntityState } from '../shared/protocol';
import { aircraftByIndex } from '../shared/aircraft';
import { NO_TRAIL, type TrailHandle } from './TrailSystem';
import type { VfxCore } from './VfxCore';
import {
  humidityAt, releaseVortices, updateContrails, updateGroundWash,
  updatePropVortices, updateTransonic, updateWingVortices, type AirflowInput,
} from './Airflow';
import { releaseDamageTrail, updateDamageFx, type DamageAnchors } from './DamageFx';
import { updateBombFx, updateRocketFx } from './Ordnance';

/**
 * Per-entity VFX state.
 *
 * The VFX system is a pure observer: it never mutates entity state, it just
 * watches 'ctx.entities' and keeps one of these records alongside each one.
 * That means it works identically for the locally predicted aircraft, for
 * interpolated remote aircraft and for offline sandbox entities, with no
 * special cases.
 *
 * The one thing that cannot be observed is acceleration, and load factor is
 * what gates the wingtip vortices — so it is differentiated here from the
 * velocity the network gives us, heavily smoothed, because a differentiated
 * 20 Hz signal is otherwise pure noise.
 */

/** Loose structural view of the aircraft model built by src/assets/aircraft. */
export interface VfxAircraftModel {
  root?: THREE.Object3D;
  propeller?: THREE.Object3D;
  spinner?: THREE.Object3D;
  exhaustPorts?: THREE.Object3D[];
  gunPorts?: THREE.Object3D[];
  wingtipL?: THREE.Object3D;
  wingtipR?: THREE.Object3D;
  damageParts?: THREE.Object3D[];
}

export interface AircraftFx {
  id: number;
  kind: number;
  typeId: number;
  seenFrame: number;
  age: number;

  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  hasPrev: boolean;
  /** Smoothed body-axis load factor, g. */
  gLoad: number;

  contrailL: TrailHandle;
  contrailR: TrailHandle;
  vortexL: TrailHandle;
  vortexR: TrailHandle;
  propL: TrailHandle;
  propR: TrailHandle;
  debrisTrail: TrailHandle;

  propPhase: number;
  /** Helix phase of the wingtip vortex cores, radians. */
  vortexPhase: number;
  machTimer: number;
  dustTimer: number;
  vortexMist: number;
  coolantTimer: number;
  oilTimer: number;
  fuelTimer: number;
  fireTimer: number;
  fireSmokeTimer: number;
  debrisTimer: number;

  model: VfxAircraftModel | null;
  /** Damage bits pushed in by attachDamageEffects, OR-ed with the entity's. */
  extraBits: number;
  lastBits: number;
  wasAlive: boolean;
}

function newFx(): AircraftFx {
  return {
    id: 0, kind: 0, typeId: 0, seenFrame: -1, age: 0,
    px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, hasPrev: false, gLoad: 1,
    contrailL: NO_TRAIL, contrailR: NO_TRAIL,
    vortexL: NO_TRAIL, vortexR: NO_TRAIL,
    propL: NO_TRAIL, propR: NO_TRAIL, debrisTrail: NO_TRAIL,
    propPhase: 0, vortexPhase: 0, machTimer: 0, dustTimer: 0, vortexMist: 0,
    coolantTimer: 0, oilTimer: 0, fuelTimer: 0, fireTimer: 0,
    fireSmokeTimer: 0, debrisTimer: 0,
    model: null, extraBits: 0, lastBits: 0, wasAlive: true,
  };
}

const _q = new THREE.Quaternion();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _wp = new THREE.Vector3();
const _portL = new THREE.Vector3();
const _portR = new THREE.Vector3();

const airflow: AirflowInput = {
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
  right: _right, up: _up, fwd: _fwd,
  gLoad: 1, speed: 0, throttle: 0, rpm: 0,
  span: 11, propDia: 3, machCrit: 0.75, tipY: 0, tipZ: 0,
};

const anchors: DamageAnchors = {
  ex: 0, ey: 0, ez: 0, lx: 0, ly: 0, lz: 0,
  rx: 0, ry: 0, rz: 0, tx: 0, ty: 0, tz: 0,
};

export class EntityFxRegistry {
  private map = new Map<number, AircraftFx>();
  private pool: AircraftFx[] = [];
  /** Global humidity multiplier, 0..1.5. Weather drives this. */
  humidity = 0.85;
  /** Set to false to skip airflow effects entirely (very low quality). */
  airflowEnabled = true;

  /** Called by the entity system so we can use real model anchor points. */
  attach(entityId: number, model: VfxAircraftModel | null, damageBits: number): void {
    const fx = this.map.get(entityId) ?? this.acquire(entityId);
    fx.model = model;
    fx.extraBits = damageBits;
  }

  detach(entityId: number, core: VfxCore): void {
    const fx = this.map.get(entityId);
    if (!fx) return;
    this.releaseAll(core, fx);
    this.map.delete(entityId);
    if (this.pool.length < 64) this.pool.push(fx);
  }

  get(entityId: number): AircraftFx | undefined { return this.map.get(entityId); }

  private acquire(id: number): AircraftFx {
    const fx = this.pool.pop() ?? newFx();
    fx.id = id;
    fx.seenFrame = -1;
    fx.age = 0;
    fx.hasPrev = false;
    fx.gLoad = 1;
    fx.model = null;
    fx.extraBits = 0;
    fx.lastBits = 0;
    fx.wasAlive = true;
    fx.propPhase = 0;
    fx.vortexPhase = 0;
    fx.contrailL = fx.contrailR = NO_TRAIL;
    fx.vortexL = fx.vortexR = NO_TRAIL;
    fx.propL = fx.propR = NO_TRAIL;
    fx.debrisTrail = NO_TRAIL;
    this.map.set(id, fx);
    return fx;
  }

  private releaseAll(core: VfxCore, fx: AircraftFx): void {
    releaseVortices(core, fx);
    releaseDamageTrail(core, fx);
    if (fx.contrailL !== NO_TRAIL) { core.trailsBill.release(fx.contrailL); fx.contrailL = NO_TRAIL; }
    if (fx.contrailR !== NO_TRAIL) { core.trailsBill.release(fx.contrailR); fx.contrailR = NO_TRAIL; }
    if (fx.propL !== NO_TRAIL) { core.trailsRibbon.release(fx.propL); fx.propL = NO_TRAIL; }
    if (fx.propR !== NO_TRAIL) { core.trailsRibbon.release(fx.propR); fx.propR = NO_TRAIL; }
  }

  /** Per-frame sweep over the replicated entity set. */
  update(core: VfxCore, entities: Map<number, EntityState>, frame: number): void {
    for (const e of entities.values()) {
      let fx = this.map.get(e.id);
      if (!fx) fx = this.acquire(e.id);
      fx.kind = e.kind;
      fx.typeId = e.typeId;
      fx.age += core.dt;
      fx.seenFrame = frame;

      switch (e.kind) {
        case EntityKind.Aircraft: this.updateAircraft(core, e, fx); break;
        case EntityKind.Rocket: this.updateRocket(core, e, fx); break;
        case EntityKind.Bomb: this.updateBomb(core, e, fx); break;
        case EntityKind.Wreck: this.updateWreck(core, e, fx); break;
        default: break;
      }

      fx.px = e.px; fx.py = e.py; fx.pz = e.pz;
      fx.vx = e.vx; fx.vy = e.vy; fx.vz = e.vz;
      fx.hasPrev = true;
    }

    // Retire records for entities that vanished.
    for (const [id, fx] of this.map) {
      if (fx.seenFrame === frame) continue;
      this.releaseAll(core, fx);
      this.map.delete(id);
      if (this.pool.length < 64) this.pool.push(fx);
    }
  }

  // -------------------------------------------------------------------------

  private basis(e: EntityState): void {
    _q.set(e.qx, e.qy, e.qz, e.qw).normalize();
    _right.set(1, 0, 0).applyQuaternion(_q);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _fwd.set(0, 0, 1).applyQuaternion(_q);
  }

  private updateAircraft(core: VfxCore, e: EntityState, fx: AircraftFx): void {
    this.basis(e);
    const spec = aircraftByIndex(e.typeId);
    const speed = Math.hypot(e.vx, e.vy, e.vz);

    // Load factor: differentiate the replicated velocity, add gravity back in
    // and project onto body up. Smoothed hard — a 20 Hz snapshot stream gives
    // a very noisy derivative and vortices that strobe look broken.
    if (fx.hasPrev && core.dt > 1e-4) {
      const ax = (e.vx - fx.vx) / core.dt;
      const ay = (e.vy - fx.vy) / core.dt + 9.81;
      const az = (e.vz - fx.vz) / core.dt;
      const n = (ax * _up.x + ay * _up.y + az * _up.z) / 9.81;
      const k = 1 - Math.exp(-6 * core.dt);
      fx.gLoad += (n - fx.gLoad) * k;
    }

    const a = airflow;
    a.x = e.px; a.y = e.py; a.z = e.pz;
    a.vx = e.vx; a.vy = e.vy; a.vz = e.vz;
    a.gLoad = fx.gLoad;
    a.speed = speed;
    a.throttle = e.throttle;
    a.rpm = e.rpm;
    a.span = spec.aero.span;
    a.propDia = spec.engine.propDia;
    a.machCrit = spec.aero.machCrit;
    a.tipY = spec.geom.wingY + spec.geom.wing.dihedral * spec.aero.span * 0.5;
    a.tipZ = spec.geom.wingZ - spec.geom.wing.rootChord * 0.25;

    const groundY = core.terrain.height(e.px, e.pz);
    const nearCam = !core.tooFar(e.px, e.py, e.pz, 12000);

    if (this.airflowEnabled && nearCam) {
      updateWingVortices(core, fx, a, this.humidity);

      // Exhaust ports from the real model when the entity system gave us one;
      // otherwise a symmetric pair just aft of the cowling.
      let pl: THREE.Vector3 | null = null;
      let pr: THREE.Vector3 | null = null;
      const ports = fx.model?.exhaustPorts;
      if (ports && ports.length >= 1) {
        ports[0].getWorldPosition(_portL); pl = _portL;
        ports[Math.min(1, ports.length - 1)].getWorldPosition(_portR); pr = _portR;
      }
      updateContrails(core, fx, a, pl, pr);

      // Propeller hub: the spinner if we have it, otherwise the nose.
      if (fx.model?.spinner) {
        fx.model.spinner.getWorldPosition(_wp);
      } else {
        _wp.set(e.px, e.py, e.pz).addScaledVector(_fwd, spec.geom.length * 0.46);
      }
      updatePropVortices(core, fx, a, _wp.x, _wp.y, _wp.z, this.humidity);
      updateTransonic(core, fx, a, this.humidity);
      updateGroundWash(core, fx, a, groundY);
    } else {
      releaseVortices(core, fx);
    }

    // Damage.
    const bits = e.damage | fx.extraBits;
    if (nearCam) {
      this.fillAnchors(e, fx, spec.geom.length, spec.aero.span);
      updateDamageFx(core, fx, a, bits, e.health, anchors);
    }
    fx.lastBits = bits;
  }

  private fillAnchors(e: EntityState, fx: AircraftFx, length: number, span: number): void {
    // Engine: the cowling, not the centre section.
    //
    // 0.30 of the length forward put the anchor level with the windscreen on a
    // single-seat fighter, so an engine fire appeared to be coming out of the
    // cockpit and the flame licks streamed back over the fuselage roundel. The
    // Merlin's exhaust stubs sit at roughly 0.38 of the length ahead of the
    // centre of mass and just below the thrust line, which is where the fire
    // actually escapes and where its licks clear the airframe.
    _wp.set(e.px, e.py, e.pz).addScaledVector(_fwd, length * 0.44).addScaledVector(_up, -0.04);
    anchors.ex = _wp.x; anchors.ey = _wp.y; anchors.ez = _wp.z;

    const tipL = fx.model?.wingtipL;
    const tipR = fx.model?.wingtipR;
    if (tipL) { tipL.getWorldPosition(_wp); anchors.lx = _wp.x; anchors.ly = _wp.y; anchors.lz = _wp.z; }
    else {
      _wp.set(e.px, e.py, e.pz).addScaledVector(_right, -span * 0.34);
      anchors.lx = _wp.x; anchors.ly = _wp.y; anchors.lz = _wp.z;
    }
    if (tipR) { tipR.getWorldPosition(_wp); anchors.rx = _wp.x; anchors.ry = _wp.y; anchors.rz = _wp.z; }
    else {
      _wp.set(e.px, e.py, e.pz).addScaledVector(_right, span * 0.34);
      anchors.rx = _wp.x; anchors.ry = _wp.y; anchors.rz = _wp.z;
    }

    _wp.set(e.px, e.py, e.pz).addScaledVector(_fwd, -length * 0.42).addScaledVector(_up, 0.2);
    anchors.tx = _wp.x; anchors.ty = _wp.y; anchors.tz = _wp.z;
  }

  private updateRocket(core: VfxCore, e: EntityState, fx: AircraftFx): void {
    this.basis(e);
    updateRocketFx(core, fx, e.px, e.py, e.pz, e.vx, e.vy, e.vz, _fwd);
  }

  private updateBomb(core: VfxCore, e: EntityState, fx: AircraftFx): void {
    this.basis(e);
    fx.propPhase += core.dt * 2.4;
    updateBombFx(
      core, fx, e.px, e.py, e.pz, e.vx, e.vy, e.vz,
      _fwd, _right, _up, humidityAt(e.py, this.humidity),
    );
  }

  private updateWreck(core: VfxCore, e: EntityState, fx: AircraftFx): void {
    this.basis(e);
    const spec = aircraftByIndex(e.typeId);
    const a = airflow;
    a.x = e.px; a.y = e.py; a.z = e.pz;
    a.vx = e.vx; a.vy = e.vy; a.vz = e.vz;
    a.gLoad = 1;
    a.speed = Math.hypot(e.vx, e.vy, e.vz);
    a.throttle = 0; a.rpm = 0;
    a.span = spec.aero.span; a.propDia = spec.engine.propDia;
    a.machCrit = spec.aero.machCrit; a.tipY = 0; a.tipZ = 0;
    if (core.tooFar(e.px, e.py, e.pz, 9000)) return;
    this.fillAnchors(e, fx, spec.geom.length, spec.aero.span);
    // A wreck is on fire by definition.
    updateDamageFx(core, fx, a, 0xffff, 0.05, anchors);
  }

  clear(core: VfxCore): void {
    for (const fx of this.map.values()) this.releaseAll(core, fx);
    this.map.clear();
  }

  get count(): number { return this.map.size; }
}
