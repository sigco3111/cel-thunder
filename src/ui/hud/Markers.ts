import * as THREE from 'three';
import { el, setText, setStyle, setClass, clamp, distStr } from '../dom';
// setClass drives both the ally/enemy/lock colouring and the label offset.
import { EntityKind, type EntityState } from '../../shared/protocol';

export interface TargetInfo {
  id: number;
  dist: number;
  /** Absolute compass bearing to the target, degrees. */
  bearing: number;
  screenX: number;
  screenY: number;
  state: EntityState | null;
}

interface Marker {
  root: HTMLElement;
  box: HTMLElement;
  arrow: HTMLElement;
  lbl: HTMLElement;
  name: HTMLElement;
  sub: HTMLElement;
  edge: HTMLElement;
  used: boolean;
}

const MAX_MARKERS = 28;
/**
 * Radius, in design px, of the keep-out disc around the gunsight.
 *
 * The convergence bracket sits at 104 and the outer range ring plus its ticks
 * reach 72, so a block anchored at 118 was still landing on the bracket corner
 * — which is exactly where "Bf 109 G-6 455m" was drawn across the sight in both
 * the chase and the cockpit captures. 150 clears the whole assembly including
 * the ink pass, and the offset anchors below are sized to reach past it.
 */
const RETICLE_CLEAR = 150;
/* ID-block placement, design px. The offsets mirror '.ct-mk-lbl' /
 * '.ct-mk-lbl.is-offset' in the stylesheet and must move with them. */
const LBL_DROP = 26;
const LBL_OFF_X = 132;
const LBL_OFF_Y = 118;
/** Half-extent of a block for the overlap test — a two-line label at nano/tiny. */
const LBL_W = 76;
const LBL_H = 26;

/**
 * Where a contact's ID block may be hung, in preference order.
 *
 * [dx, dy, side] in design px relative to the marker centre; 'side' is 0 for
 * the centred block that hangs straight below and ±1 for the two offset blocks
 * that swing out and back-reference the bracket with a leader.
 *
 * Having more than one candidate is the whole point. A single fixed anchor
 * cannot avoid anything: it put target labels on the airspeed odometer and on
 * the gunsight in the same frame. Trying four in order and taking the first
 * that clears every protected region is cheap (a handful of rectangle tests per
 * contact) and it is stable, because contacts are visited nearest-first so the
 * important one always gets its first choice.
 */
/** Clear band an edge-clamped chevron may occupy, design px from each side.
 *  The top is generous because the heading tape lives there. */
const EDGE_TOP = 90;
const EDGE_BOTTOM = 54;
const EDGE_SIDE = 48;
/** Half-extent of the range chip that rides an edge chevron, design px. */
const EDGE_CHIP_W = 30;
const EDGE_CHIP_H = 11;

const ANCHORS: readonly (readonly [number, number, number])[] = [
  [0, LBL_DROP, 0],
  [LBL_OFF_X, LBL_OFF_Y, 1],
  [-LBL_OFF_X, LBL_OFF_Y, -1],
  [LBL_OFF_X, -LBL_OFF_Y, 1],
  [-LBL_OFF_X, -LBL_OFF_Y, -1],
];

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/**
 * Contact markers over aircraft.
 *
 * Three behaviours matter and all three are easy to get wrong:
 *  - **off-screen clamping**: a contact behind you must still be findable, so
 *    the marker collapses to an arrow pinned to the frame edge pointing the
 *    short way round. Points behind the camera have to be mirrored first or
 *    the arrow points at the wrong edge;
 *  - **distance falloff**: markers scale and fade with range so a furball at
 *    400 m does not become an unreadable pile of labels;
 *  - **occlusion budget**: only the nearest 'MAX_MARKERS' contacts are drawn.
 */
export class Markers {
  readonly root: HTMLElement;
  private pool: Marker[] = [];
  private w = 1920;
  private h = 1080;
  private u = 1;
  /* Contact ordering, pooled. Two parallel arrays and an insertion sort in
     place: the previous version allocated one '{e,d}' object per contact per
     frame, a comparator closure for the sort, and a third closure for the
     findIndex at the end — every frame, for up to MAX_MARKERS contacts. */
  private readonly orderE: EntityState[] = [];
  private readonly orderD: number[] = [];
  private orderN = 0;
  /* Anchors of the ID blocks already placed this frame, for the declutter pass.
     Preallocated: this runs every frame over every visible contact. */
  private readonly lblX = new Float64Array(MAX_MARKERS);
  private readonly lblY = new Float64Array(MAX_MARKERS);
  private lblN = 0;
  /* Instrument keep-out rectangles in screen px, flat [x0,y0,x1,y1,…]. Fed by
     Hud from the live layout, so a chip that moves takes its protection with
     it rather than leaving a stale hole in the middle of the frame. */
  private readonly protX = new Float64Array(4 * 16);
  private protN = 0;

  nameOf: (ownerId: number) => string = () => '';
  labelOf: (typeId: number) => string = () => '';

  constructor(parent: HTMLElement) {
    this.root = el('div', '', parent);
    this.root.id = 'ct-markers';
    for (let i = 0; i < MAX_MARKERS; i++) {
      const root = el('div', 'ct-mk', this.root);
      const box = el('div', 'ct-mk-box', root);
      for (let k = 0; k < 4; k++) el('i', '', box);
      const arrow = el('div', 'ct-mk-arrow', root);
      // A contact clamped to the frame edge used to be a bare chevron with no
      // statement of what it was or how far away — two of them floating on an
      // otherwise empty right-hand edge, which reads as decoration. The range
      // chip rides just inboard of the arrow and makes it information.
      const edge = el('div', 'ct-mk-edge', root);
      const lbl = el('div', 'ct-mk-lbl', root);
      const name = el('span', '', lbl);
      const sub = el('b', '', lbl);
      root.style.display = 'none';
      this.pool.push({ root, box, arrow, lbl, name, sub, edge, used: false });
    }
  }

  resize(w: number, h: number, u: number): void {
    this.w = w; this.h = h; this.u = u;
  }

  /**
   * Declares screen rectangles that a contact label may not be drawn over.
   *
   * 'rects' is flat [x0,y0,x1,y1,…] in CSS pixels, already inflated by whatever
   * margin the caller wants. Anything past the array's capacity is ignored.
   */
  setProtected(rects: ArrayLike<number>, count: number): void {
    const n = Math.min(count, this.protX.length >> 2);
    for (let i = 0; i < n * 4; i++) this.protX[i] = rects[i];
    this.protN = n;
  }

  /** True when the block anchored here overlaps an instrument or the sight. */
  private blocked(cx: number, cy: number, hw: number, hh: number): boolean {
    for (let k = 0; k < this.protN; k++) {
      const o = k * 4;
      if (cx + hw > this.protX[o] && cx - hw < this.protX[o + 2]
        && cy + hh > this.protX[o + 1] && cy - hh < this.protX[o + 3]) return true;
    }
    return false;
  }

  /**
   * Projects every contact and returns the current primary target — the enemy
   * closest to the gunsight, which drives the lead pip and the bearing caret.
   */
  update(
    camera: THREE.PerspectiveCamera,
    entities: Map<number, EntityState>,
    localId: number,
    localTeam: number,
    localPos: THREE.Vector3,
    enabled: boolean,
  ): TargetInfo | null {
    for (const m of this.pool) m.used = false;
    if (!enabled) {
      for (const m of this.pool) setStyle(m.root, 'display', 'none');
      return null;
    }

    this.orderN = 0;
    this.lblN = 0;
    for (const e of entities.values()) {
      if (e.id === localId) continue;
      if (e.kind !== EntityKind.Aircraft && e.kind !== EntityKind.GroundUnit) continue;
      const d = Math.hypot(e.px - localPos.x, e.py - localPos.y, e.pz - localPos.z);
      if (d > 14000) continue;
      // Nearest-first insertion into a bounded list. Anything further than the
      // current worst of a full list cannot make the cut, so it is dropped
      // without moving anything.
      if (this.orderN >= MAX_MARKERS && d >= this.orderD[MAX_MARKERS - 1]) continue;
      let i = Math.min(this.orderN, MAX_MARKERS - 1);
      while (i > 0 && this.orderD[i - 1] > d) {
        this.orderD[i] = this.orderD[i - 1];
        this.orderE[i] = this.orderE[i - 1];
        i--;
      }
      this.orderD[i] = d;
      this.orderE[i] = e;
      if (this.orderN < MAX_MARKERS) this.orderN++;
    }

    camera.getWorldDirection(_fwd);
    const margin = 46 * this.u;
    let best: TargetInfo | null = null;
    let bestScore = Infinity;

    for (let i = 0; i < this.orderN; i++) {
      const e = this.orderE[i];
      const d = this.orderD[i];
      const m = this.pool[i];
      m.used = true;

      _p.set(e.px, e.py, e.pz);
      _v.copy(_p).sub(camera.position);
      const depth = _v.dot(_fwd);      // > 0 means in front of the camera
      _p.project(camera);

      let sx = (_p.x * 0.5 + 0.5) * this.w;
      let sy = (-_p.y * 0.5 + 0.5) * this.h;
      // Points behind the camera project to a mirrored position; flip them
      // about the centre so the edge arrow points the right way.
      if (depth <= 0) {
        sx = this.w - sx;
        sy = this.h - sy;
      }

      const onScreen = depth > 0 && sx > margin && sx < this.w - margin && sy > margin && sy < this.h - margin;

      let px = sx, py = sy, rot = 0;
      if (!onScreen) {
        const dx = sx - this.w * 0.5;
        const dy = sy - this.h * 0.5;
        const hw = this.w * 0.5 - margin;
        const hh = this.h * 0.5 - margin;
        const k = Math.min(hw / Math.max(1e-3, Math.abs(dx)), hh / Math.max(1e-3, Math.abs(dy)));
        px = this.w * 0.5 + dx * k;
        py = this.h * 0.5 + dy * k;
        rot = Math.atan2(dy, dx) * 57.29578 + 90;
        // The frame edge is not uniformly free. The heading tape occupies the
        // top 62 design px across the middle of the frame, and two clamped
        // chevrons with range chips landed straight on it. Clamping the arrow
        // into the band that is actually clear costs a couple of degrees of
        // bearing accuracy on an indicator that is already only telling you
        // which way to look.
        py = clamp(py, EDGE_TOP * this.u, this.h - EDGE_BOTTOM * this.u);
        px = clamp(px, EDGE_SIDE * this.u, this.w - EDGE_SIDE * this.u);
      }

      const friendly = e.team === localTeam;
      // Scale: readable at 300 m, small but present at 8 km.
      const s = clamp(1.25 - d / 9000, 0.5, 1.25);
      // Floor raised from 0.22 and the fade pushed out from 4 km. At 0.22 a
      // contact block sitting on the bright band along the horizon was simply
      // unreadable — which defeats the point of a marker, since the whole reason
      // to draw one at 6 km is that you cannot see the aeroplane.
      const a = clamp(1.05 - Math.max(0, d - 5000) / 9000, 0.45, 1);

      setStyle(m.root, 'display', 'block');
      setStyle(m.root, 'transform',
        `translate3d(${px.toFixed(1)}px,${py.toFixed(1)}px,0) scale(${s.toFixed(3)})`);
      setStyle(m.root, 'opacity', a.toFixed(3));
      setClass(m.root, 'is-ally', friendly);
      setClass(m.root, 'is-enemy', !friendly);
      setStyle(m.box, 'display', onScreen ? 'block' : 'none');
      setStyle(m.arrow, 'display', onScreen ? 'none' : 'block');
      if (!onScreen) {
        setStyle(m.arrow, 'transform', `rotate(${rot.toFixed(1)}deg)`);
        // Park the chip on the inboard side of the arrow so it never hangs off
        // the frame: the arrow is already clamped to the margin, so "inboard"
        // is simply the direction back toward the centre.
        const ix = px < this.w * 0.5 ? 1 : -1;
        const iy = py < this.h * 0.5 ? 1 : -1;
        const cx = px + ix * (26 + EDGE_CHIP_W) * this.u;
        const cy = py + iy * 15 * this.u;
        // The chip competes for space with the ID blocks of on-screen contacts,
        // so it goes through the same declutter list: two contacts clamped to
        // the same corner, or a chip landing under a block, both produce the
        // stacked-text mess the whole placement pass exists to prevent.
        let chipOk = !this.blocked(cx, cy, EDGE_CHIP_W * this.u, EDGE_CHIP_H * this.u);
        if (chipOk) {
          for (let k = 0; k < this.lblN; k++) {
            if (Math.abs(cx - this.lblX[k]) < (EDGE_CHIP_W + LBL_W * 0.5) * this.u
              && Math.abs(cy - this.lblY[k]) < (EDGE_CHIP_H + LBL_H) * this.u) { chipOk = false; break; }
          }
        }
        if (chipOk && this.lblN < MAX_MARKERS) {
          this.lblX[this.lblN] = cx;
          this.lblY[this.lblN] = cy;
          this.lblN++;
        }
        setStyle(m.edge, 'display', chipOk ? 'block' : 'none');
        if (chipOk) {
          setText(m.edge, distStr(d));
          setStyle(m.edge, 'transform',
            `translate(${(ix * 26 * this.u).toFixed(0)}px,${(iy * 15 * this.u).toFixed(0)}px)`
            + ` translate(${ix > 0 ? '0' : '-100%'},-50%)`);
        }
      } else {
        setStyle(m.edge, 'display', 'none');
      }

      /*
       * Block placement.
       *
       * Three things can be under a contact's ID block and all three make it
       * worthless: another contact's block, an instrument (the airspeed
       * odometer, the compass plate, the systems panel) and the gunsight. Each
       * anchor in ANCHORS is tested against all three and the first clear one
       * wins; if none is clear the block is dropped and the bracket carries the
       * contact on its own, which is always better than two readings printed on
       * top of each other.
       *
       * Contacts are visited nearest-first, so in a cluster the near contact —
       * the one that can kill you — takes its preferred anchor and the ones
       * behind it move or go quiet. That ordering is by range rather than by
       * whatever the entity map yielded, so the layout is stable frame to frame.
       */
      const U = this.u;
      const rx = px - this.w * 0.5;
      const ry = py - this.h * 0.5;
      const onSight = Math.hypot(rx, ry) < RETICLE_CLEAR * U;
      let clear = false;
      let ax = px, ay = py, side = 0;
      if (onScreen && s > 0.62) {
        for (let ai = 0; ai < ANCHORS.length; ai++) {
          const [dx, dy, sd] = ANCHORS[ai];
          // The centred block is symmetric about the anchor; an offset block
          // grows away from it, so its centre sits half a width further out.
          const bx = px + dx * U + sd * LBL_W * 0.5 * U;
          const by = py + dy * U;
          // Still on the sight?
          if (Math.hypot(bx - this.w * 0.5, by - this.h * 0.5) < (RETICLE_CLEAR + LBL_H) * U) continue;
          // Off the edge of the frame?
          if (bx - LBL_W * 0.5 * U < 4 || bx + LBL_W * 0.5 * U > this.w - 4
            || by - LBL_H * U < 4 || by + LBL_H * U > this.h - 4) continue;
          if (this.blocked(bx, by, LBL_W * 0.5 * U, LBL_H * U)) continue;
          let hit = false;
          for (let k = 0; k < this.lblN; k++) {
            if (Math.abs(bx - this.lblX[k]) < LBL_W * U
              && Math.abs(by - this.lblY[k]) < LBL_H * U) { hit = true; break; }
          }
          if (hit) continue;
          // A contact sitting on the sight must not use the centred anchor even
          // if the geometry happens to clear: the block would hang between the
          // reticle and the target it annotates with no leader to tie them.
          if (onSight && sd === 0) continue;
          ax = bx; ay = by; side = sd; clear = true;
          break;
        }
      }
      if (clear && this.lblN < MAX_MARKERS) {
        this.lblX[this.lblN] = ax;
        this.lblY[this.lblN] = ay;
        this.lblN++;
      }

      setStyle(m.lbl, 'display', clear ? 'block' : 'none');
      if (clear) {
        setText(m.name, this.nameOf(e.ownerId) || this.labelOf(e.typeId));
        setText(m.sub, distStr(d));
        setClass(m.lbl, 'is-offset', side !== 0);
        setClass(m.lbl, 'is-left', side < 0);
        setClass(m.lbl, 'is-up', side !== 0 && ay < py);
      }

      if (!friendly && onScreen && depth > 0) {
        // Primary target: smallest screen offset from the gunsight, weighted so
        // a close contact wins over a distant one on a similar bearing.
        const off = Math.hypot(px - this.w * 0.5, py - this.h * 0.5);
        const score = off * (0.6 + d / 12000);
        if (off < this.w * 0.24 && score < bestScore) {
          bestScore = score;
          let bearing = Math.atan2(e.px - localPos.x, e.pz - localPos.z) * 57.29578;
          if (bearing < 0) bearing += 360;
          best = { id: e.id, dist: d, bearing, screenX: px, screenY: py, state: e };
        }
      }
    }

    for (const m of this.pool) {
      if (!m.used) setStyle(m.root, 'display', 'none');
      else setClass(m.root, 'is-lock', false);
    }
    if (best) {
      for (let i = 0; i < this.orderN; i++) {
        if (this.orderE[i].id === best.id) { setClass(this.pool[i].root, 'is-lock', true); break; }
      }
    }
    return best;
  }
}
