import * as THREE from 'three';
import { createCelMaterial, addOutline } from '../../render/CelMaterial';
import { chuteTexture } from './textures';
import type { ClientEnv } from '../env';

/**
 * Bailed-out pilots under canopy.
 *
 * Two phases, because the difference is what makes a bailout read: a brief
 * free fall with the pilot tumbling, then the snatch as the canopy inflates —
 * a hard deceleration, an overshoot of the pilot under the skirt, and a
 * pendulum that damps out over a few swings. Drifting straight down at a
 * constant rate looks like a prop, not a person.
 */

const CHUTE_R = 3.6;          // inflated canopy radius, m
const TERMINAL = 5.6;         // descent rate under a WWII 24 ft canopy, m/s
const FREEFALL_TERMINAL = 52;

interface Chute {
  group: THREE.Group;
  canopy: THREE.Group;
  pilot: THREE.Object3D;
  lines: THREE.LineSegments;
  entityId: number;
  live: boolean;
  age: number;
  /** 0 = free fall, ramps to 1 as the canopy inflates. */
  deploy: number;
  vel: THREE.Vector3;
  swing: number;
  swingVel: number;
  swingAxis: number;
  landed: boolean;
}

const _wind = { x: 0, y: 0, z: 0 };

export class ParachuteField {
  readonly group = new THREE.Group();
  private pool: Chute[] = [];
  private byEntity = new Map<number, Chute>();
  private env: ClientEnv;

  constructor(env: ClientEnv, capacity = 8) {
    this.group.name = 'parachutes';
    this.env = env;

    const canopyMat = createCelMaterial({
      name: 'chute_canopy',
      map: chuteTexture(),
      bands: 3,
      bandSoftness: 0.07,
      gloss: 0.85,
      specular: 0.18,
      rimStrength: 1.1,
      rimPower: 2.2,
      shadowTint: 0x6b86ad,
      side: THREE.DoubleSide,
      outline: true,
    });
    const bodyMat = createCelMaterial({
      name: 'chute_pilot',
      color: 0x4b4a42,
      bands: 3,
      gloss: 0.3,
      specular: 0.3,
      rimStrength: 0.9,
    });
    const lineMat = new THREE.LineBasicMaterial({ color: 0x1a1d22, transparent: true, opacity: 0.85 });

    // Canopy: a hemisphere flattened toward a real parachute's shallow dome,
    // with a vent at the apex.
    const canopyGeo = new THREE.SphereGeometry(CHUTE_R, 20, 10, 0, Math.PI * 2, 0.16, Math.PI / 2 - 0.16);
    canopyGeo.scale(1, 0.72, 1);

    for (let i = 0; i < capacity; i++) {
      const g = new THREE.Group();
      g.name = `chute${i}`;
      g.visible = false;

      const canopy = new THREE.Group();
      const dome = new THREE.Mesh(canopyGeo, canopyMat);
      dome.castShadow = true;
      addOutline(dome, 0.010, 0x0b0f16);
      canopy.add(dome);
      canopy.position.y = 6.2;
      g.add(canopy);

      const pilot = new THREE.Group();
      const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.5, 3, 8), bodyMat);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), bodyMat);
      head.position.y = 0.48;
      const legL = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.55, 2, 6), bodyMat);
      legL.position.set(-0.12, -0.62, 0.05);
      legL.rotation.x = 0.35;
      const legR = legL.clone(); legR.position.x = 0.12;
      const harness = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.035, 4, 10), bodyMat);
      harness.rotation.x = Math.PI / 2;
      harness.position.y = 0.05;
      pilot.add(torso, head, legL, legR, harness);
      pilot.traverse((o) => { (o as THREE.Mesh).castShadow = true; });
      g.add(pilot);

      // Rigging: 12 lines from the skirt to the harness.
      const pts: number[] = [];
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        pts.push(Math.cos(a) * CHUTE_R * 0.94, 6.2 - CHUTE_R * 0.12, Math.sin(a) * CHUTE_R * 0.94);
        pts.push(Math.cos(a) * 0.22, 0.35, Math.sin(a) * 0.22);
      }
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const lines = new THREE.LineSegments(lineGeo, lineMat);
      g.add(lines);

      this.group.add(g);
      this.pool.push({
        group: g, canopy, pilot, lines,
        entityId: 0, live: false, age: 0, deploy: 0,
        vel: new THREE.Vector3(), swing: 0, swingVel: 0, swingAxis: 0, landed: false,
      });
    }
  }

  /** True when a chute already exists for this entity. */
  has(entityId: number): boolean { return this.byEntity.has(entityId); }

  /**
   * Spawns a chute. 'vel' is the aircraft's velocity at bailout — the pilot
   * leaves with it, which is why a bailout from a fast dive throws the pilot
   * a long way before the canopy bites.
   */
  spawn(entityId: number, x: number, y: number, z: number, vel: THREE.Vector3): void {
    let c = this.pool.find((p) => !p.live);
    if (!c) {
      // Recycle the oldest.
      c = this.pool.reduce((a, b) => (a.age > b.age ? a : b));
      this.byEntity.delete(c.entityId);
    }
    c.live = true;
    c.entityId = entityId;
    c.age = 0;
    c.deploy = 0;
    c.landed = false;
    c.vel.copy(vel).multiplyScalar(0.85);
    c.swing = 0;
    c.swingVel = 0;
    c.swingAxis = Math.random() * Math.PI * 2;
    c.group.visible = true;
    c.group.position.set(x, y, z);
    c.canopy.scale.setScalar(0.05);
    c.lines.visible = false;
    this.byEntity.set(entityId, c);
  }

  /** Keeps a chute glued to a replicated Parachute entity, if the server owns it. */
  track(entityId: number, x: number, y: number, z: number): void {
    const c = this.byEntity.get(entityId);
    if (!c || !c.live) return;
    c.group.position.set(x, y, z);
  }

  despawn(entityId: number): void {
    const c = this.byEntity.get(entityId);
    if (!c) return;
    c.live = false;
    c.group.visible = false;
    this.byEntity.delete(entityId);
  }

  update(dt: number, time: number): void {
    for (const c of this.pool) {
      if (!c.live) continue;
      c.age += dt;

      // Canopy inflation: the snatch happens over ~0.7 s starting 1.2 s after
      // separation, which is roughly a WWII static-line/ripcord delay.
      const target = c.age > 1.2 ? 1 : 0;
      c.deploy += Math.min(1, dt / 0.7) * (target - c.deploy);
      const dep = smooth(c.deploy);
      c.canopy.scale.setScalar(0.05 + dep * 0.95);
      c.lines.visible = dep > 0.25;
      (c.lines.material as THREE.LineBasicMaterial).opacity = 0.85 * dep;

      if (!c.landed) {
        this.env.windAt(c.group.position, _wind);
        // Drag ramps with inflation. Terminal velocity falls from ~52 m/s in
        // free fall to ~5.6 m/s under the canopy.
        const terminal = FREEFALL_TERMINAL + (TERMINAL - FREEFALL_TERMINAL) * dep;
        const k = 9.80665 / (terminal * terminal);

        const rx = c.vel.x - _wind.x, ry = c.vel.y - _wind.y, rz = c.vel.z - _wind.z;
        const sp = Math.hypot(rx, ry, rz);
        if (sp > 0.01) {
          const a = k * sp;
          c.vel.x -= rx * a * dt;
          c.vel.y -= ry * a * dt;
          c.vel.z -= rz * a * dt;
        }
        c.vel.y -= 9.80665 * dt;
        c.group.position.addScaledVector(c.vel, dt);

        const gh = this.env.terrainHeight(c.group.position.x, c.group.position.z);
        if (c.group.position.y <= gh + 0.9) {
          c.group.position.y = gh + 0.9;
          c.landed = true;
          c.vel.set(0, 0, 0);
        }
      }

      // Pendulum. Excited by the opening shock, damped by canopy drag; a slow
      // residual sway persists, driven by the wind field.
      const drive = c.age > 1.2 && c.age < 2.4 ? 3.4 : 0;
      const w0 = 0.78;      // rad/s: 6.2 m riser length gives ~8 s period
      c.swingVel += (-w0 * w0 * c.swing - 0.55 * c.swingVel + drive * Math.sin(c.age * 5)) * dt;
      c.swing += c.swingVel * dt;
      if (c.landed) c.swing *= Math.exp(-dt * 3);
      const sway = c.swing + (c.landed ? 0 : Math.sin(time * 0.6 + c.swingAxis) * 0.05 * dep);
      c.group.rotation.set(
        Math.sin(c.swingAxis) * sway,
        0,
        Math.cos(c.swingAxis) * sway,
      );
      // Before the canopy bites, the pilot tumbles.
      if (dep < 0.4) {
        c.pilot.rotation.x += dt * 5.5 * (1 - dep);
        c.pilot.rotation.z += dt * 2.5 * (1 - dep);
      } else {
        c.pilot.rotation.x *= Math.exp(-dt * 4);
        c.pilot.rotation.z *= Math.exp(-dt * 4);
      }

      // Retire once landed and settled.
      if (c.landed && c.age > 45) { c.live = false; c.group.visible = false; this.byEntity.delete(c.entityId); }
    }
  }

  dispose(): void {
    for (const c of this.pool) {
      c.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh || (o as THREE.LineSegments).isLineSegments) m.geometry?.dispose();
      });
    }
    this.pool.length = 0;
    this.byEntity.clear();
  }
}

const smooth = (t: number) => t * t * (3 - 2 * t);
