import * as THREE from 'three';
import type { ClientEnv } from '../env';
import { v3 } from '../../shared/math';

/**
 * Shot-off parts, tumbling under their own physics.
 *
 * A detached wingtip is not spawned as a new object — it is the *same*
 * 'Object3D' that was hinged to the aircraft a frame earlier, lifted out of the
 * rig with its world transform preserved. That is what sells the moment: the
 * piece that flies away is unmistakably the piece that was there.
 *
 * Because those parts belong to pooled aircraft models, every item remembers
 * its home parent and local transform and is put back when it dies or when the
 * aircraft is recycled. Nothing is ever destroyed.
 */

interface DebrisItem {
  obj: THREE.Object3D;
  owner: number;
  home: THREE.Object3D;
  homePos: THREE.Vector3;
  homeQuat: THREE.Quaternion;
  homeScale: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  age: number;
  life: number;
  /** Drag area over mass, m²/kg — light panels flutter, spars plummet. */
  ballistic: number;
  burning: boolean;
  resting: boolean;
  live: boolean;
}

const _wp = new THREE.Vector3();
const _wq = new THREE.Quaternion();
const _ws = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _wind = v3();
const _windArg = v3();

export interface DebrisEmit {
  (x: number, y: number, z: number, vx: number, vy: number, vz: number, burning: boolean): void;
}

export class DebrisField {
  readonly group = new THREE.Group();
  private items: DebrisItem[] = [];
  private env: ClientEnv;
  private max: number;

  constructor(env: ClientEnv, max = 48) {
    this.group.name = 'debris';
    this.env = env;
    this.max = max;
  }

  /**
   * Detaches 'obj' from its rig and launches it.
   *
   * @param vel       aircraft velocity at the moment of separation
   * @param omega     aircraft body angular velocity — the part inherits the
   *                  tangential velocity of its own moment arm, which is why a
   *                  tip shed in a hard turn is flung outward rather than
   *                  dropping straight down
   */
  detach(
    owner: number, obj: THREE.Object3D,
    vel: THREE.Vector3, omega: THREE.Vector3,
    ballistic: number, burning: boolean, life = 14,
  ): boolean {
    if (!obj.parent) return false;
    if (this.items.filter((i) => i.live).length >= this.max) this.retireOldest();

    const home = obj.parent;
    obj.updateWorldMatrix(true, false);
    obj.matrixWorld.decompose(_wp, _wq, _ws);

    const item: DebrisItem = {
      obj, owner, home,
      homePos: obj.position.clone(),
      homeQuat: obj.quaternion.clone(),
      homeScale: obj.scale.clone(),
      vel: new THREE.Vector3(),
      spin: new THREE.Vector3(),
      age: 0, life,
      ballistic, burning, resting: false, live: true,
    };

    // Tangential contribution: v = ω × r, with r taken from the aircraft origin
    // to the part, both already in world space.
    _axis.copy(_wp).sub(_ownerOrigin(home));
    item.vel.copy(vel).add(new THREE.Vector3().crossVectors(omega, _axis));
    // Separation impulse: structural failure throws the piece clear.
    item.vel.x += (Math.random() - 0.5) * 9;
    item.vel.y += Math.random() * 5 + 1;
    item.vel.z += (Math.random() - 0.5) * 9;
    // Torn metal always tumbles hard; slow, stately rotation looks fake.
    item.spin.set(
      (Math.random() - 0.5) * 11,
      (Math.random() - 0.5) * 7,
      (Math.random() - 0.5) * 13,
    );

    this.group.add(obj);
    obj.position.copy(_wp);
    obj.quaternion.copy(_wq);
    obj.scale.copy(_ws);
    obj.visible = true;

    this.items.push(item);
    return true;
  }

  private retireOldest(): void {
    let best: DebrisItem | null = null;
    for (const i of this.items) if (i.live && (!best || i.age > best.age)) best = i;
    if (best) this.restore(best);
  }

  /**
   * Puts a part back where it came from. 'makeVisible' is false for the normal
   * lifetime expiry — the aircraft is still missing that piece — and true when
   * the whole rig is being recycled for a fresh spawn.
   */
  private restore(item: DebrisItem, makeVisible = false): void {
    item.live = false;
    item.home.add(item.obj);
    item.obj.position.copy(item.homePos);
    item.obj.quaternion.copy(item.homeQuat);
    item.obj.scale.copy(item.homeScale);
    item.obj.visible = makeVisible;
  }

  /** Force every part belonging to 'owner' back into its rig, whole again. */
  recallOwner(owner: number): void {
    for (const item of this.items) {
      if (item.live && item.owner === owner) this.restore(item, true);
    }
    this.items = this.items.filter((i) => i.live);
  }

  update(dt: number, emit: DebrisEmit | null): void {
    if (this.items.length === 0) return;
    for (const item of this.items) {
      if (!item.live) continue;
      item.age += dt;

      const o = item.obj;
      if (!item.resting) {
        // Scratch argument, hoisted: at 56 live items this was 3 360 short-lived
        // object literals a second straight into the nursery.
        _windArg.x = o.position.x; _windArg.y = o.position.y; _windArg.z = o.position.z;
        this.env.windAt(_windArg, _wind);
        const rho = this.env.airDensity(o.position.y);

        // Relative airspeed, quadratic drag with the item's ballistic ratio.
        const rx = item.vel.x - _wind.x, ry = item.vel.y - _wind.y, rz = item.vel.z - _wind.z;
        const sp = Math.hypot(rx, ry, rz);
        if (sp > 0.01) {
          const a = 0.5 * rho * sp * item.ballistic;
          item.vel.x -= rx * a * dt;
          item.vel.y -= ry * a * dt;
          item.vel.z -= rz * a * dt;
        }
        item.vel.y -= 9.80665 * dt;

        o.position.addScaledVector(item.vel, dt);

        // Tumble. Damping scales with dynamic pressure: a fluttering panel
        // stabilises as it slows, which is what real wreckage does.
        const damp = Math.exp(-dt * (0.25 + 0.0009 * rho * sp * sp * item.ballistic));
        item.spin.multiplyScalar(damp);
        const w = item.spin.length();
        if (w > 1e-4) {
          _axis.copy(item.spin).multiplyScalar(1 / w);
          _dq.setFromAxisAngle(_axis, w * dt);
          o.quaternion.premultiply(_dq);
        }

        if (emit && (item.burning || item.age < 3)) {
          // Burning parts trail fire and soot; fresh breaks shed dust briefly.
          emit(o.position.x, o.position.y, o.position.z,
            item.vel.x * 0.3, item.vel.y * 0.3, item.vel.z * 0.3, item.burning);
        }

        const gh = this.env.terrainHeight(o.position.x, o.position.z);
        if (o.position.y <= gh + 0.25) {
          o.position.y = gh + 0.25;
          if (item.vel.y < -4 && item.age < item.life * 0.7) {
            // One dead bounce, then it stays down.
            item.vel.y = -item.vel.y * 0.22;
            item.vel.x *= 0.45; item.vel.z *= 0.45;
            item.spin.multiplyScalar(0.4);
          } else {
            item.resting = true;
            item.vel.set(0, 0, 0);
            item.spin.set(0, 0, 0);
            // Settle flat rather than standing on edge.
            o.rotation.x = Math.random() * 0.3 - 0.15;
            o.rotation.z = Math.random() * 0.3 - 0.15;
          }
        }
      }

      // Fade out over the last two seconds, then go home.
      const remaining = item.life - item.age;
      if (remaining < 2) {
        const k = Math.max(0, remaining / 2);
        o.scale.set(item.homeScale.x * k, item.homeScale.y * k, item.homeScale.z * k);
      }
      if (item.age >= item.life) this.restore(item);
    }
    if (this.items.some((i) => !i.live)) this.items = this.items.filter((i) => i.live);
  }

  get activeCount(): number { return this.items.length; }

  dispose(): void {
    for (const item of this.items) if (item.live) this.restore(item);
    this.items.length = 0;
  }
}

/** World-space origin of the rig a detached part came from. */
function _ownerOrigin(home: THREE.Object3D): THREE.Vector3 {
  let root: THREE.Object3D = home;
  while (root.parent && root.parent.type !== 'Scene' && root.parent.name !== 'entities') root = root.parent;
  root.updateWorldMatrix(true, false);
  return _origin.setFromMatrixPosition(root.matrixWorld);
}
const _origin = new THREE.Vector3();
